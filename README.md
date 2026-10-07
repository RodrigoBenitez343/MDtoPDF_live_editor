# DocMaster — Markdown → Formal PDF Document Formatter

DocMaster is a self-contained **desktop app** (Neutralinojs) for writing in
Markdown, previewing a **professionally typeset A4 document** live, and exporting
it as a print-ready PDF. Everything runs locally — no server, no network, no
account.

```
Markdown ─▶ client-side pipeline ─▶ formal HTML ─▶ A4 PDF
            (marked + smartypants    (document.css   (native print,
             + DOMPurify + mermaid,   + DOCUMENT_CSS) one A4 sheet = one page)
             turndown to save back)
```

## Features

- **Live document preview** — the editor renders Markdown with the *same*
  transformations as the export, so what you see is exactly the PDF.
- **WYSIWYG edit view** — edit the rendered document directly; the DOM is the
  source of truth and is serialized back to Markdown (turndown).
- **Markdown view** — edit the raw source; switch between views with the toolbar
  or `Ctrl+E`.
- **Formal styling** — A4, Georgia/serif typography, a document title built from
  the first heading, and print-grade margins (`DOCUMENT_CSS`).
- **ATS-safe text layer** — no letter-spacing or justification, so Chromium PDF
  text extractors (ATS parsers) read the words cleanly.
- **Mermaid diagrams** — ` ```mermaid ` blocks render in the preview and are
  embedded in the export.
- **Markdown extras** — GFM tables, fenced code, smart punctuation, sanitized
  HTML (DOMPurify), and inline images pasted or picked from disk.
- **Índice (table of contents)** — auto-generated from the headings; insert or
  remove it with the toolbar or with `\tableofcontents` in the source.
- **Page-fold guides** — thin lines with page numbers show exactly where each
  printed page will break while you edit.
- **Deterministic PDF export** — "Save as PDF" paginates the document into A4
  sheets with the same content-fit engine that draws the fold guides, so every
  exported page is exactly one of the on-screen page separations.
- **Library — documents & collections** — a workspace tree of libraries
  (folders) and documents: create, rename, duplicate, drag-and-drop to move,
  search and sort, import/export a whole library, and a Trash with restore and
  permanent delete. Every edit autosaves.
- **Native file dialogs** — Open / Save / Save as, drag-and-drop a `.md` file,
  and draft auto-restore between sessions.
- Word count, page count, and a line/column indicator.

## Requirements

- **Node.js 18 or newer** (comes with npm) — https://nodejs.org
- Internet access for the one-time setup: `npm install` (build tool + vendor
  deps) and `npx neu update` (downloads the per-OS Neutralino binaries).

No Python, no separate server, and no browser is needed for the desktop app.

## Build & run

```powershell
git clone <repo_url> docmaster
cd docmaster/app

npm install          # installs @neutralinojs/neu and the vendor dependencies
npx neu update       # downloads the Neutralino binaries for your OS into app/bin/
npm run dev          # launches the DocMaster window (neu run)
```

### Package distributables

```powershell
npm run build        # neu build                (debug build)
npm run release      # neu build --release --embed-resources
```

The build output lands in `app/dist/docmaster/`, e.g. `docmaster-win_x64.exe`,
`docmaster-linux_x64`, `docmaster-mac_universal` — each alongside a
`resources.neu` bundle. Ship the executable **together with its `resources.neu`**.

`neu update` decides which platforms can be built; run it again to refresh those
binaries. Builds are per platform — run the steps on Windows for a Windows build,
on macOS/Linux for those (the per-OS binaries are fetched into `app/bin/`).

## Project layout

```
docmaster/
├── app/                     # the entire desktop app
│   ├── package.json         # dev / build / release scripts (neu)
│   ├── neutralino.config.json
│   ├── resources/           # index.html, js/, styles/, icons/, sample.md
│   │   ├── js/app.js        #   app logic (editor, Library, export)
│   │   ├── js/pagination.js #   page-fit engine (fold guides + PDF sheets)
│   │   ├── js/files.js      #   pure path/name helpers (node-checkable)
│   │   └── styles/          #   app.css + document.css (DOCUMENT_CSS)
│   ├── scripts/             # verify_pdf.py · verify_formatting.py · make-icon.ps1
│   ├── buildAssets/         # app icon source
│   ├── bin/                 # (gitignored) per-OS Neutralino binaries
│   └── node_modules/        # (gitignored)
├── .gitignore
└── README.md
```

## Notes

- `app/bin/` (Neutralino binaries) and `app/node_modules/` are gitignored —
  restore them with `npx neu update` and `npm install`.
- Your documents live in the app's data folder under `documents/` (the
  OS-specific per-app data directory returned by Neutralino's `os.getPath('data')`),
  created on first run. Opening a document autosaves into it.
- `app/.storage/` and `app/.tmp/` hold runtime/draft data and are gitignored.
- The app is already fully client-side, so it needs no backend at any point.

