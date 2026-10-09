import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Absolute path of the `data/` directory, independent of the current working directory. */
export const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DESTINATIONS_FILE = path.join(DATA_DIR, 'destinations.yaml');
export const CORPUS_DIR = path.join(DATA_DIR, 'corpus');
export const CLIMATE_DIR = path.join(DATA_DIR, 'climate');
/** Raw downloads (gitignored): re-fetchable, pinned by revision id / request URL. */
export const RAW_WIKIVOYAGE_DIR = path.join(DATA_DIR, 'raw', 'wikivoyage');
export const RAW_OPEN_METEO_DIR = path.join(DATA_DIR, 'raw', 'open-meteo');

export const guidePath = (id: string): string => path.join(CORPUS_DIR, id, 'guide.md');
export const factsPath = (id: string): string => path.join(CORPUS_DIR, id, 'facts.yaml');
export const climatePath = (id: string): string => path.join(CLIMATE_DIR, `${id}.yaml`);
export const rawWikivoyagePath = (id: string): string =>
  path.join(RAW_WIKIVOYAGE_DIR, `${id}.json`);
export const rawOpenMeteoPath = (id: string): string => path.join(RAW_OPEN_METEO_DIR, `${id}.json`);
