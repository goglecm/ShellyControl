// Fallback simplified script for reliability; single-energy model; no advanced calibration/persistence.

let CFG = {
  tankLitres: 114,
  statTempC: 55,
  showerOutTempC: 42,
  coldMode: "fixed", // "fixed" or "monthmap"
  coldFixedC: 5,
  coldByMonthC: [5, 5, 6, 8, 11, 14, 16, 16, 13, 10, 7, 5],

  showerLpm: 7.2,
  showerOnW: 100,
  showerOffW: 20,

  standingLoss: [
    { c: 45, kwhDay: 1.24 },
    { c: 50, kwhDay: 1.49 },
    { c: 55, kwhDay: 1.74 },
    { c: 65, kwhDay: 2.23 }
  ],

  hpChargeKW: 2.2,
  immersionKW: 3.0,

  reserveMins42: 10,
  targetMins42: 22,
  urgentMins42: 7,
  minLeadMins: 15,

  agile: {
    enabled: true,
    endpoint: "https://api.octopus.energy/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-A/standard-unit-rates/",
    lookaheadHours: 36,
    staleMs: 6 * 60 * 60000
  },
  solar: {
    enabled: true,
    endpoint: "https://api.open-meteo.com/v1/forecast",
    lat: 52.22094,
    lon: 0.44630,
    forecastHours: 48,
    minWindowHours: 2,
    scoreThreshold: 0.55,
    maxPrecipProbPct: 60,
    staleMs: 6 * 60 * 60000
  },

  remote: {
    showerPowerW: {
      url: "http://192.168.1.76/rpc/Switch.GetStatus?id=0",
      path: "apower",
      kind: "number"
    },
    chargeCommand: {
      url: "http://192.168.1.127/rpc/Switch.GetStatus?id=0",
      path: "output",
      kind: "bool",
      invert: true
    },
    immersionCommand: {
      url: "http://192.168.1.131/rpc/Switch.GetStatus?id=0",
      path: "output",
      kind: "bool",
      invert: false
    }
  },

  pollMs: 1000,
  remotePollEveryTicks: 5,
  extPollEveryTicks: 1800,
  healthStalePowerMs: 2 * 60000
};

let V = {
  health: Virtual.getHandle("text:220"),
  fullnessPct: Virtual.getHandle("number:220"),
  confidencePct: Virtual.getHandle("number:221"),
  activity: Virtual.getHandle("text:221"),
  nextReheatMins: Virtual.getHandle("number:222"),
  plan: Virtual.getHandle("text:222")
};

let S = {
  energyKwh: 0,
  showerPowerW: 0,
  showerRunning: false,
  chargeCommand: false,
  immersionCommand: false,

  lastTickUptimeMs: 0,
  seen: {
    showerPowerW: 0,
    chargeCommand: 0,
    immersionCommand: 0,
    agile: 0,
    solar: 0
  },

  agile: { ok: false, fetchedEpochMs: 0, slots: [] },
  solar: { ok: false, fetchedEpochMs: 0, windows: [] },

  plan: {
    reason: "HOLD",
    mode: "NONE",
    nextReheatMins: 0,
    agileCandidate: { status: "none", startEpochMs: 0, priceIncVat: null },
    solarCandidate: { status: "none", startEpochMs: 0 }
  },

  errorSummary: "OK"
};

let LOOP = { tick: 0 };

function isNum(x) { return typeof x === "number" && isFinite(x) && !isNaN(x); }
function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
function nowEpochMs() { return (new Date()).getTime(); }
function round1(x) { return Math.round(x * 10) / 10; }
function round0(x) { return Math.round(x); }

function getColdC() {
  if (CFG.coldMode === "monthmap") return CFG.coldByMonthC[(new Date()).getMonth()];
  return CFG.coldFixedC;
}

function kwhPerC() { return (CFG.tankLitres * 4.186) / 3600.0; }
function energyAtStatKwh() { return Math.max(0, kwhPerC() * (CFG.statTempC - getColdC())); }
function avgTempFromEnergy(kwh) { return getColdC() + (kwh / kwhPerC()); }
function showerKwhPerMinute() { return (CFG.showerLpm * 4.186 * (CFG.showerOutTempC - getColdC())) / 3600.0; }

function standingLossPerDay(avgTempC) {
  let pts = CFG.standingLoss;
  if (avgTempC <= pts[0].c) return pts[0].kwhDay;
  if (avgTempC >= pts[pts.length - 1].c) return pts[pts.length - 1].kwhDay;
  let i;
  for (i = 0; i < pts.length - 1; i++) {
    if (avgTempC >= pts[i].c && avgTempC <= pts[i + 1].c) {
      let f = (avgTempC - pts[i].c) / (pts[i + 1].c - pts[i].c);
      return pts[i].kwhDay + f * (pts[i + 1].kwhDay - pts[i].kwhDay);
    }
  }
  return pts[pts.length - 1].kwhDay;
}

