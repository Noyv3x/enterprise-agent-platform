import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicPublish,
  retainedPreviousAssets,
  validateStagedBuild,
} from "./build-static.mjs";

const roots = [];
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

describe("previous release retention", () => {
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
});
