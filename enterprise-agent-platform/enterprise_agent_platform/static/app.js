const state = {
  user: null,
  channels: [],
  activeView: "channel",
  activeChannelId: null,
  messages: [],
  privateMessages: [],
  documents: [],
  selectedDocument: null,
  secrets: [],
  busy: false,
  error: "",
};

const app = document.getElementById("app");

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

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function render() {
  app.replaceChildren(state.user ? renderShell() : renderLogin());
}

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
      });
    },
  }, [
    h("h1", { text: "Enterprise Agent" }),
    h("p", { text: "账号密码登录" }),
    username,
    password,
    h("button", { class: "primary", type: "submit", disabled: state.busy, text: state.busy ? "登录中" : "登录" }),
    h("div", { class: "error", text: state.error }),
  ]);
  return h("main", { class: "login" }, [form]);
}

function renderShell() {
  return h("div", { class: "shell" }, [
    renderSidebar(),
    h("main", { class: "main" }, [
      renderTopbar(),
      h("section", { class: "content" }, [renderContent()]),
    ]),
  ]);
}

function renderSidebar() {
  const channelButtons = state.channels.map((channel) =>
    h("button", {
      class: `channel-button ${state.activeView === "channel" && state.activeChannelId === channel.id ? "active" : ""}`,
      onclick: async () => {
        state.activeView = "channel";
        state.activeChannelId = channel.id;
        await loadChannelMessages();
        render();
      },
    }, [`# ${channel.name}`]),
  );
  const channelName = h("input", { placeholder: "新频道" });
  return h("aside", { class: "sidebar" }, [
    h("div", { class: "brand" }, [
      h("strong", { text: "Agent Platform" }),
      h("button", { class: "icon", title: "退出", onclick: logout, text: "↗" }),
    ]),
    h("div", { class: "nav" }, [
      navButton("channel", "频道"),
      navButton("private", "私人 Agent"),
      navButton("knowledge", "知识库"),
      navButton("settings", "设置"),
    ]),
    h("div", { class: "channels" }, channelButtons),
    h("form", {
      class: "channel-create",
      onsubmit: async (event) => {
        event.preventDefault();
        await withBusy(async () => {
          await api("/api/channels", { method: "POST", body: JSON.stringify({ name: channelName.value }) });
          channelName.value = "";
          await loadChannels();
        });
      },
    }, [channelName, h("button", { text: "创建频道" })]),
  ]);
}

function navButton(view, label) {
  return h("button", {
    class: state.activeView === view ? "active" : "",
    onclick: async () => {
      state.activeView = view;
      if (view === "private") await loadPrivateMessages();
      if (view === "knowledge") await loadDocuments();
      if (view === "settings") await loadSecrets();
      render();
    },
  }, [label]);
}

function renderTopbar() {
  const title = state.activeView === "channel"
    ? `# ${activeChannel()?.name || "频道"}`
    : state.activeView === "private"
      ? "私人 Agent"
      : state.activeView === "knowledge"
        ? "企业知识库"
        : "系统设置";
  return h("header", { class: "topbar" }, [
    h("div", {}, [h("h1", { text: title }), h("div", { class: "muted", text: state.user.display_name })]),
    h("div", { class: "error", text: state.error }),
  ]);
}

function renderContent() {
  if (state.activeView === "private") return renderChat("private");
  if (state.activeView === "knowledge") return renderKnowledge();
  if (state.activeView === "settings") return renderSettings();
  return renderChat("channel");
}

