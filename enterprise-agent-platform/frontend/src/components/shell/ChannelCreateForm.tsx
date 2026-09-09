import { Button, Form, Input, Tooltip } from "antd";
import { useState } from "react";
import { loadChannels } from "../../data/loaders";
import { runBusy } from "../../data/sessionActions";
import { api } from "../../lib/api";
import { endpoints } from "../../lib/endpoints";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Dialog } from "../common/Dialog";
import { Icon } from "../common/Icon";

export function ChannelCreateForm() {
  const store = useStoreHandle();
  const { t } = useI18n();
  const creating = useStore(state => state.pendingOperations.includes("channel:create"));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  return <>
    <Tooltip title={t("nav.channel.create")}><Button type="text" icon={<Icon name="plus" />}
      aria-label={t("nav.channel.create")} onClick={() => setOpen(true)} /></Tooltip>
    <Dialog open={open} onClose={() => { if (!creating) setOpen(false); }} title={t("nav.channel.create")} description={t("nav.channels.visibility")}>
      <Form layout="vertical" onFinish={() => {
        if (creating || !name.trim()) return;
        void runBusy(store, "channel:create", async () => {
          await api(endpoints.createChannel.path(), { method: "POST", body: JSON.stringify({ name }) });
          setName("");
          await loadChannels(store);
          setOpen(false);
        });
      }}>
        <Form.Item label={t("nav.channel.createPlaceholder")} htmlFor="wf-channel-name" help={t("nav.channel.nameHint")}>
          <Input id="wf-channel-name" name="channel-name" value={name} required disabled={creating}
            onChange={event => setName(event.target.value)} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={creating} disabled={creating || !name.trim()}>{t("nav.channel.create")}</Button>
      </Form>
    </Dialog>
  </>;
}
