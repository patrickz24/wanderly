import { z } from 'zod';
import { defineDataTool, requireKnownDestination } from './tool.js';

export const GET_SEASONAL_WEATHER = 'get_seasonal_weather';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? `month ${month}`;
}

const GetSeasonalWeatherInput = z.object({
  destinationId: z.string().trim().min(1).max(64),
  month: z.int().min(1).max(12),
});

export const getSeasonalWeatherTool = defineDataTool({
  name: GET_SEASONAL_WEATHER,
  description: [
    'Get the climate normals of a destination for one month (averages over 2015-2024 from Open-Meteo): average high and low in °C, rainy days and precipitation.',
    'Use it whenever the travel month is known or the user asks about weather or the best season; call it once per month you discuss.',
    'Returns `weatherId` (copy it into itinerary.weather.fromToolCallId) and a `ref` to cite; found is false when there is no data.',
  ].join(' '),
  input: GetSeasonalWeatherInput,
  fieldDescriptions: {
    destinationId: 'Catalog id of the destination.',
    month: 'Month number, 1 = January.',
  },
  async execute(input, context) {
    requireKnownDestination(context, input.destinationId);
    const fact = await context.knowledge.getClimate(input.destinationId, input.month);
    if (fact === null) {
      return {
        output: {
          found: false,
          destinationId: input.destinationId,
          month: input.month,
          note: 'No climate data for this destination and month.',
        },
        summary: `No climate data for ${input.destinationId} in ${monthName(input.month)}`,
      };
    }
    context.evidence.recordWeather({ callId: context.callId, fact });
    return {
      output: {
        found: true,
        weatherId: context.callId,
        ref: { kind: 'weather', id: context.callId },
        destinationId: fact.destinationId,
        month: fact.month,
        monthName: monthName(fact.month),
        avgHighC: fact.avgHighC,
        avgLowC: fact.avgLowC,
        rainDays: fact.rainDays,
        precipitationMm: fact.precipitationMm,
      },
      summary: `${monthName(fact.month)} in ${fact.destinationId}: ${fact.avgHighC}°C / ${fact.avgLowC}°C, ${fact.rainDays} rainy days`,
    };
  },
});
