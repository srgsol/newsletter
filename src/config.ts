import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

// --- schema ----------------------------------------------------------------

export const BlogSourceSchema = z.object({
  type: z.literal('blog'),
  url: z.string().min(1, 'blog source needs a feed url'),
});

export const YoutubeSourceSchema = z.object({
  type: z.literal('youtube'),
  channelId: z
    .string()
    .regex(/^UC[\w-]{22}$/, 'youtube source needs a channel id (24 chars, UC-prefixed — not a handle)'),
});

export const SourceSchema = z.discriminatedUnion('type', [BlogSourceSchema, YoutubeSourceSchema]);

export const PersonSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'person id must be lowercase alphanumeric with dashes'),
  name: z.string().min(1),
  tags: z.array(z.string()).default([]),
  sources: z.array(SourceSchema).min(1, 'person must have at least one source'),
});

export const ConfigSchema = z.object({
  title: z.string().default('The Watchlist'),
  language: z.string().default('english'),
  provider: z.string().default('deepseek'),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  maxItemsPerRun: z.number().int().positive().default(20),
  lookbackDays: z.number().int().positive().default(7),
  edition: z
    .object({
      groupBy: z.enum(['ranked', 'person', 'type']).default('ranked'),
    })
    .default(() => ({ groupBy: 'ranked' as const })),
  people: z.array(PersonSchema).min(1, 'config must define at least one person'),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Person = z.infer<typeof PersonSchema>;
export type SourceConfig = z.infer<typeof SourceSchema>;

// --- provider registry -----------------------------------------------------

export interface ProviderPreset {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
}

export const PROVIDERS: Record<string, ProviderPreset> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', apiKeyEnv: 'OLLAMA_API_KEY' },
};

// --- load / save -----------------------------------------------------------

export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read config at ${path}: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new Error(`invalid YAML in ${path}: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(data ?? {});
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid config in ${path}:\n${details}`);
  }
  return result.data;
}

export function saveConfig(path: string, config: Config): void {
  writeFileSync(path, stringifyYaml(config));
}

/** Merges a provider preset with any per-config overrides. */
export function resolveProvider(config: Config): ProviderPreset {
  const preset = PROVIDERS[config.provider];
  if (!preset) {
    throw new Error(`unknown provider '${config.provider}' (known: ${Object.keys(PROVIDERS).join(', ')})`);
  }
  return {
    baseUrl: config.baseUrl ?? preset.baseUrl,
    model: config.model ?? preset.model,
    apiKeyEnv: preset.apiKeyEnv,
  };
}

/** Provider-specific env var first, generic LLM_API_KEY as fallback. */
export function getApiKey(envName: string): string | null {
  return process.env[envName] ?? process.env.LLM_API_KEY ?? null;
}
