// Fleet Observatory appearance (2026-10-30). Loaded in <head> without `defer`,
// so <html data-theme> is set before the first paint and the page does not
// flash light in dark mode.
//
// The mode is "system", "light" or "dark". The page also keeps it in the
// observatory settings (app.js), because the desktop app's web view forgets
// localStorage at each start. Each bot's Control UI gets the same mode when
// the observatory opens it (see claw-port-proxy.mjs).
"use strict";

(function () {
  const KEY = "claw-observatory-theme";
  const MODES = ["system", "light", "dark"];
  const media = matchMedia("(prefers-color-scheme: dark)");
  let mode = "system";

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  function resolved() {
    return mode === "system" ? (media.matches ? "dark" : "light") : mode;
  }

  function apply() {
    const root = document.documentElement;
    const theme = resolved();
    root.dataset.theme = theme;
    root.dataset.themeMode = mode;
    root.style.colorScheme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#161e2a" : "#f5f4f0");
    document.dispatchEvent(new CustomEvent("observatory:theme", { detail: { mode, theme } }));
  }

  function set(next) {
    mode = MODES.includes(next) ? next : "system";
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      // storage is blocked; the mode still holds for this page load
    }
    apply();
  }

  media.addEventListener("change", () => {
    if (mode === "system") apply();
  });

  mode = MODES.includes(stored()) ? stored() : "system";
  apply();

  window.observatoryTheme = {
    MODES,
    get mode() {
      return mode;
    },
    resolved,
    set,
  };
})();
