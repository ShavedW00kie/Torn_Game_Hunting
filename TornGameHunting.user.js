// ==UserScript==
// @name         Torn Game Hunting - Russian Roulette Monitor & Filter (FFScouter aware) - Fixed
// @namespace    https://www.torn.com/
// @version      1.1.0
// @description  Visual filter & monitor for Torn.com Russian Roulette lobby. Integrates FFScouter DOM notes, optional Torn API health checks. Fixed row detection, FF parsing, pot parsing, continuous monitoring, and API throttling. Does NOT automate actions (no auto-click). For Tampermonkey/Greasemonkey. See install instructions below.
// @author       ShavedW00kie (via Copilot Space)
// @homepageURL  https://github.com/ShavedW00kie
// @downloadURL  https://github.com/ShavedW00kie/Claude_Skills/raw/refs/heads/main/Torn/UserScripts/TornGameHunting.user.js
// @updateURL    https://github.com/ShavedW00kie/Claude_Skills/raw/refs/heads/main/Torn/UserScripts/TornGameHunting.user.js
// @match        https://www.torn.com/page.php?sid=russianRoulette*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      api.torn.com
// ==/UserScript==

/*
================================================================================
OVERVIEW (Updated / Fixed)
--------------------------------------------------------------------------------
This fixed userscript:
- Improves row identification so filters apply to the correct lobby/game entries.
- Expands FF/Stat/pot extraction heuristics to capture FFScouter injections via data-attributes, title attributes, adjacent number spans, and more.
- Adds a periodic monitor loop (2s) to complement MutationObserver, catching updates MutationObserver misses.
- Uses per-row state caching (WeakMap) and per-user API call cooldowns to avoid excess Torn API calls.
- Maintains all earlier UI, settings, and fairness constraints (no automated attacks).
================================================================================
*/

/* =========================
   Documentation / Purpose
   =========================
   - Uses heuristics to find lobby rows containing players and bet amounts.
   - Optional Torn API health checks (if API key is provided).
   - Persistent settings via GM_setValue / GM_getValue.
   - No automated clicks: ATTACK icon is a manual link to user's profile page.
*/

/* =========================
   Configuration Defaults
   ========================= */
const DEFAULTS = {
  minFF: 0,
  maxFF: 999999999,
  minStat: 0,
  maxStat: 999999999,
  minBet: 0, // minimum pot/bet to consider
  apiKey: "", // optional
  monitorOn: false,
  uiInjected: true,
  requireKnownFF: false // if true, unknown FF will NOT pass filters
};

/* =========================
   Utilities
   ========================= */

function loadSettings() {
  return {
    minFF: Number(GM_getValue("gh_minFF", DEFAULTS.minFF)),
    maxFF: Number(GM_getValue("gh_maxFF", DEFAULTS.maxFF)),
    minStat: Number(GM_getValue("gh_minStat", DEFAULTS.minStat)),
    maxStat: Number(GM_getValue("gh_maxStat", DEFAULTS.maxStat)),
    minBet: Number(GM_getValue("gh_minBet", DEFAULTS.minBet)),
    apiKey: String(GM_getValue("gh_apiKey", DEFAULTS.apiKey) || ""),
    monitorOn: Boolean(GM_getValue("gh_monitorOn", DEFAULTS.monitorOn)),
    requireKnownFF: Boolean(GM_getValue("gh_requireKnownFF", DEFAULTS.requireKnownFF)),
  };
}

function saveSettings(s) {
  GM_setValue("gh_minFF", Number(s.minFF));
  GM_setValue("gh_maxFF", Number(s.maxFF));
  GM_setValue("gh_minStat", Number(s.minStat));
  GM_setValue("gh_maxStat", Number(s.maxStat));
  GM_setValue("gh_minBet", Number(s.minBet));
  GM_setValue("gh_apiKey", String(s.apiKey || ""));
  GM_setValue("gh_monitorOn", Boolean(s.monitorOn));
  GM_setValue("gh_requireKnownFF", Boolean(s.requireKnownFF));
}

function parseNumber(str) {
  if (typeof str !== "string") return NaN;
  let s = str.trim().toLowerCase();
  if (!s) return NaN;
  // Remove currency symbols
  s = s.replace(/[$€£,]/g, "");
  // Handle 'k' and 'm' suffixes
  const m = s.match(/^(-?[\d,.]+(?:\.\d+)?)([km]?)$/i);
  if (m) {
    let num = parseFloat(m[1].replace(/,/g, ""));
    const suf = m[2].toLowerCase();
    if (suf === "k") num *= 1_000;
    if (suf === "m") num *= 1_000_000;
    return num;
  }
  // fallback extract first numeric
  const m2 = s.match(/-?[\d,.]+(?:\.\d+)?/);
  if (m2) return parseFloat(m2[0].replace(/,/g, ""));
  return NaN;
}

