import { fetchIssues, fetchPulls, parseRepo, MAX_ISSUES, MAX_PRS } from './github.js';
import { issueText, templateLines } from './text.js';
import { Matcher, RECENT_DAYS } from './match.js';
import { LIKELY, MAYBE, PR_LIKELY, PR_MAYBE } from './threshold.js';
import { prText, prTemplate, sameIssue } from './prs.js';
import { clusters, closeRequests, send } from './sweep.js';
import * as model from './model.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STATE = { open: 'open', completed: 'closed', not_planned: 'closed: not planned', duplicate: 'closed as duplicate', reopened: 'open', closed: 'closed', merged: 'merged' };

$('#size').textContent = `${model.SIZE_MB} MB`;

let current = null; // { repo, issues, matcher, template, embed }
let sweep = null; // { repo, issues }

// ---------- input -------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
if (params.get('repo')) $('#repo').value = params.get('repo');
try { const t = sessionStorage.getItem('gh-token'); if (t) $('#token').value = t; } catch {}

let mode = 'issues';
function setMode(m) {
  mode = m;
  document.querySelector(`input[name=mode][value=${m}]`).checked = true;
  document.querySelectorAll('.samples').forEach((el) => { el.hidden = el.dataset.mode !== m; });
  $('#go').textContent = m === 'prs' ? 'Find duplicate PRs' : 'Find the duplicates';
}
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => setMode(r.value)));
setMode(params.get('mode') === 'prs' ? 'prs' : 'issues');

document.querySelectorAll('[data-repo]').forEach((b) => b.addEventListener('click', () => {
  $('#repo').value = b.dataset.repo;
  if (b.dataset.snapshot == null) run();
  else if (mode === 'prs') openPrSnapshot(b.dataset.repo);
  else openSnapshot(b.dataset.repo);
}));
$('#go').addEventListener('click', run);
$('#repo').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

const status = (s) => { $('#status').textContent = s; };

async function run() {
  const repo = parseRepo($('#repo').value);
  if (!repo) { status('Type a repo as owner/name, like ollama/ollama.'); return; }
  const token = $('#token').value.trim();
  try { token ? sessionStorage.setItem('gh-token', token) : sessionStorage.removeItem('gh-token'); } catch {}
  const bar = $('#bar');
  $('#go').disabled = true;
  bar.hidden = false; bar.value = 0;
  $('#results').hidden = true;
  $('#pr-results').hidden = true;
  history.replaceState(null, '', `?repo=${repo}${mode === 'prs' ? '&mode=prs' : ''}`);
  try {
    if (mode === 'prs') await runPrs(repo, token, bar); else await runIssues(repo, token, bar);
  } catch (err) {
    console.error(err);
    status(err.message || String(err));
  } finally {
    $('#go').disabled = false;
    bar.hidden = true;
  }
}

/** Embeds texts and titles with progress, after fetching took the first 15% of the bar. */
async function read(texts, titles, bar, noun) {
  status('Loading the model (once; it is cached after this)…');
  const embed = await model.load((p) => { bar.value = 0.15 + p * 0.25; status(`Downloading EmbeddingGemma… ${Math.round(p * 100)}%`); });
  const t0 = performance.now();
  const total = texts.length * 1.2; // titles are short: about a fifth of the work
  const body = await embed(texts, (n) => { bar.value = 0.4 + 0.6 * (n / total); status(`Reading every ${noun} on this device… ${n.toLocaleString()} of ${texts.length.toLocaleString()}`); });
  const title = await embed(titles, (n) => { bar.value = 0.4 + 0.6 * ((texts.length + n * 0.2) / total); status('Reading the titles…'); });
  return { embed, body, title, secs: ((performance.now() - t0) / 1000).toFixed(0) };
}

const device = () => (model.backend() === 'webgpu' ? 'GPU' : 'CPU');

async function runIssues(repo, token, bar) {
  status(`Fetching ${repo}'s open issues, and those closed in the last ${RECENT_DAYS} days, from GitHub…`);
  const { issues, capped } = await fetchIssues(repo, { token, onProgress: (n) => { bar.value = Math.min(0.15, (n / 3000) * 0.15); status(`Fetching issues from GitHub… ${n.toLocaleString()}`); } });
  if (issues.length < 2) throw new Error(`${repo} has ${issues.length ? 'only one open issue' : 'no open issues'} to compare.`);
  const template = templateLines(issues);
  const texts = issues.map((x) => issueText(x, template));
  const { embed, body, title, secs } = await read(texts, issues.map((x) => x.title.trim()), bar, 'issue');
  current = { repo, issues, matcher: new Matcher(body, title, texts), template, embed };
  status('Comparing every open issue with the ones filed before it…');
  await new Promise((r) => setTimeout(r, 30));
  const found = render(current);
  status(`Read ${issues.length.toLocaleString()} issues in ${secs} s on this device (${device()}). ${found}${capped ? ` (Stopped at ${MAX_ISSUES.toLocaleString()} issues.)` : ''}`);
}

