# Repository Agent Instructions

This repository (`custom-air-sensor`) holds the CircuitPython ESP32-S3 firmware, Firebase Cloud Functions backend, Remote MCP Server, Web Dashboard, 3D enclosure prompts, and documentation for the home air quality monitor.

## Standing Repository Rules

1. **Keep `IMPLEMENTATION_PLAN.md` Up to Date (Required):**
   - Whenever a step, phase, or feature roadmap item is added, updated, or completed, update both `IMPLEMENTATION_PLAN.md` at the repository root and the active plan under `docs/plans/` in the same task/commit so `IMPLEMENTATION_PLAN.md` remains the authoritative project tracker.
2. **Implementation Plan Commit Policy:**
   - **Feature, performance, and roadmap plans** live in `docs/plans/` and **should be committed to GitHub** (after passing `./scripts/check-secrets.sh`).
   - **Security audit, vulnerability, and security-hardening plans** **must never be committed to GitHub** — store them in `docs/plans/security/` (or name them `*security*.md` / `*audit*.md`), which is gitignored in `.gitignore`.
3. **Public-Repo Safety & Validation:**
   - Never commit real credentials, project IDs, personal paths, or raw media (`.firebaserc`, `firmware/settings.toml`, `.env`, `local_media_raw/`).
   - Always run `./scripts/check-secrets.sh` and the relevant offline verification suites (`npm --prefix functions test`, `node scripts/verify_web_dashboard.mjs`, `python3 scripts/test_firmware_local.py`) before committing.
