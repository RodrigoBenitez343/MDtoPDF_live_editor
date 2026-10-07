// ============================================================================
// pagination.js — deterministic pagination engine (DocMaster desktop app)
//
// ONE fragmentation model drives BOTH the on-screen page-fold guides in the
// Edit view and the exported PDF:
//
//   • updatePageGuides()  — measures the live .document-page and overlays a
//     thin fold line + "Page N of M" label exactly where every printed page
//     will end (content-fit: paragraphs split at line boundaries, lists
//     between <li>, tables between rows, headings keep with their content).
//
//   • buildPrintSheets()  — clones the live document and physically splits it
//     into .print-page sheets whose content box is EXACTLY the document content
//     box (154 mm × 247 mm: full 210×297mm sheets minus the 2.5cm/2.8cm
//     padding that carries the page margins). One sheet prints as exactly one
//     PDF page, so the dialog's margin/scaling choices can no longer move page
//     breaks — the exported pages are always the pages the fold guides show.
//
// Fragmentation rules follow the print stylesheet: margins collapse between
// siblings inside a page and are truncated at page breaks; paragraph / <pre>
// boxes split at word / line boundaries; everything else moves whole.
// ============================================================================
'use strict';

const PAGE_CONTENT_H_PX = Math.round((297 - 50) * 96 / 25.4); // 247mm ≈ 934px
const PAGE_MIN_REMAIN_PX = 60; // heading keep-with-next guard
const MIN_FRAGMENT_PX = 18;    // less room than a line → start a new page
const CUT_SEARCH_RANGE = 60;   // word-boundary search radius when splitting
let lastPlan = null;           // pages from the last screen-media pagination

// ---------------------------------------------------------------------------
// Flat-text helpers (offsets run over el.textContent, preserving inline
// markup when a paragraph / code block is cut)
// ---------------------------------------------------------------------------
function textLengthOf(el) {
  const t = el.textContent;
  return t ? t.length : 0;
}

function flatTextNodes(root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) out.push(walker.currentNode);
  return out;
}

// Range spanning the flat-text interval [a, b) inside root
function flatTextRange(root, a, b) {
  const nodes = flatTextNodes(root);
  const range = document.createRange();
  let startNode = null;
  let startOff = 0;
  let endNode = null;
  let endOff = 0;
  let acc = 0;
  for (const n of nodes) {
    const len = n.nodeValue.length;
    if (startNode === null && a >= acc && a <= acc + len) {
      startNode = n;
      startOff = a - acc;
    }
    if (endNode === null && b >= acc && b <= acc + len) {
      endNode = n;
      endOff = b - acc;
    }
    acc += len;
  }
  if (!startNode) {
    const last = nodes[nodes.length - 1] || root;
    startNode = last;
    startOff = last.nodeType === 3 ? last.nodeValue.length : 0;
  }
  if (!endNode) {
    const last = nodes[nodes.length - 1] || root;
    endNode = last;
    endOff = last.nodeType === 3 ? last.nodeValue.length : 0;
  }
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  return range;
}

// Measured rendered height of el's flat-text slice [from, to)
function measureSliceHeight(el, from, to) {
  if (to <= from || !el.parentNode) return 0;
  const probe = el.cloneNode(true);
  probe.removeAttribute('id');
  const len = textLengthOf(probe);
  if (from > 0 && from < len) flatTextRange(probe, 0, from).deleteContents();
  const rest = textLengthOf(probe);
  const want = to - from;
  if (rest > want) flatTextRange(probe, want, rest).deleteContents();
  el.parentNode.insertBefore(probe, el.nextSibling);
  const h = probe.offsetHeight || 0;
  probe.remove();
  return h;
}

