/// ============================================================
/// FILE   : extension/dashboard/dashboard.js
/// PURPOSE: Full-page dashboard logic — binds the REAL data from chrome.storage
///          to the reactor + cards. Demo mode keeps the prototype behavior.
/// STATUS : Phase 1.5 — first real-data version
/// INDEX  :
///   [S1] constants — storage keys, window names/colors
///   [S2] helpers — colorVar, cssVal, fmtReset, drawSpark
///   [S3] real data → provider list (snapshot + history + collector)
///        sessionRate(): the last hour's real burn (percentage points/hour)
///   [S4] card building + renderCard (same visuals as prototype S8)
///   [S5] reactor canvas — drawPool / burstAt / explode (prototype S9)
///   [S6] main loop — in real mode burn = sessionRate (20 p/h = full speed),
///        in demo mode the prototype's 0.6s animation
///   [S7] demo mode data + transitions
///   [S8] startup — read/listen storage, clock, buttons
/// NOTE   : In real mode there are no "Burn/Refill" buttons (data is real!); the
///          explosion is purely visual. The 20 p/h threshold = the rate that
///          exhausts a session in 5 hours.
/// ============================================================

(function () {
  "use strict";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /// [S1] constants — texts from chrome.i18n (the user's Chrome language)
  var t = function (k, subs) { return chrome.i18n.getMessage(k, subs) || k; };
  var STORAGE_KEY = "ailhq_claude", HISTORY_KEY = "ailhq_history", ATTRIB_KEY = "ailhq_attrib";
  var WIN_META = {
    session:       { name: t("dwSession"), plan: t("dwPlanSession"), color: "#8B5CF6" },
    weekly:        { name: t("dwWeekly"),  plan: t("dwPlanWeekly"),  color: "#8B5CF6" },
    weekly_scoped: { name: t("dwScoped"),  plan: t("dwPlanScoped"),  color: "#7C6BE0" },
    weekly_opus:   { name: t("dwOpus"),    plan: t("dwPlanModel"),   color: "#9B7CF6" },
    weekly_sonnet: { name: t("dwSonnet"),  plan: t("dwPlanModel"),   color: "#7C9CF6" }
  };
  var FULL_SPEED = 20; // p/h — the burn rate that exhausts a session in exactly 5 hours

  var snap = null, history = [], demoMode = false;

  /// [S2] helpers
  function colorVar(pct) {
    if (pct >= 80) return "--g-blue";
    if (pct >= 60) return "--g-green";
    if (pct >= 40) return "--g-yellow";
    if (pct >= 20) return "--g-orange";
    return "--g-red";
  }
  function cssVal(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function fmtReset(s) {
    if (s == null) return "—";
    var D = t("unitDay"), H = t("unitHour"), M = t("unitMin");
    if (s >= 86400) return Math.floor(s/86400)+D+" "+Math.floor((s%86400)/3600)+H;
    var h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
    if (h>0) return h+H+" "+m+M;
    return m+M;
  }
  function drawSpark(cv, hist, color) {
    var ctx = cv.getContext("2d"), w = cv.width, h = cv.height;
    ctx.clearRect(0,0,w,h);
    if (!hist || hist.length < 2) return;
    var max = Math.max.apply(null, hist) || 1, n = hist.length;
    ctx.beginPath();
    for (var i=0;i<n;i++){ var x=i/(n-1)*w, y=h-(hist[i]/max)*(h-6)-3; if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y); }
    ctx.lineTo(w,h); ctx.lineTo(0,h); ctx.closePath();
    var grd = ctx.createLinearGradient(0,0,0,h); grd.addColorStop(0,color+"55"); grd.addColorStop(1,color+"00");
    ctx.fillStyle = grd; ctx.fill();
    ctx.beginPath();
    for (var j=0;j<n;j++){ var x2=j/(n-1)*w, y2=h-(hist[j]/max)*(h-6)-3; if(j===0)ctx.moveTo(x2,y2); else ctx.lineTo(x2,y2); }
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.fillStyle = color; var lx=w, ly=h-(hist[n-1]/max)*(h-6)-3; ctx.beginPath(); ctx.arc(lx-2,ly,2.4,0,7); ctx.fill();
  }

  /// [S3] real data → providers
  // hourly rate (percentage points/hour) from the usage increase over the last `minutes`
  function usedRate(field, minutes) {
    var now = Date.now(), cut = now - minutes*60000;
    var pts = history.filter(function (h) { return h[field] != null; });
    if (pts.length < 2) return 0;
    var base = pts[0];
    for (var i=0;i<pts.length;i++) { if (pts[i].t <= cut) base = pts[i]; else break; }
    var lastP = pts[pts.length-1];
    var dtMin = (lastP.t - base.t) / 60000;
    if (dtMin < 1) return 0;
    var d = lastP[field] - base[field];
    if (d < 0) d = 0; // window reset
    return d / dtMin * 60;
  }
  function sessionRate() { return usedRate("s", 60); }
  // sparkline: session deltas between consecutive history points (last 24)
  function sessionDeltas() {
    var out = [];
    for (var i=1;i<history.length;i++) {
      var d = (history[i].s || 0) - (history[i-1].s || 0);
      out.push(Math.max(0, d));
    }
    return out.slice(-24);
  }

  function realProviders() {
    var list = [];
    if (!snap || !snap.ok) return list;
    var deltas = sessionDeltas();
    snap.data.limits.forEach(function (l) {
      var meta = WIN_META[l.window] || { name: "Claude — "+l.window, plan: "", color: "#8B5CF6" };
      list.push({
        key: l.window, name: meta.name, plan: meta.plan, color: meta.color,
        total: 100, rem: l.remaining,
        reset: l.resets_at ? Math.max(0, (new Date(l.resets_at) - Date.now())/1000) : null,
        burnText: l.window === "session" ? sessionRate().toFixed(1)+" "+t("pShort") : usedRate("w", 360).toFixed(2)+" "+t("pShort"),
        hist: l.window === "session" ? deltas : null
      });
    });
    if (snap.collector) {
      list.push({
        key: "code", name: "Claude Code", plan: t("dwCodePlan"), color: "#D97757",
        tokenCard: true, tokens: snap.collector.tokens_5h, sessions: snap.collector.sessions,
        active: snap.collector.active
      });
    }
    return list;
  }

  /// [S4] card building
  var grid = document.getElementById("grid");
  function buildCards(providers) {
    grid.innerHTML = "";
    providers.forEach(function (p) {
      var el = document.createElement("div");
      el.className = "card";
      el.innerHTML =
        '<div class="card-top">' +
          '<div class="glyph" style="background:'+p.color+'">'+(p.tokenCard?"⌨":p.name.replace("Claude — ","")[0])+'</div>' +
          '<div class="card-id"><div class="name">'+p.name+'</div><div class="plan">'+p.plan+'</div></div>' +
          '<span class="pill" data-pill>—</span>' +
        '</div>' +
        '<div class="readout"><span class="big" data-big>0</span><span class="tot" data-tot></span><span class="pct" data-pct></span></div>' +
        '<div class="gauge"><i data-fill></i><div class="ticks"><span style="left:20%"></span><span style="left:40%"></span><span style="left:60%"></span><span style="left:80%"></span></div></div>' +
        '<div class="meta">' +
          '<div class="m"><span class="k" data-k1>'+t("cardResetK")+'</span><span class="v" data-reset>—</span></div>' +
          '<div class="m"><span class="k" data-k2>'+t("cardBurnK")+'</span><span class="v" data-burn>—</span></div>' +
          '<canvas class="spark" data-spark width="184" height="60"></canvas>' +
        '</div>';
      p.el = el;
      grid.appendChild(el);
      renderCard(p);
    });
  }

  function renderCard(p) {
    var pill = p.el.querySelector("[data-pill]");
    if (p.tokenCard) {
      var col = p.active ? cssVal("--g-orange") : cssVal("--g-blue");
      p.el.style.setProperty("--bar-color", col);
      p.el.querySelector("[data-big]").textContent = p.tokens.toLocaleString();
      p.el.querySelector("[data-tot]").textContent = t("tokens5h");
      p.el.querySelector("[data-pct]").textContent = "";
      p.el.querySelector("[data-fill]").style.width = p.active ? "100%" : "8%";
      p.el.querySelector("[data-k1]").textContent = t("k1Session");
      p.el.querySelector("[data-reset]").textContent = t("sessionsActive", [String(p.sessions)]);
      p.el.querySelector("[data-k2]").textContent = t("k2State");
      p.el.querySelector("[data-burn]").textContent = p.active ? t("runningWord") : t("idleWord");
      pill.textContent = p.active ? t("pillActive") : t("pillQuiet");
      return;
    }
    var pct = Math.max(0, Math.min(100, p.rem/p.total*100));
    var col2 = cssVal(colorVar(pct));
    p.el.style.setProperty("--bar-color", col2);
    p.el.querySelector("[data-big]").textContent = Math.round(p.rem);
    p.el.querySelector("[data-tot]").textContent = "/ "+p.total;
    p.el.querySelector("[data-pct]").textContent = Math.round(pct)+"%";
    p.el.querySelector("[data-fill]").style.width = pct+"%";
    p.el.querySelector("[data-reset]").textContent = fmtReset(p.reset);
    p.el.querySelector("[data-burn]").textContent = p.burnText || (p.burn != null ? p.burn.toFixed(0)+"/min" : "—");
    pill.textContent = pct>=80?t("tier80"):pct>=60?t("tier60"):pct>=40?t("tier40"):pct>=20?t("tier20"):t("tier0");
    if (p.hist && p.hist.length > 1) drawSpark(p.el.querySelector("[data-spark]"), p.hist, col2);
  }

  /// [S5] reactor canvas
  var pool = document.getElementById("pool"), pctx = pool.getContext("2d");
  var flash = document.getElementById("flash"), boomWord = document.getElementById("boomWord"), reactorBox = document.getElementById("reactorBox");
  var particles = [], sparks = [], W=0, H=0, dpr = Math.min(2, window.devicePixelRatio||1);

  function sizePool() {
    var r = pool.getBoundingClientRect(); W=r.width; H=r.height;
    pool.width = W*dpr; pool.height = H*dpr; pctx.setTransform(dpr,0,0,dpr,0,0);
    if (particles.length===0) for (var i=0;i<44;i++) particles.push(newTok());
  }
  function newTok() {
    return { x:Math.random()*W, y:H*0.35+Math.random()*H*0.6, r:2+Math.random()*3.5,
             vx:(Math.random()-.5)*.25, vy:-.15-Math.random()*.35, ph:Math.random()*6.28 };
  }
  function burstAt(cx, cy, n, power) {
    for (var i=0;i<n;i++){ var a=Math.random()*6.283, s=power*(0.4+Math.random());
      sparks.push({ x:cx, y:cy, vx:Math.cos(a)*s, vy:Math.sin(a)*s-1, life:1, r:1.5+Math.random()*3,
        hue: Math.random()<.5?"#F0883E":"#F85149" }); }
  }

  var heat = 0, overload = 0, boomCooldown = 0;

  function drawPool() {
    pctx.clearRect(0,0,W,H);
    var g = pctx.createRadialGradient(W/2,H,10,W/2,H,H*0.9);
    g.addColorStop(0, "rgba("+Math.round(180+heat*75)+","+Math.round(120-heat*70)+","+Math.round(255-heat*180)+","+(0.10+heat*0.28)+")");
    g.addColorStop(1, "rgba(0,0,0,0)");
    pctx.fillStyle = g; pctx.fillRect(0,0,W,H);

    for (var i=0;i<particles.length;i++){
      var t = particles[i];
      t.ph += 0.02+heat*0.05;
      t.x += t.vx + Math.sin(t.ph)*0.3;
      t.y += t.vy*(1+heat*1.6);
      if (t.y < H*0.28 || t.x<0 || t.x>W){ particles[i]=newTok(); particles[i].y=H-4; continue; }
      var col = heat>0.6 ? "#F0883E" : cssVal("--g-blue");
      pctx.beginPath(); pctx.arc(t.x,t.y,t.r,0,6.283);
      pctx.fillStyle = col; pctx.globalAlpha = 0.5+0.4*Math.sin(t.ph); pctx.fill(); pctx.globalAlpha=1;
    }
    for (var j=sparks.length-1;j>=0;j--){
      var s=sparks[j]; s.vy+=0.06; s.x+=s.vx; s.y+=s.vy; s.life-=0.018;
      if (s.life<=0){ sparks.splice(j,1); continue; }
      pctx.beginPath(); pctx.arc(s.x,s.y,s.r*s.life,0,6.283);
      pctx.fillStyle=s.hue; pctx.globalAlpha=s.life; pctx.fill(); pctx.globalAlpha=1;
    }
  }

  function explode() {
    if (boomCooldown>0) return;
    boomCooldown = 70;
    if (!reduce) {
      burstAt(W/2, H*0.62, 90, 4.5);
      reactorBox.classList.remove("shake"); void reactorBox.offsetWidth; reactorBox.classList.add("shake");
      flash.style.transition="none"; flash.style.opacity="0.6";
      setTimeout(function(){ flash.style.transition="opacity .5s ease"; flash.style.opacity="0"; },30);
      boomWord.style.transition="none"; boomWord.style.opacity="1"; boomWord.style.transform="scale(1.15)";
      setTimeout(function(){ boomWord.style.transition="opacity .6s ease, transform .6s ease"; boomWord.style.opacity="0"; boomWord.style.transform="scale(.6)"; },40);
    }
  }

  /// [S6] main loop
  var last = performance.now(), acc = 0, demo = null;
  function loop(now) {
    var dt = Math.min(60, now-last); last = now;
    if (boomCooldown>0) boomCooldown--;
    overload = Math.max(0, overload - dt*0.03);

    var burnDisplay, bnorm;
    if (demoMode && demo) {
      acc += dt;
      if (acc > 600) { acc = 0; demo.tick(); }
      burnDisplay = Math.round(demo.burnPerMin + overload*0.6);
      bnorm = Math.min(1, (demo.burnPerMin/90) + overload/140);
    } else {
      var rate = sessionRate();
      burnDisplay = rate.toFixed(1);
      bnorm = Math.min(1, rate/FULL_SPEED + overload/140);
      // sustained above full speed → auto-explode
      if (rate > FULL_SPEED*1.2) overload += dt*0.02;
    }
    heat = bnorm;

    document.getElementById("burnBar").style.width = (10+bnorm*90)+"%";
    document.getElementById("burnVal").textContent = burnDisplay;
    var sys = document.getElementById("sysState"), st = document.getElementById("sysText");
    if (overload>70 || bnorm>0.85) { sys.className="sys crit"; st.textContent=t("sysCrit"); }
    else if (bnorm>0.5) { sys.className="sys warn"; st.textContent=t("sysWarn"); }
    else { sys.className="sys ok"; st.textContent=t("sysOk"); }

    if (overload > 100) { overload = 40; explode(); }

    drawPool();
    requestAnimationFrame(loop);
  }

  /// [S7] demo mode
  function makeDemo() {
    var providers = [
      { key:"claude",  name:"Claude Opus",   plan:"Max · 5h window",    color:"#8B5CF6", total:900,  rem:792, burn:22, reset:4*3600+1200 },
      { key:"code",    name:"Claude Code",   plan:"Max · daily",        color:"#D97757", total:100,  rem:34,  burn:9,  reset:9*3600 },
      { key:"gpt",     name:"ChatGPT Plus",  plan:"GPT-5 · 3h window",  color:"#10A37F", total:80,   rem:53,  burn:5,  reset:2*3600+400 },
      { key:"gemini",  name:"Gemini Advanced",plan:"2.5 Pro · daily",   color:"#4285F4", total:120,  rem:62,  burn:4,  reset:11*3600 },
      { key:"cursor",  name:"Cursor",        plan:"Pro · monthly avg",  color:"#5B6472", total:500,  rem:69,  burn:14, reset:6*86400 },
      { key:"copilot", name:"GitHub Copilot",plan:"premium requests",   color:"#6E7681", total:300,  rem:228, burn:3,  reset:19*86400 }
    ];
    providers.forEach(function (p) { p.hist = []; for (var i=0;i<24;i++) p.hist.push(p.burn*(0.7+Math.random()*0.6)); });
    buildCards(providers);
    return {
      burnPerMin: 0,
      tick: function () {
        var self = this; self.burnPerMin = 0;
        providers.forEach(function (p) {
          var b = p.burn*(0.6+Math.random()*0.8);
          p.rem = Math.max(0, p.rem - b*0.12);
          if (p.rem<=0) p.rem = p.total;
          p.reset -= 8; if (p.reset<=0) { p.reset = 5*3600; p.rem = p.total; }
          p.hist.push(b); p.hist.shift();
          self.burnPerMin += b;
          renderCard(p);
        });
      }
    };
  }

  function applyMode() {
    var unit = document.getElementById("burnUnit"), sub = document.getElementById("burnSub");
    var title = document.getElementById("readTitle");
    if (demoMode) {
      demo = makeDemo();
      unit.textContent = t("unitTokMin"); title.textContent = t("dashBurnDemo");
      sub.innerHTML = t("subDemo");
    } else {
      demo = null;
      unit.textContent = t("unitPointsHour"); title.textContent = t("dashBurnReal");
      sub.innerHTML = t("subReal", [String(FULL_SPEED)]);
      refreshReal();
    }
  }

  /// [S8] startup
  function refreshReal() {
    if (demoMode) return;
    var acct = document.getElementById("acct");
    if (snap && snap.ok) acct.textContent = "Claude · " + snap.data.plan;
    else if (snap && snap.error === "AUTH") acct.textContent = t("noAccount");
    var list = realProviders();
    if (list.length) buildCards(list);
    else grid.innerHTML = '<div class="card"><div class="card-id"><div class="name">'+t("waitData")+'</div><div class="plan">'+t("waitDataSub")+"</div></div></div>";
  }

  // static headings (placeholders in HTML — language from chrome.i18n)
  document.title = "AI Limit — Token Reactor";
  document.getElementById("brandTag").textContent = t("brandTag");
  document.getElementById("acctK").textContent = t("acctLabel");
  document.getElementById("clockK").textContent = t("clockLabel");
  document.getElementById("stageLabel").textContent = t("poolLabel");
  document.getElementById("gridHead").textContent = t("dashLimits");
  document.getElementById("footNote").innerHTML = t("footNote");
  document.getElementById("overdrive").textContent = t("overdriveBtn");
  document.getElementById("sysText").textContent = t("sysOk");
  applyMode(); // real-mode headings (readTitle/burnUnit/burnSub)

  chrome.storage.local.get([STORAGE_KEY, HISTORY_KEY]).then(function (o) {
    snap = o[STORAGE_KEY] || null;
    history = o[HISTORY_KEY] || [];
    refreshReal();
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes[STORAGE_KEY]) snap = changes[STORAGE_KEY].newValue;
    if (changes[HISTORY_KEY]) history = changes[HISTORY_KEY].newValue || [];
    if (changes[STORAGE_KEY] || changes[HISTORY_KEY]) refreshReal();
  });

  var legend = document.getElementById("legend");
  [["≥ 80","--g-blue"],["60–80","--g-green"],["40–60","--g-yellow"],["20–40","--g-orange"],["< 20","--g-red"]]
    .forEach(function (t) {
      var i = document.createElement("span"); i.className = "item";
      i.innerHTML = '<span class="sw" style="background:'+cssVal(t[1])+'"></span>'+t[0];
      legend.appendChild(i);
    });

  function tickClock() {
    var d = new Date();
    document.getElementById("clock").textContent =
      String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")+":"+String(d.getSeconds()).padStart(2,"0");
  }
  setInterval(tickClock, 1000); tickClock();

  document.getElementById("overdrive").addEventListener("click", function () { overload = 130; if (reduce) explode(); });
  var demoBtn = document.getElementById("demoToggle");
  demoBtn.textContent = t("demoOn");
  demoBtn.addEventListener("click", function () {
    demoMode = !demoMode;
    demoBtn.textContent = demoMode ? t("demoOff") : t("demoOn");
    applyMode();
  });

  window.addEventListener("resize", sizePool);
  sizePool();
  requestAnimationFrame(loop);
})();
