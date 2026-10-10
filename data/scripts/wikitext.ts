/**
 * Wikivoyage wikitext → structured guide (sections, paragraphs, list items, listings) → Markdown.
 *
 * Division of labour:
 * - Structure (headings, lists, tables) and Wikivoyage-specific templates (listings, markers,
 *   region lists, boxes, units, currencies) are handled here, so that listings stay where the
 *   author put them and keep their fields (wtf_wikipedia drops templates it does not know).
 * - Inline markup (links, bold/italic, HTML entities and tags, generic inline templates such as
 *   `{{lang}}`, `{{convert}}`, `{{nowrap}}`) is rendered to plain text by wtf_wikipedia.
 *
 * Everything here is pure (no I/O) so it can be unit-tested and re-run deterministically.
 */
import wtf from 'wtf_wikipedia';
import { type TemplateCall, param, replaceTemplates } from './wikitext-templates.js';

export const LISTING_TEMPLATES = new Set([
  'see',
  'do',
  'buy',
  'eat',
  'drink',
  'sleep',
  'go',
  'listing',
  'event',
]);

/** Templates with no article text worth keeping: maps, banners, navigation, status, references. */
const DROPPED_TEMPLATES = new Set([
  'pagebanner',
  'mapframe',
  'mapshape',
  'mapshapes',
  'mapmask',
  'maplink',
  'geo',
  'ispartof',
  'quickbar',
  'routebox',
  'seealso',
  'see also',
  'main',
  'clear',
  '-',
  'dead link',
  'stdcolor',
  'climate',
  'climate chart',
  'exchange rates',
  'exchange rate euros',
  'schengen',
  'euro',
  'other uses',
  'movetocity',
  'nordiccountries',
  'related',
  'commons',
  'wikipedia',
  'toc',
  'tocright',
  'cite web',
  'cite book',
  'cite news',
  'citation',
  'reflist',
  'translate',
  'disamb',
  'dotm',
  'otbp',
  'ftt',
  'ptt',
  'pgname',
  'otheruses',
  'anchor',
  'cbignore',
  'ipa',
]);

/** Article status banners such as `{{usableregion}}` or `{{outlinecity}}`. */
const STATUS_TEMPLATE = /^(?:stub|outline|usable|guide|star)\s?[a-z ]*$/;

/** Unit templates (`{{km|5}}` → `5 km`). */
const UNIT_TEMPLATES: Readonly<Record<string, string>> = {
  km: 'km',
  mi: 'mi',
  m: 'm',
  meter: 'm',
  metre: 'm',
  ft: 'ft',
  cm: 'cm',
  mm: 'mm',
  kmh: 'km/h',
  mph: 'mph',
  km2: 'km²',
  mi2: 'sq mi',
  ha: 'ha',
  kg: 'kg',
  m2: 'm²',
  hectare: 'ha',
  inch: 'in',
  c: '°C',
  f: '°F',
};

/** Currency templates rendered as a prefix symbol (`{{EUR|10}}` → `€10`). */
const CURRENCY_TEMPLATES: Readonly<Record<string, string>> = {
  eur: '€',
  euro: '€',
  gbp: '£',
  usd: 'US$',
};

export interface Listing {
  /** Template name (`see`, `eat`, `sleep`…) or the `type` of a generic `{{listing}}`. */
  readonly type: string;
  readonly name: string;
  readonly alt: string | null;
  readonly description: string | null;
  readonly price: string | null;
  readonly hours: string | null;
}

/** A list item that names a place or activity (used for POI extraction). */
export type Entry =
  | { readonly source: 'listing'; readonly listing: Listing }
  | {
      readonly source: 'marker' | 'named';
      readonly name: string;
      readonly description: string | null;
    };

export type Block =
  | { readonly type: 'paragraph'; readonly text: string }
  | {
      readonly type: 'item';
      readonly level: number;
      readonly ordered: boolean;
      readonly text: string;
      readonly entry: Entry | null;
    }
  | { readonly type: 'box'; readonly label: string; readonly text: string };

