/* <ChannelList/> — the sidebar channel buttons + empty hint (legacy channelButtons,
   legacy-app.js:449-461). Clicking a channel switches to channel view, selects it,
   closes the drawer, and loads its messages via selectChannel. */

import { cx } from "../../lib/cx";
import { selectChannel } from "../../data/chatActions";
import { useStore, useStoreHandle } from "../../store/useStore";

export function ChannelList() {
  const store = useStoreHandle();
  const channels = useStore((state) => state.channels);
  const activeView = useStore((state) => state.activeView);
  const activeChannelId = useStore((state) => state.activeChannelId);

  return (
    <div className="channels">
      {channels.length ? (
        channels.map((channel) => (
          <button
            key={String(channel.id)}
            className={cx(
              "channel",
              activeView === "channel" && activeChannelId === channel.id && "is-active",
            )}
            onClick={() => void selectChannel(store, channel.id)}
          >
            <span className="channel__hash">#</span>
            <span className="channel__name">{channel.name}</span>
          </button>
        ))
      ) : (
        <div className="muted" style={{ padding: "4px 10px", fontSize: "12.5px" }}>
          暂无频道，创建一个开始协作。
        </div>
      )}
    </div>
  );
}
