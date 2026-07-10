/// ============================================================
/// FILE   : extension/background.js
/// PURPOSE: MV3 service worker — syncs Claude + ChatGPT + Gemini usage roughly
///          every 60s, produces a snapshot + history + surface breakdown (delta
///          attribution), updates the badge. Also polls the local Claude Code collector.
/// STATUS : Phase 2 — multi-provider (Claude + ChatGPT + Gemini)
/// INDEX  :
///   [S1] constants + alarm setup (60s period; no 5s — PROJECT.md §4)
///   [S2] popup/strip message: "ailhq:refresh" → immediate sync + reply
///   [S3] sync() — adapters (parallel) + collector → snapshots → storage
///   [S4] fetchCollector() — http://127.0.0.1:41777/usage (silently null if absent)
///   [S5] recordDelta() — attribute the session-% increase to the active surface
///        surfaces: chat (claude.ai heartbeat) · code (collector) · other
///   [S6] updateBadge() — session remaining % + color spec (PROJECT.md §5)
/// NOTE   : Attribution is heuristic (60s resolution); the Code surface relies on
///          the collector's real-token signal when it's running. When the session
///          resets (used drops), the delta is skipped.
/// ============================================================

import { fetchClaudeUsage } from "./adapters/claude.js";
import { fetchChatGPTUsage } from "./adapters/chatgpt.js";
import { fetchGeminiUsage } from "./adapters/gemini.js";

/// [S1] constants + alarm setup
const STORAGE_KEY  = "ailhq_claude";
const CHATGPT_KEY  = "ailhq_chatgpt";
const GEMINI_KEY   = "ailhq_gemini";
const HISTORY_KEY  = "ailhq_history";       // [{t, s(used%), w(used%)}] — max 2880 (~2 days)
const ATTRIB_KEY   = "ailhq_attrib";        // [{t, d(points), surface}] — max 1000
const ACTIVITY_KEY = "ailhq_activity_chat"; // content-script heartbeat (ms)
const COLLECTOR_URL = "http://127.0.0.1:41777/usage";
const ALARM = "ailhq-sync";

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);

function schedule() {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  sync();
}

chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) sync(); });

/// [S2] immediate refresh request (popup + strip)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "ailhq:refresh") {
    // the requester (popup/tab) may have closed before the reply — swallow silently
    sync().then(s => { try { sendResponse(s); } catch { /* port closed */ } });
    return true; // async reply
  }
  if (msg && msg.type === "ailhq:open-dashboard") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  }
});

/// [S3] sync — providers in parallel; one failing doesn't affect the others
async function sync() {
  const [collector, gptSnap, gemSnap] = await Promise.all([
    fetchCollector(), snapOf(fetchChatGPTUsage), snapOf(fetchGeminiUsage)
  ]);
  let snap;
  try {
    const data = await fetchClaudeUsage();
    snap = { ok: true, updatedAt: Date.now(), data, collector };
  } catch (e) {
    snap = { ok: false, updatedAt: Date.now(), error: String((e && e.message) || e), collector };
  }
  if (snap.ok) await recordDelta(snap, collector);
  await chrome.storage.local.set({ [STORAGE_KEY]: snap, [CHATGPT_KEY]: gptSnap, [GEMINI_KEY]: gemSnap });
  updateBadge(snap);
  return snap;
}

// other providers: AUTH = not signed in to that site — normal case, silent snapshot
async function snapOf(fetcher) {
  try {
    return { ok: true, updatedAt: Date.now(), data: await fetcher() };
  } catch (e) {
    return { ok: false, updatedAt: Date.now(), error: String((e && e.message) || e) };
  }
}

/// [S4] local Claude Code collector (optional — null if not installed)
async function fetchCollector() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(COLLECTOR_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json(); // {active, tokens_5h, sessions}
  } catch {
    return null;
  }
}

/// [S5] delta attribution — write the session increase between two syncs to a surface
async function recordDelta(snap, collector) {
  const sess = snap.data.limits.find(l => l.window === "session");
  if (!sess) return;
  const week = snap.data.limits.find(l => l.window === "weekly");
  const used = 100 - sess.remaining;
  const now = Date.now();

  const st = await chrome.storage.local.get([HISTORY_KEY, ATTRIB_KEY, ACTIVITY_KEY]);
  const hist = st[HISTORY_KEY] || [];
  const attrib = st[ATTRIB_KEY] || [];
  const prev = hist[hist.length - 1];

  hist.push({ t: now, s: used, w: week ? 100 - week.remaining : null });
  while (hist.length > 2880) hist.shift();

  // attribute if there's an increase (used < prev.s = session reset → skip)
  if (prev && used > prev.s) {
    const chatActive = (st[ACTIVITY_KEY] || 0) > prev.t - 45000; // heartbeat every 30s, tolerance
    const codeActive = !!(collector && collector.active);
    const surface = chatActive && codeActive ? "chat+code"
                  : codeActive ? "code"
                  : chatActive ? "chat" : "other";
    attrib.push({ t: now, d: +(used - prev.s).toFixed(2), surface });
    while (attrib.length > 1000) attrib.shift();
  }

  await chrome.storage.local.set({ [HISTORY_KEY]: hist, [ATTRIB_KEY]: attrib });
}

/// [S6] badge — session remaining %; colors match token-reactor.html S1 (dark)
const BADGE_COLORS = [
  [80, "#2DA8FF"],  // FRESH
  [60, "#3FB950"],  // HEALTHY
  [40, "#E3B341"],  // WATCH
  [20, "#F0883E"],  // WARNING
  [0,  "#F85149"]   // CRITICAL
];

function updateBadge(snap) {
  if (!snap.ok) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#6E7681" });
    return;
  }
  const session = snap.data.limits.find(l => l.window === "session") || snap.data.limits[0];
  const rem = Math.round(session.remaining);
  const color = BADGE_COLORS.find(([min]) => rem >= min)[1];
  chrome.action.setBadgeText({ text: String(rem) });
  chrome.action.setBadgeBackgroundColor({ color });
}
