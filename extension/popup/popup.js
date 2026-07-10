/// ============================================================
/// FILE   : extension/popup/popup.js
/// PURPOSE: Popup logic — reads the snapshot from storage and draws the gauge
///          cards; the refresh button asks the background for an immediate sync.
/// STATUS : Phase 2 — multi-provider (Claude + ChatGPT + Gemini)
/// INDEX  :
///   [S1] constants — color threshold colorVar() (source: token-reactor.html S7) + labels
///   [S2] helpers — fmtReset() countdown, fmtAgo() last sync
///   [S3] render() — snapshot → cards (session/weekly/sub-limits), error state
///   [S3a] renderBreakdown() — last-5h surface breakdown (Chat/Code/Other) + Code tokens
///   [S3b] renderProvider() — ChatGPT/Gemini snapshot → heading + % cards
///         + feature allowance chips (ChatGPT limits_progress, count-based)
///   [S4] startup — read storage + listen for changes + refresh button
/// ============================================================

/// [S1] color threshold + labels (spec: PROJECT.md §5 — fixed in the product)
/// Texts come from chrome.i18n — shown in the user's Chrome language.
const t = (k, subs) => chrome.i18n.getMessage(k, subs) || k;
const STORAGE_KEY = "ailhq_claude";
const PROVIDERS = [
  { key: "ailhq_chatgpt", name: "ChatGPT" },
  { key: "ailhq_gemini",  name: "Gemini" }
];

function colorVar(pct) {
  if (pct >= 80) return "--g-blue";
  if (pct >= 60) return "--g-green";
  if (pct >= 40) return "--g-yellow";
  if (pct >= 20) return "--g-orange";
  return "--g-red";
}
function label(pct) {
  if (pct >= 80) return t("tier80");
  if (pct >= 60) return t("tier60");
  if (pct >= 40) return t("tier40");
  if (pct >= 20) return t("tier20");
  return t("tier0");
}
const WINDOW_TITLES = {
  session: t("titleSession"),
  weekly: t("titleWeekly"),
  monthly: t("titleMonthly"),
  weekly_scoped: t("titleScoped"),
  weekly_opus: t("titleOpus"),
  weekly_sonnet: t("titleSonnet")
};
const FEATURE_NAMES = {
  deep_research: t("featDeepResearch"),
  file_upload: t("featFileUpload"),
  paste_text_to_file: t("featPasteText"),
  image_gen: t("featImageGen")
};
const ATTRIB_KEY = "ailhq_attrib";
const SURFACE_NAMES = { chat: "💬 Chat", code: "⌨ Code", "chat+code": "💬+⌨", other: t("surfOther") };

/// [S2] helpers
function fmtReset(iso) {
  if (!iso) return "";
  const s = Math.max(0, (new Date(iso) - Date.now()) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return t("resetLabel") + d + t("unitDay") + " " + h + t("unitHour");
  if (h > 0) return t("resetLabel") + h + t("unitHour") + " " + m + t("unitMin");
  return t("resetLabel") + m + t("unitMin");
}
function fmtAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return t("agoSec", [String(s)]);
  return t("agoMin", [String(Math.round(s / 60))]);
}

/// [S3] render
/// [S3a] breakdown card — splits the last-5h session drop across surfaces (delta attribution)
function renderBreakdown(gauges, attrib, collector) {
  const cut = Date.now() - 5 * 3600 * 1000;
  const sums = {};
  for (const a of attrib || []) {
    if (a.t >= cut) sums[a.surface] = (sums[a.surface] || 0) + a.d;
  }
  const keys = Object.keys(sums);
  if (!keys.length && !collector) return;

  const card = document.createElement("div");
  card.className = "card";
  let chips = keys
    .sort((a, b) => sums[b] - sums[a])
    .map(k => `<span class="chip">${SURFACE_NAMES[k] || k} <b>${sums[k].toFixed(1)}p</b></span>`)
    .join("");
  if (!keys.length) chips = '<span class="chip">' + t("noDrop") + "</span>";
  const codeLine = collector
    ? `<div class="meta" style="margin-top:6px">${t("codeReal", [collector.tokens_5h.toLocaleString()])}${collector.active ? " · <b>" + t("activeWord") + "</b>" : ""}</div>`
    : "";
  card.innerHTML = `
    <div class="top"><span class="title">${t("breakdownTitle")}</span></div>
    <div class="breakdown">${chips}</div>${codeLine}
    <div class="meta" style="margin-top:4px">${t("pUnit")}</div>`;
  gauges.appendChild(card);
}

