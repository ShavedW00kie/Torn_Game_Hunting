// ==UserScript==
// @name         Torn Game Hunting - Russian Roulette Monitor & Filter (FFScouter aware)
// @namespace    https://www.torn.com/
// @version      1.4.1
// @description  Visual filter & monitor for Torn.com Russian Roulette lobby. Integrates FFScouter DOM notes, optional Torn API health checks. Does NOT automate actions (no auto-click). For Tampermonkey/Greasemonkey. See install instructions below.
// @author       ShavedW00kie (via Copilot Space)
// @homepageURL  https://github.com/ShavedW00kie
// @downloadURL  https://gist.githubusercontent.com/ShavedW00kie/fd414d7498a01308ef65a8f997a77301/raw/TornGameHunting.user.js
// @updateURL    https://gist.githubusercontent.com/ShavedW00kie/fd414d7498a01308ef65a8f997a77301/raw/TornGameHunting.user.js
// @match        https://www.torn.com/page.php?sid=russianRoulette*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      api.torn.com
// ==/UserScript==

/*
 Version 1.4.1 - Minor fixes and helper implementations
 - Adds missing helper functions (getLobbyRows, extractUserIdFromHref, getDisplayNameFromAnchor, findProfileAnchorsInRegion, addStyles, toggleDebugPanel)
 - Keeps all previous UI, debug panel, Recent Winners, and strict no-automation policy.
 - Ensures minimal changes to original logic; preserves heuristics and behavior.
*/

/* =========================
   Defaults & Settings
   ========================= */
const DEFAULTS = {
  minFF: 0,
  maxFF: 999999999,
  minStat: 0,
  maxStat: 999999999,
  minBet: 0,
  apiKey: "",
  monitorOn: false,
  requireKnownFF: false,
  debugEnabled: false,
  testExtractionCount: 8,
  includeFullRowHTML: false
};

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
    debugEnabled: Boolean(GM_getValue("gh_debugEnabled", DEFAULTS.debugEnabled)),
    testExtractionCount: Number(GM_getValue("gh_testExtractionCount", DEFAULTS.testExtractionCount)),
    includeFullRowHTML: Boolean(GM_getValue("gh_includeFullRowHTML", DEFAULTS.includeFullRowHTML))
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
  GM_setValue("gh_debugEnabled", Boolean(s.debugEnabled));
  GM_setValue("gh_testExtractionCount", Number(s.testExtractionCount));
  GM_setValue("gh_includeFullRowHTML", Boolean(s.includeFullRowHTML));
}

let settings = loadSettings();

/* =========================
   Logging utilities
   ========================= */
const LOG_BUFFER_MAX = 400;
const logBuffer = [];
function pushLog(level, msg, meta) {
  const entry = { ts: Date.now(), level, msg: String(msg), meta: meta || null };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  if (settings.debugEnabled) {
    const t = new Date(entry.ts).toISOString();
    if (level === "error") console.error(`[GH ${t}] ${msg}`, meta || "");
    else if (level === "warn") console.warn(`[GH ${t}] ${msg}`, meta || "");
    else if (level === "info") console.info(`[GH ${t}] ${msg}`, meta || "");
    else console.log(`[GH ${t}] ${msg}`, meta || "");
  }
  updateDebugPanel();
}
function logDebug(m, meta){ pushLog("debug", m, meta); }
function logInfo(m, meta){ pushLog("info", m, meta); }
function logWarn(m, meta){ pushLog("warn", m, meta); }
function logError(m, meta){ pushLog("error", m, meta); }

/* =========================
   Small helpers
   ========================= */
function parseNumber(str) {
  if (typeof str !== "string") return NaN;
  let s = str.trim().toLowerCase();
  if (!s) return NaN;
  s = s.replace(/[$€£\s,]/g, "");
  const m = s.match(/^(-?[\d.]+)([km]?)$/i);
  if (m) {
    let num = parseFloat(m[1]);
    const suf = (m[2] || "").toLowerCase();
    if (suf === "k") num *= 1_000;
    if (suf === "m") num *= 1_000_000;
    return num;
  }
  const m2 = s.match(/-?[\d.]+/);
  if (m2) return parseFloat(m2[0]);
  return NaN;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, function (m) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m];
  });
}

/* =========================
   Missing helper implementations (added to make script functional)
   These are intentionally conservative and robust to different DOM structures.
*/

/**
 * Return an array of "row" elements representing lobby entries.
 * Strategy:
 *  - Find all anchors that look like profile links, then map to a sensible ancestor row element.
 *  - Deduplicate and return as an array.
 */
function getLobbyRows() {
  try {
    const anchors = Array.from(document.querySelectorAll('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]'));
    const rows = [];
    const seen = new Set();
    for (const a of anchors) {
      // prefer a closest row-like ancestor
      let row = a.closest('tr, li, div');
      if (!row) row = a.parentElement;
      // try to find a row with class containing "row" or "entry" or "lobby"
      let candidate = row;
      for (let i = 0; i < 6 && candidate && candidate !== document.body; i++) {
        const cls = (candidate.className || "").toString().toLowerCase();
        if (cls.includes('row') || cls.includes('entry') || cls.includes('lobby') || cls.includes('game') || cls.includes('list')) { row = candidate; break; }
        candidate = candidate.parentElement;
      }
      if (!row) continue;
      if (!seen.has(row)) { seen.add(row); rows.push(row); }
    }
    // Fallback: if none found, try to find table rows under known containers
    if (!rows.length) {
      const possible = Array.from(document.querySelectorAll('#content tr, #content li, .roulette-lobby .row, .rr-row, .lobby-row'));
      for (const el of possible) {
        if (!seen.has(el)) { seen.add(el); rows.push(el); }
      }
    }
    return rows;
  } catch (e) {
    logError("getLobbyRows error", e);
    return [];
  }
}

