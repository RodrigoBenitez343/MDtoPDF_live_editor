// ============================================================================
// app.js — DocMaster (Neutralinojs desktop app)
// Fully client-side implementation. Markdown → HTML uses marked (+ smartypants):
// title extraction, first-heading strip, mermaid code-block post-processing,
// document header, DOCUMENT_CSS styling.
//
// Two views:
//   • Edit      — the rendered document is directly editable (WYSIWYG); the
//     DOM is the source of truth and is serialized back to Markdown with
//     turndown (debounced) for saving / toggling / printing.
//   • Markdown  — the raw source in a textarea; switching back re-renders.
// The Índice (table of contents) is an optional document element: insert or
// remove it with the toolbar "Índice" button, or write \tableofcontents on its
// own line in the Markdown source. Generated from the document headings (each
// heading is an anchor), it occupies its real space while editing, so the
// on-screen layout matches the exported PDF. Live page-fold guides (thin
// lines with page numbers) show where each printed page will break.
// PDF export paginates the live document into fixed A4 content sheets with
// the same content-fit engine that draws the fold guides (pagination.js),
// then opens the native print dialog (Neutralino.window.print) — one sheet
// prints as exactly one PDF page, so the exported pages always match the
// on-screen page separations.
// ============================================================================

'use strict';

// ─── Markdown configuration (matches python-markdown: tables, fenced_code,
//     smarty, sane_lists — GFM in marked covers tables + fenced code) ───
// marked-smartypants UMD exposes the plugin as an object with a
// .markedSmartypants property (or directly as a function in ESM builds).
const smartypantsPlugin =
  typeof markedSmartypants === 'function'
    ? markedSmartypants
    : markedSmartypants.markedSmartypants;
marked.use(smartypantsPlugin()); // smarty quotes/dashes/ellipses

// ─── DOM refs ───
const editor = document.getElementById('editor');
const docContent = document.getElementById('docContent');
const wordCount = document.getElementById('wordCount');
const lineCol = document.getElementById('lineCol');
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const fileNameEl = document.getElementById('fileName');
const viewTitle = document.getElementById('viewTitle');
const downloadBtn = document.getElementById('downloadBtn');
const newBtn = document.getElementById('newBtn');
const openBtn = document.getElementById('openBtn');
const saveBtn = document.getElementById('saveBtn');
const loadSampleBtn = document.getElementById('loadSampleBtn');
const editModeBtn = document.getElementById('editModeBtn');
const mdModeBtn = document.getElementById('mdModeBtn');
const filesToggleBtn = document.getElementById('filesToggleBtn');
const newLibBtn = document.getElementById('newLibBtn');
const newDocBtn = document.getElementById('newDocBtn');
const filesRefreshBtn = document.getElementById('filesRefreshBtn');
const filesTree = document.getElementById('filesTree');
const filesEmpty = document.getElementById('filesEmpty');
const filesSearch = document.getElementById('filesSearch');
const filesSort = document.getElementById('filesSort');
const filesImportBtn = document.getElementById('filesImportBtn');
const filesTrashBtn = document.getElementById('filesTrashBtn');
const filesEmptyTrashBtn = document.getElementById('filesEmptyTrashBtn');
const filesMenu = document.getElementById('filesMenu');
const filesTrashCount = document.getElementById('filesTrashCount');
const formatBar = document.getElementById('formatBar');
const fmtPopover = document.getElementById('fmtPopover');
const fmtPopoverBody = document.getElementById('fmtPopoverBody');
const toast = document.getElementById('toast');

// ─── App state ───
let currentFile = null;
let mode = 'edit'; // 'edit' (WYSIWYG) | 'markdown' (source)
let mdState = '';      // markdown source, kept in sync with the active view
let renderSeq = 0;
let serializeTimer = null;
let draftTimer = null;
let toastTimer = null;
let wsRoot = null;      // library workspace root (<app data>/documents)
let filesOpen = false;
let selectedDir = null; // folder that receives new libraries / documents
let creating = null;    // 'lib' | 'doc' while the inline create input is active
const treeExpanded = new Set(); // expanded folder paths
const listByPath = new Map();   // folder path → its <ul> in the tree
const FS_SEP = /win/i.test(navigator.platform) ? '\\' : '/';
const WIN = FS_SEP === '\\';          // Windows path rules (case-insensitive)
const TRASH_ID = '.trash';            // hidden workspace folder holding deleted items
let sortMode = 'name';                // Library sort: 'name' | 'modified'
let filterQuery = '';                 // Library search text
let trashMode = false;                // Library panel shows the Trash instead of the tree
let searchTimer = null;
let dragPath = null;                  // path currently dragged in the Library tree
let dragIsDir = false;

// Native (Neutralino) availability — set when the 'ready' event fires
let nativeAvailable = false;

// ===========================================================================
// DOM → Markdown serializer (turndown + GFM tables)
// ===========================================================================
const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});
turndownService.use(turndownPluginGfm.tables);
turndownService.use(turndownPluginGfm.strikethrough);

// Inline styling (color / size / font / underline) survives as raw HTML so
// WYSIWYG formatting round-trips through the Markdown source. Rules registered
// later win, so the custom block rules below still take precedence.
turndownService.keep(['span', 'div', 'u', 's', 'mark', 'sub', 'sup']);

// Fenced code blocks keep their language class (```python etc.); bare <pre>
// blocks (toolbar "code block") serialize as a fence without a language.
// The closing fence is always bare backticks — GFM only closes on ``` alone,
// a language-tagged line would leave the fence open to the end of input.
turndownService.addRule('fencedCodeBlock', {
  filter: (node) => node.nodeName === 'PRE',
  replacement: (content, node) => {
    const code =
      node.firstChild && node.firstChild.nodeName === 'CODE' ? node.firstChild : null;
    const langMatch = code ? (code.className || '').match(/language-([\w-]+)/) : null;
    const open = '```' + (langMatch ? langMatch[1] : '');
    const body = (code ? code.textContent : node.textContent).replace(/\n$/, '');
    return '\n\n' + open + '\n' + body + '\n```\n\n';
  },
});

// Page-break markers serialize back to \newpage on their own line
turndownService.addRule('pageBreakMarker', {
  filter: (node) => node.nodeName === 'DIV' && node.classList.contains('pageBreakMarker'),
  replacement: () => '\n\n\\newpage\n\n',
});

// The generated Índice serializes back to a \tableofcontents marker, so the
// optional index round-trips through the Markdown source.
turndownService.addRule('tocMarker', {
  filter: (node) => node.nodeName === 'DIV' && node.classList.contains('tocMarker'),
  replacement: () => '\n\n\\tableofcontents\n\n',
});

// Images resized in the WYSIWYG view keep their size as raw HTML
turndownService.addRule('imageWithSize', {
  filter: (node) =>
    node.nodeName === 'IMG' &&
    (node.getAttribute('width') || node.getAttribute('height') || node.getAttribute('style')),
  replacement: (content, node) => '\n\n' + node.outerHTML + '\n\n',
});

// ===========================================================================
// Markdown pipeline (Markdown → formal document HTML)
// ===========================================================================

