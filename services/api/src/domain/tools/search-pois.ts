import { PoiKindSchema } from '@wanderly/contracts';
import { z } from 'zod';
import type { PoiFact } from '../ports/knowledge.js';
import { excerpt } from './search-knowledge.js';
import { defineDataTool, requireKnownDestination } from './tool.js';

export const SEARCH_POIS = 'search_pois';

const DEFAULT_LIMIT = 10;
const MAX_DESCRIPTION_CHARS = 300;

const SearchPoisInput = z.object({
  destinationId: z.string().trim().min(1).max(64),
  kinds: z.array(PoiKindSchema).max(8),
  maxCrowdLevel: z.int().min(1).max(5).nullable(),
  month: z.int().min(1).max(12).nullable(),
  limit: z.int().min(1).max(20).nullable(),
});

export const searchPoisTool = defineDataTool({
  name: SEARCH_POIS,
  description: [
    "List points of interest from the guide's listings for one destination, optionally filtered by kinds (matches any), crowd level and month.",
    'Use it to pick concrete places for itinerary items; set an item poiId only to a poiId returned here.',
    'crowdLevel goes from 1 (quiet) to 5 (very crowded) and is null when the guide says nothing; maxCrowdLevel keeps places with an unknown crowd level.',
    'Places recommended for the given month come first. Each result has a `ref` to copy into sourceRefs.',
  ].join(' '),
  input: SearchPoisInput,
  fieldDescriptions: {
    destinationId: 'Catalog id of the destination.',
    kinds: 'Kinds to match (any of them); an empty list returns every kind.',
    maxCrowdLevel: 'Exclude places known to be more crowded than this (1-5), or null.',
    month: 'Travel month (1 = January) to rank seasonal places first, or null.',
    limit: 'Maximum number of results; null for the default (10).',
  },
  async execute(input, context) {
    requireKnownDestination(context, input.destinationId);
    const pois = await context.knowledge.searchPois({
      destinationId: input.destinationId,
      kinds: input.kinds,
      maxCrowdLevel: input.maxCrowdLevel,
      month: input.month,
      limit: input.limit ?? DEFAULT_LIMIT,
    });
    // Defence in depth: only POIs of the requested destination become citable evidence.
    const own = pois.filter((poi) => poi.destinationId === input.destinationId);
    context.evidence.recordPois(own);
    return {
      output: { results: own.map(toResult) },
      summary:
        own.length === 0
          ? `No point of interest found in ${input.destinationId}`
          : `${own.length} point(s) of interest in ${input.destinationId}`,
    };
  },
});

function toResult(poi: PoiFact) {
  return {
    ref: { kind: 'poi', id: poi.id },
    poiId: poi.id,
    name: poi.name,
    kinds: poi.kinds,
    description: poi.description === null ? null : excerpt(poi.description, MAX_DESCRIPTION_CHARS),
    crowdLevel: poi.crowdLevel,
    bestMonths: poi.bestMonths,
    section: poi.sourceRef,
  };
}
