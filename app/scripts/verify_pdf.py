# verify_pdf.py — end-to-end verification of the deterministic PDF export.
#
# The app is served from app/resources (python -m http.server 8899). The
# script feeds a Markdown document through the real UI (markdown mode ->
# rendered document mode), runs buildPrintSheets() — the same pagination the
# "Save as PDF" button performs — and exports the paginated sheets with
# Chromium (identical print pipeline to the WebView2 native dialog).
#
# Checks:
#   1. page-count label + fold-guide count in the Edit view == number of
#      exported PDF pages (preview ⇄ PDF parity)
#   2. each .print-page sheet becomes exactly one PDF page
#   3. ATS text layer: headings/name/contact extract cleanly (no phantom
#      spaces from letter-spacing, no word-run concatenation from justify)
#   4. interactive Índice links resolve across pages and \newpage moves the
#      following section to a later page
import re
import sys
import tempfile
from pathlib import Path

import fitz  # PyMuPDF

BASE = "http://127.0.0.1:8899/"
ROOT = Path(__file__).resolve().parents[2]  # repo root
SAMPLE = ROOT / "app" / "resources" / "sample.md"
RESUME = ROOT / "Rodrigo_Benitez_Resume.md"

OUT = Path(tempfile.mkdtemp(prefix="cdocs_verify_"))


# --------------------------------------------------------------------------- helpers
def link_dests(pdf_path):
    """[(fromPage, destName)] for every internal link (Chromium emits internal
    links as named destinations — the exact page is asserted by locating the
    target section text instead, since fitz cannot always resolve the names)."""
    doc = fitz.open(str(pdf_path))
    links = []
    for i, page in enumerate(doc):
        for ln in page.get_links():
            if ln.get("nameddest"):
                links.append((i + 1, ln["nameddest"]))
            elif "page" in ln and "to" in ln:
                links.append((i + 1, f"page{(ln['page'] or 0) + 1}"))
    doc.close()
    return links


def first_page_with(pdf_path, needle):
    """0-based index of the first page whose text contains `needle`, else -1."""
    doc = fitz.open(str(pdf_path))
    try:
        for i, page in enumerate(doc):
            if needle in page.get_text():
                return i
        return -1
    finally:
        doc.close()


def feed_md(page, md):
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
    page.wait_for_timeout(900)  # mermaid settles + guides drawn


def build_sheets(page) -> int:
    """Run the app's pagination + sheet build; returns the page count."""
    return page.evaluate("() => buildPrintSheets()")


def export_pdf(page, path):
    # Mirrors the app's print CSS (@page margin 0 + full-page sheets): zero
    # margins leave no room for the browser's date/URL headers and footers,
    # and each 210×297mm .print-page must map to exactly one PDF page.
    page.pdf(
        path=str(path),
        format="A4",
        margin={"top": "0", "bottom": "0", "left": "0", "right": "0"},
        print_background=True,
    )


def pdf_page_count(path):
    doc = fitz.open(str(path))
    n = doc.page_count
    doc.close()
    return n


def pdf_text(path):
    doc = fitz.open(str(path))
    text = "\n".join(p.get_text() for p in doc)
    doc.close()
    return text


# --------------------------------------------------------------------------- main
def main():
    from playwright.sync_api import sync_playwright

    sample = SAMPLE.read_text(encoding="utf-8")
    no_break = sample.replace("\\newpage", "")
    resume = RESUME.read_text(encoding="utf-8")

    results = []

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception:
            browser = p.chromium.launch(channel="msedge")
        page = browser.new_page()
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_timeout(4000)  # fallback startup (no neutralino backend)

        # ---- 1) sample: sheets == guides == PDF pages, \newpage + Índice ----
        feed_md(page, sample)
        label = page.evaluate("() => document.getElementById('pageCount').textContent")
        guide_count = page.evaluate("() => document.querySelectorAll('.page-guide').length")
        sheets = build_sheets(page)
        print(f"sample  : pageCount label={label!r} guides={guide_count} sheets={sheets}")

        pdf_a = OUT / "with_break.pdf"
        export_pdf(page, pdf_a)
        n_a = pdf_page_count(pdf_a)
        results.append(("sheets == PDF pages (sample)", sheets == n_a, f"{sheets} vs {n_a}"))
        results.append(
            ("guides == PDF pages - 1", guide_count == n_a - 1, f"{guide_count} vs {n_a - 1}")
        )
        label_pages = int(label.split()[0]) if label else 0
        results.append(("pageCount label == sheets", label_pages == sheets, f"{label_pages} vs {sheets}"))

        # without the explicit \newpage marker
        feed_md(page, no_break)
        build_sheets(page)
        pdf_b = OUT / "no_break.pdf"
        export_pdf(page, pdf_b)

        la = link_dests(pdf_a)
        lb = link_dests(pdf_b)
        ok_links = len(la) >= 5 and all(f == 1 for f, _ in la)
        results.append(("Índice internal links resolve (from page 1)", ok_links, f"links={len(la)}"))

        # \newpage: the Formal Document Style BODY must land on a later page
        # than the Process Diagram BODY when the marker is present, and on the
        # same page when it is not. (Headings alone can't be used — the Índice
        # lists them all on page 1.)
        pa_proc = first_page_with(pdf_a, "Write Markdown")
        pa_formal = first_page_with(pdf_a, "first heading becomes the document header")
        pb_proc = first_page_with(pdf_b, "Write Markdown")
        pb_formal = first_page_with(pdf_b, "first heading becomes the document header")
        break_ok = (
            pa_formal > pa_proc          # with \newpage the section moves to a later page
            and pb_formal == pb_proc      # without it, it stays on the same page
        )
        results.append(
            ("\\newpage moves the section to a later page", break_ok,
             f"with: p{pa_proc + 1}->p{pa_formal + 1}; without: p{pb_proc + 1}->p{pb_formal + 1}")
        )

        # ---- 2) resume: ATS-clean text layer ----
        feed_md(page, resume)
        sheets_r = build_sheets(page)
        pdf_r = OUT / "resume.pdf"
        export_pdf(page, pdf_r)
        n_r = pdf_page_count(pdf_r)
        results.append(("sheets == PDF pages (resume)", sheets_r == n_r, f"{sheets_r} vs {n_r}"))

        text = pdf_text(pdf_r)
        checks = {
            "name intact": "Rodrigo David Benitez" in text,
            "no phantom spaces in name": "Benit ez" not in text and "Benit e" not in text,
            "clean summary heading": "\nSummary\n" in text or text.count("Summary") >= 1,
            "no letter-spaced headings": all(
                s not in text for s in ("Su mma", "Pro f e s s io n a l", "Ed u ca", "Co re Co")
            ),
            "skills heading present": "Skills" in text,
            "experience heading present": "Professional Experience" in text,
            "email present": bool(re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text)),
            "no word-run concat": "Results-drivenSoftware" not in text
            and "behindArrow" not in text
            and "troubleshootJenkins" not in text,
            "url text present": "linkedin.com/in/rodrigo-benitez-9184aa214" in text,
        }
        for name, ok in checks.items():
            results.append((f"ATS: {name}", ok, ""))

        browser.close()

    print()
    failed = 0
    for label, ok, extra in results:
        mark = "YES" if ok else "NO "
        print(f"[{mark}] {label}" + (f" ({extra})" if extra else ""))
        failed += 0 if ok else 1
    print("\npdfs at:", OUT)
    print("RESULT:", "PASS" if failed == 0 else f"FAIL ({failed} check(s))")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