// extractTitle — first # or ## heading, else "Documento"
function extractTitle(raw) {
  const match = raw.match(/^#{1,2}\s+(.+)$/m);
  return match ? match[1].trim() : 'Documento';
}

// transformMd — strip first heading, drop empty centered divs;
// additionally converts explicit page-break markers (\newpage, \pagebreak,
// \clearpage on their own line) into .page-break dividers and the optional
// index marker (\tableofcontents) into a placeholder. Markers inside fenced
// code blocks are left untouched.
function transformMd(raw) {
  let text = raw.replace(/^#{1,2}\s+.+$/m, ''); // count=1 like re.sub in Python
  text = text.replace(/<div align="center">\s*<\/div>/g, '');

  const lines = text.split('\n');
  let inFence = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && /^\s*\\(?:newpage|pagebreak|clearpage)\s*$/.test(line)) {
      out.push('<div class="page-break"></div>');
    } else if (!inFence && /^\s*\\tableofcontents\s*$/.test(line)) {
      // the Índice renders here, generated from the document headings
      out.push('<div class="toc-placeholder"></div>');
    } else {
      out.push(line);
    }
  }
  return out.join('\n').trim();
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Inline SVG icon set (line icons that replace the emoji/glyph placeholders) ───
const ICON_PATHS = {
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  import: '<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  orderedList: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  minus: '<path d="M5 12h14"/>',
  pagebreak: '<path d="M4 4h16"/><path d="M4 20h16"/><path d="M12 7v7"/><path d="m9 11 3 3 3-3"/>',
  quote: '<path d="M10 11H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v6a2 2 0 0 1-2 2"/><path d="M19 11h-4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v6a2 2 0 0 1-2 2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  restore: '<path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.1-9.36L3 7"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};

function svgIcon(name, size = 14) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ico');
  svg.innerHTML = ICON_PATHS[name] || '';
  return svg;
}

// mdToBodyHtml — returns { title, hasTitle, body } with the
// document header plus an auto-generated table of contents ("Índice") that
// reacts to the document headings.
function mdToBodyHtml(mdText) {
  const match = mdText.match(/^#{1,2}\s+(.+)$/m);
  const hasTitle = !!match;
  const title = hasTitle ? match[1].trim() : '';
  let bodyHtml = marked.parse(transformMd(mdText), { gfm: true, breaks: false });

  // Post-process mermaid code blocks: <pre class="mermaid">…</pre>
  bodyHtml = bodyHtml.replace(
    /<pre><code class="language-mermaid">(.*?)<\/code><\/pre>/gs,
    '<pre class="mermaid">$1</pre>'
  );

  // Sanitize (python-markdown passed raw HTML through; DOMPurify keeps the
  // formatting elements we style, plus align= for centered divs and sanitized
  // inline styles from the WYSIWYG toolbar, and embedded base64 images)
  bodyHtml = DOMPurify.sanitize(bodyHtml, {
    ADD_ATTR: ['align', 'style'],
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|file):|data:image\/[a-z0-9.+-]+;base64,|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });

  // Auto table of contents: give every h1–h3 an anchor id and collect entries
  let entryIndex = 0;
  const tocEntries = [];
  bodyHtml = bodyHtml.replace(/<h([1-3])[^>]*>(.*?)<\/h\1>/gs, (m, level, inner) => {
    entryIndex += 1;
    const id = 'sec-' + entryIndex;
    // Plain text for the index entry: strip tags, decode entities, collapse space
    const text = inner
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
    tocEntries.push({ level: Number(level), id, text });
    return '<h' + level + ' id="' + id + '">' + inner + '</h' + level + '>';
  });

  // The optional Índice marker (\tableofcontents) becomes the generated
  // table of contents at its exact position; without headings it collapses.
  const toc = buildToc(tocEntries);
  bodyHtml = bodyHtml.replace(/<div class="toc-placeholder"><\/div>/g, toc);

  // Prepend the document header. The header is only
  // rendered when the source actually has a heading, so an untitled document
  // never gets a phantom title.
  const header = hasTitle
    ? '<div class="document-header"><h1>' + escapeHtml(title) + '</h1></div>'
    : '';
  return { title, hasTitle, body: header + '\n' + bodyHtml };
}

// Generated table of contents — rebuilt on every render, so it always matches
// the current document headings. Rendered only where the \tableofcontents
// marker sits (or where the toolbar "Índice" toggle inserted it). Section
// links navigate within the document and become internal links in the PDF.
function buildToc(entries) {
  if (!entries.length) return '';
  const items = entries
    .map((e) =>
      '<li class="toc-item toc-lvl-' + e.level + '">' +
      '<a href="#' + e.id + '">' + escapeHtml(e.text) + '</a></li>'
    )
    .join('\n    ');
  return (
    '<nav class="document-toc">' +
    '<h2 class="toc-title">Índice</h2>' +
    '<ul class="toc-list">' + items + '</ul>' +
    '</nav>'
  );
}

// ─── Mermaid rendering ───
function initMermaid() {
  if (typeof mermaid === 'undefined') return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    fontFamily: 'Georgia, serif',
    fontSize: 10,
  });
}

async function renderDiagrams(root) {
  if (typeof mermaid === 'undefined') return;
  const nodes = Array.from(root.querySelectorAll('.mermaid')).filter((n) => !n.querySelector('svg'));
  if (!nodes.length) return;
  for (const node of nodes) {
    // Stash the diagram source so the DOM → Markdown serializer can restore
    // the original ```mermaid fence (the SVG replaces this text).
    node.setAttribute('data-src', node.textContent);
    const id = 'mmd-' + Math.random().toString(36).slice(2, 10);
    try {
      const { svg } = await mermaid.render(id, node.textContent);
      node.innerHTML = svg;
    } catch (err) {
      console.warn('Mermaid render failed:', err);
      node.innerHTML =
        '<p style="color:#a33;font-style:italic;font-size:10pt">[Diagram error: ' +
        escapeHtml(err.message) + ']</p>';
    }
  }
}

