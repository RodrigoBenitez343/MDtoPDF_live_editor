# verify_formatting.py — end-to-end: WYSIWYG-formatted document (styled text,
# table, embedded image, page break) → render → PDF; checks DOM, PDF text,
# embedded image, internal links, and the \newpage page break.
import sys
import tempfile
from pathlib import Path

import fitz  # PyMuPDF

TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

MD = """# Formatted Test

\\tableofcontents

## Styled Section

<span style="color: rgb(139, 0, 0); font-weight: bold;">Red bold text</span> and normal text.

## Table

| A | B |
|---|---|
| 1 | 2 |

## Image

![Logo]({png})

\\newpage

## Last Section

End of document.
""".format(png=TINY_PNG)


def main():
    from playwright.sync_api import sync_playwright

    tmp = Path(tempfile.mkdtemp(prefix="cdocs_fmt_"))
    out = tmp / "formatted.pdf"
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception:
            browser = p.chromium.launch(channel="msedge")
        page = browser.new_page()
        page.goto("http://127.0.0.1:8899/", wait_until="domcontentloaded")
        page.wait_for_timeout(4000)
        page.evaluate(
            """(md) => {
                switchToMarkdown();
                const el = document.getElementById('editor');
                el.value = md;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }""",
            MD,
        )
        page.wait_for_timeout(700)
        page.evaluate("() => switchToEdit()")
        page.wait_for_timeout(1000)

        dom = page.evaluate(
            """() => ({
                styled: !!document.querySelector('.doc-root .document-page span[style*="color"]'),
                table: !!document.querySelector('.doc-root .document-page table tbody'),
                img: !!document.querySelector('.doc-root .document-page img[src^="data:image"]'),
                breaks: document.querySelectorAll('.doc-root .document-page .page-break').length,
                toc: document.querySelectorAll('.doc-root .document-page .toc-item').length
            })"""
        )
        print("DOM after render:", dom)
        page.pdf(path=str(out), format="A4", print_background=True)
        browser.close()

    doc = fitz.open(str(out))
    text = "".join(pg.get_text() for pg in doc)
    links = [
        (i + 1, (ln.get("page") or 0) + 1)
        for i, pg in enumerate(doc)
        for ln in pg.get_links()
        if "page" in ln and "to" in ln
    ]
    images = sum(len(pg.get_images()) for pg in doc)
    pages = [pg.get_text() for pg in doc]

    def page_of(needle):
        for i, t in enumerate(pages):
            if needle in t:
                return i + 1
        return None

    print("PDF pages:", len(doc))
    print("PDF has styled text:", "Red bold text" in text)
    print("PDF has table cells:", "1" in text and "2" in text)
    print("PDF has embedded image:", images > 0)
    print("PDF page of 'Image':", page_of("Image"), "| page of 'End of document':", page_of("End of document"))
    print("PAGE BREAK WORKS:", page_of("End of document") is not None and page_of("End of document") > page_of("Image"))
    print("PDF links:", len(links), links)
    print("INTERACTIVE INDEX:", "YES" if len(links) >= 4 else "NO")
    print("pdf at:", out)


if __name__ == "__main__":
    sys.exit(main())
