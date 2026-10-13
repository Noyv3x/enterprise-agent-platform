const SAFE_LINK = /^(?:https?:|mailto:)/i;

/** Hyperlinks come from the document: only http(s) and mailto stay clickable (HTML and SVG anchors alike). */
export function limitLinks(root: ParentNode) {
  for (const link of Array.from(root.querySelectorAll("a"))) {
    const href = link.getAttribute("href") ?? link.getAttribute("xlink:href") ?? "";
    if (SAFE_LINK.test(href.trim())) {
      link.setAttribute("rel", "noopener noreferrer");
      link.setAttribute("target", "_blank");
    } else {
      link.removeAttribute("href");
      link.removeAttribute("xlink:href");
      link.removeAttribute("target");
    }
  }
}
