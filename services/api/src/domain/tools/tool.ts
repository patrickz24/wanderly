import type { z } from 'zod';
import type { DestinationCatalog } from '../agent/catalog.js';
import type { KnowledgeRepository, Retriever } from '../ports/knowledge.js';
import type { ToolSpec } from '../ports/llm.js';
import type { EvidenceRegistry } from './evidence.js';
import { toStrictJsonSchema } from './strict-json-schema.js';

/** What a data tool may use. Every port here is read-only: tools have no side effects. */
export interface ToolContext {
  /** Provider-issued id of this call; budget and weather results are cited by it. */
  readonly callId: string;
  readonly retriever: Retriever;
  readonly knowledge: KnowledgeRepository;
  readonly catalog: DestinationCatalog;
  readonly evidence: EvidenceRegistry;
}

export interface ToolSuccess {
  readonly ok: true;
  /** JSON-serializable result sent to the model (compact, with ids to cite). */
  readonly output: unknown;
  /** One line for the transparency panel. */
  readonly summary: string;
  /**
   * What the trace records instead of `output`, when set: the same result plus diagnostics the
   * model does not need (e.g. retrieval scores), so they cost no prompt tokens.
   */
  readonly traceOutput?: unknown;
}

export interface ToolFailure {
  readonly ok: false;
  /** Sent to the model as an `is_error` tool result: short and actionable. */
  readonly error: string;
}

export type ToolResult = ToolSuccess | ToolFailure;

/** A read-only tool the model calls to gather evidence. */
export interface DataTool {
  readonly spec: ToolSpec;
  /** Validates the raw arguments, then executes. Port failures propagate as exceptions. */
  run(rawInput: unknown, context: ToolContext): Promise<ToolResult>;
}

/** The model sent arguments that are well-formed but unusable (e.g. an unknown destination). */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export interface DataToolDefinition<Schema extends z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly input: Schema;
  readonly fieldDescriptions?: Readonly<Record<string, string>>;
  execute(
    input: z.output<Schema>,
    context: ToolContext,
  ): Promise<{
    readonly output: unknown;
    readonly summary: string;
    readonly traceOutput?: unknown;
  }>;
}

export function defineDataTool<Schema extends z.ZodType>(
  definition: DataToolDefinition<Schema>,
): DataTool {
  const spec: ToolSpec = Object.freeze({
    name: definition.name,
    description: definition.description,
    inputSchema: toStrictJsonSchema(definition.input, definition.fieldDescriptions),
    strict: true,
  });
  return Object.freeze({
    spec,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- learning skeleton: remove this line with the TODO.
    async run(rawInput: unknown, context: ToolContext): Promise<ToolResult> {
      // TODO(learning) — étape 3. Spec : data-tools.test.ts (tous les appels à `.run`) et, plus
      // tard, le test « answers unknown tools, invalid arguments… » de run-agent.test.ts.
      // Les arguments viennent du MODÈLE : c'est une entrée non fiable, même avec `strict: true`
      // (le mode strict ne vérifie ni les bornes, ni les longueurs).
      // 1. Valide `rawInput` avec `definition.input.safeParse`. En cas d'échec, renvoie un échec
      //    `{ ok: false, error }` dont le message commence par "Invalid arguments: " suivi des
      //    issues formatées (`formatIssues`) : le modèle doit pouvoir se corriger.
      // 2. Exécute `definition.execute(parsed.data, context)` et renvoie
      //    `{ ok: true, output, summary }`, plus `traceOutput` SEULEMENT si l'outil en fournit un
      //    (la vue enrichie pour la trace, jamais envoyée au modèle). Un test vérifie que la clé
      //    est absente, et pas seulement `undefined`, pour les autres outils.
      // 3. Une `ToolInputError` (arguments bien formés mais inutilisables, ex. destination
      //    inconnue) devient aussi un échec `{ ok: false, error: message }`.
      // 4. Toute autre exception (panne de base, bug) n'est PAS rattrapée ici : elle remonte à la
      //    boucle, qui la trace et envoie au modèle un message générique (pas de détails internes).
      throw new Error('TODO(learning): DataTool.run (agent-loop, step 3)');
    },
  });
}

/** `path: message` per issue; paths use dots and brackets (`days[2].items`). */
export function issueLines(issues: readonly z.core.$ZodIssue[], max = 10): string[] {
  const lines = issues.slice(0, max).map((issue) => {
    const path = formatPath(issue.path);
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
  if (issues.length > max) lines.push(`(${issues.length - max} more issue(s))`);
  return lines;
}

export function formatIssues(issues: readonly z.core.$ZodIssue[], max = 10): string {
  return issueLines(issues, max).join('; ');
}

function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((key, index) => {
      if (typeof key === 'number') return `[${key}]`;
      const name = String(key);
      return index === 0 ? name : `.${name}`;
    })
    .join('');
}

export function requireKnownDestination(context: ToolContext, destinationId: string): void {
  if (!context.catalog.has(destinationId)) {
    throw new ToolInputError(
      `Unknown destinationId "${destinationId}". Use an id from the destination catalog; if the place is not in the catalog, decline with reason unknown_destination.`,
    );
  }
}
