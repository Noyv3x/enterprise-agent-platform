import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function scopeOwns(owner: string, candidate: string): boolean {
  return candidate === owner || candidate.startsWith(`${owner}/delegate/`);
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function assertNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
}

export function resolveWorkspacePath(workspace: string, requested: string): string {
  const base = resolve(workspace);
  return isAbsolute(requested) ? resolve(requested) : resolve(base, requested);
}

export function abortError(reason = "Operation aborted"): Error {
  const error = new Error(reason);
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function truncate(value: string, max = 100_000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… ${value.length - max} characters omitted`;
}
