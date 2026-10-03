// The toolbar popup: the questions waiting in consent windows, whether the
// camera is coming in, the two settings, and the sites the user answered,
// each of which can be removed (the site asks again next time).
'use strict';

const $ = (id) => document.getElementById(id);
const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);
$('version').textContent = msg('popup_version', [chrome.runtime.getManifest().version]);

// ---- Status ----

// showStatus renders the receiver's browser-camera status (see
// background.js): whether it runs, whether the browser camera is on in its
// menu, whether video arrives, and who watches. (A receiver whose browser
// camera could not start has no listener for this to reach: it reads as not
// running, and only its monitor page says why. So does a Remote Visio from
// before the browser camera, which the hint points at: its menu has no
// Browser Camera.)
function showStatus(s) {
  const state = $('state');
  let text, cls = 'warn', hint = '';
  // The receiver refuses an extension whose ID it does not know: a copy
  // unpacked from the Chrome Web Store zip, which has no key and so gets an
  // ID of its own. (Its other refusal, a Host that is not loopback, cannot
  // happen to this extension, which always asks 127.0.0.1.)
  if (s && s.reachable && s.error === 'forbidden') {
    text = msg('popup_status_refused'); cls = 'err';
    hint = msg('popup_status_refused_hint');
  } else if (!s || !s.reachable || s.error) {
    text = msg('popup_status_down'); cls = 'err';
    hint = msg('popup_status_down_hint');
  } else if (!s.on) {
    text = msg('popup_status_off');
  } else if (!s.video) {
    text = msg('popup_status_waiting');
    hint = msg('popup_status_waiting_hint');
  } else {
    text = msg('popup_status_receiving', [String(s.fps || 0)]); cls = 'ok';
  }
  state.textContent = text;
  state.className = cls;
  $('hint').textContent = hint;
  $('pages').textContent = s && s.reachable ? inUse(s) : '';
}

// inUse says who watches. The receiver lists the sites of the connected
// pages, once each, and counts every connection; the count shows when it is
// more than the sites: several pages (or frames) of one site, and
// connections that named no site, which did not come from this extension
// (a program on this Mac can connect to the receiver too). So nothing
// watches unseen.
function inUse(s) {
  const pages = Array.isArray(s.pages) ? s.pages.filter((p) => typeof p === 'string' && p) : [];
  const viewers = Number.isInteger(s.viewers) && s.viewers > 0 ? s.viewers : 0;
  if (!pages.length) return viewers ? msg('popup_in_use_unnamed', [String(viewers)]) : '';
  const names = pages.map(shortOrigin).join(', ');
  if (viewers > pages.length) return msg('popup_in_use_count', [names, String(viewers)]);
  return msg('popup_in_use', [names]);
}

// shortOrigin drops the https:// that every site has; other schemes stay.
function shortOrigin(origin) {
  return origin.startsWith('https://') ? origin.slice(8) : origin;
}

// named puts a message together with an origin in bold: the message is
// split around its placeholder, and the origin goes in as text, never as
// markup.
function named(el, key, origin) {
  const mark = '\u0001';
  const [before, after = ''] = msg(key, [mark]).split(mark);
  const b = document.createElement('b');
  b.textContent = shortOrigin(origin);
  b.title = origin;
  el.replaceChildren(before, b, after);
}

async function refreshStatus() {
  try {
    showStatus(await chrome.runtime.sendMessage({ type: 'status' }));
  } catch {
    showStatus(null);
  }
}

// ---- Questions waiting ----

// loadQuestions lists the consent windows open now, each with a button that
// brings it back to the front: it may have gone behind the browser's
// window. (A site's own request brings it back only with the user's click.)
async function loadQuestions() {
  const { consentWindows } = await chrome.storage.session.get('consentWindows');
  const rows = [];
  for (const [id, r] of Object.entries(consentWindows && typeof consentWindows === 'object' ? consentWindows : {})) {
    if (!r || r.abandoned || typeof r.origin !== 'string') continue;
    try { await chrome.windows.get(Number(id)); } catch { continue; }
    rows.push(questionRow(Number(id), r.origin));
  }
  $('questionList').replaceChildren(...rows);
  $('questions').hidden = rows.length === 0;
}

function questionRow(id, origin) {
  const li = document.createElement('li');
  const text = document.createElement('span');
  text.className = 'question';
  named(text, 'popup_question', origin);
  const show = document.createElement('button');
  show.type = 'button';
  show.className = 'show';
  show.textContent = msg('popup_question_show');
  show.addEventListener('click', () => { chrome.windows.update(id, { focused: true }).catch(() => {}); });
  li.append(text, show);
  return li;
}

// ---- Settings ----

async function loadSettings() {
  const v = await chrome.storage.local.get(['enabled', 'prefer']);
  const enabled = v.enabled !== false;
  $('enabled').checked = enabled;
  $('prefer').checked = v.prefer === true;
  $('prefer').disabled = !enabled;
  $('preferRow').classList.toggle('disabled', !enabled);
}

$('enabled').addEventListener('change', (e) => {
  chrome.storage.local.set({ enabled: e.target.checked }).catch(() => {});
});
$('prefer').addEventListener('change', (e) => {
  chrome.storage.local.set({ prefer: e.target.checked }).catch(() => {});
});

// ---- Sites ----

async function loadSites() {
  const { sites } = await chrome.storage.local.get('sites');
  const entries = Object.entries(sites && typeof sites === 'object' ? sites : {})
    .filter(([, v]) => v === 'allow' || v === 'block')
    .sort(([a], [b]) => shortOrigin(a).localeCompare(shortOrigin(b)));
  const list = $('sites');
  list.replaceChildren(...entries.map(([origin, decision]) => siteRow(origin, decision)));
  $('noSites').hidden = entries.length > 0;
}

function siteRow(origin, decision) {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'origin';
  name.textContent = origin;
  name.title = origin;
  const d = document.createElement('span');
  d.className = 'decision ' + (decision === 'allow' ? 'ok' : 'err');
  d.textContent = msg(decision === 'allow' ? 'popup_site_allowed' : 'popup_site_blocked');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '×';
  remove.title = msg('popup_site_remove');
  remove.setAttribute('aria-label', msg('popup_site_remove') + ' ' + origin);
  remove.addEventListener('click', async () => {
    const { sites } = await chrome.storage.local.get('sites');
    if (!sites || typeof sites !== 'object') return;
    delete sites[origin];
    await chrome.storage.local.set({ sites });
  });
  li.append(name, d, remove);
  return li;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.consentWindows) loadQuestions().catch(() => {});
  if (area !== 'local') return;
  if (changes.enabled || changes.prefer) loadSettings().catch(() => {});
  if (changes.sites) loadSites().catch(() => {});
});

loadQuestions().catch(() => {});
loadSettings().catch(() => {});
loadSites().catch(() => {});
refreshStatus();
setInterval(refreshStatus, 2000);
