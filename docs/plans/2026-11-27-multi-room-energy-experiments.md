# Implementation Plan: Multi-Room Mixed Fleet, Energy-Aware Ventilation & House Physics Experiment Loop

- **Date:** 2026-11-27
- **Status:** In Progress
- **Scope:** `functions/` (outdoor psychrometrics & 24h forecast, experiment logger & House Physics Playbook, multi-room comparison, Dashboard API, Remote MCP tools & prompts, device provisioning CLI), `web/` (energy-tax & forecast advisor, quick-action experiment logger, unlabeled event triage, playbook view, multi-room chart overlays), `firestore.rules`, `firestore.indexes.json`, `firmware/` (`v1.4.0` auto-detecting mixed fleet), `enclosure/` (compact SCD-40 satellite SpeakCAD prompt), and `docs/` + `README.md` + `IMPLEMENTATION_PLAN.md`

## Goal
Transform the single-node air quality monitor into a 2–3 node mixed-fleet whole-house network that:
1. Quantifies the real heating, cooling, and dehumidification **"energy tax"** of opening a window and finds free-ventilation windows from Open-Meteo's 24-hour forecast;
2. Learns empirical **"house physics"** from logged and auto-detected real-world experiments (e.g., 5-minute window crack, opening an interior door, running a HEPA purifier or range hood); and
3. Empowers both the Web Dashboard and AI assistants (via Remote MCP) to recommend house-proven, lowest-energy-tax actions whenever spikes occur—sequenced **software-first** so Node #1 (`master-bedroom`) gets immediate value while Nodes #2–3 are ordered and 3D-printed.

## Assumptions & Open Decisions
- **No central HVAC control:** Advisory + AI-agent decision loop only; no smart-thermostat or HVAC wiring/API integration.
- **Mixed-fleet hardware:** Full hubs (`ESP32-S3 + SCD-40 + PMSA003I`) in main/kitchen zones; lower-cost `CO₂ / Temp / RH`-only (`ESP32-S3 + SCD-40`) satellites in secondary rooms, all running a single unified OTA firmware image (`v1.4.0`).
- **Finalized 3-node BOM:** Node #1 & Node #2 = `ESP32-S3 + SCD-40 + PMSA003I` full hubs; Node #3 = bare-minimum `ESP32-S3 + SCD-40` satellite; explicitly skipping `SGP41`, `DPS310`/`BMP390`, and `VEML7700` to keep cost and complexity minimal.
- **Experiment capture UX:** Both a Web Dashboard quick-action logger and WorkOS owner-allowlisted Remote MCP write tools (`log_experiment`, `update_experiment`), plus passive auto-detected unlabeled event candidates on sharp telemetry step changes.
- **Energy-tax model:** Psychrometric dew-point + moist-air enthalpy tax tier (`free` / `low` / `moderate` / `high`) + Open-Meteo 24-hour hourly forecast window finder + empirical indoor temp/RH drift learned from logged experiments (no utility-rate dollar/kWh home-profile estimator).
- **Pull-only delivery:** Web Dashboard + AI MCP on demand; proactive push notifications are explicitly deferred out of this roadmap.
- **Minimal room metadata:** Only `location` + optional `floor` (e.g., `"main"`, `"upstairs"`, `"basement"`) on `device_configs/{device_id}`; cross-room intelligence is driven by numeric room-to-room comparisons, gradients, and multi-room chart overlays rather than detailed room inventories.
- **Sequencing:** Software-first on Node #1 (Phases 1–2), then mixed-fleet rules/backend/firmware `v1.4.0` and whole-house intelligence (Phases 3–4), then Node #2–3 provisioning CLI & compact satellite enclosure (Phase 5), followed by a `[HUMAN]` live walkthrough (Phase 6) and Final Documentation update (Phase 7).

---

## Phases & Validation Gates

### Phase 0: Baseline Verification
**Changes:**
- [x] Confirm a clean, passing baseline across secrets, firmware, backend TypeScript suites, and web dashboard checks before modifying any code.

