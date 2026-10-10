import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { DESTINATIONS_FILE } from './paths.js';
import { MAX_PLACES } from './places.js';

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
  /** Place articles (cities, towns, islands, parks) chosen by select-places.ts. */
  places: z
    .array(
      z.strictObject({
        id: z.string().regex(SLUG, 'place id must be a kebab-case slug'),
        title: z.string().min(1),
      }),
    )
    .max(MAX_PLACES)
    .default([])
    .refine(
      (places) => new Set(places.map((place) => place.id)).size === places.length,
      'place ids must be unique',
    ),
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

/** One Markdown document of a destination: its region guide or one of its place articles. */
export interface DocumentSpec {
  readonly destinationId: string;
  /** null for the region guide. */
  readonly placeId: string | null;
  readonly title: string;
  readonly role: 'region' | 'place';
}

/** The region guide first, then the place articles in the order of destinations.yaml. */
export function destinationDocuments(destination: Destination): DocumentSpec[] {
  return [
    {
      destinationId: destination.id,
      placeId: null,
      title: destination.wikivoyage_title,
      role: 'region',
    },
    ...destination.places.map((place) => ({
      destinationId: destination.id,
      placeId: place.id,
      title: place.title,
      role: 'place' as const,
    })),
  ];
}
