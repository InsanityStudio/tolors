#!/usr/bin/env node
/*
 * Side-by-side diff of scratch.mit.edu.txt (before vs after), text-compare style:
 *   red    = removed (left only)
 *   green  = added   (right only)
 *   yellow = changed (both sides, changed words highlighted)
 *
 * Usage: node diff-list.js <old.txt> <new.txt> [summary-line-out.txt] [report.html-out]
 *
 *  - Prints the side-by-side view to the log with ANSI colours. Unchanged stretches
 *    are collapsed into expandable ::group:: blocks, so the whole file is still there.
 *  - Optionally writes a standalone HTML version (same view, much nicer to read).
 *  - Appends a short note to $GITHUB_STEP_SUMMARY when running in Actions.
 *
 * Env: DIFF_COL_WIDTH (default 64) = characters per column in the log view.
 */
const fs = require('fs');

const [oldPath, newPath, summaryOut, htmlOut] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error('Usage: node diff-list.js <old.txt> <new.txt> [summary-line-out.txt] [report.html-out]');
  process.exit(2);
}

const W = Math.max(20, parseInt(process.env.DIFF_COL_WIDTH, 10) || 64);
const CTX = 2; // unchanged rows kept visible around each change

const readLines = (f) =>
  fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '  ').split('\n');

/* ------------------------------------------------------------------
   Entry-level counts (only used for the one-line summary / commit msg).
   Mirrors parseSuggestions() in script.js.
   ------------------------------------------------------------------ */
function entriesOf(file) {
  let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\n*\[URL's content end\]\s*$/, '');
  const start = text.indexOf('THE REJECTED SUGGESTIONS');
  const map = new Map();
  if (start === -1) return { map, outside: text };
  const rel = text.slice(start);
  const re = /\[b\](\d+\.\d+)\s+([\s\S]*?)\[\/b\]/g;
  const hs = [];
  let m;
  while ((m = re.exec(rel)) !== null) hs.push({ id: m[1], at: m.index, len: m[0].length });
  hs.forEach((h, i) => {
    const end = i + 1 < hs.length ? hs[i + 1].at : rel.length;
    const raw = rel.slice(h.at, end).trimEnd().replace(/\s+\[big\]\[b\]\[u\][\s\S]*$/i, '').trimEnd();
    map.set(h.id, raw);
  });
  return { map, outside: text.slice(0, start) };
}

function summaryLine() {
  const O = entriesOf(oldPath), N = entriesOf(newPath);
  let added = [], removed = [], modified = 0, renumbered = 0;
  for (const [id, raw] of N.map) if (!O.map.has(id)) added.push(raw);
  for (const [id, raw] of O.map) if (!N.map.has(id)) removed.push(raw);
  for (const [id, raw] of N.map) if (O.map.has(id) && O.map.get(id) !== raw) modified++;
  const sid = (r) => r.replace(/^\[b\]\d+\.\d+/, '[b]');
  for (let i = removed.length - 1; i >= 0; i--) {
    const k = added.findIndex((a) => sid(a) === sid(removed[i]));
    if (k !== -1) { renumbered++; removed.splice(i, 1); added.splice(k, 1); }
  }
  const parts = `${added.length} added, ${removed.length} removed, ${modified} modified, ${renumbered} renumbered`;
  const hdr = O.outside !== N.outside ? ', header text changed' : '';
  const none = !added.length && !removed.length && !modified && !renumbered && !hdr;
  return none ? 'no entry changes (whitespace/formatting only)' : parts + hdr;
}

/* ------------------------------------------------------------------
   Line diff (prefix/suffix trimmed, then LCS) -> ops
   ------------------------------------------------------------------ */
function lineOps(A, B) {
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const a = A.slice(p, A.length - s), b = B.slice(p, B.length - s);
  const ops = [];
  for (let i = 0; i < p; i++) ops.push({ t: '=', a: i, b: i });

  const n = a.length, m = b.length;
  if (n * m > 25e6) {                                   // pathological: treat middle as replaced
    for (let i = 0; i < n; i++) ops.push({ t: '-', a: p + i });
    for (let j = 0; j < m; j++) ops.push({ t: '+', b: p + j });
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ t: '=', a: p + i, b: p + j }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: '-', a: p + i++ });
      else ops.push({ t: '+', b: p + j++ });
    }
    while (i < n) ops.push({ t: '-', a: p + i++ });
    while (j < m) ops.push({ t: '+', b: p + j++ });
  }
  for (let k = 0; k < s; k++) ops.push({ t: '=', a: A.length - s + k, b: B.length - s + k });
  return ops;
}

