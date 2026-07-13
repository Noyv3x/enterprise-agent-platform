/* <ChannelList/> — the sidebar channel buttons + empty hint (legacy channelButtons,
   legacy-app.js:449-461). Clicking a channel switches to channel view, selects it,
   closes the drawer, and loads its messages via selectChannel. */

import { cx } from "../../lib/cx";
import { selectChannel } from "../../data/chatActions";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";

export function ChannelList() {
  const store = useStoreHandle();
  const { t } = useI18n();
  const channels = useStore((state) => state.channels);
  const activeView = useStore((state) => state.activeView);
  const activeChannelId = useStore((state) => state.activeChannelId);

  return (
    <nav className="channels" aria-label={t("shell.channelsNavigation")}>
      {channels.length ? (
        channels.map((channel) => (
          <button
            type="button"
            key={String(channel.id)}
            className={cx(
              "channel",
              activeView === "channel" && activeChannelId === channel.id && "is-active",
            )}
            aria-current={activeView === "channel" && activeChannelId === channel.id ? "page" : undefined}
            onClick={() => void selectChannel(store, channel.id)}
          >
            <span className="channel__hash">#</span>
            <span className="channel__name">{channel.name}</span>
          </button>
        ))
      ) : (
        <div className="channel-empty muted">
          {t("nav.channels.empty")}
        </div>
      )}
    </nav>
  );
}
