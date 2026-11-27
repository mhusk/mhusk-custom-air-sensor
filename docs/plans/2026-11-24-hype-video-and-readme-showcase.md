# Implementation Plan: Google Flow Hype Video & README Showcase Polish

- **Date:** 2026-11-24
- **Status:** Complete
- **Scope:** Hardware & dashboard media capture, EXIF/privacy media prep (`scripts/prepare_media.sh`, `docs/images/`), Google Flow (`Veo 3 / 3.1`) hype video storyboard & copy-paste prompt pack (`docs/12-showcase-and-hype-video.md`), and portfolio-grade `README.md` showcase polish.

## Goal
Turn the finished ESP32-S3 Air Quality Sensor + 3D-printed enclosure + Firebase Web Dashboard + Remote MCP Server into a compelling visual showcase: capture a clean set of real hardware photos and privacy-scrubbed screenshots, produce a ready-to-paste **Google Flow** script/storyboard for a sleek 30–45 second 16:9 hardware reveal hype video, and upgrade `README.md` so visitors immediately see the finished build in action.

## Assumptions & Open Decisions
- **Video Format & Length:** `16:9` landscape, ~35–45 seconds (5 scenes × ~8s clips in Google Flow / Veo).
- **Creative Direction:** Sleek hardware reveal (Apple / Teenage Engineering vibe) — dark/warm studio lighting, macro product shots, subtle electronic beat + tactile foley, minimal on-screen titles.
- **Real Media Inputs:** 4–5 hardware photos + 2–3 privacy-scrubbed app screenshots powering both `README.md` and Google Flow **Ingredients to Video** / **Frames to Video**.
- **Repo Layout & Privacy:** Raw unedited photos live in a gitignored `local_media_raw/` staging folder; only resized, EXIF/GPS-stripped, privacy-checked assets are committed under `docs/images/`. Final rendered `.mp4` video stays outside Git (hosted on YouTube/X/GitHub Release attachment and linked/embedded from `README.md`).

---

## Phases & Validation Gates

### Phase 1: Shot List Spec, Gitignore Guard & Media Prep Script
**Changes:**
- [x] Add `local_media_raw/` to `.gitignore` so unedited HEIC/RAW photos (which contain GPS EXIF) and large `.mp4` renders can never be accidentally committed.
- [x] Create `scripts/prepare_media.sh` (using macOS built-in `sips` + Python metadata verification) to convert images from `local_media_raw/` into `docs/images/`, resize to `<= 1600px` wide, strip EXIF/GPS metadata, and enforce a `< 600 KB` web-friendly size budget.
- [x] Draft the exact **Photo & Screenshot Shot List** (angles, lighting, `16:9` framing, and privacy-scrubbing checklist for dashboard/AI screenshots) inside `docs/12-showcase-and-hype-video.md` (Part 1).

**Validation Gate 1:**
- Command / check: `bash -n scripts/prepare_media.sh && ./scripts/prepare_media.sh --help && ./scripts/check-secrets.sh`
- Expected result: Script syntax passes, `--help` prints usage cleanly, `local_media_raw/` is ignored by `git check-ignore local_media_raw`, and `check-secrets.sh` passes with 0 findings.
- If it fails: Check executable permissions (`chmod +x scripts/prepare_media.sh`) or `.gitignore` pattern placement.

---

### Phase 2: Capture, Privacy-Scrub & Optimize Real Photos + Screenshots
**Changes:**
- [x] User captures the 4–5 hardware photos and 2–3 screenshots and drops them into `local_media_raw/`:
  1. `hero-enclosure-closed` — Closed 3D-printed hub on nightstand/desk (3/4 angle, `16:9`, warm directional side light, clean uncluttered surface)
  2. `internals-open-lid` — Lid slid off, 45° or top-down view showing ESP32-S3 Feather, SCD-40, PMSA003I, thermal baffles, and coiled STEMMA QT cables
  3. `rear-vents-usbc` — Rear 3/4 macro showing the split PMSA003I intake/exhaust grille, solid LED shield, and USB-C port
  4. `hardware-scale` *(optional)* — Wide nightstand/room context shot showing how low-profile and sleek the hub looks in place
  5. `dashboard-overview` — Web Dashboard showing live indoor cards, outdoor delta strip, and 24h SVG charts *(privacy check: crop/hide browser address bar, personal email, and any city/coordinates)*
  6. `dashboard-fleet-ota` — Fleet & Firmware tab showing live `v1.3.3` OTA status *(privacy check: no private URLs/emails)*
  7. `ai-mcp-query` — Live Gemini or Grok conversation answering an indoor air quality prompt via MCP *(privacy check: crop out account avatar/email)*
