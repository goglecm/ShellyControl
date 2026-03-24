// PART 1 OF 4
// =====================================================
// SHELLY VIRTUAL DHW TANK MODEL v3
// - Restart-safe: persists energy + timestamps, applies offline standing losses
// - 10 virtual devices total
// - Robust error registry + Health virtual device
// - Tap draw detection via top pipe temperature rise (when no shower)
// - Reheat recommendation using reserve + optional solar / Agile timing
// - Cheveley, Newmarket solar location + Octopus Agile endpoint support
// =====================================================

// --------------------
// CONFIG
// --------------------
let CFG = {
  // --- Tank model ---
  tankLitres: 114,
  statTempC: 55,
  maxTankTempC: 65,

  showerOutTempC: 42,
  showerLpm: 7.2,

  // Cold inlet: "fixed" or "monthmap"
  coldMode: "fixed",
  coldFixedC: 5,
  coldByMonthC: [5, 5, 6, 8, 11, 14, 16, 16, 13, 10, 7, 5],

  // Shower detection hysteresis
  showerOnW: 100,
  showerOffW: 20,

  // Heat pump on/off from measured power draw
  hpOnW: 400,
  hpOffW: 10,

  // Charging assumptions / thresholds
  immersionKW: 3.0,
  hpChargeKW: 2.2,
  minUsefulFeedC: 30,

  // Immersion thermostat inference
  immersionLowPowerW: 50,
  immersionLowPowerHoldMs: 30000,

  // Two-layer model
  upperFraction: 0.55,
  hpToLowerFrac: 0.75,
  immersionToUpperFrac: 1.0,

  // Shower session grouping
  showerSessionGapMs: 300000,
  reliableTopAfterRunMs: 240000,

  // Standing loss table
  standingLoss: [
    { c: 45, kwhDay: 1.24 },
    { c: 50, kwhDay: 1.49 },
    { c: 55, kwhDay: 1.74 },
    { c: 65, kwhDay: 2.23 }
  ],

  // Learning clamps
  learning: {
    hpMinKW: 1.0,
    hpMaxKW: 3.5,
    standbyMinMul: 0.5,
    standbyMaxMul: 2.0,
    showerMinMul: 0.85,
    showerMaxMul: 1.20
  },

  // --- Tap draw detection ---
  tap: {
    enabled: true,
    idleBaselineTauSec: 1800,
    riseThresholdC: 1.5,
    slopeStartCPerMin: 0.25,
    endBelowDeltaC: 0.7,
    slopeStopCPerMin: -0.10,
    minActiveMs: 20000,
    maxEventMs: 15 * 60000,
    assumedLpm: 2.0,
    assumedOutTempC: 45
  },

  // --- Reheat recommendation ---
  planner: {
    enabled: true,
    reserveMins42: 10,
    targetMins42: 22,
    urgentMins42: 7,
    minLeadMins: 15,
    maxHpMins: 240,
    maxImmMins: 180,
    horizonMins: 24 * 60
  },

  // --- External data sources ---
  solar: {
    enabled: true,
    lat: 52.22094,
    lon: 0.44630,
    forecastHours: 48,
    minWindowHours: 2,
    scoreThreshold: 0.55,
    maxPrecipProbPct: 60
  },

  agile: {
    enabled: true,
    endpoint: "https://api.octopus.energy/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-A/standard-unit-rates/",
    lookaheadHours: 36
  },

  // --- Persistence ---
  persist: {
    keyV3: "dhw_model_v3",
    keyV2Fallback: "dhw_model_v2",
    keyV1Fallback: "dhw_model_v1",
    minFlushGapMs: 60000,
    maxOfflineHours: 168
  },

  // --- Error / staleness ---
  stale: {
    fastMs: 2 * 60000,
    tempMs: 10 * 60000,
    externalMs: 6 * 60 * 60000,
    bootGraceMs: 45000
  },

  // Remote Shelly mappings
  remote: {
    hpPowerW: {
      url: "http://192.168.1.69/rpc/Switch.GetStatus?id=0",
      path: "apower",
      kind: "number"
    },
    dhwMode: {
      url: "http://192.168.1.127/rpc/Switch.GetStatus?id=0",
      path: "output",
      invert: true,
      kind: "bool"
    },
    tankDemand: {
      url: "http://192.168.1.127/rpc/Input.GetStatus?id=0",
      path: "state",
      invert: false,
      kind: "bool"
    },
    immersionOn: {
      url: "http://192.168.1.131/rpc/Switch.GetStatus?id=0",
      path: "output",
      invert: false,
      kind: "bool"
    },
    immersionPowerW: {
      url: "http://192.168.1.131/rpc/Switch.GetStatus?id=0",
      path: "apower",
      kind: "number"
    },
    showerPowerW: {
      url: "http://192.168.1.76/rpc/Switch.GetStatus?id=0",
      path: "apower",
      kind: "number"
    },
    feedC: {
      url: "http://192.168.1.127/rpc/Temperature.GetStatus?id=100",
      path: "tC",
      kind: "number"
    },
    topC: {
      url: "http://192.168.1.127/rpc/Temperature.GetStatus?id=102",
      path: "tC",
      kind: "number"
    }
  }
};

// --------------------
// 10 VIRTUAL COMPONENTS TOTAL
// --------------------
let V = {
  kwh:        Virtual.getHandle("number:200"),
  pct:        Virtual.getHandle("number:201"),
  mins42:     Virtual.getHandle("number:202"),
  conf:       Virtual.getHandle("number:203"),
  sinceFull:  Virtual.getHandle("number:204"),
  nextReheat: Virtual.getHandle("number:205"),

  state:      Virtual.getHandle("text:200"),
  liveMode:   Virtual.getHandle("text:201"),
  health:     Virtual.getHandle("text:202"),
  plan:       Virtual.getHandle("text:203")
};

// --------------------
// STATE
// --------------------
let S = {
  upperKwh: 0,
  lowerKwh: 0,
  energyKwh: 0,

  lastModelTickUptimeMs: 0,
  lastSatisfiedEpochMs: 0,
  lastUpdateEpochMs: 0,

  hpOn: false,
  hpPowerW: 0,
  dhwMode: false,
  tankDemand: true,

  immersionOn: false,
  immersionPowerW: 0,
  immersionHeatingNow: false,
  immersionLowPowerStartMs: 0,
  immersionTopConfirmedThisRun: false,

  showerPowerW: 0,
  showerRunning: false,

  feedC: null,
  topC: null,

  hpChargingNow: false,

  prevTankDemand: null,
  prevChargeActive: null,
  chargeSatisfiedThisRun: false,

  calibrationCount: 0,
  meanAbsCalErrorKwh: 0,

  learnHpKW: CFG.hpChargeKW,
  learnStandbyMul: 1.0,
  learnShowerMul: 1.0,

  partialChargeCountSinceFull: 0,
  showerSessionsSinceFull: 0,
  tapEventsSinceFull: 0,

  session: {
    active: false,
    startUptimeMs: 0,
    startEpochMs: 0,
    runtimeMs: 0,
    lastFlowUptimeMs: 0,
    reliableTopC: null
  },

  tap: {
    baselineC: null,
    lastTopC: null,
    lastTopUptimeMs: 0,
    active: false,
    activeSinceUptimeMs: 0,
    runtimeMs: 0,
    countedEvent: false
  },

  seen: {
    hpPowerW: 0,
    dhwMode: 0,
    tankDemand: 0,
    immersionOn: 0,
    immersionPowerW: 0,
    showerPowerW: 0,
    feedC: 0,
    topC: 0,
    solar: 0,
    agile: 0
  },

  err: {
    present: {}
  },

  solar: {
    ok: false,
    fetchedEpochMs: 0,
    bestStartEpochMs: 0,
    bestEndEpochMs: 0,
    bestScore: 0
  },

  agile: {
    ok: false,
    fetchedEpochMs: 0,
    slots: []
  },

  plan: {
    nextReheatMins: 0,
    mode: "NONE",
    hpMins: 0,
    immMins: 0,
    reason: "NONE",
    reasonDetail: "HOLD",
    note: "NONE"
  }
};

