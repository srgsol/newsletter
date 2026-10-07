# Changelog

## Unreleased

### Added

- **`html` source** — follows sites that publish no feed (e.g. Anthropic
  Engineering) by reading their listing page. `src/sources/html.ts` is a
  dependency-free extractor over a small CSS subset (`tag`, `*`, `.class`,
  `#id`, `[attr]`, `[attr=value]`, descendant combinators) with `item`,
  `title`, `link`, `date`, optional `description` and optional `urlPattern`
  keys in the config. Items without a usable link or a parseable date are
  skipped; date-only values are read as local midnight so they don't shift a
  day in negative-offset timezones.
- **Backfill note in the README** — a newly added source whose posts are all
  older than the lookback window reports nothing new; `--since` pulls the back
  catalogue once.

### Verified

- Typecheck clean; 47/47 tests passing (13 new: extraction, entity decoding,
  script/style stripping, custom + descendant selectors, urlPattern, date
  fallback, HTTP failure, config validation).
- Live against https://www.anthropic.com/engineering: 25 items parsed with real
  titles, urls and publish dates (2024-09-18 … 2026-04-23); dry run with
  `--since 2025-01-01 --person anthropic-engineering` reported 22 new items.

### Fixed (found during live verification)

- The listing page mixes an off-site promo `<article>`
  (`https://platform.claude.com/`) into the real posts, which produced a bogus
  item and a duplicate title — `urlPattern` filters it out.
- An ISO date-only `datetime` (`2026-01-09`) parsed as UTC midnight and could
  fall out of the window in positive-offset timezones; it is now local.

## 0.1.0 — 2026-08-21

Initial release: the full v1 of the personal newsletter automation.

### Added

- **Config** — zod-validated `config.yaml` plus a provider registry
  (deepseek / openai / ollama) with per-provider defaults, model/endpoint
  overrides, and env-key handling (`DEEPSEEK_API_KEY`, generic `LLM_API_KEY`
  fallback).
- **Sources** — `Source` interface with blog and YouTube RSS implementations
  (no API keys needed; YouTube uses per-channel RSS feeds). X/LinkedIn can be
  added later as implementations without touching the pipeline.
- **AI** — `Summarizer` interface with an OpenAI-compatible implementation
  (batched requests, JSON mode, retries with backoff, fence-stripping).
  DeepSeek today; switching providers is a config change or a small adapter.
- **Pipeline** — fetch → window/seen dedupe → summarize → AI cross-post
  dedupe ("Also covered by") → rank + cap → render → state.
- **State** — atomic JSON store (`data/state.json`: seen URLs + edition
  history), plus a lock file guarding against overlapping runs.
- **Rendering** — Markdown editions (`editions/YYYY-MM-DD.md`) with
  `groupBy: ranked | person | type`, and a styled HTML twin via `--html`.
- **CLI** — `init`, `build` (`--days`, `--since`, `--max-items`, `--person`,
  `--dry-run`, `--skip-ai`, `--provider`, `--html`), `people list|add|edit`,
  `feed-check`, `resolve-channel`.
- **Tests** — 34 unit tests: config schema/providers, state store, RSS
  parsing (Atom + YouTube media:description), renderer golden files,
  pipeline filtering/dedupe/ranking, AI adapter with mocked HTTP
  (mapping, fence-stripping, retry policy).

### Verified

- Typecheck clean; 34/34 tests passing.
- Live against real feeds: Simon Willison's blog (30 items parsed);
  `resolve-channel @Fireship` → channel id → 15 real YouTube items.
- End-to-end run: fetched 45 · new 17 · included 5 (cap) → Markdown + HTML
  edition; second run correctly reported nothing new; last-run window and
  `--days` override confirmed; dry-run lists items and writes nothing.

### Fixed (found during live verification)

- Commander 15 rejects `.command('people list')` shorthand — restructured
  `people` as a parent command with `list`/`add`/`edit` children.
- Lock acquisition misreported a missing `data/` parent directory as "another
  run in progress" — now creates the parent and only treats `EEXIST` as a held
  lock.
- Logger wrote info lines to stdout, polluting command output — all logs now
  go to stderr so stdout carries only data (e.g. the id from
  `resolve-channel`).

### Remaining (user actions)

1. Copy `.env.example` to `.env` and add `DEEPSEEK_API_KEY` (until then,
   builds work with `--skip-ai`).
2. Run `npm run newsletter -- init` and fill `config.yaml` with the people to
   follow.
3. First `npm run newsletter -- build` — the only path not yet exercised
   against the real API is the DeepSeek call itself (adapter is unit-tested
   with mocked HTTP).

### Not yet included (planned later)

- Cron/systemd scheduling (lock file already in place), X/LinkedIn sources,
  full-text extraction for richer summaries, git repository initialization.
