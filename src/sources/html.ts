import { toDate } from '../util/dates.js';
import { logger } from '../util/logger.js';
import type { RawItem, Source } from './types.js';

/**
 * A generic HTML listing scraper for sites without a feed. It walks a small,
 * dependency-free subset of CSS selectors: tag, `*`, `.class`, `#id`,
 * `[attr]`, `[attr=value]` and descendant combinators (whitespace).
 */
export interface HtmlSelectors {
  /** listing page url; also the base for relative item links */
  url: string;
  /** selector matching each item container on the listing page */
  item: string;
  /** selector for the item's title text (default: h3) */
  title?: string;
  /** selector whose href is the item url (default: a) */
  link?: string;
  /** selector whose datetime attribute or text is the publish date (default: time) */
  date?: string;
  /** optional selector for the item's summary/excerpt text */
  description?: string;
  /** optional regex (as a string) the item url must match — filters promos and off-site cards */
  urlPattern?: string;
}

export interface HtmlItem {
  url: string;
  title: string;
  description: string;
  publishedAt: Date;
}

export const HTML_SELECTOR_DEFAULTS = { title: 'h3', link: 'a', date: 'time' } as const;

const USER_AGENT = 'personal-newsletter/1.0 (+local automation)';

// --- element tree ----------------------------------------------------------

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Array<El | string>;
  parent: El | null;
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g;
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

