/* eslint-disable @typescript-eslint/no-unused-vars -- learning skeleton: the imports and parameters are used once the TODOs are implemented; remove this line at the end. */
import type { TripBrief } from '@wanderly/contracts';
import type { LlmMessage, ToolCallBlock, ToolResultBlock } from '../ports/llm.js';
import { isTerminalToolName } from '../tools/terminal-tools.js';
import { pendingToolCalls, textBlock, toolResult, userMessage } from './messages.js';

/**
 * Builds the user turn of a run. Its content, in order:
 *
 * 1. `tool_result` blocks answering the tool calls left open by the previous run. A successful
 *    run ends with the assistant message holding its terminal tool call (that message is the
 *    response); the provider requires every `tool_use` to be answered at the start of the next
 *    user message, so it is answered here, when the next turn starts. Calls of a run that failed
 *    are closed by that run itself (see `closePendingCalls`), so an open terminal call here was
 *    delivered.
 * 2. A context block written by the application: today's date and the trip brief so far. It is
 *    per-turn data, kept out of the system prompt so the prompt prefix stays cacheable.
 * 3. The user's own words, in their own block, never mixed with application text.
 */
export interface UserTurnInput {
  readonly history: readonly LlmMessage[];
  readonly userText: string;
  readonly brief: TripBrief;
  readonly today: string;
}

export const DELIVERED_RESULT = 'Delivered to the user.';
export const NOT_EXECUTED_RESULT = 'Not executed: the turn ended before this call ran.';

export function buildUserTurn(input: UserTurnInput): LlmMessage {
  // TODO(learning) — étape 1. Spec : user-turn.test.ts, describe('buildUserTurn').
  // 1. Retrouve les appels d'outils restés ouverts à la fin de l'historique (`pendingToolCalls`).
  // 2. Réponds à chacun par un `tool_result` (`answerOpenCalls`, plus bas).
  // 3. Ajoute le bloc de contexte de l'application (`contextBlock`), puis le texte de
  //    l'utilisateur dans SON PROPRE bloc texte : jamais de mélange application / utilisateur.
  // 4. Construis le message avec `userMessage` : il gèle le message (historique append-only).
  // L'ordre n'est pas libre : l'API exige les `tool_result` en tête du message utilisateur.
  throw new Error('TODO(learning): buildUserTurn (agent-loop, step 1)');
}

function answerOpenCalls(calls: readonly ToolCallBlock[]): ToolResultBlock[] {
  // TODO(learning) — étape 1.
  // Un appel terminal resté ouvert a été livré à l'utilisateur : DELIVERED_RESULT, sans erreur.
  // Un appel d'outil de données resté ouvert n'a jamais tourné : NOT_EXECUTED_RESULT, en erreur.
  // Outils utiles : `isTerminalToolName`, `toolResult`.
  throw new Error('TODO(learning): answerOpenCalls (agent-loop, step 1)');
}

export function contextBlock(today: string, brief: TripBrief): string {
  // TODO(learning) — étape 1. Spec : describe('contextBlock').
  // Cinq lignes, dans l'ordre exact du test : balise ouvrante, une phrase qui dit que
  // l'application (et pas l'utilisateur) a écrit ce bloc, la date du jour, le brief sérialisé
  // (`serializeBrief`), balise fermante.
  throw new Error('TODO(learning): contextBlock (agent-loop, step 1)');
}

/** Fixed key order: the stored turn is replayed verbatim, and the text should not depend on how the brief was loaded. */
export function serializeBrief(brief: TripBrief): string {
  // TODO(learning) — étape 1. Spec : describe('serializeBrief').
  // `JSON.stringify(brief)` ne suffit pas : l'ordre des clés dépend de la façon dont l'objet a été
  // construit (lu en base, reçu du modèle…). Or ce texte est rejoué octet par octet aux tours
  // suivants (cache de prompt, blocs de raisonnement signés). Fixe l'ordre des huit champs.
  throw new Error('TODO(learning): serializeBrief (agent-loop, step 1)');
}
