import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Corpus } from '../../services/api/src/application/ports/corpus-source.js';
import { chunkMarkdown } from '../../services/api/src/domain/rag/chunker.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const TargetSchema = z.strictObject({
  destinationId: z.string().regex(SLUG),
  document: z.string().regex(/^(?:guide\.md|places\/[a-z0-9-]+\.md)$/),
  headingPath: z.string().trim().min(1),
});

const QuerySchema = z.strictObject({
  id: z.string().regex(SLUG),
  query: z.string().trim().min(1).max(300),
  destinationId: z.string().regex(SLUG).nullable(),
  style: z.enum(['keyword', 'paraphrase', 'question', 'cross-section']),
  relevant: z.array(TargetSchema).min(1),
  provenance: z.string().trim().min(1),
});

export const RetrievalDatasetSchema = z
  .strictObject({ version: z.literal(1), queries: z.array(QuerySchema).min(1) })
  .superRefine((dataset, ctx) => {
    const ids = new Set<string>();
    dataset.queries.forEach((query, index) => {
      if (ids.has(query.id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate query id',
          path: ['queries', index, 'id'],
        });
      }
      ids.add(query.id);
    });
  });

export type RetrievalDataset = z.infer<typeof RetrievalDatasetSchema>;
export type RetrievalCase = RetrievalDataset['queries'][number];

export function parseRetrievalDataset(text: string): RetrievalDataset {
  return RetrievalDatasetSchema.parse(parse(text));
}

export async function loadRetrievalDataset(file: string): Promise<RetrievalDataset> {
  return parseRetrievalDataset(await readFile(file, 'utf8'));
}

/** Every section of every document, as "<destination>/<document>#<section path>". */
export function listCorpusSections(corpus: Corpus): Set<string> {
  // One chunk per section: budgets far above any section, nothing merged.
  const whole = {
    targetTokens: 1_000_000,
    maxTokens: 1_000_000,
    overlapTokens: 0,
    minTokens: 0,
    contextualHeader: false,
  };
  const sections = new Set<string>();
  for (const destination of corpus.destinations) {
    for (const document of destination.documents) {
      for (const chunk of chunkMarkdown(
        { title: document.title, markdown: document.body },
        whole,
      )) {
        for (const section of chunk.sections) sections.add(`${document.path}#${section}`);
      }
    }
  }
  return sections;
}

/** Labels that name no section of the corpus (a typo, or a corpus that changed under them). */
export function findUnknownLabels(dataset: RetrievalDataset, corpus: Corpus): string[] {
  const sections = [...listCorpusSections(corpus)];
  const problems: string[] = [];
  for (const query of dataset.queries) {
    for (const target of query.relevant) {
      const prefix = `${target.destinationId}/${target.document}#${target.headingPath}`;
      const exists = sections.some(
        (section) => section === prefix || section.startsWith(`${prefix} > `),
      );
      if (!exists)
        problems.push(
          `${query.id}: no section "${target.headingPath}" in ${target.destinationId}/${target.document}`,
        );
    }
  }
  return problems;
}