let POLL = {
  busy: false,
  fastList: ["hpPowerW", "dhwMode", "tankDemand", "immersionOn", "immersionPowerW", "showerPowerW"],
  tempList: ["feedC", "topC"],
  fastIndex: 0,
  tempIndex: 0,
  tick: 0
};

let EXT = {
  nextSolarUptimeMs: 0,
  nextAgileUptimeMs: 0,
  solarEveryMs: 30 * 60000,
  agileEveryMs: 30 * 60000
};

let PERSIST = {
  dirty: false,
  inFlight: false,
  loaded: false,
  lastSaveJson: null,
  lastFlushUptimeMs: 0
};

// =====================================================
// HELPERS
// =====================================================
function isNum(x) {
  return typeof x === "number" && !isNaN(x) && isFinite(x);
}

function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function fmtHHMM(epochMs) {
  let d = new Date(epochMs);
  let hh = d.getHours();
  let mm = d.getMinutes();
  return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
}

function fmtPence(priceIncVat) {
  return round1(priceIncVat) + "p";
}

function agileSummary(bestSlot, nextSlot) {
  let parts = [];
  if (bestSlot && isNum(bestSlot.fromEpochMs) && isNum(bestSlot.priceIncVat)) {
    parts.push("AGILE best " + fmtHHMM(bestSlot.fromEpochMs) + " @ " + fmtPence(bestSlot.priceIncVat));
  }
  if (nextSlot && isNum(nextSlot.fromEpochMs)) {
    let nextPrice = isNum(nextSlot.priceIncVat) ? fmtPence(nextSlot.priceIncVat) : "n/a";
    parts.push("next " + fmtHHMM(nextSlot.fromEpochMs) + " @ " + nextPrice);
  }
  return parts.join("; ");
}

function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }
function nowEpochMs() { return (new Date()).getTime(); }

function isEpochSane(ms) {
  return isNum(ms) && ms > 1577836800000 && ms < 4102444800000;
}

function getColdC() {
  if (CFG.coldMode === "monthmap") {
    let m = (new Date()).getMonth();
    return CFG.coldByMonthC[m];
  }
  return CFG.coldFixedC;
}

function kwhPerC() {
  return (CFG.tankLitres * 4.186) / 3600.0;
}

function energyFromTemp(tempC) {
  return Math.max(0, kwhPerC() * (tempC - getColdC()));
}

function avgTempFromEnergy(kwh) {
  return getColdC() + (kwh / kwhPerC());
}

function showerKwhPerMinuteBase() {
  return (CFG.showerLpm * 4.186 * (CFG.showerOutTempC - getColdC())) / 3600.0;
}

function showerKwhPerMinuteLearned() {
  return showerKwhPerMinuteBase() * S.learnShowerMul;
}

function tapKwhPerMinute() {
  return (CFG.tap.assumedLpm * 4.186 * (CFG.tap.assumedOutTempC - getColdC())) / 3600.0;
}

function standingLossPerDayBase(avgTempC) {
  let pts = CFG.standingLoss;

  if (avgTempC <= pts[0].c) return pts[0].kwhDay;
  if (avgTempC >= pts[pts.length - 1].c) return pts[pts.length - 1].kwhDay;

  for (let i = 0; i < pts.length - 1; i++) {
    if (avgTempC >= pts[i].c && avgTempC <= pts[i + 1].c) {
      let frac = (avgTempC - pts[i].c) / (pts[i + 1].c - pts[i].c);
      return pts[i].kwhDay + frac * (pts[i + 1].kwhDay - pts[i].kwhDay);
    }
  }

  return pts[pts.length - 1].kwhDay;
}

function getByPath(obj, path) {
  let cur = obj;
  let parts = path.split(".");
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || typeof cur === "undefined") return null;
    cur = cur[parts[i]];
  }
  return cur;
}

// PART 2 OF 4
function parseBoolValue(v, invert) {
  let b = null;
  if (typeof v === "boolean") b = v;
  else if (v === 1 || v === "1") b = true;
  else if (v === 0 || v === "0") b = false;
  if (b === null) return null;
  return invert ? !b : b;
}

function parseNumValue(v) {
  return isNum(v) ? v : null;
}

function markSeen(name) {
  S.seen[name] = Shelly.getUptimeMs();
}

function minutesSinceEpoch(epochMs) {
  if (!isEpochSane(epochMs)) return null;
  let dt = nowEpochMs() - epochMs;
  if (dt < 0) return null;
  return Math.floor(dt / 60000);
}

function appendQuery(url, query) {
  return url + (url.indexOf("?") >= 0 ? "&" : "?") + query;
}

// =====================================================
// ERROR REGISTRY
// =====================================================
function errSet(key, msg, severity) {
  S.err.present[key] = {
    msg: msg,
    severity: severity || 2,
    sinceUptimeMs: Shelly.getUptimeMs()
  };
}

function errClear(key) {
  if (S.err.present[key]) delete S.err.present[key];
}

function errSummary() {
  let chosen = null;
  for (let k in S.err.present) {
    if (!S.err.present[k]) continue;
    if (!chosen || S.err.present[k].severity > chosen.severity ||
        (S.err.present[k].severity === chosen.severity && S.err.present[k].sinceUptimeMs < chosen.sinceUptimeMs)) {
      chosen = S.err.present[k];
    }
  }
  return chosen ? chosen.msg : "OKAY";
}

// =====================================================
// TWO-LAYER MODEL
// =====================================================
function upperCapAtTemp(tempC) {
  return CFG.upperFraction * energyFromTemp(tempC);
}

function lowerCapAtTemp(tempC) {
  return (1.0 - CFG.upperFraction) * energyFromTemp(tempC);
}

function syncTotalEnergy() {
  S.energyKwh = S.upperKwh + S.lowerKwh;
}

