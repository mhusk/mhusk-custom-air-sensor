# Step-by-Step Implementation & Validation Plan

This document serves as the living roadmap and session handoff tracker for building the **Custom ESP32-S3 Air Quality Sensor + Firebase + Remote MCP Server** project across multiple chat sessions.

---

## How We Work (Workflow Rules for Every Step)

To keep every change easy to understand, debug, and learn from, every step in this plan follows a strict 4-part loop:

1. **Build One Atomic Slice + Its Documentation**:
   - Implement only the files for the current step.
   - Author or update the corresponding `docs/0X-*.md` guide right alongside the code (rather than waiting until the end of the project).
2. **Run One Focused Validation Check**:
   - Pause and run a single, non-bulky validation check that tests **only** the newly added layer in isolation.
   - If something fails, we immediately know which layer caused it.
3. **Capture Real-World "Good to Know" & Troubleshooting Notes**:
   - Any errors, subtle gotchas, CLI quirks, or insights discovered during validation are immediately documented in a **"Good to Know & Real-World Troubleshooting"** section inside that step's `docs/0X-*.md` file so future readers benefit.
4. **Commit & Check Off**:
   - Once validation passes and the docs reflect what we learned, update the checkbox (`[x]`) in both this file (`IMPLEMENTATION_PLAN.md`) and any active feature plan under `docs/plans/` (per `AGENTS.md`) and make a dedicated git commit for the step.

---

## Progress Tracker

### Phase 1: Core v1 Sensor Node, Cloud Firestore & Remote MCP Server *(Completed)*
- [x] **Step 1**: `README.md` & Public-Repo Security Guardrails
- [x] **Step 2**: Firebase Project Initialization & Firestore Database Provisioning
- [x] **Step 3**: Hardened Firestore Security Rules
- [x] **Step 4**: Firmware Math & REST Client (Tested Locally on Mac First)
- [x] **Step 5**: Cloud Functions Scaffolding & Firestore Query Service
- [x] **Step 6**: Core MCP Server Tools, Prompts & Resources (Local/Bearer Validation)
- [x] **Step 7**: WorkOS AuthKit Integration & Owner Allowlist
- [x] **Step 8**: Connecting AI Assistants (Gemini, Claude, ChatGPT, Grok)
- [x] **Step 9**: Physical Hardware Assembly & CircuitPython Flashing
- [x] **Step 10**: Complete CircuitPython Sensor Loop (`firmware/code.py`)
- [x] **Step 11**: Live End-to-End AI Query & Final Docs Polish
- [x] **Enclosure Plan**: Screwless 3D-Printed Enclosure Design & SpeakCAD Spec (`docs/08-enclosure-hardware-plan.md`) — *printed on Bambu Lab X1 Carbon; commissioned, thermally calibrated, and inaudible*

### Phase 2: Enclosure Commissioning, Lightweight Web Dashboard & Remote Config *(Layer 1 — Completed)*
- [x] **Step 12**: `device_configs` Firestore Schema, Rules & Calibration Docs *(cloud schema, `firestore.rules`, seed doc, 5-point rules validation, and physical enclosure commissioning in `docs/08-enclosure-hardware-plan.md` Section 8 complete)*
- [x] **Step 13**: Firmware Remote Configuration Polling (`device_configs/{device_id}`) *(v1.1.0 live-verified end-to-end on ESP32-S3 hardware: `v1` → `v2` 60s/LED-off → `v3` 300s/LED-on)*
- [x] **Step 14**: Dashboard Backend API & WorkOS Auth Integration
- [x] **Step 15**: Lightweight Web Dashboard on Firebase Hosting (Live Charts + Device Settings Drawer)

### Phase 3: Cloud Pull-Based OTA Firmware Updates with A/B Rollback *(Layer 2 — Completed)*
- [x] **Step 16**: Safe Bootloader Split (`boot.py` USB-Aware Mount + Minimal `code.py` → `app.py` with Auto-Rollback) *(live-verified on ESP32-S3 hardware: broken `app.py` on wall power auto-rolled back to `app.py.bak` and resumed publishing `v1.2.0`)*
- [x] **Step 17**: Release Manifest Schema, SHA-256 Artifact Hosting & Publish CLI *(live-verified: `firestore.rules` deployed, `firmware_releases/1.2.0-rc1` published atomically, all 6 offline + 9 live REST security/SHA-256 checks passed)*
- [x] **Step 18**: On-Device Pull-Based OTA Updater (Download, Verify, Atomic Swap & Health Check) *(live-verified on ESP32-S3 wall power: wireless `1.3.0` → `1.3.2` upgrade + live tampered SHA-256 rejection)*
- [x] **Step 19**: Fleet & Firmware Rollout Panel in Web Dashboard *(live-verified on ESP32-S3 wall power: `1.3.2` → `1.3.3` promoted from the web dashboard)*

