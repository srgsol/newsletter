/**
 * Newsletter extension — exposes the personal-newsletter app to a pi agent.
 *
 * Registers custom tools the LLM can call:
 *   newsletter_build            build an edition (real run or dry run)
 *   newsletter_feed_check       list recent items from a feed / YouTube channel
 *   newsletter_resolve_channel  resolve a YouTube handle/url to a channel id
 *   newsletter_feeds            list or add feeds in config.yaml
 *   newsletter_status           show run history and config overview
 *
 * Plus a `/newsletter` command for an interactive dry run.
 *
 * Design notes:
 *  - Tools import the app's compiled ESM modules directly from `dist/`
 *    (rebuilt on demand when missing or stale), so they share the app's own
 *    lock, state tracking, config validation, and logging.
 *  - The extension is project-local (`.pi/extensions/`), so the project root
 *    is resolved from `ctx.cwd` (falling back to the extension's own path).
 *  - Env vars are loaded from `.env` the same way `cli.ts` does.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";

// .pi/extensions/ → project root (fallback when ctx.cwd isn't the project dir)
const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Minimal shapes of the app's pipeline/state results (dist has no .d.ts).
interface BuildResult {
  fetched: number;
  newItems: number;
  editionFile: string | null;
}

interface FeedItem {
  title: string;
  url: string;
  publishedAt: Date;
}

// --- helpers ---------------------------------------------------------------

function getProjectRoot(ctx: ExtensionContext): string {
  return existsSync(join(ctx.cwd, "config.yaml")) ? ctx.cwd : EXT_ROOT;
}

/** Newest mtime of any file under src/ — used to detect stale builds. */
function latestSrcMtime(root: string): number {
  const srcDir = join(root, "src");
  if (!existsSync(srcDir)) return 0;
  let latest = 0;
  for (const entry of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
    const full = join(srcDir, entry);
    try {
      const st = statSync(full);
      if (st.isFile()) latest = Math.max(latest, st.mtimeMs);
    } catch {
      /* unreadable entries are skipped */
    }
  }
  return latest;
}

/** Runs `npm run build` when dist/ is missing or older than src/. */
async function ensureBuilt(root: string, pi: ExtensionAPI): Promise<void> {
  const distEntry = join(root, "dist", "pipeline.js");
  const needsBuild = !existsSync(distEntry) || statSync(distEntry).mtimeMs < latestSrcMtime(root);
  if (!needsBuild) return;
  const res = await pi.exec("npm", ["run", "build", "--silent"], { cwd: root, timeout: 180_000 });
  if (res.code !== 0) throw new Error(`npm run build failed:\n${res.stderr || res.stdout}`);
}

/** Dynamic import of a compiled app module (path relative to dist/). */
async function importDist(root: string, pi: ExtensionAPI, rel: string): Promise<any> {
  await ensureBuilt(root, pi);
  return import(pathToFileURL(join(root, "dist", rel)).href) as Promise<Record<string, any>>;
}