/* =========================
   DOM heuristics & row discovery (improved)
   ========================= */

function findProfileAnchorsInRegion(root = document) {
  // broaden anchor patterns; include /profiles.php?XID= and /profiles.php?XID=
  const anchors = Array.from(root.querySelectorAll('a[href*="profiles.php"], a[href*="profile.php"], a[href*="XID="], a[href*="profile"]'));
  return anchors;
}

function extractUserIdFromHref(href = "") {
  if (!href) return null;
  try {
    // Some anchors may be relative; use URL with base
    const url = new URL(href, window.location.origin);
    if (url.searchParams.has("XID")) return url.searchParams.get("XID");
    if (url.searchParams.has("id")) return url.searchParams.get("id");
    // If path like /profiles.php?XID=123
    const m = href.match(/XID=(\d+)/i) || href.match(/profiles\.php\?(\d+)/i) || href.match(/profile\.php\?XID=(\d+)/i);
    if (m) return m[1];
    // fallback: any long digit sequence
    const m2 = href.match(/(\d{4,12})/);
    return m2 ? m2[1] : null;
  } catch (err) {
    const m = href.match(/XID=(\d+)/i) || href.match(/profiles\.php\?(\d+)/i);
    return m ? m[1] : null;
  }
}

/**
 * getLobbyRows - robustly collects candidate "row" elements that represent individual games/entries.
 * Strategy:
 * - Start from every profile anchor in the document.
 * - For each anchor, climb up to N levels collecting nearest ancestor that:
 *   - contains at least one profile anchor (itself qualifies), and
 *   - contains at least one numeric token (likely pot) OR contains multiple profile anchors (players)
 * - Deduplicate and return array of elements.
 */
function getLobbyRows() {
  const anchors = findProfileAnchorsInRegion(document);
  const rows = new Set();

  anchors.forEach(a => {
    // skip anchors that are in unrelated areas (like header, footer, menus)
    if (!document.body.contains(a)) return;
    let el = a;
    let found = null;
    for (let depth = 0; depth < 12 && el && el !== document.body; depth++) {
      // If this ancestor contains at least one other profile anchor or pot-like tokens, treat as a row
      const profileAnchors = el.querySelectorAll ? el.querySelectorAll('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]') : [];
      const text = (el.textContent || "").toLowerCase();
      const hasNum = /[\d,.]+[km]?/.test(text);
      if ((profileAnchors && profileAnchors.length >= 1 && hasNum) || (profileAnchors && profileAnchors.length >= 2) || /bet|pot|wager|stakes|stakes|playing|players/i.test(text)) {
        found = el;
        break;
      }
      el = el.parentElement;
    }
    if (!found) {
      // fallback: use the immediate parent row-ish element
      const p = a.parentElement;
      if (p) found = p;
    }
    if (found) rows.add(found);
  });

  // convert to array and return
  return Array.from(rows);
}

/* =========================
   Heuristics to pull FF/Stats/Pot (improved)
   ========================= */

