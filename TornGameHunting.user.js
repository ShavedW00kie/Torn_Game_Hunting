// ==UserScript==
// @name         Torn Game Hunting - Russian Roulette Monitor & Filter (FFScouter aware)
// @namespace    https://github.com/ShavedW00kie/
// @version      1.5.0
// @description  Event-driven Russian Roulette lobby filter and winner monitor for Torn.com. FFScouter-aware, TornPDA-friendly, no automated game actions.
// @author       ShavedW00kie (Torn: ThaWookie [2954173] )
// @license      BSD-3-Clause
// @homepageURL  https://github.com/ShavedW00kie
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * Torn Game Hunting - Russian Roulette Monitor & Filter
 * Version 1.5.0
 *
 * BSD-3-Clause License
 *
 * Copyright (c) 2026 ShavedW00kie
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

(function () {
    "use strict";

    /* ============================================================
     * 1. CORE CONSTANTS / DEBUGGER
     * ============================================================ */

    const SCRIPT_NAME = "Torn Game Hunting - Russian Roulette Monitor & Filter (FFScouter aware)";
    const SCRIPT_VERSION = "1.5.0";
    const STORAGE_KEY = "tgh_settings_v2";
    const STYLE_ID = "tgh-style-v150";
    const PROFILE_SELECTOR = 'a[href*="XID="], a[href*="profiles.php"], a[href*="profile.php"]';
    const OWN_UI_SELECTOR = '[data-tgh-ui="1"]';
    const MAX_SAFE_FILTER = 999_999_999_999_999;

    const MyDebug = initializeModularDebugger(GM_info.script.name);

    function debugLog(level, message, meta = null) {
        MyDebug.log({
            level: String(level || "INFO").toUpperCase(),
            message: String(message || ""),
            meta
        });
    }

    /* ============================================================
     * 2. GM / TORN PDA COMPATIBILITY WRAPPER
     * ============================================================ */

    let mainStyleInjected = false;

    const GMCompat = Object.freeze({
        get(key, fallback) {
            try {
                if (typeof GM_getValue === "function") {
                    return GM_getValue(key, fallback);
                }
            } catch (error) {
                debugLog("WARN", "GM_getValue failed; using localStorage fallback.", {
                    key,
                    error: serializeError(error)
                });
            }

            try {
                const raw = localStorage.getItem(`tgh:${key}`);
                return raw === null ? fallback : JSON.parse(raw);
            } catch (error) {
                debugLog("WARN", "localStorage read failed.", {
                    key,
                    error: serializeError(error)
                });
                return fallback;
            }
        },

        set(key, value) {
            try {
                if (typeof GM_setValue === "function") {
                    GM_setValue(key, value);
                    return true;
                }
            } catch (error) {
                debugLog("WARN", "GM_setValue failed; using localStorage fallback.", {
                    key,
                    error: serializeError(error)
                });
            }

            try {
                localStorage.setItem(`tgh:${key}`, JSON.stringify(value));
                return true;
            } catch (error) {
                debugLog("ERROR", "Unable to persist setting.", {
                    key,
                    error: serializeError(error)
                });
                return false;
            }
        },

        remove(key) {
            try {
                if (typeof GM_deleteValue === "function") {
                    GM_deleteValue(key);
                }
            } catch (error) {
                debugLog("WARN", "GM_deleteValue failed.", {
                    key,
                    error: serializeError(error)
                });
            }

            try {
                localStorage.removeItem(`tgh:${key}`);
            } catch (_) {
                // Storage cleanup is best-effort only.
            }
        },

        addStyle(cssText) {
            if (mainStyleInjected || document.getElementById(STYLE_ID)) {
                mainStyleInjected = true;
                return;
            }

            if (typeof GM_addStyle === "function") {
                try {
                    const styleNode = GM_addStyle(cssText);
                    if (styleNode && styleNode.nodeType === Node.ELEMENT_NODE) {
                        styleNode.id = STYLE_ID;
                    }
                    mainStyleInjected = true;
                    return;
                } catch (error) {
                    debugLog("WARN", "GM_addStyle failed; using style element fallback.", {
                        error: serializeError(error)
                    });
                }
            }

            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = cssText;
            (document.head || document.documentElement).appendChild(style);
            mainStyleInjected = true;
        },

        registerMenu(label, handler) {
            try {
                if (typeof GM_registerMenuCommand === "function") {
                    GM_registerMenuCommand(label, handler);
                }
            } catch (error) {
                debugLog("WARN", "GM_registerMenuCommand failed.", {
                    label,
                    error: serializeError(error)
                });
            }
        }
    });

    /* ============================================================
     * 3. SETTINGS / LEGACY MIGRATION
     * ============================================================ */

    const DEFAULTS = Object.freeze({
        minFF: 0,
        maxFF: MAX_SAFE_FILTER,
        minStat: 0,
        maxStat: MAX_SAFE_FILTER,
        minBet: 0,
        monitorOn: false,
        requireKnownFF: false,
        requireKnownStats: false,
        showRecentWinners: true,
        testExtractionCount: 8,
        includeFullRowHTML: false
    });

    function coerceBoolean(value, fallback = false) {
        if (typeof value === "boolean") return value;
        if (value === "true" || value === 1 || value === "1") return true;
        if (value === "false" || value === 0 || value === "0") return false;
        return fallback;
    }

    function finiteNumber(value, fallback, min = 0, max = MAX_SAFE_FILTER) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(max, Math.max(min, number));
    }

    function sanitizeSettings(raw = {}) {
        const sanitized = {
            minFF: finiteNumber(raw.minFF, DEFAULTS.minFF),
            maxFF: finiteNumber(raw.maxFF, DEFAULTS.maxFF),
            minStat: finiteNumber(raw.minStat, DEFAULTS.minStat),
            maxStat: finiteNumber(raw.maxStat, DEFAULTS.maxStat),
            minBet: finiteNumber(raw.minBet, DEFAULTS.minBet),
            monitorOn: coerceBoolean(raw.monitorOn, DEFAULTS.monitorOn),
            requireKnownFF: coerceBoolean(raw.requireKnownFF, DEFAULTS.requireKnownFF),
            requireKnownStats: coerceBoolean(raw.requireKnownStats, DEFAULTS.requireKnownStats),
            showRecentWinners: coerceBoolean(raw.showRecentWinners, DEFAULTS.showRecentWinners),
            testExtractionCount: finiteNumber(raw.testExtractionCount, DEFAULTS.testExtractionCount, 1, 50),
            includeFullRowHTML: coerceBoolean(raw.includeFullRowHTML, DEFAULTS.includeFullRowHTML)
        };

        if (sanitized.minFF > sanitized.maxFF) {
            [sanitized.minFF, sanitized.maxFF] = [sanitized.maxFF, sanitized.minFF];
        }

        if (sanitized.minStat > sanitized.maxStat) {
            [sanitized.minStat, sanitized.maxStat] = [sanitized.maxStat, sanitized.minStat];
        }

        return sanitized;
    }

    function migrateLegacySettings() {
        const missing = `__tgh_missing_${Date.now()}__`;
        const legacyMap = {
            minFF: "gh_minFF",
            maxFF: "gh_maxFF",
            minStat: "gh_minStat",
            maxStat: "gh_maxStat",
            minBet: "gh_minBet",
            monitorOn: "gh_monitorOn",
            requireKnownFF: "gh_requireKnownFF",
            testExtractionCount: "gh_testExtractionCount",
            includeFullRowHTML: "gh_includeFullRowHTML"
        };

        const migrated = {};
        let foundLegacy = false;

        for (const [newKey, oldKey] of Object.entries(legacyMap)) {
            const value = GMCompat.get(oldKey, missing);
            if (value !== missing) {
                migrated[newKey] = value;
                foundLegacy = true;
            }
        }

        /*
         * v1.4.0 stored an API key for a health-based outcome heuristic.
         * v1.5.0 does not use the Torn API at all. Remove the obsolete key
         * during migration rather than retaining a secret the script no
         * longer needs.
         */
        GMCompat.remove("gh_apiKey");
        GMCompat.remove("gh_debugEnabled");

        if (!foundLegacy) {
            return null;
        }

        const result = sanitizeSettings({ ...DEFAULTS, ...migrated });
        GMCompat.set(STORAGE_KEY, result);

        for (const oldKey of Object.values(legacyMap)) {
            GMCompat.remove(oldKey);
        }

        debugLog("INFO", "Migrated legacy Game Hunting settings to v2 storage.");
        return result;
    }

    function loadSettings() {
        const stored = GMCompat.get(STORAGE_KEY, null);
        if (stored && typeof stored === "object") {
            return sanitizeSettings(stored);
        }

        return migrateLegacySettings() || { ...DEFAULTS };
    }

    function saveSettings(nextSettings) {
        settings = sanitizeSettings(nextSettings);
        GMCompat.set(STORAGE_KEY, settings);
        return settings;
    }

    let settings = loadSettings();

    /* ============================================================
     * 4. GENERIC HELPERS
     * ============================================================ */

    function serializeError(error) {
        if (!error) return null;
        return {
            name: error.name || "Error",
            message: error.message || String(error),
            stack: error.stack || ""
        };
    }

    function normalizeText(value) {
        return String(value || "")
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function parseCompactNumber(value) {
        if (value === null || typeof value === "undefined") return Number.NaN;

        let text = normalizeText(value)
            .toLowerCase()
            .replace(/[$€£¥\s,]/g, "");

        if (!text) return Number.NaN;

        const exact = text.match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))([kmbtq]?)$/i);
        if (!exact) return Number.NaN;

        let number = Number(exact[1]);
        const suffix = exact[2].toLowerCase();
        const multipliers = {
            "": 1,
            k: 1e3,
            m: 1e6,
            b: 1e9,
            t: 1e12,
            q: 1e15
        };

        number *= multipliers[suffix] || 1;
        return Number.isFinite(number) ? number : Number.NaN;
    }

    const NUMBER_TOKEN_SOURCE = "([0-9][0-9,]*(?:\\.[0-9]+)?\\s*[kKmMbBtTqQ]?)";

    function extractLabeledNumber(text, labels) {
        const clean = normalizeText(text);
        if (!clean) return Number.NaN;

        for (const label of labels) {
            const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const after = new RegExp(`(?:^|\\b)${escaped}\\s*[:=\\-]?\\s*${NUMBER_TOKEN_SOURCE}`, "i");
            const before = new RegExp(`${NUMBER_TOKEN_SOURCE}\\s*${escaped}(?:\\b|$)`, "i");
            const match = clean.match(after) || clean.match(before);
            if (match) {
                const candidate = match[1] || match[0];
                const numberToken = String(candidate).match(/[0-9][0-9,]*(?:\.[0-9]+)?\s*[kKmMbBtTqQ]?/);
                if (numberToken) {
                    const parsed = parseCompactNumber(numberToken[0]);
                    if (Number.isFinite(parsed)) return parsed;
                }
            }
        }

        return Number.NaN;
    }

    function formatCompactNumber(value) {
        if (!Number.isFinite(value)) return "unknown";
        const abs = Math.abs(value);
        const scales = [
            [1e15, "Q"],
            [1e12, "T"],
            [1e9, "B"],
            [1e6, "M"],
            [1e3, "K"]
        ];

        for (const [size, suffix] of scales) {
            if (abs >= size) {
                const scaled = value / size;
                return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}${suffix}`;
            }
        }

        return Math.round(value).toLocaleString();
    }

    function isTargetRoute() {
        return /(?:[?&#])sid=russianroulette(?:[&#]|$)/i.test(window.location.href);
    }

    function getContentRoot() {
        return (
            document.querySelector("#mainContainer") ||
            document.querySelector("#content") ||
            document.querySelector('[role="main"]') ||
            document.querySelector("main") ||
            document.body
        );
    }

    function isOwnUi(node) {
        return Boolean(
            node &&
            node.nodeType === Node.ELEMENT_NODE &&
            (node.matches(OWN_UI_SELECTOR) || node.closest(OWN_UI_SELECTOR))
        );
    }

    function extractUserIdFromHref(href = "") {
        if (!href) return null;

        try {
            const url = new URL(href, window.location.origin);
            const xid = url.searchParams.get("XID") || url.searchParams.get("xid");
            if (xid && /^\d+$/.test(xid)) return xid;
        } catch (_) {
            // Continue into regex compatibility path.
        }

        const match = String(href).match(/[?&]XID=(\d+)/i) || String(href).match(/profile(?:s)?\.php[^\d]*(\d+)/i);
        return match ? match[1] : null;
    }

    function isUsableProfileAnchor(anchor) {
        return Boolean(
            anchor &&
            anchor.nodeType === Node.ELEMENT_NODE &&
            anchor.matches(PROFILE_SELECTOR) &&
            !isOwnUi(anchor) &&
            extractUserIdFromHref(anchor.getAttribute("href") || "")
        );
    }

    function findProfileAnchorsInRegion(root) {
        if (!root) return [];

        const result = [];
        if (root.nodeType === Node.ELEMENT_NODE && root.matches(PROFILE_SELECTOR) && isUsableProfileAnchor(root)) {
            result.push(root);
        }

        if (typeof root.querySelectorAll === "function") {
            for (const anchor of root.querySelectorAll(PROFILE_SELECTOR)) {
                if (isUsableProfileAnchor(anchor)) result.push(anchor);
            }
        }

        return result;
    }

    function getDisplayNameFromAnchor(anchor) {
        if (!anchor) return "Unknown";

        const directText = normalizeText(anchor.textContent);
        if (
            directText.length >= 2 &&
            directText.length <= 60 &&
            !/^(?:view\s+)?profile|details|click here$/i.test(directText)
        ) {
            return directText;
        }

        const attributeCandidates = [
            anchor.getAttribute("data-player-name"),
            anchor.getAttribute("data-username"),
            anchor.getAttribute("data-name"),
            anchor.getAttribute("aria-label"),
            anchor.getAttribute("title"),
            anchor.getAttribute("data-original-title")
        ];

        for (const candidate of attributeCandidates) {
            const text = normalizeText(candidate);
            if (text && text.length <= 60 && !/profile|details/i.test(text)) {
                return text;
            }
        }

        const namedChild = anchor.querySelector(".name, .player-name, .username, strong, b, img[alt]");
        if (namedChild) {
            const text = normalizeText(namedChild.alt || namedChild.textContent);
            if (text && text.length <= 60 && !/avatar|profile/i.test(text)) {
                return text;
            }
        }

        let sibling = anchor.previousSibling;
        for (let depth = 0; depth < 4 && sibling; depth += 1) {
            const text = normalizeText(sibling.textContent);
            if (text) {
                const match = text.match(/([A-Za-z0-9_\-\[\] ]{2,40}):?$/);
                if (match && !/bet|pot|wager|stake|profile/i.test(match[1])) {
                    return normalizeText(match[1]);
                }
            }
            sibling = sibling.previousSibling;
        }

        return "Unknown";
    }

    /* ============================================================
     * 5. ROW DISCOVERY
     * ============================================================ */

    function rowCandidateScore(element) {
        if (!element || element === document.body || isOwnUi(element)) return -1;

        const text = normalizeText(element.textContent);
        if (!text || text.length > 1800) return -1;

        const profileCount = findProfileAnchorsInRegion(element).length;
        if (profileCount === 0 || profileCount > 4) return -1;

        let score = 0;
        if (profileCount === 1) score += 3;
        else score += 1;

        if (/\b(?:bet|pot|wager|stake|playing|player|winner|roulette|game)\b/i.test(text)) score += 2;
        if (/[$£€]?\s*\d[\d,.]*\s*[kKmMbBtTqQ]?/.test(text)) score += 1;
        if (/^(?:LI|TR)$/i.test(element.tagName) || element.getAttribute("role") === "row") score += 2;
        if (/game|roulette|player|row|item|entry|match/i.test(element.className || "")) score += 1;

        return score;
    }

    function findRowForAnchor(anchor) {
        if (!anchor || !anchor.isConnected) return null;

        const contentRoot = getContentRoot();
        let element = anchor.parentElement;
        let best = null;
        let bestScore = -1;

        for (let depth = 0; depth < 10 && element && element !== document.body; depth += 1) {
            const score = rowCandidateScore(element);
            if (score > bestScore) {
                best = element;
                bestScore = score;
            }

            if (score >= 6) {
                return element;
            }

            if (element === contentRoot) break;
            element = element.parentElement;
        }

        return best || anchor.closest("li, tr, [role='row']") || anchor.parentElement;
    }

    function collectRowsFromRegion(region) {
        const rows = new Set();
        for (const anchor of findProfileAnchorsInRegion(region)) {
            const row = findRowForAnchor(anchor);
            if (row && !isOwnUi(row)) rows.add(row);
        }
        return rows;
    }

    function getPrimaryAnchor(row) {
        return findProfileAnchorsInRegion(row)[0] || null;
    }

    /* ============================================================
     * 6. FFSCOUTER / STAT / BET EXTRACTION
     * ============================================================ */

    function readDatasetNumber(element, keys) {
        if (!element || !element.dataset) return Number.NaN;
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(element.dataset, key)) {
                const parsed = parseCompactNumber(element.dataset[key]);
                if (Number.isFinite(parsed)) return parsed;
            }
        }
        return Number.NaN;
    }

    function heuristicExtractFFAndStats(container) {
        const result = {
            ff: Number.NaN,
            stats: Number.NaN,
            sources: []
        };

        if (!container) return result;

        try {
            const dataNodes = container.querySelectorAll(
                "[data-ff], [data-ffscore], [data-ff-score], [data-ffscouter], [data-ff-scouter], " +
                "[data-stats], [data-stat], [data-statestimate], [data-stat-estimate]"
            );

            for (const node of dataNodes) {
                if (!Number.isFinite(result.ff)) {
                    const value = readDatasetNumber(node, ["ff", "ffscore", "ffScore", "ffscouter", "ffScouter"]);
                    if (Number.isFinite(value)) {
                        result.ff = value;
                        result.sources.push({ type: "data", field: "ff", value });
                    }
                }

                if (!Number.isFinite(result.stats)) {
                    const value = readDatasetNumber(node, ["stats", "stat", "statestimate", "statEstimate"]);
                    if (Number.isFinite(value)) {
                        result.stats = value;
                        result.sources.push({ type: "data", field: "stats", value });
                    }
                }

                if (Number.isFinite(result.ff) && Number.isFinite(result.stats)) break;
            }

            if (!Number.isFinite(result.ff) || !Number.isFinite(result.stats)) {
                const likelyNodes = container.querySelectorAll(
                    '[class*="ff" i], [class*="stat" i], [title], [aria-label], [data-original-title]'
                );

                for (const node of likelyNodes) {
                    const samples = [
                        normalizeText(node.textContent),
                        normalizeText(node.getAttribute("title")),
                        normalizeText(node.getAttribute("aria-label")),
                        normalizeText(node.getAttribute("data-original-title"))
                    ].filter(Boolean);

                    for (const sample of samples) {
                        if (!Number.isFinite(result.ff)) {
                            const value = extractLabeledNumber(sample, ["FF", "FFScouter", "FF score"]);
                            if (Number.isFinite(value)) {
                                result.ff = value;
                                result.sources.push({ type: "dom", field: "ff", sample: sample.slice(0, 120) });
                            }
                        }

                        if (!Number.isFinite(result.stats)) {
                            const value = extractLabeledNumber(sample, ["stats", "stat", "estimate", "estimated stats", "battle stats"]);
                            if (Number.isFinite(value)) {
                                result.stats = value;
                                result.sources.push({ type: "dom", field: "stats", sample: sample.slice(0, 120) });
                            }
                        }

                        if (Number.isFinite(result.ff) && Number.isFinite(result.stats)) break;
                    }

                    if (Number.isFinite(result.ff) && Number.isFinite(result.stats)) break;
                }
            }

            const rowText = normalizeText(container.textContent);
            if (!Number.isFinite(result.ff)) {
                const value = extractLabeledNumber(rowText, ["FF", "FFScouter", "FF score"]);
                if (Number.isFinite(value)) {
                    result.ff = value;
                    result.sources.push({ type: "row-text", field: "ff" });
                }
            }

            if (!Number.isFinite(result.stats)) {
                const value = extractLabeledNumber(rowText, ["stats", "stat", "estimate", "estimated stats", "battle stats"]);
                if (Number.isFinite(value)) {
                    result.stats = value;
                    result.sources.push({ type: "row-text", field: "stats" });
                }
            }
        } catch (error) {
            debugLog("ERROR", "FF/stat extraction failed.", {
                error: serializeError(error)
            });
        }

        return result;
    }

    function findPotOrBetInRow(row) {
        if (!row) return Number.NaN;

        try {
            const explicitDataNodes = row.querySelectorAll(
                "[data-bet], [data-pot], [data-wager], [data-stake], [data-amount]"
            );

            for (const node of explicitDataNodes) {
                const value = readDatasetNumber(node, ["bet", "pot", "wager", "stake", "amount"]);
                if (Number.isFinite(value)) return value;
            }

            const likelyNodes = row.querySelectorAll(
                '[class*="pot" i], [class*="bet" i], [class*="wager" i], [class*="stake" i], [aria-label], [title]'
            );

            for (const node of likelyNodes) {
                const samples = [
                    normalizeText(node.textContent),
                    normalizeText(node.getAttribute("aria-label")),
                    normalizeText(node.getAttribute("title"))
                ].filter(Boolean);

                for (const sample of samples) {
                    const value = extractLabeledNumber(sample, ["pot", "bet", "wager", "stake", "stakes"]);
                    if (Number.isFinite(value)) return value;
                }
            }

            return extractLabeledNumber(normalizeText(row.textContent), ["pot", "bet", "wager", "stake", "stakes"]);
        } catch (error) {
            debugLog("ERROR", "Bet/pot extraction failed.", {
                error: serializeError(error)
            });
            return Number.NaN;
        }
    }

    /* ============================================================
     * 7. FILTER EVALUATION
     * ============================================================ */

    function evaluateRange(value, minimum, maximum, requireKnown) {
        if (!Number.isFinite(value)) return !requireKnown;
        return value >= minimum && value <= maximum;
    }

    function evaluateRow(row) {
        const anchor = getPrimaryAnchor(row);
        const uid = anchor ? extractUserIdFromHref(anchor.getAttribute("href") || "") : null;
        const displayName = anchor ? getDisplayNameFromAnchor(anchor) : "Unknown";
        const heuristics = heuristicExtractFFAndStats(row);
        const pot = findPotOrBetInRow(row);

        const passFF = evaluateRange(
            heuristics.ff,
            settings.minFF,
            settings.maxFF,
            settings.requireKnownFF
        );

        const passStats = evaluateRange(
            heuristics.stats,
            settings.minStat,
            settings.maxStat,
            settings.requireKnownStats
        );

        const passBet = Number.isFinite(pot)
            ? pot >= settings.minBet
            : settings.minBet <= 0;

        return {
            uid,
            displayName,
            anchor,
            ff: heuristics.ff,
            stats: heuristics.stats,
            pot,
            sources: heuristics.sources,
            passes: passFF && passStats && passBet,
            passFF,
            passStats,
            passBet
        };
    }

    const rowState = new WeakMap();

    function restoreRowDisplay(row, state) {
        if (!row || !state) return;
        if (state.originalInlineDisplay) {
            row.style.display = state.originalInlineDisplay;
        } else {
            row.style.removeProperty("display");
        }
    }

    function applyFilterAppearance(row, meta, state) {
        row.classList.toggle("tgh-filter-miss", !meta.passes);
        row.classList.toggle("tgh-filter-pass", meta.passes);

        if (settings.monitorOn && !meta.passes) {
            row.style.setProperty("display", "none", "important");
        } else {
            restoreRowDisplay(row, state);
        }
    }

    /* ============================================================
     * 8. CONSERVATIVE OUTCOME DETECTION
     * ============================================================ */

    const LOSS_PATTERN = /\b(?:sent to (?:the )?hospital|hospitali[sz]ed|lost(?: the game)?|loser|died|dead|skull|0\s*(?:hp|health))\b/i;
    const WIN_PATTERN = /\b(?:winner|won(?: the game)?|collected|survived|took the pot|wins? the pot)\b/i;

    function detectGameOutcomeForRow(row) {
        if (!row) return null;

        try {
            const signalNodes = row.querySelectorAll(
                '[class*="winner" i], [class*="loser" i], [class*="result" i], [class*="outcome" i], [class*="status" i], img[alt], [title], [aria-label]'
            );

            for (const node of signalNodes) {
                const className = normalizeText(node.className);
                if (/\bwinner\b/i.test(className)) return "won";
                if (/\bloser\b|\blost\b/i.test(className)) return "lost";

                const signal = [
                    node.textContent,
                    node.getAttribute && node.getAttribute("alt"),
                    node.getAttribute && node.getAttribute("title"),
                    node.getAttribute && node.getAttribute("aria-label")
                ]
                    .map(normalizeText)
                    .filter(Boolean)
                    .join(" ");

                const loss = LOSS_PATTERN.test(signal);
                const win = WIN_PATTERN.test(signal);
                if (loss && !win) return "lost";
                if (win && !loss) return "won";
            }

            const text = normalizeText(row.textContent);
            const loss = LOSS_PATTERN.test(text);
            const win = WIN_PATTERN.test(text);

            if (loss && !win) return "lost";
            if (win && !loss) return "won";
        } catch (error) {
            debugLog("ERROR", "Outcome detection failed.", {
                error: serializeError(error)
            });
        }

        return null;
    }

    function makeProfileLink(uid) {
        return `https://www.torn.com/profiles.php?XID=${encodeURIComponent(uid)}`;
    }

    function removeAttackLink(row) {
        const existing = row && row.querySelector(".tgh-attack");
        if (existing) existing.remove();
    }

    function ensureAttackLink(row, meta) {
        if (!row || !meta.uid || !meta.passes) return;
        if (row.querySelector(".tgh-attack")) return;

        const link = document.createElement("a");
        link.className = "tgh-attack";
        link.dataset.tghUi = "1";
        link.href = makeProfileLink(meta.uid);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = "Open target profile. Any attack remains a manual action.";
        link.setAttribute("aria-label", `Open ${meta.displayName || "target"} profile for a manual action`);

        const crosshair = document.createElement("span");
        crosshair.className = "tgh-crosshair";
        crosshair.setAttribute("aria-hidden", "true");

        const label = document.createElement("span");
        label.textContent = "ATTACK";

        link.append(crosshair, label);

        if (meta.anchor && meta.anchor.parentElement) {
            meta.anchor.parentElement.insertBefore(link, meta.anchor.nextSibling);
        } else {
            row.appendChild(link);
        }
    }

    /* ============================================================
     * 9. RECENT MATCHING WINNERS - NO TIMERS
     * ============================================================ */

    const recentWinnerNodes = new Map();

    function ensureRecentWinnersPanel() {
        let panel = document.getElementById("tgh-recent-winners");
        if (panel) {
            panel.style.display = settings.showRecentWinners ? "" : "none";
            return panel;
        }

        panel = document.createElement("section");
        panel.id = "tgh-recent-winners";
        panel.dataset.tghUi = "1";
        panel.setAttribute("aria-label", "Recent matching Russian Roulette winners");

        const header = document.createElement("div");
        header.className = "tgh-recent-header";

        const title = document.createElement("strong");
        title.textContent = "Recent Matching Winners";

        const note = document.createElement("span");
        note.textContent = "60s";
        note.title = "Entries expire after 60 seconds";

        header.append(title, note);

        const list = document.createElement("div");
        list.id = "tgh-recent-list";

        panel.append(header, list);
        document.body.appendChild(panel);
        panel.style.display = settings.showRecentWinners ? "" : "none";
        return panel;
    }

    function addRecentWinner(meta) {
        if (!settings.showRecentWinners || !meta.uid || !meta.passes) return;

        ensureRecentWinnersPanel();
        const list = document.getElementById("tgh-recent-list");
        if (!list) return;

        const existing = recentWinnerNodes.get(meta.uid);
        if (existing && existing.isConnected) {
            return;
        }

        const entry = document.createElement("div");
        entry.className = "tgh-recent-entry";
        entry.dataset.tghUi = "1";
        entry.dataset.uid = meta.uid;

        const details = document.createElement("div");
        details.className = "tgh-recent-details";

        const name = document.createElement("div");
        name.className = "tgh-recent-name";
        name.textContent = meta.displayName || `XID ${meta.uid}`;

        const stats = document.createElement("div");
        stats.className = "tgh-recent-meta";
        stats.textContent = [
            Number.isFinite(meta.ff) ? `FF ${formatCompactNumber(meta.ff)}` : null,
            Number.isFinite(meta.stats) ? `Stats ${formatCompactNumber(meta.stats)}` : null,
            Number.isFinite(meta.pot) ? `Pot ${formatCompactNumber(meta.pot)}` : null
        ].filter(Boolean).join(" • ") || "matching target";

        details.append(name, stats);

        const link = document.createElement("a");
        link.className = "tgh-recent-open";
        link.dataset.tghUi = "1";
        link.href = makeProfileLink(meta.uid);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = "Open target profile";
        link.setAttribute("aria-label", `Open ${meta.displayName || "target"} profile`);
        link.textContent = "◎";

        entry.append(details, link);

        entry.addEventListener("animationend", (event) => {
            if (event.animationName !== "tgh-recent-lifetime") return;
            entry.remove();
            if (recentWinnerNodes.get(meta.uid) === entry) {
                recentWinnerNodes.delete(meta.uid);
            }
        });

        recentWinnerNodes.set(meta.uid, entry);
        list.prepend(entry);
    }

    function clearRecentWinners() {
        recentWinnerNodes.clear();
        const list = document.getElementById("tgh-recent-list");
        if (list) list.replaceChildren();
    }

    /* ============================================================
     * 10. SINGLE-PASS ROW PROCESSOR
     * ============================================================ */

    function processRow(row, reason = "mutation") {
        if (!row || !row.isConnected || isOwnUi(row)) return;

        const anchor = getPrimaryAnchor(row);
        if (!anchor) return;

        const previous = rowState.get(row) || {
            originalInlineDisplay: row.style.display || "",
            outcome: null,
            passes: null,
            uid: null
        };

        const meta = evaluateRow(row);
        const outcome = detectGameOutcomeForRow(row);

        applyFilterAppearance(row, meta, previous);
        row.classList.toggle("tgh-winner", outcome === "won");
        row.classList.toggle("tgh-loser", outcome === "lost");

        if (outcome === "won" && meta.passes) {
            ensureAttackLink(row, meta);
            addRecentWinner(meta);
        } else {
            removeAttackLink(row);
        }

        const state = {
            ...previous,
            uid: meta.uid,
            displayName: meta.displayName,
            ff: meta.ff,
            stats: meta.stats,
            pot: meta.pot,
            passes: meta.passes,
            outcome,
            lastProcessedAt: Date.now()
        };

        rowState.set(row, state);

        if (previous.outcome !== outcome && outcome) {
            debugLog("INFO", "Russian Roulette outcome transition detected.", {
                reason,
                uid: meta.uid,
                name: meta.displayName,
                outcome,
                passesFilters: meta.passes
            });
        }
    }

    function processRows(rows, reason) {
        for (const row of rows) {
            try {
                processRow(row, reason);
            } catch (error) {
                debugLog("ERROR", "Row processing failed.", {
                    reason,
                    error: serializeError(error)
                });
            }
        }
        updateMonitorButton();
    }

    function processInitialRows() {
        const root = getContentRoot();
        const rows = collectRowsFromRegion(root);
        processRows(rows, "initial-scan");
        debugLog("INFO", "Initial Russian Roulette scan complete.", {
            rowsFound: rows.size
        });
    }

    /* ============================================================
     * 11. EVENT-DRIVEN MUTATION PROCESSING
     * ============================================================ */

    let pageObserver = null;
    let active = false;

    function classMutationIsOnlyOurs(mutation) {
        if (mutation.type !== "attributes" || mutation.attributeName !== "class") return false;
        const target = mutation.target;
        if (!target || target.nodeType !== Node.ELEMENT_NODE) return false;

        const strip = (value) => normalizeText(value)
            .split(" ")
            .filter(Boolean)
            .filter((token) => !token.startsWith("tgh-"))
            .sort()
            .join(" ");

        return strip(mutation.oldValue || "") === strip(target.className || "");
    }

    function collectRowsFromMutation(mutation, rows) {
        if (!mutation || !rows) return;

        if (mutation.type === "attributes") {
            if (classMutationIsOnlyOurs(mutation) || isOwnUi(mutation.target)) return;

            const anchor = mutation.target.matches && mutation.target.matches(PROFILE_SELECTOR)
                ? mutation.target
                : mutation.target.closest && mutation.target.closest(PROFILE_SELECTOR);

            if (anchor && isUsableProfileAnchor(anchor)) {
                const row = findRowForAnchor(anchor);
                if (row) rows.add(row);
                return;
            }

            for (const candidate of collectRowsFromRegion(mutation.target)) {
                rows.add(candidate);
            }
            return;
        }

        if (mutation.type === "characterData") {
            const parent = mutation.target.parentElement;
            if (!parent || isOwnUi(parent)) return;

            const anchor = parent.closest(PROFILE_SELECTOR) || (parent.querySelector && parent.querySelector(PROFILE_SELECTOR));
            if (anchor && isUsableProfileAnchor(anchor)) {
                const row = findRowForAnchor(anchor);
                if (row) rows.add(row);
            } else {
                const nearestProfile = parent.parentElement && parent.parentElement.querySelector(PROFILE_SELECTOR);
                if (nearestProfile && isUsableProfileAnchor(nearestProfile)) {
                    const row = findRowForAnchor(nearestProfile);
                    if (row) rows.add(row);
                }
            }
            return;
        }

        if (mutation.type === "childList") {
            const target = mutation.target;
            if (
                target &&
                target.nodeType === Node.ELEMENT_NODE &&
                target !== document.body &&
                target !== getContentRoot() &&
                !isOwnUi(target) &&
                normalizeText(target.textContent).length <= 1800
            ) {
                const targetRows = collectRowsFromRegion(target);
                for (const row of targetRows) rows.add(row);
            }

            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE || isOwnUi(node)) continue;
                const addedRows = collectRowsFromRegion(node);
                for (const row of addedRows) rows.add(row);
            }
        }
    }

    function startPageObserver() {
        if (pageObserver || !document.body) return;

        pageObserver = new MutationObserver((mutations) => {
            if (!active) return;

            if (!isTargetRoute()) {
                handleRouteChange("observer-route-check");
                return;
            }

            ensureToolbar();
            ensureRecentWinnersPanel();

            const rows = new Set();
            for (const mutation of mutations) {
                collectRowsFromMutation(mutation, rows);
            }

            if (rows.size) {
                processRows(rows, "mutation");
            }
        });

        pageObserver.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeOldValue: true,
            attributeFilter: [
                "class",
                "title",
                "aria-label",
                "data-original-title",
                "data-ff",
                "data-ffscore",
                "data-ff-score",
                "data-ffscouter",
                "data-ff-scouter",
                "data-stats",
                "data-stat",
                "data-statestimate",
                "data-stat-estimate",
                "data-bet",
                "data-pot",
                "data-wager",
                "data-stake",
                "data-amount"
            ]
        });

        debugLog("INFO", "Targeted MutationObserver attached.");
    }

    function stopPageObserver() {
        if (!pageObserver) return;
        pageObserver.disconnect();
        pageObserver = null;
        debugLog("INFO", "Targeted MutationObserver detached.");
    }

    /* ============================================================
     * 12. MAIN UI STYLES
     * ============================================================ */

    function injectMainStyles() {
        GMCompat.addStyle(`
            #tgh-toolbar[data-tgh-ui="1"] {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 8px;
                margin: 8px 0 10px;
                padding: 8px;
                border: 1px solid rgba(255,255,255,.08);
                border-radius: 7px;
                background: rgba(0,0,0,.12);
                box-sizing: border-box;
            }

            .tgh-btn {
                min-height: 34px;
                padding: 7px 10px;
                border: 1px solid rgba(255,255,255,.12);
                border-radius: 5px;
                background: rgba(0,0,0,.2);
                color: inherit;
                font: inherit;
                font-size: 12px;
                line-height: 1.2;
                cursor: pointer;
                touch-action: manipulation;
                -webkit-tap-highlight-color: transparent;
            }

            .tgh-btn:hover { background: rgba(255,255,255,.08); }
            .tgh-btn:active { transform: scale(.98); }
            .tgh-btn:focus-visible { outline: 2px solid #8ab63d; outline-offset: 2px; }

            .tgh-btn.tgh-primary {
                background: #8ab63d;
                border-color: #6a8c2f;
                color: #fff;
                font-weight: 700;
            }

            .tgh-btn.tgh-monitor-active {
                background: #1f7a45;
                border-color: #2ecc71;
                color: #fff;
                font-weight: 700;
            }

            .tgh-filter-miss:not(.tgh-winner):not(.tgh-loser) {
                opacity: .28 !important;
                filter: grayscale(60%);
            }

            .tgh-winner {
                box-shadow: inset 3px 0 0 #2ecc71;
                background-image: linear-gradient(90deg, rgba(46,204,113,.09), transparent) !important;
            }

            .tgh-loser {
                box-shadow: inset 3px 0 0 #e74c3c;
                background-image: linear-gradient(90deg, rgba(231,76,60,.07), transparent) !important;
            }

            .tgh-attack {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                margin-left: 8px;
                padding: 3px 6px;
                border: 1px solid rgba(255,255,255,.12);
                border-radius: 4px;
                color: inherit !important;
                background: rgba(0,0,0,.16);
                text-decoration: none !important;
                font-size: 11px;
                font-weight: 700;
                vertical-align: middle;
                touch-action: manipulation;
            }

            .tgh-crosshair {
                width: 14px;
                height: 14px;
                border: 2px solid currentColor;
                border-radius: 50%;
                box-sizing: border-box;
                position: relative;
            }

            .tgh-crosshair::before,
            .tgh-crosshair::after {
                content: "";
                position: absolute;
                background: currentColor;
            }

            .tgh-crosshair::before { width: 2px; height: 18px; left: 4px; top: -4px; }
            .tgh-crosshair::after { height: 2px; width: 18px; top: 4px; left: -4px; }

            #tgh-recent-winners {
                position: fixed;
                right: 12px;
                top: 120px;
                z-index: 2147483000;
                width: min(300px, calc(100vw - 24px));
                max-height: 58vh;
                overflow: auto;
                padding: 8px;
                border: 1px solid rgba(255,255,255,.08);
                border-radius: 8px;
                background: rgba(16,16,16,.9);
                color: var(--default-color, #eee);
                box-shadow: 0 8px 24px rgba(0,0,0,.35);
                box-sizing: border-box;
                font-size: 12px;
                backdrop-filter: blur(4px);
            }

            .tgh-recent-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;
                padding: 2px 3px 8px;
            }

            .tgh-recent-header span { opacity: .7; font-size: 11px; }

            @keyframes tgh-recent-lifetime {
                from { outline-color: transparent; }
                to { outline-color: transparent; }
            }

            @keyframes tgh-recent-progress {
                from { transform: scaleX(1); }
                to { transform: scaleX(0); }
            }

            .tgh-recent-entry {
                position: relative;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                margin-bottom: 6px;
                padding: 8px 8px 10px;
                overflow: hidden;
                border-radius: 6px;
                background: rgba(46,204,113,.08);
                animation: tgh-recent-lifetime 60s linear 1;
            }

            .tgh-recent-entry::after {
                content: "";
                position: absolute;
                left: 0;
                right: 0;
                bottom: 0;
                height: 2px;
                background: #2ecc71;
                transform-origin: 0 50%;
                animation: tgh-recent-progress 60s linear 1;
            }

            .tgh-recent-details { min-width: 0; }
            .tgh-recent-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .tgh-recent-meta { margin-top: 2px; opacity: .72; font-size: 10px; overflow-wrap: anywhere; }

            .tgh-recent-open {
                flex: 0 0 auto;
                display: inline-flex;
                width: 30px;
                height: 30px;
                align-items: center;
                justify-content: center;
                border: 1px solid rgba(255,255,255,.12);
                border-radius: 50%;
                color: inherit !important;
                text-decoration: none !important;
                font-size: 21px;
                touch-action: manipulation;
            }

            #tgh-modal-backdrop {
                position: fixed;
                inset: 0;
                z-index: 2147483100;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 12px;
                background: rgba(0,0,0,.68);
                box-sizing: border-box;
            }

            #tgh-modal {
                width: min(720px, 100%);
                max-height: min(90vh, 900px);
                overflow: auto;
                padding: 16px;
                border: 1px solid rgba(255,255,255,.1);
                border-radius: 10px;
                background: #181818;
                color: #eee;
                box-shadow: 0 14px 50px rgba(0,0,0,.6);
                box-sizing: border-box;
                font-family: Arial, sans-serif;
                font-size: 13px;
            }

            #tgh-modal h2 { margin: 0 0 4px; font-size: 20px; }
            #tgh-modal .tgh-version { margin-bottom: 14px; opacity: .65; font-size: 11px; }
            #tgh-modal h3 { margin: 18px 0 8px; font-size: 14px; }

            .tgh-setting-grid {
                display: grid;
                grid-template-columns: minmax(150px, 220px) minmax(0, 1fr);
                gap: 9px 12px;
                align-items: center;
            }

            .tgh-setting-grid label { line-height: 1.3; }

            .tgh-setting-grid input[type="number"] {
                width: 100%;
                min-height: 34px;
                padding: 6px 8px;
                border: 1px solid rgba(255,255,255,.12);
                border-radius: 5px;
                background: #0f0f0f;
                color: #fff;
                box-sizing: border-box;
            }

            .tgh-check {
                display: inline-flex;
                align-items: center;
                gap: 7px;
                min-height: 30px;
            }

            .tgh-actions,
            .tgh-diagnostics {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                margin-top: 12px;
            }

            #tgh-test-output {
                margin-top: 10px;
                max-height: 320px;
                overflow: auto;
                padding: 8px;
                border-radius: 6px;
                background: #0e0e0e;
                white-space: pre-wrap;
                overflow-wrap: anywhere;
                font: 11px/1.45 monospace;
            }

            .tgh-note {
                margin-top: 10px;
                padding: 8px;
                border-left: 3px solid #8ab63d;
                background: rgba(138,182,61,.08);
                font-size: 11px;
                line-height: 1.45;
            }

            .tgh-support-slot {
                margin-top: 8px;
                padding: 10px;
                border: 1px solid rgba(255,255,255,.08);
                border-radius: 8px;
                background: rgba(255,255,255,.025);
            }

            @media (max-width: 640px) {
                .tgh-setting-grid { grid-template-columns: 1fr; gap: 5px; }
                #tgh-recent-winners { top: auto; bottom: 10px; right: 10px; width: min(320px, calc(100vw - 20px)); max-height: 42vh; }
                #tgh-modal { padding: 13px; }
                .tgh-btn { min-height: 40px; }
            }

            @media (prefers-reduced-motion: reduce) {
                .tgh-btn:active { transform: none; }
                .tgh-recent-entry::after { display: none; }
            }
        `);
    }

    /* ============================================================
     * 13. TOOLBAR
     * ============================================================ */

    function findToolbarHost() {
        const selectors = [
            ".submenu",
            ".subtabs",
            ".page-tabs",
            ".tabBar",
            ".contentHeader",
            ".header-links",
            ".breadcrumbs",
            "#mainContainer",
            "#content",
            '[role="main"]',
            "main"
        ];

        for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (node && !isOwnUi(node)) return node;
        }

        return document.body;
    }

    function updateMonitorButton() {
        const button = document.getElementById("tgh-monitor-toggle");
        if (!button) return;

        button.classList.toggle("tgh-monitor-active", settings.monitorOn);
        button.textContent = settings.monitorOn
            ? "Monitor: ON — hiding non-matches"
            : "Monitor: OFF — dim only";
        button.setAttribute("aria-pressed", settings.monitorOn ? "true" : "false");
    }

    function ensureToolbar() {
        if (!active || !document.body || document.getElementById("tgh-toolbar")) {
            updateMonitorButton();
            return;
        }

        const host = findToolbarHost();
        if (!host) return;

        const toolbar = document.createElement("div");
        toolbar.id = "tgh-toolbar";
        toolbar.dataset.tghUi = "1";

        const settingsButton = document.createElement("button");
        settingsButton.type = "button";
        settingsButton.className = "tgh-btn tgh-primary";
        settingsButton.textContent = "Game Hunting Settings";
        settingsButton.addEventListener("click", openSettingsModal);

        const monitorButton = document.createElement("button");
        monitorButton.type = "button";
        monitorButton.id = "tgh-monitor-toggle";
        monitorButton.className = "tgh-btn";
        monitorButton.addEventListener("click", () => {
            saveSettings({ ...settings, monitorOn: !settings.monitorOn });
            updateMonitorButton();
            reprocessAllRows("monitor-toggle");
        });

        toolbar.append(settingsButton, monitorButton);

        if (host === document.body) {
            host.prepend(toolbar);
        } else {
            host.insertBefore(toolbar, host.firstChild);
        }

        updateMonitorButton();
    }

    /* ============================================================
     * 14. EMBEDDED DONATION UI MODULE
     *     Adapted from Donation_UI_Module.user.js v1.4.
     *     Embedded in settings only; no second DOM observer needed.
     * ============================================================ */

    const DonationSettingsModule = (() => {
        const CONFIG = Object.freeze({
            bmcId: "bittick1c",
            tornUserId: "2954173",
            styleId: "tgh-donation-settings-style"
        });

        let coffeeInstance = 0;

        function injectStyles() {
            if (document.getElementById(CONFIG.styleId)) return;

            const style = document.createElement("style");
            style.id = CONFIG.styleId;
            style.textContent = `
                .tgh-support-controls {
                    display: grid;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    gap: 8px;
                    font-family: Arial, sans-serif;
                }

                .tgh-support-btn {
                    box-sizing: border-box;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    min-height: 40px;
                    padding: 10px 15px;
                    border-radius: 8px;
                    font-size: 13px;
                    font-weight: bold;
                    line-height: 1.2;
                    text-align: center;
                    text-decoration: none !important;
                    cursor: pointer;
                    user-select: none;
                    -webkit-tap-highlight-color: transparent;
                    touch-action: manipulation;
                }

                .tgh-support-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

                .tgh-bmc {
                    position: relative;
                    overflow: hidden;
                    isolation: isolate;
                    gap: 6px;
                    min-width: 0;
                    padding: 6px 12px;
                    background: #FFDD00;
                    color: #000 !important;
                    border: 1px solid #FFDD00;
                    border-radius: 6px;
                    font-size: 11px;
                    font-weight: 600;
                    transition: opacity .15s ease, transform .15s ease;
                }

                .tgh-bmc > * { position: relative; z-index: 1; }
                .tgh-bmc:hover { opacity: .9; }
                .tgh-bmc:active { transform: scale(.97); }

                @keyframes tgh-coffee-cup-hop {
                    0% { transform: translateY(0) scale(1,1); }
                    18% { transform: translateY(.5px) scale(1.08,.9); }
                    32% { transform: translateY(-2px) scale(.94,1.08); }
                    50% { transform: translateY(-3px) scale(1,1); }
                    68% { transform: translateY(0) scale(1.1,.88); }
                    84% { transform: translateY(0) scale(.97,1.03); }
                    100% { transform: translateY(0) scale(1,1); }
                }

                .tgh-coffee-cup {
                    position: relative;
                    display: inline-flex;
                    flex-shrink: 0;
                    transform-origin: 50% 100%;
                    animation: tgh-coffee-cup-hop 2.4s cubic-bezier(.4,0,.5,1) infinite;
                }

                .tgh-coffee-cup > svg { position: relative; z-index: 1; display: block; }

                .tgh-coffee-cup::before,
                .tgh-coffee-cup::after {
                    content: "";
                    position: absolute;
                    bottom: 74%;
                    width: 2px;
                    height: 4px;
                    border-radius: 999px;
                    background: linear-gradient(to top, rgba(90,58,36,.5), rgba(90,58,36,0));
                    opacity: 0;
                    pointer-events: none;
                    will-change: transform, opacity;
                }

                .tgh-coffee-cup::before { left: 27%; animation: tgh-coffee-steam 2.8s ease-out infinite; }
                .tgh-coffee-cup::after { left: 45%; animation: tgh-coffee-steam 2.8s ease-out infinite; animation-delay: -1.4s; }

                @keyframes tgh-coffee-steam {
                    0% { opacity: 0; transform: translateY(2px) scale(.6,.5) skewX(0); }
                    30% { opacity: .7; transform: translateY(0) scale(1,.9) skewX(4deg); }
                    65% { opacity: .4; transform: translateY(-3px) scale(.85,1.2) skewX(-5deg); }
                    100% { opacity: 0; transform: translateY(-5px) scale(.5,1.5) skewX(6deg); }
                }

                .tgh-coffee-fill {
                    transform: scaleY(.15);
                    transform-origin: 50% 100%;
                    animation: tgh-coffee-refill 7s cubic-bezier(.45,0,.55,1) infinite;
                }

                @keyframes tgh-coffee-refill {
                    0% { transform: scaleY(.15); }
                    30% { transform: scaleY(.95); }
                    55% { transform: scaleY(.75); }
                    80% { transform: scaleY(.3); }
                    100% { transform: scaleY(.15); }
                }

                .tgh-bmc:hover .tgh-coffee-fill {
                    animation: tgh-coffee-fill-to-full .45s cubic-bezier(.4,0,.2,1) forwards;
                }

                @keyframes tgh-coffee-fill-to-full { to { transform: scaleY(1); } }

                .tgh-bmc::after {
                    content: "";
                    position: absolute;
                    top: 0;
                    bottom: 0;
                    left: -60%;
                    width: 45%;
                    pointer-events: none;
                    background: linear-gradient(100deg, transparent 0%, rgba(255,255,255,.15) 35%, rgba(255,255,255,.75) 50%, rgba(255,255,255,.15) 65%, transparent 100%);
                    transform: skewX(-18deg);
                    will-change: transform;
                    animation: tgh-coffee-glare 5s cubic-bezier(.5,0,.5,1) infinite;
                }

                @keyframes tgh-coffee-glare {
                    0% { transform: translateX(0) skewX(-18deg); }
                    22%, 100% { transform: translateX(400%) skewX(-18deg); }
                }

                .tgh-coffee-label {
                    display: grid;
                    align-items: center;
                    justify-items: center;
                    min-width: 0;
                }

                .tgh-coffee-label > span {
                    grid-area: 1 / 1;
                    white-space: nowrap;
                    transform-origin: 50% 50%;
                    will-change: opacity, transform, filter;
                    animation: tgh-coffee-label-drip 7s cubic-bezier(.65,0,.35,1) infinite;
                }

                .tgh-coffee-label > span:nth-child(2) { animation-delay: -3.5s; }

                @keyframes tgh-coffee-label-drip {
                    0%, 34% { opacity: 1; transform: translateY(0) scale(1,1); filter: blur(0); }
                    38% { opacity: .5; transform: translateY(2px) scale(.94,1.08); filter: blur(1.2px); }
                    42% { opacity: 0; transform: translateY(9px) scale(1.06,.5); filter: blur(4px); }
                    42.01%, 92% { opacity: 0; transform: translateY(-9px) scale(1.06,.5); filter: blur(4px); }
                    96% { opacity: 1; transform: translateY(1px) scale(1.05,.9); filter: blur(0); }
                    98% { opacity: 1; transform: translateY(0) scale(.99,1.03); filter: blur(0); }
                    100% { opacity: 1; transform: translateY(0) scale(1,1); filter: blur(0); }
                }

                .tgh-torn-tip {
                    background: #8ab63d;
                    color: #fff !important;
                    border: 1px solid #6a8c2f;
                    box-shadow: 0 4px 6px rgba(0,0,0,.3);
                    transition: transform .2s ease, background-color .2s ease;
                }

                .tgh-torn-tip:active { transform: scale(.95); }

                @media (max-width: 520px) {
                    .tgh-support-controls { grid-template-columns: 1fr; }
                    .tgh-support-btn { width: 100%; }
                }

                @media (prefers-reduced-motion: reduce) {
                    .tgh-coffee-cup,
                    .tgh-coffee-cup::before,
                    .tgh-coffee-cup::after,
                    .tgh-coffee-fill,
                    .tgh-coffee-label > span,
                    .tgh-bmc::after { animation: none; }
                    .tgh-coffee-fill { transform: scaleY(.8); }
                    .tgh-coffee-label > span { opacity: 0; filter: none; transform: none; }
                    .tgh-coffee-label > span:nth-child(2) { opacity: 1; }
                }
            `;

            (document.head || document.documentElement).appendChild(style);
        }

        function buildCoffeeButton() {
            coffeeInstance += 1;
            const clipId = `tgh-coffee-clip-${coffeeInstance}`;
            const namespace = "http://www.w3.org/2000/svg";

            const link = document.createElement("a");
            link.className = "tgh-support-btn tgh-bmc";
            link.href = `https://www.buymeacoffee.com/${encodeURIComponent(CONFIG.bmcId)}`;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.title = "Support ThaWookie";
            link.setAttribute("aria-label", "Buy me a coffee — support ThaWookie");

            const cup = document.createElement("span");
            cup.className = "tgh-coffee-cup";
            cup.setAttribute("aria-hidden", "true");

            const svg = document.createElementNS(namespace, "svg");
            svg.setAttribute("width", "16");
            svg.setAttribute("height", "16");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("fill", "none");
            svg.setAttribute("stroke", "currentColor");
            svg.setAttribute("stroke-width", "1.5");

            const defs = document.createElementNS(namespace, "defs");
            const clipPath = document.createElementNS(namespace, "clipPath");
            clipPath.setAttribute("id", clipId);
            const clipShape = document.createElementNS(namespace, "path");
            clipShape.setAttribute("d", "M5 8h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8z");
            clipPath.appendChild(clipShape);
            defs.appendChild(clipPath);
            svg.appendChild(defs);

            const coffeeFill = document.createElementNS(namespace, "rect");
            coffeeFill.setAttribute("class", "tgh-coffee-fill");
            coffeeFill.setAttribute("x", "5");
            coffeeFill.setAttribute("y", "8");
            coffeeFill.setAttribute("width", "11");
            coffeeFill.setAttribute("height", "9");
            coffeeFill.setAttribute("fill", "#6f4e37");
            coffeeFill.setAttribute("stroke", "none");
            coffeeFill.setAttribute("clip-path", `url(#${clipId})`);
            svg.appendChild(coffeeFill);

            const body = document.createElementNS(namespace, "path");
            body.setAttribute("stroke-linecap", "round");
            body.setAttribute("stroke-linejoin", "round");
            body.setAttribute("d", "M5 8h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8z");
            svg.appendChild(body);

            const handle = document.createElementNS(namespace, "path");
            handle.setAttribute("stroke-linecap", "round");
            handle.setAttribute("stroke-linejoin", "round");
            handle.setAttribute("d", "M16 9h2.5a2.5 2.5 0 0 1 0 5H16");
            svg.appendChild(handle);

            cup.appendChild(svg);
            link.appendChild(cup);

            const label = document.createElement("span");
            label.className = "tgh-coffee-label";
            label.setAttribute("aria-hidden", "true");

            const first = document.createElement("span");
            first.textContent = "Support the project?";
            const second = document.createElement("span");
            second.textContent = "Buy me a coffee";

            label.append(first, second);
            link.appendChild(label);
            return link;
        }

        function buildTornTipButton() {
            const link = document.createElement("a");
            link.className = "tgh-support-btn tgh-torn-tip";
            link.href = "https://www.torn.com/item.php";
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.title = `Opens Items — search \"Xanax\", tap Send, enter ThaWookie [${CONFIG.tornUserId}]`;
            link.setAttribute("aria-label", `Send a Xanax tip to ThaWookie [${CONFIG.tornUserId}]`);
            link.textContent = "💊 Send a Xanax Tip";
            return link;
        }

        function mount(target) {
            if (!target) return;
            injectStyles();
            target.replaceChildren();

            const controls = document.createElement("div");
            controls.className = "tgh-support-controls";
            controls.append(buildCoffeeButton(), buildTornTipButton());
            target.appendChild(controls);
        }

        return Object.freeze({ mount });
    })();

    /* ============================================================
     * 15. SETTINGS MODAL / TEST EXTRACTION
     * ============================================================ */

    let modalKeyHandler = null;

    function closeSettingsModal() {
        if (modalKeyHandler) {
            document.removeEventListener("keydown", modalKeyHandler);
            modalKeyHandler = null;
        }
        const backdrop = document.getElementById("tgh-modal-backdrop");
        if (backdrop) backdrop.remove();
    }

    function createCheckboxRow(id, labelText) {
        const label = document.createElement("label");
        label.setAttribute("for", id);
        label.textContent = labelText;

        const wrapper = document.createElement("div");
        wrapper.className = "tgh-check";

        const input = document.createElement("input");
        input.type = "checkbox";
        input.id = id;

        wrapper.appendChild(input);
        return { label, wrapper, input };
    }

    function addNumberSetting(grid, id, labelText, value) {
        const label = document.createElement("label");
        label.setAttribute("for", id);
        label.textContent = labelText;

        const input = document.createElement("input");
        input.type = "number";
        input.id = id;
        input.min = "0";
        input.step = "1";
        input.value = String(value);

        grid.append(label, input);
        return input;
    }

    function openSettingsModal() {
        if (!document.body || document.getElementById("tgh-modal-backdrop")) return;
        injectMainStyles();

        const backdrop = document.createElement("div");
        backdrop.id = "tgh-modal-backdrop";
        backdrop.dataset.tghUi = "1";

        const modal = document.createElement("section");
        modal.id = "tgh-modal";
        modal.dataset.tghUi = "1";
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");
        modal.setAttribute("aria-labelledby", "tgh-modal-title");

        const title = document.createElement("h2");
        title.id = "tgh-modal-title";
        title.textContent = "Game Hunting Settings";

        const version = document.createElement("div");
        version.className = "tgh-version";
        version.textContent = `${SCRIPT_NAME} v${SCRIPT_VERSION}`;

        const filterHeading = document.createElement("h3");
        filterHeading.textContent = "Target Filters";

        const grid = document.createElement("div");
        grid.className = "tgh-setting-grid";

        const minFF = addNumberSetting(grid, "tgh-min-ff", "Minimum FF score", settings.minFF);
        const maxFF = addNumberSetting(grid, "tgh-max-ff", "Maximum FF score", settings.maxFF);
        const minStat = addNumberSetting(grid, "tgh-min-stat", "Minimum stat estimate", settings.minStat);
        const maxStat = addNumberSetting(grid, "tgh-max-stat", "Maximum stat estimate", settings.maxStat);
        const minBet = addNumberSetting(grid, "tgh-min-bet", "Minimum bet / pot", settings.minBet);

        const knownFF = createCheckboxRow("tgh-known-ff", "Require a known FF score");
        knownFF.input.checked = settings.requireKnownFF;
        grid.append(knownFF.label, knownFF.wrapper);

        const knownStats = createCheckboxRow("tgh-known-stats", "Require a known stat estimate");
        knownStats.input.checked = settings.requireKnownStats;
        grid.append(knownStats.label, knownStats.wrapper);

        const monitor = createCheckboxRow("tgh-monitor-on", "Hide non-matching rows");
        monitor.input.checked = settings.monitorOn;
        grid.append(monitor.label, monitor.wrapper);

        const recent = createCheckboxRow("tgh-show-recent", "Show recent matching winners panel");
        recent.input.checked = settings.showRecentWinners;
        grid.append(recent.label, recent.wrapper);

        const testCount = addNumberSetting(grid, "tgh-test-count", "Test extraction row count", settings.testExtractionCount);
        testCount.max = "50";

        const includeHtml = createCheckboxRow("tgh-include-html", "Include full row HTML in test output");
        includeHtml.input.checked = settings.includeFullRowHTML;
        grid.append(includeHtml.label, includeHtml.wrapper);

        const diagnosticsHeading = document.createElement("h3");
        diagnosticsHeading.textContent = "Diagnostics";

        const diagnostics = document.createElement("div");
        diagnostics.className = "tgh-diagnostics";

        const testButton = document.createElement("button");
        testButton.type = "button";
        testButton.className = "tgh-btn";
        testButton.textContent = "Run Test Extraction";

        const debugButton = document.createElement("button");
        debugButton.type = "button";
        debugButton.className = "tgh-btn";
        debugButton.textContent = "🪲";
        debugButton.title = "Toggle debugger";
        debugButton.setAttribute("aria-label", "Toggle debugger");
        debugButton.addEventListener("click", () => MyDebug.toggleView());

        const copyButton = document.createElement("button");
        copyButton.type = "button";
        copyButton.className = "tgh-btn";
        copyButton.textContent = "📋 Copy Logs to Clipboard";
        copyButton.addEventListener("click", function () {
            void MyDebug.copy(this);
        });

        diagnostics.append(testButton, debugButton, copyButton);

        const output = document.createElement("pre");
        output.id = "tgh-test-output";
        output.textContent = "Run Test Extraction to inspect the currently detected rows.";

        const architectureNote = document.createElement("div");
        architectureNote.className = "tgh-note";
        architectureNote.textContent = "v1.5.0 is DOM-only: no Torn API key, no polling, no automated attack or game action. It reacts to Torn/FFScouter DOM changes and only opens a profile for manual action.";

        const supportHeading = document.createElement("h3");
        supportHeading.textContent = "Support Development";

        const supportSlot = document.createElement("div");
        supportSlot.className = "tgh-support-slot";
        DonationSettingsModule.mount(supportSlot);

        const actions = document.createElement("div");
        actions.className = "tgh-actions";

        const resetButton = document.createElement("button");
        resetButton.type = "button";
        resetButton.className = "tgh-btn";
        resetButton.textContent = "Reset Defaults";

        const saveButton = document.createElement("button");
        saveButton.type = "button";
        saveButton.className = "tgh-btn tgh-primary";
        saveButton.textContent = "Save";

        const closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.className = "tgh-btn";
        closeButton.textContent = "Close";

        actions.append(resetButton, saveButton, closeButton);

        modal.append(
            title,
            version,
            filterHeading,
            grid,
            diagnosticsHeading,
            diagnostics,
            output,
            architectureNote,
            supportHeading,
            supportSlot,
            actions
        );
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);

        backdrop.addEventListener("click", (event) => {
            if (event.target === backdrop) closeSettingsModal();
        });

        modalKeyHandler = (event) => {
            if (event.key === "Escape") {
                closeSettingsModal();
            }
        };
        document.addEventListener("keydown", modalKeyHandler);

        testButton.addEventListener("click", () => {
            runTestExtraction(output, {
                count: finiteNumber(testCount.value, settings.testExtractionCount, 1, 50),
                includeHTML: includeHtml.input.checked
            });
        });

        resetButton.addEventListener("click", () => {
            minFF.value = String(DEFAULTS.minFF);
            maxFF.value = String(DEFAULTS.maxFF);
            minStat.value = String(DEFAULTS.minStat);
            maxStat.value = String(DEFAULTS.maxStat);
            minBet.value = String(DEFAULTS.minBet);
            knownFF.input.checked = DEFAULTS.requireKnownFF;
            knownStats.input.checked = DEFAULTS.requireKnownStats;
            monitor.input.checked = DEFAULTS.monitorOn;
            recent.input.checked = DEFAULTS.showRecentWinners;
            testCount.value = String(DEFAULTS.testExtractionCount);
            includeHtml.input.checked = DEFAULTS.includeFullRowHTML;
        });

        saveButton.addEventListener("click", () => {
            saveSettings({
                minFF: minFF.value,
                maxFF: maxFF.value,
                minStat: minStat.value,
                maxStat: maxStat.value,
                minBet: minBet.value,
                requireKnownFF: knownFF.input.checked,
                requireKnownStats: knownStats.input.checked,
                monitorOn: monitor.input.checked,
                showRecentWinners: recent.input.checked,
                testExtractionCount: testCount.value,
                includeFullRowHTML: includeHtml.input.checked
            });

            if (active) ensureRecentWinnersPanel();
            updateMonitorButton();
            reprocessAllRows("settings-save");
            debugLog("INFO", "Settings saved.", settings);
            closeSettingsModal();
        });

        closeButton.addEventListener("click", () => {
            closeSettingsModal();
        });

        saveButton.focus();
    }

    function runTestExtraction(output, options = {}) {
        if (!output) return;

        const root = getContentRoot();
        const rows = Array.from(collectRowsFromRegion(root)).slice(0, options.count || settings.testExtractionCount);

        if (!rows.length) {
            output.textContent = "No candidate Russian Roulette rows were found. Keep the lobby visible, then run the test again.";
            debugLog("WARN", "Test extraction found no rows.");
            return;
        }

        const report = rows.map((row, index) => {
            const meta = evaluateRow(row);
            const outcome = detectGameOutcomeForRow(row);
            const record = {
                index: index + 1,
                xid: meta.uid,
                displayName: meta.displayName,
                ff: Number.isFinite(meta.ff) ? meta.ff : "unknown",
                stats: Number.isFinite(meta.stats) ? meta.stats : "unknown",
                potOrBet: Number.isFinite(meta.pot) ? meta.pot : "unknown",
                passesFilters: meta.passes,
                filterParts: {
                    ff: meta.passFF,
                    stats: meta.passStats,
                    bet: meta.passBet
                },
                outcome: outcome || "unknown",
                sources: meta.sources.slice(0, 8),
                textSnippet: normalizeText(row.textContent).slice(0, 300)
            };

            if (options.includeHTML) {
                record.rowHTML = row.innerHTML;
            }

            return record;
        });

        output.textContent = JSON.stringify(report, null, 2);
        debugLog("INFO", "Test extraction complete.", {
            rows: report.length,
            includeHTML: Boolean(options.includeHTML)
        });
    }

    /* ============================================================
     * 16. REPROCESS / CLEANUP
     * ============================================================ */

    function reprocessAllRows(reason = "manual") {
        if (!active) return;
        const rows = collectRowsFromRegion(getContentRoot());
        processRows(rows, reason);
    }

    function removeInjectedUi() {
        for (const selector of ["#tgh-toolbar", "#tgh-recent-winners", "#tgh-modal-backdrop"]) {
            const node = document.querySelector(selector);
            if (node) node.remove();
        }
        recentWinnerNodes.clear();
    }

    function restoreProcessedRows() {
        const root = getContentRoot();
        if (!root || !root.querySelectorAll) return;

        for (const row of root.querySelectorAll(".tgh-filter-miss, .tgh-filter-pass, .tgh-winner, .tgh-loser")) {
            const state = rowState.get(row);
            if (state) restoreRowDisplay(row, state);
            row.classList.remove("tgh-filter-miss", "tgh-filter-pass", "tgh-winner", "tgh-loser");
            removeAttackLink(row);
        }
    }

    /* ============================================================
     * 17. ROUTE LIFECYCLE
     * ============================================================ */

    function activate(reason = "route") {
        if (active || !document.body || !isTargetRoute()) return;

        active = true;
        injectMainStyles();
        ensureToolbar();
        ensureRecentWinnersPanel();
        processInitialRows();
        startPageObserver();

        debugLog("INFO", "Game Hunting activated.", {
            reason,
            url: window.location.href,
            version: SCRIPT_VERSION
        });
    }

    function deactivate(reason = "route") {
        if (!active) return;

        stopPageObserver();
        restoreProcessedRows();
        removeInjectedUi();
        active = false;

        debugLog("INFO", "Game Hunting deactivated.", {
            reason,
            url: window.location.href
        });
    }

    function handleRouteChange(reason = "history") {
        if (!document.body) return;
        if (isTargetRoute()) activate(reason);
        else deactivate(reason);
    }

    function installHistoryHooks() {
        for (const method of ["pushState", "replaceState"]) {
            const original = history[method];
            if (typeof original !== "function" || original.__tghWrapped) continue;

            const wrapped = function (...args) {
                const before = window.location.href;
                const result = original.apply(this, args);
                if (window.location.href !== before) {
                    handleRouteChange(`history.${method}`);
                }
                return result;
            };

            Object.defineProperty(wrapped, "__tghWrapped", {
                value: true,
                configurable: false,
                enumerable: false,
                writable: false
            });

            history[method] = wrapped;
        }

        window.addEventListener("popstate", () => handleRouteChange("popstate"));
        window.addEventListener("hashchange", () => handleRouteChange("hashchange"));
    }

    function bootstrap() {
        installHistoryHooks();
        GMCompat.registerMenu("Game Hunting Settings", openSettingsModal);
        GMCompat.registerMenu("Toggle Game Hunting Debugger", () => MyDebug.toggleView());

        if (document.body) {
            handleRouteChange("bootstrap");
            return;
        }

        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", () => handleRouteChange("DOMContentLoaded"), { once: true });
        }
    }

    bootstrap();
})();

