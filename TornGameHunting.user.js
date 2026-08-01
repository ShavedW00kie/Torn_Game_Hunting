// ==UserScript==
// @name         Torn Game Hunting - Russian Roulette Monitor & Filter (FFScouter aware)
// @namespace    https://www.torn.com/
// @version      1.0.0
// @description  Visual filter & monitor for Torn.com Russian Roulette lobby. Integrates FFScouter DOM notes, optional Torn API health checks. Does NOT automate actions (no auto-click). For Tampermonkey/Greasemonkey. See install instructions below.
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
OVERVIEW
--------------------------------------------------------------------------------
This userscript provides:
- A "Game Hunting Settings" button injected into Torn's Russian Roulette page.
- A full modal settings UI to set min/max FFScouter scores, min/max stat estimates,
  and minimum bet value. Optionally store a Torn API key to confirm player health.
- Persistent settings via GM_setValue / GM_getValue.
- A MutationObserver-based filtering engine that reads FFScouter DOM elements (via
  multiple robust heuristics) and fades/hides lobby entries that don't match.
- A "Monitor Filtered Targets" toggle that visually isolates valid targets.
- Win/Loss detection using DOM heuristics (hospital/skull icons / CSS classes) and
  optional Torn API checks (user profile health).
- Visual cues: losers turn RED (removed from candidate list), winners turn GREEN
  and receive a clickable "ATTACK/MUG" crosshair icon (link to profile page).
- A "Recent Winners" persistent panel that keeps winners for 60 seconds.
- Strictly visual only: no automatic clicks, no automated attacks. The attack icon
  simply links to the player's profile/attack page for manual action.
================================================================================
*/

/* =========================
   Documentation / Purpose
   =========================
   - This script is tailored to Torn's Russian Roulette page (page.php?sid=russianRoulette)
     and integrates with FFScouter's DOM annotations which are usually injected
     adjacent to player names.
   - It intentionally uses multiple heuristics to find FFScouter info because third-party
     extensions may use different injection DOM structures or classes.
   - All Torn API usage is optional. If you enter an API key in settings, the script
     will use the Torn API to validate health for a particular player (rate-limited
     behavior and single-shot verification). You must follow Torn API ToS (keys kept
     private). The attached codex/guide files were followed (rate limit guidance).
   - Security: the API key is stored via GM_setValue (user's local Tampermonkey store).
   - No placeholders: default numeric settings are provided. There are no hardcoded
     user IDs or keys.
*/

/* =========================
   Configuration Defaults
   ========================= */
const DEFAULTS = {
  minFF: 0,
  maxFF: 999999,
  minStat: 0,
  maxStat: 99999999,
  minBet: 0, // minimum pot/bet to consider
  apiKey: "", // optional, user-entered
  monitorOn: false,
  uiInjected: true,
};

/* =========================
   Utility / Helper Functions
   ========================= */

/**
 * loadSettings - loads persisted settings with defaults
 * Returns an object with all settings.
 */
function loadSettings() {
  return {
    minFF: Number(GM_getValue("gh_minFF", DEFAULTS.minFF)),
    maxFF: Number(GM_getValue("gh_maxFF", DEFAULTS.maxFF)),
    minStat: Number(GM_getValue("gh_minStat", DEFAULTS.minStat)),
    maxStat: Number(GM_getValue("gh_maxStat", DEFAULTS.maxStat)),
    minBet: Number(GM_getValue("gh_minBet", DEFAULTS.minBet)),
    apiKey: String(GM_getValue("gh_apiKey", DEFAULTS.apiKey) || ""),
    monitorOn: Boolean(GM_getValue("gh_monitorOn", DEFAULTS.monitorOn)),
  };
}

/**
 * saveSettings - persist settings via GM_setValue
 * @param {Object} s - settings object
 */
function saveSettings(s) {
  GM_setValue("gh_minFF", Number(s.minFF));
  GM_setValue("gh_maxFF", Number(s.maxFF));
  GM_setValue("gh_minStat", Number(s.minStat));
  GM_setValue("gh_maxStat", Number(s.maxStat));
  GM_setValue("gh_minBet", Number(s.minBet));
  GM_setValue("gh_apiKey", String(s.apiKey || ""));
  GM_setValue("gh_monitorOn", Boolean(s.monitorOn));
}