function heuristicExtractFFAndStats(container) {
  let ff = NaN, stats = NaN;
  if (!container) return { ff: NaN, stats: NaN };

  // 1) dataset attributes search (direct & robust)
  const candidates = Array.from(container.querySelectorAll('*'));
  for (const el of candidates) {
    try {
      if (el.dataset) {
        if (!isFinite(ff) && (el.dataset.ff || el.dataset.ffscore || el.dataset.ffScouter)) {
          ff = parseNumber(el.dataset.ff || el.dataset.ffscore || el.dataset.ffScouter);
        }
        if (!isFinite(stats) && (el.dataset.stats || el.dataset.statestimate || el.dataset.statEstimate)) {
          stats = parseNumber(el.dataset.stats || el.dataset.statestimate || el.dataset.statEstimate);
        }
      }
      // check title / aria-label / data-original-title
      const title = (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('data-original-title'))) || "";
      if (title) {
        if (!isFinite(ff)) {
          const m = title.match(/ff[:\s]*([0-9,\.kmKM]+)/i) || title.match(/([0-9,\.kmKM]+)\s*ff/i);
          if (m) ff = parseNumber(m[1] || m[0]);
        }
        if (!isFinite(stats)) {
          const m2 = title.match(/(?:stat(?:s|estimate)?[:\s]*)([0-9,\.kmKM]+)/i);
          if (m2) stats = parseNumber(m2[1]);
        }
      }
    } catch (e) {
      // ignore
    }
    if (isFinite(ff) && isFinite(stats)) break;
  }

  // 2) adjacent numeric spans near profile anchors (common FFScouter injection)
  if ((!isFinite(ff) || !isFinite(stats))) {
    const anchors = container.querySelectorAll('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]');
    for (const a of anchors) {
      // scan neighbors within a small window
      let sib = a.nextElementSibling;
      let steps = 0;
      while (sib && steps < 6 && (!isFinite(ff) || !isFinite(stats))) {
        const txt = (sib.textContent || "").trim();
        if (!isFinite(ff)) {
          const m = txt.match(/ff[:\s]*([0-9,\.kmKM]+)/i) || txt.match(/^([0-9,\.kmKM]+)$/);
          if (m) ff = parseNumber(m[1] || m[0]);
        }
        if (!isFinite(stats)) {
          const m2 = txt.match(/(?:est|stat|stats|estimate)[:\s]*([0-9,\.kmKM]+)/i);
          if (m2) stats = parseNumber(m2[1]);
        }
        // also check dataset of sibling
        if (sib.dataset) {
          if (!isFinite(ff) && (sib.dataset.ff || sib.dataset.ffscore)) ff = parseNumber(sib.dataset.ff || sib.dataset.ffscore);
          if (!isFinite(stats) && (sib.dataset.stats || sib.dataset.statestimate)) stats = parseNumber(sib.dataset.stats || sib.dataset.statestimate);
        }
        sib = sib.nextElementSibling;
        steps++;
      }
      // previous siblings
      sib = a.previousElementSibling;
      steps = 0;
      while (sib && steps < 6 && (!isFinite(ff) || !isFinite(stats))) {
        const txt = (sib.textContent || "").trim();
        if (!isFinite(ff)) {
          const m = txt.match(/ff[:\s]*([0-9,\.kmKM]+)/i) || txt.match(/^([0-9,\.kmKM]+)$/);
          if (m) ff = parseNumber(m[1] || m[0]);
        }
        if (!isFinite(stats)) {
          const m2 = txt.match(/(?:est|stat|stats|estimate)[:\s]*([0-9,\.kmKM]+)/i);
          if (m2) stats = parseNumber(m2[1]);
        }
        if (sib.dataset) {
          if (!isFinite(ff) && (sib.dataset.ff || sib.dataset.ffscore)) ff = parseNumber(sib.dataset.ff || sib.dataset.ffscore);
          if (!isFinite(stats) && (sib.dataset.stats || sib.dataset.statestimate)) stats = parseNumber(sib.dataset.stats || sib.dataset.statestimate);
        }
        sib = sib.previousElementSibling;
        steps++;
      }
      if (isFinite(ff) && isFinite(stats)) break;
    }
  }

  // 3) textual fallback within container
  if (!isFinite(ff) || !isFinite(stats)) {
    const text = container.textContent || "";
    if (!isFinite(ff)) {
      const m = text.match(/FF[:\s]*([0-9,\.kmKM]+)/i) || text.match(/FFscouter[:\s]*([0-9,\.kmKM]+)/i) || text.match(/\b([0-9,\.kmKM]+)\s*FF\b/i);
      if (m) ff = parseNumber(m[1] || m[0]);
    }
    if (!isFinite(stats)) {
      const m2 = text.match(/(?:EST|estimate|stat(?:s)?)[:\s]*([0-9,\.kmKM]+)/i);
      if (m2) stats = parseNumber(m2[1]);
    }
  }

  return { ff: isFinite(ff) ? ff : NaN, stats: isFinite(stats) ? stats : NaN };
}

function findPotOrBetInRow(row) {
  if (!row) return NaN;
  const text = row.textContent || "";
  // Look for patterns like "Pot: 5M", "Bet $5M", "Wager 500k"
  const m = text.match(/(?:pot|bet|wager|stakes|stake|pot:|bet:)[^\d\-]*([0-9,\.kmKM]+)/i);
  if (m) return parseNumber(m[1]);
  // fallback: any currency-like tokens, take the biggest (likely the pot)
  const nums = Array.from((text.match(/([0-9,\.]+(?:[kmKM]?))/g) || [])).map(parseNumber).filter(isFinite);
  if (nums.length) return Math.max(...nums);
  return NaN;
}

/* =========================
   UI Injection & CSS (unchanged but kept)
   ========================= */

