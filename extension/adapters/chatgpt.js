/// ============================================================
/// FILE   : extension/adapters/chatgpt.js
/// PURPOSE: ChatGPT (chatgpt.com) subscription-limit adapter — wham/usage
///          (percentage) + conversation/init (feature allowances) → common format.
///          Schema: docs/endpoints.md (ChatGPT section, discovered 2026-07-10).
/// STATUS : Phase 2 — first version (verified on a Free account; Plus model_limits TODO)
/// INDEX  :
///   [S1] constants + getToken() (auth chain: cookie → accessToken)
///   [S2] api() — request helper with Bearer header
///   [S3] fetchChatGPTUsage() — session → wham + init → normalize
///   [S4] normalize() — common format: {provider, plan, limits[], features[]}
/// NOTE   : accessToken stays in session context, is NEVER persisted (K5).
///          wham reset_at = unix seconds (differs from Claude's ISO) → converted to ISO.
///          Poll ~60s (no 5s); both requests are read-only, spend no messages.
/// ============================================================

/// [S1] constants + getToken
const BASE = "https://chatgpt.com";

async function getToken() {
  const res = await fetch(BASE + "/api/auth/session", { credentials: "include" });
  if (!res.ok) throw new Error("AUTH");
  const sess = await res.json().catch(() => null);
  if (!sess || !sess.accessToken) throw new Error("AUTH");
  return sess.accessToken;
}

/// [S2] api — request with Bearer header (token passed in, not persisted)
async function api(token, path, opt) {
  const res = await fetch(BASE + path, Object.assign({
    credentials: "include",
    headers: {
      accept: "application/json",
      authorization: "Bearer " + token,
      "content-type": "application/json"
    }
  }, opt || {}));
  if (res.status === 401 || res.status === 403) throw new Error("AUTH");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/// [S3] fetchChatGPTUsage — auth chain → two sources → normalize
export async function fetchChatGPTUsage() {
  const token = await getToken();
  const [wham, init] = await Promise.all([
    api(token, "/backend-api/wham/usage").catch(() => null),
    api(token, "/backend-api/conversation/init", { method: "POST", body: "{}" }).catch(() => null)
  ]);
  if (!wham && !init) throw new Error("EMPTY");
  return normalize(wham, init);
}

/// [S4] normalize — endpoints.md schema → common format
/// wham used_percent = USED % → remaining = 100 - used.
/// limits_progress.remaining = COUNT (cap unknown) → features[] (not a percentage).
export function normalize(wham, init) {
  const plan = (wham && wham.plan_type)
    ? wham.plan_type.charAt(0).toUpperCase() + wham.plan_type.slice(1)
    : "?";

  const out = [];
  // window name by duration: ≤6h session, ≤7d weekly, above that monthly
  const windowName = (sec) => {
    if (sec == null) return "session";
    if (sec <= 6 * 3600) return "session";
    if (sec <= 7 * 86400) return "weekly";
    return "monthly";
  };
  const pushWindow = (w, reached) => {
    if (!w || w.used_percent == null) return;
    out.push({
      provider: "chatgpt",
      window: windowName(w.limit_window_seconds),
      remaining: Math.max(0, Math.min(100, 100 - w.used_percent)),
      resets_at: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
      severity: reached ? "critical" : "normal"
    });
  };
  const rl = wham && wham.rate_limit;
  if (rl) {
    pushWindow(rl.primary_window, rl.limit_reached);
    pushWindow(rl.secondary_window, rl.limit_reached);
  }

  // per-feature remaining allowances (counts) — shown as number chips in the UI
  const features = [];
  const prog = init && Array.isArray(init.limits_progress) ? init.limits_progress : [];
  for (const p of prog) {
    if (!p || p.remaining == null) continue;
    features.push({
      name: p.feature_name || "?",
      remaining: p.remaining,
      resets_at: p.reset_after || null
    });
  }

  if (out.length === 0 && features.length === 0) throw new Error("EMPTY");
  return { provider: "chatgpt", plan, limits: out, features };
}
