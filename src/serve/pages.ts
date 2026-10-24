/**
 * HTML for pages the Worker generates itself: the index, the secured login
 * form, and the 403 and 404 pages. Every value from storage or the request
 * goes through escapeHtml.
 */
import { type ArtifactSummary, type Scope, scopeUrlPrefix, type Visibility } from '../lib/artifacts';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; color: #222; background: #fff; }
  h1 { font-size: 1.4rem; }
  a { color: #0645ad; }
  ul { padding-left: 1.2rem; }
  li { margin: 0.4rem 0; }
  .meta { color: #666; font-size: 0.9rem; }
  .error { color: #b00020; }
  input, button { font: inherit; padding: 0.3rem 0.5rem; }
  @media (prefers-color-scheme: dark) {
    body { color: #ddd; background: #161616; }
    a { color: #8ab4f8; }
    .meta { color: #999; }
    .error { color: #ff7b7b; }
  }
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function artifactUrl(scope: Scope, slug: string): string {
  return `${scopeUrlPrefix(scope)}${slug}/`;
}

const VISIBILITY_LABEL: Record<Visibility, string> = {
  public: '',
  secured: ' (password)',
  gated: ' (allowlisted network only)',
};

/** The generated index. Only titles and links: no artifact content. */
export function indexPage(artifacts: readonly ArtifactSummary[]): string {
  const items = artifacts.map((a) => {
    const title = a.meta.title || a.slug;
    const date = a.meta.updated.slice(0, 10);
    return `<li><a href="${escapeHtml(artifactUrl(a.scope, a.slug))}">${escapeHtml(title)}</a>${VISIBILITY_LABEL[a.scope.visibility]} <span class="meta">${escapeHtml(date)}</span></li>`;
  });
  const list = items.length > 0 ? `<ul>\n${items.join('\n')}\n</ul>` : '<p>Nothing listed yet.</p>';
  return layout('share.rlew.io', `<h1>share.rlew.io</h1>\n${list}`);
}

export function loginPage(action: string, error: boolean): string {
  const message = error ? '<p class="error">Wrong password.</p>\n' : '';
  return layout(
    'Password required',
    `<h1>Password required</h1>
<p>This page is protected by a password.</p>
${message}<form method="post" action="${escapeHtml(action)}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Open</button>
</form>`,
  );
}

export function forbiddenPage(): string {
  return layout(
    'Restricted',
    `<h1>Restricted</h1>
<p>This page is restricted to an allowlisted network.</p>`,
  );
}

export function notFoundPage(): string {
  return layout('Not found', `<h1>Not found</h1>\n<p>There is nothing at this address.</p>`);
}