function addStyles() {
  GM_addStyle(`
    .gh-btn { display:inline-block; margin-right:8px; padding:6px 9px; border-radius:3px; cursor:pointer; background:rgba(0,0,0,0.12); color:var(--text-color, #fff); border:1px solid rgba(255,255,255,0.06); font-size:13px; }
    .gh-btn.gh-primary { background:linear-gradient(180deg,#2ecc71,#27ae60); color:#062; border-color:rgba(0,0,0,0.2); font-weight:600; }
    .gh-btn.gh-toggle-active { box-shadow:0 0 0 2px rgba(39,174,96,0.12) inset; }
    .gh-modal { position:fixed; z-index:999999; left:50%; top:50%; transform:translate(-50%,-50%); width:520px; max-width:94%; background:var(--bg-color, #111); color:var(--text-color, #fff); border:1px solid rgba(255,255,255,0.06); border-radius:8px; padding:16px; box-shadow:0 8px 30px rgba(0,0,0,0.6); }
    .gh-modal h2 { margin:0 0 8px 0; font-size:16px; }
    .gh-row { display:flex; gap:8px; align-items:center; margin:8px 0; }
    .gh-row label { width:160px; font-size:13px; opacity:0.9; }
    .gh-row input[type="number"], .gh-row input[type="text"] { flex:1; padding:6px; border-radius:4px; border:1px solid rgba(255,255,255,0.06); background:rgba(0,0,0,0.35); color:var(--text-color,#fff); }
    .gh-row input[type="range"] { flex:1; }
    .gh-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:12px; }
    .gh-hidden { opacity:0.22 !important; filter:grayscale(60%); }
    .gh-winner { background:linear-gradient(90deg, rgba(30,120,40,0.12), rgba(60,180,80,0.05)); color:#9f7; border-left:3px solid #2ecc71; }
    .gh-loser { background:linear-gradient(90deg, rgba(120,30,30,0.06), rgba(200,60,60,0.04)); color:#f88; border-left:3px solid #e74c3c; text-decoration:line-through; }
    .gh-attack { margin-left:6px; color:#fff; background:transparent; border:none; cursor:pointer; font-size:12px; vertical-align:middle; text-decoration:none; display:inline-flex; align-items:center; gap:6px; }
    .gh-attack:hover { transform:scale(1.05); }
    #gh-recent-winners { position:fixed; right:12px; top:120px; z-index:999998; width:220px; background:rgba(0,0,0,0.5); padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.04); color:#fff; max-height:60vh; overflow:auto; }
    #gh-recent-winners h4{ margin:4px 0 8px 0; font-size:13px; }
    .gh-recent-entry { display:flex; align-items:center; justify-content:space-between; padding:6px 8px; border-radius:5px; margin-bottom:6px; background:rgba(0,0,0,0.25); }
    .gh-recent-entry .name { font-weight:600; font-size:13px; }
    .gh-recent-entry .when { font-size:12px; opacity:0.8; }
    .gh-crosshair { width:18px; height:18px; display:inline-block; background-image:radial-gradient(circle at 50% 50%, transparent 30%, rgba(0,0,0,0.3) 31%); border:2px solid #eee; border-radius:50%; box-sizing:border-box; }
    .gh-sr-only { position:absolute !important; left:-9999px; top:auto; width:1px; height:1px; overflow:hidden; }
  `);
}

/* =========================
   Settings Modal (kept, with minor addition for requireKnownFF)
   ========================= */

let settings = loadSettings();

