# Guide 07: Understanding Your Sensor Readings & How to Improve Them

> **Reference guide for everyday use** — Explains every metric coming off your **SCD-40** and **PMSA003I** sensors, what happens when a reading climbs too high (or drops too low), how to diagnose common indoor patterns, and practical ways to improve your indoor air quality.

> [!NOTE]
> All thresholds in this guide match the exact values used by [`firmware/aqi.py`](../firmware/aqi.py), [`functions/src/services/firestore.ts`](../functions/src/services/firestore.ts), and the MCP `air-quality://thresholds/reference` resource in [`functions/src/mcp/prompts.ts`](../functions/src/mcp/prompts.ts). This guide summarizes public US EPA, ASHRAE, and peer-reviewed indoor air research for educational purposes—it is not medical advice.

---

## 1. At-a-Glance Cheat Sheet

| Metric | Sensor | Target Range | Too High / Too Low Risk | #1 Fix |
| :--- | :--- | :--- | :--- | :--- |
| **CO<sub>2</sub>** | SCD-40 | **400 – 799 ppm** *(acceptable to 1,000)* | Drowsiness, sluggish thinking, headaches, worse sleep | **Fresh outdoor air** (open window/door; HEPA does *not* remove CO<sub>2</sub>) |
| **PM<sub>2.5</sub>** | PMSA003I | **0.0 – 9.0 &mu;g/m<sup>3</sup>** *(EPA Good)* | Deep lung irritation, coughing, asthma/allergy flare-ups, cardiovascular strain | **True HEPA air purifier** + vented range hood while cooking |
| **PM<sub>1.0</sub>** | PMSA003I | **As low as possible** *(typically &le; 5–7 &mu;g/m<sup>3</sup>)* | Ultrafine combustion/smoke particles penetrate deepest into lungs | **True HEPA purifier** + eliminate indoor smoke/candles/ultrasonic mist |
| **PM<sub>10.0</sub>** | PMSA003I | **0 – 54 &mu;g/m<sup>3</sup>** *(EPA Good)* | Upper-airway, nose, throat, and eye irritation (dust, pollen, dander) | **HEPA purifier** + HEPA vacuuming + wash bedding / damp-dust |
| **US EPA AQI** | Computed on ESP32-S3 | **0 – 50** *(Good)* | Combined particulate health index (worst of PM<sub>2.5</sub> & PM<sub>10</sub>) | Address whichever PM sub-index is driving the score (almost always PM<sub>2.5</sub>) |
| **Humidity (% RH)** | SCD-40 | **30% – 50% RH** | **&lt;30%**: dry sinuses/skin; **&gt;60%**: mold, dust mites, musty air | Dehumidifier/AC/exhaust fan if high; evaporative humidifier if dry |
| **Temperature** | SCD-40 | **68–74 &deg;F** daytime / **65–68 &deg;F** sleep | Too warm hurts sleep & comfort; shifts relative humidity | Thermostat, airflow/fan, shade/ventilation |

---

## 2. Carbon Dioxide (CO<sub>2</sub>) — Freshness & Ventilation

### What It Measures
The **Sensirion SCD-40** measures **true carbon dioxide (CO<sub>2</sub>)** in parts per million (**ppm**) using photoacoustic infrared sensing. Outdoor air sits around **~420 ppm**. Indoors, the primary source of CO<sub>2</sub> is simply **people (and pets) breathing** in a closed room—along with unvented gas stoves or heaters. Because exhaled air builds up whenever fresh outdoor air isn't replacing stale indoor air, CO<sub>2</sub> is the best everyday proxy for **room ventilation**.

> [!CAUTION]
> **CO<sub>2</sub> (Carbon Dioxide) is NOT CO (Carbon Monoxide)!**
> Your SCD-40 measures harmless-at-low-levels exhaled **CO<sub>2</sub>**, not toxic **CO** from faulty furnaces or generators. Always keep dedicated, UL-listed smoke and carbon monoxide detectors in your home.

### Thresholds & What Happens When CO<sub>2</sub> Is Too High
Based on ASHRAE ventilation standards and Harvard T.H. Chan School of Public Health (*COGfx*) cognitive studies:

