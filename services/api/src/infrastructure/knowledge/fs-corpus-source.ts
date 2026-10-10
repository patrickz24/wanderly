import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FactsSchema,
  GuideFrontMatterSchema,
  type Facts,
  type GuideFrontMatter,
} from '@wanderly/contracts';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import {
  CorpusValidationError,
  type Corpus,
  type CorpusDestination,
  type CorpusDocument,
  type CorpusSource,
} from '../../application/ports/corpus-source.js';
import { BREADCRUMB_SEPARATOR } from '../../domain/rag/chunker.js';

/** `data/corpus` of the repository, from both `src/` and `dist/` builds. */
export const DEFAULT_CORPUS_DIR = fileURLToPath(
  new URL('../../../../../data/corpus', import.meta.url),
);

const FACTS_FILE = 'facts.yaml';
const GUIDE_FILE = 'guide.md';
const PLACES_DIR = 'places';
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const PLACE_FILE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/**
 * Reads `data/corpus/<id>/{facts.yaml, guide.md, places/*.md}` and validates every file with the
 * shared Zod schemas of `@wanderly/contracts`. All problems are collected and reported together;
 * nothing is returned unless the whole corpus is valid. File content is untrusted data: it is
 * parsed and validated, never executed.
 */
export class FsCorpusSource implements CorpusSource {
  constructor(private readonly root: string = DEFAULT_CORPUS_DIR) {}

  async load(): Promise<Corpus> {
    const issues: string[] = [];
    const entries = await readdir(this.root, { withFileTypes: true });
    const ids = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();

    const destinations: CorpusDestination[] = [];
    for (const id of ids) {
      const destination = await this.#loadDestination(id, issues);
      if (destination !== null) destinations.push(destination);
    }
    if (issues.length > 0) throw new CorpusValidationError(issues);
    if (destinations.length === 0) {
      throw new CorpusValidationError([`${this.root}: no destination directory found`]);
    }
    return { destinations };
  }

  async #loadDestination(id: string, issues: string[]): Promise<CorpusDestination | null> {
    const facts = await this.#readFacts(id, issues);
    const guide = await this.#readDocument(`${id}/${GUIDE_FILE}`, issues);
    if (facts === null || guide === null) return null;

    const before = issues.length;
    if (facts.id !== id) issues.push(`${id}/${FACTS_FILE}: id "${facts.id}" must be "${id}"`);
    if (guide.frontMatter.id !== id || guide.frontMatter.parent !== undefined) {
      issues.push(`${id}/${GUIDE_FILE}: front matter must have id "${id}" and no parent`);
    }
    if (guide.frontMatter.revision_id !== facts.source.revision_id) {
      issues.push(
        `${id}/${FACTS_FILE}: source.revision_id ${facts.source.revision_id} differs from ` +
          `the guide revision ${guide.frontMatter.revision_id} (regenerate the facts)`,
      );
    }

    const places = await this.#readPlaces(id, facts, issues);
    if (issues.length > before || places === null) return null;

    const region = toDocument(guide, id, 'region', facts.name);
    const placeDocuments = places.map((place) =>
      toDocument(
        place,
        id,
        'place',
        [facts.name, place.frontMatter.title].join(BREADCRUMB_SEPARATOR),
      ),
    );
    return {
      facts,
      factsAsOf: guide.frontMatter.revision_timestamp.slice(0, 10),
      documents: [region, ...placeDocuments],
    };
  }

  async #readFacts(id: string, issues: string[]): Promise<Facts | null> {
    const file = `${id}/${FACTS_FILE}`;
    const text = await this.#readText(file, issues);
    if (text === null) return null;
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (error) {
      issues.push(`${file}: invalid YAML (${messageOf(error)})`);
      return null;
    }
    return validate(FactsSchema, raw, file, issues);
  }

  async #readPlaces(id: string, facts: Facts, issues: string[]): Promise<ParsedDocument[] | null> {
    let files: string[];
    try {
      const entries = await readdir(path.join(this.root, id, PLACES_DIR), { withFileTypes: true });
      files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isNotFound(error)) files = [];
      else throw error;
    }

    const before = issues.length;
    const places: ParsedDocument[] = [];
    for (const name of files) {
      const file = `${id}/${PLACES_DIR}/${name}`;
      if (!PLACE_FILE.test(name)) {
        issues.push(`${file}: place files must be named <place-id>.md`);
        continue;
      }
      const place = await this.#readDocument(file, issues);
      if (place === null) continue;
      const placeId = name.slice(0, -'.md'.length);
      if (place.frontMatter.id !== placeId || place.frontMatter.parent !== id) {
        issues.push(`${file}: front matter must have id "${placeId}" and parent "${id}"`);
        continue;
      }
      places.push(place);
    }

    // facts.yaml lists the documents the facts were derived from (when generated with places).
    if (facts.documents !== undefined) {
      const listed = new Set(
        facts.documents.filter((entry) => entry.role === 'place').map((entry) => entry.file),
      );
      const found = new Set(files.map((name) => `${PLACES_DIR}/${name}`));
      for (const file of listed) {
        if (!found.has(file)) issues.push(`${id}/${FACTS_FILE}: lists ${file}, which is missing`);
      }
      for (const file of found) {
        if (!listed.has(file)) issues.push(`${id}/${file}: not listed in ${FACTS_FILE} documents`);
      }
    }
    return issues.length > before ? null : places;
  }

  async #readDocument(file: string, issues: string[]): Promise<ParsedDocument | null> {
    const text = await this.#readText(file, issues);
    if (text === null) return null;
    const match = FRONT_MATTER.exec(text);
    if (match === null) {
      issues.push(`${file}: missing YAML front matter`);
      return null;
    }
    let raw: unknown;
    try {
      raw = parseYaml(match[1] ?? '');
    } catch (error) {
      issues.push(`${file}: invalid front matter YAML (${messageOf(error)})`);
      return null;
    }
    const frontMatter = validate(GuideFrontMatterSchema, raw, file, issues);
    if (frontMatter === null) return null;
    const body = text.slice(match[0].length).replace(/\r\n?/g, '\n').trim();
    return { file, frontMatter, body, checksum: sha256(text) };
  }

  async #readText(file: string, issues: string[]): Promise<string | null> {
    try {
      return await readFile(path.join(this.root, file), 'utf8');
    } catch (error) {
      if (!isNotFound(error)) throw error;
      issues.push(`${file}: missing`);
      return null;
    }
  }
}

interface ParsedDocument {
  readonly file: string;
  readonly frontMatter: GuideFrontMatter;
  readonly body: string;
  readonly checksum: string;
}

function toDocument(
  parsed: ParsedDocument,
  destinationId: string,
  role: CorpusDocument['role'],
  breadcrumbRoot: string,
): CorpusDocument {
  return {
    path: parsed.file,
    destinationId,
    role,
    title: parsed.frontMatter.title,
    breadcrumbRoot,
    sourceUrl: parsed.frontMatter.revision_url,
    license: parsed.frontMatter.license,
    attribution: parsed.frontMatter.attribution,
    body: parsed.body,
    checksum: parsed.checksum,
  };
}

function validate<Schema extends z.ZodType>(
  schema: Schema,
  raw: unknown,
  file: string,
  issues: string[],
): z.output<Schema> | null {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const at = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    issues.push(`${file}: ${at}: ${issue.message}`);
  }
  return null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