function clampLayers() {
  let upperMax = upperCapAtTemp(CFG.maxTankTempC);
  let lowerMax = lowerCapAtTemp(CFG.maxTankTempC);

  S.upperKwh = clamp(S.upperKwh, 0, upperMax);
  S.lowerKwh = clamp(S.lowerKwh, 0, lowerMax);
  syncTotalEnergy();
}

function setFullAtStatTemp() {
  S.upperKwh = upperCapAtTemp(CFG.statTempC);
  S.lowerKwh = lowerCapAtTemp(CFG.statTempC);
  clampLayers();
}

function addToUpper(kwh) {
  let cap = upperCapAtTemp(CFG.maxTankTempC);
  let room = Math.max(0, cap - S.upperKwh);
  let add = Math.min(room, kwh);
  S.upperKwh += add;
  return kwh - add;
}

function addToLower(kwh) {
  let cap = lowerCapAtTemp(CFG.maxTankTempC);
  let room = Math.max(0, cap - S.lowerKwh);
  let add = Math.min(room, kwh);
  S.lowerKwh += add;
  return kwh - add;
}

function addHpEnergy(kwh) {
  if (kwh <= 0) return;
  let lowerFirst = kwh * CFG.hpToLowerFrac;
  let upperPart = kwh - lowerFirst;

  let rem = addToLower(lowerFirst);
  rem = addToUpper(upperPart + rem);
  if (rem > 0) addToLower(rem);
  clampLayers();
}

function addImmersionEnergy(kwh) {
  if (kwh <= 0) return;
  let rem = addToUpper(kwh * CFG.immersionToUpperFrac);
  if (rem > 0) addToLower(rem);
  clampLayers();
}

function removeEnergy(kwh) {
  if (kwh <= 0) return;

  let fromUpper = Math.min(S.upperKwh, kwh);
  S.upperKwh -= fromUpper;
  kwh -= fromUpper;

  if (kwh > 0) {
    let fromLower = Math.min(S.lowerKwh, kwh);
    S.lowerKwh -= fromLower;
  }

  clampLayers();
}

function applyStandingLoss(totalLossKwh) {
  if (totalLossKwh <= 0) return;
  let total = S.upperKwh + S.lowerKwh;
  if (total <= 0) return;

  let upperShare = S.upperKwh / total;
  let lowerShare = S.lowerKwh / total;

  S.upperKwh = Math.max(0, S.upperKwh - totalLossKwh * upperShare);
  S.lowerKwh = Math.max(0, S.lowerKwh - totalLossKwh * lowerShare);
  clampLayers();
}

// =====================================================
// METRIC STALENESS + DERIVED STATES
// =====================================================
function isMetricStale(name, maxAgeMs) {
  let last = S.seen[name] || 0;
  if (!last) return true;
  return (Shelly.getUptimeMs() - last) > maxAgeMs;
}

function computeHpChargingNow() {
  if (isMetricStale("hpPowerW", CFG.stale.fastMs) ||
      isMetricStale("dhwMode", CFG.stale.fastMs) ||
      isMetricStale("tankDemand", CFG.stale.fastMs)) {
    return false;
  }

  if (!(S.hpOn && S.dhwMode && S.tankDemand)) return false;

  if (!isMetricStale("feedC", CFG.stale.tempMs) && isNum(S.feedC)) {
    return S.feedC >= CFG.minUsefulFeedC;
  }
  return true;
}

function computeImmersionHeatingNow() {
  if (isMetricStale("immersionOn", CFG.stale.fastMs)) return false;
  if (!S.immersionOn) return false;

  if (!isMetricStale("immersionPowerW", CFG.stale.fastMs) && isNum(S.immersionPowerW)) {
    return S.immersionPowerW >= CFG.immersionLowPowerW;
  }
  return false;
}

function computeShowerRunning() {
  if (isMetricStale("showerPowerW", CFG.stale.fastMs) || !isNum(S.showerPowerW)) {
    return false;
  }

  if (!S.showerRunning && S.showerPowerW >= CFG.showerOnW) return true;
  if (S.showerRunning && S.showerPowerW <= CFG.showerOffW) return false;
  return S.showerRunning;
}

function currentChargeActive() {
  return S.immersionHeatingNow || S.hpChargingNow;
}

// =====================================================
// SHOWER SESSION GROUPING
// =====================================================
function startShowerSession() {
  if (S.session.active) return;

  let nowU = Shelly.getUptimeMs();
  S.session.active = true;
  S.session.startUptimeMs = nowU;
  S.session.startEpochMs = nowEpochMs();
  S.session.runtimeMs = 0;
  S.session.lastFlowUptimeMs = nowU;
  S.session.reliableTopC = null;
}

function finalizeShowerSession() {
  if (!S.session.active) return;

  if (S.session.runtimeMs >= CFG.reliableTopAfterRunMs && isNum(S.session.reliableTopC)) {
    let topC = clamp(S.session.reliableTopC, getColdC(), CFG.maxTankTempC);
    let targetUpper = upperCapAtTemp(topC);
    if (S.upperKwh > targetUpper) {
      S.upperKwh = targetUpper;
      clampLayers();
    }
  }

  S.showerSessionsSinceFull += 1;

  S.session.active = false;
  S.session.startUptimeMs = 0;
  S.session.startEpochMs = 0;
  S.session.runtimeMs = 0;
  S.session.lastFlowUptimeMs = 0;
  S.session.reliableTopC = null;
}

// =====================================================
// TAP DRAW DETECTION
// =====================================================
function isHydraulicallyIdle() {
  return !S.showerRunning && !S.hpChargingNow && !S.immersionHeatingNow;
}

function resetTapEvent() {
  S.tap.active = false;
  S.tap.activeSinceUptimeMs = 0;
  S.tap.runtimeMs = 0;
  S.tap.countedEvent = false;
}

function updateTapBaseline(dtSec) {
  if (!isNum(S.topC)) return;
  if (!isHydraulicallyIdle()) return;
  if (S.tap.active) return;

  if (!isNum(S.tap.baselineC)) {
    S.tap.baselineC = S.topC;
    return;
  }

  let tau = Math.max(30, CFG.tap.idleBaselineTauSec);
  let alpha = 1.0 - Math.exp(-dtSec / tau);
  S.tap.baselineC = (1 - alpha) * S.tap.baselineC + alpha * S.topC;
}

