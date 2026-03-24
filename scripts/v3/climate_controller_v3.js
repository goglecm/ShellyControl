let C = {
  plant_ip: "192.168.1.127",
  plant_ep: "/script/1/plant",

  tick_ms: 30000,
  discover_ms: 30 * 60 * 1000,
  plant_poll_ms: 60000,

  night_start_h: 22,
  night_start_m: 30,
  night_ramp_start_h: 21,
  night_ramp_start_m: 0,
  morning_ramp_start_h: 5,
  morning_ramp_start_m: 0,
  day_start_h: 6,
  day_start_m: 30,

  ch_outside_max_c: 16.0,
  ufh_outside_max_c: 8.0,
  room_need_delta_c: 0.3,
  ch_on_pos: 20,
  ch_off_pos: 5,

  ufh_delta_c: 0.7,
  ufh_off_hyst_c: 0.2,
  ufh_delay_s: 90 * 60,
  ufh_delay_panic_s: 20 * 60,

  ultra_cheap_price_p: 1.1,
  extra_cold_c: 2.0,

  outside_temp_mac: "38:39:8f:7c:d7:40",
  kitchen_humidity_mac: "7c:c6:b6:74:48:af",

  trvs: {
    kitchen: { mac: "28:68:47:fc:f0:7b", ufh_ip: "", day: 20.0, night: 19.0, away_short: 18.0, away_long: 16.0 },
    living:  { mac: "28:68:47:fc:e3:60", ufh_ip: "192.168.1.53", day: 22.5, night: 21.5, away_short: 20.5, away_long: 16.0 },
    bedroom: { mac: "28:68:47:fd:61:d9", ufh_ip: "192.168.1.129", day: 21.0, night: 20.0, away_short: 19.0, away_long: 16.0 },
    small:   { mac: "28:68:47:fc:64:99", ufh_ip: "192.168.1.77", day: 19.5, night: 18.5, away_short: 17.5, away_long: 16.0 }
  },

  virt_ids: {
    living_day: 200,
    bedroom_day: 201,
    small_day: 202,
    kitchen_day: 203,
    shower_soon: 204
  }
};

let S = {
  manual_mode: "AUTO",
  last_resolved_mode: "HOME_DAY",
  last_reason: "boot",
  plant_ok: false,
  plant_fault: false,
  discovered: false,
  outside_temp_id: null,
  kitchen_humidity_id: null,
  price_p: null,
  rooms: {
    kitchen: { trv_id: null, temp_sensor_id: null, ufh_cold_since: 0 },
    living:  { trv_id: null, temp_sensor_id: null, ufh_cold_since: 0 },
    bedroom: { trv_id: null, temp_sensor_id: null, ufh_cold_since: 0 },
    small:   { trv_id: null, temp_sensor_id: null, ufh_cold_since: 0 }
  },
  virt_ready: false,
  events: []
};