/** Loads .env into process.env, same as cli.ts. No-op when missing. */
function loadEnv(root: string): void {
  const envPath = join(root, ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

/** Races a promise against the agent's abort signal. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(new Error("cancelled by user"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** One-line description of a source, for the feeds list. */
function describeSource(s: any): string {
  switch (s.type) {
    case "blog":
      return `blog ${s.url}`;
    case "youtube":
      return `youtube ${s.channelId}`;
    case "html":
      return `html ${s.url} (${s.item})`;
    default:
      return String(s.type);
  }
}

// --- tools -----------------------------------------------------------------

export default function newsletterExtension(pi: ExtensionAPI) {
  // newsletter_build ---------------------------------------------------------
  pi.registerTool({
    name: "newsletter_build",
    label: "Newsletter Build",
    description:
      "Fetch the configured sources (RSS/Atom, YouTube, HTML listings), summarize with the configured " +
      "LLM, and write today's Markdown edition into editions/. With dryRun it only reports counts (no AI, no " +
      "writes, no state changes). skipAi writes a titles-and-links-only edition. Use days/since " +
      "to override the look-back window.",
    promptSnippet: "Build a newsletter edition from the configured sources",
    promptGuidelines: [
      "Use newsletter_build when the user asks to generate or refresh the newsletter edition.",
      "Use newsletter_build with dryRun first when the user wants to preview what is new.",
    ],
    parameters: Type.Object({
      days: Type.Optional(Type.Number({ description: "look back n days instead of since the last run" })),
      since: Type.Optional(Type.String({ description: "only items published on/after this ISO date" })),
      maxItems: Type.Optional(Type.Number({ description: "cap the edition size (default: config maxItemsPerRun)" })),
      feed: Type.Optional(Type.String({ description: "only this feed (config id)" })),
      dryRun: Type.Optional(Type.Boolean({ description: "report only: no AI, no writes, no state changes" })),
      skipAi: Type.Optional(Type.Boolean({ description: "skip LLM summaries (titles and links only)" })),
      html: Type.Optional(Type.Boolean({ description: "also write an HTML version of the edition" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const root = getProjectRoot(ctx);
      onUpdate?.({ content: [{ type: "text", text: "Building newsletter edition…" }], details: {} });

      const [{ runPipeline }, { loadConfig }, { createSummarizer }, { daysAgo, toDate }] = await Promise.all([
        importDist(root, pi, "pipeline.js"),
        importDist(root, pi, "config.js"),
        importDist(root, pi, "ai/index.js"),
        importDist(root, pi, "util/dates.js"),
      ]);

      loadEnv(root);
      const config = loadConfig(join(root, "config.yaml"));

      let since: Date | undefined;
      if (params.days !== undefined) {
        if (!Number.isInteger(params.days) || params.days <= 0) throw new Error("days must be a positive integer");
        since = daysAgo(params.days);
      } else if (params.since) {
        const d = toDate(params.since);
        if (!d) throw new Error(`cannot parse since date: ${params.since}`);
        since = d;
      }
      if (params.maxItems !== undefined && (!Number.isInteger(params.maxItems) || params.maxItems <= 0)) {
        throw new Error("maxItems must be a positive integer");
      }

      const summarizer = params.skipAi || params.dryRun ? null : createSummarizer(config);
      const result = (await abortable(
        runPipeline({
          config,
          rootDir: root,
          summarizer,
          since,
          maxItems: params.maxItems,
          feedId: params.feed,
          dryRun: !!params.dryRun,
          html: !!params.html,
        }),
        signal,
      )) as BuildResult;

      const lines = [
        `fetched ${result.fetched} · new ${result.newItems}`,
        result.editionFile ? `wrote ${result.editionFile}` : "no new items — nothing written",
      ];
      if (params.dryRun) lines.push("(dry run: no AI, no writes, no state changes)");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ...result, windowStart: since?.toISOString() ?? null },
      };
    },
  });

  // newsletter_feed_check ----------------------------------------------------
  pi.registerTool({
    name: "newsletter_feed_check",
    label: "Newsletter Feed Check",
    description:
      "Fetch a feed URL or YouTube channel id and list its latest items (date, title, url). " +
      "Useful to verify a feed works or preview what a source publishes.",
    promptSnippet: "Check what a feed or YouTube channel recently published",
    parameters: Type.Object({
      feed: Type.String({ description: "RSS/Atom feed URL or YouTube channel id (UC…)" }),
      limit: Type.Optional(Type.Number({ description: "max items to show (default 10)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const root = getProjectRoot(ctx);
      const [{ fetchFeed }, { isChannelId, youtubeFeedUrl }] = await Promise.all([
        importDist(root, pi, "sources/rss.js"),
        importDist(root, pi, "sources/youtube.js"),
      ]);

      const url = isChannelId(params.feed) ? youtubeFeedUrl(params.feed) : params.feed;
      const items = (await abortable(fetchFeed(url), signal)) as FeedItem[];
      const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
      const shown = items.slice(0, limit);
      const text =
        shown.length === 0
          ? `${items.length} items in the feed`
          : `${items.length} items in the feed, showing the ${shown.length} latest:\n` +
            shown.map((it) => `${it.publishedAt.toISOString().slice(0, 10)}  ${it.title}\n    ${it.url}`).join("\n");
      return { content: [{ type: "text", text }], details: { url, count: items.length } };
    },
  });

  // newsletter_resolve_channel ----------------------------------------------
  // resolveChannelId lives inside cli.ts (not exported), so this tool shells
  // out to the compiled CLI and captures stdout — the CLI prints the id then
  // the feed url.
  pi.registerTool({
    name: "newsletter_resolve_channel",
    label: "Newsletter Resolve Channel",
    description:
      "Resolve a YouTube handle (@name), channel URL, or video URL to a channel id (UC…) and its RSS feed URL.",
    promptSnippet: "Resolve a YouTube channel id from a handle or URL",
    parameters: Type.Object({
      handleOrUrl: Type.String({
        description: "e.g. @somechannel, https://www.youtube.com/@name, or a channel/video URL",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = getProjectRoot(ctx);
      await ensureBuilt(root, pi);
      const res = await pi.exec("node", ["dist/cli.js", "resolve-channel", params.handleOrUrl], {
        cwd: root,
        timeout: 60_000,
      });
      if (res.code !== 0) throw new Error(`resolve-channel failed: ${res.stderr || res.stdout}`);
      const [channelId, feedLine] = res.stdout.trim().split("\n");
      const feedUrl = feedLine?.replace(/^feed:\s*/, "") ?? "";
      return {
        content: [{ type: "text", text: `${channelId}\nfeed: ${feedUrl}` }],
        details: { channelId, feedUrl },
      };
    },
  });

  // newsletter_feeds --------------------------------------------------------
  pi.registerTool({
    name: "newsletter_feeds",
    label: "Newsletter Feeds",
    description:
      "List the feeds tracked in config.yaml or add one (an RSS/Atom feed, a YouTube channel id, " +
      "or a no-feed listing page scraped with an html item selector).",
    promptSnippet: "List or add feeds tracked by the newsletter",
    parameters: Type.Object({
      // Plain string (not an enum) to stay compatible with all model APIs.
      action: Type.String({ description: "one of: list | add" }),
      id: Type.Optional(Type.String({ description: "feed id (lowercase alphanumeric with dashes), required for add" })),
      name: Type.Optional(Type.String({ description: "display name, required for add" })),
      blog: Type.Optional(Type.String({ description: "RSS/Atom feed URL (add: give one of blog/youtube/html)" })),
      youtube: Type.Optional(
        Type.String({ description: "YouTube channel id UC… (add: give one of blog/youtube/html)" }),
      ),
      html: Type.Optional(Type.String({ description: "listing page URL for a site with no feed" })),
      item: Type.Optional(
        Type.String({ description: "html item selector (required with html), e.g. \"article\"" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = getProjectRoot(ctx);
      const { loadConfig, saveConfig } = await importDist(root, pi, "config.js");
      const configPath = join(root, "config.yaml");
      const config = loadConfig(configPath);

      if (params.action !== "list" && params.action !== "add") {
        throw new Error(`invalid action '${params.action}' (expected list or add)`);
      }
      if (params.action === "list") {
        const lines = config.feeds.map(
          (f: any) =>
            `${f.id}  ${f.name}  (${f.sources.map((s: any) => describeSource(s)).join(", ")})`,
        );
        return {
          content: [{ type: "text", text: lines.join("\n") || "(no feeds configured)" }],
          details: { count: config.feeds.length },
        };
      }

      if (!params.id || !params.name) throw new Error("add requires id and name");
      if (!params.blog && !params.youtube && !params.html) {
        throw new Error("add requires at least one of blog, youtube or html");
      }
      if (params.html && !params.item) throw new Error("add with html requires an item selector");
      if (config.feeds.some((f: any) => f.id === params.id)) throw new Error(`feed '${params.id}' already exists`);

      const { isChannelId } = await importDist(root, pi, "sources/youtube.js");
      if (params.youtube && !isChannelId(params.youtube)) {
        throw new Error(`'${params.youtube}' is not a valid channel id — use newsletter_resolve_channel to find it`);
      }

      const sources: any[] = [];
      if (params.blog) sources.push({ type: "blog", url: params.blog });
      if (params.youtube) sources.push({ type: "youtube", channelId: params.youtube });
      if (params.html) sources.push({ type: "html", url: params.html, item: params.item });
      config.feeds.push({ id: params.id, name: params.name, tags: [], sources });
      saveConfig(configPath, config);
      return {
        content: [{ type: "text", text: `added '${params.id}' (${params.name}) to ${configPath}` }],
        details: { added: params.id },
      };
    },
  });

  // newsletter_status --------------------------------------------------------
  pi.registerTool({
    name: "newsletter_status",
    label: "Newsletter Status",
    description: "Show the newsletter's state: last run, edition history, seen item count, and configured feeds.",
    promptSnippet: "Show newsletter run history and configuration summary",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const root = getProjectRoot(ctx);
      const [{ loadConfig }, { StateStore }] = await Promise.all([
        importDist(root, pi, "config.js"),
        importDist(root, pi, "state.js"),
      ]);
      const config = loadConfig(join(root, "config.yaml"));
      const state = new StateStore(join(root, "data", "state.json")).load();
      const last = state.editions[state.editions.length - 1];
      const lines = [
        `feeds: ${config.feeds.length} (${config.feeds.map((f: any) => f.id).join(", ")})`,
        `last run: ${state.lastRun ?? "never"}`,
        `editions: ${state.editions.length}${last ? ` — latest issue ${last.issue} (${last.file}, ${last.items} items)` : ""}`,
        `seen items: ${Object.keys(state.seen).length}`,
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          lastRun: state.lastRun,
          editions: state.editions.length,
          seen: Object.keys(state.seen).length,
        },
      };
    },
  });

  // /newsletter command ------------------------------------------------------
  pi.registerCommand("newsletter", {
    description: "Run a dry-run newsletter build and show what's new",
    handler: async (_args, ctx) => {
      const root = getProjectRoot(ctx);
      const [{ runPipeline }, { loadConfig }] = await Promise.all([
        importDist(root, pi, "pipeline.js"),
        importDist(root, pi, "config.js"),
      ]);
      loadEnv(root);
      const config = loadConfig(join(root, "config.yaml"));
      const result = await runPipeline({ config, rootDir: root, summarizer: null, dryRun: true });
      const msg =
        result.newItems > 0
          ? `dry run: ${result.newItems} new items of ${result.fetched} fetched — run newsletter_build to write the edition`
          : `dry run: ${result.fetched} fetched, no new items since the last run`;
      ctx.ui.notify(msg, "info");
    },
  });
}