/**
 * Extract numeric user id from a profile href.
 */
function extractUserIdFromHref(href) {
  if (!href || typeof href !== 'string') return null;
  try {
    // common Torn patterns: profiles.php?XID=12345 or profile.php?XID=12345 or /profiles/12345
    const m = href.match(/[?&]XID=(\d+)/i) || href.match(/profiles\/(\d+)/i) || href.match(/profile.php\/(\d+)/i);
    if (m) return m[1];
    // sometimes the link is like "index.php#profile_12345" or similar
    const m2 = href.match(/profile[_-]?(\d+)/i);
    if (m2) return m2[1];
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Get a display name from an anchor element, using title, data attributes, or text content.
 */
function getDisplayNameFromAnchor(anchor) {
  if (!anchor) return "Unknown";
  try {
    const t = (anchor.getAttribute("title") || anchor.getAttribute("aria-label") || anchor.getAttribute("data-player-name") || anchor.getAttribute("data-name") || anchor.textContent || "").trim();
    if (t) return t.replace(/\s+/g, " ");
  } catch (e) { /* ignore */ }
  return "Unknown";
}

/**
 * Find profile anchors within a DOM region/node.
 */
function findProfileAnchorsInRegion(node) {
  const anchors = [];
  try {
    if (!node) return anchors;
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.matches && node.matches('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]')) anchors.push(node);
      anchors.push(...Array.from(node.querySelectorAll('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]')));
    }
  } catch (e) { logError("findProfileAnchorsInRegion error", e); }
  return anchors;
}

/**
 * Add CSS styles used by the script.
 */
function addStyles() {
  try {
    const css = `
    /* Game Hunting styles */
    #gh-top-btns { display:inline-block; vertical-align:middle; }
    .gh-btn { margin:0 4px; padding:6px 8px; background:#222; color:#fff; border-radius:4px; border:1px solid rgba(255,255,255,0.06); cursor:pointer; font-size:12px; }
    .gh-btn.gh-primary { background:linear-gradient(#2b8,#198); color:#012; font-weight:600; }
    .gh-toggle-active { box-shadow:0 0 0 2px rgba(100,255,100,0.08) inset; }
    .gh-hidden { opacity:0.35; transition:opacity 200ms ease; }
    .gh-winner { background: linear-gradient(90deg, rgba(0,80,0,0.06), rgba(0,120,0,0.02)); border-left:4px solid #2ecc71; }
    .gh-loser { background: linear-gradient(90deg, rgba(80,0,0,0.04), rgba(120,0,0,0.02)); border-left:4px solid #e74c3c; }
    .gh-attack { margin-left:6px; display:inline-block; padding:2px 6px; background:rgba(255,255,255,0.04); border-radius:3px; text-decoration:none; color:inherit; border:1px solid rgba(255,255,255,0.03); }
    #gh-recent-winners { position:fixed; right:12px; top:80px; width:260px; max-height:320px; overflow:auto; background:rgba(0,0,0,0.6); padding:8px; border-radius:6px; z-index:99999; color:#fff; font-size:13px; }
    .gh-recent-entry { display:flex; justify-content:space-between; gap:8px; padding:6px; border-radius:4px; margin-bottom:6px; background:rgba(255,255,255,0.02); }
    .gh-recent-entry .name { font-weight:600; }
    #gh-modal { position:fixed; left:50%; top:50%; transform:translate(-50%,-50%); background:rgba(10,10,10,0.95); color:#fff; padding:14px; border-radius:8px; z-index:100000; width:720px; max-width:95%; box-shadow:0 8px 30px rgba(0,0,0,0.6); }
    .gh-row { display:flex; gap:8px; align-items:center; margin:6px 0; }
    .gh-row label { width:220px; font-size:13px; opacity:0.9; }
    .gh-row input[type="number"], .gh-row input[type="text"] { flex:1; padding:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.04); color:#fff; border-radius:4px; }
    .gh-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:10px; }
    #gh-debug-panel { position:fixed; left:12px; bottom:12px; width:420px; max-height:60vh; overflow:auto; background:rgba(0,0,0,0.7); color:#fff; padding:8px; border-radius:6px; z-index:99999; font-size:13px; display:none; }
    .gh-log-entry { padding:6px; border-bottom:1px solid rgba(255,255,255,0.03); margin-bottom:6px; }
    .gh-log-entry.debug { color:#9cf; }
    .gh-log-entry.info { color:#8f8; }
    .gh-log-entry.warn { color:#ffb86b; }
    .gh-log-entry.error { color:#ff7b7b; }
    `;
    GM_addStyle && GM_addStyle(css);
  } catch (e) { console.error("addStyles error", e); }
}

