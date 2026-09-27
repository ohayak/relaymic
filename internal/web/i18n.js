// Shared by the sender page and the monitor page. Each page defines its own
// STRINGS table (language -> key -> text) before loading this; this picks the
// language, translates the static markup and provides t() for the rest.

// UI language: follow the browser's language, fall back to English. ?lang=xx forces one (for debugging).
function pickLang() {
  const forced = new URLSearchParams(location.search).get('lang');
  const wanted = forced ? [forced] : (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en']);
  for (const w of wanted) {
    const primary = String(w).toLowerCase().split(/[-_]/)[0];
    if (STRINGS[primary]) return primary;
  }
  return 'en';
}
const LANG = pickLang();
document.documentElement.lang = LANG;

// t looks up a string in the current language, falling back to English. {name} placeholders are filled from vars.
function t(key, vars) {
  let s = (STRINGS[LANG] && STRINGS[LANG][key]) || STRINGS.en[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(v);
  return s;
}
document.title = t('title');
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
