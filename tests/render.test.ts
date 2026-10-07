import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import { renderMarkdown, type RenderInput } from '../src/render/markdown.js';

const cfg = ConfigSchema.parse({
  title: 'The Watchlist',
  feeds: [{ id: 'alice', name: 'Alice', sources: [{ type: 'blog', url: 'https://example.com/feed' }] }],
});

const baseInput: RenderInput = {
  date: new Date(2026, 7, 21, 9, 0, 0),
  issue: 3,
  fetched: 34,
  items: [
    {
      item: {
        url: 'https://example.com/a',
        title: 'Post A',
        description: '',
        publishedAt: new Date(2026, 7, 20, 12, 0, 0),
        type: 'blog',
        feedId: 'alice',
        feedName: 'Alice',
        feedTags: [],
      },
      summary: 'Summary of A.',
      why: 'because A.',
      score: 9,
    },
    {
      item: {
        url: 'https://youtube.com/b',
        title: 'Video B',
        description: '',
        publishedAt: new Date(2026, 7, 19, 12, 0, 0),
        type: 'youtube',
        feedId: 'bob',
        feedName: 'Bob',
        feedTags: [],
      },
      summary: null,
      why: null,
      score: 0,
    },
  ],
  duplicates: {
    'https://youtube.com/b': [{ title: 'Video B (mirror)', url: 'https://youtube.com/b2' }],
  },
  windowStart: new Date(2026, 7, 14, 9, 0, 0),
};

describe('renderMarkdown', () => {
  it('renders the ranked edition layout', () => {
    expect(renderMarkdown(cfg, baseInput)).toBe(
      [
        '# The Watchlist — Issue #3',
        '',
        '**2026-08-21** · 2 new items · 34 fetched since 2026-08-14',
        '',
        '### 1. [Post A](https://example.com/a)',
        '`[Blog]` · Alice · 2026-08-20',
        '',
        'Summary of A.',
        '',
        '*Why it matters:* because A.',
        '',
        '### 2. [Video B](https://youtube.com/b)',
        '`[YouTube]` · Bob · 2026-08-19',
        '',
        '*Also covered by:* [Video B (mirror)](https://youtube.com/b2)',
        '',
      ].join('\n'),
    );
  });

  it('groups by feed when configured', () => {
    const byFeed = ConfigSchema.parse({ ...cfg, edition: { groupBy: 'feed' } });
    const md = renderMarkdown(byFeed, baseInput);
    expect(md).toContain('## Alice');
    expect(md).toContain('## Bob');
    // numbering restarts per section: both sections start at 1
    expect(md.match(/### 1\./g)).toHaveLength(2);
    expect(md).toContain('### 1. [Post A](https://example.com/a)');
  });

  it('groups by type when configured', () => {
    const byType = ConfigSchema.parse({ ...cfg, edition: { groupBy: 'type' } });
    const md = renderMarkdown(byType, baseInput);
    const blogSection = md.indexOf('## Blog');
    const youtubeSection = md.indexOf('## YouTube');
    expect(blogSection).toBeGreaterThan(-1);
    expect(youtubeSection).toBeGreaterThan(-1);
    expect(youtubeSection).toBeLessThan(blogSection); // YouTube section first
  });

  it('escapes markdown metacharacters in titles', () => {
    const input: RenderInput = {
      ...baseInput,
      items: [
        {
          ...baseInput.items[0]!,
          item: { ...baseInput.items[0]!.item, title: 'Post [with] *markup*' },
        },
      ],
    };
    const md = renderMarkdown(cfg, input);
    expect(md).toContain('### 1. [Post \\[with\\] \\*markup\\*](https://example.com/a)');
  });
});
