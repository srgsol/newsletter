#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { createSummarizer } from './ai/index.js';
import { loadConfig, saveConfig, type Config } from './config.js';
import { runPipeline } from './pipeline.js';
import { fetchFeed } from './sources/rss.js';
import { isChannelId, youtubeFeedUrl } from './sources/youtube.js';
import { daysAgo, formatDate, toDate } from './util/dates.js';
import { logger, setVerbose } from './util/logger.js';

const program = new Command();

program
  .name('newsletter')
  .description('Personal newsletter: fetch RSS activity, summarize with an LLM, render a Markdown edition')
  .version('0.1.0')
  .option('-c, --config <path>', 'path to config.yaml', 'config.yaml')
  .option('--verbose', 'verbose logging');

// --- init ------------------------------------------------------------------

const INIT_TEMPLATE = `# Personal newsletter configuration — see README.md
# Replace the example person below with the people you follow.
#   • blog: the site's RSS/Atom feed url
#   • youtube: the 24-char channel id (starts with UC). Find it with:
#       newsletter resolve-channel @handle

title: The Watchlist
language: english

# LLM provider: deepseek | openai | ollama (see README for api keys)
provider: deepseek
# model: deepseek-chat               # optional override of the provider default
# baseUrl: https://api.deepseek.com  # optional override of the endpoint

maxItemsPerRun: 20
lookbackDays: 7
edition:
  groupBy: ranked                    # ranked | person | type

people:
  - id: example
    name: Example Person
    tags: [ai, web]                  # used by the LLM for relevance
    sources:
      - type: blog
        url: https://example.com/feed.xml
      # - type: youtube
      #   channelId: UCXXXXXXXXXXXXXXXXXXXXXX
`;

program
  .command('init')
  .description('create a starter config.yaml (does not overwrite)')
  .action(() => {
    const configPath = resolve((program.opts() as { config: string }).config);
    if (existsSync(configPath)) {
      throw new Error(`${configPath} already exists — not overwriting`);
    }
    writeFileSync(configPath, INIT_TEMPLATE);
    logger.info(`wrote ${configPath}`);
    logger.info('next: edit it with your people, copy .env.example to .env, then run `newsletter build`');
  });

// --- build -----------------------------------------------------------------

interface BuildFlags {
  days?: string;
  since?: string;
  maxItems?: string;
  person?: string;
  dryRun?: boolean;
  skipAi?: boolean;
  provider?: string;
  html?: boolean;
}

program
  .command('build')
  .description('fetch sources, summarize with the LLM, and write today\'s edition')
  .option('--days <n>', 'look back n days instead of since the last run')
  .option('--since <iso-date>', 'only include items published on/after this date')
  .option('--max-items <n>', 'cap the edition size (default: config maxItemsPerRun)')
  .option('--person <id>', 'only fetch this person (config id)')
  .option('--dry-run', 'fetch and report without AI, writes, or state changes')
  .option('--skip-ai', 'build the edition with titles and links only')
  .option('--provider <id>', 'override the provider for this run (deepseek | openai | ollama)')
  .option('--html', 'also write an HTML version of the edition')
  .action(async (flags: BuildFlags) => {
    const globals = program.opts() as { config: string; verbose?: boolean };
    setVerbose(!!globals.verbose);
    const configPath = resolve(globals.config);
    const rootDir = dirname(configPath);
    try {
      process.loadEnvFile(resolve(rootDir, '.env'));
    } catch {
      /* no .env — runs still work, just without AI summaries */
    }

    const cfg = loadConfig(configPath);
    const effective: Config = flags.provider ? { ...cfg, provider: flags.provider } : cfg;

    let since: Date | undefined;
    if (flags.days !== undefined) {
      const n = Number(flags.days);
      if (!Number.isInteger(n) || n <= 0) throw new Error('--days must be a positive integer');
      since = daysAgo(n);
    } else if (flags.since) {
      const d = toDate(flags.since);
      if (!d) throw new Error(`--since is not a parseable date: ${flags.since}`);
      since = d;
    }

    let maxItems: number | undefined;
    if (flags.maxItems !== undefined) {
      maxItems = Number(flags.maxItems);
      if (!Number.isInteger(maxItems) || maxItems <= 0) throw new Error('--max-items must be a positive integer');
    }

    const summarizer = flags.skipAi || flags.dryRun ? null : createSummarizer(effective);
    const result = await runPipeline({
      config: effective,
      rootDir,
      summarizer,
      since,
      maxItems,
      personId: flags.person,
      dryRun: !!flags.dryRun,
      html: !!flags.html,
    });
    if (result.editionFile) logger.info(`wrote ${result.editionFile}`);
  });

// --- people ----------------------------------------------------------------

const people = program.command('people').description('manage the people in the config');

