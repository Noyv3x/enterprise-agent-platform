from __future__ import annotations

import hashlib
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.db import Database
from enterprise_agent_platform.knowledge import (
    KnowledgeBase,
    KnowledgeEmbeddingConfig,
)
from enterprise_agent_platform import knowledge_files as files_module
from enterprise_agent_platform.knowledge_files import (
    ExtractedKnowledgeFile,
    KnowledgeFileError,
    extract_docx_preview,
    extract_knowledge_file,
    extract_pdf_preview,
    extract_pptx_preview,
    extract_xlsx_preview,
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def extract(filename: str, media_type: str, data: bytes, *, maximum: int = 100_000):
    return extract_knowledge_file(
        filename=filename,
        declared_media_type=media_type,
        data=data,
        sha256=digest(data),
        maximum_chars=maximum,
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


class FakeEmbeddingClient:
    def embed(self, texts):
        return [[1.0, 0.5, 0.25] for _text in texts]


def configured_knowledge(database: Database) -> KnowledgeBase:
    return KnowledgeBase(
        database,
        KnowledgeEmbeddingConfig(
            base_url="https://embeddings.example/v1",
            model="test",
            api_key="secret",
            dimensions=3,
        ),
        FakeEmbeddingClient(),
    )


class KnowledgeFileExtractionTests(unittest.TestCase):
    def test_text_markdown_csv_json_and_html_are_deterministic(self):
        cases = [
            ("notes.txt", "text/plain", b"alpha\r\n\r\nbeta", "alpha\n\nbeta"),
            ("notes.md", "text/markdown", b"# Alpha\nBody", "# Alpha\nBody"),
            ("rows.csv", "text/csv", b"name,value\na,1", "name,value\na,1"),
            ("data.json", "application/json", b'{"b":2,"a":1}', '"a": 1'),
            (
                "page.html",
                "text/html",
                b"<h1>Alpha</h1><script>bad()</script><p>Beta</p>",
                "Alpha\n\nBeta",
            ),
        ]
        for filename, media_type, data, expected in cases:
            with self.subTest(filename=filename):
                result = extract(filename, media_type, data)
                self.assertIn(expected, result.content)
                self.assertEqual(result.filename, filename)
                self.assertEqual(result.sha256, digest(data))

    def test_docx_xlsx_pptx_and_odt_extract_visible_text(self):
        docx = archive({
            "[Content_Types].xml": content_types(
                "vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
            ),
            "word/document.xml": (
                b"<w:document xmlns:w='w'><w:body><w:p><w:r><w:t>Alpha"
                b"</w:t></w:r></w:p><w:p><w:r><w:t>Beta</w:t></w:r></w:p>"
                b"</w:body></w:document>"
            ),
        })
        xlsx = archive({
            "[Content_Types].xml": content_types(
                "vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
            ),
            "xl/sharedStrings.xml": (
                b"<sst xmlns='x'><si><t>Alpha</t></si></sst>"
            ),
            "xl/worksheets/sheet1.xml": (
                b"<worksheet xmlns='x'><sheetData><row><c t='s'><v>0</v></c>"
                b"<c><v>42</v></c></row></sheetData></worksheet>"
            ),
        })
        pptx = archive({
            "[Content_Types].xml": content_types(
                "vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
            ),
            "ppt/slides/slide1.xml": b"<p:sld xmlns:p='p' xmlns:a='a'><a:t>Alpha</a:t></p:sld>",
        })
        odt = archive({
            "mimetype": b"application/vnd.oasis.opendocument.text",
            "content.xml": b"<office:document xmlns:office='o' xmlns:text='t'><text:p>Alpha</text:p></office:document>",
        })
        cases = [
            ("file.docx", docx, "Alpha\nBeta"),
            ("file.xlsx", xlsx, "Alpha 42"),
            ("file.pptx", pptx, "Slide 1\nAlpha"),
            ("file.odt", odt, "Alpha"),
        ]
        for filename, data, expected in cases:
            with self.subTest(filename=filename):
                self.assertIn(expected, extract(filename, "application/octet-stream", data).content)

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
                b"<row r='1'><c r='A1' t='s'><v>0</v></c><c r='C1'><f>SUM(A2:A3)</f><v>2</v></c></row>"
                b"<row r='2'><c r='A2' t='s'><v>1</v></c><c r='B2' t='b'><v>1</v></c></row>"
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

    def test_xlsx_preview_rejects_external_or_unsafe_worksheet_relationships(self):
        xlsx = archive({
            "[Content_Types].xml": content_types(
                "vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
            ),
            "xl/workbook.xml": (
                b"<workbook xmlns='x' xmlns:r='r'><sheet name='Bad' r:id='rId1'/></workbook>"
            ),
            "xl/_rels/workbook.xml.rels": (
                b"<Relationships><Relationship Id='rId1' "
                b"Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' "
                b"Target='../escape.xml'/></Relationships>"
            ),
        })
        with self.assertRaisesRegex(KnowledgeFileError, "unsafe"):
            extract_xlsx_preview(xlsx)

    def test_docx_pptx_and_pdf_previews_return_bounded_text_sections(self):
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
                b"<p:sld xmlns:p='p' xmlns:a='a'><a:t>Quarterly</a:t><a:t>Revenue</a:t></p:sld>"
            ),
            "ppt/slides/slide2.xml": (
                b"<p:sld xmlns:p='p' xmlns:a='a'><a:t>Outlook</a:t></p:sld>"
            ),
        })
        page = mock.Mock()
        page.extract_text.return_value = "Page one text"
        second = mock.Mock()
        second.extract_text.return_value = "Page two text"
        reader = mock.Mock(is_encrypted=False, pages=[page, second])

        document = extract_docx_preview(docx)
        slides = extract_pptx_preview(pptx)
        with mock.patch.object(files_module, "PdfReader", return_value=reader):
            pdf = extract_pdf_preview(b"%PDF-preview")

        self.assertEqual(document["kind"], "docx")
        self.assertEqual(document["sections"][0]["blocks"], ["Title line", "Body paragraph"])
        self.assertEqual(slides["kind"], "pptx")
        self.assertEqual(slides["section_count"], 2)
        self.assertEqual(slides["sections"][0]["index"], 1)
        self.assertEqual(slides["sections"][0]["blocks"], ["Quarterly", "Revenue"])
        self.assertEqual(pdf["kind"], "pdf")
        self.assertEqual(pdf["section_count"], 2)
        self.assertEqual(pdf["sections"][0]["blocks"], ["Page one text"])

        empty_pdf = mock.Mock(is_encrypted=False, pages=[mock.Mock(extract_text=mock.Mock(return_value=""))])
        with mock.patch.object(files_module, "PdfReader", return_value=empty_pdf):
            with self.assertRaisesRegex(KnowledgeFileError, "no extractable text"):
                extract_pdf_preview(b"%PDF-empty")

    def test_pdf_uses_existing_text_layer_and_rejects_scans(self):
        page = mock.Mock()
        page.extract_text.return_value = "Alpha PDF"
        reader = mock.Mock(is_encrypted=False, pages=[page])
        with mock.patch.object(files_module, "PdfReader", return_value=reader):
            result = extract("paper.pdf", "application/pdf", b"%PDF-fake")
        self.assertEqual(result.content, "Alpha PDF")

        page.extract_text.return_value = ""
        with mock.patch.object(files_module, "PdfReader", return_value=reader):
            with self.assertRaisesRegex(KnowledgeFileError, "OCR"):
                extract("scan.pdf", "application/pdf", b"%PDF-scan")

    def test_format_identity_digest_and_archive_safety_fail_closed(self):
        data = b"plain"
        with self.assertRaisesRegex(KnowledgeFileError, "media type do not match"):
            extract("note.txt", "application/pdf", data)
        with self.assertRaisesRegex(KnowledgeFileError, "digest is invalid"):
            extract_knowledge_file(
                filename="note.txt",
                declared_media_type="text/plain",
                data=data,
                sha256="0" * 64,
                maximum_chars=100,
            )
        unsafe = archive({
            "[Content_Types].xml": content_types(
                "vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
            ),
            "word/document.xml": b"<document/>",
            "../escape": b"bad",
        })
        with self.assertRaisesRegex(KnowledgeFileError, "unsafe path"):
            extract("bad.docx", "application/octet-stream", unsafe)
        wrong_identity = archive({
            "[Content_Types].xml": content_types(
                "vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
            ),
            "xl/worksheets/sheet1.xml": b"<worksheet/>",
        })
        with self.assertRaisesRegex(KnowledgeFileError, "does not match"):
            extract("bad.docx", "application/octet-stream", wrong_identity)

    def test_archive_and_extracted_text_budgets_are_enforced(self):
        docx = archive({
            "[Content_Types].xml": content_types(
                "vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
            ),
            "word/document.xml": b"<document>too large</document>",
        })
        with mock.patch.object(files_module, "MAX_ARCHIVE_UNCOMPRESSED_BYTES", 8):
            with self.assertRaisesRegex(KnowledgeFileError, "safety limit"):
                extract("large.docx", "application/octet-stream", docx)
        with self.assertRaisesRegex(KnowledgeFileError, "exceeds 3 characters"):
            extract("large.txt", "text/plain", b"four", maximum=3)