function updateTapDetection(dtMs) {
  if (!CFG.tap.enabled) return;

  if (isMetricStale("topC", CFG.stale.tempMs) || !isNum(S.topC)) {
    resetTapEvent();
    S.tap.lastTopC = null;
    S.tap.lastTopUptimeMs = 0;
    return;
  }

  let nowU = Shelly.getUptimeMs();
  let dtSec = Math.max(0.001, dtMs / 1000.0);

  updateTapBaseline(dtSec);

  let slopeCPerMin = 0;
  if (isNum(S.tap.lastTopC) && S.tap.lastTopUptimeMs) {
    let dC = S.topC - S.tap.lastTopC;
    let dMin = Math.max(0.001, (nowU - S.tap.lastTopUptimeMs) / 60000.0);
    slopeCPerMin = dC / dMin;
  }
  S.tap.lastTopC = S.topC;
  S.tap.lastTopUptimeMs = nowU;

  if (!isHydraulicallyIdle()) {
    resetTapEvent();
    return;
  }

  if (!isNum(S.tap.baselineC)) return;

  let delta = S.topC - S.tap.baselineC;

  if (!S.tap.active) {
    if (delta >= CFG.tap.riseThresholdC && slopeCPerMin >= CFG.tap.slopeStartCPerMin) {
      S.tap.active = true;
      S.tap.activeSinceUptimeMs = nowU;
      S.tap.runtimeMs = 0;
      S.tap.countedEvent = false;
    }
    return;
  }

  S.tap.runtimeMs += dtMs;

  if ((nowU - S.tap.activeSinceUptimeMs) >= CFG.tap.minActiveMs) {
    removeEnergy(tapKwhPerMinute() * (dtMs / 60000.0));
    if (!S.tap.countedEvent) {
      S.tapEventsSinceFull += 1;
      S.tap.countedEvent = true;
    }
  }

  if (S.tap.runtimeMs >= CFG.reliableTopAfterRunMs) {
    let topC = clamp(S.topC, getColdC(), CFG.maxTankTempC);
    let targetUpper = upperCapAtTemp(topC);
    if (S.upperKwh > targetUpper) {
      S.upperKwh = targetUpper;
      clampLayers();
    }
  }

  let activeLongEnough = (nowU - S.tap.activeSinceUptimeMs) >= CFG.tap.minActiveMs;
  let tooLong = S.tap.runtimeMs >= CFG.tap.maxEventMs;

  if ((activeLongEnough && delta <= CFG.tap.endBelowDeltaC && slopeCPerMin <= 0.05) ||
      (activeLongEnough && slopeCPerMin <= CFG.tap.slopeStopCPerMin) ||
      tooLong) {
    resetTapEvent();
  }
}

// =====================================================
// INTEGRATION
// =====================================================
function integrateModel(dtMs) {
  let dtHours = dtMs / 3600000.0;
  if (dtHours <= 0) return;

  if (S.hpChargingNow) {
    addHpEnergy(S.learnHpKW * dtHours);
  }

  if (S.immersionHeatingNow) {
    let immKW = CFG.immersionKW;
    if (!isMetricStale("immersionPowerW", CFG.stale.fastMs) && isNum(S.immersionPowerW)) {
      immKW = S.immersionPowerW / 1000.0;
    }
    addImmersionEnergy(immKW * dtHours);
  }

  if (S.showerRunning) {
    removeEnergy(showerKwhPerMinuteLearned() * (dtMs / 60000.0));
    if (S.session.active) {
      S.session.runtimeMs += dtMs;
      S.session.lastFlowUptimeMs = Shelly.getUptimeMs();
    }
  }

  let avgTempC = avgTempFromEnergy(S.energyKwh);
  let standby = (standingLossPerDayBase(avgTempC) * S.learnStandbyMul / 24.0) * dtHours;
  applyStandingLoss(standby);
}

// =====================================================
// FULL CALIBRATION
// =====================================================
function snapTankToFull() {
  let fullKwh = energyFromTemp(CFG.statTempC);
  let signedErr = S.energyKwh - fullKwh;
  let absErr = Math.abs(signedErr);

  S.calibrationCount += 1;
  if (S.calibrationCount === 1) {
    S.meanAbsCalErrorKwh = absErr;
  } else {
    S.meanAbsCalErrorKwh = ((S.meanAbsCalErrorKwh * (S.calibrationCount - 1)) + absErr) / S.calibrationCount;
  }

  if (absErr > 0.2) {
    let factor = 1.0 + clamp(signedErr / Math.max(0.5, fullKwh), -0.05, 0.05);
    S.learnStandbyMul = clamp(S.learnStandbyMul * factor, CFG.learning.standbyMinMul, CFG.learning.standbyMaxMul);
  }

  setFullAtStatTemp();
  S.lastSatisfiedEpochMs = nowEpochMs();
  S.partialChargeCountSinceFull = 0;
  S.showerSessionsSinceFull = 0;
  S.tapEventsSinceFull = 0;
  S.chargeSatisfiedThisRun = true;
}

// =====================================================
// CONFIDENCE + DISPLAY HELPERS
// =====================================================

// PART 3 OF 4
function litres42Remaining() {
  let denom = 4.186 * (CFG.showerOutTempC - getColdC());
  if (denom <= 0) return 0;
  return Math.max(0, (S.energyKwh * 3600.0) / denom);
}

function minutes42Remaining() {
  return litres42Remaining() / CFG.showerLpm;
}

function tankState() {
  let mins = minutes42Remaining();
  if (mins < 8) return "LOW";
  if (mins < 15) return "1 short shower";
  if (mins < 22) return "1 shower";
  return "OK";
}

function liveModeText() {
  if (S.showerRunning) return "SHOWER";
  if (S.tap.active) return "TAP";
  if (S.immersionHeatingNow && S.hpChargingNow) return "HP+IMM";
  if (S.immersionHeatingNow) return "IMMERSION";
  if (S.hpChargingNow) return "HP+DHW";
  return "IDLE";
}

function computeConfidence() {
  let c = 100;
  let minsFromFull = minutesSinceEpoch(S.lastSatisfiedEpochMs);

  if (minsFromFull === null) c = 55;
  else c -= Math.min(35, minsFromFull / 20);

  c -= Math.min(24, S.showerSessionsSinceFull * 8);
  c -= Math.min(12, S.tapEventsSinceFull * 2);
  c -= Math.min(20, S.partialChargeCountSinceFull * 5);

  if (isMetricStale("feedC", CFG.stale.tempMs)) c -= 8;
  if (isMetricStale("topC", CFG.stale.tempMs)) c -= 4;
  if (isMetricStale("hpPowerW", CFG.stale.fastMs)) c -= 6;
  if (isMetricStale("immersionPowerW", CFG.stale.fastMs)) c -= 4;
  if (isMetricStale("showerPowerW", CFG.stale.fastMs)) c -= 4;

  c -= Math.min(15, S.meanAbsCalErrorKwh * 5);
  return clamp(Math.round(c), 10, 100);
}

function planText() {
  if (!S.plan || S.plan.mode === "NONE") return "HOLD";
  if (S.plan.nextReheatMins <= 0) return "NOW " + S.plan.note;
  return "IN " + S.plan.nextReheatMins + "m " + S.plan.note;
}

