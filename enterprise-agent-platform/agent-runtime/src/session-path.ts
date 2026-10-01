import { createHash } from "node:crypto";
import { join } from "node:path";

export function sessionPath(home: string, sid: string): string {
  return join(home, "sessions-v3", `${createHash("sha256").update(sid).digest("hex")}.jsonl`);
}
