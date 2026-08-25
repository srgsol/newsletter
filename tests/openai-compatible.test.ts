import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mergeResults,
  OpenAICompatibleSummarizer,
  parseAiResponse,
} from '../src/ai/openai-compatible.js';
import type { RawItem } from '../src/sources/types.js';

const item = (url: string): RawItem => ({
  url,
  title: `title ${url}`,
  description: 'some description',
  publishedAt: new Date('2026-08-20T12:00:00Z'),
  type: 'blog',
  personId: 'p',
  personName: 'Person',
  personTags: ['ai'],
});

const jsonResponse = (content: unknown, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseAiResponse', () => {
  it('parses a plain JSON object response', () => {
    const out = parseAiResponse('{"items":[{"url":"https://x","summary":"s","why":"w","score":9,"isDuplicateOf":null}]}');
    expect(out).toEqual([{ url: 'https://x', summary: 's', why: 'w', score: 9, isDuplicateOf: null }]);
  });

  it('strips markdown fences', () => {
    const out = parseAiResponse('```json\n{"items":[{"url":"https://x","score":"8"}]}\n```');
    expect(out[0]).toMatchObject({ url: 'https://x', score: 8 });
  });

  it('clamps scores to 1–10 and defaults garbage to 5', () => {
    const out = parseAiResponse('{"items":[{"url":"a","score":99},{"url":"b","score":"wat"}]}');
    expect(out[0]!.score).toBe(10);
    expect(out[1]!.score).toBe(5);
  });

  it('throws on invalid JSON and on missing items array', () => {
    expect(() => parseAiResponse('not json')).toThrow(/not valid JSON/);
    expect(() => parseAiResponse('{"other":[]}')).toThrow(/missing the "items" array/);
  });
});

describe('mergeResults', () => {
  it('maps parsed items back onto input items and fills gaps with nulls', () => {
    const merged = mergeResults(
      [item('https://x/a'), item('https://x/b')],
      [{ url: 'https://x/a', summary: 'S', why: 'W', score: 7, isDuplicateOf: null }],
    );
    expect(merged).toEqual([
      { url: 'https://x/a', summary: 'S', why: 'W', score: 7, isDuplicateOf: null },
      { url: 'https://x/b', summary: null, why: null, score: 0, isDuplicateOf: null },
    ]);
  });
});

describe('OpenAICompatibleSummarizer', () => {
  const make = () =>
    new OpenAICompatibleSummarizer({
      baseUrl: 'https://api.example.com/v1/',
      model: 'test-model',
      apiKey: 'k',
      language: 'english',
    });

  it('posts a chat completion and maps the result', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        jsonResponse({
          items: [
            { url: 'https://x/a', summary: 'Sum A', why: 'Why A', score: 8, isDuplicateOf: null },
            { url: 'https://x/b', summary: 'Sum B', why: null, score: 4, isDuplicateOf: 'https://x/a' },
          ],
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await make().summarize([item('https://x/a'), item('https://x/b')]);

    expect(out).toEqual([
      { url: 'https://x/a', summary: 'Sum A', why: 'Why A', score: 8, isDuplicateOf: null },
      { url: 'https://x/b', summary: 'Sum B', why: null, score: 4, isDuplicateOf: 'https://x/a' },
    ]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe('test-model');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('does not retry non-retryable HTTP errors', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'bad key' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(make().summarize([item('https://x/a')])).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries transient errors and succeeds on a later attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'overloaded' }, 500))
      .mockResolvedValueOnce(jsonResponse({ items: [{ url: 'https://x/a', summary: 'S', score: 6 }] }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await make().summarize([item('https://x/a')]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out[0]!.summary).toBe('S');
  });
});
