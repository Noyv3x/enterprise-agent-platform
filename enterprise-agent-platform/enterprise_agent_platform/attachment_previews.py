from __future__ import annotations

"""Bounded text previews for chat attachments."""

import io
import posixpath
import re
import stat
import zipfile
from pathlib import PurePosixPath
from xml.etree import ElementTree

from pypdf import PdfReader


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


class AttachmentPreviewError(ValueError):
    """A bounded, user-facing attachment preview failure."""


def extract_xlsx_preview(data: bytes) -> dict[str, object]:
    """Return a bounded, text-only preview of an OOXML workbook."""

    if not data or len(data) > MAX_XLSX_PREVIEW_BYTES or not data.startswith(b"PK"):
        raise AttachmentPreviewError("XLSX preview input is invalid")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = _validate_archive(
                archive,
                maximum_entries=MAX_XLSX_PREVIEW_ARCHIVE_ENTRIES,
                maximum_uncompressed_bytes=MAX_XLSX_PREVIEW_UNCOMPRESSED_BYTES,
            )
            _validate_archive_identity(archive, names, ".xlsx")
            return {"kind": "xlsx", **_extract_xlsx_preview(archive, names)}
    except AttachmentPreviewError:
        raise
    except (OSError, RuntimeError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        raise AttachmentPreviewError("XLSX preview is malformed or unsupported") from exc


def extract_docx_preview(data: bytes) -> dict[str, object]:
    """Return a bounded, text-only preview of an OOXML document."""

    if not data or len(data) > MAX_DOCUMENT_PREVIEW_BYTES or not data.startswith(b"PK"):
        raise AttachmentPreviewError("DOCX preview input is invalid")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = _validate_archive(
                archive,
                maximum_entries=MAX_XLSX_PREVIEW_ARCHIVE_ENTRIES,
                maximum_uncompressed_bytes=MAX_XLSX_PREVIEW_UNCOMPRESSED_BYTES,
            )
            _validate_archive_identity(archive, names, ".docx")
            return _extract_docx_preview(archive, names)
    except AttachmentPreviewError:
        raise
    except (OSError, RuntimeError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        raise AttachmentPreviewError("DOCX preview is malformed or unsupported") from exc


def extract_pptx_preview(data: bytes) -> dict[str, object]:
    """Return a bounded, text-only preview of an OOXML presentation."""

    if not data or len(data) > MAX_DOCUMENT_PREVIEW_BYTES or not data.startswith(b"PK"):
        raise AttachmentPreviewError("PPTX preview input is invalid")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = _validate_archive(
                archive,
                maximum_entries=MAX_XLSX_PREVIEW_ARCHIVE_ENTRIES,
                maximum_uncompressed_bytes=MAX_XLSX_PREVIEW_UNCOMPRESSED_BYTES,
            )
            _validate_archive_identity(archive, names, ".pptx")
            return _extract_pptx_preview(archive, names)
    except AttachmentPreviewError:
        raise
    except (OSError, RuntimeError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        raise AttachmentPreviewError("PPTX preview is malformed or unsupported") from exc


def extract_pdf_preview(data: bytes) -> dict[str, object]:
    """Return a bounded preview of an existing PDF text layer."""

    if not data or len(data) > MAX_DOCUMENT_PREVIEW_BYTES or not data.startswith(b"%PDF-"):
        raise AttachmentPreviewError("PDF preview input is invalid")
    try:
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise AttachmentPreviewError("encrypted PDF documents are not supported")
        page_count = len(reader.pages)
        if page_count > MAX_PDF_PAGES:
            raise AttachmentPreviewError("PDF contains too many pages")
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
    except AttachmentPreviewError:
        raise
    except Exception as exc:
        raise AttachmentPreviewError("PDF preview is malformed or unsupported") from exc
    if not any(section["blocks"] for section in sections):
        raise AttachmentPreviewError(
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
    raise AttachmentPreviewError("attachment preview type is unsupported")


def _validate_archive(
    archive: zipfile.ZipFile,
    *,
    maximum_entries: int,
    maximum_uncompressed_bytes: int,
) -> set[str]:
    entries = archive.infolist()
    if len(entries) > maximum_entries:
        raise AttachmentPreviewError("document archive contains too many entries")
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
            raise AttachmentPreviewError("document archive contains an unsafe path")
        if entry.flag_bits & 0x1:
            raise AttachmentPreviewError("encrypted document archives are not supported")
        total += int(entry.file_size)
        if total > maximum_uncompressed_bytes:
            raise AttachmentPreviewError("document archive expands beyond the safety limit")
        names.add(name)
    return names


def _validate_archive_identity(
    archive: zipfile.ZipFile,
    names: set[str],
    suffix: str,
) -> None:
    if "[Content_Types].xml" not in names:
        raise AttachmentPreviewError("Office document identity is missing")
    identity = _read_entry(
        archive, "[Content_Types].xml", maximum=MAX_XML_PART_BYTES
    ).decode("utf-8", errors="replace")
    markers = {
        ".docx": "wordprocessingml.document.main+xml",
        ".xlsx": "spreadsheetml.sheet.main+xml",
        ".pptx": "presentationml.presentation.main+xml",
    }
    if markers[suffix] not in identity:
        raise AttachmentPreviewError("Office container identity does not match its filename")


def _read_entry(archive: zipfile.ZipFile, name: str, *, maximum: int) -> bytes:
    try:
        info = archive.getinfo(name)
    except KeyError as exc:
        raise AttachmentPreviewError("document container is missing required content") from exc
    if info.file_size > maximum:
        raise AttachmentPreviewError("document XML part exceeds the safety limit")
    with archive.open(info, "r") as handle:
        value = handle.read(maximum + 1)
    if len(value) > maximum:
        raise AttachmentPreviewError("document XML part exceeds the safety limit")
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


def _natural_key(value: str) -> tuple[object, ...]:
    return tuple(
        int(part) if part.isdigit() else part
        for part in re.split(r"(\d+)", value)
    )


def _xlsx_sheet_parts(
    archive: zipfile.ZipFile,
    names: set[str],
) -> list[tuple[str, str]]:
    required = {"xl/workbook.xml", "xl/_rels/workbook.xml.rels"}
    if not required.issubset(names):
        raise AttachmentPreviewError("XLSX workbook metadata is missing")
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
            raise AttachmentPreviewError("XLSX worksheet relationship is unsafe")
        normalized = posixpath.normpath(
            target.lstrip("/") if target.startswith("/xl/") else f"xl/{target}"
        )
        if not normalized.startswith("xl/") or normalized not in names:
            raise AttachmentPreviewError("XLSX worksheet relationship is invalid")
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
            raise AttachmentPreviewError("XLSX worksheet relationship is missing")
        name = str(element.attrib.get("name") or f"Sheet {len(sheets) + 1}")
        name = _preview_text(name)
        sheets.append((name or f"Sheet {len(sheets) + 1}", part))
        if len(sheets) > MAX_XLSX_PREVIEW_WORKBOOK_SHEETS:
            raise AttachmentPreviewError("XLSX workbook contains too many worksheets")
    if not sheets:
        raise AttachmentPreviewError("XLSX document contains no worksheets")
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
        raise AttachmentPreviewError("DOCX document content is missing")
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
        raise AttachmentPreviewError("PPTX document contains no slides")
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
            raise AttachmentPreviewError("XLSX shared string index is invalid") from exc
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
                    raise AttachmentPreviewError(
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
