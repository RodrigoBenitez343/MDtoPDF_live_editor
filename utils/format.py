#!/usr/bin/env python3
"""
formalize_contract.py
Transforms ORIGINAL.MD into a professionally formatted document (HTML + optional PDF).
Generic formatter — no contract-specific elements (no cover, no signatures, no watermark).
"""

import re
import os
import sys
import argparse
import subprocess
import markdown
from pathlib import Path

# ---------------------------------------------------------------------------
# CSS for professional document styling
# ---------------------------------------------------------------------------
DOCUMENT_CSS = r"""
@page {
    size: A4;
    margin: 2.5cm 2.8cm 2.5cm 2.8cm;
}

* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

html {
    font-size: 11pt;
}

body {
    font-family: 'Georgia', 'Times New Roman', 'Garamond', serif;
    font-size: 11pt;
    line-height: 1.55;
    color: #1a1a1a;
    background: #f5f5f0;
    padding: 0;
    margin: 0;
}

.document-page {
    max-width: 210mm;
    margin: 20px auto;
    padding: 2cm 2.5cm;
    background: #ffffff;
    box-shadow: 0 2px 20px rgba(0,0,0,0.08);
}

@media print {
    body { background: #fff; }
    .document-page {
        box-shadow: none;
        margin: 0;
        padding: 0;
        max-width: 100%;
    }
}

/* ── DOCUMENT HEADER ── */
.document-header {
    text-align: center;
    margin-bottom: 12pt;
    padding-bottom: 4pt;
    border-bottom: 2pt solid #b8a97e;
}

.document-header h1 {
    font-family: 'Georgia', serif;
    font-size: 18pt;
    font-weight: 700;
    letter-spacing: 1.5pt;
    margin-bottom: 4pt;
    color: #111;
}

.document-header .subtitle {
    font-size: 10pt;
    font-weight: 400;
    letter-spacing: 0.5pt;
    color: #555;
    margin-top: 6pt;
}

/* ── SECTION HEADINGS ── */
h2 {
    font-family: 'Georgia', serif;
    font-size: 12.5pt;
    font-weight: 700;
    letter-spacing: 1pt;
    color: #1a1a1a;
    margin-top: 18pt;
    margin-bottom: 10pt;
    padding-bottom: 6pt;
    position: relative;
    page-break-after: avoid;
}

h2::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 0;
    width: 40%;
    height: 1.5pt;
    background: #b8a97e;
}

h3 {
    font-family: 'Georgia', serif;
    font-size: 11pt;
    font-weight: 700;
    letter-spacing: 0.5pt;
    color: #333;
    margin-top: 12pt;
    margin-bottom: 8pt;
    page-break-after: avoid;
}

/* ── PARAGRAPHS ── */
p {
    text-align: justify;
    text-justify: inter-word;
    margin-bottom: 9pt;
    font-size: 10.5pt;
    line-height: 1.6;
}

/* ── BOLD ── */
strong {
    font-weight: 700;
}

/* ── HORIZONTAL RULES ── */
hr {
    border: none;
    border-top: 1pt solid #d0c9b0;
    margin: 14pt 0;
}

/* ── TABLES ── */
table {
    width: 100%;
    border-collapse: collapse;
    margin: 10pt 0;
    font-size: 9.5pt;
}

thead {
    display: table-header-group;
}

tr {
    page-break-inside: avoid;
}

thead, tr:first-child {
    background: #2c2c2c;
    color: #fff;
}

th {
    padding: 8pt 10pt;
    font-weight: 700;
    text-align: left;
    letter-spacing: 0.4pt;
    font-size: 9pt;
    text-transform: uppercase;
    border: 1pt solid #2c2c2c;
}

td {
    padding: 7pt 10pt;
    border: 0.5pt solid #d0c9b0;
    vertical-align: top;
}

tbody tr:nth-child(even) {
    background: #fafaf7;
}

tbody tr:hover {
    background: #f0ede4;
}

/* ── LISTS ── */
ul, ol {
    margin: 8pt 0 12pt 22pt;
    font-size: 10.5pt;
}

li {
    margin-bottom: 5pt;
    line-height: 1.55;
}

/* ── CODE / MONOSPACE ── */
code {
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 9pt;
    background: #f4f1e8;
    padding: 1pt 4pt;
    border-radius: 2pt;
    border: 0.5pt solid #d8d3c0;
}

/* ── FOOTER NOTE ── */
.footer-note {
    margin-top: 30pt;
    padding-top: 12pt;
    border-top: 0.5pt solid #ccc;
    text-align: center;
    font-size: 8.5pt;
    color: #888;
    font-style: italic;
}

/* ── CENTER DIVS ── */
div[align="center"] {
    text-align: center;
}

/* ── HIGHLIGHT BOX (for important callouts) ── */
.highlight-box {
    padding: 12pt 16pt;
    background: #fafaf7;
    border-left: 3pt solid #b8a97e;
    margin: 14pt 0;
    font-size: 10.5pt;
    line-height: 1.6;
}

/* ── MERMAID DIAGRAMS ── */
.mermaid {
    text-align: center;
    margin: 16pt 0;
    overflow-x: auto;
}
.mermaid svg {
    max-width: 100%;
    height: auto;
}
"""

# ---------------------------------------------------------------------------
# HTML template
# ---------------------------------------------------------------------------
HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <style>
{css}
    </style>
