import { Button, Field, Input, Select, Switch } from "../ui/beautiful";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "../../context/ToastContext";
import { useI18n } from "../../i18n";
import { api } from "../../lib/api";
import { endpoints } from "../../lib/endpoints";
import type { MailAccount, MailAccountMutationRequest, MailAccountPatchRequest, MailAccountResponse, MailAccountsResponse } from "../../types";
import { DataRegion, EmptyState, FormFooter, FormGrid, Notice, OverlayPanel, ResourceList, ResourceRow, Section, StatusMark } from "../ui/beautiful";
import { Dialog } from "../common/Dialog";

type MailFormValues = MailAccountMutationRequest & { password: string };
const NEW_ACCOUNT: MailFormValues = {
  label: "", email_address: "", username: "", password: "",
  imap_host: "", imap_port: 993, imap_security: "tls",
  smtp_host: "", smtp_port: 465, smtp_security: "tls",
  enabled: true, wake_enabled: false, wake_folder: "INBOX", poll_interval_seconds: 300,
};
function editValues(account: MailAccount): MailFormValues {
  return {
    label: account.label, email_address: account.email_address, username: account.username, password: "",
    imap_host: account.imap_host, imap_port: account.imap_port, imap_security: account.imap_security,
    smtp_host: account.smtp_host, smtp_port: account.smtp_port, smtp_security: account.smtp_security,
    enabled: account.enabled, wake_enabled: account.wake_enabled, wake_folder: account.wake_folder,
    poll_interval_seconds: account.poll_interval_seconds,
  };
}

