#!/usr/bin/env node
/*
 * Entry-level change log for scratch.mit.edu.txt.
 *
 * Usage: node diff-list.js <old.txt> <new.txt> [summary-line-out.txt]
 *
 * 1. Every entry in the OLD file is checked: unchanged, edited in place,
 *    moved to a different number (possibly edited too), or removed.
 * 2. Every entry in the NEW file that was not matched to an old one is ADDED.
 *
 * A renumbering is reported once ("1.5 X moved to 2.7 X"), never as a removal
 * plus an addition. Prints a plain-text log and appends a Markdown version to
 * $GITHUB_STEP_SUMMARY when run in GitHub Actions.
 *
 * The entry splitting mirrors parseSuggestions() in script.js.
 */
const fs = require('fs');

const [oldPath, newPath, summaryOut] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error('Usage: node diff-list.js <old.txt> <new.txt> [summary-line-out.txt]');
  process.exit(2);
}

/* ---------------------------- parsing ---------------------------- */
function strip(text) {
  return text
    .replace(/\[scratchblocks\][\s\S]*?\[\/scratchblocks\]/g, '')
    .replace(/\[url(?:=[^\]]*)?\]/gi, '').replace(/\[\/url\]/gi, '')
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, '')
    .replace(/\[\/?(b|i|u|small)\]/gi, '')
    .replace(/\[color=[^\]]*\]/gi, '').replace(/\[\/color\]/gi, '')
    .replace(/\s+/g, ' ').trim();
}

