/* eslint-disable @typescript-eslint/no-unused-vars -- learning skeleton: the parameters and helpers are used once the TODOs are implemented; remove this line at the end. */
import { estimateTokens, type TokenEstimator } from './tokens.js';

/**
 * Structure-aware Markdown chunker (plan section 6, option 3).
 *
 * 1. The document is cut into sections at `##` and `###` headings. Deeper headings stay inside
 *    their section, glued to the block that follows them.
 * 2. Sections smaller than `minTokens` are merged with an adjacent sibling (same parent heading)
 *    when the result still fits `targetTokens`, so a three-line subsection does not become a
 *    low-information chunk of its own.
 * 3. Sections longer than `maxTokens` are split on block boundaries (paragraphs, list items,
 *    quotes) towards `targetTokens`, each part repeating up to `overlapTokens` of the previous
 *    part. A list item (a Wikivoyage listing) is never cut, even when it alone exceeds the
 *    budget; an over-long paragraph is split between sentences.
 * 4. Each chunk carries its breadcrumb, "<Document title> > <Section> > <Subsection>", which is
 *    prefixed to the embedded text when `contextualHeader` is on (contextual chunk header).
 *
 * Budgets apply to the chunk body and are counted with a token estimate (see `tokens.ts`).
 */

/*
 * SQUELETTE D'EXERCICE (branche learning/chunking-rrf). Guide : docs/learning/chunking-rrf.md sur
 * main ; ordre des étapes : LEARNING.md à la racine de la branche.
 *
 * Fourni : les types, les options et leur validation, l'empreinte, la fabrique `markdownChunker`,
 * les expressions régulières, le découpage des lignes en blocs (`toBlocks`) et les petites aides
 * (`toUnit`, `commonPrefix`, `sumTokens`, `joinBlocks`, `isBlank`).
 * À écrire : le pipeline (`chunkMarkdown`), les sections (`parseSections`), la fusion des petites
 * sections, le découpage des longues sections avec chevauchement, et les phrases.
 *
 * Le vocabulaire : un BLOC est un paragraphe, un élément de liste (avec ses lignes de suite), une
 * citation ou un bloc de code ; une SECTION est un chemin de titres + ses blocs ; une UNITÉ est une
 * section ou plusieurs petites sections sœurs fusionnées ; une PARTIE est un morceau d'unité, qui
 * deviendra un chunk.
 */

export interface ChunkingOptions {
  /** Size, in estimated tokens, that long sections are split towards. */
  readonly targetTokens: number;
  /** A section up to this size stays whole; parts never exceed it, except one over-long list item. */
  readonly maxTokens: number;
  /** Trailing context of a part repeated at the start of the next part of the same section. */
  readonly overlapTokens: number;
  /** Sections below this size are merged with a sibling when the result fits `targetTokens`. */
  readonly minTokens: number;
  /** Prefix the breadcrumb to the embedded text. */
  readonly contextualHeader: boolean;
}

/** Bump when the algorithm changes, so that ingestion re-chunks every document. */
export const CHUNKER_VERSION = 1;

/**
 * Default parameters. In the retrieval evaluation (docs/EVALUATIONS.md) this configuration beats
 * a fixed-size baseline by 10.4 points of Recall@5 with vector search (95 % CI 2.8 to 18.9); other
 * sizes have not been compared yet. Bodies stay under ~450 estimated tokens so that, with the
 * breadcrumb, the embedded text fits the model's 512-token window (2 of 2,136 chunks exceed it).
 */
export const DEFAULT_CHUNKING: ChunkingOptions = {
  targetTokens: 300,
  maxTokens: 450,
  overlapTokens: 30,
  minTokens: 60,
  contextualHeader: true,
};

export const BREADCRUMB_SEPARATOR = ' > ';

export interface MarkdownDocument {
  /** Breadcrumb root, usually the document title. */
  readonly title: string;
  /** Markdown body, front matter removed. A leading `# Title` heading is skipped. */
  readonly markdown: string;
}