/** Parses enough of an HTML document to query it with simple selectors. */
function parseHtml(html: string): El {
  // Script, style and comment contents are noise for extraction; drop them
  // wholesale so markup inside JS strings never becomes an "item".
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');

  const root: El = { tag: '#root', attrs: {}, children: [], parent: null };
  const stack: El[] = [root];
  let cursor = 0;

  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(clean); m; m = TAG_RE.exec(clean)) {
    const text = clean.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    const top = stack[stack.length - 1]!;
    if (text) top.children.push(decodeEntities(text));

    const [, closing, rawTag, rawAttrs, selfClosing] = m;
    const tag = rawTag!.toLowerCase();
    if (closing) {
      const at = stack.findLastIndex((el) => el.tag === tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const el: El = { tag, attrs: parseAttrs(rawAttrs ?? ''), children: [], parent: top };
    top.children.push(el);
    if (!selfClosing && !VOID_ELEMENTS.has(tag)) stack.push(el);
  }
  const tail = clean.slice(cursor);
  if (tail) stack[stack.length - 1]!.children.push(decodeEntities(tail));
  return root;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(raw); m; m = ATTR_RE.exec(raw)) {
    const name = m[1]!.toLowerCase();
    const value = m[2];
    attrs[name] = value ? decodeEntities(value.replace(/^["']|["']$/g, '')) : '';
  }
  return attrs;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1]!.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// --- selectors -------------------------------------------------------------

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: Array<{ name: string; value: string | null }>;
}

function parseSelector(selector: string): Compound[] {
  const compounds = selector.trim().split(/\s+/).filter(Boolean).map(parseCompound);
  if (compounds.some((c) => c === null)) {
    throw new Error(`unsupported selector '${selector}' (supported: tag, *, .class, #id, [attr], [attr=value], descendant spaces)`);
  }
  return compounds as Compound[];
}

function parseCompound(part: string): Compound | null {
  const compound: Compound = { tag: null, id: null, classes: [], attrs: [] };
  let rest = part;
  const tag = /^([a-zA-Z][\w-]*|\*)/.exec(rest);
  if (tag) {
    compound.tag = tag[0].toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  while (rest) {
    let m: RegExpExecArray | null;
    if ((m = /^\.([\w-]+)/.exec(rest))) compound.classes.push(m[1]!.toLowerCase());
    else if ((m = /^#([\w-]+)/.exec(rest))) compound.id = m[1]!;
    else if ((m = /^\[\s*([\w:-]+)\s*(?:([~^$*|]?=)\s*("[^"]*"|'[^']*'|[^\]\s]+)\s*)?\]/.exec(rest))) {
      if (m[2] && m[2] !== '=') return null; // only exact-match attribute selectors
      compound.attrs.push({ name: m[1]!.toLowerCase(), value: m[3] ? m[3].replace(/^["']|["']$/g, '') : null });
    } else return null;
    rest = rest.slice(m[0].length);
  }
  return compound.tag === null && !compound.id && !compound.classes.length && !compound.attrs.length
    ? null
    : compound;
}

function matches(el: El, c: Compound): boolean {
  if (c.tag && c.tag !== '*' && el.tag !== c.tag) return false;
  if (c.id && el.attrs['id'] !== c.id) return false;
  if (c.classes.length) {
    const classes = (el.attrs['class'] ?? '').toLowerCase().split(/\s+/);
    if (!c.classes.every((cls) => classes.includes(cls))) return false;
  }
  return c.attrs.every((a) => a.name in el.attrs && (a.value === null || el.attrs[a.name] === a.value));
}

function descendants(root: El): El[] {
  const out: El[] = [];
  const walk = (el: El) => {
    for (const child of el.children) {
      if (typeof child === 'string') continue;
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** True when `el` matches the selector's last compound, with ancestors up to `root` matching the rest. */
function matchesChain(el: El, chain: Compound[], root: El): boolean {
  if (!matches(el, chain[chain.length - 1]!)) return false;
  let node = el.parent;
  for (let i = chain.length - 2; i >= 0; i--) {
    while (node && node !== root && !matches(node, chain[i]!)) node = node.parent;
    if (!node || node === root) return false;
    node = node.parent;
  }
  return true;
}

function select(root: El, selector: string): El[] {
  const chain = parseSelector(selector);
  return descendants(root).filter((el) => matchesChain(el, chain, root));
}

function selectFirst(root: El, selector: string): El | null {
  return select(root, selector)[0] ?? null;
}

/** Visible text of an element, whitespace-collapsed. */
function text(el: El): string {
  const parts: string[] = [];
  const walk = (node: El) => {
    for (const child of node.children) {
      if (typeof child === 'string') parts.push(child);
      else if (child.tag !== 'script' && child.tag !== 'style') walk(child);
    }
  };
  walk(el);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function resolveUrl(href: string | undefined, base: string): string | null {
  const raw = (href ?? '').trim();
  if (!raw || raw.startsWith('#')) return null;
  try {
    const url = new URL(raw, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Date-only values (`2026-01-09`) are read as local midnight, not UTC — otherwise
 * a listing date shifts a day back in negative-offset timezones and can fall out
 * of the lookback window.
 */
function parseItemDate(raw: string | null | undefined): Date | null {
  const value = (raw ?? '').trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  }
  return toDate(value);
}

// --- extraction ------------------------------------------------------------

/** Extracts listing items from an HTML page. Items without a usable link or date are skipped. */
export function parseHtmlItems(html: string, selectors: HtmlSelectors): HtmlItem[] {
  const titleSel = selectors.title ?? HTML_SELECTOR_DEFAULTS.title;
  const linkSel = selectors.link ?? HTML_SELECTOR_DEFAULTS.link;
  const dateSel = selectors.date ?? HTML_SELECTOR_DEFAULTS.date;

  const page = parseHtml(html);
  const urlFilter = selectors.urlPattern ? new RegExp(selectors.urlPattern) : null;
  const items: HtmlItem[] = [];
  for (const el of select(page, selectors.item)) {
    const url = resolveUrl(selectFirst(el, linkSel)?.attrs['href'], selectors.url);
    if (!url) {
      logger.debug(`html ${selectors.url}: skipping item without a usable link`);
      continue;
    }
    if (urlFilter && !urlFilter.test(url)) {
      logger.debug(`html ${selectors.url}: skipping item outside urlPattern: ${url}`);
      continue;
    }
    const dateEl = selectFirst(el, dateSel);
    const publishedAt = parseItemDate(
      dateEl?.attrs['datetime'] || dateEl?.attrs['data-date'] || (dateEl && text(dateEl)),
    );
    if (!publishedAt) {
      logger.debug(`html ${selectors.url}: skipping item without a parseable date: ${url}`);
      continue;
    }
    const titleEl = selectFirst(el, titleSel);
    const descEl = selectors.description ? selectFirst(el, selectors.description) : null;
    items.push({
      url,
      title: (titleEl && text(titleEl)) || '(untitled)',
      description: descEl ? text(descEl) : '',
      publishedAt,
    });
  }
  return items;
}

/** Fetches a listing page over HTTP(S), with a timeout and a sane UA. */
export async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export class HtmlSource implements Source {
  constructor(
    private readonly selectors: HtmlSelectors,
    private readonly person: { id: string; name: string; tags: string[] },
  ) {}

  get label(): string {
    return `html:${this.selectors.url}`;
  }

  async fetch(): Promise<RawItem[]> {
    const items = parseHtmlItems(await fetchHtml(this.selectors.url), this.selectors);
    return items.map((it) => ({
      url: it.url,
      title: it.title,
      description: it.description,
      publishedAt: it.publishedAt,
      type: 'blog' as const,
      personId: this.person.id,
      personName: this.person.name,
      personTags: this.person.tags,
    }));
  }
}
