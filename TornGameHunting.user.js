// ==UserScript==
// @name         Torn Game Hunting - Russian Roulette Monitor & Filter (FFScouter aware)
// @namespace    https://www.torn.com/
// @version      1.2.0
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
  Version 1.2.0 - Fixes + Test Extraction + Debug Logging
  - Addresses user reports where player names appeared blank.
  - Adds a "Test Extraction" tool in the settings to inspect parsed FF/Stats/Pot for top N rows.
  - Adds debugging toggles, in-memory log buffer, and an on-screen Debug Panel.
  - Keeps ALL prior functionality (filters, monitor toggle, API checks, Recent Winners).
  - Styling changed to avoid overriding Torn's text colors (only decorations/backgrounds applied).
*/

/* ----------------------
   Adversarial Plan Summary
   ----------------------
   1) Preserve existing UI & behavior.
   2) Prevent our CSS from overriding Torn's text color (fixing 'blank names').
   3) Provide Test Extraction feature to display parsing results for top N rows.
   4) Add debug logging (console + in-app debug panel) and persist debug toggle.
   5) Keep API use minimal, cached, and compliant with attached codex.
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
  testExtractionCount: 8
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
    testExtractionCount: Number(GM_getValue("gh_testExtractionCount", DEFAULTS.testExtractionCount))
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
}

let settings = loadSettings();

/* =========================
   Debug Logging Utilities
   ========================= */
const LOG_BUFFER_MAX = 200;
const logBuffer = [];

function pushLog(level, msg, meta) {
  const entry = { ts: Date.now(), level, msg: String(msg), meta: meta || null };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  // Console output when debugEnabled
  if (settings.debugEnabled) {
    const t = new Date(entry.ts).toISOString();
    if (level === "error") console.error(`[GH ${t}] ${msg}`, meta || "");
    else if (level === "warn") console.warn(`[GH ${t}] ${msg}`, meta || "");
    else if (level === "info") console.info(`[GH ${t}] ${msg}`, meta || "");
    else console.log(`[GH ${t}] ${msg}`, meta || "");
  }
  // update debug panel if visible
  updateDebugPanel();
}

function logDebug(msg, meta) { pushLog("debug", msg, meta); }
function logInfo(msg, meta) { pushLog("info", msg, meta); }
function logWarn(msg, meta) { pushLog("warn", msg, meta); }
function logError(msg, meta) { pushLog("error", msg, meta); }

/* =========================
   Utilities
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
   Styles (avoid overriding Torn text colors)
   ========================= */
