/** What artifact pages keep in `localStorage`, kept by the panel per artifact (frontend.md § Artifacts).
 *
 * Pages run in an opaque origin, where the browser's storage throws; the page runtime (`/artifact-runtime.js`) gives
 * them an in-memory `localStorage` and posts its contents (`eap-storage`) to the panel after changes. The panel keeps
 * the latest snapshot in memory and in its own `localStorage`, and hands it back on the next load through the frame
 * URL's `#__eap=<base64url JSON>` fragment, which the runtime reads and strips before page scripts run.
 *
 * Every kept record is `{t, data}`, `t` its last use (saved or seeded). All records together stay within
 * TOTAL_BUDGET_BYTES: the least recently used are dropped first, so pages never fill the app's own storage. */

/** A snapshot larger than this (UTF-8 JSON) is not kept. */
export const STORAGE_CAP_BYTES = 256 * 1024;
/** All kept records together (UTF-8 JSON) stay within this. */
export const TOTAL_BUDGET_BYTES = 1024 * 1024;

const PREFIX = "eap-artifact-storage:";
const FRAGMENT = "#__eap=";

type Snapshot = Record<string, string>;
interface Kept { t: number; data: Snapshot; bytes: number }

/** Records by key, also when the browser's own storage is unavailable or full. */
const memory = new Map<string, Kept>();
/** The last use stamp handed out: strictly increasing, so uses in the same millisecond keep their order. */
let lastUse = 0;

/** The key of one artifact's snapshot for one account: a shared browser never seeds another account's page. */
export function frameStorageKey(owner: string | number | undefined, artifactId: number): string {
  return `${PREFIX}${owner ?? "-"}:${artifactId}`;
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** A plain object of string values, or null. */
function snapshotOf(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== "string")) return null;
  return Object.fromEntries(entries) as Snapshot;
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** A record from the browser's storage; anything unreadable counts as never used, so it goes first. */
function storedRecord(storage: Storage, key: string): Kept | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { t?: unknown; data?: unknown };
    const data = snapshotOf(parsed?.data);
    if (data && typeof parsed.t === "number") return { t: parsed.t, data, bytes: utf8Length(raw) };
  } catch {
    // Unreadable: dropped by the next budget pass.
  }
  return { t: 0, data: {}, bytes: utf8Length(raw) };
}

/** Writes a record as used now, in memory and in the browser's storage. */
function keep(key: string, data: Snapshot): void {
  lastUse = Math.max(Date.now(), lastUse + 1);
  const json = JSON.stringify({ t: lastUse, data });
  memory.set(key, { t: lastUse, data, bytes: utf8Length(json) });
  try {
    browserStorage()?.setItem(key, json);
  } catch {
    // Quota exceeded: the record still lives in memory for this tab.
  }
  enforceBudget(key);
}

function forget(key: string): void {
  memory.delete(key);
  browserStorage()?.removeItem(key);
}

/** Drops the least recently used records until all fit TOTAL_BUDGET_BYTES; `current` (just used) stays. */
function enforceBudget(current: string): void {
  const storage = browserStorage();
  const records = new Map<string, Kept>(memory);
  if (storage) {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(PREFIX) && !records.has(key)) {
        const record = storedRecord(storage, key);
        if (record) records.set(key, record);
      }
    }
  }
  let total = 0;
  for (const record of records.values()) total += record.bytes;
  const oldestFirst = [...records].filter(([key]) => key !== current).sort(([, a], [, b]) => a.t - b.t);
  for (const [key, record] of oldestFirst) {
    if (total <= TOTAL_BUDGET_BYTES) break;
    forget(key);
    total -= record.bytes;
  }
}

/** The kept snapshot, marked as used now (a seeded page counts as recent). */
export function loadFrameStorage(key: string): Snapshot | null {
  let data = memory.get(key)?.data ?? null;
  if (!data) {
    const storage = browserStorage();
    const record = storage ? storedRecord(storage, key) : null;
    data = record && record.t > 0 ? record.data : null;
  }
  if (data) keep(key, data);
  return data;
}

/** Keeps a page's `eap-storage` snapshot; an empty, malformed or oversized one clears what was kept. */
export function saveFrameStorage(key: string, data: unknown): void {
  const snapshot = snapshotOf(data);
  if (!snapshot || !Object.keys(snapshot).length || utf8Length(JSON.stringify(snapshot)) > STORAGE_CAP_BYTES) {
    forget(key);
    return;
  }
  keep(key, snapshot);
}

export function base64url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The frame URL carrying the kept snapshot in its fragment; a URL with its own fragment is left alone. */
export function seededFrameUrl(url: string, key: string): string {
  if (url.includes("#")) return url;
  const snapshot = loadFrameStorage(key);
  if (!snapshot) return url;
  return `${url}${FRAGMENT}${base64url(JSON.stringify(snapshot))}`;
}
