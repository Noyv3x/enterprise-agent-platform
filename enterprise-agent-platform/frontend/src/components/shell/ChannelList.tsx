/* <ChannelList/> — the sidebar channel buttons + empty hint (legacy channelButtons,
   legacy-app.js:449-461). Clicking a channel switches to channel view, selects it,
   closes the drawer, and loads its messages via selectChannel. */

import { Menu, type MenuProps } from "antd";
import { selectChannel } from "../../data/chatActions";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";

export function ChannelList() {
  const store = useStoreHandle();
  const { t } = useI18n();
  const channels = useStore((state) => state.channels);
  const activeView = useStore((state) => state.activeView);
  const activeChannelId = useStore((state) => state.activeChannelId);

  const items: MenuProps["items"] = channels.map((channel) => ({
    key: String(channel.id),
    icon: <span className="channel__hash">#</span>,
    label: <span className="channel__name">{channel.name}</span>,
  }));
  const selectedKey = activeView === "channel" && activeChannelId != null
    ? String(activeChannelId)
    : "";

  return (
    <nav className="channels" aria-label={t("shell.channelsNavigation")}>
      {channels.length ? (
        <Menu
          className="shell-menu shell-menu--channels"
          mode="inline"
          selectedKeys={selectedKey ? [selectedKey] : []}
          items={items}
          classNames={{
            item: "shell-menu__item",
            itemIcon: "shell-menu__icon",
            itemContent: "shell-menu__content",
          }}
          onClick={({ key }) => {
            const channel = channels.find((item) => String(item.id) === key);
            if (channel) void selectChannel(store, channel.id);
          }}
        />
      ) : (
        <div className="channel-empty muted">
          {t("nav.channels.empty")}
        </div>
      )}
    </nav>
  );
}
