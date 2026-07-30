import {
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useState } from "react";
import { toast } from "../../context/ToastContext";
import { useI18n } from "../../i18n";
import { api } from "../../lib/api";
import { endpoints } from "../../lib/endpoints";
import type {
  MailAccount,
  MailAccountMutationRequest,
  MailAccountPatchRequest,
  MailAccountResponse,
  MailAccountsResponse,
} from "../../types";
import { Icon } from "../common/Icon";

type MailFormValues = MailAccountMutationRequest & { password: string };

const NEW_ACCOUNT: MailFormValues = {
  label: "",
  email_address: "",
  username: "",
  password: "",
  imap_host: "",
  imap_port: 993,
  imap_security: "tls",
  smtp_host: "",
  smtp_port: 465,
  smtp_security: "tls",
  enabled: true,
  wake_enabled: false,
  wake_folder: "INBOX",
  poll_interval_seconds: 300,
};

function editValues(account: MailAccount): MailFormValues {
  return {
    label: account.label,
    email_address: account.email_address,
    username: account.username,
    password: "",
    imap_host: account.imap_host,
    imap_port: account.imap_port,
    imap_security: account.imap_security,
    smtp_host: account.smtp_host,
    smtp_port: account.smtp_port,
    smtp_security: account.smtp_security,
    enabled: account.enabled,
    wake_enabled: account.wake_enabled,
    wake_folder: account.wake_folder,
    poll_interval_seconds: account.poll_interval_seconds,
  };
}

