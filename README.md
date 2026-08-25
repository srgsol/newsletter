# Personal Newsletter

Tracks the online activity of people you follow (blogs and YouTube channels via
RSS), summarizes and ranks new items with an LLM, and renders one Markdown
edition per run into `editions/`. Runs on demand from the CLI; safe to schedule
with cron or a systemd timer later.

## Setup

```bash
npm install
cp .env.example .env        # add your DEEPSEEK_API_KEY (optional: editions still work without AI)
npm run newsletter -- init  # creates config.yaml
```

Both steps are required on a fresh clone: `.env` and `config.yaml` are
gitignored, since one holds your API key and the other your personal
watchlist. `init` scaffolds a starter `config.yaml` and never overwrites an
existing one.

Edit `config.yaml`: replace the example person with your people. Each person
has one or more sources:

- `blog` — the site's RSS/Atom feed url
- `youtube` — the 24-char channel id (starts with `UC`), not the handle. Find
  it with `npm run newsletter -- resolve-channel @handle`.

```yaml
people:
  - id: simon
    name: Simon Willison
    tags: [ai, python]      # passed to the LLM for relevance scoring
    sources:
      - type: blog
        url: https://simonwillison.net/atom/everything/
      - type: youtube
        channelId: UCXXXXXXXXXXXXXXXXXXXXXX
```

## Usage

```bash
npm run newsletter -- build              # full run: fetch → summarize → rank → render
npm run newsletter -- build --dry-run    # fetch + report, no AI, no writes
npm run newsletter -- build --skip-ai    # edition with titles and links only
npm run newsletter -- build --days 7 --max-items 20
npm run newsletter -- build --person simon --html
npm run newsletter -- people list | people add | people edit
npm run newsletter -- feed-check <feed-url-or-channel-id>
npm run newsletter -- resolve-channel <handle-or-url>
```

On the first run everything from the last `lookbackDays` is new. Each run
writes `editions/YYYY-MM-DD.md`, records seen URLs in `data/state.json` (an
item is never included twice), and starts the next run where the last one left
off.

## Providers

`provider` in `config.yaml` selects the LLM adapter. All are OpenAI-compatible
endpoints, so switching is a config change:

| provider  | default model     | API key env var       |
|-----------|-------------------|-----------------------|
| deepseek  | `deepseek-chat`   | `DEEPSEEK_API_KEY`    |
| openai    | `gpt-4o-mini`     | `OPENAI_API_KEY`      |
| ollama    | `llama3.1`        | none needed (local)   |

`LLM_API_KEY` works as a generic fallback for any provider. Override the
endpoint or model per-run with `--provider`, or in config with `baseUrl` /
`model`. If no key is found or the API fails, the edition is still produced
with titles and links only.

## Scheduling (later)

A cron entry like this runs the build every morning at 9:

```
0 9 * * * cd /path/to/newsletter && npm run newsletter -- build
```

A lock file (`data/.lock`) prevents overlapping runs. If you start using a
scheduler, consider adding `--verbose` for a log trail.

## Layout

```
src/
  cli.ts             # commander CLI
  pipeline.ts        # fetch → dedupe → summarize → rank → render → state
  config.ts          # zod-validated config + provider registry
  state.ts           # seen-URL store (JSON; sqlite is the upgrade path)
  sources/           # Source interface + blog/YouTube implementations
  ai/                # Summarizer interface + OpenAI-compatible implementation
  render/            # Markdown edition + optional HTML
  util/              # dates, run lock, logger
tests/               # vitest unit tests

config.yaml          # your watchlist + settings   — local, via `init`
.env                 # API keys                    — local, via .env.example
editions/            # generated Markdown editions — output
data/state.json      # seen URLs + edition history — local state
dist/                # compiled JS                 — build output
```

The bottom five are gitignored: the first two because they are personal, the
rest because they are produced by running the tool. A fresh clone contains
only source, tests, and docs.

New platforms (X, LinkedIn) are added as `Source` implementations; new LLM
vendors as `Summarizer` implementations or config changes — the pipeline
doesn't change.
