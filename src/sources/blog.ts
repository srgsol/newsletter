import { fetchFeed } from './rss.js';
import type { RawItem, Source } from './types.js';

export class BlogSource implements Source {
  constructor(
    private readonly feedUrl: string,
    private readonly feed: { id: string; name: string; tags: string[] },
  ) {}

  get label(): string {
    return `blog:${this.feedUrl}`;
  }

  async fetch(): Promise<RawItem[]> {
    const items = await fetchFeed(this.feedUrl);
    return items.map((it) => ({
      url: it.url,
      title: it.title,
      description: it.description,
      publishedAt: it.publishedAt,
      type: 'blog' as const,
      feedId: this.feed.id,
      feedName: this.feed.name,
      feedTags: this.feed.tags,
    }));
  }
}