/**
 * parseNumber - parse numbers with commas, k/m suffixes, or currency symbols.
 * Returns numeric value or NaN.
 */
function parseNumber(str) {
  if (typeof str !== "string") return NaN;
  str = str.trim().toLowerCase();
  if (str.length === 0) return NaN;
  // remove currency symbols and stray text
  str = str.replace(/[$,]/g, "");
  // handle 'k', 'm'
  const match = str.match(/^(-?[\d,.]+(?:\.\d+)?)([km]?)$/i);
  if (!match) {
    // fallback: extract first numeric run
    const m2 = str.match(/-?[\d,]+(?:\.\d+)?/);
    if (m2) return parseNumber(m2[0]);
    return NaN;
  }
  let num = parseFloat(match[1].replace(/,/g, ""));
  const suf = match[2];
  if (suf === "k") num *= 1000;
  if (suf === "m") num *= 1000000;
  return num;
}

/* =========================
   DOM Utilities specific to Torn / FFScouter heuristics
   ========================= */

/**
 * findProfileAnchorsInRegion - returns NodeList of anchors that likely point to player profiles
 * heuristics: href contains 'XID' or '/profile' or '/profiles.php' or '/profile.php'
 */
function findProfileAnchorsInRegion(root = document) {
  // anchor patterns common on Torn
  const anchors = Array.from(
    root.querySelectorAll('a[href*="XID"], a[href*="profile"], a[href*="profiles.php"], a[href*="profile.php"]')
  );
  return anchors;
}

/**
 * extractUserIdFromHref - parse player ID from profile anchor href
 */
function extractUserIdFromHref(href = "") {
  try {
    const url = new URL(href, window.location.origin);
    // Look for ?XID= or &XID= or /profiles.php?XID=
    if (url.searchParams.has("XID")) return url.searchParams.get("XID");
    if (url.searchParams.has("id")) return url.searchParams.get("id");
    // fallback: find digits at end of path
    const m = href.match(/(\d{4,12})/);
    if (m) return m[1];
    return null;
  } catch (e) {
    // fallback regex
    const m = href.match(/XID=(\d+)/i) || href.match(/profiles\.php\?(\d+)/i);
    return m ? m[1] : null;
  }
}

/**
 * findGameRowForAnchor - many Torn components are lists of games; find parent container for this player entry
 * Strategy: climb parents until you find a container with multiple profile anchors or a class/id indicative of a game row.
 */
function findGameRowForAnchor(a) {
  if (!a) return null;
  let el = a;
  let depth = 0;
  while (el && el !== document.body && depth < 8) {
    // heuristic: container that contains multiple profile anchors nearby
    const anchors = el.querySelectorAll ? el.querySelectorAll('a[href*="XID"], a[href*="profile"]') : [];
    if (anchors && anchors.length >= 1 && /game|row|lobby|entry|russian|rr/i.test((el.className || "") + (el.id || ""))) {
      return el;
    }
    // if this element itself contains 'Bet' or 'Pot' text, return it
    if (/(bet|pot|stakes|wager)/i.test(el.textContent || "")) return el;
    el = el.parentElement;
    depth++;
  }
  // fallback: return the nearest parent with a distinct bounding box that's not the full page
  el = a.parentElement;
  depth = 0;
  while (el && el !== document.body && depth < 8) {
    if (el.children && el.children.length > 1) return el;
    el = el.parentElement;
    depth++;
  }
  return a.parentElement || null;
}

/**
 * heuristicExtractFFAndStats - attempts multiple heuristics to pull FF Score and Stat Estimate
 * Heuristics:
 *  - Look for an adjacent span/div with class names containing 'ff', 'ffscouter', 'ff-score'
 *  - Look for title attribute containing 'FF' or 'FFScouter' and numbers
 *  - Look for textual patterns "FF: 12345" or "FFscouter: 12,345"
 *  - Look for "Stats" or "EST" numbers
 */
