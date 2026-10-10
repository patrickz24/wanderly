import type {
  DaySlot,
  ItineraryBudget,
  ItineraryItem,
  ItineraryWeather,
} from '@wanderly/contracts';
import {
  budgetLevelLabel,
  destinationName,
  formatMoney,
  monthName,
  plural,
} from '../../lib/format';
import { OPEN_METEO, sourceKey } from '../../lib/sources';
import type { AgentResponseOf } from '../../lib/types';
import { ExternalLink } from '../common/ExternalLink';
import { PinIcon } from '../common/icons';
import { CitationChips, type CitationContext } from './CitationChips';

interface ItineraryViewProps {
  readonly response: AgentResponseOf<'itinerary'>;
  readonly citations: CitationContext;
}

const SLOT_LABELS: Readonly<Record<DaySlot, string>> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
};

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-full border border-line bg-surface-muted px-3 py-1">
      <dt className="sr-only">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ItemView({ item, citations }: { item: ItineraryItem; citations: CitationContext }) {
  const poi =
    item.poiId === null
      ? undefined
      : citations.sources.get(sourceKey({ kind: 'poi', id: item.poiId }));
  return (
    <li className="grid gap-1 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-4">
      <p className="text-xs font-semibold tracking-wide text-accent uppercase sm:pt-0.5">
        {SLOT_LABELS[item.slot]}
      </p>
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h5 className="font-semibold">{item.title}</h5>
          {item.poiId !== null && (
            <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted px-2 py-0.5 text-xs text-fg-muted">
              <PinIcon />
              <span>
                <span className="sr-only">Point of interest: </span>
                {poi?.title ?? 'Point of interest'}
              </span>
            </span>
          )}
        </div>
        <p className="text-sm">{item.description}</p>
        <p className="text-sm text-fg-muted">
          <span className="font-medium text-fg">Why it fits: </span>
          {item.justification}
        </p>
        <CitationChips refs={item.sourceRefs} context={citations} />
      </div>
    </li>
  );
}

function BudgetBlock({
  budget,
  citations,
}: {
  budget: ItineraryBudget;
  citations: CitationContext;
}) {
  const amount = (value: number | null): string =>
    value === null ? 'Unknown' : formatMoney(value, budget.currency);
  return (
    <section className="space-y-2 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">Budget</h4>
        <span className="rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium">
          {budgetLevelLabel(budget.level)}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-fg-muted">Total</dt>
          <dd className="text-base font-semibold">{amount(budget.total)}</dd>
        </div>
        <div>
          <dt className="text-fg-muted">Per person</dt>
          <dd className="text-base font-semibold">{amount(budget.perPerson)}</dd>
        </div>
      </dl>
      {budget.total === null && budget.perPerson === null && (
        <p className="text-sm text-fg-muted">
          The guide lacks the prices needed for an estimate, so no figure is given rather than a
          guess.
        </p>
      )}
      {budget.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
          {budget.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <CitationChips refs={[{ kind: 'budget', id: budget.fromToolCallId }]} context={citations} />
    </section>
  );
}

function WeatherBlock({
  weather,
  citations,
}: {
  weather: ItineraryWeather;
  citations: CitationContext;
}) {
  return (
    <section className="space-y-2 rounded-lg border border-line p-4">
      <h4 className="font-semibold">Weather in {monthName(weather.month)}</h4>
      <p className="text-sm">{weather.summary}</p>
      <p className="text-xs text-fg-muted">
        <ExternalLink href={OPEN_METEO.url}>{OPEN_METEO.text}</ExternalLink>
        {' · climate normals, not a forecast'}
      </p>
      <CitationChips refs={[{ kind: 'weather', id: weather.fromToolCallId }]} context={citations} />
    </section>
  );
}

function NoteList({
  title,
  items,
  tone,
}: {
  title: string;
  items: readonly string[];
  tone: 'neutral' | 'warning';
}) {
  if (items.length === 0) {
    return null;
  }
  const toneClass =
    tone === 'warning'
      ? 'border-notice-line bg-notice text-notice-fg'
      : 'border-line bg-surface-muted text-fg';
  return (
    <section className={`rounded-lg border p-4 ${toneClass}`}>
      <h4 className="font-semibold">{title}</h4>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/** A day-by-day plan with its budget, weather, assumptions and warnings. */
export function ItineraryView({ response, citations }: ItineraryViewProps) {
  const { itinerary } = response;
  const travellers =
    itinerary.travelers === null
      ? 'Travellers not specified'
      : plural(itinerary.travelers, 'traveller');

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
          {destinationName(itinerary.destinationId)}
        </p>
        <h3 className="text-xl font-semibold tracking-tight">{itinerary.title}</h3>
        <p className="text-fg-muted">{itinerary.summary}</p>
        <dl className="flex flex-wrap gap-2 text-sm">
          <Fact
            label="Month"
            value={itinerary.month === null ? 'Any month' : monthName(itinerary.month)}
          />
          <Fact label="Duration" value={plural(itinerary.durationDays, 'day')} />
          <Fact label="Travellers" value={travellers} />
        </dl>
      </div>

      <ol className="space-y-4" aria-label="Days">
        {itinerary.days.map((day) => (
          <li key={day.day}>
            <section className="rounded-lg border border-line bg-surface p-4">
              <h4 className="mb-3 flex flex-wrap items-baseline gap-x-2">
                <span className="rounded-md bg-accent px-2 py-0.5 text-sm font-semibold text-surface">
                  Day {day.day}
                </span>{' '}
                <span className="font-semibold">{day.theme}</span>
              </h4>
              <ol className="space-y-4">
                {day.items.map((item) => (
                  <ItemView key={`${item.slot}-${item.title}`} item={item} citations={citations} />
                ))}
              </ol>
            </section>
          </li>
        ))}
      </ol>

      {(itinerary.budget !== null || itinerary.weather !== null) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {itinerary.budget !== null && (
            <BudgetBlock budget={itinerary.budget} citations={citations} />
          )}
          {itinerary.weather !== null && (
            <WeatherBlock weather={itinerary.weather} citations={citations} />
          )}
        </div>
      )}

      <NoteList title="Assumptions" items={itinerary.assumptions} tone="neutral" />
      <NoteList title="Warnings" items={itinerary.warnings} tone="warning" />
    </div>
  );
}
