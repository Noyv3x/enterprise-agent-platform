/* =====================================================================
   Enterprise Agent Platform — application shell
   React/Vite-hosted legacy runtime. Full re-render on state change with
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
  draftFiles: {},
  agentStatuses: { channels: {}, private: null },
  expandedAgentRuns: {},
  mentionTargets: [],
  typingUsers: [],
  documents: [],
  knowledgeSearch: { query: "", results: null },
  selectedDocument: null,
  users: [],
  permissionGroups: [],
  activeAdminPage: "accounts",
  messageAudit: {
    auditChannelId: null,
    channelMessages: [],
    channelTotal: 0,
    privateConversations: [],
    auditPrivateUserId: null,
    privateMessages: [],
    privateTotal: 0,
  },
  tokenUsage: null,
  tokenUsageDays: 30,
  secrets: [],
  runtimes: null,
  hermesConfig: null,
  telegramConfig: null,
  autoUpdateConfig: null,
  privateTelegram: null,
  privateTelegramExpanded: false,
  hermesInternalConfig: null,
  cogneeConfig: null,
  securityConfig: null,
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
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const typingState = { key: null, active: false, lastSent: 0, stopTimer: null };
const composerState = { composing: false, renderDeferred: false };
const mentionState = { active: false, selected: 0, options: [], range: null, menu: null, input: null };

/* ---------------------------------------------------------------- api */
async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const res = await fetch(path, {
    credentials: "include",
    headers: isForm ? (options.headers || {}) : { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data = {};
  if (text) {
    // The server always returns JSON, but a fronting proxy can emit an HTML
    // 502/504 page (or an HTML login redirect); don't blow up on those.
    try { data = JSON.parse(text); } catch (_) { data = {}; }
  }
  if (res.status === 401 && !options.skipAuthHandling) {
    handleSessionExpired();
  }
  if (!res.ok) {
    throw new Error(data.error || data.detail || `请求失败（${res.status}）`);
  }
  return data;
}

// Only http(s)/relative URLs (plus mailto/tel) are allowed as link targets so a
// compromised or unexpected backend value such as "javascript:..." cannot run
// when an anchor is clicked. src attributes additionally allow data:/blob: for
// inline image previews.
function safeUrl(value, { allowData = false } = {}) {
  // Strip control chars (incl. tab/newline/CR) first, so something like
  // "java\tscript:alert(1)" cannot smuggle a blocked scheme past the allow-list.
  const raw = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!raw) return "";
  if (/^(\/|\.|#|\?)/.test(raw)) return raw;
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (!match) return raw;
  const scheme = match[1].toLowerCase();
  // blob: is safe for links: such URLs are minted in-page by the app (OAuth
  // credential export, optimistic attachment previews), never backend-supplied.
  // data: is permitted only for src (images), never for href (data:text/html).
  const allowed = allowData ? ["http", "https", "blob", "data"] : ["http", "https", "mailto", "tel", "blob"];
  return allowed.includes(scheme) ? raw : "";
}

/* ------------------------------------------------------ DOM builders */
function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "href") { const safe = safeUrl(value); if (safe) node.setAttribute("href", safe); }
    else if (key === "src" || key === "xlink:href") { const safe = safeUrl(value, { allowData: true }); if (safe) node.setAttribute(key, safe); }
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
  upload: [["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }], ["path", { d: "M17 8l-5-5-5 5" }], ["line", { x1: 12, y1: 3, x2: 12, y2: 15 }]],
  paperclip: [["path", { d: "M21.4 11.6 12 21a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7L9.2 18.2a2 2 0 0 1-2.8-2.8l9.2-9.2" }]],
  close: [["line", { x1: 18, y1: 6, x2: 6, y2: 18 }], ["line", { x1: 6, y1: 6, x2: 18, y2: 18 }]],
  menu: [["line", { x1: 3, y1: 6, x2: 21, y2: 6 }], ["line", { x1: 3, y1: 12, x2: 21, y2: 12 }], ["line", { x1: 3, y1: 18, x2: 21, y2: 18 }]],
  external: [["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }], ["path", { d: "M15 3h6v6" }], ["line", { x1: 10, y1: 14, x2: 21, y2: 3 }]],
  loader: [["line", { x1: 12, y1: 2, x2: 12, y2: 6 }], ["line", { x1: 12, y1: 18, x2: 12, y2: 22 }], ["line", { x1: 4.9, y1: 4.9, x2: 7.8, y2: 7.8 }], ["line", { x1: 16.2, y1: 16.2, x2: 19.1, y2: 19.1 }], ["line", { x1: 2, y1: 12, x2: 6, y2: 12 }], ["line", { x1: 18, y1: 12, x2: 22, y2: 12 }], ["line", { x1: 4.9, y1: 19.1, x2: 7.8, y2: 16.2 }], ["line", { x1: 16.2, y1: 7.8, x2: 19.1, y2: 4.9 }]],
  key: [["circle", { cx: 7.5, cy: 15.5, r: 3.5 }], ["path", { d: "M10 13l9-9" }], ["path", { d: "M18 5l2 2" }], ["path", { d: "M15 8l2 2" }]],
  server: [["rect", { x: 3, y: 4, width: 18, height: 7, rx: 1.6 }], ["rect", { x: 3, y: 13, width: 18, height: 7, rx: 1.6 }], ["line", { x1: 7, y1: 7.5, x2: 7.01, y2: 7.5 }], ["line", { x1: 7, y1: 16.5, x2: 7.01, y2: 16.5 }]],
  shield: [["path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }], ["path", { d: "M9 12l2 2 4-4" }]],
  doc: [["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }], ["path", { d: "M14 2v6h6" }], ["line", { x1: 8, y1: 13, x2: 16, y2: 13 }], ["line", { x1: 8, y1: 17, x2: 13, y2: 17 }]],
  image: [["rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ["circle", { cx: 8.5, cy: 10, r: 1.5 }], ["path", { d: "M21 15l-4.5-4.5L7 19" }]],
  message: [["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }]],
  barChart: [["line", { x1: 4, y1: 20, x2: 20, y2: 20 }], ["rect", { x: 6, y: 10, width: 3, height: 7, rx: 1 }], ["rect", { x: 11, y: 5, width: 3, height: 12, rx: 1 }], ["rect", { x: 16, y: 8, width: 3, height: 9, rx: 1 }]],
  trash: [["path", { d: "M3 6h18" }], ["path", { d: "M8 6V4h8v2" }], ["path", { d: "M19 6l-1 15H6L5 6" }], ["path", { d: "M10 11v6" }], ["path", { d: "M14 11v6" }]],
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
  { id: "tokens", label: "Token 监控", icon: "barChart", description: "按账户、私聊/频道、供应商和模型查看消耗。" },
  { id: "messages", label: "消息审计", icon: "message", description: "频道消息删除与私人 Agent 会话审计。" },
  { id: "model", label: "模型接入", icon: "shield", description: "OAuth 供应商验证与 Hermes API 参数。" },
  { id: "telegram", label: "Telegram", icon: "message", description: "Telegram 私聊网关与用户绑定状态。" },
  { id: "updates", label: "自动更新", icon: "refresh", description: "监听上游代码提交并自动拉取部署。" },
  { id: "security", label: "公网安全", icon: "key", description: "反向代理、Cookie 与启动安全项。" },
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

function svgNode(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.setAttribute("class", value);
    else if (key === "text") node.textContent = value;
    else if (value !== false && value != null) node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
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
  syncActiveAdminPager();
  syncScopeStream();
}
function syncActiveAdminPager() {
  if (state.activeView !== "admin" || !window.matchMedia("(max-width: 800px)").matches) return;
  const active = app.querySelector(".admin-pager__item.is-active");
  if (!active) return;
  active.scrollIntoView({ block: "nearest", inline: "center" });
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
  const username = h("input", { name: "username", autocomplete: "username", placeholder: "用户名" });
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
    h("div", { class: "error", role: "alert", text: state.error }),
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
    h("button", { class: "scrim", type: "button", "aria-label": "关闭菜单", tabindex: state.sidebarOpen ? "0" : "-1", onclick: closeSidebar }),
    h("main", { class: "main" }, [renderTopbar(), renderContent()]),
  ]);
}

// On mobile (<=800px) the sidebar slides off-canvas; expose that to AT/keyboard
// so its controls are not focusable while it is closed and off-screen.
function sidebarHiddenForA11y() {
  return !state.sidebarOpen && window.matchMedia("(max-width: 800px)").matches;
}

function openSidebar() {
  state.sidebarOpen = true;
  render();
  // Move focus into the drawer so screen-reader/keyboard focus follows the
  // disclosure. afterRender already runs on the next frame; do this after it.
  requestAnimationFrame(() => app.querySelector("#app-sidebar .nav__item")?.focus());
}

function closeSidebar() {
  const wasOpen = state.sidebarOpen;
  state.sidebarOpen = false;
  render();
  // Return focus to the control that opened the drawer.
  if (wasOpen) requestAnimationFrame(() => app.querySelector(".menu-btn")?.focus());
}

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

  const hidden = sidebarHiddenForA11y();
  return h("aside", { class: "sidebar", id: "app-sidebar", inert: hidden, "aria-hidden": hidden ? "true" : null }, [
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
  const actions = [
    state.activeView === "private" ? renderPrivateTelegramAction() : null,
    themeToggle(),
  ];
  return h("header", { class: "topbar" }, [
    h("button", { class: "icon-btn menu-btn", title: "打开菜单", "aria-label": "打开菜单", "aria-expanded": String(state.sidebarOpen), "aria-controls": "app-sidebar", onclick: openSidebar }, [icon("menu")]),
    h("div", { class: "topbar__title-wrap" }, [
      h("div", { class: "topbar__title" }, [
        info.hash ? h("span", { class: "hash", text: "#" }) : icon(info.icon, { size: 18, cls: "muted" }),
        h("span", { text: info.title }),
      ]),
      info.sub ? h("div", { class: "topbar__sub", text: info.sub }) : null,
    ]),
    h("div", { class: "topbar__actions" }, actions),
  ]);
}

function renderPrivateTelegramAction() {
  const payload = state.privateTelegram || {};
  const gateway = payload.gateway || {};
  const link = payload.link || {};
  const expanded = !!state.privateTelegramExpanded;
  const linked = !!link.telegram_user_id;
  const title = gateway.enabled
    ? linked ? "Telegram 私聊已绑定" : "配置 Telegram 私聊"
    : "Telegram 私聊未启用";
  return h("button", {
    class: `icon-btn private-telegram-trigger ${expanded ? "is-active" : ""} ${linked ? "is-linked" : ""}`,
    type: "button",
    title,
    "aria-label": "Telegram 私聊设置",
    "aria-expanded": expanded ? "true" : "false",
    "aria-controls": "private-telegram-popover",
    onclick: () => {
      state.privateTelegramExpanded = !expanded;
      render();
    },
  }, [icon("message")]);
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
  return h("section", { class: `content ${animate ? "view-enter" : ""}` }, [
    view,
    state.activeView === "private" && state.privateTelegramExpanded ? renderPrivateTelegramConfig() : null,
  ]);
}

/* ----------------------------------------------------------------- chat */
function renderChat(mode) {
  const messages = mode === "private" ? state.privateMessages : state.messages;
  const noChannel = mode === "channel" && !state.activeChannelId;
  const canChat = hasPermission("chat") && (mode !== "private" || hasPermission("private_agent"));
  const scopeId = scopeIdFor(mode);
  const draftKey = composerDraftKey(mode, scopeId);
  const selectedFiles = state.draftFiles[draftKey] || [];
  const mentionMenuId = `mention-menu-${scopeTypeFor(mode)}-${scopeId}`;
  const mentionMenu = h("div", { class: "mention-menu", role: "listbox", id: mentionMenuId, hidden: true });
  const fileInput = h("input", {
    class: "composer__file-input",
    type: "file",
    multiple: true,
    tabindex: "-1",
    onchange: (event) => {
      const incoming = Array.from(event.target.files || []);
      event.target.value = "";
      if (!incoming.length) return;
      addDraftFiles(draftKey, incoming);
    },
  });

  const input = h("textarea", {
    rows: 1,
    disabled: noChannel || !canChat,
    placeholder: noChannel
      ? "选择频道后发送消息"
      : canChat
      ? (mode === "private" ? "给你的私人 Agent 发消息…" : `在 #${activeChannel()?.name || "频道"} 发消息，@agent 呼叫 Agent…`)
      : "当前权限组只能查看内容",
    "aria-label": "消息输入框",
    role: mode === "channel" ? "combobox" : null,
    "aria-haspopup": mode === "channel" ? "listbox" : null,
    "aria-autocomplete": mode === "channel" ? "list" : null,
    "aria-controls": mode === "channel" ? mentionMenuId : null,
    "aria-expanded": mode === "channel" ? "false" : null,
    oninput: (e) => {
      state.drafts[draftKey] = e.target.value;
      autoGrow(e.target);
      updateMentionMenu(input, mentionMenu, mode);
      if (!e.isComposing && !composerState.composing) notifyTyping(mode, scopeId, e.target.value.trim().length > 0);
    },
    onfocus: () => updateMentionMenu(input, mentionMenu, mode),
    onclick: () => updateMentionMenu(input, mentionMenu, mode),
    onpaste: (e) => {
      const images = clipboardImageFiles(e.clipboardData);
      if (!images.length) return;
      e.preventDefault();
      addDraftFiles(draftKey, images);
    },
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
    const files = state.draftFiles[draftKey] || [];
    if ((!content && !files.length) || noChannel || !canChat) return;
    input.value = "";
    state.drafts[draftKey] = "";
    delete state.draftFiles[draftKey];
    autoGrow(input);
    state._focusComposer = true;
    state._scrollChatToBottom = true;
    notifyTyping(mode, scopeId, false);
    const sent = await postChatMessage(mode, scopeId, content, files);
    if (!sent) {
      // Send failed: restore the user's typed text and files so nothing is lost,
      // then refocus the composer (postChatMessage's finally already re-rendered
      // with the draft cleared, so we must render again after restoring state).
      state.drafts[draftKey] = content;
      if (files.length) state.draftFiles[draftKey] = files;
      state._focusComposer = true;
      render();
    }
  };

  let body;
  if (noChannel) {
    body = emptyState("hash", "还没有频道", "在左侧创建一个频道，开始与团队和 Agent 协作。");
  } else if (!messages.length && !isAgentActive(agentStatusFor(mode)) && agentStatusFor(mode)?.state !== "error") {
    body = mode === "private"
      ? emptyState("bot", "开启你的私人 Agent", "这是仅你可见的助手。发送第一条消息试试看。")
      : emptyState("message", "暂无消息", "成为第一个在该频道发言的人。需要时 @agent。");
  } else {
    const items = messages.map(renderMessage);
    const status = agentStatusFor(mode);
    if (isAgentActive(status)) {
      items.push(hasAgentProcessSteps(status) ? renderAgentActivity(status) : renderAgentTyping(status));
      for (const streamingMessage of agentStreamingMessages(status, mode)) {
        items.push(renderMessage(streamingMessage));
      }
    } else if (status && status.state === "error") {
      // Terminal failure where even the error reply could not be persisted as a
      // chat message; surface it inline instead of rendering nothing.
      items.push(h("article", { class: "msg msg--agent msg--activity" }, [
        h("div", { class: "msg__avatar" }, [icon("bot", { size: 18 })]),
        renderAgentWorkCard(status, { active: false }),
      ]));
    }
    if (mode === "channel" && state.typingUsers.length) items.push(renderTypingUsers(state.typingUsers));
    body = h("div", { class: "messages__inner" }, items);
  }

  return h("div", { class: "chat" }, [
    h("div", { class: "messages", "data-chat-key": `${scopeTypeFor(mode)}:${scopeId}` }, [body]),
    h("form", { class: "composer", onsubmit: (e) => { e.preventDefault(); submit(); } }, [
      h("div", { class: "composer__wrap" }, [
        h("div", { class: "composer__field" }, [
          fileInput,
          h("button", {
            class: "icon-btn composer__attach",
            type: "button",
            title: "添加文件",
            "aria-label": "添加文件",
            disabled: noChannel || !canChat,
            onclick: () => fileInput.click(),
          }, [icon("paperclip", { size: 18 })]),
          input,
          mentionMenu,
          h("button", { class: "btn btn--primary composer__send", type: "submit", title: "发送 (Enter)", "aria-label": "发送", disabled: noChannel || !canChat }, [
            icon("send", { size: 18 }),
          ]),
        ]),
        selectedFiles.length ? renderComposerFiles(draftKey, selectedFiles) : null,
        h("div", { class: "composer__hint" }, [
          h("span", { class: "kbd", text: "Enter" }), h("span", { text: "发送" }),
          h("span", { class: "kbd", text: "Shift+Enter" }), h("span", { text: "换行" }),
        ]),
      ]),
    ]),
  ]);
}

function renderPrivateTelegramConfig() {
  const payload = state.privateTelegram || {};
  const gateway = payload.gateway || {};
  const link = payload.link || {};
  const telegramId = h("input", { value: link.telegram_user_id || "", placeholder: "例如 123456789", inputmode: "numeric" });
  const telegramUsername = h("input", { value: link.telegram_username || "", placeholder: "可选，不带 @" });
  const linked = !!link.telegram_user_id;
  const botName = gateway.bot_username ? `@${gateway.bot_username}` : "Telegram bot";
  const status = gateway.enabled
    ? `${botName} ${linked ? "已绑定" : "可绑定"}`
    : "管理员尚未启用";
  const form = h("form", {
      class: "telegram-link__form",
      onsubmit: async (event) => {
        event.preventDefault();
        await withBusy(async () => {
          await api("/api/private-agent/telegram", {
            method: "PUT",
            body: JSON.stringify({
              telegram_user_id: telegramId.value,
              telegram_username: telegramUsername.value,
            }),
          });
          await loadPrivateTelegram();
          toast("Telegram 绑定已保存", { type: "ok", title: "完成" });
        });
      },
    }, [
      field("Telegram ID", telegramId),
      field("Telegram 用户名", telegramUsername),
      h("div", { class: "telegram-link__actions" }, [
        h("button", { class: "btn btn--primary btn--sm", type: "submit", disabled: state.busy }, [h("span", { text: linked ? "更新绑定" : "保存绑定" })]),
        linked ? h("button", {
          class: "btn btn--danger btn--sm",
          type: "button",
          disabled: state.busy,
          onclick: async () => {
            await withBusy(async () => {
              await api("/api/private-agent/telegram", { method: "DELETE", body: "{}" });
              await loadPrivateTelegram();
              toast("Telegram 绑定已解除", { type: "ok", title: "完成" });
            });
          },
        }, [h("span", { text: "解除" })]) : null,
      ]),
    ]);

  return h("section", {
    class: "telegram-link",
    id: "private-telegram-popover",
    role: "dialog",
    "aria-label": "Telegram 私聊设置",
  }, [
    h("div", { class: "telegram-link__header" }, [
      h("div", { class: "telegram-link__meta" }, [
        h("div", { class: "telegram-link__title" }, [icon("message", { size: 16 }), h("span", { text: "Telegram 私聊" })]),
        h("div", { class: "telegram-link__sub", text: status }),
      ]),
      h("button", {
        class: "icon-btn telegram-link__close",
        type: "button",
        title: "收起",
        "aria-label": "收起 Telegram 私聊设置",
        onclick: () => {
          state.privateTelegramExpanded = false;
          render();
        },
      }, [icon("close", { size: 16 })]),
    ]),
    form,
  ]);
}

function addDraftFiles(draftKey, incoming) {
  const current = state.draftFiles[draftKey] || [];
  const accepted = [];
  for (const file of incoming || []) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast(`${file.name || "附件"} 超过 50 MB`, { title: "文件过大" });
      continue;
    }
    accepted.push(file);
  }
  if (!accepted.length) return false;
  const next = [...current, ...accepted].slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  if (current.length + accepted.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    toast(`每条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`, { title: "附件过多" });
  }
  state.draftFiles[draftKey] = next;
  state._focusComposer = true;
  render();
  return true;
}

function clipboardImageFiles(clipboardData) {
  if (!clipboardData) return [];
  const files = [];
  for (const item of Array.from(clipboardData.items || [])) {
    if (item.kind !== "file" || !item.type?.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(namedClipboardImage(file, files.length));
  }
  if (!files.length) {
    for (const file of Array.from(clipboardData.files || [])) {
      if (file.type?.startsWith("image/")) files.push(namedClipboardImage(file, files.length));
    }
  }
  return files;
}

function namedClipboardImage(file, index) {
  if (file.name) return file;
  const extension = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
  }[file.type] || "png";
  try {
    return new File([file], `pasted-image-${index + 1}.${extension}`, { type: file.type || "image/png", lastModified: file.lastModified || Date.now() });
  } catch (_) {
    return file;
  }
}

function renderMessage(message) {
  const isUser = message.author_type === "user";
  const suggestions = message.metadata?.knowledge_suggestions || [];
  const agentWork = message.metadata?.agent_work || null;
  const streaming = !!message.metadata?.streaming;
  const attachments = message.attachments || [];
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
      message.content ? h("div", { class: "msg__body", text: message.content }) : null,
      attachments.length ? renderMessageAttachments(attachments) : null,
      suggestions.length
        ? h("div", { class: "msg__suggest" }, suggestions.map((s) =>
            h("span", { class: "chip" }, [h("span", { class: "chip__id", text: `kb:${s.id}` }), h("span", { text: s.title })])))
        : null,
      agentWork && hasAgentProcessSteps(agentWork) ? renderAgentWorkCard(agentWork, { active: false }) : null,
    ]),
  ]);
}

function renderMessageAttachments(attachments) {
  return h("div", { class: "msg-attachments" }, attachments.map((attachment) => {
    const name = attachment.filename || "attachment";
    const size = formatFileSize(attachment.size_bytes || 0);
    if (attachment.is_image) {
      return h("a", {
        class: "msg-attachment msg-attachment--image",
        href: attachment.download_url || attachment.url,
        target: "_blank",
        rel: "noreferrer",
        title: name,
      }, [
        h("img", { src: attachment.url, alt: name, loading: "lazy" }),
        h("span", { class: "msg-attachment__caption", text: `${name} · ${size}` }),
      ]);
    }
    return h("a", {
      class: "msg-attachment msg-attachment--file",
      href: attachment.download_url || attachment.url,
      target: "_blank",
      rel: "noreferrer",
      title: name,
    }, [
      h("span", { class: "msg-attachment__fileicon" }, [icon("doc", { size: 18 })]),
      h("span", { class: "msg-attachment__meta" }, [
        h("strong", { text: name }),
        h("span", { text: `${attachment.mime_type || "file"} · ${size}` }),
      ]),
      icon("download", { size: 16 }),
    ]);
  }));
}

function renderAgentActivity(status) {
  return h("article", { class: "msg msg--agent msg--activity" }, [
    h("div", { class: "msg__avatar" }, [icon("bot", { size: 18 })]),
    renderAgentWorkCard(status, { active: true }),
  ]);
}

function renderAgentTyping(status) {
  return h("div", { class: "typing-line typing-line--agent" }, [
    h("span", { text: agentStatusText(status) || "Agent 正在处理" }),
    h("div", { class: "typing__dots" }, [h("i"), h("i"), h("i")]),
  ]);
}

function agentStreamingMessages(status, mode) {
  const segments = [];
  for (const stream of status?.stream_messages || []) {
    if (stream?.content) segments.push(stream);
  }
  const active = status?.stream_message || null;
  if (active?.content) segments.push(active);
  return segments.map((stream, index) => ({
    id: stream.id || `stream-${status.run_id || status.started_at || "agent"}-${index}`,
    scope_type: scopeTypeFor(mode),
    scope_id: scopeIdFor(mode),
    author_type: "agent",
    user_id: null,
    username: stream.username || (mode === "private" ? "Private Agent" : "Main Agent"),
    content: stream.content || "",
    metadata: { streaming: stream.active !== false, stream_segment: stream.active === false },
    created_at: stream.created_at || status.started_at || Math.floor(Date.now() / 1000),
  }));
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

function hasAgentProcessSteps(work) {
  return agentProcessLines(work).length > 0;
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
  mentionState.input = input;
  renderMentionMenu(input, menu);
}

function renderMentionMenu(input, menu) {
  const options = mentionState.options || [];
  const optionId = (index) => `${menu.id || "mention-menu"}-opt-${index}`;
  menu.replaceChildren(...options.map((option, index) =>
    h("button", {
      class: `mention-option ${index === mentionState.selected ? "is-active" : ""}`,
      type: "button",
      role: "option",
      id: optionId(index),
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
  if (input) {
    input.setAttribute("aria-expanded", "true");
    if (options.length) input.setAttribute("aria-activedescendant", optionId(mentionState.selected));
    else input.removeAttribute("aria-activedescendant");
  }
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
  const input = mentionState.input;
  if (input && (!menu || input.getAttribute("aria-controls") === menu.id)) {
    if (input.getAttribute("role") === "combobox") input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  mentionState.active = false;
  mentionState.selected = 0;
  mentionState.options = [];
  mentionState.range = null;
  if (!menu || mentionState.menu === menu) { mentionState.menu = null; mentionState.input = null; }
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

function renderComposerFiles(draftKey, files) {
  return h("div", { class: "composer-files" }, files.map((file, index) =>
    h("div", { class: "composer-file" }, [
      h("span", { class: "composer-file__icon" }, [icon(file.type?.startsWith("image/") ? "image" : "doc", { size: 15 })]),
      h("span", { class: "composer-file__name", text: file.name || "attachment" }),
      h("span", { class: "composer-file__size", text: formatFileSize(file.size || 0) }),
      h("button", {
        class: "icon-btn composer-file__remove",
        type: "button",
        title: "移除",
        "aria-label": "移除附件",
        onclick: () => {
          const next = [...(state.draftFiles[draftKey] || [])];
          next.splice(index, 1);
          if (next.length) state.draftFiles[draftKey] = next;
          else delete state.draftFiles[draftKey];
          state._focusComposer = true;
          render();
        },
      }, [icon("close", { size: 14 })]),
    ])
  ));
}

/* ------------------------------------------------------------ knowledge */
function renderKnowledge() {
  const canManage = hasPermission("manage_knowledge");
  const title = h("input", { placeholder: "标题" });
  const source = h("input", { placeholder: "来源（URL、系统名等）" });
  const summary = h("input", { placeholder: "摘要（可留空）" });
  const content = h("textarea", { placeholder: "正文内容…" });
  const searchQuery = state.knowledgeSearch.query || "";
  const searchResults = state.knowledgeSearch.results;
  const isSearching = !!searchQuery && Array.isArray(searchResults);
  const search = h("input", { placeholder: "搜索标题或正文…", "aria-label": "搜索知识库", value: searchQuery });

  const docCard = (doc) =>
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
    ]);

  const listSource = isSearching ? searchResults : state.documents;
  const emptyCard = isSearching
    ? emptyState("search", "没有匹配结果", `未找到与“${searchQuery}”相关的条目。`)
    : emptyState("doc", "知识库为空", "在左侧表单中录入第一条企业知识。");
  const docCards = listSource.length ? listSource.map(docCard) : [emptyCard];

  const clearSearch = () => {
    state.knowledgeSearch = { query: "", results: null };
    render();
  };

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
        const query = search.value.trim();
        if (!query) { clearSearch(); return; }
        // Search results are kept separate from the full library so a search
        // never shrinks the visible document list permanently.
        await withBusy(async () => {
          const result = await api(`/api/knowledge/search?q=${encodeURIComponent(query)}`);
          state.knowledgeSearch = { query, results: result.results || [] };
        });
      },
    }, [
      h("div", { class: "search-field" }, [
        icon("search"),
        search,
        isSearching
          ? h("button", { class: "icon-btn search-field__clear", type: "button", title: "清除搜索", "aria-label": "清除搜索，显示全部条目", onclick: clearSearch }, [icon("close", { size: 15 })])
          : null,
      ]),
    ]),
    isSearching
      ? h("div", { class: "list__note" }, [
          h("span", { text: `搜索“${searchQuery}”：${searchResults.length} 条结果` }),
          h("button", { class: "btn btn--sm", type: "button", onclick: clearSearch }, [h("span", { text: "显示全部" })]),
        ])
      : null,
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
      onclick: async () => {
        state.activeAdminPage = page.id;
        if (page.id === "messages") await withBusy(loadMessageAudit);
        else if (page.id === "tokens") await withBusy(loadTokenUsage);
        else render();
      },
    }, [
      icon(page.icon, { size: 16 }),
      h("span", { text: page.label }),
      adminPageBadge(page.id),
    ]);
  }));
}

function adminPageBadge(pageId) {
  const security = state.securityConfig?.config || {};
  const securityWarnings = [
    security.secure_cookie_enabled === false,
    security.admin_default_password_active,
    security.allow_default_admin_password,
    security.listen_restart_required,
  ].filter(Boolean).length;
  const value = {
    accounts: state.users.length,
    tokens: state.tokenUsage?.summary?.total_tokens ? formatCompactNumber(state.tokenUsage.summary.total_tokens) : 0,
    messages: (state.messageAudit?.privateConversations || []).filter((item) => item.message_count > 0).length,
    model: state.oauthProviders?.providers?.length || 0,
    telegram: state.telegramConfig?.config?.enabled ? (state.telegramConfig?.linked_users?.length || "on") : 0,
    updates: state.autoUpdateConfig?.config?.enabled ? "on" : 0,
    security: securityWarnings,
    runtime: state.runtimes ? Object.keys(state.runtimes).length : 0,
    secrets: state.secrets.filter((secret) => !isOAuthSecret(secret.key)).length,
  }[pageId];
  return value ? h("span", { class: "admin-pager__badge", text: String(value) }) : null;
}

function renderAdminPageSections(pageId) {
  if (pageId === "accounts") return [renderAccountManagement()];
  if (pageId === "tokens") return [renderTokenUsageMonitoring()];
  if (pageId === "messages") return [renderMessageAuditManagement()];
  if (pageId === "model") return [renderOAuthSettings(), renderHermesConfig()];
  if (pageId === "telegram") return [renderTelegramAdminConfig()];
  if (pageId === "updates") return [renderAutoUpdateConfig()];
  if (pageId === "security") return [renderSecuritySettings()];
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
  const accountModel = accountModelControl("");
  const modelName = accountModel.select;
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
      field("模型型号", accountModel.control),
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
  const accountModel = accountModelControl(user.model_name || "");
  const modelName = accountModel.select;
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
      field("模型型号", accountModel.control),
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

function renderTokenUsageMonitoring() {
  const report = state.tokenUsage || {};
  const summary = report.summary || {};
  const today = report.today || {};
  const last7 = report.last_7_days || {};
  const dailyUsage = Array.isArray(report.daily_usage) ? report.daily_usage : [];
  const days = h("select", {
    onchange: async (event) => {
      state.tokenUsageDays = Number(event.target.value) || 30;
      await withBusy(loadTokenUsage);
    },
  }, [7, 30, 90, 365].map((value) => h("option", { value, text: `${value} 天` })));
  days.value = String(state.tokenUsageDays || report.window?.days || 30);

  const accountRows = report.by_account || [];
  const detailRows = report.details || [];
  const scopeRows = report.by_scope || [];
  const modelRows = report.by_model || [];
  return h("div", { class: "token-usage" }, [
    h("section", { class: "card token-usage__overview" }, [
      cardHead("Token 消耗总览", "barChart", {
        desc: report.window ? `${formatTimestamp(report.window.since)} 至 ${formatTimestamp(report.window.until)}` : "暂无 token usage 数据",
        extra: h("div", { class: "token-usage__filters" }, [
          field("时间范围", days),
          h("button", {
            class: "btn btn--sm",
            type: "button",
            disabled: state.busy,
            onclick: async () => withBusy(loadTokenUsage),
          }, [icon("refresh", { size: 14 }), h("span", { text: "刷新" })]),
        ]),
      }),
      h("div", { class: "metric-grid" }, [
        usageMetric("本日消耗", today.total_tokens),
        usageMetric("近 7 日消耗", last7.total_tokens),
        usageMetric("总 Token", summary.total_tokens),
        usageMetric("输入 Token", summary.input_tokens),
        usageMetric("输出 Token", summary.output_tokens),
        usageMetric("Agent 调用", summary.event_count, "次"),
        usageMetric("涉及账户", summary.account_count, "个"),
        usageMetric("频道/私聊", `${summary.channel_event_count || 0}/${summary.private_event_count || 0}`, "次"),
      ]),
      renderTokenUsageCurve(dailyUsage),
    ]),
    renderUsageTable(
      "按账户汇总",
      "每个企业账户在当前时间范围内触发的 Agent token 消耗。",
      "users",
      ["账户", "调用", "输入", "输出", "总计", "最近使用"],
      accountRows,
      (row) => [
        userUsageCell(row),
        h("span", { text: formatNumber(row.event_count) }),
        h("span", { text: formatNumber(row.input_tokens) }),
        h("span", { text: formatNumber(row.output_tokens) }),
        h("strong", { text: formatNumber(row.total_tokens) }),
        h("span", { text: formatTimestamp(row.last_used_at) || "-" }),
      ],
      "暂无账户 token 数据。",
    ),
    renderUsageTable(
      "账户 / 渠道 / 模型明细",
      "细分到每个账户在私聊或具体频道中使用的供应商和模型。",
      "barChart",
      ["账户", "渠道", "供应商 / 模型", "调用", "输入", "输出", "总计"],
      detailRows,
      (row) => [
        userUsageCell(row),
        h("span", { text: tokenScopeLabel(row) }),
        h("span", { text: tokenModelLabel(row) }),
        h("span", { text: formatNumber(row.event_count) }),
        h("span", { text: formatNumber(row.input_tokens) }),
        h("span", { text: formatNumber(row.output_tokens) }),
        h("strong", { text: formatNumber(row.total_tokens) }),
      ],
      "暂无 token 明细。",
    ),
    h("div", { class: "token-usage__columns" }, [
      renderUsageTable(
        "按渠道汇总",
        "区分私人 Agent 会话和具体频道。",
        "message",
        ["渠道", "调用", "输入", "输出", "总计"],
        scopeRows,
        (row) => [
          h("span", { text: tokenScopeLabel(row) }),
          h("span", { text: formatNumber(row.event_count) }),
          h("span", { text: formatNumber(row.input_tokens) }),
          h("span", { text: formatNumber(row.output_tokens) }),
          h("strong", { text: formatNumber(row.total_tokens) }),
        ],
        "暂无渠道汇总。",
      ),
      renderUsageTable(
        "按供应商和模型汇总",
        "用于比较不同模型的 token 消耗。",
        "shield",
        ["供应商 / 模型", "调用", "输入", "输出", "总计"],
        modelRows,
        (row) => [
          h("span", { text: tokenModelLabel(row) }),
          h("span", { text: formatNumber(row.event_count) }),
          h("span", { text: formatNumber(row.input_tokens) }),
          h("span", { text: formatNumber(row.output_tokens) }),
          h("strong", { text: formatNumber(row.total_tokens) }),
        ],
        "暂无模型汇总。",
      ),
    ]),
  ]);
}

function usageMetric(label, value, suffix = "") {
  const isText = typeof value === "string";
  return h("div", { class: "metric-tile" }, [
    h("span", { text: label }),
    h("strong", { text: isText ? value : formatNumber(value) }),
    suffix ? h("small", { text: suffix }) : null,
  ]);
}

function renderTokenUsageCurve(rows) {
  const daily = normalizeTokenDailyUsage(rows);
  const maxTotal = Math.max(1, ...daily.map((row) => Number(row.total_tokens) || 0));
  const width = 640;
  const height = 170;
  const padX = 26;
  const padY = 18;
  const usableWidth = width - padX * 2;
  const usableHeight = height - padY * 2;
  const points = daily.map((row, index) => {
    const ratio = Math.max(0, (Number(row.total_tokens) || 0) / maxTotal);
    const x = padX + (daily.length <= 1 ? 0 : index * (usableWidth / (daily.length - 1)));
    const y = height - padY - ratio * usableHeight;
    return { ...row, x, y };
  });
  const linePath = points.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const areaPath = points.length
    ? `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${height - padY} L ${points[0].x.toFixed(1)} ${height - padY} Z`
    : "";
  const total = daily.reduce((sum, row) => sum + (Number(row.total_tokens) || 0), 0);

  return h("div", { class: "token-curve" }, [
    h("div", { class: "token-curve__head" }, [
      h("div", {}, [
        h("strong", { text: "近 7 日消耗曲线" }),
        h("span", { text: `${formatNumber(total)} tokens` }),
      ]),
      h("span", { class: "muted", text: daily.length ? `${daily[0].label} - ${daily[daily.length - 1].label}` : "" }),
    ]),
    svgNode("svg", { class: "token-curve__svg", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "近 7 日 token 消耗曲线", preserveAspectRatio: "none" }, [
      svgNode("line", { class: "token-curve__axis", x1: padX, y1: height - padY, x2: width - padX, y2: height - padY }),
      areaPath ? svgNode("path", { class: "token-curve__area", d: areaPath }) : null,
      linePath ? svgNode("path", { class: "token-curve__line", d: linePath }) : null,
      ...points.map((point) => svgNode("circle", { class: "token-curve__point", cx: point.x.toFixed(1), cy: point.y.toFixed(1), r: 4 }, [
        svgNode("title", { text: `${point.date}: ${formatNumber(point.total_tokens)} tokens` }),
      ])),
    ]),
    h("div", { class: "token-curve__labels" }, daily.map((row) =>
      h("div", { class: "token-curve__label" }, [
        h("span", { text: row.label }),
        h("strong", { text: formatCompactNumber(row.total_tokens) }),
      ])
    )),
  ]);
}

function normalizeTokenDailyUsage(rows) {
  const items = (Array.isArray(rows) ? rows : []).slice(-7).map((row) => ({
    date: row.date || "",
    label: row.label || tokenUsageDateLabel(row.start_at || row.date),
    input_tokens: Number(row.input_tokens) || 0,
    output_tokens: Number(row.output_tokens) || 0,
    total_tokens: Number(row.total_tokens) || 0,
    event_count: Number(row.event_count) || 0,
  }));
  while (items.length < 7) {
    items.unshift({
      date: "",
      label: "-",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      event_count: 0,
    });
  }
  return items;
}

function tokenUsageDateLabel(value) {
  if (!value) return "-";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function renderUsageTable(title, desc, iconName, headers, rows, renderCells, emptyText) {
  return h("section", { class: "card usage-card" }, [
    cardHead(title, iconName, { desc }),
    rows.length
      ? h("div", { class: "usage-table", style: `--usage-cols:${headers.length}` }, [
          h("div", { class: "usage-table__row usage-table__head" }, headers.map((item) => h("span", { text: item }))),
          ...rows.map((row) => h("div", { class: "usage-table__row" }, renderCells(row))),
        ])
      : h("div", { class: "muted", text: emptyText }),
  ]);
}

function userUsageCell(row) {
  const name = row.display_name || row.username || `u${row.user_id || ""}`;
  return h("span", { class: "usage-user" }, [
    h("strong", { text: name }),
    h("small", { text: row.username ? `@${row.username}` : `ID ${row.user_id || "-"}` }),
  ]);
}

function tokenScopeLabel(row) {
  if (row.scope_type === "private") return `私聊：${row.scope_name || row.display_name || row.username || row.scope_id}`;
  if (row.scope_type === "channel") return row.scope_name || `频道 ${row.scope_id || ""}`;
  return row.scope_name || row.scope_id || "-";
}

function tokenModelLabel(row) {
  const provider = oauthProviderLabel(row.provider || "");
  const model = row.model || "unknown";
  return provider ? `${provider} / ${model}` : model;
}

function oauthProviderLabel(providerId) {
  const provider = (state.oauthProviders?.providers || []).find((item) => item.id === providerId);
  return provider?.label || providerId || "";
}

function renderMessageAuditManagement() {
  const audit = messageAuditState();
  const channelId = String(audit.auditChannelId || state.activeChannelId || state.channels[0]?.id || "");
  if (!audit.auditChannelId && channelId) audit.auditChannelId = channelId;
  const channel = state.channels.find((item) => String(item.id) === channelId);
  const channelSelect = h("select", {
    onchange: async (event) => {
      const nextId = String(event.target.value || "");
      audit.auditChannelId = nextId;
      await withBusy(async () => loadAuditChannelMessages(nextId));
    },
  }, state.channels.map((item) => h("option", { value: item.id, text: `#${item.name}` })));
  channelSelect.value = channelId;

  const messageId = h("input", { type: "number", min: "1", step: "1", placeholder: "消息 ID" });
  const beforeTime = h("input", { type: "datetime-local" });
  const privateMessageId = h("input", { type: "number", min: "1", step: "1", placeholder: "消息 ID" });
  const privateBeforeTime = h("input", { type: "datetime-local" });
  const channelMessages = audit.channelMessages || [];

  const channelRows = channelMessages.length
    ? channelMessages.map((message) => renderAuditMessageRow(message, {
        deletable: true,
        onDelete: () => deleteChannelMessage(channelId, message.id),
      }))
    : [h("div", { class: "muted", text: channel ? "当前频道暂无消息。" : "暂无频道。" })];

  const conversations = audit.privateConversations || [];
  const selectedPrivateUserId = String(audit.auditPrivateUserId || "");
  const selectedConversation = conversations.find((item) => String(item.user_id) === selectedPrivateUserId);
  const privateRows = (audit.privateMessages || []).length
    ? audit.privateMessages.map((message) => renderAuditMessageRow(message, {
        deletable: true,
        onDelete: () => deletePrivateMessage(selectedPrivateUserId, message.id),
      }))
    : [h("div", { class: "muted", text: selectedConversation ? "该用户暂无私人 Agent 消息。" : "选择一个用户查看私人 Agent 会话。" })];

  return h("div", { class: "audit-grid" }, [
    h("section", { class: "card audit-card" }, [
      cardHead("频道消息管理", "message", {
        desc: channel ? `#${channel.name}：${audit.channelTotal || 0} 条消息` : "选择频道后查看和删除消息",
        extra: h("button", {
          class: "btn btn--sm",
          type: "button",
          disabled: state.busy || !channelId,
          onclick: async () => withBusy(async () => loadAuditChannelMessages(channelId)),
        }, [icon("refresh", { size: 14 }), h("span", { text: "刷新" })]),
      }),
      state.channels.length ? field("频道", channelSelect) : null,
      h("div", { class: "audit-tools" }, [
        h("form", {
          class: "audit-tool",
          onsubmit: async (event) => {
            event.preventDefault();
            const id = Number(messageId.value);
            if (!id) return toast("请输入要删除的消息 ID", { title: "缺少消息 ID" });
            await deleteChannelMessage(channelId, id);
            messageId.value = "";
          },
        }, [
          field("精确删除", messageId),
          h("button", { class: "btn btn--danger", type: "submit", disabled: state.busy || !channelId }, [icon("trash", { size: 15 }), h("span", { text: "删除 ID" })]),
        ]),
        h("form", {
          class: "audit-tool",
          onsubmit: async (event) => {
            event.preventDefault();
            const ts = unixFromDatetimeLocal(beforeTime.value);
            if (!ts) return toast("请选择删除截止时间", { title: "缺少时间" });
            await deleteChannelMessagesBefore(channelId, ts);
            beforeTime.value = "";
          },
        }, [
          field("删除时间点前", beforeTime),
          h("button", { class: "btn btn--danger", type: "submit", disabled: state.busy || !channelId }, [icon("trash", { size: 15 }), h("span", { text: "删除之前" })]),
        ]),
        h("div", { class: "audit-tool audit-tool--compact" }, [
          h("span", { class: "field" }, [h("span", { text: "全部清空" }), h("span", { class: "muted", text: "清空当前频道消息" })]),
          h("button", {
            class: "btn btn--danger",
            type: "button",
            disabled: state.busy || !channelId,
            onclick: async () => clearChannelMessages(channelId),
          }, [icon("trash", { size: 15 }), h("span", { text: "清空频道" })]),
        ]),
      ]),
      h("div", { class: "audit-list" }, channelRows),
    ]),
    h("section", { class: "card audit-card" }, [
      cardHead("私人 Agent 审计", "bot", {
        desc: `${conversations.filter((item) => item.message_count > 0).length} 个用户有私人会话记录`,
        extra: h("button", {
          class: "btn btn--sm",
          type: "button",
          disabled: state.busy,
          onclick: async () => withBusy(loadMessageAudit),
        }, [icon("refresh", { size: 14 }), h("span", { text: "刷新" })]),
      }),
      h("div", { class: "audit-tools" }, [
        h("form", {
          class: "audit-tool",
          onsubmit: async (event) => {
            event.preventDefault();
            const id = Number(privateMessageId.value);
            if (!id) return toast("请输入要删除的消息 ID", { title: "缺少消息 ID" });
            await deletePrivateMessage(selectedPrivateUserId, id);
            privateMessageId.value = "";
          },
        }, [
          field("精确删除", privateMessageId),
          h("button", { class: "btn btn--danger", type: "submit", disabled: state.busy || !selectedPrivateUserId }, [icon("trash", { size: 15 }), h("span", { text: "删除 ID" })]),
        ]),
        h("form", {
          class: "audit-tool",
          onsubmit: async (event) => {
            event.preventDefault();
            const ts = unixFromDatetimeLocal(privateBeforeTime.value);
            if (!ts) return toast("请选择删除截止时间", { title: "缺少时间" });
            await deletePrivateMessagesBefore(selectedPrivateUserId, ts);
            privateBeforeTime.value = "";
          },
        }, [
          field("删除时间点前", privateBeforeTime),
          h("button", { class: "btn btn--danger", type: "submit", disabled: state.busy || !selectedPrivateUserId }, [icon("trash", { size: 15 }), h("span", { text: "删除之前" })]),
        ]),
        h("div", { class: "audit-tool audit-tool--compact" }, [
          h("span", { class: "field" }, [h("span", { text: "全部清空" }), h("span", { class: "muted", text: "清空当前用户私人会话" })]),
          h("button", {
            class: "btn btn--danger",
            type: "button",
            disabled: state.busy || !selectedPrivateUserId,
            onclick: async () => clearPrivateMessages(selectedPrivateUserId),
          }, [icon("trash", { size: 15 }), h("span", { text: "清空会话" })]),
        ]),
      ]),
      h("div", { class: "audit-private" }, [
        h("div", { class: "audit-conversations" }, conversations.length
          ? conversations.map(renderPrivateConversationItem)
          : [h("div", { class: "muted", text: "暂无用户可审计。" })]),
        h("div", { class: "audit-private__messages" }, [
          selectedConversation ? h("div", { class: "audit-subhead" }, [
            h("div", {}, [
              h("strong", { text: selectedConversation.display_name || selectedConversation.username }),
              h("span", { text: `@${selectedConversation.username}` }),
            ]),
            h("span", { class: "status", text: `${audit.privateTotal || 0} messages` }),
          ]) : null,
          h("div", { class: "audit-list" }, privateRows),
        ]),
      ]),
    ]),
  ]);
}

function renderPrivateConversationItem(item) {
  const audit = messageAuditState();
  const active = String(audit.auditPrivateUserId || "") === String(item.user_id);
  return h("button", {
    class: `audit-conversation ${active ? "is-active" : ""}`,
    type: "button",
    onclick: async () => {
      audit.auditPrivateUserId = String(item.user_id);
      await withBusy(async () => loadAuditPrivateMessages(item.user_id));
    },
  }, [
    h("div", { class: "avatar", text: initials(item.display_name || item.username) }),
    h("div", { class: "audit-conversation__main" }, [
      h("strong", { text: item.display_name || item.username }),
      h("span", { text: item.last_message_at ? formatTimestamp(item.last_message_at) : "暂无记录" }),
    ]),
    h("span", { class: "nav__badge", text: String(item.message_count || 0) }),
  ]);
}

function renderAuditMessageRow(message, { deletable = false, onDelete = null } = {}) {
  const author = message.username || (message.author_type === "agent" ? "Agent" : "User");
  return h("article", { class: `audit-message audit-message--${message.author_type}` }, [
    h("div", { class: "audit-message__meta" }, [
      h("span", { class: "mono", text: `#${message.id}` }),
      h("strong", { text: author }),
      h("span", { text: message.author_type }),
      h("span", { text: formatTimestamp(message.created_at) }),
    ]),
    h("div", { class: "audit-message__body", text: message.content }),
    message.attachments?.length ? renderMessageAttachments(message.attachments) : null,
    deletable ? h("div", { class: "audit-message__actions" }, [
      h("button", {
        class: "icon-btn",
        title: "删除消息",
        "aria-label": "删除消息",
        onclick: async () => onDelete && onDelete(),
      }, [icon("trash", { size: 16 })]),
    ]) : null,
  ]);
}

function renderSecuritySettings() {
  const security = state.securityConfig?.config || {};
  const publicBaseUrl = h("input", {
    value: security.public_base_url || "",
    placeholder: "https://agent.example.com",
  });
  const trustedProxy = h("input", { type: "checkbox" });
  trustedProxy.checked = !!security.trusted_proxy;
  const host = h("input", { value: security.host || "127.0.0.1", placeholder: "127.0.0.1" });
  const port = h("input", { type: "number", min: "1", max: "65535", step: "1", value: security.port || 8765 });
  const sessionTtl = h("input", {
    type: "number",
    min: "60",
    max: String(30 * 24 * 60 * 60),
    step: "60",
    value: security.session_ttl_seconds || 8 * 60 * 60,
  });
  const sessionSecret = h("input", {
    type: "password",
    autocomplete: "off",
    placeholder: security.session_secret_configured ? "留空不修改" : "至少 32 字符",
  });

  const statusRows = [
    securityStatusRow("Secure Cookie", !!security.secure_cookie_enabled, security.secure_cookie_enabled ? "已启用" : "未启用"),
    securityStatusRow("Trusted Proxy", !!security.trusted_proxy, security.trusted_proxy ? "信任 X-Forwarded-* 头" : "未信任代理头"),
    securityStatusRow("默认 admin/admin", !security.admin_default_password_active && !security.allow_default_admin_password, security.admin_default_password_active ? "当前可用" : (security.allow_default_admin_password ? "启动项允许" : "未启用")),
    securityStatusRow("Session Secret", !!security.session_secret_configured, security.session_secret_source === "env" ? "来自环境变量" : "已持久化"),
    securityStatusRow("监听地址", !security.listen_restart_required, `${security.applied_host || "-"}:${security.applied_port || "-"}${security.listen_restart_required ? "，有待重启配置" : ""}`),
    securityStatusRow("Bootstrap 密码文件", !security.bootstrap_password_file_exists, security.bootstrap_password_file_exists ? "仍存在" : "不存在"),
  ];

  return h("section", { class: "card config-form security-config" }, [
    cardHead("公网安全", "key", { desc: "公开到公网前确认 HTTPS 反代、Cookie、会话与监听边界。" }),
    h("form", {
      onsubmit: async (event) => {
        event.preventDefault();
        await withBusy(async () => {
          const result = await api("/api/system/security/config", {
            method: "PUT",
            body: JSON.stringify({
              public_base_url: publicBaseUrl.value,
              trusted_proxy: trustedProxy.checked,
              host: host.value,
              port: port.value,
              session_ttl_seconds: sessionTtl.value,
              session_secret: sessionSecret.value,
            }),
          });
          state.securityConfig = result;
          sessionSecret.value = "";
          const needsRestart = !!result.restart_required;
          const secretRestart = !!result.session_secret_restart_required;
          toast(
            secretRestart
              ? "已保存；重启后所有会话会失效"
              : (needsRestart ? "已保存；部分启动项需要重启/重新部署后生效" : "公网安全配置已保存"),
            { type: "ok", title: needsRestart || secretRestart ? "需要重启" : "完成" },
          );
          render();
        });
      },
    }, [
      h("div", { class: "config-grid" }, [
        h("div", { class: "field--full" }, [field("公网 URL", h("div", { class: "field-stack" }, [
          publicBaseUrl,
          h("div", { class: "field-help", text: "设为 https:// 域名后，登录 Cookie 会带 Secure，写请求按该域名校验 Origin/Referer。" }),
        ]))]),
        h("label", { class: "check-row field--full" }, [
          trustedProxy,
          h("div", { class: "check-row__text" }, [
            h("strong", { text: "信任反向代理头" }),
            h("span", { text: "只在后端端口不能被公网直连时开启；用于真实客户端 IP、X-Forwarded-Host/Proto。" }),
          ]),
        ]),
        field("监听 Host", h("div", { class: "field-stack" }, [
          host,
          h("div", { class: "field-help", text: `当前进程：${security.applied_host || "-"}，修改后需重启/重新部署。` }),
        ])),
        field("监听 Port", h("div", { class: "field-stack" }, [
          port,
          h("div", { class: "field-help", text: `当前进程：${security.applied_port || "-"}，修改后需重启/重新部署。` }),
        ])),
        field("Session TTL 秒", h("div", { class: "field-stack" }, [
          sessionTtl,
          h("div", { class: "field-help", text: "影响新签发的登录会话；建议公网保持有限时长。" }),
        ])),
        field("轮换 Session Secret", h("div", { class: "field-stack" }, [
          sessionSecret,
          h("div", { class: "field-help", text: "留空不修改；填入新值后重启会使所有旧会话失效。" }),
        ])),
      ]),
      h("div", { class: "form-actions" }, [
        h("button", { class: "btn btn--primary", type: "submit", disabled: state.busy }, [h("span", { text: "保存安全配置" })]),
      ]),
    ]),
    h("div", { class: "security-status" }, statusRows),
  ]);
}

function securityStatusRow(label, ok, value) {
  return h("div", { class: "security-status__row" }, [
    h("span", { text: label }),
    statusBadge(ok, value),
  ]);
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

function hermesModelCatalog(providerId) {
  const normalized = ["openai-codex", "xai-oauth"].includes(providerId) ? providerId : "openai-codex";
  const fromConfig = state.hermesConfig?.config?.model_catalog?.[normalized];
  if (fromConfig && typeof fromConfig === "object") return fromConfig;
  const fromOAuth = (state.oauthProviders?.providers || []).find((item) => item.id === normalized);
  if (fromOAuth) {
    return {
      models: fromOAuth.models || [],
      default_model: fromOAuth.default_model || "",
      error: fromOAuth.model_catalog_error || "",
    };
  }
  return { models: [], default_model: "", error: "Hermes 模型目录不可用" };
}

function activeHermesProviderId() {
  const provider = state.oauthProviders?.active_provider || state.hermesConfig?.config?.provider || "openai-codex";
  return ["openai-codex", "xai-oauth"].includes(provider) ? provider : "openai-codex";
}

function accountModelControl(selectedModel = "") {
  const providerId = activeHermesProviderId();
  const catalog = hermesModelCatalog(providerId);
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const defaultModel = catalog.default_model || state.hermesConfig?.config?.model || "系统默认";
  const select = h("select");
  const hint = h("div", { class: "field-help" });
  select.replaceChildren(
    h("option", { value: "", text: `系统默认 (${defaultModel})` }),
    ...models.map((item) => h("option", { value: item, text: item })),
  );
  const clean = String(selectedModel || "").trim();
  if (clean && models.includes(clean)) {
    select.value = clean;
  } else {
    select.value = "";
  }
  if (clean && !models.includes(clean)) {
    hint.textContent = `已保存模型 ${clean} 不在当前 Hermes 目录，保存后将改为系统默认。`;
  } else if (models.length) {
    hint.textContent = `${models.length} 个模型，来源：Hermes`;
  } else {
    hint.textContent = catalog.error || "当前仅可使用系统默认模型。";
  }
  return { select, control: h("div", { class: "field-stack" }, [select, hint]) };
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
  const model = h("select");
  const modelHint = h("div", { class: "field-help" });
  const syncModelOptions = (preferredModel = "") => {
    const catalog = hermesModelCatalog(provider.value);
    const models = Array.isArray(catalog.models) ? catalog.models : [];
    const current = String(preferredModel || "").trim();
    const fallback = String(catalog.default_model || "").trim();
    if (!models.length) {
      model.replaceChildren(h("option", { value: "", text: "Hermes 模型目录不可用" }));
      model.value = "";
      model.disabled = true;
      modelHint.textContent = catalog.error || "需要先安装/启动托管 Hermes 后读取模型目录。";
      return;
    }
    model.disabled = false;
    model.replaceChildren(...models.map((item) => h("option", { value: item, text: item })));
    model.value = models.includes(current) ? current : (models.includes(fallback) ? fallback : models[0]);
    modelHint.textContent = `${models.length} 个模型，来源：Hermes`;
  };
  provider.addEventListener("change", () => syncModelOptions(""));
  syncModelOptions(hermes.model || "");
  const modelControl = h("div", { class: "field-stack" }, [model, modelHint]);
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
        field("模型", modelControl),
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

function renderTelegramAdminConfig() {
  const payload = state.telegramConfig || {};
  const config = payload.config || {};
  const enabled = h("input", { type: "checkbox" });
  enabled.checked = !!config.enabled;
  const polling = h("input", { type: "checkbox" });
  polling.checked = config.polling !== false;
  const botUsername = h("input", { value: config.bot_username || "", placeholder: "your_bot_username" });
  const botToken = h("input", {
    type: "password",
    autocomplete: "off",
    placeholder: config.bot_token_configured ? "保持不变" : "BotFather token",
  });
  const webhookSecret = h("input", {
    type: "password",
    autocomplete: "off",
    placeholder: config.webhook_secret_configured ? "保持不变" : "8-128 位 URL-safe secret",
  });
  const webhookUrl = config.webhook_url || "保存 webhook secret 后生成 URL";
  const linked = payload.linked_users || [];
  const linkedRows = linked.length
    ? linked.map((item) => h("div", { class: "usage-table__row", style: "--usage-cols:5" }, [
        h("div", { text: item.display_name || item.username }),
        h("div", { text: item.username }),
        h("div", { class: "mono", text: item.external_id }),
        h("div", { text: item.telegram_username ? `@${item.telegram_username}` : "-" }),
        h("div", { text: formatTime(item.updated_at) }),
      ]))
    : [h("div", { class: "muted", text: "暂无用户绑定 Telegram。" })];

  return h("section", { class: "card config-form" }, [
    cardHead("Telegram 私聊网关", "message", {
      desc: "全局 bot 由管理员配置；每个用户在私人 Agent 页面绑定自己的 Telegram ID。",
      extra: statusBadge(!!config.enabled && !!config.bot_token_configured, config.enabled ? "已启用" : "未启用"),
    }),
    h("form", {
      onsubmit: async (event) => {
        event.preventDefault();
        await withBusy(async () => {
          await api("/api/system/telegram/config", {
            method: "PUT",
            body: JSON.stringify({
              enabled: enabled.checked,
              polling: polling.checked,
              bot_username: botUsername.value,
              bot_token: botToken.value,
              webhook_secret: webhookSecret.value,
            }),
          });
          botToken.value = "";
          webhookSecret.value = "";
          await loadTelegramConfig();
          toast("Telegram 配置已保存", { type: "ok", title: "完成" });
        });
      },
    }, [
      h("div", { class: "config-grid" }, [
        h("label", { class: "check-row" }, [
          enabled,
          h("div", { class: "check-row__text" }, [h("strong", { text: "启用 Telegram 私聊" }), h("span", { text: "只接收 private chat，不处理群组或频道" })]),
        ]),
        h("label", { class: "check-row" }, [
          polling,
          h("div", { class: "check-row__text" }, [h("strong", { text: "Long polling" }), h("span", { text: "关闭后使用 webhook URL 接收 update" })]),
        ]),
        field("Bot 用户名", botUsername),
        field("Bot Token", botToken),
        h("div", { class: "field--full" }, [field("Webhook Secret", webhookSecret)]),
        h("div", { class: "field--full field-stack" }, [
          h("span", { class: "field-help", text: "Webhook URL" }),
          h("code", { class: "mono", text: webhookUrl }),
        ]),
      ]),
      h("div", { class: "form-actions" }, [
        h("button", { class: "btn btn--primary", type: "submit", disabled: state.busy }, [h("span", { text: "保存 Telegram 配置" })]),
      ]),
    ]),
    h("div", { class: "usage-table", style: "margin-top:14px" }, [
      h("div", { class: "usage-table__row usage-table__row--head", style: "--usage-cols:5" }, [
        h("div", { text: "平台用户" }),
        h("div", { text: "用户名" }),
        h("div", { text: "Telegram ID" }),
        h("div", { text: "Telegram 用户名" }),
        h("div", { text: "更新时间" }),
      ]),
      ...linkedRows,
    ]),
  ]);
}

function renderAutoUpdateConfig() {
  const payload = state.autoUpdateConfig || {};
  const config = payload.config || {};
  const status = payload.status || {};
  const enabled = h("input", { type: "checkbox" });
  enabled.checked = !!config.enabled;
  const interval = h("input", { type: "number", min: "5", max: "3600", step: "1", value: config.interval_seconds || 30 });
  const remote = h("input", { value: config.remote || "origin", placeholder: "origin" });
  const branch = h("input", { value: config.branch || "", placeholder: "留空使用当前分支" });
  const webhookSecret = h("input", {
    type: "password",
    autocomplete: "off",
    placeholder: config.webhook_secret_configured ? "保持不变" : "至少 16 位 secret",
  });
  const webhookUrl = config.webhook_url || "启用后自动生成 webhook URL";
  const updateState = status.in_progress
    ? "检查中"
    : status.update_started
      ? "已触发更新"
      : status.update_available
        ? "发现更新"
        : "待命";
  const clean = !status.dirty;
  return h("section", { class: "card config-form" }, [
    cardHead("自动更新监听", "refresh", {
      desc: "常驻监听上游分支；GitHub webhook 可秒级触发，轮询作为兜底。",
      extra: statusBadge(!!config.enabled, config.enabled ? "已启用" : "未启用"),
    }),
    h("form", {
      onsubmit: async (event) => {
        event.preventDefault();
        await withBusy(async () => {
          await api("/api/system/auto-update/config", {
            method: "PUT",
            body: JSON.stringify({
              enabled: enabled.checked,
              interval_seconds: interval.value,
              remote: remote.value,
              branch: branch.value,
              webhook_secret: webhookSecret.value,
            }),
          });
          webhookSecret.value = "";
          await loadAutoUpdateConfig();
          toast("自动更新配置已保存", { type: "ok", title: "完成" });
        });
      },
    }, [
      h("div", { class: "config-grid" }, [
        h("label", { class: "check-row" }, [
          enabled,
          h("div", { class: "check-row__text" }, [
            h("strong", { text: "启用常驻监听" }),
            h("span", { text: "收到 webhook 或轮询发现上游更新后自动执行 deploy.sh update" }),
          ]),
        ]),
        field("轮询间隔（秒）", interval),
        field("Git remote", remote),
        field("分支", branch),
        h("div", { class: "field--full" }, [field("Webhook Secret", webhookSecret)]),
        h("div", { class: "field--full field-stack" }, [
          h("span", { class: "field-help", text: "GitHub Webhook URL" }),
          h("code", { class: "mono", text: webhookUrl }),
        ]),
      ]),
      h("div", { class: "form-actions" }, [
        h("button", { class: "btn btn--primary", type: "submit", disabled: state.busy }, [h("span", { text: "保存自动更新配置" })]),
        h("button", {
          class: "btn",
          type: "button",
          disabled: state.busy || !config.enabled,
          onclick: async () => {
            await withBusy(async () => {
              await api("/api/system/auto-update/check", { method: "POST", body: "{}" });
              await loadAutoUpdateConfig();
              toast("已触发自动更新检查", { type: "ok", title: "已发送" });
            });
          },
        }, [icon("refresh", { size: 15 }), h("span", { text: "立即检查" })]),
      ]),
    ]),
    h("div", { class: "metric-grid metric-grid--compact" }, [
      usageMetric("状态", updateState),
      usageMetric("工作树", clean ? "干净" : "有本地改动"),
      usageMetric("当前版本", shortSha(status.current_revision)),
      usageMetric("远端版本", shortSha(status.remote_revision)),
      usageMetric("最近检查", formatTime(status.last_check_at) || "-"),
      usageMetric("最近触发", status.last_trigger || "-"),
    ]),
    status.last_error ? h("div", { class: "notice notice--warn", text: status.last_error }) : null,
    status.dirty_summary ? h("pre", { class: "config-preview", text: status.dirty_summary }) : null,
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
    internal.default_error ? h("div", { class: "config-warning", text: internal.default_error }) : null,
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
      h("span", { class: "config-field__meta" }, [
        item.defaulted ? h("span", { class: "config-field__source", text: "默认值" }) : null,
        h("code", { text: item.key }),
      ]),
    ]),
    configFieldControl(item, attr),
  ]);
}

function configFieldControl(item, attr) {
  const dataAttr = attr === "yamlKey" ? "data-yaml-key" : "data-env-key";
  const common = { [dataAttr]: item.key };
  const hasDisplayValue = !!item.configured || !!item.defaulted;
  if (item.kind === "boolean") {
    const select = h("select", common, [
      h("option", { value: "", text: "未设置" }),
      h("option", { value: "true", text: "true" }),
      h("option", { value: "false", text: "false" }),
    ]);
    if (hasDisplayValue) select.value = String(item.value === true || String(item.value).toLowerCase() === "true");
    select.dataset.initial = select.value;
    return select;
  }
  if (item.options?.length) {
    const select = h("select", common, [
      h("option", { value: "", text: "未设置" }),
      ...item.options.map((option) => h("option", { value: option, text: option })),
    ]);
    select.value = hasDisplayValue ? String(item.value ?? "") : "";
    select.dataset.initial = select.value;
    return select;
  }
  if (item.kind === "json") {
    const textarea = h("textarea", { ...common, spellcheck: "false" });
    textarea.value = hasDisplayValue ? String(item.value ?? "") : "";
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
  if (!item.secret && hasDisplayValue) input.value = String(item.value ?? "");
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
  const importInput = h("input", {
    type: "file",
    accept: "application/json,.json",
    style: "display:none",
    onchange: async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) await importOAuthCredentials(file);
    },
  });
  const transferActions = h("div", { class: "oauth-transfer" }, [
    h("button", {
      class: "btn btn--sm",
      type: "button",
      disabled: state.busy,
      onclick: () => exportOAuthCredentials(),
    }, [icon("download", { size: 14 }), h("span", { text: "导出凭据" })]),
    h("button", {
      class: "btn btn--sm",
      type: "button",
      disabled: state.busy,
      onclick: () => importInput.click(),
    }, [icon("upload", { size: 14 }), h("span", { text: "导入凭据" })]),
    importInput,
  ]);
  return h("section", { class: "card" }, [
    cardHead("API 供应商验证", "shield", { desc: "通过 OAuth 授权模型供应商，验证后 Hermes 自动切换。", extra: transferActions }),
    providers.length
      ? h("div", { class: "oauth-grid" }, providers.map(renderOAuthProviderCard))
      : h("div", { class: "muted", text: "未发现可验证的供应商。" }),
  ]);
}

function renderOAuthProviderCard(provider) {
  const flow = state.oauthFlows[provider.id];
  const callbackValue = state.oauthCallbackUrls[provider.id] || "";
  const errorText = oauthProviderErrorText(provider);
  const header = h("div", { class: "oauth-card__head" }, [
    h("div", { class: "oauth-card__id" }, [
      h("div", { class: "oauth-card__logo" }, [h("strong", { class: "mono", text: (provider.label || "?").trim().charAt(0) })]),
      h("div", {}, [
        h("div", { class: "oauth-card__label", text: provider.label }),
        provider.default_model ? h("div", { class: "oauth-card__model", text: provider.default_model }) : null,
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

  const children = [header, meta];
  if (errorText) children.push(h("div", { class: "oauth-error", role: "alert" }, [icon("alert", { size: 15 }), h("span", { text: errorText })]));
  if (!provider.default_model && provider.model_catalog_error) {
    children.push(h("div", { class: "oauth-error", role: "alert" }, [icon("alert", { size: 15 }), h("span", { text: provider.model_catalog_error })]));
  }
  children.push(h("div", { class: "oauth-actions" }, [startButton]));
  if (flow?.kind === "device_code") children.push(renderCodexOAuthFlow(provider.id, flow));
  else if (flow?.kind === "manual_callback") children.push(renderGrokOAuthFlow(provider.id, flow, callbackValue));
  if (flow?.complete) children.push(h("div", { class: "oauth-guide complete" }, [icon("checkCircle", { size: 16 }), h("span", { text: "验证完成，Hermes 已切换到该供应商。" })]));
  return h("div", { class: `oauth-card ${provider.active ? "is-active" : ""}` }, children);
}

function oauthProviderErrorText(provider) {
  const authError = provider?.last_auth_error;
  if (!authError || typeof authError !== "object") return "";
  const message = String(authError.message || authError.detail || authError.code || "").trim();
  if (!message) return "";
  return authError.relogin_required ? `需要重新验证：${message}` : message;
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
function messageAuditState() {
  if (!state.messageAudit) {
    state.messageAudit = {
      auditChannelId: null,
      channelMessages: [],
      channelTotal: 0,
      privateConversations: [],
      auditPrivateUserId: null,
      privateMessages: [],
      privateTotal: 0,
    };
  }
  return state.messageAudit;
}
function unixFromDatetimeLocal(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
}
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
function formatNumber(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat().format(number);
}
function shortSha(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 7) : "-";
}
function formatCompactNumber(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(number);
}
function formatFileSize(value) {
  let size = Math.max(0, Number(value) || 0);
  const units = ["B", "KB", "MB", "GB"];
  for (const unit of units) {
    if (size < 1024 || unit === units[units.length - 1]) {
      return unit === "B" ? `${Math.round(size)} ${unit}` : `${size.toFixed(1)} ${unit}`;
    }
    size /= 1024;
  }
  return "0 B";
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
    attachments: (message.attachments || []).map((item) => ({
      id: item.id,
      filename: item.filename,
      mime_type: item.mime_type,
      size_bytes: item.size_bytes,
      url: item.url,
    })),
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
    stream_messages: (status.stream_messages || []).map((item) => `${item.id}:${item.content || ""}:${item.updated_at || 0}`),
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
function optimisticAttachments(files) {
  return (files || []).map((file, index) => {
    const url = URL.createObjectURL(file);
    return {
      id: `tmp-att-${localMessageSeq}-${index}`,
      filename: file.name || "attachment",
      mime_type: file.type || "application/octet-stream",
      size_bytes: file.size || 0,
      is_image: (file.type || "").startsWith("image/"),
      url,
      download_url: url,
      local_preview: true,
    };
  });
}
function revokeAttachmentUrls(message) {
  for (const attachment of message?.attachments || []) {
    if (attachment.local_preview && attachment.url) {
      try { URL.revokeObjectURL(attachment.url); } catch (_) {}
    }
  }
}
function appendOptimisticMessage(mode, scopeId, content, files = []) {
  localMessageSeq += 1;
  const message = {
    id: `tmp-${localMessageSeq}`,
    scope_type: scopeTypeFor(mode),
    scope_id: String(scopeId),
    author_type: "user",
    user_id: state.user?.id || null,
    username: state.user?.display_name || state.user?.username || "你",
    content,
    attachments: optimisticAttachments(files),
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
  const pending = state.pendingMessages.find((message) => message.id === tempId);
  revokeAttachmentUrls(pending);
  state.pendingMessages = removeLocalMessage(state.pendingMessages, tempId);
  const apply = (messages) => {
    const old = messages.find((message) => message.id === tempId);
    revokeAttachmentUrls(old);
    let next = removeLocalMessage(messages, tempId);
    if (savedMessage && !next.some((message) => message.id === savedMessage.id)) next = [...next, savedMessage];
    return next;
  };
  if (mode === "private") state.privateMessages = apply(state.privateMessages);
  else if (String(state.activeChannelId) === String(scopeId)) state.messages = apply(state.messages);
}
function removeOptimisticMessage(mode, scopeId, tempId) {
  const pending = state.pendingMessages.find((message) => message.id === tempId);
  revokeAttachmentUrls(pending);
  state.pendingMessages = removeLocalMessage(state.pendingMessages, tempId);
  if (mode === "private") state.privateMessages = removeLocalMessage(state.privateMessages, tempId);
  else if (String(state.activeChannelId) === String(scopeId)) state.messages = removeLocalMessage(state.messages, tempId);
}
async function postChatMessage(mode, scopeId, content, files = []) {
  const pending = appendOptimisticMessage(mode, scopeId, content, files);
  render();
  try {
    let request;
    if (files.length) {
      const form = new FormData();
      form.append("content", content);
      for (const file of files) form.append("files", file, file.name);
      request = { method: "POST", body: form };
    } else {
      request = { method: "POST", body: JSON.stringify({ content }) };
    }
    const result = mode === "private"
      ? await api("/api/private-agent/messages", request)
      : await api(`/api/channels/${scopeId}/messages`, request);
    replaceOptimisticMessage(mode, scopeId, pending.id, result.user_message);
    setAgentStatus(mode, scopeId, result.agent_status);
    await refreshActiveChat({ renderAfter: false });
    return true;
  } catch (error) {
    removeOptimisticMessage(mode, scopeId, pending.id);
    const message = error.message || String(error);
    state.error = message;
    toast(message, { type: "error", title: "发送失败" });
    return false;
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

async function deleteChannelMessage(channelId, messageId) {
  if (!channelId || !messageId) return;
  if (!window.confirm(`删除频道消息 #${messageId}？`)) return;
  await withBusy(async () => {
    const result = await api(`/api/admin/channels/${channelId}/messages/${messageId}`, { method: "DELETE", body: "{}" });
    await reloadAfterChannelAuditChange(channelId);
    toast(`已删除 ${result.deleted || 0} 条频道消息`, { type: "ok", title: "完成" });
  });
}

async function deleteChannelMessagesBefore(channelId, beforeCreatedAt) {
  if (!channelId || !beforeCreatedAt) return;
  if (!window.confirm("删除该时间点之前的频道消息？")) return;
  await withBusy(async () => {
    const result = await api(`/api/admin/channels/${channelId}/messages`, {
      method: "DELETE",
      body: JSON.stringify({ before_created_at: beforeCreatedAt }),
    });
    await reloadAfterChannelAuditChange(channelId);
    toast(`已删除 ${result.deleted || 0} 条频道消息`, { type: "ok", title: "完成" });
  });
}

async function clearChannelMessages(channelId) {
  if (!channelId) return;
  if (!window.confirm("清空当前频道的全部消息？")) return;
  await withBusy(async () => {
    const result = await api(`/api/admin/channels/${channelId}/messages`, {
      method: "DELETE",
      body: JSON.stringify({ clear_all: true }),
    });
    await reloadAfterChannelAuditChange(channelId);
    toast(`已清空 ${result.deleted || 0} 条频道消息`, { type: "ok", title: "完成" });
  });
}

async function deletePrivateMessage(userId, messageId) {
  if (!userId || !messageId) return;
  if (!window.confirm(`删除私人 Agent 消息 #${messageId}？`)) return;
  await withBusy(async () => {
    const result = await api(`/api/admin/private-agent/conversations/${userId}/messages/${messageId}`, { method: "DELETE", body: "{}" });
    await reloadAfterPrivateAuditChange(userId);
    toast(`已删除 ${result.deleted || 0} 条私人 Agent 消息`, { type: "ok", title: "完成" });
  });
}

async function deletePrivateMessagesBefore(userId, beforeCreatedAt) {
  if (!userId || !beforeCreatedAt) return;
  if (!window.confirm("删除该时间点之前的私人 Agent 消息？")) return;
  await withBusy(async () => {
    const result = await api(`/api/admin/private-agent/conversations/${userId}/messages`, {
      method: "DELETE",
      body: JSON.stringify({ before_created_at: beforeCreatedAt }),
    });
    await reloadAfterPrivateAuditChange(userId);
    toast(`已删除 ${result.deleted || 0} 条私人 Agent 消息`, { type: "ok", title: "完成" });
  });
}

async function clearPrivateMessages(userId) {
  if (!userId) return;
  if (!window.confirm("清空当前用户的全部私人 Agent 消息？")) return;
  await withBusy(async () => {
    const result = await api(`/api/admin/private-agent/conversations/${userId}/messages`, {
      method: "DELETE",
      body: JSON.stringify({ clear_all: true }),
    });
    await reloadAfterPrivateAuditChange(userId);
    toast(`已清空 ${result.deleted || 0} 条私人 Agent 消息`, { type: "ok", title: "完成" });
  });
}

async function reloadAfterChannelAuditChange(channelId) {
  await Promise.all([loadChannels(), loadAuditChannelMessages(channelId)]);
  if (String(state.activeChannelId || "") === String(channelId)) await loadChannelMessages();
}

async function reloadAfterPrivateAuditChange(userId) {
  await Promise.all([loadPrivateConversations(), loadAuditPrivateMessages(userId)]);
  if (String(state.user?.id || "") === String(userId)) await loadPrivateMessages();
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
  const [result] = await Promise.all([
    api("/api/private-agent/messages"),
    loadPrivateTelegram(),
  ]);
  const scopeId = scopeIdFor("private");
  state.privateMessages = mergePendingMessages("private", scopeId, result.messages || []);
  setAgentStatus("private", scopeId, result.agent_status);
}
async function loadPrivateTelegram() {
  state.privateTelegram = await api("/api/private-agent/telegram");
}
async function loadDocuments() {
  const result = await api("/api/knowledge/documents");
  state.documents = result.documents;
  state.knowledgeSearch = { query: "", results: null };
}
async function loadUsers() {
  const result = await api("/api/users");
  state.users = result.users;
}
async function loadPermissionGroups() {
  const result = await api("/api/permission-groups");
  state.permissionGroups = result.permission_groups;
}
async function loadAuditChannelMessages(channelId = messageAuditState().auditChannelId) {
  const audit = messageAuditState();
  if (!channelId) {
    audit.channelMessages = [];
    audit.channelTotal = 0;
    return;
  }
  audit.auditChannelId = String(channelId);
  const result = await api(`/api/admin/channels/${channelId}/messages?limit=200`);
  audit.channelMessages = result.messages || [];
  audit.channelTotal = result.total || 0;
}
async function loadPrivateConversations() {
  const audit = messageAuditState();
  const result = await api("/api/admin/private-agent/conversations");
  audit.privateConversations = result.conversations || [];
  const selected = String(audit.auditPrivateUserId || "");
  if (!audit.privateConversations.some((item) => String(item.user_id) === selected)) {
    const firstWithMessages = audit.privateConversations.find((item) => item.message_count > 0);
    audit.auditPrivateUserId = firstWithMessages
      ? String(firstWithMessages.user_id)
      : String(audit.privateConversations[0]?.user_id || "");
  }
}
async function loadAuditPrivateMessages(userId = messageAuditState().auditPrivateUserId) {
  const audit = messageAuditState();
  if (!userId) {
    audit.privateMessages = [];
    audit.privateTotal = 0;
    return;
  }
  audit.auditPrivateUserId = String(userId);
  const result = await api(`/api/admin/private-agent/conversations/${userId}/messages?limit=200`);
  audit.privateMessages = result.messages || [];
  audit.privateTotal = result.total || 0;
}
async function loadSecrets() {
  const result = await api("/api/settings/secrets");
  state.secrets = result.secrets;
}
async function loadOAuthProviders() { state.oauthProviders = await api("/api/system/oauth/providers"); }
async function loadRuntime() { state.runtimes = await api("/api/system/runtime"); }
async function loadSecurityConfig() { state.securityConfig = await api("/api/system/security/config"); }
async function loadHermesConfig() { state.hermesConfig = await api("/api/system/hermes/config"); }
async function loadTelegramConfig() { state.telegramConfig = await api("/api/system/telegram/config"); }
async function loadAutoUpdateConfig() { state.autoUpdateConfig = await api("/api/system/auto-update/config"); }
async function loadHermesInternalConfig() { state.hermesInternalConfig = await api("/api/system/hermes/internal-config"); }
async function loadCogneeConfig() { state.cogneeConfig = await api("/api/system/cognee/config"); }
async function loadTokenUsage() {
  const days = encodeURIComponent(String(state.tokenUsageDays || 30));
  state.tokenUsage = await api(`/api/admin/token-usage?days=${days}&limit=200`);
  state.tokenUsageDays = state.tokenUsage?.window?.days || state.tokenUsageDays || 30;
}
async function loadSettings() { await Promise.all([loadSecrets(), loadRuntime(), loadSecurityConfig(), loadHermesConfig(), loadTelegramConfig(), loadAutoUpdateConfig(), loadHermesInternalConfig(), loadCogneeConfig(), loadOAuthProviders()]); }
async function loadMessageAudit() {
  const audit = messageAuditState();
  if (!state.channels.length) await loadChannels();
  if (!audit.auditChannelId && (state.activeChannelId || state.channels[0]?.id)) {
    audit.auditChannelId = String(state.activeChannelId || state.channels[0].id);
  }
  await Promise.all([loadAuditChannelMessages(audit.auditChannelId), loadPrivateConversations()]);
  await loadAuditPrivateMessages(audit.auditPrivateUserId);
}
async function loadAdminPanel() { await Promise.all([loadUsers(), loadPermissionGroups(), loadSettings(), loadMessageAudit(), loadTokenUsage()]); }
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
  // Real-time updates arrive via the SSE stream (syncScopeStream); this poll is
  // only a low-frequency safety net for when the stream is unavailable.
  pollTimer = setInterval(() => refreshActiveChat(), 4000);
}
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  closeScopeStream();
  if (typingState.stopTimer) {
    clearTimeout(typingState.stopTimer);
    typingState.stopTimer = null;
  }
  typingState.active = false;
}

let scopeStream = null;
let scopeStreamKey = null;
let scopeStreamReconnect = null;
const SSE_RECONNECT_MS = 3000;

function currentScopeStreamUrl() {
  if (state.activeView === "channel" && state.activeChannelId) return `/api/channels/${state.activeChannelId}/events`;
  if (state.activeView === "private") return "/api/private-agent/events";
  return null;
}

function closeScopeStream() {
  if (scopeStreamReconnect) {
    clearTimeout(scopeStreamReconnect);
    scopeStreamReconnect = null;
  }
  if (scopeStream) {
    try { scopeStream.close(); } catch (_) {}
  }
  scopeStream = null;
  scopeStreamKey = null;
}

// Keep a single Server-Sent Events stream open for the active conversation so
// agent activity and new messages surface immediately instead of waiting for
// the poll. The browser auto-reconnects on network-level drops (readyState 0);
// readyState 2 (CLOSED) is terminal and we reconnect ourselves below.
function syncScopeStream() {
  if (!state.user || typeof EventSource === "undefined") return;
  const url = currentScopeStreamUrl();
  if (!url) { closeScopeStream(); return; }
  if (scopeStreamKey === url && scopeStream && scopeStream.readyState !== 2) return;
  closeScopeStream();
  scopeStreamKey = url;
  const es = new EventSource(url, { withCredentials: true });
  scopeStream = es;
  es.addEventListener("update", () => {
    if (scopeStream === es) refreshActiveChat();
  });
  es.addEventListener("error", () => {
    if (scopeStream !== es) return;
    // readyState 2 (CLOSED) is the terminal, non-reconnecting state. It happens
    // on session expiry (the reconnect request 401s) or a transient proxy 5xx.
    // Probe auth: a valid session means it was a transport blip, so schedule a
    // reconnect with a short delay instead of relying on an incidental render;
    // an invalid session drops to login via api()'s 401 handling.
    if (es.readyState === 2) {
      closeScopeStream();
      api("/api/auth/me")
        .then(() => {
          if (scopeStreamReconnect) return;
          scopeStreamReconnect = setTimeout(() => {
            scopeStreamReconnect = null;
            if (state.user && !document.hidden) syncScopeStream();
          }, SSE_RECONNECT_MS);
        })
        .catch(() => {});
    }
  });
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
async function exportOAuthCredentials() {
  await withBusy(async () => {
    const payload = await api("/api/system/oauth/credentials/export");
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = h("a", {
      href: url,
      download: `enterprise-oauth-credentials-${new Date().toISOString().slice(0, 10)}.json`,
    });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast("OAuth 凭据文件已生成", { type: "ok", title: "完成" });
  });
}
async function importOAuthCredentials(file) {
  await withBusy(async () => {
    let credentials;
    try {
      credentials = JSON.parse(await file.text());
    } catch (error) {
      throw new Error("OAuth 凭据文件不是有效 JSON");
    }
    const result = await api("/api/system/oauth/credentials/import", {
      method: "POST",
      body: JSON.stringify({ credentials }),
    });
    updateOAuthState(result.active_provider, result);
    await Promise.all([loadSecrets(), loadHermesConfig()]);
    const count = result.imported?.keys?.length || 0;
    toast(`已导入 ${count} 个 OAuth 凭据`, { type: "ok", title: "完成" });
  });
}
function updateOAuthState(providerId, result) {
  state.oauthProviders = { providers: result.providers || [], active_provider: result.active_provider || providerId };
  if (result.flow) state.oauthFlows[providerId] = result.flow;
}

/* ---------------------------------------------------------------- session */
function handleSessionExpired() {
  // Triggered when any API call returns 401 while we believed we were logged
  // in: drop to the login screen instead of silently polling forever.
  if (!state.user) return;
  stopPolling();
  state.user = null;
  state.sidebarOpen = false;
  hideMentionMenu();
  toast("会话已过期，请重新登录", { type: "error", title: "需要登录" });
  render();
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  stopPolling();
  for (const message of state.pendingMessages) revokeAttachmentUrls(message);
  state.user = null;
  state.sidebarOpen = false;
  state.pendingMessages = [];
  state.draftFiles = {};
  state.mentionTargets = [];
  state.typingUsers = [];
  state.messageAudit = {
    auditChannelId: null,
    channelMessages: [],
    channelTotal: 0,
    privateConversations: [],
    auditPrivateUserId: null,
    privateMessages: [],
    privateTotal: 0,
  };
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

let globalListenersReady = false;
function setupGlobalListeners() {
  if (globalListenersReady) return;
  globalListenersReady = true;

  // Escape closes the open mobile drawer for keyboard users.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.sidebarOpen) {
      event.preventDefault();
      closeSidebar();
    }
  });

  // Re-evaluate the off-canvas drawer's inert/aria-hidden state when the
  // viewport crosses the mobile breakpoint.
  const mobileQuery = window.matchMedia("(max-width: 800px)");
  const onBreakpointChange = () => { if (state.user) render(); };
  if (mobileQuery.addEventListener) mobileQuery.addEventListener("change", onBreakpointChange);
  else if (mobileQuery.addListener) mobileQuery.addListener(onBreakpointChange);

  // Pause the poll/SSE on hidden tabs to avoid wasted server load; catch up and
  // re-establish real-time updates when the tab becomes visible again.
  document.addEventListener("visibilitychange", () => {
    if (!state.user) return;
    if (document.hidden) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      closeScopeStream();
    } else {
      refreshActiveChat();
      startPolling();
      syncScopeStream();
    }
  });

  // Release the server-side SSE connection promptly when the tab goes away.
  window.addEventListener("pagehide", () => { closeScopeStream(); });
}

async function boot() {
  setupGlobalListeners();
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

let bootStarted = false;

export function startEnterpriseApp() {
  if (bootStarted) return;
  bootStarted = true;
  boot();
}
