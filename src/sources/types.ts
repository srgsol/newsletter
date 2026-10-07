export type ItemType = 'blog' | 'youtube';

export interface RawItem {
  url: string;
  title: string;
  description: string;
  publishedAt: Date;
  type: ItemType;
  feedId: string;
  feedName: string;
  feedTags: string[];
}

/**
 * A source of items for one feed (a blog feed, a YouTube channel, later X or
 * LinkedIn). The pipeline only depends on this interface, so new platforms are
 * added as implementations, never as pipeline changes.
 */
export interface Source {
  readonly label: string;
  fetch(): Promise<RawItem[]>;
}
