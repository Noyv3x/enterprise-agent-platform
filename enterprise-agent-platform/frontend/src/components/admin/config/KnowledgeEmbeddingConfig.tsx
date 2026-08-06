import {
  Alert,
  Button,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Progress,
  Space,
  Tag,
} from "antd";
import { useEffect, useId, useMemo, useState } from "react";
import {
  reindexKnowledge,
  saveKnowledgeConfig,
} from "../../../data/adminActions";
import { useI18n, type Translator } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type {
  KnowledgeEmbeddingConfigValues,
  KnowledgeIndexState,
} from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Icon } from "../../common/Icon";
import { AdminCard } from "../AdminCard";

interface KnowledgeFormState {
  baseUrl: string;
  model: string;
  dimensions: number | null;
  batchSize: number;
  apiKey: string;
}

function seedForm(config: KnowledgeEmbeddingConfigValues): KnowledgeFormState {
  return {
    baseUrl: config.base_url || "",
    model: config.model || "",
    dimensions: config.dimensions ?? null,
    batchSize: config.batch_size || 32,
    apiKey: "",
  };
}

function statusColor(state: KnowledgeIndexState): string {
  switch (state) {
    case "ready": return "success";
    case "indexing": return "processing";
    case "degraded": return "warning";
    case "disabled": return "default";
  }
}

function statusLabel(t: Translator, state: KnowledgeIndexState): string {
  return t(`admin.knowledge.status.${state}`);
}

