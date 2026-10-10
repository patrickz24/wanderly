import { describe, expect, it } from 'vitest';
import { assessCrowd, crowdSignal } from './crowds.js';
import { assessBestMonths, monthsInSentence } from './seasons.js';
import { splitSentences } from './curation.js';

describe('crowdSignal', () => {
  it.each([
    ['It gets very crowded in August.', 'high'],
    ['Expect long queues at the entrance.', 'high'],
    ['Overrun by cruise ships at midday.', 'high'],
    ['A rather touristy spot.', 'high'],
    ['A quiet, secluded cove.', 'low'],
    ['Off the beaten track and deserted in the morning.', 'low'],
    ['It is not crowded even in summer.', 'low'],
    ["The beach isn't too busy.", 'low'],
    ['Less crowded than the main square.', 'low'],
    ['Busy at noon but quiet in the evening.', null],
    ['Not quiet at all.', null],
    ['A baroque church with frescoes.', null],
    ['A plaza removed from the tourist crowds.', 'low'],
    ['Packed with 18th-century burial chapels.', null],
    ['A small museum crowded with artworks.', null],
    ['Packed with tourists at noon.', 'high'],
    ['The busy A82 cuts the town off from the shore.', null],
    ['On a busy road outside the old town.', null],
    ['Crowds gathered here in 1991 for independence.', null],
  ])('%j → %s', (sentence, expected) => {
    expect(crowdSignal(sentence)).toBe(expected);
  });
});

describe('assessCrowd', () => {
  it('maps one or more agreeing sentences to a level and keeps them as evidence', () => {
    expect(assessCrowd(['Very crowded.', 'Nice frescoes.'])).toEqual({
      level: 4,
      evidence: ['Very crowded.'],
    });
    expect(assessCrowd(['Very crowded.', 'Long queues.']).level).toBe(5);
    expect(assessCrowd(['Peaceful.']).level).toBe(2);
    expect(assessCrowd(['Peaceful.', 'Secluded.']).level).toBe(1);
  });

  it('stays null on mixed or absent signals', () => {
    expect(assessCrowd(['Crowded in July.', 'Peaceful in winter.'])).toEqual({
      level: null,
      evidence: [],
    });
    expect(assessCrowd([])).toEqual({ level: null, evidence: [] });
  });
});

describe('monthsInSentence', () => {
  const months = (sentence: string): [number[], number[]] => {
    const found = monthsInSentence(sentence);
    return [[...found.included].sort((a, b) => a - b), [...found.excluded].sort((a, b) => a - b)];
  };

  it('reads months, seasons and ranges when the sentence says when to go or open', () => {
    expect(months('Best visited in May.')).toEqual([[5], []]);
    expect(months('Open from April to October.')).toEqual([[4, 5, 6, 7, 8, 9, 10], []]);
    expect(months('(hours: Apr-Oct 09:00-18:00)')).toEqual([[4, 5, 6, 7, 8, 9, 10], []]);
    expect(months('The festival is held in summer.')).toEqual([[6, 7, 8], []]);
    expect(months('Boats run Nov–Feb only.')).toEqual([[1, 2, 11, 12], []]);
    expect(months('Ideal in the fall.')).toEqual([[9, 10, 11], []]);
  });

  it('treats closures as exclusions', () => {
    expect(months('Closed in winter.')).toEqual([[], [1, 2, 12]]);
    expect(months('Open daily, closed in January and February.')).toEqual([[], [1, 2]]);
  });

  it('ignores history, verbs, lone abbreviations and sentences without a cue', () => {
    expect(months('Built in May 1890 by the king.')).toEqual([[], []]);
    expect(months('May be open later on request.')).toEqual([[], []]);
    expect(months('Visit Jan Hus square.')).toEqual([[], []]);
    expect(months('The road was rebuilt in summer.')).toEqual([[], []]);
    expect(months('The waterfalls fall into the gorge, best seen.')).toEqual([[], []]);
  });

  it('ignores schedules, holiday closures and named seasons, but keeps dated events', () => {
    expect(months('(hours: Daily, summer 08:00-18:00, winter 08:00-15:00)')).toEqual([[], []]);
    expect(months('(hours: 08:00-20:00, until 18:00 in winter)')).toEqual([[], []]);
    expect(months('(hours: May-Oct 10:00-18:00; Nov-Apr 11:00-17:00)')).toEqual([[], []]);
    expect(months('(hours: Tue-Sun 10:00-18:00; closed Jan 1, May 1, Dec 25)')).toEqual([[], []]);
    expect(months('The festival takes place on December 13.')).toEqual([[12], []]);
    expect(months('Free entrance on 6 Mar, 18 Apr and 18 May; open daily.')).toEqual([[], []]);
    expect(months('It started the Slovenian spring, a season of protests.')).toEqual([[], []]);
    expect(months('In summer the ferry runs daily.')).toEqual([[6, 7, 8], []]);
    expect(months('Navigation banned in spring because of falling rock.')).toEqual([[], [3, 4, 5]]);
    expect(months('(hours: Wed-Fri 13:00-18:00; Jul-Aug: daily 11:00-19:00)')).toEqual([[], []]);
    expect(months('(hours: Jul-mid Sep: 09:00-20:00; May-Jun: 10:00-19:00)')).toEqual([[], []]);
    expect(months('Open to the public from 1 May to 31 October.')).toEqual([
      [5, 6, 7, 8, 9, 10],
      [],
    ]);
    expect(months('(hours: 15 May-15 Sep: 10:00-20:00)')).toEqual([[5, 6, 7, 8, 9], []]);
    expect(months('Open most of the year (closed May 1-Jul 15 for nesting).')).toEqual([
      [],
      [5, 6, 7],
    ]);
    expect(months('The celebration takes place in May 6–8.')).toEqual([[5], []]);
    expect(months('Open for the hike from 1 May until mid-October.')).toEqual([
      [5, 6, 7, 8, 9, 10],
      [],
    ]);
    expect(months('Open daily; closed on bullfighting days in September.')).toEqual([[], []]);
  });
});

describe('assessBestMonths', () => {
  it('combines sentences, removes exclusions and keeps the evidence', () => {
    expect(assessBestMonths(['Open April to October.', 'Closed in August.'])).toEqual({
      months: [4, 5, 6, 7, 9, 10],
      evidence: ['Open April to October.', 'Closed in August.'],
    });
  });

  it('uses the complement when the text only says when it is closed', () => {
    expect(assessBestMonths(['Closed in winter.']).months).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('returns nothing without usable mentions or when every month qualifies', () => {
    expect(assessBestMonths(['Nice view.'])).toEqual({ months: [], evidence: [] });
    expect(assessBestMonths(['Open January to December.'])).toEqual({ months: [], evidence: [] });
  });
});

describe('splitSentences', () => {
  it('splits on sentence ends and keeps every piece verbatim', () => {
    const text = '**Castle** — Old walls. Busy in July! (price: €5; hours: Apr-Oct)';
    const sentences = splitSentences(text);
    expect(sentences).toEqual([
      '**Castle** — Old walls.',
      'Busy in July!',
      '(price: €5; hours: Apr-Oct)',
    ]);
    for (const sentence of sentences) expect(text).toContain(sentence);
  });
});