// Snap a candidate cut toward a word / line boundary. `min` is the current
// search lower bound, so an aligned cut is always > min (never regresses).
function alignCut(text, mid, mode, min) {
  // prefer a break after `mid` (searching forward keeps the offset growing)
  for (let i = 0; i <= CUT_SEARCH_RANGE && mid + i < text.length; i++) {
    const c = text[mid + i];
    if ((mode === 'line' && c === '\n') || (mode === 'word' && (c === ' ' || c === '\n' || c === '\u00a0'))) {
      return mid + i + 1;
    }
  }
  // otherwise take the last break before `mid` (still above `min`)
  for (let i = 1; i <= CUT_SEARCH_RANGE && mid - i > min; i++) {
    const c = text[mid - i];
    if ((mode === 'line' && c === '\n') || (mode === 'word' && (c === ' ' || c === '\n' || c === '\u00a0'))) {
      return mid - i + 1;
    }
  }
  return -1;
}

// Largest slice [from, to) whose measured height fits maxH (binary search)
function measureFragment(el, from, maxH, mode) {
  const len = textLengthOf(el);
  if (from >= len) return { to: from, h: 0 };
  const text = el.textContent || '';
  let lo = from;
  let hi = len;
  let guard = 0;
  while (lo < hi) {
    if (++guard > 120) {
      throw new Error('pagination stall: measureFragment binary search');
    }
    const mid = Math.ceil((lo + hi) / 2);
    let cut = alignCut(text, mid, mode, lo);
    if (cut === -1 || cut <= lo) cut = mid;
    if (cut > len) cut = len;
    const fits = measureSliceHeight(el, from, cut) <= maxH + 0.5;
    if (fits) lo = cut;
    else hi = mid - 1;
  }
  if (lo <= from) return { to: from, h: 0 };
  return { to: lo, h: measureSliceHeight(el, from, lo) };
}

// ---------------------------------------------------------------------------
// Unit collection — flatten the live document into ordered fragmentable boxes
// ---------------------------------------------------------------------------
function hasOwnText(el) {
  const t = el.textContent;
  return !!(t && t.trim());
}

function unitTop(u) {
  if (u.kind === 'text') {
    const probe = document.createElement('p');
    probe.textContent = u.el.nodeValue;
    probe.style.margin = '0';
    u.el.parentNode.insertBefore(probe, u.el);
    const top = probe.offsetTop || 0;
    probe.remove();
    return top;
  }
  return u.el.offsetTop || 0;
}

function unitHeight(u) {
  if (u.kind === 'text') {
    const probe = document.createElement('p');
    probe.textContent = u.el.nodeValue;
    probe.style.margin = '0';
    u.el.parentNode.insertBefore(probe, u.el);
    const h = probe.offsetHeight || 0;
    probe.remove();
    return h;
  }
  return u.el.offsetHeight || 0;
}

// Collapsed vertical gap between two flow-consecutive units (≥ 0)
function flowGap(a, b) {
  return Math.max(0, unitTop(b) - (unitTop(a) + unitHeight(a)));
}

function expandTable(el, units) {
  const theadRows = [];
  const footRows = [];
  const dataRows = [];
  for (const tr of Array.from(el.rows)) {
    const parent = tr.parentElement;
    const sec = parent ? parent.tagName : '';
    if (sec === 'THEAD') theadRows.push(tr);
    else if (sec === 'TFOOT') footRows.push(tr);
    else dataRows.push(tr);
  }
  // A one-row (or header-only) table is atomic — no fragmenting needed
  if (!dataRows.length) {
    units.push({ kind: 'block', el });
    return;
  }
  const headerH = theadRows.reduce((s, tr) => s + (tr.offsetHeight || 0), 0);
  const meta = { table: el, theadRows, footRows, headerH, hasHeader: theadRows.length > 0 };
  const all = dataRows.concat(footRows);
  const lastIdx = all.length - 1;
  for (let i = 0; i < all.length; i++) {
    units.push({
      kind: 'tr',
      el: all[i],
      table: el,
      tableMeta: meta,
      rowIndex: i,
      isFirstRow: i === 0,
      isLastRow: i === lastIdx,
    });
  }
}

