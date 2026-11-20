// Set the theme before first paint, so a reader never sees the wrong edition flash. A file, not inline, for the CSP.
// ?theme=dark or ?theme=light picks an edition for a shared link; otherwise the reader's last choice, otherwise the
// system preference, otherwise light (the day edition).
try {
  var asked = new URLSearchParams(location.search).get("theme");
  document.documentElement.dataset.theme = asked === "dark" || asked === "light" ? asked
    : localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
} catch (e) {}