async function runPrs(repo, token, bar) {
  status(`Fetching ${repo}'s open pull requests, and those closed in the last ${RECENT_DAYS} days, from GitHub…`);
  const { prs: fetched, capped, linked } = await fetchPulls(repo, { token, onProgress: (n) => { bar.value = Math.min(0.15, (n / 1500) * 0.15); status(`Fetching pull requests from GitHub… ${n.toLocaleString()}`); } });
  const prs = fetched.filter((p) => !p.bot);
  if (prs.filter((p) => p.state === 'open').length < 1) throw new Error(`${repo} has no open pull requests from people to compare.`);
  const template = prTemplate(prs);
  const texts = prs.map((p) => prText(p, template));
  const { body, title, secs } = await read(texts, prs.map((p) => p.title.trim()), bar, 'pull request');
  status('Comparing every open PR with the ones filed before it…');
  await new Promise((r) => setTimeout(r, 30));
  const found = renderPrs({ repo, prs, matcher: new Matcher(body, title, texts) });
  const from = linked === 'github' ? '' : ` Linked issues come from the PR text only${token ? ` (${linked})` : '. A token adds the ones linked from the sidebar'}.`;
  status(`Read ${prs.length.toLocaleString()} pull requests in ${secs} s on this device (${device()}). ${found}${from}${capped ? ` (Stopped at ${MAX_PRS.toLocaleString()} PRs.)` : ''}`);
}

// Vectors read in advance by the same model (scripts/snapshot.mjs), as 8-bit numbers.
async function loadSnapshot(name) {
  const [meta, buf] = await Promise.all([
    fetch(`data/snapshots/${name}.json`).then((r) => r.json()),
    fetch(`data/snapshots/${name}.bin`).then((r) => r.arrayBuffer()),
  ]);
  const q = new Int8Array(buf);
  const vec = (row) => {
    const v = new Float32Array(meta.dims);
    let n = 0;
    for (let x = 0; x < meta.dims; x++) { v[x] = q[row * meta.dims + x] * meta.scale; n += v[x] * v[x]; }
    n = Math.sqrt(n);
    for (let x = 0; x < meta.dims; x++) v[x] /= n;
    return v;
  };
  const count = meta.issues?.length ?? meta.prs.length;
  const day = new Date(meta.taken).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return { meta, day, body: Array.from({ length: count }, (_, k) => vec(2 * k)), title: Array.from({ length: count }, (_, k) => vec(2 * k + 1)) };
}

// A repo read in advance, so the demo opens instantly.
async function openSnapshot(repo) {
  status(`Opening a snapshot of ${repo}…`);
  $('#pr-results').hidden = true;
  try {
    const { meta, day, body, title } = await loadSnapshot(repo.replace('/', '__'));
    current = { repo, issues: meta.issues, matcher: new Matcher(body, title, meta.texts), template: new Set(), embed: null };
    status(`Comparing every open issue of ${repo} with the ones filed before it…`);
    await new Promise((r) => setTimeout(r, 30));
    const found = render(current);
    status(`A snapshot of ${repo} taken on ${day}: ${meta.issues.length.toLocaleString()} open and recently closed issues, read in advance by the same model. ${found} Press “Find the duplicates” to read today's issues live.`);
  } catch (err) {
    console.error(err);
    status(`Could not open the snapshot (${err.message}).`);
  }
}

async function openPrSnapshot(repo) {
  status(`Opening a snapshot of ${repo}'s pull requests…`);
  $('#results').hidden = true;
  try {
    const { meta, day, body, title } = await loadSnapshot(`${repo.replace('/', '__')}-prs`);
    await new Promise((r) => setTimeout(r, 30));
    const found = renderPrs({ repo, prs: meta.prs, matcher: new Matcher(body, title, meta.texts) });
    status(`A snapshot of ${repo} taken on ${day}: ${meta.prs.length.toLocaleString()} open and recently closed pull requests, read in advance by the same model. ${found} Press “Find duplicate PRs” to read today's PRs live.`);
  } catch (err) {
    console.error(err);
    status(`Could not open the snapshot (${err.message}).`);
  }
}

