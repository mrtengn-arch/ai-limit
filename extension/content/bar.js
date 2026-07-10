/// ============================================================
/// FILE   : extension/content/bar.js
/// PURPOSE: In-page limit UI — PROVIDER-AGNOSTIC. Whichever site it's on
///          (claude.ai / chatgpt.com / gemini.google.com) it reads that
///          provider's snapshot and draws it. Two parts:
///          (a) a fixed 26px top limit strip (quick glance)
///          (b) a thin right-edge handle + sliding DETAIL PANEL (wide view)
///          On page entry the panel opens once, then docks to the edge (intro).
/// STATUS : Phase 2 — multi-provider (Claude + ChatGPT + Gemini)
/// INDEX  :
///   [S0] PROVIDER — pick provider by hostname (key, name, capabilities)
///   [S1] constants — color/label thresholds (spec: PROJECT.md §5)
///   [S2] helpers — tier(), fmtReset(), fmtAgo()
///   [S3] shadow DOM skeleton — <style> + top bar + handle + sliding panel
///   [S4] renderBar() — strip: main gauges + sub-limit badges
///   [S5] renderDrawer() — panel: cards + (Claude) breakdown + (ChatGPT) allowances
///   [S6] behavior — handle/close, hide-show top bar (persisted), intro
///   [S7] startup — read storage + listen + refresh countdown every 20s
///   [S8] chat activity signal — claude.ai ONLY (for delta attribution)
/// NOTE   : Doesn't fetch data; reads the background snapshot. Provider-specific
///          parts (breakdown/Code/heartbeat = Claude; feature allowances = ChatGPT)
///          are conditional. All chrome.* calls go through alive()/safeSend()/safeSet().
/// ============================================================

