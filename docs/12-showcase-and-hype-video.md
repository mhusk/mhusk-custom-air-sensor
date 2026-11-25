# Guide 12: Hardware Showcase Photos & Google Flow Hype Video Production

> **Visual showcase & AI filmmaking workflow** — Captures clean, privacy-safe hardware photos and UI screenshots for [`README.md`](../README.md), then turns them into a cohesive 35–45 second `16:9` hardware reveal hype video using **Google Flow** (**Veo 3 / 3.1** **Ingredients to Video** + **Frames to Video**).

---

## Part 1: Photo & Screenshot Shot List (For `README.md` + Google Flow)

Drop your raw photos and screenshots into the gitignored `local_media_raw/` directory using the exact base filenames below, then run `./scripts/prepare_media.sh` to automatically resize (`<= 1600px`), compress (`<= 600 KB`), and strip 100% of EXIF/GPS/XMP metadata into `docs/images/`.

### Hardware Photos (`16:9` Landscape — Shoot Horizontally!)

> [!TIP]
> **Why `16:9` with a clean background matters for Google Flow:**
> Google Flow's **Ingredients to Video** works best when the hero subject is crisp, well-lit, and separated from background clutter. Shoot in landscape (`16:9`), turn off harsh overhead ceiling lights, and use soft directional side lighting (window light or a warm desk lamp) so the matte 3D-printed contours and chamfered edges pop.

| Target Filename (in `local_media_raw/`) | Shot Angle & Framing | What It Shows | Used In |
| :--- | :--- | :--- | :--- |
| **`hero-enclosure-closed`** *(required)* | Front-left 3/4 angle, low eye-level on nightstand or desk (`16:9`) | Sleek closed 3D-printed hub, seamless front face, matte texture, clean surface | `README.md` hero + Flow `@HubClosed` (Scenes 1 & 5) |
| **`internals-open-lid`** *(required)* | 45° top-down with sliding lid removed and set neatly beside it (`16:9`) | Screwless ESP32-S3 Feather, SCD-40, PMSA003I, thermal baffles, coiled STEMMA QT cables | `README.md` gallery + Flow `@HubInternals` (Scene 2) |
| **`rear-vents-usbc`** *(required)* | Rear 3/4 close-up (`16:9`) | Split PMSA003I blue/black airflow grilles, solid LED-blocking wall, USB-C port | `README.md` hardware detail + Flow `@HubRear` (Scene 3) |
| **`hardware-scale`** *(optional)* | Wider room/nightstand context shot (`16:9`) | Low-profile footprint blending into a bedroom/desk setup | Optional `README.md` context / Flow reference |

### App & AI Screenshots (Privacy-Scrubbed!)

Before saving UI screenshots into `local_media_raw/`, check every frame against this **Public-Repo Privacy Checklist**:
- [ ] **Hide or crop the browser address bar** (do not expose your private Firebase Hosting `.web.app` domain if you keep it private).
- [ ] **No personal email address or account avatar** visible in the WorkOS header or AI chat sidebar.
- [ ] **No home street address, ZIP code, or exact GPS coordinates** visible in the Home Location drawer (the main dashboard outdoor card only displays generic conditions/AQI, which is safe!).

| Target Filename (in `local_media_raw/`) | What to Capture | Used In |
| :--- | :--- | :--- |
| **`dashboard-overview`** *(required)* | Live Web Dashboard showing room card (CO₂, PM₂.₅, AQI, Temp/Humidity), Outdoor Weather & AQI card, indoor-vs-outdoor delta strip, and 24h SVG trend charts | `README.md` gallery + Flow `@DashboardUI` (Scene 4) |
| **`dashboard-fleet-ota`** *(optional)* | **Fleet & Firmware** tab showing `v1.3.3` `Up to date` OTA status and published releases | `README.md` OTA highlight |
| **`ai-mcp-query`** *(required)* | Live **Gemini** or **Grok** chat answering *"How's the air quality in my room right now?"* via MCP | `README.md` gallery + Flow `@AIChatUI` (Scene 5) |

### Running the Media Prep & Privacy Check

