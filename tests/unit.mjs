// Fast checks of everything that is not the model: cleaning issue text, finding a repo's
// template, keyword search, ranking, how the test questions are built, and which issues a PR
// says it fixes.
import assert from 'node:assert/strict';
import { issueText, templateLines } from '../src/text.js';
import { BM25, tokens } from '../src/bm25.js';
import { Matcher, candidates } from '../src/match.js';
import { parseRepo } from '../src/github.js';
import { groups, questions } from '../scripts/data.mjs';
import { score, rankOfRight } from '../scripts/measure.mjs';
import { linkedIssues, dupLinks, sameIssue, prText, prTemplate, isBot } from '../src/prs.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; };

const TEMPLATE = '### What is the issue?\n\n### OS\n\n### GPU\n\n### Ollama version\n';
const mk = (n, title, body = '', extra = {}) => ({ n, title, body, created: `2026-01-${String(n % 28 + 1).padStart(2, '0')}`, state: 'open', ...extra });

t('template lines are found from the repo itself, not hard-coded', () => {
  const issues = Array.from({ length: 50 }, (_, i) => mk(i + 1, `bug ${i}`, `${TEMPLATE}something unique ${i}`));
  const tpl = templateLines(issues);
  assert.ok(tpl.has('### what is the issue?'));
  assert.ok(tpl.has('### ollama version'));
  assert.ok(!tpl.has('something unique 3'));
  const text = issueText(issues[3], tpl);
  assert.equal(text, 'bug 3\nsomething unique 3');
});

t('only the first lines of a log are kept; comments, links and images go', () => {
  const body = '<!-- please fill in -->\nIt crashes on start, see [the docs](https://x.y/z).\n![shot](https://img/a.png)\n```\nError: CUDA out of memory\nline 2\nline 3\nline 4\nline 5\nline 6\n```\nThanks';
  const text = issueText(mk(1, 'Crash on start', body));
  assert.ok(text.includes('see the docs'));
  assert.ok(!text.includes('https'));
  assert.ok(!text.includes('please fill in'));
  assert.ok(text.includes('Error: CUDA out of memory'));
  assert.ok(text.includes('line 4') && !text.includes('line 5'));
  assert.ok(text.endsWith('Thanks'));
  assert.equal(issueText(mk(2, '  Just a title  ', '')), 'Just a title');
});

t('keyword search ranks shared rare words first', () => {
  const ix = new BM25();
  ix.add('model fails to load on AMD GPU with ROCm');
  ix.add('feature request: dark mode');
  ix.add('the the the model');
  const s = ix.scores('ROCm GPU not detected');
  assert.ok(s[0] > s[1] && s[0] > s[2]);
  assert.deepEqual(tokens('Why does v0.3.1 crash?'), ['why', 'v0.3.1', 'crash']);
});

t('the matcher mixes body, title and keywords, and ranks best first', () => {
  const v = (a) => { const n = Math.hypot(...a); return Float32Array.from(a.map((x) => x / n)); };
  const body = [v([1, 0, 0]), v([0, 1, 0]), v([0.9, 0.1, 0]), v([1, 0.05, 0])];
  const title = [v([0, 0, 1]), v([0, 1, 0]), v([0, 0.2, 1]), v([0, 0, 1])];
  const texts = ['gpu not found', 'dark mode', 'gpu missing', 'gpu not found on linux'];
  const m = new Matcher(body, title, texts, { body: 1, title: 0, keywords: 0 });
  assert.deepEqual(m.top(2, [0, 1]).map(([j]) => j), [0, 1]);
  // Keywords alone: shared rare words win.
  const k = new Matcher(body, title, texts, { body: 0, title: 0, keywords: 1 });
  assert.equal(k.top(3, [0, 1, 2], 1)[0][0], 0);
  assert.equal(k.top(3, [0, 1, 2], 1)[0][1], 1); // the best keyword match is scaled to 1
  // A draft that is not in the matrix.
  assert.equal(new Matcher(body, title, texts).top({ body: v([0, 1, 0]), title: v([0, 1, 0]), text: 'dark mode please' }, [0, 1, 2, 3], 1)[0][0], 1);
});

t('candidates: earlier issues still open then, or closed in the 30 days before', () => {
  const day = (d) => new Date(Date.UTC(2026, 0, 1) + d * 864e5).toISOString();
  const issues = [
    { n: 1, created: day(0), closed: null },        // still open
    { n: 2, created: day(1), closed: day(5) },      // closed long before #4
    { n: 3, created: day(2), closed: day(60) },     // closed 10 days before #4
    { n: 4, created: day(70), closed: null },
  ];
  assert.deepEqual(candidates(issues)(3), [0, 2]);
  assert.deepEqual(candidates(issues)(1), [0]);
});

