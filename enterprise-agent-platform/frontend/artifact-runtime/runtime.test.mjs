// @vitest-environment node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { minifyArtifactRuntime } from "../scripts/build-artifact-runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, "runtime.js"), "utf8");
const minified = await minifyArtifactRuntime();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const doms = [];

afterEach(() => doms.splice(0).forEach((d) => d.window.close()));

/**
 * Run the helper in a page whose native storage and cookie accessors throw (as
 * in an opaque-origin sandbox), before any page script, as Platform injects
 * it. The page's window.parent is a separate window that collects messages.
 */
function frame({ code = source, url = "https://platform.test/artifact-view/tok/pages/a.html", body = "", hash = "" } = {}) {
  const parent = new JSDOM("", { url: "https://platform.test/" }).window;
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { runScripts: "outside-only", url: url + hash });
  doms.push(dom, { window: parent });
  const win = dom.window;
  Object.defineProperty(win, "parent", { value: parent, configurable: true });
  const sec = () => { throw new win.DOMException("The document is sandboxed", "SecurityError"); };
  Object.defineProperty(win, "localStorage", { configurable: true, get: sec });
  Object.defineProperty(win, "sessionStorage", { configurable: true, get: sec });
  Object.defineProperty(win.document, "cookie", { configurable: true, get: sec, set: sec });
  win.eval(code);
  const toParent = [];
  parent.postMessage = (data, targetOrigin) => {
    expect(targetOrigin).toBe("*"); // an opaque origin can only be addressed with "*"
    toParent.push(data);
  };
  // Collect the page's posts synchronously. jsdom's postMessage is async and
  // leaves event.source null, so parent messages are delivered with an explicit
  // source, as browsers do.
  const send = (data, source = parent) =>
    win.dispatchEvent(new win.MessageEvent("message", { data, source }));
  return { parent, win, toParent, send };
}

