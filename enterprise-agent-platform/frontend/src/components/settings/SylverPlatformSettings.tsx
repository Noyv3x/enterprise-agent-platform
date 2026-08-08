import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Popconfirm,
  Space,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useState } from "react";
import { toast } from "../../context/ToastContext";
import { useI18n } from "../../i18n";
import { api, isApiError } from "../../lib/api";
import { endpoints } from "../../lib/endpoints";
import type {
  SylverPlatformConnection,
  SylverPlatformConnectionResponse,
  SylverPlatformConnectionUpdateRequest,
} from "../../types";
import { formatTimestamp } from "../../utils/format";
import { Icon } from "../common/Icon";

interface ConnectionFormValues {
  token: string;
}

const DEFAULT_PLATFORM_URL = "https://devops.sylver-lining.org";
const EMPTY_FORM: ConnectionFormValues = { token: "" };

function visible(value: unknown): string {
  const text = String(value ?? "").trim();
  return text || "-";
}

export function SylverPlatformSettings() {
  const { t } = useI18n();
  const [form] = Form.useForm<ConnectionFormValues>();
  const [connection, setConnection] = useState<SylverPlatformConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [actionError, setActionError] = useState<
    "connect" | "identityConflict" | "disconnect" | ""
  >("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<SylverPlatformConnectionResponse>(
        endpoints.privateSylverPlatformConnection.path(),
      );
      setConnection(result.connection);
      form.setFieldsValue({ token: "" });
      setLoadError(false);
      setActionError("");
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (values: ConnectionFormValues) => {
    setSaving(true);
    setActionError("");
    const body: SylverPlatformConnectionUpdateRequest = {
      token: values.token,
    };
    try {
      const result = await api<SylverPlatformConnectionResponse>(
        endpoints.updatePrivateSylverPlatformConnection.path(),
        { method: "PUT", body: JSON.stringify(body) },
      );
      setConnection(result.connection);
      form.setFieldsValue({ token: "" });
      setLoadError(false);
      toast(t("sylverPlatform.saved"), { type: "ok", title: t("toast.complete") });
    } catch (error) {
      setActionError(
        isApiError(error, 409) && error.code === "sylver_platform_identity_conflict"
          ? "identityConflict"
          : "connect",
      );
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    setActionError("");
    try {
      await api<{ ok: true }>(endpoints.deletePrivateSylverPlatformConnection.path(), {
        method: "DELETE",
      });
      setConnection(null);
      form.setFieldsValue({ token: "" });
      toast(t("sylverPlatform.disconnected"), { type: "ok", title: t("toast.complete") });
    } catch {
      setActionError("disconnect");
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <Card
      className="settings-card sylver-platform-settings"
      classNames={{ body: "settings-card__body" }}
      title={<Space><Icon name="link" />{t("sylverPlatform.title")}</Space>}
      extra={connection ? (
        <Popconfirm
          title={t("sylverPlatform.disconnectConfirm")}
          description={t("sylverPlatform.disconnectConfirmDetail")}
          okText={t("sylverPlatform.disconnect")}
          cancelText={t("sylverPlatform.cancel")}
          okButtonProps={{ danger: true, loading: disconnecting }}
          onConfirm={disconnect}
        >
          <Button danger disabled={saving || disconnecting}>
            {t("sylverPlatform.disconnect")}
          </Button>
        </Popconfirm>
      ) : null}
      loading={loading && !connection}
    >
      <Typography.Paragraph type="secondary" className="sylver-platform-settings__description">
        {t("sylverPlatform.description")}
      </Typography.Paragraph>

      {loadError ? (
        <Alert
          type="error"
          showIcon
          title={t("sylverPlatform.loadFailed")}
          action={<Button size="small" onClick={() => void load()}>{t("sylverPlatform.retry")}</Button>}
        />
      ) : null}

      {connection ? (
        <section className="sylver-platform-identity" aria-label={t("sylverPlatform.identity")}>
          <div className="sylver-platform-identity__header">
            <Typography.Text strong>{t("sylverPlatform.identity")}</Typography.Text>
            <Tag color="green">{t("sylverPlatform.connected")}</Tag>
          </div>
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2, md: 2, lg: 2, xl: 2, xxl: 2 }}
          >
            <Descriptions.Item label={t("sylverPlatform.remoteName")}>
              {visible(connection.full_name)}
            </Descriptions.Item>
            <Descriptions.Item label={t("sylverPlatform.username")}>
              {visible(connection.username)}
            </Descriptions.Item>
            <Descriptions.Item label={t("sylverPlatform.remoteUserId")}>
              {visible(connection.remote_user_id)}
            </Descriptions.Item>
            <Descriptions.Item label={t("sylverPlatform.remoteTitle")}>
              {visible(connection.title)}
            </Descriptions.Item>
            <Descriptions.Item label={t("sylverPlatform.email")}>
              {visible(connection.email)}
            </Descriptions.Item>
            <Descriptions.Item label={t("sylverPlatform.role")}>
              {visible(connection.role)}
            </Descriptions.Item>
            <Descriptions.Item label={t("sylverPlatform.baseUrl")} span={2}>
              <Typography.Text className="sylver-platform-identity__url">
                {connection.base_url}
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label={t("sylverPlatform.verifiedAt")} span={2}>
              {formatTimestamp(connection.verified_at) || "-"}
            </Descriptions.Item>
          </Descriptions>
        </section>
      ) : null}

      {actionError ? (
        <Alert
          className="sylver-platform-settings__error"
          type="error"
          showIcon
          title={t(
            actionError === "connect"
              ? "sylverPlatform.connectFailed"
              : actionError === "identityConflict"
                ? "sylverPlatform.identityConflict"
                : "sylverPlatform.disconnectFailed",
          )}
        />
      ) : null}

      <Form<ConnectionFormValues>
        form={form}
        layout="vertical"
        requiredMark="optional"
        initialValues={EMPTY_FORM}
        onFinish={(values) => void save(values)}
      >
        <div className="settings-form__grid sylver-platform-settings__form">
          <Typography.Text type="secondary" className="sylver-platform-settings__fixed-url">
            {t("sylverPlatform.baseUrl")}: {DEFAULT_PLATFORM_URL}
          </Typography.Text>
          <Form.Item
            name="token"
            label={t("sylverPlatform.token")}
            extra={t("sylverPlatform.tokenHint")}
            rules={[{ required: true, message: t("sylverPlatform.required") }]}
          >
            <Input.Password maxLength={4_096} autoComplete="new-password" />
          </Form.Item>
        </div>
        <div className="form-actions">
          <Button
            type="primary"
            htmlType="submit"
            loading={saving}
            disabled={loading || disconnecting}
          >
            {t(connection ? "sylverPlatform.reconnect" : "sylverPlatform.connect")}
          </Button>
        </div>
      </Form>

      <Alert
        className="sylver-platform-settings__security"
        type="info"
        showIcon
        title={t("sylverPlatform.securityNotice")}
      />
    </Card>
  );
}
