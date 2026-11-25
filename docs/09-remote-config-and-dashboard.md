# Guide 09: Remote Configuration & Lightweight Web Dashboard

> **Built in Steps 12–15 of [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md)** — Introduces Layer 1 remote device management (`device_configs/{device_id}`), live firmware config polling, a WorkOS-protected Dashboard API, and a lightweight Firebase Hosting web UI so you can calibrate and tune enclosed sensors without plugging in USB.

---

## 1. Part 1: Control-Plane Data Model & Security Rules (Step 12)

### Why Separate Desired State (`device_configs`) from Reported State (`devices`)?

In IoT systems, putting desired settings and live telemetry in the same document creates race conditions and weakens security boundaries (the device would need write access to its own config). Splitting them into two collections follows the classic **Device Shadow** pattern:

```mermaid
flowchart LR
    UI["Web Dashboard / Console<br/>(WorkOS Owner Allowlist)"] -->|"Admin SDK Write<br/>(config_version++)"| CFG[("device_configs/{device_id}<br/>Desired State")]
    CFG -->|"1. Sensor GET (read-only)<br/>No list, no write"| ESP["ESP32-S3 Sensor<br/>(CircuitPython)"]
    ESP -->|"2. Apply in RAM &<br/>report config_version"| DEV[("devices/{device_id}<br/>Reported State + Latest")]
    DEV -->|"Compare desired vs.<br/>reported config_version"| UI
```

1. **`device_configs/{device_id}` (Desired State — Control Plane):**
   - Written **only** by the Firebase Console or our WorkOS-authenticated Cloud Function (Admin SDK).
   - Allowlisted sensors have **`get`-only** access (`allow get: if isSensorDevice() && isDeviceId(deviceId);`), with `allow list: if false;` and `allow write: if false;`. A sensor can fetch its own config by exact document ID, cannot enumerate other devices, and cannot tamper with or delete configs.
2. **`devices/{device_id}` (Reported State — Telemetry Plane):**
   - Written by the sensor on every publish cycle.
   - Reports back the active `config_version`, `temperature_offset_c`, `altitude_m`, and `led_enabled` alongside `latest_reading`.
   - The dashboard compares `device_configs.config_version` against `devices.config_version` to display **Synced (`v3`)** vs. **Pending sync...** automatically.

---

### `device_configs/{device_id}` Schema Reference

| Field | Firestore Type | Allowed Range / Format | Default | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `device_id` | `string` | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` | `"feather-s3-01"` | Matches the document ID |
| `location` | `string` | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` | `"master-bedroom"` | Room label written to future `readings` and `devices` docs |
| `reporting_interval_seconds` | `integer` | `60` – `3600` | `300` | Seconds between Firestore publishes |
| `temperature_offset_c` | `double` | `0.0` – `20.0` | `4.0` | Sensirion SCD-40 hardware temperature offset (°C) |
| `altitude_m` | `integer` | `0` – `5000` | `0` | Site elevation in meters for SCD-40 CO₂ pressure compensation |
| `led_enabled` | `boolean` | `true` / `false` | `true` | Enables or mutes the Feather's onboard NeoPixel pulse |
| `config_version` | `integer` | `1` – `1000000` | `1` | Monotonically incremented on every change for sync tracking |
| `reboot_requested_at` | `timestamp \| null` | RFC 3339 timestamp or `null` | `null` | One-shot remote reboot trigger (see design note below) |
| `updated_at` | `timestamp` | RFC 3339 timestamp | — | Last modification timestamp |
| `updated_by` | `string` | Email or `"initial-seed"` | — | Audit label identifying who changed the config |

#### Why `reboot_requested_at` Uses a Timestamp Instead of a Boolean
Because the sensor has **read-only** access to `device_configs/{device_id}`, it cannot reset a `reboot: true` boolean back to `false`—doing so would cause an infinite reboot loop! Instead:
- On startup, the firmware syncs UTC time via NTP and records `boot_time_utc` in RAM.
- Clicking **Reboot** in the dashboard sets `reboot_requested_at = now()` on `device_configs/{device_id}`.
- On its next poll, if `reboot_requested_at > boot_time_utc` (and within a recent window), the board calls `microcontroller.reset()`.
- After rebooting, the board's new `boot_time_utc` is strictly newer than `reboot_requested_at`, so it will **never** reboot twice—with **zero flash writes** and **read-only** permissions.

