#!/usr/bin/env node
/*
 * Compares two versions of scratch.mit.edu.txt entry-by-entry and prints what
 * changed (added / removed / renumbered / modified, with before vs after).
 *
 * Usage: node diff-list.js <old.txt> <new.txt> [summary-line-out.txt]
 *
 * Also appends a Markdown report to $GITHUB_STEP_SUMMARY when running in Actions.
 *
 * NOTE: the entry splitting below mirrors parseSuggestions() in script.js, so an
 * "entry" here is exactly the block the website shows and copies.
 */
const fs = require('fs');

const [oldPath, newPath, summaryOut] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error('Usage: node diff-list.js <old.txt> <new.txt> [summary-line-out.txt]');
  process.exit(2);
}

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
  if (start === -1) return { entries: new Map(), outside: text };
  const outside = text.slice(0, start);
  const rel = text.slice(start);
  const re = /\[b\](\d+\.\d+)\s+([\s\S]*?)\[\/b\]/g;
  const hs = [];
  let m;
  while ((m = re.exec(rel)) !== null) {
    hs.push({ id: m[1], title: strip(m[2].trim()), at: m.index, len: m[0].length });
  }
  const entries = new Map();
  hs.forEach((h, i) => {
    const end = i + 1 < hs.length ? hs[i + 1].at : rel.length;
    let raw = rel.slice(h.at, end).trimEnd();
    raw = raw.replace(/\s+\[big\]\[b\]\[u\][\s\S]*$/i, '').trimEnd();
    const body = raw.slice(h.len).trim();
    entries.set(h.id, { id: h.id, title: h.title, body, raw });
  });
  return { entries, outside };
}

// Plain LCS line diff -> array of {t:' '|'-'|'+', s}
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: A[i++] });
    else out.push({ t: '+', s: B[j++] });
  }
  while (i < n) out.push({ t: '-', s: A[i++] });
  while (j < m) out.push({ t: '+', s: B[j++] });
  return out;
}