function refreshVirtuals() {
  let fullKwh = energyFromTemp(CFG.statTempC);
  let pct = fullKwh > 0 ? (100.0 * S.energyKwh / fullKwh) : 0;
  let sinceFull = minutesSinceEpoch(S.lastSatisfiedEpochMs);

  if (V.kwh)        V.kwh.setValue(round2(S.energyKwh));
  if (V.pct)        V.pct.setValue(round1(clamp(pct, 0, 150)));
  if (V.mins42)     V.mins42.setValue(round1(minutes42Remaining()));
  if (V.conf)       V.conf.setValue(computeConfidence());
  if (V.sinceFull)  V.sinceFull.setValue(sinceFull !== null ? sinceFull : -1);
  if (V.nextReheat) V.nextReheat.setValue(S.plan.nextReheatMins);

  if (V.state)      V.state.setValue(tankState());
  if (V.liveMode)   V.liveMode.setValue(liveModeText());
  if (V.health)     V.health.setValue(errSummary());
  if (V.plan)       V.plan.setValue(planText());
}

// =====================================================
// PLANNER
// =====================================================
function computeTimeToReserveMins(reserveKwh) {
  if (S.energyKwh <= reserveKwh) return 0;

  let avgTempC = avgTempFromEnergy(S.energyKwh);
  let standbyKw = (standingLossPerDayBase(avgTempC) * S.learnStandbyMul) / 24.0;
  if (standbyKw <= 0.0001) return CFG.planner.horizonMins;

  let hours = (S.energyKwh - reserveKwh) / standbyKw;
  if (!isNum(hours) || hours < 0) return 0;
  return clamp(Math.floor(hours * 60), 0, CFG.planner.horizonMins);
}

function computeReheatPlan() {
  if (!CFG.planner.enabled) return;

  let mins = minutes42Remaining();
  let kwhPerMin42 = showerKwhPerMinuteBase();
  let reserveKwh = CFG.planner.reserveMins42 * kwhPerMin42;
  let targetKwh = CFG.planner.targetMins42 * kwhPerMin42;
  let immediateNeededKwh = Math.max(0, targetKwh - S.energyKwh);
  let futureRefillKwh = Math.max(0, targetKwh - reserveKwh);
  let planKwh = immediateNeededKwh > 0.05 ? immediateNeededKwh : futureRefillKwh;
  let minsToReserve = computeTimeToReserveMins(reserveKwh);
  let latestSafeStart = Math.max(0, minsToReserve - CFG.planner.minLeadMins);

  let plan = {
    nextReheatMins: minsToReserve,
    mode: "NONE",
    hpMins: 0,
    immMins: 0,
    reason: "NONE",
    reasonDetail: "HOLD",
    note: "HOLD",
    agileBestSlot: null,
    agileNextSlot: null
  };

  if (planKwh <= 0.05) {
    S.plan = plan;
    return;
  }

  let hpMins = clamp(Math.ceil((planKwh / Math.max(0.5, S.learnHpKW)) * 60), 0, CFG.planner.maxHpMins);
  let immMins = clamp(Math.ceil((planKwh / CFG.immersionKW) * 60), 0, CFG.planner.maxImmMins);

  if (mins <= CFG.planner.urgentMins42 || minsToReserve <= CFG.planner.minLeadMins) {
    plan.nextReheatMins = 0;
    plan.reason = mins <= CFG.planner.urgentMins42 ? "URGENT_LOW_MINS" : "URGENT_RESERVE_LEAD";
    if (mins <= 3) {
      plan.mode = "HP+IMM";
      plan.hpMins = hpMins;
      plan.immMins = immMins;
      plan.reasonDetail = "HP+IMM UNTIL SAT";
      plan.note = plan.reasonDetail + " [" + plan.reason + "]";
    } else {
      plan.mode = "HP";
      plan.hpMins = hpMins;
      plan.reasonDetail = "HP " + hpMins + "m";
      plan.note = plan.reasonDetail + " [" + plan.reason + "]";
    }
    S.plan = plan;
    return;
  }

  let nowE = nowEpochMs();
  let solarInMins = null;
  let agileInMins = null;
  let agileBestSlot = null;
  let agileNextSlot = null;
  let agileDeadlineEpochMs = nowE + latestSafeStart * 60000;

  if (CFG.solar.enabled && S.solar.ok && isEpochSane(S.solar.bestStartEpochMs)) {
    let dt = S.solar.bestStartEpochMs - nowE;
    if (dt >= 0) solarInMins = Math.floor(dt / 60000);
  }

  if (CFG.agile.enabled && S.agile.ok && S.agile.slots.length > 0) {
    for (let i = 0; i < S.agile.slots.length; i++) {
      let slot = S.agile.slots[i];
      if (!slot || !isNum(slot.fromEpochMs)) continue;

      if (slot.fromEpochMs >= nowE) {
        if (!agileNextSlot || slot.fromEpochMs < agileNextSlot.fromEpochMs) {
          agileNextSlot = slot;
        }
      }

      if (!isNum(slot.priceIncVat)) continue;
      if (slot.fromEpochMs < nowE || slot.fromEpochMs > agileDeadlineEpochMs) continue;

      if (!agileBestSlot || slot.priceIncVat < agileBestSlot.priceIncVat ||
          (slot.priceIncVat === agileBestSlot.priceIncVat && slot.fromEpochMs < agileBestSlot.fromEpochMs)) {
        agileBestSlot = slot;
      }
    }
    if (agileBestSlot) agileInMins = Math.floor((agileBestSlot.fromEpochMs - nowE) / 60000);
  }

  plan.agileBestSlot = agileBestSlot;
  plan.agileNextSlot = agileNextSlot;

  function decoratePlanNote() {
    let summary = agileSummary(plan.agileBestSlot, plan.agileNextSlot);
    if (summary) plan.note = plan.note + " | " + summary;
  }

  if (solarInMins !== null && solarInMins <= latestSafeStart && solarInMins <= CFG.planner.horizonMins) {
    plan.nextReheatMins = solarInMins;
    plan.mode = "IMMERSION";
    plan.immMins = immMins;
    plan.reason = "SOLAR_WINDOW";
    plan.reasonDetail = "IMM " + immMins + "m";
    plan.note = plan.reasonDetail + " [" + plan.reason + "]";
    decoratePlanNote();
    S.plan = plan;
    return;
  }

  if (agileInMins !== null && agileInMins <= latestSafeStart && agileInMins <= CFG.planner.horizonMins) {
    plan.nextReheatMins = agileInMins;
    plan.mode = "HP";
    plan.hpMins = hpMins;
    plan.reason = "AGILE_PRICE";
    plan.reasonDetail = "HP " + hpMins + "m";
    plan.note = plan.reasonDetail + " [" + plan.reason + "]";
    decoratePlanNote();
    S.plan = plan;
    return;
  }

  if (minsToReserve >= CFG.planner.horizonMins && immediateNeededKwh <= 0.05) {
    S.plan = plan;
    return;
  }

  plan.nextReheatMins = latestSafeStart;
  plan.mode = "HP";
  plan.hpMins = hpMins;
  plan.reason = "RESERVE_DEADLINE";
  plan.reasonDetail = "HP " + hpMins + "m (no AGILE <= deadline)";
  plan.note = plan.reasonDetail + " [" + plan.reason + "]";
  decoratePlanNote();
  S.plan = plan;
}

