import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  brotliDecompress as brotliDecompressCallback,
  gunzip as gunzipCallback,
} from "node:zlib";
import { precompressStaticAssets } from "./build-static.mjs";

const roots = [];
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const brotliDecompress = promisify(brotliDecompressCallback);
const gunzip = promisify(gunzipCallback);

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "eap-static-build-"));
  roots.push(root);
  return root;
}

async function writeFixture(outputDir) {
  await mkdir(outputDir, { recursive: true });
  const app = "app-AbCd1234.js";
  const styles = "styles-ZyXw9876.css";
  await Promise.all([
    writeFile(
      join(outputDir, "index.html"),
      `<!doctype html><script src="/theme-init.js"></script><script type="module" src="/${app}"></script><link rel="stylesheet" href="/${styles}">`,
    ),
    writeFile(join(outputDir, app), `console.log("application-ready")`),
    writeFile(join(outputDir, styles), "body{color:black}"),
    writeFile(join(outputDir, "theme-init.js"), `localStorage.getItem("eap-theme")`),
    writeFile(join(outputDir, "asset.png"), Buffer.concat([pngSignature, Buffer.alloc(1024)])),
  ]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("static asset precompression", () => {
  it("writes lossless Brotli and Gzip sidecars for sizeable text assets", async () => {
    const root = await temporaryRoot();
    const stage = join(root, "stage");
    await writeFixture(stage);
    const source = "const payload = 'agent platform performance';\n".repeat(100);
    await writeFile(join(stage, "app-AbCd1234.js"), source);

    await precompressStaticAssets(stage);
    expect(
      (await brotliDecompress(await readFile(join(stage, "app-AbCd1234.js.br")))).toString(),
    ).toBe(source);
    expect(
      (await gunzip(await readFile(join(stage, "app-AbCd1234.js.gz")))).toString(),
    ).toBe(source);
  });

  it("does not waste sidecars on tiny text or binary assets", async () => {
    const root = await temporaryRoot();
    const stage = join(root, "stage");
    await writeFixture(stage);

    await precompressStaticAssets(stage);
    expect((await readdir(stage)).some((name) => name.startsWith("asset.png."))).toBe(false);
    expect((await readdir(stage)).some((name) => name === "theme-init.js.br")).toBe(false);
  });
});