// ===========================================================================
// Document view (WYSIWYG): render Markdown into the editable light-DOM doc
// ===========================================================================
async function renderDocument(md) {
  const seq = ++renderSeq;

  if (!md.trim()) {
    docContent.innerHTML = '<div class="doc-root"><div class="document-page"></div></div>';
    updateWordCount('');
    updatePageGuides();
    return;
  }

  try {
    const { title, body } = mdToBodyHtml(md);
    if (seq !== renderSeq) return;

    docContent.innerHTML =
      '<div class="doc-root"><div class="document-page" contenteditable="true">' +
      body + '</div></div>';
    const root = docContent.querySelector('.doc-root');

    // Generated regions are not editable: Índice, diagrams, page-break markers
    root.querySelectorAll('.document-toc, .mermaid, .page-break').forEach((n) => {
      n.contentEditable = 'false';
    });

    // Índice links: smooth-scroll the target into view (hrefs stay intact for
    // internal links in the printed PDF).
    root.querySelectorAll('.document-toc a').forEach((a) => {
      a.addEventListener('click', (evt) => {
        evt.preventDefault();
        const target = root.querySelector(a.getAttribute('href'));
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    await renderDiagrams(root);
    if (seq !== renderSeq) return;

    updateWordCount(docText());
    updatePageGuides();

    // The window title carries the app name; document.title must stay clean —
    // the print dialog's optional headers/footers render it into the PDF.
    document.title = title;
    if (nativeAvailable) {
      Neutralino.window.setTitle((title || 'Untitled') + ' — DocMaster').catch(() => {});
    }
  } catch (err) {
    if (seq !== renderSeq) return;
    docContent.innerHTML =
      '<div style="text-align:center;padding:60px 40px;color:#b0b0a0;' +
      'font-family:Georgia,serif;font-style:italic;">Render failed: ' +
      escapeHtml(err.message) + '</div>';
  }
}

// Visible text of the rendered document, excluding generated regions
function docText() {
  const page = docContent.querySelector('.document-page');
  if (!page) return '';
  let text = page.innerText || '';
  page.querySelectorAll('.document-toc, .mermaid, .page-guide').forEach((n) => {
    if (n.innerText) text = text.replace(n.innerText, '');
  });
  return text;
}

// ===========================================================================
// DOM → Markdown (serialize the edited rendered document)
// ===========================================================================
function domToMarkdown() {
  const page = docContent.querySelector('.document-page');
  if (!page || !page.innerText.trim()) return '';

  const clone = page.cloneNode(true);

  // Capture + remove the document title (rendered header) — it round-trips
  // back to the first `# heading` of the Markdown source.
  let title = '';
  const header = clone.querySelector('.document-header');
  if (header) {
    const h1 = header.querySelector('h1');
    title = h1 ? h1.textContent.trim() : '';
    header.remove();
  }

  // Drop the generated footer note and pagination guides; the Índice
  // round-trips back to its \tableofcontents marker (the zero-width space
  // keeps turndown from treating the empty div as "blank" before the custom
  // rule runs).
  clone.querySelectorAll('.footer-note, .page-guide').forEach((n) => n.remove());
  clone.querySelectorAll('.document-toc').forEach((n) => {
    const marker = document.createElement('div');
    marker.className = 'tocMarker';
    marker.textContent = '\u200b';
    n.replaceWith(marker);
  });

  // Page-break markers → block elements so turndown keeps them on their own
  // line (raw text nodes would be merged into paragraphs and escaped). The
  // zero-width space keeps turndown from treating the empty div as "blank"
  // and skipping it before the custom rule runs.
  clone.querySelectorAll('.page-break').forEach((n) => {
    const marker = document.createElement('div');
    marker.className = 'pageBreakMarker';
    marker.textContent = '\u200b';
    n.replaceWith(marker);
  });

  // Mermaid diagrams → a real <pre><code> block; the fencedCodeBlock rule
  // writes the original source fence (data-src stashed at render time)
  clone.querySelectorAll('.mermaid').forEach((n) => {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-mermaid';
    code.textContent = (n.getAttribute('data-src') || n.textContent).trim();
    pre.appendChild(code);
    n.replaceWith(pre);
  });

  // Headings: strip render-time attributes (anchor ids)
  clone.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
    [...h.attributes].forEach((a) => h.removeAttribute(a.name));
  });

  let md = turndownService.turndown(clone).replace(/\n{3,}/g, '\n\n').trim();
  if (title) md = '# ' + title + '\n\n' + md;
  return md + '\n';
}

// Markdown source of truth for the active view (fresh serialize in document
// mode so saves are exact; the textarea in markdown mode)
function currentMarkdown() {
  return mode === 'markdown' ? editor.value : domToMarkdown();
}

function hasContent() {
  return !!currentMarkdown().trim();
}

// ===========================================================================
// View mode management
//   'edit'     — the rendered document is directly editable (WYSIWYG); the
//                optional Índice is visible and occupies its real space
//   'markdown' — the raw source in a textarea; switching back re-renders
// ===========================================================================
function setMode(next) {
  mode = next;
  document.body.classList.toggle('mode-edit', next === 'edit');
  document.body.classList.toggle('mode-markdown', next === 'markdown');
  editModeBtn.classList.toggle('active', next === 'edit');
  mdModeBtn.classList.toggle('active', next === 'markdown');
  viewTitle.textContent = next === 'edit' ? 'Editing' : 'Markdown';
  lineCol.textContent = next === 'edit' ? 'Edit mode' : 'Ln 1, Col 1';
  if (next === 'markdown') updateCursorPos();

  // the same DOM instance serves both views — only editability changes
  const page = docContent.querySelector('.document-page');
  if (page) page.contentEditable = next === 'edit' ? 'true' : 'false';
  updatePageGuides();
}

function switchToMarkdown() {
  if (mode === 'markdown') return;
  mdState = domToMarkdown();
  editor.value = mdState;
  setMode('markdown');
  updateWordCount(mdState);
}

async function switchToEdit() {
  if (mode === 'edit') return;
  if (mode === 'markdown') await renderDocument(editor.value);
  setMode('edit');
  focusDocEnd();
}

// Ctrl+E toggles Edit ⇄ Markdown
function toggleMode() {
  if (mode === 'edit') switchToMarkdown();
  else switchToEdit();
}

// ===========================================================================
// Live pagination guides (Edit view) + deterministic PDF sheets
// The engine lives in pagination.js (loaded before this file): it shares ONE
// content-fit fragmentation model between the on-screen fold guides and the
// exported PDF, which is paginated into fixed A4 content sheets whose page
// breaks always match the guides.
// ===========================================================================

// Place the caret at the end of the rendered document
function focusDocEnd() {
  const page = docContent.querySelector('.document-page');
  if (!page) return;
  page.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(page);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ===========================================================================
// Word count + cursor position
// ===========================================================================
function updateWordCount(text) {
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  wordCount.textContent = words + ' word' + (words !== 1 ? 's' : '');
}

function updateCursorPos() {
  const text = editor.value.substring(0, editor.selectionStart);
  const lines = text.split('\n');
  const line = lines.length;
  const col = lines[lines.length - 1].length + 1;
  lineCol.textContent = 'Ln ' + line + ', Col ' + col;
}

function setStatus(type, text) {
  statusDot.className = 'status-dot ' + type;
  statusText.textContent = text;
}

function showToast(message, type = 'info') {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = 'toast ' + type + ' show';
  toastTimer = setTimeout(() => { toast.classList.remove('show'); }, 3200);
}

// ===========================================================================
// File operations (Neutralino native APIs)
// ===========================================================================
function basename(path) {
  return path.split(/[\\/]/).pop();
}

function dirname(path) {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return i < 0 ? '' : path.slice(0, i);
}

function updateFileLabel() {
  fileNameEl.textContent = currentFile ? basename(currentFile) : 'untitled.md';
}

async function confirmDiscard() {
  if (!hasContent()) return true;
  if (!nativeAvailable) return true; // cannot prompt without native APIs
  const choice = await Neutralino.os.showMessageBox(
    'Unsaved changes',
    'Discard the current document?',
    'YES_NO',
    'QUESTION'
  );
  return choice === 'YES';
}

async function openFile() {
  if (!nativeAvailable) { showToast('Native file dialogs unavailable here', 'error'); return; }
  const entries = await Neutralino.os.showOpenDialog('Open Markdown', {
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (!entries || !entries.length) return;
  if (!(await confirmDiscard())) return;

  const path = entries[0];
  const content = await Neutralino.filesystem.readFile(path);
  editor.value = content;
  mdState = content;
  currentFile = path;
  await renderDocument(content);
  setMode('edit');
  updateFileLabel();
  setActiveFile(path);
  showToast('Opened ' + basename(path), 'success');
}

async function doSave(path) {
  const md = currentMarkdown();
  mdState = md;
  await Neutralino.filesystem.writeFile(path, md);
  currentFile = path;
  updateFileLabel();
  setActiveFile(path);
  showToast('Saved: ' + basename(path), 'success');
  setStatus('saved', 'Ready');
}

async function saveFile() {
  if (!currentFile) return saveAs();
  await doSave(currentFile);
}

async function saveAs() {
  if (!nativeAvailable) { showToast('Native file dialogs unavailable here', 'error'); return; }
  const base = (extractTitle(currentMarkdown()) || 'document').replace(/[^\w\- ]+/g, '').trim() || 'document';
  const path = await Neutralino.os.showSaveDialog('Save Markdown', {
    defaultPath: base + '.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (!path) return;
  await doSave(path);
}

async function newDocument() {
  if (!nativeAvailable && hasContent()) { showToast('Native dialogs unavailable here', 'error'); return; }
  if (!(await confirmDiscard())) return;
  editor.value = '';
  mdState = '';
  currentFile = null;
  await renderDocument('');
  setMode('edit');
  updateFileLabel();
  setActiveFile(null);
  showToast('New document', 'info');
}

async function loadSample() {
  if (!(await confirmDiscard())) return;
  try {
    const resp = await fetch('/sample.md');
    if (!resp.ok) throw new Error('Sample not found');
    editor.value = await resp.text();
  } catch {
    showToast('Sample file missing from bundle', 'error');
    return;
  }
  mdState = editor.value;
  currentFile = null;
  await renderDocument(editor.value);
  setMode('edit');
  updateFileLabel();
  setActiveFile(null);
  showToast('Sample document loaded', 'info');
}

// ===========================================================================
// PDF export — deterministic paginated sheets → native print dialog.
// The live document is cloned into #printRoot and split into fixed A4 content
// sheets (.print-page, exactly the @page content box) by the same pagination
// engine that draws the Edit-view fold guides. @media print hides the app and
// shows only the sheets, so every PDF page equals one sheet — and one of the
// on-screen page separations — regardless of the dialog's margin/scaling
// settings. The editable document is never printed directly.
// ===========================================================================
async function exportPdf() {
  if (!hasContent()) {
    showToast('Document is empty — write something first!', 'error');
    return;
  }
  if (!nativeAvailable) {
    showToast('Native print dialog unavailable here — open the desktop app', 'error');
    return;
  }

  downloadBtn.disabled = true;
  setStatus('typing', 'Preparing print…');

  try {
    if (mode === 'markdown') await switchToEdit(); // print the rendered view
    await new Promise((r) => setTimeout(r, 300));      // let mermaid SVGs settle
    try {
      mdState = domToMarkdown(); // keep the source of truth in sync
    } catch (err) {
      console.warn('Serialize failed:', err);
    }

    const pageCount = buildPrintSheets(); // paginate the clone into A4 sheets
    if (!pageCount) {
      showToast('Document is empty — write something first!', 'error');
      return;
    }
    await Neutralino.window.print(); // native dialog → "Save as PDF"
    showToast('Print dialog closed — choose "Save as PDF" to export', 'info');
    setStatus('saved', 'Ready');
  } catch (err) {
    showToast('Print failed: ' + err.message, 'error');
    setStatus('error', 'Error');
    console.error(err);
  } finally {
    // Keep the print sheets in the DOM until the native dialog has captured
    // them: clearing here raced the async print() and wiped the pages before
    // they were printed (empty PDF). @afterprint / the next build clear them.
    downloadBtn.disabled = false;
  }
}

// ===========================================================================
// Draft auto-save / restore (Neutralino storage)
// ===========================================================================
function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    mdState = currentMarkdown();
    Neutralino.storage.setData('draft', mdState).catch(() => {});
    // autosave into the real file being edited (desktop app only)
    if (currentFile && nativeAvailable) {
      setStatus('saving', 'Saving…');
      Neutralino.filesystem.writeFile(currentFile, mdState)
        .then(() => setStatus('saved', 'Saved'))
        .catch((err) => {
          setStatus('error', 'Save failed');
          showToast('Autosave failed: ' + err.message, 'error');
        });
    }
  }, 600);
}

async function restoreDraftOrSample() {
  try {
    const draft = await Neutralino.storage.getData('draft');
    if (draft && draft.trim()) {
      editor.value = draft;
      mdState = draft;
      await renderDocument(draft);
      setMode('edit');
      showToast('Draft restored', 'info');
      return;
    }
  } catch {
    /* no draft yet */
  }
  editor.value = '';
  await loadSampleQuiet();
}

async function loadSampleQuiet() {
  try {
    const resp = await fetch('/sample.md');
    if (!resp.ok) throw new Error('Sample not found');
    editor.value = await resp.text();
  } catch {
    editor.value = '';
  }
  mdState = editor.value;
  await renderDocument(editor.value);
  setMode('edit');
}

// ===========================================================================
// Library panel (workspace files with autosave)
// The desktop app keeps its documents in <app data>/documents ("Library").
// The panel lists the workspace: libraries (folders) and documents (.md).
// Creating a library creates a folder; creating a document writes an empty
// .md file and opens it — every edit afterwards autosaves into that file.
// ===========================================================================
async function initWorkspace() {
  try {
    const dataDir = await Neutralino.os.getPath('data');
    wsRoot = dataDir + FS_SEP + 'documents';
    try {
      await Neutralino.filesystem.createDirectory(wsRoot);
    } catch {
      /* already exists */
    }
    selectedDir = wsRoot;
    await refreshTree();
  } catch (err) {
    console.warn('Workspace unavailable:', err);
  }
}

async function listDir(path) {
  const entries = await Neutralino.filesystem.readDirectory(path);
  const dirs = [];
  let files = [];
  for (const e of entries || []) {
    // Neutralino entries carry the name in `entry` ({ entry, path, type })
    const name = e.entry || e.name;
    if (!name || name.startsWith('.')) continue; // hides .trash
    if (String(e.type).toUpperCase() === 'DIRECTORY') dirs.push(name);
    else if (/\.(md|markdown|txt)$/i.test(name)) files.push(name);
  }
  dirs.sort((a, b) => a.localeCompare(b));
  if (sortMode === 'modified') {
    const times = await Promise.all(
      files.map((f) =>
        Neutralino.filesystem
          .getStats(path + FS_SEP + f)
          .then((s) => (s && s.modifiedAt) || 0)
          .catch(() => 0)
      )
    );
    files = files
      .map((name, i) => ({ name, t: times[i] }))
      .sort((a, b) => b.t - a.t || a.name.localeCompare(b.name))
      .map((o) => o.name);
  } else {
    files.sort((a, b) => a.localeCompare(b));
  }
  return { dirs, files };
}

async function buildList(dirPath, depth) {
  const { dirs, files } = await listDir(dirPath);
  const ul = document.createElement('ul');
  ul.className = 'files-list';
  ul.dataset.depth = depth;
  listByPath.set(dirPath, ul);
  const q = filterQuery.trim().toLowerCase();
  for (const name of dirs) {
    const childPath = dirPath + FS_SEP + name;
    const childUl = await buildList(childPath, depth + 1);
    const nameMatch = !q || name.toLowerCase().includes(q);
    const childMatch = childUl.dataset.match === '1';
    if (q && !nameMatch && !childMatch) {
      listByPath.delete(childPath); // folder is hidden while searching
      continue;
    }
    // while searching, every match stays open so results stay visible
    const expanded = q ? true : treeExpanded.has(childPath);
    ul.appendChild(makeFolderRow(childPath, name, expanded ? childUl : null));
  }
  for (const name of files) {
    if (q && !name.toLowerCase().includes(q)) continue;
    ul.appendChild(makeFileRow(dirPath + FS_SEP + name, name));
  }
  ul.dataset.match = ul.children.length > 0 ? '1' : '0';
  return ul;
}

async function refreshTree() {
  if (!wsRoot || trashMode) return;
  filesTree.innerHTML = '';
  listByPath.clear();
  const root = await buildList(wsRoot, 0);
  filesTree.appendChild(root);
  filesEmpty.hidden = root.children.length > 0;
  filesEmpty.innerHTML = 'No documents yet.<br>Create a library or a document to start.';
  setActiveFile(currentFile);
}

function makeFileRow(path, name) {
  const li = document.createElement('li');
  li.className = 'files-item';
  const row = document.createElement('div');
  row.className = 'files-row file';
  row.dataset.path = path;
  row.draggable = true;
  row.addEventListener('dragstart', (e) => startRowDrag(e, path, false));
  row.addEventListener('dragend', () => { dragPath = null; });
  row.addEventListener('contextmenu', (e) => openFileMenu(e, path, false));
  const icon = document.createElement('span');
  icon.className = 'files-icon';
  icon.appendChild(svgIcon('file', 13));
  const label = document.createElement('span');
  label.className = 'files-name';
  label.textContent = name;
  const del = document.createElement('button');
  del.className = 'files-del';
  del.title = 'Move to Trash';
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteItem(path, false);
  });
  row.appendChild(icon);
  row.appendChild(label);
  row.appendChild(del);
  row.addEventListener('click', (e) => {
    if (e.target.closest('button, .files-input')) return;
    openWorkspaceFile(path);
  });
  li.appendChild(row);
  return li;
}

function makeFolderRow(path, name, childrenUl) {
  const li = document.createElement('li');
  li.className = 'files-item';
  const row = document.createElement('div');
  row.className = 'files-row folder';
  row.dataset.path = path;
  row.draggable = true;
  row.addEventListener('dragstart', (e) => startRowDrag(e, path, true));
  row.addEventListener('dragend', () => { dragPath = null; });
  row.addEventListener('contextmenu', (e) => openFileMenu(e, path, true));
  const caret = document.createElement('span');
  caret.className = 'files-caret';
  if (!childrenUl) caret.classList.add('collapsed');
  caret.appendChild(svgIcon('chevron', 12));
  const icon = document.createElement('span');
  icon.className = 'files-icon';
  icon.appendChild(svgIcon('folder', 13));
  const label = document.createElement('span');
  label.className = 'files-name';
  label.textContent = name;
  const del = document.createElement('button');
  del.className = 'files-del';
  del.title = 'Move to Trash';
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteItem(path, true);
  });
  row.appendChild(caret);
  row.appendChild(icon);
  row.appendChild(label);
  row.appendChild(del);
  row.addEventListener('click', (e) => {
    if (e.target.closest('button, .files-input')) return;
    // clicking a folder selects it (creation target) and toggles expansion
    selectedDir = path;
    if (treeExpanded.has(path)) treeExpanded.delete(path);
    else treeExpanded.add(path);
    refreshTree();
  });
  li.appendChild(row);
  if (childrenUl) li.appendChild(childrenUl);
  return li;
}

