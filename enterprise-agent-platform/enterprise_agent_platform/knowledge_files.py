from __future__ import annotations

import io
import hashlib
import hmac
import json
import posixpath
import re
import stat
import zipfile
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import PurePosixPath
from xml.etree import ElementTree

from pypdf import PdfReader


MAX_KNOWLEDGE_FILE_BYTES = 50 * 1024 * 1024
MAX_KNOWLEDGE_FILES_PER_IMPORT = 10
MAX_KNOWLEDGE_IMPORT_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 10_000
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
MAX_XML_PART_BYTES = 32 * 1024 * 1024
MAX_PDF_PAGES = 5_000
MAX_XLSX_PREVIEW_BYTES = 50 * 1024 * 1024
MAX_XLSX_PREVIEW_ARCHIVE_ENTRIES = 2_048
MAX_XLSX_PREVIEW_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
MAX_XLSX_PREVIEW_XML_BYTES = 16 * 1024 * 1024
MAX_XLSX_PREVIEW_SHEETS = 5
MAX_XLSX_PREVIEW_ROWS = 100
MAX_XLSX_PREVIEW_COLUMNS = 30
MAX_XLSX_PREVIEW_CELLS = 2_000
MAX_XLSX_PREVIEW_CELL_CHARS = 500
MAX_XLSX_PREVIEW_SHARED_STRINGS = 100_000
MAX_XLSX_PREVIEW_WORKBOOK_SHEETS = 1_000
MAX_DOCUMENT_PREVIEW_BYTES = MAX_XLSX_PREVIEW_BYTES
MAX_DOCX_PREVIEW_PARAGRAPHS = 80
MAX_DOCX_PREVIEW_BLOCK_CHARS = 500
MAX_PPTX_PREVIEW_SLIDES = 12
MAX_PPTX_PREVIEW_BLOCKS = 24
MAX_PPTX_PREVIEW_BLOCK_CHARS = 400
MAX_PDF_PREVIEW_PAGES = 8
MAX_PDF_PREVIEW_PAGE_CHARS = 2_000


_CANONICAL_MEDIA_TYPES = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".html": "text/html",
    ".htm": "text/html",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".odt": "application/vnd.oasis.opendocument.text",
}

_COMPATIBLE_MEDIA_TYPES = {
    ".txt": {"text/plain"},
    ".md": {"text/markdown", "text/plain"},
    ".markdown": {"text/markdown", "text/plain"},
    ".csv": {"text/csv", "application/csv", "text/plain"},
    ".json": {"application/json", "text/json", "text/plain"},
    ".html": {"text/html", "application/xhtml+xml", "text/plain"},
    ".htm": {"text/html", "application/xhtml+xml", "text/plain"},
    ".pdf": {"application/pdf"},
    ".docx": {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    },
    ".xlsx": {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    },
    ".pptx": {
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    },
    ".odt": {"application/vnd.oasis.opendocument.text"},
}

_GENERIC_MEDIA_TYPES = {"", "application/octet-stream", "binary/octet-stream"}


class KnowledgeFileError(ValueError):
    """A bounded, user-facing document import failure."""


@dataclass(frozen=True)
class ExtractedKnowledgeFile:
    filename: str
    media_type: str
    size_bytes: int
    sha256: str
    data: bytes
    title: str
    content: str


class _VisibleHTML(HTMLParser):
    _SKIPPED = frozenset({"script", "style", "template", "noscript"})
    _BLOCKS = frozenset(
        {
            "address", "article", "aside", "blockquote", "br", "div", "dl",
            "dt", "dd", "figcaption", "figure", "footer", "h1", "h2", "h3",
            "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol",
            "p", "pre", "section", "table", "tr", "ul",
        }
    )

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        clean = tag.casefold()
        if clean in self._SKIPPED:
            self._skip_depth += 1
        elif self._skip_depth == 0 and clean in self._BLOCKS:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        clean = tag.casefold()
        if clean in self._SKIPPED and self._skip_depth:
            self._skip_depth -= 1
        elif self._skip_depth == 0 and clean in self._BLOCKS:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self._parts.append(data)

    def text(self) -> str:
        return "".join(self._parts)


def supported_knowledge_extensions() -> tuple[str, ...]:
    return tuple(sorted(_CANONICAL_MEDIA_TYPES))