// ---------- results -----------------------------------------------------------------------

const url = (repo, n, kind = 'issues') => `https://github.com/${repo}/${kind}/${n}`;
const ago = (iso) => {
  const d = (Date.now() - new Date(iso)) / 86400000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 60) return `${Math.round(d)} days ago`;
  if (d < 730) return `${Math.round(d / 30.4)} months ago`;
  return `${Math.round(d / 365)} years ago`;
};

function issueLine(repo, x, cls = '', kind = 'issues') {
  return `<a class="issue ${cls}" href="${url(repo, x.n, kind)}" target="_blank" rel="noopener">
    <span class="num">#${x.n}</span> <span class="title">${esc(x.title)}</span>
    <span class="meta">${kind === 'pull' ? 'PR, ' : ''}${STATE[x.state] ?? x.state}${x.draft ? ', draft' : ''} · ${ago(x.created)}</span></a>`;
}
const prLine = (repo, p, cls = '') => issueLine(repo, p, cls, 'pull');

function render({ repo, issues, matcher }) {
  // Each open issue against every issue filed before it, the same question the tests ask.
  const open = issues.map((x, i) => [x, i]).filter(([x]) => x.state === 'open' || x.state === 'reopened');
  const rows = [];
  for (const [x, i] of open) {
    const top = matcher.top(i, Array.from({ length: i }, (_, j) => j), 3);
    if (top.length && top[0][1] >= MAYBE) rows.push({ x, i, top });
  }
  rows.sort((a, b) => b.top[0][1] - a.top[0][1]);
  const likely = rows.filter((r) => r.top[0][1] >= LIKELY);
  const maybe = rows.filter((r) => r.top[0][1] < LIKELY);

  const card = ({ x, top }) => `
    <li class="pair ${top[0][1] >= LIKELY ? 'likely' : 'maybe'}">
      ${issueLine(repo, x, 'new')}
      <p class="looks">looks like</p>
      <ol class="matches">${top.filter(([, s], k) => k === 0 || s >= MAYBE).map(([j]) => `
        <li>${issueLine(repo, issues[j])}</li>`).join('')}
      </ol>
      <div class="actions">
        <button class="copy" data-copy="Duplicate of #${issues[top[0][0]].n}">Copy “Duplicate of #${issues[top[0][0]].n}”</button>
        <a class="small" href="${url(repo, x.n)}" target="_blank" rel="noopener">Open #${x.n} on GitHub</a>
      </div>
    </li>`;

  $('#likely-count').textContent = likely.length;
  $('#maybe-count').textContent = maybe.length;
  $('#open-count').textContent = open.length.toLocaleString();
  $('#likely').innerHTML = likely.map(card).join('') || '<li class="empty">No open issue looks like a duplicate of an earlier one. Nice repo.</li>';
  $('#maybe').innerHTML = maybe.map(card).join('');
  $('#maybe-wrap').hidden = !maybe.length;
  $('#results').hidden = false;
  $('#draft-repo').textContent = repo;
  $('#draft-out').innerHTML = '';
  const best = new Map(rows.map((r) => [r.i, r.top[0]]));
  renderSweep(repo, issues, clusters(issues, (i) => best.get(i), LIKELY));
  return `${likely.length} of ${open.length.toLocaleString()} open issues look like an earlier one.`;
}

