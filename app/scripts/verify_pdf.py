# verify_pdf.py — replicate the export flow (renderPreview -> print) with
# Chromium (same print pipeline as the WebView2 native dialog) and check with
# PyMuPDF:
#   1. the exported PDF has 5 internal link annotations on the TOC page
#      pointing to the real section positions  -> interactive Índice
#   2. with \newpage the last section's destination lands on a LATER page than
#      the previous section; without \newpage both share the same page
#      -> page breaks work in the exported PDF
# The document lives in the light DOM (live preview), so no print-view
# preparation is needed — page.pdf() captures exactly what the app prints.
# Note: PyMuPDF text extraction inserts spaces around letter-spaced glyphs
# (h2 uses letter-spacing:1pt), so section positions come from the PDF link
# destinations instead of text matching.
import sys
import tempfile
from pathlib import Path

import fitz  # PyMuPDF

URL = "http://127.0.0.1:8899/"


def link_dests(pdf_path):
    """Return [(fromPage, toPage, y)] for every internal link, sorted so that
    sections appear in document order (by page, then top-to-bottom)."""
    doc = fitz.open(str(pdf_path))
    links = []
    for i, page in enumerate(doc):
        for ln in page.get_links():
            # Chromium emits named destinations (LINK_NAMED); fitz resolves
            # them into a target page + position for us
            if "page" in ln and "to" in ln:
                links.append((i + 1, (ln["page"] or 0) + 1, round(ln["to"].y, 1)))
    doc.close()
    links.sort(key=lambda l: (l[1], -l[2]))
    return links


def main():
    from playwright.sync_api import sync_playwright

    sample = Path(r"c:\Users\LoOper\Desktop\CIBERNETDOCS\app\resources\sample.md").read_text(encoding="utf-8")
    no_break = sample.replace("\\newpage", "")

    tmp = Path(tempfile.mkdtemp(prefix="cdocs_verify_"))
    out_a = tmp / "with_break.pdf"
    out_b = tmp / "no_break.pdf"

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception:
            browser = p.chromium.launch(channel="msedge")
        page = browser.new_page()
        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_timeout(4000)

        def export_pdf(path, md):
            # feed markdown through the app: markdown mode -> document mode
            page.evaluate(
                """(md) => {
                    switchToMarkdown();
                    const el = document.getElementById('editor');
                    el.value = md;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }""",
                md,
            )
            page.wait_for_timeout(700)
            page.evaluate("() => switchToEdit()")
            page.wait_for_timeout(800)  # mermaid settles
            page.pdf(
                path=str(path),
                format="A4",
                margin={"top": "25mm", "bottom": "25mm", "left": "28mm", "right": "28mm"},
                print_background=True,
            )

        export_pdf(out_a, sample)
        export_pdf(out_b, no_break)
        browser.close()

    la = link_dests(out_a)
    lb = link_dests(out_b)
    print("link dests WITH    :", la)
    print("link dests WITHOUT :", lb)

    def verdict(label, links):
        ok = len(links) >= 5 and all(f == 1 for f, _, _ in links)
        pages = sorted({p for _, p, _ in links})
        print(f"{label}: {'YES' if ok else 'NO'} (links={len(links)}, fromTocPage={ok}, targetPages={pages})")
        return ok, pages

    ok_a, pages_a = verdict("INTERACTIVE INDEX", la)
    _, pages_b = verdict("INTERACTIVE INDEX (no break doc)", lb)

    # page break: last section (sec-5) vs previous (sec-4)
    sec4_a, sec5_a = la[3], la[4]
    sec4_b, sec5_b = lb[3], lb[4]
    print(f"WITH    \\newpage : sec-4 -> p{sec4_a[1]} y{sec4_a[2]} | sec-5 -> p{sec5_a[1]} y{sec5_a[2]}")
    print(f"WITHOUT \\newpage : sec-4 -> p{sec4_b[1]} y{sec4_b[2]} | sec-5 -> p{sec5_b[1]} y{sec5_b[2]}")
    break_ok = (
        sec5_a[1] > sec4_a[1]        # with the marker the section moves to a later page
        and sec5_b[1] == sec4_b[1]    # without it, it stays on the same page
        and sec5_b[2] < sec4_b[2]     # (and sits lower on that page)
    )
    print("PAGE BREAK WORKS:", "YES" if break_ok else "NO")
    print("pdfs at:", out_a, out_b)


if __name__ == "__main__":
    sys.exit(main())
