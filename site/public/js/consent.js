// Google Analytics, only after consent.
//
// Nothing from Google is requested, and no cookie is set, until the visitor
// clicks Accept. The choice is kept in localStorage ("rv-consent") on this
// device and asked again after six months. Decline is as easy as Accept.
// "Cookie settings" in the footer reopens the banner. A browser that sends
// Global Privacy Control counts as Decline until the visitor accepts there.
(function () {
  var GA_ID = "G-RMG8MNGGZQ";
  var KEY = "rv-consent";
  var MAX_AGE = 1000 * 60 * 60 * 24 * 182;
  var banner = document.getElementById("consent-banner");
  var loaded = false;

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var value = JSON.parse(raw);
      if (!value || (value.choice !== "granted" && value.choice !== "denied")) return null;
      if (typeof value.at !== "number" || Date.now() - value.at > MAX_AGE) return null;
      return value.choice;
    } catch (e) {
      return null;
    }
  }

  function write(choice) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ choice: choice, at: Date.now() }));
    } catch (e) {}
  }

  function loadAnalytics() {
    if (loaded) return;
    loaded = true;
    window["ga-disable-" + GA_ID] = false;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () {
      window.dataLayer.push(arguments);
    };
    window.gtag("js", new Date());
    window.gtag("config", GA_ID, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
    var script = document.createElement("script");
    script.async = true;
    script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GA_ID);
    document.head.appendChild(script);
  }

  function clearAnalyticsCookies() {
    window["ga-disable-" + GA_ID] = true;
    var names = document.cookie.split(";").map(function (c) {
      return c.split("=")[0].trim();
    });
    var host = location.hostname;
    var domains = ["", host, "." + host];
    var parts = host.split(".");
    if (parts.length > 2) domains.push("." + parts.slice(-2).join("."));
    names.forEach(function (name) {
      if (name === "_ga" || name.indexOf("_ga_") === 0 || name === "_gid" || name === "_gat") {
        domains.forEach(function (domain) {
          document.cookie =
            name + "=; Max-Age=0; path=/" + (domain ? "; domain=" + domain : "") + "; SameSite=Lax";
        });
      }
    });
  }

  // While the banner is open, keep focused elements clear of it: the
  // browser scrolls a focused element above the scroll padding, and the
  // extra space at the bottom lets the last links scroll above the banner.
  function pad() {
    if (!banner || banner.hidden) return;
    var space = banner.offsetHeight + 24 + "px";
    document.documentElement.style.scrollPaddingBottom = space;
    document.body.style.paddingBottom = space;
  }

  function show() {
    if (!banner) return;
    banner.hidden = false;
    pad();
    window.addEventListener("resize", pad);
  }

  function hide() {
    if (!banner) return;
    banner.hidden = true;
    document.documentElement.style.scrollPaddingBottom = "";
    document.body.style.paddingBottom = "";
    window.removeEventListener("resize", pad);
  }

  function decide(choice) {
    var wasGranted = read() === "granted";
    write(choice);
    hide();
    if (choice === "granted") {
      loadAnalytics();
    } else {
      clearAnalyticsCookies();
      // Google's script, once running, cannot be unloaded: reload so the
      // withdrawal takes effect at once.
      if (wasGranted && loaded) location.reload();
    }
    updateStatus();
  }

  function updateStatus() {
    var choice = read();
    document.querySelectorAll("[data-consent-status]").forEach(function (el) {
      el.textContent =
        choice === "granted"
          ? "You accepted analytics on this device."
          : choice === "denied"
            ? "You declined analytics on this device."
            : "You have not made a choice on this device yet.";
    });
  }

  document.addEventListener("click", function (event) {
    var target = event.target.closest("[data-consent]");
    if (!target) return;
    var action = target.getAttribute("data-consent");
    if (action === "accept") decide("granted");
    else if (action === "decline") decide("denied");
    else if (action === "open") {
      event.preventDefault();
      show();
      var first = banner && banner.querySelector("button");
      if (first) first.focus();
    }
  });

  var choice = read();
  if (choice === "granted") {
    loadAnalytics();
  } else if (choice === null) {
    if (navigator.globalPrivacyControl === true) {
      // Treated as Decline; the visitor can still accept in Cookie settings.
    } else {
      show();
    }
  }
  updateStatus();
})();
