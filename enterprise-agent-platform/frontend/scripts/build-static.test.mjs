import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  brotliDecompress as brotliDecompressCallback,
  gunzip as gunzipCallback,
} from "node:zlib";
import {
  atomicPublish,
  precompressStaticAssets,
  retainedPreviousAssets,
  validateStagedBuild,
} from "./build-static.mjs";

const roots = [];
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const brotliDecompress = promisify(brotliDecompressCallback);
const gunzip = promisify(gunzipCallback);

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "eap-static-build-"));
  roots.push(root);
  return root;
}

async function writeFixture(stage, { hashed = true } = {}) {
  await mkdir(stage, { recursive: true });
  const app = hashed ? "app-AbCd1234.js" : "app.js";
  const styles = hashed ? "styles-ZyXw9876.css" : "styles.css";
  await Promise.all([
    writeFile(
      join(stage, "index.html"),
      `<!doctype html><script src="/theme-init.js"></script><script type="module" src="/${app}"></script><link rel="stylesheet" href="/${styles}">`,
    ),
    writeFile(join(stage, app), `console.log("/ubitech-logo.png")`),
    writeFile(join(stage, styles), "body{color:black}"),
    writeFile(join(stage, "theme-init.js"), `localStorage.getItem("eap-theme")`),
    writeFile(join(stage, "ubitech-logo.png"), Buffer.concat([pngSignature, Buffer.alloc(128)])),
  ]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("static build validation", () => {
  it("accepts a complete content-hashed release", async () => {
    const root = await temporaryRoot();
    const stage = join(root, "stage");
    await writeFixture(stage);
    const result = await validateStagedBuild(stage);
    expect(result.scripts).toEqual(["app-AbCd1234.js"]);
    expect(result.styles).toEqual(["styles-ZyXw9876.css"]);
  });

  it("rejects unhashed entry assets before publication", async () => {
    const root = await temporaryRoot();
    const stage = join(root, "stage");
    await writeFixture(stage, { hashed: false });
    await expect(validateStagedBuild(stage)).rejects.toThrow("not content-hashed");
  });
});

describe("static asset precompression", () => {
  it("writes deterministic Brotli and Gzip sidecars for sizeable text assets", async () => {
    const root = await temporaryRoot();
    const stage = join(root, "stage");
    await writeFixture(stage);
    const source = "const payload = 'ubitech agent performance';\n".repeat(100);
    await writeFile(join(stage, "app-AbCd1234.js"), source);

    expect(await precompressStaticAssets(stage)).toContain("app-AbCd1234.js");
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
    expect((await readdir(stage)).some((name) => name.startsWith("ubitech-logo.png."))).toBe(false);
    expect((await readdir(stage)).some((name) => name === "theme-init.js.br")).toBe(false);
  });
});

describe("previous release retention", () => {
  it("retains compressed variants together with their hashed source asset", () => {
    const current = [
      "app-current123.js",
      "app-current123.js.br",
      "app-current123.js.gz",
    ];
    const previous = {
      current_assets: [
        "app-previous1.js",
        "app-previous1.js.br",
        "app-previous1.js.gz",
      ],
      previous_assets: [],
    };

    expect(retainedPreviousAssets(current, previous)).toEqual([
      "app-previous1.js",
      "app-previous1.js.br",
      "app-previous1.js.gz",
    ]);
  });

  it("keeps the previous release when rebuilding identical current assets", () => {
    expect(
      retainedPreviousAssets(
        ["app-current.js", "styles-current.css"],
        {
          current_assets: ["styles-current.css", "app-current.js"],
          previous_assets: ["app-previous.js", "styles-previous.css"],
        },
      ),
    ).toEqual(["app-previous.js", "styles-previous.css"]);
  });

  it("promotes the old current release when content hashes change", () => {
    expect(
      retainedPreviousAssets(
        ["app-new.js", "styles-new.css"],
        {
          current_assets: ["app-old.js", "styles-old.css"],
          previous_assets: ["app-older.js"],
        },
      ),
    ).toEqual(["app-old.js", "styles-old.css"]);
  });
});

describe("atomic static publication", () => {
  it("restores every touched live file when commit is interrupted", async () => {
    const root = await temporaryRoot();
    const stage = join(root, "stage");
    const live = join(root, "live");
    await writeFixture(stage);
    await mkdir(live, { recursive: true });
    await Promise.all([
      writeFile(join(live, "index.html"), "old index"),
      writeFile(join(live, "theme-init.js"), "old theme"),
      writeFile(join(live, "ubitech-logo.png"), "old logo"),
    ]);

    await expect(
      atomicPublish(
        stage,
        live,
        { version: 1, current_assets: ["app-AbCd1234.js", "styles-ZyXw9876.css"], previous_assets: [] },
        { beforeCommit: () => { throw new Error("simulated commit failure"); } },
      ),
    ).rejects.toThrow("simulated commit failure");

    expect(await readFile(join(live, "index.html"), "utf8")).toBe("old index");
    expect(await readFile(join(live, "theme-init.js"), "utf8")).toBe("old theme");
    expect(await readFile(join(live, "ubitech-logo.png"), "utf8")).toBe("old logo");
    expect((await readdir(live)).sort()).toEqual(["index.html", "theme-init.js", "ubitech-logo.png"]);
  });

  it("publishes the entry only after all release files are installed", async () => {
    const root = await temporaryRoot();
    const stage = join(root, "stage");
    const live = join(root, "live");
    await writeFixture(stage);
    await mkdir(live, { recursive: true });
    await writeFile(join(live, "index.html"), "old index");
    let dependenciesReady = false;

    await atomicPublish(
      stage,
      live,
      { version: 1, current_assets: ["app-AbCd1234.js", "styles-ZyXw9876.css"], previous_assets: [] },
      {
        beforeCommit: async () => {
          dependenciesReady =
            (await readFile(join(live, "app-AbCd1234.js"), "utf8")).includes("ubitech-logo") &&
            (await readFile(join(live, "styles-ZyXw9876.css"), "utf8")).includes("body");
        },
      },
    );

    expect(dependenciesReady).toBe(true);
    expect(await readFile(join(live, "index.html"), "utf8")).toContain("app-AbCd1234.js");
  });

  it("publishes encoded indexes after ordinary assets and identity index last", async () => {
    const root = await temporaryRoot();
    const stage = join(root, "stage");
    const live = join(root, "live");
    await writeFixture(stage);
    const indexPath = join(stage, "index.html");
    await writeFile(
      indexPath,
      `${await readFile(indexPath, "utf8")}\n${"<!-- release entry -->".repeat(80)}`,
    );
    await precompressStaticAssets(stage);
    await mkdir(live, { recursive: true });

    const installed = [];
    await atomicPublish(
      stage,
      live,
      { version: 1, current_assets: [], previous_assets: [] },
      { afterInstall: (relativePath) => installed.push(relativePath) },
    );

    expect(installed.slice(-3)).toEqual([
      "index.html.br",
      "index.html.gz",
      "index.html",
    ]);
    const firstEntryIndex = installed.indexOf("index.html.br");
    expect(firstEntryIndex).toBeGreaterThan(0);
    expect(
      installed
        .slice(0, firstEntryIndex)
        .some((relativePath) => relativePath.startsWith("index.html")),
    ).toBe(false);
    expect(await readFile(join(live, "index.html.br"))).toEqual(
      await readFile(join(stage, "index.html.br")),
    );
    expect(await readFile(join(live, "index.html.gz"))).toEqual(
      await readFile(join(stage, "index.html.gz")),
    );
  });
});
