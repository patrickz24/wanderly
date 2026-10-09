/**
 * Zod schema of `data/corpus/<id>/facts.yaml`, the structured half of the corpus.
 *
 * Self-contained on purpose (only depends on Zod) so that the API can reuse it at milestone 2
 * to validate the corpus at ingestion. Every number in a facts file is derived from a source:
 * climate normals from Open-Meteo, costs from prices written in Wikivoyage listings. Unknown
 * values are `null`, never estimates.
 */
import { z } from 'zod';

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

export const COST_LEVELS = ['budget', 'mid', 'comfort'] as const;
export type CostLevelName = (typeof COST_LEVELS)[number];

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
  /** Heading path of the guide section the POI comes from, e.g. "See > Museums". */
  source_ref: nonEmpty,
});
export type Poi = z.infer<typeof PoiSchema>;

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
    }),
  })
  .superRefine((facts, ctx) => {
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
