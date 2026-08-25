import { fetchFeed } from './rss.js';
import type { RawItem, Source } from './types.js';

/** Builds the per-channel RSS feed URL (no API key needed). */
export function youtubeFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

/** True for a 24-char UC-prefixed channel id. */
export function isChannelId(v: string): boolean {
  return /^UC[\w-]{22}$/.test(v);
}

export class YoutubeSource implements Source {
  constructor(
    private readonly channelId: string,
    private readonly person: { id: string; name: string; tags: string[] },
  ) {}

  get label(): string {
    return `youtube:${this.channelId}`;
  }

  async fetch(): Promise<RawItem[]> {
    const items = await fetchFeed(youtubeFeedUrl(this.channelId));
    return items.map((it) => ({
      url: it.url,
      title: it.title,
      description: it.description,
      publishedAt: it.publishedAt,
      type: 'youtube' as const,
      personId: this.person.id,
      personName: this.person.name,
      personTags: this.person.tags,
    }));
  }
}