function addStyles() {
  GM_addStyle(`
    /* Buttons */
    .gh-btn { display:inline-block; margin-right:8px; padding:6px 9px; border-radius:3px; cursor:pointer; background:rgba(0,0,0,0.12); color:inherit; border:1px solid rgba(255,255,255,0.06); font-size:13px; }
    .gh-btn.gh-primary { background:linear-gradient(180deg,#2ecc71,#27ae60); color:inherit; border-color:rgba(0,0,0,0.2); font-weight:600; }
    .gh-btn.gh-toggle-active { box-shadow:0 0 0 2px rgba(39,174,96,0.12) inset; }

    /* Modal */
    .gh-modal { position:fixed; z-index:999999; left:50%; top:50%; transform:translate(-50%,-50%); width:540px; max-width:96%; background:rgba(20,20,20,0.96); color:var(--text-color, #fff); border-radius:8px; padding:14px; box-shadow:0 8px 30px rgba(0,0,0,0.6); font-family:Arial, sans-serif; font-size:13px; }
    .gh-modal h2 { margin:0 0 8px 0; font-size:16px; }
    .gh-row { display:flex; gap:8px; align-items:center; margin:8px 0; }
    .gh-row label { width:170px; font-size:13px; opacity:0.95; }
    .gh-row input[type="number"], .gh-row input[type="text"] { flex:1; padding:6px; border-radius:4px; border:1px solid rgba(255,255,255,0.06); background:rgba(0,0,0,0.35); color:var(--text-color,#fff); }
    .gh-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:12px; }

    /* Row decorations - only background / border; DO NOT change text color */
    .gh-winner { background: linear-gradient(90deg, rgba(40,140,60,0.06), rgba(80,180,80,0.03)); border-left:3px solid #2ecc71; }
    .gh-loser { background: linear-gradient(90deg, rgba(140,40,40,0.04), rgba(180,80,80,0.03)); border-left:3px solid #e74c3c; text-decoration:line-through; }
    .gh-hidden { opacity:0.28 !important; filter:grayscale(60%); }

    .gh-attack { margin-left:8px; color:inherit; background:transparent; border:none; cursor:pointer; font-size:12px; vertical-align:middle; text-decoration:none; display:inline-flex; align-items:center; gap:6px; }
    .gh-attack .gh-crosshair { width:16px; height:16px; border:2px solid rgba(255,255,255,0.85); border-radius:50%; box-sizing:border-box; }

    /* Recent Winners */
    #gh-recent-winners { position:fixed; right:12px; top:120px; z-index:999998; width:240px; background:rgba(10,10,10,0.5); padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.04); color:var(--text-color,#fff); max-height:60vh; overflow:auto; font-size:13px; }
    #gh-recent-winners h4{ margin:4px 0 8px 0; font-size:13px; }
    .gh-recent-entry { display:flex; align-items:center; justify-content:space-between; padding:6px 8px; border-radius:5px; margin-bottom:6px; background:rgba(0,0,0,0.25); }

    /* Debug panel */
    #gh-debug-panel { position:fixed; left:12px; bottom:12px; z-index:999999; width:420px; max-height:50vh; overflow:auto; background:rgba(0,0,0,0.7); padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.06); color:var(--text-color,#fff); font-size:12px; display:none; }
    #gh-debug-panel h4 { margin: 0 0 6px 0; font-size:13px; }
    .gh-log-entry { padding:4px 6px; border-radius:4px; margin-bottom:4px; }
    .gh-log-entry.debug { background: rgba(255,255,255,0.02); }
    .gh-log-entry.info { background: rgba(39,174,96,0.04); }
    .gh-log-entry.warn { background: rgba(241,196,15,0.04); }
    .gh-log-entry.error { background: rgba(192,57,43,0.06); color:#fdd; }
  `);
}

/* =========================
   DOM discovery & parsing
   ========================= */

function findProfileAnchorsInRegion(root = document) {
  try {
    return Array.from(root.querySelectorAll('a[href*="profiles.php"], a[href*="profile.php"], a[href*="XID="], a[href*="profile"]'));
  } catch (e) {
    logError("findProfileAnchorsInRegion error", e);
    return [];
  }
}

function extractUserIdFromHref(href = "") {
  if (!href) return null;
  try {
    const url = new URL(href, window.location.origin);
    if (url.searchParams.has("XID")) return url.searchParams.get("XID");
    if (url.searchParams.has("id")) return url.searchParams.get("id");
  } catch (e) {
    // ignore - fallback regex
  }
  const m = href.match(/XID=(\d+)/i) || href.match(/profiles\.php\?(\d+)/i) || href.match(/profile\.php\?XID=(\d+)/i) || href.match(/profile\/(\d+)/i);
  return m ? m[1] : (href.match(/(\d{4,12})/) ? href.match(/(\d{4,12})/)[1] : null);
}

/**
 * getLobbyRows - finds likely game rows. Returns deduplicated array of elements.
 */
function getLobbyRows() {
  const anchors = findProfileAnchorsInRegion(document);
  const rows = new Set();
  anchors.forEach(a => {
    if (!document.body.contains(a)) return;
    let el = a;
    let found = null;
    for (let depth = 0; depth < 12 && el && el !== document.body; depth++) {
      const text = (el.textContent || "").toLowerCase();
      const profileAnchors = el.querySelectorAll ? el.querySelectorAll('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]') : [];
      const hasNum = /[\d,.]+[km]?/.test(text);
      if ((profileAnchors && profileAnchors.length >= 1 && hasNum) || (profileAnchors && profileAnchors.length >= 2) || /bet|pot|wager|stakes|playing|players|winner/i.test(text)) {
        found = el;
        break;
      }
      el = el.parentElement;
    }
    if (!found) {
      const p = a.closest("li, tr, div") || a.parentElement;
      found = p;
    }
    if (found) rows.add(found);
  });
  return Array.from(rows);
}