| CO<sub>2</sub> (ppm) | Band | What Happens | What to Do |
| :--- | :--- | :--- | :--- |
| **400 – 799** | `optimal` | Air is fresh and well-ventilated; ideal for focus, decision-making, and restorative sleep. | Nothing needed—keep doing what you're doing. |
| **800 – 1,000** | `acceptable` | Typical for an occupied room with modest ventilation. Fine short-term, though worth watching if climbing. | Crack a door or window if you notice it trending past 1,000 ppm. |
| **1,001 – 1,400** | `elevated` | Stuffy air. Controlled studies show measurable dips in strategic thinking, crisis response, and focus, plus mild drowsiness. | Open a window for 10–15 minutes (or leave the bedroom/office door ajar so HVAC air can circulate). |
| **&gt; 1,400** | `poor` | Poor ventilation—often happens overnight in a closed bedroom or during long meetings in a sealed office. Can cause grogginess, headaches, and noticeably stale air. | Ventilate promptly with cross-breeze (two windows or window + interior door) or HVAC fresh-air intake. |

### How to Improve High CO<sub>2</sub>
- **Open a window or create a cross-breeze**: Even cracking a window for 5–15 minutes can drop a 1,400 ppm room back under 700 ppm.
- **Open the interior door**: A closed bedroom or home office traps exhaled CO<sub>2</sub> rapidly; opening the door mixes room air with the rest of the house's larger air volume.
- **Run HVAC circulation (`Fan: On`) or an ERV/HRV**: Central HVAC recirculation mixes air across rooms (preventing localized pockets), while an Energy/Heat Recovery Ventilator (ERV/HRV) actively brings in filtered outdoor air.
- **Remember: HEPA air purifiers do NOT remove CO<sub>2</sub>**: CO<sub>2</sub> is a tiny gas molecule that passes straight through HEPA and standard carbon filters. Only fresh air exchange lowers CO<sub>2</sub>.

---

## 3. Particulate Matter (PM<sub>1.0</sub>, PM<sub>2.5</sub>, PM<sub>10.0</sub>) & US EPA AQI

### What It Measures
The **Plantower PMSA003I** draws room air across a laser beam and counts microscopic airborne particles by diameter (for scale, a human hair is roughly **50–70 &mu;m** wide):

- **PM<sub>10.0</sub> (&le; 10 &mu;m — Coarse Particles)**: Household dust, pollen, mold spores, pet dander, construction dust. Mostly trapped in the nose, sinuses, and upper airways.
- **PM<sub>2.5</sub> (&le; 2.5 &mu;m — Fine Particles)**: Cooking smoke/oils, candles, incense, wildfire smoke, vehicle exhaust, fireplace smoke, and mineral "white dust" from ultrasonic humidifiers. Small enough to travel deep into the lungs and enter the bloodstream—this is the most closely watched health metric.
- **PM<sub>1.0</sub> (&le; 1.0 &mu;m — Sub-Micron / Ultrafine-Range Particles)**: Smoke, combustion aerosols, vaping/tobacco aerosols, and fine cooking haze. These penetrate deepest into lung alveoli and stay suspended in room air for hours.
- **Raw Particle Counts (`particles_0_3um` through `particles_10_0um`)**: The exact number of particles per `0.1 L` of air larger than `0.3`, `0.5`, `1.0`, `2.5`, `5.0`, and `10.0` &mu;m. Watching the `0.3 µm` and `0.5 µm` bins gives you an instant early warning the moment cooking haze or smoke drifts into a room.

> [!TIP]
> **Notice the `PM1.0` vs. `PM2.5` vs. `PM10` ratio!**
> - When **PM<sub>1.0</sub> is a large share of PM<sub>2.5</sub>** (e.g., `PM1.0 = 19`, `PM2.5 = 31`, `PM10 = 33`), the particles are mostly **very fine aerosols** (cooking, smoke, candles, outdoor haze, or an ultrasonic humidifier)—not coarse dust.
> - When **PM<sub>10</sub> is much higher than PM<sub>2.5</sub>** (e.g., `PM2.5 = 6`, `PM10 = 45`), the culprit is **coarse dust, sweeping/vacuuming, shaking blankets, or pollen**.