class KnowledgeFileStorageTests(unittest.TestCase):
    def test_import_batch_limits_are_enforced_inside_the_knowledge_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory) / "platform.db")
            try:
                knowledge = configured_knowledge(database)
                item = extract("one.txt", "text/plain", b"Alpha")
                with self.assertRaisesRegex(ValueError, "at most 10"):
                    knowledge.import_files([item] * 11, created_by=None)
                oversized = ExtractedKnowledgeFile(
                    filename="large.txt",
                    media_type="text/plain",
                    size_bytes=100 * 1024 * 1024 + 1,
                    sha256=digest(b"Alpha"),
                    data=b"Alpha",
                    title="Large",
                    content="Alpha",
                )
                with self.assertRaisesRegex(ValueError, "100 MiB total"):
                    knowledge.import_files([oversized], created_by=None)
                self.assertEqual(
                    database.scalar("SELECT count(*) FROM knowledge_documents"), 0
                )
            finally:
                database.close()

    def test_batch_import_preserves_original_and_downloads_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory) / "platform.db")
            try:
                knowledge = configured_knowledge(database)
                one = extract("one.md", "text/markdown", b"# One\nAlpha")
                two = extract("two.txt", "text/plain", b"Beta")
                results = knowledge.import_files([one, two], created_by=None)
                self.assertEqual([item["created"] for item in results], [True, True])
                document_id = int(results[0]["document"]["id"])
                self.assertEqual(
                    results[0]["document"]["original_filename"], "one.md"
                )
                self.assertNotIn("content", results[0]["document"])
                download = knowledge.download_document(document_id)
                self.assertEqual(download["content"], b"# One\nAlpha")
                self.assertTrue(download["original"])
                duplicate = knowledge.import_files([one], created_by=None)
                self.assertFalse(duplicate[0]["created"])
                self.assertEqual(
                    database.scalar("SELECT count(*) FROM knowledge_document_files"), 2
                )
            finally:
                database.close()

    def test_manual_document_download_is_markdown(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory) / "platform.db")
            try:
                knowledge = configured_knowledge(database)
                document = knowledge.add_document(
                    title="Manual", content="Alpha", summary="Summary", source="Wiki"
                )
                expected_hash = hashlib.sha256(
                    "Manual\x00Alpha\x00Wiki".encode("utf-8")
                ).hexdigest()
                self.assertEqual(document["content_hash"], expected_hash)
                download = knowledge.download_document(int(document["id"]))
                self.assertEqual(download["media_type"], "text/markdown; charset=utf-8")
                self.assertIn(b"# Manual", download["content"])
                self.assertIn(b"Alpha", download["content"])
                self.assertFalse(download["original"])
            finally:
                database.close()

    def test_batch_database_failure_rolls_back_every_file(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory) / "platform.db")
            try:
                knowledge = configured_knowledge(database)
                valid = extract("valid.txt", "text/plain", b"Alpha")
                invalid = ExtractedKnowledgeFile(
                    filename="x" * 256,
                    media_type="text/plain",
                    size_bytes=4,
                    sha256=digest(b"Beta"),
                    data=b"Beta",
                    title="Invalid",
                    content="Beta",
                )
                with self.assertRaises(Exception):
                    knowledge.import_files([valid, invalid], created_by=None)
                self.assertEqual(
                    database.scalar("SELECT count(*) FROM knowledge_documents"), 0
                )
                self.assertEqual(
                    database.scalar("SELECT count(*) FROM knowledge_document_files"), 0
                )
            finally:
                database.close()


if __name__ == "__main__":
    unittest.main()
