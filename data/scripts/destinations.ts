import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { DESTINATIONS_FILE } from './paths.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const DestinationSchema = z.strictObject({
  id: z.string().regex(SLUG, 'id must be a kebab-case slug'),
  name: z.string().min(1),
  country: z.string().min(1),
  wikivoyage_title: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  climate_point: z.strictObject({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    source: z.string().min(1),
  }),
  substitution: z
    .strictObject({ requested: z.string().min(1), reason: z.string().min(1) })
    .optional(),
  note: z.string().min(1).optional(),
});

export const DestinationListSchema = z
  .strictObject({ destinations: z.array(DestinationSchema).min(1) })
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const [index, destination] of list.destinations.entries()) {
      if (seen.has(destination.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate destination id "${destination.id}"`,
          path: ['destinations', index, 'id'],
        });
      }
      seen.add(destination.id);
    }
  });

export type Destination = z.infer<typeof DestinationSchema>;

export async function loadDestinations(file: string = DESTINATIONS_FILE): Promise<Destination[]> {
  const parsed = DestinationListSchema.safeParse(parse(await readFile(file, 'utf8')));
  if (!parsed.success) {
    throw new Error(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.destinations;
}

/** Applies the `--only <id>` CLI filter; fails loudly on an unknown id. */
export function selectDestinations(
  destinations: readonly Destination[],
  only: string | null,
): Destination[] {
  if (only === null) return [...destinations];
  const match = destinations.filter((d) => d.id === only);
  if (match.length === 0) {
    throw new Error(`Unknown destination id "${only}" (see data/destinations.yaml)`);
  }
  return match;
}
