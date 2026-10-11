/* eslint-disable @typescript-eslint/no-unused-vars, no-unused-private-class-members -- learning skeleton: the imports, parameters and private members are used once the TODOs are implemented; remove this line at the end. */
import type { AgentResponse, ToolCallSummary } from '@wanderly/contracts';
import {
  InvalidOutputError,
  type KnownDomainError,
  LlmTimeoutError,
  ProviderUnavailableError,
} from '../errors.js';
import { containsCanary } from '../guardrails/canary.js';
import { detectInjectionSignals } from '../guardrails/injection.js';
import { resolveSources } from '../guardrails/sources.js';
import { validateResponse } from '../guardrails/validate-response.js';
import type {
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  ToolCallBlock,
  ToolResultBlock,
} from '../ports/llm.js';
import { addUsage, ZERO_USAGE } from '../ports/llm.js';
import { costUsd, maxCallCostUsd } from '../pricing.js';
import { EvidenceRegistry } from '../tools/evidence.js';
import { AGENT_TOOL_SPECS, findDataTool } from '../tools/registry.js';
import {
  findTerminalTool,
  isTerminalToolName,
  TERMINAL_TOOL_NAMES,
} from '../tools/terminal-tools.js';
import type { ToolResult } from '../tools/tool.js';
import { createCatalog, type DestinationCatalog } from './catalog.js';
import { DeadlineExceeded, startRunDeadline, withDeadline } from './deadline.js';
import {
  assistantMessage,
  pendingToolCalls,
  textBlock,
  toolCallsOf,
  toolResult,
  userMessage,
} from './messages.js';
import { buildSystemPrompt } from './system-prompt.js';
import type {
  AgentFailureReason,
  AgentRunDeps,
  AgentRunInput,
  AgentRunResult,
  AgentStepEvent,
} from './types.js';
import { buildUserTurn } from './user-turn.js';

/*
 * SQUELETTE D'EXERCICE (branche learning/agent-loop). Guide : docs/learning/agent-loop.md sur main.
 *
 * Ce qui est fourni : les imports (tout ce que la version d'origine utilise), les constantes, les
 * types internes, l'état du run (champs de `AgentRun`) et les petites méthodes de tenue de
 * registre (`#append`, `#recordSignals`, `#emit`, `#throwIfCancelled`, `#finish`, `describe`,
 * `truncate`). Ce qui est à écrire : chaque corps qui lève `TODO(learning)`.
 *
 * Ordre conseillé (les numéros d'étape sont ceux de LEARNING.md à la racine de la branche) :
 * - étape 5, chemin heureux : `runAgent`, `execute`, `#callModel` (succès), `#executeTools`,
 *   `#executeTool` (succès), `#judge`, `#deliver` (sans canary), `#succeed` ;
 * - étape 6, outils en échec : `#executeTool` (échecs), `toolFailureMessage` ;
 * - étape 7, réparation et rappel : `repairMessage`, `#fail`, branches de réparation de `execute` ;
 * - étape 8, garde-fous et tour suivant : canary dans `#deliver`, signaux d'injection ;
 * - étape 9, échecs du modèle : `#callModel` (échecs), `#refused`, troncature ;
 * - étape 10, limites, append-only et annulation.
 */

/**
 * The agent loop (plan §5.2): call the model, run the tools it asks for, feed the results back,
 * until it calls a terminal tool whose output passes validation, or a limit stops the run.
 *
 * - The history is append-only: `input.history` is never modified, and every message of the run
 *   (user turn included) is returned in `newMessages`, ready to be appended to the store.
 * - Tool calls of one step run in parallel and all their results go back in ONE user message.
 *   Failures (unknown tool, invalid arguments, port error, timeout) become `is_error` results the
 *   model can recover from.
 * - A terminal call is validated (schema, business rules, grounding); an invalid one gets one
 *   repair round with the issues as an `is_error` result. Plain text gets one reminder.
 * - Limits: steps, per-call and per-tool timeouts, a run deadline, a per-run cost ceiling.
 * - Expected failures (timeouts, provider unavailable, invalid output, limits) are returned as
 *   `status: 'error'` with what was spent; unexpected errors (bugs, a rejected request, a failing
 *   catalog query) are thrown. Cancellation through `deps.signal` rejects with its reason.
 * - `deps.trace` receives one record per LLM call and tool call. The caller owns the trace: it
 *   attaches the scores (from `validFirstTry`, `repairs`, `toolCalls`, `signals`) and ends it.
 */
export async function runAgent(input: AgentRunInput, deps: AgentRunDeps): Promise<AgentRunResult> {
  // TODO(learning) — étape 5.
  // 1. Démarre la deadline du run (`startRunDeadline`), reliée à `deps.signal` (annulation).
  // 2. Exécute un `AgentRun` avec le signal de cette deadline.
  // 3. Libère la deadline quoi qu'il arrive (succès, échec ou exception) : minuteur et écouteur.
  throw new Error('TODO(learning): runAgent (agent-loop, step 5)');
}