t('duplicate links become groups; each later member is a question', () => {
  const issues = [mk(1, 'a'), mk(2, 'b', '', { dupOf: 1 }), mk(3, 'c'), mk(4, 'd', '', { dupOf: 1 }), mk(5, 'e', '', { state: 'duplicate' }), mk(6, 'f', '', { dupOf: 9 })];
  const g = groups(issues);
  assert.equal(g[0], g[1]); assert.equal(g[0], g[3]); assert.equal(g[2], -1);
  const q = questions(issues);
  assert.deepEqual(q.dups, [1, 3]);          // #2 and #4; #1 is the first of its group
  assert.deepEqual(q.others, [2, 5]);        // #3 and #6 (its target is outside the repo); #5 left out
  // #4 is answered correctly by #2 as well as by #1: both are the same bug.
  assert.equal(rankOfRight([[2, 0.9], [1, 0.8]], 3, g), 2);
  assert.equal(rankOfRight([[1, 0.9]], 3, g), 1);
});

t('scoring: top-k, and what a threshold catches and costs', () => {
  const issues = [mk(1, 'a'), mk(2, 'b', '', { dupOf: 1 }), mk(3, 'c'), mk(4, 'd')];
  const q = questions(issues);
  const ranks = new Map([[1, [[0, 0.9]]], [2, [[0, 0.5]]], [3, [[2, 0.7]]]]);
  assert.deepEqual(score(ranks, q, 0.6), { at1: 1, at3: 1, at5: 1, caught: 1, alarms: 0.5 });
  assert.equal(score(ranks, q, 0.95).caught, 0);
});

t('repo names in every form people paste', () => {
  assert.equal(parseRepo('ollama/ollama'), 'ollama/ollama');
  assert.equal(parseRepo('https://github.com/zed-industries/zed/issues'), 'zed-industries/zed');
  assert.equal(parseRepo(' neovim/neovim.git '), 'neovim/neovim');
  assert.equal(parseRepo('just-a-word'), null);
});

t('PR links: closing keywords, same repo only, not inside comments', () => {
  const body = 'This PR fixes #23995\n<!-- fixes #1 -->\nCloses meshery/meshery#12, resolves https://github.com/meshery/meshery/issues/99\nfixes other/repo#5. Fixed: #7. Related to #8';
  assert.deepEqual(linkedIssues(body, 'meshery/meshery'), [7, 12, 99, 23995]);
  assert.deepEqual(linkedIssues('', 'a/b'), []);
});

t('said duplicates: only lines that say duplicate or superseded, never quotes', () => {
  const text = '> duplicate of #1\nI guess this is a duplicate of #20541\nLooks good, see #6\nSuperseded by https://github.com/meshery/meshery/pull/22715';
  assert.deepEqual(dupLinks(text, 21605, 'meshery/meshery'), [20541, 22715]);
  assert.deepEqual(dupLinks('duplicate of #5', 5, 'a/b'), []);
});

t('bots are left out', () => {
  assert.ok(isBot({ login: 'dependabot[bot]', type: 'Bot' }));
  assert.ok(isBot({ login: 'renovate-bot' }));
  assert.ok(!isBot({ login: 'octocat', type: 'User' }));
});

t('same issue: later open PRs, against open or merged earlier ones', () => {
  const prs = [{ n: 1, state: 'merged', closes: [9] }, { n: 2, state: 'closed', closes: [9] }, { n: 3, state: 'open', closes: [9, 10] }, { n: 4, state: 'open', closes: [10] }, { n: 5, state: 'open', closes: [] }];
  assert.deepEqual(sameIssue(prs), [{ pr: 4, issue: 10, by: [3] }, { pr: 3, issue: 9, by: [1] }]);
});

t('PR text: template and issue references taken out', () => {
  const prs = Array.from({ length: 30 }, (_, i) => ({ title: `Fix ${i}`, body: `**Notes for Reviewers**\nThis PR fixes #${100 + i}\nchange ${i} see #4 and https://github.com/a/b/pull/3` }));
  assert.equal(prText(prs[3], prTemplate(prs)), 'Fix 3\nchange 3 see and');
});

console.log(`${passed}/${passed} unit checks pass`);