export interface GuideSection {
  readonly title: string;
  /** 2 for `== H2 ==`, 3 for `=== H3 ===`… The lead section is rendered as a depth-2 "Overview". */
  readonly depth: number;
  /** Heading path from the top-level section, e.g. `["See", "Museums"]`. */
  readonly path: readonly string[];
  readonly blocks: readonly Block[];
  /** Every listing template of the section, in list items or inline in paragraphs. */
  readonly listings: readonly Listing[];
}

export interface GuideDocument {
  readonly title: string;
  readonly sections: readonly GuideSection[];
  /** Parents declared by `{{IsPartOf|…}}` (Wikivoyage breadcrumb). */
  readonly isPartOf: readonly string[];
  /** Non-fatal conversion issues (e.g. unknown templates that were dropped). */
  readonly warnings: readonly string[];
}

export const LEAD_SECTION_TITLE = 'Overview';

// ---------------------------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------------------------

interface ConversionContext {
  readonly warnings: Map<string, number>;
}

const newContext = (): ConversionContext => ({ warnings: new Map() });

function warn(ctx: ConversionContext, message: string): void {
  ctx.warnings.set(message, (ctx.warnings.get(message) ?? 0) + 1);
}

/** Expands the templates of an inline fragment to plain text (recursively). */
function expandInlineTemplates(text: string, ctx: ConversionContext): string {
  return replaceTemplates(text, (call) => renderInlineTemplate(call, ctx));
}

function renderInlineTemplate(call: TemplateCall, ctx: ConversionContext): string {
  const { name } = call;
  const first = param(call, '1');
  const expand = (value: string | null): string =>
    value === null ? '' : expandInlineTemplates(value, ctx).trim();

  if (DROPPED_TEMPLATES.has(name) && !(name === 'euro' && first !== null)) return '';
  if (STATUS_TEMPLATE.test(name)) return '';
  if (name === 'marker' || LISTING_TEMPLATES.has(name)) return expand(param(call, 'name'));
  const unit = UNIT_TEMPLATES[name];
  if (unit !== undefined) return first === null ? unit : `${expand(first)} ${unit}`.trim();
  const currency = CURRENCY_TEMPLATES[name];
  if (currency !== undefined) return `${currency}${expand(first)}`;
  if (name === 'iata' || name === 'phone') return expand(first);
  if (name === '!') return '|';
  if (name === 'unesco') return 'UNESCO World Heritage Site';

  // Generic inline templates ({{lang}}, {{convert}}, {{nowrap}}, {{currency}}…): let wtf_wikipedia
  // render them, after expanding the templates nested in their arguments.
  const inner = expandInlineTemplates(call.raw.slice(2, -2), ctx);
  const rendered = wtf(`{{${inner}}}`).text().trim();
  if (rendered === '') warn(ctx, `dropped unknown template {{${name}}}`);
  return rendered;
}

/** Converts an inline wikitext fragment (no list markers, no headings) to plain text. */
function renderInline(text: string, ctx: ConversionContext): string {
  const expanded = expandInlineTemplates(text, ctx);
  if (expanded.trim() === '') return '';
  return tidySpacing(wtf(expanded).text());
}

/** Collapses whitespace and removes the space left before punctuation by dropped templates. */
function tidySpacing(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?])(?=\s|$)/g, '$1')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim();
}

/** Public helper for tests and for other scripts: wikitext fragment → plain text. */
export function wikitextToPlainText(text: string): string {
  return renderInline(text, newContext());
}

// ---------------------------------------------------------------------------------------------
// Pre-processing
// ---------------------------------------------------------------------------------------------