/* =========================
   Heuristic extraction (existing code)
   (kept unchanged except for minor safety guards)
*/
function heuristicExtractFFAndStats(container) {
  const meta = { sources: [] };
  try {
    if (!container) return { ff: NaN, stats: NaN, meta };
    let ff = NaN, stats = NaN;
    // 1) direct data attributes
    try {
      if (container.dataset) {
        if (container.dataset.ff) { ff = parseNumber(container.dataset.ff); meta.sources.push({ type: "data-ff", sample: container.dataset.ff }); }
        if (container.dataset.ffscouter) { ff = parseNumber(container.dataset.ffscouter); meta.sources.push({ type: "data-ffscouter", sample: container.dataset.ffscouter }); }
        if (container.dataset.stats) { stats = parseNumber(container.dataset.stats); meta.sources.push({ type: "data-stats", sample: container.dataset.stats }); }
      }
    } catch (e) { /* ignore */ }

    // 2) scan child nodes for known tokens
    try {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        try {
          const txt = (node.nodeType === Node.TEXT_NODE ? node.textContent : (node.textContent || "")).trim();
          if (!txt) continue;
          // FF patterns
          if (!isFinite(ff)) {
            const m = txt.match(/(?:FFscouter|FF)[:\s]*([0-9,\.kmKM]+)/i) || txt.match(/\b([0-9,\.kmKM]+)\s*FF\b/i);
            if (m) { ff = parseNumber(m[1] || m[0]); meta.sources.push({ type: "node-text", sample: (m[0]||"") }); }
          }
          // stats patterns
          if (!isFinite(stats)) {
            const m2 = txt.match(/(?:EST|estimate|stat(?:s)?)[:\s]*([0-9,\.kmKM]+)/i);
            if (m2) { stats = parseNumber(m2[1]); meta.sources.push({ type: "node-text", sample: (m2[0]||"") }); }
          }
          // quick exit if both found
          if (isFinite(ff) && isFinite(stats)) break;
        } catch (e) { /* ignore per-node errors */ }
      }
    } catch (e) { /* ignore walker errors */ }

    // 3) scan for elements with classes or attributes that might contain FF/stats
    try {
      const candidates = container.querySelectorAll('[class*="ff"], [class*="ffscouter"], [data-ff], [data-ffscouter], [class*="stat"], [data-stat], [data-stats]');
      for (const el of candidates) {
        if (!isFinite(ff)) {
          const t = (el.getAttribute('data-ff') || el.textContent || el.getAttribute('title') || "").trim();
          if (t) {
            const m = t.match(/([0-9,\.kmKM]+)/);
            if (m) { ff = parseNumber(m[1]); meta.sources.push({ type: "candidate-attr", sample: t }); }
          }
        }
        if (!isFinite(stats)) {
          const t2 = (el.getAttribute('data-stats') || el.textContent || el.getAttribute('title') || "").trim();
          if (t2) {
            const m2 = t2.match(/([0-9,\.kmKM]+)/);
            if (m2) { stats = parseNumber(m2[1]); meta.sources.push({ type: "candidate-attr", sample: t2 }); }
          }
        }
        if (isFinite(ff) && isFinite(stats)) break;
      }
    } catch (e) { /* ignore */ }

    // 4) inspect adjacent nodes (e.g., anchor siblings)
    try {
      const anchors = container.querySelectorAll('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]');
      for (const a of anchors) {
        if (!isFinite(ff)) {
          // check sibling text nodes and parent text
          const sibText = (a.nextSibling && a.nextSibling.textContent) ? a.nextSibling.textContent : "";
          const parentText = (a.parentElement && a.parentElement.textContent) ? a.parentElement.textContent : "";
          const combined = (sibText + " " + parentText).trim();
          const m = combined.match(/FF[:\s]*([0-9,\.kmKM]+)/i) || combined.match(/\b([0-9,\.kmKM]+)\s*FF\b/i);
          if (m) { ff = parseNumber(m[1] || m[0]); meta.sources.push({ type: "adjacent-text", sample: (m[0]||"") }); }
        }
        if (!isFinite(stats)) {
          const parentText = (a.parentElement && a.parentElement.textContent) ? a.parentElement.textContent : "";
          const m2 = parentText.match(/(?:EST|estimate|stat(?:s)?)[:\s]*([0-9,\.kmKM]+)/i);
          if (m2) { stats = parseNumber(m2[1]); meta.sources.push({ type: "adjacent-text", sample: (m2[0]||"") }); }
        }
        if (isFinite(ff) && isFinite(stats)) break;
      }
    } catch (e) { /* ignore */ }

    // 5) fallback regex scan over container text
    if (!isFinite(ff) || !isFinite(stats)) {
      const txt = container.textContent || "";
      if (!isFinite(ff)) {
        const m = txt.match(/FF[:\s]*([0-9,\.kmKM]+)/i) || txt.match(/FFscouter[:\s]*([0-9,\.kmKM]+)/i) || txt.match(/\b([0-9,\.kmKM]+)\s*FF\b/i);
        if (m) { ff = parseNumber(m[1] || m[0]); meta.sources.push({ type: "text-scan", sample: (m[0]||"") }); }
      }
      if (!isFinite(stats)) {
        const m2 = txt.match(/(?:EST|estimate|stat(?:s)?)[:\s]*([0-9,\.kmKM]+)/i);
        if (m2) { stats = parseNumber(m2[1]); meta.sources.push({ type: "text-scan", sample: (m2[0]||"") }); }
      }
    }

  } catch (e) {
    logError("heuristicExtractFFAndStats error", e);
  }
  return { ff: isFinite(ff) ? ff : NaN, stats: isFinite(stats) ? stats : NaN, meta };
}