/** Sent (as a user message) when the model replies in plain text instead of a terminal tool. */
export const NUDGE_TEXT = [
  'Reminder from the application: your last reply was plain text, which the user never sees.',
  `End this turn by calling exactly one terminal tool: ${TERMINAL_TOOL_NAMES.join(', ')}.`,
].join(' ');

const REFUSAL_MESSAGE =
  "I can't help with this request. I can help you plan a trip to one of the destinations I cover.";
const CANARY_MESSAGE =
  "I can't share that. I can help you plan a trip to one of the destinations I cover.";
const MAX_SUMMARY_CHARS = 300;

type CallOutcome =
  | { readonly ok: true; readonly response: LlmResponse }
  | { readonly ok: false; readonly result: AgentRunResult };

type TerminalVerdict =
  | { readonly ok: true; readonly response: AgentResponse }
  | { readonly ok: false; readonly issues: readonly string[] };

interface ToolExecution {
  readonly block: ToolResultBlock;
  readonly summary: ToolCallSummary;
}

class AgentRun {
  readonly #input: AgentRunInput;
  readonly #deps: AgentRunDeps;
  readonly #runSignal: AbortSignal;
  readonly #startedAt: Date;
  /** The whole conversation sent to the model: history + this run's messages. */
  readonly #messages: LlmMessage[];
  readonly #newMessages: LlmMessage[] = [];
  readonly #evidence = new EvidenceRegistry();
  readonly #toolCalls: ToolCallSummary[] = [];
  readonly #injectionSignals = new Set<string>();
  #usage: LlmUsage = ZERO_USAGE;
  #costUsd = 0;
  #steps = 0;
  #repairs = 0;
  #nudged = false;
  #canaryLeak = false;
  #providerRefusal = false;

  constructor(input: AgentRunInput, deps: AgentRunDeps, runSignal: AbortSignal) {
    this.#input = input;
    this.#deps = deps;
    this.#runSignal = runSignal;
    this.#startedAt = deps.clock.now();
    this.#messages = [...input.history];
  }

  async execute(): Promise<AgentRunResult> {
    // TODO(learning) — étapes 5 à 10 : la boucle. Écris-la par petits morceaux, test par test.
    // Avant la boucle :
    // 1. Le catalogue (`createCatalog` sur `knowledge.listDestinations()`) et la partie fixe de
    //    chaque requête : { system, tools, maxTokens } (`buildSystemPrompt` avec le canary,
    //    `AGENT_TOOL_SPECS`, `limits.maxOutputTokens`). Mesure aussi sa taille en caractères :
    //    elle servira au plafond de coût.
    // 2. Ajoute le tour utilisateur (`buildUserTurn`) et relève les signaux d'injection du texte
    //    de l'utilisateur.
    // Puis, tant que `#steps < limits.maxSteps` :
    // 3. Annulation par l'appelant ? (`#throwIfCancelled`). Deadline du run déjà passée ?
    //    -> échec `run_deadline`.
    // 4. Plafond de coût, AVANT l'appel : déjà dépensé + pire cas du prochain appel
    //    (`maxCallCostUsd` sur la taille du prompt complet) > `limits.maxRunCostUsd` ?
    //    -> échec `cost_ceiling`.
    // 5. Compte le pas, appelle le modèle (`#callModel`) avec une COPIE des messages.
    // 6. `refusal` -> `#refused`. `max_tokens` -> échec `truncated`. Dans les deux cas, la sortie
    //    n'entre pas dans l'historique.
    // 7. Aucun appel d'outil : c'est du texte libre (violation du contrat). Garde le message s'il
    //    contient du texte (pas s'il est vide), envoie UN rappel (`NUDGE_TEXT`), et échoue en
    //    `invalid_output` si ça recommence.
    // 8. Seulement des outils de données : exécute-les (`#executeTools`) et renvoie TOUS les
    //    résultats dans UN SEUL message utilisateur.
    // 9. Au moins un appel terminal : exactement un est permis. Valide-le (`#judge`). Valide ->
    //    `#deliver`. Invalide -> une réparation : chaque appel terminal reçoit un `tool_result` en
    //    erreur (`repairMessage` pour celui qu'on a jugé), les autres appels sont exécutés
    //    normalement, et on reboucle. Plus de réparation possible -> échec `invalid_output`.
    // Après la boucle : échec `step_limit`.
    throw new Error('TODO(learning): AgentRun.execute (agent-loop, steps 5 to 10)');
  }

  // --- Model calls ------------------------------------------------------------------------------

