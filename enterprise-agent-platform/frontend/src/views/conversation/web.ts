import { parsePartialJson } from "./partialJson";
import type { Words } from "./work";

/* What a web_search / web_fetch step found, for the work trace, the computer panel and the reply's sources
 * (platform-api.md § Assistant message work trace; the gateway contract in agent-runtime.md). Live steps read it
 * from `tool_end.details`, persisted ones from the trace item's bounded fields; older events and traces carry only
 * the tool's JSON output (possibly cut), which is parsed as far as it goes. */

export interface WebResult {
  title: string;
  url: string;
  description: string;
}

export interface WebSearch {
  kind: "search";
  query: string;
  results: WebResult[];
  /** engines that did not answer, with why (CAPTCHA, suspended, …) */
  unresponsive: { engine: string; reason: string }[];
  /** an old trace's output that is not the JSON shape: shown as text */
  text?: string;
}

export interface WebPage {
  kind: "page";
  /** the final URL */
  url: string;
  title: string;
  /** null when the step predates the field */
  via: "direct" | "browser" | null;
  /** the extracted page's length in characters; null when unknown */
  chars: number | null;
  /** the page text the AI received was cut */
  truncated: boolean;
  /** the start of the page as Markdown */
  excerpt: string;
}

export interface WebFailure {
  kind: "failure";
  /** `blocked | not_found | http_error | timeout | unreachable | too_large | unsupported | invalid_url | forbidden`, or
   * `unknown` for older steps without the field */
  error: string;
  host: string;
  url: string;
  status: number | null;
  protection: string;
  /** null when unknown (older steps) */
  triedBrowser: boolean | null;
  /** the explanation the AI received */
  message: string;
}

export type WebData = WebSearch | WebPage | WebFailure;

export const WEB_TOOLS: Record<string, true> = { web_search: true, web_fetch: true };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** Image syntax never renders: a page's pictures are third-party requests. */
export function withoutImages(markdown: string): string {
  return markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/^\s*!\[[^\]]*\]:\s*\S+.*$/gm, "");
}

/** An address that may become a link: http(s) only, never `javascript:` or `data:`. */
export function safeHref(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/** The work trace's per-field bounds (platform-api.md § Assistant message work trace, `_WorkTrace`). Live details are
 * clipped to the same bounds, so a reloaded step shows exactly what the live one showed: the same rows, count, excerpt
 * and notes. */
const BOUND = { query: 500, results: 10, title: 200, url: 500, description: 240, engines: 5, engine: 64, reason: 120, pageUrl: 2000, excerpt: 2000, message: 2000 };

function results(value: unknown): WebResult[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
      const item = record(entry);
      const url = text(item?.url).slice(0, BOUND.url);
      return item && url ? [{ title: text(item.title).slice(0, BOUND.title), url, description: text(item.description).slice(0, BOUND.description) }] : [];
    }).slice(0, BOUND.results)
    : [];
}

function engines(value: unknown): WebSearch["unresponsive"] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
      const item = record(entry);
      return item ? [{ engine: text(item.engine).slice(0, BOUND.engine), reason: text(item.reason).slice(0, BOUND.reason) }] : [];
    }).slice(0, BOUND.engines).filter((item) => item.engine)
    : [];
}

/** Search data from the gateway's `data` or the trace item's fields (same names apart from the result list's). */
function search(query: unknown, list: unknown, unresponsive: unknown, args: Record<string, unknown>): WebSearch {
  return { kind: "search", query: text(query).slice(0, BOUND.query) || text(args.query), results: results(list), unresponsive: engines(unresponsive) };
}

/** A page read from the gateway's `data` or the trace item's `page` and `excerpt`. */
function page(fields: Record<string, unknown>, excerpt: unknown): WebPage {
  return {
    kind: "page", url: text(fields.url).slice(0, BOUND.pageUrl), title: text(fields.title).slice(0, BOUND.title),
    via: fields.via === "browser" ? "browser" : "direct", chars: integer(fields.chars), truncated: fields.truncated === true,
    excerpt: withoutImages(text(excerpt).slice(0, BOUND.excerpt)),
  };
}