**Validation Gate 0:**
- Command / check: `./scripts/check-secrets.sh && python3 scripts/test_firmware_local.py && npm --prefix functions test && node scripts/verify_web_dashboard.mjs`
- Expected result: All four commands exit `0` with zero secret findings and all offline test suites passing.
- If it fails: Inspect the failing script's output and resolve any pre-existing drift or local environment issue before starting Phase 1.

---

### Phase 1: Energy-Tax Psychrometrics & Open-Meteo 24h Free-Ventilation Forecast *(Immediate Value on Node #1)*
**Changes:**
- [x] **Psychrometric Energy Tax (`functions/src/services/outdoor.ts`):** Add pure helpers `computeDewPointF(tempF, rh)`, `computeMoistAirEnthalpyKjKg(tempC, rh)`, and `computeVentilationEnergyTax(indoor, outdoor)` returning `{ tier: "free" | "low" | "moderate" | "high", sensible_delta_f, dew_point_indoor_f, dew_point_outdoor_f, dew_point_delta_f, enthalpy_delta_kj_kg, primary_penalty: "none" | "cooling" | "heating" | "dehumidification" | "cooling_and_dehumidification", summary }`.
- [x] **Energy-Aware Window Advice (`functions/src/services/outdoor.ts`):** Upgrade `computeIndoorOutdoorDelta()` to attach `energy_tax` and distinguish clean-but-expensive outdoor conditions (e.g., `open_brief_purge` or `wait_for_window` / `keep_closed_high_tax` alongside existing `open_recommended`, `neutral`, and `keep_closed`, keeping existing consumers backward-safe).
- [x] **24h Forecast Sync & Single-Doc Cache (`functions/src/services/outdoor.ts`, `functions/src/services/firestore/db.ts`):** Extend parallel Open-Meteo calls in `fetchOpenMeteoSnapshot()` (free & keyless) to fetch 24-hour hourly forecasts (`temperature_2m`, `relative_humidity_2m`, `wind_speed_10m`, `weather_code` + hourly `pm2_5`, `us_aqi`), persisting a single compact document `outdoor_forecasts/home` inside the existing `syncOutdoorReadingIfStale()` transaction lease (0 extra reads on cache hits; 1 doc read on forecast queries).
- [x] **Best-Window Finder (`functions/src/services/outdoor.ts`):** Add `findBestVentilationWindows(indoorBaseline, forecast, options)` to score each upcoming hour on air cleanliness (`us_aqi`, `pm2_5`) and lowest energy tax, returning the next `"free"` or `"low"` ventilation window (`start_time`, `end_time`, `duration_hours`, `tax_tier`, `expected_outdoor_temp_f`, `expected_dew_point_f`, `expected_us_aqi`, `reason`).
- [x] **API & MCP Exposure (`functions/src/api/routes/outdoor.ts`, `functions/src/api/routes/telemetry.ts`, `functions/src/api/dashboard.ts`, `functions/src/mcp/tools.ts`):** Include `energy_tax` in `outdoor_delta` on `/api/dashboard/overview` and `get_latest_reading`; add `GET /api/outdoor/forecast` (cached via `DashboardResponseCache`) and read-only MCP tool `get_ventilation_forecast`.
- [x] **Web Dashboard Surface (`web/index.html`, `web/app.js`, `web/api.js`, `web/styles.css`):** Display outdoor Dew Point, an Energy Tax badge (`Free` / `Low Tax` / `Moderate Tax` / `High AC/Humidity Tax`), and a "Next Best Window" pill on the Outdoor and Room cards.
- [x] **Unit & Integration Tests (`functions/src/scripts/verifyOutdoor.ts`, `verifyApi.ts`, `verifyMcp.ts`, `scripts/verify_web_dashboard.mjs`):** Cover summer humid, winter cold, wildfire smoke, and mild fall psychrometric + 24-hour forecast scenarios.

**Validation Gate 1 (Offline + Cloud Deploy Gate):**
- Command / check:
  1. `npm --prefix functions test && node scripts/verify_web_dashboard.mjs && ./scripts/check-secrets.sh`
  2. Live Cloud Deploy Gate: `firebase deploy --only functions,hosting`, then trigger **Refresh Outdoor** on the live Web Dashboard (or hit `GET /api/outdoor/forecast` after auth) and inspect `outdoor_forecasts/home` + UI badges.
