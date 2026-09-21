import { Button, DataTable, SegmentedControl } from "../ui/beautiful";
import { useEffect, useState } from "react";
import { useI18n, type MessageKey } from "../../i18n";
import { api, isApiRequestCancelled, safeUrl } from "../../lib/api";
import type { Attachment, AttachmentPreview, AttachmentPreviewKind, AttachmentPreviewSection, XlsxPreviewSheet } from "../../types";
import { formatFileSize } from "../../utils/format";
import { AttachmentSlot, LoadingState, Notice } from "../ui/beautiful";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import "../preview/preview.css";

const KIND_LABELS: Record<AttachmentPreviewKind, MessageKey> = {
  xlsx: "chat.preview.kind.xlsx", docx: "chat.preview.kind.docx",
  pptx: "chat.preview.kind.pptx", pdf: "chat.preview.kind.pdf",
};

function columnName(index: number): string {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

function Sheet({ sheet, compact }: { sheet: XlsxPreviewSheet; compact: boolean }) {
  const { t } = useI18n();
  const rows = compact ? sheet.rows.slice(0, 8) : sheet.rows;
  const count = Math.max(sheet.columns, ...rows.map((row) => row.length));
  const visibleColumns = compact ? Math.min(8, count) : count;
  const limited = sheet.truncated || rows.length < sheet.rows.length || visibleColumns < count;
  return <div className="bui-document-sheet">
    {rows.length && visibleColumns ? <DataTable<{ cells: string[]; index: number }>
      aria-label={t("chat.xlsx.sheet", { name: sheet.name })}
      rows={rows.map((cells, index) => ({ cells, index }))}
      columns={Array.from({ length: visibleColumns }, (_, index) => ({
        title: columnName(index), key: String(index), render: (row: { cells: string[] }) => row.cells[index] || "",
      }))}
      rowKey={row => row.index}
    /> : <Notice title={t("chat.xlsx.empty")} />}
    {limited ? <Notice title={t("chat.xlsx.limited")} /> : null}
  </div>;
}

function TextSection({ section, compact }: { section?: AttachmentPreviewSection; compact: boolean }) {
  const { t } = useI18n();
  const blocks = section?.blocks || [];
  const visible = compact ? blocks.slice(0, 8) : blocks;
  return <div className="bui-document-text">
    {visible.length ? visible.map((text, index) => <p key={index}>{text}</p>) : <Notice title={t("chat.preview.empty")} />}
    {section?.truncated || visible.length < blocks.length ? <Notice title={t("chat.preview.limited")} /> : null}
  </div>;
}

export function AttachmentPreviewCard({ attachment }: { attachment: Attachment }) {
  const { t } = useI18n();
  const rawUrl = safeUrl(attachment.preview_url);
  let previewUrl = "";
  try {
    const url = new URL(rawUrl, window.location.origin);
    if (rawUrl && url.origin === window.location.origin && !url.username && !url.password
      && url.pathname === `/api/attachments/${encodeURIComponent(String(attachment.id))}/preview`) previewUrl = url.pathname + url.search;
  } catch { /* Invalid attachment URLs cannot initiate a preview request. */ }
  const identity = `${attachment.id}:${previewUrl}`;
  const [result, setResult] = useState<{ identity: string; preview?: AttachmentPreview; failed?: boolean } | null>(null);
  const [openIdentity, setOpenIdentity] = useState<string | null>(null);
  const [selection, setSelection] = useState({ identity, key: "0" });
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setResult(null);
    setOpenIdentity(null);
    setSelection({ identity, key: "0" });
    if (previewUrl) {
      api<AttachmentPreview>(previewUrl, { signal: controller.signal }).then((preview) => {
        if (current) setResult({ identity, preview });
      }).catch((reason) => {
        if (current && !isApiRequestCancelled(reason)) setResult({ identity, failed: true });
      });
    }
    return () => { current = false; controller.abort(); };
  }, [identity, previewUrl]);
  const preview = result?.identity === identity ? result.preview : undefined;
  const failed = !previewUrl || (result?.identity === identity && result.failed);
  const suffix = attachment.filename?.split(".").pop()?.toLowerCase();
  const kind = preview?.kind || (suffix && suffix in KIND_LABELS ? suffix as AttachmentPreviewKind : undefined);
  const sheets = preview?.sheets || [];
  const sections = preview?.sections || [];
  const spreadsheet = kind === "xlsx";
  const name = attachment.filename || t("chat.attachment");
  const download = safeUrl(attachment.download_url || attachment.url);
  const expandLabel = t(spreadsheet ? "chat.xlsx.expand" : "chat.preview.expand");
  const downloadLabel = t(spreadsheet ? "chat.xlsx.download" : "chat.preview.download");
  const sectionLabel = (section: AttachmentPreviewSection, index: number) => section.title || (
    kind === "pdf" ? t("chat.preview.page", { number: section.index || index + 1 }) :
    kind === "pptx" ? t("chat.preview.slide", { number: section.index || index + 1 }) : String(index + 1));
  const canExpand = Boolean(preview && (spreadsheet ? sheets.length : sections.some((section) => section.blocks.length)));
  const downloadAction = download ? <a className="bui-attachment-download" aria-label={downloadLabel} title={downloadLabel} href={download} target="_blank" rel="noreferrer"><Icon name="download" size={18} /></a> : undefined;
  const selectedIndex = Number(selection.identity === identity ? selection.key : "0");
  const compact = failed ? <Notice tone="warning" title={t("chat.preview.unavailable")} /> : !preview ? <LoadingState label={t("chat.preview.loading")} /> : <>
    {spreadsheet ? sheets[0] ? <><strong>{sheets[0].name}</strong><Sheet sheet={sheets[0]} compact /></> : <Notice title={t("chat.xlsx.empty")} /> : <>
      {sections[0] && (sections[0].title || kind === "pdf" || kind === "pptx") ? <strong>{sectionLabel(sections[0], 0)}</strong> : null}
      <TextSection section={sections[0]} compact />
    </>}
    {preview.truncated || (spreadsheet ? sheets.length > 1 : sections.length > 1) ? <Notice title={t(spreadsheet ? "chat.xlsx.limited" : "chat.preview.limited")} /> : null}
  </>;
  return <>
    <AttachmentSlot name={name} meta={`${kind ? t(KIND_LABELS[kind]) : attachment.mime_type || t("chat.file")} · ${formatFileSize(attachment.size_bytes || 0)}`}
      actions={<><Button variant="ghost" icon={<Icon name="external" size={18} />} aria-label={expandLabel} title={expandLabel} disabled={!canExpand} onClick={() => setOpenIdentity(identity)} />{downloadAction}</>}
      preview={<div className="bui-document-compact" aria-live="polite">{compact}</div>}
    />
    <Dialog open={openIdentity === identity} onClose={() => setOpenIdentity(null)} title={name} footer={downloadAction}>
      <div className="bui-document-expanded">
        {preview ? <>
          <SegmentedControl value={String(selectedIndex)} onChange={key => setSelection({ identity, key })}
            aria-label={name} options={spreadsheet ? sheets.map((sheet, index) => ({ value: String(index), label: sheet.name })) : sections.map((section, index) => ({ value: String(index), label: sectionLabel(section, index) }))} />
          {spreadsheet ? sheets[selectedIndex] ? <Sheet sheet={sheets[selectedIndex]} compact={false} /> : null : <TextSection section={sections[selectedIndex]} compact={false} />}
          {preview.truncated ? <Notice title={t(spreadsheet ? "chat.xlsx.limited" : "chat.preview.limited")} /> : null}
        </> : null}
      </div>
    </Dialog>
  </>;
}