/* =========================
   Pot / Bet extraction (improved)
*/
function findPotOrBetInRow(row) {
  try {
    if (!row) return NaN;
    const classNodes = row.querySelectorAll('[class*="pot"], [class*="bet"], [class*="wager"], [class*="amount"], [class*="value"], [class*="price"], [class*="stake"]');
    for (const el of classNodes) {
      const txt = (el.textContent || "").trim();
      const m = txt.match(/([0-9,\.]+[kmKM]?)/);
      if (m) return parseNumber(m[1]);
      if (el.dataset) {
        if (el.dataset.amount) return parseNumber(el.dataset.amount);
        if (el.dataset.value) return parseNumber(el.dataset.value);
      }
    }
    const text = row.textContent || "";
    const m2 = text.match(/(?:pot|bet|wager|stake|stakes|pot:|bet:)[^\d\-]*([0-9,\.kmKM]+)/i);
    if (m2) return parseNumber(m2[1]);
    const dataNodes = row.querySelectorAll('[data-amount], [data-value]');
    for (const el of dataNodes) {
      if (el.dataset.amount) {
        const n = parseNumber(el.dataset.amount);
        if (isFinite(n)) return n;
      }
      if (el.dataset.value) {
        const n = parseNumber(el.dataset.value);
        if (isFinite(n)) return n;
      }
    }
    const allNums = Array.from((text.match(/([0-9,\.]+[kmKM]?)/g) || [])).map(parseNumber).filter(isFinite);
    if (allNums.length) return Math.max(...allNums);
  } catch (e) {
    logError("findPotOrBetInRow error", e);
  }
  return NaN;
}

/* =========================
   Filtering & state management
*/
const rowState = new WeakMap();
const userHealthCheckCache = {};
const recentWinners = [];

function applyFilterToRow(row, meta, passes) {
  if (!row) return;
  try {
    row.classList.remove("gh-winner", "gh-loser", "gh-hidden");
    const old = row.querySelector(".gh-attack"); if (old) old.remove();
    if (!passes) { row.classList.add("gh-hidden"); row.dataset.ghPass = "0"; } else { row.classList.remove("gh-hidden"); row.dataset.ghPass = "1"; }
    rowState.set(row, Object.assign(rowState.get(row) || {}, { lastFilterCheck: Date.now(), meta }));
  } catch (e) { logError("applyFilterToRow error", e); }
}

function applyAllFilters() {
  try {
    const rows = getLobbyRows();
    rows.forEach(row => {
      const anchor = row.querySelector('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]');
      const displayName = anchor ? getDisplayNameFromAnchor(anchor) : "Unknown";
      const uid = anchor ? extractUserIdFromHref(anchor.getAttribute("href") || "") : null;
      const heur = heuristicExtractFFAndStats(row);
      const pot = findPotOrBetInRow(row);
      let passFF = true;
      if (isFinite(heur.ff)) passFF = heur.ff >= settings.minFF && heur.ff <= settings.maxFF; else passFF = settings.requireKnownFF ? false : true;
      let passStat = true; if (isFinite(heur.stats)) passStat = heur.stats >= settings.minStat && heur.stats <= settings.maxStat;
      let passBet = true; if (isFinite(pot)) passBet = pot >= settings.minBet; else passBet = settings.minBet > 0 ? false : true;
      const passes = passFF && passStat && passBet;
      applyFilterToRow(row, { uid, displayName, ff: heur.ff, stats: heur.stats, pot }, passes);
    });
    updateMonitorUI();
  } catch (e) { logError("applyAllFilters error", e); }
}

function updateMonitorUI() {
  try {
    const toggle = document.getElementById("gh-monitor-toggle");
    if (toggle) { if (settings.monitorOn) { toggle.classList.add("gh-toggle-active"); toggle.textContent = "Monitor: ON (showing valid targets)"; } else { toggle.classList.remove("gh-toggle-active"); toggle.textContent = "Monitor Filtered Targets"; } }
    const rows = getLobbyRows();
    rows.forEach(row => {
      const pass = row.dataset && row.dataset.ghPass === "1";
      if (settings.monitorOn) row.style.display = pass ? "" : "none"; else row.style.display = "";
    });
  } catch (e) { logError("updateMonitorUI error", e); }
}

/* =========================
   Outcome detection + attack injection
*/
function detectGameOutcomeForRow(row) {
  if (!row) return null;
  try {
    const text = (row.textContent || "").toLowerCase();
    if (/sent to hospital|sent to the hospital|hospital|skull|dead|died|0 hp|0 health|hp: 0|health: 0/.test(text)) return "lost";
    if (/(won|winner|collected|survived|took the pot|won \$|won m|won k)/.test(text)) return "won";
    const imgs = row.querySelectorAll("img");
    for (const img of imgs) {
      const alt = (img.alt || "").toLowerCase();
      const title = (img.title || "").toLowerCase();
      if (/(hospital|skull|dead)/.test(alt + " " + title)) return "lost";
      if (/(winner|won|collected|took the pot)/.test(alt + " " + title)) return "won";
    }
  } catch (e) { logError("detectGameOutcomeForRow error", e); }
  return null;
}

function makeProfileOrAttackLink(uid) { return `https://www.torn.com/profiles.php?XID=${encodeURIComponent(uid)}`; }

function markAsLoser(row, uid, name) {
  if (!row) return;
  try {
    row.classList.remove("gh-winner"); row.classList.add("gh-loser");
    const btn = row.querySelector(".gh-attack"); if (btn) btn.remove();
    row.classList.add("gh-hidden");
    rowState.set(row, Object.assign(rowState.get(row) || {}, { outcome: "lost", outcomeAt: Date.now() }));
    logInfo(`Marked loser: ${name || uid}`, { uid, name });
  } catch (e) { logError("markAsLoser error", e); }
}

