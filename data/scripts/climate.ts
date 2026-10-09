/**
 * Monthly climate normals from daily Open-Meteo archive data (pure, deterministic).
 *
 * For each calendar month m:
 * - avg_high_c / avg_low_c: mean of all daily max / min temperatures of month m over the period;
 * - precipitation_mm: mean over years of the monthly precipitation total;
 * - rain_days: mean over years of the number of days with precipitation >= 1 mm.
 * A (year, month) with a missing daily precipitation value is left out of the precipitation
 * means rather than counted as dry. Values are rounded to one decimal.
 */
import { z } from 'zod';
import { type ClimateMonth, ClimateMonthSchema } from './facts-schema.js';

export const RAIN_DAY_THRESHOLD_MM = 1;

/** Shape of the Open-Meteo archive response fields we use (validated, never trusted). */
export const OpenMeteoDailySchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  elevation: z.number(),
  timezone: z.string(),
  daily: z.object({
    time: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    temperature_2m_max: z.array(z.number().nullable()),
    temperature_2m_min: z.array(z.number().nullable()),
    precipitation_sum: z.array(z.number().nullable()),
  }),
});
export type OpenMeteoDaily = z.infer<typeof OpenMeteoDailySchema>;

export const round1 = (value: number): number => Math.round(value * 10) / 10;

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

interface MonthAccumulator {
  readonly highs: number[];
  readonly lows: number[];
  /** Per year: precipitation total and rain days, or null when a day is missing. */
  readonly years: Map<number, { total: number; rainDays: number } | null>;
}

export interface ClimateAggregation {
  readonly months: ClimateMonth[];
  /** Days with at least one missing variable (reported, not fatal unless a month is empty). */
  readonly missingDays: number;
}

export function aggregateMonthlyNormals(daily: OpenMeteoDaily['daily']): ClimateAggregation {
  const { time, temperature_2m_max: highs, temperature_2m_min: lows } = daily;
  const precipitation = daily.precipitation_sum;
  if (
    highs.length !== time.length ||
    lows.length !== time.length ||
    precipitation.length !== time.length
  ) {
    throw new Error('Open-Meteo daily arrays have different lengths');
  }
  const months: MonthAccumulator[] = Array.from({ length: 12 }, () => ({
    highs: [],
    lows: [],
    years: new Map(),
  }));
  let missingDays = 0;
  time.forEach((date, index) => {
    const year = Number(date.slice(0, 4));
    const accumulator = months[Number(date.slice(5, 7)) - 1];
    if (accumulator === undefined) throw new Error(`Invalid date "${date}"`);
    const high = highs[index] ?? null;
    const low = lows[index] ?? null;
    const rain = precipitation[index] ?? null;
    if (high === null || low === null || rain === null) missingDays++;
    if (high !== null) accumulator.highs.push(high);
    if (low !== null) accumulator.lows.push(low);
    const current = accumulator.years.has(year)
      ? (accumulator.years.get(year) ?? null)
      : { total: 0, rainDays: 0 };
    if (current === null || rain === null) {
      accumulator.years.set(year, null);
    } else {
      accumulator.years.set(year, {
        total: current.total + rain,
        rainDays: current.rainDays + (rain >= RAIN_DAY_THRESHOLD_MM ? 1 : 0),
      });
    }
  });
  return {
    missingDays,
    months: months.map((accumulator, index) => {
      const complete = [...accumulator.years.values()].filter(
        (value): value is { total: number; rainDays: number } => value !== null,
      );
      if (
        accumulator.highs.length === 0 ||
        accumulator.lows.length === 0 ||
        complete.length === 0
      ) {
        throw new Error(`No usable data for month ${index + 1}`);
      }
      return {
        month: index + 1,
        avg_high_c: round1(mean(accumulator.highs)),
        avg_low_c: round1(mean(accumulator.lows)),
        rain_days: round1(mean(complete.map((value) => value.rainDays))),
        precipitation_mm: round1(mean(complete.map((value) => value.total))),
      };
    }),
  };
}

export const CLIMATE_PERIOD = { start: '2015-01-01', end: '2024-12-31' } as const;
/** ERA5-Land temperatures (0.1°) with ERA5 fallback: one consistent reanalysis for the period. */
export const CLIMATE_MODEL = 'era5_seamless';

export const CLIMATE_PROVIDER = 'Open-Meteo Historical Weather API';
export const CLIMATE_LICENSE = 'CC BY 4.0';
export const CLIMATE_ATTRIBUTION =
  'Weather data by Open-Meteo.com (https://open-meteo.com/), licensed under CC BY 4.0. ' +
  'Generated using Copernicus Climate Change Service information (ERA5 and ERA5-Land reanalyses).';

/** File written for each destination and read back by build-facts. */
export const ClimateFileSchema = z.strictObject({
  id: z.string(),
  provider: z.string(),
  model: z.string(),
  period: z.strictObject({ start: z.string(), end: z.string() }),
  point: z.strictObject({ lat: z.number(), lon: z.number(), source: z.string() }),
  grid_cell: z.strictObject({ lat: z.number(), lon: z.number(), elevation_m: z.number() }),
  timezone: z.string(),
  license: z.string(),
  attribution: z.string(),
  retrieved_at: z.string(),
  missing_days: z.int().nonnegative(),
  months: z.array(ClimateMonthSchema).length(12),
});
export type ClimateFile = z.infer<typeof ClimateFileSchema>;
