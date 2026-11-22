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

- [x] **Step 1**: `README.md` & Public-Repo Security Guardrails
- [x] **Step 2**: Firebase Project Initialization & Firestore Database Provisioning
- [x] **Step 3**: Hardened Firestore Security Rules
- [x] **Step 4**: Firmware Math & REST Client (Tested Locally on Mac First)
- [x] **Step 5**: Cloud Functions Scaffolding & Firestore Query Service
- [x] **Step 6**: Core MCP Server Tools, Prompts & Resources (Local/Bearer Validation)
- [x] **Step 7**: WorkOS AuthKit Integration & Owner Allowlist
- [x] **Step 8**: Connecting AI Assistants (Gemini, Claude, ChatGPT, Grok)
- [ ] **Step 9**: Physical Hardware Assembly & CircuitPython Flashing
- [ ] **Step 10**: Complete CircuitPython Sensor Loop (`firmware/code.py`)
- [ ] **Step 11**: Live End-to-End AI Query & Final Docs Polish

---

## Detailed Step Breakdown

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
- **Status**: `[ ] Pending`
- **Goal**: Assemble the Adafruit ESP32-S3 Feather, SCD-40, and PMSA003I via STEMMA QT cables, flash CircuitPython 9.x, install required libraries onto `CIRCUITPY/lib`, and verify the I2C bus sees both sensors.
- **Deliverables**:
  - `firmware/requirements-circuitpython.txt`
  - `docs/01-hardware-and-i2c.md`
- **Single Focused Validation**:
  - Plug the assembled hardware into the Mac via USB-C, confirm the `CIRCUITPY` drive mounts, and run a short I2C bus scan in the serial console verifying both `0x62` (SCD-40) and `0x12` (PMSA003I) are detected.
- **Target Commit**: `docs(hardware): add STEMMA QT wiring, CircuitPython flashing, and I2C verification guide`

---

### Step 10: Complete CircuitPython Sensor Loop (`firmware/code.py`)
- **Status**: `[ ] Pending`
- **Goal**: Implement the full on-device firmware loop (`firmware/code.py`) combining SCD-40 + PMSA003I polling, NeoPixel status colors, watchdog resilience, and 5-minute Firestore publishing, then load it onto the ESP32-S3.
- **Deliverables**:
  - `firmware/code.py`
  - `docs/02-circuitpython-firmware.md` (Part 2: Main sensor loop, NeoPixel status codes, and copying files to `CIRCUITPY`)
- **Single Focused Validation**:
  - Copy `code.py`, `aqi.py`, `firestore_client.py`, and `settings.toml` to the `CIRCUITPY` drive. Observe the NeoPixel turn solid blue during boot, pulse green once when the first reading succeeds, and confirm a real room reading appears in Firestore.
- **Target Commit**: `feat(firmware): add main CircuitPython sensor polling and Firestore loop`

---

### Step 11: Live End-to-End AI Query & Final Docs Polish
- **Status**: `[ ] Pending`
- **Goal**: Perform a full end-to-end validation from physical sensors -> ESP32-S3 -> Firestore -> Cloud Function MCP Server -> AI Assistant, and finalize any remaining "Good to Know" notes across all docs.
- **Deliverables**:
  - Final updates to `README.md`, `PRD.md`, `IMPLEMENTATION_PLAN.md`, and `docs/01`–`06`
- **Single Focused Validation**:
  - Ask Claude/ChatGPT/Grok: *"What is the current air quality in my room right now, and how do my CO2 and PM2.5 levels look?"* and confirm the response matches the live hardware telemetry.
- **Target Commit**: `docs: finalize end-to-end verification notes and complete implementation plan`