function markAsWinner(row, uid, name) {
  if (!row) return;
  try {
    row.classList.remove("gh-loser"); row.classList.add("gh-winner"); row.classList.remove("gh-hidden");
    if (!row.querySelector(".gh-attack")) {
      const link = document.createElement("a"); link.className = "gh-attack"; link.setAttribute("title", "Open profile / attack page (manual action only)");
      link.href = uid ? makeProfileOrAttackLink(uid) : "#"; link.target = "_blank"; link.rel = "noopener noreferrer";
      link.innerHTML = '<span class="gh-crosshair" aria-hidden="true"></span><span style="font-size:12px;color:inherit;">ATTACK</span>';
      const anchor = row.querySelector('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]');
      if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(link, anchor.nextSibling); else row.appendChild(link);
    }
    addRecentWinner({ id: uid, name: name || (row.querySelector('a') ? getDisplayNameFromAnchor(row.querySelector('a')) : "Unknown"), link: makeProfileOrAttackLink(uid) });
    rowState.set(row, Object.assign(rowState.get(row) || {}, { outcome: "won", outcomeAt: Date.now() }));
    logInfo(`Marked winner: ${name || uid}`, { uid, name });
  } catch (e) { logError("markAsWinner error", e); }
}

/* recent winners panel */
function ensureRecentWinnersPanel() {
  let panel = document.getElementById("gh-recent-winners");
  if (!panel) {
    panel = document.createElement("div"); panel.id = "gh-recent-winners"; panel.innerHTML = `<h4>Recent Winners (60s)</h4><div id="gh-recent-list"></div>`; document.body.appendChild(panel);
  }
  panel.style.display = "";
}

function addRecentWinner({ id, name, link }) {
  ensureRecentWinnersPanel();
  try {
    const entry = document.createElement("div"); entry.className = "gh-recent-entry gh-winner"; entry.setAttribute("data-uid", id);
    const left = document.createElement("div"); left.innerHTML = `<div class="name">${escapeHtml(name)}</div><div class="when">just now</div>`;
    const right = document.createElement("div");
    const a = document.createElement("a"); a.href = link || "#"; a.target = "_blank"; a.rel = "noopener noreferrer"; a.className = "gh-attack";
    a.innerHTML = '<span class="gh-crosshair" title="Open profile / attack (manual)"></span>';
    right.appendChild(a); entry.appendChild(left); entry.appendChild(right);
    const list = document.getElementById("gh-recent-list"); if (list) list.insertBefore(entry, list.firstChild);
    const created = Date.now(); recentWinners.push({ id, name, created, node: entry });
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - created) / 1000);
      const when = entry.querySelector(".when"); if (when) when.textContent = `${elapsed}s ago`;
      if (elapsed >= 60) { clearInterval(interval); entry.remove(); const idx = recentWinners.findIndex(r => r.id === id && r.created === created); if (idx >= 0) recentWinners.splice(idx, 1); }
    }, 1000);
  } catch (e) { logError("addRecentWinner error", e); }
}

/* =========================
   Observers & periodic monitor
*/
let observer = null;
let scanThrottleTimer = null;
const SCAN_DEBOUNCE_MS = 600;

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
  logDebug("MutationObserver started");
}

function detectOutcomesFromMutations(mutations) {
  try {
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
          if (outcome === "lost") markAsLoser(row, uid, getDisplayNameFromAnchor(a));
          else if (outcome === "won") markAsWinner(row, uid, getDisplayNameFromAnchor(a));
          else if (settings.apiKey && uid) scheduleUserHealthCheck(uid, row, getDisplayNameFromAnchor(a));
        });
      });

      const t = m.target;
      if (t && t.nodeType === Node.ELEMENT_NODE) {
        const anchors = findProfileAnchorsInRegion(t);
        anchors.forEach(a => {
          const uid = extractUserIdFromHref(a.getAttribute("href") || "");
          const row = findRowForAnchor(a);
          if (!row) return;
          const outcome = detectGameOutcomeForRow(row);
          if (outcome === "lost") markAsLoser(row, uid, getDisplayNameFromAnchor(a));
          else if (outcome === "won") markAsWinner(row, uid, getDisplayNameFromAnchor(a));
        });
      }
    }
  } catch (e) { logError("detectOutcomesFromMutations error", e); }
}

function findRowForAnchor(a) {
  const rows = getLobbyRows();
  for (const row of rows) if (row.contains(a)) return row;
  let el = a;
  for (let i = 0; i < 8 && el && el !== document.body; i++) { if (rows.includes(el)) return el; el = el.parentElement; }
  return a.parentElement;
}

let periodicMonitorInterval = null;
function startPeriodicMonitor() {
  if (periodicMonitorInterval) return;
  periodicMonitorInterval = setInterval(() => {
    try {
      const rows = getLobbyRows();
      rows.forEach(row => {
        const st = rowState.get(row) || {};
        if (st.outcome && Date.now() - (st.outcomeAt || 0) < 10_000) return;
        const outcome = detectGameOutcomeForRow(row);
        const anchor = row.querySelector('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]');
        const uid = anchor ? extractUserIdFromHref(anchor.getAttribute("href") || "") : null;
        const name = anchor ? getDisplayNameFromAnchor(anchor) : "Unknown";
        if (outcome === "lost") markAsLoser(row, uid, name);
        if (outcome === "won") markAsWinner(row, uid, name);
        if ((!outcome || outcome === null) && settings.apiKey && uid) scheduleUserHealthCheck(uid, row, name);
      });
    } catch (e) { logError("periodic monitor error", e); }
  }, 2000);
  logDebug("Periodic monitor started");
}

