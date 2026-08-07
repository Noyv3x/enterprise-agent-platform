import { Button, Spin, Tabs } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { api, isApiRequestCancelled, safeUrl } from "../../lib/api";
import type {
  Attachment,
  XlsxAttachmentPreview,
  XlsxPreviewSheet,
} from "../../types";
import { formatFileSize } from "../../utils/format";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

const INLINE_ROWS = 8;
const INLINE_COLUMNS = 8;

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

export function XlsxAttachmentCard({ attachment }: { attachment: Attachment }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<XlsxAttachmentPreview | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [activeSheet, setActiveSheet] = useState("0");
  const previewUrl = safeUrl(attachment.preview_url);
  const downloadUrl = safeUrl(attachment.download_url || attachment.url);
  const name = attachment.filename || t("chat.attachment");
  const size = formatFileSize(attachment.size_bytes || 0);

  useEffect(() => {
    if (!previewUrl) {
      setError(t("chat.xlsx.unavailable"));
      return;
    }
    const controller = new AbortController();
    setError("");
    api<XlsxAttachmentPreview>(previewUrl, { signal: controller.signal })
      .then((value) => setPreview(value))
      .catch((reason) => {
        if (!isApiRequestCancelled(reason)) setError(t("chat.xlsx.unavailable"));
      });
    return () => controller.abort();
  }, [previewUrl, t]);

  const tabs = useMemo(
    () => (preview?.sheets || []).map((sheet, index) => ({
      key: String(index),
      label: sheet.name,
      children: <SheetTable sheet={sheet} compact={false} />,
    })),
    [preview],
  );
  const firstSheet = preview?.sheets[0];

  return (
    <section className="msg-attachment msg-attachment--xlsx" aria-label={name}>
      <header className="xlsx-preview__header">
        <span className="msg-attachment__fileicon">
          <Icon name="doc" size={18} />
        </span>
        <span className="msg-attachment__meta">
          <strong title={name}>{name}</strong>
          <span>{`${t("chat.xlsx.workbook")} · ${size}`}</span>
        </span>
        <span className="xlsx-preview__actions">
          <Button
            type="text"
            size="small"
            icon={<Icon name="external" size={16} />}
            aria-label={t("chat.xlsx.expand")}
            title={t("chat.xlsx.expand")}
            disabled={!preview || !preview.sheets.length}
            onClick={() => setExpanded(true)}
          />
          <Button
            type="text"
            size="small"
            icon={<Icon name="download" size={16} />}
            aria-label={t("chat.xlsx.download")}
            title={t("chat.xlsx.download")}
            href={downloadUrl || undefined}
            target="_blank"
            rel="noreferrer"
            disabled={!downloadUrl}
          />
        </span>
      </header>
      <div className="xlsx-preview__body" aria-live="polite">
        {!preview && !error ? (
          <div className="xlsx-preview__loading"><Spin size="small" /> {t("chat.xlsx.loading")}</div>
        ) : error ? (
          <div className="xlsx-preview__error">{error}</div>
        ) : firstSheet ? (
          <>
            <div className="xlsx-preview__sheet-name">{firstSheet.name}</div>
            <SheetTable sheet={firstSheet} compact />
          </>
        ) : (
          <div className="xlsx-preview__empty">{t("chat.xlsx.empty")}</div>
        )}
      </div>
      <Dialog
        open={expanded}
        onClose={() => setExpanded(false)}
        title={name}
        className="xlsx-preview-dialog"
      >
        {tabs.length > 1 ? (
          <Tabs items={tabs} activeKey={activeSheet} onChange={setActiveSheet} />
        ) : firstSheet ? (
          <SheetTable sheet={firstSheet} compact={false} />
        ) : null}
      </Dialog>
    </section>
  );
}
