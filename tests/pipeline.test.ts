import { describe, expect, it } from 'vitest';
import type { SummarizedItem } from '../src/ai/types.js';
import { computeWindowStart, filterItems, rankItems, resolveDuplicates } from '../src/pipeline.js';
import type { RawItem } from '../src/sources/types.js';
import type { State } from '../src/state.js';
import { daysAgo } from '../src/util/dates.js';

function item(url: string, publishedAt: Date): RawItem {
  return {
    url,
    title: `title ${url}`,
    description: '',
    publishedAt,
    type: 'blog',
    personId: 'p',
    personName: 'Person',
    personTags: [],
  };
}

const D = (iso: string) => new Date(iso);

describe('computeWindowStart', () => {
  it('uses lastRun when present', () => {
    const state: State = { seen: {}, editions: [], lastRun: '2026-08-20T09:00:00.000Z' };
    expect(computeWindowStart(state, 7).getTime()).toBe(D('2026-08-20T09:00:00.000Z').getTime());
  });

  it('falls back to lookbackDays ago', () => {
    const state: State = { seen: {}, editions: [], lastRun: null };
    const expected = daysAgo(7).getTime();
    const actual = computeWindowStart(state, 7).getTime();
    expect(Math.abs(actual - expected)).toBeLessThan(60_000);
  });
});

describe('filterItems', () => {
  it('keeps only in-window, never-seen, non-duplicate items, newest first', () => {
    const raw = [
      item('https://x/old', D('2026-08-01T00:00:00Z')),
      item('https://x/seen', D('2026-08-20T00:00:00Z')),
      item('https://x/new-1', D('2026-08-19T00:00:00Z')),
      item('https://x/new-2', D('2026-08-20T00:00:00Z')),
      item('https://x/new-2', D('2026-08-20T00:00:00Z')), // in-run duplicate
    ];
    const out = filterItems(raw, D('2026-08-15T00:00:00Z'), new Set(['https://x/seen']));
    expect(out.map((i) => i.url)).toEqual(['https://x/new-2', 'https://x/new-1']);
  });
});

describe('resolveDuplicates', () => {
  const items = [item('https://x/a', D('2026-08-20T00:00:00Z')), item('https://x/b', D('2026-08-19T00:00:00Z'))];

  it('drops batch-internal duplicates and records them under the primary', () => {
    const summarized: SummarizedItem[] = [
      { url: 'https://x/a', summary: 'A', why: null, score: 8, isDuplicateOf: null },
      { url: 'https://x/b', summary: 'B', why: null, score: 5, isDuplicateOf: 'https://x/a' },
    ];
    const { kept, duplicates } = resolveDuplicates(items, summarized);
    expect(kept.map((k) => k.url)).toEqual(['https://x/a']);
    expect(duplicates['https://x/a']).toEqual([{ title: 'title https://x/b', url: 'https://x/b' }]);
  });

  it('keeps items flagged as duplicating something outside the batch', () => {
    const summarized: SummarizedItem[] = [
      { url: 'https://x/a', summary: 'A', why: null, score: 8, isDuplicateOf: 'https://x/from-last-week' },
    ];
    const { kept } = resolveDuplicates(items, summarized);
    expect(kept).toHaveLength(1);
  });
});

describe('rankItems', () => {
  it('sorts by score desc (unscored last), then date, and applies the cap', () => {
    const a = item('https://x/a', D('2026-08-20T00:00:00Z'));
    const b = item('https://x/b', D('2026-08-19T00:00:00Z'));
    const c = item('https://x/c', D('2026-08-18T00:00:00Z'));
    const d = item('https://x/d', D('2026-08-21T00:00:00Z'));
    const kept = [
      { url: 'https://x/a', summary: null, why: null, score: 0, isDuplicateOf: null, item: a },
      { url: 'https://x/b', summary: null, why: null, score: 7, isDuplicateOf: null, item: b },
      { url: 'https://x/c', summary: null, why: null, score: 9, isDuplicateOf: null, item: c },
      { url: 'https://x/d', summary: null, why: null, score: 0, isDuplicateOf: null, item: d },
    ];
    const out = rankItems(kept, 3);
    expect(out.map((o) => o.item.url)).toEqual(['https://x/c', 'https://x/b', 'https://x/d']);
  });
});
