import { parse } from 'yaml';
import { stringifyYaml } from './yaml-text.js';

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/;

/** Splits `---\n<yaml>\n---\n<body>`; `data` is unknown until validated by the caller. */
export function parseFrontMatter(text: string): { data: unknown; body: string } {
  const normalised = text.replace(/\r\n?/g, '\n');
  const match = FRONT_MATTER.exec(normalised);
  if (match === null) throw new Error('missing YAML front matter');
  return { data: parse(match[1] ?? ''), body: normalised.slice(match[0].length) };
}

export function withFrontMatter(data: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(data)}---\n\n${body}`;
}
