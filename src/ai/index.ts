import { getApiKey, resolveProvider, type Config } from '../config.js';
import { logger } from '../util/logger.js';
import { OpenAICompatibleSummarizer } from './openai-compatible.js';
import type { Summarizer } from './types.js';

/**
 * Builds the summarizer for the configured provider, or returns null when no
 * API key is available (the pipeline then renders titles and links only).
 */
export function createSummarizer(config: Config): Summarizer | null {
  const { baseUrl, model, apiKeyEnv } = resolveProvider(config);
  const apiKey = getApiKey(apiKeyEnv) ?? (config.provider === 'ollama' ? 'ollama' : null);
  if (!apiKey) {
    logger.warn(`no API key found (${apiKeyEnv} or LLM_API_KEY); editions will have titles and links only`);
    return null;
  }
  return new OpenAICompatibleSummarizer({ baseUrl, model, apiKey, language: config.language });
}