### Phase 4: Multi-Room Fleet, Energy Awareness & Experiments *(In Progress)*
- [x] **Step 20**: Outdoor Weather & AQI Feed (Open-Meteo Trigger, Dashboard Deltas & Chart Overlays, MCP `get_outdoor_air_quality` + `outdoor_comparison`)
- [x] **Step 21**: Firestore Read Optimization & Daily Rollups (`daily_rollups`, `outdoor_daily_rollups`, server/browser TTL caches, backfill CLI; see [docs/plans/2026-11-24-reduce-firestore-reads.md](docs/plans/2026-11-24-reduce-firestore-reads.md) and [docs/13-firestore-read-optimization-and-rollups.md](docs/13-firestore-read-optimization-and-rollups.md))
- [x] **Step 22**: Visual Showcase, EXIF-Stripped Media Pipeline & Google Flow Hype Video Storyboard (see [docs/plans/2026-11-24-hype-video-and-readme-showcase.md](docs/plans/2026-11-24-hype-video-and-readme-showcase.md) and [docs/12-showcase-and-hype-video.md](docs/12-showcase-and-hype-video.md))
- [x] **Step 23**: Reliability, Security & Multi-Room Hardening (`v1.3.4` firmware timeouts & 30-bit monotonic safety, Open-Meteo `WriteBatch`, CORS/WorkOS hardening, expanded GitHub Actions CI)
- [x] **Step 24**: Psychrometric Energy Tax & 24h Open-Meteo Free-Ventilation Forecast (Phase 1 of [docs/plans/2026-11-27-multi-room-energy-experiments.md](docs/plans/2026-11-27-multi-room-energy-experiments.md))
- [x] **Step 25**: Experiment Logger, Auto-Detected Events & House Physics Playbook (Phase 2 of [docs/plans/2026-11-27-multi-room-energy-experiments.md](docs/plans/2026-11-27-multi-room-energy-experiments.md)):
  - [x] **Step 25.1 (2.1)**: Core Experiments & House Physics Playbook Service (`b0aedbd`, deployed)
  - [x] **Step 25.2 (2.2)**: Passive Auto-Detection & Opportunistic Finalizer (`02003bf`, deployed)
  - [x] **Step 25.3 (2.3)**: Dashboard API Routes & Strict Zod Schemas (`27222e1`, deployed)
  - [x] **Step 25.4 (2.4)**: Remote MCP Read/Write Tools & `analyze_indoor_air` Prompt Update
  - [x] **Step 25.5 (2.5)**: Web Dashboard Experiments & Playbook UI
  - [x] **Step 25.6 (2.6)**: Live Cloud Deploy Gate & Validation Gate 2 *(deployed, then committed on main)*
- [ ] **Step 26** *(In Progress)*: Mixed-Fleet Data Model, Security Rules & Auto-Detecting Firmware `v1.4.0` (Phase 3 — `SCD-40`-only satellite support + full hubs):
  - [x] **Step 26.1 (3.1)**: Backward-compatible Firestore rules for null PM/AQI fields, `SCD-40`-only sensors, and optional `floor` (emulator-verified and deployed; live rules match the file)
  - [x] **Step 26.2 (3.2)**: Null-safe backend services (PM/AQI stay null; optional `floor` on device config). Offline checks passed. Not deployed.
- [ ] **Step 27**: Multi-Room Whole-House Intelligence (`compare_rooms`, Zero-Energy Internal Dilution Detector & Multi-Room Chart Overlays) (Phase 4)
- [ ] **Step 28**: Scaling Toolkit — Node #2–3 Per-Device Provisioning CLI (`provision:device`) & Compact Satellite Enclosure Prompt (Phase 5)
- [ ] **Step 29**: Live Hardware Walkthrough, First House Experiments & Final Docs (Phases 6–7)
- [ ] **Future / Deferred**:
  - **Proactive Alerts**: Firestore `onDocumentCreated` push alerts with cooldowns (CO₂ / PM₂.₅ / stale sensor)
  - **Optional Smart-Home Actuation & VOC/NOₓ Expansion**: Triggering a HEPA air purifier smart plug on PM₂.₅ spikes and adding a Sensirion `SGP41` VOC/NOₓ breakout on STEMMA QT

---

## Detailed Step Breakdown

### Phase 1: Core v1 Sensor Node, Cloud Firestore & Remote MCP Server

### Step 1: `README.md` & Public-Repo Security Guardrails
- **Status**: `[x] Completed`
- **Goal**: Establish the project README (including the backstory inspired by the Chris Williamson podcast with Michael Feldstein, founder of Jaspr—building our own sensor for a similar price as off-the-shelf units to learn how IAQ hardware, cloud telemetry, and MCP work under the hood) and put all 4 layers of secret protection in place before any real credentials exist.
- **Deliverables**:
  - `README.md`
  - `.gitignore`
  - `.gitleaks.toml`
  - `scripts/check-secrets.sh` (executable local pre-commit secret check)
  - `.github/workflows/secret-scan.yml`
  - Safe template files: `.firebaserc.example`, `firmware/settings.toml.example`, `functions/.env.example`
  - `docs/06-security-and-privacy-checklist.md`
- **Single Focused Validation**:
  - Create a temporary dummy secret in a working tree file and run `./scripts/check-secrets.sh` to verify it detects and blocks the secret, then remove the dummy secret and verify `./scripts/check-secrets.sh` passes cleanly.
- **Target Commit**: `chore(security): add README, secret guardrails, templates, and security guide`

---

### Step 2: Firebase Project Initialization & Firestore Database Provisioning
- **Status**: `[x] Completed`
- **Goal**: Create the Firebase project, enable Firestore and Firebase Authentication (Email/Password for the dedicated sensor device account), and configure local Firebase CLI project files.
- **Deliverables**:
  - Interactive walkthrough to create the Firebase project, Firestore database, and dedicated device Auth user
  - `.firebaserc` (local only, gitignored)
  - `firebase.json`
  - `firestore.indexes.json` (composite indexes for `readings` by `device_id` + `timestamp` and `location` + `timestamp`)
  - `docs/03-firebase-and-firestore.md` (Part 1: Project creation, Firebase Auth device account, and Firestore indexes)
- **Single Focused Validation**:
  - Run `firebase deploy --only firestore:indexes` and verify the composite indexes build cleanly in the Firebase Console and `.firebaserc` remains untracked by `git status`.
- **Target Commit**: `feat(firebase): add firebase config, composite indexes, and setup guide`

---

### Step 3: Hardened Firestore Security Rules
- **Status**: `[x] Completed`
- **Goal**: Lock down Cloud Firestore so unauthenticated requests have zero access and the dedicated device UID has strict write-only access with schema validation on `readings` and `devices/{device_id}`. The UID lives in Firestore at `authorized_devices/{uid}` so the committed rules stay free of it.
- **Deliverables**:
  - `firestore.rules`
  - `docs/03-firebase-and-firestore.md` (Part 2: Security Rules architecture & schema validation)
- **Single Focused Validation**:
  - Deploy `firestore.rules` (`firebase deploy --only firestore:rules`) and run a two-part check:
    1. Confirm an unauthenticated `curl` request to the Firestore REST API returns `403 PERMISSION_DENIED`.
    2. Confirm the rules compile and deploy with zero warnings.