export function KnowledgeEmbeddingConfig() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const configState = useStore((state) => state.knowledgeConfig);
  const status = useStore((state) => state.knowledgeStatus);
  const saving = useStore((state) => state.pendingOperations.includes("admin:knowledge:save"));
  const reindexing = useStore((state) => state.pendingOperations.includes("admin:knowledge:reindex"));
  const formId = useId();
  const config = configState?.config;
  const [form, setForm] = useState<KnowledgeFormState>(() => seedForm(config || {
    base_url: "",
    model: "",
    dimensions: null,
    batch_size: 32,
    credential_configured: false,
  }));

  useEffect(() => {
    if (config) setForm(seedForm(config));
  }, [config]);

  const seeded = useMemo(() => config ? seedForm(config) : null, [config]);
  if (!config || !status || !seeded) return null;

  const dirty = JSON.stringify(form) !== JSON.stringify(seeded);
  const valid = !!form.baseUrl.trim()
    && !!form.model.trim()
    && form.batchSize > 0
    && (config.credential_configured || !!form.apiKey.trim());
  const total = Math.max(0, status.total_documents || 0);
  const indexed = Math.min(total, Math.max(0, status.indexed_documents || 0));
  const percent = total > 0 ? Math.round((indexed / total) * 100) : status.state === "ready" ? 100 : 0;
  const statusDetail = status.last_error || status.detail || "";
  const configuredCredential = config.credential_configured;

  const submit = () => {
    if (!valid) return;
    void saveKnowledgeConfig(store, {
      base_url: form.baseUrl.trim(),
      model: form.model.trim(),
      dimensions: form.dimensions,
      batch_size: form.batchSize,
      api_key: form.apiKey.trim(),
    });
  };

  return (
    <AdminCard className="config-form knowledge-embedding-config">
      <CardHead
        title={t("admin.knowledge.title")}
        icon="library"
        desc={t("admin.knowledge.description")}
        extra={(
          <Tag color={statusColor(status.state)}>
            {statusLabel(t, status.state)}
          </Tag>
        )}
      />

      {statusDetail ? (
        <Alert
          showIcon
          type={status.state === "degraded" ? "warning" : "info"}
          message={statusDetail}
        />
      ) : null}

      <Descriptions
        className="knowledge-embedding-config__status"
        column={{ xs: 1, sm: 2, lg: 4 }}
        size="small"
        items={[
          {
            key: "generation",
            label: t("admin.knowledge.activeGeneration"),
            children: status.active_generation_id == null ? "—" : String(status.active_generation_id),
          },
          {
            key: "indexed",
            label: t("admin.knowledge.indexedDocuments"),
            children: `${indexed} / ${total}`,
          },
          {
            key: "pending",
            label: t("admin.knowledge.pendingDocuments"),
            children: String(status.pending_documents || 0),
          },
          {
            key: "failed",
            label: t("admin.knowledge.failedDocuments"),
            children: String(status.failed_documents || 0),
          },
        ]}
      />
      {status.state === "indexing" ? (
        <Progress
          percent={percent}
          status="active"
          aria-label={t("admin.knowledge.indexProgress")}
        />
      ) : null}

      <Form layout="vertical" requiredMark={false} onFinish={submit}>
        <div className="config-grid">
          <Form.Item
            className="eap-field field--full"
            label={t("admin.knowledge.baseUrl")}
            htmlFor={`${formId}-base-url`}
            required
          >
            <Input
              id={`${formId}-base-url`}
              inputMode="url"
              autoComplete="url"
              placeholder="https://api.example.com/v1"
              value={form.baseUrl}
              onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
            />
          </Form.Item>
          <Form.Item
            className="eap-field"
            label={t("admin.knowledge.model")}
            htmlFor={`${formId}-model`}
            required
          >
            <Input
              id={`${formId}-model`}
              autoComplete="off"
              placeholder="text-embedding-3-small"
              value={form.model}
              onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
            />
          </Form.Item>
          <Form.Item
            className="eap-field"
            label={t("admin.knowledge.dimensions")}
            htmlFor={`${formId}-dimensions`}
            extra={t("admin.knowledge.dimensionsHint")}
          >
            <InputNumber
              id={`${formId}-dimensions`}
              min={1}
              max={65_536}
              precision={0}
              placeholder={t("admin.knowledge.providerDefault")}
              value={form.dimensions}
              onChange={(value) => setForm((current) => ({ ...current, dimensions: value }))}
            />
          </Form.Item>
          <Form.Item
            className="eap-field"
            label={t("admin.knowledge.batchSize")}
            htmlFor={`${formId}-batch-size`}
            required
          >
            <InputNumber
              id={`${formId}-batch-size`}
              min={1}
              max={2048}
              precision={0}
              value={form.batchSize}
              onChange={(value) => setForm((current) => ({ ...current, batchSize: value || 0 }))}
            />
          </Form.Item>
          <Form.Item
            className="eap-field"
            label={t("admin.knowledge.apiKey")}
            htmlFor={`${formId}-api-key`}
            extra={configuredCredential
              ? t("admin.knowledge.apiKeyConfigured", {
                mask: config.credential_masked || "••••••••",
              })
              : t("admin.knowledge.apiKeyRequired")}
          >
            <Input.Password
              id={`${formId}-api-key`}
              autoComplete="new-password"
              placeholder={configuredCredential
                ? t("admin.common.keepUnchanged")
                : t("admin.knowledge.apiKeyPlaceholder")}
              value={form.apiKey}
              onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
            />
          </Form.Item>
        </div>
        <div className="form-actions">
          <Space wrap>
            <Button
              type="primary"
              htmlType="submit"
              disabled={!dirty || !valid}
              loading={saving}
            >
              {t(saving ? "admin.common.verifying" : "admin.knowledge.save")}
            </Button>
            <Popconfirm
              title={t("admin.knowledge.reindexConfirm")}
              description={t("admin.knowledge.reindexConfirmHint")}
              okText={t("admin.knowledge.reindex")}
              cancelText={t("admin.common.cancel")}
              onConfirm={() => void reindexKnowledge(store)}
              disabled={!configuredCredential || status.state === "indexing" || saving}
            >
              <Button
                icon={<Icon name="refresh" size={16} />}
                loading={reindexing}
                disabled={!configuredCredential || status.state === "indexing" || saving}
              >
                {t("admin.knowledge.reindex")}
              </Button>
            </Popconfirm>
          </Space>
        </div>
      </Form>
    </AdminCard>
  );
}