// =====================================================
// EXTERNAL FETCHERS
// =====================================================
function buildSolarUrl() {
  return "https://api.open-meteo.com/v1/forecast" +
    "?latitude=" + CFG.solar.lat +
    "&longitude=" + CFG.solar.lon +
    "&hourly=shortwave_radiation,cloud_cover,precipitation_probability" +
    "&forecast_hours=" + CFG.solar.forecastHours +
    "&timeformat=unixtime";
}

function buildAgileUrl() {
  let from = (new Date()).toISOString();
  let to = (new Date(nowEpochMs() + CFG.agile.lookaheadHours * 3600000)).toISOString();
  return appendQuery(CFG.agile.endpoint, "period_from=" + encodeURIComponent(from) + "&period_to=" + encodeURIComponent(to));
}

function parseSolarResponse(obj) {
  if (!obj || !obj.hourly) return false;

  let t = obj.hourly.time;
  let sw = obj.hourly.shortwave_radiation;
  let cc = obj.hourly.cloud_cover;
  let pp = obj.hourly.precipitation_probability;
  if (!t || !sw || !cc || !pp) return false;

  let n = Math.min(t.length, sw.length, cc.length, pp.length);
  if (n < 6) return false;

  let scores = [];
  for (let i = 0; i < n; i++) {
    let swN = clamp(sw[i] / 800.0, 0, 1);
    let cloud = clamp(cc[i] / 100.0, 0, 1);
    let rainP = clamp(pp[i] / 100.0, 0, 1);

    if (pp[i] >= CFG.solar.maxPrecipProbPct) {
      scores.push(0);
      continue;
    }

    let score = swN * (1 - 0.85 * cloud) * (1 - 0.60 * rainP);
    scores.push(clamp(score, 0, 1));
  }

  let minLen = Math.max(1, CFG.solar.minWindowHours);
  let bestStart = -1, bestEnd = -1, bestScore = 0;

  for (let i = 0; i <= n - minLen; i++) {
    for (let len = minLen; len <= Math.min(n - i, 8); len++) {
      let sum = 0;
      for (let j = 0; j < len; j++) sum += scores[i + j];
      let avg = sum / len;
      if (avg >= CFG.solar.scoreThreshold && avg > bestScore) {
        bestScore = avg;
        bestStart = i;
        bestEnd = i + len - 1;
      }
    }
  }

  S.solar.ok = true;
  S.solar.fetchedEpochMs = nowEpochMs();

  if (bestStart < 0) {
    S.solar.bestStartEpochMs = 0;
    S.solar.bestEndEpochMs = 0;
    S.solar.bestScore = 0;
    return true;
  }

  S.solar.bestStartEpochMs = t[bestStart] * 1000;
  S.solar.bestEndEpochMs = t[bestEnd] * 1000 + 3600000;
  S.solar.bestScore = bestScore;
  return true;
}

function parseAgileResponse(obj) {
  if (!obj || !obj.results || !obj.results.length) return false;

  let slots = [];
  for (let i = 0; i < obj.results.length; i++) {
    let r = obj.results[i];
    if (!r || !r.valid_from || !r.valid_to) continue;

    let p = isNum(r.value_inc_vat) ? r.value_inc_vat : (isNum(r.value_exc_vat) ? r.value_exc_vat : null);
    if (p === null) continue;

    let fromE = Date.parse(r.valid_from);
    let toE = Date.parse(r.valid_to);
    if (!isEpochSane(fromE) || !isEpochSane(toE)) continue;

    slots.push({ fromEpochMs: fromE, toEpochMs: toE, priceIncVat: p });
  }

  if (!slots.length) return false;
  S.agile.ok = true;
  S.agile.fetchedEpochMs = nowEpochMs();
  S.agile.slots = slots;
  return true;
}

// =====================================================
// HTTP CALLBACK
// =====================================================
function onHttp(result, error_code, error_message, userdata) {
  POLL.busy = false;

  if (error_code !== 0 || !result || result.code !== 200 || !result.body) {
    errSet("http_" + userdata.name, "HTTP fail " + userdata.name + " (" + error_code + ")", 2);
    return;
  }

  let obj = null;
  try {
    obj = JSON.parse(result.body);
  } catch (e) {
    errSet("json_" + userdata.name, "Bad JSON " + userdata.name, 2);
    return;
  }

  if (userdata.type === "metric") {
    let value = getByPath(obj, userdata.path);
    let kind = userdata.kind;

    if (kind === "number") {
      value = parseNumValue(value);
      if (value === null) {
        errSet("bad_" + userdata.name, "BAD " + userdata.name, 1);
        return;
      }
    } else if (kind === "bool") {
      value = parseBoolValue(value, userdata.invert);
      if (value === null) {
        errSet("bad_" + userdata.name, "BAD " + userdata.name, 1);
        return;
      }
    }

    errClear("http_" + userdata.name);
    errClear("json_" + userdata.name);
    errClear("bad_" + userdata.name);

    if (userdata.name === "hpPowerW") {
      S.hpPowerW = value;
    } else if (userdata.name === "dhwMode") {
      S.dhwMode = value;
    } else if (userdata.name === "tankDemand") {
      S.tankDemand = value;
    } else if (userdata.name === "immersionOn") {
      S.immersionOn = value;
    } else if (userdata.name === "immersionPowerW") {
      S.immersionPowerW = value;
    } else if (userdata.name === "showerPowerW") {
      S.showerPowerW = value;
    } else if (userdata.name === "feedC") {
      S.feedC = value;
    } else if (userdata.name === "topC") {
      S.topC = value;
    }

    markSeen(userdata.name);
    return;
  }

  if (userdata.type === "solar") {
    if (parseSolarResponse(obj)) {
      markSeen("solar");
      errClear("http_solar");
      errClear("json_solar");
      errClear("solar_parse");
    } else {
      errSet("solar_parse", "SOLAR parse failed", 1);
    }
    return;
  }

  if (userdata.type === "agile") {
    if (parseAgileResponse(obj)) {
      markSeen("agile");
      errClear("http_agile");
      errClear("json_agile");
      errClear("agile_parse");
    } else {
      errSet("agile_parse", "AGILE parse failed", 1);
    }
  }
}

// =====================================================
// FETCH HELPERS
// =====================================================
function fetchMetric(name) {
  let m = CFG.remote[name];
  if (!m || !m.url || !m.path) return;
  if (POLL.busy || PERSIST.inFlight) return;

  POLL.busy = true;
  let timeout = (name === "feedC" || name === "topC") ? 10 : 5;
  Shelly.call("HTTP.GET", { url: m.url, timeout: timeout }, onHttp,
    { type: "metric", name: name, path: m.path, invert: !!m.invert, kind: m.kind });
}

function fetchSolar() {
  if (!CFG.solar.enabled || POLL.busy || PERSIST.inFlight) return;
  POLL.busy = true;
  Shelly.call("HTTP.GET", { url: buildSolarUrl(), timeout: 10 }, onHttp, { type: "solar", name: "solar" });
}

