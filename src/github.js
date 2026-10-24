// Issues straight from GitHub's public API, from this tab. Without a token GitHub allows 60
// requests an hour per network, which is 6,000 issues; a token (read-only, public repos)
// raises it to 5,000 requests.
import { RECENT_DAYS } from './match.js';

const API = 'https://api.github.com';
export const MAX_ISSUES = 6000;

export function parseRepo(s) {
  const m = String(s).trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '').match(/^([\w.-]+)\/([\w.-]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function* pages(url, headers) {
  // Follow GitHub's own "next" links: page numbers stop working after page 10 on big repos.
  while (url) {
    const r = await fetch(url, { headers });
    if (r.status === 404) throw new Error('GitHub has no public repo by that name.');
    if (r.status === 401) throw new Error('GitHub did not accept that token.');
    if (r.status === 403 || r.status === 429) {
      const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000;
      const mins = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 60000)) : null;
      throw new Error(`GitHub's hourly limit for this network is used up${mins ? ` (it resets in ${mins} min)` : ''}. A read-only token lifts it.`);
    }
    if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
    yield await r.json();
    url = r.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
}

const toIssue = (x) => ({
  n: x.number,
  title: x.title,
  body: (x.body || '').slice(0, 4000),
  created: x.created_at,
  closed: x.closed_at,
  state: x.state === 'open' ? 'open' : (x.state_reason || 'closed'),
});

/**
 * What a new issue gets compared with: every open issue, and every issue closed in the last
 * RECENT_DAYS days (pull requests skipped). In filing order.
 */
export async function fetchIssues(repo, { token, onProgress } = {}) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const since = new Date(Date.now() - RECENT_DAYS * 864e5).toISOString();
  const out = [];
  let capped = false;
  const queries = [
    `${API}/repos/${repo}/issues?state=open&per_page=100`,
    `${API}/repos/${repo}/issues?state=closed&since=${since}&per_page=100`,
  ];
  for (const q of queries) {
    for await (const list of pages(q, headers)) {
      for (const x of list) if (!x.pull_request && (x.state === 'open' || x.closed_at >= since)) out.push(toIssue(x));
      onProgress?.(out.length);
      if (out.length >= MAX_ISSUES) { capped = true; break; }
    }
    if (capped) break;
  }
  const seen = new Set();
  const issues = out.filter((x) => !seen.has(x.n) && seen.add(x.n)).sort((a, b) => a.n - b.n);
  return { issues, capped };
}
