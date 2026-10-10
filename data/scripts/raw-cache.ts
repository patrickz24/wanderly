/** Raw Wikivoyage download cache (`data/raw/wikivoyage/<id>.json`, gitignored). */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { rawWikivoyagePath } from './paths.js';
import { readJsonIfExists } from './yaml-io.js';

export const RawArticleSchema = z.strictObject({
  title: z.string().min(1),
  page_id: z.number(),
  revision_id: z.int().positive(),
  revision_timestamp: z.string(),
  canonical_url: z.url(),
  coordinates: z.strictObject({ lat: z.number(), lon: z.number() }).nullable(),
  retrieved_at: z.string(),
  license: z.strictObject({ name: z.string(), text: z.string(), url: z.url() }),
  wikitext: z.string(),
});
export type RawArticle = z.infer<typeof RawArticleSchema>;

export async function readRawArticle(
  id: string,
  placeId: string | null = null,
): Promise<RawArticle | null> {
  const file = rawWikivoyagePath(id, placeId);
  const data = await readJsonIfExists(file);
  if (data === null) return null;
  const parsed = RawArticleSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Corrupt cache ${file}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export async function writeRawArticle(
  id: string,
  placeId: string | null,
  article: RawArticle,
): Promise<void> {
  const file = rawWikivoyagePath(id, placeId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(article, null, 2)}\n`, 'utf8');
}
