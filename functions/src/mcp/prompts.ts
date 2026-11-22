import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const THRESHOLDS_RESOURCE_URI = "air-quality://thresholds/reference";

export const AIR_QUALITY_THRESHOLDS_MARKDOWN = `# Indoor Air Quality Thresholds & Reference Guide

This reference aligns with the sensor firmware (\`firmware/aqi.py\`) and Firestore aggregation service (\`functions/src/services/firestore.ts\`).

## 1. Carbon Dioxide (CO2) — Ventilation & Cognitive Impact
Based on ASHRAE indoor ventilation guidance and Harvard T.H. Chan School of Public Health (COGfx) cognitive function studies:

| CO2 Range (ppm) | Band | Interpretation & Recommended Action |
| :--- | :--- | :--- |
| **400 – 799 ppm** | \`optimal\` | Well ventilated (near outdoor baseline ~420 ppm). Optimal cognitive performance and focus. |
| **800 – 1,000 ppm** | \`acceptable\` | Typical occupied indoor room. Acceptable, but consider opening a window or increasing airflow if trending upward. |
| **1,001 – 1,400 ppm** | \`elevated\` | Stuffy air; studies associate sustained levels here with measurable dips in strategic decision-making and mild drowsiness. Open a window or crack an interior door for 10–15 minutes. |
| **> 1,400 ppm** | \`poor\` | Poor ventilation. Ventilate the room promptly (cross-breeze or HVAC fresh-air intake). |

*Note: Indoor CO2 is primarily a proxy for exhaled breath accumulation and ventilation adequacy—HEPA air purifiers remove particulates (PM2.5/PM10) but do **not** reduce CO2; fresh outdoor air exchange is required to lower CO2.*

## 2. Fine Particulate Matter (PM2.5) — Revised May 2024 US EPA AQI Breakpoints
From the US EPA Technical Assistance Document for Reporting Daily Air Quality (EPA-454/B-24-002, effective May 6, 2024). PM2.5 concentrations are truncated to 1 decimal place before breakpoint lookup.

| PM2.5 (ug/m3) | US EPA AQI | Category | Indoor Guidance |
| :--- | :--- | :--- | :--- |
| **0.0 – 9.0** | 0 – 50 | Good | Clean indoor particulate air. |
| **9.1 – 35.4** | 51 – 100 | Moderate | Mildly elevated particles (e.g., cooking, candles, dust). Running a HEPA purifier helps bring PM2.5 back under 9.0 ug/m3. |
| **35.5 – 55.4** | 101 – 150 | Unhealthy for Sensitive Groups | Elevated fine particles; run HEPA filtration on high and inspect indoor/outdoor smoke or cooking sources. |
| **55.5 – 125.4** | 151 – 200 | Unhealthy | High particulate load; keep windows closed if outdoor wildfire/smoke is the source and run HEPA filtration continuously. |
| **125.5 – 225.4** | 201 – 300 | Very Unhealthy | Very high particulate load; avoid indoor combustion, seal drafts, and run maximum HEPA filtration. |
| **225.5 – 325.4+** | 301 – 500 | Hazardous | Hazardous particulate levels; take immediate mitigation steps. |

## 3. Coarse Particulate Matter (PM10) — US EPA AQI Breakpoints
PM10 concentrations are truncated to an integer before breakpoint lookup. Overall US AQI is the worst (maximum) sub-index of PM2.5 and PM10.

| PM10 (ug/m3) | US EPA AQI | Category |
| :--- | :--- | :--- |
| **0 – 54** | 0 – 50 | Good |
| **55 – 154** | 51 – 100 | Moderate |
| **155 – 254** | 101 – 150 | Unhealthy for Sensitive Groups |
| **255 – 354** | 151 – 200 | Unhealthy |
| **355 – 424** | 201 – 300 | Very Unhealthy |
| **425 – 504** | 301 – 400 | Hazardous |
| **505 – 604+** | 401 – 500 | Hazardous |

## 4. Relative Humidity & Thermal Comfort
| Relative Humidity (% RH) | Band | Guidance |
| :--- | :--- | :--- |
| **< 30%** | \`dry\` | Dry indoor air; can irritate nasal passages, throat, and skin. |
| **30% – 50%** | \`ideal\` | Ideal indoor comfort and respiratory health range (EPA/ASHRAE recommended). |
| **> 50%** | \`humid\` | Elevated moisture; sustained levels > 60% RH encourage dust mites and mold growth. Use dehumidification or ventilation. |

## 5. Sensor Reporting & Freshness Thresholds
The ESP32-S3 sensor (SCD-40 + PMSA003I) publishes every **5 minutes (300 seconds)**:
- **Online**: last seen <= 15 minutes ago
- **Stale**: last seen 16–60 minutes ago (possible transient Wi-Fi drop)
- **Offline**: last seen > 60 minutes ago (check USB power, Wi-Fi, or onboard NeoPixel LED)
`;