- Expected result: All offline tests pass; deployed Cloud Function populates `outdoor_forecasts/home` in Firestore without extra trigger errors, and the live Web Dashboard displays outdoor dew point, Energy Tax tier, and Next Best Window.
- If it fails: Check Open-Meteo hourly array alignment/timezone parsing in `fetchOpenMeteoSnapshot()`, verify `DashboardResponseCache` invalidation on `/api/outdoor/refresh`, and inspect Cloud Functions logs (`firebase functions:log --only mcp,syncOutdoorOnReading`).

---

### Phase 2: Experiment Logger, Auto-Detected Events & House Physics Playbook *(Immediate Value on Node #1)*
**Changes:**
- [x] **Experiment & Playbook Collections (`functions/src/services/experiments.ts`, `functions/src/services/firestore/db.ts`):** Define Admin-SDK-only Firestore collections (already deny-all to clients via `firestore.rules` catch-all):
  - `experiments/{experimentId}`: `{ id, action_type, custom_label, device_id, location, started_at, ended_at, duration_minutes, notes, status: "active" | "pending_evaluation" | "evaluated" | "unlabeled" | "dismissed", source: "dashboard" | "mcp" | "auto_detected", outdoor_snapshot, energy_tax_tier, evaluation: { baseline, post_settle, co2_delta_ppm, co2_rate_ppm_per_min, pm2_5_delta_ug_m3, temp_delta_f, humidity_delta_percent, cross_room_deltas, evaluated_at } | null, created_at, created_by }`
  - `house_playbook/summary` (single compact rollup doc to minimize Firestore reads): empirical medians/means grouped by `(location, action_type, energy_tax_tier)` — `sample_count`, `co2_delta_ppm`, `pm2_5_delta_ug_m3`, `temp_delta_f`, `humidity_delta_percent`, `avg_duration_minutes`, `confidence: "low" | "medium" | "high"`, `last_observed_at`.
- [x] **Settling-Window Evaluator (`functions/src/services/experiments.ts`):** Implement `evaluateExperimentOutcome()` reading from `daily_rollups` (with raw fallback) using a 15-minute pre-baseline window (`started_at - 15m .. started_at`) and 20-minute post-settle window (`ended_at .. ended_at + 20m`) across the target device and all sibling devices (capturing cross-room spillover) plus outdoor context.
- [x] **Passive Auto-Detection & Opportunistic Finalizer (`functions/src/index.ts`, `functions/src/services/experiments.ts`):** Inside `syncOutdoorOnReading`, add `detectUnlabeledEventCandidate()` comparing the incoming sample against the device's prior snapshot; on sharp step changes (`|ΔCO₂| >= 150 ppm` or `|ΔPM2.5| >= 15 µg/m³` within `<= 15` minutes) with a 30-minute per-device cooldown and no overlapping logged experiment, write a `status: "unlabeled", source: "auto_detected"` candidate. Opportunistically finalize any `pending_evaluation` experiments whose `ended_at + 20m` window has elapsed and refresh `house_playbook/summary`.
- [x] **Dashboard API & Schemas (`functions/src/api/routes/experiments.ts`, `functions/src/api/schemas.ts`, `functions/src/api/dashboard.ts`):** Add WorkOS owner-allowlisted endpoints with strict `.strict()` Zod validation and `DashboardResponseCache` invalidation: `GET /api/experiments`, `POST /api/experiments`, `PATCH /api/experiments/:id`, `POST /api/experiments/:id/evaluate`, and `GET /api/playbook`.
- [x] **Remote MCP Read/Write Tools & Prompt (`functions/src/mcp/tools.ts`, `functions/src/mcp/prompts.ts`):**
  - Write tools (`readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false`): `log_experiment` and `update_experiment` (finish / label / dismiss).
  - Read tools (`readOnlyHint: true`): `list_experiments` and `get_house_playbook` (accepts current indoor/outdoor context to rank house-proven recommendations).
  - Update `analyze_indoor_air` prompt to consult `get_ventilation_forecast` and `get_house_playbook` so AI recommendations cite measured past house outcomes and energy tax.
