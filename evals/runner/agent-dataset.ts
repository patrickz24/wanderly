import { readFile } from 'node:fs/promises';
import {
  BudgetLevelSchema,
  DeclineReasonSchema,
  PoiKindSchema,
  type AgentResponseType,
} from '@wanderly/contracts';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Corpus } from '../../services/api/src/application/ports/corpus-source.js';

/**
 * Agent evaluation dataset (`evals/datasets/agent-cases.yaml`, plan section 8.1): the schema, the
 * loader, and the checks that tie every expectation to the corpus (ground truth never comes from
 * a model's output).
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const CASE_CATEGORIES = [
  'clear',
  'ambiguous',
  'out_of_scope',
  'direct_injection',
  'indirect_injection',
  'unknown_destination',
  'multi_turn',
] as const;
export const CaseCategorySchema = z.enum(CASE_CATEGORIES);
export type CaseCategory = z.infer<typeof CaseCategorySchema>;

const ResponseTypeSchema = z.enum(['itinerary', 'clarification', 'answer', 'decline']);

/** Brief fields the user did not give: the agent must leave them null instead of inventing them. */
export const UNSTATED_FIELDS = [
  'destinationId',
  'durationDays',
  'month',
  'startDate',
  'budgetLevel',
  'travelers',
] as const;
const UnstatedFieldSchema = z.enum(UNSTATED_FIELDS);
export type UnstatedField = z.infer<typeof UnstatedFieldSchema>;

const ExpectSchema = z.strictObject({
  /** Acceptable response types of the last turn (the first one is the preferred outcome). */
  types: z.array(ResponseTypeSchema).min(1),
  /** When the response is a decline, its reason must be one of these (any reason if absent). */
  declineReasons: z.array(DeclineReasonSchema).min(1).optional(),
  destinationId: z.string().regex(SLUG).optional(),
  durationDays: z.int().min(1).max(21).optional(),
  month: z.int().min(1).max(12).optional(),
  travelers: z.int().min(1).max(12).optional(),
  budgetLevel: BudgetLevelSchema.optional(),
  /** POI kinds the itinerary must reflect (each one in at least one cited POI). */
  interests: z.array(PoiKindSchema).max(4).optional(),
  /** Brief fields that must stay null (ambiguous requests). */
  unstated: z.array(UnstatedFieldSchema).min(1).optional(),
  /** Strings that must not appear anywhere in the delivered response (case-insensitive). */
  forbidden: z.array(z.string().trim().min(3)).optional(),
  /** Upper bound on data tool calls in the last turn (tool abuse). */
  maxToolCalls: z.int().min(0).optional(),
});
export type CaseExpectation = z.infer<typeof ExpectSchema>;

const PoisonSchema = z.strictObject({
  destinationId: z.string().regex(SLUG),
  text: z.string().trim().min(20).max(1200),
});
export type PoisonDocument = z.infer<typeof PoisonSchema>;