function renderPrs({ repo, prs, matcher }) {
  const at = new Map(prs.map((p, i) => [p.n, i]));

  // Issues with more than one PR: the first one that fixes it, then every open PR after it.
  const byIssue = new Map();
  for (const s of sameIssue(prs)) {
    if (!byIssue.has(s.issue)) byIssue.set(s.issue, { first: s.by[0], later: [] });
    byIssue.get(s.issue).later.push(s.pr);
  }
  const fixing = [...byIssue].sort((a, b) => b[1].later.length - a[1].later.length || b[0] - a[0]);
  $('#fixing-count').textContent = fixing.length;
  $('#fixing').innerHTML = fixing.map(([issue, { first, later }]) => {
    const p = prs[at.get(first)];
    return `
    <li class="pair likely">
      <p class="fix">Issue <a href="${url(repo, issue)}" target="_blank" rel="noopener">#${issue}</a> ${p.state === 'merged' ? 'was already fixed in' : 'is already being fixed in'} PR #${first}${p.state === 'merged' ? ', which is merged' : ''}.</p>
      ${prLine(repo, p)}
      <p class="looks">also fixing it</p>
      <ol class="matches">${later.sort((a, b) => a - b).map((n) => `<li>${prLine(repo, prs[at.get(n)])}</li>`).join('')}</ol>
      <div class="actions"><button class="copy" data-copy="Duplicate of #${first}">Copy “Duplicate of #${first}”</button></div>
    </li>`;
  }).join('') || '<li class="empty">No issue has more than one open PR fixing it.</li>';

  // PRs whose text looks like an earlier PR's. Pairs already shown above are left out.
  const shares = (a, b) => a.closes?.some((x) => b.closes?.includes(x));
  const open = prs.map((p, i) => [p, i]).filter(([p]) => p.state === 'open');
  const rows = [];
  for (const [p, i] of open) {
    const top = matcher.top(i, Array.from({ length: i }, (_, j) => j), 3).filter(([j]) => !shares(p, prs[j]));
    if (top.length && top[0][1] >= PR_MAYBE) rows.push({ p, top });
  }
  rows.sort((a, b) => b.top[0][1] - a.top[0][1]);
  const likely = rows.filter((r) => r.top[0][1] >= PR_LIKELY);
  const maybe = rows.filter((r) => r.top[0][1] < PR_LIKELY);
  const card = ({ p, top }) => `
    <li class="pair ${top[0][1] >= PR_LIKELY ? 'likely' : 'maybe'}">
      ${prLine(repo, p, 'new')}
      <p class="looks">looks like</p>
      <ol class="matches">${top.filter(([, s], k) => k === 0 || s >= PR_MAYBE).map(([j]) => `<li>${prLine(repo, prs[j])}</li>`).join('')}</ol>
      <div class="actions">
        <button class="copy" data-copy="Duplicate of #${prs[top[0][0]].n}">Copy “Duplicate of #${prs[top[0][0]].n}”</button>
        <a class="small" href="${url(repo, p.n, 'pull')}" target="_blank" rel="noopener">Open PR #${p.n} on GitHub</a>
      </div>
    </li>`;
  $('#pr-likely-count').textContent = likely.length;
  $('#pr-maybe-count').textContent = maybe.length;
  $('#pr-open-count').textContent = open.length.toLocaleString();
  $('#pr-likely').innerHTML = likely.map(card).join('') || '<li class="empty">No open PR looks like an earlier one.</li>';
  $('#pr-maybe').innerHTML = maybe.map(card).join('');
  $('#pr-maybe-wrap').hidden = !maybe.length;
  $('#pr-maybe-wrap').open = !likely.length; // PRs rarely pass the strict line, so show the rest
  $('#results').hidden = true;
  $('#pr-results').hidden = false;
  return `${fixing.length} issues have more than one PR, and ${likely.length} of ${open.length.toLocaleString()} open PRs look like an earlier one.`;
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied. Paste it as a comment.'; } catch { b.textContent = b.dataset.copy; }
});

// ---------- backlog sweep -----------------------------------------------------------------

function renderSweep(repo, issues, groups) {
  sweep = { repo, issues };
  $('#sweep-count').textContent = groups.length;
  $('#clusters').innerHTML = groups.map((g) => {
    const o = issues[g.canonical];
    return `
    <li class="cluster">
      <p class="looks">the original</p>
      ${issueLine(repo, o)}
      <p class="looks">close as duplicates of #${o.n}</p>
      <ul class="members">${g.members.map((m) => `
        <li><input type="checkbox" data-close="${m.i}" data-original="${g.canonical}" aria-label="Close #${issues[m.i].n} as a duplicate of #${o.n}">
          ${issueLine(repo, issues[m.i])}</li>`).join('')}
      </ul>
    </li>`;
  }).join('') || '<li class="empty">No groups of likely duplicates to close.</li>';
  $('#sweep-out').innerHTML = '';
  updateSweep();
}

const ticked = () => [...document.querySelectorAll('[data-close]:checked:not(:disabled)')];

function updateSweep() {
  const n = ticked().length;
  const dry = $('#dry').checked;
  $('#write-wrap').hidden = dry;
  $('#close').disabled = !n;
  $('#close').textContent = dry ? `Show what would be sent for ${n} ticked issue${n === 1 ? '' : 's'}` : `Close ${n} ticked issue${n === 1 ? '' : 's'}`;
}
$('#clusters').addEventListener('change', updateSweep);
$('#dry').addEventListener('change', updateSweep);

