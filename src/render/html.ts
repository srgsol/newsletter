import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ linkify: true });

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1c1e21;
  --muted: #5c626b;
  --accent: #0b6bcb;
  --code-bg: #f0f1f3;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181a;
    --fg: #e8eaed;
    --muted: #9aa2ac;
    --accent: #7fb4ea;
    --code-bg: #232528;
  }
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main {
  max-width: 46rem;
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
}
h1 { font-size: 1.6rem; margin: 0 0 0.5rem; }
h2 { font-size: 1.25rem; margin: 2rem 0 0.5rem; }
h3 { font-size: 1.05rem; margin: 1.5rem 0 0.25rem; }
a { color: var(--accent); }
p { margin: 0.5rem 0; }
strong { font-weight: 600; }
code {
  background: var(--code-bg);
  padding: 0.1em 0.35em;
  border-radius: 4px;
  font-size: 0.85em;
}
em { color: var(--muted); }
`;

/** Wraps rendered Markdown in a minimal self-contained HTML page. */
export function renderHtml(markdown: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS}</style>
</head>
<body>
<main>
${md.render(markdown)}
</main>
</body>
</html>`;
}
