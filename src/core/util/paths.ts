import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Root for the SQLite db, cached bodies and spilled text. Override with OPENSCRAPE_DATA_DIR. */
export const DATA_DIR = resolve(
  process.env.OPENSCRAPE_DATA_DIR || join(homedir(), '.openscrape'),
);

export const BODIES_DIR = join(DATA_DIR, 'bodies');
export const SPILL_DIR = join(DATA_DIR, 'pages');
export const EXPORTS_DIR = join(DATA_DIR, 'exports');
export const DB_PATH = join(DATA_DIR, 'openscrape.db');

let ready = false;
export function ensureDataDirs(): void {
  if (ready) return;
  for (const dir of [DATA_DIR, BODIES_DIR, SPILL_DIR, EXPORTS_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
  ready = true;
}
