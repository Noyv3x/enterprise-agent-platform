/* <ChannelCreateForm/> — the gated (manage_channels) new-channel form
   (legacy-app.js:471-482). The empty guard trims, but the POST body sends the
   RAW (untrimmed) input value verbatim — preserve this to avoid backend drift. */

import { useState } from "react";
import { api } from "../../lib/api";
import { endpoints } from "../../lib/endpoints";
import { loadChannels } from "../../data/loaders";
import { runBusy } from "../../data/sessionActions";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Icon } from "../common/Icon";

export function ChannelCreateForm() {
  const store = useStoreHandle();
  const { t } = useI18n();
  const creating = useStore((state) => state.pendingOperations.includes("channel:create"));
  const [name, setName] = useState("");

  return (
    <form
      className="channel-create"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return; // guard trims, payload does not
        void runBusy(store, "channel:create", async () => {
          await api(endpoints.createChannel.path(), {
            method: "POST",
            body: JSON.stringify({ name }), // UNTRIMMED, verbatim legacy payload
          });
          setName("");
          await loadChannels(store);
        });
      }}
    >
      <input
        placeholder={t("nav.channel.createPlaceholder")}
        aria-label={t("nav.channel.createPlaceholder")}
        value={name}
        disabled={creating}
        onChange={(event) => setName(event.target.value)}
      />
      <button
        className="icon-btn channel-create__submit"
        type="submit"
        title={t("nav.channel.create")}
        aria-label={t("nav.channel.create")}
        disabled={creating || !name.trim()}
      >
        <Icon name="plus" size={16} />
      </button>
    </form>
  );
}
