// Pull requests: which issues each one says it fixes, and which open PRs overlap. Shared by
// the browser, the GitHub Action and the tests.
import { issueText, templateLines } from './text.js';

// GitHub's closing keywords. Each reference needs its own keyword, as on GitHub itself.
const KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+((?:https:\/\/github\.com\/)?[\w.-]+\/[\w.-]+(?:#|\/issues\/)\d+|#\d+)/gi;

const stripComments = (s) => String(s || '').replace(/<!--[\s\S]*?(-->|$)/g, ' ');

/** Issue numbers a PR body links with "fixes #12", "closes owner/name#12" or a full issue URL. */
export function linkedIssues(body, repo) {
  const out = new Set();
  for (const [, ref] of stripComments(body).matchAll(KEYWORD)) {
    const m = ref.match(/^(?:https:\/\/github\.com\/)?(?:([\w.-]+\/[\w.-]+)(?:#|\/issues\/))?#?(\d+)$/i);
    if (!m) continue;
    if (m[1] && repo && m[1].toLowerCase() !== repo.toLowerCase()) continue;
    out.add(Number(m[2]));
  }
  return [...out].sort((a, b) => a - b);
}

/** Dependabot, Renovate and the like. Their PRs replace each other by design. */
export function isBot(user) {
  if (!user) return false;
  return user.type === 'Bot' || user.__typename === 'Bot' || /\[bot\]$|^(dependabot|renovate)/i.test(user.login || '');
}

/**
 * PR numbers that a maintainer's comment calls a duplicate: "duplicate of #456", "superseded
 * by https://github.com/o/n/pull/789". Only references on a line that says duplicate or
 * superseded count, and quoted lines are skipped. The caller checks each number is a PR.
 */
export function dupLinks(text, self, repo) {
  const out = new Set();
  const ref = new RegExp(`(?:https://github\\.com/${repo.replace(/[.]/g, '\\.')}/(?:pull|issues)/|(?<![\\w/])#)(\\d+)`, 'gi');
  for (const line of stripComments(text).split('\n')) {
    if (/^\s*>/.test(line) || !/duplicat|supersed/i.test(line)) continue;
    for (const [, n] of line.matchAll(ref)) if (Number(n) !== self) out.add(Number(n));
  }
  return [...out];
}

/**
 * Open PRs that fix an issue an earlier PR already fixes: "#123 is already being fixed in
 * PR #456". `prs` need { n, state, closes }. Earlier means a lower number. A merged PR counts
 * as already fixing it; a closed unmerged one does not.
 * @returns {{ pr: number, issue: number, by: number[] }[]}
 */
export function sameIssue(prs) {
  const fixers = new Map(); // issue -> PRs that fix it, oldest first
  for (const p of [...prs].sort((a, b) => a.n - b.n)) {
    if (p.state !== 'open' && p.state !== 'merged') continue;
    for (const i of p.closes ?? []) {
      if (!fixers.has(i)) fixers.set(i, []);
      fixers.get(i).push(p);
    }
  }
  const out = [];
  for (const [issue, list] of fixers) {
    list.forEach((p, k) => {
      if (p.state !== 'open' || k === 0) return;
      out.push({ pr: p.n, issue, by: list.slice(0, k).map((x) => x.n) });
    });
  }
  return out.sort((a, b) => b.pr - a.pr || a.issue - b.issue);
}

const stripRefs = (body) => stripComments(body)
  .replace(KEYWORD, ' ')
  .replace(/(?:https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/|(?<![\w/])#)\d+/g, ' ');

/**
 * The text a PR is compared by: its title and cleaned body, without "fixes #12" and other
 * references. Links are matched exactly by sameIssue, so the embedding judges the change itself.
 */
export const prText = (pr, template) => issueText({ title: pr.title, body: stripRefs(pr.body) }, template);

/** A repo's PR template lines, found the same way as for issues. */
export const prTemplate = (prs) => templateLines(prs.map((p) => ({ body: stripRefs(p.body) })));