function tryInsertTopButtons() {
  const textMatches = ["Last Games", "Statistics", "Back to Casino"];
  let container = null;
  const possibleSelectors = ['.submenu', '.subtabs', '.page-tabs', '.tabBar', '.contentHeader', '.header-links', '.breadcrumbs'];
  for (const sel of possibleSelectors) {
    const el = document.querySelector(sel);
    if (el && /russian/i.test(document.title + (document.querySelector("h1") ? document.querySelector("h1").textContent : ""))) {
      container = el;
      break;
    }
  }

  if (!container) {
    const anchors = Array.from(document.querySelectorAll("a, button"));
    for (const a of anchors) {
      if (textMatches.some(t => (a.textContent || "").trim().includes(t))) {
        container = a.parentElement || a.closest("div") || document.body;
        break;
      }
    }
  }

  if (!container) {
    container = document.querySelector("#content") || document.body;
  }

  if (document.getElementById("gh-top-btns")) {
    // already inserted
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.style.display = "inline-block";
  wrapper.style.marginRight = "8px";
  wrapper.id = "gh-top-btns";

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "gh-btn";
  settingsBtn.textContent = "Game Hunting Settings";
  settingsBtn.title = "Open Game Hunting settings (FFScouter filters, API key, thresholds)";
  settingsBtn.onclick = openSettingsModal;

  const monitorToggle = document.createElement("button");
  monitorToggle.className = "gh-btn";
  monitorToggle.id = "gh-monitor-toggle";
  monitorToggle.textContent = "Monitor Filtered Targets";
  monitorToggle.title = "Toggle visual monitor for filtered targets";
  monitorToggle.onclick = () => {
    settings.monitorOn = !settings.monitorOn;
    saveSettings(settings);
    updateMonitorUI();
    applyAllFilters();
  };

  wrapper.appendChild(settingsBtn);
  wrapper.appendChild(monitorToggle);

  try {
    container.insertBefore(wrapper, container.firstChild);
  } catch (e) {
    (container.parentElement || document.body).insertBefore(wrapper, container);
  }
}

function openSettingsModal() {
  if (document.getElementById("gh-modal")) return;
  const modal = document.createElement("div");
  modal.className = "gh-modal";
  modal.id = "gh-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  modal.innerHTML = `
    <h2>Game Hunting Settings</h2>
    <div class="gh-row"><label>Min FF Score</label><input id="gh-min-ff" type="number" min="0" step="1" /></div>
    <div class="gh-row"><label>Max FF Score</label><input id="gh-max-ff" type="number" min="0" step="1" /></div>
    <div class="gh-row"><label>Min Stat Estimate</label><input id="gh-min-stat" type="number" min="0" step="1" /></div>
    <div class="gh-row"><label>Max Stat Estimate</label><input id="gh-max-stat" type="number" min="0" step="1" /></div>
    <div class="gh-row"><label>Minimum Bet / Pot</label><input id="gh-min-bet" type="number" min="0" step="1" /></div>
    <div class="gh-row"><label>Torn API Key (optional)</label><input id="gh-api-key" type="text" placeholder="Enter Torn API key for health check (optional)" /></div>
    <div class="gh-row"><label>Monitor On</label><input id="gh-monitor-on" type="checkbox" /></div>
    <div class="gh-row"><label>Require Known FF (exclude unknown)</label><input id="gh-require-known-ff" type="checkbox" /></div>
    <div class="gh-actions">
      <button class="gh-btn" id="gh-reset">Reset Defaults</button>
      <button class="gh-btn gh-primary" id="gh-save">Save</button>
      <button class="gh-btn" id="gh-close">Close</button>
    </div>
    <div style="font-size:12px;opacity:0.9;margin-top:10px;">
      Note: This tool performs only visual filtering and monitoring. It will NOT perform any attacks automatically.
      If you provide an API key, it will query the Torn API to confirm a player's health (rate-limited). Keys are stored locally only.
    </div>
  `;

  document.body.appendChild(modal);

  // populate values
  document.getElementById("gh-min-ff").value = settings.minFF;
  document.getElementById("gh-max-ff").value = settings.maxFF;
  document.getElementById("gh-min-stat").value = settings.minStat;
  document.getElementById("gh-max-stat").value = settings.maxStat;
  document.getElementById("gh-min-bet").value = settings.minBet;
  document.getElementById("gh-api-key").value = settings.apiKey || "";
  document.getElementById("gh-monitor-on").checked = settings.monitorOn;
  document.getElementById("gh-require-known-ff").checked = settings.requireKnownFF;

  document.getElementById("gh-save").onclick = () => {
    settings.minFF = Number(document.getElementById("gh-min-ff").value || 0);
    settings.maxFF = Number(document.getElementById("gh-max-ff").value || DEFAULTS.maxFF);
    settings.minStat = Number(document.getElementById("gh-min-stat").value || 0);
    settings.maxStat = Number(document.getElementById("gh-max-stat").value || DEFAULTS.maxStat);
    settings.minBet = Number(document.getElementById("gh-min-bet").value || 0);
    settings.apiKey = String(document.getElementById("gh-api-key").value || "");
    settings.monitorOn = Boolean(document.getElementById("gh-monitor-on").checked);
    settings.requireKnownFF = Boolean(document.getElementById("gh-require-known-ff").checked);
    saveSettings(settings);
    updateMonitorUI();
    applyAllFilters();
    closeSettingsModal();
  };

  document.getElementById("gh-reset").onclick = () => {
    settings = Object.assign({}, DEFAULTS);
    saveSettings(settings);
    document.getElementById("gh-min-ff").value = settings.minFF;
    document.getElementById("gh-max-ff").value = settings.maxFF;
    document.getElementById("gh-min-stat").value = settings.minStat;
    document.getElementById("gh-max-stat").value = settings.maxStat;
    document.getElementById("gh-min-bet").value = settings.minBet;
    document.getElementById("gh-api-key").value = "";
    document.getElementById("gh-monitor-on").checked = settings.monitorOn;
    document.getElementById("gh-require-known-ff").checked = settings.requireKnownFF;
    applyAllFilters();
  };

  document.getElementById("gh-close").onclick = closeSettingsModal;
}

function closeSettingsModal() {
  const m = document.getElementById("gh-modal");
  if (m) m.remove();
}

/* =========================
   Core Filtering & Monitoring (fixed)
   ========================= */

let observer = null;
let scanThrottleTimer = null;
const SCAN_DEBOUNCE_MS = 600;
const recentWinners = []; // {id,name,timestamp,link}
const rowState = new WeakMap(); // track per-row status to prevent reprocessing
const userHealthCheckCache = {}; // uid -> {lastChecked, status, healthPercent}

function applyFilterToRow(row, meta, passes) {
  if (!row) return;
  row.classList.remove("gh-winner", "gh-loser", "gh-hidden");
  // ensure attack removal if previously added
  const old = row.querySelector(".gh-attack");
  if (old) old.remove();

  if (!passes) {
    row.classList.add("gh-hidden");
    row.dataset.ghPass = "0";
  } else {
    row.classList.remove("gh-hidden");
    row.dataset.ghPass = "1";
  }
  rowState.set(row, Object.assign(rowState.get(row) || {}, { lastFilterCheck: Date.now(), meta }));
}

function applyAllFilters() {
  const rows = getLobbyRows();
  rows.forEach(row => {
    // get any profile anchor name & id for context
    const anchor = row.querySelector('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]');
    const name = anchor ? (anchor.textContent || "").trim() : "Unknown";
    const uid = anchor ? extractUserIdFromHref(anchor.getAttribute("href") || "") : null;

    const heur = heuristicExtractFFAndStats(row);
    const pot = findPotOrBetInRow(row);

    // Decide pass/fail
    let passFF = true;
    if (isFinite(heur.ff)) {
      passFF = heur.ff >= settings.minFF && heur.ff <= settings.maxFF;
    } else {
      // unknown
      passFF = settings.requireKnownFF ? false : true;
    }

    let passStat = true;
    if (isFinite(heur.stats)) {
      passStat = heur.stats >= settings.minStat && heur.stats <= settings.maxStat;
    } else {
      passStat = true;
    }

    let passBet = true;
    if (isFinite(pot)) {
      passBet = pot >= settings.minBet;
    } else {
      passBet = settings.minBet > 0 ? false : true; // if user set a minBet and we can't detect a pot, fail
    }

    const passes = passFF && passStat && passBet;
    applyFilterToRow(row, { uid, name, ff: heur.ff, stats: heur.stats, pot }, passes);
  });

  // apply monitor visibility
  updateMonitorUI();
}

function updateMonitorUI() {
  const toggle = document.getElementById("gh-monitor-toggle");
  if (toggle) {
    if (settings.monitorOn) {
      toggle.classList.add("gh-toggle-active");
      toggle.textContent = "Monitor: ON (showing valid targets)";
    } else {
      toggle.classList.remove("gh-toggle-active");
      toggle.textContent = "Monitor Filtered Targets";
    }
  }

  const rows = getLobbyRows();
  rows.forEach(row => {
    const pass = row.dataset && row.dataset.ghPass === "1";
    if (settings.monitorOn) {
      if (!pass) {
        // fully collapse
        row.style.display = "none";
      } else {
        row.style.display = "";
      }
    } else {
      // restore any forced display state
      row.style.display = "";
    }
  });
}

/* =========================
   Outcome Detection (improved)
   ========================= */

function detectGameOutcomeForRow(row) {
  if (!row) return null;
  const text = (row.textContent || "").toLowerCase();

  // direct textual signals
  if (/sent to hospital|sent to the hospital|hospital|skull|dead|died|0 hp|0 health|hp: 0|health: 0/i.test(text)) return "lost";
  if (/(won|winner|collected|survived|took the pot|took the pot|won \$|won m|won k)/i.test(text)) return "won";

  // icons
  const imgs = row.querySelectorAll("img");
  for (const img of imgs) {
    const alt = (img.alt || "").toLowerCase();
    const title = (img.title || "").toLowerCase();
    if (/(hospital|skull|dead)/.test(alt + " " + title)) return "lost";
    if (/(winner|won|collected|took the pot)/.test(alt + " " + title)) return "won";
  }

  // small nodes
  const smalls = row.querySelectorAll("small,span");
  for (const s of smalls) {
    const t = (s.textContent || "").toLowerCase();
    if (/(hospital|sent to hospital|dead|0 health|0 hp)/.test(t)) return "lost";
    if (/(won|winner|collected|survived)/.test(t)) return "won";
  }

  return null;
}

function markAsLoser(row, uid, name) {
  if (!row) return;
  row.classList.remove("gh-winner");
  row.classList.add("gh-loser");
  const btn = row.querySelector(".gh-attack");
  if (btn) btn.remove();
  row.classList.add("gh-hidden");
  rowState.set(row, Object.assign(rowState.get(row) || {}, { outcome: "lost", outcomeAt: Date.now() }));
}

function makeProfileOrAttackLink(uid) {
  return `https://www.torn.com/profiles.php?XID=${encodeURIComponent(uid)}`;
}

function markAsWinner(row, uid, name) {
  if (!row) return;
  row.classList.remove("gh-loser");
  row.classList.add("gh-winner");
  row.classList.remove("gh-hidden");

  // Add attack/mug icon (manual link)
  let existing = row.querySelector(".gh-attack");
  if (!existing) {
    const link = document.createElement("a");
    link.className = "gh-attack";
    link.setAttribute("title", "Open profile / attack page (manual action only)");
    link.href = uid ? makeProfileOrAttackLink(uid) : "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.innerHTML = '<span class="gh-crosshair" aria-hidden="true"></span><span style="font-size:12px;color:#dfffe0;">ATTACK</span>';
    const anchor = row.querySelector('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]');
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(link, anchor.nextSibling);
    } else {
      row.appendChild(link);
    }
  }

  // add to recent winners
  addRecentWinner({ id: uid, name: name || (row.querySelector('a') ? row.querySelector('a').textContent.trim() : "Unknown"), link: makeProfileOrAttackLink(uid) });
  rowState.set(row, Object.assign(rowState.get(row) || {}, { outcome: "won", outcomeAt: Date.now() }));
}

