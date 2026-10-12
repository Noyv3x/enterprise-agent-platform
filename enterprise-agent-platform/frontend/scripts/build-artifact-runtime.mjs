import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "vite";

const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "../artifact-runtime/runtime.js");

// The helper is plain ES2015 browser JavaScript, not part of the Vite module
// graph: Platform injects it, un-hashed, into artifact pages (platform-api.md
// § Artifacts) and derives the `?v=` cache key from the built bytes.
export async function minifyArtifactRuntime() {
  const result = await minify("artifact-runtime.js", await readFile(sourcePath, "utf8"), {
    compress: { target: "es2015" },
    mangle: true,
    codegen: { removeWhitespace: true },
  });
  return result.code;
}

export async function writeArtifactRuntime(outputDir) {
  const code = await minifyArtifactRuntime();
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "artifact-runtime.js"), code, { mode: 0o644 });
  return code;
}
