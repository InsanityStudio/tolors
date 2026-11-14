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
    localStorage.setItem('theme', 'dark');
  } else {
    document.body.classList.remove('dark-mode');
    themeToggle.textContent = 'Theme: Light';
    localStorage.setItem('theme', 'light');
  }
}

const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'dark') {
  applyTheme(true);
}

themeToggle.addEventListener('click', () => {
  const isDark = document.body.classList.contains('dark-mode');
  applyTheme(!isDark);
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
   Parser (Now pre-calculating lowercase strings for instant search)
   ================================================================== */
function parseSuggestions(text) {
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\n*\[URL's content end\]\s*$/, '');

  const startMarker = 'THE REJECTED SUGGESTIONS';
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return [];
  const relevant = text.slice(startIdx);

  // CHANGED: capture the whole [b]...[/b] block instead of expecting a single
  // [url=...]...[/url] pair. This fixes multi-link titles like 9.5.
  const headerRegex = /\[b\](\d+\.\d+)\s+([\s\S]*?)\[\/b\]/g;
  const headers = [];
  let m;
  while ((m = headerRegex.exec(relevant)) !== null) {
    headers.push({
      id: m[1],
      title: stripBBCode(m[2].trim()),   // CHANGED: strip BBCode from title
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
      // PRE-COMPUTED SEARCH KEYS (Makes searching theoretically instant)
      _id: h.id.toLowerCase(),
      _title: h.title.toLowerCase(),
      _text: preview.toLowerCase()
    });
  }

  return entries;
}

/* ==================================================================
   Search ranking (Optimized)
   ================================================================== */
function scoreItem(item, query) {
  if (query === '') return { matches: true, tier: 0 };

  // Using pre-computed strings, no .toLowerCase() needed during typing
  if (item._id === query) return { matches: true, tier: 0 };
  if (item._id.startsWith(query)) return { matches: true, tier: 1 };
  if (item._id.includes(query)) return { matches: true, tier: 2 };
  if (item._title.includes(query)) return { matches: true, tier: 3 };
  if (item._text.includes(query)) return { matches: true, tier: 4 };

  return { matches: false };
}

/* ==================================================================
   Rendering & Sync
   ================================================================== */
function renderResults(filterText = '') {
  resultsList.innerHTML = '';
  const query = filterText.toLowerCase().trim();

  const scored = suggestionsData
    .map((item, idx) => {
      const { matches, tier } = scoreItem(item, query);
      return matches ? { item, idx, tier: tier === undefined ? 0 : tier } : null;
    })
    .filter(x => x !== null)
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.idx - b.idx;
    });

  const total = scored.length;
  resultsCount.textContent = `${total} entr${total === 1 ? 'y' : 'ies'} found`;

  scored.forEach(({ item, tier }) => {
    const div = document.createElement('div');
    div.className = 'suggestion-item';

    let badge = '';
    if (query !== '') {
      if (tier === 0) badge = '<span class="match-badge badge-exact">Exact ID</span>';
      else if (tier === 1 || tier === 2) badge = '<span class="match-badge badge-id">ID Match</span>';
      else if (tier === 3) badge = '<span class="match-badge badge-title">Title Match</span>';
    }

    div.innerHTML = `
      <div class="suggestion-id">${item.id}${badge}</div>
      <div class="suggestion-title">${item.title}</div>
      <div class="suggestion-text">${item.text}</div>
    `;

    div.addEventListener('click', () => {
      navigator.clipboard.writeText(item.bbcode).then(() => {
        toast.style.display = 'block';
        setTimeout(() => {
          toast.style.display = 'none';
        }, 2000);
      }).catch(err => {
        console.error('Could not copy text: ', err);
      });
    });

    resultsList.appendChild(div);
  });
}

// Sync function keeps both search bars identical
function syncSearch(val) {
  if (headerSearchInput.value !== val) headerSearchInput.value = val;
  if (appSearchInput.value !== val) appSearchInput.value = val;
  renderResults(val);
}

headerSearchInput.addEventListener('input', (e) => syncSearch(e.target.value));
appSearchInput.addEventListener('input', (e) => syncSearch(e.target.value));

/* ==================================================================
   Boot
   ================================================================== */
async function init() {
  try {
    const response = await fetch('scratch.mit.edu.txt');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const text = await response.text();

    suggestionsData = parseSuggestions(text);

    if (suggestionsData.length === 0) {
      resultsCount.textContent = 'No entries found in scratch.mit.edu.txt';
      return;
    }

    resultsCount.textContent = `${suggestionsData.length} entries available`;
    syncSearch(''); // Initial render
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
