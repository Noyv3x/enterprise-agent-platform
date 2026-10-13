import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The Office viewer runs inside an opaque-origin sandboxed iframe (platform-api.md § Office viewer). It is its own bundle,
// separate from the app: `viewer.js` plus one lazily imported chunk per format, served by Platform under `/file-viewer/`.
export async function writeFileViewer(outputDir) {
  const target = join(outputDir, "file-viewer");
  await rm(target, { recursive: true, force: true });
  await build({
    configFile: false,
    root: join(frontendDir, "file-viewer"),
    base: "/file-viewer/",
    logLevel: "warn",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: target,
      emptyOutDir: true,
      target: "es2020",
      modulePreload: false,
      cssCodeSplit: false,
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        input: join(frontendDir, "file-viewer/viewer.ts"),
        output: {
          format: "es",
          entryFileNames: "viewer.js",
          chunkFileNames: "chunk-[name]-[hash].js",
          assetFileNames: "asset-[name]-[hash][extname]",
        },
      },
    },
  });
  return target;
}
