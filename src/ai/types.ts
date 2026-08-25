import type { RawItem } from '../sources/types.js';

export interface SummarizedItem {
  url: string;
  /** 2–3 sentence summary; null when the AI was unavailable or skipped the item */
  summary: string | null;
  /** one short "why it matters" line; null when absent */
  why: string | null;
  /** 1–10 relevance score; 0 means "not scored" */
  score: number;
  /** url of another item in the same batch that covers the same story, if any */
  isDuplicateOf: string | null;
}

/**
 * Provider-agnostic summarizer. The pipeline only depends on this interface,
 * so switching LLM providers means a config change or a new implementation,
 * never a pipeline change.
 */
export interface Summarizer {
  readonly providerName: string;
  summarize(items: RawItem[]): Promise<SummarizedItem[]>;
}
