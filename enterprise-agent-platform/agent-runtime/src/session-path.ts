import { createHash } from "node:crypto";
import { join } from "node:path";

export function sessionPath(home: string, sid: string): string {
  return join(home, "sessions-v3", `${createHash("sha256").update(sid).digest("hex")}.jsonl`);
}

/** Stable-effort plan beside the journal; deleted with the session. */
export function effortPath(home: string, sid: string): string {
  return join(home, "sessions-v3", `${createHash("sha256").update(sid).digest("hex")}.effort.json`);
}