function failure(url: string, message: string, fields: Record<string, unknown> | null): WebFailure {
  // The trace keeps no failure URL: the requested one (the call's argument) is what both show.
  const target = url || text(fields?.url);
  return {
    kind: "failure", error: text(fields?.error).slice(0, 32) || "unknown", url: target,
    host: text(fields?.host).slice(0, 255) || hostOf(target), status: integer(fields?.status), protection: text(fields?.protection).slice(0, 32),
    triedBrowser: typeof fields?.tried_browser === "boolean" ? fields.tried_browser : null, message: message.slice(0, BOUND.message),
  };
}

/** The tool's own output (an older step): the search or page JSON, as much of it as arrived. */
function fromOutput(name: string, args: Record<string, unknown>, error: boolean, output: string): WebData | null {
  const url = text(args.url);
  if (error) return failure(url, output, null);
  const parsed = output.trimStart().startsWith("{") ? record(parsePartialJson(output)) : null;
  if (name === "web_search") {
    const list = parsed && Array.isArray(parsed.web) ? results(parsed.web) : null;
    return { kind: "search", query: text(args.query), results: list ?? [], unresponsive: [], ...(list ? {} : output.trim() ? { text: output } : {}) };
  }
  return {
    kind: "page", url: text(parsed?.url) || url, title: text(parsed?.title), via: null, chars: null, truncated: false,
    excerpt: withoutImages(parsed ? text(parsed.content) : output),
  };
}

/** A finished step's data: live `tool_end.details` (the gateway's `data`), else the tool's output. Null for other
 * tools and for steps still running. */
export function webFromEvent(name: string, args: Record<string, unknown>, error: boolean, details: unknown, output: string): WebData | null {
  if (!WEB_TOOLS[name]) return null;
  const data = record(details);
  if (name === "web_search" && !error && data && Array.isArray(data.web)) return search(data.query, data.web, data.unresponsive, args);
  if (name === "web_fetch" && !error && data && text(data.url) && "excerpt" in data) return page(data, data.excerpt);
  if (name === "web_fetch" && error && data && text(data.error)) return failure(text(args.url), output, data);
  return fromOutput(name, args, error, output);
}

/** A persisted trace item's data: its bounded display fields, else its output (older traces). */
export function webFromItem(name: string, args: Record<string, unknown>, status: string, item: Record<string, unknown>, output: string): WebData | null {
  if (!WEB_TOOLS[name] || (status !== "done" && status !== "error")) return null;
  const fields = record(item.page);
  const failed = record(item.failure);
  if (name === "web_search" && Array.isArray(item.results)) return search(item.query, item.results, item.unresponsive, args);
  if (name === "web_fetch" && fields && text(fields.url)) return page(fields, item.excerpt);
  if (name === "web_fetch" && failed) return failure(text(args.url), output, failed);
  return fromOutput(name, args, status === "error", output);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** The host as people say it: without `www.` or `m.`. */
export function siteOf(url: string): string {
  return hostOf(url).replace(/^(?:www\d?|m)\./i, "");
}

/** Second-level labels under a country code that are not the site's name (sina.com.cn, bbc.co.uk). */
const GENERIC: Record<string, true> = { com: true, net: true, org: true, gov: true, edu: true, co: true, ac: true, or: true, ne: true, go: true };

/** The registrable part of a host, roughly: zhuanlan.zhihu.com → zhihu.com, finance.sina.com.cn → sina.com.cn. */
function registrable(host: string): string {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2 || /^\d+$/.test(labels[labels.length - 1])) return labels.join(".");
  const keep = labels[labels.length - 1].length === 2 && GENERIC[labels[labels.length - 2]] ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** Monogram tones: upstream semantic hues except red (which reads as failure) and a teal between accent and green.
 * No neutral: ink-2 turns light in the dark theme, where the white initial would vanish. */
const TONES = ["var(--accent)", "var(--green)", "var(--orange)", "color-mix(in oklch, var(--accent) 55%, var(--green))"];

/** A site's generated avatar: the first letter or digit of its name and a stable tone. Never a favicon: the app
 * makes no third-party requests. */
export function siteMark(url: string): { letter: string; color: string } {
  const name = registrable(siteOf(url));
  const letter = (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? "·").toUpperCase();
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return { letter, color: TONES[hash % TONES.length] };
}

/** One URL as a comparison key: no fragment, `www.`, scheme or trailing slash. */
export function urlKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch {
    return url;
  }
}

