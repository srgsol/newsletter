import type { Config } from '../config.js';
import type { RawItem } from '../sources/types.js';
import { formatDate } from '../util/dates.js';

export interface EditionItem {
  item: RawItem;
  summary: string | null;
  why: string | null;
  score: number;
}

export interface RenderInput {
  date: Date;
  issue: number;
  /** raw items received from all sources this run (before filtering) */
  fetched: number;
  /** items to include, already deduped, ranked, and capped */
  items: EditionItem[];
  /** primary url -> items that duplicate it (shown as "Also covered by") */
  duplicates: Record<string, { title: string; url: string }[]>;
  windowStart: Date;
}

export function renderMarkdown(cfg: Config, r: RenderInput): string {
  const lines: string[] = [];
  lines.push(`# ${cfg.title} — Issue #${r.issue}`, '');
  lines.push(
    `**${formatDate(r.date)}** · ${r.items.length} new item${s(r.items.length)} · ` +
      `${r.fetched} fetched since ${formatDate(r.windowStart)}`,
  );

  const groups = groupItems(cfg.edition.groupBy, r.items);
  for (const group of groups) {
    if (cfg.edition.groupBy !== 'ranked') {
      lines.push('', `## ${group.heading}`);
    }
    group.items.forEach((it, i) => {
      lines.push('', ...renderItem(it, i + 1, r.duplicates));
    });
  }
  lines.push('');
  return lines.join('\n');
}

// --- grouping --------------------------------------------------------------

interface Group {
  heading: string;
  items: EditionItem[];
}

function groupItems(groupBy: 'ranked' | 'person' | 'type', items: EditionItem[]): Group[] {
  if (groupBy === 'ranked') {
    return [{ heading: '', items }];
  }
  if (groupBy === 'person') {
    const order: string[] = [];
    const byPerson = new Map<string, EditionItem[]>();
    for (const it of items) {
      if (!byPerson.has(it.item.personName)) {
        byPerson.set(it.item.personName, []);
        order.push(it.item.personName);
      }
      byPerson.get(it.item.personName)!.push(it);
    }
    return order.map((name) => ({ heading: name, items: byPerson.get(name)! }));
  }
  // type
  return (['youtube', 'blog'] as const)
    .map((type) => ({
      heading: type === 'youtube' ? 'YouTube' : 'Blog',
      items: items.filter((it) => it.item.type === type),
    }))
    .filter((g) => g.items.length > 0);
}

// --- item rendering --------------------------------------------------------

function renderItem(
  it: EditionItem,
  rank: number,
  duplicates: Record<string, { title: string; url: string }[]>,
): string[] {
  const badge = it.item.type === 'youtube' ? 'YouTube' : 'Blog';
  const lines = [
    `### ${rank}. [${esc(it.item.title)}](${it.item.url})`,
    `\`[${badge}]\` · ${esc(it.item.personName)} · ${formatDate(it.item.publishedAt)}`,
  ];
  if (it.summary) lines.push('', it.summary);
  if (it.why) lines.push('', `*Why it matters:* ${it.why}`);
  const dups = duplicates[it.item.url];
  if (dups && dups.length > 0) {
    lines.push('', `*Also covered by:* ${dups.map((d) => `[${esc(d.title)}](${d.url})`).join(' · ')}`);
  }
  return lines;
}

function esc(s: string): string {
  return s.replace(/([\\[\]*_`|])/g, '\\$1');
}

function s(n: number): string {
  return n === 1 ? '' : 's';
}
