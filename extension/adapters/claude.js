/// ============================================================
/// FILE   : extension/adapters/claude.js
/// PURPOSE: Claude (claude.ai) subscription-limit adapter — reads the usage
///          endpoint and maps it to the common format. Schema: docs/endpoints.md.
/// STATUS : Phase 1 — first version
/// INDEX  :
///   [S1] constants + getJSON() (read-only GET with session cookie)
///   [S2] fetchClaudeUsage() — org uuid → usage → normalize
///   [S3] normalize() — common format: {provider, window, remaining, resets_at, severity}
/// NOTE   : We never read passwords/cookies; the browser sends its own cookies (K5).
///          Endpoint is read-only, spends no messages. Poll ~60s (no 5s).
/// ============================================================

/// [S1] constants + getJSON
const BASE = "https://claude.ai/api";

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    credentials: "include"
  });
  if (res.status === 401 || res.status === 403) throw new Error("AUTH");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/// [S2] fetchClaudeUsage — find org uuid, fetch usage, normalize
export async function fetchClaudeUsage() {
  const orgs = await getJSON(BASE + "/organizations");
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error("AUTH");
  const org = orgs.find(o => (o.capabilities || []).includes("chat")) || orgs[0];
  const usage = await getJSON(BASE + "/organizations/" + org.uuid + "/usage");
  return normalize(usage, org);
}

/// [S3] normalize — endpoints.md schema → common format
/// Source priority: usage.limits[] (cleanest) → else five_hour/seven_day.
/// utilization/percent = USED %; the panel shows REMAINING → remaining = 100 - percent.
export function normalize(usage, org) {
  const caps = (org && org.capabilities) || [];
  const plan = caps.includes("claude_max") ? "Max"
             : caps.includes("claude_pro") ? "Pro"
             : caps.includes("chat") ? "Free" : "?";

  const out = [];
  const push = (windowName, percent, resetsAt, severity) => {
    if (percent == null) return;
    out.push({
      provider: "claude",
      window: windowName,                       // "session" (5h) | "weekly" (7d)
      remaining: Math.max(0, Math.min(100, 100 - percent)),
      resets_at: resetsAt || null,
      severity: severity || "normal"
    });
  };

  const limits = Array.isArray(usage && usage.limits) ? usage.limits : [];
  const session = limits.find(l => l.kind === "session");
  const weekly  = limits.find(l => l.kind === "weekly_all");
  const scoped  = limits.find(l => l.kind === "weekly_scoped");

  if (session || weekly) {
    if (session) push("session", session.percent, session.resets_at, session.severity);
    if (weekly)  push("weekly",  weekly.percent,  weekly.resets_at,  weekly.severity);
  } else {
    if (usage && usage.five_hour) push("session", usage.five_hour.utilization, usage.five_hour.resets_at);
    if (usage && usage.seven_day) push("weekly",  usage.seven_day.utilization, usage.seven_day.resets_at);
  }

  // sub-limits (if present): scoped weekly + per-model (filled on Max plans)
  if (scoped) push("weekly_scoped", scoped.percent, scoped.resets_at, scoped.severity);
  const opus = usage && usage.seven_day_opus, sonnet = usage && usage.seven_day_sonnet;
  if (opus   && opus.utilization   != null) push("weekly_opus",   opus.utilization,   opus.resets_at);
  if (sonnet && sonnet.utilization != null) push("weekly_sonnet", sonnet.utilization, sonnet.resets_at);

  if (out.length === 0) throw new Error("EMPTY");
  return { provider: "claude", plan, limits: out };
}