- [x] Run `./scripts/prepare_media.sh` to strip EXIF/GPS, compress, and output final web-ready files into `docs/images/`.
- [x] Visually inspect all output images in `docs/images/` to confirm crisp framing and zero sensitive info (emails, URLs, coordinates, personal items in background).

**Validation Gate 2:**
- Command / check: Verify every file in `docs/images/` is `< 600 KB`, has zero GPS/EXIF metadata (`sips -g all` / `mdls` check built into `scripts/prepare_media.sh --verify`), and `./scripts/check-secrets.sh` passes.
- Expected result: All target images exist in `docs/images/`, pass size & zero-EXIF checks, and `git status` shows zero files under `local_media_raw/`.
- If it fails: Re-run `prepare_media.sh` with a lower JPEG quality (e.g., `80`) for oversized images, or crop/blur any sensitive UI text before re-processing.

---

### Phase 3: Google Flow Hype Video Storyboard & Copy-Paste Prompt Pack
**Changes:**
- [x] Complete `docs/12-showcase-and-hype-video.md` (Parts 2–4) with a production-ready **Google Flow** workflow:
  - **Part 2 — Google Flow Asset (`@Ingredient`) Setup:** Exact naming convention (`@HubClosed`, `@HubInternals`, `@HubRear`, `@DashboardUI`, `@AIChatUI`), upload order, and when to use **Ingredients to Video** vs. **Frames to Video** (First/Last Frame lock).
  - **Part 3 — 5-Scene Shot-by-Shot Script & Copy-Paste Veo Prompts (`16:9`, ~40s):** Each scene uses the 4-part Veo formula (*Subject & Action, Composition & Camera Motion, Location & Lighting, Style & Aesthetics*) plus native audio/SFX/music cues and optional minimal title overlays:
    - *Scene 1 (0–8s):* Invisible Air / Sleek Hub Reveal (`@HubClosed`)
    - *Scene 2 (8–16s):* Zero Screws, All Signal — Lid Slide & Internal Architecture (`@HubClosed` → `@HubInternals`)
    - *Scene 3 (16–24s):* Precision Thermal & Airflow Engineering (`@HubRear`)
    - *Scene 4 (24–32s):* Real-Time Cloud Telemetry & Outdoor Deltas (`@DashboardUI`)
    - *Scene 5 (32–40s):* Ask Your Room Anything via MCP + Clean End Card (`@AIChatUI` → `@HubClosed`)
  - **Part 4 — Generation & Assembly Troubleshooting:** Tips for keeping hardware geometry consistent (1–2 `@Ingredients` per prompt), avoiding garbled AI-generated UI text (compositing clean titles/screenshots in post if needed), and stitching the 5 clips smoothly in Google Flow Scene Builder.

**Validation Gate 3:**
- Command / check: Review `docs/12-showcase-and-hype-video.md` against all 5 scenes + `@Ingredient` table + troubleshooting checklist, and run `./scripts/check-secrets.sh`.
- Expected result: Every scene has a self-contained, copy-paste-ready Google Flow prompt referencing the exact prepared images from Phase 2, with zero personal info or broken links.
- If it fails: Tighten any ambiguous camera/lighting cues or mismatching `@Ingredient` references before generating clips in Google Flow.

---

### Final Phase: `README.md` Showcase Polish & Documentation Update
**Changes:**
- [x] Upgrade `README.md` with a clean top visual showcase:
  - Hero hardware photo (`docs/images/hero-enclosure-closed.jpg`) + compact 2-column gallery of the open internals, live Web Dashboard, and AI MCP query.
  - Concise technology/status badges and a scannable "Key Highlights" strip (hardware, remote config, A/B OTA, outdoor deltas, MCP).
  - Video showcase callout box (ready to drop in the final YouTube/GitHub-hosted Google Flow hype video link once rendered).
- [x] Add `docs/12-showcase-and-hype-video.md` to the `README.md` Documentation Curriculum list.
- [x] Add a brief **Media & Screenshot Privacy** bullet to `docs/06-security-and-privacy-checklist.md` (EXIF stripping + cropping emails/URLs/coordinates).
- [x] Mark all completed checkboxes in this plan (`docs/plans/2026-11-24-hype-video-and-readme-showcase.md`) and set **Status** to `Complete`.

**Final Validation Gate:**
- Command / check: Verify all markdown image/doc links in `README.md` and `docs/12-showcase-and-hype-video.md` resolve to existing files, run `./scripts/check-secrets.sh`, and check `git status` to ensure no raw media or secrets are staged.
- Expected result: Zero broken links, zero EXIF/secret warnings, and a clean, portfolio-ready `README.md`.
