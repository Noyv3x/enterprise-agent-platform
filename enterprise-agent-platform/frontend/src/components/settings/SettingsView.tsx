import { Button, Input, Field } from "../ui/beautiful";
import { useEffect, useId, useMemo, useState } from "react";
import { browserTimezone, changePassword, updateCurrentUser } from "../../data/accountActions";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { EmptyState, FormFooter, FormGrid, Notice, PageHeader, PageLayout, Section, SectionIndex } from "../ui/beautiful";
import { BrowserNotificationSettings } from "./BrowserNotificationSettings";
import { MailAccountSettings } from "./MailAccountSettings";
import "./settings.css";

function timezoneOptions(current: string): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  let values: string[] = [];
  try { values = intl.supportedValuesOf?.("timeZone") || []; } catch { /* Free entry remains available. */ }
  return [...new Set([current, "UTC", ...values].filter(Boolean))];
}

export function SettingsView() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const user = useStore((state) => state.user);
  const pending = useStore((state) => state.pendingOperations);
  const [displayName, setDisplayName] = useState("");
  const [position, setPosition] = useState("");
  const [timezone, setTimezone] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordError, setPasswordError] = useState<"mismatch" | "short" | "">("");
  const [activeSection, setActiveSection] = useState("profile");
  const id = useId();
  const zones = useMemo(() => timezoneOptions(timezone).map((value) => ({ value })), [timezone]);
  useEffect(() => {
    setDisplayName(user?.display_name || user?.username || "");
    setPosition(user?.position || "");
  }, [user?.id, user?.display_name, user?.username, user?.position]);
  useEffect(() => { setTimezone(user?.timezone || browserTimezone() || "UTC"); }, [user?.id, user?.timezone]);
  useEffect(() => {
    setCurrentPassword(""); setNewPassword(""); setConfirmation(""); setPasswordError("");
  }, [user?.id]);

  if (!user) return <EmptyState title={t("session.loginRequired")} description={t("account.loginRequiredDetail")} />;
  const profilePending = pending.includes("account:profile");
  const passwordPending = pending.includes("account:password");
  const profileDirty = displayName !== (user.display_name || user.username || "") || position !== (user.position || "") || timezone !== (user.timezone || "");
  const submitPassword = () => {
    if (newPassword !== confirmation) { setPasswordError("mismatch"); return; }
    if (newPassword.length < 8) { setPasswordError("short"); return; }
    setPasswordError("");
    const owner = String(user.id);
    void changePassword(store, { current_password: currentPassword, new_password: newPassword }, () => {
      if (String(store.getState().user?.id) !== owner) return;
      setCurrentPassword(""); setNewPassword(""); setConfirmation("");
    });
  };
  const items = [
    { key: "profile", label: t("account.profile") },
    { key: "password", label: t("account.changePassword") },
    { key: "notifications", label: t("notifications.settings.title") },
    { key: "mail", label: t("mail.title") },
  ];
  return <PageLayout
    header={<PageHeader title={t("nav.settings")} description={t("account.settingsDescription")} meta={<span>{user.display_name || user.username} · @{user.username}{user.position?.trim() ? ` · ${user.position.trim()}` : ""}</span>} />}
    navigation={<SectionIndex label={t("nav.settings")} groups={[{ key: "settings", label: null, items }]} activeKey={activeSection} onSelect={(key) => { setActiveSection(key); document.getElementById(`${id}-${key}`)?.scrollIntoView({ block: "start" }); }} />}
  >
    <div className="settings-sections">
      <Section id={`${id}-profile`} title={t("account.profile")}>
        <form onSubmit={(event) => { event.preventDefault(); if (!profilePending && profileDirty && timezone.trim()) void updateCurrentUser(store, { display_name: displayName, position, timezone: timezone.trim() }); }}><fieldset disabled={profilePending}><FormGrid>
          <Field label={t("account.displayName")} htmlFor={`${id}-name`}><Input id={`${id}-name`} value={displayName} autoComplete="name" onChange={(event) => setDisplayName(event.target.value)} /></Field>
          <Field label={t("account.position")} htmlFor={`${id}-position`}><Input id={`${id}-position`} value={position} maxLength={80} onChange={(event) => setPosition(event.target.value)} /></Field>
          <Field label={t("account.timezone")} htmlFor={`${id}-zone`} hint={t("account.timezoneHint")}><Input id={`${id}-zone`} value={timezone} list={`${id}-zones`} onChange={(event) => setTimezone(event.target.value)} /><datalist id={`${id}-zones`}>{zones.map(({ value }) => <option key={value} value={value} />)}</datalist></Field>
        </FormGrid>
        <FormFooter><Button variant="primary" type="submit" loading={profilePending} disabled={!profileDirty || !timezone.trim()}>{t("account.saveProfile")}</Button></FormFooter></fieldset></form>
      </Section>
      <Section id={`${id}-password`} title={t("account.changePassword")}>
        <form onSubmit={(event) => { event.preventDefault(); if (!passwordPending) submitPassword(); }}><fieldset disabled={passwordPending}><FormGrid>
          <Field label={t("account.currentPassword")} htmlFor={`${id}-current`}><Input type="password" id={`${id}-current`} autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></Field>
          <Field label={t("account.newPassword")} htmlFor={`${id}-new`}><Input type="password" id={`${id}-new`} autoComplete="new-password" value={newPassword} onChange={(event) => { setNewPassword(event.target.value); setPasswordError(""); }} /></Field>
          <Field label={t("account.confirmPassword")} htmlFor={`${id}-confirmation`}><Input type="password" id={`${id}-confirmation`} autoComplete="new-password" value={confirmation} onChange={(event) => { setConfirmation(event.target.value); setPasswordError(""); }} /></Field>
        </FormGrid>
        {passwordError ? <Notice tone="danger" title={passwordError === "mismatch" ? t("account.passwordMismatch") : t("account.passwordMinLength", { count: 8 })} /> : null}
        <FormFooter><Button  type="submit" loading={passwordPending} disabled={!(currentPassword || newPassword || confirmation)}>{t("account.updatePassword")}</Button></FormFooter></fieldset></form>
      </Section>
      <div id={`${id}-notifications`}><BrowserNotificationSettings key={String(user.id)} userId={user.id} /></div>
      <div id={`${id}-mail`}><MailAccountSettings key={String(user.id)} /></div>
    </div>
  </PageLayout>;
}