```bash
# 1. Create staging folder (gitignored) and drop raw HEIC/JPG/PNG files inside
mkdir -p local_media_raw

# 2. Convert, resize (<= 1600px), compress (<= 600 KB), and strip 100% of EXIF/GPS metadata
./scripts/prepare_media.sh

# 3. Re-verify docs/images/ and confirm zero secrets/raw files are tracked
./scripts/prepare_media.sh --verify
./scripts/check-secrets.sh
```

---

## Part 2: Google Flow Setup & `@Ingredient` Upload Map

Before generating clips in **Google Flow** (using **Veo 3 / 3.1**, `16:9` Landscape), create a new project and upload the 5 prepared images from `docs/images/` as **Ingredients** (reference assets) using the exact short names below so you can reference them cleanly with `@` in your prompts:

| Google Flow `@Ingredient` Name | File to Upload (`docs/images/`) | Role in the Video |
| :--- | :--- | :--- |
| **`@HubClosed`** | [`docs/images/hero-enclosure-closed.jpg`](./images/hero-enclosure-closed.jpg) | Hero closed matte-ivory 3D-printed hub (Scenes 1, 2, 5) |
| **`@HubInternals`** | [`docs/images/internals-open-lid.jpg`](./images/internals-open-lid.jpg) | Open-lid engineering reveal: ESP32-S3, teal Plantower PMSA003I, SCD-40, coiled cables (Scene 2) |
| **`@HubRear`** | [`docs/images/rear-vents-usbc.jpg`](./images/rear-vents-usbc.jpg) | Rear USB-C & split airflow grilles with teal PMSA003I peeking through (Scene 3) |
| **`@DashboardUI`** | [`docs/images/dashboard-overview.png`](./images/dashboard-overview.png) | Dark-mode live telemetry, outdoor deltas & 24h SVG trend charts (Scene 4) |
| **`@AIChatUI`** | [`docs/images/ai-mcp-query.png`](./images/ai-mcp-query.png) | Live natural-language MCP query & room advice (Scene 5) |

> [!TIP]
> **Optional bonus asset:** You can also upload [`docs/images/hardware-scale.jpg`](./images/hardware-scale.jpg) as `@HubGlow` if you want a softer glowing-LED alternate for Scene 1 or Scene 5, and [`docs/images/dashboard-fleet-ota.png`](./images/dashboard-fleet-ota.png) as `@FleetUI` if you decide to add a 6th clip highlighting one-click SHA-256 Cloud OTA rollouts.

### Mode Selection Rule of Thumb
- Use **Ingredients to Video** when you want Google Flow to keep the exact matte-ivory hub design, teal sensor housing, or dark-mode UI while creating fresh cinematic camera movement and studio lighting.
- Use **Frames to Video (First / Last Frame)** for **Scene 2** (optional) if you want a hyper-controlled morph from `@HubClosed` as the opening frame into `@HubInternals` as the ending frame.

---

## Part 3: Google Flow Prompts (End-to-End Master Prompt + Scene-by-Scene Backup)

**Creative Direction:** Apple / Teenage Engineering industrial hardware reveal — **one locked studio environment** (matte dark-slate desk, soft warm-white key light from camera-left, cool teal rim light from camera-right, dark charcoal backdrop) and **one continuous 124 BPM minimalist electronic beat**.

