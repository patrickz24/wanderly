/**
 * Zod schema of the YAML front matter of `data/corpus/<id>/guide.md` (provenance and licence of
 * the Markdown guide). Only depends on Zod so that the API ingestion can reuse it.
 */
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

export const GuideFrontMatterSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: nonEmpty,
  source_url: z.url(),
  revision_id: z.int().positive(),
  revision_timestamp: z.iso.datetime(),
  revision_url: z.url(),
  retrieved_at: z.iso.datetime(),
  license: nonEmpty,
  license_url: z.url(),
  attribution: nonEmpty,
  is_part_of: z.array(nonEmpty),
});
export type GuideFrontMatter = z.infer<typeof GuideFrontMatterSchema>;