- [x] **Web Dashboard Experiments & Playbook UI (`web/index.html`, `web/app.js`, `web/api.js`, `web/styles.css`):** Add an **Experiments & Playbook** section/tab featuring one-tap presets (*Crack Window*, *Cross-Ventilate*, *Open Door*, *HEPA Purifier*, *Range Hood*, *Custom*), active experiment timer/stop control, retroactive "Log Past Action" drawer, "Unlabeled Events Detected" triage cards (one-tap label or dismiss), and the Learned House Playbook table.
- [x] **Indexes & Verification Suite (`firestore.indexes.json`, `functions/src/scripts/verifyExperiments.ts`, `functions/package.json`):** Add any required composite index on `experiments` (if querying by `status` + `started_at desc`; prefer single-field `started_at desc` where possible to keep index count minimal), wire `verify:experiments` into `verify:all`, and extend `verifyApi.ts`, `verifyMcp.ts`, and `verify_web_dashboard.mjs`. *(Validation Gate 2 passed offline and on the live project, then this work was committed on main.)*

**Validation Gate 2 (Offline + Cloud Deploy Gate):**
- Command / check:
  1. `npm --prefix functions test && node scripts/verify_web_dashboard.mjs && ./scripts/check-secrets.sh`
  2. Live Cloud Deploy Gate: `firebase deploy --only firestore:indexes,functions,hosting`, then log a test experiment via the Dashboard and via MCP (`log_experiment`), trigger evaluation, and inspect `GET /api/playbook`.
- Expected result: `verify:experiments` and all 8+ backend suites pass; deployed `experiments` + `house_playbook/summary` persist and update cleanly with zero unauthenticated access (`401`/`403` verified).
- If it fails: Check Firestore index status (`firebase firestore:indexes`) if a query returns `FAILED_PRECONDITION`, verify `syncOutdoorOnReading` cooldown logic doesn't suppress valid tests, and inspect `DashboardResponseCache` invalidation on experiment mutations.

---

### Phase 3: Mixed-Fleet Data Model, Security Rules & Auto-Detecting Firmware (`v1.4.0`)
**Changes:**
- [x] **Backward-Compatible Security Rules (`firestore.rules`, `scripts/verify_device_configs_rules.py`):** The `firestore-rules-author` specialist was not available in this session, so the rules were edited directly. Emulator checks passed, then `firebase deploy --only firestore:rules` released the file. The released rules match `firestore.rules`. The rules are:
  - `validReading` and `validLatestReading` accept `null` for PM/AQI/particle fields (`pm1_0_ug_m3`, `pm2_5_ug_m3`, `pm10_0_ug_m3`, `aqi_us`, `aqi_category`, `particles_*`) when a node lacks a `PMSA003I`, while keeping strict numeric/enum checks whenever non-null.
  - `validSensors` accepts `['SCD-40']` as well as `['SCD-40', 'PMSA003I']`.
  - Optional `floor` (`string | null`, safe slug `<= 32` chars) is permitted on `device_configs/{deviceId}` (Admin SDK written).
  - Extend `scripts/verify_device_configs_rules.py` to test both legacy full-hub writes and `SCD-40`-only satellite writes (plus reject negative/out-of-range non-null PM values).