function setActiveFile(path) {
  document.querySelectorAll('.files-row').forEach((r) => {
    r.classList.toggle('active', r.dataset.path === path);
  });
}

async function openWorkspaceFile(path) {
  if (!(await confirmDiscard())) return;
  try {
    const content = await Neutralino.filesystem.readFile(path);
    editor.value = content;
    mdState = content;
    currentFile = path;
    await renderDocument(content);
    setMode('edit');
    updateFileLabel();
    setActiveFile(path);
    showToast('Opened ' + basename(path), 'success');
  } catch (err) {
    showToast('Failed to read file: ' + err.message, 'error');
  }
}

function startCreate(kind) {
  if (!wsRoot) { showToast('Library folder unavailable', 'error'); return; }
  if (creating) return;
  creating = kind;
  const targetPath = selectedDir || wsRoot;
  treeExpanded.add(targetPath); // the create row lives inside this folder's list
  refreshTree().then(() => {
    const ul = listByPath.get(targetPath);
    if (!ul) return finishCreate();
    const li = document.createElement('li');
    li.className = 'files-item files-creating';
    const input = document.createElement('input');
    input.className = 'files-input';
    input.placeholder = kind === 'lib' ? 'Library name…' : 'Document name…';
    input.maxLength = 60;
    li.appendChild(input);
    ul.insertBefore(li, ul.firstChild);
    input.focus();
    const finish = (commit) => {
      if (creating !== kind) return;
      creating = null;
      const name = input.value;
      li.remove();
      if (commit && name.trim()) createItem(kind, name);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(false));
  }).catch((err) => {
    creating = null;
    showToast('Library unavailable: ' + err.message, 'error');
  });
}

