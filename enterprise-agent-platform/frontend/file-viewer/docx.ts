import { renderAsync } from "docx-preview";
import { limitLinks } from "./links";

export async function render(data: ArrayBuffer, root: HTMLElement) {
  const styles = document.createElement("div");
  const body = document.createElement("div");
  root.replaceChildren(styles, body);
  await renderAsync(data, body, styles, {
    className: "docx",
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    renderAltChunks: false,
    useBase64URL: true,
  });
  limitLinks(root);
}
