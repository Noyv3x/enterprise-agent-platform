import {
  Alert,
  Avatar,
  Button,
  Descriptions,
  Form,
  Input,
  Popconfirm,
  Spin,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "../../../context/ToastContext";
import { useI18n } from "../../../i18n";
import { api, isApiError } from "../../../lib/api";
import { endpoints } from "../../../lib/endpoints";
import type {
  AdminSylverPlatformConnectionUpdateRequest,
  SylverPlatformConnection,
  SylverPlatformConnectionResponse,
  SylverPlatformConnectionUpdateRequest,
  SylverPlatformIdentityPreview,
  SylverPlatformIdentityPreviewResponse,
  User,
} from "../../../types";
import { formatTimestamp, initials } from "../../../utils/format";
import { Drawer } from "../../common/Drawer";

interface SylverPlatformAccountDrawerProps {
  user: User;
  open: boolean;
  onClose: () => void;
}

type ActionError =
  | ""
  | "verify"
  | "save"
  | "identityChanged"
  | "identityConflict"
  | "disconnect";

const DEFAULT_PLATFORM_URL = "https://devops.sylver-lining.org";

function visible(value: unknown): string {
  const text = String(value ?? "").trim();
  return text || "-";
}

function identityProjection(identity: SylverPlatformIdentityPreview): SylverPlatformIdentityPreview {
  return {
    // The connector has one product-owned provider origin. Never let a remote
    // response turn it into a configurable or navigable endpoint in the UI.
    base_url: DEFAULT_PLATFORM_URL,
    remote_user_id: identity.remote_user_id,
    username: identity.username,
    full_name: identity.full_name,
    title: identity.title,
    email: identity.email,
    role: identity.role,
  };
}

function connectionProjection(
  connection: SylverPlatformConnection | null,
): SylverPlatformConnection | null {
  if (!connection) return null;
  return {
    ...identityProjection(connection),
    credential_configured: connection.credential_configured,
    verified_at: connection.verified_at,
    updated_at: connection.updated_at,
  };
}

function RemoteIdentity({
  identity,
  verifiedAt,
}: {
  identity: SylverPlatformIdentityPreview;
  verifiedAt?: number | string;
}) {
  const { t } = useI18n();
  return (
    <Descriptions
      className="eap-admin-sylver-identity"
      size="small"
      column={{ xs: 1, sm: 2, md: 2, lg: 2, xl: 2, xxl: 2 }}
    >
      <Descriptions.Item label={t("sylverPlatform.remoteName")}>
        {visible(identity.full_name)}
      </Descriptions.Item>
      <Descriptions.Item label={t("sylverPlatform.username")}>
        {visible(identity.username)}
      </Descriptions.Item>
      <Descriptions.Item label={t("sylverPlatform.remoteUserId")}>
        {visible(identity.remote_user_id)}
      </Descriptions.Item>
      <Descriptions.Item label={t("sylverPlatform.remoteTitle")}>
        {visible(identity.title)}
      </Descriptions.Item>
      <Descriptions.Item label={t("sylverPlatform.email")}>
        {visible(identity.email)}
      </Descriptions.Item>
      <Descriptions.Item label={t("sylverPlatform.role")}>
        {visible(identity.role)}
      </Descriptions.Item>
      <Descriptions.Item label={t("sylverPlatform.baseUrl")} span={2}>
        <Typography.Text className="eap-admin-sylver-identity__url">
          {visible(identity.base_url)}
        </Typography.Text>
      </Descriptions.Item>
      {verifiedAt !== undefined ? (
        <Descriptions.Item label={t("sylverPlatform.verifiedAt")} span={2}>
          {formatTimestamp(verifiedAt) || "-"}
        </Descriptions.Item>
      ) : null}
    </Descriptions>
  );
}

function LocalAccount({ user }: { user: User }) {
  const { t } = useI18n();
  return (
    <section className="eap-admin-sylver-local" aria-label={t("admin.accounts.sylver.localAccount")}>
      <Typography.Text className="eap-admin-sylver-section-label" type="secondary">
        {t("admin.accounts.sylver.localAccount")}
      </Typography.Text>
      <div className="eap-admin-sylver-local__identity">
        <Avatar size={40}>{initials(user.display_name || user.username)}</Avatar>
        <div>
          <Typography.Text strong>{user.display_name || user.username}</Typography.Text>
          <Typography.Text type="secondary">
            @{user.username}{user.position ? ` · ${user.position}` : ""}
          </Typography.Text>
        </div>
        <Tag color={user.active ? "green" : "default"}>
          {t(user.active ? "admin.common.active" : "admin.common.disabled")}
        </Tag>
      </div>
    </section>
  );
}

export function SylverPlatformAccountDrawer({
  user,
  open,
  onClose,
}: SylverPlatformAccountDrawerProps) {
  const { t } = useI18n();
  const inputId = useId();
  const loadGeneration = useRef(0);
  const [connection, setConnection] = useState<SylverPlatformConnection | null>(null);
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<SylverPlatformIdentityPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [actionError, setActionError] = useState<ActionError>("");
  const candidateBusy = verifying || saving || disconnecting;

  const resetCandidate = useCallback(() => {
    setToken("");
    setPreview(null);
    setActionError("");
  }, []);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(false);
    try {
      const result = await api<SylverPlatformConnectionResponse>(
        endpoints.adminSylverPlatformConnection.path(user.id),
      );
      if (generation !== loadGeneration.current) return;
      setConnection(connectionProjection(result.connection));
      resetCandidate();
    } catch {
      if (generation !== loadGeneration.current) return;
      setLoadError(true);
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [resetCandidate, user.id]);

  useEffect(() => {
    if (open) void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, [load, open]);

  const requestClose = () => {
    if (candidateBusy) return;
    loadGeneration.current += 1;
    resetCandidate();
    onClose();
  };

  const handleTokenChange = (value: string) => {
    setToken(value);
    setPreview(null);
    setActionError("");
  };

  const verify = async () => {
    if (!token.trim()) return;
    setVerifying(true);
    setActionError("");
    setPreview(null);
    const body: SylverPlatformConnectionUpdateRequest = { token };
    try {
      const result = await api<SylverPlatformIdentityPreviewResponse>(
        endpoints.verifyAdminSylverPlatformConnection.path(user.id),
        { method: "POST", body: JSON.stringify(body) },
      );
      setPreview(identityProjection(result.identity));
    } catch {
      setActionError("verify");
    } finally {
      setVerifying(false);
    }
  };

  const save = async () => {
    if (!preview || !token.trim()) return;
    setSaving(true);
    setActionError("");
    const body: AdminSylverPlatformConnectionUpdateRequest = {
      token,
      expected_remote_user_id: preview.remote_user_id,
    };
    try {
      const result = await api<SylverPlatformConnectionResponse>(
        endpoints.updateAdminSylverPlatformConnection.path(user.id),
        { method: "PUT", body: JSON.stringify(body) },
      );
      setConnection(connectionProjection(result.connection));
      resetCandidate();
      toast(t("sylverPlatform.saved"), { type: "ok", title: t("toast.complete") });
    } catch (error) {
      if (isApiError(error, 409) && error.code === "sylver_platform_identity_changed") {
        setPreview(null);
        setActionError("identityChanged");
      } else if (isApiError(error, 409) && error.code === "sylver_platform_identity_conflict") {
        setActionError("identityConflict");
      } else {
        setActionError("save");
      }
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    setActionError("");
    try {
      await api<{ ok: true }>(endpoints.deleteAdminSylverPlatformConnection.path(user.id), {
        method: "DELETE",
      });
      setConnection(null);
      resetCandidate();
      toast(t("sylverPlatform.disconnected"), { type: "ok", title: t("toast.complete") });
    } catch {
      setActionError("disconnect");
    } finally {
      setDisconnecting(false);
    }
  };

  const errorKey = actionError === "verify"
    ? "admin.accounts.sylver.verifyFailed"
    : actionError === "identityChanged"
      ? "admin.accounts.sylver.identityChanged"
      : actionError === "identityConflict"
        ? "admin.accounts.sylver.identityConflict"
        : actionError === "disconnect"
          ? "sylverPlatform.disconnectFailed"
          : actionError === "save"
            ? "admin.accounts.sylver.saveFailed"
            : null;
  const permissionKnownMissing = Array.isArray(user.permissions)
    && !user.permissions.includes("private_agent");
  return (
    <Drawer
      open={open}
      onClose={requestClose}
      closeOnBackdrop={!candidateBusy}
      showCloseButton={!candidateBusy}
      title={t("admin.accounts.sylver.title", { username: user.username })}
      description={t("admin.accounts.sylver.description")}
      className="account-drawer eap-admin-sylver-drawer"
    >
      <Spin spinning={loading}>
        {loadError ? (
          <Alert
            type="error"
            showIcon
            title={t("sylverPlatform.loadFailed")}
            action={<Button size="small" onClick={() => void load()}>{t("sylverPlatform.retry")}</Button>}
          />
        ) : null}

        {!loading && !loadError ? (
          <div className="eap-admin-sylver-content">
            {!preview ? <LocalAccount user={user} /> : null}

            {!user.active || permissionKnownMissing ? (
              <Alert type="warning" showIcon title={t("admin.accounts.sylver.preconfigureHint")} />
            ) : null}

            <section className="eap-admin-sylver-current" aria-label={t("admin.accounts.sylver.currentIdentity")}>
              <div className="eap-admin-sylver-section-heading">
                <Typography.Text strong>{t("admin.accounts.sylver.currentIdentity")}</Typography.Text>
                {connection ? <Tag color="green">{t("sylverPlatform.connected")}</Tag> : null}
              </div>
              {connection ? (
                <RemoteIdentity identity={connection} verifiedAt={connection.verified_at} />
              ) : (
                <Typography.Text type="secondary">{t("admin.accounts.sylver.notConnected")}</Typography.Text>
              )}
              {connection ? (
                <Popconfirm
                  title={t("admin.accounts.sylver.disconnectConfirm", { username: user.username })}
                  description={t("sylverPlatform.disconnectConfirmDetail")}
                  okText={t("sylverPlatform.disconnect")}
                  cancelText={t("sylverPlatform.cancel")}
                  okButtonProps={{ danger: true, loading: disconnecting }}
                  onConfirm={disconnect}
                >
                  <Button danger disabled={candidateBusy}>{t("sylverPlatform.disconnect")}</Button>
                </Popconfirm>
              ) : null}
            </section>

            {errorKey ? <Alert type="error" showIcon title={t(errorKey)} /> : null}

            <Form layout="vertical" requiredMark={false} onFinish={() => void verify()}>
              <Typography.Paragraph type="secondary" className="eap-admin-sylver-token-description">
                {t("admin.accounts.sylver.tokenDescription")}
              </Typography.Paragraph>
              <Typography.Paragraph type="secondary">
                {t("sylverPlatform.baseUrl")}: <Typography.Text code>{DEFAULT_PLATFORM_URL}</Typography.Text>
              </Typography.Paragraph>
              <Form.Item
                label={t("sylverPlatform.token")}
                htmlFor={inputId}
                extra={t("sylverPlatform.tokenHint")}
              >
                <Input.Password
                  id={inputId}
                  maxLength={4_096}
                  autoComplete="new-password"
                  value={token}
                  disabled={candidateBusy}
                  onChange={(event) => handleTokenChange(event.target.value)}
                />
              </Form.Item>
              <Button
                htmlType="submit"
                loading={verifying}
                disabled={!token.trim() || saving || disconnecting}
              >
                {t("admin.accounts.sylver.verify")}
              </Button>
            </Form>

            {preview ? (
              <section className="eap-admin-sylver-preview" aria-label={t("admin.accounts.sylver.previewTitle")}>
                <Alert
                  type="info"
                  showIcon
                  title={t("admin.accounts.sylver.previewTitle")}
                  description={t("admin.accounts.sylver.previewDescription")}
                />
                <div className="eap-admin-sylver-comparison">
                  <LocalAccount user={user} />
                  <section className="eap-admin-sylver-remote">
                    <Typography.Text className="eap-admin-sylver-section-label" type="secondary">
                      {t("admin.accounts.sylver.previewTitle")}
                    </Typography.Text>
                    <RemoteIdentity identity={preview} />
                  </section>
                </div>
                <Button type="primary" loading={saving} disabled={verifying || disconnecting} onClick={() => void save()}>
                  {t("admin.accounts.sylver.confirm")}
                </Button>
              </section>
            ) : null}
          </div>
        ) : null}
      </Spin>
    </Drawer>
  );
}
