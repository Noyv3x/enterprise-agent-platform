/* The app's sidebar: upstream SidebarNav fed with the session — permission-gated nav, the channel list, the chat
 * list from chatStore (search, rename, delete), Admin/Settings and the account menu (theme, language, sign out). */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { User } from "../api";
import { Button } from "../components/ui/beautiful/atoms/Button";
import { ConfirmDialog, Dialog, Field, Icon, Menu, Notice, TextField, type MenuItem } from "../components/ui/beautiful/controls";
import { useAnchoredPosition, useOutsidePress } from "../components/ui/beautiful/controls/overlay";
import SearchList from "../components/ui/beautiful/primitives/SearchList";
import SidebarNav, { RailButton, type SidebarNavItem, type SidebarRecent, type SidebarSection } from "../components/ui/beautiful/primitives/SidebarNav";
import { useBranding } from "../context/BrandingContext";
import { useTheme } from "../hooks/useTheme";
import { SUPPORTED_LOCALES, useI18n } from "../i18n";
import type { Channel } from "../views/Channels";
import { deleteChat, updateChat, useChats } from "../views/chat/chatStore";
import { useWords } from "../words";
import { BrandMark } from "./BrandMark";
import { LOCALE_NAMES } from "./preferences";
import { navKey, type Access, type Route } from "./routes";

type ChatDialog = { kind: "rename" | "delete"; chat: SidebarRecent } | null;

export function Sidebar({
  user,
  channels,
  access,
  route,
  navigate,
  onSignOut,
  collapsed,
  onCollapsedChange,
  drawer = false,
  onClose,
}: {
  user: User;
  channels: Channel[];
  access: Access;
  route: Route;
  navigate: (key: string) => void;
  onSignOut: () => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  drawer?: boolean;
  onClose?: () => void;
}) {
  const w = useWords();
  const { branding } = useBranding();
  const chats = useChats(access.chat);
  const [dialog, setDialog] = useState<ChatDialog>(null);
  const untitled = w("New chat", "新聊天", "新聊天");
  const chatRows: SidebarRecent[] = (chats.conversations ?? []).map((chat) => ({ id: chat.id, label: chat.title.trim() || untitled }));
  const activeChat = route.view === "chat" ? route.id : null;
  // After a delete removes the row (and the menu trigger that opened the dialog), focus moves to the next chat row,
  // else the previous one, else New chat, instead of falling back to <body>. "" means New chat.
  const [focusAfterDelete, setFocusAfterDelete] = useState<string | null>(null);
  useEffect(() => {
    if (focusAfterDelete === null || dialog) return;
    const row = focusAfterDelete ? document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(focusAfterDelete)}"]`) : null;
    (row ?? document.querySelector<HTMLElement>("[data-sidebar-new-chat]"))?.focus();
    setFocusAfterDelete(null);
  }, [focusAfterDelete, dialog]);
  const selectRoute = (key: string) => {
    navigate(key);
    if (drawer) onClose?.();
  };

  const nav: SidebarNavItem[] = [
    ...(access.private ? [{ key: "private", label: w("Personal AI", "个人 AI", "個人 AI"), icon: <Icon name="sparkle" /> }] : []),
    ...(access.chat ? [{ key: "chat", label: w("Chat", "聊天", "聊天"), icon: <Icon name="chat" /> }] : []),
    ...(access.private ? [{ key: "schedules", label: w("Schedules", "定时任务", "排程任務"), icon: <Icon name="clock" /> }] : []),
    ...(access.channels ? [{ key: "channels", label: w("Channels", "频道", "頻道"), icon: <Icon name="hash" /> }] : []),
  ];
  const footerNav: SidebarNavItem[] = [
    ...(access.admin ? [{ key: "admin", label: w("Admin", "管理", "管理"), icon: <Icon name="shield" /> }] : []),
    { key: "settings", label: w("Settings", "设置", "設定"), icon: <Icon name="gear" /> },
  ];

  const sections: SidebarSection[] = [];
  const openChannels = channels.filter((channel) => !channel.archived);
  if (access.channels && openChannels.length > 0) {
    sections.push({
      key: "channels",
      label: w("Channels", "频道", "頻道"),
      items: openChannels.map((channel) => ({ id: String(channel.id), label: channel.name })),
      activeId: route.view === "channel" ? String(route.id) : null,
      onPick: (id) => selectRoute(`channel-${id}`),
    });
  }
  if (access.chat) {
    sections.push({
      key: "chats",
      label: w("Chats", "聊天记录", "聊天紀錄"),
      items: chatRows,
      activeId: activeChat,
      onPick: (id) => selectRoute(`chat-${id}`),
      emptyLabel: chats.conversations ? w("No chats yet", "还没有聊天", "還沒有聊天") : undefined,
      search: {
        open: w("Search chats", "搜索聊天", "搜尋聊天"),
        placeholder: w("Search chats", "搜索聊天", "搜尋聊天"),
        ariaLabel: w("Search chat history", "搜索聊天记录", "搜尋聊天紀錄"),
        close: w("Close chat search", "关闭搜索", "關閉搜尋"),
        empty: w("No chats found", "没有找到聊天", "沒有找到聊天"),
      },
      rowActions: (chat) => <ChatRowMenu chat={chat} onRename={() => setDialog({ kind: "rename", chat })} onDelete={() => setDialog({ kind: "delete", chat })} />,
    });
  }

  const openArea = (key: string) => {
    // Chat opens the latest conversation; New chat is the way to a blank one.
    if (key === "chat" && chatRows[0]) selectRoute(`chat-${chatRows[0].id}`);
    else selectRoute(key);
  };

  return (
    <>
      <SidebarNav
        brand={{ name: branding.product_name, logo: <BrandMark name={branding.product_name} logoUrl={branding.logo_url} /> }}
        labels={{
          navigation: w("Workspace navigation", "工作区导航", "工作區導覽"),
          collapse: w("Collapse sidebar", "收起侧栏", "收合側欄"),
          expand: w("Expand sidebar", "展开侧栏", "展開側欄"),
          close: w("Close navigation", "关闭导航", "關閉導覽"),
        }}
        collapsed={collapsed}
        onCollapsedChange={onCollapsedChange}
        drawer={drawer}
        onClose={onClose}
        className={drawer ? "" : "max-lg:hidden"}
        newChat={access.chat ? { label: w("New chat", "新聊天", "新聊天"), onClick: () => selectRoute("chat") } : undefined}
        nav={nav}
        activeNav={navKey(route)}
        onNavigate={openArea}
        sections={sections}
        railSearch={access.chat && chatRows.length > 0 ? <RailSearch chats={chatRows} onPick={(id) => selectRoute(`chat-${id}`)} /> : undefined}
        footerNav={footerNav}
        account={<AccountMenu user={user} collapsed={!drawer && collapsed} onSignOut={onSignOut} />}
      />
      {dialog?.kind === "rename" && <RenameChatDialog chat={dialog.chat} onClose={() => setDialog(null)} />}
      {dialog?.kind === "delete" && (
        <DeleteChatDialog
          chat={dialog.chat}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            const index = chatRows.findIndex((row) => row.id === dialog.chat.id);
            setFocusAfterDelete((index < 0 ? undefined : chatRows[index + 1] ?? chatRows[index - 1])?.id ?? "");
            setDialog(null);
            if (activeChat === dialog.chat.id) navigate("chat");
          }}
        />
      )}
    </>
  );
}