function collectUnits(page) {
  const units = [];
  const visit = (el) => {
    if (!el || el.nodeType !== 1) return;
    const cls = el.classList;
    if (cls.contains('page-guide')) return;
    if (cls.contains('page-break')) { units.push({ kind: 'break', el }); return; }
    if (cls.contains('document-toc')) { units.push({ kind: 'toc', el }); return; }
    if (cls.contains('mermaid') || cls.contains('highlight-box')) {
      units.push({ kind: 'block', el });
      return;
    }
    const tag = el.tagName;
    if (tag === 'UL' || tag === 'OL') {
      let idx = 0;
      for (const li of el.children) {
        if (li.tagName === 'LI') {
          units.push({ kind: 'li', el: li, list: el, listIndex: idx });
          idx += 1;
        }
      }
      return;
    }
    if (tag === 'TABLE') { expandTable(el, units); return; }
    if (tag === 'P') {
      units.push({ kind: hasOwnText(el) ? 'p' : 'block', el });
      return;
    }
    if (tag === 'PRE') {
      units.push({ kind: hasOwnText(el) ? 'pre' : 'block', el });
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      units.push({ kind: 'heading', el, level: Number(tag[1]) });
      return;
    }
    // Everything else (hr, img, div, blockquote, figure, …) is atomic
    units.push({ kind: 'block', el });
  };
  for (const child of Array.from(page.childNodes)) {
    if (child.nodeType === 1) visit(child);
    else if (child.nodeType === 3 && child.nodeValue.trim()) {
      units.push({ kind: 'text', el: child });
    }
  }
  return units;
}