const toks = (x) => x.toLowerCase().split(/\s+/).filter(Boolean);
function similarity(x, y) {
  const A = toks(x), B = toks(y);
  if (!A.length || !B.length) return 0;
  const set = new Map();
  for (const w of A) set.set(w, (set.get(w) || 0) + 1);
  let common = 0;
  for (const w of B) { const c = set.get(w); if (c) { common++; set.set(w, c - 1); } }
  return (2 * common) / (A.length + B.length);
}

// Pair removed lines with added lines that are similar enough => "changed" rows.
function alignBlock(dels, adds, A, B) {
  const n = dels.length, m = adds.length, rows = [];
  if (!n || !m || n * m > 250000) {
    const k = n * m > 250000 ? Math.min(n, m) : 0;
    for (let i = 0; i < k; i++) rows.push({ k: '~', a: dels[i], b: adds[i] });
    for (let i = k; i < n; i++) rows.push({ k: '-', a: dels[i] });
    for (let j = k; j < m; j++) rows.push({ k: '+', b: adds[j] });
    return rows;
  }
  const sim = (i, j) => { const v = similarity(A[dels[i]], B[adds[j]]); return v >= 0.5 ? v : 0; };
  const f = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      let best = Math.max(f[i + 1][j], f[i][j + 1]);
      const sv = sim(i, j);
      if (sv > 0) best = Math.max(best, sv + f[i + 1][j + 1]);
      f[i][j] = best;
    }
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m) {
      const sv = sim(i, j);
      if (sv > 0 && Math.abs(f[i][j] - (sv + f[i + 1][j + 1])) < 1e-9) { rows.push({ k: '~', a: dels[i], b: adds[j] }); i++; j++; continue; }
    }
    if (i < n && (j >= m || f[i][j] === f[i + 1][j])) rows.push({ k: '-', a: dels[i++] });
    else rows.push({ k: '+', b: adds[j++] });
  }
  return rows;
}

function buildRows(A, B) {
  const ops = lineOps(A, B), rows = [];
  for (let x = 0; x < ops.length;) {
    if (ops[x].t === '=') { rows.push({ k: '=', a: ops[x].a, b: ops[x].b }); x++; continue; }
    const dels = [], adds = [];
    while (x < ops.length && ops[x].t !== '=') { (ops[x].t === '-' ? dels : adds).push(ops[x].t === '-' ? ops[x].a : ops[x].b); x++; }
    rows.push(...alignBlock(dels, adds, A, B));
  }
  return rows;
}

/* ------------------------------------------------------------------
   Word-level flags for a changed pair (1 = differs)
   ------------------------------------------------------------------ */
function wordFlags(a, b) {
  const split = (t) => { const out = []; let o = 0; for (const s of t.split(/(\s+)/).filter(Boolean)) { out.push({ s, o }); o += s.length; } return out; };
  const TA = split(a), TB = split(b), n = TA.length, m = TB.length;
  const fa = new Uint8Array(a.length), fb = new Uint8Array(b.length);
  if (n * m > 4e6) { fa.fill(1); fb.fill(1); return { fa, fb }; }
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = TA[i].s === TB[j].s ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const mark = (f, t) => f.fill(1, t.o, t.o + t.s.length);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (TA[i].s === TB[j].s) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) mark(fa, TA[i++]);
    else mark(fb, TB[j++]);
  }
  while (i < n) mark(fa, TA[i++]);
  while (j < m) mark(fb, TB[j++]);
  return { fa, fb };
}

/* ------------------------------------------------------------------
   Log rendering (ANSI)
   ------------------------------------------------------------------ */
const RESET = '\x1b[0m', INV = '\x1b[7m', NOINV = '\x1b[27m', DIM = '\x1b[2m';
const FG = { '-': '\x1b[31m', '+': '\x1b[32m', '~': '\x1b[33m', '=': '' };

function wrapRanges(t, w) {
  const out = [];
  let pos = 0;
  if (!t.length) return [[0, 0]];
  while (pos < t.length) {
    let end = Math.min(pos + w, t.length);
    if (end < t.length) {
      const sp = t.lastIndexOf(' ', end);
      if (sp > pos) end = sp;
    }
    out.push([pos, end]);
    pos = end;
    while (pos < t.length && t[pos] === ' ') pos++;
  }
  return out;
}