function fetchAgile() {
  if (!CFG.agile.enabled || POLL.busy || PERSIST.inFlight) return;
  POLL.busy = true;
  Shelly.call("HTTP.GET", { url: buildAgileUrl(), timeout: 10 }, onHttp, { type: "agile", name: "agile" });
}

// PART 4 OF 4
// =====================================================
// STALENESS => PRESENT ERRORS
// =====================================================
function updateStaleErrors() {
  if (Shelly.getUptimeMs() < CFG.stale.bootGraceMs) return;

  let fast = ["hpPowerW", "dhwMode", "tankDemand", "immersionOn", "immersionPowerW", "showerPowerW"];
  for (let i = 0; i < fast.length; i++) {
    let n = fast[i];
    if (isMetricStale(n, CFG.stale.fastMs)) errSet("stale_" + n, "STALE " + n, 1);
    else errClear("stale_" + n);
  }

  let temps = ["feedC", "topC"];
  for (let j = 0; j < temps.length; j++) {
    let t = temps[j];
    if (isMetricStale(t, CFG.stale.tempMs)) errSet("stale_" + t, "STALE " + t, 1);
    else errClear("stale_" + t);
  }

  if (CFG.solar.enabled) {
    if (isMetricStale("solar", CFG.stale.externalMs)) errSet("stale_solar", "STALE solar", 1);
    else errClear("stale_solar");
  }

  if (CFG.agile.enabled) {
    if (isMetricStale("agile", CFG.stale.externalMs)) errSet("stale_agile", "STALE agile", 1);
    else errClear("stale_agile");
  }
}

// =====================================================
// PERSISTENCE
// =====================================================
function markPersistDirty() {
  PERSIST.dirty = true;
}

function persistSnapshotV3() {
  return {
    v: 3,
    t: S.lastUpdateEpochMs,
    st: S.lastSatisfiedEpochMs,
    u: round2(S.upperKwh),
    l: round2(S.lowerKwh),
    hp: round2(S.learnHpKW),
    sb: round2(S.learnStandbyMul),
    sh: round2(S.learnShowerMul),
    cc: S.calibrationCount,
    mae: round2(S.meanAbsCalErrorKwh)
  };
}

function applyPersistedSnapshot(obj) {
  if (!obj || typeof obj !== "object") return;

  if (isNum(obj.learnHpKW)) S.learnHpKW = clamp(obj.learnHpKW, CFG.learning.hpMinKW, CFG.learning.hpMaxKW);
  if (isNum(obj.learnStandbyMul)) S.learnStandbyMul = clamp(obj.learnStandbyMul, CFG.learning.standbyMinMul, CFG.learning.standbyMaxMul);
  if (isNum(obj.learnShowerMul)) S.learnShowerMul = clamp(obj.learnShowerMul, CFG.learning.showerMinMul, CFG.learning.showerMaxMul);
  if (isNum(obj.calibrationCount)) S.calibrationCount = Math.max(0, Math.floor(obj.calibrationCount));
  if (isNum(obj.meanAbsCalErrorKwh)) S.meanAbsCalErrorKwh = Math.max(0, obj.meanAbsCalErrorKwh);

  if (isNum(obj.hp)) S.learnHpKW = clamp(obj.hp, CFG.learning.hpMinKW, CFG.learning.hpMaxKW);
  if (isNum(obj.sb)) S.learnStandbyMul = clamp(obj.sb, CFG.learning.standbyMinMul, CFG.learning.standbyMaxMul);
  if (isNum(obj.sh)) S.learnShowerMul = clamp(obj.sh, CFG.learning.showerMinMul, CFG.learning.showerMaxMul);
  if (isNum(obj.cc)) S.calibrationCount = Math.max(0, Math.floor(obj.cc));
  if (isNum(obj.mae)) S.meanAbsCalErrorKwh = Math.max(0, obj.mae);

  if (isNum(obj.u)) S.upperKwh = Math.max(0, obj.u);
  if (isNum(obj.l)) S.lowerKwh = Math.max(0, obj.l);
  if (isNum(obj.t)) S.lastUpdateEpochMs = obj.t;
  if (isNum(obj.st)) S.lastSatisfiedEpochMs = obj.st;

  clampLayers();
}

function completeLoad() {
  if (PERSIST.loaded) return;
  applyOfflineLossIfNeeded();
  PERSIST.loaded = true;
  markPersistDirty();
  refreshVirtuals();
  flushPersistedModel(true);
}

function onKvsGetV1(result, error_code, error_message) {
  if (error_code === -105) {
    setFullAtStatTemp();
    errClear("kvs_get");
    errClear("kvs_parse");
    completeLoad();
    return;
  }

  if (error_code !== 0) {
    errSet("kvs_get", "KVS.Get v1 failed (" + error_code + ")", 2);
    setFullAtStatTemp();
    completeLoad();
    return;
  }

  let raw = (result && typeof result.value !== "undefined") ? result.value : result;
  try {
    let obj = (typeof raw === "string") ? JSON.parse(raw) : raw;
    applyPersistedSnapshot(obj);
    if (!isNum(obj.u) || !isNum(obj.l)) setFullAtStatTemp();
    errClear("kvs_get");
    errClear("kvs_parse");
    completeLoad();
  } catch (e) {
    errSet("kvs_parse", "KVS parse error", 2);
    setFullAtStatTemp();
    completeLoad();
  }
}

function onKvsGetV2(result, error_code, error_message) {
  if (error_code === -105) {
    Shelly.call("KVS.Get", { key: CFG.persist.keyV1Fallback }, onKvsGetV1);
    return;
  }

  if (error_code !== 0) {
    errSet("kvs_get", "KVS.Get v2 failed (" + error_code + ")", 2);
    setFullAtStatTemp();
    completeLoad();
    return;
  }

  let raw = (result && typeof result.value !== "undefined") ? result.value : result;
  try {
    let obj = (typeof raw === "string") ? JSON.parse(raw) : raw;
    applyPersistedSnapshot(obj);
    PERSIST.lastSaveJson = (typeof raw === "string") ? raw : JSON.stringify(obj);
    errClear("kvs_get");
    errClear("kvs_parse");
    completeLoad();
  } catch (e) {
    errSet("kvs_parse", "KVS parse error", 2);
    setFullAtStatTemp();
    completeLoad();
  }
}

function onKvsGetV3(result, error_code, error_message) {
  PERSIST.inFlight = false;

  if (error_code === -105) {
    Shelly.call("KVS.Get", { key: CFG.persist.keyV2Fallback }, onKvsGetV2);
    return;
  }

  if (error_code !== 0) {
    errSet("kvs_get", "KVS.Get failed (" + error_code + ")", 2);
    setFullAtStatTemp();
    completeLoad();
    return;
  }

  let raw = (result && typeof result.value !== "undefined") ? result.value : result;
  try {
    let obj = (typeof raw === "string") ? JSON.parse(raw) : raw;
    applyPersistedSnapshot(obj);
    PERSIST.lastSaveJson = (typeof raw === "string") ? raw : JSON.stringify(obj);
    errClear("kvs_get");
    errClear("kvs_parse");
    completeLoad();
  } catch (e) {
    errSet("kvs_parse", "KVS parse error", 2);
    setFullAtStatTemp();
    completeLoad();
  }
}

