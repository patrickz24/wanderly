/**
 * Schemas of the destination corpus in `data/corpus/<id>/`: the YAML front matter of the
 * Markdown guides (provenance and licence) and `facts.yaml` (the structured half: identity,
 * climate normals, costs, POIs). Produced by the scripts in `data/scripts/` and validated again
 * by the API when it ingests the corpus.
 *
 * Every number in a facts file is derived from a source: climate normals from Open-Meteo, costs
 * from prices written in Wikivoyage listings. Unknown values are `null`, never estimates.
 */
import { z } from 'zod';
import { type BudgetLevel, BudgetLevelSchema } from './agent.js';

export const FACTS_SCHEMA_VERSION = 1;

export const POI_KINDS = [
  'hiking',
  'beach',
  'nature',
  'historic_site',
  'museum',
  'religious_site',
  'village',
  'viewpoint',
  'boat_trip',
  'food',
  'wine',
  'nightlife',
  'family',
  'adventure',
  'other',
] as const;

export const PoiKindSchema = z.enum(POI_KINDS);
export type PoiKind = z.infer<typeof PoiKindSchema>;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const nonEmpty = z.string().trim().min(1);

export const ClimateMonthSchema = z.strictObject({
  month: z.int().min(1).max(12),
  avg_high_c: z.number(),
  avg_low_c: z.number(),
  /** Mean number of days per month with precipitation >= 1 mm. */
  rain_days: z.number().min(0).max(31),
  /** Mean monthly precipitation total. */
  precipitation_mm: z.number().min(0),
});
export type ClimateMonth = z.infer<typeof ClimateMonthSchema>;

export const ClimateSchema = z
  .strictObject({
    provider: nonEmpty,
    model: nonEmpty,
    period: z.strictObject({ start: z.string().regex(ISO_DATE), end: z.string().regex(ISO_DATE) }),
    point: z.strictObject({ lat: z.number(), lon: z.number(), source: nonEmpty }),
    grid_cell: z.strictObject({ lat: z.number(), lon: z.number(), elevation_m: z.number() }),
    license: nonEmpty,
    attribution: nonEmpty,
    months: z.array(ClimateMonthSchema).length(12),
  })
  .superRefine((climate, ctx) => {
    climate.months.forEach((entry, index) => {
      if (entry.month !== index + 1) {
        ctx.addIssue({
          code: 'custom',
          message: `months must be ordered 1..12 (found ${entry.month} at position ${index + 1})`,
          path: ['months', index, 'month'],
        });
      }
      if (entry.avg_low_c > entry.avg_high_c) {
        ctx.addIssue({
          code: 'custom',
          message: 'avg_low_c is above avg_high_c',
          path: ['months', index],
        });
      }
    });
  });
export type Climate = z.infer<typeof ClimateSchema>;

/** A price statistic computed from listing prices written in one currency. */
export const CostFigureSchema = z.strictObject({
  median: z.number().nonnegative(),
  min: z.number().nonnegative(),
  max: z.number().nonnegative(),
  /** Currency token as written in the source ("€", "kr", "NOK"…), never converted. */
  currency: nonEmpty,
  /** Listings that contributed to the statistic. */
  sample_size: z.int().positive(),
  /** Priced listings left out because they use another currency than the majority. */
  excluded_other_currency: z.int().nonnegative(),
});
export type CostFigure = z.infer<typeof CostFigureSchema>;

export const CostLevelSchema = z.strictObject({
  lodging_night: CostFigureSchema.nullable(),
  meal: CostFigureSchema.nullable(),
  /** Why a value is null, or caveats about the sample. */
  notes: z.array(nonEmpty),
});
export type CostLevel = z.infer<typeof CostLevelSchema>;

/** Cost levels share the agent's budget vocabulary (`BudgetLevelSchema`). */
export const COST_LEVELS = BudgetLevelSchema.options;
export type CostLevelName = BudgetLevel;

export const CostsSchema = z.strictObject({
  derivation: nonEmpty,
  /** All priced Sleep / Eat listings, whatever their subsection. */
  overall: CostLevelSchema,
  /** Only listings under Budget / Mid-range / Splurge subsections (Wikivoyage convention). */
  levels: z.strictObject({
    budget: CostLevelSchema,
    mid: CostLevelSchema,
    comfort: CostLevelSchema,
  }),
});
export type Costs = z.infer<typeof CostsSchema>;

export const PoiSchema = z.strictObject({
  id: z.string().regex(SLUG),
  name: nonEmpty,
  kinds: z
    .array(PoiKindSchema)
    .min(1)
    .refine((kinds) => new Set(kinds).size === kinds.length, 'kinds must be unique'),
  description: nonEmpty.nullable(),
  /** 1 (quiet) … 5 (very crowded). Null until a curation pass finds support in the guide. */
  crowd_level: z.int().min(1).max(5).nullable(),
  /** Months (1-12) the guide recommends. Empty until a curation pass finds support in the guide. */
  best_months: z
    .array(z.int().min(1).max(12))
    .refine((months) => new Set(months).size === months.length, 'best_months must be unique'),
  /**
   * Where the POI comes from: the title of the source document (region guide or place article)
   * followed by the heading path of its section, e.g. "Palermo > See > Museums".
   */
  source_ref: nonEmpty,
  /**
   * Sentences of the source document, copied verbatim, that support `crowd_level` (empty when it
   * is null). Optional: absent in files written before the curation pass.
   */
  crowd_evidence: z.array(nonEmpty).optional(),
  /** Sentences of the source document, copied verbatim, that support `best_months`. */
  months_evidence: z.array(nonEmpty).optional(),
});
export type Poi = z.infer<typeof PoiSchema>;