function piece(text, flags, [s, e], fg) {
  let out = '';
  let i = s;
  while (i < e) {
    let j = i;
    const f = flags ? flags[i] : 0;
    while (j < e && (flags ? flags[j] : 0) === f) j++;
    out += f ? INV + text.slice(i, j) + NOINV : text.slice(i, j);
    i = j;
  }
  return (fg ? fg + out + RESET : out) + ' '.repeat(Math.max(0, W - (e - s)));
}

const num = (n) => (n == null ? '    ' : String(n + 1).padStart(4));

function renderRow(row, A, B) {
  const L = row.a != null ? A[row.a] : null, R = row.b != null ? B[row.b] : null;
  let fl = null, fr = null;
  if (row.k === '~') ({ fa: fl, fb: fr } = wordFlags(L, R));
  const wl = L == null ? [] : wrapRanges(L, W), wr = R == null ? [] : wrapRanges(R, W);
  const h = Math.max(wl.length, wr.length, 1);
  const lines = [];
  for (let k = 0; k < h; k++) {
    const first = k === 0;
    const mk = (side) => FG[row.k] ? FG[row.k] + (first ? side : ' ') + RESET : ' ';
    const left = L == null || !wl[k]
      ? ' '.repeat(W)
      : piece(L, fl, wl[k], FG[row.k === '=' ? '=' : (row.k === '+' ? '=' : row.k)]);
    const right = R == null || !wr[k]
      ? ' '.repeat(W)
      : piece(R, fr, wr[k], FG[row.k === '-' ? '=' : row.k]);
    const lm = row.k === '=' ? ' ' : (row.a != null ? mk(row.k === '~' ? '~' : '-') : ' ');
    const rm = row.k === '=' ? ' ' : (row.b != null ? mk(row.k === '~' ? '~' : '+') : ' ');
    lines.push(`${DIM}${first ? num(row.a) : '    '}${RESET} ${lm} ${left} ${DIM}│${RESET} ${DIM}${first ? num(row.b) : '    '}${RESET} ${rm} ${right}`.replace(/\s+$/, ''));
  }
  return lines;
}

function renderLog(rows, A, B) {
  const out = [];
  const colW = 7 + W + 3 + 7 + W;
  out.push(' '.repeat(7) + 'BEFORE (committed)'.padEnd(W + 10) + 'AFTER (just fetched)');
  out.push(`${FG['-']}red = removed${RESET}   ${FG['+']}green = added${RESET}   ${FG['~']}yellow = changed (changed words highlighted)${RESET}   ${DIM}unchanged lines are collapsed: expand a group to see them${RESET}`);
  out.push('-'.repeat(colW));

  // split into [changed-neighbourhood | long unchanged run]
  const changedIdx = rows.map((r) => r.k !== '=');
  const keep = new Array(rows.length).fill(false);
  changedIdx.forEach((c, i) => { if (c) for (let k = Math.max(0, i - CTX); k <= Math.min(rows.length - 1, i + CTX); k++) keep[k] = true; });

  let i = 0;
  while (i < rows.length) {
    if (keep[i]) { out.push(...renderRow(rows[i], A, B)); i++; continue; }
    let j = i;
    while (j < rows.length && !keep[j]) j++;
    out.push(`::group::${j - i} unchanged line${j - i === 1 ? '' : 's'} (lines ${rows[i].a + 1}-${rows[j - 1].a + 1} before / ${rows[i].b + 1}-${rows[j - 1].b + 1} after)`);
    for (let k = i; k < j; k++) out.push(...renderRow(rows[k], A, B));
    out.push('::endgroup::');
    i = j;
  }
  return out;
}

/* ------------------------------------------------------------------
   HTML report
   ------------------------------------------------------------------ */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function htmlText(text, flags) {
  if (!flags) return esc(text);
  let out = '', i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && flags[j] === flags[i]) j++;
    out += flags[i] ? '<mark>' + esc(text.slice(i, j)) + '</mark>' : esc(text.slice(i, j));
    i = j;
  }
  return out;
}

