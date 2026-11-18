// Set the theme before first paint, so a light-mode reader never sees a dark flash. A file, not inline, for the CSP.
try {
  document.documentElement.dataset.theme =
    localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
} catch {}
