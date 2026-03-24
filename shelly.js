// =====================================================
// SHELLY VIRTUAL DHW TANK - CLEAN UI + SELF-LEARNING + PERSISTENT
// =====================================================
// Visible dashboard:
// - DHW kWh
// - Tank %
// - Litres @42C
// - Minutes @42C
// - Confidence %
// - Minutes Since Full
// - HP Learned kW
// - Cal Err kWh
// - State
// - Mode
//
// Internal model still uses:
// - feed temperature
// - top pipe temperature
// - HP power
// - immersion power
// - shower power
// =====================================================

// --------------------
// CONFIG
// --------------------
let CFG = {
  tankLitres: 114,
  statTempC: 55,            // set to 50 or 55
  maxTankTempC: 65,

  showerOutTempC: 42,
  showerLpm: 7.2,

  // Cold inlet:
  // "fixed" or "monthmap"
  coldMode: "fixed",
  coldFixedC: 5,
  coldByMonthC: [5, 5, 6, 8, 11, 14, 16, 16, 13, 10, 7, 5], // Jan..Dec

  // Shower detection hysteresis
  showerOnW: 100,
  showerOffW: 20,

  // Heat pump on/off from measured power draw
  hpOnW: 400,
  hpOffW: 10,

  // Charging assumptions / thresholds
  immersionKW: 3.0,
  hpChargeKW: 2.2,          // initial learned value
  minUsefulFeedC: 30,

  // Immersion thermostat inference:
  // if immersion relay is enabled but measured power stays below this threshold
  // for this long, infer top of tank = 65 C
  immersionLowPowerW: 50,
  immersionLowPowerHoldMs: 30000,

  // Two-layer model
  upperFraction: 0.55,
  hpToLowerFrac: 0.75,
  immersionToUpperFrac: 1.0,

  // Shower session grouping
  showerSessionGapMs: 300000,          // 5 min between bursts = same shower
  reliableTopAfterRunMs: 240000,       // 4 min running water => top pipe trusted

  // Learned behavior windows
  historyDays: 14,
  morningStartHour: 6.5,    // 06:30
  morningEndHour: 9.5,      // 09:30
  eveningStartHour: 17.5,   // 17:30
  eveningEndHour: 22.0,     // 22:00

  // Standing loss after one extra 12 mm wrap over top ~90%
  standingLoss: [
    { c: 45, kwhDay: 1.24 },
    { c: 50, kwhDay: 1.49 },
    { c: 55, kwhDay: 1.74 },
    { c: 65, kwhDay: 2.23 }
  ],

  // Learning rates and clamps
  learning: {
    hpAlpha: 0.08,
    standbyAlpha: 0.05,
    showerAlpha: 0.04,

    // gentle learning from reliable top-temp-after-shower correction
    topShowerAlpha: 0.05,

    hpMinKW: 1.0,
    hpMaxKW: 3.5,

    standbyMinMul: 0.5,
    standbyMaxMul: 2.0,

    showerMinMul: 0.85,
    showerMaxMul: 1.20
  },

  remote: {
    hpPowerW: {
      url: "http://192.168.1.69/rpc/Switch.GetStatus?id=0",
      path: "apower"
    },
    dhwMode: {
      url: "http://192.168.1.127/rpc/Switch.GetStatus?id=0",
      path: "output",
      invert: true   // ON = CH, OFF = DHW
    },
    tankDemand: {
      url: "http://192.168.1.127/rpc/Input.GetStatus?id=0",
      path: "state",
      invert: false
    },
    immersionOn: {
      url: "http://192.168.1.131/rpc/Switch.GetStatus?id=0",
      path: "output",
      invert: false
    },
    immersionPowerW: {
      url: "http://192.168.1.131/rpc/Switch.GetStatus?id=0",
      path: "apower"
    },
    showerPowerW: {
      url: "http://192.168.1.76/rpc/Switch.GetStatus?id=0",
      path: "apower"   // verify if needed
    },
    feedC: {
      url: "http://192.168.1.127/rpc/Temperature.GetStatus?id=100",
      path: "tC"
    },
    topC: {
      url: "http://192.168.1.127/rpc/Temperature.GetStatus?id=102",
      path: "tC"
    }
  }
};