function loadPersistedModel() {
  if (PERSIST.inFlight || PERSIST.loaded) return;
  PERSIST.inFlight = true;
  Shelly.call("KVS.Get", { key: CFG.persist.keyV3 }, onKvsGetV3);
}

function flushPersistedModel(force) {
  let nowU = Shelly.getUptimeMs();
  if (!PERSIST.loaded && !force) return;
  if (!PERSIST.dirty && !force) return;
  if (PERSIST.inFlight) return;
  if (!force && (nowU - PERSIST.lastFlushUptimeMs) < CFG.persist.minFlushGapMs) return;

  S.lastUpdateEpochMs = nowEpochMs();
  let json = JSON.stringify(persistSnapshotV3());

  if (!force && json === PERSIST.lastSaveJson) {
    PERSIST.dirty = false;
    return;
  }

  PERSIST.inFlight = true;
  Shelly.call("KVS.Set", { key: CFG.persist.keyV3, value: json }, function(res, ec, em) {
    PERSIST.inFlight = false;
    if (ec !== 0) {
      errSet("kvs_set", "KVS.Set failed (" + ec + ")", 2);
      return;
    }
    errClear("kvs_set");
    PERSIST.lastSaveJson = json;
    PERSIST.lastFlushUptimeMs = Shelly.getUptimeMs();
    PERSIST.dirty = false;
  });
}

function applyOfflineLossIfNeeded() {
  if (!isEpochSane(S.lastUpdateEpochMs)) return;

  let dtHours = (nowEpochMs() - S.lastUpdateEpochMs) / 3600000.0;
  if (!isNum(dtHours) || dtHours <= 0.02) return;
  dtHours = Math.min(dtHours, CFG.persist.maxOfflineHours);

  while (dtHours > 0) {
    let h = Math.min(1.0, dtHours);
    let avgTempC = avgTempFromEnergy(S.energyKwh);
    let standby = (standingLossPerDayBase(avgTempC) * S.learnStandbyMul / 24.0) * h;
    applyStandingLoss(standby);
    dtHours -= h;
  }
}

// =====================================================
// MAIN TICKS
// =====================================================
function modelTick() {
  if (!PERSIST.loaded) return;

  let nowU = Shelly.getUptimeMs();
  if (!S.lastModelTickUptimeMs) {
    S.lastModelTickUptimeMs = nowU;
    return;
  }

  let dtMs = nowU - S.lastModelTickUptimeMs;
  if (dtMs <= 0) return;

  if (!isMetricStale("hpPowerW", CFG.stale.fastMs) && isNum(S.hpPowerW)) {
    if (!S.hpOn && S.hpPowerW >= CFG.hpOnW) S.hpOn = true;
    else if (S.hpOn && S.hpPowerW <= CFG.hpOffW) S.hpOn = false;
  } else {
    S.hpOn = false;
  }

  S.showerRunning = computeShowerRunning();

  if (S.showerRunning && !S.session.active) {
    startShowerSession();
  }

  if (!S.showerRunning && S.session.active && (nowU - S.session.lastFlowUptimeMs) >= CFG.showerSessionGapMs) {
    finalizeShowerSession();
  }

  S.hpChargingNow = computeHpChargingNow();
  S.immersionHeatingNow = computeImmersionHeatingNow();

  if (S.session.active && S.showerRunning && S.session.runtimeMs >= CFG.reliableTopAfterRunMs && isNum(S.topC)) {
    S.session.reliableTopC = S.topC;
  }

  if (S.immersionOn && !isMetricStale("immersionPowerW", CFG.stale.fastMs) && isNum(S.immersionPowerW)) {
    if (S.immersionPowerW < CFG.immersionLowPowerW) {
      if (!S.immersionLowPowerStartMs) S.immersionLowPowerStartMs = nowU;
      else if (!S.immersionTopConfirmedThisRun && (nowU - S.immersionLowPowerStartMs) >= CFG.immersionLowPowerHoldMs) {
        let targetUpper = upperCapAtTemp(65);
        if (S.upperKwh < targetUpper) {
          S.upperKwh = targetUpper;
          clampLayers();
        }
        S.immersionTopConfirmedThisRun = true;
      }
    } else {
      S.immersionLowPowerStartMs = 0;
    }
  } else {
    S.immersionLowPowerStartMs = 0;
    S.immersionTopConfirmedThisRun = false;
  }

  integrateModel(dtMs);
  updateTapDetection(dtMs);

  let chargeActive = currentChargeActive();
  if (S.prevChargeActive === null) S.prevChargeActive = chargeActive;
  if (S.prevTankDemand === null) S.prevTankDemand = S.tankDemand;

  if (!S.prevChargeActive && chargeActive) {
    S.chargeSatisfiedThisRun = false;
  }

  let tankDemandFresh = !isMetricStale("tankDemand", CFG.stale.fastMs);
  let demandDropped = tankDemandFresh && S.prevTankDemand === true && S.tankDemand === false;
  if (demandDropped && chargeActive) {
    snapTankToFull();
  }

  if (S.prevChargeActive && !chargeActive && !S.chargeSatisfiedThisRun) {
    S.partialChargeCountSinceFull += 1;
  }

  S.prevTankDemand = S.tankDemand;
  S.prevChargeActive = chargeActive;

  updateStaleErrors();
  computeReheatPlan();
  refreshVirtuals();

  S.lastModelTickUptimeMs = nowU;
  markPersistDirty();
}

function pollTick() {
  if (POLL.busy || PERSIST.inFlight || !PERSIST.loaded) return;

  POLL.tick++;
  let nowU = Shelly.getUptimeMs();

  if (CFG.solar.enabled && (!EXT.nextSolarUptimeMs || nowU >= EXT.nextSolarUptimeMs)) {
    EXT.nextSolarUptimeMs = nowU + EXT.solarEveryMs;
    fetchSolar();
    return;
  }

  if (CFG.agile.enabled && (!EXT.nextAgileUptimeMs || nowU >= EXT.nextAgileUptimeMs)) {
    EXT.nextAgileUptimeMs = nowU + EXT.agileEveryMs;
    fetchAgile();
    return;
  }

  if (POLL.tick % 15 === 0) {
    let tname = POLL.tempList[POLL.tempIndex];
    POLL.tempIndex = (POLL.tempIndex + 1) % POLL.tempList.length;
    fetchMetric(tname);
    return;
  }

  let fname = POLL.fastList[POLL.fastIndex];
  POLL.fastIndex = (POLL.fastIndex + 1) % POLL.fastList.length;
  fetchMetric(fname);
}

function persistTick() {
  flushPersistedModel(false);
}

// =====================================================
// BOOT
// =====================================================
function init() {
  refreshVirtuals();
  Timer.set(1000, true, pollTick);
  Timer.set(1000, true, modelTick);
  Timer.set(15000, true, persistTick);
  loadPersistedModel();
}

init();
