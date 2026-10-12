/** Mermaid rendering behind a dynamic import, so the library is its own chunk and loads with the first diagram. */
import type { Mermaid } from "mermaid";

export type DiagramTheme = "light" | "dark";

/** Why a diagram did not render: its library could not load, its source is not valid Mermaid, or it would load
 * something from outside the page (an image or a stylesheet). */
export class DiagramError extends Error {
  constructor(public reason: "load" | "syntax" | "external", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

let library: Promise<Mermaid> | null = null;
/** Renders one at a time: `initialize` sets the theme globally for the next `render`. */
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;

/** The current value of a color token as `rgb()` (Mermaid derives shades with a parser that does not read oklch),
 * painted over `ground` so translucent tints resolve as they show; null where the canvas cannot paint (tests). */
function tokenColors(names: readonly string[]): Record<string, string> | null {
  if (typeof CanvasRenderingContext2D === "undefined") return null;
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const style = getComputedStyle(document.documentElement);
  const paint = (color: string) => {
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
  };
  const colors: Record<string, string> = {};
  for (const name of names) {
    paint(style.getPropertyValue("--surface"));
    paint(style.getPropertyValue(name));
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    colors[name] = `rgb(${r}, ${g}, ${b})`;
  }
  return colors;
}

const TOKENS = ["--surface", "--inset", "--canvas", "--ink", "--ink-2", "--line-strong", "--accent", "--accent-tint"] as const;

/** Mermaid's `base` theme drawn from the Beautiful UI tokens of the painted theme (so the brand accent applies);
 * Mermaid's own light and dark themes where tokens cannot be resolved. */
function themeConfig(theme: DiagramTheme) {
  const c = tokenColors(TOKENS);
  const fontFamily = getComputedStyle(document.body).fontFamily || undefined;
  if (!c) return { theme: theme === "dark" ? ("dark" as const) : ("default" as const), fontFamily };
  return {
    theme: "base" as const,
    fontFamily,
    themeVariables: {
      darkMode: theme === "dark",
      // Flat nodes with a hairline border, as Beautiful UI cards; Mermaid's default glow reads as a halo on dark.
      dropShadow: "none",
      fontFamily,
      background: c["--surface"],
      primaryColor: c["--accent-tint"],
      primaryTextColor: c["--ink"],
      primaryBorderColor: c["--accent"],
      secondaryColor: c["--inset"],
      tertiaryColor: c["--canvas"],
      lineColor: c["--ink-2"],
      textColor: c["--ink"],
      mainBkg: c["--accent-tint"],
      nodeBorder: c["--accent"],
      clusterBkg: c["--inset"],
      clusterBorder: c["--line-strong"],
      edgeLabelBackground: c["--surface"],
      noteBkgColor: c["--inset"],
      noteBorderColor: c["--line-strong"],
      noteTextColor: c["--ink"],
      actorBkg: c["--accent-tint"],
      actorBorder: c["--accent"],
      actorTextColor: c["--ink"],
      signalColor: c["--ink-2"],
      signalTextColor: c["--ink"],
    },
  };
}

/* ── no fetches ────────────────────────────────────────────
 * Chat and artifacts never load remote resources from message text, and a diagram must not either. Mermaid
 * fetches during `render`, before its own sanitizing: flowchart image shapes (`A@{ img: … }`) through `new Image()`,
 * sequence actor icons (`properties A: {"icon": …}`) and HTML labels as `<image>`/`<img>`, and CSS `url()` from
 * style statements or a `themeCSS` directive. So a source is checked before it renders, and the SVG is cleaned
 * after as a second line. */

/** `%%{init …}%%` directives (Mermaid also accepts an unclosed one) and `---` config frontmatter: they could set
 * themeCSS, fonts or the security level. The diagram renders with the app's configuration only. */
export function withoutDirectives(source: string): string {
  let text = source.replace(/^\s*---[^\n]*\n[\s\S]*?\n---[^\n]*(?:\n|$)/, "");
  while (text.includes("%%{")) text = text.replace(/%%\{[\s\S]*?(?:\}%%|$)/g, "");
  return text;
}

/** Text that can make a rendered diagram fetch: an image key in shape data, CSS functions that load a resource,
 * HTML tags that load or embed one, and CSS escapes in style statements (which could spell `url(`). */
const EXTERNAL = [
  /\bimg\b["']?\s*:/i,
  /url\(/i,
  /@import/i,
  /(?:^|[^\w-])(?:-webkit-)?(?:image-set|image|cross-fade|element|src)\(/i,
  /<\s*\/?\s*(?:img|image|picture|source|video|audio|track|iframe|frame|object|embed|link|meta|base|svg|use|input|style|feimage|math)\b/i,
  /^\s*(?:style|classDef|linkStyle)\b.*\\/im,
];

/** Values of a diagram database collection (a Map or a record). */
function entries(collection: unknown): Record<string, unknown>[] {
  if (collection instanceof Map) return [...collection.values()];
  return collection && typeof collection === "object" ? Object.values(collection) : [];
}

/** Structural check on the parsed diagram (catches what text matching cannot, such as YAML-escaped keys): no
 * flowchart node has an image and no sequence actor an icon. */
async function externalNodes(mermaid: Mermaid, source: string): Promise<boolean> {
  const { db } = await mermaid.mermaidAPI.getDiagramFromText(source) as unknown as { db: { getVertices?: () => unknown; getActors?: () => unknown } };
  const nodes = [...entries(db.getVertices?.()), ...entries(db.getActors?.())];
  return nodes.some((node) => Boolean(node.img) || Boolean((node.properties as { icon?: unknown } | undefined)?.icon));
}

/** Tags that load or embed a resource; labels' HTML loses them, and the finished SVG too. */
const FETCHING_TAGS = ["img", "image", "picture", "source", "video", "audio", "track", "iframe", "frame", "frameset", "object", "embed", "link", "meta", "base", "svg", "use", "input", "style", "feimage", "math"];
const FETCHING_ATTRS = ["style", "src", "srcset", "href", "xlink:href", "background", "poster", "data", "action", "formaction", "ping"];

/** Removes from rendered SVG markup every element that loads a resource, every link or reference outside the
 * document, `@import` and external `url()`. Parsed in an inert document, so nothing loads while it is cleaned. */
export function withoutExternalReferences(svg: string): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${svg}</body>`, "text/html");
  const EXTERNAL_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;
  for (const element of [...doc.body.querySelectorAll("*")]) {
    const tag = element.localName.toLowerCase();
    if (tag !== "svg" && tag !== "use" && tag !== "style" && FETCHING_TAGS.includes(tag)) {
      element.remove();
      continue;
    }
    if (tag === "style") element.textContent = (element.textContent ?? "").replace(/@import[^;]*;?/gi, "").replace(EXTERNAL_URL, "none");
    for (const { name, value } of [...element.attributes]) {
      const local = name.toLowerCase();
      if ((local === "href" || local === "xlink:href" || local === "src" || local === "srcset") && !value.trim().startsWith("#")) element.removeAttribute(name);
      else if (/url\(\s*(?!['"]?#)/i.test(value)) element.removeAttribute(name);
    }
  }
  return doc.body.innerHTML;
}

/**
 * Renders Mermaid `source` to SVG markup in the given theme, with `securityLevel: 'strict'` (no click bindings,
 * sanitized output) and no error diagram drawn into the page. Directives and config frontmatter are dropped and the
 * keys that matter for safety are `secure`, so nothing in the source changes the configuration; a source that would
 * load an image or stylesheet is refused before it renders. Rejects with a DiagramError.
 */
export function renderMermaid(source: string, theme: DiagramTheme): Promise<string> {
  const run = queue.then(async () => {
    const text = withoutDirectives(source);
    if (EXTERNAL.some((pattern) => pattern.test(text))) throw new DiagramError("external", "The diagram references an external resource.");
    let mermaid: Mermaid;
    try {
      mermaid = await (library ??= import("mermaid").then((module) => module.default));
    } catch (error) {
      library = null; // a later diagram tries the chunk again
      throw new DiagramError("load", error);
    }
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "theme", "themeVariables", "themeCSS", "fontFamily", "altFontFamily", "dompurifyConfig", "htmlLabels"],
      // HTML in labels loses tags and attributes that load anything (Mermaid's strict level keeps `<img src>`).
      dompurifyConfig: { FORBID_TAGS: FETCHING_TAGS, FORBID_ATTR: FETCHING_ATTRS },
      ...themeConfig(theme),
    });
    try {
      if (await externalNodes(mermaid, text)) throw new DiagramError("external", "The diagram references an external image.");
      const { svg } = await mermaid.render(`artifact-mermaid-${++sequence}`, text);
      return withoutExternalReferences(svg);
    } catch (error) {
      throw error instanceof DiagramError ? error : new DiagramError("syntax", error);
    }
  });
  queue = run.catch(() => undefined);
  return run;
}