export function MailAccountSettings() {
  const { t } = useI18n();
  const [form] = Form.useForm<MailFormValues>();
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<MailAccount | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeAction, setActiveAction] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<MailAccountsResponse>(endpoints.privateMailAccounts.path());
      setAccounts(result.accounts || []);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({ ...NEW_ACCOUNT });
    setDrawerOpen(true);
  };

  const openEdit = (account: MailAccount) => {
    setEditing(account);
    form.setFieldsValue(editValues(account));
    setDrawerOpen(true);
  };

  const save = async (values: MailFormValues) => {
    setSaving(true);
    try {
      let result: MailAccountResponse;
      if (editing) {
        const body: MailAccountPatchRequest = { ...values };
        if (!values.password) delete body.password;
        result = await api<MailAccountResponse>(
          endpoints.updatePrivateMailAccount.path(editing.id),
          { method: "PATCH", body: JSON.stringify(body) },
        );
        setAccounts((current) => current.map((item) => (
          item.id === result.account.id ? result.account : item
        )));
      } else {
        result = await api<MailAccountResponse>(endpoints.createPrivateMailAccount.path(), {
          method: "POST",
          body: JSON.stringify(values),
        });
        setAccounts((current) => [...current, result.account]);
      }
      setDrawerOpen(false);
      form.resetFields();
      toast(t("mail.saved"), { type: "ok", title: t("toast.complete") });
    } catch {
      toast(t("mail.saveFailed"), { type: "error", title: t("toast.operationFailed") });
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (account: MailAccount, action: "test" | "check") => {
    const actionKey = `${action}:${account.id}`;
    setActiveAction(actionKey);
    try {
      const path = action === "test"
        ? endpoints.testPrivateMailAccount.path(account.id)
        : endpoints.checkPrivateMailAccount.path(account.id);
      await api(path, { method: "POST", body: "{}" });
      await load();
      toast(t(action === "test" ? "mail.testSuccess" : "mail.checkSuccess"), {
        type: "ok",
        title: t("toast.complete"),
      });
    } catch {
      await load();
      toast(t(action === "test" ? "mail.testFailed" : "mail.checkFailed"), {
        type: "error",
        title: t("toast.operationFailed"),
      });
    } finally {
      setActiveAction("");
    }
  };

  const remove = async (account: MailAccount) => {
    const actionKey = `delete:${account.id}`;
    setActiveAction(actionKey);
    try {
      await api(endpoints.deletePrivateMailAccount.path(account.id), {
        method: "DELETE",
      });
      setAccounts((current) => current.filter((item) => item.id !== account.id));
      toast(t("mail.deleted"), { type: "ok", title: t("toast.complete") });
    } catch {
      toast(t("mail.deleteFailed"), { type: "error", title: t("toast.operationFailed") });
    } finally {
      setActiveAction("");
    }
  };

  return (
    <>
      <Card
        className="settings-card mail-settings"
        classNames={{ body: "settings-card__body" }}
        title={<Space><Icon name="message" />{t("mail.title")}</Space>}
        extra={<Button type="primary" onClick={openCreate}>{t("mail.add")}</Button>}
        loading={loading && accounts.length === 0}
      >
        <Typography.Paragraph type="secondary" className="mail-settings__description">
          {t("mail.description")}
        </Typography.Paragraph>
        {loadError ? (
          <Alert
            type="error"
            showIcon
            title={t("mail.loadFailed")}
            action={<Button size="small" onClick={() => void load()}>{t("mail.retry")}</Button>}
          />
        ) : null}
        {!loading && !loadError && accounts.length === 0 ? (
          <div className="mail-settings__empty">
            <Typography.Text strong>{t("mail.empty")}</Typography.Text>
            <Typography.Text type="secondary">{t("mail.emptyDetail")}</Typography.Text>
          </div>
        ) : null}
        <div className="mail-account-list">
          {accounts.map((account) => (
            <div className="mail-account" key={account.id}>
              <div className="mail-account__identity">
                <Space wrap size={[6, 6]}>
                  <Typography.Text strong>{account.label}</Typography.Text>
                  <Tag color={account.enabled ? "green" : "default"}>
                    {t(account.enabled ? "mail.enabled" : "mail.disabled")}
                  </Tag>
                  {account.wake_enabled ? <Tag color="blue">{t("mail.wakeEnabled")}</Tag> : null}
                </Space>
                <Typography.Text type="secondary">{account.email_address}</Typography.Text>
                {account.last_error ? (
                  <Typography.Text type="danger" className="mail-account__error">
                    {t("mail.lastError", { error: account.last_error })}
                  </Typography.Text>
                ) : null}
              </div>
              <Space wrap className="mail-account__actions">
                <Button
                  size="small"
                  loading={activeAction === `test:${account.id}`}
                  onClick={() => void runAction(account, "test")}
                >
                  {t("mail.test")}
                </Button>
                <Button
                  size="small"
                  loading={activeAction === `check:${account.id}`}
                  onClick={() => void runAction(account, "check")}
                >
                  {t("mail.check")}
                </Button>
                <Button size="small" onClick={() => openEdit(account)}>{t("mail.edit")}</Button>
                <Popconfirm
                  title={t("mail.deleteConfirm")}
                  description={t("mail.deleteConfirmDetail")}
                  okText={t("mail.delete")}
                  cancelText={t("mail.cancel")}
                  okButtonProps={{ danger: true }}
                  onConfirm={() => remove(account)}
                >
                  <Button
                    danger
                    size="small"
                    loading={activeAction === `delete:${account.id}`}
                  >
                    {t("mail.delete")}
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          ))}
        </div>
      </Card>

      <Drawer
        title={t(editing ? "mail.editTitle" : "mail.addTitle")}
        open={drawerOpen}
        size="large"
        destroyOnHidden
        onClose={() => setDrawerOpen(false)}
        footer={(
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>{t("mail.cancel")}</Button>
            <Button type="primary" loading={saving} onClick={() => form.submit()}>
              {t("mail.save")}
            </Button>
          </Space>
        )}
      >
        <Form<MailFormValues>
          form={form}
          layout="vertical"
          requiredMark="optional"
          initialValues={NEW_ACCOUNT}
          onFinish={(values) => void save(values)}
        >
          <Form.Item name="label" label={t("mail.label")} rules={[{ required: true }]}>
            <Input maxLength={120} autoComplete="off" />
          </Form.Item>
          <div className="settings-form__grid">
            <Form.Item name="email_address" label={t("mail.address")} rules={[{ required: true, type: "email" }]}>
              <Input maxLength={320} autoComplete="email" />
            </Form.Item>
            <Form.Item name="username" label={t("mail.username")} rules={[{ required: true }]}>
              <Input maxLength={320} autoComplete="username" />
            </Form.Item>
          </div>
          <Form.Item
            name="password"
            label={t("mail.password")}
            extra={editing?.credential_configured ? t("mail.passwordConfigured") : t("mail.passwordHint")}
            rules={editing ? [] : [{ required: true }]}
          >
            <Input.Password maxLength={4096} autoComplete="new-password" />
          </Form.Item>

          <Typography.Title level={5}>{t("mail.imap")}</Typography.Title>
          <div className="mail-server-grid">
            <Form.Item name="imap_host" label={t("mail.host")} rules={[{ required: true }]}>
              <Input maxLength={253} autoComplete="off" />
            </Form.Item>
            <Form.Item name="imap_port" label={t("mail.port")} rules={[{ required: true }]}>
              <InputNumber min={1} max={65535} />
            </Form.Item>
            <Form.Item name="imap_security" label={t("mail.security")} rules={[{ required: true }]}>
              <Select options={[
                { value: "tls", label: t("mail.security.tls") },
                { value: "starttls", label: t("mail.security.starttls") },
              ]} />
            </Form.Item>
          </div>

          <Typography.Title level={5}>{t("mail.smtp")}</Typography.Title>
          <div className="mail-server-grid">
            <Form.Item name="smtp_host" label={t("mail.host")} rules={[{ required: true }]}>
              <Input maxLength={253} autoComplete="off" />
            </Form.Item>
            <Form.Item name="smtp_port" label={t("mail.port")} rules={[{ required: true }]}>
              <InputNumber min={1} max={65535} />
            </Form.Item>
            <Form.Item name="smtp_security" label={t("mail.security")} rules={[{ required: true }]}>
              <Select options={[
                { value: "tls", label: t("mail.security.tls") },
                { value: "starttls", label: t("mail.security.starttls") },
              ]} />
            </Form.Item>
          </div>

          <div className="settings-form__grid">
            <Form.Item name="wake_folder" label={t("mail.wakeFolder")} rules={[{ required: true }]}>
              <Input maxLength={512} />
            </Form.Item>
            <Form.Item name="poll_interval_seconds" label={t("mail.pollInterval")} rules={[{ required: true }]}>
              <InputNumber min={60} max={3600} suffix={t("mail.seconds")} />
            </Form.Item>
          </div>
          <Space orientation="vertical" size="middle">
            <Form.Item name="enabled" valuePropName="checked" noStyle>
              <Switch checkedChildren={t("mail.enabled")} unCheckedChildren={t("mail.disabled")} />
            </Form.Item>
            <Form.Item name="wake_enabled" valuePropName="checked" noStyle>
              <Switch checkedChildren={t("mail.wakeOn")} unCheckedChildren={t("mail.wakeOff")} />
            </Form.Item>
          </Space>
          <Alert className="mail-settings__security" type="info" showIcon title={t("mail.securityNotice")} />
        </Form>
      </Drawer>
    </>
  );
}