export interface Chunk {
  /** 0-based position in the document. */
  readonly ordinal: number;
  /** Breadcrumb of the chunk, e.g. "Sicily > Do > Hiking" (the common parent for merged sections). */
  readonly headingPath: string;
  /** Every section the chunk covers, relative to the document ("Do > Hiking"; "" = before any heading). */
  readonly sections: readonly string[];
  /** Markdown body shown to the agent (no breadcrumb). */
  readonly content: string;
  /** Text to embed: breadcrumb + body when `contextualHeader` is on, the body otherwise. */
  readonly text: string;
  /** Estimated tokens of `text`. */
  readonly tokenCount: number;
}

type BlockKind = 'paragraph' | 'item' | 'quote' | 'code' | 'heading';

interface Block {
  readonly kind: BlockKind;
  readonly text: string;
  readonly tokens: number;
}

interface Section {
  readonly path: readonly string[];
  readonly blocks: readonly Block[];
}

/** A section, or several small sibling sections merged together. */
interface Unit {
  readonly path: readonly string[];
  readonly sections: ReadonlyArray<readonly string[]>;
  readonly blocks: readonly Block[];
  readonly tokens: number;
}

interface Part {
  readonly blocks: readonly Block[];
  readonly tokens: number;
  /** Leading blocks repeated from the previous part. */
  readonly overlap: number;
}