def extract_knowledge_file(
    *,
    filename: str,
    declared_media_type: str,
    data: bytes,
    sha256: str,
    maximum_chars: int,
) -> ExtractedKnowledgeFile:
    if not data:
        raise KnowledgeFileError("knowledge file is empty")
    if len(data) > MAX_KNOWLEDGE_FILE_BYTES:
        raise KnowledgeFileError("knowledge file exceeds 50 MiB")
    if maximum_chars < 1:
        raise KnowledgeFileError("knowledge text extraction is disabled")
    clean_name = str(filename).strip()
    if (
        not clean_name
        or clean_name in {".", ".."}
        or "/" in clean_name
        or "\\" in clean_name
        or any(ord(character) < 32 for character in clean_name)
        or len(clean_name) > 255
    ):
        raise KnowledgeFileError("knowledge filename is invalid")
    clean_sha256 = str(sha256).casefold()
    if (
        re.fullmatch(r"[0-9a-f]{64}", clean_sha256) is None
        or not hmac.compare_digest(hashlib.sha256(data).hexdigest(), clean_sha256)
    ):
        raise KnowledgeFileError("knowledge file digest is invalid")
    suffix = PurePosixPath(clean_name).suffix.casefold()
    if suffix not in _CANONICAL_MEDIA_TYPES:
        supported = ", ".join(supported_knowledge_extensions())
        raise KnowledgeFileError(f"unsupported knowledge file type; expected {supported}")
    declared = str(declared_media_type or "").split(";", 1)[0].strip().casefold()
    if declared not in _GENERIC_MEDIA_TYPES and declared not in _COMPATIBLE_MEDIA_TYPES[suffix]:
        raise KnowledgeFileError("knowledge filename and media type do not match")

    if suffix == ".pdf":
        content = _extract_pdf(data)
    elif suffix in {".docx", ".xlsx", ".pptx", ".odt"}:
        content = _extract_archive_document(suffix, data)
    else:
        decoded = _decode_text(data)
        if suffix in {".html", ".htm"}:
            parser = _VisibleHTML()
            try:
                parser.feed(decoded)
                parser.close()
            except Exception as exc:
                raise KnowledgeFileError("HTML document is malformed") from exc
            content = parser.text()
        elif suffix == ".json":
            try:
                value = json.loads(decoded)
            except json.JSONDecodeError as exc:
                raise KnowledgeFileError("JSON document is malformed") from exc
            content = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
        else:
            content = decoded

    content = _normalize_text(content)
    if not content:
        if suffix == ".pdf":
            raise KnowledgeFileError(
                "PDF has no extractable text; scanned documents require OCR before upload"
            )
        raise KnowledgeFileError("knowledge file produced no extractable text")
    if len(content) > maximum_chars:
        raise KnowledgeFileError(
            f"extracted knowledge content exceeds {maximum_chars} characters"
        )
    title = PurePosixPath(clean_name).stem.strip() or clean_name
    return ExtractedKnowledgeFile(
        filename=clean_name,
        media_type=_CANONICAL_MEDIA_TYPES[suffix],
        size_bytes=len(data),
        sha256=clean_sha256,
        data=data,
        title=title,
        content=content,
    )