/// [S3b] other-provider section (ChatGPT/Gemini) — heading + cards + allowance chips
function limitCard(gauges, css, title, l) {
  const pct = Math.round(l.remaining);
  const col = css.getPropertyValue(colorVar(pct)).trim();
  const card = document.createElement("div");
  card.className = "card";
  card.style.setProperty("--bar-color", col);
  card.innerHTML = `
    <div class="top">
      <span class="title">${title}</span>
      <span class="badge">${label(pct)}</span>
    </div>
    <div class="big">${pct}<small>${t("pctLeft")}</small></div>
    <div class="track"><div class="fill"></div></div>
    <div class="meta">${fmtReset(l.resets_at)}</div>`;
  gauges.appendChild(card);
  requestAnimationFrame(() => { card.querySelector(".fill").style.width = pct + "%"; });
}

function renderProvider(gauges, name, snap) {
  if (!snap) return;
  const head = document.createElement("div");
  head.className = "provider-head";
  if (!snap.ok) {
    // AUTH/EMPTY = not signed in to the site → hint; other error → short error text (don't stay blind)
    const note = (snap.error === "AUTH" || snap.error === "EMPTY")
      ? t("provAuth") : t("syncErrPrefix") + snap.error;
    head.innerHTML = `<span class="pname">${name}</span><span class="pmeta">${note}</span>`;
    gauges.appendChild(head);
    return;
  }
  const plan = snap.data.plan && snap.data.plan !== "?" ? " · " + snap.data.plan : "";
  head.innerHTML = `<span class="pname">${name}${plan}</span>`;
  gauges.appendChild(head);

  const css = getComputedStyle(document.documentElement);
  for (const l of snap.data.limits || []) {
    limitCard(gauges, css, name + " · " + (WINDOW_TITLES[l.window] || l.window), l);
  }
  // feature allowances (count-based — ChatGPT limits_progress)
  const feats = snap.data.features || [];
  if (feats.length) {
    const card = document.createElement("div");
    card.className = "card";
    const chips = feats.map(f =>
      `<span class="chip">${FEATURE_NAMES[f.name] || f.name.replace(/_/g, " ")} <b>${f.remaining}</b></span>`).join("");
    card.innerHTML = `
      <div class="top"><span class="title">${t("featTitle")}</span></div>
      <div class="breakdown">${chips}</div>
      <div class="meta" style="margin-top:4px">${t("featUnit")}</div>`;
    gauges.appendChild(card);
  }
}

function render(snap) {
  const gauges = document.getElementById("gauges");
  const status = document.getElementById("status");
  const plan = document.getElementById("plan");

  // ChatGPT/Gemini cards must render even when the Claude snapshot isn't there yet
  gauges.innerHTML = "";
  if (!snap) {
    status.textContent = t("firstSync");
  } else if (!snap.ok) {
    const msg = snap.error === "AUTH" ? t("authLong") : t("syncErrPrefix") + snap.error;
    gauges.innerHTML = `<div class="error">${msg}</div>`;
    status.textContent = fmtAgo(snap.updatedAt);
  } else {
    plan.textContent = "Claude · " + snap.data.plan;
    const css = getComputedStyle(document.documentElement);
    for (const l of snap.data.limits) {
      limitCard(gauges, css, WINDOW_TITLES[l.window] || l.window, l);
    }
    status.textContent = t("syncLabel") + fmtAgo(snap.updatedAt);
  }

  // shared tail: breakdown card + other providers (ChatGPT, Gemini)
  chrome.storage.local.get([ATTRIB_KEY, ...PROVIDERS.map(p => p.key)]).then(o => {
    if (snap && snap.ok) renderBreakdown(gauges, o[ATTRIB_KEY], snap.collector);
    for (const p of PROVIDERS) renderProvider(gauges, p.name, o[p.key]);
  });
}

// read the Claude snapshot fresh (the listener also fires on ChatGPT/Gemini changes)
function rerender() {
  chrome.storage.local.get(STORAGE_KEY).then(o => render(o[STORAGE_KEY]));
}

/// [S4] startup
document.getElementById("status").textContent = t("loading");
document.getElementById("refresh").title = t("refreshTip");
document.getElementById("dashboard").title = t("dashTip");
rerender();

// re-render the popup when any of the three providers updates
const WATCH = [STORAGE_KEY, ...PROVIDERS.map(p => p.key)];
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && WATCH.some(k => changes[k])) rerender();
});

document.getElementById("dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
});

document.getElementById("refresh").addEventListener("click", () => {
  document.getElementById("status").textContent = t("syncingNow");
  chrome.runtime.sendMessage({ type: "ailhq:refresh" }, s => {
    if (chrome.runtime.lastError || !s) {
      document.getElementById("status").textContent = t("bgWaking");
      return;
    }
    render(s);
  });
});
