/// ============================================================
/// FILE   : extension/adapters/gemini.js
/// PURPOSE: Gemini (gemini.google.com) subscription-limit adapter — calls the
///          jSf9Qc WizRPC that backs the /usage page and maps it to the common format.
///          Schema: docs/endpoints.md (Gemini section, discovered 2026-07-10).
/// STATUS : Phase 2 — first version (verified on a Pro account; plan detection TODO)
/// INDEX  :
///   [S1] constants + token cache
///   [S2] getTokens() — extract at/bl/sid from the /usage HTML (regex)
///   [S3] callUsageRpc() — batchexecute POST + unwrap response
///   [S4] fetchGeminiUsage() — token → rpc (refresh once on stale token)
///   [S5] normalize() — positional array → {provider, plan, limits[]}
/// NOTE   : Tokens live in an in-memory cache, are NEVER written to storage (K5).
///          Window order is not fixed → match by type code (1=current, 2=weekly).
///          rpcids is obfuscated code — if Google changes it, rediscovery is needed.
/// ============================================================

/// [S1] constants + token cache
const BASE = "https://gemini.google.com";
let tokenCache = null; // {at, bl, sid} — for as long as the service worker lives

/// [S2] extract the WizRPC tokens from the /usage HTML
async function getTokens() {
  const res = await fetch(BASE + "/usage", { credentials: "include" });
  if (res.status === 401 || res.status === 403) throw new Error("AUTH");
  if (!res.ok) throw new Error("HTTP " + res.status);
  const html = await res.text();
  // not signed in → redirects to the Google login page, no WIZ data
  const pick = (key) => {
    const m = html.match(new RegExp('"' + key + '":"([^"]+)"'));
    return m ? m[1] : null;
  };
  const at = pick("SNlM0e"), bl = pick("cfb2h"), sid = pick("FdrFJe");
  if (!at) throw new Error("AUTH");
  return { at, bl, sid };
}

/// [S3] batchexecute call + unwrap the response envelope
async function callUsageRpc(tok) {
  const url = BASE + "/_/BardChatUi/data/batchexecute?rpcids=jSf9Qc&source-path=%2Fusage"
    + (tok.bl ? "&bl=" + encodeURIComponent(tok.bl) : "")
    + (tok.sid ? "&f.sid=" + encodeURIComponent(tok.sid) : "")
    + "&hl=en&_reqid=" + Math.floor(Math.random() * 900000 + 100000) + "&rt=c";
  const fReq = JSON.stringify([[["jSf9Qc", "[]", null, "generic"]]]);
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "f.req=" + encodeURIComponent(fReq) + "&at=" + encodeURIComponent(tok.at)
  });
  if (res.status === 401 || res.status === 403) throw new Error("AUTH");
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  // envelope: )]}' prefix + length lines; find the string JSON inside the jSf9Qc cell
  const m = text.match(/"wrb\.fr","jSf9Qc","((?:[^"\\]|\\.)*)"/);
  if (!m) throw new Error("STALE"); // stale token / format changed
  const inner = JSON.parse('"' + m[1] + '"'); // decode JSON escapes → inner string
  return JSON.parse(inner);                   // inner string = the actual array
}

/// [S4] fetchGeminiUsage — cached token, refresh once if stale
export async function fetchGeminiUsage() {
  if (!tokenCache) tokenCache = await getTokens();
  let payload;
  try {
    payload = await callUsageRpc(tokenCache);
  } catch (e) {
    if (String(e.message) !== "STALE") throw e;
    tokenCache = await getTokens();          // single retry with a fresh token
    payload = await callUsageRpc(tokenCache);
  }
  return normalize(payload);
}

/// [S5] normalize — endpoints.md schema → common format
/// payload: [2, [[unit?, ratio(0-1), type, [[reset_unix]]], ...], limit_reached?]
/// type: 1 = current window (we treat as "session") · 2 = weekly. Order is not fixed!
export function normalize(payload) {
  const rows = Array.isArray(payload) && Array.isArray(payload[1]) ? payload[1] : [];
  const reached = payload && payload[2] === true;
  const out = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r[1] == null || r[2] == null) continue;
    const usedPct = Math.max(0, Math.min(100, r[1] * 100));
    const resetSec = r[3] && r[3][0] && r[3][0][0];
    out.push({
      provider: "gemini",
      window: r[2] === 2 ? "weekly" : "session",
      remaining: Math.max(0, Math.min(100, 100 - usedPct)),
      resets_at: resetSec ? new Date(resetSec * 1000).toISOString() : null,
      severity: reached ? "critical" : "normal"
    });
  }
  if (out.length === 0) throw new Error("EMPTY");
  return { provider: "gemini", plan: "?", limits: out };
}