def extract_xlsx_preview(data: bytes) -> dict[str, object]:
    """Return a bounded, text-only preview of an OOXML workbook."""

    if not data or len(data) > MAX_XLSX_PREVIEW_BYTES or not data.startswith(b"PK"):
        raise KnowledgeFileError("XLSX preview input is invalid")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = _validate_archive(
                archive,
                maximum_entries=MAX_XLSX_PREVIEW_ARCHIVE_ENTRIES,
                maximum_uncompressed_bytes=MAX_XLSX_PREVIEW_UNCOMPRESSED_BYTES,
            )
            _validate_archive_identity(archive, names, ".xlsx")
            return {"kind": "xlsx", **_extract_xlsx_preview(archive, names)}
    except KnowledgeFileError:
        raise
    except (OSError, RuntimeError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        raise KnowledgeFileError("XLSX preview is malformed or unsupported") from exc


def extract_docx_preview(data: bytes) -> dict[str, object]:
    """Return a bounded, text-only preview of an OOXML document."""

    if not data or len(data) > MAX_DOCUMENT_PREVIEW_BYTES or not data.startswith(b"PK"):
        raise KnowledgeFileError("DOCX preview input is invalid")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = _validate_archive(
                archive,
                maximum_entries=MAX_XLSX_PREVIEW_ARCHIVE_ENTRIES,
                maximum_uncompressed_bytes=MAX_XLSX_PREVIEW_UNCOMPRESSED_BYTES,
            )
            _validate_archive_identity(archive, names, ".docx")
            return _extract_docx_preview(archive, names)
    except KnowledgeFileError:
        raise
    except (OSError, RuntimeError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        raise KnowledgeFileError("DOCX preview is malformed or unsupported") from exc


def extract_pptx_preview(data: bytes) -> dict[str, object]:
    """Return a bounded, text-only preview of an OOXML presentation."""

    if not data or len(data) > MAX_DOCUMENT_PREVIEW_BYTES or not data.startswith(b"PK"):
        raise KnowledgeFileError("PPTX preview input is invalid")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = _validate_archive(
                archive,
                maximum_entries=MAX_XLSX_PREVIEW_ARCHIVE_ENTRIES,
                maximum_uncompressed_bytes=MAX_XLSX_PREVIEW_UNCOMPRESSED_BYTES,
            )
            _validate_archive_identity(archive, names, ".pptx")
            return _extract_pptx_preview(archive, names)
    except KnowledgeFileError:
        raise
    except (OSError, RuntimeError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        raise KnowledgeFileError("PPTX preview is malformed or unsupported") from exc


def extract_pdf_preview(data: bytes) -> dict[str, object]:
    """Return a bounded preview of an existing PDF text layer."""

    if not data or len(data) > MAX_DOCUMENT_PREVIEW_BYTES or not data.startswith(b"%PDF-"):
        raise KnowledgeFileError("PDF preview input is invalid")
    try:
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise KnowledgeFileError("encrypted PDF documents are not supported")
        page_count = len(reader.pages)
        if page_count > MAX_PDF_PAGES:
            raise KnowledgeFileError("PDF contains too many pages")
        truncated = page_count > MAX_PDF_PREVIEW_PAGES
        sections: list[dict[str, object]] = []
        for index, page in enumerate(reader.pages[:MAX_PDF_PREVIEW_PAGES], start=1):
            raw = str(page.extract_text() or "")
            text = _preview_text(raw, maximum=MAX_PDF_PREVIEW_PAGE_CHARS)
            page_truncated = len(raw) > len(text)
            truncated = truncated or page_truncated
            sections.append(
                _preview_section(
                    [text] if text else [],
                    page_truncated,
                    index=index,
                )
            )
    except KnowledgeFileError:
        raise
    except Exception as exc:
        raise KnowledgeFileError("PDF preview is malformed or unsupported") from exc
    if not any(section["blocks"] for section in sections):
        raise KnowledgeFileError(
            "PDF has no extractable text; scanned documents cannot be previewed"
        )
    return {
        "kind": "pdf",
        "section_count": page_count,
        "sections": sections,
        "truncated": truncated,
    }


def extract_attachment_preview(filename: str, data: bytes) -> dict[str, object]:
    suffix = PurePosixPath(str(filename or "")).suffix.casefold()
    if suffix == ".xlsx":
        return extract_xlsx_preview(data)
    if suffix == ".docx":
        return extract_docx_preview(data)
    if suffix == ".pptx":
        return extract_pptx_preview(data)
    if suffix == ".pdf":
        return extract_pdf_preview(data)
    raise KnowledgeFileError("attachment preview type is unsupported")


def _decode_text(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        encoding = "utf-16"
    else:
        encoding = "utf-8-sig"
        if b"\x00" in data:
            raise KnowledgeFileError("text document contains binary data")
    try:
        return data.decode(encoding)
    except UnicodeDecodeError as exc:
        raise KnowledgeFileError("text document must use UTF-8 or BOM-marked UTF-16") from exc


def _extract_pdf(data: bytes) -> str:
    if not data.startswith(b"%PDF-"):
        raise KnowledgeFileError("PDF signature is invalid")
    try:
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise KnowledgeFileError("encrypted PDF documents are not supported")
        if len(reader.pages) > MAX_PDF_PAGES:
            raise KnowledgeFileError("PDF contains too many pages")
        pages = [str(page.extract_text() or "") for page in reader.pages]
    except KnowledgeFileError:
        raise
    except Exception as exc:
        raise KnowledgeFileError("PDF document is malformed or unsupported") from exc
    return "\n\n".join(pages)


def _extract_archive_document(suffix: str, data: bytes) -> str:
    if not data.startswith(b"PK"):
        raise KnowledgeFileError("document container signature is invalid")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = _validate_archive(archive)
            _validate_archive_identity(archive, names, suffix)
            if suffix == ".docx":
                return _extract_docx(archive, names)
            if suffix == ".xlsx":
                return _extract_xlsx(archive, names)
            if suffix == ".pptx":
                return _extract_pptx(archive, names)
            return _extract_odt(archive, names)
    except KnowledgeFileError:
        raise
    except (OSError, RuntimeError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        raise KnowledgeFileError("document container is malformed or unsupported") from exc


def _validate_archive(
    archive: zipfile.ZipFile,
    *,
    maximum_entries: int | None = None,
    maximum_uncompressed_bytes: int | None = None,
) -> set[str]:
    if maximum_entries is None:
        maximum_entries = MAX_ARCHIVE_ENTRIES
    if maximum_uncompressed_bytes is None:
        maximum_uncompressed_bytes = MAX_ARCHIVE_UNCOMPRESSED_BYTES
    entries = archive.infolist()
    if len(entries) > maximum_entries:
        raise KnowledgeFileError("document archive contains too many entries")
    total = 0
    names: set[str] = set()
    for entry in entries:
        name = entry.filename
        path = PurePosixPath(name)
        mode = (entry.external_attr >> 16) & 0o170000
        if (
            not name
            or "\\" in name
            or path.is_absolute()
            or ".." in path.parts
            or mode == stat.S_IFLNK
        ):
            raise KnowledgeFileError("document archive contains an unsafe path")
        if entry.flag_bits & 0x1:
            raise KnowledgeFileError("encrypted document archives are not supported")
        total += int(entry.file_size)
        if total > maximum_uncompressed_bytes:
            raise KnowledgeFileError("document archive expands beyond the safety limit")
        names.add(name)
    return names


def _validate_archive_identity(
    archive: zipfile.ZipFile,
    names: set[str],
    suffix: str,
) -> None:
    if suffix == ".odt":
        if "mimetype" not in names:
            raise KnowledgeFileError("ODT container identity is missing")
        identity = _read_entry(archive, "mimetype", maximum=256).decode(
            "ascii", errors="strict"
        )
        if identity != _CANONICAL_MEDIA_TYPES[suffix]:
            raise KnowledgeFileError("ODT container identity does not match its filename")
        return
    if "[Content_Types].xml" not in names:
        raise KnowledgeFileError("Office document identity is missing")
    identity = _read_entry(
        archive, "[Content_Types].xml", maximum=MAX_XML_PART_BYTES
    ).decode("utf-8", errors="replace")
    markers = {
        ".docx": "wordprocessingml.document.main+xml",
        ".xlsx": "spreadsheetml.sheet.main+xml",
        ".pptx": "presentationml.presentation.main+xml",
    }
    if markers[suffix] not in identity:
        raise KnowledgeFileError("Office container identity does not match its filename")


def _read_entry(archive: zipfile.ZipFile, name: str, *, maximum: int) -> bytes:
    try:
        info = archive.getinfo(name)
    except KeyError as exc:
        raise KnowledgeFileError("document container is missing required content") from exc
    if info.file_size > maximum:
        raise KnowledgeFileError("document XML part exceeds the safety limit")
    with archive.open(info, "r") as handle:
        value = handle.read(maximum + 1)
    if len(value) > maximum:
        raise KnowledgeFileError("document XML part exceeds the safety limit")
    return value


def _root(
    archive: zipfile.ZipFile,
    name: str,
    *,
    maximum: int = MAX_XML_PART_BYTES,
) -> ElementTree.Element:
    return ElementTree.fromstring(
        _read_entry(archive, name, maximum=maximum)
    )


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _element_text(element: ElementTree.Element) -> str:
    return "".join(
        child.text or ""
        for child in element.iter()
        if _local_name(child.tag) == "t"
    ).strip()


def _extract_docx(archive: zipfile.ZipFile, names: set[str]) -> str:
    if "word/document.xml" not in names:
        raise KnowledgeFileError("DOCX document content is missing")
    root = _root(archive, "word/document.xml")
    paragraphs = [
        _element_text(element)
        for element in root.iter()
        if _local_name(element.tag) == "p"
    ]
    return "\n".join(value for value in paragraphs if value)


def _natural_key(value: str) -> tuple[object, ...]:
    return tuple(
        int(part) if part.isdigit() else part
        for part in re.split(r"(\d+)", value)
    )


def _extract_pptx(archive: zipfile.ZipFile, names: set[str]) -> str:
    slides = sorted(
        (
            name
            for name in names
            if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
        ),
        key=_natural_key,
    )
    if not slides:
        raise KnowledgeFileError("PPTX document contains no slides")
    result: list[str] = []
    for index, name in enumerate(slides, start=1):
        text = "\n".join(
            value
            for value in (
                str(element.text or "").strip()
                for element in _root(archive, name).iter()
                if _local_name(element.tag) == "t"
            )
            if value
        )
        if text:
            result.append(f"## Slide {index}\n{text}")
    return "\n\n".join(result)


def _extract_xlsx(archive: zipfile.ZipFile, names: set[str]) -> str:
    shared: list[str] = []
    if "xl/sharedStrings.xml" in names:
        for item in _root(archive, "xl/sharedStrings.xml").iter():
            if _local_name(item.tag) == "si":
                shared.append(_element_text(item))
    sheets = sorted(
        (
            name
            for name in names
            if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)
        ),
        key=_natural_key,
    )
    if not sheets:
        raise KnowledgeFileError("XLSX document contains no worksheets")
    output: list[str] = []
    for index, name in enumerate(sheets, start=1):
        rows: list[str] = []
        for row in _root(archive, name).iter():
            if _local_name(row.tag) != "row":
                continue
            cells: list[str] = []
            for cell in row:
                if _local_name(cell.tag) != "c":
                    continue
                kind = str(cell.attrib.get("t") or "")
                value = ""
                if kind == "inlineStr":
                    value = _element_text(cell)
                else:
                    raw = next(
                        (
                            str(child.text or "")
                            for child in cell
                            if _local_name(child.tag) == "v"
                        ),
                        "",
                    )
                    if kind == "s" and raw:
                        try:
                            value = shared[int(raw)]
                        except (IndexError, ValueError) as exc:
                            raise KnowledgeFileError(
                                "XLSX shared string index is invalid"
                            ) from exc
                    else:
                        value = raw
                cells.append(value.replace("\t", " ").replace("\n", " "))
            if any(cells):
                rows.append("\t".join(cells).rstrip())
        if rows:
            output.append(f"## Sheet {index}\n" + "\n".join(rows))
    return "\n\n".join(output)


def _xlsx_sheet_parts(
    archive: zipfile.ZipFile,
    names: set[str],
) -> list[tuple[str, str]]:
    required = {"xl/workbook.xml", "xl/_rels/workbook.xml.rels"}
    if not required.issubset(names):
        raise KnowledgeFileError("XLSX workbook metadata is missing")
    relationships: dict[str, str] = {}
    for relationship in _root(
        archive,
        "xl/_rels/workbook.xml.rels",
        maximum=MAX_XLSX_PREVIEW_XML_BYTES,
    ).iter():
        if _local_name(relationship.tag) != "Relationship":
            continue
        relationship_id = str(relationship.attrib.get("Id") or "")
        relationship_type = str(relationship.attrib.get("Type") or "")
        target = str(relationship.attrib.get("Target") or "")
        if (
            not relationship_id
            or not relationship_type.endswith("/worksheet")
            or str(relationship.attrib.get("TargetMode") or "").casefold() == "external"
        ):
            continue
        target_path = PurePosixPath(target.lstrip("/"))
        if target_path.is_absolute() or ".." in target_path.parts or "\\" in target:
            raise KnowledgeFileError("XLSX worksheet relationship is unsafe")
        normalized = posixpath.normpath(
            target.lstrip("/") if target.startswith("/xl/") else f"xl/{target}"
        )
        if not normalized.startswith("xl/") or normalized not in names:
            raise KnowledgeFileError("XLSX worksheet relationship is invalid")
        relationships[relationship_id] = normalized

    sheets: list[tuple[str, str]] = []
    for element in _root(
        archive,
        "xl/workbook.xml",
        maximum=MAX_XLSX_PREVIEW_XML_BYTES,
    ).iter():
        if _local_name(element.tag) != "sheet":
            continue
        relationship_id = next(
            (
                str(value)
                for key, value in element.attrib.items()
                if _local_name(key) == "id"
            ),
            "",
        )
        part = relationships.get(relationship_id)
        if part is None:
            raise KnowledgeFileError("XLSX worksheet relationship is missing")
        name = str(element.attrib.get("name") or f"Sheet {len(sheets) + 1}")
        name = _preview_text(name)
        sheets.append((name or f"Sheet {len(sheets) + 1}", part))
        if len(sheets) > MAX_XLSX_PREVIEW_WORKBOOK_SHEETS:
            raise KnowledgeFileError("XLSX workbook contains too many worksheets")
    if not sheets:
        raise KnowledgeFileError("XLSX document contains no worksheets")
    return sheets


def _xlsx_column_index(reference: str) -> int | None:
    match = re.fullmatch(r"([A-Za-z]{1,4})[1-9][0-9]*", reference)
    if match is None:
        return None
    value = 0
    for character in match.group(1).upper():
        value = value * 26 + ord(character) - ord("A") + 1
    return value - 1


def _preview_text(value: object, *, maximum: int = MAX_XLSX_PREVIEW_CELL_CHARS) -> str:
    return str(value or "").replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")[
        : max(0, int(maximum))
    ]


def _preview_section(
    blocks: list[str],
    truncated: bool,
    *,
    index: int | None = None,
    title: str = "",
) -> dict[str, object]:
    section: dict[str, object] = {"title": title, "blocks": blocks, "truncated": truncated}
    if index is not None:
        section["index"] = index
    return section


def _extract_docx_preview(
    archive: zipfile.ZipFile,
    names: set[str],
) -> dict[str, object]:
    if "word/document.xml" not in names:
        raise KnowledgeFileError("DOCX document content is missing")
    blocks: list[str] = []
    truncated = False
    for element in _root(
        archive,
        "word/document.xml",
        maximum=MAX_XLSX_PREVIEW_XML_BYTES,
    ).iter():
        if _local_name(element.tag) != "p":
            continue
        raw = _element_text(element)
        if not raw:
            continue
        if len(blocks) >= MAX_DOCX_PREVIEW_PARAGRAPHS:
            truncated = True
            break
        text = _preview_text(raw, maximum=MAX_DOCX_PREVIEW_BLOCK_CHARS)
        truncated = truncated or len(raw) > len(text)
        blocks.append(text)
    return {
        "kind": "docx",
        "section_count": 1,
        "sections": [_preview_section(blocks, truncated)],
        "truncated": truncated,
    }


def _extract_pptx_preview(
    archive: zipfile.ZipFile,
    names: set[str],
) -> dict[str, object]:
    slides = sorted(
        (
            name
            for name in names
            if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
        ),
        key=_natural_key,
    )
    if not slides:
        raise KnowledgeFileError("PPTX document contains no slides")
    truncated = len(slides) > MAX_PPTX_PREVIEW_SLIDES
    sections: list[dict[str, object]] = []
    for index, name in enumerate(slides[:MAX_PPTX_PREVIEW_SLIDES], start=1):
        blocks: list[str] = []
        slide_truncated = False
        for element in _root(
            archive,
            name,
            maximum=MAX_XLSX_PREVIEW_XML_BYTES,
        ).iter():
            if _local_name(element.tag) != "t":
                continue
            raw = str(element.text or "").strip()
            if not raw:
                continue
            if len(blocks) >= MAX_PPTX_PREVIEW_BLOCKS:
                slide_truncated = True
                break
            text = _preview_text(raw, maximum=MAX_PPTX_PREVIEW_BLOCK_CHARS)
            slide_truncated = slide_truncated or len(raw) > len(text)
            blocks.append(text)
        truncated = truncated or slide_truncated
        sections.append(_preview_section(blocks, slide_truncated, index=index))
    return {
        "kind": "pptx",
        "section_count": len(slides),
        "sections": sections,
        "truncated": truncated,
    }


def _xlsx_preview_cell(
    cell: ElementTree.Element,
    shared: list[tuple[str, bool]],
) -> tuple[str, bool]:
    formula = next(
        (
            str(child.text or "")
            for child in cell
            if _local_name(child.tag) == "f"
        ),
        "",
    )
    raw_value = next(
        (
            str(child.text or "")
            for child in cell
            if _local_name(child.tag) == "v"
        ),
        "",
    )
    kind = str(cell.attrib.get("t") or "")
    source_truncated = False
    if formula:
        value = f"={formula}"
    elif kind == "inlineStr":
        value = _element_text(cell)
    elif kind == "s" and raw_value:
        try:
            value, source_truncated = shared[int(raw_value)]
        except (IndexError, ValueError) as exc:
            raise KnowledgeFileError("XLSX shared string index is invalid") from exc
    elif kind == "b":
        value = "TRUE" if raw_value == "1" else "FALSE"
    else:
        value = raw_value
    clean = _preview_text(value)
    return clean, source_truncated or len(str(value or "")) > len(clean)


def _extract_xlsx_preview(
    archive: zipfile.ZipFile,
    names: set[str],
) -> dict[str, object]:
    shared: list[tuple[str, bool]] = []
    if "xl/sharedStrings.xml" in names:
        for item in _root(
            archive,
            "xl/sharedStrings.xml",
            maximum=MAX_XLSX_PREVIEW_XML_BYTES,
        ).iter():
            if _local_name(item.tag) == "si":
                raw = _element_text(item)
                clean = _preview_text(raw)
                shared.append((clean, len(raw) > len(clean)))
                if len(shared) > MAX_XLSX_PREVIEW_SHARED_STRINGS:
                    raise KnowledgeFileError(
                        "XLSX workbook contains too many shared strings"
                    )

    sheet_parts = _xlsx_sheet_parts(archive, names)
    preview_sheets: list[dict[str, object]] = []
    total_cells = 0
    overall_truncated = len(sheet_parts) > MAX_XLSX_PREVIEW_SHEETS
    for sheet_name, part in sheet_parts[:MAX_XLSX_PREVIEW_SHEETS]:
        rows: list[list[str]] = []
        sheet_truncated = False
        maximum_columns = 0
        for row in _root(
            archive,
            part,
            maximum=MAX_XLSX_PREVIEW_XML_BYTES,
        ).iter():
            if _local_name(row.tag) != "row":
                continue
            if len(rows) >= MAX_XLSX_PREVIEW_ROWS or total_cells >= MAX_XLSX_PREVIEW_CELLS:
                sheet_truncated = True
                break
            values: list[str] = []
            sequential_column = 0
            for cell in row:
                if _local_name(cell.tag) != "c":
                    continue
                reference = str(cell.attrib.get("r") or "")
                column = _xlsx_column_index(reference)
                if column is None:
                    column = sequential_column
                sequential_column = column + 1
                if column >= MAX_XLSX_PREVIEW_COLUMNS or total_cells >= MAX_XLSX_PREVIEW_CELLS:
                    sheet_truncated = True
                    continue
                while len(values) <= column:
                    values.append("")
                value, value_truncated = _xlsx_preview_cell(cell, shared)
                values[column] = value
                sheet_truncated = sheet_truncated or value_truncated
                total_cells += 1
            while values and not values[-1]:
                values.pop()
            maximum_columns = max(maximum_columns, len(values))
            rows.append(values)
        overall_truncated = overall_truncated or sheet_truncated
        preview_sheets.append(
            {
                "name": sheet_name,
                "rows": rows,
                "columns": maximum_columns,
                "truncated": sheet_truncated,
            }
        )
    return {
        "sheet_count": len(sheet_parts),
        "sheets": preview_sheets,
        "truncated": overall_truncated,
    }


def _extract_odt(archive: zipfile.ZipFile, names: set[str]) -> str:
    if "content.xml" not in names:
        raise KnowledgeFileError("ODT document content is missing")
    paragraphs = [
        "".join(element.itertext()).strip()
        for element in _root(archive, "content.xml").iter()
        if _local_name(element.tag) in {"p", "h"}
    ]
    return "\n".join(value for value in paragraphs if value)


def _normalize_text(value: str) -> str:
    clean = value.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in clean.split("\n")]
    output: list[str] = []
    blank = False
    for line in lines:
        if line:
            output.append(line)
            blank = False
        elif output and not blank:
            output.append("")
            blank = True
    return "\n".join(output).strip()
