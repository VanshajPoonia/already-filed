// The GitHub Action against fixtures: the real model, and a fake GitHub that serves the
// fixtures and records every write. No network.
//   Issues: real zed issues from the frozen snapshot. #58197 was marked a duplicate of #45726.
//   PRs: real meshery PRs from data/prs (see fixtures/action/pulls.json for which and why).
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tf from '@huggingface/transformers';
import { embedder } from '../src/embed.js';
import { LIKELY, PR_LIKELY, PR_MAYBE } from '../src/threshold.js';
import { check, MARKER, CLEARED } from '../action/check.mjs';
import { vectorCache } from '../action/vectors.mjs';

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/action/${f}`, import.meta.url)));
const days = (d) => new Date(Date.now() - d * 864e5).toISOString();

/** Serves issues, PRs and comments from memory. Records every request that is not a GET. */
function fakeGitHub(repo, { issues = [], pulls = [] } = {}) {
  const comments = new Map();
  const writes = [];
  let nextId = 9000;
  globalThis.fetch = async (u, init = {}) => {
    const method = init.method || 'GET';
    const { pathname, searchParams } = new URL(u);
    const reply = (data, status = 200) => ({ ok: status < 300, status, headers: new Headers(), json: async () => data, text: async () => JSON.stringify(data) });
    if (pathname === '/graphql') {
      const nodes = pulls.filter((p) => p.state === 'open').map((p) => ({ number: p.number, closingIssuesReferences: { nodes: (p.sidebar ?? []).map((x) => ({ number: x, repository: { nameWithOwner: repo } })) } }));
      return reply({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes } } } });
    }
    if (method !== 'GET') writes.push(`${method} ${pathname}`);
    if (pathname === `/repos/${repo}/issues`) return reply(searchParams.get('state') === 'open' ? issues : []);
    if (pathname === `/repos/${repo}/pulls`) return reply(pulls.filter((p) => (p.state === 'open') === (searchParams.get('state') === 'open')));
    let m;
    if ((m = pathname.match(/\/issues\/(\d+)\/comments$/))) {
      const list = comments.get(+m[1]) ?? [];
      if (method === 'GET') return reply(list);
      if (method === 'POST') {
        const c = { id: nextId++, body: JSON.parse(init.body).body };
        comments.set(+m[1], [...list, c]);
        return reply(c, 201);
      }
    }
    if ((m = pathname.match(/\/issues\/comments\/(\d+)$/)) && method === 'PATCH') {
      const c = [...comments.values()].flat().find((x) => x.id === +m[1]);
      c.body = JSON.parse(init.body).body;
      return reply(c);
    }
    return reply({ message: `not in the fixtures: ${method} ${pathname}` }, 404);
  };
  return { comments, writes };
}

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

const raw = await embedder(tf, 'gemma');
const dir = mkdtempSync(join(tmpdir(), 'issuetwin-'));
const file = join(dir, 'vectors');
let cache = vectorCache(raw, file, 'test');
const run = (o) => check({ token: 't', embed: cache.embed, threshold: LIKELY, prThreshold: PR_LIKELY, ...o });

// ---------- issues ----------
const ZED = 'zed-industries/zed';
const issues = fx('issues.json');
const dupEvent = fx('event-issue.json');
const newEvent = { action: 'opened', issue: { number: 60000, title: 'Add a Fortran language server', body: 'It would be great to have fortls built in, like other languages.', state: 'open', user: { login: 'someone', type: 'User' } } };

await t('a duplicate issue gets one comment that names the original', async () => {
  const gh = fakeGitHub(ZED, { issues });
  const r = await run({ repo: ZED, event: dupEvent });
  assert.equal(r.action, 'posted');
  assert.equal(r.matches[0].n, 45726);
  assert.deepEqual(gh.writes, ['POST /repos/zed-industries/zed/issues/58197/comments']);
  const [c] = gh.comments.get(58197);
  assert.ok(c.body.startsWith(MARKER) && c.body.includes('- #45726 '));

  // A rerun with the same result writes nothing.
  assert.equal((await run({ repo: ZED, event: dupEvent })).action, 'unchanged');
  // A rerun that has more to say edits the same comment, never a second one.
  const lower = await run({ repo: ZED, event: dupEvent, threshold: 0.6 });
  assert.equal(lower.action, 'edited');
  assert.ok(lower.matches.length > 1);
  // And when nothing is close enough any more, the comment says so instead of going stale.
  assert.equal((await run({ repo: ZED, event: dupEvent, threshold: 0.999 })).action, 'edited');
  assert.equal(gh.comments.get(58197).length, 1);
  assert.equal(gh.comments.get(58197)[0].body, CLEARED);
  assert.deepEqual(gh.writes, ['POST /repos/zed-industries/zed/issues/58197/comments', ...Array(2).fill(`PATCH /repos/zed-industries/zed/issues/comments/${c.id}`)]);
});

await t('the threshold is respected: nothing close enough, no comment at all', async () => {
  const gh = fakeGitHub(ZED, { issues });
  assert.equal((await run({ repo: ZED, event: dupEvent, threshold: 0.999 })).action, 'none');
  assert.equal((await run({ repo: ZED, event: newEvent })).action, 'none');
  assert.deepEqual(gh.writes, []);
});

await t('a dry run writes nothing', async () => {
  const gh = fakeGitHub(ZED, { issues });
  assert.equal((await run({ repo: ZED, event: dupEvent, dryRun: true })).action, 'would-post');
  assert.deepEqual(gh.writes, []);
});

await t('vectors are cached between runs', async () => {
  cache.save();
  cache = vectorCache(raw, file, 'test');
  fakeGitHub(ZED, { issues });
  await run({ repo: ZED, event: dupEvent, dryRun: true });
  assert.equal(cache.stats.embedded, 0);
  assert.ok(cache.stats.reused > issues.length);
  const other = vectorCache(raw, file, 'another model');
  await other.embed([issues[0].title]);
  assert.equal(other.stats.embedded, 1); // another model's vectors are never reused
});

// ---------- pull requests ----------
const MESHERY = 'meshery/meshery';
const pulls = fx('pulls.json');
const [sameIssueEvent, repeatEvent] = fx('event-pr.json');

await t('a PR for an issue another PR already fixes says which PR, even when that one is linked only from the sidebar', async () => {
  const gh = fakeGitHub(MESHERY, { pulls });
  const r = await run({ repo: MESHERY, event: sameIssueEvent });
  assert.deepEqual(r.fixes, [{ issue: 23200, by: 23384, state: 'open' }]);
  assert.ok(gh.comments.get(23386)[0].body.includes('#23200 is already being fixed in PR #23384.'));
  assert.ok(!r.matches.some((m) => m.n === 23384)); // said once, not twice
});

await t('a PR that repeats an earlier one with no linked issue: quiet at the default line, caught by its text at the looser one', async () => {
  const gh = fakeGitHub(MESHERY, { pulls });
  assert.equal((await run({ repo: MESHERY, event: repeatEvent })).action, 'none');
  assert.deepEqual(gh.writes, []);
  const r = await run({ repo: MESHERY, event: repeatEvent, prThreshold: PR_MAYBE });
  assert.deepEqual(r.fixes, []);
  assert.equal(r.matches[0]?.n, 20910);
});

await t('a merged PR in the last 30 days counts as already fixing it', async () => {
  const merged = pulls.map((p) => (p.number === 23384 ? { ...p, state: 'closed', closed_at: days(3), merged_at: days(3), updated_at: days(3), body: `${p.body}\nCloses #23200` } : p));
  const gh = fakeGitHub(MESHERY, { pulls: merged });
  const r = await run({ repo: MESHERY, event: sameIssueEvent });
  assert.deepEqual(r.fixes, [{ issue: 23200, by: 23384, state: 'merged' }]);
  assert.ok(gh.comments.get(23386)[0].body.includes('#23200 was already fixed in PR #23384, which is merged.'));
});

await t('it never closes, labels or edits anything but its own comment', async () => {
  const gh = fakeGitHub(MESHERY, { pulls });
  await run({ repo: MESHERY, event: sameIssueEvent });
  await run({ repo: MESHERY, event: sameIssueEvent, prThreshold: 0.5 });
  assert.ok(gh.writes.length && gh.writes.every((w) => /^(POST \/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments|PATCH \/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+)$/.test(w)), gh.writes.join(', '));
  assert.equal(gh.comments.get(23386).length, 1);
});

rmSync(dir, { recursive: true, force: true });
console.log(`${passed}/${passed} Action checks pass`);
