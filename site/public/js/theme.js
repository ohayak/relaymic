// Runs in <head>, before the first paint: applies the visitor's saved theme,
// or the system's, so the page never flashes the wrong one.
(function () {
  var theme;
  try {
    theme = localStorage.getItem("theme");
  } catch (e) {}
  if (theme !== "dark" && theme !== "remotevisio") {
    theme =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "remotevisio";
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
