import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, "..");
const platformPackageDir = resolve(frontendDir, "../enterprise_agent_platform");
const liveStaticDir = join(platformPackageDir, "static");
const viteBin = join(frontendDir, "node_modules/vite/bin/vite.js");

export const RELEASE_MANIFEST = ".static-release.json";
const FIXED_FILES = new Set([
  "index.html",
  "theme-init.js",
  "ubitech-logo.png",
  "app.js",
  "styles.css",
  RELEASE_MANIFEST,
]);
const HASHED_ASSET_RE = /-[A-Za-z0-9_-]{8,}\.(?:js|css)$/;
const MANAGED_ASSET_RE = /^(?:.*\/)?(?:app-|chunk-|styles-|asset-).+/;
const LEGACY_ASSETS = new Set(["app.js", "styles.css"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`staged output must not contain symlinks: ${entry.name}`);
    if (entry.isDirectory()) files.push(...(await listFiles(root, absolute)));
    else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join("/"));
    else throw new Error(`unsupported staged output entry: ${entry.name}`);
  }
  return files.sort();
}

function localAssetPath(value) {
  const clean = String(value || "").split(/[?#]/, 1)[0];
  if (!clean.startsWith("/") || clean.startsWith("//")) return null;
  const decoded = decodeURIComponent(clean.slice(1));
  if (!decoded || decoded.includes("\\") || decoded.split("/").includes("..")) return null;
  return decoded;
}

export function extractEntryAssets(indexHtml) {
  const scripts = [...indexHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js(?:[?#][^"']*)?)["'][^>]*>/gi)]
    .map((match) => localAssetPath(match[1]))
    .filter((asset) => asset && asset !== "theme-init.js");
  const styles = [];
  for (const [tag] of indexHtml.matchAll(/<link\b[^>]*>/gi)) {
    const relValue = /\brel=["']([^"']+)["']/i.exec(tag)?.[1] || "";
    if (!relValue.toLowerCase().split(/\s+/).includes("stylesheet")) continue;
    const href = /\bhref=["']([^"']+\.css(?:[?#][^"']*)?)["']/i.exec(tag)?.[1];
    const local = href ? localAssetPath(href) : null;
    if (local) styles.push(local);
  }
  return { scripts, styles };
}

function assertInside(root, relativePath) {
  const target = resolve(root, relativePath);
  const prefix = `${resolve(root)}${sep}`;
  if (target !== resolve(root) && !target.startsWith(prefix)) {
    throw new Error(`asset escapes staging directory: ${relativePath}`);
  }
  return target;
}

async function assertRegularNonempty(path, label) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0) {
    throw new Error(`${label} is missing or empty`);
  }
}

export async function validateStagedBuild(stageDir) {
  await listFiles(stageDir);
  const indexPath = join(stageDir, "index.html");
  const themePath = join(stageDir, "theme-init.js");
  const logoPath = join(stageDir, "ubitech-logo.png");
  await assertRegularNonempty(indexPath, "index.html");
  await assertRegularNonempty(themePath, "theme-init.js");
  await assertRegularNonempty(logoPath, "ubitech-logo.png");

  const indexHtml = await readFile(indexPath, "utf8");
  if (!/<script\b[^>]*\bsrc=["']\/theme-init\.js["']/i.test(indexHtml)) {
    throw new Error("index.html does not reference /theme-init.js");
  }
  const { scripts, styles } = extractEntryAssets(indexHtml);
  if (!scripts.length) throw new Error("index.html has no local JavaScript entry");
  if (!styles.length) throw new Error("index.html has no local stylesheet entry");

  for (const asset of [...scripts, ...styles]) {
    if (!HASHED_ASSET_RE.test(asset)) {
      throw new Error(`entry asset is not content-hashed: ${asset}`);
    }
    await assertRegularNonempty(assertInside(stageDir, asset), `entry asset ${asset}`);
  }

  const theme = await readFile(themePath, "utf8");
  if (!theme.includes("eap-theme")) throw new Error("theme-init.js failed its content check");
  const logo = await readFile(logoPath);
  if (logo.length < 100 || !logo.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("ubitech-logo.png failed its PNG signature/size check");
  }
  const entryCode = (await Promise.all(scripts.map((asset) => readFile(join(stageDir, asset), "utf8")))).join("\n");
  if (!entryCode.includes("/ubitech-logo.png")) {
    throw new Error("JavaScript entry does not reference /ubitech-logo.png");
  }

  return { files: await listFiles(stageDir), scripts, styles };
}

async function atomicCopy(source, destination, releaseId) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${destination.split(sep).at(-1)}.incoming-${releaseId}`);
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o644);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function assertLiveTreeSafe(root) {
  if (!(await exists(root))) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`live static contains a symlink: ${entry.name}`);
    if (entry.isDirectory()) await assertLiveTreeSafe(join(root, entry.name));
  }
}

export async function atomicPublish(stageDir, liveDir, manifest, { beforeCommit } = {}) {
  await mkdir(liveDir, { recursive: true });
  await assertLiveTreeSafe(liveDir);
  await writeFile(join(stageDir, RELEASE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const files = await listFiles(stageDir);
  if (!files.includes("index.html")) throw new Error("cannot publish without index.html");
  const ordered = [...files.filter((name) => name !== "index.html"), "index.html"];
  const releaseId = `${process.pid}-${Date.now()}`;
  const rollbackDir = join(stageDir, ".rollback");
  const installed = [];
  let committed = false;

  try {
    for (const relativePath of ordered) {
      if (relativePath === "index.html") await beforeCommit?.();
      const source = assertInside(stageDir, relativePath);
      const destination = assertInside(liveDir, relativePath);
      const destinationInfo = await lstat(destination).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (destinationInfo && (!destinationInfo.isFile() || destinationInfo.isSymbolicLink())) {
        throw new Error(`live destination is not a regular file: ${relativePath}`);
      }
      let backup = null;
      if (destinationInfo) {
        backup = join(rollbackDir, relativePath);
        await mkdir(dirname(backup), { recursive: true });
        await copyFile(destination, backup);
      }
      await atomicCopy(source, destination, releaseId);
      installed.push({ relativePath, destination, backup });
      if (relativePath === "index.html") committed = true;
    }
  } catch (error) {
    if (!committed) {
      const rollbackErrors = [];
      for (const item of [...installed].reverse()) {
        try {
          if (item.backup) await atomicCopy(item.backup, item.destination, `${releaseId}-rollback`);
          else await rm(item.destination, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(`${item.relativePath}: ${rollbackError?.message || rollbackError}`);
        }
      }
      if (rollbackErrors.length) {
        throw new Error(`${error?.message || error}; rollback also failed: ${rollbackErrors.join("; ")}`);
      }
    }
    throw error;
  }
}

async function readManifest(liveDir) {
  try {
    const parsed = JSON.parse(await readFile(join(liveDir, RELEASE_MANIFEST), "utf8"));
    return Array.isArray(parsed?.current_assets) ? parsed : null;
  } catch {
    return null;
  }
}

async function assetsReferencedByLiveIndex(liveDir) {
  try {
    const indexHtml = await readFile(join(liveDir, "index.html"), "utf8");
    const { scripts, styles } = extractEntryAssets(indexHtml);
    return [...scripts, ...styles];
  } catch {
    return [];
  }
}

function isManagedAsset(relativePath) {
  return LEGACY_ASSETS.has(relativePath) || MANAGED_ASSET_RE.test(relativePath);
}

export function retainedPreviousAssets(currentAssets, previousManifest, discoveredAssets = []) {
  const current = new Set(currentAssets);
  const oldCurrent = Array.isArray(previousManifest?.current_assets)
    ? previousManifest.current_assets
    : discoveredAssets;
  const sameRelease =
    !!previousManifest &&
    current.size === new Set(oldCurrent).size &&
    oldCurrent.every((name) => current.has(name));
  const candidates = sameRelease
    ? previousManifest.previous_assets || []
    : oldCurrent;
  return [...new Set(candidates)].filter((name) => !current.has(name));
}

async function removeStaleAssets(liveDir, keep, previousManifest) {
  const files = await listFiles(liveDir);
  const known = new Set([
    ...(previousManifest?.current_assets || []),
    ...(previousManifest?.previous_assets || []),
  ]);
  for (const relativePath of files) {
    if (FIXED_FILES.has(relativePath) || keep.has(relativePath)) continue;
    if (isManagedAsset(relativePath) || known.has(relativePath)) {
      await rm(join(liveDir, relativePath), { force: true });
    }
  }
}

function runVite(stageDir) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [viteBin, "build", "--outDir", stageDir, "--emptyOutDir"],
      { cwd: frontendDir, env: process.env, stdio: "inherit" },
    );
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Vite build failed (${signal || `exit ${code}`})`));
    });
  });
}

