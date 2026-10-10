import type { CorpusDestination, CorpusDocument } from './corpus-source.js';

/**
 * Port: the write side of the knowledge base, used by the ingestion only (the agent reads through
 * the domain's Retriever and KnowledgeRepository ports). Implemented over Postgres + pgvector.
 */

/** What is stored about an indexed document, to decide whether it must be indexed again. */
export interface IndexedDocument {
  readonly path: string;
  readonly checksum: string;
  readonly embeddingModel: string | null;
  readonly chunking: string | null;
}

export interface ChunkToStore {
  readonly ordinal: number;
  readonly headingPath: string;
  readonly sections: readonly string[];
  readonly content: string;
  readonly tokenCount: number;
  readonly embedding: readonly number[];
}

export interface DocumentToStore {
  readonly document: CorpusDocument;
  readonly embeddingModel: string;
  readonly chunking: string;
  readonly chunks: readonly ChunkToStore[];
}

export interface DestinationSyncResult {
  readonly upserted: number;
  /** Destinations no longer in the corpus, deleted with everything derived from them. */
  readonly removed: readonly string[];
}

export interface KnowledgeStore {
  /**
   * Makes the destinations and their facts (climate, costs, POIs) equal to the corpus, in one
   * transaction. Existing destinations are updated in place, so their documents are kept.
   */
  syncDestinations(destinations: readonly CorpusDestination[]): Promise<DestinationSyncResult>;
  listIndexedDocuments(): Promise<readonly IndexedDocument[]>;
  /** Replaces a document and all its chunks atomically (one transaction). */
  replaceDocument(input: DocumentToStore): Promise<void>;
  removeDocuments(paths: readonly string[]): Promise<void>;
}