people
  .command('list')
  .description('list the people in the config')
  .action(() => {
    const globals = program.opts() as { config: string; verbose?: boolean };
    setVerbose(!!globals.verbose);
    const cfg = loadConfig(resolve(globals.config));
    for (const p of cfg.people) {
      const sources = p.sources.map((s) => (s.type === 'blog' ? 'blog' : `youtube ${s.channelId.slice(0, 10)}…`));
      logger.info(`${p.id}  ${p.name}  (${sources.join(', ')})`);
    }
  });

people
  .command('add')
  .description('add a person to the config')
  .requiredOption('--id <id>', 'lowercase id (e.g. simon)')
  .requiredOption('--name <name>', 'display name')
  .option('--blog <url>', 'RSS/Atom feed url')
  .option('--youtube <channelId>', 'YouTube channel id (UC..., use `newsletter resolve-channel`)')
  .action((flags: { id: string; name: string; blog?: string; youtube?: string }) => {
    const globals = program.opts() as { config: string; verbose?: boolean };
    setVerbose(!!globals.verbose);
    const configPath = resolve(globals.config);
    const cfg = loadConfig(configPath);
    if (cfg.people.some((p) => p.id === flags.id)) {
      throw new Error(`a person with id '${flags.id}' already exists`);
    }
    if (!flags.blog && !flags.youtube) {
      throw new Error('provide at least one of --blog or --youtube');
    }
    if (flags.youtube && !isChannelId(flags.youtube)) {
      throw new Error(`'${flags.youtube}' is not a valid channel id — find it with \`newsletter resolve-channel @handle\``);
    }
    const sources: Config['people'][number]['sources'] = [];
    if (flags.blog) sources.push({ type: 'blog', url: flags.blog });
    if (flags.youtube) sources.push({ type: 'youtube', channelId: flags.youtube });
    cfg.people.push({ id: flags.id, name: flags.name, tags: [], sources });
    saveConfig(configPath, cfg);
    logger.info(`added '${flags.id}' (${flags.name}) to ${configPath}`);
  });

people
  .command('edit')
  .description('open the config in $EDITOR')
  .action(() => {
    const globals = program.opts() as { config: string; verbose?: boolean };
    setVerbose(!!globals.verbose);
    const configPath = resolve(globals.config);
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
    const result = spawnSync(editor, [configPath], { stdio: 'inherit', shell: true });
    if (result.status !== 0) {
      throw new Error(`${editor} exited with status ${result.status}`);
    }
  });

// --- debugging helpers -----------------------------------------------------

program
  .command('feed-check <feed>')
  .description('fetch a feed url or YouTube channel id and list its latest items')
  .option('-n, --limit <n>', 'items to show', '10')
  .action(async (feed: string, flags: { limit: string }) => {
    const url = isChannelId(feed) ? youtubeFeedUrl(feed) : feed;
    logger.info(`checking ${url}`);
    const items = await fetchFeed(url);
    const limit = Math.max(1, Number(flags.limit) || 10);
    logger.info(`${items.length} items in the feed, showing the ${Math.min(limit, items.length)} latest:`);
    for (const it of items.slice(0, limit)) {
      console.log(`  ${formatDate(it.publishedAt)}  ${it.title}`);
      console.log(`    ${it.url}`);
    }
  });

const CHANNEL_PATTERNS = [
  /"externalId":"(UC[\w-]{22})"/,
  /"channelId":"(UC[\w-]{22})"/,
  /<meta itemprop="channelId" content="(UC[\w-]{22})">/,
  /<meta itemprop="identifier" content="(UC[\w-]{22})">/,
  /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})">/,
];

async function resolveChannelId(input: string): Promise<string | null> {
  if (isChannelId(input)) return input;
  if (input.includes('/channel/')) {
    const m = input.match(/UC[\w-]{22}/);
    if (m) return m[0];
  }
  let url = input.startsWith('@') ? `https://www.youtube.com/${input}` : input;
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  logger.info(`fetching ${url}`);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const html = await res.text();
  for (const pattern of CHANNEL_PATTERNS) {
    const m = html.match(pattern);
    if (m) return m[1];
  }
  return null;
}

program
  .command('resolve-channel <handleOrUrl>')
  .description('resolve a YouTube handle or channel/video url to a channel id')
  .action(async (input: string) => {
    const channelId = await resolveChannelId(input);
    if (!channelId) {
      throw new Error(
        `couldn't find a channel id on that page (YouTube may have changed its markup). ` +
          `Try a channel url like https://www.youtube.com/channel/UC... instead.`,
      );
    }
    console.log(channelId);
    console.log(`feed: ${youtubeFeedUrl(channelId)}`);
  });

// --- entry -----------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    logger.error((err as Error).message);
    process.exitCode = 1;
  }
}

main();