/** What happened to each page the run tried to read, by `urlKey` of the requested and the final URL. */
export function visits(steps: readonly { name: string; args: Record<string, unknown>; web?: WebData | null }[]): Map<string, "read" | "failed"> {
  const seen = new Map<string, "read" | "failed">();
  for (const step of steps) {
    if (step.name !== "web_fetch" || !step.web || step.web.kind === "search") continue;
    const outcome = step.web.kind === "page" ? "read" : "failed";
    for (const url of [text(step.args.url), step.web.url]) {
      // a later successful read of the same page wins over an earlier failure
      if (url && seen.get(urlKey(url)) !== "read") seen.set(urlKey(url), outcome);
    }
  }
  return seen;
}

export interface Source {
  url: string;
  title: string;
  site: string;
}

/** The pages a run actually read, in reading order, once each (from its work items or calls). */
export function readSources(steps: readonly { web?: WebData | null; type?: unknown; id?: unknown }[]): Source[] {
  const sources = new Map<string, Source>();
  for (const { web } of steps) {
    if (web?.kind !== "page" || !safeHref(web.url) || sources.has(urlKey(web.url))) continue;
    sources.set(urlKey(web.url), { url: web.url, title: web.title || siteOf(web.url), site: siteOf(web.url) });
  }
  return [...sources.values()];
}

/** The contract's `web_fetch` failure reasons. Each is explained to the AI, which moves on to another source, so none
 * is a malfunction: the site's side (turned the AI away, no such page, answered with an error, timed out, unreachable,
 * too large, not a page) and the AI's own bad address (not a valid URL, a private or internal address). */
const CALM_ERRORS: Record<string, true> = {
  blocked: true, not_found: true, http_error: true, timeout: true, unreachable: true, too_large: true, unsupported: true,
  invalid_url: true, forbidden: true,
};

/** A failed page read with a contract reason (above), shown calmly everywhere: the work trace row, the computer's
 * notice and its status pill. A failure without one (an older trace, a gateway error, an unknown reason) and a failed
 * search (the search service itself is down) stay real failures, in red. */
export function calmFailure(web: WebData | null | undefined): WebFailure | null {
  return web?.kind === "failure" && CALM_ERRORS[web.error] ? web : null;
}

/** A failed read in a few words, after the site's name: "reuters.com 拦截了自动访问". */
export function failureShort(failure: WebFailure, w: Words): string {
  switch (failure.error) {
    case "blocked":
      return w("blocked automated access", "拦截了自动访问", "攔截了自動存取");
    case "not_found":
      return w("has no such page", "没有这个页面", "沒有這個頁面");
    case "http_error":
      return failure.status ? w(`answered with an error (${failure.status})`, `返回了错误（${failure.status}）`, `回傳了錯誤（${failure.status}）`)
        : w("answered with an error", "返回了错误", "回傳了錯誤");
    case "timeout":
      return w("did not respond in time", "响应超时", "回應逾時");
    case "unreachable":
      return w("could not be reached", "无法连接", "無法連線");
    case "too_large":
      return w("page is too large to read", "页面太大，无法读取", "頁面太大，無法讀取");
    case "unsupported":
      return w("is not a readable page", "不是可读取的网页", "不是可讀取的網頁");
    case "invalid_url":
      return w("is not a valid address", "不是有效的网址", "不是有效的網址");
    case "forbidden":
      return w("may not be visited", "不允许访问", "不允許存取");
    default:
      return w("could not be opened", "无法打开", "無法開啟");
  }
}

