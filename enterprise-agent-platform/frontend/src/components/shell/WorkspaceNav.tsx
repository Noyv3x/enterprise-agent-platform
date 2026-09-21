import { useEffect, useRef, useState } from "react";
import { deleteChannel, navigateToView, selectChannel } from "../../data/chatActions";
import { usePermissions } from "../../hooks/usePermissions";
import { useI18n } from "../../i18n";
import { getApiSessionGeneration } from "../../lib/api";
import { useStore, useStoreHandle } from "../../store/useStore";
import type { Channel } from "../../types";
import { Dialog } from "../common/Dialog";
import { Icon } from "../common/Icon";
import { Button, MenuButton, Notice, WorkspaceNav as Navigation, type NavigationGroup } from "../ui/beautiful";
import { ChannelCreateForm } from "./ChannelCreateForm";
import { preloadRoute } from "./routePreload";

interface DeleteTarget {
  id: Channel["id"];
  name: string;
  actor: string;
  generation: number;
}

export function useChannelDeletion() {
  const store = useStoreHandle();
  const permissions = usePermissions();
  const { t } = useI18n();
  const userId = useStore(state => state.user?.id);
  const canManage = permissions.has("manage_channels");
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failedTargets, setFailedTargets] = useState<DeleteTarget[]>([]);
  const generation = getApiSessionGeneration();
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const ownsTarget = !!target && canManage && userId != null
    && target.actor === String(userId) && target.generation === generation;
  useEffect(() => {
    if (target && !ownsTarget) {
      setTarget(null);
      setOpen(false);
      setFailed(false);
    }
  }, [target, ownsTarget]);
  useEffect(() => {
    setFailedTargets(current => {
      const retained = current.filter(item => canManage && userId != null
        && item.actor === String(userId) && item.generation === generation);
      return retained.length === current.length ? current : retained;
    });
  }, [canManage, userId, generation]);

  const beginDelete = (channel: Channel) => {
    if (!canManage || userId == null || pending.current) return;
    setTarget({ id: channel.id, name: channel.name, actor: String(userId), generation: getApiSessionGeneration() });
    setFailed(false);
    store.dispatch({ type: "SET_SIDEBAR_OPEN", payload: false });
    setOpen(true);
  };
  const submitDelete = async () => {
    if (!target || !ownsTarget || pending.current || target.actor !== String(store.getState().user?.id)
      || target.generation !== getApiSessionGeneration()) return;
    const captured = target;
    pending.current = true;
    setBusy(true);
    try {
      const deleted = await deleteChannel(store, captured.id);
      if (!mounted.current || captured.actor !== String(store.getState().user?.id)
        || captured.generation !== getApiSessionGeneration()) return;
      if (deleted) {
        setFailedTargets(current => current.filter(item => String(item.id) !== String(captured.id)));
        setTarget(null);
        setOpen(false);
        setFailed(false);
      } else {
        setFailed(true);
        setFailedTargets(current => current.some(item => String(item.id) === String(captured.id))
          ? current : [...current, captured]);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return {
    beginDelete,
    busy,
    retryAction: <div className="bui-stack-tight">{failedTargets.filter(item => canManage
      && item.actor === String(userId) && item.generation === generation
      && !(open && target && String(target.id) === String(item.id))).map(item =>
      <Button key={String(item.id)} className="bui-channel-delete-retry" variant="danger" disabled={busy} onClick={() => {
        if (pending.current) return;
        setTarget(item);
        setFailed(true);
        store.dispatch({ type: "SET_SIDEBAR_OPEN", payload: false });
        setOpen(true);
      }}>{t("nav.channel.deleteRetryNamed", { name: item.name })}</Button>)}</div>,
    confirmation: <>
    {ownsTarget && target && <>
      <Dialog open={open} onClose={() => { if (!pending.current) setOpen(false); }}
        title={t("nav.channel.deleteTitle", { name: target.name })}
        description={t("nav.channel.deleteDescription")}
        footer={<>
          <Button disabled={busy} onClick={() => setOpen(false)}>{t("chat.confirm.cancel")}</Button>
          <Button variant="danger" disabled={busy} loading={busy} onClick={() => void submitDelete()}>
            {t(busy ? "nav.channel.deleting" : failed ? "nav.channel.deleteRetry" : "nav.channel.delete")}
          </Button>
        </>}>
        <p>{t("nav.channel.deleteRetention")}</p>
        {failed && <Notice tone="warning" title={t("nav.channel.deleteFailed")}>{t("nav.channel.deleteRetryHint", { name: target.name })}</Notice>}
      </Dialog>
    </>}
    </>,
  };
}

export function WorkspaceNav({ onDelete, deleteBusy }: { onDelete: (channel: Channel) => void; deleteBusy: boolean }) {
  const store = useStoreHandle();
  const permissions = usePermissions();
  const { t } = useI18n();
  const channels = useStore(state => state.channels);
  const view = useStore(state => state.activeView);
  const channelId = useStore(state => state.activeChannelId);
  const canManage = permissions.has("manage_channels");
  const groups: NavigationGroup[] = [];
  if (permissions.has("private_agent")) groups.push({
    key: "personal", label: null, items: [
      { key: "private", label: t("nav.privateAgent"), icon: <Icon name="bot" /> },
      { key: "guide", label: t("personalAi.guide.sidebar"), icon: <Icon name="sparkles" /> },
    ],
  });
  groups.push({
    key: "channels", label: <span><Icon name="users" /> {t("nav.channels")}</span>,
    action: canManage ? <ChannelCreateForm /> : undefined,
    items: channels.length ? channels.map(channel => ({
      key: `channel:${String(channel.id)}`, label: channel.name,
      description: <span className="bui-stack-tight"><span>{t("nav.channels.memberVisible")}</span>{channel.description ? <span>{channel.description}</span> : null}</span>,
      icon: <Icon name="hash" />,
      trailing: canManage ? <MenuButton label={<Icon name="menu" />} aria-label={t("nav.channel.manage", { name: channel.name })}
        disabled={deleteBusy} items={[{ key: "delete", label: t("nav.channel.delete"), danger: true, onSelect: () => onDelete(channel) }]} /> : undefined,
    })) : [{ key: "no-channels", label: t("nav.channels.empty"), description: t("nav.channels.visibility"), disabled: true }],
  });
  groups.push({ key: "tools", label: null, items: [
    { key: "settings", label: <span onPointerEnter={() => preloadRoute("settings")} onTouchStart={() => preloadRoute("settings")}>{t("nav.settings")}</span>, icon: <Icon name="settings" /> },
    ...(permissions.isAdmin ? [{ key: "admin", label: <span onPointerEnter={() => preloadRoute("admin")} onTouchStart={() => preloadRoute("admin")}>{t("nav.admin")}</span>, icon: <Icon name="shield" /> }] : []),
  ] });
  return <Navigation label={t("shell.navigation")} groups={groups}
      activeKey={view === "channel" ? `channel:${String(channelId)}` : view}
      onSelect={key => {
        if (key.startsWith("channel:")) {
          const selected = channels.find(channel => `channel:${String(channel.id)}` === key);
          if (selected) void selectChannel(store, selected.id);
        } else if (key === "guide") {
          void navigateToView(store, "private");
          store.dispatch({ type: "SET_PERSONAL_AI_GUIDE_OPEN", payload: { open: true, markShown: true } });
        } else if (key === "private" || key === "settings" || key === "admin") {
          void navigateToView(store, key);
        }
      }} />;
}