/* Heuristics for FF and Stats */
function heuristicExtractFFAndStats(container) {
  let ff = NaN, stats = NaN;
  try {
    if (!container) return { ff: NaN, stats: NaN };

    // 1) dataset attributes in subtree
    const all = Array.from(container.querySelectorAll('*'));
    for (const el of all) {
      if (el.dataset) {
        if (!isFinite(ff) && (el.dataset.ff || el.dataset.ffscore || el.dataset.ffScouter)) {
          ff = parseNumber(el.dataset.ff || el.dataset.ffscore || el.dataset.ffScouter);
        }
        if (!isFinite(stats) && (el.dataset.stats || el.dataset.stat || el.dataset.statestimate)) {
          stats = parseNumber(el.dataset.stats || el.dataset.stat || el.dataset.statestimate);
        }
      }
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
      if (isFinite(ff) && isFinite(stats)) break;
    }

    // 2) check close neighbors around profile anchors inside container
    if ((!isFinite(ff) || !isFinite(stats))) {
      const anchors = container.querySelectorAll('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]');
      for (const a of anchors) {
        let sib = a.nextElementSibling, steps = 0;
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
          sib = sib.nextElementSibling; steps++;
        }
        // previous
        sib = a.previousElementSibling; steps = 0;
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
          sib = sib.previousElementSibling; steps++;
        }
        if (isFinite(ff) && isFinite(stats)) break;
      }
    }

    // 3) fallback text scan
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
  } catch (e) {
    logError("heuristicExtractFFAndStats error", e);
  }
  return { ff: isFinite(ff) ? ff : NaN, stats: isFinite(stats) ? stats : NaN };
}

function findPotOrBetInRow(row) {
  try {
    if (!row) return NaN;
    const text = row.textContent || "";
    const m = text.match(/(?:pot|bet|wager|stakes|stake)[:\s]*\$?([0-9,\.kmKM]+)/i);
    if (m) return parseNumber(m[1]);
    // fallback: largest number in row
    const nums = Array.from((text.match(/([0-9,\.]+[kmKM]?)/g) || [])).map(parseNumber).filter(isFinite);
    if (nums.length) return Math.max(...nums);
  } catch (e) {
    logError("findPotOrBetInRow error", e);
  }
  return NaN;
}

/* =========================
   Filtering & Monitoring
   ========================= */

const rowState = new WeakMap(); // store meta: { lastFilterCheck, outcome, outcomeAt }
const userHealthCheckCache = {}; // uid -> { lastChecked, status, healthPercent }

function applyFilterToRow(row, meta, passes) {
  if (!row) return;
  try {
    row.classList.remove("gh-winner", "gh-loser", "gh-hidden");
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
  } catch (e) {
    logError("applyFilterToRow error", e);
  }
}

function applyAllFilters() {
  try {
    const rows = getLobbyRows();
    rows.forEach(row => {
      const anchor = row.querySelector('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]');
      const name = anchor ? (anchor.textContent || "").trim() : "Unknown";
      const uid = anchor ? extractUserIdFromHref(anchor.getAttribute("href") || "") : null;

      const heur = heuristicExtractFFAndStats(row);
      const pot = findPotOrBetInRow(row);

      let passFF = true;
      if (isFinite(heur.ff)) {
        passFF = heur.ff >= settings.minFF && heur.ff <= settings.maxFF;
      } else {
        passFF = settings.requireKnownFF ? false : true;
      }

      let passStat = true;
      if (isFinite(heur.stats)) {
        passStat = heur.stats >= settings.minStat && heur.stats <= settings.maxStat;
      }

      let passBet = true;
      if (isFinite(pot)) {
        passBet = pot >= settings.minBet;
      } else {
        passBet = settings.minBet > 0 ? false : true;
      }

      const passes = passFF && passStat && passBet;
      applyFilterToRow(row, { uid, name, ff: heur.ff, stats: heur.stats, pot }, passes);
    });

    updateMonitorUI();
  } catch (e) {
    logError("applyAllFilters error", e);
  }
}

