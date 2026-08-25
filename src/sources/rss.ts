import Parser from 'rss-parser';
import { toDate } from '../util/dates.js';
import { logger } from '../util/logger.js';

export interface RssItem {
  title: string;
  url: string;
  description: string;
  publishedAt: Date;
}

/** Extra fields we ask rss-parser to extract (YouTube's media:description). */
interface CustomItemFields {
  mediaDescription?: string;
}

const parser = new Parser<Record<string, unknown>, CustomItemFields>({
  customFields: {
    item: [['media:description', 'mediaDescription']],
  },
});

const USER_AGENT = 'personal-newsletter/1.0 (+local automation)';

/** Parses feed XML (Atom or RSS 2.0). Exported separately for tests. */
export async function parseFeedXml(xml: string): Promise<RssItem[]> {
  const feed = await parser.parseString(xml);
  const items: RssItem[] = [];
  for (const it of feed.items ?? []) {
    const publishedAt = toDate(it.isoDate ?? it.pubDate ?? null);
    if (!publishedAt) {
      logger.debug(`skipping feed item without a parseable date: ${String(it.title ?? it.link ?? '')}`);
      continue;
    }
    const url = String(it.link ?? it.guid ?? '').trim();
    if (!url) continue;
    items.push({
      title: String(it.title ?? '(untitled)').trim(),
      url,
      description: String(it.mediaDescription ?? it.contentSnippet ?? it.summary ?? it.content ?? '')
        .trim()
        .replace(/\s+/g, ' '),
      publishedAt,
    });
  }
  return items;
}

/** Fetches and parses a feed over HTTP(S), with a timeout and a sane UA. */
export async function fetchFeed(feedUrl: string): Promise<RssItem[]> {
  const res = await fetch(feedUrl, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${feedUrl}`);
  return parseFeedXml(await res.text());
}
