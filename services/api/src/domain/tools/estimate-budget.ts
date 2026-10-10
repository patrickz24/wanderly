import { BudgetLevelSchema } from '@wanderly/contracts';
import { z } from 'zod';
import { estimateBudget, MEALS_PER_DAY, TRAVELERS_PER_ROOM } from './budget.js';
import { defineDataTool, requireKnownDestination } from './tool.js';

export const ESTIMATE_BUDGET = 'estimate_budget';

const EstimateBudgetInput = z.object({
  destinationId: z.string().trim().min(1).max(64),
  days: z.int().min(1).max(21),
  travelers: z.int().min(1).max(12),
  level: BudgetLevelSchema,
});

export const estimateBudgetTool = defineDataTool({
  name: ESTIMATE_BUDGET,
  description: [
    'Estimate the cost of a trip from the median listing prices the guide quotes for a comfort level (budget, mid or comfort).',
    `Lodging = (days - 1) nights × rooms (${TRAVELERS_PER_ROOM} travellers per room) × median price per night; meals = ${MEALS_PER_DAY} meals per traveller per day × median meal price.`,
    'Use it when the user mentions money or a comfort level, and for every itinerary that shows a budget.',
    'Copy its figures exactly (never convert currencies, round or adjust them) and copy `estimateId` into itinerary.budget.fromToolCallId.',
    'Figures are null when the guide has no prices: then set itinerary.budget to null and say so in warnings.',
  ].join(' '),
  input: EstimateBudgetInput,
  fieldDescriptions: {
    destinationId: 'Catalog id of the destination.',
    days: 'Trip length in days (the itinerary durationDays).',
    travelers: 'Number of travellers.',
    level: 'Comfort level: budget, mid or comfort.',
  },
  async execute(input, context) {
    requireKnownDestination(context, input.destinationId);
    const costs = await context.knowledge.getCosts(input.destinationId);
    const estimate = estimateBudget(costs, input);
    context.evidence.recordBudget({ callId: context.callId, estimate });
    return {
      output: {
        estimateId: context.callId,
        ref: { kind: 'budget', id: context.callId },
        ...estimate,
      },
      summary:
        estimate.total === null || estimate.currency === null
          ? `No complete ${input.level} budget for ${input.destinationId} in the guide`
          : `${input.level} budget for ${input.destinationId}: ${estimate.total} ${estimate.currency} for ${input.travelers} traveller(s), ${input.days} day(s)`,
    };
  },
});