function updateMonitorUI() {
  try {
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
          row.style.display = "none";
        } else {
          row.style.display = "";
        }
      } else {
        row.style.display = "";
      }
    });
  } catch (e) {
    logError("updateMonitorUI error", e);
  }
}

/* =========================
   Outcome detection & recent winners
   ========================= */

const recentWinners = []; // {id,name,created,node}

function detectGameOutcomeForRow(row) {
  if (!row) return null;
  try {
    const text = (row.textContent || "").toLowerCase();
    if (/sent to hospital|sent to the hospital|hospital|skull|dead|died|0 hp|0 health|hp: 0|health: 0/.test(text)) return "lost";
    if (/(won|winner|collected|survived|took the pot|took the pot|won \$|won m|won k)/.test(text)) return "won";

    const imgs = row.querySelectorAll("img");
    for (const img of imgs) {
      const alt = (img.alt || "").toLowerCase();
      const title = (img.title || "").toLowerCase();
      if (/(hospital|skull|dead)/.test(alt + " " + title)) return "lost";
      if (/(winner|won|collected|took the pot)/.test(alt + " " + title)) return "won";
    }

    const smalls = row.querySelectorAll("small,span");
    for (const s of smalls) {
      const t = (s.textContent || "").toLowerCase();
      if (/(hospital|sent to hospital|dead|0 health|0 hp)/.test(t)) return "lost";
      if (/(won|winner|collected|survived)/.test(t)) return "won";
    }
  } catch (e) {
    logError("detectGameOutcomeForRow error", e);
  }
  return null;
}

function makeProfileOrAttackLink(uid) {
  return `https://www.torn.com/profiles.php?XID=${encodeURIComponent(uid)}`;
}

function markAsLoser(row, uid, name) {
  try {
    if (!row) return;
    row.classList.remove("gh-winner");
    row.classList.add("gh-loser");
    const btn = row.querySelector(".gh-attack");
    if (btn) btn.remove();
    row.classList.add("gh-hidden");
    rowState.set(row, Object.assign(rowState.get(row) || {}, { outcome: "lost", outcomeAt: Date.now() }));
    logInfo(`Marked loser: ${name || uid}`, { uid, name });
  } catch (e) {
    logError("markAsLoser error", e);
  }
}

function markAsWinner(row, uid, name) {
  try {
    if (!row) return;
    row.classList.remove("gh-loser");
    row.classList.add("gh-winner");
    row.classList.remove("gh-hidden");

    if (!row.querySelector(".gh-attack")) {
      const link = document.createElement("a");
      link.className = "gh-attack";
      link.setAttribute("title", "Open profile / attack page (manual action only)");
      link.href = uid ? makeProfileOrAttackLink(uid) : "#";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.innerHTML = '<span class="gh-crosshair" aria-hidden="true"></span><span style="font-size:12px;color:inherit;">ATTACK</span>';
      const anchor = row.querySelector('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]');
      if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(link, anchor.nextSibling);
      else row.appendChild(link);
    }

    addRecentWinner({ id: uid, name: name || (row.querySelector('a') ? row.querySelector('a').textContent.trim() : "Unknown"), link: makeProfileOrAttackLink(uid) });
    rowState.set(row, Object.assign(rowState.get(row) || {}, { outcome: "won", outcomeAt: Date.now() }));
    logInfo(`Marked winner: ${name || uid}`, { uid, name });
  } catch (e) {
    logError("markAsWinner error", e);
  }
}

/* Recent winners UI */
function ensureRecentWinnersPanel() {
  let panel = document.getElementById("gh-recent-winners");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "gh-recent-winners";
    panel.innerHTML = `<h4>Recent Winners (60s)</h4><div id="gh-recent-list"></div>`;
    document.body.appendChild(panel);
  }
  panel.style.display = ""; // ensure visible
}

