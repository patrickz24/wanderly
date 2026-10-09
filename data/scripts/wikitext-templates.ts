/**
 * Balanced `{{template}}` scanner and parameter parser for MediaWiki wikitext.
 *
 * wtf_wikipedia parses templates too, but it replaces unknown ones (all Wikivoyage listing
 * templates) by an empty string, losing their position in the text. We need the position to keep
 * listings where the author put them, so templates are located here and rendered by our code.
 */

export interface TemplateCall {
  /** Index of the opening `{{` in the scanned text. */
  readonly start: number;
  /** Index just after the closing `}}`. */
  readonly end: number;
  readonly raw: string;
  /** Normalised name: trimmed, lower-case, `_` → space, no `Template:` prefix. */
  readonly name: string;
  /** Named parameters by key, positional ones by `"1"`, `"2"`… Values are raw, trimmed wikitext. */
  readonly params: ReadonlyMap<string, string>;
}

/** Finds the top-level templates of `text` (nested ones stay inside their parent's `raw`). */
export function findTemplates(text: string): TemplateCall[] {
  const calls: TemplateCall[] = [];
  let depth = 0;
  let start = -1;
  let i = 0;
  while (i < text.length - 1) {
    if (text[i] === '{' && text[i + 1] === '{') {
      if (depth === 0) start = i;
      depth++;
      i += 2;
    } else if (text[i] === '}' && text[i + 1] === '}' && depth > 0) {
      depth--;
      i += 2;
      if (depth === 0) calls.push(parseTemplateCall(text.slice(start, i), start));
    } else {
      i++;
    }
  }
  return calls;
}

/** Replaces every top-level template by the string returned by `render`. */
export function replaceTemplates(text: string, render: (call: TemplateCall) => string): string {
  let out = '';
  let cursor = 0;
  for (const call of findTemplates(text)) {
    out += text.slice(cursor, call.start) + render(call);
    cursor = call.end;
  }
  return out + text.slice(cursor);
}

export function normaliseTemplateName(name: string): string {
  return name
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*template\s*:/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Splits on `separator` characters that are not nested inside `{{…}}` or `[[…]]`. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let braces = 0;
  let brackets = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const pair = text.slice(i, i + 2);
    if (pair === '{{') {
      braces++;
      current += pair;
      i++;
    } else if (pair === '}}' && braces > 0) {
      braces--;
      current += pair;
      i++;
    } else if (pair === '[[') {
      brackets++;
      current += pair;
      i++;
    } else if (pair === ']]' && brackets > 0) {
      brackets--;
      current += pair;
      i++;
    } else if (text[i] === separator && braces === 0 && brackets === 0) {
      parts.push(current);
      current = '';
    } else {
      current += text[i];
    }
  }
  parts.push(current);
  return parts;
}

function parseTemplateCall(raw: string, start: number): TemplateCall {
  const [head = '', ...args] = splitTopLevel(raw.slice(2, -2), '|');
  const params = new Map<string, string>();
  let position = 0;
  for (const arg of args) {
    const [key, ...rest] = splitTopLevel(arg, '=');
    if (rest.length > 0 && key !== undefined && key.trim() !== '' && !/[{}[\]]/.test(key)) {
      params.set(key.trim().toLowerCase(), rest.join('=').trim());
    } else {
      position++;
      params.set(String(position), arg.trim());
    }
  }
  return { start, end: start + raw.length, raw, name: normaliseTemplateName(head), params };
}

/** Returns a parameter value, or `null` when absent or blank. */
export function param(call: TemplateCall, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = call.params.get(key);
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return null;
}