async function copyLogoIntoStage(stageDir) {
  const publicLogo = join(frontendDir, "public/ubitech-logo.png");
  const source = (await exists(publicLogo)) ? publicLogo : join(liveStaticDir, "ubitech-logo.png");
  if (!(await exists(source))) {
    throw new Error("ubitech-logo.png is missing from both frontend/public and live static");
  }
  await copyFile(source, join(stageDir, "ubitech-logo.png"));
}

async function writeLegacyEntrypoints(stageDir, validated) {
  // Keep the pre-hashed entry URLs valid across the first migration release.
  // Older index.html responses may still request these names while a deploy is
  // replacing the live tree; the tiny shims always point at the new build.
  if (validated.scripts.length !== 1 || validated.styles.length !== 1) {
    throw new Error("legacy entrypoint shims require exactly one JavaScript and CSS entry");
  }
  await writeFile(join(stageDir, "app.js"), `import "/${validated.scripts[0]}";\n`, "utf8");
  await writeFile(join(stageDir, "styles.css"), `@import url("/${validated.styles[0]}");\n`, "utf8");
}

async function main() {
  await mkdir(platformPackageDir, { recursive: true });
  const stageDir = join(platformPackageDir, `.static-staging-${process.pid}-${Date.now()}`);
  await mkdir(stageDir, { recursive: true });
  try {
    const [stageDevice, liveParentDevice] = await Promise.all([
      stat(stageDir).then((value) => value.dev),
      stat(platformPackageDir).then((value) => value.dev),
    ]);
    if (stageDevice !== liveParentDevice) throw new Error("static staging must share the live filesystem");
    await runVite(stageDir);
    await copyLogoIntoStage(stageDir);
    const validated = await validateStagedBuild(stageDir);
    await writeLegacyEntrypoints(stageDir, validated);
    const previousManifest = await readManifest(liveStaticDir);
    const discoveredPrevious = await assetsReferencedByLiveIndex(liveStaticDir);
    const currentAssets = validated.files.filter((name) => !FIXED_FILES.has(name));
    const previousAssets = retainedPreviousAssets(currentAssets, previousManifest, discoveredPrevious);
    const manifest = {
      version: 1,
      current_assets: currentAssets,
      previous_assets: previousAssets,
    };
    await atomicPublish(stageDir, liveStaticDir, manifest);

    // Keep one previous content-hashed release for already-open pages. Cleanup
    // is post-commit and best-effort; publication is already complete here.
    const keep = new Set([...currentAssets, ...previousAssets]);
    await removeStaleAssets(liveStaticDir, keep, previousManifest).catch((error) => {
      process.stderr.write(`Static build published; stale-asset cleanup skipped: ${error?.message || error}\n`);
    });
    process.stdout.write(`Static build published atomically to ${liveStaticDir}\n`);
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
