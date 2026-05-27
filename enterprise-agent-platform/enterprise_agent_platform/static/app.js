/* =====================================================================
   Enterprise Agent Platform — application shell
   Framework-free, dependency-free. Full re-render on state change with
   targeted post-render hooks (scroll, focus). All API calls and payload
   shapes are preserved from the original implementation.
   ===================================================================== */

const state = {
  user: null,
  channels: [],
  activeView: "channel",
  activeChannelId: null,
  messages: [],
  privateMessages: [],
  pendingMessages: [],
  drafts: {},
  agentStatuses: { channels: {}, private: null },
  expandedAgentRuns: {},
  mentionTargets: [],
  typingUsers: [],
  documents: [],
  selectedDocument: null,
  users: [],
  permissionGroups: [],
  activeAdminPage: "accounts",
  secrets: [],
  runtimes: null,
  hermesConfig: null,
  hermesInternalConfig: null,
  cogneeConfig: null,
  oauthProviders: null,
  oauthFlows: {},
  oauthCallbackUrls: {},
  busy: false,
  sending: false,
  sidebarOpen: false,
  error: "",
  _lastView: null,
  _focusComposer: false,
  _scrollChatToBottom: false,
};

const app = document.getElementById("app");
const toastStack = document.getElementById("toast-stack");
let pollTimer = null;
let pollInFlight = false;
let localMessageSeq = 0;
const typingState = { key: null, active: false, lastSent: 0, stopTimer: null };
const composerState = { composing: false, renderDeferred: false };
const mentionState = { active: false, selected: 0, options: [], range: null, menu: null };

/* ---------------------------------------------------------------- api */
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(data.error || data.detail || `${res.status} ${res.statusText}`);
  }
  return data;
}