function addRecentWinner({ id, name, link }) {
  ensureRecentWinnersPanel();
  try {
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
    if (list) list.insertBefore(entry, list.firstChild);

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
  } catch (e) {
    logError("addRecentWinner error", e);
  }
}

/* =========================
   MutationObserver + Periodic Monitor
   ========================= */

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
          if (outcome === "lost") markAsLoser(row, uid, a.textContent.trim());
          else if (outcome === "won") markAsWinner(row, uid, a.textContent.trim());
          else if (settings.apiKey && uid) scheduleUserHealthCheck(uid, row, a.textContent.trim());
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
          if (outcome === "lost") markAsLoser(row, uid, a.textContent.trim());
          else if (outcome === "won") markAsWinner(row, uid, a.textContent.trim());
        });
      }
    }
  } catch (e) {
    logError("detectOutcomesFromMutations error", e);
  }
}

function findRowForAnchor(a) {
  const rows = getLobbyRows();
  for (const row of rows) {
    if (row.contains(a)) return row;
  }
  let el = a;
  for (let i = 0; i < 8 && el && el !== document.body; i++) {
    if (rows.includes(el)) return el;
    el = el.parentElement;
  }
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
        const name = anchor ? (anchor.textContent || "").trim() : "Unknown";
        if (outcome === "lost") markAsLoser(row, uid, name);
        if (outcome === "won") markAsWinner(row, uid, name);
        if ((!outcome || outcome === null) && settings.apiKey && uid) scheduleUserHealthCheck(uid, row, name);
      });
    } catch (e) {
      logError("periodic monitor error", e);
    }
  }, 2000);
  logDebug("Periodic monitor started");
}

/* =========================
   Torn API (health checks) - cached & rate-limited
   ========================= */

function scheduleUserHealthCheck(uid, row, name) {
  if (!settings.apiKey || !uid) return;
  const key = String(uid);
  const now = Date.now();
  const last = userHealthCheckCache[key];
  if (last && now - (last.lastChecked || 0) < 8000) return;
  userHealthCheckCache[key] = { lastChecked: now };

  const apiUrl = `https://api.torn.com/user/?selections=profile&id=${encodeURIComponent(uid)}&key=${encodeURIComponent(settings.apiKey)}`;
  logDebug(`Performing Torn API check for uid ${uid}`);
  GM_xmlhttpRequest({
    method: "GET",
    url: apiUrl,
    timeout: 10000,
    onload: function (resp) {
      try {
        if (resp.status >= 200 && resp.status < 400) {
          const data = JSON.parse(resp.responseText || "{}");
          if (data.error) {
            logWarn("Torn API returned error", data.error);
            userHealthCheckCache[key] = { lastChecked: now, status: "error" };
            return;
          }
          let percent = NaN;
          if (data.profile && data.profile.health) {
            // some formats
            if (typeof data.profile.health.percent !== "undefined") percent = Number(data.profile.health.percent);
            else if (typeof data.health !== "undefined" && typeof data.health.percent !== "undefined") percent = Number(data.health.percent);
            else if (typeof data.profile.health_percent !== "undefined") percent = Number(data.profile.health_percent);
          } else if (data.health && typeof data.health === "object" && typeof data.health.percent !== "undefined") {
            percent = Number(data.health.percent);
          } else if (typeof data.health === "number") {
            percent = Number(data.health);
          }
          userHealthCheckCache[key] = { lastChecked: now, status: "ok", healthPercent: percent };
          if (isFinite(percent)) {
            if (percent <= 0.5) markAsLoser(row, uid, name);
            else markAsWinner(row, uid, name);
          } else {
            const outcome = detectGameOutcomeForRow(row);
            if (outcome === "lost") markAsLoser(row, uid, name);
            if (outcome === "won") markAsWinner(row, uid, name);
          }
        } else {
          logWarn("Torn API request non-200", { status: resp.status, resp: resp.responseText });
          userHealthCheckCache[key] = { lastChecked: now, status: "error" };
        }
      } catch (err) {
        logError("Torn API parse error", err);
        userHealthCheckCache[key] = { lastChecked: now, status: "error" };
      }
    },
    onerror: function (err) {
      logError("Torn API network error", err);
      userHealthCheckCache[key] = { lastChecked: now, status: "error" };
    }
  });
}

