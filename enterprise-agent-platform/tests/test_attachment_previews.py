from __future__ import annotations

import io
import unittest
import zipfile
from unittest import mock

from enterprise_agent_platform import attachment_previews as files_module
from enterprise_agent_platform.attachment_previews import (
    AttachmentPreviewError,
    extract_docx_preview,
    extract_pdf_preview,
    extract_pptx_preview,
    extract_xlsx_preview,
)


def archive(entries: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as value:
        for name, content in entries.items():
            value.writestr(name, content)
    return output.getvalue()


def content_types(marker: str) -> bytes:
    return (
        "<?xml version='1.0' encoding='UTF-8'?>"
        "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'>"
        f"<Override PartName='/main.xml' ContentType='application/{marker}'/>"
        "</Types>"
    ).encode()


class AttachmentPreviewTests(unittest.TestCase):
    def test_xlsx_preview_preserves_sheet_names_columns_and_formula_text(self):
        xlsx = archive({
            "[Content_Types].xml": content_types(
                "vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
            ),
            "xl/workbook.xml": (
                b"<workbook xmlns='x' xmlns:r='r'><sheets>"
                b"<sheet name='Summary' r:id='rId1'/></sheets></workbook>"
            ),
            "xl/_rels/workbook.xml.rels": (
                b"<Relationships><Relationship Id='rId1' "
                b"Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' "
                b"Target='worksheets/sheet1.xml'/></Relationships>"
            ),
            "xl/sharedStrings.xml": (
                b"<sst xmlns='x'><si><t>Name</t></si><si><t>Alice</t></si></sst>"
            ),
            "xl/worksheets/sheet1.xml": (
                b"<worksheet xmlns='x'><sheetData>"
                b"<row r='1'><c r='A1' t='s'><v>0</v></c>"
                b"<c r='C1'><f>SUM(A2:A3)</f><v>2</v></c></row>"
                b"<row r='2'><c r='A2' t='s'><v>1</v></c>"
                b"<c r='B2' t='b'><v>1</v></c></row>"
                b"</sheetData></worksheet>"
            ),
        })

        preview = extract_xlsx_preview(xlsx)

        self.assertEqual(preview["kind"], "xlsx")
        self.assertEqual(preview["sheet_count"], 1)
        self.assertFalse(preview["truncated"])
        sheet = preview["sheets"][0]
        self.assertEqual(sheet["name"], "Summary")
        self.assertEqual(sheet["rows"][0], ["Name", "", "=SUM(A2:A3)"])
        self.assertEqual(sheet["rows"][1], ["Alice", "TRUE"])

    def test_xlsx_preview_rejects_unsafe_worksheet_relationship(self):
        xlsx = archive({
            "[Content_Types].xml": content_types(
                "vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
            ),
            "xl/workbook.xml": (
                b"<workbook xmlns='x' xmlns:r='r'>"
                b"<sheet name='Bad' r:id='rId1'/></workbook>"
            ),
            "xl/_rels/workbook.xml.rels": (
                b"<Relationships><Relationship Id='rId1' "
                b"Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' "
                b"Target='../escape.xml'/></Relationships>"
            ),
        })

        with self.assertRaisesRegex(AttachmentPreviewError, "unsafe"):
            extract_xlsx_preview(xlsx)

    def test_document_slide_and_pdf_previews_return_bounded_sections(self):
        docx = archive({
            "[Content_Types].xml": content_types(
                "vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
            ),
            "word/document.xml": (
                b"<w:document xmlns:w='w'><w:body>"
                b"<w:p><w:r><w:t>Title line</w:t></w:r></w:p>"
                b"<w:p><w:r><w:t>Body paragraph</w:t></w:r></w:p>"
                b"</w:body></w:document>"
            ),
        })
        pptx = archive({
            "[Content_Types].xml": content_types(
                "vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
            ),
            "ppt/slides/slide1.xml": (
                b"<p:sld xmlns:p='p' xmlns:a='a'>"
                b"<a:t>Quarterly</a:t><a:t>Revenue</a:t></p:sld>"
            ),
            "ppt/slides/slide2.xml": (
                b"<p:sld xmlns:p='p' xmlns:a='a'><a:t>Outlook</a:t></p:sld>"
            ),
        })
        reader = mock.Mock(
            is_encrypted=False,
            pages=[
                mock.Mock(extract_text=mock.Mock(return_value="Page one text")),
                mock.Mock(extract_text=mock.Mock(return_value="Page two text")),
            ],
        )

        document = extract_docx_preview(docx)
        slides = extract_pptx_preview(pptx)
        with mock.patch.object(files_module, "PdfReader", return_value=reader):
            pdf = extract_pdf_preview(b"%PDF-preview")

        self.assertEqual(document["sections"][0]["blocks"], [
            "Title line",
            "Body paragraph",
        ])
        self.assertEqual(slides["section_count"], 2)
        self.assertEqual(slides["sections"][0]["blocks"], ["Quarterly", "Revenue"])
        self.assertEqual(pdf["section_count"], 2)
        self.assertEqual(pdf["sections"][0]["blocks"], ["Page one text"])

        empty = mock.Mock(
            is_encrypted=False,
            pages=[mock.Mock(extract_text=mock.Mock(return_value=""))],
        )
        with mock.patch.object(files_module, "PdfReader", return_value=empty):
            with self.assertRaisesRegex(AttachmentPreviewError, "no extractable text"):
                extract_pdf_preview(b"%PDF-empty")


if __name__ == "__main__":
    unittest.main()
