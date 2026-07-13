interface ClipboardEnvironment {
  navigator?: Pick<Navigator, "clipboard">;
  document?: Document;
}

/** Copy text with a legacy DOM fallback for browsers where the async clipboard
 * API is unavailable or denied. The fallback node is removed immediately and
 * focus is restored to the control that initiated the copy. */
export async function copyText(value: string, environment?: ClipboardEnvironment): Promise<boolean> {
  const browserNavigator =
    environment?.navigator ?? (typeof navigator === "undefined" ? undefined : navigator);
  try {
    if (browserNavigator?.clipboard?.writeText) {
      await browserNavigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Permission policies can reject the modern API. Try the DOM fallback.
  }

  const browserDocument = environment?.document ?? (typeof document === "undefined" ? undefined : document);
  if (!browserDocument?.body || typeof browserDocument.execCommand !== "function") return false;

  const activeElement = browserDocument.activeElement as HTMLElement | null;
  const textarea = browserDocument.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.className = "clipboard-proxy";
  browserDocument.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  try {
    return browserDocument.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    activeElement?.focus();
  }
}
