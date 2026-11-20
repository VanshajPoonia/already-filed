// Issues straight from GitHub's public API, from this tab. Without a token GitHub allows 60
// requests an hour per network, which is 6,000 issues; a token (read-only, public repos)
// raises it to 5,000 requests.
import { RECENT_DAYS } from './match.js';
import { linkedIssues, isBot } from './prs.js';

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
  id: x.id,
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

export const MAX_PRS = 3000;

const toPull = (x, repo) => ({
  n: x.number,
  title: x.title,
  body: (x.body || '').slice(0, 4000),
  created: x.created_at,
  closed: x.closed_at,
  state: x.merged_at ? 'merged' : x.state === 'open' ? 'open' : 'closed',
  draft: !!x.draft,
  bot: isBot(x.user),
  closes: linkedIssues(x.body, repo),
});

// GitHub's own list of the issues a PR will close, which also has links made in the sidebar.
// GraphQL needs a token, so without one the links come from the PR text only.
const CLOSING = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){
  pullRequests(states:OPEN,first:100,after:$after){pageInfo{hasNextPage endCursor}
    nodes{number closingIssuesReferences(first:10){nodes{number repository{nameWithOwner}}}}}}}`;

async function closingRefs(repo, token) {
  const [owner, name] = repo.split('/');
  const out = new Map();
  let after = null;
  do {
    const r = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: CLOSING, variables: { owner, name, after } }),
    });
    const j = await r.json();
    if (!r.ok || j.errors) throw new Error(j.errors?.[0]?.message || `GitHub answered ${r.status}`);
    const p = j.data.repository.pullRequests;
    for (const x of p.nodes) out.set(x.number, x.closingIssuesReferences.nodes.filter((i) => i.repository.nameWithOwner.toLowerCase() === repo.toLowerCase()).map((i) => i.number));
    after = p.pageInfo.hasNextPage ? p.pageInfo.endCursor : null;
  } while (after && out.size < MAX_PRS);
  return out;
}

/**
 * What a PR gets compared with: every open PR, and every PR closed or merged in the last
 * RECENT_DAYS days. In filing order. `linked` says where the "fixes #N" links came from.
 */
export async function fetchPulls(repo, { token, onProgress } = {}) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const since = new Date(Date.now() - RECENT_DAYS * 864e5).toISOString();
  const out = [];
  let capped = false;
  for await (const list of pages(`${API}/repos/${repo}/pulls?state=open&per_page=100`, headers)) {
    out.push(...list.map((x) => toPull(x, repo)));
    onProgress?.(out.length);
    if (out.length >= MAX_PRS) { capped = true; break; }
  }
  // Closed PRs newest-updated first: once one was last touched before `since`, so were the rest.
  if (!capped) {
    for await (const list of pages(`${API}/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`, headers)) {
      for (const x of list) if (x.closed_at >= since) out.push(toPull(x, repo));
      onProgress?.(out.length);
      if (!list.length || list[list.length - 1].updated_at < since) break;
      if (out.length >= MAX_PRS) { capped = true; break; }
    }
  }
  let linked = 'text';
  if (token) {
    try {
      const refs = await closingRefs(repo, token);
      for (const p of out) if (refs.has(p.n)) p.closes = [...new Set([...p.closes, ...refs.get(p.n)])].sort((a, b) => a - b);
      linked = 'github';
    } catch (err) {
      linked = `text (GitHub's linked-issue list failed: ${err.message})`;
    }
  }
  const seen = new Set();
  const prs = out.filter((x) => !seen.has(x.n) && seen.add(x.n)).sort((a, b) => a.n - b.n);
  return { prs, capped, linked };
}