- **Target Commit**: `feat(firestore): add hardened device write-only security rules`

---

### Step 4: Firmware Math & REST Client (Tested Locally on Mac First)
- **Status**: `[x] Completed`
- **Goal**: Build and verify the pure-Python US EPA AQI calculator and the Firebase Auth + Firestore REST publishing client on macOS **before** introducing microcontroller hardware.
- **Deliverables**:
  - `firmware/aqi.py` (US EPA $\text{PM}_{2.5}$ and $\text{PM}_{10}$ AQI breakpoint calculation and category mapping)
  - `firmware/firestore_client.py` (Firebase Auth `signInWithPassword`, token refresh, and Firestore REST document formatting)
  - `docs/02-circuitpython-firmware.md` (Part 1: How EPA AQI calculation and Firestore REST authentication work)
- **Single Focused Validation**:
  - Run a local Python test on Mac that verifies EPA AQI calculations against known EPA reference values and publishes 1 synthetic sensor reading document to the live Firestore database using the device credentials. Verify the document appears in the Firebase Console under `readings` and `devices`.
- **Target Commit**: `feat(firmware): add EPA AQI calculator and Firestore REST client`

---

### Step 5: Cloud Functions Scaffolding & Firestore Query Service
- **Status**: `[x] Completed`
- **Goal**: Set up the Node.js 22 + TypeScript Firebase Cloud Functions project and implement the Firestore data access & statistical aggregation layer (`firestore.ts`).
- **Deliverables**:
  - `functions/package.json` & `functions/tsconfig.json`
  - `functions/src/services/firestore.ts` (typed functions for `getLatestReading`, `getReadingsHistory`, `getAirQualitySummary`, and `getSensorStatus`)
  - `docs/04-workos-and-mcp-server.md` (Part 1: Cloud Functions TypeScript setup & Firestore aggregation queries)
- **Single Focused Validation**:
  - Run `npm run build` in `functions/` to verify clean TypeScript compilation, and execute a small local verification call against `firestore.ts` to confirm it reads and computes summary stats from the synthetic reading created in Step 4.
- **Target Commit**: `feat(functions): scaffold TypeScript Cloud Functions and Firestore query service`

---

### Step 6: Core MCP Server Tools, Prompts & Resources (Local/Bearer Validation)
- **Status**: `[x] Completed`
- **Goal**: Implement the Model Context Protocol (MCP) server, its 4 tools, its health analysis prompt, and its EPA/ASHRAE reference resource, and test them locally before adding WorkOS OAuth complexity.
- **Deliverables**:
  - `functions/src/mcp/server.ts`
  - `functions/src/mcp/tools.ts` (`get_latest_reading`, `get_readings_history`, `get_air_quality_summary`, `get_sensor_status`)
  - `functions/src/mcp/prompts.ts` (`analyze_indoor_air` prompt + `air-quality://thresholds/reference` resource)
  - `docs/04-workos-and-mcp-server.md` (Part 2: How MCP Tools, Prompts, and Resources work)
- **Single Focused Validation**:
  - Run the MCP server locally (via Firebase Functions emulator / local server) and invoke the MCP tools (`tools/list` and `tools/call` for `get_latest_reading`) using `curl` or the MCP Inspector to confirm valid MCP JSON-RPC responses.
- **Target Commit**: `feat(mcp): implement IAQ MCP server tools, prompts, and reference resources`

---

