(function () {
  // Synchronous head script: apply the persisted theme before first paint. Beautiful UI's tokens switch on a
  // `.dark` class; an unpinned theme follows the OS.
  var root = document.documentElement;
  var theme = null;
  try {
    theme = localStorage.getItem("eap-theme");
  } catch (_error) {
    // Storage can be unavailable in hardened/private browser contexts.
  }
  if (theme === "light" || theme === "dark") {
    root.dataset.theme = theme;
  } else {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  root.classList.toggle("dark", theme === "dark");
})();