// ---------------------------------------------------------------------------
// Planning — decide where every page ends (content-fit)
// Returns pages: [{ frags: [{ u, whole, from, to }] }]
// ---------------------------------------------------------------------------
function paginateUnits(units) {
  // A few px of safety slack so accumulated sub-pixel rounding can never push
  // the last line of a sheet past the fixed 247mm sheet height (which would
  // clip it). Guides are drawn from the same budget, so preview = PDF stays.
  const BUDGET = PAGE_CONTENT_H_PX - 8;
  const pages = [];
  let page = null;   // current open page (only non-null while it holds content)
  let used = 0;      // content height consumed on the current page
  let flowTail = null; // last flow unit fully completed
  let breakPending = false;

  const openPage = () => {
    page = { frags: [] };
    used = 0;
    pages.push(page);
  };
  // Close the current page (keep it in `pages`); next placement opens a new one
  const closePage = () => {
    page = null;
    used = 0;
  };

  const placeWhole = (u, gap, extraH) => {
    page.frags.push({ u, whole: true, from: 0, to: null });
    used += gap + extraH;
  };

  const placeFragment = (u, from, to, fragH, gap) => {
    page.frags.push({ u, whole: false, from, to });
    used += gap + fragH;
  };

  // A paragraph / <pre> that cannot fit whole: consume it page by page,
  // cutting the text at the exact line/word boundary each page allows.
  const consumeFragile = (u, mode) => {
    const len = textLengthOf(u.el);
    if (len === 0) {
      placeWhole(u, gapFor(u), unitHeight(u));
      flowTail = u;
      return;
    }
    let from = 0;
    let gapUsed = false;
    let guard = 0;
    while (from < len) {
      if (++guard > Math.max(2000, len * 4 + 80)) {
        throw new Error('pagination stall: fragile unit not consumed');
      }
      if (!page) openPage();
      if (used >= BUDGET - 0.5) { closePage(); continue; }
      let gap = 0;
      if (!gapUsed) {
        gap = page.frags.length ? flowGap(flowTail, u) : 0;
        gapUsed = true;
      }
      const avail = Math.max(0, BUDGET - used - gap);
      if (avail < MIN_FRAGMENT_PX) { closePage(); continue; }
      const frag = measureFragment(u.el, from, avail, mode);
      if (frag.to > from) {
        placeFragment(u, from, frag.to, frag.h, gap);
        from = frag.to;
        // The paragraph consumed the whole page? Roll to the next one.
        if (used >= BUDGET - 0.5 && from < len) closePage();
      } else if (avail >= MIN_FRAGMENT_PX) {
        // No word boundary near the candidate — force raw progress so the
        // loop can never stall on an unbreakable token.
        const forced = Math.min(len, from + Math.max(1, Math.floor(avail / 8)));
        const h = measureSliceHeight(u.el, from, forced);
        if (forced > from) {
          placeFragment(u, from, forced, h, gap);
          from = forced;
        } else {
          closePage();
        }
      } else {
        closePage();
      }
    }
    flowTail = u;
  };

  // Margin that applies when placing `u` onto the currently open page
  const gapFor = (u) => (page && page.frags.length ? flowGap(flowTail, u) : 0);

  const placeAtomic = (u) => {
    const h = unitHeight(u);
    let gap = gapFor(u);
    // Headings keep with their following content (60px bottom guard)
    if (
      u.kind === 'heading' &&
      page && page.frags.length &&
      used + gap + h > BUDGET - PAGE_MIN_REMAIN_PX
    ) {
      closePage();
      gap = 0;
    }
    const onFresh = !page || page.frags.length === 0;
    const fits = onFresh ? h <= BUDGET + 0.5 : used + gap + h <= BUDGET + 0.5;
    if (!fits) {
      // Monolithic blocks taller than a page still get a fresh page; the
      // fixed sheet clips the overflow (nothing else the engine can do).
      closePage();
      gap = 0;
    }
    if (!page) openPage();
    placeWhole(u, gap, h);
    flowTail = u;
  };

  // Table rows are atomic; when a split table crosses a page the repeated
  // <thead> block must be reserved on every continuation page (print repeats
  // the header group on each page of a split table).
  const placeTr = (u) => {
    const meta = u.tableMeta || { headerH: 0, hasHeader: false };
    const h = unitHeight(u);
    let attempts = 0;
    while (true) {
      if (!page) openPage();
      const onFresh = page.frags.length === 0;
      const gap = onFresh ? 0 : gapFor(u);
      const headerReserve =
        onFresh && meta.hasHeader && meta.headerH > 0 ? meta.headerH : 0;
      const fits =
        used + headerReserve + gap + h <= BUDGET + 0.5;
      if (fits || attempts >= 1) {
        if (headerReserve) used = headerReserve;
        page.frags.push({ u, whole: true, from: 0, to: null });
        used += gap + h;
        flowTail = u;
        break;
      }
      closePage();
      if (++attempts > 8) {
        throw new Error('pagination stall: table row placement');
      }
    }
  };

  for (const u of units) {
    if (u.kind === 'break') {
      // Explicit \newpage marker: content after it begins a new page. The
      // marker itself has no printed height.
      breakPending = true;
      continue;
    }
    if (breakPending) {
      if (page && page.frags.length) closePage();
      breakPending = false;
    }
    if (u.kind === 'p') { consumeFragile(u, 'word'); continue; }
    if (u.kind === 'pre') { consumeFragile(u, 'line'); continue; }
    if (u.kind === 'toc') {
      placeAtomic(u);
      // The Índice always ends its page (matches the print stylesheet)
      closePage();
      continue;
    }
    if (u.kind === 'tr') { placeTr(u); continue; }
    placeAtomic(u);
  }
  return pages;
}

// Any print entry point (the neutralino native dialog, Ctrl+P, a browser's
// Print…) gets the same deterministic sheets. The app's export button builds
// them first; beforeprint only kicks in when nothing is prepared yet, and
// afterprint restores the editing view.
window.addEventListener('beforeprint', () => {
  try {
    if (mode !== 'edit') return;
    if (document.getElementById('printRoot')) return;
    const page = docContent && docContent.querySelector('.document-page');
    if (!page || !(page.innerText || '').trim()) return;
    buildPrintSheets();
  } catch (err) {
    console.warn('beforeprint pagination failed:', err);
  }
});

window.addEventListener('afterprint', () => {
  try {
    cleanupPrintSheets();
  } catch (err) {
    console.warn('afterprint cleanup failed:', err);
  }
});

