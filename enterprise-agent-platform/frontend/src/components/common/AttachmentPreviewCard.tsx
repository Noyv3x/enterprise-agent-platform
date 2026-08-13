import { Button, Spin, Tabs } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useI18n, type MessageKey, type Translator } from "../../i18n";
import { api, isApiRequestCancelled, safeUrl } from "../../lib/api";
import type {
  Attachment,
  AttachmentPreview,
  AttachmentPreviewKind,
  AttachmentPreviewSection,
  XlsxPreviewSheet,
} from "../../types";
import { formatFileSize } from "../../utils/format";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

const INLINE_ROWS = 8;
const INLINE_COLUMNS = 8;
const INLINE_BLOCKS = 8;

const KIND_LABELS: Record<AttachmentPreviewKind, MessageKey> = {
  xlsx: "chat.preview.kind.xlsx",
  docx: "chat.preview.kind.docx",
  pptx: "chat.preview.kind.pptx",
  pdf: "chat.preview.kind.pdf",
};

function previewKind(filename: string | undefined, kind?: string): AttachmentPreviewKind | "" {
  if (kind === "xlsx" || kind === "docx" || kind === "pptx" || kind === "pdf") return kind;
  const suffix = String(filename || "").toLowerCase();
  if (suffix.endsWith(".xlsx")) return "xlsx";
  if (suffix.endsWith(".docx")) return "docx";
  if (suffix.endsWith(".pptx")) return "pptx";
  if (suffix.endsWith(".pdf")) return "pdf";
  return "";
}

