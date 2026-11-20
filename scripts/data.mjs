// The frozen issue snapshots in data/repos, the duplicate links in them, and an embedding
// cache so the slow part of the tests runs once.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, rmSync, truncateSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { issueText, templateLines } from '../src/text.js';

const CACHE = new URL('../tests/.cache/', import.meta.url);

export function loadRepo(repo) {
  const base = new URL(`../data/repos/${repo.replace('/', '__')}.json`, import.meta.url);
  const gz = new URL(base.href + '.gz');
  const raw = existsSync(gz) ? gunzipSync(readFileSync(gz)) : readFileSync(base);
  const { issues, fetched } = JSON.parse(raw);
  issues.sort((a, b) => a.n - b.n);
  issues.fetched = fetched;
  return issues;
}

/** The frozen pull requests in data/prs (scripts/fetch-prs.mjs). */
export function loadPrs(repo) {
  const file = new URL(`../data/prs/${repo.replace('/', '__')}.json.gz`, import.meta.url);
  const { prs, fetched, since } = JSON.parse(gunzipSync(readFileSync(file)));
  prs.sort((a, b) => a.n - b.n);
  Object.assign(prs, { fetched, since });
  return prs;
}

/**
 * Groups issues that maintainers linked as duplicates (A dup of B, C dup of B: one group).
 * `dupOf` is one number, or a list for PRs. Returns, for each issue, its group id, or -1 if it
 * was never linked.
 */
export function groups(issues) {
  const at = new Map(issues.map((x, i) => [x.n, i]));
  const parent = issues.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const linked = new Set();
  for (const [i, x] of issues.entries()) {
    for (const d of [x.dupOf ?? []].flat()) {
      if (!at.has(d)) continue;
      const j = at.get(d);
      parent[find(i)] = find(j);
      linked.add(i); linked.add(j);
    }
  }
  return issues.map((_, i) => (linked.has(i) ? find(i) : -1));
}

/**
 * The questions the tests ask. Issues are replayed in the order they were filed, and each new
 * issue is compared with every issue filed before it.
 *   dups:   new issues that maintainers later linked to an earlier one. Right answer: any
 *           earlier issue in the same group.
 *   others: new issues never linked to anything. Any confident suggestion is a false alarm
 *           (as far as the labels know; maintainers do not link every duplicate).
 * Issues closed as "duplicate" without saying of what are left out of both.
 */
export function questions(issues) {
  const g = groups(issues);
  const firstOf = new Map();
  const dups = [], others = [];
  for (const [i, x] of issues.entries()) {
    if (g[i] === -1) { if (x.state !== 'duplicate') others.push(i); continue; }
    if (firstOf.has(g[i])) dups.push(i); else firstOf.set(g[i], i);
  }
  return { g, dups, others };
}

export function texts(issues, mode = 'clean') {
  if (mode === 'title') return issues.map((x) => x.title.trim());
  if (mode === 'raw') return issues.map((x) => `${x.title.trim()}\n${(x.body || '').slice(0, 1500)}`);
  const template = templateLines(issues);
  return issues.map((x) => issueText(x, template));
}

const CHUNK = 1000;

/**
 * Embeds texts once and keeps the vectors in tests/.cache, keyed by repo and variant. Progress
 * is saved every CHUNK texts, so a run that gets killed picks up where it stopped.
 */
export async function embedCached(name, list, embed, dims) {
  mkdirSync(CACHE, { recursive: true });
  const bin = new URL(`${name}.bin`, CACHE);
  const read = () => {
    const buf = readFileSync(bin);
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return all.length === list.length * dims ? Array.from(list, (_, i) => all.subarray(i * dims, (i + 1) * dims)) : null;
  };
  if (existsSync(bin)) {
    const vecs = read();
    if (vecs) return vecs;
  }
  const part = new URL(`${name}.part.bin`, CACHE);
  const meta = new URL(`${name}.part.json`, CACHE);
  const key = createHash('sha1').update(list.join('\0')).digest('hex');
  let done = 0;
  if (existsSync(part) && existsSync(meta) && JSON.parse(readFileSync(meta, 'utf8')).key === key) {
    done = Math.floor(readFileSync(part).byteLength / 4 / dims);
    truncateSync(part, done * dims * 4); // drop a half-written chunk
  } else {
    writeFileSync(part, Buffer.alloc(0));
    writeFileSync(meta, JSON.stringify({ key }));
  }
  const t = Date.now();
  for (let i = done; i < list.length; i += CHUNK) {
    const vecs = await embed(list.slice(i, i + CHUNK), (n) => process.stdout.write(`\r  embedding ${name}: ${i + n}/${list.length}`));
    const buf = new Float32Array(vecs.length * dims);
    vecs.forEach((v, k) => buf.set(v, k * dims));
    appendFileSync(part, Buffer.from(buf.buffer));
  }
  process.stdout.write(`\r  embedded ${name}: ${list.length - done} texts in ${((Date.now() - t) / 60000).toFixed(1)} min\n`);
  renameSync(part, bin);
  rmSync(meta);
  return read();
}
