// What part of an issue gets compared. Shared by the browser and the tests.
//
// Issue templates are the main problem: in a repo with a template, every issue starts with
// the same "### What is the issue?", "### OS", "### GPU", so two unrelated issues share half
// their words. Rather than hard-coding any repo's template, a line counts as template text
// when it appears in more than 2% of the repo's issues. Long logs are the other problem, so
// only the first lines of each code block are kept: that is where the error usually is.

const CODE_LINES = 4;
const MAX_CHARS = 1500;

function lines(body) {
  return (body || '')
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim());
}

const key = (l) => l.toLowerCase().replace(/\s+/g, ' ');

/** Lines common enough across a repo's issues to be its template, not the reporter's words. */
export function templateLines(issues, share = 0.02) {
  const counts = new Map();
  for (const i of issues) {
    const seen = new Set();
    for (const l of lines(i.body)) if (l && l.length < 200) seen.add(key(l));
    for (const k of seen) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const min = Math.max(5, issues.length * share);
  return new Set([...counts].filter(([, c]) => c >= min).map(([k]) => k));
}

/** The text that gets embedded: the title, then the body without template, links or long logs. */
export function issueText(issue, template = new Set()) {
  const out = [];
  let inCode = false;
  let codeLines = 0;
  for (const l of lines(issue.body)) {
    if (/^(```|~~~)/.test(l)) { inCode = !inCode; codeLines = 0; continue; }
    if (inCode) { if (codeLines++ < CODE_LINES && l) out.push(l); continue; }
    if (!l || template.has(key(l))) continue;
    const clean = l
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')          // images
      .replace(/<img[^>]*>/gi, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // links: keep the words
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/<\/?[a-z][^>]*>/gi, ' ')
      .replace(/^#+\s*|^[-*>]\s+|\*\*|__/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean && !template.has(key(clean))) out.push(clean);
  }
  const body = out.join('\n').slice(0, MAX_CHARS);
  return body ? `${issue.title.trim()}\n${body}` : issue.title.trim();
}