- [x] **Null-Safe Backend Services (`functions/src/services/firestore/types.ts`, `rollups.ts`, `readings.ts`, `analytics.ts`, `devices.ts`, `deviceConfigs.ts`, `outdoor.ts`, `api/schemas.ts`):** Update `AirQualityReading`, `DeviceLatestReadingSnapshot`, `CompactIndoorSample`, `assessReadingHealth()`, `computeAirQualitySummary()`, and `computeIndoorOutdoorDelta()` so missing PM/AQI fields stay strictly `null` (never coerced to `0`!)—preventing `SCD-40`-only satellites from diluting house PM₂.₅ averages or reporting false `0 µg/m³` Good AQI. Support optional `floor` on `DeviceConfig` and `updateDeviceConfigSchema`. Offline checks passed. `firebase deploy --only functions` updated `mcp` and `syncOutdoorOnReading` in `us-east1` on 2026-11-27 at 8:57 PM America/Detroit. Hosting was not deployed.
- [ ] **Unified Auto-Detecting Firmware `v1.4.0` (`firmware/app.py`, `firmware/firestore_client.py`, `scripts/test_firmware_local.py`):**
  - Update `init_sensors(i2c)` in `firmware/app.py` to require `SCD-40 (0x62)` and auto-detect `PMSA003I (0x12)`:
    - Present → `active_sensors = ["SCD-40", "PMSA003I"]`, full reading payload.
    - Absent → `active_sensors = ["SCD-40"]`, log `[I2C] Running in SCD-40 satellite mode (no PMSA003I detected)`, publish `null` for PM/AQI/particle fields.
  - Bump `FIRMWARE_VERSION = "1.4.0"` and update `firmware/firestore_client.py` to serialize `None` as `{ "nullValue": None }` for nullable PM/AQI fields.
- [ ] **Null-Safe Web UI (`web/app.js`, `web/charts.js`, `web/index.html`):** Render satellite cards cleanly with `CO₂ / Temp / Humidity` and a `CO₂ Satellite` badge (muting/omitting PM₂.₅/AQI slots instead of showing `0` or `NaN`), expose optional `Floor` field in the Device Settings drawer, and skip `null` PM samples gracefully in `charts.js`.

**Validation Gate 3 (Deploy Rules First → Firmware & Backend → Cloud Deploy Gate):**
- Command / check:
  1. Offline checks: `python3 scripts/test_firmware_local.py && npm --prefix functions test && node scripts/verify_web_dashboard.mjs && ./scripts/check-secrets.sh`
  2. Deploy rules FIRST: `firebase deploy --only firestore:rules && python3 scripts/verify_device_configs_rules.py`
  3. Confirm live `v1.3.3` Node #1 keeps publishing cleanly (`devices/feather-s3-01` `last_seen_at` advances), then deploy `firebase deploy --only functions,hosting` and publish `firmware_releases/1.4.0` via `npm --prefix functions run publish:release`.
- Expected result: Zero `403 PERMISSION_DENIED` errors on existing `v1.3.3` nodes; both full-hub and synthetic `SCD-40`-only satellite payloads validate and render cleanly without `0`-coercion bugs.
- If it fails: Do NOT proceed to Phase 4 if `v1.3.3` publishes fail—check `hasOnly` / `hasAll` key lists in `firestore.rules` and `null` handling in `firestore_client.py` / `rollups.ts` first.

---

### Phase 4: Multi-Room Whole-House Intelligence (`compare_rooms` & Dashboard Overlays)
**Changes:**
- [ ] **Multi-Room Analytics Service (`functions/src/services/firestore/multiRoom.ts` + re-exports in `firestore.ts`):** Implement `compareRooms()` computing:
  - Per-room latest snapshot (`device_id`, `location`, `floor`, `sensors`, `is_stale`, `co2_ppm`, `pm2_5_ug_m3`, `temperature_f`, `humidity_percent`, `dew_point_f`).
  - Whole-house summary (indoor averages, worst CO₂ room, worst PM₂.₅ room across PM-capable hubs only, min/max temp & humidity spread, and per-floor averages when `floor` is configured).
  - **Zero-Energy Internal Dilution Detector:** Flags when any room has elevated CO₂ (`> 1000 ppm`) while another indoor room is substantially fresher (`>= 250 ppm` lower and `< 850 ppm`), surfacing an indoor equalization opportunity (e.g., *"Open bedroom door to equalize with main floor — 0 energy tax"*), and flags PM₂.₅ gradients (`>= 10 µg/m³` spread across PM hubs) to pinpoint active particle sources.
- [ ] **API & MCP (`functions/src/api/routes/telemetry.ts`, `functions/src/mcp/tools.ts`, `functions/src/mcp/prompts.ts`):**
  - Attach `whole_house` summary and `dilution_opportunities` to `/api/dashboard/overview`.
  - Support `device_id=all` multi-series history response on `/api/readings/history` (using `daily_rollups` so read cost stays minimal).
  - Register read-only MCP tool `compare_rooms` and update `analyze_indoor_air` prompt to call `compare_rooms` first when multiple sensors exist.
