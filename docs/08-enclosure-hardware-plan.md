# Guide 08: 3D-Printed Enclosure Hardware Plan (Bambu Lab X1 Carbon & SpeakCAD)

> **Mechanical design specification & print guide** — Defines a 100% screwless, support-free, low-profile smart-home enclosure for the **Adafruit ESP32-S3 Feather (PID 5477)**, **SCD-40 (PID 5187)**, **PMSA003I (PID 4632)**, and **2× 300 mm STEMMA QT cables**, optimized for a bedroom nightstand or wall mount.

> [!TIP]
> A clean, copy-pasteable master prompt for generating the 3D CAD model in [SpeakCAD](https://speakcad.com/) is stored in [`enclosure/speakcad-prompt.txt`](../enclosure/speakcad-prompt.txt) and reproduced in [Section 6](#6-ready-to-paste-speakcad-prompt) below. If you are patching an existing v1 SpeakCAD model (`TD6H6L`), use the targeted delta prompt in [`enclosure/speakcad-fix-prompt.txt`](../enclosure/speakcad-fix-prompt.txt).

---

## 1. Design Requirements Summary

| Requirement | Specification |
| :--- | :--- |
| **Microcontroller** | Adafruit ESP32-S3 Feather (**PID 5477**), headerless, onboard PCB Wi-Fi antenna (`52.3 × 22.7 × 7.9 mm`; top-entry vertical STEMMA QT port measuring **~11.0 mm** total height with cable plugged in) |
| **Sensors** | Adafruit **SCD-40** (`25.5 × 22.8 × 7.7 mm`) + Adafruit **PMSA003I** (`51.0 × 35.5 × 13.6 mm`), both headerless |
| **Interconnects** | **2× 300 mm** STEMMA QT (JST SH) cables coiled internally (`Feather → SCD-40 → PMSA003I`) |
| **Power & Access** | Straight USB-C cable (rear exit); no battery; no external button holes (slide lid open for `RESET`/`BOOT`); completely solid top (zero bedroom LED glare) |
| **Placement** | Indoor master bedroom — sits flat on nightstand/dresser (with 4× recessed bumper pockets) **or** hangs flush on a wall (2× recessed blind keyholes) |
| **Assembly & Closure** | **100% screwless** internal PCB cradles + compliant snap-clips; **rear-entry sliding dovetail lid** |
| **Printer & Finish** | **Bambu Lab X1 Carbon** (`0.4 mm` nozzle), **100% support-free**, modern rounded smart-home hub look |

---

## 2. Exact External & Internal Dimensions

| Parameter | Dimension | Notes |
| :--- | :--- | :--- |
| **External Size (`W × D × H`)** | **128.0 × 84.0 × 26.0 mm** (`5.04" × 3.31" × 1.02"`) | Ultra-sleek low-profile smart-home hub silhouette |
| **Internal Cavity (`W × D × H`)** | **122.0 × 78.0 × 20.0 mm** | Fits all 3 boards + 11 mm Feather cable bend + 2× coiled 300 mm cables |
| **Outer Wall Thickness** | **3.0 mm** (all 4 walls) | Houses 45° sliding dovetail tracks cleanly |
| **Floor Thickness** | **3.0 mm** nominal (**5.4 mm** local keyhole boss) | Supports `1.0 mm` bumper recesses + enclosed keyholes |
| **Sliding Lid Thickness** | **3.0 mm** (flush top) | Solid top plate (zero upward light bleed) |
| **Outer Vertical Corner Radii** | **8.0 mm** fillet on all 4 vertical corners | Modern hub aesthetic; minimizes bed-corner warp |
| **Edge Chamfers** | **1.2 mm** bottom chamfer; **0.8 mm** top rim chamfer | Eliminates elephant's foot & sharp seams |

### Coordinate Reference
- **X-axis (`0 → 122.0 mm` internal):** Left → Right
- **Y-axis (`0 → 78.0 mm` internal):** Front (solid bedroom-facing wall) → Rear (USB-C exit, PMSA003I vents, sliding lid entry)
- **Z-axis (`0 → 20.0 mm` internal):** Inner floor (`Z_ext = 3.0 mm`) → Lid underside (`Z_ext = 23.0 mm`)

---

## 3. Component Layout & Screwless Mounting Strategy

### Top-Down Internal Floor Plan (`122.0 × 78.0 mm` Internal Cavity)

```text
                    FRONT WALL (Y = 0) — 100% Solid, Clean Face
   +-------------------------+-------------------------------------+------------------+
   |                         |  ZONE 4: 300mm CABLE COILING BAY    |  Clear Wi-Fi     |
 L |  ZONE 1: SCD-40         |  (56 × 38 mm)                       |  Antenna Zone    | R
 E |  (34 × 50 mm)           |    (O) Keyholes below (40 mm c-c)   |  (24.7 mm clear) | I
 F |  [22.8 × 25.5 mm PCB]   |        [Post]      [Post]           |                  | G
 T |  10.25mm front /        |     (X=58 & 80, Y=20 — clear path)  |  ZONE 3:         | H
   |  14.25mm rear bend room |                                     |  ESP32-S3        | T
 V |  <-- Left Louvers       | (Open 19mm)                         |  FEATHER (5477)  |
 E |  [14×10mm Side Notch]   +  X=36-55  +=== Cable Guard (55-92)==+  [22.7 × 52.3]   | V
 N |                         |                                     |  Top-entry JST   | E
 T +-------------------------+  ZONE 2: PMSA003I (56 × 38 mm)      |  (11mm measured; | N
 S |  Solid Rear Baffle      |  [51.0 × 35.5 mm PCB + Fan Box]     |   6mm headroom)  | T
   |  (Y = 50–52 mm)         |  [LED/PCB(L) | Blue(Mid) | Fan(R)]  |                  | S
   |  Rear-Left Pocket       |   Active JST #2 faces open X=36-55! |                  |
   +-------------------------+--(Solid LED)--[Blue]--|--[BlackFan]-+---[USB-C Port]---+
                    REAR WALL (Y = 78) — Lid Slides In From Here
```

### Verified Daisy-Chain Order & Fit-Tested PMSA003I Orientation
- **Why `ESP32-S3 Feather → SCD-40 → PMSA003I` is optimal:**
  - On the Adafruit PMSA003I breakout (PID 4632), when seated with its vented edge `1.0 mm` from the Rear wall (`Y_int = 77.0 mm`), reading Left → Right (`X_int = 38.5–89.5 mm`), the verified physical order is:
    1. **Left (`X_int = 38.5–51.5 mm`):** Exposed black PCB strip with the green power LED, unused rear STEMMA QT port #1, and active front-facing STEMMA QT port #2 (`X_int ≈ 46–51 mm`).
    2. **Middle (`X_int = 51.5–70.5 mm`):** Blue metal housing air port.
    3. **Right (`X_int = 70.5–89.5 mm`):** Black plastic fan housing.
  - Putting the **PMSA003I at the end of the I2C chain** lets us plug ONLY into its **inward-facing STEMMA QT port #2** (facing forward through the open `X_int = 36.0–55.0 mm` entry into the Cable Bay), so its fan + blue-housing ports sit `1.0 mm` against the Rear grilles with zero cable interference—**and** the solid Rear wall over the unused connector/PCB strip (`X_int = 36.0–52.5 mm`) **completely blocks the bright green power LED** from lighting up the bedroom!
  - Meanwhile, the **SCD-40** sits in the middle of the chain inside its isolated `34.0 × 50.0 mm` chamber (`22.8 mm` along X × `25.5 mm` along Y), giving **10.25 mm front / 14.25 mm rear bend clearance**, an `8.7 mm` right wire channel, and **one single low vertical baffle notch** (`X_int = 34–36 mm`, `Y_int = 26–40 mm`, `Z_int = 0–10 mm`) opening directly into the Cable Bay right beside the PMSA003I's STEMMA QT #2 port (zero cross-draft through the thermal chamber).
- **Dual-orientation thermal safety:**
  - **Tabletop:** SCD-40 (Far-Left) and ESP32-S3 (Far-Right) are separated by **> 65 mm** and **two full-height `2.0 mm` divider walls** (`19.4 mm` tall, stopping `0.6 mm` below the sliding lid underside).
  - **Wall-mounted (Rear/USB-C edge pointing down):** SCD-40 stays on the Left and ESP32-S3 stays on the Right—heat vents vertically out the Right wall and never rises into the SCD-40 chamber.

### Step-by-Step Internal Cable Routing & Assembly Order

Because I2C is a parallel bus, wire the chain as **`ESP32-S3 Feather → SCD-40 → PMSA003I`** so the **SCD-40 sits in the middle** (using both of its STEMMA QT ports) and the **PMSA003I sits at the end** (using **only its front/inward-facing STEMMA QT #2 port**, while its rear port facing the rear wall stays **unplugged**):

```text
[ESP32-S3 Feather] ──Cable #1──▶ [SCD-40 (Front + Rear ports)] ──Cable #2──▶ [PMSA003I (Front port ONLY)]
     (1 port)                         (middle of chain)                       (rear port stays EMPTY)
```

1. **Snap in all three boards (power unplugged):** Seat the **ESP32-S3 Feather** (Zone 3, USB-C toward rear), **PMSA003I** (Zone 2, black fan + blue casing `1.0 mm` from the rear grille, exposed PCB strip on the left toward Zone 1), and **SCD-40** (Zone 1, centered on the Left-wall louvers).
2. **Route Cable #1 (`Feather → SCD-40 Front port`):**
   - Plug into the Feather's top-entry STEMMA QT port and pass the cable through the **Feather divider notch** (`X_int = 92–94 mm`, `Y_int = 28–40 mm`) into Zone 4 (Cable Bay).
   - Coil excess slack neatly around the **two spool posts** (`X_int = 58 & 80 mm`, `Y_int = 20 mm`) underneath their flared retaining rims.
   - Pass the cable through the **SCD-40 vertical baffle notch** (`X_int = 34–36 mm`, `Y_int = 26–40 mm`), run it forward along the `8.7 mm` right wire channel inside Zone 1, and plug it into the **SCD-40 Front STEMMA QT port** (`Y_int ≈ 10.25 mm`).
3. **Route Cable #2 (`SCD-40 Rear port → PMSA003I Front port`):**
   - Plug into the **SCD-40 Rear STEMMA QT port** (`Y_int ≈ 35.75 mm`) and curve the wire gently inside the `14.25 mm` rear bend clearance (`Y_int = 35.75–50.0 mm`).
   - Exit through that **same SCD-40 vertical baffle notch** (`X_int = 34–36 mm`, `Y_int = 26–40 mm`) into the open `X_int = 36–55 mm` corridor.
   - Coil excess slack around the **spool posts** and plug straight into the **PMSA003I Front STEMMA QT #2 port** (`X_int ≈ 46–51 mm`, `Y_int = 41.5 mm`). Leave the PMSA003I's rear STEMMA QT #1 port completely empty against the solid rear LED-blocking wall.
4. **Slide the lid closed:** Confirm all cable loops sit below the `14 mm` spool post rims (`6 mm` clear under the lid) and slide the dovetail lid forward from the Rear wall until the rear detents click.

### 100% Screwless Board Retention
Because the lid slides horizontally across the top, all three PCBs are secured to the base floor with **printed perimeter cradles (`0.35 mm` side clearance) + compliant snap-clips** so the sliding lid never contacts components or cables:

| Board | Footprint | Cradle Elevation (`Z_int`) | Tallest Stack (`Z_int`) | Headroom Under Lid (`20.0 mm`) | Screwless Retention Details |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **ESP32-S3 Feather (PID 5477)** | `22.7 × 52.3 × 7.9 mm` *(~`11.0 mm` w/ cable)* | **3.0 mm** | **14.0 mm** *(measured `11.0 mm` w/ connected cable)* | **6.0 mm** | 2× diagonal `1.8 mm` pegs (`17.78 × 45.72 mm` spacing) + 2× side snap-clips (`1.2 mm` thick, `0.6 mm` lip) + **solid front shoulder backstop** at `Y = 24.5 mm` to absorb USB-C plug insertion force |
| **PMSA003I (PID 4632)** | `51.0 × 35.5 × 13.6 mm` | **3.0 mm** | **16.6 mm** | **3.4 mm** | 2× diagonal `2.0 mm` pegs + corner locating ribs + 2× front compliant snap-clips (`1.2 mm` thick, positioned at `X_int = 57–63` & `67–73 mm`—completely clear of the `X_int = 36–55 mm` STEMMA QT #2 entry). Rear vent face sits `1.0 mm` from the Rear exterior wall |
| **SCD-40 (PID 5187)** | `22.8 × 25.5 × 7.7 mm` *(oriented along Y)* | **4.0 mm** *(centered in side louvers)* | **11.7 mm** | **8.3 mm** | Recessed perimeter pocket (`23.5 × 26.2 mm`, `2.5 mm` rim walls, widened `11.5 mm` front & rear notches at `X_int = 9.0–20.5 mm` for the two STEMMA QT plugs) + 2× left/right compliant snap-clips |
| **2× 300 mm STEMMA QT Cables** | ~`3.5 × 1.2 mm` ribbon | Floor (`Z_int = 2.4 mm` over keyhole boss) | ~`13.4 mm` coiled | **6.6 mm** | 2× smooth round spool posts (`8.0 mm` dia, top at `Z_int = 14.0 mm`, `22.0 mm` c-c at `X = 58` & `80 mm`, `Y = 20 mm`) with 45° flared `1.2 mm` retaining rims |

---

## 4. Cutouts, Vents, Keyholes & Clearances

1. **USB-C Cutout (Rear Wall, `Y_int = 78.0 mm`):**
   - Centered on Feather axis (`X_int = 108.0 mm` / `X_ext = 111.0 mm`), vertical center at `Z_int = 6.5 mm` (`Z_ext = 9.5 mm`).
   - Through-opening: **11.5 mm W × 6.8 mm H** rounded stadium slot.
   - Exterior plug-boot recess: **15.0 mm W × 9.8 mm H × 1.2 mm deep** so chunky straight overmolded USB-C plugs seat fully.
2. **Zone 1 — SCD-40 Louvers (Left Wall, `X_int = 0 mm`):**
   - Spans `Y_int = 6.0–40.0 mm`, `Z_int = 4.0–16.0 mm`.
   - Vertical capsule slots: **2.5 mm W × 12.0 mm H**, **2.0 mm** rib spacing (centered directly on the SCD-40 sensor module).
3. **Zone 2 — PMSA003I Fit-Tested Rear Grille (Rear Wall, `Y_int = 78.0 mm`):**
   - Aligned directly to the PMSA003I sitting at `X_int = 38.5–89.5 mm` with its vent face at `Y_int = 77.0 mm`:
     - **Solid LED-Blocking Wall (`X_int = 36.0–52.5 mm`):** Unvented solid Rear wall completely hiding the exposed breakout PCB strip, unused rear STEMMA QT #1 port, and bright green power LED.
     - **Blue Metal Air-Port Grille (`X_int = 53.0–68.5 mm`, `Z_int = 4.5–16.0 mm`):** Vertical capsule slots (`3.0 mm` W × `11.5 mm` H, `1.5 mm` ribs).
     - **Solid Air-Separator Rib (`X_int = 68.5–72.5 mm`):** `4.0 mm` solid vertical wall centered on the seam (`X_int ≈ 70.5 mm`) between the blue metal housing and black plastic fan housing to block exhaust-to-intake recirculation.
     - **Black Plastic Fan Grille (`X_int = 72.5–88.5 mm`, `Z_int = 4.5–16.0 mm`):** Vertical capsule slots (`3.0 mm` W × `11.5 mm` H, `1.5 mm` ribs) aligned directly over the black fan housing.
4. **Zone 3 — ESP32-S3 Convection Vents (Right Wall, `X_int = 122.0 mm`):**
   - Spans `Y_int = 24.0–70.0 mm`, `Z_int = 5.0–17.0 mm`.
   - Vertical capsule slots: **2.5 mm W × 12.0 mm H**, **2.0 mm** rib spacing.
5. **Internal Cable Pass-Throughs:**
   - **SCD-40 Vertical Thermal Baffle (`X = 34.0–36.0 mm`):** Single bottom-flush notch **14.0 mm W × 10.0 mm H** (`Y_int = 26.0–40.0 mm`, `Z_int = 0–10.0 mm`) routing both SCD-40 STEMMA QT cables directly into the Cable Bay right beside the PMSA003I's open front port. The rear baffle (`Y = 50.0–52.0 mm`) is completely solid for zero thermal cross-draft and `14.25 mm` of rear wire-bend clearance.
   - **ESP32-S3 Divider (`X = 92.0–94.0 mm`):** Single bottom-flush notch **12.0 mm W × 10.0 mm H** (`Y_int = 28.0–40.0 mm`, `Z_int = 0–10.0 mm`).
   - **PMSA003I Cable Guard (`Y = 38.0–40.0 mm`, `X_int = 55.0–92.0 mm`):** `10.0 mm` tall barrier behind the blue/black sensor housing only, leaving a wide-open **19.0 mm entry (`X_int = 36.0–55.0 mm`)** directly in front of the PMSA003I's inward-facing STEMMA QT port #2 (`X_int ≈ 46–51 mm`).
6. **Underside Bumper Recesses (Exterior Bottom Face, `Z_ext = 0`):**
   - 4× circular recesses: **10.5 mm dia × 1.0 mm deep**, centered `12.0 mm` inward from each outer corner (fits standard `10 mm` / `3/8"` stick-on clear silicone pads for grip and micro-fan vibration isolation).
7. **Underside Wall-Mount Keyholes (Exterior Bottom Face, `Z_ext = 0`):**
   - **2× symmetric blind keyholes** spaced **40.0 mm apart** (`X_ext = 47.0 mm` & `87.0 mm`, `Y_ext = 17.0 mm`) housed inside a locally thickened **5.4 mm floor boss** under the cable bay (`X_int = 38–90 mm`, `Y_int = 2–26 mm`).
   - Sized for `#6` / `#8` pan-head drywall/wood screws: **9.0 mm** entry circle → **4.2 mm W × 8.0 mm L** upward slot (toward Front `Y = 0`), **1.6 mm** outer lip, **2.6 mm** head cavity, **45° self-supporting roof**, and **1.2 mm** solid inner ceiling.

---

## 5. Lid Closure, Print Orientation & Bambu Lab X1C Settings

### Rear-Entry Sliding Dovetail Lid
- **45° dovetail tracks** recessed `1.5 mm` deep into the top `3.0 mm` of the Left and Right outer walls (`Z_ext = 23.0–26.0 mm`).
- Rear outer wall terminates `3.0 mm` lower (`Z_ext = 23.0 mm`) so the `3.0 mm` lid slides cleanly from Rear (`Y = 84 mm`) to Front (`Y = 0`) and seats flush against the solid Front wall.
- **Locking detents:** Subtle `0.4 mm` hemispherical bumps on the rear inner rails matching shallow lid dimples so the lid stays locked even when wall-mounted, plus a `14.0 × 3.0 × 0.8 mm` recessed rear thumb grip.

### Print Orientation & Recommended Slicer Profile (Bambu Studio)

| Setting | Value | Rationale |
| :--- | :--- | :--- |
| **Base Orientation** | Flat upright (bottom face on build plate) | 100% support-free; vertical vents & 45° dovetails bridge cleanly |
| **Lid Orientation** | Upside down (top face on PEI plate) | Smooth matte bedroom finish; 45° bevels point upward with zero overhangs |
| **Recommended Filament** | **Bambu Matte PLA** *(Charcoal / Ash Gray / Ivory)* | Best modern hub finish, zero warp, hides layer lines |
| **Optional Filament** | **Matte PETG / PETG-HF** | Extra flex for compliant snap-clips & higher thermal margin |
| **Nozzle & Layer Height** | **0.4 mm nozzle**, **0.20 mm** (or `0.16 mm`) layers | Crisp dovetails with minimal post-processing |
| **Walls & Infill** | **3 wall loops**, **15% Gyroid**, **Arachne** wall generator | Strong clips and solid thin divider walls |
| **Supports / Brim** | **Supports: OFF**, **Brim: OFF** | Self-supporting geometry; `8 mm` corner radii resist warp |
| **Design Tolerances** | Dovetail: **0.20 mm/side** (`0.15 mm` Z); Cradles: **0.35 mm/side** | Tuned for X1 Carbon accuracy straight off the build plate |

---

## 6. Ready-to-Paste SpeakCAD Prompt

The exact text below is also saved standalone in [`enclosure/speakcad-prompt.txt`](../enclosure/speakcad-prompt.txt).

> [!NOTE]
> If SpeakCAD simplifies any internal details in a single generation pass, iterate in 2 quick follow-ups: first ask it to verify the internal thermal baffles & PCB cradles, then verify the rear/side vents & bottom keyholes.

```text
Design a two-piece, 100% support-free, screwless 3D-printable electronics enclosure for an indoor smart-home air quality monitor (Bambu Lab X1 Carbon, 0.4 mm nozzle, printed side-by-side: base upright, lid upside down).

OVERALL SHELL & AESTHETIC:
- Modern minimalist smart-home hub style, low-profile horizontal box.
- External dimensions: 128.0 mm wide (X) x 84.0 mm deep (Y) x 26.0 mm tall (Z), with outer Front-Left-Bottom corner at (0, 0, 0).
- Internal cavity dimensions: 122.0 mm wide (X) x 78.0 mm deep (Y) x 20.0 mm tall (Z), spanning external X = 3.0 to 125.0 mm, Y = 3.0 to 81.0 mm, Z = 3.0 to 23.0 mm.
- Uniform 3.0 mm outer wall thickness on all four sides and 3.0 mm nominal floor thickness.
- 8.0 mm vertical fillet radius on all four outer vertical corners; 1.2 mm chamfer along the bottom outer perimeter; 0.8 mm chamfer along the top outer perimeter.
- Front wall (Y = 0) is completely solid and seamless with no holes, vents, or seams.

SLIDING DOVETAIL LID (REAR-ENTRY):
- Separate 3.0 mm thick completely solid top lid (no LED holes or vents) that sits flush with the top rim (Z_ext = 23.0 to 26.0 mm).
- Slides horizontally from the rear wall (Y_ext = 84.0 mm) toward the front wall (Y_ext = 0) along 45-degree dovetail tracks recessed 1.5 mm deep into the top 3.0 mm of the left and right outer walls.
- Rear outer wall ends 3.0 mm lower (at Z_ext = 23.0 mm) to create the rear slide-in entry; front outer wall remains full 26.0 mm height as a flush end-stop.
- Include 0.20 mm lateral sliding clearance on each angled dovetail face and 0.15 mm vertical clearance.
- Add small 0.4 mm locking detent bumps near the rear of the inner side rails with matching shallow dimples on the lid edges, plus a 14.0 mm wide x 3.0 mm deep x 0.8 mm recessed thumb-grip groove near the rear top edge of the lid.

INTERNAL THREE-ZONE LAYOUT & THERMAL BAFFLES (internal cavity coordinates: origin at inner Front-Left corner X=0, Y=0, Z=0 on inner floor, so X_ext = X+3, Y_ext = Y+3, Z_ext = Z+3):
1. Zone 1 — SCD-40 Chamber (Front-Left, X = 0 to 34.0 mm, Y = 0 to 50.0 mm):
   - Isolated by two 2.0 mm thick full-height thermal baffle walls (19.4 mm tall, stopping 0.6 mm below the lid):
     - Vertical baffle wall at X = 34.0–36.0 mm spanning Y = 0–52.0 mm, with ONE bottom-flush cable pass-through notch 14.0 mm wide x 10.0 mm tall at Y = 26.0–40.0 mm (Z = 0–10.0 mm) opening directly into Zone 4 (Cable Bay) ahead of the PMSA003I.
     - Solid rear baffle wall at Y = 50.0–52.0 mm spanning X = 0–36.0 mm (completely solid with NO rear notch, leaving 14.25 mm of wire-bend clearance behind the SCD-40 while preventing cross-drafts).
   - Inside this zone, build a raised screwless PCB cradle (4.0 mm floor elevation) for a 22.8 mm (X) x 25.5 mm (Y) board with 0.35 mm side clearance (23.5 x 26.2 mm pocket, 2.5 mm tall perimeter lip), positioned at X = 2.5 to 25.3 mm and Y = 10.25 to 35.75 mm (leaving 10.25 mm plug clearance in front, 14.25 mm wire-bend clearance behind, and an 8.7 mm wire channel along the right side X = 25.3–34.0 mm).
   - On both the front (Y ≈ 9.5 mm) and rear (Y ≈ 36.5 mm) cradle perimeter lips, cut open cable notches 11.5 mm wide spanning X = 9.0 to 20.5 mm (flush down to the 4.0 mm cradle pad) so both STEMMA QT plugs insert cleanly without rubbing the rim. Add two 1.2 mm thick compliant snap-clips (0.6 mm overhang lip) along the left and right edges.
2. Zone 4 — 300 mm Cable Coiling Bay (Front-Center, X = 36.0 to 92.0 mm, Y = 0 to 38.0 mm):
   - Add a 2.4 mm raised flat internal floor reinforcement boss (total floor thickness 5.4 mm) covering X = 38.0 to 90.0 mm, Y = 2.0 to 26.0 mm to enclose the underside wall-mount keyholes.
   - Add two vertical cylindrical cable-wrap spool posts (8.0 mm shaft diameter, top at internal Z = 14.0 mm, spaced 22.0 mm center-to-center at X = 58.0 mm and X = 80.0 mm, Y = 20.0 mm) with 45-degree flared 1.2 mm top retaining rims (10.4 mm outer top diameter). Positioning them at X = 58 & 80 mm, Y = 20 mm keeps a wide-open 16.5 mm corridor in front of the PMSA003I STEMMA QT port and outside the SCD-40 vertical baffle notch.
3. Zone 2 — PMSA003I Particulate Sensor Chamber (Rear-Center, X = 36.0 to 92.0 mm, Y = 40.0 to 78.0 mm):
   - Add a 2.0 mm thick x 10.0 mm tall cable-guard barrier wall along Y = 38.0–40.0 mm spanning ONLY X = 55.0 to 92.0 mm (behind the blue/black sensor housing). Leave X = 36.0 to 55.0 mm COMPLETELY OPEN (19.0 mm open cable entry) directly in front of the PMSA003I's front-facing STEMMA QT #2 connector (which sits on the left exposed-PCB strip around X = 46–51 mm).
   - Build a screwless cradle (3.0 mm corner pad elevation) for a 51.0 mm (X) x 35.5 mm (Y) Adafruit PMSA003I breakout positioned at X = 38.5 to 89.5 mm, Y = 41.5 to 77.0 mm (1.0 mm from the rear vented wall), with two 2.0 mm diameter diagonal locator pegs (3.0 mm tall above pads), low corner locating ribs (0.35 mm clearance), and two 1.2 mm thick compliant snap-clips on the front edge positioned at X = 57.0–63.0 mm and X = 67.0–73.0 mm (completely clear of the X = 36.0–55.0 mm STEMMA QT #2 port entry).
   - Verified board orientation (looking top-down with Front Y=0 at top, Rear Y=78 at bottom, X increasing Left to Right): X = 38.5–51.5 mm is the exposed black PCB strip (green LED + unused rear STEMMA QT #1 + active front STEMMA QT #2); X = 51.5–70.5 mm is the blue metal housing port; X = 70.5–89.5 mm is the black plastic fan housing.
4. Zone 3 — ESP32-S3 Feather Chamber (Far-Right, X = 94.0 to 122.0 mm, Y = 0 to 78.0 mm):
   - Separated from Zones 2 and 4 by a 2.0 mm thick, 19.4 mm tall vertical divider wall at X = 92.0–94.0 mm (Y = 0 to 78.0 mm) with one bottom-flush 12.0 mm wide x 10.0 mm tall cable pass-through notch at Y = 28.0–40.0 mm (Z = 0–10.0 mm).
   - Build a screwless cradle (3.0 mm pad elevation) for a 22.7 x 52.3 mm board oriented front-to-back at X = 96.65 to 119.35 mm, Y = 24.7 to 77.0 mm (leaving 24.7 mm clear space in front for the PCB Wi-Fi antenna and 1.0 mm to the rear wall for the USB-C port).
   - Include two 1.8 mm diameter diagonal locator pegs spaced 17.78 x 45.72 mm, two 1.2 mm thick compliant side snap-clips, and a solid 3.0 mm tall rear-facing shoulder backstop at Y = 24.5 mm to brace the board against USB-C insertion force.
   - Keep at least 17.0 mm clear vertical space above the board's 3.0 mm cradle pads (no lid ribs; accommodates the 11.0 mm connected top-entry cable height with 6.0 mm margin).

EXTERNAL CUTOUTS, VENTS & UNDERSIDE FEATURES:
- USB-C Cutout (Rear Wall): Centered at internal X = 108.0 mm, internal Z = 6.5 mm. Rounded stadium through-slot 11.5 mm wide x 6.8 mm tall, with an outer recessed plug-boot pocket 15.0 mm wide x 9.8 mm tall x 1.2 mm deep on the outside rear face.
- Left Wall Louvers (SCD-40): Vertical capsule vents spanning internal Y = 6.0–40.0 mm, internal Z = 4.0–16.0 mm (2.5 mm wide slots, 2.0 mm rib spacing, centered on the SCD-40 sensor).
- Rear Wall Grille (PMSA003I — solid LED shield on left, split blue/black airflow grilles on center-right):
  - Solid LED-blocking section (aligned to exposed PCB strip & green power LED): Leave internal X = 36.0–52.5 mm (X_ext = 39.0–55.5 mm) COMPLETELY SOLID and unvented.
  - Blue-housing air grille (aligned to blue metal port): Vertical capsule vents spanning internal X = 53.0–68.5 mm (X_ext = 56.0–71.5 mm), internal Z = 4.5–16.0 mm (3.0 mm wide slots, 1.5 mm rib spacing).
  - Solid air-separator rib (aligned to blue/black housing seam at X = 70.5 mm): 4.0 mm wide solid vertical wall at internal X = 68.5–72.5 mm (X_ext = 71.5–75.5 mm) between the blue and black housings to prevent air recirculation.
  - Black fan grille (aligned to black plastic fan housing): Vertical capsule vents spanning internal X = 72.5–88.5 mm (X_ext = 75.5–91.5 mm), internal Z = 4.5–16.0 mm (3.0 mm wide slots, 1.5 mm rib spacing).
- Right Wall Vents (ESP32-S3 Heat Escape): Vertical capsule vents spanning internal Y = 24.0–70.0 mm, internal Z = 5.0–17.0 mm (2.5 mm wide slots, 2.0 mm rib spacing).
- Bottom Bumper Recesses (Exterior Bottom Face, Z_ext = 0): Four 10.5 mm diameter x 1.0 mm deep circular recesses centered 12.0 mm inward from each outer corner.
- Bottom Wall-Mount Keyholes (Exterior Bottom Face, Z_ext = 0): Two recessed blind keyhole slots spaced 40.0 mm apart horizontally at external X = 47.0 mm and 87.0 mm, external Y = 17.0 mm (aligned inside the reinforced 5.4 mm floor boss). Each keyhole has a 9.0 mm entry hole, a 4.2 mm wide x 8.0 mm long upward-pointing slot (toward Y = 0), a 1.6 mm thick outer lip, a 2.6 mm internal head pocket, and a 45-degree self-supporting ceiling leaving a solid 1.2 mm inner top seal.
```

---

## 7. Open Risks & Test-Print Verification Checklist

Before committing to the full print, verify these four items:

1. **15-Minute Tolerance Coupon Test (Recommended):** In Bambu Studio, use the **Cut tool** to print a small `25 mm` slice containing the rear sliding dovetail joint + one `1.2 mm` compliant snap-clip in your actual filament:
   - Adjust dovetail clearance to `0.25 mm` if tight or `0.15 mm` if loose.
   - Confirm Matte PLA snap-clips flex without cracking (if stiff, thin to `1.0 mm` or switch to Matte PETG).
2. **PMSA003I Chain Order Assembly Check:** Wire your I2C chain as **`Feather → SCD-40 → PMSA003I`**, plugging Cable #2 into the PMSA003I's **front/inward-facing STEMMA QT #2 port** (facing the open `X_int = 36–55 mm` Cable Bay corridor) and leaving its **rear STEMMA QT #1 port unplugged** against the solid LED-blocking rear wall so the fan + blue intake edge sits cleanly `1.0 mm` from the Rear grille.
3. **SCD-40 Power-LED Light Bleed:** While the PMSA003I's green power LED is now fully shielded by the solid rear wall, the SCD-40 breakout also has a small green power LED facing its Left-wall louvers. If you notice any faint green glow on the adjacent wall at night, cover it with a tiny dot of black electrical tape or cut the `LED` jumper pad on the back of the SCD-40.
4. **PMSA003I Micro-Fan Acoustic Isolation:** Listen in a quiet bedroom once snapped in. With `3.4 mm` of vertical headroom above the PMSA003I, adding tiny `1 mm` foam/silicone tape dots onto its four cradle pads easily eliminates any resonant plastic buzz.

---

## 8. Enclosure Commissioning & Calibration Log

Once the final v2 print finishes and all three boards are snapped inside, let the unit run in its target spot for **60 minutes** with the lid closed, then record the measurements below and apply `temperature_offset_c` / `altitude_m` / `led_enabled` via `device_configs/feather-s3-01` (see [Guide 09: Remote Configuration & Dashboard](./09-remote-config-and-dashboard.md)):

| Commissioning Check | Status | Measured / Final Value | Notes |
| :--- | :--- | :--- | :--- |
| **Mechanical Fit & Lid Action** | ✅ Completed | Clean fit | Feather, SCD-40, and PMSA003I seated cleanly inside the v2 enclosure with sliding dovetail lid closed |
| **Enclosed Thermal Offset (`temperature_offset_c`)** | ✅ Completed | **`6.8 °C`** *(was `4.0 °C`)* | `+2.8 °C` enclosed self-heating shift measured with the lid closed; applied live in SCD-40 RAM via `device_configs/feather-s3-01` |
| **Site Elevation (`altitude_m`)** | ✅ Configured | Configured privately in `device_configs` | Local elevation applied for SCD-40 CO₂ pressure compensation (kept private outside Git) |
| **Dark-Room LED Light Bleed** | ✅ Completed *(Note)* | Faint bleed through white lid | With a white PLA case, onboard breakout power LEDs bleed faintly through the `3.0 mm` top lid in a dark room. Mute the Feather NeoPixel in the dashboard (`led_enabled: false`) and either print in darker opaque filament (e.g., Charcoal Matte PLA) or cover breakout power LEDs with small squares of black electrical tape |
| **PMSA003I Fan Acoustics** | ✅ Completed | Inaudible | No noticeable fan noise inside the printed enclosure at normal bedroom distance |
