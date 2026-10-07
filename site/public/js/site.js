// The mobile menu and the theme switch. No framework, no dependencies.
(function () {
  var root = document.documentElement;

  // Theme switch: a real checkbox, so it works with the keyboard and
  // screen readers out of the box.
  document.querySelectorAll("[data-theme-toggle]").forEach(function (input) {
    input.checked = root.getAttribute("data-theme") === "dark";
    input.addEventListener("change", function () {
      var theme = input.checked ? "dark" : "remotevisio";
      root.setAttribute("data-theme", theme);
      try {
        localStorage.setItem("theme", theme);
      } catch (e) {}
      document.querySelectorAll("[data-theme-toggle]").forEach(function (other) {
        other.checked = input.checked;
      });
    });
  });

  // Mobile menu.
  var button = document.querySelector("[data-menu-button]");
  var menu = document.getElementById("mobile-menu");
  if (button && menu) {
    var setOpen = function (open) {
      button.setAttribute("aria-expanded", open ? "true" : "false");
      button.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      menu.hidden = !open;
    };
    button.addEventListener("click", function () {
      setOpen(button.getAttribute("aria-expanded") !== "true");
    });
    menu.addEventListener("click", function (event) {
      if (event.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && button.getAttribute("aria-expanded") === "true") {
        setOpen(false);
        button.focus();
      }
    });
  }
})();