function spreadsheetColumn(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function SheetTable({
  sheet,
  compact,
}: {
  sheet: XlsxPreviewSheet;
  compact: boolean;
}) {
  const { t } = useI18n();
  const rows = compact ? sheet.rows.slice(0, INLINE_ROWS) : sheet.rows;
  const availableColumns = Math.max(
    Number(sheet.columns) || 0,
    ...rows.map((row) => row.length),
  );
  const columnCount = compact
    ? Math.min(availableColumns, INLINE_COLUMNS)
    : availableColumns;
  const clipped = sheet.truncated
    || rows.length < sheet.rows.length
    || columnCount < availableColumns;

  if (!rows.length || columnCount === 0) {
    return <div className="xlsx-preview__empty">{t("chat.xlsx.empty")}</div>;
  }

  return (
    <>
      <div className="xlsx-preview__scroll">
        <table aria-label={t("chat.xlsx.sheet", { name: sheet.name })}>
          <thead>
            <tr>
              <th className="xlsx-preview__corner" aria-hidden="true" />
              {Array.from({ length: columnCount }, (_, index) => (
                <th key={index} scope="col">{spreadsheetColumn(index)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th scope="row">{rowIndex + 1}</th>
                {Array.from({ length: columnCount }, (_, columnIndex) => (
                  <td key={columnIndex}>{row[columnIndex] || ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {clipped ? (
        <div className="xlsx-preview__limited">{t("chat.xlsx.limited")}</div>
      ) : null}
    </>
  );
}

function sectionTitle(
  section: AttachmentPreviewSection,
  kind: AttachmentPreviewKind,
  translate: Translator,
): string {
  if (section.title) return section.title;
  const number = Number(section.index || 0);
  if (kind === "pptx" && number) return translate("chat.preview.slide", { number });
  if (kind === "pdf" && number) return translate("chat.preview.page", { number });
  return "";
}

function DocumentSections({
  sections,
  kind,
  compact,
  truncated,
}: {
  sections: AttachmentPreviewSection[];
  kind: AttachmentPreviewKind;
  compact: boolean;
  truncated: boolean;
}) {
  const { t } = useI18n();
  const visible = compact ? sections.slice(0, 1) : sections;
  const first = visible[0];
  const blocks = compact ? (first?.blocks || []).slice(0, INLINE_BLOCKS) : [];
  const clipped = truncated
    || sections.some((section) => section.truncated)
    || (compact && (
      sections.length > 1
      || (first?.blocks.length || 0) > INLINE_BLOCKS
    ));

  if (!sections.some((section) => section.blocks.length)) {
    return <div className="document-preview__empty">{t("chat.preview.empty")}</div>;
  }

  if (compact) {
    return (
      <>
        {first && sectionTitle(first, kind, t) ? (
          <div className="document-preview__section-name">{sectionTitle(first, kind, t)}</div>
        ) : null}
        <div className="document-preview__text">
          {blocks.map((block, index) => <p key={index}>{block}</p>)}
        </div>
        {clipped ? <div className="document-preview__limited">{t("chat.preview.limited")}</div> : null}
      </>
    );
  }

  if (visible.length > 1) {
    return null;
  }
  return (
    <>
      <div className="document-preview__text">
        {(first?.blocks || []).map((block, index) => <p key={index}>{block}</p>)}
      </div>
      {clipped ? <div className="document-preview__limited">{t("chat.preview.limited")}</div> : null}
    </>
  );
}

export function AttachmentPreviewCard({ attachment }: { attachment: Attachment }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [activeKey, setActiveKey] = useState("0");
  const previewUrl = safeUrl(attachment.preview_url);
  const downloadUrl = safeUrl(attachment.download_url || attachment.url);
  const name = attachment.filename || t("chat.attachment");
  const size = formatFileSize(attachment.size_bytes || 0);
  const kind = previewKind(attachment.filename, preview?.kind);
  const kindLabel = kind ? t(KIND_LABELS[kind]) : t("chat.file");

  useEffect(() => {
    if (!previewUrl) {
      setError(t("chat.preview.unavailable"));
      return;
    }
    const controller = new AbortController();
    setError("");
    api<AttachmentPreview>(previewUrl, { signal: controller.signal })
      .then((value) => setPreview(value))
      .catch((reason) => {
        if (!isApiRequestCancelled(reason)) setError(t("chat.preview.unavailable"));
      });
    return () => controller.abort();
  }, [previewUrl, t]);

  const spreadsheet = kind === "xlsx" || Boolean(preview?.sheets?.length);
  const sheets = preview?.sheets || [];
  const sections = preview?.sections || [];
  const firstSheet = sheets[0];
  const canExpand = spreadsheet
    ? Boolean(firstSheet)
    : sections.some((section) => section.blocks.length);

  const tabs = useMemo(() => {
    if (spreadsheet) {
      return sheets.map((sheet, index) => ({
        key: String(index),
        label: sheet.name,
        children: <SheetTable sheet={sheet} compact={false} />,
      }));
    }
    if (sections.length <= 1) return [];
    return sections.map((section, index) => ({
      key: String(index),
      label: sectionTitle(section, kind || "docx", t) || String(index + 1),
      children: (
        <div className="document-preview__text">
          {section.blocks.map((block, blockIndex) => <p key={blockIndex}>{block}</p>)}
          {section.truncated ? (
            <div className="document-preview__limited">{t("chat.preview.limited")}</div>
          ) : null}
        </div>
      ),
    }));
  }, [kind, sections, sheets, spreadsheet, t]);

  return (
    <section className={`msg-attachment msg-attachment--preview msg-attachment--${kind || "file"}`} aria-label={name}>
      <header className="xlsx-preview__header">
        <span className="msg-attachment__fileicon">
          <Icon name="doc" size={18} />
        </span>
        <span className="msg-attachment__meta">
          <strong title={name}>{name}</strong>
          <span>{`${kindLabel} · ${size}`}</span>
        </span>
        <span className="xlsx-preview__actions">
          <Button
            type="text"
            size="small"
            icon={<Icon name="external" size={16} />}
            aria-label={spreadsheet ? t("chat.xlsx.expand") : t("chat.preview.expand")}
            title={spreadsheet ? t("chat.xlsx.expand") : t("chat.preview.expand")}
            disabled={!canExpand}
            onClick={() => setExpanded(true)}
          />
          <Button
            type="text"
            size="small"
            icon={<Icon name="download" size={16} />}
            aria-label={spreadsheet ? t("chat.xlsx.download") : t("chat.preview.download")}
            title={spreadsheet ? t("chat.xlsx.download") : t("chat.preview.download")}
            href={downloadUrl || undefined}
            target="_blank"
            rel="noreferrer"
            disabled={!downloadUrl}
          />
        </span>
      </header>
      <div className="xlsx-preview__body" aria-live="polite">
        {!preview && !error ? (
          <div className="xlsx-preview__loading"><Spin size="small" /> {t("chat.preview.loading")}</div>
        ) : error ? (
          <div className="xlsx-preview__error">{error}</div>
        ) : spreadsheet && firstSheet ? (
          <>
            <div className="xlsx-preview__sheet-name">{firstSheet.name}</div>
            <SheetTable sheet={firstSheet} compact />
          </>
        ) : spreadsheet ? (
          <div className="xlsx-preview__empty">{t("chat.xlsx.empty")}</div>
        ) : (
          <DocumentSections
            compact
            kind={kind || "docx"}
            sections={sections}
            truncated={Boolean(preview?.truncated)}
          />
        )}
      </div>
      <Dialog
        open={expanded}
        onClose={() => setExpanded(false)}
        title={name}
        className={spreadsheet ? "xlsx-preview-dialog" : "document-preview-dialog"}
      >
        {tabs.length > 1 ? (
          <Tabs items={tabs} activeKey={activeKey} onChange={setActiveKey} />
        ) : spreadsheet && firstSheet ? (
          <SheetTable sheet={firstSheet} compact={false} />
        ) : (
          <DocumentSections
            compact={false}
            kind={kind || "docx"}
            sections={sections}
            truncated={Boolean(preview?.truncated)}
          />
        )}
      </Dialog>
    </section>
  );
}