function minutesAt42FromEnergy(kwh) {
  let kpm = showerKwhPerMinute();
  if (kpm <= 0) return 0;
  return Math.max(0, kwh / kpm);
}

function getByPath(obj, path) {
  let cur = obj;
  let p = path.split(".");
  let i;
  for (i = 0; i < p.length; i++) {
    if (cur === null || typeof cur === "undefined") return null;
    cur = cur[p[i]];
  }
  return cur;
}

function parseBool(v, invert) {
  let b = null;
  if (typeof v === "boolean") b = v;
  else if (v === 1 || v === "1") b = true;
  else if (v === 0 || v === "0") b = false;
  if (b === null) return null;
  return invert ? !b : b;
}

function parseRemote(name, body) {
  let m = CFG.remote[name];
  if (!m || !body) return null;
  let raw = getByPath(body, m.path);
  if (m.kind === "number") return isNum(raw) ? raw : null;
  return parseBool(raw, !!m.invert);
}

function setError(msg) {
  S.errorSummary = msg || "OK";
}

function fetchRemote(name) {
  let m = CFG.remote[name];
  if (!m) return;
  Shelly.call("HTTP.GET", { url: m.url, timeout: 6 }, function (res, errCode) {
    if (errCode !== 0 || !res || res.code !== 200) {
      setError("REMOTE_ERR " + name);
      return;
    }
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch (e) {}
    let val = parseRemote(name, parsed);
    if (val === null) {
      setError("REMOTE_PARSE " + name);
      return;
    }
    if (name === "showerPowerW") S.showerPowerW = val;
    if (name === "chargeCommand") S.chargeCommand = val;
    if (name === "immersionCommand") S.immersionCommand = val;
    S.seen[name] = Shelly.getUptimeMs();
  });
}

function buildAgileUrl() {
  let from = (new Date()).toISOString();
  let to = (new Date(nowEpochMs() + CFG.agile.lookaheadHours * 3600000)).toISOString();
  return CFG.agile.endpoint + "?period_from=" + encodeURIComponent(from) + "&period_to=" + encodeURIComponent(to);
}

function fetchAgile() {
  if (!CFG.agile.enabled) return;
  Shelly.call("HTTP.GET", { url: buildAgileUrl(), timeout: 10 }, function (res, errCode) {
    if (errCode !== 0 || !res || res.code !== 200) {
      S.agile.ok = false;
      setError("AGILE_ERR");
      return;
    }
    let data = null;
    try { data = JSON.parse(res.body); } catch (e) {}
    if (!data || !data.results || !data.results.length) {
      S.agile.ok = false;
      setError("AGILE_PARSE");
      return;
    }
    let slots = [];
    let i;
    for (i = 0; i < data.results.length; i++) {
      let r = data.results[i];
      let f = Date.parse(r.valid_from);
      let p = r.value_inc_vat;
      if (isNum(f) && isNum(p)) slots.push({ fromEpochMs: f, priceIncVat: p });
    }
    slots.sort(function (a, b) { return a.fromEpochMs - b.fromEpochMs; });
    S.agile.ok = true;
    S.agile.fetchedEpochMs = nowEpochMs();
    S.agile.slots = slots;
    S.seen.agile = Shelly.getUptimeMs();
  });
}

function buildSolarUrl() {
  return CFG.solar.endpoint +
    "?latitude=" + CFG.solar.lat +
    "&longitude=" + CFG.solar.lon +
    "&hourly=cloud_cover,precipitation_probability" +
    "&forecast_hours=" + CFG.solar.forecastHours;
}

function fetchSolar() {
  if (!CFG.solar.enabled) return;
  Shelly.call("HTTP.GET", { url: buildSolarUrl(), timeout: 10 }, function (res, errCode) {
    if (errCode !== 0 || !res || res.code !== 200) {
      S.solar.ok = false;
      setError("SOLAR_ERR");
      return;
    }
    let data = null;
    try { data = JSON.parse(res.body); } catch (e) {}
    let h = data && data.hourly;
    if (!h || !h.time || !h.cloud_cover || !h.precipitation_probability) {
      S.solar.ok = false;
      setError("SOLAR_PARSE");
      return;
    }
    let windows = [];
    let minLen = Math.max(1, CFG.solar.minWindowHours);
    let i = 0;
    while (i < h.time.length) {
      let j = i;
      let sum = 0;
      let n = 0;
      while (j < h.time.length) {
        let cloud = h.cloud_cover[j];
        let pp = h.precipitation_probability[j];
        let score = (1 - clamp(cloud, 0, 100) / 100) * (1 - clamp(pp, 0, 100) / 100);
        if (pp > CFG.solar.maxPrecipProbPct || score < CFG.solar.scoreThreshold) break;
        sum += score;
        n++;
        j++;
      }
      if (n >= minLen) {
        windows.push({
          startEpochMs: Date.parse(h.time[i]),
          endEpochMs: Date.parse(h.time[j - 1]) + 3600000,
          avgScore: sum / n
        });
      }
      i = (j === i) ? (i + 1) : j;
    }
    S.solar.ok = true;
    S.solar.fetchedEpochMs = nowEpochMs();
    S.solar.windows = windows;
    S.seen.solar = Shelly.getUptimeMs();
  });
}