/* =========================
   Recent Winners panel (unchanged behavior)
   ========================= */

function ensureRecentWinnersPanel() {
  let panel = document.getElementById("gh-recent-winners");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "gh-recent-winners";
    panel.innerHTML = `<h4>Recent Winners (60s)</h4><div id="gh-recent-list"></div>`;
    document.body.appendChild(panel);
  }
}

function addRecentWinner({ id, name, link }) {
  ensureRecentWinnersPanel();
  const entry = document.createElement("div");
  entry.className = "gh-recent-entry gh-winner";
  entry.setAttribute("data-uid", id);
  const left = document.createElement("div");
  left.innerHTML = `<div class="name">${escapeHtml(name)}</div><div class="when">just now</div>`;
  const right = document.createElement("div");
  const a = document.createElement("a");
  a.href = link || "#";
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.className = "gh-attack";
  a.innerHTML = '<span class="gh-crosshair" title="Open profile / attack (manual)"></span>';
  right.appendChild(a);
  entry.appendChild(left);
  entry.appendChild(right);

  const list = document.getElementById("gh-recent-list");
  if (list) {
    list.insertBefore(entry, list.firstChild);
  }

  const created = Date.now();
  recentWinners.push({ id, name, created, node: entry });

  const interval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - created) / 1000);
    const when = entry.querySelector(".when");
    if (when) when.textContent = `${elapsed}s ago`;
    if (elapsed >= 60) {
      clearInterval(interval);
      entry.remove();
      const idx = recentWinners.findIndex(r => r.id === id && r.created === created);
      if (idx >= 0) recentWinners.splice(idx, 1);
    }
  }, 1000);
}

