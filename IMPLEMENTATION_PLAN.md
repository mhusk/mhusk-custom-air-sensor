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
   - Once validation passes and the docs reflect what we learned, update the checkbox (`[x]`) in this file and make a dedicated git commit for the step.

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
- [x] **Enclosure Plan**: Screwless 3D-Printed Enclosure Design & SpeakCAD Spec (`docs/08-enclosure-hardware-plan.md`) — *currently printing on Bambu Lab X1 Carbon*

### Phase 2: Enclosure Commissioning, Lightweight Web Dashboard & Remote Config *(Layer 1 — In Progress)*
- [x] **Step 12**: `device_configs` Firestore Schema, Rules & Calibration Docs *(cloud schema, `firestore.rules`, seed doc & 5-point rules validation complete; physical enclosure thermal/acoustic measurements in `docs/08-enclosure-hardware-plan.md` Section 8 pending finished print)*
- [x] **Step 13**: Firmware Remote Configuration Polling (`device_configs/{device_id}`) *(v1.1.0 implemented & verified via offline + live Mac tests; ready to copy `code.py` + `firestore_client.py` to `CIRCUITPY`)*
- [ ] **Step 14**: Dashboard Backend API & WorkOS Auth Integration
- [ ] **Step 15**: Lightweight Web Dashboard on Firebase Hosting (Live Charts + Device Settings Drawer)

### Phase 3: Cloud Pull-Based OTA Firmware Updates with A/B Rollback *(Layer 2)*
- [ ] **Step 16**: Safe Bootloader Split (`boot.py` USB-Aware Mount + Minimal `code.py` → `app.py` with Auto-Rollback)
- [ ] **Step 17**: Release Manifest Schema, SHA-256 Artifact Hosting & Publish CLI
- [ ] **Step 18**: On-Device Pull-Based OTA Updater (Download, Verify, Atomic Swap & Health Check)
- [ ] **Step 19**: Fleet & Firmware Rollout Panel in Web Dashboard

### Phase 4: Future Horizons *(Multi-Room Fleet & Proactive Intelligence — Backlog)*
- [ ] **Multi-Room Sensor Network**: Per-device UID-to-`device_id` isolation in `firestore.rules`, `compare_rooms` MCP tool, optional CO₂-only (`SCD-40`) satellite nodes, and additional 3D-printed enclosures
- [ ] **Proactive Alerts & Outdoor AQI Context**: Firestore `onDocumentCreated` push alerts with cooldowns (CO₂ / PM₂.₅ / stale sensor) and an outdoor AQI + weather MCP tool for "should I open the window?" advice
- [ ] **Optional Smart-Home Actuation & VOC/NOₓ Expansion**: Triggering a HEPA air purifier smart plug on PM₂.₅ spikes and adding a Sensirion `SGP41` VOC/NOₓ breakout on STEMMA QT

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
- **Status**: `[x] Cloud Schema, Rules & Docs Complete (Physical Enclosure Measurements Pending Print)`
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
- **Status**: `[ ] Pending`
- **Goal**: Add lightweight authenticated JSON API routes to Firebase Cloud Functions—reusing the existing WorkOS AuthKit OAuth + strict owner allowlist—for fetching live room snapshots, 24h/7d time-series data, device health, and updating `device_configs/{device_id}`.
- **Deliverables**:
  - `functions/src/api/dashboard.ts` (typed REST endpoints backed by `functions/src/services/firestore.ts` plus `updateDeviceConfig` with strict Zod validation)
  - `functions/src/index.ts` (route wiring + WorkOS session/token verification)
  - Verification script (`npm --prefix functions run verify:api`) testing auth rejection (`401`/`403`) and valid config updates
  - `docs/09-remote-config-and-dashboard.md` (Part 3: Securing a personal IoT dashboard API with WorkOS AuthKit)
- **Single Focused Validation**:
  - Run `npm --prefix functions run verify:api` and confirm unauthenticated requests fail with `401`, non-allowlisted users get `403`, and an authorized request reads telemetry and updates `device_configs/{device_id}` cleanly.
