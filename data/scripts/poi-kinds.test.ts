import { describe, expect, it } from 'vitest';
import { mapKinds } from './poi-kinds.js';

const kinds = (name: string, description: string | null = null, sectionPath = ['See']): string[] =>
  mapKinds({ name, description, sectionPath });

describe('mapKinds', () => {
  it('maps names and descriptions through the keyword table', () => {
    expect(kinds('Lofotr Viking Museum')).toEqual(['historic_site', 'museum']);
    expect(kinds('Cathedral of Monreale')).toEqual(['religious_site']);
    expect(kinds('Samaria Gorge', 'A breathtaking gorge, a strenuous hike of 7 hours')).toEqual([
      'hiking',
      'nature',
    ]);
    expect(kinds('Spiaggia dei Conigli', 'Sandy beach with turtles')).toEqual(['beach']);
    expect(kinds('Whale watching', 'Boat trips from Andenes')).toEqual(['boat_trip']);
    expect(kinds('Cantina Florio', 'Marsala wine tasting')).toEqual(['wine']);
  });

  it('uses subsection headings but ignores the top-level See / Do titles', () => {
    expect(kinds('Grotta Zinzulusa', null, ['Do', 'Caves'])).toEqual(['nature']);
    expect(kinds('Seceda', null, ['See'])).toEqual(['other']);
  });

  it('matches whole words only, with wildcard endings', () => {
    expect(kinds('Trattoria', 'family-run place')).toEqual(['other']);
    expect(kinds('Kids club', 'family-friendly activities')).toEqual(['family']);
    expect(kinds('Embarcadero', 'Bar Lazio is nearby')).toEqual(['other']);
    expect(kinds('GR20', 'the famous long-distance trek')).toEqual(['hiking']);
    expect(kinds('Þingvellir National Park')).toEqual(['nature']);
  });

  it('avoids known false friends of the keyword table', () => {
    expect(kinds('Kollhellaren', 'Cave paintings were discovered in 1989')).toEqual(['nature']);
    expect(kinds('Golf', 'Courses near Cala Ratjada')).toEqual(['other']);
    expect(kinds('Laurisilva', 'A UNESCO World Heritage forest')).toEqual(['nature']);
    expect(kinds('Cathedral', 'The largest church on the island')).toEqual(['religious_site']);
  });

  it('falls back to "other" when nothing matches', () => {
    expect(kinds('Svolvær tourist information')).toEqual(['other']);
  });
});
