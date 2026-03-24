let C = {
  climate_ip: "192.168.1.15",
  climate_ep: "/script/1/climate",
  hood_ip: "192.168.1.17",
  cooker_ip: "192.168.1.98",
  shower_pump_ip: "192.168.1.76",

  poll_ms: 20000,
  hum_on: 60,
  hum_off: 55,
  cooker_on_w: 250,
  hood_on_w: 30,
  shower_start_w: 25,
  shower_stop_w: 10,
  shower_gap_s: 5 * 60,

  fallback_start_h: 6,
  fallback_end_h: 22,
  fallback_mins_each_hour: 20,
  shower_window_mins: [360, 420, 1140, 1260]
};

let S = {
  hum_hold: false,
  hum_stale: true,
  hood_hold: false,
  cooker_hold: false,
  shower_active: false,
  shower_above_since: 0,
  shower_below_since: 0,
  climate_ok: false,
  last_reason: "boot",
  events: []
};

function nowTs() { let st = Shelly.getComponentStatus("sys"); return st && typeof st.unixtime === "number" ? st.unixtime : 0; }
function hhmm() { let st = Shelly.getComponentStatus("sys"); return st && st.time ? st.time : "00:00"; }
function minsNow() { let p = hhmm().split(":"); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); }
function parseJsonSafe(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function addEvent(tag, msg) { let row = nowTs()+"|"+tag+"|"+msg; S.events.push(row); while (S.events.length > 40) S.events.shift(); S.last_reason = tag + (msg ? (" " + msg) : ""); print("VENT", row); }
function httpGet(url, cb, ud) { Shelly.call("HTTP.GET", { url: url, timeout: 8 }, cb, ud); }
function localFan(on, why) { let st = Shelly.getComponentStatus("switch", 0); if (!st || st.output !== on) Shelly.call("Switch.Set", { id: 0, on: on }, null, null); S.last_reason = why; }
function climateCb(res, ec) {
  if (ec !== 0 || !res || res.code !== 200) { S.climate_ok = false; S.hum_stale = true; return; }
  let body = parseJsonSafe(res.body); if (!body) return; S.climate_ok = true;
  if (typeof body.kitchen_rh === "number") {
    if (!S.hum_hold && body.kitchen_rh >= C.hum_on) S.hum_hold = true;
    if (S.hum_hold && body.kitchen_rh <= C.hum_off) S.hum_hold = false;
    S.hum_stale = false;
  } else S.hum_stale = true;
}
function switchStatusCb(res, ec, em, ud) {
  if (ec !== 0 || !res || res.code !== 200) return;
  let body = parseJsonSafe(res.body); if (!body) return;
  if (ud.kind === "hood") { let w = typeof body.apower === "number" ? body.apower : (body.output ? 50 : 0); S.hood_hold = !!(body.output || w >= C.hood_on_w); }
  if (ud.kind === "cooker") { let ap = typeof body.apower === "number" ? body.apower : 0; S.cooker_hold = ap >= C.cooker_on_w; }
  if (ud.kind === "pump") {
    let ap2 = typeof body.apower === "number" ? body.apower : 0; let now = nowTs();
    if (!S.shower_active) {
      if (ap2 >= C.shower_start_w) { if (!S.shower_above_since) S.shower_above_since = now; if ((now - S.shower_above_since) >= 10) { S.shower_active = true; S.shower_below_since = 0; } }
      else S.shower_above_since = 0;
    } else {
      if (ap2 > C.shower_stop_w) S.shower_below_since = 0;
      else { if (!S.shower_below_since) S.shower_below_since = now; if ((now - S.shower_below_since) >= C.shower_gap_s) { S.shower_active = false; S.shower_above_since = 0; S.shower_below_since = 0; } }
    }
  }
}
function fallbackScheduleOn() {
  let m = minsNow(); let hh = Math.floor(m / 60); let mm = m % 60; if (hh < C.fallback_start_h || hh > C.fallback_end_h) return false; if (mm < C.fallback_mins_each_hour) return true; let i; for (i = 0; i < C.shower_window_mins.length; i++) { if (Math.abs(m - C.shower_window_mins[i]) <= 15) return true; } return false;
}
function loop() {
  httpGet("http://" + C.climate_ip + C.climate_ep + "?status=1", climateCb, null);
  httpGet("http://" + C.hood_ip + "/rpc/Switch.GetStatus?id=0", switchStatusCb, { kind: "hood" });
  httpGet("http://" + C.cooker_ip + "/rpc/Switch.GetStatus?id=0", switchStatusCb, { kind: "cooker" });
  httpGet("http://" + C.shower_pump_ip + "/rpc/Switch.GetStatus?id=0", switchStatusCb, { kind: "pump" });
  let on = false; let why = [];
  if (S.hum_hold) { on = true; why.push("humidity"); }
  if (S.hood_hold) { on = true; why.push("hood"); }
  if (S.cooker_hold) { on = true; why.push("cooker"); }
  if (S.shower_active) { on = true; why.push("shower"); }
  if (!on && (!S.climate_ok || S.hum_stale) && fallbackScheduleOn()) { on = true; why.push("fallback_cycle"); }
  localFan(on, why.join("+"));
}
function endpoint(req, res) {
  let status = req.query && req.query.indexOf("status=1") >= 0;
  if (status) { res.code = 200; res.headers = [["Content-Type", "application/json"]]; res.body = JSON.stringify({ climate_ok: S.climate_ok, hum_hold: S.hum_hold, hum_stale: S.hum_stale, hood_hold: S.hood_hold, cooker_hold: S.cooker_hold, shower_active: S.shower_active, last_reason: S.last_reason, events: S.events }); res.send(); return; }
  res.code = 200; res.body = "OK"; res.send();
}
HTTPServer.registerEndpoint("vent", endpoint); Timer.set(C.poll_ms, true, loop); addEvent("vent_started", "script=" + Shelly.getCurrentScriptId());
