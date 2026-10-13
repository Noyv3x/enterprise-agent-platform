// Office file viewer: runs inside an opaque-origin, CSP-sandboxed iframe (docs/reference/platform-api.md § Office viewer).
// No React, no network except fetching the one file from its own URL (`?raw=1`). One lazy chunk per format.
import { messages } from "./messages";
import { withinZipLimits } from "./zipLimits";

type Renderer = (data: ArrayBuffer, root: HTMLElement, stacked: boolean) => Promise<void>;

const LOADERS: Record<string, () => Promise<{ render: Renderer }>> = {
  docx: () => import("./docx"),
  xlsx: () => import("./xlsx"),
  pptx: () => import("./pptx"),
};
const FILE_LIMIT = 64 * 1024 * 1024;
const LOG_LIMIT = 50;

declare global {
  interface Window {
    __eapLog?: string[];
  }
}

const log: string[] = (window.__eapLog = []);
function record(text: unknown) {
  if (log.length < LOG_LIMIT) log.push(String(text instanceof Error ? text.stack || text.message : text).slice(0, 500));
}
window.addEventListener("error", (event) => record(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => record(event.reason));

function state(value: "ready" | "error") {
  document.documentElement.setAttribute("data-eap-viewer", value);
}

function fail(root: HTMLElement, key: "failed" | "unsupported" | "tooLarge") {
  root.replaceChildren();
  const box = document.createElement("div");
  box.className = "eap-error";
  box.setAttribute("role", "alert");
  box.textContent = messages()[key];
  root.append(box);
  state("error");
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;
  const kind = document.documentElement.getAttribute("data-kind") ?? "";
  const load = LOADERS[kind];
  if (!load) return fail(root, "unsupported");
  try {
    const url = new URL(location.href);
    url.search = "?raw=1";
    url.hash = "";
    const response = await fetch(url.href, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    if (data.byteLength > FILE_LIMIT) return fail(root, "tooLarge");
    if (!withinZipLimits(data)) return fail(root, "tooLarge");
    const { render } = await load();
    await render(data, root, document.documentElement.getAttribute("data-layout") === "stacked");
    state("ready");
  } catch (error) {
    record(error);
    fail(root, "failed");
  }
}

void main();
