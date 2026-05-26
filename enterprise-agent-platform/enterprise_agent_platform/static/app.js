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
  runtimes: null,
  hermesConfig: null,
  oauthProviders: null,
  oauthFlows: {},
  oauthCallbackUrls: {},
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
      if (view === "settings") await loadSettings();
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
  const providerBaseUrl = h("input", {
    value: hermes.provider_base_url || "",
    placeholder: "默认使用所选 OAuth 供应商 endpoint",
  });
  const model = h("input", { value: hermes.model || "" });
  const installExtras = h("input", { value: hermes.install_extras || "", placeholder: "可选，例如 dev" });
  const startupWait = h("input", { type: "number", min: "0", max: "120", step: "0.5", value: hermes.startup_wait_seconds ?? 8 });
  const apiKey = h("input", {
    type: "password",
    placeholder: hermes.api_key_configured ? "保持不变" : "API server key",
  });
  const rows = state.secrets.filter((secret) => !isOAuthSecret(secret.key)).map((secret) => {
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
  const runtimeRows = state.runtimes ? Object.values(state.runtimes).map((runtime) =>
    h("div", { class: "runtime-row" }, [
      h("div", {}, [
        h("strong", { text: runtime.name }),
        h("span", { class: `status ${runtime.available ? "ok" : "warn"}`, text: runtime.state }),
        h("div", { class: "muted", text: runtime.detail || runtime.error || runtime.path || "" }),
      ]),
      h("div", { class: "runtime-actions" }, [
        runtime.name === "hermes" ? h("button", {
          onclick: async () => {
            await withBusy(async () => {
              await api("/api/system/runtime/hermes/install", { method: "POST", body: "{}" });
              await loadSettings();
            });
          },
          text: "安装",
        }) : null,
        h("button", {
          onclick: async () => {
            await withBusy(async () => {
              await api(`/api/system/runtime/${runtime.name}/restart`, { method: "POST", body: "{}" });
              await loadSettings();
            });
          },
          text: runtime.name === "hermes" ? "重启" : "刷新",
        }),
      ]),
    ]),
  ) : [];
  return h("div", { class: "panel" }, [
    renderOAuthSettings(),
    h("div", { class: "section" }, [
      h("h2", { text: "底层基座" }),
      h("div", { class: "list" }, runtimeRows),
    ]),
    h("form", {
      class: "section config-form",
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
              api_key: apiKey.value,
            }),
          });
          apiKey.value = "";
          await loadSettings();
        });
      },
    }, [
      h("h2", { text: "Hermes 配置" }),
      h("label", { class: "check-row" }, [manageHermes, h("span", { text: "由平台托管 Hermes" })]),
      field("源码路径", repoPath),
      field("API URL", apiUrl),
      field("API 供应商", provider),
      field("供应商 Base URL", providerBaseUrl),
      field("模型", model),
      field("安装 extras", installExtras),
      field("启动等待秒数", startupWait),
      field("API Server Key", apiKey),
      h("div", { class: "form-actions" }, [
        h("button", { class: "primary", type: "submit", disabled: state.busy, text: "保存配置" }),
        h("button", {
          type: "button",
          disabled: state.busy,
          onclick: async () => {
            await withBusy(async () => {
              await api("/api/system/runtime/hermes/install", { method: "POST", body: "{}" });
              await loadSettings();
            });
          },
          text: "从源码重装",
        }),
      ]),
    ]),
    h("div", { class: "section" }, [
      h("h2", { text: "平台内部密钥" }),
      rows.length ? h("div", { class: "list" }, rows) : h("div", { class: "muted", text: "暂无可手动配置的内部密钥" }),
    ]),
  ]);
}

function renderOAuthSettings() {
  const providers = state.oauthProviders?.providers || [];
  return h("div", { class: "section" }, [
    h("h2", { text: "API 供应商验证" }),
    h("div", { class: "oauth-grid" }, providers.map(renderOAuthProviderCard)),
  ]);
}