for (const [label, code] of [["source", source], ["minified", minified]]) {
  describe(`artifact runtime (${label})`, () => {
    it("shims storage where the native accessors throw", () => {
      const { win } = frame({ code });
      const s = win.localStorage;
      expect(s.length).toBe(0);
      s.setItem("a", 1);
      expect(s.getItem("a")).toBe("1");
      expect(s.getItem("missing")).toBeNull();
      s.b = { toString: () => "two" };
      expect(s.b).toBe("two");
      expect(s.getItem("b")).toBe("two");
      expect(s.length).toBe(2);
      expect(s.key(0)).toBe("a");
      expect(s.key(2)).toBeNull();
      expect("a" in s).toBe(true);
      expect(Object.keys(s)).toEqual(["a", "b"]);
      delete s.a;
      expect(s.getItem("a")).toBeNull();
      s.removeItem("b");
      s.setItem("c", "3");
      s.clear();
      expect(s.length).toBe(0);
      expect(s.nope).toBeUndefined();
      expect(typeof s.getItem).toBe("function");
      expect(Object.prototype.toString.call(s)).toBe("[object Storage]");
      expect(JSON.stringify({ ...win.sessionStorage })).toBe("{}");
    });

    it("keeps localStorage and sessionStorage separate and exposes a cookie jar", () => {
      const { win } = frame({ code });
      win.localStorage.x = "L";
      win.sessionStorage.x = "S";
      expect(win.localStorage.x).toBe("L");
      expect(win.sessionStorage.x).toBe("S");
      win.document.cookie = "a=1; path=/";
      win.document.cookie = "b=2";
      expect(win.document.cookie).toBe("a=1; b=2");
      win.document.cookie = "a=; max-age=0";
      expect(win.document.cookie).toBe("b=2");
    });

    it("seeds localStorage from the fragment and strips it", () => {
      const data = { greeting: "héllo ✓", n: "7" };
      const b64 = Buffer.from(JSON.stringify(data)).toString("base64url");
      const { win } = frame({ code, hash: `#__eap=${b64}&section=2` });
      expect(win.localStorage.getItem("greeting")).toBe("héllo ✓");
      expect(win.localStorage.length).toBe(2);
      expect(win.location.hash).toBe("#section=2");

      const only = frame({ code, hash: `#__eap=${b64}` });
      expect(only.win.location.hash).toBe("");
      expect(only.win.location.href).not.toContain("__eap");
    });

    it("ignores malformed seeds and does not post a seed back", async () => {
      const { win, toParent } = frame({ code, hash: "#__eap=%%%not-base64" });
      expect(win.localStorage.length).toBe(0);
      expect(win.location.hash).toBe("");
      await sleep(500);
      expect(toParent).toEqual([]);
    });

    it("debounces storage changes into one eap-storage post", async () => {
      const { win, toParent } = frame({ code });
      win.localStorage.setItem("k", "1");
      win.localStorage.setItem("k", "2");
      win.localStorage.other = "x";
      expect(toParent).toEqual([]);
      await sleep(550);
      expect(toParent).toEqual([{ type: "eap-storage", data: { k: "2", other: "x" } }]);
      win.localStorage.setItem("k", "2"); // unchanged: no post
      await sleep(550);
      expect(toParent).toHaveLength(1);
      win.localStorage.removeItem("k");
      await sleep(550);
      expect(toParent[1]).toEqual({ type: "eap-storage", data: { other: "x" } });
    });

    it("captures console errors, warnings, uncaught errors and rejections within bounds", () => {
      const { win } = frame({ code });
      win.console.error("boom", { a: 1 }, new win.Error("bad"));
      win.console.warn("x".repeat(2000));
      win.console.log("not captured");
      win.dispatchEvent(new win.ErrorEvent("error", { message: "kaput", filename: "a.js", lineno: 3 }));
      const reject = new win.Event("unhandledrejection");
      reject.reason = new win.Error("nope");
      win.dispatchEvent(reject);
      const log = win.__eapLog;
      expect(log).toHaveLength(4);
      expect(log[0]).toMatch(/^\[error\] boom \{"a":1\} Error: bad/);
      expect(log[1]).toHaveLength(500);
      expect(log[2]).toBe("[uncaught] kaput (a.js:3)");
      expect(log[3]).toMatch(/^\[unhandledrejection\] Error: nope/);
      for (let i = 0; i < 100; i++) win.console.error("e" + i);
      expect(win.__eapLog).toHaveLength(50);
      expect(win.__eapLog.every((l) => l.length <= 500)).toBe(true);
    });

    it("records failed resource loads", () => {
      const { win } = frame({ code, body: '<img id="i" src="/missing.png">' });
      win.document.getElementById("i").dispatchEvent(new win.Event("error"));
      expect(win.__eapLog[0]).toMatch(/^\[resource\] <img> failed to load: .*missing\.png/);
    });

    it("builds short, unique, stable selectors", () => {
      const { win, send, toParent } = frame({
        code,
        body: `
          <main>
            <section class="card"><h2 id="t1">One</h2><p>a</p><p>b</p></section>
            <section class="card"><h2>Two</h2><p class="css-1a2b3c4 lead">c</p><p>d</p></section>
            <div id="1bad.id">odd id</div>
            <ul><li>x</li><li class="hover">y</li><li>z</li></ul>
          </main>`,
      });
      const doc = win.document;
      const pickSel = (el) => {
        send({ type: "eap-inspect", on: true });
        el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
        send({ type: "eap-inspect", on: false });
        return toParent.at(-1).selector;
      };
      const all = [...doc.querySelectorAll("*")];
      const seen = new Set();
      for (const el of all) {
        const sel = pickSel(el);
        const hit = doc.querySelectorAll(sel);
        expect(hit.length, sel).toBe(1);
        expect(hit[0]).toBe(el);
        expect(seen.has(sel), sel).toBe(false);
        seen.add(sel);
        expect(pickSel(el)).toBe(sel); // stable across repeats
      }
      expect(pickSel(doc.getElementById("t1"))).toBe("#t1");
      expect(pickSel(doc.querySelector("main"))).toBe("main");
      // hashed and state classes never appear; the shortest unique path is used
      const sels = [...seen].join("\n");
      expect(sels).not.toMatch(/css-1a2b3c4|\.hover/);
      expect(pickSel(doc.querySelector("ul"))).toBe("ul");
    });

    it("posts element picks with geometry and the artifact-relative path, and suppresses the click", () => {
      const { win, send, toParent } = frame({
        code,
        url: "https://platform.test/artifact-view/tok/pages/a%20b.html",
        body: '<button id="go">  Go\n  now </button>',
      });
      let pageSaw = 0;
      win.document.getElementById("go").addEventListener("click", () => pageSaw++);
      const click = () => win.document.getElementById("go").dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
      click();
      expect(pageSaw).toBe(1); // inactive by default
      expect(toParent).toEqual([]);

      send({ type: "eap-inspect", on: true });
      send({ type: "eap-inspect", on: true }); // idempotent
      expect(win.document.querySelectorAll("[data-eap-overlay]")).toHaveLength(1);
      click();
      expect(pageSaw).toBe(1); // suppressed
      expect(toParent).toHaveLength(1);
      expect(toParent[0]).toMatchObject({
        type: "eap-pick", kind: "element", selector: "#go", tag: "button", text: "Go now",
        path: "pages/a b.html",
        scroll: { x: 0, y: 0 },
      });
      expect(toParent[0].rect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
      expect(toParent[0].viewport.w).toBeGreaterThan(0);

      send({ type: "eap-inspect", on: false });
      expect(win.document.querySelectorAll("[data-eap-overlay]")).toHaveLength(0);
      click();
      expect(pageSaw).toBe(2); // restored
      expect(toParent).toHaveLength(1);
    });

    it("truncates picked text to 300 characters", () => {
      const { win, send, toParent } = frame({ code, body: `<p id="p">${"é".repeat(900)}</p>` });
      send({ type: "eap-inspect", on: true });
      win.document.getElementById("p").dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(toParent[0].text).toHaveLength(300);
    });

    it("posts a region on Shift+drag, ignores plain tiny drags, and exits on Escape", () => {
      const { win, send, toParent } = frame({ code, body: '<div id="d">x</div>' });
      const d = win.document.getElementById("d");
      const m = (type, x, y, extra = {}) =>
        d.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...extra }));
      send({ type: "eap-inspect", on: true });
      m("mousedown", 10, 20, { shiftKey: true });
      m("mousemove", 60, 90, { shiftKey: true });
      m("mouseup", 60, 90, { shiftKey: true });
      m("click", 60, 90, { shiftKey: true }); // the click after a drag must not pick an element
      expect(toParent).toEqual([
        {
          type: "eap-pick", kind: "region", rect: { x: 10, y: 20, w: 50, h: 70 },
          path: "pages/a.html", scroll: { x: 0, y: 0 }, viewport: { w: win.innerWidth, h: win.innerHeight },
        },
      ]);
      m("mousedown", 5, 5, { shiftKey: true });
      m("mouseup", 6, 6, { shiftKey: true });
      expect(toParent).toHaveLength(1);

      win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(toParent.at(-1)).toEqual({ type: "eap-inspect-exit" });
      expect(win.document.querySelectorAll("[data-eap-overlay]")).toHaveLength(0);
      d.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(toParent).toHaveLength(2); // inactive again: no pick
    });

    it("ignores messages that do not come from window.parent", () => {
      const { win, send, toParent } = frame({ code, body: '<a id="a" href="#x">x</a>' });
      const other = new JSDOM("", { url: "https://evil.test/" }).window;
      send({ type: "eap-inspect", on: true }, other);
      send({ type: "eap-inspect", on: true }, win); // the page itself
      send({ type: "eap-inspect", on: true }, null);
      win.document.getElementById("a").dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(toParent).toEqual([]);
      send("eap-inspect"); // malformed payloads from the parent are ignored too
      send(null);
      send({ type: "eap-other", on: true });
      win.document.getElementById("a").dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(toParent).toEqual([]);
      send({ type: "eap-inspect", on: true });
      win.document.getElementById("a").dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(toParent).toHaveLength(1);
    });

    it("caps selector and path at 500 characters", () => {
      let html = '<span id="leaf">x</span>';
      for (let i = 0; i < 120; i++) html = `<div class="level-${i}-wrapper">${html}<i></i></div>`;
      const { win, send, toParent } = frame({
        code,
        url: `https://platform.test/artifact-view/tok/${"d/".repeat(400)}a.html`,
        body: html,
      });
      send({ type: "eap-inspect", on: true });
      win.document.querySelectorAll("i")[0].dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
      win.document.getElementById("leaf").dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
      for (const m of toParent) {
        expect(m.selector.length).toBeLessThanOrEqual(500);
        expect(m.path.length).toBe(500);
      }
      expect(toParent[1].selector).toBe("#leaf");
    });

    it("is idempotent when injected twice", () => {
      const { win } = frame({ code });
      win.localStorage.a = "1";
      win.eval(code);
      expect(win.localStorage.a).toBe("1");
    });
  });
}

describe("artifact runtime size", () => {
  it("stays under 12 KB minified", () => {
    expect(Buffer.byteLength(minified)).toBeLessThan(12 * 1024);
  });
});
