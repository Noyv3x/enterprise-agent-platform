import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  brotliCompress as brotliCompressCallback,
  constants as zlibConstants,
  gzip as gzipCallback,
} from "node:zlib";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, "..");
const staticDir = resolve(frontendDir, "../enterprise_agent_platform/static");
const viteBin = join(frontendDir, "node_modules/vite/bin/vite.js");

const COMPRESSIBLE_ASSET_RE = /\.(?:css|html|js|json|map|svg|txt|xml)$/i;
const PRECOMPRESS_MIN_BYTES = 512;
const brotliCompress = promisify(brotliCompressCallback);
const gzip = promisify(gzipCallback);

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

function runVite() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [viteBin, "build", "--outDir", staticDir, "--emptyOutDir"],
      { cwd: frontendDir, env: process.env, stdio: "inherit" },
    );
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Vite build failed (${signal || `exit ${code}`})`));
    });
  });
}

export async function precompressStaticAssets(outputDir) {
  const files = await listFiles(outputDir);
  for (const sourcePath of files) {
    if (!COMPRESSIBLE_ASSET_RE.test(sourcePath)) continue;
    const source = await readFile(sourcePath);
    if (source.length < PRECOMPRESS_MIN_BYTES) continue;
    const [brotli, gzipped] = await Promise.all([
      brotliCompress(source, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 7,
          [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        },
      }),
      gzip(source, { level: 6, mtime: 0 }),
    ]);
    await Promise.all([
      writeFile(`${sourcePath}.br`, brotli, { mode: 0o644 }),
      writeFile(`${sourcePath}.gz`, gzipped, { mode: 0o644 }),
    ]);
  }
}

async function main() {
  await runVite();
  await precompressStaticAssets(staticDir);
  process.stdout.write(`Static build written to ${staticDir}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