> [!IMPORTANT]
> **Why one end-to-end prompt (or Flow's "Extend" chain)?**
> Generating 5 completely separate clips in Google Flow gives each clip a different background and a different music track. Starting from a single timestamped master prompt (or using Flow's **Extend** button from Clip 1) keeps the exact same desk, lighting, and music bed end-to-end.
>
> *Ingredient limit note:* If your Google Flow prompt box caps you at **3 `@Ingredients`** per generation, use the **3-Ingredient Master Prompt** (`@HubClosed`, `@HubInternals`, `@DashboardUI`). If your Flow workspace allows **5 `@Ingredients`** (or you paste into Flow's **AI Agent / Storyboard** planner), use the **Full 5-Ingredient End-to-End Prompt**.

---

### Option A1 (Recommended): True Single-Take ("Oner") Continuous Prompt — Zero Cuts, One Audio Track
- **Mode:** `Ingredients to Video` (paste directly into a single video generation—**no timestamp headers**, so Google Flow will NOT auto-split it into multiple clips!)
- **Attach Ingredients:** `@HubClosed`, `@HubInternals`, `@DashboardUI` *(cleanest 3-ingredient sweet spot)* — or add `@AIChatUI` if your Flow prompt box accepts 4+.

```text
Single unbroken continuous one-take camera shot with zero cuts, zero scene changes, and one continuous robotic gimbal motion in a dark minimalist Apple and Teenage Engineering-style studio. Everything takes place on one matte dark obsidian slate desk against a deep charcoal background, lit by a soft warm-white directional key light from camera-left and a subtle cool teal rim light from camera-right. The shot begins at a low, tight 85mm macro angle on @HubClosed resting motionless in the foreground on the dark slate desk as ultra-fine sunlit dust motes drift slowly through the warm left beam, while a frameless dark-glass monitor stands softly out of focus directly behind it on the same desk. In one uninterrupted fluid motion, the camera cranes smoothly upward and glides over @HubClosed as its matte-ivory top lid slides cleanly off-frame to expose the precision internals of @HubInternals—revealing the black ESP32-S3, metallic teal-blue Plantower sensor, black SCD-40, and twin loops of coiled black STEMMA QT cables inside the crisp white thermal baffles—then without ever cutting, the camera smoothly tilts upward and racks focus from the open hardware in the foreground onto the razor-sharp dark-glass monitor behind it displaying @DashboardUI with its glowing mint-teal CO2 and amber PM2.5 trend lines. Photorealistic commercial cinematography, silky smooth gimbal movement, subtle 35mm film grain. Audio: one continuous unbroken minimalist dark-electronic synth track building from a deep atmospheric sub-bass swell and soft glass chime into a crisp tactile lid-slide click and steady pulsing synth beat that resolves cleanly on a warm final chord.
```

> [!TIP]
> **Want to extend it to 16 seconds with `@AIChatUI` without breaking continuity?**
> Once the single-take clip above finishes, click the **`+` (Extend)** button on that clip in Google Flow's Scene timeline and use this single follow-up prompt so it continues seamlessly from the exact last frame and music track:
>
> ```text
> Seamless continuation of the exact same single-take shot, desk, lighting, and continuous minimalist dark-electronic synth track with zero cuts. The frameless dark-glass monitor smoothly transitions from @DashboardUI to @AIChatUI displaying a live air-quality answer, as the camera glides smoothly back and lowers into a calm hero framing that pulls focus back onto @HubClosed sitting quietly in the foreground on the dark slate desk with a faint diffused green LED glow under its matte-ivory lid, while the synth track resolves into one warm final chord and fades softly to silence.
> ```

---

### Option A2 (If Flow Caps You at 3 `@Ingredients`): 3-Ingredient End-to-End Master Prompt
- **Mode:** `Ingredients to Video`
- **Attach Ingredients:** `@HubClosed`, `@HubInternals`, `@DashboardUI`

```text
One continuous, seamless, ultra-sleek Apple and Teenage Engineering-style product reveal set entirely in ONE locked studio environment: a matte dark obsidian slate desk against a deep charcoal studio background, lit consistently throughout by a soft warm-white key light from camera-left and a subtle cool teal rim light from camera-right. Photorealistic 85mm macro cinema lens, crisp focus, zero background changes.

AUDIO (ONE UNBROKEN CONTINUOUS TRACK): A single cohesive 124 BPM minimalist dark-electronic synth pulse with clean tactile foley from start to finish—never changing music.

[0:00–0:02.5] Slow cinematic macro push-in on @HubClosed sitting motionless on the dark obsidian slate desk as faint sunlit dust motes drift across the warm left key light. Deep sub-bass swell and a single crisp chime.
[0:02.5–0:05] On the beat drop, the matte-ivory lid slides cleanly off @HubClosed to reveal @HubInternals on the exact same dark slate desk—a smooth overhead macro glide showcases the black ESP32-S3, metallic teal Plantower sensor, black SCD-40, and coiled black STEMMA QT cables inside the white thermal baffles. Tactile lid-slide click synced to the beat kicking in.
[0:05–0:08] The camera tilts smoothly up from the hardware on the exact same desk to a frameless dark-glass monitor right behind it displaying @DashboardUI in razor-sharp focus, glowing with mint-teal CO2 and amber PM2.5 telemetry curves, before pulling back slightly to frame both @HubClosed and @DashboardUI together as the single synth track resolves into a clean warm chord.
```

---

### Option B: Scene-by-Scene Prompts (For Flow's "Extend" Chain or Manual Editing)

> [!TIP]
> If an 8-second single generation feels too fast for all 5 beats, generate **Scene 1** first and then use Google Flow's **Extend** button (or paste the same locked environment block into each clip) so the desk and music carry forward seamlessly. Keep on-screen text short (2–4 words) or add crisp titles in post.

---

### Scene 1 (0:00 – 0:08) — The Hook: Invisible Air, Minimalist Hardware
- **Mode:** `Ingredients to Video`
- **Attach Ingredient:** `@HubClosed`
- **Optional On-Screen Title (post or overlay):** `YOU CAN'T FIX WHAT YOU CAN'T SEE.`

**Copy-Paste Google Flow Prompt:**
```text
Using @HubClosed, a sleek matte-ivory 3D-printed smart air quality hub resting motionless on a dark charcoal matte slate desk. Ultra-fine sunlit dust motes drift slowly through a soft beam of warm directional side light across the dark studio background, highlighting the rounded corners and precision vertical side vents of @HubClosed. Slow, deliberate cinematic dolly-in with a shallow depth of field (85mm macro lens), transitioning from moody silhouette to crisp product hero lighting. Minimalist Apple and Teenage Engineering commercial aesthetic, photorealistic, subtle 35mm film grain, clean reflections. Audio: deep, resonant sub-bass swell with soft atmospheric room tone and a single crisp minimalist glass chime as the hub comes into sharp focus.
```

---

### Scene 2 (0:08 – 0:16) — Zero Screws, All Signal (Internal Architecture Reveal)
- **Mode:** `Ingredients to Video` *(attach `@HubClosed` and `@HubInternals`)* — **OR** `Frames to Video` *(First Frame: `@HubClosed`, Last Frame: `@HubInternals`)*
- **Optional On-Screen Title:** `SOLDERLESS. SCREWLESS. 3D-PRINTED.`

**Copy-Paste Google Flow Prompt:**
```text
Seamless hardware reveal transitioning from @HubClosed to @HubInternals: the flush matte-ivory top lid slides smoothly off-frame to expose the precision internal layout of @HubInternals inside its thermally baffled white enclosure. Smooth overhead macro orbital sweep gliding closely over the black ESP32-S3 microcontroller, the metallic teal-blue Plantower particulate sensor, the compact black SCD-40 CO2 sensor, and the twin loops of glossy black STEMMA QT cables coiled neatly around two white spool posts. High-contrast studio rim lighting catches the metallic silver RF shield and anodized teal housing against clean matte white walls. Crisp industrial design teardown aesthetic, ultra-sharp macro focus, smooth gimbal motion. Audio: crisp tactile sliding plastic click followed by a tight, upbeat minimalist electronic percussion groove kicking in.
```

---

### Scene 3 (0:16 – 0:24) — Precision Airflow & Silent Sensing
- **Mode:** `Ingredients to Video`
- **Attach Ingredient:** `@HubRear`
- **Optional On-Screen Title:** `CO₂ · PM₂.₅ · TEMP · HUMIDITY · SILENT.`

**Copy-Paste Google Flow Prompt:**
```text
Extreme macro tracking shot gliding laterally across the rear face of @HubRear, showcasing the recessed USB-C port and the dual split vertical intake and exhaust grilles with the metallic teal-blue particulate sensor visible just behind the matte-ivory slots. Delicate, barely-visible wisps of illuminated air particles flow smoothly into the rear grille while a subtle, soft emerald-green status glow pulses once faintly through the matte top shell. Dramatic low-key studio lighting with cool cyan-teal rim highlights and soft shadows on a glossy dark surface. Photorealistic product cinematography, 100mm macro lens, silky 60fps slow-motion feel. Audio: sleek futuristic subtle air-whoosh foley synced with a clean rising synth arpeggio and steady modern electronic beat.
```

---

### Scene 4 (0:24 – 0:32) — Live Cloud Telemetry & Outdoor Deltas
- **Mode:** `Ingredients to Video`
- **Attach Ingredient:** `@DashboardUI`
- **Optional On-Screen Title:** `LIVE TELEMETRY. CLOUD OTA. ZERO SUBSCRIPTIONS.`

**Copy-Paste Google Flow Prompt:**
```text
Smooth match-cut into a sleek frameless dark-glass monitor floating in a dimly lit modern studio, displaying @DashboardUI in sharp focus. Gentle subtle parallax camera push-in at a slight 15-degree angle as the glowing mint-teal CO2 trend line and warm amber PM2.5 graph shimmer subtly with crisp dark-mode contrast against the deep charcoal interface. Soft ambient emerald and cyan screen glow reflects faintly off a dark desk surface below. Clean modern tech keynote aesthetic, razor-sharp UI clarity, steady cinematic camera movement without distortion. Audio: driving minimalist electronic beat with crisp, satisfying digital telemetry ticks.
```

---

### Scene 5 (0:32 – 0:40) — Ask Your Room Anything (MCP) + Hero Finale
- **Mode:** `Ingredients to Video`
- **Attach Ingredients:** `@AIChatUI` and `@HubClosed`
- **Optional On-Screen Title (final 3s end card in post):** `CUSTOM AIR SENSOR` / `ESP32-S3 · FIRESTORE · MCP · OPEN SOURCE`

**Copy-Paste Google Flow Prompt:**
```text
Starting on a crisp dark-mode glass screen displaying @AIChatUI in a quiet, softly lit modern bedroom workspace, the camera smoothly glides back and racks focus from the glowing AI conversation onto @HubClosed sitting peacefully on the minimalist desk beside it, bathed in warm evening ambient light with a gentle diffused green LED glow under its matte-ivory lid. Calm, confident cinematic pull-back, shallow depth of field, high-end industrial design film look, photorealistic, warm highlights and deep shadows. Audio: electronic beat resolves cleanly into a warm, triumphant ambient synth chord and a soft final chime that fades to silence.
```

---

## Part 4: Google Flow Assembly & Troubleshooting Notes

1. **Google Flow Real-World Lessons & Snags (Captured During Testing):**
   - **Auto-splitting on timestamps:** Including timestamp headers (`[0:00–0:02]`, `Scene 1`, `Cut to`) causes Google Flow to automatically chunk the prompt into separate clips inside a Scene—each with its own background and unrelated music track.
   - **Scene Editor edits one clip at a time:** The `"Describe how to edit this video..."` box in Flow's Scene Editor only applies to the currently selected clip, not the entire stitched timeline, so you cannot use it to unify music across multiple clips in one pass.
   - **Single-take duration limits:** Writing one continuous paragraph with zero timestamps successfully produces one unbroken shot, but Veo may still generate a short (~4-second) clip depending on model/duration settings—requiring `+` (**Extend**) passes to lengthen it.
   - **Practical takeaway:** Until you dial in Flow's **Extend** workflow, the cleanest and fastest production loop is to generate 3–4 short visual hero clips in Flow (ignoring the per-clip generated audio), then assemble them in iMovie, CapCut, or DaVinci Resolve under **one continuous royalty-free music track**.
2. **Preventing Enclosure Geometry Drift:**
   - If attaching 4–5 `@Ingredients` in one prompt causes Veo to blend or warp the enclosure vents, drop back to the **3-Ingredient Master Prompt (Option A2)** (`@HubClosed`, `@HubInternals`, `@DashboardUI`), which stays within Veo's tightest multi-ingredient sweet spot.
3. **Keeping UI Text Crisp in Scenes 4 & 5:**
   - If Veo slightly warps small numbers inside `@DashboardUI` or `@AIChatUI`, reduce camera motion speed in the prompt (e.g., change *"parallax push-in"* to *"very slow, nearly static subtle zoom"*), **or** drop the raw crisp PNG from `docs/images/dashboard-overview.png` / `docs/images/ai-mcp-query.png` as a clean 2-second cutaway inside Google Flow Scene Builder / CapCut / iMovie.
4. **Publishing & Linking in `README.md`:**
   - Keep the rendered `.mp4` out of Git (it's already ignored by `.gitignore`). Upload it to YouTube (Unlisted or Public), X, or drag-and-drop it directly into a GitHub Issue/PR comment to get a native GitHub-hosted video URL, then paste the link into the **Video Showcase** callout at the top of [`README.md`](../README.md).

