import { constants } from "node:fs";
import { chmod, type FileHandle, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { id } from "./utils.js";

/** Serialize a key without retaining completed or failed operations. */
export async function withQueue<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).then(task);
  const settled = result.then(() => undefined, () => undefined);
  queues.set(key, settled);
  try {
    return await result;
  } finally {
    if (queues.get(key) === settled) queues.delete(key);
  }
}

export function keyedQueue() {
  const queues = new Map<string, Promise<void>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => withQueue(queues, key, task);
}

export async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function removeDurableFile(file: string): Promise<void> {
  await rm(file, { force: true });
  try {
    await syncDirectory(dirname(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function replaceText(file: string, text: string, enforceMode = true): Promise<void> {
  const temporary = `${file}.${id("state")}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    if (enforceMode) await chmod(file, 0o600);
    await syncDirectory(dirname(file));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function writeState(file: string, state: object, enforceMode = true): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await replaceText(file, `${JSON.stringify(state, null, 2)}\n`, enforceMode);
}

/** Inspect the opened inode, not the path, before trusting a private sidecar. */
export async function readPrivateText(
  file: string,
  label: string,
  maximumBytes: number,
  runtimeUid = typeof process.getuid === "function" ? process.getuid() : undefined,
  checkReadSize = false,
): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} is not a regular file`);
    if (info.nlink !== 1) throw new Error(`${label} must have exactly one link`);
    if (runtimeUid !== undefined && info.uid !== runtimeUid) {
      throw new Error(`${label} is not owned by the Runtime user`);
    }
    if ((info.mode & 0o077) !== 0) throw new Error(`${label} is not owner-only`);
    if (info.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    const raw = await handle.readFile({ encoding: "utf8" });
    if (checkReadSize && Buffer.byteLength(raw, "utf8") > maximumBytes) {
      throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    }
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`${label} must not be a symbolic link`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