---

### Backward-Compatible `devices/{device_id}` Reported Config Fields

To keep existing `v1.0.0` firmware running uninterrupted while rolling out Step 13 firmware, [`firestore.rules`](../firestore.rules) keeps the original 7 fields required in `hasAll(...)` and allows 4 **optional** config-echo fields in `hasOnly(...)`:

| Optional Field on `devices/{device_id}` | Rule | Meaning |
| :--- | :--- | :--- |
| `config_version` | `int`, `0`–`1000000` | `0` = local `settings.toml` fallback; `>= 1` = applied cloud `config_version` |
| `temperature_offset_c` | `number`, `0`–`20` | Active SCD-40 hardware offset currently loaded on the sensor |
| `altitude_m` | `number`, `0`–`5000` | Active SCD-40 altitude compensation in meters |
| `led_enabled` | `bool` | Whether NeoPixel publish pulses are currently enabled |

---

### How SCD-40 Thermal & Altitude Calibration Works

1. **Temperature Offset (`temperature_offset_c`):**
   - The Sensirion SCD-40's photoacoustic emitter and surrounding PCB components warm the sensor slightly above true room air. Its factory default offset is **`4.0 °C`** (which Sensirion subtracts internally from raw temperature **and** uses to automatically re-compensate relative humidity `%RH`—far more accurate than subtracting a number in software after the fact).
   - Once your boards are snapped inside the 3D-printed enclosure ([Guide 08](./08-enclosure-hardware-plan.md)), let the unit stabilize for **60 minutes**, compare against a trusted room thermometer, and compute:
     `new_offset_c = current_offset_c + (sensor_temp_c - reference_temp_c)`
   - Because `temperature_offset_c` is applied in RAM on the SCD-40 (`scd4x.temperature_offset = ...`) without calling `persist_settings()`, there is **zero EEPROM wear**—you can iterate as many times as you want from the dashboard!
2. **Altitude Compensation (`altitude_m`):**
   - Photoacoustic CO₂ sensing depends on ambient air density. Setting `altitude_m` to your city's elevation above sea level (e.g., `150` m, or `1609` m for Denver) corrects systematic CO₂ under-reading at higher elevations.

---

### Deploying & Running the Step 12 Focused Validation

1. **Deploy the updated rules:**
   ```bash
   npx -y firebase-tools@latest deploy --only firestore:rules
   ```
   Confirm `rules file firestore.rules compiled successfully` with zero warnings.
2. **Seed `device_configs/<device_id>`** (via Firebase Console or Admin SDK) with the fields from the schema table above (`config_version: 1`).
3. **Run the automated 5-point rules verification script:**
   ```bash
   python3 scripts/verify_device_configs_rules.py
   ```
   **Expected output:**
   - Unauthenticated `GET device_configs/<id>` → `403 PERMISSION_DENIED`
   - Sensor-authenticated `GET device_configs/<id>` → `200 OK`
   - Sensor-authenticated `LIST device_configs` → `403 PERMISSION_DENIED`
   - Sensor-authenticated `PATCH device_configs/<id>` → `403 PERMISSION_DENIED`
   - Sensor-authenticated `DELETE device_configs/<id>` → `403 PERMISSION_DENIED`

---

### Good to Know & Real-World Troubleshooting (Part 1)

> [!TIP]
> **Use `allow get` instead of `allow read` on `device_configs/{deviceId}`.**
> In Firestore Security Rules, `read` is shorthand for both `get` (single document by ID) and `list` (collection queries). Separating them into `allow get` + `allow list: if false;` lets a sensor pull its own config while blocking anyone with a device credential from listing every room/device in the collection.

