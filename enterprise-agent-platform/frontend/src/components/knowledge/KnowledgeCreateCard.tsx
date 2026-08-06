import { Button, Form, Input, Progress, Tabs, Typography, Upload } from "antd";
import type { UploadFile } from "antd";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "../../context/ToastContext";
import {
  createDocument,
  importKnowledgeDocuments,
  loadDocuments,
} from "../../data/knowledgeActions";
import { resourceKeys, runResourceLoad } from "../../data/resourceState";
import { runBusy } from "../../data/sessionActions";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Icon } from "../common/Icon";

const { TextArea } = Input;
const { Dragger } = Upload;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const ACCEPTED_DOCUMENTS = [
  ".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm",
  ".pdf", ".docx", ".xlsx", ".pptx", ".odt",
].join(",");

export function KnowledgeCreateCard({
  onSaved,
  onDirtyChange,
}: {
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const createBusy = useStore((state) => state.pendingOperations.includes("knowledge:create"));
  const importBusy = useStore((state) => state.pendingOperations.includes("knowledge:import"));
  const [mode, setMode] = useState<"manual" | "upload">("upload");
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fieldPrefix = useId();
  const dirty = !!(title || source || summary || content || files.length);
  const selectedFiles = useMemo(
    () => files.flatMap((file) => file.originFileObj ? [file.originFileObj as File] : []),
    [files],
  );
  const totalBytes = useMemo(
    () => selectedFiles.reduce((total, file) => total + file.size, 0),
    [selectedFiles],
  );

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const refreshAndFinish = async () => {
    await runResourceLoad(store, resourceKeys.knowledgeList, () => loadDocuments(store));
    toast(t("knowledge.saved"), { type: "ok", title: t("toast.complete") });
    onSaved?.();
  };

  const manualForm = (
    <Form
      layout="vertical"
      requiredMark="optional"
      onFinish={() => {
        void runBusy(store, "knowledge:create", async () => {
          await createDocument({ title, source, summary, content });
          setTitle("");
          setSource("");
          setSummary("");
          setContent("");
          await refreshAndFinish();
        });
      }}
    >
      <Form.Item label={t("knowledge.title")} htmlFor={`${fieldPrefix}-title`} required>
        <Input
          id={`${fieldPrefix}-title`}
          placeholder={t("knowledge.title")}
          value={title}
          maxLength={255}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Form.Item>
      <Form.Item label={t("knowledge.source")} htmlFor={`${fieldPrefix}-source`}>
        <Input
          id={`${fieldPrefix}-source`}
          placeholder={t("knowledge.sourcePlaceholder")}
          value={source}
          onChange={(event) => setSource(event.target.value)}
        />
      </Form.Item>
      <Form.Item label={t("knowledge.summary")} htmlFor={`${fieldPrefix}-summary`}>
        <Input
          id={`${fieldPrefix}-summary`}
          placeholder={t("knowledge.summaryPlaceholder")}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
        />
      </Form.Item>
      <Form.Item label={t("knowledge.content")} htmlFor={`${fieldPrefix}-content`} required>
        <TextArea
          id={`${fieldPrefix}-content`}
          className="knowledge-create__content"
          autoSize={{ minRows: 10, maxRows: 22 }}
          placeholder={t("knowledge.contentPlaceholder")}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
      </Form.Item>
      <Button
        type="primary"
        htmlType="submit"
        icon={<Icon name="plus" size={16} />}
        loading={createBusy}
        disabled={!title.trim() || !content.trim()}
      >
        {t("knowledge.save")}
      </Button>
    </Form>
  );

  const uploadForm = (
    <div className="knowledge-import">
      <Dragger
        accept={ACCEPTED_DOCUMENTS}
        multiple
        maxCount={10}
        fileList={files}
        disabled={importBusy}
        beforeUpload={(file) => {
          if (file.size > MAX_FILE_BYTES) {
            toast(t("knowledge.importFileTooLarge", { name: file.name }), { type: "error" });
            return Upload.LIST_IGNORE;
          }
          return false;
        }}
        onChange={({ fileList }) => setFiles(fileList.slice(0, 10))}
      >
        <p className="ant-upload-drag-icon"><Icon name="upload" size={34} /></p>
        <p className="ant-upload-text">{t("knowledge.importDrop")}</p>
        <p className="ant-upload-hint">{t("knowledge.importFormats")}</p>
      </Dragger>
      <Typography.Text type={totalBytes > MAX_TOTAL_BYTES ? "danger" : "secondary"}>
        {t("knowledge.importSelection", {
          count: selectedFiles.length,
          size: (totalBytes / (1024 * 1024)).toFixed(1),
        })}
      </Typography.Text>
      {progress ? (
        <Progress
          percent={progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0}
          status={importBusy ? "active" : "normal"}
        />
      ) : null}
      <div className="knowledge-import__actions">
        <Button
          type="primary"
          icon={<Icon name="upload" size={16} />}
          loading={importBusy}
          disabled={!selectedFiles.length || totalBytes > MAX_TOTAL_BYTES}
          onClick={() => {
            const controller = new AbortController();
            abortRef.current = controller;
            setProgress({ loaded: 0, total: totalBytes });
            void runBusy(store, "knowledge:import", async () => {
              try {
                await importKnowledgeDocuments(selectedFiles, {
                  signal: controller.signal,
                  onProgress: setProgress,
                });
                setFiles([]);
                await refreshAndFinish();
              } finally {
                if (abortRef.current === controller) abortRef.current = null;
                setProgress(null);
              }
            });
          }}
        >
          {t("knowledge.importStart")}
        </Button>
        {importBusy ? (
          <Button onClick={() => abortRef.current?.abort()}>{t("knowledge.importCancel")}</Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="knowledge-create">
      <Tabs
        activeKey={mode}
        onChange={(key) => setMode(key as "manual" | "upload")}
        items={[
          { key: "upload", label: t("knowledge.importTab"), children: uploadForm },
          { key: "manual", label: t("knowledge.manualTab"), children: manualForm },
        ]}
      />
    </div>
  );
}
