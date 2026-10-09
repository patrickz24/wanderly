import { describe, expect, it } from 'vitest';
import { type OpenMeteoDaily, aggregateMonthlyNormals, round1 } from './climate.js';

type Daily = OpenMeteoDaily['daily'];

/** Builds a daily series for the given years where `day(date)` returns [max, min, precipitation]. */
function series(
  years: readonly number[],
  day: (date: Date) => [number | null, number | null, number | null],
): Daily {
  const daily: Daily = {
    time: [],
    temperature_2m_max: [],
    temperature_2m_min: [],
    precipitation_sum: [],
  };
  for (const year of years) {
    for (let date = new Date(Date.UTC(year, 0, 1)); date.getUTCFullYear() === year;) {
      const [high, low, rain] = day(date);
      daily.time.push(date.toISOString().slice(0, 10));
      daily.temperature_2m_max.push(high);
      daily.temperature_2m_min.push(low);
      daily.precipitation_sum.push(rain);
      date = new Date(date.getTime() + 86_400_000);
    }
  }
  return daily;
}

describe('aggregateMonthlyNormals', () => {
  it('averages temperatures over all days and precipitation over years', () => {
    // Month m: max = 10 + m, min = m; it rains 2 mm on the first 3 days of each month
    // in 2021 and on the first 5 days in 2022, plus 0.5 mm (below the rain-day threshold) on day 10.
    const daily = series([2021, 2022], (date) => {
      const month = date.getUTCMonth() + 1;
      const rainyDays = date.getUTCFullYear() === 2021 ? 3 : 5;
      const dayOfMonth = date.getUTCDate();
      const rain = dayOfMonth <= rainyDays ? 2 : dayOfMonth === 10 ? 0.5 : 0;
      return [10 + month, month, rain];
    });
    const { months, missingDays } = aggregateMonthlyNormals(daily);
    expect(missingDays).toBe(0);
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({
      month: 1,
      avg_high_c: 11,
      avg_low_c: 1,
      rain_days: 4,
      precipitation_mm: 8.5,
    });
    expect(months[11]?.avg_high_c).toBe(22);
  });

  it('counts a day with exactly 1 mm as a rain day', () => {
    const daily = series([2023], (date) => [20, 10, date.getUTCDate() === 1 ? 1 : 0.99]);
    expect(aggregateMonthlyNormals(daily).months[5]?.rain_days).toBe(1);
  });

  it('leaves out of the precipitation means a (year, month) with a missing day', () => {
    const daily = series([2021, 2022], (date) => {
      const missing =
        date.getUTCFullYear() === 2021 && date.getUTCMonth() === 0 && date.getUTCDate() === 15;
      return [5, 1, missing ? null : date.getUTCFullYear() === 2021 ? 1 : 3];
    });
    const { months, missingDays } = aggregateMonthlyNormals(daily);
    expect(missingDays).toBe(1);
    // January: only 2022 counts (31 days × 3 mm); February: both years ((28 + 3 × 28) / 2).
    expect(months[0]?.precipitation_mm).toBe(93);
    expect(months[1]?.precipitation_mm).toBe(56);
  });

  it('rounds to one decimal', () => {
    expect(round1(12.345)).toBe(12.3);
    expect(round1(-0.05)).toBe(-0);
    expect(round1(7.25)).toBe(7.3);
  });

  it('rejects inconsistent arrays and months without data', () => {
    const daily = series([2023], () => [1, 0, 0]);
    expect(() =>
      aggregateMonthlyNormals({ ...daily, precipitation_sum: daily.precipitation_sum.slice(1) }),
    ).toThrow(/different lengths/);
    const januaryOnly: Daily = {
      time: ['2023-01-01'],
      temperature_2m_max: [1],
      temperature_2m_min: [0],
      precipitation_sum: [0],
    };
    expect(() => aggregateMonthlyNormals(januaryOnly)).toThrow(/month 2/);
  });
});