> [!NOTE]
> **macOS built-in `python3` is often Python 3.9 (no `tomllib`).**
> Standard-library `tomllib` arrived in Python 3.11. Both [`scripts/test_firmware_local.py`](../scripts/test_firmware_local.py) and [`scripts/verify_device_configs_rules.py`](../scripts/verify_device_configs_rules.py) include a lightweight fallback TOML parser so they work out of the box with macOS's default `/usr/bin/python3` and require zero `pip install` steps.

> [!IMPORTANT]
> **Backward compatibility during phased rollouts.**
> Because `devices/{device_id}` uses `hasOnly(...)` in `firestore.rules`, adding any new telemetry field in firmware *before* updating the rules will cause `403 PERMISSION_DENIED` on every publish. Always deploy optional fields in `firestore.rules` first (Step 12), verify live `v1.0.0` devices keep publishing cleanly, and *then* update firmware (Step 13).

---

## 2. Part 2: Firmware Remote Configuration Polling (Step 13)

With `device_configs/{device_id}` locked down in Firestore, firmware `v1.1.0` teaches the ESP32-S3 to check its cloud mailbox once per publishing cycle—**before** sampling the sensors—so updated calibration or room names apply immediately on the very next reading.

### How the On-Device Control Loop Applies Config Safely

1. **Fetch & Decode (`firmware/firestore_client.py`):**
   - `FirestoreClient.fetch_device_config(device_id)` sends an authenticated `GET` to `device_configs/{device_id}` and decodes Firestore REST typed values (`stringValue`, `integerValue`, `doubleValue`, `booleanValue`, `timestampValue`, `nullValue`) into a plain Python dictionary.
   - If the document does not exist yet (**HTTP 404**), it returns `None` cleanly instead of raising an error.
   - If a transient Wi-Fi/TLS hiccup happens during the config fetch, `firmware/code.py` logs `[Config WARN]` and **keeps the last known-good config** so telemetry publishing is never interrupted.
2. **Validate & Clamp (`normalize_device_config`):**
   - Every field is type-checked and clamped to the exact same bounds enforced by `firestore.rules` (`reporting_interval_seconds`: `60–3600`, `temperature_offset_c`: `0.0–20.0`, `altitude_m`: `0–5000`, `location`: safe slug regex, `led_enabled`: strict `bool`).
   - A bad or unexpected value in Firestore can never crash the sensor or cause rejected publishes.
3. **One-Shot Remote Reboot (`should_trigger_reboot`):**
   - On the very first NTP sync after startup, the board records `boot_epoch` in RAM using pure-Python UTC calendar math (`parse_utc_timestamp_epoch`).
   - If `reboot_requested_at` is strictly **newer** than `boot_epoch` (and within 30 minutes of current UTC time), the board turns off its NeoPixel and calls `microcontroller.reset()`. After rebooting, the new `boot_epoch` is newer than `reboot_requested_at`, preventing infinite reboot loops with zero flash writes.
4. **SCD-40 RAM Calibration Without EEPROM Wear (`apply_scd40_calibration`):**
   - Per the Sensirion SCD-4x datasheet, `temperature_offset` and `altitude` can only be written while periodic measurement is stopped.
   - `firmware/code.py` tracks the currently applied offset/altitude in RAM and **only** pauses periodic measurement (`stop_periodic_measurement()` → `500 ms` → set registers → `start_periodic_measurement()`) on startup or when a value actually changes.
   - It intentionally **never** calls `scd4x.persist_settings()`, avoiding EEPROM write wear (unlimited RAM updates).
5. **Muteable Bedroom NeoPixel (`StatusLED.set_enabled`):**
   - When `led_enabled` is `false`, `StatusLED` keeps the onboard NeoPixel completely dark across publish pulses and error blinks—ideal for a pitch-black bedroom nightstand.
6. **Config Sync Echo (`devices/{device_id}`):**
   - Every publish reports `config_version`, `temperature_offset_c`, `altitude_m`, and `led_enabled` in `devices/{device_id}` so the dashboard (Steps 14–15) can confirm the physical sensor is in sync.

---

### Updating Your ESP32-S3 (`CIRCUITPY`) to Firmware `v1.1.0`