/* =========================
   Settings Modal + Test Extraction + Debug Panel
   ========================= */

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
  if (!container) container = document.querySelector("#content") || document.body;
  if (document.getElementById("gh-top-btns")) return;

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
    <div class="gh-row"><label>Enable Debug Logs</label><input id="gh-debug-enabled" type="checkbox" /></div>
    <div class="gh-row"><label>Test Extraction Count (top rows)</label><input id="gh-test-count" type="number" min="1" max="50" step="1" /></div>

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

    <div id="gh-test-output" style="margin-top:10px; max-height:240px; overflow:auto; background:rgba(255,255,255,0.02); padding:6px; border-radius:6px; font-size:12px;"></div>

    <div style="font-size:12px;opacity:0.9;margin-top:10px;">
      Note: This tool performs only visual filtering and monitoring. It will NOT perform any attacks automatically.
      If you provide an API key, it will query the Torn API to confirm a player's health (rate-limited). Keys are stored locally only.
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
    saveSettings(settings);
    updateMonitorUI();
    applyAllFilters();
    logInfo("Settings saved", settings);
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
    document.getElementById("gh-debug-enabled").checked = settings.debugEnabled;
    document.getElementById("gh-test-count").value = settings.testExtractionCount;
    applyAllFilters();
    logInfo("Settings reset to defaults");
  };

  document.getElementById("gh-close").onclick = closeSettingsModal;

  document.getElementById("gh-run-test").onclick = () => runTestExtraction();
  document.getElementById("gh-copy-logs").onclick = () => copyLogsToClipboard();
  document.getElementById("gh-toggle-debug-panel").onclick = () => toggleDebugPanel();
}

function closeSettingsModal() {
  const m = document.getElementById("gh-modal");
  if (m) m.remove();
}

/* Test Extraction - inspects top N rows and shows parsed fields */
function runTestExtraction() {
  const out = document.getElementById("gh-test-output");
  if (!out) return;
  out.innerHTML = "<div>Running extraction...</div>";
  try {
    const count = Number(document.getElementById("gh-test-count").value || settings.testExtractionCount || 8);
    const rows = getLobbyRows().slice(0, count);
    if (!rows.length) {
      out.innerHTML = "<div>No rows found on the page. Make sure the lobby is visible.</div>";
      return;
    }
    const lines = [];
    lines.push(`<div style="font-weight:600;margin-bottom:6px;">Top ${rows.length} rows extraction</div>`);
    rows.forEach((row, idx) => {
      const anchor = row.querySelector('a[href*="XID"], a[href*="profiles.php"], a[href*="profile.php"]');
      const name = anchor ? (anchor.textContent || "").trim() : "Unknown";
      const uid = anchor ? extractUserIdFromHref(anchor.getAttribute("href") || "") : null;
      const heur = heuristicExtractFFAndStats(row);
      const pot = findPotOrBetInRow(row);
      const passFF = isFinite(heur.ff) ? (heur.ff >= settings.minFF && heur.ff <= settings.maxFF) : (settings.requireKnownFF ? false : true);
      const passStat = isFinite(heur.stats) ? (heur.stats >= settings.minStat && heur.stats <= settings.maxStat) : true;
      const passBet = isFinite(pot) ? (pot >= settings.minBet) : (settings.minBet > 0 ? false : true);
      const passes = passFF && passStat && passBet;
      lines.push(`<div style="padding:6px;border-radius:4px;margin-bottom:6px;background:rgba(255,255,255,0.02)"><div style="font-weight:600">${idx+1}. ${escapeHtml(name)} ${uid ? ` (XID:${uid})` : ""}</div>
        <div style="font-size:12px;margin-top:4px;">FF: ${isFinite(heur.ff)?heur.ff:"unknown"}, Stats: ${isFinite(heur.stats)?heur.stats:"unknown"}, Pot: ${isFinite(pot)?pot:"unknown"}</div>
        <div style="font-size:12px;margin-top:4px;">Passes filters: ${passes ? "<span style='color:#6f6'>YES</span>" : "<span style='color:#f66'>NO</span>"}</div></div>`);
    });
    out.innerHTML = lines.join("");
    logInfo("Test extraction ran", { count: rows.length });
  } catch (e) {
    out.innerHTML = `<div style="color:#f88">Error running extraction: ${escapeHtml(String(e))}</div>`;
    logError("runTestExtraction error", e);
  }
}