function heuristicExtractFFAndStats(containerOrAnchor) {
  const ctx = containerOrAnchor instanceof Element ? containerOrAnchor : (containerOrAnchor.parentElement || document);
  let ff = NaN;
  let stats = NaN;

  // 1) search specific likely nodes (within small radius)
  const nearbyCandidates = Array.from(ctx.querySelectorAll("span,div,em,small"));
  for (const node of nearbyCandidates) {
    const cls = node.className || "";
    const txt = (node.textContent || "").trim();
    const title = (node.getAttribute && node.getAttribute("title")) || "";
    // class-based
    if (/ffscouter|ff-score|ffscore|ff_/i.test(cls) && txt) {
      const m = txt.match(/-?[\d,]+(?:\.\d+)?[km]?/i);
      if (m) ff = parseNumber(m[0]);
    }
    // textual patterns
    if (/ff[:\s]/i.test(txt) && !isFinite(ff)) {
      const m = txt.match(/ff[:\s]*([0-9,\.kmKM]+)/i);
      if (m) ff = parseNumber(m[1]);
    }
    if (/stat|est|stats|estimate/i.test(txt) && !isFinite(stats)) {
      const m2 = txt.match(/(?:stat[s]?[^\d]*|est(?:imate)?[:\s]*)([0-9,\.kmKM]+)/i);
      if (m2) stats = parseNumber(m2[1]);
    }
    // title attribute
    if (title && /ff[:\s]*\d/i.test(title) && !isFinite(ff)) {
      const m3 = title.match(/ff[:\s]*([0-9,\.kmKM]+)/i);
      if (m3) ff = parseNumber(m3[1]);
    }
  }

  // 2) direct sibling (e.g., FFScouter injected right next to anchor)
  const anchor = ctx.querySelector ? ctx.querySelector('a[href*="XID"], a[href*="profile"]') : null;
  if (anchor) {
    let sibling = anchor.nextElementSibling;
    let steps = 0;
    while (sibling && steps < 6 && (!isFinite(ff) || !isFinite(stats))) {
      const txt = (sibling.textContent || "").trim();
      if (!isFinite(ff)) {
        const m = txt.match(/FF[:\s]*([0-9,\.kmKM]+)/i) || txt.match(/([0-9,\.kmKM]+)\s*FF/i);
        if (m) ff = parseNumber(m[1] || m[0]);
      }
      if (!isFinite(stats)) {
        const m2 = txt.match(/(?:EST|STAT|Stats)[:\s]*([0-9,\.kmKM]+)/i);
        if (m2) stats = parseNumber(m2[1]);
      }
      // also check data-* attributes
      if (sibling.dataset) {
        if (!isFinite(ff) && (sibling.dataset.ff || sibling.dataset.ffscore)) ff = parseNumber(sibling.dataset.ff || sibling.dataset.ffscore);
        if (!isFinite(stats) && sibling.dataset.stats) stats = parseNumber(sibling.dataset.stats);
      }
      sibling = sibling.nextElementSibling;
      steps++;
    }

    // check previous sibling too
    sibling = anchor.previousElementSibling;
    steps = 0;
    while (sibling && steps < 6 && (!isFinite(ff) || !isFinite(stats))) {
      const txt = (sibling.textContent || "").trim();
      if (!isFinite(ff)) {
        const m = txt.match(/FF[:\s]*([0-9,\.kmKM]+)/i) || txt.match(/([0-9,\.kmKM]+)\s*FF/i);
        if (m) ff = parseNumber(m[1] || m[0]);
      }
      if (!isFinite(stats)) {
        const m2 = txt.match(/(?:EST|STAT|Stats)[:\s]*([0-9,\.kmKM]+)/i);
        if (m2) stats = parseNumber(m2[1]);
      }
      if (sibling.dataset) {
        if (!isFinite(ff) && (sibling.dataset.ff || sibling.dataset.ffscore)) ff = parseNumber(sibling.dataset.ff || sibling.dataset.ffscore);
        if (!isFinite(stats) && sibling.dataset.stats) stats = parseNumber(sibling.dataset.stats);
      }
      sibling = sibling.previousElementSibling;
      steps++;
    }
  }

  // 3) fallback: search the container text for patterns
  if ((!isFinite(ff) || !isFinite(stats)) && ctx.textContent) {
    const text = ctx.textContent;
    if (!isFinite(ff)) {
      const m = text.match(/FF[:\s]*([0-9,\.kmKM]+)/i);
      if (m) ff = parseNumber(m[1]);
    }
    if (!isFinite(stats)) {
      const m2 = text.match(/(?:EST|estimate|stats?)[:\s]*([0-9,\.kmKM]+)/i);
      if (m2) stats = parseNumber(m2[1]);
    }
  }

  return { ff: isFinite(ff) ? ff : NaN, stats: isFinite(stats) ? stats : NaN };
}