When you are ready to load `v1.1.0` onto the Feather (you only need to copy the two updated Python files—your `settings.toml` and `lib/` folder stay untouched):

```bash
cp firmware/firestore_client.py /Volumes/CIRCUITPY/firestore_client.py
cp firmware/code.py /Volumes/CIRCUITPY/code.py
sync
```

Watch the serial console (`screen /dev/cu.usbmodem* 115200`) on boot and confirm:
- `[Config] Active (cloud v1): location=master-bedroom, interval=300s, temp_offset=4.00C, altitude=0m, led=True`
- `[SCD-40] Applied RAM calibration: temperature_offset=4.00C, altitude=0m`
- `[OK ...] cfg=v1 | CO2=...`

---

### Single Focused Validation Checkpoint (Part 2)

1. **Mac Offline + Live Config Fetch Check (no hardware required):**
   ```bash
   python3 scripts/test_firmware_local.py --fetch-config
   ```
   Verifies EPA AQI math, v1.1 `devices` payload encoding, Firestore value decoding, out-of-range clamping, leap-year UTC epoch parsing, reboot loop prevention, `code.py` syntax compilation, live `GET device_configs/<id>`, and graceful `404` fallback.
2. **On-Device Live Config Test (once `v1.1.0` is copied to `CIRCUITPY`):**
   - Temporarily change `reporting_interval_seconds` from `300` → `60` (and bump `config_version` to `2`) in Firestore.
   - Watch the next reading arrive and verify `devices/feather-s3-01` updates to `firmware_version: "1.1.0"`, `config_version: 2`, and `reporting_interval_seconds: 60` without rebooting or touching USB—then change it back to `300`.

---

### Good to Know & Real-World Troubleshooting (Part 2)

> [!TIP]
> **Why `parse_utc_timestamp_epoch` uses pure Gregorian math instead of `time.mktime()`.**
> On macOS CPython, `time.mktime()` interprets a time tuple in your **local timezone** (e.g., EST/EDT, 4–5 hours off UTC), whereas CircuitPython's `time.mktime()` treats the same tuple as **UTC**. Using pure-Python calendar arithmetic (`_days_from_civil`) guarantees identical Unix epoch seconds on both Mac unit tests and the ESP32-S3 with zero `datetime` dependency.

> [!NOTE]
> **Remember `isinstance(True, int)` is `True` in Python!**
> In `normalize_device_config()`, numeric checks explicitly guard `not isinstance(val, bool)` so an accidental boolean in an integer field (`config_version`, `reporting_interval_seconds`, `altitude_m`) is cleanly rejected instead of silently turning into `1` or `0`.

---

## 3. Part 3: Dashboard Backend API & WorkOS Auth Integration (Step 14)

Instead of standing up a separate server, the lightweight Dashboard REST API lives inside the same **2nd Gen Firebase Cloud Function** (`functions/src/index.ts`) that already serves your Remote MCP Server—reusing your existing Google Cloud Secret Manager bindings (`WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_AUTHKIT_DOMAIN`, `ALLOWED_USER_EMAILS`, `MCP_BEARER_FALLBACK_SECRET`) with zero new secrets required.

### API Endpoint Map ([`functions/src/api/dashboard.ts`](../functions/src/api/dashboard.ts) & [`functions/src/api/routes/`](../functions/src/api/routes/))

Route handlers are grouped by domain under `functions/src/api/routes/` (`auth.ts`, `telemetry.ts`, `outdoor.ts`, `firmware.ts`, `devices.ts`) with shared Zod schemas in `schemas.ts` and JSON/validation helpers in `http.ts`. Standard `GET /api/readings/history` chart loads use `getReadingsHistoryWithSummary()` to compute both downsampled points and summary stats from a **single** Firestore `readings` query.

