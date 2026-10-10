import type { AgentResponse, SourceRef, SourceSummary } from '@wanderly/contracts';
import type { DestinationCatalog } from '../agent/catalog.js';
import { monthName } from '../tools/get-seasonal-weather.js';
import type { EvidenceRegistry } from '../tools/evidence.js';
import { excerpt } from '../tools/search-knowledge.js';

const SNIPPET_CHARS = 240;

/**
 * Licence shown next to each source. The whole corpus (guides, listings and the POIs and prices
 * derived from them) comes from Wikivoyage; climate normals come from Open-Meteo.
 */
export const WIKIVOYAGE_LICENSE = 'CC BY-SA 4.0';
export const OPEN_METEO_LICENSE = 'Weather data by Open-Meteo.com (CC BY 4.0)';

/** Every piece of evidence a response cites (refs, POIs, budget, weather), deduplicated in order. */
export function citedRefs(response: AgentResponse): SourceRef[] {
  const refs: SourceRef[] = [];
  if (response.type === 'answer') refs.push(...response.sourceRefs);
  if (response.type === 'itinerary') {
    const { itinerary } = response;
    for (const day of itinerary.days) {
      for (const item of day.items) {
        if (item.poiId !== null) refs.push({ kind: 'poi', id: item.poiId });
        refs.push(...item.sourceRefs);
      }
    }
    if (itinerary.weather !== null) {
      refs.push({ kind: 'weather', id: itinerary.weather.fromToolCallId });
    }
    if (itinerary.budget !== null) {
      refs.push({ kind: 'budget', id: itinerary.budget.fromToolCallId });
    }
  }
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Resolves cited evidence for display. Refs without evidence (rejected earlier) are skipped. */
export function resolveSources(
  response: AgentResponse,
  evidence: EvidenceRegistry,
  catalog: DestinationCatalog,
): SourceSummary[] {
  return citedRefs(response)
    .map((ref) => toSummary(ref, evidence, catalog))
    .filter((source): source is SourceSummary => source !== null);
}

function toSummary(
  ref: SourceRef,
  evidence: EvidenceRegistry,
  catalog: DestinationCatalog,
): SourceSummary | null {
  switch (ref.kind) {
    case 'chunk': {
      const chunk = evidence.chunk(ref.id);
      if (chunk === undefined) return null;
      return {
        kind: 'chunk',
        id: chunk.id,
        title: chunk.headingPath.trim() === '' ? chunk.documentTitle : chunk.headingPath,
        destinationId: chunk.destinationId,
        snippet: excerpt(chunk.content, SNIPPET_CHARS),
        url: httpUrlOrNull(chunk.sourceUrl),
        license: WIKIVOYAGE_LICENSE,
      };
    }
    case 'poi': {
      const poi = evidence.poi(ref.id);
      if (poi === undefined) return null;
      return {
        kind: 'poi',
        id: poi.id,
        title: poi.name,
        destinationId: poi.destinationId,
        snippet: poi.description === null ? null : excerpt(poi.description, SNIPPET_CHARS),
        url: null,
        license: WIKIVOYAGE_LICENSE,
      };
    }
    case 'weather': {
      const weather = evidence.weather(ref.id);
      if (weather === undefined) return null;
      const { fact } = weather;
      return {
        kind: 'weather',
        id: ref.id,
        title: `Climate in ${placeName(fact.destinationId, catalog)}, ${monthName(fact.month)}`,
        destinationId: fact.destinationId,
        snippet: `${monthName(fact.month)}: ${fact.avgHighC}°C / ${fact.avgLowC}°C, ${fact.rainDays} rainy days, ${fact.precipitationMm} mm`,
        url: 'https://open-meteo.com/',
        license: OPEN_METEO_LICENSE,
      };
    }
    case 'budget': {
      const budget = evidence.budget(ref.id);
      if (budget === undefined) return null;
      const { estimate } = budget;
      return {
        kind: 'budget',
        id: ref.id,
        title: `Budget estimate (${estimate.level}), ${placeName(estimate.destinationId, catalog)}`,
        destinationId: estimate.destinationId,
        snippet:
          estimate.total === null || estimate.currency === null
            ? 'No complete price in the guide.'
            : `${estimate.total} ${estimate.currency} for ${estimate.travelers} traveller(s), ${estimate.days} day(s)`,
        url: null,
        license: WIKIVOYAGE_LICENSE,
      };
    }
  }
}

function placeName(destinationId: string, catalog: DestinationCatalog): string {
  return catalog.get(destinationId)?.name ?? destinationId;
}

function httpUrlOrNull(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const { protocol } = new URL(value);
  return protocol === 'https:' || protocol === 'http:' ? value : null;
}