function ChatRowMenu({ chat, onRename, onDelete }: { chat: SidebarRecent; onRename: () => void; onDelete: () => void }) {
  const w = useWords();
  return (
    <Menu
      label={w(`Actions for ${chat.label}`, `“${chat.label}”的操作`, `「${chat.label}」的操作`)}
      width={200}
      align="start"
      items={[
        { key: "rename", label: w("Rename", "重命名", "重新命名"), icon: <Icon name="pencil" size={16} />, onSelect: onRename },
        { key: "sep", separator: true },
        { key: "delete", label: w("Delete", "删除", "刪除"), icon: <Icon name="trash" size={16} />, tone: "danger", onSelect: onDelete },
      ]}
      trigger={(props) => (
        <button
          type="button"
          {...props}
          aria-label={w(`More actions for ${chat.label}`, `更多操作：${chat.label}`, `更多操作：${chat.label}`)}
          className="flex size-7 items-center justify-center rounded-[6px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink aria-expanded:bg-hover aria-expanded:text-ink touch:size-11"
        >
          <Icon name="more" size={16} />
        </button>
      )}
    />
  );
}

function RenameChatDialog({ chat, onClose }: { chat: SidebarRecent; onClose: () => void }) {
  const w = useWords();
  const [title, setTitle] = useState(chat.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = title.trim();
  const save = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      await updateChat(chat.id, { title: trimmed });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      size="sm"
      title={w("Rename chat", "重命名聊天", "重新命名聊天")}
      initialFocusRef={inputRef}
      footer={
        <>
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onClose} className="touch:h-11 touch:px-4">{w("Cancel", "取消", "取消")}</Button>
          <Button type="submit" form="rename-chat" size="sm" variant="primary" disabled={busy || !trimmed} aria-busy={busy || undefined} className="touch:h-11 touch:px-4">{w("Save", "保存", "儲存")}</Button>
        </>
      }
    >
      <form
        id="rename-chat"
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label={w("Title", "标题", "標題")}>
          <TextField ref={inputRef} value={title} maxLength={120} disabled={busy} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        {error && <Notice tone="danger" title={error} />}
      </form>
    </Dialog>
  );
}

