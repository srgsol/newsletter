import { afterEach, describe, expect, it, vi } from 'vitest';
import { HtmlSource, parseHtmlItems } from '../src/sources/html.js';

/** Mirrors the markup of https://www.anthropic.com/engineering (Next.js, minified). */
const LISTING = `<!DOCTYPE html><html><head><title>Engineering</title>
<script>const tpl = '<article><a href="/engineering/fake"><h3>Fake post from a script</h3><time datetime="2026-03-03">Mar 03, 2026</time></a></article>';</script>
<style>.ArticleList{color:red}</style></head><body>
<div class="ArticleList-module"><article class="ArticleList-module__article"><a class="cardLink" href="/engineering/demystifying-evals-for-ai-agents"><div class="spotIllo"><img alt="Demystifying evals" loading="lazy" src="/x.svg"/></div><div class="content"><h3 class="headline-4">Demystifying evals for AI agents</h3><div class="date"><time dateTime="2026-01-09">Jan 09, 2026</time></div></div></a></article><article class="ArticleList-module__article"><a class="cardLink" href="/engineering/equipping-agents"><h3 class="headline-4">Equipping agents &amp; skills
  for the real world</h3><time>Jan 21, 2026</time></a></article><article class="ArticleList-module__article"><a href="/engineering/no-date"><h3>Undated post</h3></a></article><article class="ArticleList-module__article"><h3>Post with no link</h3><time datetime="2026-02-02">Feb 02, 2026</time></article><article class="ArticleList-module__article"><a href="#"><h3>Anchor only</h3><time datetime="2026-02-03">Feb 03, 2026</time></a></article></div>
</body></html>`;

const PAGE_URL = 'https://www.anthropic.com/engineering';

const ANTHROPIC_SELECTORS = {
  url: PAGE_URL,
  item: 'article',
  title: 'h3',
  link: 'a',
  date: 'time',
};

/** A listing where every field needs a custom selector, with an excerpt. */
const CUSTOM = `<ul class="posts">
  <li class="entry"><a class="title" href="/posts/hello"><span>A post about
  widgets</span></a><p class="excerpt">Widgets are back.</p><span class="when" data-x="1">2026-04-01</span></li>
  <li class="entry"><a class="title" href="https://other.example/posts/two">Second post</a><p class="excerpt">More widgets.</p><span class="when">2026-03-15</span></li>
</ul>`;

describe('parseHtmlItems', () => {
  it('extracts title, absolute url and date from a listing', () => {
    const items = parseHtmlItems(LISTING, ANTHROPIC_SELECTORS);
    expect(items).toHaveLength(2); // undated, unlinked and anchor-only items are skipped
    expect(items[0]).toMatchObject({
      title: 'Demystifying evals for AI agents',
      url: 'https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents',
    });
    expect(items[0]!.publishedAt.getTime()).toBe(new Date(2026, 0, 9).getTime());
  });

  it('never reads items or titles out of script and style blocks', () => {
    const titles = parseHtmlItems(LISTING, ANTHROPIC_SELECTORS).map((i) => i.title);
    expect(titles).not.toContain('Fake post from a script');
    expect(titles.join(' ')).not.toContain('color:red');
  });

  it('decodes entities and collapses whitespace in titles', () => {
    const second = parseHtmlItems(LISTING, ANTHROPIC_SELECTORS)[1]!;
    expect(second.title).toBe('Equipping agents & skills for the real world');
  });

  it('falls back to the element text when there is no datetime attribute', () => {
    const second = parseHtmlItems(LISTING, ANTHROPIC_SELECTORS)[1]!;
    expect(second.publishedAt.getTime()).toBe(new Date(2026, 0, 21).getTime());
  });

  it('honours custom selectors, descendant combinators and an excerpt selector', () => {
    const items = parseHtmlItems(CUSTOM, {
      url: 'https://example.com/blog/',
      item: 'ul.posts li.entry',
      title: 'a.title',
      link: 'a.title',
      date: '.when',
      description: '.excerpt',
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'A post about widgets',
      url: 'https://example.com/posts/hello',
      description: 'Widgets are back.',
    });
    expect(items[0]!.publishedAt.getTime()).toBe(new Date(2026, 3, 1).getTime());
    expect(items[1]).toMatchObject({ url: 'https://other.example/posts/two', description: 'More widgets.' });
    expect(items[1]!.publishedAt.getTime()).toBe(new Date(2026, 2, 15).getTime());
  });

  it('skips items whose url does not match urlPattern', () => {
    const items = parseHtmlItems(CUSTOM, {
      url: 'https://example.com/blog/',
      item: 'ul.posts li.entry',
      title: 'a.title',
      link: 'a.title',
      date: '.when',
      urlPattern: '^https://example\\.com/',
    });
    expect(items.map((i) => i.url)).toEqual(['https://example.com/posts/hello']);
  });

  it('returns an empty list when the selectors match nothing', () => {
    expect(parseHtmlItems(LISTING, { url: PAGE_URL, item: 'li.nope' })).toEqual([]);
  });

  it('skips a table row with no date rather than inventing one', () => {
    const items = parseHtmlItems(LISTING, { url: PAGE_URL, item: 'article', date: '.missing' });
    expect(items).toEqual([]);
  });
});

describe('HtmlSource', () => {
  const feed = { id: 'anthropic-engineering', name: 'Anthropic Engineering', tags: ['ai'] };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the listing and maps items to RawItems', async () => {
    const fetchMock = vi.fn(async () => new Response(LISTING, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const source = new HtmlSource(ANTHROPIC_SELECTORS, feed);
    const items = await source.fetch();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      url: 'https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents',
      type: 'blog',
      feedId: 'anthropic-engineering',
      feedName: 'Anthropic Engineering',
      feedTags: ['ai'],
      description: '',
    });
    expect(source.label).toBe(`html:${PAGE_URL}`);
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    await expect(new HtmlSource(ANTHROPIC_SELECTORS, feed).fetch()).rejects.toThrow(/HTTP 503/);
  });
});