| Method & Route | Auth Required? | Purpose |
| :--- | :--- | :--- |
| `GET /api/auth/config` | Public (non-secret) | Returns `{ oauth_configured, authkit_domain, client_id, authorize_endpoint }` so the browser UI can start WorkOS AuthKit PKCE login. |
| `POST /api/auth/exchange` | Public PKCE + **Owner Allowlist** | Exchanges an AuthKit authorization `code` (+ `code_verifier`) via `workos.userManagement.authenticateWithCode`, rejects non-allowlisted or unverified users with `403`, and returns `{ access_token, refresh_token, user }`. |
| `POST /api/auth/refresh` | Public Refresh + **Owner Allowlist** | Refreshes an AuthKit browser session via `authenticateWithRefreshToken` and re-verifies `ALLOWED_USER_EMAILS`. |
| `GET /api/me` | **Yes (`401`/`403`)** | Returns the verified owner identity (`user_id`, `email`, `auth_method`). |
| `GET /api/dashboard/overview` | **Yes (`401`/`403`)** | Returns every device's live status, latest reading, qualitative `health_context`, desired `device_configs/{device_id}`, and `config_sync_status` (`"synced"`, `"pending"`, or `"local_defaults"`). |
| `GET /api/readings/history` | **Yes (`401`/`403`)** | Accepts `hours` (`1`–`168`), `limit` (`1`–`500`), `period` (`1h`/`6h`/`24h`/`7d`/`30d`), `device_id`, and `location`; returns chronological readings plus min/max/avg/p95 stats and notable spikes for 24h/7d charts. |
| `GET /api/devices/:deviceId/config` | **Yes (`401`/`403`)** | Fetches both the desired `device_configs/{deviceId}` doc and the device's reported config state. |
| `PUT /api/devices/:deviceId/config` | **Yes (`401`/`403`)** | Validates `{ location, reporting_interval_seconds, temperature_offset_c, altitude_m, led_enabled }` with strict **Zod** rules, atomically increments `config_version` in a Firestore transaction, and stamps `updated_at` / `updated_by`. |
| `POST /api/devices/:deviceId/reboot` | **Yes (`401`/`403`)** | Atomically stamps `reboot_requested_at = now` and increments `config_version` (preserving all other settings) to trigger a safe one-shot remote reboot. |

### How Browser Auth Works Without Exposing Secrets

```mermaid
sequenceDiagram
    participant WEB as Web Dashboard (Firebase Hosting)
    participant API as Cloud Function (/api/*)
    participant WOS as WorkOS AuthKit
    participant FS as Cloud Firestore (Admin SDK)

    WEB->>API: GET /api/auth/config
    API-->>WEB: { client_id, authkit_domain, authorize_endpoint }
    WEB->>WOS: Redirect with PKCE code_challenge (S256)
    WOS-->>WEB: Redirect back with ?code=...
    WEB->>API: POST /api/auth/exchange { code, code_verifier }
    API->>WOS: authenticateWithCode (using server-side WORKOS_API_KEY)
    API->>API: Verify emailVerified + ALLOWED_USER_EMAILS (403 if stranger)
    API-->>WEB: { access_token, refresh_token, user }
    WEB->>API: PUT /api/devices/feather-s3-01/config (Authorization: Bearer <access_token>)
    API->>WOS: Verify JWT signature & claims + owner allowlist
    API->>FS: Transactionally update device_configs (config_version++)
    API-->>WEB: 200 OK { updated: true, config: { config_version: 4, ... } }
```

### Single Focused Validation Checkpoint (Part 3)

1. **Automated Offline API & Auth Verification Suite:**
   ```bash
   npm --prefix functions run verify:api
   npm --prefix functions run verify:auth
   ```
   Confirms `200`/`400`/`401`/`403` enforcement across WorkOS AuthKit code exchange, refresh, Connect JWTs, UserManagement session tokens, Bearer fallback, strict Zod payload validation, transactional `config_version` increments, sync-status transitions (`synced` → `pending`), and one-shot reboot stamping.
2. **Deploy & Live Smoke Check:**
   ```bash
   npx -y firebase-tools@latest deploy --only functions
   ```
   Verify `GET <function-url>/api/auth/config` returns `200 OK` (with zero secrets) and unauthenticated `GET <function-url>/api/dashboard/overview` returns `401 Unauthorized`.