/** Markdown file of a destination, relative to `data/corpus/<id>/`. */
const DOCUMENT_FILE = /^(?:guide\.md|places\/[a-z0-9]+(?:-[a-z0-9]+)*\.md)$/;

/**
 * A Markdown document of a destination: the region guide (`guide.md`) or a place article
 * (`places/<place-id>.md`, a city, town, island or park listed by the region article).
 */
export const CorpusDocumentSchema = z.strictObject({
  file: z.string().regex(DOCUMENT_FILE),
  role: z.enum(['region', 'place']),
  /** Destination id for the region guide, place id for a place article. */
  id: z.string().regex(SLUG),
  title: nonEmpty,
  url: z.url(),
  revision_id: z.int().positive(),
  license: nonEmpty,
});
export type CorpusDocument = z.infer<typeof CorpusDocumentSchema>;

export const FactsSchema = z
  .strictObject({
    schema_version: z.literal(FACTS_SCHEMA_VERSION),
    id: z.string().regex(SLUG),
    name: nonEmpty,
    country: nonEmpty,
    aliases: z.array(nonEmpty),
    /** Wikivoyage breadcrumb parents (`{{IsPartOf}}`). */
    is_part_of: z.array(nonEmpty),
    source: z.strictObject({
      guide: z.literal('guide.md'),
      title: nonEmpty,
      url: z.url(),
      revision_id: z.int().positive(),
      license: nonEmpty,
    }),
    /**
     * Every document the facts were derived from, region guide first (optional for files written
     * before place articles were added; always present in generated files).
     */
    documents: z.array(CorpusDocumentSchema).min(1).optional(),
    climate: ClimateSchema,
    costs: CostsSchema,
    pois: z.array(PoiSchema),
    /** Counters from the extraction, for review and corpus statistics. */
    extraction: z.strictObject({
      listings: z.int().nonnegative(),
      listings_by_type: z.record(z.string(), z.int().nonnegative()),
      priced_listings: z.strictObject({
        sleep: z.int().nonnegative(),
        eat: z.int().nonnegative(),
      }),
      poi_sources: z.strictObject({
        listing: z.int().nonnegative(),
        marker: z.int().nonnegative(),
        named: z.int().nonnegative(),
      }),
      duplicate_pois_dropped: z.int().nonnegative(),
      /** List items dropped because they name a generic activity or category, not a place. */
      generic_items_pruned: z.int().nonnegative().optional(),
    }),
  })
  .superRefine((facts, ctx) => {
    facts.pois.forEach((poi, index) => {
      if (
        poi.crowd_evidence !== undefined &&
        (poi.crowd_level === null) !== (poi.crowd_evidence.length === 0)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'crowd_level and crowd_evidence must be both set or both empty',
          path: ['pois', index, 'crowd_evidence'],
        });
      }
      if (
        poi.months_evidence !== undefined &&
        (poi.best_months.length === 0) !== (poi.months_evidence.length === 0)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'best_months and months_evidence must be both set or both empty',
          path: ['pois', index, 'months_evidence'],
        });
      }
    });
    if (facts.documents !== undefined) {
      const [first, ...rest] = facts.documents;
      if (
        first?.role !== 'region' ||
        first.file !== 'guide.md' ||
        first.revision_id !== facts.source.revision_id
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'documents must start with the region guide (guide.md, same revision as source)',
          path: ['documents', 0],
        });
      }
      const files = new Set<string>();
      rest.forEach((document, index) => {
        if (document.role !== 'place' || files.has(document.file)) {
          ctx.addIssue({
            code: 'custom',
            message: 'documents after the first must be distinct place articles',
            path: ['documents', index + 1],
          });
        }
        files.add(document.file);
      });
    }
    const ids = new Set<string>();
    facts.pois.forEach((poi, index) => {
      if (!poi.id.startsWith(`${facts.id}-`)) {
        ctx.addIssue({
          code: 'custom',
          message: `POI id must start with "${facts.id}-"`,
          path: ['pois', index, 'id'],
        });
      }
      if (ids.has(poi.id)) {
        ctx.addIssue({ code: 'custom', message: 'duplicate POI id', path: ['pois', index, 'id'] });
      }
      ids.add(poi.id);
    });
  });
export type Facts = z.infer<typeof FactsSchema>;

// ---------------------------------------------------------------------------------------------
// Guide front matter
// ---------------------------------------------------------------------------------------------

export const GuideFrontMatterSchema = z.strictObject({
  id: z.string().regex(SLUG),
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
  /** Destination id, for a place article (`places/<place-id>.md`); absent for a region guide. */
  parent: z.string().regex(SLUG).optional(),
});
export type GuideFrontMatter = z.infer<typeof GuideFrontMatterSchema>;