/* ------------------------------------------------------ DOM builders */
function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SVGNS = "http://www.w3.org/2000/svg";
const ICONS = {
  hash: [["line", { x1: 4, y1: 9, x2: 20, y2: 9 }], ["line", { x1: 4, y1: 15, x2: 20, y2: 15 }], ["line", { x1: 10, y1: 3, x2: 8, y2: 21 }], ["line", { x1: 16, y1: 3, x2: 14, y2: 21 }]],
  bot: [["rect", { x: 4, y: 9, width: 16, height: 11, rx: 2.5 }], ["path", { d: "M12 9V5" }], ["circle", { cx: 12, cy: 3.6, r: 1.3 }], ["path", { d: "M9.4 14h.01" }], ["path", { d: "M14.6 14h.01" }], ["path", { d: "M4 13.5H2.5" }], ["path", { d: "M21.5 13.5H20" }]],
  library: [["path", { d: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20" }], ["path", { d: "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" }]],
  settings: [["line", { x1: 3, y1: 8, x2: 21, y2: 8 }], ["circle", { cx: 9, cy: 8, r: 2.3 }], ["line", { x1: 3, y1: 16, x2: 21, y2: 16 }], ["circle", { cx: 15, cy: 16, r: 2.3 }]],
  send: [["path", { d: "M12 19V5" }], ["path", { d: "M6 11l6-6 6 6" }]],
  search: [["circle", { cx: 11, cy: 11, r: 7 }], ["line", { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }]],
  sun: [["circle", { cx: 12, cy: 12, r: 4 }], ["path", { d: "M12 2v2" }], ["path", { d: "M12 20v2" }], ["path", { d: "M2 12h2" }], ["path", { d: "M20 12h2" }], ["path", { d: "M4.9 4.9l1.4 1.4" }], ["path", { d: "M17.7 17.7l1.4 1.4" }], ["path", { d: "M19.1 4.9l-1.4 1.4" }], ["path", { d: "M6.3 17.7l-1.4 1.4" }]],
  moon: [["path", { d: "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" }]],
  logout: [["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }], ["path", { d: "M16 17l5-5-5-5" }], ["line", { x1: 21, y1: 12, x2: 9, y2: 12 }]],
  plus: [["line", { x1: 12, y1: 5, x2: 12, y2: 19 }], ["line", { x1: 5, y1: 12, x2: 19, y2: 12 }]],
  checkCircle: [["path", { d: "M22 11.08V12a10 10 0 1 1-5.93-9.14" }], ["path", { d: "M22 4L12 14.01l-3-3" }]],
  alert: [["path", { d: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" }], ["line", { x1: 12, y1: 9, x2: 12, y2: 13 }], ["line", { x1: 12, y1: 17, x2: 12.01, y2: 17 }]],
  refresh: [["path", { d: "M21 2v6h-6" }], ["path", { d: "M3 12a9 9 0 0 1 15-6.7L21 8" }], ["path", { d: "M3 22v-6h6" }], ["path", { d: "M21 12a9 9 0 0 1-15 6.7L3 16" }]],
  download: [["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }], ["path", { d: "M7 10l5 5 5-5" }], ["line", { x1: 12, y1: 15, x2: 12, y2: 3 }]],
  close: [["line", { x1: 18, y1: 6, x2: 6, y2: 18 }], ["line", { x1: 6, y1: 6, x2: 18, y2: 18 }]],
  menu: [["line", { x1: 3, y1: 6, x2: 21, y2: 6 }], ["line", { x1: 3, y1: 12, x2: 21, y2: 12 }], ["line", { x1: 3, y1: 18, x2: 21, y2: 18 }]],
  external: [["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }], ["path", { d: "M15 3h6v6" }], ["line", { x1: 10, y1: 14, x2: 21, y2: 3 }]],
  loader: [["line", { x1: 12, y1: 2, x2: 12, y2: 6 }], ["line", { x1: 12, y1: 18, x2: 12, y2: 22 }], ["line", { x1: 4.9, y1: 4.9, x2: 7.8, y2: 7.8 }], ["line", { x1: 16.2, y1: 16.2, x2: 19.1, y2: 19.1 }], ["line", { x1: 2, y1: 12, x2: 6, y2: 12 }], ["line", { x1: 18, y1: 12, x2: 22, y2: 12 }], ["line", { x1: 4.9, y1: 19.1, x2: 7.8, y2: 16.2 }], ["line", { x1: 16.2, y1: 7.8, x2: 19.1, y2: 4.9 }]],
  key: [["circle", { cx: 7.5, cy: 15.5, r: 3.5 }], ["path", { d: "M10 13l9-9" }], ["path", { d: "M18 5l2 2" }], ["path", { d: "M15 8l2 2" }]],
  server: [["rect", { x: 3, y: 4, width: 18, height: 7, rx: 1.6 }], ["rect", { x: 3, y: 13, width: 18, height: 7, rx: 1.6 }], ["line", { x1: 7, y1: 7.5, x2: 7.01, y2: 7.5 }], ["line", { x1: 7, y1: 16.5, x2: 7.01, y2: 16.5 }]],
  shield: [["path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }], ["path", { d: "M9 12l2 2 4-4" }]],
  doc: [["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }], ["path", { d: "M14 2v6h6" }], ["line", { x1: 8, y1: 13, x2: 16, y2: 13 }], ["line", { x1: 8, y1: 17, x2: 13, y2: 17 }]],
  message: [["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }]],
  link: [["path", { d: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" }], ["path", { d: "M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" }]],
  users: [["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }], ["circle", { cx: 9, cy: 7, r: 4 }], ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.9" }], ["path", { d: "M16 3.1a4 4 0 0 1 0 7.8" }]],
};

const FALLBACK_PERMISSION_GROUPS = [
  { id: "admin", label: "管理员", description: "管理企业账户、模型配置和平台运行时。", permissions: ["read_workspace", "chat", "private_agent", "manage_channels", "manage_knowledge", "manage_users", "system_settings"] },
  { id: "manager", label: "经理", description: "管理频道和知识库，并使用企业 Agent。", permissions: ["read_workspace", "chat", "private_agent", "manage_channels", "manage_knowledge"] },
  { id: "member", label: "成员", description: "使用频道、知识库和私人 Agent。", permissions: ["read_workspace", "chat", "private_agent"] },
  { id: "viewer", label: "只读", description: "只能查看频道消息和企业知识。", permissions: ["read_workspace"] },
];
const THINKING_DEPTH_OPTIONS = [
  ["none", "关闭"],
  ["minimal", "极低"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "超高"],
];
const ADMIN_PAGES = [
  { id: "accounts", label: "账户权限", icon: "users", description: "企业账户、权限组与个人模型策略。" },
  { id: "model", label: "模型接入", icon: "shield", description: "OAuth 供应商验证与 Hermes API 参数。" },
  { id: "runtime", label: "运行时", icon: "server", description: "底层基座服务健康状态。" },
  { id: "hermes", label: "Hermes", icon: "settings", description: "Hermes config.yaml 与环境变量。" },
  { id: "cognee", label: "Cognee", icon: "library", description: "Cognee 环境变量配置。" },
  { id: "secrets", label: "密钥", icon: "key", description: "平台内部密钥。" },
];

function icon(name, { size, cls, strokeWidth } = {}) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(strokeWidth || 1.7));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (size) { svg.setAttribute("width", size); svg.setAttribute("height", size); }
  if (cls) svg.setAttribute("class", cls);
  for (const [tag, attrs] of ICONS[name] || []) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

/* --------------------------------------------------------------- theme */
function currentTheme() {
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("eap-theme", next); } catch (_) {}
  render();
}
function themeToggle() {
  const dark = currentTheme() === "dark";
  return h("button", { class: "icon-btn", title: dark ? "切换到浅色主题" : "切换到深色主题", "aria-label": "切换主题", onclick: toggleTheme }, [icon(dark ? "sun" : "moon")]);
}

/* -------------------------------------------------------------- toasts */
function toast(message, { type = "error", title } = {}) {
  if (!toastStack) return;
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    node.classList.add("is-leaving");
    node.addEventListener("animationend", () => node.remove(), { once: true });
  };
  const node = h("div", { class: `toast toast--${type}`, role: "status" }, [
    h("div", { class: "toast__icon" }, [icon(type === "ok" ? "checkCircle" : "alert", { size: 18 })]),
    h("div", { class: "toast__body" }, [
      title ? h("div", { class: "toast__title", text: title }) : null,
      h("div", { class: "toast__msg", text: message }),
    ]),
    h("button", { class: "icon-btn toast__close", title: "关闭", onclick: dismiss }, [icon("close", { size: 16 })]),
  ]);
  toastStack.appendChild(node);
  timer = setTimeout(dismiss, type === "ok" ? 3200 : 6500);
}

/* ----------------------------------------------------- render plumbing */
function render() {
  if (shouldDeferComposerRender()) {
    composerState.renderDeferred = true;
    return;
  }
  const messageScroll = captureMessageScroll();
  app.replaceChildren(state.user ? renderShell() : renderLogin());
  requestAnimationFrame(() => afterRender(messageScroll));
}
function shouldDeferComposerRender() {
  return composerState.composing && document.activeElement?.matches?.(".composer textarea");
}
function flushDeferredRender() {
  if (!composerState.renderDeferred) return;
  composerState.renderDeferred = false;
  state._focusComposer = true;
  render();
}
function afterRender(messageScroll) {
  const msgs = app.querySelector(".messages");
  if (msgs) restoreMessageScroll(msgs, messageScroll);
  state._scrollChatToBottom = false;
  const ta = app.querySelector(".composer textarea");
  if (ta) autoGrow(ta, { animate: false });
  if (state._focusComposer) {
    if (ta) { ta.focus(); autoGrow(ta); }
    state._focusComposer = false;
  }
}
function captureMessageScroll() {
  const msgs = app.querySelector(".messages");
  if (!msgs) return null;
  return {
    key: msgs.dataset.chatKey || "",
    top: msgs.scrollTop,
    bottom: Math.max(0, msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight),
  };
}
function restoreMessageScroll(msgs, previous) {
  const sameChat = previous && previous.key === (msgs.dataset.chatKey || "");
  if (state._scrollChatToBottom || !sameChat || previous.bottom < 32) {
    msgs.scrollTop = msgs.scrollHeight;
    return;
  }
  const maxTop = Math.max(0, msgs.scrollHeight - msgs.clientHeight);
  msgs.scrollTop = Math.min(previous.top, maxTop);
}

/* ----------------------------------------------------------- shared UI */
function brand() {
  return h("div", { class: "brand" }, [
    h("img", { class: "brand__logo", src: "/ubitech-logo.png", alt: "ubitech" }),
    h("span", { class: "brand__eyebrow", text: "Agent Platform" }),
  ]);
}
function field(label, control) {
  return h("label", { class: "field" }, [h("span", { text: label }), control]);
}
function cardHead(title, iconName, { desc, extra } = {}) {
  return h("div", { class: "card__head" }, [
    h("div", {}, [
      h("div", { class: "card__title" }, [iconName ? icon(iconName) : null, h("span", { text: title })]),
      desc ? h("div", { class: "card__desc", text: desc }) : null,
    ]),
    extra || null,
  ]);
}
function statusBadge(ok, label) {
  return h("span", { class: `status status--${ok ? "ok" : "warn"}` }, [
    h("span", { class: `dot ${ok ? "" : "dot--warn"}` }),
    document.createTextNode(label),
  ]);
}
function userPermissions() {
  return new Set(state.user?.permissions || []);
}
function isAdmin() {
  return state.user?.role === "admin" || state.user?.permission_group === "admin" || userPermissions().has("system_settings");
}
function hasPermission(permission) {
  return isAdmin() || userPermissions().has(permission);
}
function emptyState(iconName, title, text) {
  return h("div", { class: "empty" }, [
    h("div", { class: "empty__icon" }, [icon(iconName, { size: 26 })]),
    h("h3", { text: title }),
    h("p", { text: text }),
  ]);
}

/* ---------------------------------------------------------------- login */
function renderLogin() {
  const username = h("input", { name: "username", autocomplete: "username", placeholder: "用户名", value: "admin" });
  const password = h("input", { name: "password", type: "password", autocomplete: "current-password", placeholder: "密码" });
  const form = h("form", {
    onsubmit: async (event) => {
      event.preventDefault();
      await withBusy(async () => {
        const result = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ username: username.value, password: password.value }),
        });
        state.user = result.user;
        await loadInitial();
        startPolling();
      });
    },
  }, [
    field("用户名", username),
    field("密码", password),
    h("button", { class: "btn btn--primary btn--lg btn--block", type: "submit", disabled: state.busy }, [
      state.busy ? icon("loader", { size: 18, cls: "spin" }) : null,
      h("span", { text: state.busy ? "正在登录…" : "登录" }),
    ]),
    h("div", { class: "error", text: state.error }),
  ]);
  return h("main", { class: "auth" }, [
    h("aside", { class: "auth__aside" }, [
      h("img", { class: "auth__logo", src: "/ubitech-logo.png", alt: "ubitech" }),
    ]),
    h("div", { class: "auth__main" }, [
      h("div", { class: "auth__card" }, [
        brand(),
        h("h1", { text: "登录" }),
        form,
      ]),
    ]),
  ]);
}

/* ---------------------------------------------------------------- shell */
function renderShell() {
  if (!isAdmin() && state.activeView === "admin") state.activeView = "channel";
  if (!hasPermission("private_agent") && state.activeView === "private") state.activeView = "channel";
  return h("div", { class: `shell ${state.sidebarOpen ? "is-open" : ""}` }, [
    renderSidebar(),
    h("div", { class: "scrim", onclick: closeSidebar }),
    h("main", { class: "main" }, [renderTopbar(), renderContent()]),
  ]);
}

function closeSidebar() { state.sidebarOpen = false; render(); }

function renderSidebar() {
  const navSpecs = [
    ["channel", "频道", "hash"],
    hasPermission("private_agent") ? ["private", "私人 Agent", "bot"] : null,
    ["knowledge", "知识库", "library"],
    isAdmin() ? ["admin", "管理面板", "shield"] : null,
  ].filter(Boolean);
  const navItems = navSpecs.map(([view, label, ic]) => navItem(view, label, ic));

  const channelName = h("input", { placeholder: "新频道名称", "aria-label": "新频道名称" });
  const channelButtons = state.channels.length
    ? state.channels.map((channel) =>
        h("button", {
          class: `channel ${state.activeView === "channel" && state.activeChannelId === channel.id ? "is-active" : ""}`,
          onclick: async () => {
            state.activeView = "channel";
            state.activeChannelId = channel.id;
            state._focusComposer = true;
            state.sidebarOpen = false;
            await withBusy(loadChannelMessages);
          },
        }, [h("span", { class: "channel__hash", text: "#" }), h("span", { class: "channel__name", text: channel.name })]))
    : [h("div", { class: "muted", style: "padding:4px 10px;font-size:12.5px", text: "暂无频道，创建一个开始协作。" })];

  return h("aside", { class: "sidebar" }, [
    h("div", { class: "sidebar__head" }, [brand()]),
    h("div", { class: "sidebar__scroll" }, [
      h("div", {}, [h("div", { class: "section-label", text: "工作区" }), h("nav", { class: "nav" }, navItems)]),
      h("div", {}, [
        h("div", { class: "section-label" }, [h("span", { text: "频道" }), h("span", { class: "nav__badge", text: String(state.channels.length) })]),
        h("div", { class: "channels" }, channelButtons),
        hasPermission("manage_channels") ? h("form", {
          class: "channel-create",
          onsubmit: async (event) => {
            event.preventDefault();
            if (!channelName.value.trim()) return;
            await withBusy(async () => {
              await api("/api/channels", { method: "POST", body: JSON.stringify({ name: channelName.value }) });
              channelName.value = "";
              await loadChannels();
            });
          },
        }, [channelName, h("button", { class: "icon-btn", type: "submit", title: "创建频道", "aria-label": "创建频道", style: "border:1px solid var(--line-strong)" }, [icon("plus", { size: 16 })])]) : null,
      ]),
    ]),
    renderSidebarFoot(),
  ]);
}

function navItem(view, label, iconName) {
  return h("button", {
    class: `nav__item ${state.activeView === view ? "is-active" : ""}`,
    onclick: async () => {
      state.activeView = view;
      state.sidebarOpen = false;
      if (view === "channel" || view === "private") state._focusComposer = true;
      if (view === "private") await withBusy(loadPrivateMessages);
      else if (view === "knowledge") await withBusy(loadDocuments);
      else if (view === "admin") await withBusy(loadAdminPanel);
      else render();
    },
  }, [icon(iconName), h("span", { class: "nav__label", text: label })]);
}

function renderSidebarFoot() {
  const name = state.user.display_name || state.user.username || "用户";
  const role = state.user.position || state.user.permission_group_label || (state.user.role || "member").toUpperCase();
  return h("div", { class: "sidebar__foot" }, [
    h("div", { class: "user" }, [
      h("div", { class: "avatar", text: initials(name) }),
      h("div", { class: "user__meta" }, [
        h("span", { class: "user__name", text: name }),
        h("span", { class: "user__role", text: role }),
      ]),
    ]),
    h("button", { class: "icon-btn", title: "退出登录", "aria-label": "退出登录", onclick: logout }, [icon("logout")]),
  ]);
}

function renderTopbar() {
  const info = topbarInfo();
  return h("header", { class: "topbar" }, [
    h("button", { class: "icon-btn menu-btn", title: "打开菜单", "aria-label": "打开菜单", onclick: () => { state.sidebarOpen = true; render(); } }, [icon("menu")]),
    h("div", { class: "topbar__title-wrap" }, [
      h("div", { class: "topbar__title" }, [
        info.hash ? h("span", { class: "hash", text: "#" }) : icon(info.icon, { size: 18, cls: "muted" }),
        h("span", { text: info.title }),
      ]),
      info.sub ? h("div", { class: "topbar__sub", text: info.sub }) : null,
    ]),
    h("div", { class: "topbar__actions" }, [themeToggle()]),
  ]);
}

function topbarInfo() {
  if (state.activeView === "private") {
    const active = agentStatusText(agentStatusFor("private"));
    return { title: "私人 Agent", icon: "bot", sub: active || "仅你可见的私有助手会话" };
  }
  if (state.activeView === "knowledge") return { title: "企业知识库", icon: "library", sub: `${state.documents.length} 篇文档` };
  if (state.activeView === "admin") return { title: "管理面板", icon: "shield", sub: activeAdminPage().description };
  const ch = activeChannel();
  const active = agentStatusText(agentStatusFor("channel"));
  return { title: ch?.name || "频道", hash: true, sub: ch ? (active || `${state.messages.length} 条消息`) : "选择或创建一个频道" };
}

function renderContent() {
  const animate = state._lastView !== state.activeView;
  state._lastView = state.activeView;
  let view;
  if (state.activeView === "private") view = renderChat("private");
  else if (state.activeView === "knowledge") view = renderKnowledge();
  else if (state.activeView === "admin") view = renderAdminPanel();
  else view = renderChat("channel");
  return h("section", { class: `content ${animate ? "view-enter" : ""}` }, [view]);
}

/* ----------------------------------------------------------------- chat */
function renderChat(mode) {
  const messages = mode === "private" ? state.privateMessages : state.messages;
  const noChannel = mode === "channel" && !state.activeChannelId;
  const canChat = hasPermission("chat") && (mode !== "private" || hasPermission("private_agent"));
  const scopeId = scopeIdFor(mode);
  const draftKey = composerDraftKey(mode, scopeId);
  const mentionMenu = h("div", { class: "mention-menu", role: "listbox", hidden: true });

  const input = h("textarea", {
    rows: 1,
    disabled: noChannel || !canChat,
    placeholder: noChannel
      ? "选择频道后发送消息"
      : canChat
      ? (mode === "private" ? "给你的私人 Agent 发消息…" : `在 #${activeChannel()?.name || "频道"} 发消息，@agent 呼叫 Agent…`)
      : "当前权限组只能查看内容",
    "aria-label": "消息输入框",
    oninput: (e) => {
      state.drafts[draftKey] = e.target.value;
      autoGrow(e.target);
      updateMentionMenu(input, mentionMenu, mode);
      if (!e.isComposing && !composerState.composing) notifyTyping(mode, scopeId, e.target.value.trim().length > 0);
    },
    onfocus: () => updateMentionMenu(input, mentionMenu, mode),
    onclick: () => updateMentionMenu(input, mentionMenu, mode),
    onkeyup: (e) => {
      if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) updateMentionMenu(input, mentionMenu, mode);
    },
    onblur: () => setTimeout(() => hideMentionMenu(mentionMenu), 120),
    oncompositionstart: () => {
      composerState.composing = true;
      hideMentionMenu(mentionMenu);
    },
    oncompositionend: (e) => {
      composerState.composing = false;
      state.drafts[draftKey] = e.target.value;
      autoGrow(e.target);
      notifyTyping(mode, scopeId, e.target.value.trim().length > 0);
      updateMentionMenu(input, mentionMenu, mode);
      flushDeferredRender();
    },
    onkeydown: (e) => {
      if (!e.isComposing && handleMentionKey(e, input, mentionMenu, mode, scopeId, draftKey)) return;
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    },
  });
  input.value = state.drafts[draftKey] || "";

  const submit = async () => {
    if (composerState.composing) return;
    const content = (state.drafts[draftKey] || input.value).trim();
    if (!content || noChannel || !canChat) return;
    input.value = "";
    state.drafts[draftKey] = "";
    autoGrow(input);
    state._focusComposer = true;
    state._scrollChatToBottom = true;
    notifyTyping(mode, scopeId, false);
    await postChatMessage(mode, scopeId, content);
  };

  let body;
  if (noChannel) {
    body = emptyState("hash", "还没有频道", "在左侧创建一个频道，开始与团队和 Agent 协作。");
  } else if (!messages.length && !isAgentActive(agentStatusFor(mode))) {
    body = mode === "private"
      ? emptyState("bot", "开启你的私人 Agent", "这是仅你可见的助手。发送第一条消息试试看。")
      : emptyState("message", "暂无消息", "成为第一个在该频道发言的人。需要时 @agent。");
  } else {
    const items = messages.map(renderMessage);
    const status = agentStatusFor(mode);
    if (isAgentActive(status)) {
      items.push(renderAgentActivity(status));
      const streamingMessage = agentStreamingMessage(status, mode);
      if (streamingMessage) items.push(renderMessage(streamingMessage));
    }
    if (mode === "channel" && state.typingUsers.length) items.push(renderTypingUsers(state.typingUsers));
    body = h("div", { class: "messages__inner" }, items);
  }

  return h("div", { class: "chat" }, [
    h("div", { class: "messages", "data-chat-key": `${scopeTypeFor(mode)}:${scopeId}` }, [body]),
    h("form", { class: "composer", onsubmit: (e) => { e.preventDefault(); submit(); } }, [
      h("div", { class: "composer__wrap" }, [
        h("div", { class: "composer__field" }, [
          input,
          mentionMenu,
          h("button", { class: "btn btn--primary composer__send", type: "submit", title: "发送 (Enter)", "aria-label": "发送", disabled: noChannel || !canChat }, [
            icon("send", { size: 18 }),
          ]),
        ]),
        h("div", { class: "composer__hint" }, [
          h("span", { class: "kbd", text: "Enter" }), h("span", { text: "发送" }),
          h("span", { class: "kbd", text: "Shift+Enter" }), h("span", { text: "换行" }),
        ]),
      ]),
    ]),
  ]);
}

function renderMessage(message) {
  const isUser = message.author_type === "user";
  const suggestions = message.metadata?.knowledge_suggestions || [];
  const agentWork = message.metadata?.agent_work || null;
  const streaming = !!message.metadata?.streaming;
  const avatar = isUser
    ? h("div", { class: "msg__avatar", text: initials(message.username || "你") })
    : h("div", { class: "msg__avatar" }, [icon("bot", { size: 18 })]);
  const pending = message.metadata?.local_pending;
  return h("article", { class: `msg msg--${message.author_type} ${pending ? "msg--pending" : ""} ${streaming ? "msg--streaming" : ""}` }, [
    avatar,
    h("div", { class: "msg__bubble" }, [
      h("div", { class: "msg__meta" }, [
        h("span", { class: "msg__name", text: message.username || (isUser ? "你" : "Agent") }),
        pending ? h("span", { class: "msg__pending", text: "发送中" }) : null,
        streaming ? h("span", { class: "msg__pending", text: "生成中" }) : null,
        h("span", { class: "msg__time", text: formatTime(message.created_at) }),
      ]),
      h("div", { class: "msg__body", text: message.content }),
      suggestions.length
        ? h("div", { class: "msg__suggest" }, suggestions.map((s) =>
            h("span", { class: "chip" }, [h("span", { class: "chip__id", text: `kb:${s.id}` }), h("span", { text: s.title })])))
        : null,
      agentWork ? renderAgentWorkCard(agentWork, { active: false }) : null,
    ]),
  ]);
}

function renderAgentActivity(status) {
  return h("article", { class: "msg msg--agent msg--activity" }, [
    h("div", { class: "msg__avatar" }, [icon("bot", { size: 18 })]),
    renderAgentWorkCard(status, { active: true }),
  ]);
}

function agentStreamingMessage(status, mode) {
  const stream = status?.stream_message || null;
  const content = stream?.content || "";
  if (!content) return null;
  return {
    id: stream.id || `stream-${status.run_id || status.started_at || "agent"}`,
    scope_type: scopeTypeFor(mode),
    scope_id: scopeIdFor(mode),
    author_type: "agent",
    user_id: null,
    username: stream.username || (mode === "private" ? "Private Agent" : "Main Agent"),
    content,
    metadata: { streaming: true },
    created_at: stream.created_at || status.started_at || Math.floor(Date.now() / 1000),
  };
}

function renderAgentWorkCard(work, { active = false } = {}) {
  const text = active ? (agentStatusText(work) || "Agent 正在处理") : agentWorkTitle(work);
  const queuedCount = Number(work?.queued_count || 0);
  const waiting = active ? (work?.state === "replying" ? queuedCount : Math.max(0, queuedCount - 1)) : 0;
  const current = work?.current_step || (active ? text : "已完成");
  const runId = work?.run_id || `${work?.scope_type || "agent"}:${work?.scope_id || ""}:${work?.started_at || ""}`;
  const hasStoredExpansion = Object.prototype.hasOwnProperty.call(state.expandedAgentRuns, runId);
  const expanded = hasStoredExpansion ? !!state.expandedAgentRuns[runId] : active;
  const processLines = agentProcessLines(work);
  const lines = processLines.length ? processLines : [active ? "等待 Hermes Agent 运行过程" : "本次没有工具调用记录"];
  return h("details", { class: `agent-work ${active ? "agent-work--active" : "agent-work--complete"}`, open: expanded }, [
      h("summary", {
        class: "agent-work__summary",
        onclick: (event) => {
          event.preventDefault();
          state.expandedAgentRuns[runId] = !expanded;
          render();
        },
      }, [
        active
          ? h("div", { class: "typing__dots" }, [h("i"), h("i"), h("i")])
          : h("div", { class: "agent-work__done" }, [icon(work?.state === "error" ? "alert" : "checkCircle", { size: 15 })]),
        h("div", { class: "agent-work__main" }, [
          h("span", { class: "agent-work__title", text }),
          h("span", { class: "agent-work__step", text: active ? current : `${processLines.length} 条工作记录` }),
        ]),
        waiting > 0 ? h("span", { class: "agent-status__queue", text: `另有 ${waiting} 条等待` }) : null,
      ]),
      h("div", { class: "agent-work__log" }, lines.map((line) => h("div", { class: "agent-work__line", text: line }))),
  ]);
}

function agentWorkTitle(work) {
  if (work?.state === "error") return "Agent 工作过程失败";
  return `查看 Agent 工作过程`;
}

function agentProcessLines(work) {
  const steps = work?.activity || [];
  return steps.filter(isAgentProcessStep).map((step) => step.line || agentStepLine(step)).filter(Boolean);
}

function isAgentProcessStep(step) {
  const stage = String(step?.stage || "").toLowerCase();
  return step?.source === "hermes" || stage === "tool" || stage.startsWith("tool.") || !!step?.tool;
}

function agentStepLine(step) {
  const stage = String(step?.stage || "").toLowerCase();
  const label = step?.label || step?.stage || "处理中";
  const detail = step?.detail || "";
  if (stage === "tool") return `${step?.emoji || "⚙️"} ${step?.tool || label}${detail ? `: "${detail}"` : "..."}`;
  if (stage === "complete") return `✅ ${label}`;
  if (stage === "error") return `⚠️ ${label}${detail ? `: ${detail}` : ""}`;
  if (stage === "queued") return `⏳ ${label}`;
  if (stage === "replying") return `💬 ${label}`;
  return `• ${label}${detail ? `: ${detail}` : ""}`;
}

function currentMentionRange(input) {
  const cursor = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, cursor);
  const match = before.match(/(^|[\s([{])@([A-Za-z0-9_.-]*)$/);
  if (!match) return null;
  const query = match[2] || "";
  return { start: before.length - query.length - 1, end: cursor, query: query.toLowerCase() };
}

function mentionOptions(query) {
  const targets = state.mentionTargets.length
    ? state.mentionTargets
    : [{ kind: "agent", handle: "agent", label: "Agent", description: "呼叫频道 Agent" }];
  return targets.filter((target) => {
    const haystack = `${target.handle || ""} ${target.label || ""} ${target.description || ""}`.toLowerCase();
    return !query || haystack.includes(query);
  }).slice(0, 8);
}

function updateMentionMenu(input, menu, mode) {
  if (mode !== "channel" || input.disabled || composerState.composing) {
    hideMentionMenu(menu);
    return;
  }
  const range = currentMentionRange(input);
  if (!range) {
    hideMentionMenu(menu);
    return;
  }
  const options = mentionOptions(range.query);
  if (!options.length) {
    hideMentionMenu(menu);
    return;
  }
  const previousQuery = mentionState.range?.query;
  mentionState.active = true;
  mentionState.selected = previousQuery === range.query ? Math.min(mentionState.selected, options.length - 1) : 0;
  mentionState.options = options;
  mentionState.range = range;
  mentionState.menu = menu;
  renderMentionMenu(input, menu);
}

function renderMentionMenu(input, menu) {
  const options = mentionState.options || [];
  menu.replaceChildren(...options.map((option, index) =>
    h("button", {
      class: `mention-option ${index === mentionState.selected ? "is-active" : ""}`,
      type: "button",
      role: "option",
      "aria-selected": index === mentionState.selected,
      onmousedown: (event) => {
        event.preventDefault();
        mentionState.selected = index;
        applyMention(input, menu);
      },
      onmouseenter: () => {
        mentionState.selected = index;
        renderMentionMenu(input, menu);
      },
    }, [
      h("span", { class: `mention-option__avatar mention-option__avatar--${option.kind || "user"}`, text: option.kind === "agent" ? "A" : initials(option.label || option.handle) }),
      h("span", { class: "mention-option__main" }, [
        h("span", { class: "mention-option__label", text: option.label || option.handle }),
        h("span", { class: "mention-option__meta", text: `@${option.handle}` }),
      ]),
      option.description ? h("span", { class: "mention-option__desc", text: option.description }) : null,
    ])
  ));
  menu.hidden = false;
}

function handleMentionKey(event, input, menu, mode, scopeId, draftKey) {
  if (mode !== "channel") return false;
  if (!mentionState.active || mentionState.menu !== menu) updateMentionMenu(input, menu, mode);
  if (!mentionState.active || mentionState.menu !== menu) return false;
  const options = mentionState.options || [];
  if (!options.length) return false;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    mentionState.selected = (mentionState.selected + 1) % options.length;
    renderMentionMenu(input, menu);
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    mentionState.selected = (mentionState.selected - 1 + options.length) % options.length;
    renderMentionMenu(input, menu);
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    applyMention(input, menu, scopeId, draftKey);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    hideMentionMenu(menu);
    return true;
  }
  return false;
}

function applyMention(input, menu, scopeId = scopeIdFor("channel"), draftKey = composerDraftKey("channel", scopeId)) {
  const option = mentionState.options[mentionState.selected];
  const range = mentionState.range || currentMentionRange(input);
  if (!option || !range) return;
  const insert = `@${option.handle} `;
  const next = `${input.value.slice(0, range.start)}${insert}${input.value.slice(range.end)}`;
  const cursor = range.start + insert.length;
  input.value = next;
  state.drafts[draftKey] = next;
  autoGrow(input);
  notifyTyping("channel", scopeId, next.trim().length > 0);
  hideMentionMenu(menu);
  input.focus();
  input.setSelectionRange(cursor, cursor);
}

function hideMentionMenu(menu) {
  if (menu) {
    menu.hidden = true;
    menu.replaceChildren();
  }
  mentionState.active = false;
  mentionState.selected = 0;
  mentionState.options = [];
  mentionState.range = null;
  if (!menu || mentionState.menu === menu) mentionState.menu = null;
}

function renderTypingUsers(users) {
  const names = users.map((item) => item.username).filter(Boolean).slice(0, 3).join("、");
  return h("div", { class: "typing-line" }, [
    h("span", { text: `${names || "有人"} 正在输入` }),
    h("div", { class: "typing__dots" }, [h("i"), h("i"), h("i")]),
  ]);
}

function autoGrow(el, { animate = true } = {}) {
  if (!el) return;
  const previousHeight = el.getBoundingClientRect().height;
  el.style.height = "auto";
  const fullHeight = el.scrollHeight;
  const nextHeight = Math.min(fullHeight, 200);
  el.classList.toggle("is-scrollable", fullHeight > nextHeight + 1);

  if (!animate || !previousHeight || Math.abs(previousHeight - nextHeight) < 1) {
    el.style.height = nextHeight + "px";
    return;
  }

  el.style.height = previousHeight + "px";
  void el.offsetHeight;
  el.style.height = nextHeight + "px";
}

/* ------------------------------------------------------------ knowledge */
function renderKnowledge() {
  const canManage = hasPermission("manage_knowledge");
  const title = h("input", { placeholder: "标题" });
  const source = h("input", { placeholder: "来源（URL、系统名等）" });
  const summary = h("input", { placeholder: "摘要（可留空）" });
  const content = h("textarea", { placeholder: "正文内容…" });
  const search = h("input", { placeholder: "搜索标题或正文…", "aria-label": "搜索知识库" });

  const docCards = state.documents.length
    ? state.documents.map((doc) =>
        h("div", { class: "doc-card" }, [
          h("div", { class: "doc-card__title" }, [icon("doc"), h("span", { text: doc.title })]),
          doc.summary ? h("div", { class: "doc-card__summary", text: doc.summary }) : null,
          h("div", { class: "doc-card__actions" }, [
            h("button", {
              class: "btn btn--sm",
              onclick: async () => {
                await withBusy(async () => {
                  const result = await api(`/api/knowledge/documents/${doc.id}`);
                  state.selectedDocument = result.document;
                });
              },
            }, [icon("doc", { size: 14 }), h("span", { text: "查看正文" })]),
          ]),
        ]))
    : [emptyState("doc", "知识库为空", "在左侧表单中录入第一条企业知识。")];

  const sections = [];
  if (canManage) {
    sections.push(h("section", { class: "card" }, [
      cardHead("新增条目", "plus", { desc: "结构化录入企业知识，供 Agent 检索引用。" }),
      h("form", {
        onsubmit: async (event) => {
          event.preventDefault();
          await withBusy(async () => {
            await api("/api/knowledge/documents", {
              method: "POST",
              body: JSON.stringify({ title: title.value, source: source.value, summary: summary.value, content: content.value }),
            });
            title.value = source.value = summary.value = content.value = "";
            await loadDocuments();
            toast("已保存知识条目", { type: "ok", title: "完成" });
          });
        },
      }, [
        field("标题", title),
        field("来源", source),
        field("摘要", summary),
        field("正文", content),
        h("button", { class: "btn btn--primary", type: "submit", disabled: state.busy }, [icon("plus", { size: 16 }), h("span", { text: "保存条目" })]),
      ]),
    ]));
  }
  sections.push(h("section", { class: "card" }, [
    cardHead("条目库", "library", { extra: h("span", { class: "status", text: `${state.documents.length} docs` }) }),
    h("form", {
      onsubmit: async (event) => {
        event.preventDefault();
        await withBusy(async () => {
          const result = await api(`/api/knowledge/search?q=${encodeURIComponent(search.value)}`);
          state.documents = result.results;
        });
      },
    }, [h("div", { class: "search-field" }, [icon("search"), search])]),
    h("div", { class: "list" }, docCards),
    state.selectedDocument ? renderDocViewer() : null,
  ]));

  return h("div", { class: "panel" }, [
    h("div", { class: "panel__inner" }, [
      h("div", { class: `kb-grid ${canManage ? "" : "kb-grid--single"}` }, sections),
    ]),
  ]);
}

function renderDocViewer() {
  return h("div", { class: "doc-viewer" }, [
    h("div", { class: "doc-viewer__bar" }, [
      h("span", { class: "eyebrow", text: state.selectedDocument.title || "DOCUMENT" }),
      h("button", { class: "icon-btn", title: "关闭", "aria-label": "关闭文档", onclick: () => { state.selectedDocument = null; render(); } }, [icon("close", { size: 16 })]),
    ]),
    h("pre", { text: state.selectedDocument.content }),
  ]);
}

/* --------------------------------------------------------- admin panel */
function renderAdminPanel() {
  if (!isAdmin()) return emptyState("shield", "需要管理员权限", "请使用管理员账户登录后访问管理面板。");
  const page = activeAdminPage();
  return h("div", { class: "panel" }, [
    h("div", { class: "panel__inner admin-panel" }, [
      renderAdminPager(page.id),
      h("div", { class: `admin-page admin-page--${page.id}` }, [
        h("div", { class: "admin-page__head" }, [
          h("div", {}, [
            h("div", { class: "eyebrow", text: "管理分页" }),
            h("h2", { text: page.label }),
            h("p", { text: page.description }),
          ]),
          h("span", { class: "status", text: `${ADMIN_PAGES.findIndex((item) => item.id === page.id) + 1}/${ADMIN_PAGES.length}` }),
        ]),
        h("div", { class: "admin-page__content" }, renderAdminPageSections(page.id)),
      ]),
    ]),
  ]);
}

function activeAdminPage() {
  return ADMIN_PAGES.find((page) => page.id === state.activeAdminPage) || ADMIN_PAGES[0];
}

function renderAdminPager(activeId) {
  return h("nav", { class: "admin-pager", "aria-label": "管理面板分页" }, ADMIN_PAGES.map((page) => {
    const active = page.id === activeId;
    return h("button", {
      class: `admin-pager__item ${active ? "is-active" : ""}`,
      type: "button",
      "aria-current": active ? "page" : null,
      onclick: () => {
        state.activeAdminPage = page.id;
        render();
      },
    }, [
      icon(page.icon, { size: 16 }),
      h("span", { text: page.label }),
      adminPageBadge(page.id),
    ]);
  }));
}

function adminPageBadge(pageId) {
  const value = {
    accounts: state.users.length,
    model: state.oauthProviders?.providers?.length || 0,
    runtime: state.runtimes ? Object.keys(state.runtimes).length : 0,
    secrets: state.secrets.filter((secret) => !isOAuthSecret(secret.key)).length,
  }[pageId];
  return value ? h("span", { class: "admin-pager__badge", text: String(value) }) : null;
}

function renderAdminPageSections(pageId) {
  if (pageId === "accounts") return [renderAccountManagement()];
  if (pageId === "model") return [renderOAuthSettings(), renderHermesConfig()];
  if (pageId === "runtime") return [renderRuntimeSettings()];
  if (pageId === "hermes") return [renderHermesInternalConfig()];
  if (pageId === "cognee") return [renderCogneeInternalConfig()];
  if (pageId === "secrets") return [renderSecretsSettings()];
  return [renderAccountManagement()];
}

function renderAccountManagement() {
  const groups = state.permissionGroups.length ? state.permissionGroups : FALLBACK_PERMISSION_GROUPS;
  const username = h("input", { placeholder: "username", autocomplete: "off" });
  const displayName = h("input", { placeholder: "显示名称" });
  const password = h("input", { type: "password", autocomplete: "new-password", placeholder: "初始密码" });
  const position = h("input", { placeholder: "职位，例如 项目经理" });
  const permissionGroup = permissionGroupSelect(groups, "member");
  const modelName = h("input", { placeholder: state.hermesConfig?.config?.model || "默认模型" });
  const thinkingDepth = thinkingDepthSelect("medium");

  const createForm = h("form", {
    class: "account-create",
    onsubmit: async (event) => {
      event.preventDefault();
      await withBusy(async () => {
        await api("/api/users", {
          method: "POST",
          body: JSON.stringify({
            username: username.value,
            display_name: displayName.value,
            password: password.value,
            position: position.value,
            permission_group: permissionGroup.value,
            model_name: modelName.value,
            thinking_depth: thinkingDepth.value,
          }),
        });
        username.value = displayName.value = password.value = position.value = modelName.value = "";
        permissionGroup.value = "member";
        thinkingDepth.value = "medium";
        await loadUsers();
        toast("企业账户已创建", { type: "ok", title: "完成" });
      });
    },
  }, [
    h("div", { class: "account-create__grid" }, [
      field("用户名", username),
      field("显示名称", displayName),
      field("初始密码", password),
      field("职位", position),
      field("权限组", permissionGroup),
      field("模型型号", modelName),
      field("思考深度", thinkingDepth),
    ]),
    h("button", { class: "btn btn--primary", type: "submit", disabled: state.busy }, [icon("plus", { size: 16 }), h("span", { text: "创建账户" })]),
  ]);

  const rows = state.users.length
    ? state.users.map((user) => renderAccountRow(user, groups))
    : [h("div", { class: "muted", text: "暂无企业账户。" })];
  return h("section", { class: "card account-admin" }, [
    cardHead("企业账户", "users"),
    createForm,
    h("div", { class: "account-list" }, rows),
  ]);
}

function renderAccountRow(user, groups) {
  const displayName = h("input", { value: user.display_name || "" });
  const position = h("input", { value: user.position || "", placeholder: "职位" });
  const permissionGroup = permissionGroupSelect(groups, user.permission_group || "member");
  const modelName = h("input", { value: user.model_name || "", placeholder: state.hermesConfig?.config?.model || "默认模型" });
  const thinkingDepth = thinkingDepthSelect(user.thinking_depth || "medium");
  const active = h("input", { type: "checkbox" });
  active.checked = !!user.active;
  if (user.id === state.user.id) active.disabled = true;
  const password = h("input", { type: "password", autocomplete: "new-password", placeholder: "留空不修改" });
  return h("form", {
    class: "account-row",
    onsubmit: async (event) => {
      event.preventDefault();
      await withBusy(async () => {
        await api(`/api/users/${user.id}`, {
          method: "PUT",
          body: JSON.stringify({
            display_name: displayName.value,
            position: position.value,
            permission_group: permissionGroup.value,
            model_name: modelName.value,
            thinking_depth: thinkingDepth.value,
            active: active.checked,
            password: password.value,
          }),
        });
        password.value = "";
        await loadUsers();
        toast(`已更新 ${user.username}`, { type: "ok", title: "完成" });
      });
    },
  }, [
    h("div", { class: "account-row__head" }, [
      h("div", { class: "account-row__identity" }, [
        h("div", { class: "avatar", text: initials(user.display_name || user.username) }),
        h("div", {}, [
          h("strong", { text: user.username }),
          h("span", { text: user.permission_group_label || user.permission_group || "member" }),
        ]),
      ]),
      statusBadge(user.active, user.active ? "active" : "disabled"),
    ]),
    h("div", { class: "account-row__grid" }, [
      field("显示名称", displayName),
      field("职位", position),
      field("权限组", permissionGroup),
      field("模型型号", modelName),
      field("思考深度", thinkingDepth),
      field("重置密码", password),
      h("label", { class: "check-row account-row__active" }, [
        active,
        h("div", { class: "check-row__text" }, [h("strong", { text: "账户启用" }), h("span", { text: "停用后无法登录" })]),
      ]),
    ]),
    h("div", { class: "form-actions" }, [
      h("button", { class: "btn btn--primary btn--sm", type: "submit", disabled: state.busy }, [h("span", { text: "保存账户" })]),
    ]),
  ]);
}

function permissionGroupSelect(groups, selected) {
  const select = h("select", {}, groups.map((group) =>
    h("option", { value: group.id, text: group.label || group.id })));
  select.value = selected;
  return select;
}

function thinkingDepthSelect(selected) {
  const select = h("select", {}, THINKING_DEPTH_OPTIONS.map(([value, label]) =>
    h("option", { value, text: label })));
  select.value = selected;
  return select;
}

function renderRuntimeSettings() {
  const rows = state.runtimes
    ? Object.values(state.runtimes).map((runtime) =>
        h("div", { class: "runtime-row" }, [
          h("div", { class: "runtime-row__main" }, [
            h("div", { class: "runtime-row__title" }, [
              h("span", { class: `dot ${runtime.available ? "dot--pulse" : "dot--off"}` }),
              h("span", { class: "runtime-row__name", text: runtime.name }),
              statusBadge(runtime.available, runtime.state || (runtime.available ? "ready" : "down")),
            ]),
            h("div", { class: "runtime-row__detail", text: runtime.detail || runtime.error || runtime.path || "" }),
          ]),
          h("div", { class: "runtime-row__actions" }, [
            runtime.name === "hermes"
              ? h("button", { class: "btn btn--sm", disabled: state.busy, onclick: () => runHermesInstall() }, [icon("download", { size: 14 }), h("span", { text: "安装" })])
              : null,
            h("button", {
              class: "btn btn--sm",
              disabled: state.busy,
              onclick: async () => {
                await withBusy(async () => {
                  await api(`/api/system/runtime/${runtime.name}/restart`, { method: "POST", body: "{}" });
                  await loadSettings();
                });
              },
            }, [icon("refresh", { size: 14 }), h("span", { text: runtime.managed && runtime.name !== "cognee" ? "重启" : "刷新" })]),
          ]),
        ]))
    : [h("div", { class: "muted", text: "正在读取运行时状态…" })];
  return h("section", { class: "card" }, [
    cardHead("底层基座", "server", { desc: "平台托管的 Hermes / Cognee / Camofox / Firecrawl 运行时健康状态。" }),
    h("div", { class: "list" }, rows),
  ]);
}

async function runHermesInstall() {
  await withBusy(async () => {
    await api("/api/system/runtime/hermes/install", { method: "POST", body: "{}" });
    await loadSettings();
    toast("已触发 Hermes 安装", { type: "ok", title: "完成" });
  });
}

function renderHermesConfig() {
  const hermes = state.hermesConfig?.config || {};
  const manageHermes = h("input", { type: "checkbox" });
  manageHermes.checked = hermes.manage_hermes !== false;
  const repoPath = h("input", { value: hermes.repo_path || "" });
  const apiUrl = h("input", { value: hermes.api_url || "" });
  const provider = h("select", {}, [
    h("option", { value: "openai-codex", text: "Codex OAuth" }),
    h("option", { value: "xai-oauth", text: "Grok OAuth" }),
  ]);
  provider.value = ["openai-codex", "xai-oauth"].includes(hermes.provider) ? hermes.provider : "openai-codex";
  const providerBaseUrl = h("input", { value: hermes.provider_base_url || "", placeholder: "默认使用所选 OAuth 供应商 endpoint" });
  const model = h("input", { value: hermes.model || "" });
  const installExtras = h("input", { value: hermes.install_extras || "", placeholder: "可选，例如 dev" });
  const startupWait = h("input", { type: "number", min: "0", max: "120", step: "0.5", value: hermes.startup_wait_seconds ?? 8 });
  const timeoutSeconds = h("input", { type: "number", min: "1", max: "3600", step: "1", value: hermes.timeout_seconds ?? 240 });
  const apiKey = h("input", { type: "password", autocomplete: "off", placeholder: hermes.api_key_configured ? "保持不变" : "API server key" });

  return h("section", { class: "card config-form" }, [
    cardHead("Hermes 配置", "settings", { desc: "运行时来源、API 供应商与模型参数。" }),
    h("form", {
      onsubmit: async (event) => {
        event.preventDefault();
        await withBusy(async () => {
          await api("/api/system/hermes/config", {
            method: "PUT",
            body: JSON.stringify({
              manage_hermes: manageHermes.checked,
              repo_path: repoPath.value,
              api_url: apiUrl.value,
              provider: provider.value,
              provider_base_url: providerBaseUrl.value,
              model: model.value,
              install_extras: installExtras.value,
              startup_wait_seconds: startupWait.value,
              timeout_seconds: timeoutSeconds.value,
              api_key: apiKey.value,
            }),
          });
          apiKey.value = "";
          await loadSettings();
          toast("Hermes 配置已保存", { type: "ok", title: "完成" });
        });
      },
    }, [
      h("label", { class: "check-row" }, [
        manageHermes,
        h("div", { class: "check-row__text" }, [h("strong", { text: "由平台托管 Hermes" }), h("span", { text: "自动安装与管理运行时生命周期" })]),
      ]),
      h("div", { class: "config-grid" }, [
        h("div", { class: "field--full" }, [field("源码路径", repoPath)]),
        h("div", { class: "field--full" }, [field("API URL", apiUrl)]),
        field("API 供应商", provider),
        field("供应商 Base URL", providerBaseUrl),
        field("模型", model),
        field("安装 extras", installExtras),
        field("启动等待秒数", startupWait),
        field("请求超时秒数", timeoutSeconds),
        field("API Server Key", apiKey),
      ]),
      h("div", { class: "form-actions" }, [
        h("button", { class: "btn btn--primary", type: "submit", disabled: state.busy }, [h("span", { text: "保存配置" })]),
        h("button", { class: "btn", type: "button", disabled: state.busy, onclick: () => runHermesInstall() }, [icon("download", { size: 15 }), h("span", { text: "从源码重装" })]),
      ]),
    ]),
  ]);
}

function renderHermesInternalConfig() {
  const payload = state.hermesInternalConfig || {};
  const internal = payload.internal || {};
  const fields = internal.fields || [];
  const envFields = internal.env || [];
  const yaml = h("textarea", { class: "raw-config", spellcheck: "false", "aria-label": "Hermes config.yaml" });
  yaml.value = internal.yaml_text || "";
  return h("section", { class: "card config-software" }, [
    cardHead("Hermes 内部配置", "settings", { desc: internal.config_path || "config.yaml" }),
    internal.yaml_error ? h("div", { class: "config-warning", text: internal.yaml_error }) : null,
    renderConfigSections(internal.sections || []),
    renderConfigFieldsForm({
      fields,
      attr: "yamlKey",
      buttonText: "保存 Hermes 字段",
      onsubmit: async (updates) => {
        await withBusy(async () => {
          await api("/api/system/hermes/internal-config", { method: "PUT", body: JSON.stringify({ yaml_updates: updates }) });
          await loadHermesInternalConfig();
          toast("Hermes 内部配置已保存", { type: "ok", title: "完成" });
        });
      },
    }),
    h("form", {
      class: "raw-config-form",
      onsubmit: async (event) => {
        event.preventDefault();
        await withBusy(async () => {
          await api("/api/system/hermes/internal-config", { method: "PUT", body: JSON.stringify({ yaml_text: yaml.value }) });
          await loadHermesInternalConfig();
          toast("Hermes config.yaml 已保存", { type: "ok", title: "完成" });
        });
      },
    }, [
      h("div", { class: "section-label", text: "config.yaml" }),
      yaml,
      h("div", { class: "form-actions" }, [
        h("button", { class: "btn btn--primary", type: "submit", disabled: state.busy }, [h("span", { text: "保存 YAML" })]),
      ]),
    ]),
    renderConfigFieldsForm({
      fields: envFields,
      attr: "envKey",
      buttonText: "保存 Hermes 环境变量",
      onsubmit: async (updates) => {
        await withBusy(async () => {
          await api("/api/system/hermes/internal-config", { method: "PUT", body: JSON.stringify({ env: updates }) });
          await loadHermesInternalConfig();
          toast("Hermes .env 已保存", { type: "ok", title: "完成" });
        });
      },
    }),
  ]);
}

function renderCogneeInternalConfig() {
  const payload = state.cogneeConfig || {};
  const internal = payload.internal || {};
  return h("section", { class: "card config-software" }, [
    cardHead("Cognee 内部配置", "settings", { desc: internal.env_path || "Cognee .env" }),
    renderConfigFieldsForm({
      fields: internal.env || [],
      attr: "envKey",
      buttonText: "保存 Cognee 环境变量",
      onsubmit: async (updates) => {
        await withBusy(async () => {
          await api("/api/system/cognee/config", { method: "PUT", body: JSON.stringify({ env: updates }) });
          await loadCogneeConfig();
          await loadRuntime();
          toast("Cognee 内部配置已保存", { type: "ok", title: "完成" });
        });
      },
    }),
  ]);
}

function renderConfigSections(sections) {
  if (!sections.length) return null;
  return h("div", { class: "config-sections" }, sections.slice(0, 18).map((section) =>
    h("span", { class: "chip" }, [h("span", { class: "chip__id", text: section.key }), h("span", { text: section.detail })])));
}

function renderConfigFieldsForm({ fields, attr, buttonText, onsubmit }) {
  if (!fields.length) return h("div", { class: "muted", text: "正在读取配置…" });
  return h("form", {
    class: "config-fields-form",
    onsubmit: async (event) => {
      event.preventDefault();
      const updates = collectConfigUpdates(event.currentTarget, attr);
      if (!Object.keys(updates).length) return;
      await onsubmit(updates);
    },
  }, [
    h("div", { class: "config-groups" }, groupedConfigFields(fields, attr)),
    h("div", { class: "form-actions" }, [
      h("button", { class: "btn btn--primary", type: "submit", disabled: state.busy }, [h("span", { text: buttonText })]),
    ]),
  ]);
}

function groupedConfigFields(fields, attr) {
  const groups = {};
  for (const item of fields) {
    const group = item.group || "配置";
    groups[group] = groups[group] || [];
    groups[group].push(item);
  }
  return Object.entries(groups).map(([group, items], index) =>
    h("details", { class: "config-group", open: index < 2 }, [
      h("summary", {}, [h("span", { text: group }), h("span", { class: "nav__badge", text: String(items.length) })]),
      h("div", { class: "config-group__body" }, items.map((item) => renderConfigField(item, attr))),
    ]));
}

function renderConfigField(item, attr) {
  return h("label", { class: "config-field" }, [
    h("span", { class: "config-field__label" }, [
      h("strong", { text: item.label || item.key }),
      h("code", { text: item.key }),
    ]),
    configFieldControl(item, attr),
  ]);
}

function configFieldControl(item, attr) {
  const dataAttr = attr === "yamlKey" ? "data-yaml-key" : "data-env-key";
  const common = { [dataAttr]: item.key };
  if (item.kind === "boolean") {
    const select = h("select", common, [
      h("option", { value: "", text: "未设置" }),
      h("option", { value: "true", text: "true" }),
      h("option", { value: "false", text: "false" }),
    ]);
    if (item.configured) select.value = String(item.value === true || String(item.value).toLowerCase() === "true");
    select.dataset.initial = select.value;
    return select;
  }
  if (item.options?.length) {
    const select = h("select", common, [
      h("option", { value: "", text: "未设置" }),
      ...item.options.map((option) => h("option", { value: option, text: option })),
    ]);
    select.value = item.configured ? String(item.value ?? "") : "";
    select.dataset.initial = select.value;
    return select;
  }
  if (item.kind === "json") {
    const textarea = h("textarea", { ...common, spellcheck: "false" });
    textarea.value = item.configured ? String(item.value ?? "") : "";
    textarea.dataset.initial = textarea.value;
    return textarea;
  }
  const attrs = {
    ...common,
    type: item.secret ? "password" : item.kind === "number" ? "number" : "text",
    autocomplete: "off",
    placeholder: item.secret && item.configured ? item.masked : "",
  };
  const input = h("input", attrs);
  if (!item.secret && item.configured) input.value = String(item.value ?? "");
  input.dataset.initial = input.value;
  return input;
}

function collectConfigUpdates(form, attr) {
  const selector = attr === "yamlKey" ? "[data-yaml-key]" : "[data-env-key]";
  const keyAttr = attr === "yamlKey" ? "yamlKey" : "envKey";
  const updates = {};
  form.querySelectorAll(selector).forEach((control) => {
    const key = control.dataset[keyAttr];
    if (!key) return;
    const value = control.value;
    if (value === control.dataset.initial) return;
    if (control.type === "password" && !value) return;
    if (attr === "envKey" && value === "") return;
    updates[key] = value;
  });
  return updates;
}

function renderSecretsSettings() {
  const rows = state.secrets.filter((secret) => !isOAuthSecret(secret.key)).map((secret) => {
    const input = h("input", { type: "password", autocomplete: "off", placeholder: secret.configured ? secret.masked : "未配置" });
    return h("div", { class: "secret-row" }, [
      h("div", { class: "secret-row__key" }, [icon("key"), h("span", { class: "secret-row__name", text: secret.key })]),
      h("span", { class: "secret-row__val", text: secret.configured ? secret.masked : "empty" }),
      h("form", {
        onsubmit: async (event) => {
          event.preventDefault();
          await withBusy(async () => {
            await api(`/api/settings/secrets/${secret.key}`, { method: "PUT", body: JSON.stringify({ value: input.value }) });
            input.value = "";
            await loadSecrets();
            toast(`已更新 ${secret.key}`, { type: "ok", title: "完成" });
          });
        },
      }, [input, h("button", { class: "btn btn--sm", type: "submit", text: "设置" })]),
    ]);
  });
  return h("section", { class: "card" }, [
    cardHead("平台内部密钥", "key", { desc: "手动配置的平台级密钥，OAuth 凭据在上方管理。" }),
    rows.length ? h("div", { class: "list" }, rows) : h("div", { class: "muted", text: "暂无可手动配置的内部密钥。" }),
  ]);
}

/* ---------------------------------------------------------------- oauth */
function renderOAuthSettings() {
  const providers = state.oauthProviders?.providers || [];
  return h("section", { class: "card" }, [
    cardHead("API 供应商验证", "shield", { desc: "通过 OAuth 授权模型供应商，验证后 Hermes 自动切换。" }),
    providers.length
      ? h("div", { class: "oauth-grid" }, providers.map(renderOAuthProviderCard))
      : h("div", { class: "muted", text: "未发现可验证的供应商。" }),
  ]);
}

function renderOAuthProviderCard(provider) {
  const flow = state.oauthFlows[provider.id];
  const callbackValue = state.oauthCallbackUrls[provider.id] || "";
  const header = h("div", { class: "oauth-card__head" }, [
    h("div", { class: "oauth-card__id" }, [
      h("div", { class: "oauth-card__logo" }, [h("strong", { class: "mono", text: (provider.label || "?").trim().charAt(0) })]),
      h("div", {}, [
        h("div", { class: "oauth-card__label", text: provider.label }),
        provider.model ? h("div", { class: "oauth-card__model", text: provider.model }) : null,
      ]),
    ]),
    statusBadge(!!provider.configured, provider.configured ? "已验证" : "未验证"),
  ]);
  const meta = h("div", { class: "oauth-meta" }, [
    provider.active ? h("span", { class: "chip" }, [h("span", { class: "dot" }), document.createTextNode("使用中")]) : null,
    provider.last_refresh ? h("span", { class: "muted", style: "font-size:12px", text: `更新于 ${formatTimestamp(provider.last_refresh)}` }) : null,
  ]);
  const startButton = h("button", {
    class: provider.configured ? "btn btn--sm" : "btn btn--primary btn--sm",
    disabled: state.busy,
    onclick: async () => startOAuthVerification(provider.id),
  }, [icon("shield", { size: 14 }), h("span", { text: provider.configured ? "重新验证" : "开始验证" })]);

  const children = [header, meta, h("div", { class: "oauth-actions" }, [startButton])];
  if (flow?.kind === "device_code") children.push(renderCodexOAuthFlow(provider.id, flow));
  else if (flow?.kind === "manual_callback") children.push(renderGrokOAuthFlow(provider.id, flow, callbackValue));
  if (flow?.complete) children.push(h("div", { class: "oauth-guide complete" }, [icon("checkCircle", { size: 16 }), h("span", { text: "验证完成，Hermes 已切换到该供应商。" })]));
  return h("div", { class: `oauth-card ${provider.active ? "is-active" : ""}` }, children);
}

function renderCodexOAuthFlow(providerId, flow) {
  return h("div", { class: "oauth-guide" }, [
    h("div", { class: "oauth-line" }, [
      h("span", { text: "验证页" }),
      h("a", { href: flow.verification_url, target: "_blank", rel: "noreferrer" }, [h("span", { text: flow.verification_url }), icon("external", { size: 13 })]),
    ]),
    h("div", { class: "oauth-code", text: flow.user_code }),
    h("div", { class: "oauth-actions" }, [
      h("button", { class: "btn btn--sm", disabled: state.busy, onclick: async () => pollOAuthVerification(providerId, flow.flow_id) }, [icon("refresh", { size: 14 }), h("span", { text: "检查状态" })]),
      h("span", { class: "muted", style: "font-size:12px", text: `状态：${oauthStatusLabel(flow.status)}` }),
    ]),
  ]);
}

function renderGrokOAuthFlow(providerId, flow, callbackValue) {
  const callbackInput = h("textarea", {
    placeholder: "粘贴浏览器跳转后的完整 callback URL",
    oninput: (event) => { state.oauthCallbackUrls[providerId] = event.target.value; },
  });
  callbackInput.value = callbackValue;
  return h("div", { class: "oauth-guide" }, [
    h("div", { class: "oauth-line" }, [
      h("span", { text: "授权页" }),
      h("a", { href: flow.authorize_url, target: "_blank", rel: "noreferrer" }, [h("span", { text: "打开 Grok OAuth" }), icon("external", { size: 13 })]),
    ]),
    h("div", { class: "oauth-line" }, [h("span", { text: "回调地址" }), h("code", { text: flow.redirect_uri })]),
    callbackInput,
    h("div", { class: "oauth-actions" }, [
      h("button", { class: "btn btn--primary btn--sm", disabled: state.busy, onclick: async () => completeOAuthVerification(providerId, flow.flow_id) }, [icon("checkCircle", { size: 14 }), h("span", { text: "完成验证" })]),
      h("span", { class: "muted", style: "font-size:12px", text: `状态：${oauthStatusLabel(flow.status)}` }),
    ]),
  ]);
}

/* --------------------------------------------------------------- helpers */
function isOAuthSecret(key) { return key.includes("_OAUTH_"); }
function oauthStatusLabel(status) {
  return ({ waiting_for_user: "等待网页登录", waiting_for_callback: "等待回调 URL", complete: "已完成" })[status] || status || "等待中";
}
function initials(name) {
  const s = String(name || "?").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/);
  if (parts.length >= 2 && /[a-zA-Z]/.test(s)) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
function formatTime(value) {
  if (!value) return "";
  const d = new Date(value * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function formatTimestamp(value) {
  if (!value) return "";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}
function activeChannel() { return state.channels.find((c) => c.id === state.activeChannelId); }
function scopeTypeFor(mode) { return mode === "private" ? "private" : "channel"; }
function scopeIdFor(mode, channelId = state.activeChannelId) {
  return mode === "private" ? String(state.user?.id || "") : String(channelId || "");
}
function composerDraftKey(mode, scopeId = scopeIdFor(mode)) {
  return `${scopeTypeFor(mode)}:${scopeId}`;
}
function agentStatusFor(mode, channelId = state.activeChannelId) {
  if (mode === "private") return state.agentStatuses.private;
  return state.agentStatuses.channels[String(channelId || "")] || null;
}
function setAgentStatus(mode, scopeId, status) {
  if (!status) return;
  if (mode === "private") state.agentStatuses.private = status;
  else state.agentStatuses.channels[String(scopeId)] = status;
}
function isAgentActive(status) {
  return status && (status.state === "queued" || status.state === "replying");
}
function agentStatusText(status) {
  if (!isAgentActive(status)) return "";
  const target = status.replying_to?.username || "用户";
  return status.state === "queued" ? `Agent 准备回复 ${target}` : `Agent 正在回复 ${target}`;
}
function messageFingerprint(message) {
  const work = message.metadata?.agent_work || null;
  return {
    id: message.id,
    author_type: message.author_type,
    user_id: message.user_id,
    username: message.username,
    content: message.content,
    created_at: message.created_at,
    pending: !!message.metadata?.local_pending,
    agent_work: work
      ? {
          run_id: work.run_id,
          state: work.state,
          current_step: work.current_step || "",
          activity: (work.activity || []).map((item) => `${item.source || ""}:${item.stage}:${item.label}:${item.detail}:${item.line || ""}:${item.tool_status || ""}:${item.at}`),
        }
      : null,
  };
}
function agentStatusFingerprint(status) {
  if (!status) return null;
  return {
    run_id: status.run_id || "",
    state: status.state,
    queued_count: status.queued_count || 0,
    current_step: status.current_step || "",
    activity: (status.activity || []).map((item) => `${item.source || ""}:${item.stage}:${item.label}:${item.detail}:${item.line || ""}:${item.tool_status || ""}:${item.at}`),
    stream_message: status.stream_message
      ? {
          id: status.stream_message.id,
          content: status.stream_message.content || "",
          updated_at: status.stream_message.updated_at || 0,
        }
      : null,
    replying_to: status.replying_to
      ? {
          id: status.replying_to.id,
          username: status.replying_to.username,
          content: status.replying_to.content,
          created_at: status.replying_to.created_at,
        }
      : null,
  };
}
function chatSnapshot(mode, scopeId = scopeIdFor(mode)) {
  const messages = mode === "private" ? state.privateMessages : state.messages;
  return JSON.stringify({
    scope: `${scopeTypeFor(mode)}:${scopeId || ""}`,
    messages: messages.map(messageFingerprint),
    agent: agentStatusFingerprint(agentStatusFor(mode, scopeId)),
    typing: mode === "channel" ? state.typingUsers.map((item) => ({ user_id: item.user_id, username: item.username })) : [],
  });
}
function mergePendingMessages(mode, scopeId, messages) {
  const pending = state.pendingMessages.filter((message) => message.scope_type === scopeTypeFor(mode) && message.scope_id === String(scopeId));
  return [...messages, ...pending];
}
function appendOptimisticMessage(mode, scopeId, content) {
  const message = {
    id: `tmp-${++localMessageSeq}`,
    scope_type: scopeTypeFor(mode),
    scope_id: String(scopeId),
    author_type: "user",
    user_id: state.user?.id || null,
    username: state.user?.display_name || state.user?.username || "你",
    content,
    metadata: { local_pending: true },
    created_at: Math.floor(Date.now() / 1000),
  };
  state.pendingMessages.push(message);
  if (mode === "private") state.privateMessages = [...state.privateMessages, message];
  else if (String(state.activeChannelId) === String(scopeId)) state.messages = [...state.messages, message];
  return message;
}
function removeLocalMessage(list, id) {
  return list.filter((message) => message.id !== id);
}
function replaceOptimisticMessage(mode, scopeId, tempId, savedMessage) {
  state.pendingMessages = removeLocalMessage(state.pendingMessages, tempId);
  const apply = (messages) => {
    let next = removeLocalMessage(messages, tempId);
    if (savedMessage && !next.some((message) => message.id === savedMessage.id)) next = [...next, savedMessage];
    return next;
  };
  if (mode === "private") state.privateMessages = apply(state.privateMessages);
  else if (String(state.activeChannelId) === String(scopeId)) state.messages = apply(state.messages);
}
function removeOptimisticMessage(mode, scopeId, tempId) {
  state.pendingMessages = removeLocalMessage(state.pendingMessages, tempId);
  if (mode === "private") state.privateMessages = removeLocalMessage(state.privateMessages, tempId);
  else if (String(state.activeChannelId) === String(scopeId)) state.messages = removeLocalMessage(state.messages, tempId);
}
async function postChatMessage(mode, scopeId, content) {
  const pending = appendOptimisticMessage(mode, scopeId, content);
  render();
  try {
    const result = mode === "private"
      ? await api("/api/private-agent/messages", { method: "POST", body: JSON.stringify({ content }) })
      : await api(`/api/channels/${scopeId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
    replaceOptimisticMessage(mode, scopeId, pending.id, result.user_message);
    setAgentStatus(mode, scopeId, result.agent_status);
    await refreshActiveChat({ renderAfter: false });
  } catch (error) {
    removeOptimisticMessage(mode, scopeId, pending.id);
    const message = error.message || String(error);
    state.error = message;
    toast(message, { type: "error", title: "发送失败" });
  } finally {
    state._focusComposer = true;
    render();
  }
}
function notifyTyping(mode, scopeId, isTyping) {
  if (mode !== "channel" || !scopeId) return;
  const key = `channel:${scopeId}`;
  if (typingState.stopTimer) {
    clearTimeout(typingState.stopTimer);
    typingState.stopTimer = null;
  }
  if (!isTyping) {
    sendTypingState(key, false);
    return;
  }
  const now = Date.now();
  if (typingState.key !== key || !typingState.active || now - typingState.lastSent > 1800) {
    sendTypingState(key, true);
  }
  typingState.stopTimer = setTimeout(() => sendTypingState(key, false), 3500);
}
function sendTypingState(key, isTyping) {
  const channelId = key.replace(/^channel:/, "");
  typingState.key = key;
  typingState.active = isTyping;
  typingState.lastSent = Date.now();
  api(`/api/channels/${channelId}/typing`, {
    method: "POST",
    body: JSON.stringify({ typing: isTyping }),
  }).catch(() => {});
}

/* ---------------------------------------------------------------- loads */
async function loadInitial() {
  await Promise.all([loadChannels(), loadMentionTargets()]);
  await loadChannelMessages();
}
async function loadChannels() {
  const result = await api("/api/channels");
  state.channels = result.channels;
  if (!state.activeChannelId && state.channels.length) state.activeChannelId = state.channels[0].id;
}
async function loadMentionTargets() {
  try {
    const result = await api("/api/mention-targets");
    state.mentionTargets = result.targets || [];
  } catch (_) {
    state.mentionTargets = [];
  }
}
async function loadChannelMessages() {
  if (!state.activeChannelId) return;
  const channelId = String(state.activeChannelId);
  const result = await api(`/api/channels/${channelId}/messages`);
  if (String(state.activeChannelId) !== channelId) return;
  state.messages = mergePendingMessages("channel", channelId, result.messages || []);
  setAgentStatus("channel", channelId, result.agent_status);
  state.typingUsers = result.typing || [];
}
async function loadPrivateMessages() {
  const result = await api("/api/private-agent/messages");
  const scopeId = scopeIdFor("private");
  state.privateMessages = mergePendingMessages("private", scopeId, result.messages || []);
  setAgentStatus("private", scopeId, result.agent_status);
}
async function loadDocuments() {
  const result = await api("/api/knowledge/documents");
  state.documents = result.documents;
}
async function loadUsers() {
  const result = await api("/api/users");
  state.users = result.users;
}
async function loadPermissionGroups() {
  const result = await api("/api/permission-groups");
  state.permissionGroups = result.permission_groups;
}
async function loadSecrets() {
  const result = await api("/api/settings/secrets");
  state.secrets = result.secrets;
}
async function loadOAuthProviders() { state.oauthProviders = await api("/api/system/oauth/providers"); }
async function loadRuntime() { state.runtimes = await api("/api/system/runtime"); }
async function loadHermesConfig() { state.hermesConfig = await api("/api/system/hermes/config"); }
async function loadHermesInternalConfig() { state.hermesInternalConfig = await api("/api/system/hermes/internal-config"); }
async function loadCogneeConfig() { state.cogneeConfig = await api("/api/system/cognee/config"); }
async function loadSettings() { await Promise.all([loadSecrets(), loadRuntime(), loadHermesConfig(), loadHermesInternalConfig(), loadCogneeConfig(), loadOAuthProviders()]); }
async function loadAdminPanel() { await Promise.all([loadUsers(), loadPermissionGroups(), loadSettings()]); }
async function refreshActiveChat({ renderAfter = true } = {}) {
  if (!state.user || pollInFlight) return;
  const keepFocus = !!app.querySelector(".composer textarea:focus");
  const mode = state.activeView === "private" ? "private" : state.activeView === "channel" ? "channel" : "";
  const scopeId = mode ? scopeIdFor(mode) : "";
  const before = mode ? chatSnapshot(mode, scopeId) : "";
  pollInFlight = true;
  try {
    if (state.activeView === "channel" && state.activeChannelId) await loadChannelMessages();
    else if (state.activeView === "private") await loadPrivateMessages();
    else return;
    const changed = mode ? before !== chatSnapshot(mode, scopeId) : true;
    if (renderAfter && changed) {
      if (keepFocus) state._focusComposer = true;
      render();
    }
  } catch (_) {
    // Polling is best-effort; explicit user actions surface their own errors.
  } finally {
    pollInFlight = false;
  }
}
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => refreshActiveChat(), 600);
}
function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  if (typingState.stopTimer) {
    clearTimeout(typingState.stopTimer);
    typingState.stopTimer = null;
  }
  typingState.active = false;
}

/* ----------------------------------------------------------------- oauth */
async function startOAuthVerification(providerId) {
  await withBusy(async () => {
    const result = await api(`/api/system/oauth/${providerId}/start`, { method: "POST", body: "{}" });
    updateOAuthState(providerId, result);
    await loadHermesConfig();
  });
}
async function pollOAuthVerification(providerId, flowId) {
  await withBusy(async () => {
    const result = await api(`/api/system/oauth/${providerId}/poll`, { method: "POST", body: JSON.stringify({ flow_id: flowId }) });
    updateOAuthState(providerId, result);
    await loadHermesConfig();
  });
}
async function completeOAuthVerification(providerId, flowId) {
  await withBusy(async () => {
    const result = await api(`/api/system/oauth/${providerId}/complete`, {
      method: "POST",
      body: JSON.stringify({ flow_id: flowId, callback_url: state.oauthCallbackUrls[providerId] || "" }),
    });
    updateOAuthState(providerId, result);
    if (result.flow?.complete) state.oauthCallbackUrls[providerId] = "";
    await loadHermesConfig();
  });
}
function updateOAuthState(providerId, result) {
  state.oauthProviders = { providers: result.providers || [], active_provider: result.active_provider || providerId };
  if (result.flow) state.oauthFlows[providerId] = result.flow;
}

/* ---------------------------------------------------------------- session */
async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  stopPolling();
  state.user = null;
  state.sidebarOpen = false;
  state.pendingMessages = [];
  state.mentionTargets = [];
  state.typingUsers = [];
  hideMentionMenu();
  render();
}

async function withBusy(fn) {
  state.busy = true;
  state.error = "";
  render();
  try {
    await fn();
  } catch (error) {
    const message = error.message || String(error);
    state.error = message;
    if (state.user) toast(message, { type: "error", title: "操作失败" });
  } finally {
    state.busy = false;
    render();
  }
}

async function boot() {
  try {
    const result = await api("/api/auth/me");
    state.user = result.user;
    state._focusComposer = true;
    await loadInitial();
    startPolling();
  } catch (_) {
    state.user = null;
    stopPolling();
  }
  render();
}

boot();