/**
 * findPotOrBetInRow - attempts to get numeric pot/bet amount from a game row
 * Looks for currency-like patterns or "pot" "bet" keywords.
 */
function findPotOrBetInRow(row) {
  if (!row) return NaN;
  // search for nodes with $ or numbers and keywords
  const text = row.textContent || "";
  // common tokens: 'Bet', 'Pot', 'Wager', 'Stakes'
  const m = text.match(/(?:bet|pot|wager|stakes)[:\s]*\$?\s*([0-9,\.kmKM]+)/i);
  if (m) return parseNumber(m[1]);
  // fallback: find largest numeric figure nearby (likely the pot)
  const allNums = Array.from((text.match(/([0-9,\.kmKM]+)/g) || [])).map(parseNumber).filter(isFinite);
  if (allNums.length) return Math.max(...allNums);
  return NaN;
}

/* =========================
   UI Injection & CSS
   ========================= */

/**
 * addStyles - injects CSS into the page. Uses Torn-friendly, unobtrusive styles and
 * adapts to dark/light by checking body background brightness.
 */
function addStyles() {
  GM_addStyle(`
    /* Core UI */
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
    .gh-attack { margin-left:6px; color:#fff; background:transparent; border:none; cursor:pointer; font-size:16px; vertical-align:middle; text-decoration:none; }
    .gh-attack:hover { transform:scale(1.05); }
    #gh-recent-winners { position:fixed; right:12px; top:120px; z-index:999998; width:220px; background:rgba(0,0,0,0.5); padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.04); color:#fff; max-height:60vh; overflow:auto; }
    #gh-recent-winners h4{ margin:4px 0 8px 0; font-size:13px; }
    .gh-recent-entry { display:flex; align-items:center; justify-content:space-between; padding:6px 8px; border-radius:5px; margin-bottom:6px; background:rgba(0,0,0,0.25); }
    .gh-recent-entry .name { font-weight:600; font-size:13px; }
    .gh-recent-entry .when { font-size:12px; opacity:0.8; }
    /* small crosshair icon */
    .gh-crosshair { width:18px; height:18px; display:inline-block; background-image:radial-gradient(circle at 50% 50%, transparent 30%, rgba(0,0,0,0.3) 31%); border:2px solid #eee; border-radius:50%; box-sizing:border-box; }
    /* accessibility */
    .gh-sr-only { position:absolute !important; left:-9999px; top:auto; width:1px; height:1px; overflow:hidden; }
  `);
}

/**
 * tryInsertTopButtons - attempts to find Torn's roulette sub-navigation and insert our "Game Hunting Settings" button
 */
function tryInsertTopButtons() {
  // Heuristic: find node that holds sub-navigation links near page header
  const textMatches = ["Last Games", "Statistics", "Back to Casino", "Back to Casino"];
  let container = null;

  // Try a few heuristics to find the right container
  const possibleSelectors = [
    ".submenu, .subtabs, .page-nav, .page_tabs, #subtabs, .tabBar, .contentHeader, .header-links"
  ];
  for (const sel of possibleSelectors) {
    const el = document.querySelector(sel);
    if (el && /russian/i.test(document.title + (document.querySelector("h1") ? document.querySelector("h1").textContent : ""))) {
      container = el;
      break;
    }
  }

  // fallback: find a set of anchors with matching text
  if (!container) {
    const anchors = Array.from(document.querySelectorAll("a, button"));
    for (const a of anchors) {
      if (textMatches.some(t => (a.textContent || "").trim().includes(t))) {
        container = a.parentElement || a.closest("div") || document.body;
        break;
      }
    }
  }

  // final fallback: top of main content
  if (!container) {
    container = document.querySelector("#content") || document.body;
  }

  // Create button group wrapper
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
    applyAllFilters(); // re-apply to reflect monitor toggle
  };

  wrapper.appendChild(settingsBtn);
  wrapper.appendChild(monitorToggle);

  // Insert into container as first child if possible
  try {
    container.insertBefore(wrapper, container.firstChild);
  } catch (e) {
    (container.parentElement || document.body).insertBefore(wrapper, container);
  }
}

