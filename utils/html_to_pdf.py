#!/usr/bin/env python3
"""
html_to_pdf.py — Convert DOCUMENTO_FORMAL.html to a professional PDF using Playwright.
"""
import sys
import argparse
from pathlib import Path


def convert(html_path: str, pdf_path: str):
    from playwright.sync_api import sync_playwright

    html_file = Path(html_path).resolve()
    pdf_file = Path(pdf_path).resolve()

    if not html_file.exists():
        print(f"[ERROR] HTML file not found: {html_file}", file=sys.stderr)
        sys.exit(1)

    file_url = html_file.as_uri()

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(file_url, wait_until="networkidle")

        page.pdf(
            path=str(pdf_file),
            format="A4",
            margin={"top": "25mm", "bottom": "25mm", "left": "28mm", "right": "28mm"},
            print_background=True,
            display_header_footer=True,
            header_template=(
                '<div style="font-size:8px;color:#888;width:100%;text-align:center;'
                'font-family:Georgia,serif;padding-top:8mm;">'
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

    print(f"[OK] PDF generated: {pdf_file}")


def main():
    parser = argparse.ArgumentParser(description="Convert document HTML to PDF.")
    parser.add_argument(
        "-i", "--input",
        default="DOCUMENTO_FORMAL.html",
        help="Input HTML file (default: DOCUMENTO_FORMAL.html)",
    )
    parser.add_argument(
        "-o", "--output",
        default="DOCUMENTO_FORMAL.pdf",
        help="Output PDF file (default: DOCUMENTO_FORMAL.pdf)",
    )
    args = parser.parse_args()
    convert(args.input, args.output)


if __name__ == "__main__":
    main()