(function () {
  "use strict";
  if (window.top !== window) return; // main frame only

  /// [S0] provider selection — which site are we on?
  const HOST = location.hostname;
  const PROVIDER =
    HOST.endsWith("claude.ai")        ? { id: "claude",  key: "ailhq_claude",  name: "Claude",  breakdown: true }
  : HOST.endsWith("chatgpt.com")      ? { id: "chatgpt", key: "ailhq_chatgpt", name: "ChatGPT", features: true }
  : HOST.endsWith("gemini.google.com")? { id: "gemini",  key: "ailhq_gemini",  name: "Gemini" }
  : null;
  if (!PROVIDER) return; // unknown site (shouldn't happen — manifest is restricted)

  /// [S1] constants — texts from chrome.i18n (language = the user's Chrome language)
  const t = (k, subs) => chrome.i18n.getMessage(k, subs) || k;
  const STORAGE_KEY = PROVIDER.key;
  const ATTRIB_KEY = "ailhq_attrib";
  const BAR_HIDDEN_KEY = "ailhq_bar_collapsed"; // true = top bar hidden (preference shared across sites)
  const TIERS = [
    [80, "#2DA8FF", t("tier80")],
    [60, "#3FB950", t("tier60")],
    [40, "#E3B341", t("tier40")],
    [20, "#F0883E", t("tier20")],
    [0,  "#F85149", t("tier0")]
  ];
  const WIN_NAMES = {
    session: t("winSession"), weekly: t("winWeekly"), monthly: t("winMonthly"),
    weekly_scoped: t("winScoped"), weekly_opus: "OPUS", weekly_sonnet: "SONNET"
  };
  const WIN_TITLES = {
    session: t("titleSession"), weekly: t("titleWeekly"), monthly: t("titleMonthly"),
    weekly_scoped: t("titleScoped"),
    weekly_opus: t("titleOpus"), weekly_sonnet: t("titleSonnet")
  };
  const FULL_WINDOWS = new Set(["session", "weekly", "monthly"]); // full gauge in the strip
  const SURFACE_NAMES = { chat: "💬 Chat", code: "⌨ Code", "chat+code": "💬+⌨", other: t("surfOther") };
  const FEATURE_NAMES = {
    deep_research: t("featDeepResearch"), file_upload: t("featFileUpload"),
    paste_text_to_file: t("featPasteText"), image_gen: t("featImageGen")
  };

  /// [S2] helpers
  function tier(pct) { return TIERS.find(([min]) => pct >= min); }
  function fmtReset(iso) {
    if (!iso) return "";
    const s = Math.max(0, (new Date(iso) - Date.now()) / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + t("unitDay") + " " + h + t("unitHour");
    if (h > 0) return h + t("unitHour") + " " + m + t("unitMin");
    return m + t("unitMin");
  }
  function fmtAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    return s < 60 ? t("agoSec", [String(s)]) : t("agoMin", [String(Math.round(s / 60))]);
  }

  /// [S3] shadow DOM skeleton
  const host = document.createElement("div");
  host.id = "ailhq-host";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }

      /* ---- top bar ---- */
      .bar {
        position: fixed; top: 0; left: 50%; transform: translateX(-50%);
        width: 60vw; min-width: 620px; max-width: 96vw; height: 26px;
        z-index: 2147483647;
        display: none; align-items: center; gap: 14px;
        padding: 0 14px;
        background: rgba(13,17,23,.92);
        backdrop-filter: blur(6px);
        border: 1px solid #30363D; border-top: none;
        border-radius: 0 0 12px 12px;
        box-shadow: 0 4px 16px rgba(0,0,0,.25);
        color: #E6EDF3;
        font: 11px/1 "Segoe UI", system-ui, sans-serif;
        overflow: hidden;
      }
      :host([data-bar="on"]) .bar { display: flex; }
      .brand { font-weight: 700; letter-spacing: 1px; font-size: 10px; color: #8B949E; white-space: nowrap; }
      .seg { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
      .seg .w { color: #8B949E; font-size: 10px; letter-spacing: .5px; }
      .track { display: inline-block; width: 72px; height: 6px; border-radius: 3px; background: #0D1117; border: 1px solid #30363D; overflow: hidden; }
      .fill { display: block; position: relative; height: 100%; border-radius: 3px; transition: width .4s ease; overflow: hidden; }
      .fill::after {
        content: ""; position: absolute; inset: 0;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,.35), transparent);
        transform: translateX(-100%);
        animation: ailhq-wave 2.4s ease-in-out infinite;
      }
      @keyframes ailhq-wave { to { transform: translateX(100%); } }
      .pct { font-weight: 700; min-width: 34px; }
      .reset { color: #8B949E; font-size: 10px; }
      .mini { color: #8B949E; font-size: 10px; white-space: nowrap; }
      .mini b { font-weight: 700; }
      .spacer { flex: 1; }
      .msg { color: #F85149; }
      button {
        all: unset; cursor: pointer; color: #8B949E; font-size: 12px;
        padding: 2px 6px; border-radius: 4px; line-height: 1;
        font-family: "Segoe UI", system-ui, sans-serif;
      }
      button:hover { color: #E6EDF3; background: #30363D; }

      /* ---- right-edge handle (thin line) ---- */
      .handle {
        position: fixed; right: 0; top: 50%; transform: translateY(-50%);
        z-index: 2147483646;
        width: 24px; padding: 12px 0;
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        background: rgba(13,17,23,.92);
        border: 1px solid #30363D; border-right: none;
        border-radius: 10px 0 0 10px;
        cursor: pointer;
        backdrop-filter: blur(6px);
        transition: width .15s ease;
      }
      .handle:hover { width: 28px; }
      .handle .dot { width: 9px; height: 9px; border-radius: 50%; background: #6E7681; }
      .handle .vpct {
        writing-mode: vertical-rl;
        font: 700 10px/1 "Segoe UI", system-ui, sans-serif;
        color: #E6EDF3; letter-spacing: 1px;
      }
      .handle .vplan {
        color: #8B949E; font-weight: 600; letter-spacing: 2px;
        border-top: 1px solid #30363D; padding-top: 8px;
      }
      :host([data-drawer="open"]) .handle { display: none; }

      /* ---- sliding detail panel ---- */
      .drawer {
        position: fixed; top: 0; right: 0; height: 100vh; width: 300px;
        z-index: 2147483647;
        display: flex; flex-direction: column;
        background: rgba(13,17,23,.97);
        border-left: 1px solid #30363D;
        color: #E6EDF3;
        font: 13px/1.45 "Segoe UI", system-ui, sans-serif;
        transform: translateX(100%);
        transition: transform .35s cubic-bezier(.4,0,.2,1);
        backdrop-filter: blur(8px);
        box-shadow: -8px 0 24px rgba(0,0,0,.35);
      }
      :host([data-drawer="open"]) .drawer { transform: translateX(0); }
      .dhead {
        display: flex; justify-content: space-between; align-items: center;
        padding: 12px 14px; border-bottom: 1px solid #30363D;
      }
      .dbody { flex: 1; overflow-y: auto; padding: 12px 14px; }
      .dfoot {
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 14px; border-top: 1px solid #30363D;
        color: #8B949E; font-size: 11px;
      }
      .card {
        background: #161B22; border: 1px solid #30363D; border-radius: 8px;
        padding: 10px 12px; margin-bottom: 8px;
      }
      .card .top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
      .card .title { font-size: 11px; color: #8B949E; letter-spacing: .5px; }
      .card .badge { font-size: 10px; font-weight: 700; letter-spacing: .5px; }
      .card .big { font-size: 22px; font-weight: 700; }
      .card .big small { font-size: 12px; font-weight: 400; color: #8B949E; }
      .card .track { display: block; width: 100%; height: 8px; margin: 6px 0; border-radius: 4px; }
      .card .meta { font-size: 11px; color: #8B949E; }
      .chips { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; }
      .chips .chip { font-size: 11px; }
      .chips .chip b { font-weight: 700; }
      .switchrow {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 12px; margin-top: 4px;
        background: #161B22; border: 1px solid #30363D; border-radius: 8px;
        font-size: 12px;
      }
      .switchrow button {
        border: 1px solid #30363D; background: #0D1117; color: #E6EDF3;
        padding: 3px 10px; border-radius: 6px; font-size: 11px;
      }
    </style>

    <div class="bar">
      <span class="brand">⚡ ${PROVIDER.name.toUpperCase()}</span>
      <span id="segs" style="display:flex;gap:14px;align-items:center;"></span>
      <span class="spacer"></span>
      <button id="refresh" title="${t("refreshTip")}">⟳</button>
      <button id="openDrawer" title="${t("panelTip")}">◨</button>
      <button id="hideBar" title="${t("hideBarTip")}">✕</button>
    </div>

    <div class="handle" id="handle" title="${t("expandTip")}">
      <span class="dot" id="hdot"></span>
      <span class="vpct" id="hpct">—</span>
      <span class="dot" id="hdot2"></span>
      <span class="vpct" id="hpct2">—</span>
      <span class="vpct vplan" id="hplan"></span>
    </div>

    <div class="drawer">
      <div class="dhead">
        <span class="brand">⚡ AI LIMIT</span>
        <span>
          <button id="drefresh" title="${t("refreshTip")}">⟳</button>
          <button id="closeDrawer" title="${t("dockTip")}">➤</button>
        </span>
      </div>
      <div class="dbody" id="dbody"></div>
      <div class="dfoot">
        <span id="dstatus">${t("loading")}</span>
        <span id="dplan">—</span>
      </div>
    </div>`;

  const $ = sel => shadow.querySelector(sel);
  let snap = null, attrib = [];

  // When the extension reloads, the old content script's context dies ("Extension
  // context invalidated"). Check before every chrome.* call; if dead, stop the timers
  // and remove the UI (teardown) — no errors land in the log.
  const timers = [];
  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
  }
  function teardown() {
    timers.forEach(clearInterval);
    try { host.remove(); } catch { /* already gone */ }
  }
  function safeSend(msg, cb) {
    if (!alive()) { teardown(); return; }
    try {
      chrome.runtime.sendMessage(msg, res => {
        void chrome.runtime.lastError; // silence the "message port closed" log
        if (res && cb) cb(res);
      });
    } catch { teardown(); }
  }
  function safeSet(obj) {
    if (!alive()) { teardown(); return; }
    try { chrome.storage.local.set(obj); } catch { teardown(); }
  }
  // read the snapshot from the CORRECT provider key (the refresh reply always returns Claude)
  function loadSnap() {
    if (!alive()) { teardown(); return; }
    try {
      chrome.storage.local.get([STORAGE_KEY, ATTRIB_KEY]).then(o => {
        snap = o[STORAGE_KEY] || null;
        attrib = o[ATTRIB_KEY] || [];
        render();
      });
    } catch { teardown(); }
  }

  /// [S4] renderBar — top strip
  function renderBar() {
    const segs = $("#segs");
    if (!snap) { segs.innerHTML = '<span class="w">' + t("loading") + "</span>"; return; }
    if (!snap.ok) {
      segs.innerHTML = '<span class="msg">' +
        (snap.error === "AUTH" ? t("authShort") : t("syncErrShort")) + "</span>";
      return;
    }
    segs.innerHTML = "";
    for (const l of snap.data.limits) {
      const pct = Math.round(l.remaining);
      const [, col, lab] = tier(pct);
      const name = WIN_NAMES[l.window] || l.window;
      const seg = document.createElement("span");
      seg.className = "seg";
      if (FULL_WINDOWS.has(l.window)) {
        seg.innerHTML =
          '<span class="w">' + name + "</span>" +
          '<span class="track"><span class="fill" style="width:' + pct + "%;background:" + col + '"></span></span>' +
          '<span class="pct" style="color:' + col + '">' + pct + "%</span>" +
          '<span class="reset">' + lab + " · " + fmtReset(l.resets_at) + "</span>";
      } else {
        seg.innerHTML = '<span class="mini">' + name + ' <b style="color:' + col + '">' + pct + "%</b></span>";
      }
      segs.appendChild(seg);
    }
  }

  /// [S5] renderDrawer — handle + detail panel
  function renderDrawer() {
    const body = $("#dbody");

    // handle: primary % (session/first) + secondary % (weekly/monthly) + plan
    if (snap && snap.ok) {
      const lim = snap.data.limits;
      const primary = lim.find(l => l.window === "session") || lim[0];
      const secondary = lim.find(l => l.window === "weekly" || l.window === "monthly");
      const pct = Math.round(primary.remaining);
      $("#hpct").textContent = pct + "%";
      $("#hdot").style.background = tier(pct)[1];
      if (secondary && secondary !== primary) {
        const wp = Math.round(secondary.remaining);
        $("#hpct2").textContent = wp + "%";
        $("#hdot2").style.display = "";
        $("#hdot2").style.background = tier(wp)[1];
      } else {
        $("#hpct2").textContent = ""; $("#hdot2").style.display = "none";
      }
      $("#hplan").textContent = (snap.data.plan && snap.data.plan !== "?" ? snap.data.plan : "").toUpperCase();
    } else if (snap) {
      $("#hpct").textContent = "!";
      $("#hdot").style.background = "#6E7681";
      $("#hpct2").textContent = ""; $("#hdot2").style.display = "none"; $("#hplan").textContent = "";
    }

    if (!snap) { $("#dstatus").textContent = t("firstSync"); return; }
    if (!snap.ok) {
      body.innerHTML = '<div class="card"><span class="msg">' +
        (snap.error === "AUTH" ? t("authLong") : t("syncErrPrefix") + snap.error) +
        "</span></div>";
      $("#dstatus").textContent = fmtAgo(snap.updatedAt);
      return;
    }

    $("#dplan").textContent = PROVIDER.name + " · " + (snap.data.plan || "?");
    body.innerHTML = "";

    // limit cards
    for (const l of snap.data.limits) {
      const pct = Math.round(l.remaining);
      const [, col, lab] = tier(pct);
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="top">
          <span class="title">${WIN_TITLES[l.window] || l.window}</span>
          <span class="badge" style="color:${col}">${lab}</span>
        </div>
        <div class="big" style="color:${col}">${pct}<small>${t("pctLeft")}</small></div>
        <span class="track"><span class="fill" style="width:${pct}%;background:${col}"></span></span>
        <div class="meta">${t("resetLabel")}${fmtReset(l.resets_at)}</div>`;
      body.appendChild(card);
    }

    // ChatGPT: feature allowances (count-based)
    if (PROVIDER.features && snap.data.features && snap.data.features.length) {
      const chips = snap.data.features.map(f =>
        `<span class="chip">${FEATURE_NAMES[f.name] || f.name.replace(/_/g, " ")} <b>${f.remaining}</b></span>`).join("");
      const fc = document.createElement("div");
      fc.className = "card";
      fc.innerHTML = `
        <div class="top"><span class="title">${t("featTitle")}</span></div>
        <div class="chips">${chips}</div>
        <div class="meta" style="margin-top:4px">${t("featUnit")}</div>`;
      body.appendChild(fc);
    }

    // Claude: surface breakdown (last 5h) + Code collector line
    if (PROVIDER.breakdown) {
      const cut = Date.now() - 5 * 3600 * 1000;
      const sums = {};
      for (const a of attrib) if (a.t >= cut) sums[a.surface] = (sums[a.surface] || 0) + a.d;
      const keys = Object.keys(sums).sort((a, b) => sums[b] - sums[a]);
      const chips = keys.length
        ? keys.map(k => `<span class="chip">${SURFACE_NAMES[k] || k} <b>${sums[k].toFixed(1)}p</b></span>`).join("")
        : '<span class="chip" style="color:#8B949E">' + t("noDrop") + "</span>";
      const codeLine = snap.collector
        ? `<div class="meta" style="margin-top:6px">${t("codeReal", [snap.collector.tokens_5h.toLocaleString()])}${snap.collector.active ? " · <b>" + t("activeWord") + "</b>" : ""}</div>`
        : "";
      const bd = document.createElement("div");
      bd.className = "card";
      bd.innerHTML = `
        <div class="top"><span class="title">${t("breakdownTitle")}</span></div>
        <div class="chips">${chips}</div>${codeLine}
        <div class="meta" style="margin-top:4px">${t("pUnit")}</div>`;
      body.appendChild(bd);
    }

    // top-bar toggle
    const barOn = host.getAttribute("data-bar") === "on";
    const sw = document.createElement("div");
    sw.className = "switchrow";
    sw.innerHTML = `<span>${t("topStrip")}</span><button id="barToggle">${barOn ? t("hideWord") : t("showWord")}</button>`;
    body.appendChild(sw);
    sw.querySelector("#barToggle").addEventListener("click", () => setBar(!barOn));

    // full-page dashboard (token reactor)
    const dash = document.createElement("div");
    dash.className = "switchrow";
    dash.innerHTML = `<span>⚡ Token Reactor</span><button id="openDash">${t("openDash")}</button>`;
    body.appendChild(dash);
    dash.querySelector("#openDash").addEventListener("click", () =>
      safeSend({ type: "ailhq:open-dashboard" }));

    $("#dstatus").textContent = t("syncLabel") + fmtAgo(snap.updatedAt);
  }

  function render() { renderBar(); renderDrawer(); }

  /// [S6] behavior
  function setDrawer(open) { host.setAttribute("data-drawer", open ? "open" : "closed"); }
  function setBar(on) {
    host.setAttribute("data-bar", on ? "on" : "off");
    safeSet({ [BAR_HIDDEN_KEY]: !on });
    renderDrawer(); // refresh the toggle label
  }

  $("#handle").addEventListener("click", () => setDrawer(true));
  $("#closeDrawer").addEventListener("click", () => setDrawer(false));
  $("#openDrawer").addEventListener("click", () => setDrawer(true));
  $("#hideBar").addEventListener("click", () => setBar(false));
  // refresh: sync all providers, then re-read from the CORRECT key
  const doRefresh = () => safeSend({ type: "ailhq:refresh" }, () => loadSnap());
  $("#refresh").addEventListener("click", doRefresh);
  $("#drefresh").addEventListener("click", doRefresh);

  // intro: on entry the panel opens once, then docks to the edge shortly after
  function intro() {
    setDrawer(true);
    setTimeout(() => setDrawer(false), 1800);
  }

  /// [S7] startup
  chrome.storage.local.get([STORAGE_KEY, ATTRIB_KEY, BAR_HIDDEN_KEY]).then(o => {
    snap = o[STORAGE_KEY] || null;
    attrib = o[ATTRIB_KEY] || [];
    host.setAttribute("data-bar", o[BAR_HIDDEN_KEY] ? "off" : "on");
    setDrawer(false);
    render();
    document.documentElement.appendChild(host);
    requestAnimationFrame(intro);
    doRefresh();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEY]) snap = changes[STORAGE_KEY].newValue;
    if (changes[ATTRIB_KEY]) attrib = changes[ATTRIB_KEY].newValue || [];
    if (changes[STORAGE_KEY] || changes[ATTRIB_KEY]) render();
  });

  timers.push(setInterval(render, 20000)); // refresh the countdown (doesn't fetch data)

  /// [S8] chat activity signal — claude.ai ONLY (delta attribution, read by background S5)
  if (PROVIDER.id === "claude") {
    const ACTIVITY_KEY = "ailhq_activity_chat";
    const beat = () => {
      if (document.visibilityState === "visible") safeSet({ [ACTIVITY_KEY]: Date.now() });
    };
    beat();
    timers.push(setInterval(beat, 30000));
    document.addEventListener("visibilitychange", beat);
  }
})();
