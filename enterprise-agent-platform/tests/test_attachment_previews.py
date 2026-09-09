from __future__ import annotations

import io
import unittest
import zipfile
from unittest import mock
from xml.sax.saxutils import escape

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

def presentation_parts(
    slides: list[list[str]], *, order: list[int] | None = None
) -> dict[str, bytes]:
    p = "http://schemas.openxmlformats.org/presentationml/2006/main"
    a = "http://schemas.openxmlformats.org/drawingml/2006/main"
    r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package = "http://schemas.openxmlformats.org/package/2006/relationships"
    if order is None:
        order = list(range(1, len(slides) + 1))
    parts = {
        "[Content_Types].xml": (
            "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'>"
            "<Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/>"
            "<Default Extension='xml' ContentType='application/xml'/>"
            "<Override PartName='/ppt/presentation.xml' "
            "ContentType='application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'/>"
            + "".join(
                f"<Override PartName='/ppt/slides/slide{index}.xml' "
                "ContentType='application/vnd.openxmlformats-officedocument.presentationml.slide+xml'/>"
                for index in range(1, len(slides) + 1)
            )
            + "</Types>"
        ).encode(),
        "_rels/.rels": (
            f"<Relationships xmlns='{package}'><Relationship Id='rId1' "
            f"Type='{r}/officeDocument' Target='ppt/presentation.xml'/></Relationships>"
        ).encode(),
        "ppt/presentation.xml": (
            f"<p:presentation xmlns:p='{p}' xmlns:r='{r}'><p:sldIdLst>"
            + "".join(
                f"<p:sldId id='{256 + position}' r:id='rId{index}'/>"
                for position, index in enumerate(order)
            )
            + "</p:sldIdLst></p:presentation>"
        ).encode(),
        "ppt/_rels/presentation.xml.rels": (
            f"<Relationships xmlns='{package}'>"
            + "".join(
                f"<Relationship Id='rId{index}' Type='{r}/slide' "
                f"Target='slides/slide{index}.xml'/>"
                for index in range(1, len(slides) + 1)
            )
            + "</Relationships>"
        ).encode(),
    }
    for index, blocks in enumerate(slides, start=1):
        parts[f"ppt/slides/slide{index}.xml"] = (
            f"<p:sld xmlns:p='{p}' xmlns:a='{a}'><p:cSld><p:spTree>"
            "<p:nvGrpSpPr><p:cNvPr id='1' name=''/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>"
            "<p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id='2' name='Text'/>"
            "<p:cNvSpPr txBox='1'/><p:nvPr/></p:nvSpPr><p:spPr/>"
            "<p:txBody><a:bodyPr/><a:lstStyle/>"
            + "".join(f"<a:p><a:r><a:t>{escape(text)}</a:t></a:r></a:p>" for text in blocks)
            + "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>"
        ).encode()
    return parts



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

    def test_pptx_preview_follows_presentation_order_and_excludes_orphan_slides(self):
        pptx = archive(presentation_parts([["ONE"], ["TWO"], ["THREE"]], order=[2, 1]))

        preview = extract_pptx_preview(pptx)

        self.assertEqual(preview["section_count"], 2)
        self.assertEqual([section["blocks"] for section in preview["sections"]], [["TWO"], ["ONE"]])
        self.assertFalse(preview["truncated"])

    def test_pptx_preview_resolves_equivalent_internal_relationship_targets(self):
        relationship_part = "ppt/_rels/presentation.xml.rels"
        parts = presentation_parts([["ONE"]])
        expected = extract_pptx_preview(archive(parts))
        for target in (b"../ppt/slides/slide1.xml", b"/ppt/slides/slide1.xml"):
            with self.subTest(target=target):
                equivalent = dict(parts)
                equivalent[relationship_part] = parts[relationship_part].replace(
                    b"Target='slides/slide1.xml'", b"Target='" + target + b"'"
                )
                self.assertEqual(extract_pptx_preview(archive(equivalent)), expected)

    def test_pptx_preview_rejects_relationships_resolving_outside_presentation(self):
        relationship_part = "ppt/_rels/presentation.xml.rels"
        for target, member in (
            (b"../escape.xml", "escape.xml"),
            (b"../../ppt/slides/slide1.xml", "ppt/slides/slide1.xml"),
        ):
            with self.subTest(target=target):
                parts = presentation_parts([["ONE"]])
                parts[member] = parts["ppt/slides/slide1.xml"]
                parts[relationship_part] = parts[relationship_part].replace(
                    b"Target='slides/slide1.xml'", b"Target='" + target + b"'"
                )
                with self.assertRaises(AttachmentPreviewError):
                    extract_pptx_preview(archive(parts))

    def test_pptx_preview_rejects_missing_presentation_metadata(self):
        for missing in ("ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "ppt/slides/slide1.xml"):
            with self.subTest(missing=missing):
                parts = presentation_parts([["ONE"]])
                del parts[missing]
                with self.assertRaises(AttachmentPreviewError):
                    extract_pptx_preview(archive(parts))

    def test_pptx_preview_rejects_invalid_slide_relationships(self):
        relationship_part = "ppt/_rels/presentation.xml.rels"
        for before, after in (
            (b"Id='rId1'", b"Id='other'"),
            (b"/relationships/slide'", b"/relationships/slideLayout'"),
            (b"Target='slides/slide1.xml'", b"Target='https://example.com/slide.xml'"),
            (b"Target='slides/slide1.xml'", b"Target='slides/slide1.xml' TargetMode='External'"),
            (b"Target='slides/slide1.xml'", b"Target='slides/missing.xml'"),
        ):
            with self.subTest(after=after):
                parts = presentation_parts([["ONE"]])
                parts[relationship_part] = parts[relationship_part].replace(before, after)
                with self.assertRaises(AttachmentPreviewError):
                    extract_pptx_preview(archive(parts))

    def test_pptx_preview_keeps_slide_and_text_limits(self):
        parts = presentation_parts([
            ["x" * (files_module.MAX_PPTX_PREVIEW_BLOCK_CHARS + 1)]
            * (files_module.MAX_PPTX_PREVIEW_BLOCKS + 1)
            for _ in range(files_module.MAX_PPTX_PREVIEW_SLIDES + 1)
        ])

        preview = extract_pptx_preview(archive(parts))

        self.assertEqual(preview["section_count"], files_module.MAX_PPTX_PREVIEW_SLIDES + 1)
        self.assertEqual(len(preview["sections"]), files_module.MAX_PPTX_PREVIEW_SLIDES)
        self.assertTrue(preview["truncated"])
        self.assertEqual(
            preview["sections"][0]["blocks"],
            ["x" * files_module.MAX_PPTX_PREVIEW_BLOCK_CHARS] * files_module.MAX_PPTX_PREVIEW_BLOCKS,
        )

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
        pptx = archive(presentation_parts([["Quarterly", "Revenue"], ["Outlook"]]))
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