- [ ] **Web Dashboard Multi-Room UI (`web/index.html`, `web/charts.js`, `web/app.js`, `web/styles.css`):**
  - Add a **Whole-House Summary & Dilution Banner** above room cards whenever `>= 2` sensors exist (cleanly hidden when only 1 sensor exists).
  - Add **Compare All Rooms** multi-line overlay mode to `web/charts.js` (color-coded per room + dashed Outdoor line + synchronized hover tooltip).

**Validation Gate 4 (Offline Multi-Room Fixtures + Cloud Deploy Gate):**
- Command / check:
  1. `npm --prefix functions test && node scripts/verify_web_dashboard.mjs && ./scripts/check-secrets.sh` (using 3-room mixed-fleet fixtures: 1 full hub `kitchen-living` + 2 `SCD-40` satellites `master-bedroom` & `home-office`)
  2. Live Cloud Deploy Gate: `firebase deploy --only functions,hosting`
- Expected result: `compare_rooms` accurately excludes `null` PM satellites from PM₂.₅ averages, detects internal CO₂ dilution opportunities, and multi-room charts render without overlap or `NaN` errors; single-node live Node #1 UI stays uncluttered.
- If it fails: Check null-filtering in `compareRooms()` and multi-series timestamp alignment in `web/charts.js`.

---

