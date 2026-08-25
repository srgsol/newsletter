import type { Person, SourceConfig } from '../config.js';
import { BlogSource } from './blog.js';
import { YoutubeSource } from './youtube.js';
import type { Source } from './types.js';

/** Builds every source defined for a person. */
export function buildSources(person: Person): Source[] {
  return person.sources.map((sc: SourceConfig) => {
    switch (sc.type) {
      case 'blog':
        return new BlogSource(sc.url, person);
      case 'youtube':
        return new YoutubeSource(sc.channelId, person);
    }
  });
}
