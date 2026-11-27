# Implementation Plan: Reduce Firestore Reads via Daily Rollups, Multi-Layer Caching & Trigger Cleanup

- **Date:** 2026-11-24
- **Status:** Complete
- **Scope:** `firestore.indexes.json`, `functions/` (Firestore services, Outdoor service, Cloud Function triggers, Dashboard API, MCP tools, backfill & verification scripts), `web/` (Dashboard API client & UI controller), and `docs/` + `README.md`

## Goal
Cut Firestore read volume by **>99%** on dashboard chart loads and MCP history/summary queries, eliminate redundant reads during UI interactions, and cut background trigger reads in half — keeping daily usage comfortably inside Firestore's 50,000-reads/day free tier.

## Phases & Validation Gates

### Phase 0: Baseline Verification
- [x] Write local plan file `docs/plans/2026-11-24-reduce-firestore-reads.md`
- [x] Run `./scripts/check-secrets.sh && npm --prefix functions test && node scripts/verify_web_dashboard.mjs`

### Phase 1: Rollup Index Exemptions & Core Rollup Service (`daily_rollups` + `outdoor_daily_rollups`)
- [x] Add `fieldOverrides` in `firestore.indexes.json` for `daily_rollups.samples` and `outdoor_daily_rollups.samples`
- [x] Add `DAILY_ROLLUPS_COLLECTION` and `OUTDOOR_DAILY_ROLLUPS_COLLECTION` in `functions/src/services/firestore/db.ts`
- [x] Create `functions/src/services/firestore/rollups.ts`
- [x] Re-export rollup helpers in `functions/src/services/firestore.ts`
- [x] Create `functions/src/scripts/verifyRollups.ts` and wire into `functions/package.json`
- [x] Pass Validation Gate 1 & commit

### Phase 2: Wire Rollup Reads + Automatic Raw Fallback Across Dashboard & MCP Services
- [x] Update `functions/src/services/firestore/readings.ts` to read from `daily_rollups` with raw fallback
- [x] Update `functions/src/services/outdoor.ts` (`getOutdoorReadingsHistory`) to read from `outdoor_daily_rollups` with raw fallback
- [x] Add parity and read-count regression tests in `verifyRollups.ts` / `verifyFirestore.ts` / `verifyOutdoor.ts`
- [x] Pass Validation Gate 2 & commit

### Phase 3: Trigger Rollup Writers & Background Read Cleanup
- [x] Update `syncOutdoorReadingIfStale()` in `functions/src/services/outdoor.ts` (`includeReading` flag + `outdoor_daily_rollups` append)
- [x] Update `syncOutdoorOnReading` in `functions/src/index.ts` to append indoor rollups and skip unused outdoor read
- [x] Add trigger/outdoor assertions in `verifyOutdoor.ts`
- [x] Pass Validation Gate 3 & commit

### Phase 4: Server-Side TTL Cache & Invalidation in Dashboard API
- [x] Create `functions/src/api/cache.ts`
- [x] Wire cache + `?refresh=1` bypass + `Cache-Control: private, no-store` + write invalidation in `types.ts`, `dashboard.ts`, `index.ts`, `routes/telemetry.ts`, `routes/firmware.ts`
- [x] Add cache hit/miss/invalidation tests in `verifyApi.ts`
- [x] Pass Validation Gate 4 & commit

### Phase 5: Browser-Side Chart Cache, Lazy Fleet Loading & Targeted Refreshes
- [x] Update `web/api.js` with `refresh=1` support and `buildReadingsHistoryPath`
- [x] Update `web/app.js` with 5m `chartsCache`, lazy `loadFirmwareReleases()`, and `refreshOverviewOnly()`
- [x] Extend `scripts/verify_web_dashboard.mjs`
- [x] Pass Validation Gate 5 & commit

### Phase 6: One-Time Historical Backfill CLI Script
- [x] Create `functions/src/scripts/backfillRollups.ts` and add `backfill:rollups` to `functions/package.json`
- [x] Add unit tests in `verifyRollups.ts`
- [x] Pass Validation Gate 6 & commit

### Phase 7: Live Firebase Rollout, Backfill & Verification
- [x] Deploy `firestore:indexes` first
- [x] Deploy `functions,hosting`
- [x] Run `backfill:rollups -- --days 30 --dry-run` and live `--days 30` (486 raw indoor -> 4 daily_rollups; 1 raw outdoor -> 1 outdoor_daily_rollups)
- [x] Live smoke checks (`/health`, `/api/auth/config`, 401 on `/api/dashboard/overview`, `verify:firestore -- --live`)

### Final Phase: Codebase Write-Up & Documentation Update
- [x] Create `docs/13-firestore-read-optimization-and-rollups.md`
- [x] Update `docs/03-firebase-and-firestore.md`, `docs/09-remote-config-and-dashboard.md`, `docs/11-outdoor-weather-and-aqi.md`, and `README.md` (preserving existing WIP)
- [x] Pass Final Validation Gate & commit docs
