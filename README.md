# Personal Newsletter

Tracks the online activity of the feeds you follow — blogs and YouTube channels
via RSS, plus feed-less sites scraped as HTML — summarizes and ranks new items
with an LLM, and renders one Markdown edition per run into `editions/`. Runs on
demand from the CLI; safe to schedule with cron or a systemd timer later.

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

Edit `config.yaml`: replace the example feed with the feeds you follow. Each
feed has one or more sources:

- `blog` — the site's RSS/Atom feed url
- `youtube` — the 24-char channel id (starts with `UC`), not the handle. Find
  it with `npm run newsletter -- resolve-channel @handle`.
- `html` — a listing page on a site that has **no feed**, scraped with simple
  CSS selectors (see below).

```yaml
feeds:
  - id: simon
    name: Simon Willison
    tags: [ai, python]      # passed to the LLM for relevance scoring
    sources:
      - type: blog
        url: https://simonwillison.net/atom/everything/
      - type: youtube
        channelId: UCXXXXXXXXXXXXXXXXXXXXXX
```

### Sites without a feed (`html`)

Some sites publish no RSS. `html` fetches the listing page and reads each item
out of the markup:

```yaml
  - id: anthropic-engineering
    name: Anthropic Engineering
    tags: [ai]
    sources:
      - type: html
        url: https://www.anthropic.com/engineering   # the listing page
        item: article        # selector for one item container (required)
        title: h3            # default: h3
        link: a              # default: a  (its href is the item url)
        date: time           # default: time  (datetime attribute, else text)
        description: .excerpt  # optional: summary/excerpt text for the LLM
        urlPattern: ^https://www\.anthropic\.com/engineering/  # optional url filter
```

Selectors are a dependency-free subset of CSS: `tag`, `*`, `.class`, `#id`,
`[attr]`, `[attr=value]`, and descendant combinators (whitespace). Items with
no usable link or no parseable date are skipped, as is anything not matching
`urlPattern` — use it to drop promo cards and off-site links that listing pages
mix in. A date-only value like `2026-01-09` is read as local midnight.

Fetching and inspecting a listing before writing the config:

```bash
curl -s https://www.anthropic.com/engineering | grep -o '<article' | wc -l
npm run newsletter -- build --feed anthropic-engineering --dry-run --verbose
```

**Backfilling:** a build only includes items inside the window (since the last
run, or `lookbackDays`). A freshly added source whose posts are all older than
that window reports nothing new — run it once with an explicit `--since` to
pull the back catalogue:

```bash
npm run newsletter -- build --feed anthropic-engineering --since 2026-01-01
```

## Usage

```bash
npm run newsletter -- build              # full run: fetch → summarize → rank → render
npm run newsletter -- build --dry-run    # fetch + report, no AI, no writes
npm run newsletter -- build --skip-ai    # edition with titles and links only
npm run newsletter -- build --days 7 --max-items 20
npm run newsletter -- build --feed simon --html
npm run newsletter -- feeds list | feeds add | feeds edit
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

## pi integration (optional)

`.pi/extensions/newsletter.ts` exposes the app to a [pi](https://github.com/badlogic/pi-mono)
agent as tools — `newsletter_build`, `newsletter_feed_check`,
`newsletter_resolve_channel`, `newsletter_feeds`, `newsletter_status` — plus a
`/newsletter` dry-run command. The CLI needs none of this; the extension is a
convenience wrapper that imports the compiled modules from `dist/`, rebuilding
them when `src/` is newer.

Two caveats if you use it:

- `typebox` and `@earendil-works/pi-coding-agent` come from pi at runtime and
  are deliberately not in `package.json`, so the extension can't be typechecked
  after a plain `npm install` without pi installed.
- It reads `config.yaml` and `.env` from the project root at call time; neither
  is tracked.

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

.pi/
  extensions/newsletter.ts  # optional pi agent tools (see above)

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