### Revised May 2024 US EPA PM<sub>2.5</sub> AQI Breakpoints
Your ESP32-S3 computes **`aqi_us`** on-device using the **May 2024 US EPA** breakpoint table (where the "Good" ceiling tightened from `12.0` to **`9.0` &mu;g/m<sup>3</sup>**), taking the worst sub-index between PM<sub>2.5</sub> and PM<sub>10</sub>:

| PM<sub>2.5</sub> (&mu;g/m<sup>3</sup>) | PM<sub>10</sub> (&mu;g/m<sup>3</sup>) | US EPA AQI | Category | What Happens & What to Do |
| :--- | :--- | :--- | :--- | :--- |
| **0.0 – 9.0** | **0 – 54** | **0 – 50** | **Good** | Clean indoor particulate air; minimal health risk. |
| **9.1 – 35.4** | **55 – 154** | **51 – 100** | **Moderate** | Mildly elevated particles. Sensitive individuals (asthma, allergies) may notice mild irritation over long exposure. Run a **True HEPA purifier** to pull PM<sub>2.5</sub> back under `9.0` &mu;g/m<sup>3</sup>. |
| **35.5 – 55.4** | **155 – 254** | **101 – 150** | **Unhealthy for Sensitive Groups** | Noticeable haze or cooking/smoke residue; can trigger coughing, chest tightness, or allergy symptoms in sensitive groups. Run HEPA filtration on high and find/stop the source. |
| **55.5 – 125.4** | **255 – 354** | **151 – 200** | **Unhealthy** | Everyone may begin to experience respiratory irritation and elevated cardiovascular strain with prolonged exposure. Keep windows shut if outdoor smoke is the source; run HEPA purifiers continuously. |
| **125.5 – 225.4** | **355 – 424** | **201 – 300** | **Very Unhealthy** | Significant health risk; avoid indoor combustion entirely, seal window/door drafts, and run maximum HEPA filtration. |
| **225.5+** | **425+** | **301 – 500** | **Hazardous** | Severe particulate pollution; take immediate steps to seal off outdoor smoke and maximize multi-room HEPA filtration. |

### How to Improve High PM<sub>1.0</sub> / PM<sub>2.5</sub> / PM<sub>10</sub>
- **Run a True HEPA air purifier**: Match the purifier's **CADR** (Clean Air Delivery Rate) to your room size so it turns the room air over **4–5 times per hour** (e.g., running on high for 20–30 minutes after cooking drops PM<sub>2.5</sub> dramatically).
- **Use a vented range hood every time you cook**: Frying, searing, and broiling are the #1 indoor source of sudden PM<sub>2.5</sub> spikes (often jumping past `100+` &mu;g/m<sup>3</sup>). Turn the exhaust fan on *before* heating the pan and leave it running 10 minutes after.
- **Check your humidifier**: **Ultrasonic (cool-mist) humidifiers** filled with tap water atomize dissolved calcium/magnesium minerals into microscopic airborne particles that laser PM sensors read as massive PM<sub>2.5</sub> spikes (and that you breathe in as "white dust"). Switch to **distilled water** or use an **evaporative (wick) humidifier** instead.
- **Avoid indoor combustion**: Scented candles, incense, wood fireplaces, and tobacco/vaping produce dense PM<sub>1.0</sub>/PM<sub>2.5</sub> clouds.
- **Upgrade your central HVAC filter**: If your HVAC blower supports it, a **MERV-13** pleated filter captures fine particles whenever the system runs (or consider a DIY **Corsi-Rosenthal box** during wildfire season).
- **Vacuum with a sealed HEPA vacuum & damp-dust**: Dry sweeping kicks settled PM<sub>10</sub> dust right back into the air.

---

## 4. Relative Humidity (% RH)

### What It Measures
Relative humidity measures how much water vapor is in the air compared to the maximum amount the air can hold at the current temperature.