/* ========================================================================
 * MANDATORY MODULAR DEBUGGER MODULE
 * Source: userscript-debugger-module.js v1.0.2
 * Appended verbatim below (except no metadata block was present in source).
 * ======================================================================== */
/**
 * File: userscript-debugger-module.js
 * Version: 1.0.2
 * Advanced Modular Userscript Debugger Engine
 * Author: Github.com/ShavedW00kie/
 * Optimized for Desktop PC, Mobile Browsers, and TornPDA Native WebViews
 *
 * License: BSD-3-Clause
 *
 * Copyright (c) 2026 ShavedW00kie
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * initializeModularDebugger()
 *
 * Creates an isolated debugger instance for a userscript.
 *
 * Public API:
 *   MyDebug.log(message)
 *   MyDebug.info(message)
 *   MyDebug.warn(message)
 *   MyDebug.error(message)
 *   MyDebug.copy(buttonElement)
 *   MyDebug.toggleView()
 *   MyDebug.clear()
 *
 * Example:
 *
 * const MyDebug = initializeModularDebugger(GM_info.script.name);
 *
 * MyDebug.log("Script initialized.");
 * MyDebug.error("Something went wrong.");
 *
 * // Settings UI:
 * debugButton.onclick = () => MyDebug.toggleView();
 * copyButton.onclick = function () {
 *     MyDebug.copy(this);
 * };
 */