const FILE_LINK_PREFIX = /^\[\[\s*(?:file|image|media)\s*:/i;

/** Removes `[[File:…]]` links, whose captions may contain nested links. */
export function removeFileLinks(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('[[', i) && FILE_LINK_PREFIX.test(text.slice(i, i + 12))) {
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text.startsWith('[[', j)) {
          depth++;
          j += 2;
        } else if (text.startsWith(']]', j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else {
          j++;
        }
      }
      i = j;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

function preprocess(wikitext: string): string {
  return removeFileLinks(
    wikitext
      .replace(/\r\n?/g, '\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<ref\b[^>]*\/>/gi, '')
      .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '')
      .replace(/<(gallery|mapframe|maplink|templatedata|noinclude)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<templatestyles\b[^>]*\/>/gi, '')
      .replace(/__[A-Z]+__/g, ''),
  )
    .replace(/\[\[\s*category\s*:[^\]]*\]\]/gi, '')
    .replace(/^\[\[[a-z-]{2,12}:[^\]]*\]\]\s*$/gm, '');
}

// ---------------------------------------------------------------------------------------------
// Block-level templates are swapped for tokens, so that each one stays on a single line
// ---------------------------------------------------------------------------------------------

type TokenPayload =
  | { readonly kind: 'listing'; readonly listing: Listing }
  | { readonly kind: 'marker'; readonly name: string }
  | { readonly kind: 'regionlist'; readonly items: readonly Block[] }
  | { readonly kind: 'box'; readonly label: string; readonly text: string };

const TOKEN = /QQWVTOKEN(\d+)QQ/g;
const tokenFor = (index: number): string => `QQWVTOKEN${index}QQ`;

function parseListing(call: TemplateCall, ctx: ConversionContext): Listing {
  const text = (value: string | null): string | null => {
    if (value === null) return null;
    const rendered = renderInline(value, ctx);
    return rendered === '' ? null : rendered;
  };
  const type =
    call.name === 'listing' ? (param(call, 'type') ?? 'listing').toLowerCase() : call.name;
  return {
    type,
    name: text(param(call, 'name')) ?? '',
    alt: text(param(call, 'alt')),
    description: text(param(call, 'content', 'description')),
    price: text(param(call, 'price')),
    hours: text(param(call, 'hours')),
  };
}

function parseRegionList(call: TemplateCall, ctx: ConversionContext): Block[] {
  const items: Block[] = [];
  for (let n = 1; n <= 50; n++) {
    const name = param(call, `region${n}name`);
    if (name === null) continue;
    const description = param(call, `region${n}description`);
    const places = param(call, `region${n}items`);
    const parts = [`**${renderInline(name, ctx)}**`];
    if (description !== null) parts.push(`— ${renderInline(description, ctx)}`);
    if (places !== null) parts.push(`(main places: ${renderInline(places, ctx)})`);
    items.push({ type: 'item', level: 1, ordered: false, text: parts.join(' '), entry: null });
  }
  return items;
}

interface Tokenised {
  readonly text: string;
  readonly payloads: readonly TokenPayload[];
  readonly isPartOf: readonly string[];
}

function tokeniseBlockTemplates(text: string, ctx: ConversionContext): Tokenised {
  const payloads: TokenPayload[] = [];
  const isPartOf: string[] = [];
  const push = (payload: TokenPayload): string => {
    payloads.push(payload);
    return tokenFor(payloads.length - 1);
  };
  const out = replaceTemplates(text, (call) => {
    if (LISTING_TEMPLATES.has(call.name)) {
      return push({ kind: 'listing', listing: parseListing(call, ctx) });
    }
    if (call.name === 'marker') {
      return push({ kind: 'marker', name: renderInline(param(call, 'name') ?? '', ctx) });
    }
    if (call.name === 'regionlist') {
      return `\n${push({ kind: 'regionlist', items: parseRegionList(call, ctx) })}\n`;
    }
    if (call.name === 'infobox') {
      const label = renderInline(param(call, '1') ?? '', ctx);
      const body = renderInline(param(call, '2') ?? '', ctx);
      return `\n${push({ kind: 'box', label, text: body })}\n`;
    }
    if (call.name === 'cautionbox' || call.name === 'warningbox') {
      const label = call.name === 'cautionbox' ? 'Caution' : 'Warning';
      return `\n${push({ kind: 'box', label, text: renderInline(param(call, '1') ?? '', ctx) })}\n`;
    }
    if (call.name === 'ispartof') {
      const parent = param(call, '1');
      if (parent !== null) isPartOf.push(parent.replace(/_/g, ' '));
      return '';
    }
    // Inline templates are expanded now: their arguments may span several lines.
    return renderInlineTemplate(call, ctx);
  });
  return { text: out, payloads, isPartOf };
}

// ---------------------------------------------------------------------------------------------
// Line walk
// ---------------------------------------------------------------------------------------------

const HEADING = /^(={1,6})\s*(.+?)\s*\1\s*$/;
const LIST_ITEM = /^([*#]+)\s*(.*)$/;
const INDENT = /^([:;]+)\s*(.*)$/;
/** Separator after an entry name, possibly after alternative names: "(Greek: Βάι) — The…". */
const LEAD_IN = /^(?:\([^)]*\)\s*)*[–—-]+\s*/;
const LEADING_BOLD = /^(?:the\s+)?'''(.+?)'''/i;
const LEADING_LINK = /^(?:the\s+)?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/i;

interface MutableSection {
  title: string;
  depth: number;
  blocks: Block[];
  listings: Listing[];
}

class GuideBuilder {
  readonly sections: MutableSection[] = [
    { title: LEAD_SECTION_TITLE, depth: 2, blocks: [], listings: [] },
  ];
  private paragraph: string[] = [];

  constructor(
    private readonly payloads: readonly TokenPayload[],
    private readonly ctx: ConversionContext,
  ) {}

  private get current(): MutableSection {
    const section = this.sections.at(-1);
    if (section === undefined) throw new Error('GuideBuilder has no section');
    return section;
  }

  heading(depth: number, rawTitle: string): void {
    this.flush();
    this.sections.push({
      title: this.inline(rawTitle),
      depth: Math.max(2, depth),
      blocks: [],
      listings: [],
    });
  }

  textLine(line: string): void {
    // A block token (region list, box) may share its line with text: split around it.
    const parts = line.split(/(QQWVTOKEN\d+QQ)/);
    for (const part of parts) {
      const payload = this.payloadOf(part);
      if (payload !== null && (payload.kind === 'regionlist' || payload.kind === 'box')) {
        this.flush();
        this.blockPayload(payload);
      } else if (part.trim() !== '') {
        this.paragraph.push(part);
      }
    }
  }

  item(markers: string, content: string): void {
    this.flush();
    this.noteListings(content);
    // A dash left at the start once an inline icon (`[[File:…]]`) is removed carries no meaning.
    const text = this.inlineWithTokens(content).replace(/^[–—]\s*/, '');
    const entry = this.entryOf(content);
    if (text === '' && entry === null) return;
    this.current.blocks.push({
      type: 'item',
      level: markers.length,
      ordered: markers.endsWith('#'),
      text,
      entry,
    });
  }

  tableRow(cells: readonly string[]): void {
    cells.forEach((cell) => this.noteListings(cell));
    const text = cells
      .map((cell) => this.inlineWithTokens(cell))
      .filter((cell) => cell !== '')
      .join(' — ');
    if (text !== '') {
      this.current.blocks.push({ type: 'item', level: 1, ordered: false, text, entry: null });
    }
  }

  flush(): void {
    if (this.paragraph.length === 0) return;
    const raw = this.paragraph.join('\n');
    this.paragraph = [];
    this.noteListings(raw);
    const text = this.inlineWithTokens(raw);
    if (text !== '') this.current.blocks.push({ type: 'paragraph', text });
  }

  private noteListings(raw: string): void {
    for (const match of raw.matchAll(TOKEN)) {
      const payload = this.payloads[Number(match[1])];
      if (payload?.kind === 'listing') this.current.listings.push(payload.listing);
    }
  }

  private blockPayload(payload: TokenPayload): void {
    if (payload.kind === 'regionlist') this.current.blocks.push(...payload.items);
    if (payload.kind === 'box' && payload.text !== '') {
      this.current.blocks.push({ type: 'box', label: payload.label, text: payload.text });
    }
  }

  private payloadOf(token: string): TokenPayload | null {
    const match = /^\s*QQWVTOKEN(\d+)QQ\s*$/.exec(token);
    if (match?.[1] === undefined) return null;
    return this.payloads[Number(match[1])] ?? null;
  }

  private inline(text: string): string {
    return renderInline(text, this.ctx);
  }

  /** Renders inline wikitext, then puts listings and markers back in place of their tokens. */
  private inlineWithTokens(text: string): string {
    return this.inline(text)
      .replace(TOKEN, (_match, index: string) => {
        const payload = this.payloads[Number(index)];
        if (payload?.kind === 'listing') return renderListing(payload.listing);
        if (payload?.kind === 'marker') return payload.name === '' ? '' : `**${payload.name}**`;
        return '';
      })
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Identifies the place or activity a list item is about, when it starts with one. */
  private entryOf(content: string): Entry | null {
    const trimmed = content.trim();
    const lead = /^QQWVTOKEN(\d+)QQ/.exec(trimmed);
    if (lead?.[1] !== undefined) {
      const payload = this.payloads[Number(lead[1])];
      const rest = this.inlineWithTokens(trimmed.slice(lead[0].length));
      if (payload?.kind === 'listing') {
        if (rest === '') return { source: 'listing', listing: payload.listing };
        const description = [payload.listing.description, rest].filter(Boolean).join(' ');
        return { source: 'listing', listing: { ...payload.listing, description } };
      }
      if (payload?.kind === 'marker' && payload.name !== '') {
        const description = describe(rest, () => this.inlineWithTokens(trimmed));
        return { source: 'marker', name: payload.name, description };
      }
      return null;
    }
    const bold = LEADING_BOLD.exec(trimmed);
    const link = bold === null ? LEADING_LINK.exec(trimmed) : null;
    const match = bold ?? link;
    if (match === null) return null;
    const rawName = bold?.[1] ?? link?.[2] ?? link?.[1] ?? '';
    const name = this.inline(rawName).replace(/[\s:.,;]+$/, '');
    if (name === '') return null;
    const rest = this.inlineWithTokens(trimmed.slice(match[0].length));
    const description = describe(rest, () => this.inlineWithTokens(trimmed));
    return { source: 'named', name, description };
  }
}

/**
 * Description of an entry from the text after its name: what follows a dash separator, or the
 * whole item when the name is part of a sentence ("'''Valldemossa''' Charterhouse was…").
 */
function describe(rest: string, wholeItem: () => string): string | null {
  if (rest === '') return null;
  const lead = LEAD_IN.exec(rest);
  const text = lead === null ? wholeItem() : rest.slice(lead[0].length).trim();
  return text === '' ? null : text;
}

/** `- **Name** (alt) — description (price: …; hours: …)` without the list marker. */
export function renderListing(listing: Listing): string {
  const head = listing.name === '' ? '' : `**${listing.name}**`;
  const alt = listing.alt === null ? '' : ` (${listing.alt})`;
  const details = [
    listing.price === null ? null : `price: ${listing.price}`,
    listing.hours === null ? null : `hours: ${listing.hours}`,
  ].filter((detail): detail is string => detail !== null);
  const tail = details.length === 0 ? '' : ` (${details.join('; ')})`;
  const body = listing.description ?? '';
  const separator = head !== '' && body !== '' ? ' — ' : '';
  return `${head}${alt}${separator}${body}${tail}`.trim();
}

function splitTableCells(line: string): string[] {
  const body = line.replace(/^[|!]/, '');
  return body.split(/\|\||!!/).map((cell) => {
    // `style="…" | content`: keep the content after the attribute block.
    const pipe = cell.indexOf('|');
    return pipe >= 0 && cell.slice(0, pipe).includes('=') && !cell.slice(0, pipe).includes('[[')
      ? cell.slice(pipe + 1)
      : cell;
  });
}

function walkLines(text: string, builder: GuideBuilder): void {
  let inTable = false;
  let row: string[] = [];
  const endRow = (): void => {
    if (row.length > 0) builder.tableRow(row);
    row = [];
  };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (inTable) {
      if (trimmed.startsWith('|}')) {
        endRow();
        inTable = false;
      } else if (trimmed.startsWith('|-')) {
        endRow();
      } else if (trimmed.startsWith('|+')) {
        builder.tableRow([trimmed.slice(2)]);
      } else if (trimmed.startsWith('|') || trimmed.startsWith('!')) {
        row.push(...splitTableCells(trimmed));
      } else if (trimmed !== '') {
        row.push(trimmed);
      }
      continue;
    }
    const heading = HEADING.exec(trimmed);
    const listItem = LIST_ITEM.exec(trimmed);
    const indent = INDENT.exec(trimmed);
    if (trimmed.startsWith('{|')) {
      builder.flush();
      inTable = true;
    } else if (heading?.[1] !== undefined && heading[2] !== undefined) {
      builder.heading(heading[1].length, heading[2]);
    } else if (trimmed === '' || /^-{4,}$/.test(trimmed)) {
      builder.flush();
    } else if (listItem?.[1] !== undefined) {
      builder.item(listItem[1], listItem[2] ?? '');
    } else if (indent?.[1] !== undefined) {
      builder.flush();
      const content = indent[2] ?? '';
      builder.textLine(indent[1].startsWith(';') ? `'''${content}'''` : content);
      builder.flush();
    } else {
      builder.textLine(line);
    }
  }
  if (inTable) endRow();
  builder.flush();
}

/** Drops sections that have no content of their own and no non-empty subsection. */
function pruneEmptySections(sections: readonly MutableSection[]): GuideSection[] {
  const keep = sections.map((section, index) => {
    if (section.blocks.length > 0 || section.listings.length > 0) return true;
    for (let j = index + 1; j < sections.length; j++) {
      const next = sections[j];
      if (next === undefined || next.depth <= section.depth) break;
      if (next.blocks.length > 0 || next.listings.length > 0) return true;
    }
    return false;
  });
  const result: GuideSection[] = [];
  const stack: { depth: number; title: string }[] = [];
  sections.forEach((section, index) => {
    if (!keep[index]) return;
    while ((stack.at(-1)?.depth ?? 0) >= section.depth) stack.pop();
    stack.push({ depth: section.depth, title: section.title });
    result.push({
      title: section.title,
      depth: section.depth,
      path: stack.map((s) => s.title),
      blocks: section.blocks,
      listings: section.listings,
    });
  });
  return result;
}

/** Converts a Wikivoyage article to a structured guide document. */
export function convertArticle(title: string, wikitext: string): GuideDocument {
  const ctx = newContext();
  const tokenised = tokeniseBlockTemplates(preprocess(wikitext), ctx);
  const builder = new GuideBuilder(tokenised.payloads, ctx);
  walkLines(tokenised.text, builder);
  const warnings = [...ctx.warnings.entries()].map(([message, count]) =>
    count > 1 ? `${message} (x${count})` : message,
  );
  return {
    title,
    sections: pruneEmptySections(builder.sections),
    isPartOf: tokenised.isPartOf,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------------------------

function renderBlocks(blocks: readonly Block[]): string {
  const chunks: string[] = [];
  let list: string[] = [];
  const flushList = (): void => {
    if (list.length > 0) chunks.push(list.join('\n'));
    list = [];
  };
  for (const block of blocks) {
    if (block.type === 'item') {
      const indent = '  '.repeat(Math.max(0, block.level - 1));
      const marker = block.ordered ? '1.' : '-';
      const text =
        block.entry?.source === 'listing' ? renderListing(block.entry.listing) : block.text;
      list.push(`${indent}${marker} ${text}`);
    } else {
      flushList();
      chunks.push(block.type === 'paragraph' ? block.text : `> **${block.label}:** ${block.text}`);
    }
  }
  flushList();
  return chunks.join('\n\n');
}

/** Renders the guide body (without front matter): `# Title`, then one heading per section. */
export function renderGuideMarkdown(doc: GuideDocument): string {
  const parts = [`# ${doc.title}`];
  for (const section of doc.sections) {
    parts.push(`${'#'.repeat(section.depth)} ${section.title}`);
    const body = renderBlocks(section.blocks);
    if (body !== '') parts.push(body);
  }
  return `${parts.join('\n\n')}\n`;
}

/** Words of rendered text (for corpus statistics). */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** Words of a Markdown guide body, headings excluded (the statistic reported by the scripts). */
export function countContentWords(markdown: string): number {
  return countWords(markdown.replace(/^#{1,6} .*$/gm, ''));
}

export function sectionText(section: GuideSection): string {
  return renderBlocks(section.blocks);
}

/** Every listing of the document with the heading path of its section. */
export function collectListings(
  doc: GuideDocument,
): { readonly listing: Listing; readonly path: readonly string[] }[] {
  return doc.sections.flatMap((section) =>
    section.listings.map((listing) => ({ listing, path: section.path })),
  );
}