// --------------------
// VIRTUAL COMPONENTS
// --------------------
let V = {
  kwh:       Virtual.getHandle("number:200"),
  pct:       Virtual.getHandle("number:201"),
  litres:    Virtual.getHandle("number:202"),
  mins:      Virtual.getHandle("number:203"),
  conf:      Virtual.getHandle("number:204"),
  sinceFull: Virtual.getHandle("number:205"),
  hpLearn:   Virtual.getHandle("number:206"),
  calErr:    Virtual.getHandle("number:207"),
  state:     Virtual.getHandle("text:200"),
  source:    Virtual.getHandle("text:201")
};

// --------------------
// PERSISTENCE
// --------------------
let PERSIST = {
  key: "dhw_model_v1",
  dirty: false,
  inFlight: false,
  loaded: false,
  lastSaveJson: null,
  minFlushGapMs: 60000,
  lastFlushUptimeMs: 0
};

// --------------------
// POLL STATE
// --------------------
let POLL = {
  busy: false,
  fastList: ["hpPowerW", "dhwMode", "tankDemand", "immersionOn", "immersionPowerW", "showerPowerW"],
  tempList: ["feedC", "topC"],
  fastIndex: 0,
  tempIndex: 0,
  tick: 0
};

// --------------------
// STATE
// --------------------
let S = {
  // two-layer energy model
  upperKwh: 0,
  lowerKwh: 0,
  energyKwh: 0,
  lastTickMs: 0,

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
  lastReliableTopUptimeMs: 0,
  lastReliableTopC: null,

  hpChargingNow: false,

  prevTankDemand: true,
  prevChargeActive: false,

  // full/satisfied tracking
  lastFullChargeC: CFG.statTempC,
  lastSource: "BOOT",
  lastSatisfiedUptimeMs: 0,
  lastSatisfiedEpochMs: 0,

  // calibration / learning
  calibrationCount: 0,
  lastCalErrorKwh: 0,      // signed: positive = model too high before snap
  meanAbsCalErrorKwh: 0,

  learnHpKW: CFG.hpChargeKW,
  learnStandbyMul: 1.0,
  learnShowerMul: 1.0,

  // interval since last full calibration
  cycle: {
    startUptimeMs: 0,
    startEnergyKwh: 0,
    hpPredKwh: 0,
    immPredKwh: 0,
    showerPredKwh: 0,
    standbyPredKwh: 0,
    hasHp: false,
    hasImm: false,
    hasShower: false
  },

  // charge tracking
  chargeSatisfiedThisRun: false,
  partialChargeCountSinceFull: 0,

  // shower sessions
  session: {
    active: false,
    startUptimeMs: 0,
    startEpochMs: 0,
    runtimeMs: 0,
    lastFlowUptimeMs: 0,
    reliableTopC: null,
    reliableTopCaptured: false
  },
  showerSessionsSinceFull: 0,

  // learning history
  history: [],
  forecast: {
    morningProb: 0,
    morningUncondKwh: 0,
    morningCondKwh: 0,
    eveningProb: 0,
    eveningUncondKwh: 0,
    eveningCondKwh: 0,
    days: 0
  },

  // metric freshness
  seen: {
    hpPowerW: 0,
    dhwMode: 0,
    tankDemand: 0,
    immersionOn: 0,
    immersionPowerW: 0,
    showerPowerW: 0,
    feedC: 0,
    topC: 0
  }
};

// --------------------
// HELPERS
// --------------------
function isNum(x) {
  return typeof x === "number" && !isNaN(x);
}