function parse(file) {
  let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\n*\[URL's content end\]\s*$/, '');
  const start = text.indexOf('THE REJECTED SUGGESTIONS');
  if (start === -1) return { entries: [], outside: text };
  const rel = text.slice(start);
  const re = /\[b\](\d+\.\d+)\s+([\s\S]*?)\[\/b\]/g;
  const hs = [];
  let m;
  while ((m = re.exec(rel)) !== null) hs.push({ id: m[1], title: strip(m[2].trim()), at: m.index, len: m[0].length });
  const entries = hs.map((h, i) => {
    const end = i + 1 < hs.length ? hs[i + 1].at : rel.length;
    const raw = rel.slice(h.at, end).trimEnd().replace(/\s+\[big\]\[b\]\[u\][\s\S]*$/i, '').trimEnd();
    const body = raw.slice(h.len).trim();
    const words = (s) => { const mp = new Map(); for (const w of s.toLowerCase().split(/\s+/).filter(Boolean)) mp.set(w, (mp.get(w) || 0) + 1); return mp; };
    return {
      id: h.id, title: h.title, body, raw,
      head: raw.slice(0, h.len).replace(/^\[b\]\d+\.\d+\s*/, '').replace(/\[\/b\]$/, '').trim(),
      // identity of the content, independent of its number and of whitespace
      key: raw.replace(/^\[b\]\d+\.\d+/, '').replace(/\s+/g, ' ').trim(),
      tw: words(h.title), bw: words(strip(body)),
    };
  });
  return { entries, outside: text.slice(0, start) };
}

const idKey = (id) => id.split('.').map((n) => n.padStart(6, '0')).join('.');
const byId = (a, b) => (idKey(a.id) < idKey(b.id) ? -1 : idKey(a.id) > idKey(b.id) ? 1 : 0);
const label = (e) => `${e.id} ${e.title}`;

/* --------------------------- matching ---------------------------- */
function dice(A, B) {
  let na = 0, nb = 0, common = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  for (const [w, c] of A) { const d = B.get(w); if (d) common += Math.min(c, d); }
  return (2 * common) / (na + nb);
}
const score = (o, n) => 0.4 * dice(o.tw, n.tw) + 0.6 * dice(o.bw, n.bw);

const OLD = parse(oldPath), NEW = parse(newPath);
const pairs = []; // {o, n, kind: 'same'|'moved'|'edited'|'moved+edited'}
const oldLeft = new Set(OLD.entries), newLeft = new Set(NEW.entries);

// 1) same number, same content -> unchanged (consume both)
const newById = new Map();
for (const n of NEW.entries) { if (!newById.has(n.id)) newById.set(n.id, []); newById.get(n.id).push(n); }
for (const o of OLD.entries) {
  const n = (newById.get(o.id) || []).find((x) => newLeft.has(x) && x.key === o.key);
  if (n) { oldLeft.delete(o); newLeft.delete(n); }
}

// 2) identical content under a different number -> moved
const newByKey = new Map();
for (const n of NEW.entries) if (newLeft.has(n)) { if (!newByKey.has(n.key)) newByKey.set(n.key, []); newByKey.get(n.key).push(n); }
for (const o of OLD.entries) {
  if (!oldLeft.has(o)) continue;
  const n = (newByKey.get(o.key) || []).find((x) => newLeft.has(x));
  if (n) { pairs.push({ o, n, kind: 'moved' }); oldLeft.delete(o); newLeft.delete(n); }
}

// 3) what is left: best similarity first. An edit in place (same number) needs
//    less similarity than an edit + move, because the number itself is evidence.
const cand = [];
for (const o of oldLeft) for (const n of newLeft) {
  const s = score(o, n);
  if (s >= 0.6 || (o.id === n.id && s >= 0.3)) cand.push({ o, n, s });
}
cand.sort((a, b) => b.s - a.s || (a.o.id === a.n.id ? -1 : 1));
for (const c of cand) {
  if (!oldLeft.has(c.o) || !newLeft.has(c.n)) continue;
  pairs.push({ o: c.o, n: c.n, kind: c.o.id === c.n.id ? 'edited' : 'moved+edited' });
  oldLeft.delete(c.o); newLeft.delete(c.n);
}

const removed = [...oldLeft].sort(byId);
const added = [...newLeft].sort(byId);
const moved = pairs.filter((p) => p.kind === 'moved' || p.kind === 'moved+edited').sort((a, b) => byId(a.o, b.o));
const edited = pairs.filter((p) => p.kind === 'edited').sort((a, b) => byId(a.o, b.o));
const movedEdited = moved.filter((p) => p.kind === 'moved+edited').length;
const headerChanged = OLD.outside.replace(/\s+/g, ' ').trim() !== NEW.outside.replace(/\s+/g, ' ').trim();

/* ----------------------- before/after of an edit ----------------------- */
function lcsDiff(A, B) {
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: '=', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: A[i++] });
    else out.push({ t: '+', s: B[j++] });
  }
  while (i < n) out.push({ t: '-', s: A[i++] });
  while (j < m) out.push({ t: '+', s: B[j++] });
  return out;
}

// git --word-diff style for one edited line, long unchanged stretches shortened
function wordDiff(a, b) {
  const tok = (t) => t.split(/(\s+)/).filter(Boolean);
  const parts = [];
  for (const x of lcsDiff(tok(a), tok(b))) {
    const last = parts[parts.length - 1];
    if (last && last.t === x.t) last.s += x.s; else parts.push({ t: x.t, s: x.s });
  }
  const CTX = 35;
  return parts.map((p, k) => {
    if (p.t === '-') return '[-' + p.s + '-]';
    if (p.t === '+') return '{+' + p.s + '+}';
    if (p.s.length <= CTX * 2 + 10) return p.s;
    return (k === 0 ? '' : p.s.slice(0, CTX)) + ' ... ' + (k === parts.length - 1 ? '' : p.s.slice(-CTX));
  }).join('');
}

