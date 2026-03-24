# ShellyControl v2 architecture

This revision keeps the **control loops local on the LAN** and uses WAN data only as an optimization layer.

## Main controllers

- `scripts/v2/plant_controller_v2.js` on **192.168.1.127** (Shelly 2PM Gen4)
- `scripts/v2/climate_controller_v2.js` on **192.168.1.15** (Shelly BLU Gateway Gen3)
- `scripts/v2/shower_demister_v2.js` on **192.168.1.76** (shower pump Shelly)
- `scripts/v2/kitchen_vent_v2.js` on **192.168.1.31** (kitchen ventilation plug)
- `scripts/v2/washer_away_watchdog_v2.js` on **192.168.1.16** (washing machine plug)

## Design rules

- **DHW and CH are separated**
  - Diverter stays on **CH** whenever DHW is not actively being heated.
  - DHW demand is **latched** from `input:0` and only cleared by `input:1`.
- **DHW decisions use both hard signals and a model**
  - Hard signals: DHW call and DHW satisfied inputs.
  - Model: shower draw energy, standby loss, top-pipe urgency during active draw.
- **WAN is optional**
  - Agile and Open-Meteo data are fetched ahead of time and cached locally.
  - If WAN disappears, cached data are reused for many hours.
  - If cache is stale, the system falls back to sensible local rules.
- **Fault tolerance**
  - If the ASHP path becomes unavailable and DHW is urgent, the plant goes to **panic immersion mode**.
  - If climate or humidity sensing becomes stale, the kitchen fan falls back to a timed ventilation cycle.
  - Shower handling allows **up to 5 minutes between bursts** and still treats it as one shower.

## Outside lights

Use the **device’s local schedule / sunrise-sunset action**, not a script.

## Important note about the provided MAC addresses

The provided MAC/ID for **kitchen H&T** and **living room H&T** are identical in the user message.  
That cannot represent two separate physical sensors.

The climate script still works because room temperature is taken from the **TRV-associated external sensor**.  
However, the kitchen fan’s humidity source uses the provided kitchen H&T MAC, so that kitchen/living MAC conflict should be corrected later for best accuracy.

## Recommended boot settings

- Run the listed scripts **on boot**
- Keep **ASHP power** default ON
- Keep **router** default ON
- Keep **dehumidifier** default ON
- Keep **fridge** default ON and set a local **auto-on = 7200s**
- Keep **diverter output 0** default ON so reboot defaults to **CH**
- Keep **circ pump output 1** default OFF
- Outside lights: local schedule only