function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function nowEpochMs() {
  return (new Date()).getTime();
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

function maxEnergyKwh() {
  return energyFromTemp(CFG.maxTankTempC);
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

function boolValue(v, invert) {
  let b = !!v;
  return invert ? !b : b;
}

function markSeen(name) {
  S.seen[name] = Shelly.getUptimeMs();
}

function minutesSinceUptime(uptimeMs) {
  if (!uptimeMs) return null;
  return Math.floor((Shelly.getUptimeMs() - uptimeMs) / 60000);
}

// --------------------
// PERSISTENCE HELPERS
// --------------------
function persistSnapshot() {
  return {
    learnHpKW: S.learnHpKW,
    learnStandbyMul: S.learnStandbyMul,
    learnShowerMul: S.learnShowerMul,
    calibrationCount: S.calibrationCount,
    meanAbsCalErrorKwh: S.meanAbsCalErrorKwh
  };
}

function markPersistDirty() {
  PERSIST.dirty = true;
}

function applyPersistedSnapshot(obj) {
  if (!obj || typeof obj !== "object") return;

  if (isNum(obj.learnHpKW)) {
    S.learnHpKW = clamp(obj.learnHpKW, CFG.learning.hpMinKW, CFG.learning.hpMaxKW);
  }
  if (isNum(obj.learnStandbyMul)) {
    S.learnStandbyMul = clamp(obj.learnStandbyMul, CFG.learning.standbyMinMul, CFG.learning.standbyMaxMul);
  }
  if (isNum(obj.learnShowerMul)) {
    S.learnShowerMul = clamp(obj.learnShowerMul, CFG.learning.showerMinMul, CFG.learning.showerMaxMul);
  }
  if (isNum(obj.calibrationCount)) {
    S.calibrationCount = Math.max(0, Math.floor(obj.calibrationCount));
  }
  if (isNum(obj.meanAbsCalErrorKwh)) {
    S.meanAbsCalErrorKwh = Math.max(0, obj.meanAbsCalErrorKwh);
  }
}

function loadPersistedModel() {
  if (PERSIST.inFlight || PERSIST.loaded) return;
  PERSIST.inFlight = true;

  Shelly.call("KVS.Get", { key: PERSIST.key }, function(result, error_code, error_message) {
    PERSIST.inFlight = false;
    PERSIST.loaded = true;

    if (error_code === -105) {
      PERSIST.dirty = true;
      print("KVS empty, starting with defaults");
      return;
    }

    if (error_code !== 0) {
      print("KVS.Get failed:", error_code, error_message);
      return;
    }

    let raw = null;
    if (result && typeof result.value !== "undefined") {
      raw = result.value;
    } else if (typeof result === "string") {
      raw = result;
    }

    if (!raw) {
      PERSIST.dirty = true;
      return;
    }

    try {
      let obj = JSON.parse(raw);
      applyPersistedSnapshot(obj);
      PERSIST.lastSaveJson = raw;
      print("KVS model loaded");
      refreshVirtuals();
    } catch (e) {
      print("KVS model parse error, resetting to defaults");
      PERSIST.dirty = true;
    }
  });
}

function flushPersistedModel(force) {
  let nowU = Shelly.getUptimeMs();

  if (!PERSIST.loaded && !force) return;
  if (!PERSIST.dirty && !force) return;
  if (PERSIST.inFlight) return;
  if (POLL.busy) return;
  if (!force && (nowU - PERSIST.lastFlushUptimeMs) < PERSIST.minFlushGapMs) return;

  let json = JSON.stringify(persistSnapshot());
  if (!force && json === PERSIST.lastSaveJson) {
    PERSIST.dirty = false;
    return;
  }

  PERSIST.inFlight = true;
  Shelly.call("KVS.Set", { key: PERSIST.key, value: json }, function(result, error_code, error_message) {
    PERSIST.inFlight = false;

    if (error_code !== 0) {
      print("KVS.Set failed:", error_code, error_message);
      return;
    }

    PERSIST.lastSaveJson = json;
    PERSIST.lastFlushUptimeMs = Shelly.getUptimeMs();
    PERSIST.dirty = false;
    print("KVS model saved");
  });
}

// --------------------
// TWO-LAYER MODEL
// --------------------
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

function removeShowerEnergy(kwh) {
  if (kwh <= 0) return;

  let fromUpper = Math.min(S.upperKwh, kwh);
  S.upperKwh -= fromUpper;
  kwh -= fromUpper;

  if (kwh > 0) {
    let fromLower = Math.min(S.lowerKwh, kwh);
    S.lowerKwh -= fromLower;
    kwh -= fromLower;
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

// --------------------
// LEARNING SUPPORT
// --------------------
function resetCycleLearning() {
  S.cycle.startUptimeMs = Shelly.getUptimeMs();
  S.cycle.startEnergyKwh = S.energyKwh;
  S.cycle.hpPredKwh = 0;
  S.cycle.immPredKwh = 0;
  S.cycle.showerPredKwh = 0;
  S.cycle.standbyPredKwh = 0;
  S.cycle.hasHp = false;
  S.cycle.hasImm = false;
  S.cycle.hasShower = false;
}

function learnFromCalibration(signedErr) {
  if (S.cycle.hpPredKwh > 0.5) {
    let ratio = signedErr / S.cycle.hpPredKwh;
    let factor = 1.0 - (CFG.learning.hpAlpha * ratio);
    factor = clamp(factor, 0.90, 1.10);

    S.learnHpKW = clamp(
      S.learnHpKW * factor,
      CFG.learning.hpMinKW,
      CFG.learning.hpMaxKW
    );
    markPersistDirty();
  }

  if (S.cycle.standbyPredKwh > 0.2) {
    let ratio = signedErr / S.cycle.standbyPredKwh;
    let factor = 1.0 + (CFG.learning.standbyAlpha * ratio);
    factor = clamp(factor, 0.90, 1.10);

    S.learnStandbyMul = clamp(
      S.learnStandbyMul * factor,
      CFG.learning.standbyMinMul,
      CFG.learning.standbyMaxMul
    );
    markPersistDirty();
  }

  if (S.cycle.showerPredKwh > 0.5) {
    let ratio = signedErr / S.cycle.showerPredKwh;
    let factor = 1.0 + (CFG.learning.showerAlpha * ratio);
    factor = clamp(factor, 0.92, 1.08);

    S.learnShowerMul = clamp(
      S.learnShowerMul * factor,
      CFG.learning.showerMinMul,
      CFG.learning.showerMaxMul
    );
    markPersistDirty();
  }
}

// --------------------
// EVENT-BASED TOP CORRECTIONS
// --------------------
function correctUpperFromReliableTop(measuredTopC, sessionKwh) {
  if (!isNum(measuredTopC)) return;

  let topC = clamp(measuredTopC, getColdC(), CFG.maxTankTempC);
  let targetUpper = upperCapAtTemp(topC);
  let predUpper = S.upperKwh;
  let errUpper = predUpper - targetUpper; // positive = model upper too high

  if (isNum(sessionKwh) && sessionKwh > 0.3) {
    let ratio = errUpper / sessionKwh;
    let factor = 1.0 + (CFG.learning.topShowerAlpha * ratio);
    factor = clamp(factor, 0.97, 1.03);

    S.learnShowerMul = clamp(
      S.learnShowerMul * factor,
      CFG.learning.showerMinMul,
      CFG.learning.showerMaxMul
    );
    markPersistDirty();
  }

  if (predUpper > targetUpper) {
    S.upperKwh = targetUpper;
  } else {
    S.upperKwh = predUpper + 0.5 * (targetUpper - predUpper);
  }

  clampLayers();

  S.lastReliableTopUptimeMs = Shelly.getUptimeMs();
  S.lastReliableTopC = topC;
}

function correctUpperFromImmersionThermostat65() {
  let targetUpper = upperCapAtTemp(65);

  if (S.upperKwh < targetUpper) {
    S.upperKwh = targetUpper;
    clampLayers();
  }

  S.lastReliableTopUptimeMs = Shelly.getUptimeMs();
  S.lastReliableTopC = 65;
}

// --------------------
// CHARGE / DISCHARGE MODEL
// --------------------
function computeHpChargingNow() {
  if (!(S.hpOn && S.dhwMode && S.tankDemand)) return false;
  if (isNum(S.feedC) && S.feedC >= CFG.minUsefulFeedC) return true;
  if (!isNum(S.feedC)) return true;
  return false;
}

function computeImmersionHeatingNow() {
  if (!S.immersionOn) return false;
  if (isNum(S.immersionPowerW)) {
    return S.immersionPowerW >= CFG.immersionLowPowerW;
  }
  return true;
}

function currentChargeActive() {
  return S.immersionHeatingNow || S.hpChargingNow;
}

function integrate() {
  let nowMs = Shelly.getUptimeMs();

  if (S.lastTickMs === 0) {
    S.lastTickMs = nowMs;
    return;
  }

  let dtMs = nowMs - S.lastTickMs;
  let dtHours = dtMs / 3600000.0;
  if (dtHours <= 0) return;

  S.hpChargingNow = computeHpChargingNow();
  S.immersionHeatingNow = computeImmersionHeatingNow();

  if (S.hpChargingNow) {
    let hpKwh = S.learnHpKW * dtHours;
    addHpEnergy(hpKwh);
    S.cycle.hpPredKwh += hpKwh;
    S.cycle.hasHp = true;
  }

  if (S.immersionHeatingNow) {
    let immKW = isNum(S.immersionPowerW) ? (S.immersionPowerW / 1000.0) : CFG.immersionKW;
    let immKwh = immKW * dtHours;
    addImmersionEnergy(immKwh);
    S.cycle.immPredKwh += immKwh;
    S.cycle.hasImm = true;
  }

  if (S.showerRunning) {
    let used = showerKwhPerMinuteLearned() * (dtHours * 60.0);
    removeShowerEnergy(used);
    S.cycle.showerPredKwh += used;
    S.cycle.hasShower = true;

    if (S.session.active) {
      S.session.runtimeMs += dtMs;
      S.session.lastFlowUptimeMs = nowMs;
    }
  }

  let avgTempC = avgTempFromEnergy(S.energyKwh);
  let standby = (standingLossPerDayBase(avgTempC) * S.learnStandbyMul / 24.0) * dtHours;
  applyStandingLoss(standby);
  S.cycle.standbyPredKwh += standby;

  S.lastTickMs = nowMs;
}

function snapTankToFull() {
  let fullKwh = energyFromTemp(CFG.statTempC);
  let modelBefore = S.energyKwh;
  let signedErr = modelBefore - fullKwh; // positive = model too high

  S.lastCalErrorKwh = signedErr;
  S.calibrationCount += 1;
  let absErr = Math.abs(signedErr);

  if (S.calibrationCount === 1) {
    S.meanAbsCalErrorKwh = absErr;
  } else {
    S.meanAbsCalErrorKwh =
      ((S.meanAbsCalErrorKwh * (S.calibrationCount - 1)) + absErr) / S.calibrationCount;
  }
  markPersistDirty();

  learnFromCalibration(signedErr);

  setFullAtStatTemp();
  S.lastFullChargeC = CFG.statTempC;
  S.lastSource = S.immersionOn ? "IMMERSION FULL" : "HP FULL";
  S.lastSatisfiedUptimeMs = Shelly.getUptimeMs();
  S.lastSatisfiedEpochMs = nowEpochMs();
  S.chargeSatisfiedThisRun = true;
  S.partialChargeCountSinceFull = 0;
  S.showerSessionsSinceFull = 0;

  resetCycleLearning();
}

// --------------------
// SHOWER SESSION GROUPING / LEARNING
// --------------------
function currentDayKey(epochMs) {
  let d = epochMs ? new Date(epochMs) : new Date();
  let y = d.getFullYear();
  let m = ("0" + (d.getMonth() + 1)).slice(-2);
  let day = ("0" + d.getDate()).slice(-2);
  return y + "-" + m + "-" + day;
}

function classifyWindow(epochMs) {
  let d = new Date(epochMs);
  let h = d.getHours() + d.getMinutes() / 60.0;

  if (h >= CFG.morningStartHour && h < CFG.morningEndHour) return "morning";
  if (h >= CFG.eveningStartHour && h < CFG.eveningEndHour) return "evening";
  return "other";
}

function getOrCreateDayRecord(dayKey) {
  for (let i = 0; i < S.history.length; i++) {
    if (S.history[i].dayKey === dayKey) return S.history[i];
  }

  let rec = {
    dayKey: dayKey,
    morningKwh: 0,
    eveningKwh: 0,
    otherKwh: 0,
    morningSessions: 0,
    eveningSessions: 0,
    otherSessions: 0
  };

  S.history.push(rec);

  while (S.history.length > CFG.historyDays) {
    S.history.shift();
  }

  return rec;
}

function updateForecast() {
  let days = S.history.length;
  let morningOcc = 0, eveningOcc = 0;
  let morningSum = 0, eveningSum = 0;

  for (let i = 0; i < S.history.length; i++) {
    let d = S.history[i];
    if (d.morningKwh > 0) morningOcc++;
    if (d.eveningKwh > 0) eveningOcc++;
    morningSum += d.morningKwh;
    eveningSum += d.eveningKwh;
  }

  S.forecast.days = days;

  if (days > 0) {
    S.forecast.morningProb = morningOcc / days;
    S.forecast.eveningProb = eveningOcc / days;

    S.forecast.morningUncondKwh = morningSum / days;
    S.forecast.eveningUncondKwh = eveningSum / days;

    S.forecast.morningCondKwh = morningOcc > 0 ? (morningSum / morningOcc) : 0;
    S.forecast.eveningCondKwh = eveningOcc > 0 ? (eveningSum / eveningOcc) : 0;
  } else {
    S.forecast.morningProb = 0;
    S.forecast.eveningProb = 0;
    S.forecast.morningUncondKwh = 0;
    S.forecast.eveningUncondKwh = 0;
    S.forecast.morningCondKwh = 0;
    S.forecast.eveningCondKwh = 0;
  }
}

function startShowerSession() {
  if (S.session.active) return;

  let nowU = Shelly.getUptimeMs();
  S.session.active = true;
  S.session.startUptimeMs = nowU;
  S.session.startEpochMs = nowEpochMs();
  S.session.runtimeMs = 0;
  S.session.lastFlowUptimeMs = nowU;
  S.session.reliableTopC = null;
  S.session.reliableTopCaptured = false;
}

function finalizeShowerSession() {
  if (!S.session.active) return;

  let runtimeMin = S.session.runtimeMs / 60000.0;
  let kwh = runtimeMin * showerKwhPerMinuteLearned();
  let bucket = classifyWindow(S.session.startEpochMs);
  let rec = getOrCreateDayRecord(currentDayKey(S.session.startEpochMs));

  if (bucket === "morning") {
    rec.morningKwh += kwh;
    rec.morningSessions += 1;
  } else if (bucket === "evening") {
    rec.eveningKwh += kwh;
    rec.eveningSessions += 1;
  } else {
    rec.otherKwh += kwh;
    rec.otherSessions += 1;
  }

  if (S.session.runtimeMs >= CFG.reliableTopAfterRunMs && isNum(S.session.reliableTopC)) {
    correctUpperFromReliableTop(S.session.reliableTopC, kwh);
  }

  S.showerSessionsSinceFull += 1;
  updateForecast();

  print("Shower session closed:",
        "runtimeMin=", round1(runtimeMin),
        "kWh=", round2(kwh),
        "window=", bucket,
        "reliableTop=", isNum(S.session.reliableTopC) ? round1(S.session.reliableTopC) : "n/a");

  S.session.active = false;
  S.session.startUptimeMs = 0;
  S.session.startEpochMs = 0;
  S.session.runtimeMs = 0;
  S.session.lastFlowUptimeMs = 0;
  S.session.reliableTopC = null;
  S.session.reliableTopCaptured = false;
}

// --------------------
// CONFIDENCE
// --------------------
function computeConfidence() {
  let c = 100;
  let minsFromFull = minutesSinceUptime(S.lastSatisfiedUptimeMs);

  if (minsFromFull === null) {
    c = 55;
  } else {
    c -= Math.min(35, minsFromFull / 20);
  }

  c -= Math.min(24, S.showerSessionsSinceFull * 8);
  c -= Math.min(20, S.partialChargeCountSinceFull * 5);

  let nowU = Shelly.getUptimeMs();
  if (S.seen.feedC && (nowU - S.seen.feedC) > 900000) c -= 8;
  if (S.seen.topC && (nowU - S.seen.topC) > 900000) c -= 4;
  if (!S.seen.feedC) c -= 8;
  if (!S.seen.topC) c -= 4;

  if (S.lastReliableTopUptimeMs && (nowU - S.lastReliableTopUptimeMs) < 1800000) {
    c += 5;
  }

  c -= Math.min(15, S.meanAbsCalErrorKwh * 5);

  return clamp(Math.round(c), 10, 100);
}

// --------------------
// STATE / DISPLAY
// --------------------
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

function tankMode() {
  if (S.showerRunning) return "SHOWER";
  if (S.immersionHeatingNow) return "IMMERSION";
  if (S.hpChargingNow) return "HP+DHW";
  return "IDLE";
}

function refreshVirtuals() {
  let fullKwh = energyFromTemp(CFG.statTempC);
  let pct = fullKwh > 0 ? (100.0 * S.energyKwh / fullKwh) : 0;
  let conf = computeConfidence();
  let sinceFull = minutesSinceUptime(S.lastSatisfiedUptimeMs);

  if (V.kwh) V.kwh.setValue(round2(S.energyKwh));
  if (V.pct) V.pct.setValue(round1(clamp(pct, 0, 150)));
  if (V.litres) V.litres.setValue(Math.round(litres42Remaining()));
  if (V.mins) V.mins.setValue(round1(minutes42Remaining()));
  if (V.conf) V.conf.setValue(conf);
  if (V.sinceFull) V.sinceFull.setValue(sinceFull !== null ? sinceFull : -1);
  if (V.hpLearn) V.hpLearn.setValue(round2(S.learnHpKW));
  if (V.calErr) V.calErr.setValue(round2(S.meanAbsCalErrorKwh));

  if (V.state) V.state.setValue(tankState());
  if (V.source) V.source.setValue(tankMode());
}

// --------------------
// TRANSITIONS
// --------------------
function applyTransitions() {
  let nowU = Shelly.getUptimeMs();

  // HP hysteresis from measured power draw
  if (!S.hpOn && isNum(S.hpPowerW) && S.hpPowerW >= CFG.hpOnW) {
    S.hpOn = true;
  } else if (S.hpOn && isNum(S.hpPowerW) && S.hpPowerW <= CFG.hpOffW) {
    S.hpOn = false;
  }

  // Immersion heating state from actual power
  S.immersionHeatingNow = computeImmersionHeatingNow();

  // Detect "immersion enabled but thermostat cut power" => top is 65 C
  if (S.immersionOn) {
    if (isNum(S.immersionPowerW) && S.immersionPowerW < CFG.immersionLowPowerW) {
      if (!S.immersionLowPowerStartMs) {
        S.immersionLowPowerStartMs = nowU;
      } else if (!S.immersionTopConfirmedThisRun &&
                 (nowU - S.immersionLowPowerStartMs) >= CFG.immersionLowPowerHoldMs) {
        correctUpperFromImmersionThermostat65();
        S.immersionTopConfirmedThisRun = true;
      }
    } else {
      S.immersionLowPowerStartMs = 0;
    }
  } else {
    S.immersionLowPowerStartMs = 0;
    S.immersionTopConfirmedThisRun = false;
  }

  // Shower hysteresis
  if (!S.showerRunning && isNum(S.showerPowerW) && S.showerPowerW >= CFG.showerOnW) {
    S.showerRunning = true;
    startShowerSession();
  } else if (S.showerRunning && isNum(S.showerPowerW) && S.showerPowerW <= CFG.showerOffW) {
    S.showerRunning = false;
  }

  // Close grouped shower session after gap timeout
  if (S.session.active && !S.showerRunning) {
    if ((nowU - S.session.lastFlowUptimeMs) >= CFG.showerSessionGapMs) {
      finalizeShowerSession();
    }
  }

  // Charge tracking
  let chargeActive = currentChargeActive();
  if (!S.prevChargeActive && chargeActive) {
    S.chargeSatisfiedThisRun = false;
  }

  // Full calibration when demand drops during an active charge
  let chargingContext = S.immersionOn || (S.hpOn && S.dhwMode);
  if (S.prevTankDemand && !S.tankDemand && chargingContext) {
    snapTankToFull();
  }

  // Count a partial charge if a charge ended without satisfaction
  if (S.prevChargeActive && !chargeActive && !S.chargeSatisfiedThisRun) {
    S.partialChargeCountSinceFull += 1;
  }

  S.prevTankDemand = S.tankDemand;
  S.prevChargeActive = chargeActive;
}

// --------------------
// HTTP POLLING
// --------------------
function onMetric(result, error_code, error_message, userdata) {
  POLL.busy = false;

  if (error_code !== 0 || !result || result.code !== 200 || !result.body) {
    print("HTTP failed:", userdata.name, "err:", error_code, "msg:", error_message);
    return;
  }

  let obj;
  try {
    obj = JSON.parse(result.body);
  } catch (e) {
    print("Bad JSON:", userdata.name);
    return;
  }

  let value = getByPath(obj, userdata.path);

  integrate();

  if (userdata.name === "hpPowerW") {
    S.hpPowerW = isNum(value) ? value : 0;
    markSeen("hpPowerW");
  } else if (userdata.name === "dhwMode") {
    S.dhwMode = boolValue(value, userdata.invert);
    markSeen("dhwMode");
  } else if (userdata.name === "tankDemand") {
    S.tankDemand = boolValue(value, userdata.invert);
    markSeen("tankDemand");
  } else if (userdata.name === "immersionOn") {
    S.immersionOn = boolValue(value, userdata.invert);
    markSeen("immersionOn");
  } else if (userdata.name === "immersionPowerW") {
    S.immersionPowerW = isNum(value) ? value : 0;
    markSeen("immersionPowerW");
  } else if (userdata.name === "showerPowerW") {
    S.showerPowerW = isNum(value) ? value : 0;
    markSeen("showerPowerW");
  } else if (userdata.name === "feedC") {
    if (isNum(value)) {
      S.feedC = value;
      markSeen("feedC");
    }
  } else if (userdata.name === "topC") {
    if (isNum(value)) {
      S.topC = value;
      markSeen("topC");

      // During a shower session, once total running-water time has reached 4 min,
      // treat the top reading as reliable top-of-cylinder temp
      if (S.session.active &&
          S.showerRunning &&
          S.session.runtimeMs >= CFG.reliableTopAfterRunMs) {
        S.session.reliableTopC = value;
        S.session.reliableTopCaptured = true;
      }
    }
  }

  applyTransitions();
  refreshVirtuals();
}

function fetchMetric(name) {
  let m = CFG.remote[name];
  if (!m || !m.url || !m.path) return;
  if (POLL.busy) return;

  POLL.busy = true;

  let timeout = (name === "feedC" || name === "topC") ? 10 : 5;

  Shelly.call(
    "HTTP.GET",
    { url: m.url, timeout: timeout },
    onMetric,
    { name: name, path: m.path, invert: !!m.invert }
  );
}

function pollOne() {
  integrate();
  refreshVirtuals();

  if (POLL.busy || PERSIST.inFlight) return;

  POLL.tick++;

  // Poll temperatures every 15 seconds, alternating feed/top
  if (POLL.tick % 15 === 0) {
    let tname = POLL.tempList[POLL.tempIndex];
    POLL.tempIndex = (POLL.tempIndex + 1) % POLL.tempList.length;
    fetchMetric(tname);
    return;
  }

  // Poll fast metrics all other seconds
  let fname = POLL.fastList[POLL.fastIndex];
  POLL.fastIndex = (POLL.fastIndex + 1) % POLL.fastList.length;
  fetchMetric(fname);
}

function persistTick() {
  flushPersistedModel(false);
}

// --------------------
// BOOT
// --------------------
function init() {
  setFullAtStatTemp();
  S.lastFullChargeC = CFG.statTempC;
  S.lastTickMs = Shelly.getUptimeMs();

  resetCycleLearning();
  updateForecast();
  refreshVirtuals();

  // Seed KVS on first boot if empty
  Timer.set(3000, false, function () {
    flushPersistedModel(true);
  });
}

init();
loadPersistedModel();
Timer.set(1000, true, pollOne);
Timer.set(15000, true, persistTick);