  async #callModel(step: number, request: LlmRequest): Promise<CallOutcome> {
    // TODO(learning) — étape 5 (succès) et étape 9 (échecs).
    // 1. Heure de début (`clock.now()`) et entrée de trace : les messages et les NOMS des outils,
    //    jamais le prompt système (il contient le canary).
    // 2. Appelle `llm.generate` à travers `withDeadline(…, limits.llmTimeoutMs, this.#runSignal)`
    //    en passant le signal reçu au port.
    // 3. Succès : coût de l'appel (`costUsd` avec `deps.pricing`), cumul de l'usage (`addUsage`) et
    //    du coût, un enregistrement `trace.llmCall`, puis `{ ok: true, response }`.
    // 4. Échec : un enregistrement `trace.llmCall` avec l'erreur (`describe`) et un usage nul, puis :
    //    - annulation par l'appelant -> relance (`#throwIfCancelled`) ;
    //    - `DeadlineExceeded` -> `run_deadline` ou `llm_timeout` selon `error.scope`, sous forme de
    //      `LlmTimeoutError(error.timeoutMs, { cause })` ;
    //    - `LlmTimeoutError` -> `llm_timeout` ; `ProviderUnavailableError` -> `provider_unavailable`
    //      (garde l'erreur d'origine) ;
    //    - toute autre erreur est un bug ou une requête rejetée : relance-la.
    throw new Error('TODO(learning): AgentRun.#callModel (agent-loop, steps 5 and 9)');
  }

  // --- Terminal calls ---------------------------------------------------------------------------

  #judge(call: ToolCallBlock, catalog: DestinationCatalog): TerminalVerdict {
    // TODO(learning) — étape 5.
    // 1. Retrouve l'outil terminal (`findTerminalTool`) ; inconnu -> une issue.
    // 2. La FORME : `tool.parse(call.input)` (Zod). Échec -> ses issues.
    // 3. Le FOND : `validateResponse` avec le registre de preuves de ce run et le catalogue.
    throw new Error('TODO(learning): AgentRun.#judge (agent-loop, step 5)');
  }

  /**
   * Success. The terminal call stays open: the next turn's user message answers it (see
   * `buildUserTurn`). A response that leaks the canary is replaced by a decline, and its call is
   * closed here so the next turn does not report it as delivered.
   */
  #deliver(
    response: AgentResponse,
    terminal: ToolCallBlock,
    catalog: DestinationCatalog,
  ): AgentRunResult {
    // TODO(learning) — étape 5 (sans canary) puis étape 8 (canary).
    // 1. Si la réponse contient le canary (`containsCanary`) : lève le signal, ferme l'appel
    //    terminal par un `tool_result` en erreur (explique au modèle pourquoi), et réussis avec un
    //    `decline` de raison `unsafe` (`CANARY_MESSAGE`, brief d'entrée inchangé).
    // 2. Sinon : réussis avec la réponse. L'appel terminal reste OUVERT (voir le docstring).
    throw new Error('TODO(learning): AgentRun.#deliver (agent-loop, steps 5 and 8)');
  }

  /** The provider's safety classifiers declined: answer with a decline, keep the brief. */
  #refused(catalog: DestinationCatalog): AgentRunResult {
    // TODO(learning) — étape 9. Lève le signal `#providerRefusal` et réussis avec un `decline`
    // `unsafe` (`REFUSAL_MESSAGE`, brief d'entrée inchangé). Un refus n'est pas une panne.
    throw new Error('TODO(learning): AgentRun.#refused (agent-loop, step 9)');
  }

  // --- Tools ------------------------------------------------------------------------------------

  async #executeTools(
    step: number,
    calls: readonly ToolCallBlock[],
    catalog: DestinationCatalog,
    overrides: ReadonlyMap<string, ToolResultBlock>,
  ): Promise<ToolResultBlock[]> {
    // TODO(learning) — étape 5.
    // 1. Lance TOUS les appels en parallèle (`Promise.all`) : un appel présent dans `overrides`
    //    (réparation) n'est pas exécuté, son résultat est déjà écrit.
    // 2. Renvoie les blocs `tool_result` dans l'ORDRE DES APPELS, et ajoute le résumé de chaque
    //    outil réellement exécuté à `#toolCalls`.
    throw new Error('TODO(learning): AgentRun.#executeTools (agent-loop, step 5)');
  }

  async #executeTool(
    step: number,
    call: ToolCallBlock,
    catalog: DestinationCatalog,
  ): Promise<ToolExecution> {
    // TODO(learning) — étape 5 (succès) et étape 6 (échecs).
    // 1. Émets `tool.started`, note l'heure de début.
    // 2. Outil de données inconnu (`findDataTool`) -> un échec : « un seul terminal par tour » si
    //    c'est un nom d'outil terminal, sinon « outil inconnu » (le message doit nommer l'outil).
    // 3. Sinon : `tool.run(call.input, { callId, retriever, knowledge, catalog, evidence })` à
    //    travers `withDeadline(…, limits.toolTimeoutMs, this.#runSignal)`, avec un registre de
    //    preuves NEUF pour cet appel. Exception -> garde le détail pour la trace, et donne au
    //    modèle un message sans détail interne (`toolFailureMessage`).
    // 4. Succès seulement : fusionne les preuves de l'appel dans celles du run (seul ce que le
    //    modèle a reçu devient citable) et relève les signaux d'injection de la sortie de l'outil.
    // 5. `trace.toolCall` : en sortie, la vue de trace de l'outil (`traceOutput`) s'il en a une,
    //    sinon ce que le modèle a reçu (`output`). Puis le résumé `ToolCallSummary` (durée, résumé
    //    tronqué à MAX_SUMMARY_CHARS), `tool.finished`, et le bloc `tool_result` : la sortie
    //    `output` en JSON compact (jamais `traceOutput`, que le modèle n'a pas à payer en tokens),
    //    ou l'erreur.
    throw new Error('TODO(learning): AgentRun.#executeTool (agent-loop, steps 5 and 6)');
  }

  // --- Run bookkeeping --------------------------------------------------------------------------

  #append(message: LlmMessage): void {
    this.#messages.push(message);
    this.#newMessages.push(message);
  }

  #recordSignals(source: 'user' | 'tool', text: string): void {
    for (const signal of detectInjectionSignals(text))
      this.#injectionSignals.add(`${source}:${signal}`);
  }

  #emit(event: AgentStepEvent): void {
    try {
      this.#deps.onEvent(event);
    } catch {
      // A failing listener (e.g. a closed SSE stream) must not break the run.
    }
  }

  #throwIfCancelled(): void {
    const cancel = this.#deps.signal;
    if (cancel?.aborted === true) throw cancel.reason;
  }

  #succeed(response: AgentResponse, catalog: DestinationCatalog): AgentRunResult {
    // TODO(learning) — étape 5. Le résultat commun (`#finish`), plus : statut `ok`, la réponse,
    // ses sources résolues pour l'affichage (`resolveSources`), et `validFirstTry` (aucune
    // réparation utilisée).
    throw new Error('TODO(learning): AgentRun.#succeed (agent-loop, step 5)');
  }

  /** Failure. Calls left open by the last assistant message are closed so the history stays valid. */
  #fail(reason: AgentFailureReason, error: KnownDomainError): AgentRunResult {
    // TODO(learning) — étape 7.
    // 1. Si le dernier message est un message assistant avec des appels d'outils
    //    (`pendingToolCalls`), ferme-les TOUS dans un message utilisateur : un `tool_result` en
    //    erreur par appel, qui dit que rien n'a été livré et pourquoi (`reason`).
    // 2. Le résultat commun (`#finish`), plus : statut `error`, l'erreur et la raison.
    throw new Error('TODO(learning): AgentRun.#fail (agent-loop, step 7)');
  }

  #finish() {
    const { clock } = this.#deps;
    return {
      newMessages: Object.freeze([...this.#newMessages]),
      toolCalls: Object.freeze([...this.#toolCalls]),
      usage: this.#usage,
      costUsd: this.#costUsd,
      steps: this.#steps,
      repairs: this.#repairs,
      latencyMs: Math.max(0, clock.now().getTime() - this.#startedAt.getTime()),
      signals: {
        canaryLeak: this.#canaryLeak,
        providerRefusal: this.#providerRefusal,
        injectionSignals: [...this.#injectionSignals],
      },
    };
  }
}

export function repairMessage(toolName: string, issues: readonly string[]): string {
  // TODO(learning) — étape 7. Un message pour le MODÈLE : son appel a été rejeté et n'a PAS été
  // montré à l'utilisateur (le test cherche « NOT shown to the user »), puis une issue par ligne,
  // et la consigne de rappeler un outil terminal une fois tout corrigé.
  throw new Error('TODO(learning): repairMessage (agent-loop, step 7)');
}

function toolFailureMessage(name: string, error: unknown, toolTimeoutMs: number): string {
  // TODO(learning) — étape 6.
  // - `DeadlineExceeded` de portée 'call' : l'outil a dépassé SON délai (« timed out after
  //   <n> ms ») ; le modèle peut réessayer une fois ou continuer sans.
  // - `DeadlineExceeded` de portée 'run' : c'est le tour entier qui n'a plus de temps.
  // - Toute autre erreur : « internal error », SANS le message d'origine (il peut contenir une
  //   adresse, une requête SQL… que le modèle répéterait à l'utilisateur). Le détail va à la trace.
  throw new Error('TODO(learning): toolFailureMessage (agent-loop, step 6)');
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