### Step 7: WorkOS AuthKit Integration & Owner Allowlist
- **Status**: `[x] Completed`
- **Goal**: Configure WorkOS AuthKit and Google Cloud Secret Manager, then wire up OAuth 2.1 metadata discovery, JWT/Bearer verification, and the strict owner allowlist in the Cloud Function HTTP entry point.
- **Deliverables**:
  - Interactive walkthrough to set up WorkOS and store secrets in Firebase/Cloud Secret Manager (`WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `MCP_BEARER_FALLBACK_SECRET`, `ALLOWED_USER_EMAILS`)
  - `functions/src/auth/workos.ts`
  - `functions/src/index.ts`
  - `docs/04-workos-and-mcp-server.md` (Part 3: WorkOS OAuth 2.1, allowlists, and deploying to Cloud Functions 2nd Gen)
- **Single Focused Validation**:
  - Deploy the Cloud Function (`firebase deploy --only functions`) and verify:
    1. An unauthenticated request to the deployed `/mcp` URL returns `401 Unauthorized`.
    2. An authenticated request (with valid Bearer/WorkOS token) returns `200 OK` with MCP tool output.
- **Target Commit**: `feat(auth): integrate WorkOS OAuth 2.1, owner allowlist, and Cloud Function entrypoint`

---

### Step 8: Connecting AI Assistants (Gemini, Claude, ChatGPT, Grok)
- **Status**: `[x] Completed`
- **Goal**: Document and validate connecting live AI assistants to the deployed remote MCP server.
- **Deliverables**:
  - `docs/05-connecting-ai-clients.md`
- **Single Focused Validation**:
  - Connect an AI client (e.g., Claude, ChatGPT, or Grok) to the live Cloud Function MCP endpoint and ask it to fetch the latest air quality reading from Firestore.
- **Target Commit**: `docs(mcp): add guide for connecting Claude, ChatGPT, and Grok to the MCP server`

---

### Step 9: Physical Hardware Assembly & CircuitPython Flashing
- **Status**: `[x] Completed`
- **Goal**: Assemble the Adafruit ESP32-S3 Feather, SCD-40, and PMSA003I via STEMMA QT cables, flash CircuitPython 9.x/10.x, install required libraries onto `CIRCUITPY/lib`, and verify the I2C bus sees both sensors.
- **Deliverables**:
  - `firmware/requirements-circuitpython.txt`
  - `docs/01-hardware-and-i2c.md`
- **Single Focused Validation**:
  - Plug the assembled hardware into the Mac via USB-C, confirm the `CIRCUITPY` drive mounts, and run a short I2C bus scan in the serial console verifying both `0x62` (SCD-40) and `0x12` (PMSA003I) are detected.
- **Target Commit**: `docs(hardware): add STEMMA QT wiring, CircuitPython flashing, and I2C verification guide`

---

### Step 10: Complete CircuitPython Sensor Loop (`firmware/code.py`)
- **Status**: `[x] Completed`
- **Goal**: Implement the full on-device firmware loop (`firmware/code.py`) combining SCD-40 + PMSA003I polling, NeoPixel status colors, watchdog resilience, and 5-minute Firestore publishing, then load it onto the ESP32-S3.
- **Deliverables**:
  - `firmware/code.py`
  - `docs/02-circuitpython-firmware.md` (Part 2: Main sensor loop, NeoPixel status codes, and copying files to `CIRCUITPY`)
- **Single Focused Validation**:
  - Copy `code.py`, `aqi.py`, `firestore_client.py`, and `settings.toml` to the `CIRCUITPY` drive. Observe the NeoPixel turn solid blue during boot, pulse green once when the first reading succeeds, and confirm a real room reading appears in Firestore.
- **Target Commit**: `feat(firmware): add main CircuitPython sensor polling and Firestore loop`

---

### Step 11: Live End-to-End AI Query & Final Docs Polish
- **Status**: `[x] Completed`
- **Goal**: Perform a full end-to-end validation from physical sensors -> ESP32-S3 -> Firestore -> Cloud Function MCP Server -> AI Assistant, and finalize any remaining "Good to Know" notes across all docs.
- **Deliverables**:
  - Final updates to `README.md`, `PRD.md`, `IMPLEMENTATION_PLAN.md`, and `docs/01`–`06`
  - `docs/07-understanding-your-readings.md` (human-readable reference guide covering every sensor metric, health thresholds, diagnostic patterns, and practical ways to improve indoor air quality)
- **Single Focused Validation**:
  - Validated live end-to-end in **Gemini** and **Grok**: *"What is the current air quality in my room right now, and how do my CO2 and PM2.5 levels look?"* confirmed fresh hardware telemetry matching the live ESP32-S3 sensor.
- **Target Commit**: `docs: finalize end-to-end verification notes and complete implementation plan`

---

### Phase 2: Enclosure Commissioning, Lightweight Web Dashboard & Remote Config (Layer 1)

> **Why split Remote Config (Phase 2) from OTA Code Updates (Phase 3)?**
> 90% of day-to-day device changes—calibrating enclosed temperature offset, changing polling intervals, muting bedroom LEDs, or renaming a room—don't require modifying Python code on flash. Solving Remote Config first gives immediate dashboard control with zero flash wear and zero risk of bricking a mounted sensor.

#### Step 12: Enclosure Calibration & `device_configs` Firestore Schema + Rules
- **Status**: `[x] Completed (Cloud Schema, Rules, Docs & Physical Enclosure Commissioning Complete)`
- **Goal**: Commission the 3D-printed enclosure (verify thermal offset, acoustic isolation, and LED shielding) and introduce a hardened `device_configs/{device_id}` Firestore collection so each sensor can pull tunable settings (`location`, `reporting_interval_seconds`, `temperature_offset_c`, `altitude_m`, `led_enabled`, `config_version`, and one-shot `reboot_requested_at`).
- **Deliverables**:
  - Updated `firestore.rules` allowing authenticated sensor devices `get`-only access to `device_configs/{device_id}` (no `list`, no `write`) plus optional reported-config fields on `devices/{device_id}`
  - `scripts/verify_device_configs_rules.py` (5-point live security rules validation script)
  - Calibration log table in `docs/08-enclosure-hardware-plan.md` (Section 8 — ready to record thermal offset, acoustics, and LED check once print completes)
  - `docs/09-remote-config-and-dashboard.md` (Part 1: Control-plane data model, `config_version` tracking, `reboot_requested_at` design, and SCD-40 thermal/altitude calibration)
- **Single Focused Validation**:
  - Deployed `firestore.rules` cleanly with zero warnings, seeded `device_configs/feather-s3-01`, and passed all 5 live access-control checks via `python3 scripts/verify_device_configs_rules.py` (unauth `GET` → `403`, sensor `GET` → `200`, sensor `LIST`/`PATCH`/`DELETE` → `403`).
- **Target Commit**: `feat(firestore): add device_configs schema, rules, and enclosure calibration notes`

#### Step 13: Firmware Remote Configuration Polling (`device_configs/{device_id}`)
- **Status**: `[x] Completed (Verified Locally on Mac; Ready to Copy to CIRCUITPY)`
- **Goal**: Teach the ESP32-S3 firmware (`v1.1.0`) to fetch `device_configs/{device_id}` during its publishing loop, apply updated settings (`temperature_offset_c`, `altitude_m`, `reporting_interval_seconds`, `location`, `led_enabled`, plus one-shot `reboot_requested_at`) live in RAM without touching flash, and report the active `config_version` and calibration back in `devices/{device_id}`.
- **Deliverables**:
  - `firmware/firestore_client.py` (`fetch_device_config()`, Firestore REST decoder, `normalize_device_config()`, `parse_utc_timestamp_epoch()`, `should_trigger_reboot()`, and optional v1.1 fields on `build_device_status_document()`)
  - `firmware/code.py` (`v1.1.0` with non-fatal remote config polling, SCD-40 RAM-only calibration on change, muteable `StatusLED`, one-shot reboot gating, and safe fallback to `settings.toml` defaults)
  - Updated `scripts/test_firmware_local.py` with offline unit tests + `--fetch-config` live Firestore fetch and 404-fallback test
  - `docs/09-remote-config-and-dashboard.md` (Part 2: How the sensor control loop applies live config safely)
- **Single Focused Validation**:
  - Ran `python3 scripts/test_firmware_local.py --fetch-config`: all offline AQI, encoding, decoding, clamping, reboot-gating, and `code.py` syntax tests passed, plus live `GET device_configs/feather-s3-01` (`v1`) and 404-fallback (`v0`) verified against Firestore. Copy `firmware/firestore_client.py` + `firmware/code.py` to `CIRCUITPY` when flashing the Feather.
- **Target Commit**: `feat(firmware): add remote config polling and SCD-40 calibration support`

#### Step 14: Dashboard Backend API & WorkOS Auth Integration
- **Status**: `[x] Completed`
- **Goal**: Add lightweight authenticated JSON API routes to Firebase Cloud Functions—reusing the existing WorkOS AuthKit OAuth + strict owner allowlist—for fetching live room snapshots, 24h/7d time-series data, device health, and updating `device_configs/{device_id}`.
- **Deliverables**:
  - `functions/src/services/firestore.ts` (extended `DeviceStatus` with optional v1.1 config fields + transactional `getDeviceConfig`, `listDeviceConfigs`, `updateDeviceConfig`, `requestDeviceReboot`)
  - `functions/src/auth/workos.ts` (WorkOS UserManagement session token verification + allowlisted `exchangeAuthKitCode` & `refreshAuthKitSession`)
  - `functions/src/api/dashboard.ts` (typed `/api/*` REST endpoints with strict Zod validation) & `functions/src/index.ts` (route wiring + `PUT` CORS support)
  - Verification script (`npm --prefix functions run verify:api` in `functions/src/scripts/verifyApi.ts`) testing `401`/`403` auth rejections, Zod `400` rejections, overview/history queries, config updates, and one-shot reboot requests
  - `docs/09-remote-config-and-dashboard.md` (Part 3: Securing a personal IoT dashboard API with WorkOS AuthKit)
- **Single Focused Validation**:
  - Passed all 7 test groups in `npm --prefix functions run verify:api` and full regression check in `npm --prefix functions run verify:auth`, deployed to Cloud Functions 2nd Gen, and confirmed live `GET /api/auth/config` (`200`) and unauthenticated `GET /api/dashboard/overview` (`401`).
- **Target Commit**: `feat(functions): add WorkOS-protected dashboard and remote config API`

#### Step 15: Lightweight Web Dashboard on Firebase Hosting
- **Status**: `[x] Completed`
- **Goal**: Build and deploy a super-lightweight, responsive web dashboard on Firebase Hosting so you can view live readings, inspect 24h/7d CO₂/PM₂.₅/Temp/Humidity charts at a glance, and tweak any sensor's Layer 1 settings from a clean Device Settings drawer.
- **Deliverables**:
  - `web/` (zero-build vanilla HTML/CSS/ES Modules app with WorkOS AuthKit PKCE login, live °F room cards, interactive 6h/24h/7d SVG trend charts, and native `<dialog>` Device Settings drawer + reboot confirmation)
  - `firebase.json` (Firebase Hosting configuration, security headers, and 2nd Gen `us-east1` Cloud Functions API rewrites)
  - `scripts/verify_web_dashboard.mjs` (offline PKCE, chart geometry, semantic HTML, and Hosting rewrite verification suite)
  - `docs/09-remote-config-and-dashboard.md` (Part 4: Deploying the dashboard, WorkOS Applications → Redirect URIs gotchas, and managing sensor settings from the browser)
- **Single Focused Validation**:
  - Passed all 7 checks in `node scripts/verify_web_dashboard.mjs` and `./scripts/check-secrets.sh`, deployed to Firebase Hosting (`firebase deploy --only hosting`), verified live `/api/auth/config` (`200`) and unauthenticated `/api/dashboard/overview` (`401`), and signed in live via WorkOS AuthKit on the deployed Hosting URL.
- **Target Commit**: `feat(web): add lightweight Firebase Hosting dashboard with remote device config`

---

### Phase 3: Cloud Pull-Based OTA Firmware Updates with A/B Rollback (Layer 2)

> **Why Pull-Based A/B OTA?**
> Updating CircuitPython `.py` files over the air lets you evolve firmware across every room without unscrewing enclosures or touching USB—while keeping a tiny, immutable `code.py` bootloader guarantees that a bad push with a syntax or runtime error automatically rolls back to the last known-good version instead of bricking the board.

#### Step 16: Safe Bootloader Split (`boot.py` + Immutable `code.py` → `app.py`)
- **Status**: `[x] Completed (Live-Verified on ESP32-S3 Wall Power)`
- **Goal**: Refactor the firmware into a USB-aware `boot.py` and a minimal, rock-solid `code.py` bootloader that imports and runs `app.py`, automatically rolling back to `app.py.bak` if a newly deployed `app.py` crashes on boot or fails to record a healthy check-in.
- **Deliverables**:
  - `firmware/boot.py` (1-shot 4-byte `microcontroller.nvm` handoff + `board.BUTTON` failsafe: mounts flash read-write for Python OTA with USB drive disabled on wall power, and auto-hands off to read-write `CIRCUITPY` with zero macOS ejection warnings when plugged into USB)
  - `firmware/code.py` (minimal immutable bootloader with USB host handoff, mid-swap self-heal, WDT guard for pending OTA, boot-attempt counter, `/boot_error.txt` forensics, and power-loss-safe `*.py.bak` rollback)
  - `firmware/app.py` (`v1.2.0` sensor polling + remote config logic moved out of `code.py` with `on_healthy` boot-confirmation hook)
  - `scripts/test_firmware_local.py` (12 offline bootloader & rollback simulation tests)
  - `docs/10-cloud-ota-and-rollback.md` (Part 1: How CircuitPython flash locking, the `boot.py` USB timing catch-22, and A/B rollback bootloaders work)
- **Single Focused Validation**:
  - Passed all 12 offline bootloader simulation tests in `python3 scripts/test_firmware_local.py` and `./scripts/check-secrets.sh`, then staged a deliberately broken `app.py` alongside `app.py.bak` on the Feather ESP32-S3 and moved to wall power—confirmed `code.py` caught the crash, restored `app.py.bak` → `app.py`, rebooted, and resumed publishing live `v1.2.0` readings to Firestore without USB intervention.
- **Target Commit**: `feat(firmware): split USB-aware boot.py and auto-rollback code.py bootloader`

#### Step 17: Release Manifest Schema, SHA-256 Artifact Hosting & Publish CLI
- **Status**: `[x] Completed (Live-Verified on Firestore)`
- **Goal**: Define the cloud OTA release pipeline: store versioned Python payloads (`app.py`, `aqi.py`, `firestore_client.py`, plus optional `ota_updater.py`) with SHA-256 checksums in Firestore (`firmware_releases/{version}/files/{filename}`) and publish release metadata to `firmware_releases/{version}` in an atomic batch.
- **Deliverables**:
  - Updated `firestore.rules` allowing `isSensorDevice()` `get`-only access (no `list`, no `write`) to `firmware_releases/{version}` and non-bootloader `.py` payloads in `firmware_releases/{version}/files/{fileId}`, plus SemVer prerelease support in `isFirmwareVersion()`
  - `functions/src/services/firestore.ts` (typed `FirmwareReleaseManifest` / `FirmwareReleaseFileArtifact` helpers, `setDeviceTargetFirmwareVersion()`, and transactional `target_firmware_version` preservation in `updateDeviceConfig()` and `requestDeviceReboot()`)
  - `functions/src/scripts/publishRelease.ts` (`npm --prefix functions run publish:release`) & `functions/src/scripts/verifyRelease.ts` (`npm --prefix functions run verify:release`)
  - `docs/10-cloud-ota-and-rollback.md` (Part 2: Checksummed release manifests, Firestore subcollection artifact hosting, and safe atomic publishing)
- **Single Focused Validation**:
  - Deployed `firestore.rules` cleanly with zero warnings, published `firmware_releases/1.2.0-rc1` (3 files, `54,819` bytes) via `publish:release`, and passed all 6 offline unit tests + all 9 live Firestore REST security & SHA-256 download checks in `verify:release -- --live --version 1.2.0-rc1` plus all 7 regression checks in `verify:api`.
- **Target Commit**: `feat(ota): add checksummed firmware release manifest and publish script`

#### Step 18: On-Device Pull-Based OTA Updater
- **Status**: `[x] Completed (Live-Verified on ESP32-S3 Wall Power)`
- **Goal**: Implement the pull-based OTA client on the ESP32-S3: compare current `FIRMWARE_VERSION` against `target_firmware_version`, download new `.py` files to `.new` staging paths, verify SHA-256 hashes on-device before touching live files, back up existing files to `.bak`, atomically swap, reboot, and confirm healthy check-in.
- **Deliverables**:
  - `firmware/ota_updater.py` (manifest & bootloader guards, one-file-at-a-time `.new` staging downloads, double SHA-256 verification in RAM + flash read-back using CircuitPython-compatible `hashlib.new("sha256")`, power-loss-safe backup/swap with `app.py` last + `os.sync()`, and rollback-loop prevention via `/ota_pending.txt` + `/ota_failed_version.txt`)
  - `firmware/firestore_client.py` (`is_valid_firmware_version()`, `is_valid_ota_filename()`, `target_firmware_version` normalization, `fetch_firmware_release()`, `fetch_firmware_release_file()`, and optional `ota_status`/`ota_target_version`/`ota_last_error` on `build_device_status_document()`)
  - `firmware/app.py` (`v1.3.2` with post-boot rollback detection, ESP-IDF-safe `init_watchdog()` during pending OTA boots, `confirm_ota_healthy()`, post-publish OTA polling with cyan LED indicator, and `ota_status` reporting)
  - Updated `firestore.rules` allowing optional `ota_status`, `ota_target_version`, and `ota_last_error` fields on `devices/{deviceId}` (deployed cleanly)
  - Updated `scripts/test_firmware_local.py` with offline OTA unit tests (manifest guards, `hashlib.new` fallback, happy-path multi-file swap, corrupted SHA-256 rejection, USB read-only skip, and rollback-loop prevention)
  - `docs/10-cloud-ota-and-rollback.md` (Part 3: End-to-end OTA verification, watchdog safety, CircuitPython `hashlib` + ESP-IDF WDT gotchas, and recovery)
- **Single Focused Validation**:
  - Deployed `firestore.rules` and Cloud Functions (`updateDeviceConfig` `target_firmware_version` preservation), passed all offline tests in `python3 scripts/test_firmware_local.py`, `verify:release`, and `./scripts/check-secrets.sh`, then live-verified on the ESP32-S3 Feather on wall power: wireless OTA upgrade `1.3.0` → `1.3.2` (`ota_status: updating` → reboot → `firmware_version: 1.3.2`, `ota_status: up_to_date`) **and** live rejection of tampered `1.3.3-badhash` (`ota_status: error`, `SHA-256 mismatch for app.py`, zero reboot, remained on `1.3.2`).
- **Target Commit**: `feat(firmware): add SHA-256 verified pull-based OTA updater`

#### Step 19: Fleet & Firmware Rollout Panel in Web Dashboard
- **Status**: `[x] Completed (Live-Verified on ESP32-S3 Wall Power)`
- **Goal**: Add a clean **Fleet & Firmware** tab to the lightweight web dashboard showing every sensor's current vs. target `firmware_version`, online/stale status, last OTA result (`up_to_date`, `updating`, `rolled_back`), and one-click version promotion per device or across all rooms.
- **Deliverables**:
  - Dashboard API endpoints (`GET /api/firmware/releases`, `PUT /api/devices/:deviceId/firmware`, `POST /api/firmware/rollout`) + `ota_status`/`ota_target_version`/`ota_last_error` mapping & `ota_rollout_status` in `functions/src/services/firestore.ts` and `functions/src/api/dashboard.ts`
  - `web/` accessible **Fleet & Firmware** tab (`focusgroup="tablist nomemory"`, `hidden="until-found"`, `@container`-responsive fleet table, Fleet-Wide Promotion bar, Published Releases cards, and native `<dialog>` rollout confirmation modal)
  - Updated `functions/src/scripts/verifyApi.ts` (10 test groups) and `scripts/verify_web_dashboard.mjs` (Step 19 semantics checks)
  - `docs/10-cloud-ota-and-rollback.md` (Part 4: Managing staged rollouts from the web dashboard + `hidden="until-found"` stacking-context gotcha)
- **Single Focused Validation**:
  - Passed all 10 checks in `verify:api`, `verify:auth`, `verify_web_dashboard.mjs`, `test_firmware_local.py`, and `./scripts/check-secrets.sh`; deployed Cloud Functions + Firebase Hosting, published `firmware_releases/1.3.3`, and promoted `feather-s3-01` (`Master Bedroom`) from `v1.3.2` → `v1.3.3` directly from the live web dashboard while on wall power (`Up to date`, `v1.3.3` live).
- **Target Commit**: `feat(web): add fleet firmware status and one-click OTA rollout UI`

---

### Phase 4: Future Horizons *(Multi-Room Fleet & Proactive Intelligence — In Progress)*

#### Step 20: Outdoor Weather & AQI Context (Open-Meteo Trigger, Dashboard Deltas & MCP)
- **Status**: `[x] Completed (Live-Verified on Cloud Functions 2nd Gen & Firebase Hosting)`
- **Goal**: Capture free, keyless Open-Meteo outdoor weather and US EPA AQI snapshots automatically whenever a sensor publishes a reading (throttled via a private `site_configs/home` Firestore doc), display outdoor metrics, indoor-vs-outdoor deltas, and dashed chart overlays on the Web Dashboard, and expose outdoor context to AI assistants via MCP.
- **Deliverables**:
  - `functions/src/services/outdoor.ts` (`fetchOpenMeteoSnapshot()`, WMO weather & US EPA AQI mappers, `computeIndoorOutdoorDelta()` with window ventilation advice, `site_configs/home` + `outdoor_readings` helpers, and cache-throttled `syncOutdoorReadingIfStale()`)
  - `functions/src/index.ts` (2nd Gen Firestore trigger `syncOutdoorOnReading` on `readings/{readingId}` in `us-east1`)
  - `functions/src/api/dashboard.ts` (`GET/PUT /api/site/config`, `POST /api/outdoor/refresh`, `site_config`/`outdoor_latest`/`outdoor_delta` on `/api/dashboard/overview`, and `outdoor_history` on `/api/readings/history`)
  - `functions/src/mcp/tools.ts` & `functions/src/mcp/prompts.ts` (new `get_outdoor_air_quality` tool, `outdoor` + `outdoor_comparison` appended to `get_latest_reading`, and updated `analyze_indoor_air` prompt)
  - `web/` (Outdoor Weather & AQI card, private Home Location `<dialog>` drawer with browser geolocation helper, indoor-vs-outdoor delta strip + window advice on room cards, and dashed Outdoor overlays on PM₂.₅/Temp/Humidity charts)
  - `functions/src/scripts/verifyOutdoor.ts` (`npm --prefix functions run verify:outdoor`) & `docs/11-outdoor-weather-and-aqi.md`
- **Single Focused Validation**:
  - Passed `verify:outdoor`, `verify:mcp`, `verify:api`, `verify:auth`, `node scripts/verify_web_dashboard.mjs`, and `./scripts/check-secrets.sh`, deployed `mcp`, `syncOutdoorOnReading`, and Firebase Hosting, and verified live on the deployed Web Dashboard.
- **Target Commit**: `feat(outdoor): add Open-Meteo trigger, dashboard deltas/overlays, and MCP outdoor tool`

#### Step 21: Firestore Read Optimization & Daily Rollups
- **Status**: `[x] Completed (Live-Verified & Backfilled)`
- **Goal**: Cut Firestore read volume by >99% on chart loads and MCP history/summary queries via UTC-day rollup documents (`daily_rollups`, `outdoor_daily_rollups`), server-side and browser-side TTL caches, and 0-read trigger writers.
- **Deliverables**: `firestore.indexes.json` (`fieldOverrides` for rollup `samples` maps), `functions/src/services/firestore/rollups.ts`, `functions/src/api/cache.ts`, `functions/src/scripts/backfillRollups.ts`, `functions/src/scripts/verifyRollups.ts`, `web/app.js` 5m chart cache & lazy fleet release loading, `docs/13-firestore-read-optimization-and-rollups.md`, and `docs/plans/2026-11-24-reduce-firestore-reads.md`.
- **Single Focused Validation**: Passed `verify:rollups`, `verify:api`, `verify_web_dashboard.mjs`, and `./scripts/check-secrets.sh`; deployed indexes/functions/hosting and ran `backfill:rollups -- --days 30`.

#### Step 22: Visual Showcase, EXIF-Stripped Media Pipeline & Google Flow Storyboard
- **Status**: `[x] Completed`
- **Goal**: Prepare privacy-scrubbed, EXIF/GPS-stripped hardware photos and dashboard/MCP screenshots and polish `README.md` with a 5-scene Google Flow (`Veo 3 / 3.1`) hype video storyboard.
- **Deliverables**: `scripts/prepare_media.sh`, `docs/images/*`, `docs/12-showcase-and-hype-video.md`, `README.md`, `docs/06-security-and-privacy-checklist.md` media privacy guidance, and `docs/plans/2026-11-24-hype-video-and-readme-showcase.md`.
- **Single Focused Validation**: Verified `< 600 KB` & zero EXIF/GPS metadata across `docs/images/`, passed `./scripts/check-secrets.sh`.

#### Step 23: Reliability, Security & Multi-Room Hardening (`v1.3.4`)
- **Status**: `[x] Completed (Deployed & Pushed)`
- **Goal**: Harden firmware `app.py`/`firestore_client.py` (`v1.3.4` HTTP timeouts, 30-bit `time.monotonic()` precision safety, SCD-40 CRC recovery), Open-Meteo `WriteBatch` atomicity, WorkOS/CORS/MCP error sanitization, Web Dashboard chart/auth resilience, and GitHub Actions CI.
- **Deliverables**: `firmware/app.py`, `firmware/firestore_client.py`, `scripts/test_firmware_local.py`, `.github/workflows/backend-ci.yml`, `functions/src/*`, `web/*`.
- **Single Focused Validation**: Passed `./scripts/check-secrets.sh`, `python3 scripts/test_firmware_local.py`, `node scripts/verify_web_dashboard.mjs`, and `npm --prefix functions test`; deployed functions & hosting (`02003bf`).

#### Step 24: Psychrometric Energy Tax & 24h Open-Meteo Free-Ventilation Forecast
- **Status**: `[x] Completed (Deployed & Pushed)`
- **Goal**: Quantify heating, cooling, and dehumidification energy tax using Magnus-Tetens dew point and ASHRAE moist-air enthalpy, cache Open-Meteo's 24h forecast in `outdoor_forecasts/home`, and surface `Next Best Window` recommendations across API, MCP, and the Web Dashboard.
- **Deliverables**: `functions/src/services/outdoor.ts`, `functions/src/api/routes/outdoor.ts`, `functions/src/mcp/tools.ts` (`get_ventilation_forecast`), `web/app.js` & `web/styles.css`, `functions/src/scripts/verifyOutdoor.ts` (Phase 1 of `docs/plans/2026-11-27-multi-room-energy-experiments.md`).
- **Single Focused Validation**: Passed `npm --prefix functions test`, `node scripts/verify_web_dashboard.mjs`, and `./scripts/check-secrets.sh`; deployed & pushed (`6cc2218`).

#### Step 25: Experiment Logger, Auto-Detected Events & House Physics Playbook
- **Status**: `[x] Completed (Steps 25.1–25.3 deployed & pushed earlier; Steps 25.4–25.6 deployed 2026-11-27 8:26 PM America/Detroit and committed on main as `c5a2dba`)`
- **Goal**: Log indoor ventilation/purifier interventions, passively detect sharp CO₂/PM₂.₅ step changes as `unlabeled` triage candidates, evaluate 15m pre-baseline vs. 20m post-settle outcomes (including cross-room spillover), and maintain a single-doc `house_playbook/summary` for AI & dashboard recommendations.
- **Completed Deliverables**:
  - **25.1 (`b0aedbd`):** `functions/src/services/experiments.ts`, `functions/src/services/firestore/db.ts`, `functions/src/scripts/verifyExperiments.ts`, `functions/package.json`.
  - **25.2 (`02003bf`):** `detectUnlabeledEventCandidate()`, `finalizeDuePendingExperiments()`, `processReadingForExperiments()`, and `syncOutdoorOnReading` wiring in `functions/src/index.ts`.
  - **25.3 (`27222e1`):** `functions/src/api/routes/experiments.ts`, strict Zod schemas in `functions/src/api/schemas.ts`, `PATCH` CORS in `functions/src/index.ts`, cache TTLs/invalidation in `functions/src/api/cache.ts`, and Check #14 in `functions/src/scripts/verifyApi.ts`.
  - **25.4:** `log_experiment`, `update_experiment`, `list_experiments`, and `get_house_playbook` in `functions/src/mcp/tools.ts`; `analyze_indoor_air` now calls `get_ventilation_forecast` and `get_house_playbook` (`functions/src/mcp/prompts.ts`); `functions/src/scripts/verifyMcp.ts`. Passed `npm --prefix functions run verify:mcp`.
  - **25.5:** Experiments tab in `web/index.html`, `web/app.js`, `web/api.js`, and `web/styles.css` — one-tap presets, active timer/stop, Log Past Action drawer, unlabeled-event triage, and the Learned House Playbook table. Passed `node scripts/verify_web_dashboard.mjs`. Live Hosting serves the tab.
  - **25.6:** `firebase deploy --only firestore:indexes,functions,hosting`. Offline gate passed (`npm --prefix functions test`, `node scripts/verify_web_dashboard.mjs`, `./scripts/check-secrets.sh`). Live dashboard and MCP smoke experiments evaluated into `house_playbook/summary`, then were dismissed so the playbook returned to 0 evaluated entries. Unauthenticated `/api/experiments`, `/api/playbook`, and the Cloud Run `/mcp` endpoint returned `401`.

#### Step 26: Mixed-Fleet Data Model, Security Rules & Auto-Detecting Firmware `v1.4.0` *(In Progress)*
- **Status**: `[ ] In Progress (Steps 26.1–26.2 done; firmware v1.4.0, null-safe web UI, and the Gate 3 functions/hosting deploy are not started)`
- **26.1:** `firestore.rules` accepts null PM/AQI/particle fields, exact sensor lists `["SCD-40"]` and `["SCD-40", "PMSA003I"]`, and an optional admin-written `floor` slug on `device_configs`. `scripts/verify_device_configs_rules.py --emulator` passed under `firebase emulators:exec`. `firebase deploy --only firestore:rules` compiled and released the file. The live `cloud.firestore` ruleset matches `firestore.rules` byte for byte, and the five live `device_configs` access checks still pass.
- **26.2:** Readings, device snapshots, and daily rollups keep null PM/AQI/particle values. `assessReadingHealth()` reports `unavailable` instead of Good. Summaries and indoor/outdoor deltas ignore unmeasured PM so a satellite cannot dilute the house average or look like `0 µg/m³`. `DeviceConfig.floor` and `updateDeviceConfigSchema` accept an optional slug. Not deployed.
- **Remaining**: firmware `v1.4.0`, null-safe web UI, and Validation Gate 3's functions/hosting deploy.

#### Steps 27–29: Whole-House `compare_rooms`, Provisioning CLI & Live Walkthrough
- **Status**: `[ ] Planned` — Tracked in detail in [docs/plans/2026-11-27-multi-room-energy-experiments.md](docs/plans/2026-11-27-multi-room-energy-experiments.md) (Phases 4–7).

Deferred future horizons (beyond the active multi-room plan):
- **Proactive Alerts**: Add a Firestore `onDocumentCreated` Cloud Function for push notifications (CO₂ > 1,200 ppm, PM₂.₅ > 35 µg/m³, or offline > 20 min) with cooldowns.
- **Smart-Home Actuation & Extra Sensors**: Optional webhook/Matter/Home Assistant trigger for a HEPA purifier smart plug on PM₂.₅ spikes, and a future STEMMA QT `SGP41` (VOC + NOₓ) breakout for cooking fumes and off-gassing.
