# CibernetDocs — Markdown → Formal PDF Document Formatter

Write in Markdown, preview a **professionally typeset A4 document** live, and
export it as a print-ready PDF. CibernetDocs ships one canonical formatting
pipeline — a formal document stylesheet (`DOCUMENT_CSS`: Georgia/serif 11 pt,
A4 margins), smart typography (smart quotes/dashes/ellipses), tables, fenced
code and Mermaid diagrams — and exposes it through **two front ends**: a
Flask web editor and a self-contained Neutralino desktop app.

```
Markdown ─▶ format.py pipeline ─▶ formal HTML ─▶ A4 PDF
            (title extraction,      (preview +       (Playwright / native print)
             DOCUMENT_CSS,           styling)         headers, "Página X de Y")
             header, mermaid)
```

## Features

- **Live document preview** — both front ends render Markdown with the *same*
  transformations as the export pipeline, so what you see is exactly the PDF.
- **Formal styling** — A4, serif typography, title header built from the first
  heading, print-grade margins.
- **Mermaid diagrams** — ` ```mermaid ` blocks render in the preview and are
  rasterized into exported PDFs.
- **Markdown extras** — GFM tables, fenced code, smart punctuation, sanitized
  HTML (DOMPurify in the client).
- **Desktop editor** (Neutralino app):
  - **WYSIWYG edit view** — edit the rendered document directly; the DOM is
    the source of truth and is serialized back to Markdown (turndown).
  - **Índice (table of contents)** — auto-generated from headings; insert/remove
    with the toolbar or `\tableofcontents` in the source.
  - **Page-fold guides** — thin lines with page numbers show exactly where each
    printed page will break while editing.
  - **PDF via native print** — the live document *is* the print view
    (`Neutralino.window.print`), so nothing can go out of sync.
  - Word count + line/column indicator.
- **Web editor** (Flask) — backend-rendered preview and a
  `/api/download-pdf` export through Playwright Chromium (renders Mermaid,
  running header with the document title, `Página X de Y` footer).

## Web version (Flask)

```powershell
pip install flask flask-cors markdown playwright
playwright install chromium

python server.py          # → http://localhost:5000
```

Routes:

| Route | Purpose |
|-------|---------|
| `/` | Editor GUI (`static/index.html`) |
| `POST /api/preview` | Rendered body HTML + CSS (same pipeline as PDF) |
| `POST /api/download-pdf` | Full formal PDF (Playwright) |

## Desktop version (Neutralino app)

```powershell
cd app
npm install
npx neu update          # downloads the per-OS neutralino binaries into app/bin (gitignored)
npm run dev             # neu run — opens the CibernetDocs window

# packaging
npm run build           # neu build
npm run release         # neu build --release --embed-resources
```

The desktop app is fully client-side (marked + marked-smartypants +
DOMPurify + turndown + mermaid) and does not need the Flask backend.

## CLI (utils)

The formatting pipeline also runs standalone:

```powershell
python utils/format.py input.md         # markdown → formal HTML
python utils/html_to_pdf.py in.html out.pdf   # HTML → A4 PDF (Playwright)
```

## Layout

```
CIBERNETDOCS/
├── server.py               # Flask backend: preview + PDF endpoints
├── static/index.html       # Web editor GUI (backend-rendered preview)
├── utils/
│   ├── format.py           # Canonical Markdown → formal HTML pipeline (CSS, header, smarty)
│   └── html_to_pdf.py      # HTML → A4 PDF via Playwright
├── app/                    # Neutralinojs desktop app
│   ├── package.json        # dev / build / release (neu)
│   ├── neutralino.config.json
│   ├── resources/          # index.html, js/app.js, styles/, icons/
│   ├── scripts/            # verify_formatting.py · verify_pdf.py · make-icon.ps1
│   ├── buildAssets/        # app icon
│   ├── bin/                # (gitignored) per-OS neutralino binaries
│   └── node_modules/       # (gitignored)
├── .gitignore
└── README.md
```

## Notes

- `app/bin/` (Neutralino per-OS binaries) and `app/node_modules/` are
  gitignored — restore them with `npx neu update` + `npm install`.
- `.storage/` / `.tmp/` hold app runtime data and are gitignored.
