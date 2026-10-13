import { limitLinks } from "./links";
import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from "@aiden0z/pptx-renderer";

export async function render(data: ArrayBuffer, root: HTMLElement) {
  const container = document.createElement("div");
  container.className = "pptx-stage";
  root.replaceChildren(container);
  // pdfjs is the library's optional EMF fallback and would load code from elsewhere: off.
  await PptxViewer.open(data, container, {
    zipLimits: RECOMMENDED_ZIP_LIMITS,
    pdfjs: false,
    fitMode: "contain",
    listOptions: { windowed: false },
  });
  limitLinks(container);
  await settled(container);
}

const SETTLE_MS = 10_000;

// `open` resolves once slides are mounted; list mode exposes no per-slide `ready`, so wait for what slides load
// afterwards (images, fonts) before the page reports itself drawn, bounded so a broken resource cannot hold it.
async function settled(container: HTMLElement) {
  const pending = Array.from(container.querySelectorAll("img"))
    .filter((image) => !image.complete)
    .map((image) => new Promise<void>((resolve) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => resolve(), { once: true });
    }));
  await Promise.race([Promise.all([...pending, document.fonts?.ready]), new Promise((resolve) => setTimeout(resolve, SETTLE_MS))]);
}