// Only the lines that differ; an edited line (one - then one +) also gets a word diff.
function changeLines(oldText, newText) {
  const d = lcsDiff(oldText.split('\n').map((l) => l.trimEnd()), newText.split('\n').map((l) => l.trimEnd()));
  const out = [];
  d.forEach((x, i) => {
    if (x.t === '=') return;
    if (x.t === '-' && x.s.trim() === '' ) return;   // ignore blank-line churn
    if (x.t === '+' && x.s.trim() === '') return;
    out.push(x.t + ' ' + x.s);
    if (x.t === '+' && d[i - 1] && d[i - 1].t === '-' && (!d[i - 2] || d[i - 2].t !== '-') && (!d[i + 1] || d[i + 1].t !== '+'))
      out.push('~ ' + wordDiff(d[i - 1].s, x.s));
  });
  return out;
}

function editDetail(p) {
  const lines = [];
  if (p.o.title !== p.n.title) {
    lines.push('- title: ' + p.o.title, '+ title: ' + p.n.title);
  } else if (p.o.head.replace(/\s+/g, ' ') !== p.n.head.replace(/\s+/g, ' ')) {
    // same visible title, but its link/formatting markup changed
    lines.push('- title markup: ' + p.o.head, '+ title markup: ' + p.n.head);
  }
  lines.push(...changeLines(p.o.body, p.n.body));
  return lines.length ? lines : ['(markup changed, no visible text difference)'];
}

/* ----------------------------- output ----------------------------- */
const parts = [`${added.length} added`, `${removed.length} removed`, `${edited.length} changed`, `${moved.length} moved`];
let line = parts.join(', ') + (movedEdited ? ` (${movedEdited} of the moved also edited)` : '') + (headerChanged ? ', header text changed' : '');
if (!added.length && !removed.length && !edited.length && !moved.length && !headerChanged)
  line = 'no entry changes (whitespace/formatting only)';

const out = [], md = [];
out.push(`Entries before: ${OLD.entries.length}   Entries after: ${NEW.entries.length}`);
out.push(`Summary: ${line}`);
md.push('## TOLORS list update', '', `**${line}**  (entries: ${OLD.entries.length} → ${NEW.entries.length})`, '');

function section(title, items, fmt) {
  if (!items.length) return;
  out.push('', `${title} (${items.length})`);
  md.push(`### ${title} (${items.length})`, '');
  for (const it of items) { const r = fmt(it); out.push(...r.log); md.push(...r.md); }
  md.push('');
}
const indent = (ls, n = 6) => ls.map((l) => ' '.repeat(n) + l);
const diffBlock = (ls) => ['', '  ```diff', ...ls.map((l) => '  ' + l), '  ```', ''];

section('REMOVED', removed, (e) => ({ log: [`  - ${label(e)}`], md: [`- 🟥 **${e.id}** ${esc(e.title)}`] }));

section('MOVED', moved, (p) => {
  const edit = p.kind === 'moved+edited' ? editDetail(p) : [];
  return {
    log: [`  ${label(p.o)}  ->  moved to  ${label(p.n)}${edit.length ? '  (also edited)' : ''}`, ...indent(edit)],
    md: [`- 🟦 **${p.o.id}** ${esc(p.o.title)} → moved to **${p.n.id}** ${esc(p.n.title)}${edit.length ? ' *(also edited)*' : ''}`, ...(edit.length ? diffBlock(edit) : [])],
  };
});

section('CHANGED', edited, (p) => {
  const edit = editDetail(p);
  return {
    log: [`  ~ ${label(p.n)}`, ...indent(edit)],
    md: [`- 🟨 **${p.n.id}** ${esc(p.n.title)}`, ...diffBlock(edit)],
  };
});

section('ADDED', added, (e) => ({ log: [`  + ${label(e)}`], md: [`- 🟩 **${e.id}** ${esc(e.title)}`] }));

if (headerChanged) {
  const d = changeLines(OLD.outside, NEW.outside);
  out.push('', 'HEADER / INTRO TEXT (above the entries) CHANGED', ...indent(d, 2));
  md.push('### Header / intro text changed', '', '```diff', ...d, '```', '');
}
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

console.log(out.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
if (summaryOut) fs.writeFileSync(summaryOut, line);