/* =========================
   Torn API checks (optional, cached)
*/
function scheduleUserHealthCheck(uid, row, name) {
  if (!settings.apiKey || !uid) return;
  const key = String(uid);
  const now = Date.now();
  const last = userHealthCheckCache[key];
  if (last && now - (last.lastChecked || 0) < 8000) return;
  userHealthCheckCache[key] = { lastChecked: now };
  const apiUrl = `https://api.torn.com/user/?selections=profile&id=${encodeURIComponent(uid)}&key=${encodeURIComponent(settings.apiKey)}`;
  logDebug(`Torn API check for uid ${uid}`);
  GM_xmlhttpRequest({
    method: "GET",
    url: apiUrl,
    timeout: 10000,
    onload(resp) {
      try {
        if (resp.status >= 200 && resp.status < 400) {
          const data = JSON.parse(resp.responseText || "{}");
          if (data.error) { logWarn("Torn API error", data.error); userHealthCheckCache[key] = { lastChecked: now, status: "error" }; return; }
          let percent = NaN;
          if (data.profile && data.profile.health) {
            if (typeof data.profile.health.percent !== "undefined") percent = Number(data.profile.health.percent);
            else if (typeof data.profile.health_percent !== "undefined") percent = Number(data.profile.health_percent);
          } else if (data.health && typeof data.health.percent !== "undefined") percent = Number(data.health.percent);
          userHealthCheckCache[key] = { lastChecked: now, status: "ok", healthPercent: percent };
          if (isFinite(percent)) {
            if (percent <= 0.5) markAsLoser(row, uid, name); else markAsWinner(row, uid, name);
          } else {
            const outcome = detectGameOutcomeForRow(row);
            if (outcome === "lost") markAsLoser(row, uid, name);
            if (outcome === "won") markAsWinner(row, uid, name);
          }
        } else { logWarn("Torn API non-200", { status: resp.status }); userHealthCheckCache[key] = { lastChecked: now, status: "error" }; }
      } catch (err) { logError("Torn API parse error", err); userHealthCheckCache[key] = { lastChecked: now, status: "error" }; }
    },
    onerror(err) { logError("Torn API network error", err); userHealthCheckCache[key] = { lastChecked: now, status: "error" }; }
  });
}

/* =========================
   Settings modal + Test Extraction (include full innerHTML)
*/
function tryInsertTopButtons() {
  const textMatches = ["Last Games", "Statistics", "Back to Casino"];
  let container = null;
  const possibleSelectors = ['.submenu', '.subtabs', '.page-tabs', '.tabBar', '.contentHeader', '.header-links', '.breadcrumbs'];
  for (const sel of possibleSelectors) {
    const el = document.querySelector(sel);
    if (el && /russian/i.test(document.title + (document.querySelector("h1") ? document.querySelector("h1").textContent : ""))) { container = el; break; }
  }
  if (!container) {
    const anchors = Array.from(document.querySelectorAll("a, button"));
    for (const a of anchors) if (textMatches.some(t => (a.textContent || "").trim().includes(t))) { container = a.parentElement || a.closest("div") || document.body; break; }
  }
  if (!container) container = document.querySelector("#content") || document.body;
  if (document.getElementById("gh-top-btns")) return;

  const wrapper = document.createElement("div"); wrapper.style.display = "inline-block"; wrapper.style.marginRight = "8px"; wrapper.id = "gh-top-btns";
  const settingsBtn = document.createElement("button"); settingsBtn.className = "gh-btn"; settingsBtn.textContent = "Game Hunting Settings"; settingsBtn.title = "Open Game Hunting settings"; settingsBtn.onclick = openSettingsModal;
  const monitorToggle = document.createElement("button"); monitorToggle.className = "gh-btn"; monitorToggle.id = "gh-monitor-toggle"; monitorToggle.textContent = "Monitor Filtered Targets"; monitorToggle.title = "Toggle visual monitor for filtered targets";
  monitorToggle.onclick = () => { settings.monitorOn = !settings.monitorOn; saveSettings(settings); updateMonitorUI(); applyAllFilters(); };
  wrapper.appendChild(settingsBtn); wrapper.appendChild(monitorToggle);
  try { container.insertBefore(wrapper, container.firstChild); } catch (e) { (container.parentElement || document.body).insertBefore(wrapper, container); }
}