// Word-level diff of one changed line, git --word-diff style: [-old-]{+new+},
// with long unchanged stretches collapsed so a one-word edit in a long paragraph is easy to spot.
function wordDiff(a, b) {
  const A = a.split(/(\s+)/).filter(Boolean), B = b.split(/(\s+)/).filter(Boolean);
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const parts = []; // {t:'=',s} | {t:'-',s} | {t:'+',s}
  const push = (t, s) => {
    const last = parts[parts.length - 1];
    if (last && last.t === t) last.s += s; else parts.push({ t, s });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('=', A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push('-', A[i++]);
    else push('+', B[j++]);
  }
  while (i < n) push('-', A[i++]);
  while (j < m) push('+', B[j++]);
  const CTX = 40; // chars of unchanged text kept on each side of a change
  return parts.map((p, k) => {
    if (p.t === '-') return '[-' + p.s + '-]';
    if (p.t === '+') return '{+' + p.s + '+}';
    const first = k === 0, last = k === parts.length - 1;
    if (p.s.length <= CTX * 2 + 10) return p.s;
    return (first ? '' : p.s.slice(0, CTX)) + ' ... ' + (last ? '' : p.s.slice(-CTX));
  }).join('');
}

// Only the changed lines plus 1 line of context, "..." between far-apart hunks.
function renderDiff(d) {
  const keep = new Array(d.length).fill(false);
  d.forEach((x, i) => {
    if (x.t !== ' ') for (let k = Math.max(0, i - 1); k <= Math.min(d.length - 1, i + 1); k++) keep[k] = true;
  });
  const lines = [];
  let skipped = false;
  d.forEach((x, i) => {
    if (!keep[i]) { skipped = true; return; }
    if (skipped && lines.length) lines.push('  ...');
    skipped = false;
    lines.push(x.t + ' ' + x.s);
    // A single removed line directly followed by a single added line = an edited line.
    if (x.t === '+' && i > 0 && d[i - 1].t === '-' && (i < 2 || d[i - 2].t !== '-') && (i + 1 >= d.length || d[i + 1].t !== '+')) {
      lines.push('  ~ ' + wordDiff(d[i - 1].s, x.s));
    }
  });
  return lines.join('\n');
}

const oldP = parse(oldPath), newP = parse(newPath);
const O = oldP.entries, N = newP.entries;

const added = [], removed = [], modified = [], renumbered = [];
for (const [id, n] of N) if (!O.has(id)) added.push(n);
for (const [id, o] of O) if (!N.has(id)) removed.push(o);
for (const [id, n] of N) {
  const o = O.get(id);
  if (o && o.raw !== n.raw) modified.push({ id, o, n });
}

// Pair removed+added entries with identical content under a new number => renumbered, not add/remove.
const stripId = (e) => e.raw.replace(/^\[b\]\d+\.\d+/, '[b]');
for (let i = removed.length - 1; i >= 0; i--) {
  const k = added.findIndex((a) => stripId(a) === stripId(removed[i]));
  if (k !== -1) {
    renumbered.push({ from: removed[i], to: added[k] });
    removed.splice(i, 1);
    added.splice(k, 1);
  }
}
renumbered.reverse();

const outsideChanged = oldP.outside !== newP.outside;
const total = added.length + removed.length + modified.length + renumbered.length;
const oneLine = total === 0 && !outsideChanged
  ? 'no entry changes (whitespace/formatting only)'
  : `${added.length} added, ${removed.length} removed, ${modified.length} modified, ${renumbered.length} renumbered` +
    (outsideChanged ? ', header/intro text changed' : '');

const out = [];       // console log
const md = [];        // step summary (markdown)
const say = (l = '') => { out.push(l); };

say(`Entries before: ${O.size}   Entries after: ${N.size}`);
say(`Result: ${oneLine}`);
md.push('## TOLORS list update', '', `**${oneLine}**  (entries: ${O.size} → ${N.size})`, '');

function section(title, items, fmt) {
  if (!items.length) return;
  say(); say(`::group::${title} (${items.length})`);
  md.push(`### ${title} (${items.length})`, '');
  for (const it of items) { const r = fmt(it); say(r.log); md.push(r.md, ''); }
  say('::endgroup::');
}

section('ADDED', added, (e) => ({
  log: `+ ${e.id}  ${e.title}\n${e.body.split('\n').map((l) => '+   ' + l).join('\n')}`,
  md: `<details><summary><b>${e.id}</b> ${esc(e.title)}</summary>\n\n\`\`\`diff\n${e.body.split('\n').map((l) => '+ ' + l).join('\n')}\n\`\`\`\n</details>`,
}));

section('REMOVED', removed, (e) => ({
  log: `- ${e.id}  ${e.title}\n${e.body.split('\n').map((l) => '-   ' + l).join('\n')}`,
  md: `<details><summary><b>${e.id}</b> ${esc(e.title)}</summary>\n\n\`\`\`diff\n${e.body.split('\n').map((l) => '- ' + l).join('\n')}\n\`\`\`\n</details>`,
}));

section('RENUMBERED (content unchanged)', renumbered, (r) => ({
  log: `~ ${r.from.id} -> ${r.to.id}  ${r.to.title}`,
  md: `- **${r.from.id} → ${r.to.id}** ${esc(r.to.title)}`,
}));

section('MODIFIED (before vs after)', modified, ({ id, o, n }) => {
  const titleLine = o.title === n.title
    ? `  title: ${n.title}`
    : `  title before: ${o.title}\n  title after:  ${n.title}`;
  const body = renderDiff(lineDiff(o.body, n.body));
  return {
    log: `* ${id}\n${titleLine}\n${body.split('\n').map((l) => '  ' + l).join('\n')}`,
    md: `<details open><summary><b>${id}</b> ${esc(n.title)}</summary>\n\n` +
        (o.title === n.title ? '' : `Title: \`${o.title}\` → \`${n.title}\`\n\n`) +
        `\`\`\`diff\n${body}\n\`\`\`\n</details>`,
  };
});

if (outsideChanged) {
  say(); say('::group::HEADER / INTRO TEXT (before the entries) changed');
  const d = renderDiff(lineDiff(oldP.outside, newP.outside));
  say(d); say('::endgroup::');
  md.push('### Header / intro text changed', '', '```diff', d, '```', '');
}

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

console.log(out.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
if (summaryOut) fs.writeFileSync(summaryOut, oneLine);
