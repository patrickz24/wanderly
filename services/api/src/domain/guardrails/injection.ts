/**
 * Prompt-injection heuristics. They produce SIGNALS for traces and evals, never a block: regexes
 * are trivial to evade (paraphrase, another language, encoding) and would also flag legitimate
 * text, so the real defences are elsewhere: read-only tools, instructions/data separation in the
 * prompt, output validation and the canary tripwire.
 */

const PATTERNS: ReadonlyArray<readonly [signal: string, pattern: RegExp]> = [
  [
    'ignore_instructions',
    /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|the|system)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?|directives?)\b/i,
  ],
  [
    'ignore_instructions',
    /\b(ignore[zr]?|oublie[zr]?)\b[^.\n]{0,40}\b(instructions?|consignes?|r[èe]gles?)\b/i,
  ],
  [
    'prompt_extraction',
    /\b(reveal|show|print|repeat|display|output|tell me|what (is|are))\b[^.\n]{0,40}\b(system prompt|instructions|initial prompt|hidden prompt)\b/i,
  ],
  ['prompt_extraction', /\b(prompt syst[èe]me|tes instructions|vos instructions)\b/i],
  [
    'role_override',
    /\b(you are now|from now on,? you|act as|pretend (to be|you are)|developer mode|jailbreak)\b/i,
  ],
  // Case-sensitive: "Dan" is a name.
  ['role_override', /\bDAN\b/],
  ['fake_system_tag', /<\/?\s*(system|assistant|instructions?|context)\s*>|\[\/?(system|INST)\]/i],
];

/** Distinct signal names found in `text`, in a stable order. */
export function detectInjectionSignals(text: string): string[] {
  const found = new Set<string>();
  for (const [signal, pattern] of PATTERNS) {
    if (pattern.test(text)) found.add(signal);
  }
  return [...found];
}