function openSettingsModal() {
  if (document.getElementById("gh-modal")) return;
  const modal = document.createElement("div"); modal.className = "gh-modal"; modal.id = "gh-modal"; modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
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
    <div class="gh-row"><label>Enable Debug Logs</label><input id="gh-debug-enabled" type="checkbox" /></div>
    <div class="gh-row"><label>Test Extraction Count (top rows)</label><input id="gh-test-count" type="number" min="1" max="50" step="1" /></div>
    <div class="gh-row"><label>Include full row HTML in test</label><input id="gh-include-html" type="checkbox" /></div>
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="gh-btn" id="gh-run-test">Run Test Extraction</button>
      <button class="gh-btn" id="gh-copy-logs">Copy Logs to Clipboard</button>
      <button class="gh-btn" id="gh-toggle-debug-panel">Toggle Debug Panel</button>
    </div>
    <div class="gh-actions">
      <button class="gh-btn" id="gh-reset">Reset Defaults</button>
      <button class="gh-btn gh-primary" id="gh-save">Save</button>
      <button class="gh-btn" id="gh-close">Close</button>
    </div>
    <div id="gh-test-output" style="margin-top:10px; max-height:340px; overflow:auto; background:rgba(255,255,255,0.02); padding:6px; border-radius:6px; font-size:12px;"></div>
    <div style="font-size:12px;opacity:0.9;margin-top:10px;">
      Note: purely visual monitoring. Optional Torn API key is stored locally. No automated attacks.
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById("gh-min-ff").value = settings.minFF;
  document.getElementById("gh-max-ff").value = settings.maxFF;
  document.getElementById("gh-min-stat").value = settings.minStat;
  document.getElementById("gh-max-stat").value = settings.maxStat;
  document.getElementById("gh-min-bet").value = settings.minBet;
  document.getElementById("gh-api-key").value = settings.apiKey || "";
  document.getElementById("gh-monitor-on").checked = settings.monitorOn;
  document.getElementById("gh-require-known-ff").checked = settings.requireKnownFF;
  document.getElementById("gh-debug-enabled").checked = settings.debugEnabled;
  document.getElementById("gh-test-count").value = settings.testExtractionCount;
  document.getElementById("gh-include-html").checked = settings.includeFullRowHTML;

  document.getElementById("gh-save").onclick = () => {
    settings.minFF = Number(document.getElementById("gh-min-ff").value || DEFAULTS.minFF);
    settings.maxFF = Number(document.getElementById("gh-max-ff").value || DEFAULTS.maxFF);
    settings.minStat = Number(document.getElementById("gh-min-stat").value || DEFAULTS.minStat);
    settings.maxStat = Number(document.getElementById("gh-max-stat").value || DEFAULTS.maxStat);
    settings.minBet = Number(document.getElementById("gh-min-bet").value || DEFAULTS.minBet);
    settings.apiKey = String(document.getElementById("gh-api-key").value || "");
    settings.monitorOn = Boolean(document.getElementById("gh-monitor-on").checked);
    settings.requireKnownFF = Boolean(document.getElementById("gh-require-known-ff").checked);
    settings.debugEnabled = Boolean(document.getElementById("gh-debug-enabled").checked);
    settings.testExtractionCount = Number(document.getElementById("gh-test-count").value || DEFAULTS.testExtractionCount);
    settings.includeFullRowHTML = Boolean(document.getElementById("gh-include-html").checked);
    saveSettings(settings); updateMonitorUI(); applyAllFilters(); logInfo("Settings saved", settings); closeSettingsModal();
  };

  document.getElementById("gh-reset").onclick = () => {
    settings = Object.assign({}, DEFAULTS); saveSettings(settings);
    document.getElementById("gh-min-ff").value = settings.minFF; document.getElementById("gh-max-ff").value = settings.maxFF;
    document.getElementById("gh-min-stat").value = settings.minStat; document.getElementById("gh-max-stat").value = settings.maxStat;
    document.getElementById("gh-min-bet").value = settings.minBet; document.getElementById("gh-api-key").value = "";
    document.getElementById("gh-monitor-on").checked = settings.monitorOn; document.getElementById("gh-require-known-ff").checked = settings.requireKnownFF;
    document.getElementById("gh-debug-enabled").checked = settings.debugEnabled; document.getElementById("gh-test-count").value = settings.testExtractionCount;
    document.getElementById("gh-include-html").checked = settings.includeFullRowHTML;
    applyAllFilters(); logInfo("Settings reset to defaults");
  };

  document.getElementById("gh-close").onclick = closeSettingsModal;
  document.getElementById("gh-run-test").onclick = () => runTestExtraction();
  document.getElementById("gh-copy-logs").onclick = () => copyLogsToClipboard();
  document.getElementById("gh-toggle-debug-panel").onclick = () => toggleDebugPanel();
}

function closeSettingsModal() { const m = document.getElementById("gh-modal"); if (m) m.remove(); }