export function MailAccountSettings() {
  const { t } = useI18n();
  const [draft, setDraft] = useState(NEW_ACCOUNT);
  const formId = useId();
  const field = (name: string) => `${formId}-${name}`;
  const change = <K extends keyof MailFormValues>(key: K, value: MailFormValues[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MailAccount | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionKey, setActionKey] = useState("");
  const [deleting, setDeleting] = useState<MailAccount | null>(null);
  const live = useRef(false);
  const generation = useRef(0);
  const readVersion = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const stopRead = useCallback(() => {
    ++readVersion.current; readController.current?.abort(); readController.current = null;
  }, []);
  const load = useCallback(async () => {
    stopRead();
    const version = readVersion.current;
    const controller = new AbortController(); readController.current = controller;
    setLoading(true);
    try {
      const result = await api<MailAccountsResponse>(endpoints.privateMailAccounts.path(), { signal: controller.signal });
      if (live.current && !controller.signal.aborted && version === readVersion.current) { setAccounts(result.accounts || []); setLoadError(false); }
    } catch {
      if (live.current && !controller.signal.aborted && version === readVersion.current) setLoadError(true);
    } finally {
      if (live.current && version === readVersion.current) { readController.current = null; setLoading(false); }
    }
  }, [stopRead]);
  useEffect(() => {
    live.current = true; void load();
    return () => { live.current = false; ++generation.current; stopRead(); };
  }, [load, stopRead]);
  const validOwner = (owner: number) => live.current && owner === generation.current;
  const openEditor = (account: MailAccount | null) => {
    if (mutation.current) return;
    setEditing(account); setMutationError("");
    setDraft(account ? editValues(account) : { ...NEW_ACCOUNT }); setOpen(true);
  };
  const closeEditor = () => { if (!mutation.current) { setOpen(false); setDraft({ ...NEW_ACCOUNT }); setEditing(null); setMutationError(""); } };
  const save = async (values: MailFormValues) => {
    if (mutation.current) return;
    mutation.current = true; const owner = generation.current;
    setSaving(true); setMutationError(""); stopRead(); setLoading(false);
    try {
      let result: MailAccountResponse;
      if (editing) {
        const body: MailAccountPatchRequest = { ...values };
        if (!values.password) delete body.password;
        result = await api<MailAccountResponse>(endpoints.updatePrivateMailAccount.path(editing.id), { method: "PATCH", body: JSON.stringify(body) });
      } else {
        result = await api<MailAccountResponse>(endpoints.createPrivateMailAccount.path(), { method: "POST", body: JSON.stringify(values) });
      }
      if (!validOwner(owner)) return;
      setAccounts((current) => current.some((item) => item.id === result.account.id) ? current.map((item) => item.id === result.account.id ? result.account : item) : [...current, result.account]);
      setOpen(false); setEditing(null); setDraft({ ...NEW_ACCOUNT });
      toast(t("mail.saved"), { type: "ok", title: t("toast.complete") });
    } catch {
      if (validOwner(owner)) { setMutationError(t("mail.saveFailed")); toast(t("mail.saveFailed"), { type: "error" }); }
    } finally { if (validOwner(owner)) { mutation.current = false; setSaving(false); } }
  };
  const runAction = async (account: MailAccount, action: "test" | "check") => {
    if (mutation.current) return;
    mutation.current = true; const owner = generation.current;
    setActionKey(`${action}:${account.id}`); setMutationError("");
    let succeeded = false;
    try {
      const path = action === "test" ? endpoints.testPrivateMailAccount.path(account.id) : endpoints.checkPrivateMailAccount.path(account.id);
      await api(path, { method: "POST", body: "{}" }); succeeded = true;
    } catch { /* Always refresh authoritative last_error after a probe. */ }
    if (!validOwner(owner)) return;
    await load();
    if (!validOwner(owner)) return;
    const message = t(action === "test" ? succeeded ? "mail.testSuccess" : "mail.testFailed" : succeeded ? "mail.checkSuccess" : "mail.checkFailed");
    if (!succeeded) setMutationError(message);
    toast(message, { type: succeeded ? "ok" : "error" });
    mutation.current = false; setActionKey("");
  };
  const remove = async (account: MailAccount) => {
    if (mutation.current) return;
    mutation.current = true; const owner = generation.current;
    setActionKey(`delete:${account.id}`); setMutationError(""); stopRead(); setLoading(false);
    try {
      await api(endpoints.deletePrivateMailAccount.path(account.id), { method: "DELETE" });
      if (!validOwner(owner)) return;
      setAccounts((current) => current.filter((item) => item.id !== account.id)); setDeleting(null);
      toast(t("mail.deleted"), { type: "ok" });
    } catch { if (validOwner(owner)) setMutationError(t("mail.deleteFailed")); }
    finally { if (validOwner(owner)) { mutation.current = false; setActionKey(""); } }
  };
  const busy = saving || !!actionKey;
  const securityOptions = [{ value: "tls", label: t("mail.security.tls") }, { value: "starttls", label: t("mail.security.starttls") }];
  return <Section title={t("mail.title")} description={t("mail.description")} actions={<Button variant="primary" disabled={busy || loading} onClick={() => openEditor(null)}>{t("mail.add")}</Button>}>
    {mutationError && !open ? <Notice tone="danger" title={mutationError} /> : null}
    <DataRegion state={accounts.length ? "ready" : loading ? "loading" : loadError ? "error" : "empty"} loadingLabel={t("common.loading")} refreshing={loading && !!accounts.length} error={loadError ? t("mail.loadFailed") : undefined} retry={<Button disabled={busy || loading} onClick={() => void load()}>{t("mail.retry")}</Button>} empty={<EmptyState title={t("mail.empty")} description={t("mail.emptyDetail")} />}>
      <ResourceList label={t("mail.title")}>
        {accounts.map((account) => <ResourceRow key={account.id} title={account.label} description={account.email_address}
          status={<StatusMark tone={account.enabled ? "success" : "neutral"}>{t(account.enabled ? "mail.enabled" : "mail.disabled")}</StatusMark>}
          meta={t(account.wake_enabled ? "mail.wakeOn" : "mail.wakeOff")}
          actions={<div className="bui-actions">
            <Button disabled={busy || loading} onClick={() => openEditor(account)}>{t("mail.edit")}</Button>
            <Button disabled={busy || loading} loading={actionKey === `test:${account.id}`} onClick={() => void runAction(account, "test")}>{t("mail.test")}</Button>
            <Button disabled={busy || loading} loading={actionKey === `check:${account.id}`} onClick={() => void runAction(account, "check")}>{t("mail.check")}</Button>
            <Button variant="danger" disabled={busy || loading} onClick={() => setDeleting(account)}>{t("mail.delete")}</Button>
          </div>}>
          {account.last_error ? <Notice tone="warning" title={t("mail.lastError", { error: account.last_error })} /> : null}
        </ResourceRow>)}
      </ResourceList>
    </DataRegion>
    <OverlayPanel open={open} onClose={closeEditor} title={t(editing ? "mail.editTitle" : "mail.addTitle")} closeLabel={t("mail.cancel")}>
      <form id={formId} onSubmit={(event) => { event.preventDefault(); if (event.currentTarget.reportValidity()) void save(draft); }}>
        <fieldset disabled={saving}>
          <Section title={t("account.identitySummary")}>
            <FormGrid>
              <Field htmlFor={field("label")} label={t("mail.label")}><Input id={field("label")} required pattern={".*\\S.*"} maxLength={120} value={draft.label} onChange={(event) => change("label", event.target.value)} /></Field>
              <Field htmlFor={field("email_address")} label={t("mail.address")}><Input id={field("email_address")} type="email" required maxLength={320} autoComplete="email" value={draft.email_address} onChange={(event) => change("email_address", event.target.value)} /></Field>
              <Field htmlFor={field("username")} label={t("mail.username")}><Input id={field("username")} required pattern={".*\\S.*"} maxLength={320} autoComplete="username" value={draft.username} onChange={(event) => change("username", event.target.value)} /></Field>
              <Field htmlFor={field("password")} label={t("mail.password")} hint={t(editing?.credential_configured ? "mail.passwordConfigured" : "mail.passwordHint")}><Input id={field("password")} type="password" required={!editing} maxLength={4096} autoComplete="new-password" value={draft.password} onChange={(event) => change("password", event.target.value)} /></Field>
            </FormGrid>
          </Section>
          {(["imap", "smtp"] as const).map((protocol) => <Section key={protocol} title={t(protocol === "imap" ? "mail.imap" : "mail.smtp")}>
            <FormGrid>
              <Field htmlFor={field(`${protocol}_host`)} label={t("mail.host")}><Input id={field(`${protocol}_host`)} required pattern={".*\\S.*"} maxLength={253} value={draft[`${protocol}_host`]} onChange={(event) => change(`${protocol}_host`, event.target.value)} /></Field>
              <Field htmlFor={field(`${protocol}_port`)} label={t("mail.port")}><Input id={field(`${protocol}_port`)} type="number" required min={1} max={65535} step={1} value={draft[`${protocol}_port`] || ""} onChange={(event) => change(`${protocol}_port`, Number(event.target.value))} /></Field>
              <Field htmlFor={field(`${protocol}_security`)} label={t("mail.security")}><Select id={field(`${protocol}_security`)} options={securityOptions} value={draft[`${protocol}_security`]} disabled={saving} onChange={(value) => { if (value === "tls" || value === "starttls") change(`${protocol}_security`, value); }} /></Field>
            </FormGrid>
          </Section>)}
          <Section title={t("mail.wakeEnabled")}>
            <FormGrid>
              <Field htmlFor={field("enabled")} label={t("mail.enabled")}><Switch id={field("enabled")} checked={draft.enabled} onChange={(value) => change("enabled", value)} /></Field>
              <Field htmlFor={field("wake_enabled")} label={t("mail.wakeEnabled")}><Switch id={field("wake_enabled")} checked={draft.wake_enabled} onChange={(value) => change("wake_enabled", value)} /></Field>
              <Field htmlFor={field("wake_folder")} label={t("mail.wakeFolder")}><Input id={field("wake_folder")} required pattern={".*\\S.*"} maxLength={512} value={draft.wake_folder} onChange={(event) => change("wake_folder", event.target.value)} /></Field>
              <Field htmlFor={field("poll_interval_seconds")} label={`${t("mail.pollInterval")} (${t("mail.seconds")})`}><Input id={field("poll_interval_seconds")} type="number" required min={60} max={3600} step={1} value={draft.poll_interval_seconds || ""} onChange={(event) => change("poll_interval_seconds", Number(event.target.value))} /></Field>
            </FormGrid>
          </Section>
          <Notice tone="info" title={t("mail.securityNotice")} />
          {mutationError ? <Notice tone="danger" title={mutationError} /> : null}
          <FormFooter><Button disabled={saving} onClick={closeEditor}>{t("mail.cancel")}</Button><Button variant="primary" type="submit" loading={saving}>{t("mail.save")}</Button></FormFooter>
        </fieldset>
      </form>
    </OverlayPanel>
    <Dialog open={!!deleting} title={t("mail.deleteConfirm")} onClose={() => { if (!busy) setDeleting(null); }} closeOnBackdrop={!busy} showCloseButton={!busy}
      footer={<FormFooter><Button disabled={busy} onClick={() => setDeleting(null)}>{t("mail.cancel")}</Button><Button variant="danger" loading={!!actionKey} disabled={busy} onClick={() => { if (deleting) void remove(deleting); }}>{t("mail.delete")}</Button></FormFooter>}>
      <p>{deleting?.label} · {deleting?.email_address}</p><p>{t("mail.deleteConfirmDetail")}</p>
      {mutationError && <Notice tone="danger" title={mutationError} />}
    </Dialog>
  </Section>;
}
