// Downloads every issue of a repo (not pull requests) with the duplicate links maintainers made,
// and freezes it into data/repos/<owner>__<name>.json.gz for the tests.
//   GITHUB_TOKEN=... node scripts/fetch.mjs ollama/ollama
// "Duplicate of #123" in a comment (or the close-as-duplicate dialog) leaves a
// MarkedAsDuplicateEvent on the issue's timeline. That event is the ground truth.
import { writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';

const repo = process.argv[2];
if (!repo?.includes('/')) throw new Error('usage: node scripts/fetch.mjs owner/name');
const [owner, name] = repo.split('/');
const token = process.env.GITHUB_TOKEN || execSync('gh auth token').toString().trim();

const QUERY = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    issues(first:100,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title body createdAt closedAt state stateReason
        labels(first:10){nodes{name}}
        timelineItems(itemTypes:[MARKED_AS_DUPLICATE_EVENT,UNMARKED_AS_DUPLICATE_EVENT],first:30){
          nodes{
            __typename
            ... on MarkedAsDuplicateEvent{createdAt canonical{__typename ... on Issue{number repository{nameWithOwner}}} duplicate{... on Issue{number}}}
            ... on UnmarkedAsDuplicateEvent{createdAt canonical{... on Issue{number}} duplicate{... on Issue{number}}}
          }
        }
      }
    }
  }
}`;

async function page(after) {
  for (let t = 0; ; t++) {
    try {
      const r = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { owner, name, after } }),
      });
      const j = await r.json();
      if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
      return j.data.repository.issues;
    } catch (e) {
      if (t > 5) throw e;
      console.warn('retry', e.message);
      await new Promise((ok) => setTimeout(ok, 5000 * (t + 1)));
    }
  }
}

// The event shows up on the canonical issue's timeline, the duplicate's, or both, so collect
// every event first and resolve them in time order afterwards.
const issues = [];
const events = [];
let after = null;
do {
  const p = await page(after);
  for (const n of p.nodes) {
    for (const ev of n.timelineItems.nodes) {
      const d = ev.duplicate?.number, c = ev.canonical?.number;
      if (!d || !c || d === c) continue;
      if (ev.__typename === 'MarkedAsDuplicateEvent' && ev.canonical.repository?.nameWithOwner !== repo) continue;
      events.push({ type: ev.__typename, at: ev.createdAt, d, c });
    }
    issues.push({
      n: n.number,
      title: n.title,
      body: (n.body || '').slice(0, 4000),
      created: n.createdAt,
      closed: n.closedAt,
      state: n.state === 'OPEN' ? 'open' : (n.stateReason || 'closed').toLowerCase(),
      labels: n.labels.nodes.map((l) => l.name),
      dupOf: null,
    });
  }
  after = p.pageInfo.hasNextPage ? p.pageInfo.endCursor : null;
  process.stdout.write(`\r${repo}: ${issues.length} issues, ${events.length} duplicate events`);
} while (after);

// A link counts only if it was never undone, and only between two issues (not pull requests).
const byNumber = new Map(issues.map((i) => [i.n, i]));
const seen = new Set();
for (const ev of events.sort((a, b) => a.at.localeCompare(b.at))) {
  const key = `${ev.type}:${ev.d}:${ev.c}:${ev.at}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const dup = byNumber.get(ev.d);
  if (!dup || !byNumber.has(ev.c)) continue;
  if (ev.type === 'MarkedAsDuplicateEvent') dup.dupOf = ev.c;
  else if (dup.dupOf === ev.c) dup.dupOf = null;
}
console.log(`\n${issues.filter((i) => i.dupOf).length} issues marked as duplicates of another issue`);

await mkdir('data/repos', { recursive: true });
const file = `data/repos/${owner}__${name}.json.gz`;
await writeFile(file, gzipSync(JSON.stringify({ repo, fetched: new Date().toISOString(), issues }), { level: 9 }));
console.log(`\nwrote ${file}`);
