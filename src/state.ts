import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface EditionRecord {
  issue: number;
  date: string; // YYYY-MM-DD
  file: string; // path relative to the project root
  items: number;
}

export interface State {
  /** url -> edition date it was included in; a url present here is never re-included */
  seen: Record<string, string>;
  editions: EditionRecord[];
  /** ISO timestamp of the last completed run */
  lastRun: string | null;
}

export class StateStore {
  constructor(private readonly path: string) {}

  load(): State {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<State>;
      return {
        seen: raw.seen ?? {},
        editions: raw.editions ?? [],
        lastRun: raw.lastRun ?? null,
      };
    } catch {
      return { seen: {}, editions: [], lastRun: null };
    }
  }

  /** Writes atomically (temp file + rename) so a crash never corrupts state. */
  save(state: State): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.path);
  }
}
