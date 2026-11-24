let suggestionsData = [];

const headerSearchInput = document.getElementById('headerSearchInput');
const appSearchInput = document.getElementById('appSearchInput');
const resultsList = document.getElementById('resultsList');
const resultsCount = document.getElementById('resultsCount');
const themeToggle = document.getElementById('themeToggle');
const toast = document.getElementById('copyToast');

/* ==================================================================
   THEME TOGGLE LOGIC
   ================================================================== */
function applyTheme(isDark) {
  if (isDark) {
    document.body.classList.add('dark-mode');
    themeToggle.textContent = 'Theme: Dark';
    try { localStorage.setItem('theme', 'dark'); } catch (e) {}
  } else {
    document.body.classList.remove('dark-mode');
    themeToggle.textContent = 'Theme: Light';
    try { localStorage.setItem('theme', 'light'); } catch (e) {}
  }
}

// The saved theme is applied by a tiny inline script in index.html before
// first paint (no light->dark flash), so nothing to do on boot here.

themeToggle.addEventListener('click', () => {
  const isDark = document.body.classList.contains('dark-mode');
  applyTheme(!isDark);
});

/* ==================================================================
   CTRL+F / CMD+F -> focus main search box, select text, jump to top
   (absorbs trackpad/wheel momentum so the page doesn't glide back down)
   ================================================================== */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();

    // Absorb trackpad/scroll-wheel momentum so the page doesn't keep
    // gliding downward after we jump to the top.
    const root = document.documentElement;
    const prevOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });

    setTimeout(() => {
      root.style.overflow = prevOverflow;
    }, 60);

    appSearchInput.focus();
    appSearchInput.select();
  }
});

/* ==================================================================
   BBCode stripper
   ================================================================== */
