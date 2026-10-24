import { fetchIssues, parseRepo, MAX_ISSUES } from './github.js';
import { issueText, templateLines } from './text.js';
import { Matcher, RECENT_DAYS } from './match.js';
import { LIKELY, MAYBE } from './threshold.js';
import * as model from './model.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STATE = { open: 'open', completed: 'closed', not_planned: 'closed: not planned', duplicate: 'closed as duplicate', reopened: 'open', closed: 'closed' };

$('#size').textContent = `${model.SIZE_MB} MB`;

let current = null; // { repo, issues, matcher, template, embed }

// ---------- input -------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
if (params.get('repo')) $('#repo').value = params.get('repo');
try { const t = sessionStorage.getItem('gh-token'); if (t) $('#token').value = t; } catch {}

document.querySelectorAll('[data-repo]').forEach((b) => b.addEventListener('click', () => {
  $('#repo').value = b.dataset.repo;
  if (b.dataset.snapshot != null) openSnapshot(b.dataset.repo); else run();
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
  history.replaceState(null, '', `?repo=${repo}`);
  try {
    status(`Fetching ${repo}'s open issues, and those closed in the last ${RECENT_DAYS} days, from GitHub…`);
    const { issues, capped } = await fetchIssues(repo, { token, onProgress: (n) => { bar.value = Math.min(0.15, (n / 3000) * 0.15); status(`Fetching issues from GitHub… ${n.toLocaleString()}`); } });
    if (issues.length < 2) throw new Error(`${repo} has ${issues.length ? 'only one open issue' : 'no open issues'} to compare.`);

    status('Loading the model (once; it is cached after this)…');
    const embed = await model.load((p) => { bar.value = 0.15 + p * 0.25; status(`Downloading EmbeddingGemma… ${Math.round(p * 100)}%`); });

    const template = templateLines(issues);
    const texts = issues.map((x) => issueText(x, template));
    const titles = issues.map((x) => x.title.trim());
    const t0 = performance.now();
    const total = texts.length * 1.2; // titles are short: about a fifth of the work
    const body = await embed(texts, (n) => { bar.value = 0.4 + 0.6 * (n / total); status(`Reading every issue on this device… ${n.toLocaleString()} of ${texts.length.toLocaleString()}`); });
    const title = await embed(titles, (n) => { bar.value = 0.4 + 0.6 * ((texts.length + n * 0.2) / total); status('Reading the titles…'); });
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    current = { repo, issues, matcher: new Matcher(body, title, texts), template, embed };
    status('Comparing every open issue with the ones filed before it…');
    await new Promise((r) => setTimeout(r, 30));
    const found = render(current);
    status(`Read ${issues.length.toLocaleString()} issues in ${secs} s on this device (${model.backend() === 'webgpu' ? 'GPU' : 'CPU'}). ${found}${capped ? ` (Stopped at ${MAX_ISSUES.toLocaleString()} issues.)` : ''}`);
  } catch (err) {
    console.error(err);
    status(err.message || String(err));
  } finally {
    $('#go').disabled = false;
    bar.hidden = true;
  }
}

// A repo read in advance by the same model (scripts/snapshot.mjs), so the demo opens instantly.
async function openSnapshot(repo) {
  const key = repo.replace('/', '__');
  status(`Opening a snapshot of ${repo}…`);
  try {
    const [meta, buf] = await Promise.all([
      fetch(`data/snapshots/${key}.json`).then((r) => r.json()),
      fetch(`data/snapshots/${key}.bin`).then((r) => r.arrayBuffer()),
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
    const body = meta.issues.map((_, k) => vec(2 * k));
    const title = meta.issues.map((_, k) => vec(2 * k + 1));
    current = { repo, issues: meta.issues, matcher: new Matcher(body, title, meta.texts), template: new Set(), embed: null };
    status(`Comparing every open issue of ${repo} with the ones filed before it…`);
    await new Promise((r) => setTimeout(r, 30));
    const found = render(current);
    const day = new Date(meta.taken).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    status(`A snapshot of ${repo} taken on ${day}: ${meta.issues.length.toLocaleString()} open and recently closed issues, read in advance by the same model. ${found} Press “Find the duplicates” to read today's issues live.`);
  } catch (err) {
    console.error(err);
    status(`Could not open the snapshot (${err.message}).`);
  }
}

// ---------- results -----------------------------------------------------------------------

const url = (repo, n) => `https://github.com/${repo}/issues/${n}`;
const ago = (iso) => {
  const d = (Date.now() - new Date(iso)) / 86400000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 60) return `${Math.round(d)} days ago`;
  if (d < 730) return `${Math.round(d / 30.4)} months ago`;
  return `${Math.round(d / 365)} years ago`;
};

function issueLine(repo, x, cls = '') {
  return `<a class="issue ${cls}" href="${url(repo, x.n)}" target="_blank" rel="noopener">
    <span class="num">#${x.n}</span> <span class="title">${esc(x.title)}</span>
    <span class="meta">${STATE[x.state] ?? x.state} · ${ago(x.created)}</span></a>`;
}

function render({ repo, issues, matcher }) {
  // Each open issue against every issue filed before it, the same question the tests ask.
  const open = issues.map((x, i) => [x, i]).filter(([x]) => x.state === 'open' || x.state === 'reopened');
  const rows = [];
  for (const [x, i] of open) {
    const top = matcher.top(i, Array.from({ length: i }, (_, j) => j), 3);
    if (top.length && top[0][1] >= MAYBE) rows.push({ x, top });
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
  return `${likely.length} of ${open.length.toLocaleString()} open issues look like an earlier one.`;
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied. Paste it as a comment.'; } catch { b.textContent = b.dataset.copy; }
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
