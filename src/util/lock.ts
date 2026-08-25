import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const STALE_MS = 60 * 60 * 1000; // locks older than an hour are considered stale

/**
 * Creates a lock file (exclusive create) to prevent overlapping runs.
 * Returns a release function. Throws if another run holds the lock.
 */
export function acquireLock(path: string): () => void {
  if (existsSync(path)) {
    try {
      const age = Date.now() - Number(readFileSync(path, 'utf8'));
      if (age > STALE_MS) rmSync(path, { force: true });
    } catch {
      rmSync(path, { force: true }); // unreadable lock: treat as stale
    }
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(Date.now()), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `another run appears to be in progress (lock file: ${path}). ` +
          `If this is stale, delete the file and try again.`,
      );
    }
    throw err; // e.g. permission errors — surface the real cause
  }
  return () => {
    try {
      rmSync(path, { force: true });
    } catch {
      /* already gone */
    }
  };
}
