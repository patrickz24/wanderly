/**
 * Display formatting. The UI is in English, so the locale is fixed: output does not depend on
 * the visitor's browser settings, and tests are deterministic.
 */
const LOCALE = 'en';

const monthFormatter = new Intl.DateTimeFormat(LOCALE, { month: 'long', timeZone: 'UTC' });
const integerFormatter = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const dateTimeFormatter = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** 1 → "January". */
export function monthName(month: number): string {
  return monthFormatter.format(new Date(Date.UTC(2000, month - 1, 1)));
}

/** "sicily" → "Sicily", "scottish-highlands" → "Scottish Highlands". */
export function destinationName(id: string): string {
  return id
    .split('-')
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** `plural(2, 'day')` → "2 days", `plural(1, 'traveller')` → "1 traveller". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${integerFormatter.format(count)} ${count === 1 ? singular : pluralForm}`;
}

export function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

/** 420 → "420 ms", 1530 → "1.5 s", 65000 → "1 min 5 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

/** Run costs are fractions of a cent: show enough digits to be meaningful. */
export function formatUsd(amount: number): string {
  const digits = amount !== 0 && amount < 1 ? 4 : 2;
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
}

/**
 * Formats a budget amount in the currency *as written in the source* ("EUR", "€", "kr"…).
 * ISO 4217 codes get proper currency formatting; anything else is shown verbatim after the
 * number. No conversion is ever made.
 */
export function formatMoney(amount: number, currency: string): string {
  const code = currency.trim();
  if (/^[A-Za-z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(LOCALE, {
        style: 'currency',
        currency: code.toUpperCase(),
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      // Not a currency code Intl knows: fall through to the verbatim form.
    }
  }
  return `${integerFormatter.format(amount)} ${code}`;
}

/** ISO timestamp → "Oct 10, 2026, 9:00 AM" in the visitor's time zone. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormatter.format(date);
}

/** "mid" → "Mid-range". */
export function budgetLevelLabel(level: 'budget' | 'mid' | 'comfort'): string {
  switch (level) {
    case 'budget':
      return 'Budget';
    case 'mid':
      return 'Mid-range';
    case 'comfort':
      return 'Comfort';
  }
}