function renderChat(mode) {
  const messages = mode === "private" ? state.privateMessages : state.messages;
  const input = h("textarea", { placeholder: mode === "private" ? "发送给你的私人 Agent" : "发送到频道主线程" });
  return h("div", { class: "chat" }, [
    h("div", { class: "messages" }, messages.map(renderMessage)),
    h("form", {
      class: "composer",
      onsubmit: async (event) => {
        event.preventDefault();
        const content = input.value.trim();
        if (!content) return;
        input.value = "";
        await withBusy(async () => {
          if (mode === "private") {
            await api("/api/private-agent/messages", { method: "POST", body: JSON.stringify({ content }) });
            await loadPrivateMessages();
          } else {
            await api(`/api/channels/${state.activeChannelId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
            await loadChannelMessages();
          }
        });
      },
    }, [input, h("button", { class: "primary", disabled: state.busy, text: state.busy ? "处理中" : "发送" })]),
  ]);
}

function renderMessage(message) {
  const suggestions = message.metadata?.knowledge_suggestions || [];
  return h("article", { class: `message ${message.author_type}` }, [
    h("div", { class: "message-head" }, [
      h("strong", { text: message.username || message.author_type }),
      h("span", { text: new Date(message.created_at * 1000).toLocaleString() }),
    ]),
    h("div", { class: "message-body", text: message.content }),
    suggestions.length ? h("div", { class: "suggestions" }, suggestions.map((s) => h("span", { class: "pill", text: `kb:${s.id} ${s.title}` }))) : null,
  ]);
}

function renderKnowledge() {
  const title = h("input", { placeholder: "标题" });
  const source = h("input", { placeholder: "来源" });
  const summary = h("input", { placeholder: "摘要（可留空）" });
  const content = h("textarea", { placeholder: "正文" });
  const search = h("input", { placeholder: "搜索知识库" });
  const docs = state.documents.map((doc) =>
    h("div", { class: "doc-row" }, [
      h("strong", { text: doc.title }),
      h("div", { class: "muted", text: doc.summary }),
      h("button", {
        onclick: async () => {
          const result = await api(`/api/knowledge/documents/${doc.id}`);
          state.selectedDocument = result.document;
          render();
        },
        text: "读取",
      }),
    ]),
  );
  return h("div", { class: "panel grid" }, [
    h("form", {
      class: "section",
      onsubmit: async (event) => {
        event.preventDefault();
        await withBusy(async () => {
          await api("/api/knowledge/documents", {
            method: "POST",
            body: JSON.stringify({ title: title.value, source: source.value, summary: summary.value, content: content.value }),
          });
          title.value = source.value = summary.value = content.value = "";
          await loadDocuments();
        });
      },
    }, [h("h2", { text: "新增条目" }), title, source, summary, content, h("button", { class: "primary", text: "保存" })]),
    h("div", { class: "section" }, [
      h("h2", { text: "条目" }),
      h("form", {
        onsubmit: async (event) => {
          event.preventDefault();
          const result = await api(`/api/knowledge/search?q=${encodeURIComponent(search.value)}`);
          state.documents = result.results;
          render();
        },
      }, [search]),
      h("div", { class: "list" }, docs),
      state.selectedDocument ? h("pre", { class: "doc-row", text: state.selectedDocument.content }) : null,
    ]),
  ]);
}

function renderSettings() {
  const rows = state.secrets.map((secret) => {
    const input = h("input", { type: "password", placeholder: secret.configured ? secret.masked : "未配置" });
    return h("div", { class: "secret-row" }, [
      h("strong", { text: secret.key }),
      h("span", { class: "muted", text: secret.configured ? secret.masked : "empty" }),
      h("form", {
        onsubmit: async (event) => {
          event.preventDefault();
          await withBusy(async () => {
            await api(`/api/settings/secrets/${secret.key}`, { method: "PUT", body: JSON.stringify({ value: input.value }) });
            input.value = "";
            await loadSecrets();
          });
        },
      }, [input, h("button", { text: "设置" })]),
    ]);
  });
  return h("div", { class: "panel" }, [
    h("div", { class: "section" }, [
      h("h2", { text: "集中密钥配置" }),
      h("div", { class: "list" }, rows),
    ]),
  ]);
}

function activeChannel() {
  return state.channels.find((c) => c.id === state.activeChannelId);
}

async function loadInitial() {
  await loadChannels();
  await loadChannelMessages();
}

async function loadChannels() {
  const result = await api("/api/channels");
  state.channels = result.channels;
  if (!state.activeChannelId && state.channels.length) state.activeChannelId = state.channels[0].id;
}

async function loadChannelMessages() {
  if (!state.activeChannelId) return;
  const result = await api(`/api/channels/${state.activeChannelId}/messages`);
  state.messages = result.messages;
}

async function loadPrivateMessages() {
  const result = await api("/api/private-agent/messages");
  state.privateMessages = result.messages;
}

async function loadDocuments() {
  const result = await api("/api/knowledge/documents");
  state.documents = result.documents;
}

async function loadSecrets() {
  const result = await api("/api/settings/secrets");
  state.secrets = result.secrets;
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  state.user = null;
  render();
}

async function withBusy(fn) {
  state.busy = true;
  state.error = "";
  render();
  try {
    await fn();
  } catch (error) {
    state.error = error.message || String(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function boot() {
  try {
    const result = await api("/api/auth/me");
    state.user = result.user;
    await loadInitial();
  } catch (_) {
    state.user = null;
  }
  render();
}

boot();
