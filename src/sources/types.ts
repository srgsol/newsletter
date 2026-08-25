export type ItemType = 'blog' | 'youtube';

export interface RawItem {
  url: string;
  title: string;
  description: string;
  publishedAt: Date;
  type: ItemType;
  personId: string;
  personName: string;
  personTags: string[];
}

/**
 * A source of items for one person (a blog feed, a YouTube channel, later X or
 * LinkedIn). The pipeline only depends on this interface, so new platforms are
 * added as implementations, never as pipeline changes.
 */
export interface Source {
  readonly label: string;
  fetch(): Promise<RawItem[]>;
}