### Phase 5: Scaling Toolkit — Node #2–3 Provisioning CLI & Compact Satellite Enclosure
**Changes:**
- [ ] **Per-Device Provisioning CLI (`functions/src/scripts/provisionDevice.ts` + `provision:device` script in `functions/package.json`):**
  - Supports `--device-id`, `--location`, `--floor`, `--dry-run` (default safe dry-run unless `--apply` is passed), and `--migrate-existing` (to bind Node #1's existing Auth UID to `feather-s3-01`).
  - Under `--apply`: creates a dedicated Firebase Auth email/password user for the node (password generated cryptographically at runtime, never hardcoded), writes `authorized_devices/{uid}` with `{ device_id }` (activating per-device UID isolation in `firestore.rules`), seeds `device_configs/{device_id}` (with `floor`), and prints a ready-to-paste `settings.toml` block to stdout without writing secrets into tracked files.
- [ ] **Compact `SCD-40`-Only Satellite Enclosure (`enclosure/speakcad-satellite-prompt.txt`):** Adapt the proven screwless sliding-dovetail thermally-baffled design in `enclosure/speakcad-prompt.txt` into a smaller two-zone footprint (ESP32-S3 Feather + SCD-40 + compact STEMMA QT cable bay, omitting Zone 2 PMSA003I and rear fan grilles) for faster Bambu Lab X1 Carbon prints.
- [ ] **Offline Provisioning Validation:** Add unit checks validating `provisionDevice.ts` CLI arg parsing, safe dry-run behavior, and `authorized_devices` / `device_configs` payload schemas.

**Validation Gate 5:**
- Command / check: `npm --prefix functions test && npm --prefix functions run provision:device -- --device-id feather-s3-02 --location home-office --floor upstairs --dry-run && ./scripts/check-secrets.sh`
- Expected result: Dry-run prints exact planned Auth/Firestore mutations without mutating live Firebase; `./scripts/check-secrets.sh` exits `0`.
- If it fails: Verify `provisionDevice.ts` never prints literal credentials in `--dry-run` and never writes `.toml` files into tracked paths.

---

### Phase 6 (`[HUMAN]`): Human-Guided Live Walkthrough & First House Experiments
**Changes:**
- [ ] **Area 1 — Energy Tax & 24h Forecast (Node #1):** Open live dashboard (`https://<project>.web.app`), confirm Outdoor card shows Dew Point, Energy Tax tier, and Next Best Window; ask Gemini/Claude/Grok via MCP *"Should I open my bedroom window right now or wait?"* and verify real forecast reasoning.
- [ ] **Area 2 — Live Experiment & Auto-Event Loop (Node #1):** Run 2 real experiments (e.g., 5-min window crack + opening bedroom door), log one from the Dashboard and one via MCP (`log_experiment`), wait for the 20-min post-settle evaluation, confirm `house_playbook/summary` updates, and verify MCP cites your house's measured CO₂/°F impact.
- [ ] **Area 3 — Unified `v1.4.0` Cloud OTA Rollout:** Promote `feather-s3-01` from `v1.3.3` → `v1.4.0` via the Dashboard **Fleet & Firmware** tab and confirm clean boot + continuous telemetry.
- [ ] **Area 4 — Node #2 / #3 Mixed-Fleet Onboarding *(as hardware arrives)*:** Print compact satellite / full hub enclosure(s), run `provision:device --apply`, flash CircuitPython + `v1.4.0`, confirm `SCD-40`-only satellite publishes cleanly alongside the full hub, and verify `compare_rooms`, multi-room chart overlays, and cross-room experiment spillover.

*(Process for each area: report any issue → fix + add regression test → verify CI passes → deploy → confirm live → check off.)*

---

### Final Phase (Phase 7): Documentation & Onboarding Update
**Changes:**
- [ ] Create `docs/14-multi-room-energy-and-experiments.md` documenting psychrometric energy-tax math, Open-Meteo 24h forecast caching, the experiment & House Physics Playbook workflow, mixed-fleet `SCD-40` satellite auto-detection, per-device UID provisioning, and real-world troubleshooting lessons captured during Phases 1–6.
- [ ] Update `README.md` (status table, docs curriculum, verification commands), `IMPLEMENTATION_PLAN.md` (link this plan & mark Phase 4B milestones), `docs/08-enclosure-hardware-plan.md` (reference `enclosure/speakcad-satellite-prompt.txt`), and `docs/11-outdoor-weather-and-aqi.md` (reference energy-tax & forecast upgrade).
- [ ] Mark all completed checkboxes in this plan and set **Status** to `Complete`.

**Final Validation Gate:**
- Command / check: `./scripts/check-secrets.sh && python3 scripts/test_firmware_local.py && npm --prefix functions test && node scripts/verify_web_dashboard.mjs`
- Expected result: Clean exit `0` across all checks with up-to-date docs, zero broken relative links, and zero secret-scanner hits.

---

## Key Technical Pitfalls & Guardrails
1. **Firestore Read Budget:** Store the 24h forecast in a single `outdoor_forecasts/home` doc (updated inside the existing Open-Meteo lease) and aggregated learnings in a single `house_playbook/summary` doc so dashboard loads and AI queries stay well inside Firebase's free tier.
2. **Rules Deploy Order:** Always deploy `firestore.rules` (Phase 3) *before* rolling out `v1.4.0` firmware or `SCD-40`-only nodes, and keep all PM/AQI fields strictly backward-compatible for live `v1.3.3` nodes.
3. **`null` Never `0` for Satellite PM Fields:** Coercing missing PM₂.₅/AQI to `0` on `SCD-40`-only nodes would corrupt house averages and show false "Good (0 µg/m³)" readings—preserve `null` end-to-end across rules, rollups, analytics, MCP, and charts.
4. **Explicit MCP Tool Annotations & Strict Schemas:** Mark `log_experiment` and `update_experiment` with `readOnlyHint: false` and validate every write payload with Zod `.strict()` + existing WorkOS owner allowlist.
5. **Auto-Detection Debouncing:** Require sharp deltas (`|ΔCO₂| >= 150 ppm` or `|ΔPM2.5| >= 15 µg/m³` within `<= 15` min), a 30-min per-device cooldown, and no overlapping active/recent logged experiment so normal occupancy curves don't spam unlabeled cards.
6. **5-Minute Polling Settling Window:** Evaluating experiments over `started_at - 15m` pre-baseline and `ended_at + 20m` post-settle avoids noise from 5-minute sampling alignment and captures full room mixing.
7. **Public-Repo Secret Hygiene:** `provision:device` must generate random passwords at runtime, never hardcode credentials or personal paths in scripts/tests, and always run `./scripts/check-secrets.sh` before commits.
