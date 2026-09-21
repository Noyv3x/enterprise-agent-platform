import { Button, Form, Input, Segmented, Upload } from "antd";
import { useEffect, useState } from "react";
import { DEFAULT_BRANDING, isValidBrandingName, useBranding } from "../../../context/BrandingContext";
import { deleteBrandingLogo, saveBrandingConfig, saveBrandingLogo } from "../../../data/adminActions";
import { useConfirm } from "../../../hooks/useConfirm";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { BrandingSnapshot } from "../../../types";
import { BrandMark, FieldworkProvider, FormFooter, FormGrid, Notice, PageHeader, Section, StatusMark } from "../../ui/fieldwork";

const COLOR = /^#[0-9a-f]{6}$/i;
function seed(snapshot: BrandingSnapshot) { return { product: snapshot.product_name, agent: snapshot.agent_name, color: snapshot.primary_color }; }
export async function brandingLogoPayload(file: File): Promise<{ mime_type: "image/png" | "image/webp"; data_base64: string }> {
  if (file.type !== "image/png" && file.type !== "image/webp") throw new Error("unsupported_type");
  if (file.size <= 0 || file.size > 256 * 1024) throw new Error("invalid_size");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { mime_type: file.type, data_base64: btoa(binary) };
}
export function BrandingSettings() {
  const { t } = useI18n();
  const { applyBranding } = useBranding();
  const { confirm, dialog } = useConfirm();
  const store = useStoreHandle();
  const snapshot = useStore((state) => state.brandingConfig) || DEFAULT_BRANDING;
  const saving = useStore((state) => state.pendingOperations.some((key) => key.startsWith("admin:branding:")));
  const [draft, setDraft] = useState(() => seed(snapshot));
  const [logoError, setLogoError] = useState("");
  const [previewMode, setPreviewMode] = useState<"light" | "dark">("light");
  useEffect(() => setDraft(seed(snapshot)), [snapshot]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(seed(snapshot));
  const validProduct = isValidBrandingName(draft.product);
  const validAgent = isValidBrandingName(draft.agent);
  const validColor = COLOR.test(draft.color);
  const valid = validProduct && validAgent && validColor;
  const upload = async (file: File) => {
    setLogoError("");
    if (dirty || saving) { setLogoError(t("admin.branding.logoSaveFirst")); return; }
    const revision = snapshot.revision;
    try {
      const payload = await brandingLogoPayload(file);
      await saveBrandingLogo(store, { expected_revision: revision, ...payload }, applyBranding);
    } catch (error) {
      setLogoError(t(error instanceof Error && error.message === "unsupported_type" ? "admin.branding.logoTypeError" : "admin.branding.logoSizeError"));
    }
  };
  const remove = async () => {
    if (dirty || saving) return;
    const revision = snapshot.revision;
    if (await confirm(t("admin.branding.logoDeleteConfirm"), { danger: true, confirmText: t("admin.branding.logoDelete") })) await deleteBrandingLogo(store, { expected_revision: revision }, applyBranding);
  };
  return <>
    {dialog}
    <Section title={t("admin.branding.title")} description={t("admin.branding.description")}>
      <FormGrid>
        <Form layout="vertical" disabled={saving} onFinish={() => { if (valid && dirty && !saving) void saveBrandingConfig(store, { expected_revision: snapshot.revision, product_name: draft.product.trim().normalize("NFC"), agent_name: draft.agent.trim().normalize("NFC"), primary_color: draft.color.toLowerCase() }, applyBranding); }}>
          <Form.Item label={t("admin.branding.productName")} validateStatus={!validProduct ? "error" : undefined} help={!validProduct ? t("admin.branding.nameError") : t("admin.branding.nameHint")}><Input aria-label={t("admin.branding.productName")} value={draft.product} onChange={(e) => setDraft({ ...draft, product: e.target.value })} /></Form.Item>
          <Form.Item label={t("admin.branding.agentName")} validateStatus={!validAgent ? "error" : undefined} help={!validAgent ? t("admin.branding.nameError") : t("admin.branding.nameHint")}><Input aria-label={t("admin.branding.agentName")} value={draft.agent} onChange={(e) => setDraft({ ...draft, agent: e.target.value })} /></Form.Item>
          <Form.Item label={t("admin.branding.primaryColor")} validateStatus={!validColor ? "error" : undefined} help={!validColor ? t("admin.branding.colorError") : t("admin.branding.colorHint")}><Input aria-label={t("admin.branding.primaryColor")} value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} /></Form.Item>
          <FormFooter>
            <Button onClick={() => setDraft(seed(DEFAULT_BRANDING))} disabled={saving}>{t("admin.branding.useDefaults")}</Button>
            <Button htmlType="submit" type="primary" loading={saving} disabled={!dirty || !valid || saving}>{t("admin.branding.save")}</Button>
          </FormFooter>
        </Form>
        <div>
          <StatusMark tone="neutral">{t("admin.branding.preview")}{dirty ? ` · ${t("admin.branding.unsaved")}` : ""}</StatusMark>
          <Segmented aria-label={t("admin.branding.preview")} value={previewMode} options={[{ value: "light", label: t("admin.branding.preview.light") }, { value: "dark", label: t("admin.branding.preview.dark") }]} onChange={(value) => setPreviewMode(value as "light" | "dark")} />
          <FieldworkProvider mode={previewMode} primaryColor={validColor ? draft.color : DEFAULT_BRANDING.primary_color}>
            <Section tone="inset"><BrandMark productName={draft.product.trim() || DEFAULT_BRANDING.product_name} logoUrl={snapshot.logo_url} /><PageHeader title={draft.agent.trim() || DEFAULT_BRANDING.agent_name} /></Section>
          </FieldworkProvider>
        </div>
      </FormGrid>
    </Section>
    <Section title={t("admin.branding.logo")} description={t("admin.branding.logoHint")}>
      <BrandMark productName={snapshot.product_name} logoUrl={snapshot.logo_url} />
      {dirty && <Notice tone="info" title={t("admin.branding.logoSaveFirst")} />}
      {logoError && <Notice tone="danger" title={logoError} />}
      <FormFooter>
        <Upload accept="image/png,image/webp" multiple={false} showUploadList={false} disabled={dirty || saving} beforeUpload={(file) => { void upload(file); return false; }}><Button disabled={dirty || saving} loading={saving}>{t(snapshot.logo_url ? "admin.branding.logoReplace" : "admin.branding.logoUpload")}</Button></Upload>
        {snapshot.logo_url && <Button danger disabled={dirty || saving} onClick={() => void remove()}>{t("admin.branding.logoDelete")}</Button>}
      </FormFooter>
    </Section>
  </>;
}