function staleByEpoch(epochMs, limitMs) {
  if (!isNum(epochMs) || epochMs <= 0) return true;
  return (nowEpochMs() - epochMs) > limitMs;
}

function updateShowerState() {
  if (!S.showerRunning && S.showerPowerW >= CFG.showerOnW) S.showerRunning = true;
  else if (S.showerRunning && S.showerPowerW <= CFG.showerOffW) S.showerRunning = false;
}

function integrate(dtMin) {
  if (dtMin <= 0) return;

  updateShowerState();

  if (S.showerRunning) {
    S.energyKwh = Math.max(0, S.energyKwh - showerKwhPerMinute() * dtMin);
  }

  let avgC = avgTempFromEnergy(S.energyKwh);
  let standLoss = (standingLossPerDay(avgC) / (24 * 60)) * dtMin;
  S.energyKwh = Math.max(0, S.energyKwh - standLoss);

  if (S.chargeCommand) {
    S.energyKwh += CFG.hpChargeKW * (dtMin / 60);
    if (S.immersionCommand) S.energyKwh += CFG.immersionKW * (dtMin / 60);
    S.energyKwh = Math.min(S.energyKwh, energyAtStatKwh());
  }
}

function computeReserveDeadlineEpoch() {
  let reserveKwh = CFG.reserveMins42 * showerKwhPerMinute();
  let e = S.energyKwh;
  let now = nowEpochMs();
  if (e <= reserveKwh) return now;

  let stepMin = 5;
  let maxMin = 48 * 60;
  let t;
  for (t = 0; t <= maxMin; t += stepMin) {
    if (e <= reserveKwh) return now + t * 60000;
    let avgC = avgTempFromEnergy(e);
    e -= (standingLossPerDay(avgC) / (24 * 60)) * stepMin;
  }
  return now + maxMin * 60000;
}

function fmtHHMM(epochMs) {
  if (!isNum(epochMs) || epochMs <= 0) return "none";
  let d = new Date(epochMs);
  let hh = d.getHours();
  let mm = d.getMinutes();
  return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
}

function fmtPkwh(price) {
  return isNum(price) ? (round1(price) + "p/kWh") : "none";
}

function chooseAgile(deadlineEpoch) {
  if (!CFG.agile.enabled) return { status: "disabled" };
  if (!S.agile.ok || staleByEpoch(S.agile.fetchedEpochMs, CFG.agile.staleMs)) return { status: "stale" };
  let now = nowEpochMs();
  let next = null;
  let best = null;
  let i;
  for (i = 0; i < S.agile.slots.length; i++) {
    let s = S.agile.slots[i];
    if (s.fromEpochMs >= now && !next) next = s;
    if (s.fromEpochMs >= now && s.fromEpochMs <= deadlineEpoch) {
      if (!best || s.priceIncVat < best.priceIncVat) best = s;
    }
  }
  return { status: best ? "ok" : "none", next: next, best: best };
}

function chooseSolar(deadlineEpoch) {
  if (!CFG.solar.enabled) return { status: "disabled" };
  if (!S.solar.ok || staleByEpoch(S.solar.fetchedEpochMs, CFG.solar.staleMs)) return { status: "stale" };
  let now = nowEpochMs();
  let next = null;
  let i;
  for (i = 0; i < S.solar.windows.length; i++) {
    let w = S.solar.windows[i];
    if (w.startEpochMs >= now) {
      if (!next || w.startEpochMs < next.startEpochMs) next = w;
      if (w.startEpochMs <= deadlineEpoch) return { status: "ok", next: next, chosen: w };
    }
  }
  return { status: "none", next: next };
}