- **Target Commit**: `feat(functions): add WorkOS-protected dashboard and remote config API`

#### Step 15: Lightweight Web Dashboard on Firebase Hosting
- **Status**: `[ ] Pending`
- **Goal**: Build and deploy a super-lightweight, responsive web dashboard on Firebase Hosting so you can view live readings, inspect 24h/7d CO₂/PM₂.₅/Temp/Humidity charts at a glance, and tweak any sensor's Layer 1 settings from a clean Device Settings drawer.
- **Deliverables**:
  - `web/` (minimal frontend app with WorkOS login, live room cards, interactive 24h/7d trend charts, and Device Settings form)
  - `firebase.json` (Firebase Hosting configuration + rewrite rules to Cloud Functions API)
  - `docs/09-remote-config-and-dashboard.md` (Part 4: Deploying the dashboard and managing sensor settings from the browser)
- **Single Focused Validation**:
  - Sign in via WorkOS on the deployed Firebase Hosting URL, confirm live charts match Firestore readings, update a setting (e.g., `led_enabled` or `reporting_interval_seconds`) in the Device Settings drawer, and observe the physical sensor pick it up on its next check-in.
- **Target Commit**: `feat(web): add lightweight Firebase Hosting dashboard with remote device config`

---

### Phase 3: Cloud Pull-Based OTA Firmware Updates with A/B Rollback (Layer 2)

> **Why Pull-Based A/B OTA?**
> Updating CircuitPython `.py` files over the air lets you evolve firmware across every room without unscrewing enclosures or touching USB—while keeping a tiny, immutable `code.py` bootloader guarantees that a bad push with a syntax or runtime error automatically rolls back to the last known-good version instead of bricking the board.

#### Step 16: Safe Bootloader Split (`boot.py` + Immutable `code.py` → `app.py`)
- **Status**: `[ ] Pending`
- **Goal**: Refactor the firmware into a USB-aware `boot.py` and a minimal, rock-solid `code.py` bootloader that imports and runs `app.py`, automatically rolling back to `app.py.bak` if a newly deployed `app.py` crashes on boot or fails to record a healthy check-in.
- **Deliverables**:
  - `firmware/boot.py` (checks `supervisor.runtime.usb_connected`: mounts flash read-write for Python OTA when on wall power, while preserving normal `CIRCUITPY` USB drive access when plugged into a Mac)
  - `firmware/code.py` (minimal ~50-line immutable bootloader with boot-attempt counter & automatic `app.py.bak` rollback)
  - `firmware/app.py` (existing sensor polling + remote config logic moved out of `code.py`)
  - `docs/10-cloud-ota-and-rollback.md` (Part 1: How CircuitPython flash locking and A/B rollback bootloaders work)
- **Single Focused Validation**:
  - Intentionally place a broken `app.py` (raising an exception on boot) alongside a valid `app.py.bak` on wall power, confirm `code.py` detects the crash, restores `app.py.bak`, reboots, and resumes publishing to Firestore without USB intervention.
- **Target Commit**: `feat(firmware): split USB-aware boot.py and auto-rollback code.py bootloader`

#### Step 17: Release Manifest Schema, SHA-256 Artifact Hosting & Publish CLI
- **Status**: `[ ] Pending`
- **Goal**: Define the cloud OTA release pipeline: store versioned Python payloads (`app.py`, `aqi.py`, `firestore_client.py`) with SHA-256 checksums in Firebase Storage / Cloud Functions and publish release metadata to `firmware_releases/{version}` in Firestore.
- **Deliverables**:
  - Firestore schema & security rules for `firmware_releases/{version}` (read-only for authenticated sensors) and `target_firmware_version` in `device_configs/{device_id}`
  - `scripts/publish_release.py` (or npm script) that hashes firmware files with SHA-256, uploads artifacts, and writes the signed/checksummed release manifest
  - `docs/10-cloud-ota-and-rollback.md` (Part 2: Checksummed release manifests and safe artifact staging)
