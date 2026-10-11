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
    async run(rawInput: unknown, context: ToolContext): Promise<ToolResult> {
      const parsed = definition.input.safeParse(rawInput);
      if (!parsed.success) {
        return { ok: false, error: `Invalid arguments: ${formatIssues(parsed.error.issues)}` };
      }
      try {
        const { output, summary, traceOutput } = await definition.execute(parsed.data, context);
        return traceOutput === undefined
          ? { ok: true, output, summary }
          : { ok: true, output, summary, traceOutput };
      } catch (error) {
        if (error instanceof ToolInputError) return { ok: false, error: error.message };
        throw error;
      }
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
