import type { Feed, SourceConfig } from '../config.js';
import { BlogSource } from './blog.js';
import { HtmlSource } from './html.js';
import { YoutubeSource } from './youtube.js';
import type { Source } from './types.js';

/** Builds every source defined for a feed. */
export function buildSources(feed: Feed): Source[] {
  return feed.sources.map((sc: SourceConfig) => {
    switch (sc.type) {
      case 'blog':
        return new BlogSource(sc.url, feed);
      case 'youtube':
        return new YoutubeSource(sc.channelId, feed);
      case 'html':
        return new HtmlSource(sc, feed);
    }
  });
}
