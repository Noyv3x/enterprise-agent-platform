import { Button, Input, SegmentedControl, Field } from "../../ui/beautiful";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_BRANDING, isValidBrandingName, useBranding } from "../../../context/BrandingContext";
import { deleteBrandingLogo, saveBrandingConfig, saveBrandingLogo } from "../../../data/adminActions";
import { useConfirm } from "../../../hooks/useConfirm";
import { useI18n } from "../../../i18n";
import { useStore, useStoreHandle } from "../../../store/useStore";
import type { BrandingSnapshot } from "../../../types";
import { BrandMark, BeautifulRoot, FormFooter, FormGrid, Notice, PageHeader, Section, StatusMark } from "../../ui/beautiful";

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
  const fileInput = useRef<HTMLInputElement>(null);
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
        <form onSubmit={(event) => { event.preventDefault(); if (valid && dirty && !saving) void saveBrandingConfig(store, { expected_revision: snapshot.revision, product_name: draft.product.trim().normalize("NFC"), agent_name: draft.agent.trim().normalize("NFC"), primary_color: draft.color.toLowerCase() }, applyBranding); }}><fieldset disabled={saving}>
        <Field label={t("admin.branding.productName")} error={!validProduct ? t("admin.branding.nameError") : undefined} hint={t("admin.branding.nameHint")}><Input aria-label={t("admin.branding.productName")} invalid={!validProduct} value={draft.product} onChange={(e) => setDraft({ ...draft, product: e.target.value })} /></Field>
        <Field label={t("admin.branding.agentName")} error={!validAgent ? t("admin.branding.nameError") : undefined} hint={t("admin.branding.nameHint")}><Input aria-label={t("admin.branding.agentName")} invalid={!validAgent} value={draft.agent} onChange={(e) => setDraft({ ...draft, agent: e.target.value })} /></Field>
        <Field label={t("admin.branding.primaryColor")} error={!validColor ? t("admin.branding.colorError") : undefined} hint={t("admin.branding.colorHint")}><Input aria-label={t("admin.branding.primaryColor")} invalid={!validColor} value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} /></Field>
        <FormFooter>
          <Button onClick={() => setDraft(seed(DEFAULT_BRANDING))} disabled={saving}>{t("admin.branding.useDefaults")}</Button>
          <Button  type="submit" variant="primary" loading={saving} disabled={!dirty || !valid || saving}>{t("admin.branding.save")}</Button>
        </FormFooter></fieldset></form>
        <div>
          <StatusMark tone="neutral">{t("admin.branding.preview")}{dirty ? ` · ${t("admin.branding.unsaved")}` : ""}</StatusMark>
          <SegmentedControl aria-label={t("admin.branding.preview")} value={previewMode} options={[{ value: "light", label: t("admin.branding.preview.light") }, { value: "dark", label: t("admin.branding.preview.dark") }]} onChange={(value) => setPreviewMode(value as "light" | "dark")} />
          <BeautifulRoot mode={previewMode} primaryColor={validColor ? draft.color : DEFAULT_BRANDING.primary_color}>
            <Section tone="inset"><BrandMark productName={draft.product.trim() || DEFAULT_BRANDING.product_name} logoUrl={snapshot.logo_url} /><PageHeader title={draft.agent.trim() || DEFAULT_BRANDING.agent_name} /></Section>
          </BeautifulRoot>
        </div>
      </FormGrid>
    </Section>
    <Section title={t("admin.branding.logo")} description={t("admin.branding.logoHint")}>
      <BrandMark productName={snapshot.product_name} logoUrl={snapshot.logo_url} />
      {dirty && <Notice tone="info" title={t("admin.branding.logoSaveFirst")} />}
      {logoError && <Notice tone="danger" title={logoError} />}
      <FormFooter>
        <input ref={fileInput} type="file" accept="image/png,image/webp" hidden disabled={dirty || saving} aria-label={t("admin.branding.logoUpload")} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
        <Button disabled={dirty || saving} loading={saving} onClick={() => fileInput.current?.click()}>{t(snapshot.logo_url ? "admin.branding.logoReplace" : "admin.branding.logoUpload")}</Button>
        {snapshot.logo_url && <Button  variant="danger" disabled={dirty || saving} onClick={() => void remove()}>{t("admin.branding.logoDelete")}</Button>}
      </FormFooter>
    </Section>
  </>;
}
