import { describe, expect, it } from 'vitest';
import { parseFeedXml } from '../src/sources/rss.js';

const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example</title>
  <link href="https://example.com/"/>
  <entry>
    <title>Post One</title>
    <link href="https://example.com/post-1"/>
    <updated>2026-08-20T12:00:00Z</updated>
    <summary>First summary.</summary>
  </entry>
  <entry>
    <title>Post Two</title>
    <link href="https://example.com/post-2"/>
    <updated>2026-08-19T12:00:00Z</updated>
  </entry>
  <entry>
    <title>Post Without a Date</title>
    <link href="https://example.com/post-3"/>
  </entry>
</feed>`;

const YOUTUBE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Channel</title>
    <item>
      <title>Video One</title>
      <link>https://www.youtube.com/watch?v=abc123</link>
      <pubDate>Thu, 20 Aug 2026 12:00:00 GMT</pubDate>
      <media:description>A video description.</media:description>
    </item>
  </channel>
</rss>`;

describe('parseFeedXml', () => {
  it('parses Atom entries into RssItems', async () => {
    const items = await parseFeedXml(ATOM_FEED);
    expect(items).toHaveLength(2); // undated entry skipped
    expect(items[0]).toMatchObject({
      title: 'Post One',
      url: 'https://example.com/post-1',
      description: 'First summary.',
    });
    expect(items[0]!.publishedAt.getTime()).toBe(new Date('2026-08-20T12:00:00Z').getTime());
  });

  it('reads media:description from YouTube-style feeds', async () => {
    const items = await parseFeedXml(YOUTUBE_FEED);
    expect(items).toHaveLength(1);
    expect(items[0]!.description).toBe('A video description.');
    expect(items[0]!.publishedAt.getTime()).toBe(new Date('2026-08-20T12:00:00Z').getTime());
  });
});