/* =========================
   MutationObserver + periodic monitor (robust)
   ========================= */

function startObservers() {
  if (observer) observer.disconnect();
  observer = new MutationObserver(mutations => {
    if (scanThrottleTimer) clearTimeout(scanThrottleTimer);
    scanThrottleTimer = setTimeout(() => {
      applyAllFilters();
      detectOutcomesFromMutations(mutations);
    }, SCAN_DEBOUNCE_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'title', 'alt', 'src'] });
}

function detectOutcomesFromMutations(mutations) {
  for (const m of mutations) {
    const nodes = Array.from(m.addedNodes || []);
    nodes.forEach(node => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const anchors = findProfileAnchorsInRegion(node);
      anchors.forEach(a => {
        const uid = extractUserIdFromHref(a.getAttribute("href") || "");
        const row = findRowForAnchor(a);
        if (!row) return;
        const outcome = detectGameOutcomeForRow(row);
        if (outcome === "lost") markAsLoser(row, uid, a.textContent.trim());
        else if (outcome === "won") markAsWinner(row, uid, a.textContent.trim());
        else {
          // fallback: schedule API check if apiKey present
          if (settings.apiKey && uid) scheduleUserHealthCheck(uid, row, a.textContent.trim());
        }
      });
    });

    // attribute changes may reflect updated state
    const t = m.target;
    if (t && t.nodeType === Node.ELEMENT_NODE) {
      const anchors = findProfileAnchorsInRegion(t);
      anchors.forEach(a => {
        const uid = extractUserIdFromHref(a.getAttribute("href") || "");
        const row = findRowForAnchor(a);
        if (!row) return;
        const outcome = detectGameOutcomeForRow(row);
        if (outcome === "lost") markAsLoser(row, uid, a.textContent.trim());
        else if (outcome === "won") markAsWinner(row, uid, a.textContent.trim());
      });
    }
  }
}

function findRowForAnchor(a) {
  // reuse getLobbyRows logic: find nearest lobbyRow that is in getLobbyRows()
  const rows = getLobbyRows();
  for (const row of rows) {
    if (row.contains(a)) return row;
  }
  // fallback climb
  let el = a;
  for (let i = 0; i < 8 && el && el !== document.body; i++) {
    if (rows.includes(el)) return el;
    el = el.parentElement;
  }
  return a.parentElement;
}