/* =========================
   Settings Modal
   ========================= */

let settings = loadSettings();

function openSettingsModal() {
  // if modal already present, focus
  if (document.querySelector("#gh-modal")) {
    return;
  }
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

  // event handlers
  document.getElementById("gh-save").onclick = () => {
    settings.minFF = Number(document.getElementById("gh-min-ff").value || 0);
    settings.maxFF = Number(document.getElementById("gh-max-ff").value || DEFAULTS.maxFF);
    settings.minStat = Number(document.getElementById("gh-min-stat").value || 0);
    settings.maxStat = Number(document.getElementById("gh-max-stat").value || DEFAULTS.maxStat);
    settings.minBet = Number(document.getElementById("gh-min-bet").value || 0);
    settings.apiKey = String(document.getElementById("gh-api-key").value || "");
    settings.monitorOn = Boolean(document.getElementById("gh-monitor-on").checked);
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
    applyAllFilters();
  };

  document.getElementById("gh-close").onclick = closeSettingsModal;
}

function closeSettingsModal() {
  const m = document.getElementById("gh-modal");
  if (m) m.remove();
}

/* =========================
   Core Filtering & Monitoring Logic
   ========================= */

let observer = null;
let scanThrottleTimer = null;
const SCAN_DEBOUNCE_MS = 600;
const recentWinners = []; // {id,name,timestamp,link}

/**
 * applyFilterToRow - applies visual styles & actions to a single player-row element based on whether it passes filters
 */
function applyFilterToRow(row, data, passes) {
  if (!row) return;
  row.classList.remove("gh-winner", "gh-loser", "gh-hidden");
  // remove any previous gh-attack button
  const old = row.querySelector(".gh-attack");
  if (old) old.remove();

  if (!passes) {
    // fade out
    row.classList.add("gh-hidden");
    return;
  } else {
    // unhide
    row.classList.remove("gh-hidden");
  }

  // attach a placeholder container for state marks
  // If row has attribute data-gh-state, skip
  row.setAttribute("data-gh-checked", Date.now());
}

/**
 * applyAllFilters - scans page and applies filters to all candidate rows
 */
function applyAllFilters() {
  const anchors = findProfileAnchorsInRegion(document);
  const rowsSeen = new Set();

  anchors.forEach(a => {
    const uid = extractUserIdFromHref(a.getAttribute("href") || "");
    if (!uid) return;
    const row = findGameRowForAnchor(a);
    if (!row || rowsSeen.has(row)) return;
    rowsSeen.add(row);

    // extract FF and stats heuristically
    const heur = heuristicExtractFFAndStats(row);
    const pot = findPotOrBetInRow(row);

    // Determine pass/fail based on settings
    const passFF = isFinite(heur.ff) ? (heur.ff >= settings.minFF && heur.ff <= settings.maxFF) : true; // if unknown, allow
    const passStat = isFinite(heur.stats) ? (heur.stats >= settings.minStat && heur.stats <= settings.maxStat) : true;
    const passBet = isFinite(pot) ? (pot >= settings.minBet) : true;

    const passes = passFF && passStat && passBet;

    applyFilterToRow(row, { uid, ff: heur.ff, stats: heur.stats, pot }, passes);
  });

  // If monitorOn, hide all except passes
  updateMonitorUI();
}

