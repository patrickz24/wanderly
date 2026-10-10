import { describe, expect, it } from 'vitest';
import { brief } from '../../../test/support/agent-fakes.js';
import type { LlmMessage } from '../ports/llm.js';
import { assistantMessage, pendingToolCalls, userMessage, visibleText } from './messages.js';
import {
  buildUserTurn,
  contextBlock,
  DELIVERED_RESULT,
  NOT_EXECUTED_RESULT,
  serializeBrief,
} from './user-turn.js';

describe('buildUserTurn', () => {
  it('puts the application context and the user text in separate blocks', () => {
    const turn = buildUserTurn({
      history: [],
      userText: 'Trip to Crete?',
      brief: brief({ destinationId: 'crete' }),
      today: '2026-10-10',
    });
    expect(turn.role).toBe('user');
    expect(turn.content).toEqual([
      { type: 'text', text: contextBlock('2026-10-10', brief({ destinationId: 'crete' })) },
      { type: 'text', text: 'Trip to Crete?' },
    ]);
  });

  it('answers the calls left open by the previous turn first', () => {
    const history: LlmMessage[] = [
      userMessage([{ type: 'text', text: 'hi' }]),
      assistantMessage([
        { type: 'tool_call', id: 't1', name: 'present_itinerary', input: {} },
        { type: 'tool_call', id: 'k1', name: 'search_knowledge', input: {} },
      ]),
    ];
    const turn = buildUserTurn({ history, userText: 'next', brief: brief(), today: '2026-10-10' });
    expect(turn.content.slice(0, 2)).toEqual([
      { type: 'tool_result', toolCallId: 't1', content: DELIVERED_RESULT, isError: false },
      { type: 'tool_result', toolCallId: 'k1', content: NOT_EXECUTED_RESULT, isError: true },
    ]);
  });

  it('adds nothing when the history ends with a user message', () => {
    const history = [userMessage([{ type: 'text', text: 'hi' }])];
    const turn = buildUserTurn({ history, userText: 'next', brief: brief(), today: '2026-10-10' });
    expect(turn.content).toHaveLength(2);
  });
});

describe('contextBlock', () => {
  it('states that the application wrote it and carries the date and brief', () => {
    const block = contextBlock('2026-10-10', brief({ month: 5 }));
    expect(block.split('\n')).toEqual([
      '<context>',
      'Written by the Wanderly application, not by the user.',
      "Today's date: 2026-10-10",
      `Trip brief so far: ${serializeBrief(brief({ month: 5 }))}`,
      '</context>',
    ]);
  });
});

describe('serializeBrief', () => {
  it('uses a fixed key order whatever the order of the stored object', () => {
    const shuffled = Object.fromEntries(Object.entries(brief({ month: 5 })).reverse());
    expect(serializeBrief(brief({ month: 5 }))).toBe(serializeBrief(brief(shuffled)));
    expect(serializeBrief(brief())).toBe(
      '{"destinationId":null,"month":null,"startDate":null,"durationDays":null,"travelers":null,"budgetLevel":null,"interests":[],"constraints":[]}',
    );
  });
});

describe('message helpers', () => {
  it('finds open calls only on a final assistant message', () => {
    expect(pendingToolCalls([])).toEqual([]);
    expect(pendingToolCalls([userMessage([{ type: 'text', text: 'x' }])])).toEqual([]);
  });

  it('joins visible text blocks', () => {
    expect(
      visibleText([
        { type: 'text', text: ' a ' },
        { type: 'opaque', provider: 'anthropic', data: {} },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a \nb');
  });
});