function nowTs() {
  let st = Shelly.getComponentStatus("sys");
  return st && typeof st.unixtime === "number" ? st.unixtime : 0;
}
function hhmm() {
  let st = Shelly.getComponentStatus("sys");
  return st && st.time ? st.time : "00:00";
}
function minsNow() {
  let p = hhmm().split(":");
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}
function addEvent(tag, msg) {
  let row = nowTs() + "|" + tag + "|" + msg;
  S.events.push(row);
  while (S.events.length > 40) S.events.shift();
  S.last_reason = tag + (msg ? (" " + msg) : "");
  print("CLIMATE", row);
}
function qVal(q, k) {
  if (!q) return null;
  let a = q.split("&");
  let i, kv;
  for (i = 0; i < a.length; i++) {
    kv = a[i].split("=");
    if (kv.length >= 2 && kv[0] === k) return kv[1];
  }
  return null;
}
function saveMode() { Script.storage.setItem("mode", S.manual_mode); }
function loadMode() { let m = Script.storage.getItem("mode"); if (typeof m === "string") S.manual_mode = m; }
function httpGet(url, cb, ud) { Shelly.call("HTTP.GET", { url: url, timeout: 10 }, cb, ud); }
function remoteSwitch(ip, on) { httpGet("http://" + ip + "/rpc/Switch.Set?id=0&on=" + (on ? "true" : "false"), null, null); }
function lerp(a, b, x) { return a + (b - a) * x; }
function targetAt(baseDay, baseNight) {
  let m = minsNow();
  let n0 = C.night_ramp_start_h * 60 + C.night_ramp_start_m;
  let n1 = C.night_start_h * 60 + C.night_start_m;
  let d0 = C.morning_ramp_start_h * 60 + C.morning_ramp_start_m;
  let d1 = C.day_start_h * 60 + C.day_start_m;
  if (m >= n1 || m < d0) return baseNight;
  if (m >= n0 && m < n1) return lerp(baseDay, baseNight, (m - n0) / (n1 - n0));
  if (m >= d0 && m < d1) return lerp(baseNight, baseDay, (m - d0) / (d1 - d0));
  return baseDay;
}
function resolvedMode() {
  if (S.manual_mode === "AWAY_LT48H") return "AWAY_LT48H";
  if (S.manual_mode === "AWAY_GT48H") return "AWAY_GT48H";
  let m = minsNow();
  let n1 = C.night_start_h * 60 + C.night_start_m;
  let d1 = C.day_start_h * 60 + C.day_start_m;
  return (m >= n1 || m < d1) ? "HOME_NIGHT" : "HOME_DAY";
}
function virtGet(key) { try { return Virtual.getHandle(key); } catch (e) { return null; } }
function ensureVirtualNumber(id, name, def, min, max, step) {
  let h = virtGet("number:" + id);
  if (!h) {
    Shelly.call("Virtual.Add", { id: id, type: "number", config: { name: name, persisted: true, default_value: def, min: min, max: max, meta: { ui: { view: "field", unit: "°C", step: step } } } }, function (res, ec, em, ud) { if (ec === 0) addEvent("virt_add", name + " id=" + id); }, null);
    return null;
  }
  return h;
}
function ensureVirtualBoolean(id, name, def, titles) {
  let h = virtGet("boolean:" + id);
  if (!h) {
    Shelly.call("Virtual.Add", { id: id, type: "boolean", config: { name: name, persisted: true, default_value: def, meta: { ui: { titles: titles || ["Off", "On"] } } } }, function (res, ec, em, ud) { if (ec === 0) addEvent("virt_add", name + " id=" + id); }, null);
    return null;
  }
  return h;
}
function ensureVirtuals() {
  let h1 = ensureVirtualNumber(C.virt_ids.living_day, "Living daytime target", C.trvs.living.day, 15, 25, 0.5);
  let h2 = ensureVirtualNumber(C.virt_ids.bedroom_day, "Bedroom daytime target", C.trvs.bedroom.day, 15, 25, 0.5);
  let h3 = ensureVirtualNumber(C.virt_ids.small_day, "Small room daytime target", C.trvs.small.day, 15, 25, 0.5);
  let h4 = ensureVirtualNumber(C.virt_ids.kitchen_day, "Kitchen daytime target", C.trvs.kitchen.day, 15, 25, 0.5);
  let h5 = ensureVirtualBoolean(C.virt_ids.shower_soon, "Likely shower within 30 min", false, ["No", "Yes"]);
  S.virt_ready = !!(h1 && h2 && h3 && h4 && h5);
}
function getVirtualNumber(id, fallback) { let h = virtGet("number:" + id); if (!h) return fallback; let st = h.getStatus(); if (!st || typeof st.value !== "number") return fallback; return st.value; }
function getVirtualBoolean(id, fallback) { let h = virtGet("boolean:" + id); if (!h) return fallback; let st = h.getStatus(); if (!st || typeof st.value !== "boolean") return fallback; return st.value; }
function baseDayTarget(name) {
  if (name === "living") return getVirtualNumber(C.virt_ids.living_day, C.trvs.living.day);
  if (name === "bedroom") return getVirtualNumber(C.virt_ids.bedroom_day, C.trvs.bedroom.day);
  if (name === "small") return getVirtualNumber(C.virt_ids.small_day, C.trvs.small.day);
  if (name === "kitchen") return getVirtualNumber(C.virt_ids.kitchen_day, C.trvs.kitchen.day);
  return 20;
}
function roomTarget(name) {
  let baseDay = baseDayTarget(name);
  let mode = resolvedMode();
  if (mode === "AWAY_LT48H") return baseDay - 2.0;
  if (mode === "AWAY_GT48H") return 16.0;
  return targetAt(baseDay, baseDay - 1.0);
}
function extractIdFromKey(key) { if (!key) return null; let p = key.split(":"); if (p.length !== 2) return null; return parseInt(p[1], 10); }
function discoverComponents() {
  Shelly.call("Shelly.GetComponents", { include: ["config", "status"] }, function (res, ec, em, ud) {
    if (ec !== 0 || !res || !res.components) { addEvent("discover_fail", "" + ec); return; }
    let i, c, cfg, roomName;
    for (i = 0; i < res.components.length; i++) {
      c = res.components[i]; cfg = c.config || {};
      if (c.key.indexOf("blutrv:") === 0 || c.key.indexOf("BluTrv:") === 0) {
        for (roomName in C.trvs) {
          if (cfg.addr && cfg.addr.toLowerCase() === C.trvs[roomName].mac.toLowerCase()) {
            S.rooms[roomName].trv_id = cfg.id;
            if (cfg.temp_sensors && cfg.temp_sensors.length) S.rooms[roomName].temp_sensor_id = extractIdFromKey(cfg.temp_sensors[0]);
          }
        }
      }
      if (c.key.indexOf("bthomesensor:") === 0) {
        if (cfg.addr && cfg.addr.toLowerCase() === C.outside_temp_mac.toLowerCase()) {
          if (cfg.obj_id === 69 || (c.status && typeof c.status.value === "number" && c.status.value > -40 && c.status.value < 60)) S.outside_temp_id = cfg.id;
        }
        if (cfg.addr && cfg.addr.toLowerCase() === C.kitchen_humidity_mac.toLowerCase()) {
          if (cfg.obj_id === 46) S.kitchen_humidity_id = cfg.id;
          else if (S.kitchen_humidity_id === null && c.status && typeof c.status.value === "number" && c.status.value >= 0 && c.status.value <= 100) S.kitchen_humidity_id = cfg.id;
        }
      }
    }
    S.discovered = true;
    addEvent("discover_ok", "out=" + S.outside_temp_id + " kh=" + S.kitchen_humidity_id + " ktrv=" + S.rooms.kitchen.trv_id + " ltrv=" + S.rooms.living.trv_id);
  }, null);
}
function getBth(id) { if (id === null || typeof id !== "number") return null; let st = Shelly.getComponentStatus("bthomesensor", id); if (!st || typeof st.value !== "number") return null; return { value: st.value, ts: st.last_update_ts || 0 }; }
function getTrv(id) { if (id === null || typeof id !== "number") return null; let st = Shelly.getComponentStatus("blutrv", id); if (!st) return null; return st; }
function setTrvTarget(id, targetC) { if (id === null || typeof id !== "number") return; Shelly.call("BluTrv.Call", { id: id, method: "TRV.SetTarget", params: { id: 0, target_C: Math.round(targetC * 10) / 10 } }, null, null); }
function plantUpdate(chNeed, outsideC, showerSoon) {
  let url = "http://" + C.plant_ip + C.plant_ep + "?ch=" + (chNeed ? "1" : "0") + "&mode=" + resolvedMode() + "&outside=" + outsideC + "&showersoon=" + (showerSoon ? "1" : "0");
  httpGet(url, null, null);
}
function pollPlant() {
  httpGet("http://" + C.plant_ip + C.plant_ep + "?status=1", function (res, ec, em, ud) {
    if (ec !== 0 || !res || res.code !== 200) { S.plant_ok = false; S.plant_fault = true; addEvent("plant_offline", "" + ec); return; }
    let body; try { body = JSON.parse(res.body); } catch (e) { return; }
    S.plant_ok = true; S.plant_fault = body && body.ashp_healthy === false; S.price_p = body && typeof body.cur_price_p === "number" ? body.cur_price_p : null;
  }, null);
}
function outsideTemp() { let b = getBth(S.outside_temp_id); if (!b) return null; return b.value; }
function kitchenHumidity() { let b = getBth(S.kitchen_humidity_id); if (!b) return null; if (b.value < 0 || b.value > 100) return null; return b.value; }
function roomTemp(name) { let id = S.rooms[name].temp_sensor_id; let b = getBth(id); if (b && b.value > -20 && b.value < 60) return b.value; let trv = getTrv(S.rooms[name].trv_id); if (trv && typeof trv.current_C === "number") return trv.current_C; return null; }
function climateLoop() {
  let outT = outsideTemp(); if (outT === null) outT = 7;
  let showerSoon = getVirtualBoolean(C.virt_ids.shower_soon, false);
  let anyDemand = false; let maxPos = 0; let now = nowTs(); let roomName, room, trv, rt, tgt, delayS, ufhOn, allowUfh;
  for (roomName in C.trvs) {
    room = C.trvs[roomName]; tgt = roomTarget(roomName); trv = getTrv(S.rooms[roomName].trv_id); rt = roomTemp(roomName);
    if (trv && typeof trv.target_C === "number" && Math.abs(trv.target_C - tgt) > 0.19) setTrvTarget(S.rooms[roomName].trv_id, tgt);
    if (trv && typeof trv.pos === "number") { if (trv.pos > maxPos) maxPos = trv.pos; if (trv.pos >= C.ch_on_pos) anyDemand = true; }
    if (rt !== null && rt <= (tgt - C.room_need_delta_c)) anyDemand = true;
    if (room.ufh_ip) {
      delayS = S.plant_fault ? C.ufh_delay_panic_s : C.ufh_delay_s; allowUfh = outT < C.ufh_outside_max_c; if (S.price_p !== null && S.price_p <= C.ultra_cheap_price_p) allowUfh = true;
      if (allowUfh && rt !== null && rt <= (tgt - C.ufh_delta_c)) { if (!S.rooms[roomName].ufh_cold_since) S.rooms[roomName].ufh_cold_since = now; } else { S.rooms[roomName].ufh_cold_since = 0; }
      ufhOn = false; if (S.rooms[roomName].ufh_cold_since && (now - S.rooms[roomName].ufh_cold_since) >= delayS) ufhOn = true; if (rt !== null && rt >= (tgt - C.ufh_off_hyst_c)) ufhOn = false; if (!allowUfh) ufhOn = false;
      remoteSwitch(room.ufh_ip, ufhOn);
    }
  }
  if (outT >= C.ch_outside_max_c && !(S.price_p !== null && S.price_p <= C.ultra_cheap_price_p)) anyDemand = false;
  plantUpdate(anyDemand, outT, showerSoon);
  S.last_resolved_mode = resolvedMode();
  addEvent("heartbeat", "mode=" + S.last_resolved_mode + " out=" + outT + " price=" + S.price_p + " pos=" + maxPos + " ch=" + (anyDemand ? "1" : "0") + " showerSoon=" + (showerSoon ? "1" : "0"));
}
function endpoint(req, res) {
  let mode = qVal(req.query, "mode"); let status = qVal(req.query, "status");
  if (mode !== null) { if (mode === "AUTO" || mode === "AWAY_LT48H" || mode === "AWAY_GT48H") { S.manual_mode = mode; saveMode(); addEvent("mode_set", mode); } }
  if (status === "1") {
    let body = { now: nowTs(), time: hhmm(), manual_mode: S.manual_mode, resolved_mode: resolvedMode(), outside_c: outsideTemp(), kitchen_rh: kitchenHumidity(), price_p: S.price_p, plant_ok: S.plant_ok, plant_fault: S.plant_fault, virtuals_ready: S.virt_ready, targets_day: { living: baseDayTarget("living"), bedroom: baseDayTarget("bedroom"), small: baseDayTarget("small"), kitchen: baseDayTarget("kitchen") }, shower_soon: getVirtualBoolean(C.virt_ids.shower_soon, false), mappings: S, last_reason: S.last_reason, events: S.events };
    res.code = 200; res.headers = [["Content-Type", "application/json"]]; res.body = JSON.stringify(body); res.send(); return;
  }
  res.code = 200; res.body = "OK"; res.send();
}
loadMode(); HTTPServer.registerEndpoint("climate", endpoint); ensureVirtuals(); discoverComponents(); pollPlant(); Timer.set(C.tick_ms, true, climateLoop); Timer.set(C.discover_ms, true, discoverComponents); Timer.set(C.plant_poll_ms, true, pollPlant); Timer.set(60000, true, ensureVirtuals); addEvent("climate_started", "script=" + Shelly.getCurrentScriptId());
