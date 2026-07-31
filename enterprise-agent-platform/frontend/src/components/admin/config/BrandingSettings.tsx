import {
  Alert,
  Button,
  Form,
  Input,
  Popconfirm,
  Space,
  Upload,
} from "antd";
import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import {
  deleteBrandingLogo,
  saveBrandingConfig,
  saveBrandingLogo,
} from "../../../data/adminActions";
import {
  isValidBrandingName,
  useBranding,
  DEFAULT_BRANDING,
} from "../../../context/BrandingContext";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { BrandingSnapshot } from "../../../types";
import { CardHead } from "../../common/CardHead";
import { Icon } from "../../common/Icon";
import { AdminCard } from "../AdminCard";

const LOGO_MAX_BYTES = 256 * 1024;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

interface BrandingFormState {
  productName: string;
  agentName: string;
  primaryColor: string;
}

function seedForm(snapshot: BrandingSnapshot | null): BrandingFormState {
  const source = snapshot ?? DEFAULT_BRANDING;
  return {
    productName: source.product_name,
    agentName: source.agent_name,
    primaryColor: source.primary_color,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export async function brandingLogoPayload(file: File): Promise<{
  mime_type: "image/png" | "image/webp";
  data_base64: string;
}> {
  if (file.type !== "image/png" && file.type !== "image/webp") {
    throw new Error("unsupported_type");
  }
  if (file.size <= 0 || file.size > LOGO_MAX_BYTES) {
    throw new Error("invalid_size");
  }
  return {
    mime_type: file.type,
    data_base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
  };
}

function BrandingPreview({ form, snapshot }: {
  form: BrandingFormState;
  snapshot: BrandingSnapshot;
}) {
  const { t } = useI18n();
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [snapshot.logo_url]);
  const productName = form.productName.trim() || DEFAULT_BRANDING.product_name;
  const agentName = form.agentName.trim() || DEFAULT_BRANDING.agent_name;
  const previewStyle = {
    "--branding-preview-color": COLOR_RE.test(form.primaryColor)
      ? form.primaryColor
      : DEFAULT_BRANDING.primary_color,
  } as CSSProperties;

  return (
    <div className="branding-preview-grid" style={previewStyle}>
      {(["light", "dark"] as const).map((tone) => (
        <div className={`branding-preview branding-preview--${tone}`} key={tone}>
          <span className="branding-preview__label">
            {t(`admin.branding.preview.${tone}`)}
          </span>
          {snapshot.logo_url && !logoFailed ? (
            <img
              src={snapshot.logo_url}
              alt={productName}
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <strong>{productName}</strong>
          )}
          <span>{agentName}</span>
          <i aria-hidden="true" />
        </div>
      ))}
    </div>
  );
}

export function BrandingSettings() {
  const { t } = useI18n();
  const { applyBranding } = useBranding();
  const store = useStoreHandle();
  const config = useStore((state) => state.brandingConfig) ?? DEFAULT_BRANDING;
  const saving = useStore((state) => state.pendingOperations.some(
    (operation) => operation.startsWith("admin:branding:"),
  ));
  const formId = useId();
  const [form, setForm] = useState<BrandingFormState>(() => seedForm(config));
  const [logoError, setLogoError] = useState("");

  useEffect(() => setForm(seedForm(config)), [config]);

  const seeded = useMemo(() => seedForm(config), [config]);
  const dirty = JSON.stringify(form) !== JSON.stringify(seeded);
  const valid = isValidBrandingName(form.productName)
    && isValidBrandingName(form.agentName)
    && COLOR_RE.test(form.primaryColor);

  const saveText = () => {
    if (!valid) return;
    void saveBrandingConfig(store, {
      expected_revision: config.revision,
      product_name: form.productName.trim().normalize("NFC"),
      agent_name: form.agentName.trim().normalize("NFC"),
      primary_color: form.primaryColor.toLowerCase(),
    }, applyBranding);
  };

  const uploadLogo = async (file: File) => {
    setLogoError("");
    if (dirty) {
      setLogoError(t("admin.branding.logoSaveFirst"));
      return;
    }
    try {
      const payload = await brandingLogoPayload(file);
      await saveBrandingLogo(store, {
        expected_revision: config.revision,
        ...payload,
      }, applyBranding);
    } catch (error) {
      if (error instanceof Error && error.message === "unsupported_type") {
        setLogoError(t("admin.branding.logoTypeError"));
      } else if (error instanceof Error && error.message === "invalid_size") {
        setLogoError(t("admin.branding.logoSizeError"));
      }
    }
  };

  return (
    <AdminCard className="config-form branding-settings">
      <CardHead
        title={t("admin.branding.title")}
        icon="settings"
        desc={t("admin.branding.description")}
      />
      <BrandingPreview form={form} snapshot={config} />
      <Form layout="vertical" requiredMark={false} onFinish={saveText}>
        <div className="config-grid">
          <Form.Item
            className="eap-field"
            label={t("admin.branding.productName")}
            htmlFor={`${formId}-product-name`}
            validateStatus={isValidBrandingName(form.productName) ? undefined : "error"}
            help={isValidBrandingName(form.productName) ? t("admin.branding.nameHint") : t("admin.branding.nameError")}
          >
            <Input
              id={`${formId}-product-name`}
              value={form.productName}
              onChange={(event) => setForm((current) => ({ ...current, productName: event.target.value }))}
            />
          </Form.Item>
          <Form.Item
            className="eap-field"
            label={t("admin.branding.agentName")}
            htmlFor={`${formId}-agent-name`}
            validateStatus={isValidBrandingName(form.agentName) ? undefined : "error"}
            help={isValidBrandingName(form.agentName) ? t("admin.branding.nameHint") : t("admin.branding.nameError")}
          >
            <Input
              id={`${formId}-agent-name`}
              value={form.agentName}
              onChange={(event) => setForm((current) => ({ ...current, agentName: event.target.value }))}
            />
          </Form.Item>
          <Form.Item
            className="eap-field"
            label={t("admin.branding.primaryColor")}
            htmlFor={`${formId}-primary-color`}
            validateStatus={COLOR_RE.test(form.primaryColor) ? undefined : "error"}
            help={COLOR_RE.test(form.primaryColor) ? t("admin.branding.colorHint") : t("admin.branding.colorError")}
          >
            <div className="branding-color-field">
              <Input
                aria-label={t("admin.branding.colorPicker")}
                type="color"
                value={COLOR_RE.test(form.primaryColor) ? form.primaryColor : DEFAULT_BRANDING.primary_color}
                onChange={(event) => setForm((current) => ({ ...current, primaryColor: event.target.value }))}
              />
              <Input
                id={`${formId}-primary-color`}
                className="mono"
                maxLength={7}
                value={form.primaryColor}
                onChange={(event) => setForm((current) => ({ ...current, primaryColor: event.target.value }))}
              />
            </div>
          </Form.Item>
          <div className="eap-field branding-logo-field">
            <strong>{t("admin.branding.logo")}</strong>
            <span className="field-help">{t("admin.branding.logoHint")}</span>
            <Space wrap>
              <Upload
                accept="image/png,image/webp"
                beforeUpload={(file) => {
                  void uploadLogo(file);
                  return Upload.LIST_IGNORE;
                }}
                disabled={saving}
                maxCount={1}
                showUploadList={false}
              >
                <Button icon={<Icon name="upload" size={16} />} disabled={saving}>
                  {config.logo_url ? t("admin.branding.logoReplace") : t("admin.branding.logoUpload")}
                </Button>
              </Upload>
              {config.logo_url ? (
                <Popconfirm
                  title={t("admin.branding.logoDeleteConfirm")}
                  okText={t("admin.branding.logoDelete")}
                  cancelText={t("admin.common.cancel")}
                  onConfirm={() => void deleteBrandingLogo(
                    store,
                    { expected_revision: config.revision },
                    applyBranding,
                  )}
                >
                  <Button danger icon={<Icon name="trash" size={16} />} disabled={saving || dirty}>
                    {t("admin.branding.logoDelete")}
                  </Button>
                </Popconfirm>
              ) : null}
            </Space>
            {logoError ? <Alert type="error" showIcon title={logoError} /> : null}
          </div>
        </div>
        <div className="form-actions branding-actions">
          <Button onClick={() => setForm(seedForm(DEFAULT_BRANDING))} disabled={saving}>
            {t("admin.branding.useDefaults")}
          </Button>
          <Button type="primary" htmlType="submit" disabled={!dirty || !valid} loading={saving}>
            {saving ? t("admin.common.saving") : t("admin.branding.save")}
          </Button>
        </div>
      </Form>
    </AdminCard>
  );
}
