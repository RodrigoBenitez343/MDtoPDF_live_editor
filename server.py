#!/usr/bin/env python3
"""
server.py — Flask backend that serves the Markdown editor GUI and handles PDF generation
using the utils/ pipeline (format.py + html_to_pdf.py).
"""

import io
import os
import re
import tempfile
from pathlib import Path

import markdown
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

from utils.format import (
    DOCUMENT_CSS,
    HTML_TEMPLATE,
    build_header,
    extract_title,
    transform_md,
)

app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app)


# ---------------------------------------------------------------------------
# Adapt DOCUMENT_CSS for Shadow DOM (no <html>/<body> elements)
# ---------------------------------------------------------------------------
def adapt_css_for_shadow(css: str) -> str:
    """Move base typography from html/body rules into .document-page
    so the preview renders with format.py's font/color/size inside a Shadow DOM."""
    # 1. Extract font-size from html rule
    html_size = ""
    m = re.search(r'html\s*\{\s*font-size\s*:\s*([^;}]+)', css)
    if m:
        html_size = "font-size: " + m.group(1).strip() + ";"

    # 2. Extract body properties (standalone rule, not inside @media)
    body_props = ""
    m = re.search(r'^body\s*\{(.*?)\}', css, re.DOTALL | re.MULTILINE)
    if m:
        body_props = m.group(1).strip()

    # 3. Build extra block to inject into .document-page
    extras = []
    if html_size:
        extras.append(html_size)
    if body_props:
        extras.append(body_props)

    if extras:
        extra_block = '\n    '.join(extras)
        css = css.replace(
            '.document-page {',
            f'.document-page {{\n    {extra_block}\n    ',
            1,
        )

    # 4. Remove standalone html and body rules (top-level only)
    css = re.sub(
        r'^html\s*\{[^}]*\}\s*$', '', css, flags=re.MULTILINE
    )
    css = re.sub(
        r'^body\s*\{[^}]*\}\s*$', '', css, flags=re.MULTILINE
    )

    return css


PREVIEW_CSS = adapt_css_for_shadow(DOCUMENT_CSS)


# ---------------------------------------------------------------------------
# Helpers: shared markdown → HTML conversion (same pipeline as format.py)
# ---------------------------------------------------------------------------
def md_to_body_html(md_text: str) -> tuple[str, str]:
    """Return (title, body_html) using the same pipeline as format.py."""
    title = extract_title(md_text)
    cleaned_md = transform_md(md_text)

    extensions = ["tables", "fenced_code", "smarty", "sane_lists"]
    body_html = markdown.markdown(cleaned_md, extensions=extensions)

    # Post-process mermaid code blocks
    body_html = re.sub(
        r'<pre><code class="language-mermaid">(.*?)</code></pre>',
        r'<pre class="mermaid">\1</pre>',
        body_html,
        flags=re.DOTALL,
    )

    # Prepend the document header (title extracted from first heading)
    body_html = build_header(title) + "\n" + body_html

    return title, body_html


def md_to_full_html(md_text: str) -> tuple[str, str]:
    """Return (title, full_html_document) suitable for Playwright PDF."""
    title, body_html = md_to_body_html(md_text)
    full_html = HTML_TEMPLATE.format(
        css=DOCUMENT_CSS,
        title=title,
        header="",
        body=body_html,
    )
    return title, full_html


# ---------------------------------------------------------------------------
# Serve the GUI
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return app.send_static_file("index.html")


# ---------------------------------------------------------------------------
# Preview: return body HTML + CSS (both from format.py pipeline)
#           so the frontend has zero hardcoded styling logic.
# ---------------------------------------------------------------------------
@app.route("/api/preview", methods=["POST"])
def preview():
    data = request.get_json(force=True)
    md_text = data.get("markdown", "")

    if not md_text.strip():
        return jsonify({"body": "", "css": PREVIEW_CSS, "title": "Documento"})

    title, body_html = md_to_body_html(md_text)
    return jsonify({"body": body_html, "css": PREVIEW_CSS, "title": title})


# ---------------------------------------------------------------------------
# Download PDF: convert markdown → full HTML → PDF via Playwright
#               The PDF bytes are read into memory before temp dir cleanup.
# ---------------------------------------------------------------------------
@app.route("/api/download-pdf", methods=["POST"])
def download_pdf():
    data = request.get_json(force=True)
    md_text = data.get("markdown", "")

    if not md_text.strip():
        return jsonify({"error": "Markdown content is empty"}), 400

    title, full_html = md_to_full_html(md_text)

    # Write HTML to a temp file → convert to PDF with Playwright → read bytes
    with tempfile.TemporaryDirectory() as tmpdir:
        html_path = os.path.join(tmpdir, "output.html")
        pdf_path = os.path.join(tmpdir, "output.pdf")

        Path(html_path).write_text(full_html, encoding="utf-8")

        from playwright.sync_api import sync_playwright

        file_url = Path(html_path).resolve().as_uri()

        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.goto(file_url, wait_until="networkidle")
            try:
                page.wait_for_selector(".mermaid svg", timeout=10000)
            except Exception:
                pass
            page.pdf(
                path=pdf_path,
                format="A4",
                margin={
                    "top": "25mm",
                    "bottom": "25mm",
                    "left": "28mm",
                    "right": "28mm",
                },
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
                    'P\xe1gina <span class="pageNumber"></span> de <span class="totalPages"></span>'
                    "</div>"
                ),
            )
            browser.close()

        # Read PDF bytes into memory *before* temp dir is cleaned up
        pdf_bytes = Path(pdf_path).read_bytes()

    # Return from memory — no file locking issues
    return send_file(
        io.BytesIO(pdf_bytes),
        as_attachment=True,
        download_name="documento_formal.pdf",
        mimetype="application/pdf",
    )


if __name__ == "__main__":
    os.makedirs("static", exist_ok=True)
    app.run(debug=True, port=5000)