/* Test Extraction now can include full row.innerHTML when checkbox is enabled */
function runTestExtraction() {
  const out = document.getElementById("gh-test-output");
  if (!out) return;
  out.innerHTML = "<div>Running extraction...</div>";
  try {
    const count = Number(document.getElementById("gh-test-count").value || settings.testExtractionCount || 8);
    const includeHTML = Boolean(document.getElementById("gh-include-html").checked);
    const rows = getLobbyRows().slice(0, count);
    if (!rows.length) { out.innerHTML = "<div>No rows found on the page. Make sure the lobby is visible.</div>"; return; }
    const lines = [];
    lines.push(`<div style="font-weight:600;margin-bottom:6px;">Top ${rows.length} rows extraction</div>`);
    rows.forEach((row, idx) => {
      const anchor = row.querySelector('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]');
      const anchorText = anchor ? (anchor.textContent||"").trim() : "";
      const displayName = anchor ? getDisplayNameFromAnchor(anchor) : "Unknown";
      const anchorAttrs = anchor ? {
        title: anchor.getAttribute("title") || "",
        aria: anchor.getAttribute("aria-label") || "",
        dataName: anchor.getAttribute("data-player-name") || anchor.getAttribute("data-name") || ""
      } : {};
      const uid = anchor ? extractUserIdFromHref(anchor.getAttribute("href") || "") : null;
      const heur = heuristicExtractFFAndStats(row);
      const pot = findPotOrBetInRow(row);
      const snippet = (row.textContent || "").trim().replace(/\s+/g," ").slice(0,200);
      const passFF = isFinite(heur.ff) ? (heur.ff >= settings.minFF && heur.ff <= settings.maxFF) : (settings.requireKnownFF ? false : true);
      const passStat = isFinite(heur.stats) ? (heur.stats >= settings.minStat && heur.stats <= settings.maxStat) : true;
      const passBet = isFinite(pot) ? (pot >= settings.minBet) : (settings.minBet>0?false:true);
      const passes = passFF && passStat && passBet;
      lines.push(`<div style="padding:6px;border-radius:4px;margin-bottom:6px;background:rgba(255,255,255,0.02)">
        <div style="font-weight:600">${idx+1}. ${escapeHtml(displayName)} ${uid?`(XID:${uid})`:""}</div>
        <div style="font-size:12px;margin-top:4px;">anchorText: "${escapeHtml(anchorText)}" anchorAttrs: ${escapeHtml(JSON.stringify(anchorAttrs))}</div>
        <div style="font-size:12px;margin-top:4px;">row snippet: <code style="background:rgba(0,0,0,0.3);padding:2px 4px;border-radius:3px;">${escapeHtml(snippet)}</code></div>
        <div style="font-size:12px;margin-top:4px;">FF: ${isFinite(heur.ff)?heur.ff:"unknown"}; Stats: ${isFinite(heur.stats)?heur.stats:"unknown"}; Pot: ${isFinite(pot)?pot:"unknown"}</div>
        <div style="font-size:12px;margin-top:4px;">Heuristic sources: ${escapeHtml(JSON.stringify(heur.meta && heur.meta.sources ? heur.meta.sources.slice(0,6) : []))}</div>
        <div style="font-size:12px;margin-top:4px;">Passes filters: ${passes ? "<span style='color:#6f6'>YES</span>" : "<span style='color:#f66'>NO</span>"}</div>` +
        (includeHTML ? `<div style="margin-top:6px;font-size:11px;color:#ddd;background:rgba(0,0,0,0.2);padding:6px;border-radius:4px;"><summary style="font-weight:600">row.innerHTML</summary><pre style="white-space:pre-wrap;max-height:120px;overflow:auto;">${escapeHtml(row.innerHTML)}</pre></div>` : "")
        + `</div>`);
      logDebug("TestExtraction row", { index: idx+1, displayName, uid, anchorText, anchorAttrs, ff: heur.ff, stats: heur.stats, pot, snippet, sources: heur.meta.sources });
    });
    out.innerHTML = lines.join("");
    logInfo("Test extraction ran", { count: rows.length, includeHTML });
  } catch (e) {
    out.innerHTML = `<div style="color:#f88">Error running extraction: ${escapeHtml(String(e))}</div>`;
    logError("runTestExtraction error", e);
  }
}

/* copy logs & debug panel */
function copyLogsToClipboard() {
  try {
    const toCopy = logBuffer.map(l => `${new Date(l.ts).toISOString()} [${l.level.toUpperCase()}] ${l.msg} ${l.meta ? JSON.stringify(l.meta) : ""}`).join("\n");
    navigator.clipboard && navigator.clipboard.writeText(toCopy);
    logInfo("Logs copied to clipboard");
    alert("Logs copied to clipboard (if allowed).");
  } catch (e) { logError("copyLogsToClipboard error", e); alert("Failed to copy logs - check console."); }
}

function ensureDebugPanel() {
  let panel = document.getElementById("gh-debug-panel");
  if (!panel) {
    panel = document.createElement("div"); panel.id = "gh-debug-panel"; panel.innerHTML = `<h4>GameHunt Debug Panel</h4><div id="gh-debug-list"></div><div style="display:flex;gap:6px;margin-top:6px;"><button id="gh-debug-clear" class="gh-btn">Clear</button><button id="gh-debug-close" class="gh-btn">Close</button></div>`;
    document.body.appendChild(panel); document.getElementById("gh-debug-clear").onclick = () => { logBuffer.length = 0; updateDebugPanel(); }; document.getElementById("gh-debug-close").onclick = () => { panel.style.display = "none"; };
  }
  panel.style.display = settings.debugEnabled ? "" : "none";
  updateDebugPanel();
}
function updateDebugPanel() {
  const panel = document.getElementById("gh-debug-panel"); if (!panel) return;
  const list = document.getElementById("gh-debug-list"); if (!list) return;
  list.innerHTML = "";
  const entries = logBuffer.slice().reverse().slice(0,150);
  for (const e of entries) {
    const div = document.createElement("div"); div.className = `gh-log-entry ${e.level}`; div.innerHTML = `<div style="font-size:11px;color:rgba(255,255,255,0.7)">${new Date(e.ts).toLocaleTimeString()} [${e.level.toUpperCase()}]</div><div>${escapeHtml(e.msg)}</div><div style="font-size:11px;opacity:0.8">${e.meta ? escapeHtml(JSON.stringify(e.meta)) : ""}</div>`; list.appendChild(div);
  }
}

/* toggle debug panel from settings */
function toggleDebugPanel() {
  settings.debugEnabled = !settings.debugEnabled;
  saveSettings(settings);
  ensureDebugPanel();
  logInfo("Debug panel toggled", { enabled: settings.debugEnabled });
}

/* =========================
   Initialization
*/
function initialScanAndBootstrap() {
  addStyles(); tryInsertTopButtons(); ensureRecentWinnersPanel(); updateMonitorUI(); applyAllFilters(); startObservers(); startPeriodicMonitor(); ensureDebugPanel();
  try { GM_registerMenuCommand && GM_registerMenuCommand("Game Hunting Settings", openSettingsModal); } catch (e) {}
  logInfo("Game Hunting script initialized", { settings });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialScanAndBootstrap); else initialScanAndBootstrap();

/* End of Script */