async function createItem(kind, name) {
  const base = selectedDir || wsRoot;
  const clean = name.trim().replace(/[\\/:*?"<>|]/g, '');
  if (!clean) return;
  const full = kind === 'lib'
    ? base + FS_SEP + clean
    : base + FS_SEP + (/\.[a-z0-9]+$/i.test(clean) ? clean : clean + '.md');
  try {
    if (kind === 'lib') {
      await Neutralino.filesystem.createDirectory(full);
    } else {
      await Neutralino.filesystem.writeFile(full, '');
    }
    treeExpanded.add(base);
    await refreshTree();
    if (kind === 'doc') await openWorkspaceFile(full);
    else showToast('Library created', 'success');
  } catch (err) {
    showToast('Create failed: ' + err.message, 'error');
  }
}

// ===========================================================================
// Library item operations: rename / move / duplicate / export / import / trash
// Everything runs on real paths through Neutralino.filesystem (move / copy) and
// the os dialogs. Delete is reversible: items move into a hidden .trash folder
// with a manifest of their original paths, so they can be restored.
// ===========================================================================
function findRow(path) {
  return (
    Array.from(document.querySelectorAll('.files-row')).find(
      (r) => r.dataset.path === path
    ) || null
  );
}

function startRowDrag(e, path, isDir) {
  dragPath = path;
  dragIsDir = isDir;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', path); } catch { /* ignore */ }
}

// Drag & drop move: a document or library can be dropped onto another library
// row (or the tree background = workspace root). The destination is the folder
// row under the pointer, else the library whose list contains the pointer.
function dropDestFromEvent(e) {
  const row = e.target.closest('.files-row.folder');
  if (row) return row.dataset.path;
  const ul = e.target.closest('ul.files-list');
  if (ul) {
    for (const [p, el] of listByPath) if (el === ul) return p;
  }
  return wsRoot;
}

function setupLibraryDnd() {
  filesTree.addEventListener('dragover', (e) => {
    if (!dragPath) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const dest = dropDestFromEvent(e);
    const target = dest && dest !== dragPath ? findRow(dest) : null;
    document.querySelectorAll('.files-row.drop-target').forEach((r) =>
      r.classList.toggle('drop-target', r === target)
    );
    filesTree.classList.toggle('drop-root', !target);
  });
  filesTree.addEventListener('dragleave', (e) => {
    if (e.target === filesTree) clearDropHints();
  });
  filesTree.addEventListener('drop', (e) => {
    if (!dragPath) return;
    e.preventDefault();
    const src = dragPath;
    const isDir = dragIsDir;
    const dest = dropDestFromEvent(e);
    dragPath = null;
    clearDropHints();
    if (dest !== src && dirname(src) !== dest) moveItem(src, dest, isDir);
  });
}

function clearDropHints() {
  filesTree.classList.remove('drop-root');
  document.querySelectorAll('.files-row.drop-target').forEach((r) =>
    r.classList.remove('drop-target')
  );
}

// ─── right-click menu ───
function openFileMenu(evt, path, isDir) {
  evt.preventDefault();
  evt.stopPropagation();
  const items = isDir
    ? [
        ['Rename', () => startRename(path, true)],
        ['Export library…', () => exportLibrary(path)],
        ['Move to Trash', () => deleteItem(path, true)],
      ]
    : [
        ['Rename', () => startRename(path, false)],
        ['Duplicate', () => duplicateItem(path)],
        ['Move to Trash', () => deleteItem(path, false)],
      ];
  filesMenu.innerHTML = '';
  for (const [label, run] of items) {
    const b = document.createElement('button');
    b.className = 'files-menu-item';
    b.textContent = label;
    b.addEventListener('click', () => { closeFileMenu(); run(); });
    filesMenu.appendChild(b);
  }
  filesMenu.hidden = false;
  const w = filesMenu.offsetWidth;
  const h = filesMenu.offsetHeight;
  filesMenu.style.left = Math.max(6, Math.min(evt.clientX, window.innerWidth - w - 6)) + 'px';
  filesMenu.style.top = Math.max(6, Math.min(evt.clientY, window.innerHeight - h - 6)) + 'px';
}

function closeFileMenu() {
  filesMenu.hidden = true;
}

function setupFileMenu() {
  document.addEventListener('click', (e) => {
    if (!filesMenu.hidden && !filesMenu.contains(e.target)) closeFileMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFileMenu(); });
  window.addEventListener('blur', closeFileMenu);
}

// ─── rename (inline input, extension preserved) ───
function startRename(path, isDir) {
  const row = findRow(path);
  const label = row && row.querySelector('.files-name');
  if (!label) return;
  const name = basename(path);
  const ext = isDir ? '' : (name.match(/(\.[a-z0-9]+)$/i) || ['', ''])[1];
  const input = document.createElement('input');
  input.className = 'files-input';
  input.maxLength = 60;
  input.value = ext ? name.slice(0, -ext.length) : name;
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const value = input.value.trim().replace(/[\\/:*?"<>|]/g, '');
    input.replaceWith(label);
    if (commit && value && value + ext !== name) renameItem(path, value + ext);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function renameItem(path, newName) {
  const dest = dirname(path) + FS_SEP + newName;
  try {
    await Neutralino.filesystem.move(path, dest);
    if (currentFile === path) { currentFile = dest; updateFileLabel(); }
    await refreshTree();
    setActiveFile(currentFile);
    showToast('Renamed to ' + newName, 'success');
  } catch (err) {
    showToast('Rename failed: ' + err.message, 'error');
  }
}

// ─── move (drag & drop) ───
async function moveItem(src, destDir, isDir) {
  if (dirname(src) === destDir) return;
  if (isDir && FilesUtil.isUnder(src, destDir, WIN)) {
    showToast("Can't move a library into itself", 'error');
    return;
  }
  const dest = destDir + FS_SEP + basename(src);
  try {
    await Neutralino.filesystem.move(src, dest);
    treeExpanded.add(destDir);
    if (currentFile === src) { currentFile = dest; updateFileLabel(); }
    await refreshTree();
    setActiveFile(currentFile);
    showToast('Moved ' + basename(src), 'success');
  } catch (err) {
    showToast('Move failed: ' + err.message, 'error');
  }
}

// ─── duplicate ───
async function duplicateItem(path) {
  const name = basename(path);
  const dir = dirname(path);
  const ext = (name.match(/(\.[a-z0-9]+)$/i) || ['', ''])[1];
  const stem = ext ? name.slice(0, -ext.length) : name;
  const newName = FilesUtil.uniqueChildName(await readNames(dir), stem + ' copy' + ext);
  try {
    await Neutralino.filesystem.copy(path, dir + FS_SEP + newName, { overwrite: false });
    await refreshTree();
    showToast('Duplicated as ' + newName, 'success');
  } catch (err) {
    showToast('Duplicate failed: ' + err.message, 'error');
  }
}

async function readNames(dir) {
  try {
    const entries = await Neutralino.filesystem.readDirectory(dir);
    return (entries || []).map((e) => e.entry || e.name).filter(Boolean);
  } catch {
    return [];
  }
}

// ─── export / import a library (a folder) ───
async function exportLibrary(path) {
  if (!nativeAvailable) { showToast('Needs the desktop app', 'error'); return; }
  const dest = await Neutralino.os.showFolderDialog('Export library to folder');
  if (!dest) return;
  const target = dest + FS_SEP + basename(path);
  try {
    await Neutralino.filesystem.copy(path, target, { recursive: true, overwrite: false });
    showToast('Exported to ' + target, 'success');
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }
}

async function importLibrary() {
  if (!nativeAvailable) { showToast('Needs the desktop app', 'error'); return; }
  if (!wsRoot) { showToast('Library folder unavailable', 'error'); return; }
  const src = await Neutralino.os.showFolderDialog('Import a library folder');
  if (!src) return;
  const base = selectedDir || wsRoot;
  const name = FilesUtil.uniqueChildName(await readNames(base), basename(src));
  try {
    await Neutralino.filesystem.copy(src, base + FS_SEP + name, { recursive: true, overwrite: false });
    treeExpanded.add(base);
    await refreshTree();
    showToast('Imported library "' + name + '"', 'success');
  } catch (err) {
    showToast('Import failed: ' + err.message, 'error');
  }
}

// ─── trash ───
function trashDir() {
  return wsRoot + FS_SEP + TRASH_ID;
}

async function readTrash() {
  try {
    return JSON.parse(await Neutralino.filesystem.readFile(trashDir() + FS_SEP + 'manifest.json')) || [];
  } catch {
    return [];
  }
}

async function writeTrash(list) {
  await Neutralino.filesystem.writeFile(trashDir() + FS_SEP + 'manifest.json', JSON.stringify(list));
}

// createDirectory errors when the folder already exists, so every delete after
// the first one would fail — create the trash folder only when it is missing.
async function ensureTrashDir() {
  try {
    await Neutralino.filesystem.getStats(trashDir());
  } catch {
    await Neutralino.filesystem.createDirectory(trashDir());
  }
}

function updateTrashBadge(count) {
  filesTrashCount.textContent = String(count);
  filesTrashCount.hidden = count === 0;
  filesTrashBtn.classList.toggle('has-items', count > 0);
}

// Permanently remove a single trashed item.
async function purgeItem(id) {
  try {
    await Neutralino.filesystem.remove(trashDir() + FS_SEP + id).catch(() => {});
    await writeTrash((await readTrash()).filter((e) => e.id !== id));
    await refreshTrash();
    showToast('Deleted permanently', 'info');
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

async function deleteItem(path, isDir) {
  const name = basename(path);
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name,
    isDir,
    orig: path,
    at: Date.now(),
  };
  try {
    await ensureTrashDir();
    await Neutralino.filesystem.move(path, trashDir() + FS_SEP + entry.id);
    const list = await readTrash();
    list.unshift(entry);
    await writeTrash(list);
    updateTrashBadge(list.length);
    if (currentFile === path || (isDir && currentFile && FilesUtil.isUnder(path, currentFile, WIN))) {
      currentFile = null;
      updateFileLabel();
      setActiveFile(null);
    }
    treeExpanded.delete(path);
    await refreshTree();
    showToast('Moved "' + name + '" to Trash', 'info');
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

async function restoreItem(id) {
  const list = await readTrash();
  const entry = list.find((e) => e.id === id);
  if (!entry) return;
  let dest = entry.orig;
  try {
    await Neutralino.filesystem.getStats(dirname(entry.orig));
  } catch {
    dest = wsRoot + FS_SEP + entry.name; // the original folder is gone
  }
  try {
    await Neutralino.filesystem.move(trashDir() + FS_SEP + id, dest);
    await writeTrash(list.filter((e) => e.id !== id));
    await refreshTrash();
    showToast('Restored "' + entry.name + '"', 'success');
  } catch (err) {
    showToast('Restore failed: ' + err.message, 'error');
  }
}

async function emptyTrash() {
  const list = await readTrash();
  if (!list.length) { showToast('Trash is already empty', 'info'); return; }
  const choice = await Neutralino.os.showMessageBox(
    'Empty Trash',
    'Permanently delete ' + list.length + ' item(s)?',
    'YES_NO',
    'WARNING'
  );
  if (choice !== 'YES') return;
  try {
    for (const e of list) {
      await Neutralino.filesystem.remove(trashDir() + FS_SEP + e.id).catch(() => {});
    }
    await writeTrash([]);
    await refreshTrash();
    showToast('Trash emptied', 'info');
  } catch (err) {
    showToast('Empty failed: ' + err.message, 'error');
  }
}

async function refreshTrash() {
  filesTree.innerHTML = '';
  listByPath.clear();
  const list = await readTrash();
  const ul = document.createElement('ul');
  ul.className = 'files-list';
  for (const e of list) ul.appendChild(makeTrashRow(e));
  filesTree.appendChild(ul);
  filesEmpty.hidden = list.length > 0;
  filesEmpty.textContent = 'Trash is empty.';
  updateTrashBadge(list.length);
}

function makeTrashRow(e) {
  const li = document.createElement('li');
  li.className = 'files-item';
  const row = document.createElement('div');
  row.className = 'files-row file trash';
  row.title = e.orig;
  const icon = document.createElement('span');
  icon.className = 'files-icon';
  icon.appendChild(svgIcon(e.isDir ? 'folder' : 'file', 13));
  const label = document.createElement('span');
  label.className = 'files-name';
  label.textContent = e.name;
  const restore = document.createElement('button');
  restore.className = 'files-del files-restore';
  restore.title = 'Restore';
  restore.appendChild(svgIcon('restore', 13));
  restore.addEventListener('click', (ev) => { ev.stopPropagation(); restoreItem(e.id); });
  const purge = document.createElement('button');
  purge.className = 'files-del';
  purge.title = 'Delete permanently';
  purge.appendChild(svgIcon('close', 13));
  purge.addEventListener('click', (ev) => { ev.stopPropagation(); purgeItem(e.id); });
  row.appendChild(icon);
  row.appendChild(label);
  row.appendChild(restore);
  row.appendChild(purge);
  li.appendChild(row);
  return li;
}

function toggleTrash() {
  trashMode = !trashMode;
  filesTrashBtn.classList.toggle('active', trashMode);
  filesEmptyTrashBtn.hidden = !trashMode;
  filesSearch.value = '';
  filterQuery = '';
  closeFileMenu();
  if (trashMode) refreshTrash();
  else refreshTree();
}

function setFilesPanel(open) {
  filesOpen = open;
  document.body.classList.toggle('files-open', open);
  filesToggleBtn.classList.toggle('active', open);
  if (open && wsRoot) refreshTree();
}

function toggleFilesPanel() {
  if (!nativeAvailable) { showToast('Files panel needs the desktop app', 'error'); return; }
  if (!wsRoot) { showToast('Library folder unavailable', 'error'); return; }
  setFilesPanel(!filesOpen);
}

// ===========================================================================
// Drag & drop: open dropped .md files (emitDropEvents gives real paths)
// ===========================================================================
function setupDropHandler() {
  Neutralino.events.on('filesDropped', async (evt) => {
    const files = evt.detail.files || [];
    const mdFile = files.find((f) => /\.(md|markdown|txt)$/i.test(f));
    if (!mdFile) {
      showToast('Drop a .md file to open it', 'error');
      return;
    }
    if (!(await confirmDiscard())) return;
    try {
      const content = await Neutralino.filesystem.readFile(mdFile);
      editor.value = content;
      mdState = content;
      currentFile = mdFile;
      await renderDocument(content);
      setMode('edit');
      updateFileLabel();
      setActiveFile(mdFile);
      showToast('Opened ' + basename(mdFile), 'success');
    } catch (err) {
      showToast('Failed to read file: ' + err.message, 'error');
    }
  });
}

// ===========================================================================
// Formatting toolbar (WYSIWYG document mode)
// Clicking any toolbar control blurs the rendered document and Chromium
// clears the editing selection — so every interaction first saves the current
// selection and every command restores it before running execCommand.
// ===========================================================================
let savedRange = null;

function saveSelection() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const page = docContent.querySelector('.document-page');
  if (page && page.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
}

function restoreSelection() {
  const page = docContent.querySelector('.document-page');
  if (!page) return;
  const sel = window.getSelection();
  if (savedRange && page.contains(savedRange.startContainer)) {
    page.focus({ preventScroll: true });
    sel.removeAllRanges();
    sel.addRange(savedRange);
    return;
  }
  // fallback: caret at the end of the document
  page.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(page);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function fmtExec(cmd, value) {
  const sel = window.getSelection();
  const page = docContent.querySelector('.document-page');
  const inPage = sel.rangeCount && page && page.contains(sel.anchorNode);
  if (!inPage) restoreSelection();
  document.execCommand(cmd, false, value || null);
  saveSelection();
}

function fmtInlineCode() {
  const sel = window.getSelection();
  const page = docContent.querySelector('.document-page');
  if (!(sel.rangeCount && page && page.contains(sel.anchorNode))) restoreSelection();
  if (!sel.rangeCount) return;
  if (sel.isCollapsed) {
    fmtExec('insertHTML', '<code></code>');
    return;
  }
  const range = sel.getRangeAt(0);
  const code = document.createElement('code');
  try {
    range.surroundContents(code);
  } catch {
    // multi-node selection: replace with a code element
    fmtExec('insertHTML', '<code>' + range.toString() + '</code>');
  }
  saveSelection();
}

function fmtPageBreak() {
  fmtExec('insertHTML', '<div class="page-break" contenteditable="false"></div><p><br></p>');
}

// Toggle the generated Índice in the WYSIWYG view. The index is rebuilt from
// the document headings (h1–h3), which carry their anchor ids — so it can be
// inserted/removed without touching the source; the serializer writes
// \tableofcontents when the index is present and nothing when it is not.
function fmtToc() {
  const page = docContent.querySelector('.document-page');
  if (!page || !page.innerText.trim()) {
    showToast('Write the document first', 'error');
    return;
  }
  const tocs = page.querySelectorAll('.document-toc');
  if (tocs.length) {
    tocs.forEach((n) => n.remove());
    showToast('Índice removed', 'info');
  } else {
    const nav = document.createElement('nav');
    nav.className = 'document-toc';
    nav.contentEditable = 'false';
    const title = document.createElement('h2');
    title.className = 'toc-title';
    title.textContent = 'Índice';
    nav.appendChild(title);
    const ul = document.createElement('ul');
    ul.className = 'toc-list';
    let idx = 0;
    page.querySelectorAll('h1, h2, h3').forEach((h) => {
      if (h.closest('.document-header, .document-toc')) return;
      idx += 1;
      const id = h.id || 'sec-' + idx;
      if (!h.id) h.id = id;
      const li = document.createElement('li');
      li.className = 'toc-item toc-lvl-' + h.tagName.slice(1);
      const a = document.createElement('a');
      a.href = '#' + id;
      a.textContent = h.textContent.trim();
      li.appendChild(a);
      ul.appendChild(li);
    });
    if (!ul.children.length) {
      showToast('No headings to index — add H1–H3 first', 'error');
      return;
    }
    nav.appendChild(ul);
    // the index opens the document, right after the generated title header
    const header = page.querySelector('.document-header');
    if (header && header.nextSibling) {
      header.parentNode.insertBefore(nav, header.nextSibling);
    } else {
      page.insertBefore(nav, page.firstChild);
    }
    nav.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', (evt) => {
        evt.preventDefault();
        const target = page.querySelector(a.getAttribute('href'));
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    showToast('Índice added — generated from headings', 'info');
  }
  // programmatic DOM edits fire no input event — sync state manually
  setStatus('typing', 'Editing…');
  updateWordCount(docText());
  scheduleDraftSave();
  clearTimeout(serializeTimer);
  serializeTimer = setTimeout(() => {
    try {
      mdState = domToMarkdown();
    } catch (err) {
      console.warn('Serialize failed:', err);
    }
    updatePageGuides();
    setStatus('saved', 'Ready');
  }, 400);
}

function fmtTable(rows, cols) {
  let html = '<table><thead><tr>';
  for (let c = 1; c <= cols; c++) html += '<th>Header ' + c + '</th>';
  html += '</tr></thead><tbody>';
  for (let r = 1; r <= rows; r++) {
    html += '<tr>';
    for (let c = 1; c <= cols; c++) html += '<td>Cell ' + r + '-' + c + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table><p><br></p>';
  fmtExec('insertHTML', html);
}

function fmtImageUrl(url, alt) {
  fmtExec('insertHTML', '<img src="' + url.replace(/"/g, '&quot;') + '" alt="' + escapeHtml(alt || 'Image') + '">');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fmtImageFile() {
  if (!nativeAvailable) { showToast('Native file dialog unavailable here', 'error'); return; }
  const entries = await Neutralino.os.showOpenDialog('Insert image', {
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
  });
  if (!entries || !entries.length) return;
  const path = entries[0];
  try {
    const buffer = await Neutralino.filesystem.readBinaryFile(path);
    const ext = (path.split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext;
    const dataUri = 'data:image/' + mime + ';base64,' + arrayBufferToBase64(buffer);
    fmtImageUrl(dataUri, basename(path).replace(/\.[^.]+$/, ''));
    closeFmtPopover();
    showToast('Image inserted and embedded in the document', 'success');
  } catch (err) {
    showToast('Failed to read image: ' + err.message, 'error');
  }
}

// ─── mini popover for link / image / table ───
function closeFmtPopover() {
  fmtPopover.hidden = true;
  fmtPopoverBody.innerHTML = '';
}

function positionFmtPopover(anchor) {
  const r = anchor.getBoundingClientRect();
  fmtPopover.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 280)) + 'px';
  fmtPopover.style.top = (r.bottom + 8) + 'px';
  fmtPopover.hidden = false;
}

function openFmtPopover(mode, anchor) {
  const input = '<input type="text" id="ppUrl" placeholder="https://… or data:…" spellcheck="false">';
  if (mode === 'link') {
    fmtPopoverBody.innerHTML =
      '<label for="ppUrl">Link URL</label>' + input +
      '<div class="pp-actions"><button class="btn btn-primary" id="ppOk">Insert link</button></div>';
  } else if (mode === 'image') {
    fmtPopoverBody.innerHTML =
      '<label for="ppUrl">Image URL (or pick a file)</label>' + input +
      '<div class="pp-actions">' +
      '<button class="btn btn-ghost" id="ppFile">From file…</button>' +
      '<button class="btn btn-primary" id="ppOk">Insert image</button></div>';
  } else if (mode === 'table') {
    fmtPopoverBody.innerHTML =
      '<div class="pp-row"><label for="ppRows">Rows</label>' +
      '<input type="number" id="ppRows" min="1" max="30" value="3"></div>' +
      '<div class="pp-row"><label for="ppCols">Columns</label>' +
      '<input type="number" id="ppCols" min="1" max="10" value="3"></div>' +
      '<div class="pp-actions"><button class="btn btn-primary" id="ppOk">Insert table</button></div>';
  } else {
    return;
  }
  positionFmtPopover(anchor);

  const ok = document.getElementById('ppOk');
  const fileBtn = document.getElementById('ppFile');
  if (mode === 'link') {
    ok.addEventListener('click', () => {
      const url = document.getElementById('ppUrl').value.trim();
      if (url) { fmtExec('createLink', url); closeFmtPopover(); }
    });
  } else if (mode === 'image') {
    ok.addEventListener('click', () => {
      const url = document.getElementById('ppUrl').value.trim();
      if (url) { fmtImageUrl(url, 'Image'); closeFmtPopover(); }
    });
    if (fileBtn) fileBtn.addEventListener('click', fmtImageFile);
  } else if (mode === 'table') {
    ok.addEventListener('click', () => {
      const rows = Math.max(1, Math.min(30, parseInt(document.getElementById('ppRows').value, 10) || 1));
      const cols = Math.max(1, Math.min(10, parseInt(document.getElementById('ppCols').value, 10) || 1));
      fmtTable(rows, cols);
      closeFmtPopover();
    });
  }
  const first = fmtPopoverBody.querySelector('input');
  if (first) setTimeout(() => first.focus(), 0);
}

// ─── toolbar wiring ───
function setupFormatBar() {
  document.execCommand('styleWithCSS', false, true);

  // any interaction with the bar first saves the document selection
  formatBar.addEventListener('mousedown', saveSelection, true);

  formatBar.querySelectorAll('.fmt-btn[data-cmd]').forEach((btn) => {
    // keep the document selection while clicking toolbar buttons
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      switch (btn.getAttribute('data-cmd')) {
        case 'bold': fmtExec('bold'); break;
        case 'italic': fmtExec('italic'); break;
        case 'underline': fmtExec('underline'); break;
        case 'strikeThrough': fmtExec('strikeThrough'); break;
        case 'h1': fmtExec('formatBlock', 'h1'); break;
        case 'h2': fmtExec('formatBlock', 'h2'); break;
        case 'h3': fmtExec('formatBlock', 'h3'); break;
        case 'p': fmtExec('formatBlock', 'p'); break;
        case 'blockquote': fmtExec('formatBlock', 'blockquote'); break;
        case 'pre': fmtExec('formatBlock', 'pre'); break;
        case 'code': fmtInlineCode(); break;
        case 'ul': fmtExec('insertUnorderedList'); break;
        case 'ol': fmtExec('insertOrderedList'); break;
        case 'hr': fmtExec('insertHorizontalRule'); break;
        case 'pagebreak': fmtPageBreak(); break;
      }
    });
  });

  const fmtColor = document.getElementById('fmtColor');
  const fmtHilite = document.getElementById('fmtHilite');
  const fmtSize = document.getElementById('fmtSize');
  const fmtFont = document.getElementById('fmtFont');
  fmtColor.addEventListener('change', () => { if (fmtColor.value) fmtExec('foreColor', fmtColor.value); fmtColor.value = ''; });
  fmtHilite.addEventListener('change', () => { if (fmtHilite.value) fmtExec('hiliteColor', fmtHilite.value); fmtHilite.value = ''; });
  fmtSize.addEventListener('change', () => { if (fmtSize.value) fmtExec('fontSize', fmtSize.value); fmtSize.value = ''; });
  fmtFont.addEventListener('change', () => { if (fmtFont.value) fmtExec('fontName', fmtFont.value); fmtFont.value = ''; });

  document.getElementById('fmtLink').addEventListener('mousedown', (e) => e.preventDefault());
  document.getElementById('fmtImage').addEventListener('mousedown', (e) => e.preventDefault());
  document.getElementById('fmtTable').addEventListener('mousedown', (e) => e.preventDefault());
  document.getElementById('fmtToc').addEventListener('mousedown', (e) => e.preventDefault());
  document.getElementById('fmtLink').addEventListener('click', (e) => openFmtPopover('link', e.currentTarget));
  document.getElementById('fmtImage').addEventListener('click', (e) => openFmtPopover('image', e.currentTarget));
  document.getElementById('fmtTable').addEventListener('click', (e) => openFmtPopover('table', e.currentTarget));
  document.getElementById('fmtToc').addEventListener('click', fmtToc);

  // click outside the popover closes it (but not the trigger click that
  // just opened it — that event bubbles up from the insert buttons)
  document.addEventListener('click', (e) => {
    if (fmtPopover.hidden) return;
    if (e.target.closest('#fmtLink, #fmtImage, #fmtTable')) return;
    if (!fmtPopover.contains(e.target)) closeFmtPopover();
  });
  window.addEventListener('resize', closeFmtPopover);
}

// ===========================================================================
// Event wiring
// ===========================================================================
// Document view: direct editing of the rendered document (edit mode only)
docContent.addEventListener('input', (e) => {
  if (mode !== 'edit') return;
  if (!e.target.closest('.document-page')) return;
  setStatus('typing', 'Editing…');
  updateWordCount(docText());
  scheduleDraftSave();
  clearTimeout(serializeTimer);
  serializeTimer = setTimeout(() => {
    try {
      mdState = domToMarkdown();
    } catch (err) {
      console.warn('Serialize failed:', err);
    }
    updatePageGuides(); // always re-paginate, even if serialization failed
    setStatus('saved', 'Ready');
  }, 600);
});

// Paste into the rendered document: images are embedded as data URIs (so they
// serialize to ![alt](data:…) and print), everything else as plain text.
docContent.addEventListener('paste', (e) => {
  if (mode !== 'edit') return;
  if (!e.target.closest('.document-page')) return;
  const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
  const imageItem = items.find((it) => it.type && it.type.startsWith('image/'));
  if (imageItem) {
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => fmtImageUrl(reader.result, 'Pasted image');
    reader.readAsDataURL(file);
    return;
  }
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
});

// Enter in the rendered document creates real paragraphs (<p>) so the
// serialized Markdown stays clean (Chromium's default is <div>).
docContent.addEventListener('keydown', (e) => {
  if (mode !== 'edit') return;
  if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey) return;
  if (!e.target.closest('.document-page')) return;
  if (e.target.closest('table')) return; // native cell navigation in tables
  e.preventDefault();
  document.execCommand('insertParagraph');
});

// Markdown view: source editing
editor.addEventListener('input', () => {
  setStatus('typing', 'Editing…');
  mdState = editor.value;
  updateWordCount(editor.value);
  scheduleDraftSave();
  clearTimeout(serializeTimer);
  serializeTimer = setTimeout(() => {
    setStatus('saved', 'Ready');
  }, 400);
});

editor.addEventListener('keyup', updateCursorPos);
editor.addEventListener('click', updateCursorPos);

newBtn.addEventListener('click', newDocument);
openBtn.addEventListener('click', openFile);
saveBtn.addEventListener('click', saveFile);
loadSampleBtn.addEventListener('click', loadSample);
downloadBtn.addEventListener('click', exportPdf);
editModeBtn.addEventListener('click', switchToEdit);
mdModeBtn.addEventListener('click', switchToMarkdown);
filesToggleBtn.addEventListener('click', toggleFilesPanel);
newLibBtn.addEventListener('click', () => startCreate('lib'));
newDocBtn.addEventListener('click', () => startCreate('doc'));
filesRefreshBtn.addEventListener('click', () => { if (wsRoot) refreshTree(); });
filesImportBtn.addEventListener('click', importLibrary);
filesTrashBtn.addEventListener('click', toggleTrash);
filesEmptyTrashBtn.addEventListener('click', emptyTrash);
filesSort.addEventListener('change', () => {
  sortMode = filesSort.value === 'modified' ? 'modified' : 'name';
  if (!trashMode) refreshTree();
});
filesSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    filterQuery = filesSearch.value;
    if (!trashMode) refreshTree();
  }, 150);
});

// Keyboard shortcuts (all features live in the UI toolbar; no native menu)
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.shiftKey && k === 'd') { e.preventDefault(); exportPdf(); }
  else if (e.shiftKey && k === 's') { e.preventDefault(); saveAs(); }
  else if (k === 's') { e.preventDefault(); saveFile(); }
  else if (k === 'o') { e.preventDefault(); openFile(); }
  else if (k === 'n') { e.preventDefault(); newDocument(); }
  else if (k === 'e') { e.preventDefault(); toggleMode(); }
});

// ─── Startup ───
// Neutralino.init() is fire-and-forget (returns undefined); native APIs become
// available when the client library dispatches the window 'ready' event.
// Without a Neutralino backend the call throws synchronously — that is fine:
// the fallback below renders the sample as a pure web page.
try {
  Neutralino.init();
} catch (err) {
  console.warn('Running without a Neutralino backend:', err);
}

window.addEventListener('ready', async () => {
  nativeAvailable = true;
  // Start maximized so the window fills the screen (work area) without
  // exceeding its bounds, regardless of any saved window geometry.
  Neutralino.window.maximize().catch(() => {});
  initMermaid();
  setupFormatBar();
  setupDropHandler();
  setupFileMenu();
  setupLibraryDnd();
  await initWorkspace();
  if (wsRoot) {
    setFilesPanel(true);
    updateTrashBadge((await readTrash()).length);
  }
  await restoreDraftOrSample();
});

// Fallback: if no Neutralino backend is present (e.g. plain web server),
// render the sample so the UI is still usable as a pure web page.
setTimeout(() => {
  if (!nativeAvailable) {
    initMermaid();
    setupFormatBar();
    loadSampleQuiet();
  }
}, 1500);