function initializeModularDebugger(scriptNamespace) {
    "use strict";

    if (typeof scriptNamespace === "undefined") {
        scriptNamespace = "App";
    }

    /* ============================================================
     * 1. INSTANCE ISOLATION
     * ============================================================ */

    const randomSuffix = (() => {
        try {
            if (
                typeof crypto !== "undefined" &&
                typeof crypto.randomUUID === "function"
            ) {
                return crypto.randomUUID().replace(/-/g, "");
            }
        } catch (_) {
            // Fall through to compatibility fallback.
        }

        return Math.random()
            .toString(36)
            .slice(2, 11) +
            Date.now().toString(36);
    })();

    const prefix = `us-debug-${randomSuffix}`;

    const CONTAINER_ID = `${prefix}-box`;
    const LOG_AREA_ID = `${prefix}-logs`;

    /* ============================================================
     * 2. MEMORY LIMITS
     * ============================================================ */

    /*
     * Clipboard-safe baseline.
     *
     * JavaScript strings are UTF-16. This limit is intentionally
     * character-based rather than byte-based because browser clipboard
     * implementations differ in their handling of Unicode.
     */
    const CLIPBOARD_MAX_CHARS = 10 * 1024 * 1024;

    /*
     * Reserve approximately 900 KiB of headroom.
     *
     * Effective maximum retained log buffer:
     * approximately 9.1 million characters.
     */
    const BUFFER_REDUCTION_MARGIN = 900 * 1024;

    const MAX_LOG_STRING_LENGTH =
        CLIPBOARD_MAX_CHARS - BUFFER_REDUCTION_MARGIN;

    /*
     * Never allow one pathological message to exceed the entire
     * configured buffer.
     */
    const MAX_SINGLE_LOG_LENGTH = MAX_LOG_STRING_LENGTH;

    /* ============================================================
     * 3. INTERNAL STATE
     * ============================================================ */

    const state = {
        logs: [],
        currentBufferLength: 0,

        domElements: {
            container: null,
            logArea: null
        },

        observer: null,
        observerAttached: false,

        destroyed: false
    };

    /* ============================================================
     * 4. DOM UTILITIES
     * ============================================================ */

    function getDocumentBody() {
        return document && document.body
            ? document.body
            : null;
    }

    function getExistingContainer() {
        return document.getElementById(CONTAINER_ID);
    }

    function isContainerAttached() {
        return Boolean(
            state.domElements.container &&
            state.domElements.container.isConnected
        );
    }

    function ensureObserver() {
        if (
            state.observerAttached ||
            typeof MutationObserver === "undefined"
        ) {
            return;
        }

        const body = getDocumentBody();

        if (!body) {
            return;
        }

        state.observer = new MutationObserver(() => {
            /*
             * Do not continuously recreate the UI.
             *
             * If the user intentionally hides the debugger, the
             * element still exists and therefore remains untouched.
             *
             * If Torn or another page lifecycle removes the element,
             * the internal references are invalidated so the next
             * toggleView() can recreate it safely.
             */
            if (
                state.domElements.container &&
                !state.domElements.container.isConnected
            ) {
                state.domElements.container = null;
                state.domElements.logArea = null;
            }
        });

        state.observer.observe(body, {
            childList: true,
            subtree: true
        });

        state.observerAttached = true;
    }

    function appendToBody(element) {
        const body = getDocumentBody();

        if (!body || !element) {
            return false;
        }

        body.appendChild(element);
        return true;
    }

    /* ============================================================
     * 5. SAFE SERIALIZATION
     * ============================================================ */

    function safeSerialize(value) {
        /*
         * Fast path for strings.
         */
        if (typeof value === "string") {
            return value;
        }

        /*
         * Primitive values.
         */
        if (
            value === null ||
            typeof value === "number" ||
            typeof value === "boolean" ||
            typeof value === "bigint"
        ) {
            try {
                return String(value);
            } catch (_) {
                return "[Unserializable Primitive]";
            }
        }

        if (typeof value === "undefined") {
            return "undefined";
        }

        if (typeof value === "symbol") {
            try {
                return value.toString();
            } catch (_) {
                return "[Symbol]";
            }
        }

        if (typeof value === "function") {
            try {
                return `[Function: ${value.name || "anonymous"}]`;
            } catch (_) {
                return "[Function]";
            }
        }

        /*
         * Error objects deserve special handling because
         * JSON.stringify(new Error()) normally returns "{}".
         */
        if (value instanceof Error) {
            const errorObject = {
                name: value.name,
                message: value.message,
                stack: value.stack
            };

            try {
                return JSON.stringify(errorObject);
            } catch (_) {
                return `${value.name || "Error"}: ${value.message || ""}`;
            }
        }

        /*
         * General objects.
         *
         * WeakSet prevents circular-reference crashes.
         */
        try {
            const seen = new WeakSet();

            const serialized = JSON.stringify(
                value,
                (key, nestedValue) => {
                    if (typeof nestedValue === "bigint") {
                        return `${nestedValue}n`;
                    }

                    if (typeof nestedValue === "undefined") {
                        return "[undefined]";
                    }

                    if (
                        typeof nestedValue === "object" &&
                        nestedValue !== null
                    ) {
                        if (seen.has(nestedValue)) {
                            return "[Circular]";
                        }

                        seen.add(nestedValue);
                    }

                    return nestedValue;
                }
            );

            if (typeof serialized === "string") {
                return serialized;
            }
        } catch (_) {
            // Fall through to String() fallback.
        }

        try {
            return String(value);
        } catch (_) {
            return "[Serialization Error]";
        }
    }

    /* ============================================================
     * 6. LOG ENTRY MANAGEMENT
     * ============================================================ */

    function truncateLogEntry(entry) {
        if (entry.length <= MAX_SINGLE_LOG_LENGTH) {
            return entry;
        }

        return (
            entry.slice(0, MAX_SINGLE_LOG_LENGTH - 40) +
            "\n...[LOG ENTRY TRUNCATED]..."
        );
    }

    function pruneBufferForEntry(entryLength) {
        while (
            state.logs.length > 0 &&
            state.currentBufferLength + entryLength >
                MAX_LOG_STRING_LENGTH
        ) {
            const removed = state.logs.shift();

            if (typeof removed === "string") {
                state.currentBufferLength -= removed.length + 1;
            }
        }

        /*
         * Defensive correction against any impossible negative state
         * caused by external mutation or future implementation changes.
         */
        if (state.currentBufferLength < 0) {
            state.currentBufferLength = 0;
        }
    }

    function renderLogs() {
        const logArea = state.domElements.logArea;

        if (!logArea || !logArea.isConnected) {
            return;
        }

        logArea.textContent = state.logs.join("\n");

        const container = state.domElements.container;

        if (container && container.isConnected) {
            container.scrollTop = container.scrollHeight;
        }
    }

    /* ============================================================
     * 7. PUBLIC LOGGING ENGINE
     * ============================================================ */

    function log(message, level = "INFO") {
        const time = new Date().toLocaleTimeString();

        let cleanMessage = safeSerialize(message);

        cleanMessage = truncateLogEntry(cleanMessage);

        const normalizedLevel =
            typeof level === "string"
                ? level.toUpperCase()
                : "INFO";

        let entry =
            `[${time}] [${normalizedLevel}] ${cleanMessage}`;

        entry = truncateLogEntry(entry);

        const entryLength = entry.length + 1;

        /*
         * If the entry is somehow still too large, do not store it.
         */
        if (entry.length > MAX_LOG_STRING_LENGTH) {
            return;
        }

        pruneBufferForEntry(entryLength);

        state.logs.push(entry);
        state.currentBufferLength += entryLength;

        renderLogs();
    }

    function info(message) {
        log(message, "INFO");
    }

    function warn(message) {
        log(message, "WARN");
    }

    function error(message) {
        log(message, "ERROR");
    }

    /* ============================================================
     * 8. CLEAR LOGS
     * ============================================================ */

    function clearLogs() {
        state.logs.length = 0;
        state.currentBufferLength = 0;

        renderLogs();
    }

    /* ============================================================
     * 9. COPY STATUS UI
     * ============================================================ */

    function setButtonStatus(button, text, statusClass = "") {
        if (!button) {
            return;
        }

        button.textContent = text;

        if (statusClass) {
            button.dataset.debugStatus = statusClass;
        } else {
            delete button.dataset.debugStatus;
        }
    }

    /*
     * Restore button state without using a timer.
     *
     * CSS animation provides the delay and animationend restores
     * the original label. This avoids setTimeout-based state handling.
     */
    function prepareStatusAnimation(button) {
        if (!button) {
            return;
        }

        if (button.dataset.debugStatusListener === "1") {
            return;
        }

        button.dataset.debugStatusListener = "1";

        button.addEventListener("animationend", (event) => {
            if (event.animationName !== "us-debug-status-reset") {
                return;
            }

            const originalText =
                button.dataset.debugOriginalText || "Copy Logs";

            button.textContent = originalText;

            delete button.dataset.debugStatus;
        });
    }

    function showCopyStatus(button, text, originalText = null) {
        if (!button) {
            return;
        }

        prepareStatusAnimation(button);

        if (originalText) {
            button.dataset.debugOriginalText = originalText;
        } else if (!button.dataset.debugOriginalText) {
            button.dataset.debugOriginalText =
                button.textContent || "Copy Logs";
        }

        button.classList.remove("us-debug-status-reset");

        /*
         * Force animation restart without a timing delay.
         */
        void button.offsetWidth;

        button.textContent = text;
        button.classList.add("us-debug-status-reset");
    }

    /* ============================================================
     * 10. CLIPBOARD ENGINE
     * ============================================================ */

    async function copyLogs(buttonElement = null) {
        const payload = state.logs.join("\n");

        if (!payload) {
            showCopyStatus(buttonElement, "Empty!");
            return false;
        }

        /*
         * Preferred modern clipboard implementation.
         */
        if (
            typeof navigator !== "undefined" &&
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === "function"
        ) {
            try {
                await navigator.clipboard.writeText(payload);

                showCopyStatus(buttonElement, "Copied!");

                return true;
            } catch (_) {
                /*
                 * Continue into compatibility fallback.
                 */
            }
        }

        /*
         * Legacy compatibility path.
         *
         * Still useful for restricted userscript environments,
         * embedded WebViews, and older browser implementations.
         */
        const success = handleCopyFallback(payload);

        if (success) {
            showCopyStatus(buttonElement, "Copied!");
            return true;
        }

        showCopyStatus(buttonElement, "Failed!");
        return false;
    }

    function handleCopyFallback(textData) {
        try {
            const body = getDocumentBody();

            if (!body) {
                return false;
            }

            const textarea = document.createElement("textarea");

            textarea.value = textData;

            textarea.setAttribute("readonly", "");
            textarea.style.position = "fixed";
            textarea.style.top = "0";
            textarea.style.left = "0";
            textarea.style.width = "1px";
            textarea.style.height = "1px";
            textarea.style.padding = "0";
            textarea.style.border = "0";
            textarea.style.outline = "0";
            textarea.style.boxShadow = "none";
            textarea.style.background = "transparent";
            textarea.style.opacity = "0";

            body.appendChild(textarea);

            textarea.focus();
            textarea.select();

            /*
             * iOS/WebView compatibility.
             */
            try {
                textarea.setSelectionRange(
                    0,
                    textarea.value.length
                );
            } catch (_) {
                // Not supported in every environment.
            }

            let success = false;

            try {
                success = document.execCommand("copy");
            } catch (_) {
                success = false;
            }

            textarea.remove();

            return Boolean(success);
        } catch (copyError) {
            /*
             * Logging the failure is intentionally done without
             * console.error so the module never reintroduces the
             * native console logging that the architecture is
             * designed to replace.
             */
            error({
                operation: "clipboard-fallback",
                message:
                    copyError && copyError.message
                        ? copyError.message
                        : String(copyError)
            });

            return false;
        }
    }

    /* ============================================================
     * 11. DEBUGGER UI
     * ============================================================ */

    function injectStyles() {
        if (document.getElementById(`${prefix}-style`)) {
            return;
        }

        const styleNode = document.createElement("style");

        styleNode.id = `${prefix}-style`;

        styleNode.textContent = `
            @keyframes us-debug-status-reset {
                from {
                    opacity: 0.75;
                }
                to {
                    opacity: 1;
                }
            }

            #${CONTAINER_ID} .us-debug-status-reset {
                animation: us-debug-status-reset 1.5s ease-in-out 1;
            }
        `;

        const head = document.head;

        if (head) {
            head.appendChild(styleNode);
        } else {
            const body = getDocumentBody();

            if (body) {
                body.appendChild(styleNode);
            }
        }
    }

    function createDebuggerContainer() {
        const body = getDocumentBody();

        if (!body) {
            return null;
        }

        const existingContainer = getExistingContainer();

        if (existingContainer) {
            state.domElements.container = existingContainer;

            const existingLogArea =
                document.getElementById(LOG_AREA_ID);

            state.domElements.logArea = existingLogArea;

            renderLogs();

            return existingContainer;
        }

        injectStyles();

        const container = document.createElement("div");

        container.id = CONTAINER_ID;

        container.style.cssText = [
            "position:fixed",
            "bottom:12px",
            "right:12px",
            "width:calc(100% - 24px)",
            "max-width:420px",
            "height:280px",
            "background:#181818",
            "color:#00ff66",
            "font-family:monospace",
            "font-size:11px",
            "padding:12px",
            "z-index:2147483647",
            "border:1px solid #00ff66",
            "overflow-y:auto",
            "overflow-x:hidden",
            "box-shadow:0 4px 20px rgba(0,0,0,0.7)",
            "border-radius:4px",
            "box-sizing:border-box",
            "touch-action:pan-y"
        ].join(";");

        const header = document.createElement("div");

        header.style.cssText = [
            "display:flex",
            "justify-content:space-between",
            "align-items:center",
            "gap:8px",
            "margin-bottom:8px",
            "border-bottom:1px solid #333",
            "padding-bottom:5px",
            "user-select:none"
        ].join(";");

        const title = document.createElement("span");

        title.textContent =
            `DEBUG LOG [${String(scriptNamespace)}]`;

        title.style.cssText = [
            "font-weight:bold",
            "letter-spacing:0.5px",
            "overflow:hidden",
            "text-overflow:ellipsis",
            "white-space:nowrap"
        ].join(";");

        const buttonGroup = document.createElement("div");

        buttonGroup.style.cssText = [
            "display:flex",
            "gap:6px",
            "flex-shrink:0"
        ].join(";");

        const copyBtn = document.createElement("button");

        copyBtn.type = "button";
        copyBtn.textContent = "Copy";
        copyBtn.style.cssText = [
            "background:#2a2a2a",
            "color:#fff",
            "border:1px solid #444",
            "cursor:pointer",
            "padding:5px 8px",
            "font-size:10px",
            "border-radius:3px",
            "touch-action:manipulation"
        ].join(";");

        copyBtn.addEventListener("click", () => {
            void copyLogs(copyBtn);
        });

        const clearBtn = document.createElement("button");

        clearBtn.type = "button";
        clearBtn.textContent = "Clear";
        clearBtn.style.cssText = [
            "background:#2a2a2a",
            "color:#fff",
            "border:1px solid #444",
            "cursor:pointer",
            "padding:5px 8px",
            "font-size:10px",
            "border-radius:3px",
            "touch-action:manipulation"
        ].join(";");

        clearBtn.addEventListener("click", () => {
            clearLogs();
        });

        const closeBtn = document.createElement("button");

        closeBtn.type = "button";
        closeBtn.textContent = "Hide";
        closeBtn.style.cssText = [
            "background:#a82020",
            "color:#fff",
            "border:none",
            "cursor:pointer",
            "padding:5px 8px",
            "font-size:10px",
            "border-radius:3px",
            "touch-action:manipulation"
        ].join(";");

        closeBtn.addEventListener("click", () => {
            container.style.display = "none";
        });

        const logArea = document.createElement("div");

        logArea.id = LOG_AREA_ID;

        logArea.style.cssText = [
            "white-space:pre-wrap",
            "overflow-wrap:anywhere",
            "word-break:break-word",
            "font-family:monospace",
            "line-height:1.4",
            "user-select:text"
        ].join(";");

        buttonGroup.appendChild(copyBtn);
        buttonGroup.appendChild(clearBtn);
        buttonGroup.appendChild(closeBtn);

        header.appendChild(title);
        header.appendChild(buttonGroup);

        container.appendChild(header);
        container.appendChild(logArea);

        if (!appendToBody(container)) {
            return null;
        }

        state.domElements.container = container;
        state.domElements.logArea = logArea;

        renderLogs();

        return container;
    }

    /* ============================================================
     * 12. VIEW TOGGLE
     * ============================================================ */

    function toggleConsoleView() {
        const existingContainer = getExistingContainer();

        if (existingContainer) {
            state.domElements.container = existingContainer;

            const existingLogArea =
                document.getElementById(LOG_AREA_ID);

            state.domElements.logArea = existingLogArea;

            const isHidden =
                existingContainer.style.display === "none";

            existingContainer.style.display =
                isHidden ? "block" : "none";

            if (isHidden) {
                renderLogs();
            }

            ensureObserver();

            return;
        }

        const container = createDebuggerContainer();

        if (container) {
            container.style.display = "block";
            renderLogs();
        }

        ensureObserver();
    }

    /* ============================================================
     * 13. INITIALIZATION
     * ============================================================ */

    function initialize() {
        if (state.destroyed) {
            return;
        }

        ensureObserver();

        /*
         * We intentionally do not use setTimeout/setInterval to wait
         * for Torn's DOM.
         *
         * If body already exists, initialization can proceed.
         * Otherwise DOMContentLoaded provides the one-time lifecycle
         * event required for early execution contexts.
         */
        if (getDocumentBody()) {
            return;
        }

        if (document.readyState === "loading") {
            document.addEventListener(
                "DOMContentLoaded",
                initialize,
                { once: true }
            );
        }
    }

    initialize();

    /* ============================================================
     * 14. PUBLIC API
     * ============================================================ */

    return Object.freeze({
        /*
         * Primary logging API.
         */
        log,

        /*
         * Structured convenience methods.
         */
        info,
        warn,
        error,

        /*
         * REQUIRED BY THE USERSCRIPT ARCHITECTURE.
         *
         * Future settings UI:
         * copyButton.onclick = function () {
         *     MyDebug.copy(this);
         * };
         */
        copy: copyLogs,

        /*
         * Debugger overlay.
         */
        toggleView: toggleConsoleView,

        /*
         * Optional maintenance operation.
         */
        clear: clearLogs
    });
}