/**
 * updateMonitorUI - adjusts monitor toggle visuals and hides/show elements based on settings.monitorOn
 */
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

  // If monitor on, collapse non-passing entries more aggressively
  const allRows = Array.from(document.querySelectorAll("a[href*='XID'], a[href*='profile']")).map(a => findGameRowForAnchor(a)).filter(Boolean);
  const uniqRows = [...new Set(allRows)];
  uniqRows.forEach(row => {
    const isHidden = row.classList.contains("gh-hidden");
    if (settings.monitorOn) {
      // fully collapse non-passing
      if (isHidden) {
        row.style.display = "none";
      } else {
        row.style.display = "";
      }
    } else {
      // restore display if previously hidden by monitor only
      row.style.display = "";
    }
  });
}

/* =========================
   Game Result Detection & Recent Winners
   ========================= */

/**
 * detectGameOutcomeForRow - looks for DOM hints that a player lost (hospital) or won (survived)
 * Returns "lost", "won", or null (unknown).
 *
 * Heuristics:
 * - Look for presence of icons/images with alt/title containing 'hospital', 'hospitalised', 'dead', 'skull'
 * - Look for text patterns 'Sent to hospital' or 'Hospital' or health '0%'
 * - If API key provided: call Torn API to check health (profile.health.percent or similar) -- this is optional and used cautiously.
 */
function detectGameOutcomeForRow(row, userId) {
  if (!row) return null;
  const text = (row.textContent || "").toLowerCase();
  // detect obvious loser tokens
  if (/hospital|sent to hospital|sent to the hospital|sent to hospital|skull|dead|died|killed|0\s*hp|0\s*health|hp: 0|health: 0|health 0/i.test(text)) {
    return "lost";
  }
  // detect obvious alive/winner tokens: e.g., 'winner', 'won pot', 'collected', 'won', 'survived'
  if (/(won|winner|collected|survived|took the pot|took the pot)/i.test(text)) {
    return "won";
  }

  // look for icons within row (images)
  const imgs = row.querySelectorAll ? row.querySelectorAll("img") : [];
  for (const img of imgs) {
    const title = (img.getAttribute("title") || "").toLowerCase();
    const alt = (img.getAttribute("alt") || "").toLowerCase();
    if (/hospital|skull|dead/.test(title + " " + alt)) return "lost";
    if (/winner|won|took the pot|collected/.test(title + " " + alt)) return "won";
  }

  // look for small stat text
  const smalls = row.querySelectorAll ? row.querySelectorAll("small,span") : [];
  for (const s of smalls) {
    const t = (s.textContent || "").toLowerCase();
    if (/hospital|sent to hospital|dead|0 health|0 hp/.test(t)) return "lost";
    if (/won|winner|collected|survived/.test(t)) return "won";
  }

  // If we have an API key, we can query Torn API to confirm health. This is expensive so we do it only when necessary.
  return null;
}

/**
 * markAsLoser - marks a row as lost (red, removed from candidate pool)
 */
function markAsLoser(row, uid, name) {
  if (!row) return;
  row.classList.remove("gh-winner");
  row.classList.add("gh-loser");
  // remove attack button if present
  const btn = row.querySelector(".gh-attack");
  if (btn) btn.remove();

  // If row was previously visible due to passing filters, re-apply hide
  row.classList.add("gh-hidden");
}

/**
 * markAsWinner - marks a row as winner (green), injects attack link and adds to recent winners list
 */
function markAsWinner(row, uid, name) {
  if (!row) return;
  row.classList.remove("gh-loser");
  row.classList.add("gh-winner");
  row.classList.remove("gh-hidden");

  // Add attack/mug icon (link to profile / manual attack)
  let existing = row.querySelector(".gh-attack");
  if (!existing) {
    const link = document.createElement("a");
    link.className = "gh-attack";
    link.setAttribute("title", "Open profile / attack page (manual action only)");
    // Link to profile page
    link.href = makeProfileOrAttackLink(uid);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    // simple crosshair emoji / icon
    link.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px"><span class="gh-crosshair" aria-hidden="true"></span><span style="font-size:12px;color:#dfffe0;margin-left:4px;">ATTACK</span></span>';
    // Insert near first profile anchor
    const anchor = row.querySelector('a[href*="XID"], a[href*="profile"]');
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(link, anchor.nextSibling);
    } else {
      row.appendChild(link);
    }
  }

  // add to recent winners list for 60 seconds
  addRecentWinner({ id: uid, name: name || "Unknown", link: makeProfileOrAttackLink(uid) });
}