- **Single Focused Validation**:
  - Publish a test release (e.g., `1.1.0-rc1`) via the publish script, verify the manifest and SHA-256 hashes appear in Firestore, and confirm the sensor auth account can fetch the manifest and artifact while unauthenticated requests are rejected.
- **Target Commit**: `feat(ota): add checksummed firmware release manifest and publish script`

#### Step 18: On-Device Pull-Based OTA Updater
- **Status**: `[ ] Pending`
- **Goal**: Implement the pull-based OTA client on the ESP32-S3: compare current `FIRMWARE_VERSION` against `target_firmware_version`, download new `.py` files to `.new` staging paths, verify SHA-256 hashes on-device before touching live files, back up existing files to `.bak`, atomically swap, reboot, and confirm healthy check-in.
- **Deliverables**:
  - `firmware/ota_updater.py` (staging downloads, SHA-256 verification, atomic backup/rename, and `ota_status` reporting to `devices/{device_id}`)
  - `firmware/app.py` (periodic OTA check hook + health confirmation clearing the "pending verification" flag after first successful Firestore publish)
  - Local offline unit tests for hash mismatch rejection and staging swap logic
  - `docs/10-cloud-ota-and-rollback.md` (Part 3: End-to-end OTA verification, watchdog safety, and recovery)
- **Single Focused Validation**:
  - Bump `FIRMWARE_VERSION` (e.g., `1.0.0` → `1.1.0`), publish the release, set `target_firmware_version` in Firestore while the Feather is on wall power only, and watch it download, verify SHA-256, reboot, and report `1.1.0` in Firestore—plus test that a deliberately corrupted hash is safely rejected without rebooting.
- **Target Commit**: `feat(firmware): add SHA-256 verified pull-based OTA updater`

#### Step 19: Fleet & Firmware Rollout Panel in Web Dashboard
- **Status**: `[ ] Pending`
- **Goal**: Add a clean **Fleet & Firmware** tab to the lightweight web dashboard showing every sensor's current vs. target `firmware_version`, online/stale status, last OTA result (`up_to_date`, `updating`, `rolled_back`), and one-click version promotion per device or across all rooms.
- **Deliverables**:
  - Dashboard API endpoints to list `firmware_releases` and trigger per-device or fleet-wide `target_firmware_version` rollouts
  - `web/` Fleet & Firmware UI panel with version badges, rollout status, and rollback warning indicators
  - `docs/10-cloud-ota-and-rollback.md` (Part 4: Managing staged rollouts from the web dashboard)
- **Single Focused Validation**:
  - From the live web dashboard (with the sensor sealed in its 3D-printed enclosure on wall power), trigger a firmware version promotion and watch the dashboard transition from `updating` → `up_to_date` with the new `firmware_version` live.
- **Target Commit**: `feat(web): add fleet firmware status and one-click OTA rollout UI`

---

### Phase 4: Future Horizons *(Multi-Room Fleet & Proactive Intelligence — Backlog)*

Planned enhancements once Phases 2 and 3 are live (will be broken into atomic steps when ready):
- **Multi-Room Sensor Network**: Print additional enclosures for bedroom / office / kitchen, tighten `authorized_devices/{uid}` in `firestore.rules` to bind each Auth UID to a specific `device_id`, add a `compare_rooms` MCP tool, and support lower-cost `SCD-40`-only satellite nodes.
- **Proactive Alerts & Outdoor AQI Context**: Add a Firestore `onDocumentCreated` Cloud Function for push notifications (CO₂ > 1,200 ppm, PM₂.₅ > 35 µg/m³, or offline > 20 min) with cooldowns, plus an outdoor AQI + weather MCP tool (Open-Meteo / AirNow) so AI assistants know whether opening a window will actually help.
- **Smart-Home Actuation & Extra Sensors**: Optional webhook/Matter/Home Assistant trigger for a HEPA purifier smart plug on PM₂.₅ spikes, and a future STEMMA QT `SGP41` (VOC + NOₓ) breakout for cooking fumes and off-gassing.