function renderHtml(rows, A, B, line) {
  const cell = (side, n, text, flags, cls) =>
    `<div class="c ${cls}"><span class="n">${n == null ? '' : n + 1}</span><span class="t">${text == null ? '' : htmlText(text, flags) || '&nbsp;'}</span></div>`;
  const rowHtml = (r) => {
    const L = r.a != null ? A[r.a] : null, R = r.b != null ? B[r.b] : null;
    let fl = null, fr = null;
    if (r.k === '~') ({ fa: fl, fb: fr } = wordFlags(L, R));
    const lc = r.k === '-' ? 'del' : r.k === '~' ? 'chg' : L == null ? 'gap' : '';
    const rc = r.k === '+' ? 'add' : r.k === '~' ? 'chg' : R == null ? 'gap' : '';
    return `<div class="r">${cell('l', r.a, L, fl, lc)}${cell('r', r.b, R, fr, rc)}</div>`;
  };
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => { if (r.k !== '=') for (let k = Math.max(0, i - CTX); k <= Math.min(rows.length - 1, i + CTX); k++) keep[k] = true; });
  let body = '';
  for (let i = 0; i < rows.length;) {
    if (keep[i]) { body += rowHtml(rows[i]); i++; continue; }
    let j = i;
    while (j < rows.length && !keep[j]) j++;
    body += `<details><summary>${j - i} unchanged line${j - i === 1 ? '' : 's'}</summary>${rows.slice(i, j).map(rowHtml).join('')}</details>`;
    i = j;
  }
  const cnt = (k) => rows.filter((r) => r.k === k).length;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TOLORS list: before vs after</title><style>
:root{--bg:#fff;--fg:#1f2328;--mut:#656d76;--bd:#d0d7de;--del:#ffd7d5;--delw:#ff9c97;--add:#ccf3d6;--addw:#7fdc97;--chg:#fff4b8;--chgw:#ffd84d;--gap:#f6f8fa}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--bd:#30363d;--del:#4a1f22;--delw:#8e2f35;--add:#173a24;--addw:#2a7a45;--chg:#4b3f10;--chgw:#8a7416;--gap:#161b22}}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--bd);padding:10px 14px;z-index:2}
h1{font:600 15px system-ui,sans-serif;margin:0 0 4px}.sum{color:var(--mut);font:13px system-ui,sans-serif}
.key span{display:inline-block;padding:1px 8px;border-radius:3px;margin-right:6px;color:var(--fg)}
.heads,.r{display:grid;grid-template-columns:1fr 1fr}.heads div{padding:6px 14px;font:600 12px system-ui,sans-serif;color:var(--mut);border-bottom:1px solid var(--bd)}
.c{display:flex;min-width:0;border-bottom:1px solid transparent}.c+.c{border-left:1px solid var(--bd)}
.n{flex:0 0 48px;text-align:right;padding:0 8px;color:var(--mut);user-select:none}.t{flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;padding-right:8px}
.del{background:var(--del)}.del mark{background:var(--delw)}.add{background:var(--add)}.add mark{background:var(--addw)}
.chg{background:var(--chg)}.chg mark{background:var(--chgw)}.gap{background:var(--gap)}mark{color:inherit;border-radius:2px}
details{border-top:1px dashed var(--bd);border-bottom:1px dashed var(--bd)}summary{cursor:pointer;color:var(--mut);padding:3px 14px;font:12px system-ui,sans-serif;background:var(--gap)}
</style></head><body><header><h1>TOLORS list: before vs after</h1>
<div class="sum">${esc(line)} &nbsp;·&nbsp; ${cnt('-')} line(s) removed, ${cnt('+')} added, ${cnt('~')} changed</div>
<div class="key sum" style="margin-top:6px"><span style="background:var(--del)">removed</span><span style="background:var(--add)">added</span><span style="background:var(--chg)">changed</span></div></header>
<div class="heads"><div>BEFORE (committed)</div><div>AFTER (just fetched)</div></div>${body}</body></html>`;
}

/* ------------------------------------------------------------------ */
const A = readLines(oldPath), B = readLines(newPath);
const rows = buildRows(A, B);
const line = summaryLine();
const nDel = rows.filter((r) => r.k === '-').length, nAdd = rows.filter((r) => r.k === '+').length, nChg = rows.filter((r) => r.k === '~').length;

console.log(`Result: ${line}`);
console.log(`Lines: ${A.length} before, ${B.length} after  (${nDel} removed, ${nAdd} added, ${nChg} changed)`);
console.log('');
if (nDel + nAdd + nChg === 0) console.log('Files are identical line-for-line (difference is only in line endings or trailing whitespace).');
else console.log(renderLog(rows, A, B).join('\n'));

if (htmlOut) fs.writeFileSync(htmlOut, renderHtml(rows, A, B, line));
if (summaryOut) fs.writeFileSync(summaryOut, line);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## TOLORS list update\n\n**${line}**\n\n` +
    `${nDel} line(s) removed 🟥 · ${nAdd} added 🟩 · ${nChg} changed 🟨\n\n` +
    `The side-by-side comparison is in the **Log what changed** step's log` +
    (htmlOut ? ', and as a downloadable HTML report in this run\'s Artifacts.\n' : '.\n'));
}