/** Why a read failed and what was tried, in full sentences. */
export function failureDetail(failure: WebFailure, w: Words): string[] {
  const lines: string[] = [];
  const status = failure.status ? ` (HTTP ${failure.status})` : "";
  const statusZh = failure.status ? `（HTTP ${failure.status}）` : "";
  switch (failure.error) {
    case "blocked":
      lines.push(failure.protection
        ? w(`The site uses ${failure.protection} bot protection, which turns away automated visitors${status}.`, `该网站使用 ${failure.protection} 防护，会拦截自动访问${statusZh}。`, `該網站使用 ${failure.protection} 防護，會攔截自動存取${statusZh}。`)
        : w(`The site turns away automated visitors${status}.`, `该网站会拦截自动访问${statusZh}。`, `該網站會攔截自動存取${statusZh}。`));
      break;
    case "not_found":
      lines.push(w(`The address leads nowhere${status}; the page may have moved or been removed.`, `这个网址没有内容${statusZh}，页面可能已移动或删除。`, `這個網址沒有內容${statusZh}，頁面可能已移動或刪除。`));
      break;
    case "http_error":
      lines.push(w(`The site answered with an error${status}.`, `网站返回了错误${statusZh}。`, `網站回傳了錯誤${statusZh}。`));
      break;
    case "timeout":
      lines.push(w("The site took too long to answer.", "网站响应时间过长。", "網站回應時間過長。"));
      break;
    case "unreachable":
      lines.push(w("The site could not be reached from the server.", "服务器无法连接到这个网站。", "伺服器無法連線到這個網站。"));
      break;
    case "too_large":
      lines.push(w("The page is larger than the AI can read.", "页面超出了 AI 能读取的大小。", "頁面超出了 AI 能讀取的大小。"));
      break;
    case "unsupported":
      lines.push(w("The address is not a web page the AI can read (for example a video or an archive).", "这个网址不是 AI 能读取的网页（例如视频或压缩包）。", "這個網址不是 AI 能讀取的網頁（例如影片或壓縮檔）。"));
      break;
    case "invalid_url":
      lines.push(w("The address is not a valid web address.", "这不是有效的网址。", "這不是有效的網址。"));
      break;
    case "forbidden":
      lines.push(w("Internal and private network addresses are off limits.", "内网和私有地址不允许访问。", "內網與私有位址不允許存取。"));
      break;
    default:
      if (failure.message) lines.push(failure.message);
  }
  if (failure.triedBrowser === true) lines.push(w("A real browser was tried as well, without success.", "也尝试了用真实浏览器打开，仍未成功。", "也嘗試了用真實瀏覽器開啟，仍未成功。"));
  if (failure.error !== "unknown") lines.push(w("The AI moves on with other sources; you can still open the page yourself.", "AI 会改用其他来源；你也可以自己打开原网页查看。", "AI 會改用其他來源；你也可以自行開啟原網頁查看。"));
  return lines;
}

/** Unavailable engines as one phrase: "baidu (CAPTCHA), brave (too many requests)". */
export function engineList(unresponsive: WebSearch["unresponsive"], w: Words): string {
  return unresponsive.map(({ engine, reason }) => (reason ? w(`${engine} (${reason})`, `${engine}（${reason}）`, `${engine}（${reason}）`) : engine))
    .join(w(", ", "、", "、"));
}

/** A short form of a query for status lines. */
export function clipQuery(query: string, max = 28): string {
  const line = query.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