| Relative Humidity (% RH) | Band | What Happens | What to Do |
| :--- | :--- | :--- | :--- |
| **&lt; 30%** | `dry` | Dry nasal passages, scratchy throat, dry skin/eyes, static shocks, and longer airborne survival for some respiratory viruses. | Run an **evaporative humidifier** (or ultrasonic humidifier with **distilled water only**) and check for excessive winter drafts. |
| **30% – 50%** | `ideal` | The EPA/ASHRAE sweet spot for respiratory comfort, sleep quality, and keeping mold & dust mites suppressed. | Ideal—maintain current conditions. |
| **51% – 60%** | `humid` | Slightly damp; generally fine briefly (e.g., after a shower or on a humid day), though dust mites begin to thrive near 55–60%. | Run bathroom/kitchen exhaust fans or air conditioning to bring it back into the 40–50% range. |
| **&gt; 60%** | `humid` *(high risk)* | Sustained humidity above 60% encourages **mold, mildew, musty odors, and dust mites**, and can make rooms feel clammy. | Run a **dehumidifier**, use AC, vent showers/dryers outdoors, and check for plumbing leaks or damp basements. |

> [!NOTE]
> Very high humidity (&gt;70% RH) or visible mist directly next to the PMSA003I can also cause fine water droplets to scatter the sensor's laser beam, temporarily inflating PM<sub>2.5</sub> readings.

---

## 5. Temperature (&deg;F / &deg;C)

### What It Measures & Ideal Ranges
The SCD-40 reports ambient room temperature in both Celsius (`temperature_c`) and Fahrenheit (`temperature_f`).

- **Daytime comfort & focus**: **~68 – 74 &deg;F** (`20 – 23.3 &deg;C`)
- **Sleep quality**: **~65 – 68 &deg;F** (`18.3 – 20 &deg;C`) — cooler bedroom temperatures help your core body temperature drop for deeper sleep.
- **Why temperature & humidity move together**: Warmer air holds more moisture, so cooling a room down lowers its capacity and raises **relative humidity (% RH)** even though the actual amount of water in the air didn't change.
- **Hardware placement reminder**: Because the ESP32-S3 Feather generates a tiny amount of heat while running Wi-Fi, keep the SCD-40 breakout positioned a couple of inches away (not stacked directly on top of the Feather) so temperature readings stay true to the room.

---

## 6. Reading the Signals Together (Quick Diagnostic Playbook)

The real superpower of having **both** a CO<sub>2</sub> sensor and a laser PM sensor—plus an AI assistant that can look at 24-hour trends—is spotting **which** intervention actually fixes the problem:

| Pattern You See | Most Likely Cause | Right Action |
| :--- | :--- | :--- |
| **High CO<sub>2</sub> (&gt;1,000 ppm) + Low PM<sub>2.5</sub> (&le;9 &mu;g/m<sup>3</sup>)** | Closed room with people breathing; air is clean of dust/smoke, just stale. | **Open a window or interior door** for 10–15 minutes. *(Turning up a HEPA purifier won't lower CO<sub>2</sub>.)* |
| **Normal CO<sub>2</sub> (&lt;1,000 ppm) + Elevated PM<sub>2.5</sub> (&gt;9 &mu;g/m<sup>3</sup>)** | Indoor particulate source (recent cooking, candle, ultrasonic humidifier with tap water) or outdoor haze/smoke seeping in. | **Run a True HEPA air purifier** and identify the source. Check outdoor AQI *before* opening a window so you don't pull outdoor smoke inside. |
| **High CO<sub>2</sub> + High PM<sub>2.5</sub>** | Closed room *plus* indoor cooking/smoke, or sealed house during wildfire smoke. | If outdoor AQI is **Good**, open a window briefly *and* run HEPA. If outdoor AQI is **Poor**, keep windows shut and run HEPA on high. |
| **Sudden PM<sub>2.5</sub> spike every night at bedtime** | Bedroom ultrasonic humidifier running on tap water, or late-night cooking/candles. | Test turning the humidifier off (or switching to distilled water) and watch the 24-hour chart in your AI assistant. |
| **CO<sub>2</sub> climbs steadily from 11 PM to 7 AM** | Normal overnight buildup in a closed bedroom. | Try sleeping with the bedroom door slightly cracked or HVAC fan circulating, then compare your next morning's `get_air_quality_summary` peak! |
