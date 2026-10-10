import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Corpus } from '../../services/api/src/application/ports/corpus-source.js';
import { FsCorpusSource } from '../../services/api/src/infrastructure/knowledge/fs-corpus-source.js';
import {
  countByCategory,
  findCorpusProblems,
  loadAgentDataset,
  parseAgentDataset,
  selectCases,
  type AgentDataset,
} from './agent-dataset.js';

const DATASET = fileURLToPath(new URL('../datasets/agent-cases.yaml', import.meta.url));

describe('agent-cases.yaml', () => {
  let dataset: AgentDataset;
  let corpus: Corpus;

  beforeAll(async () => {
    dataset = await loadAgentDataset(DATASET);
    corpus = await new FsCorpusSource().load();
  });

  it('has at least 40 cases with the planned composition', () => {
    expect(dataset.cases.length).toBeGreaterThanOrEqual(40);
    const counts = countByCategory(dataset);
    expect(counts.clear).toBeGreaterThanOrEqual(12);
    expect(counts.ambiguous).toBeGreaterThanOrEqual(8);
    expect(counts.out_of_scope).toBeGreaterThanOrEqual(5);
    expect(counts.direct_injection).toBeGreaterThanOrEqual(5);
    expect(counts.indirect_injection).toBeGreaterThanOrEqual(3);
    expect(counts.unknown_destination).toBeGreaterThanOrEqual(4);
    expect(counts.multi_turn).toBeGreaterThanOrEqual(3);
  });

  it('is written in English and French', () => {
    const languages = new Set(dataset.cases.map((item) => item.language));
    expect([...languages].sort()).toEqual(['en', 'fr']);
  });

  it('records the provenance of every case', () => {
    for (const item of dataset.cases) {
      expect(item.provenance).toBe('proposed-by-agent, pending human review');
    }
  });

  it('agrees with the corpus (destinations, POI kinds, unknown places)', () => {
    expect(findCorpusProblems(dataset, corpus)).toEqual([]);
  });
});

const minimal = (cases: string) => `version: 1\ntoday: '2026-10-10'\ncases:\n${cases}`;
const clearCase = (id: string, extra = '') => `  - id: ${id}
    category: clear
    language: en
    provenance: test
    tags: [t]
    turns: [Plan 3 days in Sicily in May]
    expect:
      types: [itinerary]
      destinationId: sicily
${extra}`;

describe('parseAgentDataset', () => {
  it('rejects duplicate ids', () => {
    expect(() => parseAgentDataset(minimal(clearCase('a') + clearCase('a')))).toThrow(
      /duplicate case id/,
    );
  });

  it('rejects an interest that is not a POI kind', () => {
    expect(() =>
      parseAgentDataset(minimal(clearCase('a', '      interests: [shopping]\n'))),
    ).toThrow();
  });

  it('requires a poison document on indirect injection cases', () => {
    const text = minimal(`  - id: a
    category: indirect_injection
    language: en
    provenance: test
    tags: [t]
    turns: [Plan 3 days in Crete in May]
    expect:
      types: [itinerary]
`);
    expect(() => parseAgentDataset(text)).toThrow(/poison/);
  });

  it('requires a clarification and the unstated fields on ambiguous cases', () => {
    const text = minimal(`  - id: a
    category: ambiguous
    language: en
    provenance: test
    tags: [t]
    turns: [Plan a trip]
    expect:
      types: [itinerary]
`);
    expect(() => parseAgentDataset(text)).toThrow(/unstated|clarification/);
  });
});

describe('findCorpusProblems', () => {
  const corpus: Corpus = {
    destinations: [
      {
        factsAsOf: '2026-01-01',
        documents: [],
        facts: {
          id: 'sicily',
          name: 'Sicily',
          aliases: ['Sicile'],
          documents: [],
          pois: [{ kinds: ['hiking'] }, { kinds: ['hiking'] }, { kinds: ['hiking', 'beach'] }],
        },
      },
    ],
  } as unknown as Corpus;

  it('reports unknown destinations, rare interests and places that are in the corpus', () => {
    const dataset = parseAgentDataset(
      minimal(
        clearCase('a', '      interests: [hiking, beach]\n') +
          `  - id: b
    category: unknown_destination
    language: fr
    provenance: test
    tags: [t]
    unknownPlace: Sicile
    turns: [3 jours en Sicile]
    expect:
      types: [decline]
      declineReasons: [unknown_destination]
      destinationId: atlantis
`,
      ),
    );
    expect(findCorpusProblems(dataset, corpus)).toEqual([
      'a: sicily has 1 POI(s) of kind "beach" (< 3)',
      'b: destination "atlantis" is not in the corpus',
      'b: "Sicile" is in the corpus',
    ]);
  });
});

describe('selectCases', () => {
  const dataset = parseAgentDataset(minimal(clearCase('a') + clearCase('b')));

  it('filters by id and category', () => {
    expect(selectCases(dataset, { ids: ['b'] }).map((item) => item.id)).toEqual(['b']);
    expect(selectCases(dataset, { categories: ['ambiguous'] })).toEqual([]);
    expect(selectCases(dataset, {}).length).toBe(2);
  });

  it('rejects an unknown id', () => {
    expect(() => selectCases(dataset, { ids: ['zzz'] })).toThrow(/Unknown case id/);
  });
});