function stripBBCode(text) {
  return text
    .replace(/\[scratchblocks\][\s\S]*?\[\/scratchblocks\]/g, '')
    .replace(/\[url(?:=[^\]]*)?\]/gi, '')
    .replace(/\[\/url\]/gi, '')
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, '')
    .replace(/\[\/?b\]/gi, '')
    .replace(/\[\/?i\]/gi, '')
    .replace(/\[\/?u\]/gi, '')
    .replace(/\[\/?small\]/gi, '')
    .replace(/\[color=[^\]]*\]/gi, '')
    .replace(/\[\/color\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ==================================================================
   HTML escape + match highlighter (used for title/text only)
   ================================================================== */
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Builds the highlight regex ONCE per query (not once per field per entry).
function makeHighlighter(query) {
  if (!query) return null;
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
}

function highlightMatch(text, re) {
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    out += escapeHtml(text.slice(last, m.index));
    out += '<mark class="search-highlight">' + escapeHtml(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

/* ==================================================================
   Parser (Now pre-calculating lowercase strings for instant search)
   ================================================================== */
function parseSuggestions(text) {
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\n*\[URL's content end\]\s*$/, '');

  const startMarker = 'THE REJECTED SUGGESTIONS';
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return [];
  const relevant = text.slice(startIdx);

  const headerRegex = /\[b\](\d+\.\d+)\s+([\s\S]*?)\[\/b\]/g;
  const headers = [];
  let m;
  while ((m = headerRegex.exec(relevant)) !== null) {
    headers.push({
      id: m[1],
      title: stripBBCode(m[2].trim()),
      headerStart: m.index,
      headerLength: m[0].length
    });
  }

  const entries = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const nextStart = (i + 1 < headers.length) ? headers[i + 1].headerStart : relevant.length;

    let rawBlock = relevant.slice(h.headerStart, nextStart).trimEnd();
    rawBlock = rawBlock.replace(/\s+\[big\]\[b\]\[u\][\s\S]*$/i, '').trimEnd();

    const content = rawBlock.slice(h.headerLength).trim();
    const firstPara = content.split(/\n\s*\n/)[0] || '';
    const preview = stripBBCode(firstPara);

    const bbcode =
      '[quote=The Informal and Unofficial List of Rejected Suggestions]' +
      rawBlock +
      ' [p][url=https://scratch.mit.edu/discuss/topic/896403/][small][b]View source[/b][/small][/url][small][/p][/quote]';

    entries.push({
      id: h.id,
      title: h.title,
      text: preview,
      bbcode: bbcode,
      _id: h.id.toLowerCase(),
      _title: h.title.toLowerCase(),
      _text: preview.toLowerCase(),
      _titleHtml: escapeHtml(h.title),
      _textHtml: escapeHtml(preview)
    });
  }

  return entries;
}

/* ==================================================================
   Search ranking: single pass, bucketed by tier (already in list order
   inside each tier, so no sort and no intermediate objects).
   ================================================================== */
function tierOf(item, query) {
  if (item._id === query) return 0;
  if (item._id.startsWith(query)) return 1;
  if (item._id.includes(query)) return 2;
  if (item._title.includes(query)) return 3;
  if (item._text.includes(query)) return 4;
  return -1;
}

/* ==================================================================
   Rendering & Sync
   ================================================================== */
const BADGES = [
  '<span class="match-badge badge-exact">Exact ID</span>',
  '<span class="match-badge badge-id">ID match</span>',
  '<span class="match-badge badge-id">ID match</span>',
  '<span class="match-badge badge-title">Title match</span>',
  ''
];

let lastQuery = null;      // last query actually rendered
let defaultHtml = null;    // cached markup for the empty query
let shown = suggestionsData; // entries currently in the DOM (click lookup)

function renderResults(filterText = '') {
  const query = filterText.toLowerCase().trim();
  if (query === lastQuery) return;   // e.g. only a trailing space was typed
  lastQuery = query;

  let html;
  let total;

  if (query === '') {
    if (defaultHtml === null) {
      let h = '';
      for (let i = 0; i < suggestionsData.length; i++) {
        const it = suggestionsData[i];
        h += '<div class="suggestion-item" data-i="' + i + '"><div class="suggestion-id">' + it.id +
             '</div><div class="suggestion-title">' + it._titleHtml +
             '</div><div class="suggestion-text">' + it._textHtml + '</div></div>';
      }
      defaultHtml = h;
    }
    html = defaultHtml;
    shown = suggestionsData;
    total = suggestionsData.length;
  } else {
    const buckets = [[], [], [], [], []];
    for (let i = 0; i < suggestionsData.length; i++) {
      const t = tierOf(suggestionsData[i], query);
      if (t >= 0) buckets[t].push(i);
    }
    const re = makeHighlighter(query);
    html = '';
    shown = [];
    for (let t = 0; t < 5; t++) {
      const b = buckets[t];
      for (let k = 0; k < b.length; k++) {
        const it = suggestionsData[b[k]];
        // ID is intentionally NOT highlighted; only title and text are.
        html += '<div class="suggestion-item" data-i="' + shown.length + '"><div class="suggestion-id">' + it.id + BADGES[t] +
                '</div><div class="suggestion-title">' + highlightMatch(it.title, re) +
                '</div><div class="suggestion-text">' + highlightMatch(it.text, re) + '</div></div>';
        shown.push(it);
      }
    }
    total = shown.length;
  }

  resultsCount.textContent = total + ' entr' + (total === 1 ? 'y' : 'ies') + ' found';
  resultsList.innerHTML = html;   // one DOM write instead of N createElement/appendChild
}

// One delegated click listener instead of one per result (rebuilt every keystroke).
resultsList.addEventListener('click', (e) => {
  const el = e.target.closest('.suggestion-item');
  if (!el) return;
  const item = shown[+el.dataset.i];
  if (!item) return;
  navigator.clipboard.writeText(item.bbcode).then(() => {
    toast.style.display = 'block';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 2000);
  }).catch(err => {
    console.error('Could not copy text: ', err);
  });
});

// Keeps both search bars identical. The inputs mirror instantly; the (heavier)
// result render is coalesced to at most once per frame so fast typing never
// queues up redundant DOM rebuilds.
let pendingVal = '';
let rafId = 0;
function syncSearch(val, immediate) {
  if (headerSearchInput.value !== val) headerSearchInput.value = val;
  if (appSearchInput.value !== val) appSearchInput.value = val;
  pendingVal = val;
  if (immediate) {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    renderResults(val);
    return;
  }
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    renderResults(pendingVal);
  });
}

headerSearchInput.addEventListener('input', (e) => syncSearch(e.target.value));
appSearchInput.addEventListener('input', (e) => syncSearch(e.target.value));

/* ==================================================================
   Boot
   ================================================================== */
async function init() {
  try {
    // The request was already fired from an inline script in <head>, so it has
    // been in flight since before this file even downloaded.
    const response = await (window.__tolorsData || fetch('scratch.mit.edu.txt'));
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const text = await response.text();

    suggestionsData = parseSuggestions(text);

    if (suggestionsData.length === 0) {
      resultsCount.textContent = 'No entries found in scratch.mit.edu.txt';
      return;
    }

    // Honour anything typed while the data was loading, otherwise show the full list.
    syncSearch(appSearchInput.value || headerSearchInput.value || '', true);
  } catch (err) {
    resultsCount.textContent = 'Error loading data';
    resultsList.innerHTML = `<div style="padding:20px;color:#c00;line-height:1.6;font-size:13px;">
      <b>Could not load scratch.mit.edu.txt.</b><br><br>
      If you opened this page directly from your disk (<code>file://</code>), the browser blocks local <code>fetch()</code> requests. Serve it via a web server (GitHub Pages, <code>python -m http.server</code>, etc.).
      <br><br>
      <small style="color:#999;">Error: ${err.message}</small>
    </div>`;
  }
}

init();