export function validateChunkingOptions(options: ChunkingOptions): ChunkingOptions {
  const { targetTokens, maxTokens, overlapTokens, minTokens } = options;
  const integers = { targetTokens, maxTokens, overlapTokens, minTokens };
  for (const [name, value] of Object.entries(integers)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer (got ${value})`);
    }
  }
  if (targetTokens < 1) throw new RangeError('targetTokens must be at least 1');
  if (maxTokens < targetTokens) throw new RangeError('maxTokens must be >= targetTokens');
  if (overlapTokens >= targetTokens) throw new RangeError('overlapTokens must be < targetTokens');
  if (minTokens > targetTokens) throw new RangeError('minTokens must be <= targetTokens');
  return options;
}

/** Stable description of the chunking configuration, stored with each indexed document. */
export function chunkingFingerprint(options: ChunkingOptions): string {
  const { targetTokens, maxTokens, overlapTokens, minTokens, contextualHeader } = options;
  return [
    `md-v${CHUNKER_VERSION}`,
    `target=${targetTokens}`,
    `max=${maxTokens}`,
    `overlap=${overlapTokens}`,
    `min=${minTokens}`,
    `header=${contextualHeader ? 'on' : 'off'}`,
  ].join(';');
}

/** A chunking strategy, identified by a fingerprint stored with each indexed document. */
export interface DocumentChunker {
  readonly fingerprint: string;
  chunk(document: MarkdownDocument): Chunk[];
}

/** The structure-aware chunker below, with fixed parameters. */
export function markdownChunker(
  options: ChunkingOptions,
  estimate: TokenEstimator = estimateTokens,
): DocumentChunker {
  validateChunkingOptions(options);
  return {
    fingerprint: chunkingFingerprint(options),
    chunk: (document) => chunkMarkdown(document, options, estimate),
  };
}

export function chunkMarkdown(
  document: MarkdownDocument,
  options: ChunkingOptions,
  estimate: TokenEstimator = estimateTokens,
): Chunk[] {
  // TODO(learning) — étape 3 (version minimale), complétée aux étapes 4 et 6.
  // Le pipeline, dans l'ordre :
  // 1. Valide les options (les tests attendent une RangeError même sur un document vide).
  // 2. Markdown -> sections (`parseSections`) -> unités (`toUnit`).
  // 3. Fusionne les petites unités sœurs (`mergeSmallSiblings`). À l'étape 3, tu peux sauter
  //    cette étape : les tests « one chunk per section » n'ont pas de petite section.
  // 4. Découpe chaque unité en parties (`splitUnit`). À l'étape 3, une unité = une partie.
  // 5. Une partie = un chunk : `ordinal` (position dans le document), `headingPath` (titre du
  //    document + chemin de l'unité, séparés par BREADCRUMB_SEPARATOR), `sections` (chaque chemin
  //    couvert, relatif au document), `content` (`joinBlocks`), `text` (fil d'Ariane + ligne vide +
  //    contenu si `contextualHeader`, sinon le contenu seul) et `tokenCount` (estimation de `text`).
  throw new Error('TODO(learning): chunkMarkdown (chunking-rrf, step 3)');
}

// ---------------------------------------------------------------------------------------------
// Parsing: Markdown → sections of blocks
// ---------------------------------------------------------------------------------------------

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;
const TOP_LEVEL_ITEM = /^ ?(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
const QUOTE = /^[ \t]{0,3}>/;

function parseSections(markdown: string, estimate: TokenEstimator): Section[] {
  // TODO(learning) — étape 3. Spec : describe('chunkMarkdown: one chunk per section').
  // Parcours ligne par ligne (normalise d'abord les fins de ligne Windows), avec un tampon de
  // lignes pour la section en cours et le chemin de titres courant.
  // - Une ligne qui ouvre ou ferme un bloc de code (FENCE) bascule un état « dans le code » : un
  //   `## …` dans du code n'est pas un titre.
  // - Pas un titre, titre de niveau ≥ 4, ou titre vide : la ligne reste dans le tampon (elle sera
  //   collée au bloc suivant par `toBlocks`).
  // - Un `# Titre` tout au début (aucune section, tampon vide) est le titre du document : on
  //   l'ignore, il est déjà la racine du fil d'Ariane. Un `#` plus loin compte comme un `##`.
  // - `#`/`##` : vide le tampon dans une section, puis nouveau chemin [titre] (retiens ce titre).
  // - `###` : vide le tampon, puis chemin [titre ## courant, titre], ou [titre] s'il n'y a pas
  //   encore eu de `##`.
  // - Vider le tampon = `toBlocks(tampon, estimate)` ; ne crée une section que si elle a des
  //   blocs (un titre qui ne fait qu'introduire des sous-sections ne donne pas de chunk).
  throw new Error('TODO(learning): parseSections (chunking-rrf, step 3)');
}

function isBlank(lines: readonly string[]): boolean {
  return lines.every((line) => line.trim() === '');
}

/** Groups lines into blocks: paragraphs, top-level list items (with continuations), quotes, code. */
function toBlocks(lines: readonly string[], estimate: TokenEstimator): Block[] {
  const raw: Array<{ kind: BlockKind; lines: string[] }> = [];
  let current: { kind: BlockKind; lines: string[] } | null = null;
  let inFence = false;

  const close = (): void => {
    if (current !== null) raw.push(current);
    current = null;
  };

  for (const line of lines) {
    if (inFence) {
      current?.lines.push(line);
      if (FENCE.test(line)) {
        inFence = false;
        close();
      }
      continue;
    }
    if (FENCE.test(line)) {
      close();
      current = { kind: 'code', lines: [line] };
      inFence = true;
      continue;
    }
    if (line.trim() === '') {
      close();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      close();
      raw.push({ kind: 'heading', lines: [line.trim()] });
      continue;
    }
    const kind: BlockKind = TOP_LEVEL_ITEM.test(line)
      ? 'item'
      : QUOTE.test(line)
        ? 'quote'
        : 'paragraph';
    const continues =
      current !== null && (kind === 'paragraph' || (kind === 'quote' && current.kind === 'quote'));
    if (continues && current !== null) {
      current.lines.push(line);
    } else {
      close();
      current = { kind, lines: [line] };
    }
  }
  close();

  // A heading inside a section is glued to the block that follows it, never left alone at the
  // end of a part; a trailing heading with nothing after it stays a block of its own.
  const blocks: Block[] = [];
  let pendingHeadings: string[] = [];
  for (const block of raw) {
    if (block.kind === 'heading') {
      pendingHeadings.push(...block.lines);
      continue;
    }
    const text = [...pendingHeadings, block.lines.join('\n').trimEnd()].join('\n');
    pendingHeadings = [];
    blocks.push({ kind: block.kind, text, tokens: estimate(text) });
  }
  if (pendingHeadings.length > 0) {
    const text = pendingHeadings.join('\n');
    blocks.push({ kind: 'paragraph', text, tokens: estimate(text) });
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------
// Merging small sibling sections
// ---------------------------------------------------------------------------------------------

function toUnit(section: Section): Unit {
  return {
    path: section.path,
    sections: [section.path],
    blocks: section.blocks,
    tokens: sumTokens(section.blocks),
  };
}

/**
 * Two units are siblings when they belong to the same `##` section (its introduction and its
 * `###` subsections), or when both are top-level `##` sections without subsections.
 */
function areSiblings(left: Unit, right: Unit): boolean {
  // TODO(learning) — étape 4. Regarde TOUTES les sections couvertes par les deux unités (une unité
  // fusionnée en couvre plusieurs) : même premier élément de chemin pour toutes, ou toutes de
  // longueur 1 (des `##` sans sous-section, qui fusionnent alors sous la racine du document).
  throw new Error('TODO(learning): areSiblings (chunking-rrf, step 4)');
}

function mergeSmallSiblings(
  units: readonly Unit[],
  options: ChunkingOptions,
  estimate: TokenEstimator,
): Unit[] {
  // TODO(learning) — étape 4. Spec : describe('chunkMarkdown: merging small sections').
  // Un seul passage de gauche à droite, en comparant chaque unité à la DERNIÈRE unité gardée :
  // si l'une des deux est petite (< minTokens) et qu'elles sont sœurs, essaie de les fusionner
  // (`mergeUnits`) ; garde la fusion seulement si elle tient dans `targetTokens`. Comme on compare
  // au résultat de la fusion précédente, de petites sœurs s'enchaînent tant qu'elles tiennent.
  throw new Error('TODO(learning): mergeSmallSiblings (chunking-rrf, step 4)');
}

function mergeUnits(left: Unit, right: Unit, estimate: TokenEstimator): Unit {
  // TODO(learning) — étape 4. Le chemin de l'unité fusionnée est le préfixe commun des deux
  // chemins (`commonPrefix`) ; ses blocs sont ceux de gauche puis de droite, chacun précédé de son
  // propre titre s'il « descend » sous ce chemin (`withHeading`) ; ses sections sont la
  // concaténation des deux listes ; ses tokens sont recalculés (`sumTokens`).
  throw new Error('TODO(learning): mergeUnits (chunking-rrf, step 4)');
}

/** Prefixes a unit's blocks with its own heading when it moves under a shorter path. */
function withHeading(unit: Unit, path: readonly string[], estimate: TokenEstimator): Block[] {
  // TODO(learning) — étape 4. Si le chemin de l'unité n'est pas plus long que `path`, ses blocs
  // restent tels quels. Sinon, recrée en Markdown les titres perdus (niveau = profondeur + 2 :
  // sous la racine, « Respect » redevient `## Respect` ; sous « Do », « Fishing » redevient
  // `### Fishing`), colle-les au PREMIER bloc (avec un saut de ligne) et ré-estime ses tokens.
  // Les tests montrent le contenu exact attendu.
  throw new Error('TODO(learning): withHeading (chunking-rrf, step 4)');
}

function commonPrefix(left: readonly string[], right: readonly string[]): string[] {
  const prefix: string[] = [];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) break;
    prefix.push(left[index] as string);
  }
  return prefix;
}

// ---------------------------------------------------------------------------------------------
// Splitting long sections
// ---------------------------------------------------------------------------------------------

function splitUnit(unit: Unit, options: ChunkingOptions, estimate: TokenEstimator): Part[] {
  // TODO(learning) — étape 6. Spec : describe('chunkMarkdown: splitting long sections').
  // 1. Une unité qui tient dans `maxTokens` reste entière : une seule partie, sans chevauchement.
  // 2. Sinon, redécoupe d'abord les paragraphes (et citations) trop longs pour `maxTokens` en
  //    morceaux de phrases (`splitParagraph` vers `targetTokens`). Un élément de liste, lui, n'est
  //    JAMAIS coupé, même s'il dépasse tout seul.
  // 3. Remplissage glouton vers `targetTokens` : quand ajouter le bloc suivant dépasserait la
  //    cible ET que la partie en cours contient au moins un bloc « neuf » (pas seulement le
  //    chevauchement), ferme la partie. La suivante commence par le chevauchement
  //    (`overlapFrom`), sauf si chevauchement + bloc dépasserait `maxTokens` : alors sans.
  //    Retiens, pour chaque partie, combien de blocs de tête viennent du chevauchement.
  // 4. Termine par `absorbSmallTail`.
  throw new Error('TODO(learning): splitUnit (chunking-rrf, step 6)');
}

/** A tiny last part is folded into the previous one (without its overlap) when that fits. */
function absorbSmallTail(parts: readonly Part[], options: ChunkingOptions): Part[] {
  // TODO(learning) — étape 6. Ne regarde que les blocs NEUFS de la dernière partie (sans son
  // chevauchement, qui est déjà dans l'avant-dernière). S'ils pèsent moins que `minTokens` et
  // tiennent avec l'avant-dernière partie dans `maxTokens`, ajoute-les à celle-ci et supprime la
  // dernière. Sinon, ne change rien.
  throw new Error('TODO(learning): absorbSmallTail (chunking-rrf, step 6)');
}

/** Whole trailing blocks within the budget; for a long trailing paragraph, its last sentences. */
function overlapFrom(blocks: readonly Block[], budget: number, estimate: TokenEstimator): Block[] {
  // TODO(learning) — étape 6. Budget nul -> pas de chevauchement. Sinon, remonte depuis la fin et
  // garde des blocs ENTIERS tant qu'ils tiennent dans le budget. Cas particulier : si le tout
  // dernier bloc ne tient pas et que c'est un paragraphe, prends ses dernières phrases
  // (`trailingSentences`) à la place. Jamais un morceau d'élément de liste.
  throw new Error('TODO(learning): overlapFrom (chunking-rrf, step 6)');
}

const SENTENCE_BOUNDARY = /(?<=[.!?…])\s+(?=["'“‘([]?[\p{Lu}\p{N}])/u;

export function splitSentences(text: string): string[] {
  // TODO(learning) — étape 5. Spec : describe('splitSentences'). Coupe sur SENTENCE_BOUNDARY (une
  // ponctuation de fin de phrase, des espaces, puis une majuscule ou un chiffre, éventuellement
  // après un guillemet ou une parenthèse), nettoie les espaces, retire les morceaux vides.
  throw new Error('TODO(learning): splitSentences (chunking-rrf, step 5)');
}

function trailingSentences(text: string, budget: number, estimate: TokenEstimator): string {
  // TODO(learning) — étape 6. Les dernières phrases de `text` qui tiennent ensemble dans le
  // budget, dans leur ordre d'origine, jointes par une espace (chaîne vide si aucune ne tient).
  throw new Error('TODO(learning): trailingSentences (chunking-rrf, step 6)');
}

/** Splits an over-long paragraph between sentences into pieces of about `target` tokens. */
function splitParagraph(block: Block, target: number, estimate: TokenEstimator): Block[] {
  // TODO(learning) — étape 6. Remplissage glouton de phrases : ferme le morceau en cours quand la
  // phrase suivante le ferait dépasser `target` (un morceau n'est jamais vide, donc une phrase
  // très longue forme un morceau à elle seule). Chaque morceau garde le `kind` du bloc d'origine
  // et ré-estime ses tokens.
  throw new Error('TODO(learning): splitParagraph (chunking-rrf, step 6)');
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function sumTokens(blocks: readonly Block[]): number {
  return blocks.reduce((total, block) => total + block.tokens, 0);
}

/** Consecutive list items stay one list; other blocks are separate paragraphs. */
function joinBlocks(blocks: readonly Block[]): string {
  let text = '';
  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    if (previous !== undefined) {
      text += previous.kind === 'item' && block.kind === 'item' ? '\n' : '\n\n';
    }
    text += block.text;
  });
  return text;
}