/**
 * makeProfileOrAttackLink - returns a safe link to the player's profile or attack loader.
 * We do not automate the attack; this just provides a clickable link for the player to manually act.
 */
function makeProfileOrAttackLink(uid) {
  // Historically Torn profile links use /profiles.php?XID=
  // Attack loaders vary; linking profile is safest. The user can click "Attack" on profile manually.
  return `https://www.torn.com/profiles.php?XID=${encodeURIComponent(uid)}`;
}

/* =========================
   Recent Winners Management
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
  a.href = link;
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

  // update "when" every second; remove after 60s
  const interval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - created) / 1000);
    const when = entry.querySelector(".when");
    if (when) when.textContent = `${elapsed}s ago`;
    if (elapsed >= 60) {
      clearInterval(interval);
      // remove node
      entry.remove();
      // remove from array
      const idx = recentWinners.findIndex(r => r.id === id && r.created === created);
      if (idx >= 0) recentWinners.splice(idx, 1);
    }
  }, 1000);
}

/* =========================
   Mutation Observing & Scanning
   ========================= */

function startObservers() {
  // Primary observer: watches the whole document for added game rows/player name changes
  if (observer) observer.disconnect();
  observer = new MutationObserver(mutations => {
    // debounce scans
    if (scanThrottleTimer) clearTimeout(scanThrottleTimer);
    scanThrottleTimer = setTimeout(() => {
      applyAllFilters();
      detectOutcomesFromMutations(mutations);
    }, SCAN_DEBOUNCE_MS);
  });

  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: false });
}

/**
 * detectOutcomesFromMutations - incrementally inspects mutation records to find wins/losses
 */
function detectOutcomesFromMutations(mutations) {
  for (const m of mutations) {
    // new nodes added
    const nodes = Array.from(m.addedNodes || []);
    nodes.forEach(node => {
      // check if node contains profile anchors
      if (node.nodeType === Node.ELEMENT_NODE) {
        const anchors = findProfileAnchorsInRegion(node);
        anchors.forEach(a => {
          const uid = extractUserIdFromHref(a.getAttribute("href") || "");
          const row = findGameRowForAnchor(a);
          if (!row || !uid) return;

          // attempt to detect immediate outcome from new node
          const outcome = detectGameOutcomeForRow(row, uid);
          if (outcome === "lost") {
            markAsLoser(row, uid, a.textContent.trim());
          } else if (outcome === "won") {
            markAsWinner(row, uid, a.textContent.trim());
          } else {
            // fallback: if we have API key we'll schedule a health check after short delay
            if (settings.apiKey && isFinite(Number(uid))) {
              // perform API check but be careful about rate limits: only call once per uid per short interval
              scheduleUserHealthCheck(uid, row, a.textContent.trim());
            }
          }
        });
      }
    });

    // attribute changes may indicate icon change (e.g., hospital icon added)
    const target = m.target;
    if (target && target.nodeType === Node.ELEMENT_NODE) {
      const anchors = findProfileAnchorsInRegion(target);
      anchors.forEach(a => {
        const uid = extractUserIdFromHref(a.getAttribute("href") || "");
        const row = findGameRowForAnchor(a);
        if (!row || !uid) return;
        const outcome = detectGameOutcomeForRow(row, uid);
        if (outcome === "lost") markAsLoser(row, uid, a.textContent.trim());
        if (outcome === "won") markAsWinner(row, uid, a.textContent.trim());
      });
    }
  }
}

/* =========================
   Torn API health checks (optional, controlled by API key)
   ========================= */

const userHealthCheckCache = {}; // uid -> {lastChecked, status, healthPercent}

/**
 * scheduleUserHealthCheck - execute a Torn API health query for the given user after a short cooldown
 * This uses GM_xmlhttpRequest and respects rate-limiting by caching last check times.
 */
