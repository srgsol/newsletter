import type { RawItem } from '../sources/types.js';
import { logger } from '../util/logger.js';
import type { SummarizedItem, Summarizer } from './types.js';

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  language: string;
  batchSize?: number;
}

interface AiItem {
  url: string;
  summary: string | null;
  why: string | null;
  score: number;
  isDuplicateOf: string | null;
}

const MAX_DESC_CHARS = 1500;
const DEFAULT_BATCH_SIZE = 25;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Talks to any OpenAI-compatible /chat/completions endpoint (DeepSeek, OpenAI,
 * Ollama, local proxies). Returns JSON, retries transient failures, and maps
 * the response back onto the input items.
 */
export class OpenAICompatibleSummarizer implements Summarizer {
  constructor(private readonly opts: OpenAiCompatibleOptions) {}

  get providerName(): string {
    return `${this.opts.model} @ ${this.opts.baseUrl}`;
  }

  async summarize(items: RawItem[]): Promise<SummarizedItem[]> {
    const batchSize = this.opts.batchSize ?? DEFAULT_BATCH_SIZE;
    const out: SummarizedItem[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      out.push(...(await this.summarizeBatch(items.slice(i, i + batchSize))));
    }
    return out;
  }

  private async summarizeBatch(items: RawItem[]): Promise<SummarizedItem[]> {
    const payload = items.map((it) => ({
      url: it.url,
      type: it.type,
      feed: it.feedName,
      tags: it.feedTags,
      publishedAt: it.publishedAt.toISOString().slice(0, 10),
      title: it.title,
      description: it.description.slice(0, MAX_DESC_CHARS),
    }));

    const raw = await this.postWithRetry({
      model: this.opts.model,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt(this.opts.language) },
        { role: 'user', content: JSON.stringify({ items: payload }) },
      ],
    });
    return mergeResults(items, parseAiResponse(raw));
  }

  private async postWithRetry(body: unknown): Promise<string> {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) {
        await sleep(1000 * 2 ** (attempt - 2));
      }
      try {
        return await this.post(body);
      } catch (err) {
        const e = err as Error & { retryable?: boolean };
        if (!e.retryable) throw e;
        lastErr = e;
        logger.warn(`LLM request failed (attempt ${attempt}/3): ${e.message}`);
      }
    }
    throw lastErr ?? new Error('LLM request failed');
  }

  private async post(body: unknown): Promise<string> {
    const endpoint = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      throw Object.assign(new Error(`LLM network error: ${(err as Error).message}`), { retryable: true });
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw Object.assign(new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`), {
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('LLM returned a non-JSON response');
    }
    const content = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message
      ?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('LLM returned an empty response');
    }
    return content;
  }
}

/** Strips markdown fences and parses the `{"items": [...]}` response. */
export function parseAiResponse(raw: string): AiItem[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error('LLM response was not valid JSON');
  }
  const arr = (data as { items?: unknown })?.items;
  if (!Array.isArray(arr)) {
    throw new Error('LLM response is missing the "items" array');
  }
  return arr.map((x) => {
    const o = x as Record<string, unknown>;
    return {
      url: typeof o.url === 'string' ? o.url : '',
      summary: typeof o.summary === 'string' && o.summary.trim() ? o.summary.trim() : null,
      why: typeof o.why === 'string' && o.why.trim() ? o.why.trim() : null,
      score: clampScore(o.score),
      isDuplicateOf: typeof o.isDuplicateOf === 'string' && o.isDuplicateOf ? o.isDuplicateOf : null,
    };
  });
}

function clampScore(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(1, Math.round(n)));
}

/** Matches LLM results back to input items; items the LLM skipped get nulls. */
export function mergeResults(items: RawItem[], parsed: AiItem[]): SummarizedItem[] {
  const byUrl = new Map(parsed.map((p) => [p.url, p]));
  return items.map((it) => {
    const p = byUrl.get(it.url);
    if (p) return p;
    return { url: it.url, summary: null, why: null, score: 0, isDuplicateOf: null };
  });
}

function systemPrompt(language: string): string {
  return [
    'You are the curation assistant for a personal newsletter that tracks the recent activity of the people, blogs and publications the reader follows.',
    `Respond ONLY with a JSON object, written in ${language}.`,
    'You receive a JSON array of items, each from a blog, a YouTube channel or a listing page, with a title, a short description, the feed it came from, and that feed\'s topic tags.',
    'For EVERY item, return an object with these fields:',
    '- "url": the exact url of the item, unchanged',
    `- "summary": a 2-3 sentence summary of the item, in ${language}, factual and neutral, based only on title and description`,
    `- "why": one short sentence in ${language} on why this item might matter to someone following this feed, informed by its tags`,
    '- "score": an integer from 1 to 10 rating how notable or interesting the item is',
    '- "isDuplicateOf": null, or the url of ANOTHER item in this batch that covers the same news or story (cross-posts, video + blog post about the same thing). Prefer keeping the more detailed item and pointing the other at it. Only mark near-identical coverage.',
    'The response must be exactly: {"items": [ ... one object per input item, in the same order ... ]}',
  ].join('\n');
}