function computePlan() {
  let now = nowEpochMs();
  let mins42 = minutesAt42FromEnergy(S.energyKwh);
  let deadline = computeReserveDeadlineEpoch();
  let latestSafeStart = Math.max(now, deadline - CFG.minLeadMins * 60000);

  let agile = chooseAgile(deadline);
  let solar = chooseSolar(deadline);

  let reason = "HOLD";
  let mode = "NONE";
  let nextStart = now;

  if (mins42 < CFG.urgentMins42) {
    reason = "URGENT";
    mode = mins42 < (CFG.urgentMins42 * 0.5) ? "NOW HP+IMM" : "NOW HP";
    nextStart = now;
  } else if (agile.status === "ok" && agile.best) {
    reason = "AGILE_PRICE";
    mode = "HP";
    nextStart = agile.best.fromEpochMs;
  } else if (solar.status === "ok" && solar.chosen) {
    reason = "SOLAR_WINDOW";
    mode = "HP";
    nextStart = solar.chosen.startEpochMs;
  } else {
    reason = "RESERVE_DEADLINE";
    mode = "HP";
    nextStart = latestSafeStart;
  }

  S.plan = {
    reason: reason,
    mode: mode,
    nextReheatMins: Math.max(0, Math.floor((nextStart - now) / 60000)),
    agileCandidate: {
      status: agile.status,
      startEpochMs: agile.next ? agile.next.fromEpochMs : 0,
      priceIncVat: agile.next ? agile.next.priceIncVat : null
    },
    solarCandidate: {
      status: solar.status,
      startEpochMs: solar.next ? solar.next.startEpochMs : 0
    }
  };
}

function confidencePct() {
  let c = 100;
  if (staleByEpoch(S.agile.fetchedEpochMs, CFG.agile.staleMs)) c -= 15;
  if (staleByEpoch(S.solar.fetchedEpochMs, CFG.solar.staleMs)) c -= 15;
  let u = Shelly.getUptimeMs();
  if (u - S.seen.showerPowerW > CFG.healthStalePowerMs) c -= 25;
  if (S.showerRunning) c -= 5;
  return clamp(round0(c), 0, 100);
}

function activityText() {
  if (S.showerRunning) return "SHOWER";
  if (S.chargeCommand && S.immersionCommand) return "CHARGING HP+IMM";
  if (S.chargeCommand) return "CHARGING HP";
  return "IDLE";
}

function planText() {
  let a = S.plan.agileCandidate;
  let s = S.plan.solarCandidate;
  let agileInfo = "agile=" + a.status + "," + fmtHHMM(a.startEpochMs) + "," + fmtPkwh(a.priceIncVat);
  let solarInfo = "solar=" + s.status + "," + fmtHHMM(s.startEpochMs);
  return "reason=" + S.plan.reason + "; action=" + S.plan.mode + "; " + agileInfo + "; " + solarInfo;
}

function healthText() {
  if (S.errorSummary !== "OK") return S.errorSummary;
  if (staleByEpoch(S.agile.fetchedEpochMs, CFG.agile.staleMs)) return "WARN AGILE_STALE";
  if (staleByEpoch(S.solar.fetchedEpochMs, CFG.solar.staleMs)) return "WARN SOLAR_STALE";
  if (Shelly.getUptimeMs() - S.seen.showerPowerW > CFG.healthStalePowerMs) return "WARN SHOWER_STALE";
  return "OK";
}

function refreshVirtuals() {
  let fullKwh = energyAtStatKwh();
  let pct = fullKwh > 0 ? (S.energyKwh / fullKwh) * 100 : 0;

  if (V.health) V.health.setValue(healthText());
  if (V.fullnessPct) V.fullnessPct.setValue(round1(clamp(pct, 0, 100)));
  if (V.confidencePct) V.confidencePct.setValue(confidencePct());
  if (V.activity) V.activity.setValue(activityText());
  if (V.nextReheatMins) V.nextReheatMins.setValue(S.plan.nextReheatMins);
  if (V.plan) V.plan.setValue(planText());
}

function tick() {
  let nowU = Shelly.getUptimeMs();
  if (S.lastTickUptimeMs <= 0) S.lastTickUptimeMs = nowU;
  let dtMin = Math.max(0, (nowU - S.lastTickUptimeMs) / 60000.0);
  S.lastTickUptimeMs = nowU;

  integrate(dtMin);
  computePlan();
  refreshVirtuals();

  LOOP.tick++;
  if (LOOP.tick % CFG.remotePollEveryTicks === 0) {
    fetchRemote("showerPowerW");
    fetchRemote("chargeCommand");
    fetchRemote("immersionCommand");
  }
  if (LOOP.tick % CFG.extPollEveryTicks === 0) {
    fetchAgile();
    fetchSolar();
  }
}

function init() {
  S.energyKwh = energyAtStatKwh();
  S.lastTickUptimeMs = Shelly.getUptimeMs();
  setError("OK");

  fetchRemote("showerPowerW");
  fetchRemote("chargeCommand");
  fetchRemote("immersionCommand");
  fetchAgile();
  fetchSolar();

  computePlan();
  refreshVirtuals();
  Timer.set(CFG.pollMs, true, tick);
}

init();