### Good to Know & Real-World Troubleshooting (Part 3)

> [!IMPORTANT]
> **WorkOS Connect MCP tokens vs. WorkOS UserManagement browser tokens have different issuers/JWKS.**
> MCP clients receive WorkOS Connect OAuth 2.1 tokens (`iss: https://<subdomain>.authkit.app`, verified against `${authkitDomain}/oauth2/jwks`). Browser dashboards using `authenticateWithCode()` receive WorkOS UserManagement session access tokens (carrying `sid` + `auth_time`, verified via `workos.userManagement.verifyAccessToken()`). Supporting both paths inside [`functions/src/auth/workos.ts`](../functions/src/auth/workos.ts) while enforcing the exact same fail-closed `ALLOWED_USER_EMAILS` check keeps AI assistants and the web dashboard seamlessly protected under one WorkOS setup.

> [!TIP]
> **CORS Restrictions for `/api/*` vs. Open CORS for `/mcp`.**
> [`functions/src/index.ts`](../functions/src/index.ts) keeps open CORS on `/mcp` and `/.well-known/*` for remote AI assistants and MCP Inspector (allowing `GET, POST, PUT, DELETE, OPTIONS`), while restricting `/api/*` `Access-Control-Allow-Origin` to the server's own public origin, `localhost`/`127.0.0.1` dev origins, and any extra comma-separated origins configured via the optional `ALLOWED_DASHBOARD_ORIGINS` environment variable.

---

## 4. Part 4: Lightweight Web Dashboard on Firebase Hosting (Step 15)

The browser dashboard lives in [`web/`](../web/) as a **zero-build, dependency-free** static app (vanilla HTML, modern light/dark CSS, ES Modules, and custom interactive SVG charts) deployed to **Firebase Hosting**. Hosting rewrites `/api/**` directly to our existing 2nd Gen Cloud Function (`mcp` in `us-east1`), so every browser request stays same-origin with strict Content Security Policy (CSP) headers and zero secrets embedded in frontend code.

### Frontend File Map (`web/`)

| File | Responsibility |
| :--- | :--- |
| [`web/index.html`](../web/index.html) | Semantic page shell, WorkOS sign-in view, live sensor cards, 6h/24h/7d trend section, slide-over `<dialog>` Device Settings drawer, and Reboot confirmation modal. |
| [`web/styles.css`](../web/styles.css) | Automatic system light/dark mode (`color-scheme: light dark` + `light-dark()`), responsive card/chart grids, post-interaction `:user-invalid` validation styles, native `<input switch>` styling, and top-layer `<dialog>` animations. |
| [`web/auth.js`](../web/auth.js) | Web Crypto PKCE (`S256`) generator, CSRF `state` verification, `/auth/callback` handler, single-flight refresh token rotation, and optional Bearer fallback sign-in. |
| [`web/api.js`](../web/api.js) | Authenticated `/api/*` client with automatic single-retry refresh on `401` and typed error parsing. |
| [`web/charts.js`](../web/charts.js) | Pure SVG time-series charts for **CO₂ (ppm)**, **PM₂.₅ (µg/m³)**, **Temperature (°F)**, and **Humidity (% RH)** with hover crosshairs, EPA/ASHRAE threshold lines, offline-gap splitting, and Min/Avg/P95/Max stats. |
| [`web/app.js`](../web/app.js) | UI controller wiring manual refresh, live room cards, chart time-window switching, Device Settings drawer saves (`PUT /api/devices/:id/config`), and confirmed one-shot reboots (`POST /api/devices/:id/reboot`). |

### One-Time WorkOS Redirect URI Setup

Before signing in from the deployed Firebase Hosting site, register the callback URL in the **WorkOS Dashboard** (making sure the environment selector at the top matches the environment—e.g. **Staging**—whose `WORKOS_CLIENT_ID` is stored in Google Cloud Secret Manager):