const requestText = (r) => `${r.method} ${r.path}\n${JSON.stringify(r.body).replace('"duplicate_issue_id":null', `"duplicate_issue_id": id of #${r.original}, looked up when sent`)}`;

$('#close').addEventListener('click', async () => {
  const boxes = ticked();
  const { repo, issues } = sweep;
  const reqs = closeRequests(repo, boxes.map((c) => ({ issue: issues[+c.dataset.close], original: issues[+c.dataset.original] })));
  const out = $('#sweep-out');
  if ($('#dry').checked) {
    out.innerHTML = `<p class="small">Dry run. Nothing was sent. ${reqs.length === 1 ? 'This request would' : `These ${reqs.length} requests would`} go to api.github.com, one at a time, using GitHub's own close-as-duplicate:</p><pre class="requests">${esc(reqs.map(requestText).join('\n\n'))}</pre>`;
    return;
  }
  const token = $('#write-token').value.trim();
  if (!token) { out.innerHTML = '<p class="verdict maybe">Paste a token with Issues: Read and write first.</p>'; return; }
  if (!confirm(`Close ${reqs.length} issue${reqs.length === 1 ? '' : 's'} on ${repo} as duplicates? This changes ${reqs.length === 1 ? 'it' : 'them'} on GitHub for everyone.`)) return;
  $('#close').disabled = true;
  out.innerHTML = '<ol class="sent"></ol>';
  const results = await send(reqs, {
    token,
    onResult: (r) => {
      out.querySelector('.sent').insertAdjacentHTML('beforeend', r.ok
        ? `<li>Closed <a href="${url(repo, r.issue)}" target="_blank" rel="noopener">#${r.issue}</a> as a duplicate of #${r.original}.</li>`
        : `<li class="failed">#${r.issue} was not closed: ${esc(r.error)}</li>`);
      if (r.ok) boxes.find((c) => issues[+c.dataset.close].n === r.issue).disabled = true;
    },
  });
  const done = results.filter((r) => r.ok).length;
  out.insertAdjacentHTML('beforeend', `<p class="small">${done} of ${reqs.length} closed.${results.length < reqs.length ? ' Stopped early because GitHub refused the token.' : ''}</p>`);
  updateSweep();
});

// ---------- "about to file an issue?" ------------------------------------------------------

$('#check').addEventListener('click', async () => {
  if (!current) return;
  const text = $('#draft').value.trim();
  if (!text) return;
  const [title, ...rest] = text.split('\n');
  const draft = issueText({ title, body: rest.join('\n') }, current.template);
  if (!current.embed) {
    $('#draft-out').innerHTML = '<p class="small">Loading the model (once; it is cached after this)…</p>';
    current.embed = await model.load((p) => { $('#draft-out').innerHTML = `<p class="small">Downloading EmbeddingGemma… ${Math.round(p * 100)}%</p>`; });
  }
  const [body, t] = await current.embed([draft, title.trim()]);
  const top = current.matcher.top({ body, title: t, text: draft }, current.issues.map((_, j) => j), 5);
  const { repo, issues } = current;
  $('#draft-out').innerHTML = top[0][1] >= LIKELY
    ? `<p class="verdict likely">This has very probably been filed already:</p>`
    : top[0][1] >= MAYBE
      ? `<p class="verdict maybe">Possibly filed already. Worth a look before you post:</p>`
      : `<p class="verdict none">Nothing very close among ${issues.length.toLocaleString()} open and recently closed issues. Probably new, but here are the nearest:</p>`;
  $('#draft-out').innerHTML += `<ol class="matches">${top.slice(0, 3).map(([j]) => `<li>${issueLine(repo, issues[j])}</li>`).join('')}</ol>`;
});

// GitHub Pages cannot send the cross-origin isolation headers that let the model use several
// CPU threads, so sw.js adds them. A service worker only takes effect on pages it served, so
// on the very first visit, reload once it is in control.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').then(async () => {
    if (self.crossOriginIsolated) return;
    let tried = false;
    try { tried = sessionStorage.getItem('isolate-reload') === '1'; sessionStorage.setItem('isolate-reload', '1'); } catch { tried = true; }
    if (tried) return;
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) location.reload();
    else navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  }).catch(() => {});
}
