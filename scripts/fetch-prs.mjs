// Downloads a repo's pull requests with the issues each one says it fixes and the duplicate
// links maintainers made, and freezes them into data/prs/<owner>__<name>.json.gz for the tests.
//   GITHUB_TOKEN=... node scripts/fetch-prs.mjs meshery/meshery [since]
// Few PRs get a "Duplicate of #123" event. Maintainers mostly say it in words ("duplicate of
// #456", "superseded by #789"), so those comments count too. See dupLinks in src/prs.js.
import { writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import { linkedIssues, isBot, dupLinks } from '../src/prs.js';
import { RECENT_DAYS } from '../src/match.js';

const repo = process.argv[2];
if (!repo?.includes('/')) throw new Error('usage: node scripts/fetch-prs.mjs owner/name [since]');
const since = process.argv[3] || '2025-01-01';
const [owner, name] = repo.split('/');
const token = process.env.GITHUB_TOKEN || execSync('gh auth token').toString().trim();

async function gql(query, variables) {
  for (let t = 0; ; t++) {
    try {
      const r = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const j = await r.json();
      if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
      return j.data;
    } catch (e) {
      if (t > 5) throw e;
      console.warn('retry', e.message);
      await new Promise((ok) => setTimeout(ok, 5000 * (t + 1)));
    }
  }
}

const PRS = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequests(first:100,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title body createdAt closedAt mergedAt state
        author{login __typename}
        closingIssuesReferences(first:10){nodes{number repository{nameWithOwner}}}
        timelineItems(itemTypes:[MARKED_AS_DUPLICATE_EVENT],first:10){
          nodes{... on MarkedAsDuplicateEvent{canonical{... on PullRequest{number repository{nameWithOwner}}} duplicate{... on PullRequest{number}}}}
        }
      }
    }
  }
}`;

const prs = [];
const marked = [];
let after = null;
do {
  const p = (await gql(PRS, { owner, name, after })).repository.pullRequests;
  for (const x of p.nodes) {
    for (const ev of x.timelineItems.nodes) {
      const c = ev.canonical?.number, d = ev.duplicate?.number;
      if (c && d && c !== d && ev.canonical.repository?.nameWithOwner === repo) marked.push([d, c]);
    }
    prs.push({
      n: x.number,
      title: x.title,
      body: (x.body || '').slice(0, 4000),
      created: x.createdAt,
      closed: x.closedAt,
      state: x.mergedAt ? 'merged' : x.state === 'OPEN' ? 'open' : 'closed',
      bot: isBot(x.author),
      closes: [...new Set([
        ...x.closingIssuesReferences.nodes.filter((i) => i.repository?.nameWithOwner === repo).map((i) => i.number),
        ...linkedIssues(x.body, repo),
      ])].sort((a, b) => a - b),
    });
  }
  after = p.pageInfo.hasNextPage ? p.pageInfo.endCursor : null;
  process.stdout.write(`\r${repo}: ${prs.length} pull requests`);
} while (after);

// Only what the tests replay: PRs filed since `since`, and older ones still open then (or
// closed in the RECENT_DAYS before), since those are what a new PR is compared with.
const from = +new Date(since) - RECENT_DAYS * 864e5;
const keep = prs.filter((x) => !x.bot && (+new Date(x.created) >= +new Date(since) || !x.closed || +new Date(x.closed) >= from));
const numbers = new Set(keep.map((x) => x.n));

// Comments that call a PR a duplicate. Search finds the PRs, then their comments are read.
const hits = new Set();
for (let page = 1; page <= 10; page++) {
  const q = encodeURIComponent(`repo:${repo} is:pr is:unmerged duplicate in:comments created:>=${since}`);
  const r = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=100&page=${page}`, { headers: { Authorization: `bearer ${token}` } });
  const j = await r.json();
  for (const x of j.items ?? []) hits.add(x.number);
  if (!j.items?.length || page * 100 >= j.total_count) break;
  await new Promise((ok) => setTimeout(ok, 2500));
}
const COMMENTS = (ns) => `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${ns.map((n) =>
  `p${n}:pullRequest(number:${n}){comments(first:100){nodes{body author{login __typename}}} reviews(first:30){nodes{body author{login __typename}}}}`).join(' ')}}}`;
const said = [];
const list = [...hits].filter((n) => numbers.has(n));
for (let i = 0; i < list.length; i += 10) {
  const data = await gql(COMMENTS(list.slice(i, i + 10)), { owner, name });
  for (const [k, v] of Object.entries(data.repository)) {
    const n = Number(k.slice(1));
    for (const c of [...v.comments.nodes, ...v.reviews.nodes]) {
      if (!isBot(c.author)) for (const m of dupLinks(c.body, n, repo)) said.push([n, m]);
    }
  }
  process.stdout.write(`\r${list.length} PRs with "duplicate" in a comment: read ${Math.min(i + 10, list.length)}`);
}

// A pair counts when both ends are PRs in the kept set. The later PR is the duplicate.
const at = new Map(keep.map((x) => [x.n, x]));
const pairs = new Map();
for (const [a, b] of [...marked, ...said]) {
  if (!at.has(a) || !at.has(b) || a === b) continue;
  const [late, early] = a > b ? [a, b] : [b, a];
  pairs.set(`${late}:${early}`, [late, early]);
}
for (const x of keep) x.dupOf = [];
for (const [late, early] of pairs.values()) at.get(late).dupOf.push(early);
console.log(`\n${keep.length} PRs kept (${prs.length - keep.length} older or from bots dropped), ${pairs.size} duplicate pairs (${marked.length} marked, ${said.length} said in comments)`);

await mkdir('data/prs', { recursive: true });
const file = `data/prs/${owner}__${name}.json.gz`;
await writeFile(file, gzipSync(JSON.stringify({ repo, fetched: new Date().toISOString(), since, prs: keep }), { level: 9 }));
console.log(`wrote ${file}`);