/**
 * Registers the indoor air quality analysis prompt and the EPA/ASHRAE
 * threshold reference resource on the provided McpServer.
 */
export function registerAirQualityPromptsAndResources(server: McpServer): void {
  server.registerPrompt(
    "analyze_indoor_air",
    {
      title: "Analyze Indoor Air Quality",
      description:
        "Guides the AI assistant to inspect the latest sensor reading and 24-hour summary, evaluate CO2 cognitive impact and PM2.5/PM10 risks against EPA/ASHRAE thresholds, and deliver concise, actionable recommendations.",
      argsSchema: {
        location: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional room/location slug to focus on (e.g., 'home-office')."),
        device_id: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional specific sensor device ID (e.g., 'feather-s3-01')."),
        period: z
          .enum(["1h", "6h", "24h", "7d", "30d"])
          .optional()
          .describe("Optional summary window (defaults to '24h')."),
      },
    },
    ({ location, device_id, period }) => {
      const targetPeriod = period ?? "24h";
      const filterParts: string[] = [];
      if (location) {
        filterParts.push(`location="${location}"`);
      }
      if (device_id) {
        filterParts.push(`device_id="${device_id}"`);
      }
      const filterClause =
        filterParts.length > 0
          ? ` filtered by ${filterParts.join(" and ")}`
          : " across my available sensor(s)";

      return {
        description: "Comprehensive indoor air quality check with actionable ventilation and filtration advice.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Please analyze my current indoor air quality${filterClause}:`,
                "",
                `1. Call \`get_latest_reading\`${filterParts.length > 0 ? ` (${filterParts.join(", ")})` : ""} to inspect the newest measurements and check whether the data is fresh or stale.`,
                `2. Call \`get_air_quality_summary\` with \`period="${targetPeriod}"\`${filterParts.length > 0 ? ` (${filterParts.join(", ")})` : ""} to review min/avg/max/p95 statistics, threshold exceedances, and any notable CO2 or PM2.5 spikes.`,
                `3. If the latest reading is stale (or no recent reading is returned), call \`get_sensor_status\` to check whether the ESP32-S3 sensor is offline.`,
                `4. Reference \`${THRESHOLDS_RESOURCE_URI}\` when interpreting CO2 cognitive ranges (400–800 ppm optimal, >1000 ppm elevated, >1400 ppm poor), revised 2024 US EPA PM2.5 AQI breakpoints (<=9.0 ug/m3 Good), and ideal humidity (30%–50% RH).`,
                "",
                "Present a clear, concise summary covering:",
                "- **Current Snapshot**: CO2 (ppm), PM2.5/PM10 (ug/m3) & US EPA AQI category, Temperature (°F/°C), Humidity (% RH), and how many minutes ago the reading was recorded.",
                `- **${targetPeriod} Trend & Spikes**: Notable CO2 or PM2.5 episodes with peak values and timestamps.`,
                "- **Actionable Advice**: Concrete next steps tailored to the metrics (remembering that opening a window / fresh air lowers CO2, while HEPA filtration lowers PM2.5/PM10).",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerResource(
    "air-quality-thresholds-reference",
    THRESHOLDS_RESOURCE_URI,
    {
      title: "US EPA & ASHRAE Indoor Air Quality Thresholds Reference",
      description:
        "Reference table of revised 2024 US EPA PM2.5/PM10 AQI breakpoints, ASHRAE / Harvard cognitive CO2 thresholds, ideal indoor relative humidity bands, and sensor freshness windows.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: AIR_QUALITY_THRESHOLDS_MARKDOWN,
        },
      ],
    })
  );
}
