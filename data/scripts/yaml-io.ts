import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';
import { parse } from 'yaml';
import { stringifyYaml } from './yaml-text.js';

/**
 * Writes data as YAML formatted by the repository's Prettier config, so that generated files are
 * stable under the pre-commit hook (lint-staged runs Prettier on YAML).
 */
export async function writeYamlFile(
  file: string,
  data: unknown,
  headerComment: string | null = null,
): Promise<void> {
  const header =
    headerComment === null
      ? ''
      : `${headerComment
          .split('\n')
          .map((line) => `# ${line}`.trimEnd())
          .join('\n')}\n`;
  const raw = header + stringifyYaml(data);
  const config = (await resolveConfig(file)) ?? {};
  const formatted = await format(raw, { ...config, filepath: file });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, formatted, 'utf8');
}

export async function readYamlFile(file: string): Promise<unknown> {
  return parse(await readFile(file, 'utf8'));
}

export async function writeTextFile(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

export async function readJsonIfExists(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
