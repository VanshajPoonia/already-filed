// What the GitHub Action does for one new issue or PR: compare it with the open and recently
// closed ones, then leave one comment, or edit the one it left before. It never closes,
// labels or reopens anything.
import { fetchIssues, fetchPulls } from '../src/github.js';
import { issueText, templateLines } from '../src/text.js';
import { Matcher } from '../src/match.js';
import { linkedIssues, isBot, prText, prTemplate } from '../src/prs.js';

export const MARKER = '<!-- issuetwin -->';
const API = 'https://api.github.com';
const SHOW = 3;

function client(token) {
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return async (method, path, body) => {
    const r = await fetch(`${API}${path}`, { method, headers, body: body && JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path}: GitHub answered ${r.status} ${(await r.text()).slice(0, 200)}`);
    return { data: await r.json(), next: r.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1]?.slice(API.length) };
  };
}

/** The item the event is about, or why there is nothing to do. */
export function itemOf(event) {
  const x = event.pull_request ?? (event.issue && !event.issue.pull_request ? event.issue : null);
  if (!x) return { skip: 'the event is not about an issue or a pull request' };
  if (x.state !== 'open') return { skip: `#${x.number} is not open` };
  if (isBot(x.user)) return { skip: `#${x.number} was opened by a bot` };
  return { kind: event.pull_request ? 'pr' : 'issue', n: x.number, title: x.title, body: x.body || '' };
}

const label = (x, kind) => {
  if (kind === 'issue') return x.state === 'open' || x.state === 'reopened' ? 'open' : 'closed';
  return x.state === 'merged' ? 'merged PR' : x.state === 'open' ? 'open PR' : 'closed PR';
};

/** The comment text, or null when there is nothing worth saying. */
export function commentBody({ kind, matches, fixes }) {
  if (!matches.length && !fixes.length) return null;
  const out = [MARKER];
  for (const f of fixes) {
    out.push(f.state === 'merged' ? `#${f.issue} was already fixed in PR #${f.by}, which is merged.` : `#${f.issue} is already being fixed in PR #${f.by}.`);
  }
  if (fixes.length) out.push('');
  if (matches.length) {
    out.push(kind === 'pr' ? 'This PR looks like an earlier one:' : 'This might have been filed before:', '');
    for (const m of matches) out.push(`- #${m.n} ${m.title.replace(/\s+/g, ' ').trim()} (${m.label})`);
    out.push('');
  }
  out.push(kind === 'pr'
    ? 'If it repeats one of these, a maintainer may want to pick one to review. If not, ignore this comment.'
    : 'If one of them is the same, a maintainer can close this one as a duplicate. If not, ignore this comment.');
  out.push('', `<sub>From IssueTwin, which compares new ${kind === 'pr' ? 'PRs' : 'issues'} with open and recently closed ones. It never closes anything.</sub>`);
  return out.join('\n');
}

export const CLEARED = `${MARKER}\nIssueTwin no longer finds a likely earlier one for this.`;

/**
 * @param {object} o
 * @param {string} o.repo          owner/name
 * @param {object} o.event         the webhook payload
 * @param {string} o.token
 * @param {(texts: string[]) => Promise<Float32Array[]>} o.embed
 * @param {number} o.threshold     for issues
 * @param {number} o.prThreshold   for PRs
 * @param {boolean} [o.dryRun]     log the comment instead of writing it
 */
export async function check({ repo, event, token, embed, threshold, prThreshold, dryRun = false, log = () => {} }) {
  const item = itemOf(event);
  if (item.skip) { log(`Nothing to do: ${item.skip}.`); return { action: 'none', skip: item.skip }; }
  const { kind, n } = item;

  // Everything filed before it that is still open, or was closed in the last 30 days.
  let pool, fixes = [];
  if (kind === 'issue') {
    pool = (await fetchIssues(repo, { token })).issues;
  } else {
    const { prs, linked } = await fetchPulls(repo, { token });
    log(`Linked issues come from ${linked}.`);
    pool = prs.filter((p) => !p.bot);
    const self = prs.find((p) => p.n === n);
    const closes = self?.closes ?? linkedIssues(item.body, repo);
    for (const issue of closes) {
      const by = pool.filter((p) => p.n < n && (p.state === 'open' || p.state === 'merged') && p.closes.includes(issue));
      if (by.length) fixes.push({ issue, by: by[0].n, state: by[0].state });
    }
  }
  const earlier = pool.filter((x) => x.n < n);
  const others = [...pool.filter((x) => x.n !== n), item];
  const [template, toText] = kind === 'pr' ? [prTemplate(others), prText] : [templateLines(others), issueText];
  const texts = earlier.map((x) => toText(x, template));
  const query = toText(item, template);
  log(`Comparing #${n} with ${earlier.length} earlier ${kind === 'pr' ? 'PRs' : 'issues'}.`);

  let matches = [];
  if (earlier.length) {
    const bodies = await embed([...texts, query]);
    const titles = await embed([...earlier.map((x) => x.title.trim()), item.title.trim()]);
    const m = new Matcher(bodies.slice(0, -1), titles.slice(0, -1), texts);
    const t = kind === 'pr' ? prThreshold : threshold;
    const fixedBy = new Set(fixes.map((f) => f.by));
    matches = m.top({ body: bodies.at(-1), title: titles.at(-1), text: query }, earlier.map((_, j) => j), SHOW)
      .filter(([j, s]) => s >= t && !fixedBy.has(earlier[j].n))
      .map(([j, s]) => ({ n: earlier[j].n, title: earlier[j].title, label: label(earlier[j], kind), score: +s.toFixed(3) }));
  }
  for (const x of matches) log(`  #${x.n} scores ${x.score}: ${x.title}`);
  for (const f of fixes) log(`  #${f.issue} is also fixed by #${f.by} (${f.state})`);

  const body = commentBody({ kind, matches, fixes });
  const api = client(token);
  let mine = null;
  for (let path = `/repos/${repo}/issues/${n}/comments?per_page=100`; path && !mine;) {
    const { data, next } = await api('GET', path);
    mine = data.find((c) => c.body?.startsWith(MARKER)) ?? null;
    path = next;
  }
  const want = body ?? (mine ? CLEARED : null);
  const result = { kind, n, matches, fixes, body: want };
  if (!want) { log('Nothing likely enough to mention. No comment.'); return { ...result, action: 'none' }; }
  if (mine?.body === want) { log('The comment already says this.'); return { ...result, action: 'unchanged', id: mine.id }; }
  if (dryRun) { log(`Dry run, so no comment. It would ${mine ? 'edit' : 'post'}:\n${want}`); return { ...result, action: mine ? 'would-edit' : 'would-post' }; }
  if (mine) {
    await api('PATCH', `/repos/${repo}/issues/comments/${mine.id}`, { body: want });
    log(`Edited comment ${mine.id}.`);
    return { ...result, action: 'edited', id: mine.id };
  }
  const { data } = await api('POST', `/repos/${repo}/issues/${n}/comments`, { body: want });
  log(`Posted comment ${data.id}.`);
  return { ...result, action: 'posted', id: data.id };
}