function renderOAuthProviderCard(provider) {
  const flow = state.oauthFlows[provider.id];
  const callbackValue = state.oauthCallbackUrls[provider.id] || "";
  const statusClass = provider.configured ? "ok" : "warn";
  const header = h("div", { class: "oauth-card-head" }, [
    h("div", {}, [
      h("strong", { text: provider.label }),
      h("div", { class: "muted", text: provider.model }),
    ]),
    h("span", { class: `status ${statusClass}`, text: provider.configured ? "已验证" : "未验证" }),
  ]);
  const meta = h("div", { class: "oauth-meta" }, [
    provider.active ? h("span", { class: "pill", text: "当前使用" }) : null,
    provider.last_refresh ? h("span", { class: "muted", text: `更新：${formatTimestamp(provider.last_refresh)}` }) : null,
  ]);
  const startButton = h("button", {
    class: provider.configured ? "" : "primary",
    disabled: state.busy,
    onclick: async () => startOAuthVerification(provider.id),
    text: provider.configured ? "重新验证" : "开始验证",
  });
  const children = [header, meta, h("div", { class: "oauth-actions" }, [startButton])];
  if (flow?.kind === "device_code") {
    children.push(renderCodexOAuthFlow(provider.id, flow));
  } else if (flow?.kind === "manual_callback") {
    children.push(renderGrokOAuthFlow(provider.id, flow, callbackValue));
  }
  if (flow?.complete) {
    children.push(h("div", { class: "oauth-guide complete", text: "验证完成，Hermes 已切换到该供应商。" }));
  }
  return h("div", { class: "oauth-card" }, children);
}

function renderCodexOAuthFlow(providerId, flow) {
  return h("div", { class: "oauth-guide" }, [
    h("div", { class: "oauth-line" }, [
      h("span", { text: "验证页" }),
      h("a", { href: flow.verification_url, target: "_blank", rel: "noreferrer", text: flow.verification_url }),
    ]),
    h("div", { class: "oauth-code", text: flow.user_code }),
    h("div", { class: "oauth-actions" }, [
      h("button", {
        disabled: state.busy,
        onclick: async () => pollOAuthVerification(providerId, flow.flow_id),
        text: "检查状态",
      }),
      h("span", { class: "muted", text: `状态：${oauthStatusLabel(flow.status)}` }),
    ]),
  ]);
}

function renderGrokOAuthFlow(providerId, flow, callbackValue) {
  const callbackInput = h("textarea", {
    placeholder: "粘贴浏览器跳转后的完整 callback URL",
    oninput: (event) => {
      state.oauthCallbackUrls[providerId] = event.target.value;
    },
  });
  callbackInput.value = callbackValue;
  return h("div", { class: "oauth-guide" }, [
    h("div", { class: "oauth-line" }, [
      h("span", { text: "授权页" }),
      h("a", { href: flow.authorize_url, target: "_blank", rel: "noreferrer", text: "打开 Grok OAuth" }),
    ]),
    h("div", { class: "oauth-line" }, [
      h("span", { text: "回调地址" }),
      h("code", { text: flow.redirect_uri }),
    ]),
    callbackInput,
    h("div", { class: "oauth-actions" }, [
      h("button", {
        disabled: state.busy,
        onclick: async () => completeOAuthVerification(providerId, flow.flow_id),
        text: "完成验证",
      }),
      h("span", { class: "muted", text: `状态：${oauthStatusLabel(flow.status)}` }),
    ]),
  ]);
}

function field(label, control) {
  return h("label", { class: "field" }, [h("span", { text: label }), control]);
}

function isOAuthSecret(key) {
  return key.includes("_OAUTH_");
}

function oauthStatusLabel(status) {
  const labels = {
    waiting_for_user: "等待网页登录",
    waiting_for_callback: "等待回调 URL",
    complete: "已完成",
  };
  return labels[status] || status || "等待中";
}

function formatTimestamp(value) {
  if (!value) return "";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
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

async function loadOAuthProviders() {
  state.oauthProviders = await api("/api/system/oauth/providers");
}

async function loadRuntime() {
  state.runtimes = await api("/api/system/runtime");
}

async function loadHermesConfig() {
  state.hermesConfig = await api("/api/system/hermes/config");
}

async function loadSettings() {
  await Promise.all([loadSecrets(), loadRuntime(), loadHermesConfig(), loadOAuthProviders()]);
}

async function startOAuthVerification(providerId) {
  await withBusy(async () => {
    const result = await api(`/api/system/oauth/${providerId}/start`, { method: "POST", body: "{}" });
    updateOAuthState(providerId, result);
    await loadHermesConfig();
  });
}

async function pollOAuthVerification(providerId, flowId) {
  await withBusy(async () => {
    const result = await api(`/api/system/oauth/${providerId}/poll`, {
      method: "POST",
      body: JSON.stringify({ flow_id: flowId }),
    });
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
  state.oauthProviders = {
    providers: result.providers || [],
    active_provider: result.active_provider || providerId,
  };
  if (result.flow) state.oauthFlows[providerId] = result.flow;
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
