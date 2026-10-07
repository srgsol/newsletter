import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema, getApiKey, resolveProvider } from '../src/config.js';

const MINIMAL = {
  people: [{ id: 'simon', name: 'Simon', sources: [{ type: 'blog', url: 'https://example.com/feed.xml' }] }],
};

describe('ConfigSchema', () => {
  it('applies defaults', () => {
    const cfg = ConfigSchema.parse(MINIMAL);
    expect(cfg.title).toBe('The Watchlist');
    expect(cfg.provider).toBe('deepseek');
    expect(cfg.language).toBe('english');
    expect(cfg.maxItemsPerRun).toBe(20);
    expect(cfg.lookbackDays).toBe(7);
    expect(cfg.edition.groupBy).toBe('ranked');
    expect(cfg.people[0]!.tags).toEqual([]);
  });

  it('rejects a config without people', () => {
    expect(ConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a person without sources', () => {
    const r = ConfigSchema.safeParse({ people: [{ id: 'a', name: 'A', sources: [] }] });
    expect(r.success).toBe(false);
  });

  it('rejects a non-UC youtube channel id', () => {
    const r = ConfigSchema.safeParse({
      people: [{ id: 'a', name: 'A', sources: [{ type: 'youtube', channelId: '@somehandle' }] }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts a valid youtube channel id', () => {
    const r = ConfigSchema.safeParse({
      people: [{ id: 'a', name: 'A', sources: [{ type: 'youtube', channelId: `UC${'a'.repeat(22)}` }] }],
    });
    expect(r.success).toBe(true);
  });

  it('defaults the html source selectors', () => {
    const cfg = ConfigSchema.parse({
      people: [
        {
          id: 'anthropic-engineering',
          name: 'Anthropic Engineering',
          sources: [{ type: 'html', url: 'https://www.anthropic.com/engineering', item: 'article' }],
        },
      ],
    });
    expect(cfg.people[0]!.sources[0]).toEqual({
      type: 'html',
      url: 'https://www.anthropic.com/engineering',
      item: 'article',
      title: 'h3',
      link: 'a',
      date: 'time',
    });
  });

  it('accepts a urlPattern on an html source and rejects an invalid regex', () => {
    const ok = ConfigSchema.safeParse({
      people: [
        {
          id: 'a',
          name: 'A',
          sources: [
            { type: 'html', url: 'https://example.com/blog', item: 'article', urlPattern: '^https://example\\.com/' },
          ],
        },
      ],
    });
    expect(ok.success).toBe(true);
    const bad = ConfigSchema.safeParse({
      people: [
        {
          id: 'a',
          name: 'A',
          sources: [{ type: 'html', url: 'https://example.com/blog', item: 'article', urlPattern: '[' }],
        },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects an html source without an item selector or a valid url', () => {
    const noItem = ConfigSchema.safeParse({
      people: [{ id: 'a', name: 'A', sources: [{ type: 'html', url: 'https://example.com/blog' }] }],
    });
    expect(noItem.success).toBe(false);
    const badUrl = ConfigSchema.safeParse({
      people: [{ id: 'a', name: 'A', sources: [{ type: 'html', url: 'not-a-url', item: 'article' }] }],
    });
    expect(badUrl.success).toBe(false);
  });
});

describe('resolveProvider', () => {
  it('returns deepseek defaults', () => {
    const cfg = ConfigSchema.parse(MINIMAL);
    expect(resolveProvider(cfg)).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    });
  });

  it('allows per-config overrides', () => {
    const cfg = ConfigSchema.parse({ ...MINIMAL, baseUrl: 'https://x.example/v1', model: 'custom-model' });
    expect(resolveProvider(cfg)).toMatchObject({ baseUrl: 'https://x.example/v1', model: 'custom-model' });
  });

  it('rejects unknown providers', () => {
    const cfg = ConfigSchema.parse({ ...MINIMAL, provider: 'nope' });
    expect(() => resolveProvider(cfg)).toThrow(/unknown provider/);
  });
});

describe('getApiKey', () => {
  afterEach(() => {
    delete process.env.LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('prefers the provider-specific variable', () => {
    process.env.OPENAI_API_KEY = 'specific';
    expect(getApiKey('OPENAI_API_KEY')).toBe('specific');
  });

  it('falls back to LLM_API_KEY', () => {
    process.env.LLM_API_KEY = 'generic';
    expect(getApiKey('OPENAI_API_KEY')).toBe('generic');
  });

  it('returns null when nothing is set', () => {
    expect(getApiKey('OPENAI_API_KEY')).toBeNull();
  });
});