1. In the left sidebar, open **Applications → `<your application>` → Redirects tab** *(or press `⌘K` / Search for `redirect` and click `<your application> > Redirect URIs` at the very top—**not** the `Admin Portal` redirect results underneath)*.
2. Click the **edit pencil icon** on the first row (**Redirect URIs**) and add your Firebase Hosting callback URL:
   - `https://<your-firebase-project-id>.web.app/auth/callback`
   - *(Optional)* `https://<your-firebase-project-id>.firebaseapp.com/auth/callback`
   - *(Optional for local emulator testing)* `http://localhost:5000/auth/callback`
3. Click **Save** and leave the remaining rows (`Initiate login URI`, `Sign-out URIs`, `Sign-up URL`, `User invitation URL`, `Password reset URL`) as **Not set**.
4. No secrets need to be added to `web/`—the dashboard discovers `client_id` and `authorize_endpoint` at runtime from `GET /api/auth/config`.

### Deploying to Firebase Hosting

Deploy only the static Hosting site and its rewrite rules:

```bash
npx -y firebase-tools@latest deploy --only hosting
```

Your live dashboard is immediately available at `https://<your-firebase-project-id>.web.app`.

### Single Focused Validation Checkpoint (Part 4)

1. **Offline Module, Hosting Config & Secret Hygiene Check:**
   ```bash
   node scripts/verify_web_dashboard.mjs
   ./scripts/check-secrets.sh
   ```
   Verifies RFC 7636 PKCE `S256` challenge math, WorkOS authorize URL parameters, chart geometry/gap-splitting/nearest-point search, semantic HTML checks, `firebase.json` 2nd Gen rewrites, and zero leaked credentials.
2. **Live Hosting & End-to-End Remote Config Check:**
   - Open `https://<your-firebase-project-id>.web.app` and verify `GET /api/auth/config` responds `200 OK` via the Hosting rewrite.
   - Click **Sign in with WorkOS**, complete AuthKit login, and confirm live room cards (°F) and 6h/24h/7d interactive SVG charts match Firestore.
   - Open **Device Settings**, toggle **Onboard NeoPixel LED** (or adjust **Reporting Interval**), and click **Save Settings**. Confirm the badge transitions to **Pending sync**, then click **Refresh** after the ESP32-S3's next check-in to see it turn **Config vN synced** as the physical sensor applies the setting.

### Good to Know & Real-World Troubleshooting (Part 4)

> [!IMPORTANT]
> **2nd Gen Cloud Function Hosting rewrites in non-`us-central1` regions MUST specify `region`.**
> In [`firebase.json`](../firebase.json), writing `"function": "mcp"` defaults Firebase Hosting to `us-central1` and returns `404` when your function lives in `us-east1`. Always use the object form `{ "functionId": "mcp", "region": "us-east1" }` and keep the `/api/**` rewrite **above** the `"source": "**"` SPA catch-all rewrite.

> [!TIP]
> **Why Manual Refresh + Zero-Build Static Files?**
> With manual refresh only (no background polling loop while a tab sits open overnight), the dashboard incurs zero idle Cloud Functions invocations or Firestore reads, keeping monthly usage comfortably inside Firebase's free tier. Zero-build ES Modules also eliminate `node_modules` bloat and let `firebase deploy --only hosting` finish in a few seconds.

> [!NOTE]
> **WorkOS UI Gotcha: "Redirect URIs" Lives Under Applications (Not Top-Level Redirects or Admin Portal).**
> WorkOS moved AuthKit callback URLs out of the old top-level "Redirects" sidebar item into **Applications → `<your application>` → Redirects tab → Redirect URIs**. If you search for `redirect` in the WorkOS command palette, ignore the `Admin Portal > ...` results (`Success redirects`, `Logo redirect URL`, `Admin Portal redirects`, `Directory Sync success URL`)—those are for Enterprise Admin Portal, not AuthKit sign-in. Pick **`<your application> > Redirect URIs`** at the top, verify the Staging/Production switcher matches your Secret Manager `WORKOS_CLIENT_ID`, and add the exact `https://<project-id>.web.app/auth/callback` URL with no trailing slash (leaving the other 5 redirect fields as `Not set`).