</head>
<body>
<div class="document-page">

{header}

{body}

<div class="footer-note">
    {title}
</div>

</div>

<!-- Mermaid diagram rendering -->
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
    document.addEventListener('DOMContentLoaded', function() {{
        mermaid.initialize({{
            startOnLoad: true,
            theme: 'neutral',
            fontFamily: 'Georgia, serif',
            fontSize: 10
        }});
    }});
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# Helper: extract title from the first heading in the markdown
# ---------------------------------------------------------------------------
def extract_title(raw: str) -> str:
    """Extract the first heading from the markdown as the document title."""
    # Try ATX-style headings (# Title)
    match = re.search(r'^#{1,2}\s+(.+)$', raw, re.MULTILINE)
    if match:
        return match.group(1).strip()
    # Fallback: use the filename
    return "Documento"


# ---------------------------------------------------------------------------
# Helper: build a clean document header
# ---------------------------------------------------------------------------
def build_header(title: str) -> str:
    return f"""
<div class="document-header">
    <h1>{title}</h1>
</div>
"""


# ---------------------------------------------------------------------------
# Transform markdown content: clean up for formal output
# ---------------------------------------------------------------------------
def transform_md(raw: str) -> str:
    """Clean and prepare the raw markdown for rendering."""

    text = raw

    # Remove the first heading (we put it in our own header)
    text = re.sub(r'^#{1,2}\s+.+$', '', text, count=1, flags=re.MULTILINE)

    # Remove any leftover empty centered divs
    text = re.sub(r'<div align="center">\s*</div>', '', text)

    return text.strip()


# ---------------------------------------------------------------------------
# Main conversion pipeline
# ---------------------------------------------------------------------------
def convert(input_path: str, output_dir: str, generate_pdf: bool = False):
    input_file = Path(input_path)
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    raw_md = input_file.read_text(encoding='utf-8')
    title = extract_title(raw_md)
    cleaned_md = transform_md(raw_md)

    # Convert Markdown -> HTML
    extensions = ['tables', 'fenced_code', 'smarty', 'sane_lists']
    body_html = markdown.markdown(cleaned_md, extensions=extensions)

    # Post-process: convert mermaid code blocks for rendering
    body_html = re.sub(
        r'<pre><code class="language-mermaid">(.*?)</code></pre>',
        r'<pre class="mermaid">\1</pre>',
        body_html,
        flags=re.DOTALL
    )

    # Assemble full HTML
    full_html = HTML_TEMPLATE.format(
        css=DOCUMENT_CSS,
        title=title,
        header=build_header(title),
        body=body_html,
    )

    # Write HTML
    html_out = out_dir / "DOCUMENTO_FORMAL.html"
    html_out.write_text(full_html, encoding='utf-8')
    print(f"[OK] HTML document generated: {html_out.resolve()}")

    # Optional PDF generation via Playwright
    if generate_pdf:
        pdf_out = out_dir / "DOCUMENTO_FORMAL.pdf"
        try:
            from playwright.sync_api import sync_playwright
            file_url = html_out.resolve().as_uri()
            with sync_playwright() as p:
                browser = p.chromium.launch()
                page = browser.new_page()
                page.goto(file_url, wait_until="networkidle")
                # Wait for mermaid diagrams to render
                try:
                    page.wait_for_selector('.mermaid svg', timeout=10000)
                except Exception:
                    pass
                page.pdf(
                    path=str(pdf_out),
                    format="A4",
                    margin={"top": "25mm", "bottom": "25mm", "left": "28mm", "right": "28mm"},
                    print_background=True,
                    display_header_footer=True,
                    header_template=(
                        '<div style="font-size:8px;color:#888;width:100%;text-align:center;'
                        'font-family:Georgia,serif;padding-top:8mm;">'
                        f"{title}"
                        "</div>"
                    ),
                    footer_template=(
                        '<div style="font-size:8px;color:#555;width:100%;text-align:center;'
                        'font-family:Georgia,serif;padding-bottom:5mm;">'
                        'Página <span class="pageNumber"></span> de <span class="totalPages"></span>'
                        "</div>"
                    ),
                )
                browser.close()
            print(f"[OK] PDF document generated (playwright): {pdf_out.resolve()}")
            return
        except ImportError:
            pass

        # Try weasyprint as fallback
        try:
            from weasyprint import HTML
            HTML(filename=str(html_out)).write_pdf(str(pdf_out))
            print(f"[OK] PDF document generated (weasyprint): {pdf_out.resolve()}")
            return
        except ImportError:
            pass

        print("[WARN] PDF generation skipped. Install 'playwright' or 'weasyprint' for PDF output.")
        print("       You can also open the HTML in a browser and use Print -> Save as PDF.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Transform ORIGINAL.MD into a professionally formatted document."
    )
    parser.add_argument(
        '-i', '--input',
        default='ORIGINAL.MD',
        help='Input markdown file (default: ORIGINAL.MD)'
    )
    parser.add_argument(
        '-o', '--output-dir',
        default='.',
        help='Output directory for generated files (default: current directory)'
    )
    parser.add_argument(
        '--pdf',
        action='store_true',
        help='Also generate PDF (requires playwright or weasyprint)'
    )
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"[ERROR] Input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    convert(args.input, args.output_dir, generate_pdf=args.pdf)
    print("\n[DONE] Document formatting complete.")


if __name__ == '__main__':
    main()
