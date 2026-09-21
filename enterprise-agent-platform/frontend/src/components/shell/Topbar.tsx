import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n";
import { topbarInfo } from "../../store/selectors";
import { useStore } from "../../store/useStore";
import type { TopbarInfo } from "../../types";
import { Icon } from "../common/Icon";
import { PageHeader, StatusMark } from "../ui/fieldwork";
import { TopbarActions } from "./TopbarActions";

function sameInfo(left: TopbarInfo, right: TopbarInfo) {
  return left.title === right.title && left.sub === right.sub && left.icon === right.icon
    && left.hash === right.hash && left.publicChannel === right.publicChannel;
}
export function Topbar() {
  const { t } = useI18n();
  const info = useStore(state => topbarInfo(state, t), sameInfo);
  const view = useStore(state => state.activeView);
  const channelId = useStore(state => state.activeChannelId);
  const titleRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (window.matchMedia("(max-width: 1040px), (pointer: coarse)").matches) titleRef.current?.focus();
  }, [view, channelId]);
  return <PageHeader
    title={<span ref={titleRef} tabIndex={-1}>{info.title}</span>}
    description={info.publicChannel ? info.sub : undefined}
    meta={info.publicChannel ? <StatusMark><Icon name="users" size={14} />{t("nav.channel.publicBadge")}</StatusMark> : undefined}
    actions={<TopbarActions />} />;
}