// ---------------------------------------------------------------------------
// Fold guides (Edit view)
// ---------------------------------------------------------------------------
function fragTop(frag) {
  const u = frag.u;
  if (!frag.whole && frag.from > 0) {
    return unitTop(u) + measureSliceHeight(u.el, 0, frag.from);
  }
  return unitTop(u);
}

function drawFolds(pages) {
  const page = docContent.querySelector('.document-page');
  if (!page) return;
  page.querySelectorAll('.page-guide').forEach((n) => n.remove());
  const total = pages.length;
  for (let i = 1; i < total; i++) {
    const first = pages[i].frags[0];
    if (!first) continue;
    const guide = document.createElement('div');
    guide.className = 'page-guide';
    guide.contentEditable = 'false';
    guide.style.top = fragTop(first) + 'px';
    const label = document.createElement('span');
    label.className = 'page-guide-label';
    label.textContent = 'Page ' + (i + 1) + ' of ' + total;
    guide.appendChild(label);
    page.appendChild(guide);
  }
}

// Recompute the page-fold guides. Runs after every render and (debounced)
// after edits. Measurement-only — the document flow is never touched except
// for temporary probes that are removed synchronously.
function updatePageGuides() {
  const page = docContent.querySelector('.document-page');
  const countEl = document.getElementById('pageCount');
  if (page) page.querySelectorAll('.page-guide').forEach((n) => n.remove());
  if (mode !== 'edit' || !page || !(page.innerText || '').trim()) {
    if (countEl) countEl.textContent = '';
    return;
  }
  try {
    const units = collectUnits(page);
    if (!units.length) {
      if (countEl) countEl.textContent = '';
      return;
    }
    const pages = paginateUnits(units);
    lastPlan = pages; // cached so a print in hidden media can reuse real measurements
    drawFolds(pages);
    const total = pages.length;
    if (countEl) countEl.textContent = total + (total === 1 ? ' page' : ' pages');
  } catch (err) {
    // Guides are decorative — never let measurement break editing
    console.warn('Pagination guides failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Print-sheet builder (deterministic export)
// ---------------------------------------------------------------------------
function sliceClone(el, from, to) {
  const c = el.cloneNode(true);
  c.removeAttribute('id');
  const len = textLengthOf(c);
  if (from > 0 && from < len) flatTextRange(c, 0, from).deleteContents();
  const rest = textLengthOf(c);
  const want = to - from;
  if (rest > want) flatTextRange(c, want, rest).deleteContents();
  if (from > 0) c.classList.add('pg-frag-start');
  if (to < textLengthOf(el)) c.classList.add('pg-frag-more');
  return c;
}

function cloneWholeUnit(u) {
  if (u.kind === 'text') {
    const p = document.createElement('p');
    p.textContent = u.el.nodeValue;
    return p;
  }
  return u.el.cloneNode(true);
}

function colWidths(table) {
  const rows = Array.from(table.rows).filter(
    (tr) => tr.parentElement && tr.parentElement.tagName === 'TBODY'
  );
  const percents = [];
  let total = 0;
  for (const tr of rows) {
    const cells = tr.cells;
    for (let c = 0; c < cells.length; c++) {
      const w = cells[c].offsetWidth || 0;
      percents[c] = Math.max(percents[c] || 0, w);
    }
  }
  const sum = percents.reduce((s, w) => s + w, 0) || 1;
  return percents.map((w) => ((w / sum) * 100).toFixed(3));
}

function cloneHeaderSection(meta, tag) {
  const wrap = document.createElement(tag);
  for (const tr of meta[tag === 'THEAD' ? 'theadRows' : 'footRows']) {
    wrap.appendChild(tr.cloneNode(true));
  }
  return wrap;
}

function cleanupPrintSheets() {
  const root = document.getElementById('printRoot');
  if (root) root.remove();
}

// Clone the live document into #printRoot A4 sheets using the same plan that
// drives the fold guides; returns the page count (0 when nothing to print).
function renderSheets(pages) {
  cleanupPrintSheets();
  const root = document.createElement('div');
  root.className = 'print-root doc-root';
  root.id = 'printRoot';
  document.body.appendChild(root);

  // table column caches per original table element
  const colCache = new Map();
  const trState = new Map(); // table meta → { wrap, sawLast }

  for (const pg of pages) {
    const sheet = document.createElement('section');
    sheet.className = 'print-page';
    root.appendChild(sheet);

    let openList = null; // { list, wrap } while appending <li> runs

    const closeOpenList = () => { openList = null; };

    for (const frag of pg.frags) {
      const u = frag.u;
      if (u.kind === 'li') {
        if (!openList || openList.list !== u.list) {
          const wrap = u.list.cloneNode(false);
          if (u.list.tagName === 'OL' && u.listIndex > 0) {
            wrap.setAttribute('start', String(u.listIndex + 1));
          }
          openList = { list: u.list, wrap };
          sheet.appendChild(wrap);
        }
        openList.wrap.appendChild(u.el.cloneNode(true));
        continue;
      }
      closeOpenList();

      if (u.kind === 'tr') {
        const meta = u.tableMeta;
        let st = trState.get(meta);
        if (!st) {
          const wrap = u.table.cloneNode(false);
          wrap.style.tableLayout = 'fixed';
          let cols = colCache.get(u.table);
          if (!cols) {
            cols = colWidths(u.table);
            colCache.set(u.table, cols);
          }
          if (cols.length) {
            const cg = document.createElement('colgroup');
            for (const p of cols) {
              const col = document.createElement('col');
              col.style.width = p + '%';
              cg.appendChild(col);
            }
            wrap.appendChild(cg);
          }
          if (meta.theadRows.length) wrap.appendChild(cloneHeaderSection(meta, 'THEAD'));
          const tb = document.createElement('tbody');
          wrap.appendChild(tb);
          st = { wrap, tb, foot: null, meta };
          trState.set(meta, st);
          sheet.appendChild(wrap);
        }
        const tr = u.el.cloneNode(true);
        st.tb.appendChild(tr);
        if (u.isLastRow && meta.footRows.length && !st.foot) {
          st.foot = cloneHeaderSection(meta, 'TFOOT');
          st.wrap.appendChild(st.foot);
        }
        continue;
      }

      // paragraphs, <pre>, headings, atomic blocks, toc, text nodes …
      let el;
      if (frag.whole) {
        el = cloneWholeUnit(u);
      } else {
        el = sliceClone(u.el, frag.from, frag.to);
      }
      sheet.appendChild(el);
    }
    // Margin truncation at the bottom of the sheet: list wrappers keep the
    // margins of their trailing <li> otherwise (a <p> is handled by the
    // :last-child rule in the print stylesheet).
    const last = sheet.lastElementChild;
    if (last && (last.tagName === 'UL' || last.tagName === 'OL')) {
      last.classList.add('pg-edge-last');
    }
  }

  // The fold guides are re-drawn from the exact same plan that produced the
  // sheets, so the on-screen page separations and the exported pages match.
  return pages.length;
}

// Build the export sheets. Measured in screen media; if the live page is hidden
// (print media / the beforeprint fallback), reuse the cached plan so pagination
// never runs against a zero-height DOM (which produced near-empty PDF pages).
function buildPrintSheets() {
  const page = docContent.querySelector('.document-page');
  if (!page || !(page.innerText || '').trim()) return 0;
  let pages;
  if (page.offsetHeight) {
    const units = collectUnits(page);
    if (!units.length) return 0;
    pages = paginateUnits(units);
    lastPlan = pages;
  } else if (lastPlan) {
    pages = lastPlan;
  } else {
    return document.querySelectorAll('#printRoot .print-page').length;
  }
  const total = renderSheets(pages);
  if (page.offsetHeight) drawFolds(pages); // fold guides only make sense on screen
  const countEl = document.getElementById('pageCount');
  if (countEl) countEl.textContent = total + (total === 1 ? ' page' : ' pages');
  return total;
}