/* Copy logs to clipboard */
function copyLogsToClipboard() {
  try {
    const toCopy = logBuffer.map(l => `${new Date(l.ts).toISOString()} [${l.level.toUpperCase()}] ${l.msg} ${l.meta ? JSON.stringify(l.meta) : ""}`).join("\n");
    navigator.clipboard && navigator.clipboard.writeText(toCopy);
    logInfo("Logs copied to clipboard");
    alert("Logs copied to clipboard (if your browser allows clipboard access).");
  } catch (e) {
    logError("copyLogsToClipboard error", e);
    alert("Failed to copy logs - see console.");
  }
}

/* Debug Panel */
function ensureDebugPanel() {
  let panel = document.getElementById("gh-debug-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "gh-debug-panel";
    panel.innerHTML = `<h4>GameHunt Debug Panel</h4><div id="gh-debug-list"></div><div style="display:flex;gap:6px;margin-top:6px;"><button id="gh-debug-clear" class="gh-btn">Clear</button><button id="gh-debug-close" class="gh-btn">Close</button></div>`;
    document.body.appendChild(panel);
    document.getElementById("gh-debug-clear").onclick = () => { logBuffer.length = 0; updateDebugPanel(); };
    document.getElementById("gh-debug-close").onclick = () => { panel.style.display = "none"; };
  }
  panel.style.display = settings.debugEnabled ? "" : "none";
  updateDebugPanel();
}

function updateDebugPanel() {
  const panel = document.getElementById("gh-debug-panel");
  if (!panel) return;
  const list = document.getElementById("gh-debug-list");
  if (!list) return;
  list.innerHTML = "";
  const entries = logBuffer.slice().reverse().slice(0, 150); // newest first
  for (const e of entries) {
    const div = document.createElement("div");
    div.className = `gh-log-entry ${e.level}`;
    div.innerHTML = `<div style="font-size:11px;color:rgba(255,255,255,0.7)">${new Date(e.ts).toLocaleTimeString()} [${e.level.toUpperCase()}]</div><div>${escapeHtml(e.msg)}</div><div style="font-size:11px;opacity:0.8">${e.meta ? escapeHtml(JSON.stringify(e.meta)) : ""}</div>`;
    list.appendChild(div);
  }
}

/* Toggle on-screen debug panel */
function toggleDebugPanel() {
  settings.debugEnabled = !settings.debugEnabled;
  saveSettings(settings);
  ensureDebugPanel();
  logInfo("Debug panel toggled", { enabled: settings.debugEnabled });
}

/* =========================
   Initialization
   ========================= */

function initialScanAndBootstrap() {
  addStyles();
  tryInsertTopButtons();
  ensureRecentWinnersPanel();
  updateMonitorUI();
  applyAllFilters();
  startObservers();
  startPeriodicMonitor();
  ensureDebugPanel();
  try { GM_registerMenuCommand && GM_registerMenuCommand("Game Hunting Settings", openSettingsModal); } catch (e) {}
  logInfo("Game Hunting script initialized", { settings });
}

/* Run */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialScanAndBootstrap);
} else {
  initialScanAndBootstrap();
}

/* =========================
   Final adversarial notes
   - CSS now avoids overriding site text color; that fixes 'blank names' symptom.
   - Test Extraction displays parsed FF/Stats/Pot for the top N discovered rows to validate heuristics.
   - Debugging: console + on-screen debug panel + copy logs facility added.
   - Torn API usage remains optional and respects the codex: uses selections=profile and checks for data.error.
   - No automated actions added; attack links are manual and open user profile in new tab.
   - If you still see missing/blank names, please paste a HTML snippet of one lobby row (including FFScouter injection) and I will further iterate.
   ========================= */