const CaseSchema = z
  .strictObject({
    id: z.string().regex(SLUG),
    category: CaseCategorySchema,
    language: z.enum(['en', 'fr']),
    provenance: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1)).min(1),
    turns: z.array(z.string().trim().min(1).max(2000)).min(1).max(4),
    poison: PoisonSchema.optional(),
    unknownPlace: z.string().trim().min(2).optional(),
    expect: ExpectSchema,
  })
  .superRefine((value, ctx) => {
    const issue = (message: string, path: PropertyKey[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    if (value.category === 'indirect_injection' && value.poison === undefined) {
      issue('indirect injection cases need a poison document', ['poison']);
    }
    if (value.category !== 'indirect_injection' && value.poison !== undefined) {
      issue('only indirect injection cases may carry a poison document', ['poison']);
    }
    if (value.category === 'unknown_destination' && value.unknownPlace === undefined) {
      issue('unknown destination cases must name the place', ['unknownPlace']);
    }
    if (value.category === 'multi_turn' && value.turns.length < 2) {
      issue('multi-turn cases need at least 2 turns', ['turns']);
    }
    if (value.category !== 'multi_turn' && value.turns.length !== 1) {
      issue('only multi-turn cases may have several turns', ['turns']);
    }
    if (value.category === 'ambiguous' && value.expect.unstated === undefined) {
      issue('ambiguous cases must list the unstated fields', ['expect', 'unstated']);
    }
    const preferred: AgentResponseType | undefined = value.expect.types[0];
    if (
      value.category === 'clear' &&
      (preferred !== 'itinerary' || value.expect.types.length > 1)
    ) {
      issue('clear cases expect exactly an itinerary', ['expect', 'types']);
    }
    if (value.category === 'ambiguous' && value.expect.types.join() !== 'clarification') {
      issue('ambiguous cases expect exactly a clarification', ['expect', 'types']);
    }
  });
export type AgentCase = z.infer<typeof CaseSchema>;

export const AgentDatasetSchema = z
  .strictObject({
    version: z.literal(1),
    /** Fixed "today" given to the agent, so date reasoning does not drift between runs. */
    today: z.string().regex(ISO_DATE),
    cases: z.array(CaseSchema).min(1),
  })
  .superRefine((dataset, ctx) => {
    const ids = new Set<string>();
    dataset.cases.forEach((item, index) => {
      if (ids.has(item.id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate case id',
          path: ['cases', index, 'id'],
        });
      }
      ids.add(item.id);
    });
  });
export type AgentDataset = z.infer<typeof AgentDatasetSchema>;

export function parseAgentDataset(text: string): AgentDataset {
  return AgentDatasetSchema.parse(parse(text));
}

export async function loadAgentDataset(file: string): Promise<AgentDataset> {
  return parseAgentDataset(await readFile(file, 'utf8'));
}

/** A POI kind counts as available when the destination has at least this many POIs of it. */
export const MIN_POIS_PER_INTEREST = 3;

/**
 * Checks every expectation against the corpus: destinations exist, expected interests are POI
 * kinds the destination really has, poison targets exist, and "unknown" places are really absent
 * (no destination id, name, alias, place id or place title matches them). Returns the problems.
 */
export function findCorpusProblems(dataset: AgentDataset, corpus: Corpus): string[] {
  const destinations = new Map(corpus.destinations.map((d) => [d.facts.id, d]));
  const knownNames = new Set<string>();
  for (const destination of corpus.destinations) {
    const { facts } = destination;
    for (const name of [facts.id, facts.name, ...facts.aliases]) knownNames.add(normalize(name));
    for (const document of destination.documents) knownNames.add(normalize(document.title));
    for (const document of facts.documents ?? []) knownNames.add(normalize(document.id));
  }

  const problems: string[] = [];
  for (const item of dataset.cases) {
    const expected = item.expect.destinationId;
    const destination = expected === undefined ? undefined : destinations.get(expected);
    if (expected !== undefined && destination === undefined) {
      problems.push(`${item.id}: destination "${expected}" is not in the corpus`);
    }
    if (destination !== undefined) {
      for (const kind of item.expect.interests ?? []) {
        const count = destination.facts.pois.filter((poi) => poi.kinds.includes(kind)).length;
        if (count < MIN_POIS_PER_INTEREST) {
          problems.push(
            `${item.id}: ${expected} has ${count} POI(s) of kind "${kind}" (< ${MIN_POIS_PER_INTEREST})`,
          );
        }
      }
    }
    if (item.poison !== undefined && !destinations.has(item.poison.destinationId)) {
      problems.push(`${item.id}: poison destination "${item.poison.destinationId}" is unknown`);
    }
    if (item.unknownPlace !== undefined && knownNames.has(normalize(item.unknownPlace))) {
      problems.push(`${item.id}: "${item.unknownPlace}" is in the corpus`);
    }
  }
  return problems;
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Case counts by category, for the report and the dataset tests. */
export function countByCategory(dataset: AgentDataset): Record<CaseCategory, number> {
  const counts = Object.fromEntries(CASE_CATEGORIES.map((category) => [category, 0])) as Record<
    CaseCategory,
    number
  >;
  for (const item of dataset.cases) counts[item.category] += 1;
  return counts;
}

/** Selects cases by id and/or category (both optional; an unknown id is an error). */
export function selectCases(
  dataset: AgentDataset,
  filter: { readonly ids?: readonly string[]; readonly categories?: readonly CaseCategory[] },
): AgentCase[] {
  const ids = filter.ids === undefined || filter.ids.length === 0 ? undefined : new Set(filter.ids);
  if (ids !== undefined) {
    const known = new Set(dataset.cases.map((item) => item.id));
    const unknown = [...ids].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`Unknown case id(s): ${unknown.join(', ')}`);
  }
  const categories =
    filter.categories === undefined || filter.categories.length === 0
      ? undefined
      : new Set(filter.categories);
  return dataset.cases.filter(
    (item) =>
      (ids === undefined || ids.has(item.id)) &&
      (categories === undefined || categories.has(item.category)),
  );
}
