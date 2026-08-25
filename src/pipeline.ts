import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SummarizedItem, Summarizer } from './ai/types.js';
import type { Config } from './config.js';
import { renderHtml } from './render/html.js';
import { renderMarkdown, type EditionItem } from './render/markdown.js';
import { buildSources } from './sources/index.js';
import type { RawItem } from './sources/types.js';
import { StateStore, type State } from './state.js';
import { daysAgo, formatDate, toDate } from './util/dates.js';
import { acquireLock } from './util/lock.js';
import { logger } from './util/logger.js';

export interface BuildOptions {
  config: Config;
  /** config file's directory; data/ and editions/ live here */
  rootDir: string;
  summarizer: Summarizer | null;
  /** explicit window start (--days / --since); defaults to since the last run */
  since?: Date;
  maxItems?: number;
  personId?: string;
  dryRun: boolean;
  html: boolean;
}

export interface BuildResult {
  /** raw items received from all sources */
  fetched: number;
  /** items that were new (in window, never seen before) */
  newItems: number;
  /** relative path of the written edition, or null when nothing new */
  editionFile: string | null;
}

// --- pure helpers (unit-tested) -------------------------------------------

/** Window starts at the last run, falling back to lookbackDays ago. */
export function computeWindowStart(state: State, lookbackDays: number): Date {
  const last = state.lastRun ? toDate(state.lastRun) : null;
  return last ?? daysAgo(lookbackDays);
}

/** Keeps items inside the window that were never seen; dedupes in-run URLs. */
export function filterItems(
  raw: RawItem[],
  windowStart: Date,
  seenUrls: ReadonlySet<string>,
): RawItem[] {
  const inRun = new Set<string>();
  const out: RawItem[] = [];
  for (const it of raw) {
    if (it.publishedAt < windowStart) continue;
    if (seenUrls.has(it.url) || inRun.has(it.url)) continue;
    inRun.add(it.url);
    out.push(it);
  }
  out.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  return out;
}

/**
 * Drops items the AI flagged as duplicates of another item in this batch,
 * recording them under the primary so the edition can say "Also covered by".
 */
export function resolveDuplicates(
  items: RawItem[],
  summarized: SummarizedItem[],
): { kept: Array<SummarizedItem & { item: RawItem }>; duplicates: Record<string, { title: string; url: string }[]> } {
  const byUrl = new Map(items.map((i) => [i.url, i]));
  const urlSet = new Set(items.map((i) => i.url));
  const duplicates: Record<string, { title: string; url: string }[]> = {};
  const kept: Array<SummarizedItem & { item: RawItem }> = [];
  for (const s of summarized) {
    const item = byUrl.get(s.url);
    if (!item) continue;
    if (s.isDuplicateOf && s.isDuplicateOf !== s.url && urlSet.has(s.isDuplicateOf)) {
      (duplicates[s.isDuplicateOf] ??= []).push({ title: item.title, url: item.url });
      continue;
    }
    kept.push({ ...s, item });
  }
  return { kept, duplicates };
}

/** Sorts by score (unscored last), then by date, and applies the cap. */
export function rankItems(kept: Array<SummarizedItem & { item: RawItem }>, maxItems: number): EditionItem[] {
  const sorted = [...kept].sort(
    (a, b) => b.score - a.score || b.item.publishedAt.getTime() - a.item.publishedAt.getTime(),
  );
  return sorted.slice(0, maxItems);
}

// --- pipeline --------------------------------------------------------------

export async function runPipeline(opts: BuildOptions): Promise<BuildResult> {
  const store = new StateStore(join(opts.rootDir, 'data', 'state.json'));
  const state = store.load();
  const windowStart = opts.since ?? computeWindowStart(state, opts.config.lookbackDays);

  const people = opts.personId
    ? opts.config.people.filter((p) => p.id === opts.personId)
    : opts.config.people;
  if (people.length === 0) {
    throw new Error(`no person with id '${opts.personId}' in config`);
  }

  // Fetch every source in parallel, isolating failures per source.
  const jobs = people.flatMap((p) => buildSources(p).map((s) => ({ label: `${p.id}/${s.label}`, source: s })));
  const settled = await Promise.allSettled(jobs.map((j) => j.source.fetch()));
  const raw: RawItem[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      raw.push(...r.value);
      logger.debug(`source ${jobs[i]!.label}: ${r.value.length} items`);
    } else {
      logger.warn(`source ${jobs[i]!.label} failed: ${(r.reason as Error)?.message}`);
    }
  });

  const fresh = filterItems(raw, windowStart, new Set(Object.keys(state.seen)));
  if (fresh.length === 0) {
    logger.info(`no new items since ${formatDate(windowStart)} (${raw.length} fetched)`);
    return { fetched: raw.length, newItems: 0, editionFile: null };
  }

  let summarized: SummarizedItem[] = fresh.map((it) => ({
    url: it.url,
    summary: null,
    why: null,
    score: 0,
    isDuplicateOf: null,
  }));
  if (opts.summarizer && !opts.dryRun) {
    try {
      summarized = await opts.summarizer.summarize(fresh);
      logger.info(`summarized ${summarized.length} items (${opts.summarizer.providerName})`);
    } catch (err) {
      logger.warn(`summarization failed (${(err as Error).message}); rendering titles and links only`);
    }
  }

  const { kept, duplicates } = resolveDuplicates(fresh, summarized);
  const cap = opts.maxItems ?? opts.config.maxItemsPerRun;
  const editionItems = rankItems(kept, cap);

  if (opts.dryRun) {
    logger.info(
      `dry run: ${fresh.length} new items since ${formatDate(windowStart)} ` +
        `(${kept.length} after dedupe, ${editionItems.length} after cap ${cap})`,
    );
    for (const it of editionItems) {
      logger.info(`  ${it.score > 0 ? `${it.score}/10` : 'n/a'}  [${it.item.type}] ${it.item.title} — ${it.item.personName}`);
    }
    return { fetched: raw.length, newItems: fresh.length, editionFile: null };
  }

  const release = acquireLock(join(opts.rootDir, 'data', '.lock'));
  try {
    const now = new Date();
    const date = formatDate(now);
    const issue = state.editions.length + 1;
    const markdown = renderMarkdown(opts.config, {
      date: now,
      issue,
      fetched: raw.length,
      items: editionItems,
      duplicates,
      windowStart,
    });

    const editionsDir = join(opts.rootDir, 'editions');
    mkdirSync(editionsDir, { recursive: true });
    const file = join(editionsDir, `${date}.md`);
    writeFileSync(file, markdown);
    if (opts.html) writeFileSync(join(editionsDir, `${date}.html`), renderHtml(markdown));

    // Everything considered this run is marked seen, including capped items,
    // so the next run starts where this one left off.
    for (const it of fresh) state.seen[it.url] = date;
    state.editions.push({ issue, date, file: relative(opts.rootDir, file), items: editionItems.length });
    state.lastRun = now.toISOString();
    store.save(state);

    const dropped = kept.length - editionItems.length;
    logger.info(
      `fetched ${raw.length} · new ${fresh.length} · included ${editionItems.length}` +
        (dropped > 0 ? ` (${dropped} below the cap)` : '') +
        ` → ${relative(opts.rootDir, file)}`,
    );
    return { fetched: raw.length, newItems: fresh.length, editionFile: relative(opts.rootDir, file) };
  } finally {
    release();
  }
}
