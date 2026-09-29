import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { id, nowIso } from "./utils.js";

interface AlwaysGrant {
  scope_key: string;
  approval_key: string;
  tool_name: string;
  created_at: string;
}

interface AlwaysGrantFile {
  version: 2;
  grants: AlwaysGrant[];
}

export class AlwaysApprovalStore {
  private readonly file: string;
  private grants = new Map<string, AlwaysGrant>();
  private commitError?: Error;

  constructor(home: string) {
    this.file = join(home, "approvals", "always.json");
    const stored = readJsonFile<unknown>(this.file, { version: 2, grants: [] });
    if (isAlwaysGrantFile(stored)) {
      for (const grant of stored.grants) {
        this.grants.set(this.key(grant.scope_key, grant.approval_key), grant);
      }
    } else if (existsSync(this.file)) {
      // Any unscoped or invalid grant could authorize unrelated commands.
      // Fail closed by replacing it with an empty current store.
      this.flush();
    }
  }

  has(scopeKey: string, approvalKey: string): boolean {
    if (this.commitError) throw this.commitError;
    return this.grants.has(this.key(scopeKey, approvalKey));
  }

  grant(scopeKey: string, approvalKey: string, toolName: string): void {
    const key = this.key(scopeKey, approvalKey);
    if (this.commitError) throw this.commitError;
    if (this.grants.has(key)) return;
    const candidate = new Map(this.grants);
    candidate.set(key, {
      scope_key: scopeKey,
      approval_key: approvalKey,
      tool_name: toolName,
      created_at: nowIso(),
    });
    this.flush(candidate);
  }

  private flush(candidate = this.grants): void {
    if (this.commitError) throw this.commitError;
    try {
      writeJsonAtomic(this.file, { version: 2, grants: [...candidate.values()] } satisfies AlwaysGrantFile);
    } catch (error) {
      if (error instanceof UncertainCommitError) this.commitError = error;
      throw error;
    }
    this.grants = candidate;
  }

  private key(scopeKey: string, approvalKey: string): string {
    return `${scopeKey}\0${approvalKey}`;
  }
}

function isAlwaysGrantFile(value: unknown): value is AlwaysGrantFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { version?: unknown; grants?: unknown };
  return candidate.version === 2
    && Array.isArray(candidate.grants)
    && candidate.grants.every((grant) => {
      if (!grant || typeof grant !== "object" || Array.isArray(grant)) return false;
      const item = grant as Record<string, unknown>;
      return typeof item.scope_key === "string" && item.scope_key.length > 0
        && typeof item.approval_key === "string" && item.approval_key.startsWith("v2:")
        && typeof item.tool_name === "string" && item.tool_name.length > 0
        && typeof item.created_at === "string";
    });
}

// After rename the disk may contain the candidate despite a failed directory
// sync. Fence the store until restart rather than overwrite evidence from a
// stale in-memory snapshot or authorize an unconfirmed grant.
class UncertainCommitError extends Error {}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`Unable to read persistent runtime state ${file}: ${(error as Error).message}`);
  }
}

function writeJsonAtomic(file: string, value: AlwaysGrantFile): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = join(directory, `.${id("state")}.tmp`);
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    renamed = true;
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (renamed) throw new UncertainCommitError(`Persistent runtime state commit is uncertain: ${(error as Error).message}`, { cause: error });
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