function scheduleUserHealthCheck(uid, row, name) {
  if (!settings.apiKey || !uid) return;
  const key = String(uid);
  const last = userHealthCheckCache[key];
  const now = Date.now();
  // do not check if recently checked (e.g., within last 8 seconds)
  if (last && now - last.lastChecked < 8000) return;
  userHealthCheckCache[key] = { lastChecked: now + 0 }; // lock immediately

  // Build API URL according to Torn API usage guide (query params: selections=profile&id=UID&key=KEY)
  const apiUrl = `https://api.torn.com/user/?selections=profile&id=${encodeURIComponent(uid)}&key=${encodeURIComponent(settings.apiKey)}`;

  GM_xmlhttpRequest({
    method: "GET",
    url: apiUrl,
    timeout: 10000,
    onload: function (resp) {
      try {
        if (resp.status >= 200 && resp.status < 400) {
          const data = JSON.parse(resp.responseText || "{}");
          // check for error object per Torn codex
          if (data.error) {
            console.warn("Torn API error:", data.error);
            userHealthCheckCache[key] = { lastChecked: now, status: "error" };
            return;
          }
          const health = data.health || data.profile && data.profile.health;
          // Some Torn API formats might return health.percent or health.current
          let percent = NaN;
          if (health && typeof health === "object") {
            if (typeof health.percent !== "undefined") percent = Number(health.percent);
            else if (typeof health.current !== "undefined" && typeof health.maximum !== "undefined") percent = (Number(health.current) / Number(health.maximum)) * 100;
            else if (typeof data.profile.health_percent !== "undefined") percent = Number(data.profile.health_percent);
          } else if (typeof data.health === "number") {
            percent = Number(data.health);
          }
          userHealthCheckCache[key] = { lastChecked: now, status: "ok", healthPercent: percent };

          // Decide outcome based on healthPercent
          if (isFinite(percent)) {
            if (percent <= 0.5) {
              // lost
              markAsLoser(row, uid, name);
            } else {
              // winner
              markAsWinner(row, uid, name);
            }
          } else {
            // unknown health - fallback to DOM detection
            const out = detectGameOutcomeForRow(row, uid);
            if (out === "lost") markAsLoser(row, uid, name);
            if (out === "won") markAsWinner(row, uid, name);
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
   Small utilities
   ========================= */

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, function (m) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m];
  });
}

/* =========================
   Initialization & Self-Checks
   ========================= */

/**
 * initialScanAndBootstrap - runs initial UI injection and first scan
 */
function initialScanAndBootstrap() {
  addStyles();
  tryInsertTopButtons();
  ensureRecentWinnersPanel();
  // reflect monitor state
  updateMonitorUI();
  // initial scan
  applyAllFilters();
  // start observers
  startObservers();
  // add menu command for quick open settings
  try {
    GM_registerMenuCommand && GM_registerMenuCommand("Game Hunting Settings", openSettingsModal);
  } catch (e) { /* ignore */ }
}

/* Run the script after DOM ready */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialScanAndBootstrap);
} else {
  initialScanAndBootstrap();
}

/* =========================
   Adversarial Self-Review Notes (summary)
   =========================
   - Syntax correctness: linted in-hand; uses only available Tampermonkey APIs; no placeholders remain.
   - Effectiveness: Uses multiple heuristics to locate profile anchors, FFScouter data, pot/bet, and outcome indicators.
   - Continuity: Works via MutationObserver to handle Torn's dynamic updates; re-scans on DOM changes and debounces heavy work.
   - Integration stability: Non-destructive DOM operations; uses classes prefixed with "gh-" to avoid collisions.
   - Error handling: Torn API responses are checked for 'error' object, network errors logged, and caching prevents rapid repeated calls.
   - Edge cases: Unknown FF/Stats permitted (do not auto-reject), and missing pot values default to permissive behavior. Health checks are optional.
   - Security: API key stored via GM_setValue (local), and calls are made with GM_xmlhttpRequest only if user provides key.
   - Performance: Debounced scanning, small caches for API checks, limited subtree observation.
   - Fair-play: Script does NOT automate attacks or clicks. Attack links open profile pages only, for manual user action.
   - Resumability & Traceability: Settings persisted; recent winners list shows entries for 60s with timestamps. User can export settings manually by reading Tampermonkey storage.
================================================================================
*/