function DeleteChatDialog({ chat, onClose, onDeleted }: { chat: SidebarRecent; onClose: () => void; onDeleted: () => void }) {
  const w = useWords();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <ConfirmDialog
      open
      tone="danger"
      busy={busy}
      error={error || undefined}
      title={w("Delete this chat?", "删除这个聊天？", "刪除這個聊天？")}
      description={w(
        `“${chat.label}”, its messages, and files in its working directory will be permanently deleted. This cannot be undone.`,
        `“${chat.label}”、其消息及工作目录中的文件将被永久删除。此操作无法撤销。`,
        `「${chat.label}」、其訊息及工作目錄中的檔案將被永久刪除。此操作無法復原。`,
      )}
      confirmLabel={w("Delete chat", "删除聊天", "刪除聊天")}
      onCancel={onClose}
      onConfirm={async () => {
        setBusy(true);
        setError("");
        try {
          await deleteChat(chat.id);
          onDeleted();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setBusy(false);
        }
      }}
    />
  );
}

function AccountMenu({ user, collapsed, onSignOut }: { user: User; collapsed: boolean; onSignOut: () => void }) {
  const w = useWords();
  const { preference, setPreference } = useTheme();
  const { locale, setLocale } = useI18n();
  const name = user.display_name || user.username;
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  const heading = (text: string) => <span className="text-[12px] font-medium text-ink-2">{text}</span>;
  const items: MenuItem[] = [
    {
      key: "who",
      heading: (
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] font-medium text-ink">{name}</span>
          <span className="truncate text-[12px] text-ink-2">@{user.username} · {user.role === "admin" ? w("Administrator", "管理员", "管理員") : w("Member", "成员", "成員")}</span>
        </div>
      ),
    },
    { key: "sep-1", separator: true },
    { key: "theme", heading: heading(w("Theme", "主题", "主題")) },
    { key: "theme-light", label: w("Light", "浅色", "淺色"), icon: <Icon name="sun" size={16} />, checked: preference === "light", onSelect: () => setPreference("light") },
    { key: "theme-dark", label: w("Dark", "深色", "深色"), icon: <Icon name="moon" size={16} />, checked: preference === "dark", onSelect: () => setPreference("dark") },
    { key: "theme-system", label: w("System", "跟随系统", "跟隨系統"), icon: <Icon name="monitor" size={16} />, checked: preference === "system", onSelect: () => setPreference("system") },
    { key: "sep-2", separator: true },
    { key: "language", heading: heading(w("Language", "语言", "語言")) },
    ...SUPPORTED_LOCALES.map((value): MenuItem => ({ key: `locale-${value}`, label: LOCALE_NAMES[value], icon: <Icon name="globe" size={16} />, checked: locale === value, onSelect: () => setLocale(value) })),
    { key: "sep-3", separator: true },
    { key: "sign-out", label: w("Sign out", "退出登录", "登出"), icon: <Icon name="logout" size={16} />, onSelect: onSignOut },
  ];
  return (
    <Menu
      label={w("Account", "账户", "帳戶")}
      side="top"
      align="start"
      width={248}
      items={items}
      trigger={(props) => (
        <RailButton
          {...props}
          title={collapsed ? name : undefined}
          aria-label={w(`Account: ${name}`, `账户：${name}`, `帳戶：${name}`)}
          icon={
            <span aria-hidden className="flex size-5 items-center justify-center rounded-full bg-hover-2 text-[10.5px] font-semibold text-ink shadow-hairline">
              {initial}
            </span>
          }
          label={name}
          trailing={<Icon name="chevronUpDown" size={14} strokeWidth={2} />}
          className="aria-expanded:bg-hover-2"
        />
      )}
    />
  );
}

/** Collapsed rail: the chat list is hidden, so a rail button opens the upstream SearchList beside it. */
function RailSearch({ chats, onPick }: { chats: SidebarRecent[]; onPick: (id: string) => void }) {
  const w = useWords();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredPosition({ open, anchorRef, popupRef, side: "right", offset: 10 });
  useOutsidePress(open, [anchorRef, popupRef], () => setOpen(false));
  useEffect(() => {
    if (open) popupRef.current?.querySelector("input")?.focus();
  }, [open]);
  const label = w("Search chats", "搜索聊天", "搜尋聊天");
  return (
    <>
      <RailButton ref={anchorRef} icon={<Icon name="search" size={18} />} label={label} title={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((current) => !current)} />
      {open &&
        createPortal(
          <div
            ref={popupRef}
            role="dialog"
            aria-label={label}
            className="bui-popover z-[80] w-72"
            style={{ ...style, animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both" }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setOpen(false);
                anchorRef.current?.focus();
              }
            }}
          >
            <SearchList
              items={chats}
              limit={8}
              labels={{
                placeholder: label,
                ariaLabel: w("Search chat history", "搜索聊天记录", "搜尋聊天紀錄"),
                clear: w("Clear search", "清除搜索", "清除搜尋"),
                emptyTitle: w("No chats found", "没有找到聊天", "沒有找到聊天"),
                emptyHint: w("Try other words from the title", "换个标题里的词试试", "換個標題裡的詞試試"),
              }}
              onPick={(item) => {
                setOpen(false);
                onPick(item.id);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
