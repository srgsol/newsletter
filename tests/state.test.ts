import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/state.js';

describe('StateStore', () => {
  it('loads empty state when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-state-'));
    const store = new StateStore(join(dir, 'data', 'state.json'));
    expect(store.load()).toEqual({ seen: {}, editions: [], lastRun: null });
  });

  it('creates parent directories and saves atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-state-'));
    const path = join(dir, 'deep', 'nested', 'state.json');
    const store = new StateStore(path);
    const state = {
      seen: { 'https://example.com/post': '2026-08-21' },
      editions: [{ issue: 1, date: '2026-08-21', file: 'editions/2026-08-21.md', items: 3 }],
      lastRun: '2026-08-21T09:00:00.000Z',
    };
    store.save(state);
    expect(store.load()).toEqual(state);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(state);
  });

  it('tolerates a corrupt state file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nl-state-'));
    const path = join(dir, 'state.json');
    writeFileSync(path, '{not json');
    const store = new StateStore(path);
    expect(store.load()).toEqual({ seen: {}, editions: [], lastRun: null });
  });
});
