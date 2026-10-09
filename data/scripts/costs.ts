/**
 * Cost profile derived ONLY from prices written in Sleep and Eat listings (pure).
 * Levels follow the Wikivoyage convention of Budget / Mid-range / Splurge subsections.
 * Anything that cannot be derived is `null` with a note; nothing is estimated.
 */
import type { CostFigure, CostLevel, CostLevelName, Costs } from './facts-schema.js';
import { type ParsedPrice, isLongStayPrice, parsePrice, summarisePrices } from './prices.js';
import type { GuideDocument } from './wikitext.js';

type Category = 'lodging' | 'meal';

const CATEGORY_SECTIONS: Readonly<Record<Category, { section: string; label: string }>> = {
  lodging: { section: 'sleep', label: 'Sleep' },
  meal: { section: 'eat', label: 'Eat' },
};

const LEVEL_HEADINGS: readonly (readonly [CostLevelName, RegExp])[] = [
  ['budget', /^(budget|cheap)/i],
  ['mid', /^(mid[- ]?range|moderate)/i],
  ['comfort', /^(splurge|luxury|upscale|high[- ]end)/i],
];

const LEVEL_LABEL: Readonly<Record<CostLevelName, string>> = {
  budget: 'Budget',
  mid: 'Mid-range',
  comfort: 'Splurge',
};

export const COST_DERIVATION =
  'Derived only from the price fields of the Sleep and Eat listing templates of the Wikivoyage ' +
  'revision in source.revision_id. An amount counts only when a currency is written next to it ' +
  '(or at the other end of its range). Each listing counts once, at the midpoint of its lowest and ' +
  'highest amount; the figure is the median over the listings that use the most frequent ' +
  'currency. Lodging prices are as written (per room, per bed or per person); meal prices are ' +
  'whatever the listing quotes. No currency conversion, inflation adjustment or estimation.';

export function levelOf(path: readonly string[]): CostLevelName | null {
  for (const title of path.slice(1)) {
    for (const [level, pattern] of LEVEL_HEADINGS) if (pattern.test(title)) return level;
  }
  return null;
}

interface PricedListing {
  readonly category: Category;
  readonly level: CostLevelName | null;
  /** null when the listing has a price field but no amount with a currency. */
  readonly price: ParsedPrice | null;
  /** Quoted per week or per month (excluded from nightly lodging figures). */
  readonly longStay: boolean;
}

export function collectPricedListings(doc: GuideDocument): PricedListing[] {
  const priced: PricedListing[] = [];
  for (const section of doc.sections) {
    const top = section.path[0]?.toLowerCase();
    const category = (Object.keys(CATEGORY_SECTIONS) as Category[]).find(
      (key) => CATEGORY_SECTIONS[key].section === top,
    );
    if (category === undefined) continue;
    for (const listing of section.listings) {
      if (listing.price === null) continue;
      priced.push({
        category,
        level: levelOf(section.path),
        price: parsePrice(listing.price),
        longStay: isLongStayPrice(listing.price),
      });
    }
  }
  return priced;
}

function figureWithNotes(
  listings: readonly PricedListing[],
  category: Category,
  scope: string,
): { figure: CostFigure | null; notes: string[] } {
  const { label } = CATEGORY_SECTIONS[category];
  const notes: string[] = [];
  const all = listings.filter((listing) => listing.category === category);
  const longStay = category === 'lodging' ? all.filter((listing) => listing.longStay).length : 0;
  if (longStay > 0) {
    notes.push(
      `${longStay} ${label} listing price(s) ${scope} quoted per week or month were left out.`,
    );
  }
  const inCategory = category === 'lodging' ? all.filter((listing) => !listing.longStay) : all;
  const parsed = inCategory.flatMap((listing) => (listing.price === null ? [] : [listing.price]));
  const unparsed = inCategory.length - parsed.length;
  if (unparsed > 0) {
    notes.push(`${unparsed} ${label} listing price(s) ${scope} had no amount with a currency.`);
  }
  const figure = summarisePrices(parsed);
  if (figure === null) {
    notes.push(`No ${label} listing ${scope} has a parseable price: value unknown.`);
  } else if (figure.sample_size < 3) {
    notes.push(`${label} figure ${scope} rests on only ${figure.sample_size} listing(s).`);
  }
  return { figure, notes };
}

function costLevel(listings: readonly PricedListing[], scope: string): CostLevel {
  const lodging = figureWithNotes(listings, 'lodging', scope);
  const meal = figureWithNotes(listings, 'meal', scope);
  return {
    lodging_night: lodging.figure,
    meal: meal.figure,
    notes: [...lodging.notes, ...meal.notes],
  };
}

export function deriveCosts(doc: GuideDocument): {
  costs: Costs;
  pricedListings: { sleep: number; eat: number };
} {
  const priced = collectPricedListings(doc);
  const hasLevels = priced.some((listing) => listing.level !== null);
  const level = (name: CostLevelName): CostLevel => {
    if (!hasLevels) {
      return {
        lodging_night: null,
        meal: null,
        notes: [
          'The article has no priced listings under Budget / Mid-range / Splurge subsections: value unknown.',
        ],
      };
    }
    return costLevel(
      priced.filter((listing) => listing.level === name),
      `under ${LEVEL_LABEL[name]}`,
    );
  };
  return {
    costs: {
      derivation: COST_DERIVATION,
      overall: costLevel(priced, 'in the article'),
      levels: { budget: level('budget'), mid: level('mid'), comfort: level('comfort') },
    },
    pricedListings: {
      sleep: priced.filter((listing) => listing.category === 'lodging').length,
      eat: priced.filter((listing) => listing.category === 'meal').length,
    },
  };
}
