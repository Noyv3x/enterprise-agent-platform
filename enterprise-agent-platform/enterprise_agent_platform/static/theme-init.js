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
})();
