import { describe, expect, it } from 'vitest';
import { describeToolCall } from './toolLabels';

describe('describeToolCall', () => {
  it.each<[string, unknown, string]>([
    [
      'search_knowledge',
      { query: 'quiet beaches', destinationId: 'sicily' },
      'Searching the guide for “quiet beaches”',
    ],
    ['search_knowledge', {}, 'Searching the guide'],
    [
      'get_seasonal_weather',
      { destinationId: 'sicily', month: 5 },
      'Checking May weather in Sicily',
    ],
    [
      'get_seasonal_weather',
      { destinationId: 'scottish-highlands', month: 9 },
      'Checking September weather in Scottish Highlands',
    ],
    [
      'get_seasonal_weather',
      { destinationId: 'sicily', month: 13 },
      'Checking the seasonal weather',
    ],
    ['estimate_budget', {}, 'Estimating the budget'],
    [
      'estimate_budget',
      { destinationId: 'sicily', days: 7, travelers: 2, level: 'mid' },
      'Estimating the budget (7 days, 2 travellers)',
    ],
    ['estimate_budget', { days: 1, travelers: 1 }, 'Estimating the budget (1 day, 1 traveller)'],
    ['search_pois', { kinds: ['hiking'], maxCrowd: 2 }, 'Finding quiet hiking spots'],
    [
      'search_pois',
      { destinationId: 'sicily', kinds: ['hiking', 'historic_site', 'beach'], maxCrowd: 5 },
      'Finding hiking, historic site and beach spots in Sicily',
    ],
    ['search_pois', { destinationId: 'crete' }, 'Finding places in Crete'],
    ['present_itinerary', {}, 'Writing the itinerary'],
    ['ask_clarification', {}, 'Preparing follow-up questions'],
    ['some_new_tool', {}, 'Running some new tool'],
  ])('labels %s %j as "%s"', (name, input, label) => {
    expect(describeToolCall(name, input)).toBe(label);
  });

  it.each([null, undefined, 'text', 42, ['array']])(
    'falls back to a generic label when the input is %j',
    (input) => {
      expect(describeToolCall('get_seasonal_weather', input)).toBe('Checking the seasonal weather');
      expect(describeToolCall('search_knowledge', input)).toBe('Searching the guide');
    },
  );

  it('ignores fields of the wrong type', () => {
    expect(
      describeToolCall('search_pois', { kinds: 'hiking', maxCrowd: '1', destinationId: 7 }),
    ).toBe('Finding places');
  });

  it('shortens long search queries', () => {
    const label = describeToolCall('search_knowledge', { query: 'x'.repeat(200) });
    expect(label.length).toBeLessThan(90);
    expect(label).toContain('…');
  });
});
