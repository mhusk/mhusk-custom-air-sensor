# Guide 11: Outdoor Weather & AQI Context (Open-Meteo + Indoor-vs-Outdoor Deltas)

> **Phase 4A** — Captures live outdoor temperature, humidity, wind, PM<sub>2.5</sub>, PM<sub>10</sub>, and US EPA AQI from the free, keyless **Open-Meteo** Weather & Air Quality APIs whenever your indoor sensor publishes a reading, surfacing indoor-vs-outdoor deltas on the Web Dashboard and inside MCP AI responses.

---

## 1. Architecture & Privacy Design

1. **Private Home Location (`site_configs/home`)**:
   - Because this repository is public on GitHub, your home latitude/longitude is **never** committed to Git or hardcoded in Cloud Functions.
   - Instead, you configure it once in the Web Dashboard (**Configure Home Location** → `PUT /api/site/config`), which stores `{ label, latitude, longitude, outdoor_poll_interval_minutes }` in Cloud Firestore at `site_configs/home`.
   - `firestore.rules` denies all client/sensor access to `site_configs` and `outdoor_readings` via the default catch-all rule (`allow read, write: if false;`), so only the Cloud Functions Admin SDK can read or write them.
2. **Event-Driven Capture with Deduplication (`syncOutdoorOnReading`)**:
   - A 2nd Gen Firestore trigger (`onDocumentCreated("readings/{readingId}")` in `us-east1`) runs whenever any ESP32-S3 sensor publishes a reading.
   - Before calling Open-Meteo, it checks the newest document in `outdoor_readings`. If it is fresher than `outdoor_poll_interval_minutes` (default **15 minutes**), the trigger exits immediately—so adding multiple room sensors never causes redundant weather API calls.
   - When the cache expires (or when you save your location / click **Refresh Outdoor**), `fetchOpenMeteoSnapshot()` fetches Open-Meteo's Weather API and Air Quality API in parallel and writes a timestamped document to `outdoor_readings`.
3. **Zero Firmware Changes**:
   - The ESP32-S3 keeps publishing its lightweight indoor payload untouched; all outdoor enrichment happens server-side in Cloud Functions.

---

## 2. Indoor-vs-Outdoor Delta & Window Advice

`computeIndoorOutdoorDelta()` in [`functions/src/services/outdoor.ts`](../functions/src/services/outdoor.ts) computes signed indoor-minus-outdoor differences:
- **`temperature_diff_f` / `temperature_diff_c`**: positive means indoors is warmer than outside.
- **`humidity_diff_percent`**: positive means indoors is more humid than outside.
- **`pm2_5_diff_ug_m3` / `aqi_diff`**: negative means indoors is cleaner than outside.
- **`window_recommendation`**:
  - `keep_closed` — Outdoor US AQI > 100 or PM<sub>2.5</sub> > 35.4 µg/m³ (smoke/pollution), or indoor PM<sub>2.5</sub> is Good (≤ 9.0) while outdoor PM<sub>2.5</sub> > 15.0 µg/m³.
  - `open_recommended` — Indoor CO<sub>2</sub> > 1,000 ppm while outdoor air is clean (US AQI ≤ 80 and PM<sub>2.5</sub> ≤ 20 µg/m³), or indoor PM<sub>2.5</sub> > 12 µg/m³ while outdoor PM<sub>2.5</sub> is at least 3 µg/m³ cleaner.
  - `neutral` — Both indoor and outdoor conditions are in comfortable ranges.

---

## 3. Web Dashboard & MCP Integration

- **Web Dashboard (`web/`)**:
  - **Outdoor Card**: Displays outdoor US AQI, PM<sub>2.5</sub>/PM<sub>10</sub>, Temperature/Feels-Like (°F), and Humidity/Wind, plus **Refresh Outdoor** and **Location** buttons (with optional one-click **Use Browser Location**).
  - **Room Card Delta Strip**: Shows `vs Outdoor:` signed deltas (`Temp`, `RH`, `PM2.5`, `AQI`) alongside the Window Recommendation badge.
  - **6h / 24h / 7d Chart Overlays**: Renders a dashed **Outdoor** comparison line on the **PM<sub>2.5</sub>**, **Temperature (°F)**, and **Relative Humidity (% RH)** charts, with paired indoor/outdoor values on hover.
- **Remote MCP Server (`functions/src/mcp/`)**:
  - **`get_latest_reading`**: Automatically appends `outdoor` and `outdoor_comparison` whenever an outdoor snapshot exists.
  - **`get_outdoor_air_quality`**: Dedicated read-only tool returning the latest outdoor weather + AQI snapshot (auto-refreshing if stale) and optional `hours` history.
  - **`analyze_indoor_air` prompt**: Guides Gemini, Claude, ChatGPT, and Grok to compare indoor vs. outdoor conditions and answer whether opening a window will help.

---

## 4. Verification & Deployment

```bash
# 1. Offline verification (Open-Meteo parsing, delta math, Dashboard API, MCP tools)
npm --prefix functions run verify:outdoor
npm --prefix functions run verify:mcp
npm --prefix functions run verify:api

# 2. Web Dashboard offline verification
node scripts/verify_web_dashboard.mjs

# 3. Secret hygiene check
./scripts/check-secrets.sh

# 4. Deploy Cloud Functions (HTTP + Firestore trigger) and Web Dashboard
firebase deploy --only functions,hosting
```

---

## Good to Know & Real-World Troubleshooting

- **First-Time Setup:** Until you save coordinates via **Configure Home Location** in the Web Dashboard, `syncOutdoorOnReading` logs `site_location_not_configured` and exits cleanly with zero errors or external calls.
- **Air Quality Outage Resilience:** If Open-Meteo's Air Quality endpoint briefly returns an error while the Weather endpoint succeeds, `fetchOpenMeteoSnapshot()` still saves outdoor temperature, humidity, wind, and weather conditions with `null` particulate fields rather than failing the whole snapshot.
- **No Custom Composite Index Required:** `outdoor_readings` is queried solely by `timestamp` (`desc` for latest, `>=` + `asc` for history), which Firestore indexes automatically out of the box.
- **First-Time 2nd Gen Firestore Trigger (Eventarc IAM Propagation):** The very first time you deploy a 2nd Gen Firestore `onDocumentCreated` trigger on a Firebase project, Firebase enables `eventarc.googleapis.com` and generates the Eventarc Service Agent. The first deploy can briefly return `HTTP 400: Permission denied while using the Eventarc Service Agent` while IAM propagates; waiting ~1–2 minutes and re-running `firebase deploy --only functions:syncOutdoorOnReading,hosting` succeeds cleanly.
