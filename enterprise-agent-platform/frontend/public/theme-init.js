(function () {
  // Synchronous head script: apply the persisted theme before first paint.
  try {
    var theme = localStorage.getItem("eap-theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }
  } catch (_error) {
    // Storage can be unavailable in hardened/private browser contexts.
  }
  var resolved = document.documentElement.dataset.theme ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
})();