// periodic check loop to detect outcomes that may not produce mutations
let periodicMonitorInterval = null;
function startPeriodicMonitor() {
  if (periodicMonitorInterval) return;
  periodicMonitorInterval = setInterval(() => {
    // scan rows and attempt to detect outcomes
    const rows = getLobbyRows();
    rows.forEach(row => {
      // skip rows already marked with outcome recently
      const st = rowState.get(row) || {};
      if (st.outcome && Date.now() - (st.outcomeAt || 0) < 10_000) return; // skip if recent
      const outcome = detectGameOutcomeForRow(row);
      const anchor = row.querySelector('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]');
      const uid = anchor ? extractUserIdFromHref(anchor.getAttribute("href") || "") : null;
      const name = anchor ? anchor.textContent.trim() : "Unknown";
      if (outcome === "lost") markAsLoser(row, uid, name);
      if (outcome === "won") markAsWinner(row, uid, name);
      // if nothing obvious and API key present, schedule a health check (but cache to avoid spam)
      if ((!outcome || outcome === null) && settings.apiKey && uid) {
        scheduleUserHealthCheck(uid, row, name);
      }
    });
  }, 2000);
}

/* =========================
   Torn API health checks (rate-limited & cached)
   ========================= */

function scheduleUserHealthCheck(uid, row, name) {
  if (!settings.apiKey || !uid) return;
  const key = String(uid);
  const now = Date.now();
  const last = userHealthCheckCache[key];
  // cooldown 8s for same user to avoid hitting API repeatedly
  if (last && now - (last.lastChecked || 0) < 8000) return;
  userHealthCheckCache[key] = { lastChecked: now };

  const apiUrl = `https://api.torn.com/user/?selections=profile&id=${encodeURIComponent(uid)}&key=${encodeURIComponent(settings.apiKey)}`;

  GM_xmlhttpRequest({
    method: "GET",
    url: apiUrl,
    timeout: 10000,
    onload: function (resp) {
      try {
        if (resp.status >= 200 && resp.status < 400) {
          const data = JSON.parse(resp.responseText || "{}");
          if (data.error) {
            console.warn("Torn API error:", data.error);
            userHealthCheckCache[key] = { lastChecked: now, status: "error" };
            return;
          }
          // parse health: support various shapes
          let percent = NaN;
          if (data.health && typeof data.health === "object") {
            if (typeof data.health.percent !== "undefined") percent = Number(data.health.percent);
            else if (typeof data.health.current !== "undefined" && typeof data.health.maximum !== "undefined") percent = (Number(data.health.current) / Number(data.health.maximum)) * 100;
            else if (typeof data.profile !== "undefined" && data.profile && typeof data.profile.health_percent !== "undefined") percent = Number(data.profile.health_percent);
          } else if (typeof data.profile === "object" && data.profile.health && typeof data.profile.health.percent !== "undefined") {
            percent = Number(data.profile.health.percent);
          } else if (typeof data.health === "number") {
            percent = Number(data.health);
          }
          userHealthCheckCache[key] = { lastChecked: now, status: "ok", healthPercent: percent };

          if (isFinite(percent)) {
            if (percent <= 0.5) {
              markAsLoser(row, uid, name);
            } else {
              markAsWinner(row, uid, name);
            }
          } else {
            // fallback to DOM detection
            const outcome = detectGameOutcomeForRow(row);
            if (outcome === "lost") markAsLoser(row, uid, name);
            if (outcome === "won") markAsWinner(row, uid, name);
          }
        } else {
          console.warn("Torn API request failed with status", resp.status);
          userHealthCheckCache[key] = { lastChecked: now, status: "error" };
        }
      } catch (err) {
        console.error("Error parsing Torn API response", err);
        userHealthCheckCache[key] = { lastChecked: now, status: "error" };
      }
    },
    onerror: function (err) {
      console.warn("Torn API request error", err);
      userHealthCheckCache[key] = { lastChecked: now, status: "error" };
    }
  });
}

/* =========================
   Utilities
   ========================= */

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, function (m) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m];
  });
}

/* =========================
   Initialization & bootstrap
   ========================= */

function initialScanAndBootstrap() {
  addStyles();
  tryInsertTopButtons();
  ensureRecentWinnersPanel();
  updateMonitorUI();
  applyAllFilters();
  startObservers();
  startPeriodicMonitor();
  try { GM_registerMenuCommand && GM_registerMenuCommand("Game Hunting Settings", openSettingsModal); } catch (e) {}
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialScanAndBootstrap);
} else {
  initialScanAndBootstrap();
}

/* =========================
   Adversarial Review Notes (post-fix)
   =========================
   - Syntax: validated; uses only granted GM_* functions; GM_registerMenuCommand granted.
   - API: Follows torn-api-master-codex.md & torn-api-usage-guide.md. Uses concise selection `selections=profile`, caches API calls, and inspects `error` object in API responses.
   - Rate-limits: per-user cooldown (8s) and caching to avoid flood; no bulk requests.
   - Robustness: improved row detection and FF/pot heuristics; periodic monitor added to catch DOM update patterns MutationObserver may miss.
   - Continuity: uses WeakMap to track row-state; monitor toggle restores display fully.
   - Fair-play: strictly no automated clicking or attacks; only provides links and visual cues.
   - Traceability: settings persisted; recent winners retained for 60s and have timestamps.
================================================================================
*/
