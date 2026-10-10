import { describe, expect, it } from 'vitest';
import { itineraryInput } from '../../../test/support/agent-scenarios.js';
import {
  answerQuestionTool,
  askClarificationTool,
  declineTool,
  presentItineraryTool,
} from './terminal-tools.js';

describe('terminal tools', () => {
  it('turn valid arguments into the matching response variant', () => {
    const parsed = presentItineraryTool.parse(itineraryInput());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.response.type).toBe('itinerary');
      expect(parsed.response.message).toBe('Voici votre itinéraire de randonnée en Sicile.');
    }
  });

  it('ignore a type field sent by the model (the tool decides the type)', () => {
    const parsed = declineTool.parse({
      type: 'itinerary',
      reason: 'out_of_scope',
      message: 'I only plan trips.',
      brief: itineraryInput().brief,
    });
    expect(parsed.ok && parsed.response.type).toBe('decline');
  });

  it('list schema issues with their paths', () => {
    const parsed = askClarificationTool.parse({
      message: 'x',
      questions: ['a', 'b', 'c', 'd'],
      brief: null,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^questions: /),
          expect.stringMatching(/^brief: /),
        ]),
      );
    }
  });

  it('reject arguments that are not an object', () => {
    expect(answerQuestionTool.parse('hello')).toEqual({
      ok: false,
      issues: ['The arguments must be a JSON object.'],
    });
    expect(answerQuestionTool.parse(null).ok).toBe(false);
  });

  it('carry model-facing descriptions on the important fields', () => {
    const schema = JSON.stringify(presentItineraryTool.spec.inputSchema);
    expect(schema).toContain('The estimateId of that estimate_budget result.');
    expect(schema).toContain("written in the language of the user's latest message");
    expect(schema).toContain('Refs copied exactly from tool results of this turn');
  });
});
