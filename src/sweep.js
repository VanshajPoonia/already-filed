// The backlog sweep: groups open issues that look like an earlier one into clusters, and
// closes the ones a maintainer ticks as duplicates. Shared by the browser and the tests.
//
// Closing uses GitHub's own close-as-duplicate: PATCH the issue with state "closed",
// state_reason "duplicate" and duplicate_issue_id, the id (not the number) of the original.
// https://docs.github.com/en/rest/issues/issues#update-an-issue

/**
 * Each open issue is linked to its best match among the issues filed before it, if that match
 * scores at least `threshold`. Linked issues form a cluster, and the cluster's oldest issue that
 * was not itself closed as a duplicate is the one the others get closed against.
 * @param {(i: number) => [number, number] | undefined} best  an issue's best earlier match and its score
 * @returns {{ canonical: number, members: { i: number, to: number, score: number }[] }[]}
 */
export function clusters(issues, best, threshold) {
  const parent = issues.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const edges = [];
  for (const [i, x] of issues.entries()) {
    if (x.state !== 'open' && x.state !== 'reopened') continue;
    const b = best(i);
    if (!b || b[1] < threshold) continue;
    edges.push({ i, to: b[0], score: b[1] });
    parent[find(i)] = find(b[0]);
  }
  const groups = new Map();
  for (const e of edges) {
    const r = find(e.i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(e);
  }
  const out = [];
  for (const members of groups.values()) {
    const all = [...new Set(members.flatMap((e) => [e.i, e.to]))].sort((a, b) => a - b);
    const canonical = all.find((k) => issues[k].state !== 'duplicate') ?? all[0];
    out.push({ canonical, members: members.filter((e) => e.i !== canonical).sort((a, b) => b.score - a.score) });
  }
  return out.filter((c) => c.members.length).sort((a, b) => b.members.length - a.members.length || b.members[0].score - a.members[0].score);
}

/** The requests that close each picked issue as a duplicate of its cluster's original. */
export function closeRequests(repo, picks) {
  return picks.map(({ issue, original }) => ({
    issue: issue.n,
    original: original.n,
    method: 'PATCH',
    path: `/repos/${repo}/issues/${issue.n}`,
    body: { state: 'closed', state_reason: 'duplicate', duplicate_issue_id: original.id ?? null },
  }));
}

/**
 * Sends the requests one at a time and reports each. Looks up an original's id first when the
 * issue list did not have it (the instant snapshot does not). Stops at the first auth error.
 */
export async function send(requests, { token, fetch = globalThis.fetch, onResult } = {}) {
  const API = 'https://api.github.com';
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const ids = new Map();
  const results = [];
  for (const r of requests) {
    let res;
    try {
      const body = { ...r.body };
      if (body.duplicate_issue_id == null) {
        if (!ids.has(r.original)) {
          const g = await fetch(`${API}${r.path.replace(/\d+$/, r.original)}`, { headers });
          if (!g.ok) throw new Error(`could not look up #${r.original} (GitHub answered ${g.status})`);
          ids.set(r.original, (await g.json()).id);
        }
        body.duplicate_issue_id = ids.get(r.original);
      }
      const p = await fetch(`${API}${r.path}`, { method: r.method, headers, body: JSON.stringify(body) });
      res = p.ok ? { ok: true } : { ok: false, status: p.status, error: (await p.json().catch(() => ({}))).message || `GitHub answered ${p.status}` };
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    results.push({ ...r, ...res });
    onResult?.(results[results.length - 1]);
    if (res.status === 401 || res.status === 403) break;
  }
  return results;
}
