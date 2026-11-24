# Guide 10: Cloud Pull-Based OTA Updates & A/B Rollback

> **Built in Steps 16–19 of [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md)** — Introduces Layer 2 remote firmware management: a USB-aware `boot.py`, an immutable `code.py` auto-rollback bootloader, SHA-256 verified release manifests, an on-device pull-based OTA updater, and a Fleet & Firmware rollout panel in the web dashboard so you can update sensors sealed inside 3D-printed enclosures without touching USB.

---

## 1. Part 1: Safe Bootloader Split & A/B Rollback (Step 16)

### Why Split `boot.py`, `code.py`, and `app.py`?

When a sensor is mounted inside a 3D-printed enclosure on wall power across the house, pushing a broken Python file directly over `code.py` would stop the board from ever connecting to Wi-Fi again—forcing you to unscrew or pop open the enclosure and plug it into a Mac.

Splitting the firmware into three clear layers makes bricking an OTA update virtually impossible:

| File on `CIRCUITPY` | Updated Over OTA? | Responsibility |
| :--- | :---: | :--- |
| **`boot.py`** | **Never** (immutable) | Runs once at hard boot before USB initializes; decides whether flash `/` is writable by CircuitPython (wall power / OTA) or by your Mac (USB maintenance). |
| **`code.py`** | **Never** (immutable) | Minimal bootloader using **only** CircuitPython built-in modules. Handles automatic USB handoff, mid-swap self-healing, hardware watchdog guarding, boot-attempt counting, and automatic rollback of `*.py.bak` files if `app.py` crashes. |
| **`app.py`** (+ `aqi.py`, `firestore_client.py`) | **Yes** (Layer 2 OTA) | Full sensor polling loop (`v1.2.0`), US EPA AQI math, remote config polling, and Firestore publishing. Invokes `on_healthy()` after its first live publish to confirm the boot succeeded. |

```mermaid
flowchart TD
    PWR["Hard Boot / Power On"] --> BOOT["boot.py<br/>(Runs before USB enumeration)"]
    BOOT -->|"NVM USB flag == 1<br/>OR BOOT button held"| USB_RO["USB Maintenance Mode<br/>CIRCUITPY R/W on Mac<br/>/ read-only to Python"]
    BOOT -->|"Default (Wall Power / Boot 1)"| OTA_RW["OTA / Wall-Power Mode<br/>USB drive disabled<br/>/ read-write for Python"]

    USB_RO --> CODE["code.py<br/>(Immutable Bootloader)"]
    OTA_RW --> CODE

    CODE -->|"fs=rw AND<br/>supervisor.runtime.usb_connected"| HANDOFF["Write NVM USB_ONCE=1<br/>& microcontroller.reset()"]
    HANDOFF --> BOOT

    CODE -->|"app.py missing &<br/>app.py.bak exists"| ROLLBACK["Atomic Rollback<br/>*.py -> *.py.failed<br/>*.py.bak -> *.py<br/>NVM OTA_STATE=2 & reset"]
    CODE -->|"Pending OTA &<br/>attempts >= 2 (WDT hang)"| ROLLBACK

    CODE -->|"Import & run app.main(on_healthy)"| APP["app.py (v1.2.0)<br/>Sensors + Remote Config + Firestore"]
    APP -->|"First Firestore publish OK"| HEALTHY["on_healthy()<br/>Clear NVM PENDING & attempts=0"]
    APP -->|"Crash / SyntaxError / ImportError<br/>(fs=rw)"| COUNT["Write /boot_error.txt<br/>attempts += 1"]
    COUNT -->|"attempts < 2"| RETRY["Reset & retry once"]
    COUNT -->|"attempts >= 2 &<br/>.bak exists"| ROLLBACK
```

---

### How CircuitPython Flash Locking Works (and the `boot.py` USB Timing Catch-22)

CircuitPython stores `CIRCUITPY` on a standard FAT filesystem in internal SPI flash. Because FAT does not support concurrent writers, **only one side can have write access at a time**:
- **Default CircuitPython behavior:** Your Mac gets read-write access over USB, and CircuitPython code gets `readonly=True` (attempting to open a file for writing raises `OSError: [Errno 30] Read-only filesystem`).
- **OTA / Rollback requirement:** When running standalone on a wall charger, CircuitPython needs `storage.remount("/", readonly=False)` so `code.py` can rename `.bak` files and `ota_updater.py` can download new `.py` files.

#### The `boot.py` Timing Catch-22
A common CircuitPython trap is writing `if not supervisor.runtime.usb_connected: storage.remount("/", readonly=False)` directly inside `boot.py`. **That does not work:** `boot.py` executes *before* the ESP32-S3 USB stack initializes and enumerates with your computer, so `supervisor.runtime.usb_connected` is **always `False`** inside `boot.py`!

#### Our Solution: 1-Shot NVM Handoff + Zero "Disk Not Ejected Properly" Warnings
We solve this cleanly by coordinating [`firmware/boot.py`](../firmware/boot.py) and [`firmware/code.py`](../firmware/code.py) through a 4-byte header in ESP32-S3 Non-Volatile Memory (`microcontroller.nvm[0:4]`):

1. **On wall power (production, 99.9% of the time):**
   - `boot.py` sees no USB flag, calls `storage.disable_usb_drive()` and `storage.remount("/", readonly=False)`.
   - `code.py` checks `supervisor.runtime.usb_connected` for `1.5s`. Wall chargers (including USB-C PD bricks) only provide power and never perform USB data enumeration, so `usb_connected` stays `False`.
   - `code.py` launches `app.py` directly with **zero extra reboots** and **zero NVM writes**.
2. **When plugged into your Mac via USB-C (development / flashing):**
   - **Boot 1:** `boot.py` disables the USB mass-storage drive (`CIRCUITPY` is not presented yet) while keeping USB serial (`usb_cdc`) active, and mounts `/` read-write for Python.
   - `code.py` runs, sees `supervisor.runtime.usb_connected == True` within a fraction of a second, writes a one-shot `BOOT_MODE_USB_ONCE = 1` flag to NVM, and calls `microcontroller.reset()`.
   - **Boot 2 (~1.5s later):** `boot.py` sees `BOOT_MODE_USB_ONCE`, immediately clears it back to `0` (one-shot), and leaves `CIRCUITPY` enabled and writable by your Mac.
   - Because Boot 1 never mounted a USB disk, macOS mounts `CIRCUITPY` cleanly with **zero "Disk Not Ejected Properly" notifications**, and subsequent file saves trigger CircuitPython soft reloads (which do not re-run `boot.py`), keeping `CIRCUITPY` read-write on your Mac indefinitely.
3. **When unplugged from your Mac and moved back to wall power:**
   - Because `boot.py` already cleared `BOOT_MODE_USB_ONCE` back to `0` on Boot 2, the next cold boot on wall power automatically enters Python read-write OTA mode!

#### Shared 4-Byte NVM Layout (`microcontroller.nvm[0:4]`)

| Byte Index | Name | Values | Purpose |
| :---: | :--- | :--- | :--- |
| `0` | `NVM_MAGIC` | `0xA5` | Distinguishes initialized bootloader state from factory `0xFF` flash bytes |
| `1` | `NVM_BOOT_MODE` | `0` = OTA/wall power, `1` = one-shot USB host R/W, `2` = one-shot force OTA over USB | Coordinates `boot.py` ↔ `code.py` mount mode |
| `2` | `NVM_OTA_STATE` | `0` = healthy, `1` = pending OTA verification, `2` = rolled back | Tracks whether the active `app.py` is awaiting its first healthy Firestore publish |
| `3` | `NVM_BOOT_ATTEMPTS` | `0`–`255` | Counts consecutive failed boots; triggers rollback at `MAX_BOOT_ATTEMPTS = 2` |

> [!TIP]
> **Three ways to mount `CIRCUITPY` read-write on your Mac:**
> 1. **Automatic (default):** Simply plug the Feather into your Mac via USB-C and wait ~2 seconds for the 1-shot NVM handoff.
> 2. **Physical `BOOT` button failsafe:** Tap `RESET`, release it, and hold the onboard `BOOT` button (`board.BUTTON`) for ~1 second while `boot.py` runs.
> 3. **CircuitPython Safe Mode:** Tap `RESET` once, then tap `RESET` again while the NeoPixel flashes yellow to skip `boot.py` and `code.py` completely.

---

### Power-Loss-Safe A/B Rollback Mechanics

Whenever `code.py` rolls back a broken firmware release (either after `2` consecutive Python exceptions or after `2` hardware watchdog resets during pending OTA verification), it scans `/` for every `*.py.bak` file whose target is not in `PROTECTED_FILES` (`boot.py`, `code.py`, `settings.toml`) and restores them together:

```python
if _exists(failed_path):
    os.remove(failed_path)
if _exists(target_path):
    os.rename(target_path, failed_path)  # Preserve broken file for post-mortem
os.rename(bak_path, target_path)         # Promote known-good backup
```

- **Why multi-file `*.py.bak` rollback matters:** When Step 18 updates `app.py` and `firestore_client.py` together, rolling back all `*.py.bak` files as a group prevents version skew between modules.
- **Why this sequence is power-loss safe:** Even if wall power drops in the exact millisecond between moving `app.py` → `app.py.failed` and promoting `app.py.bak` → `app.py`, the next boot detects `not _exists("/app.py") and _exists("/app.py.bak")` and immediately finishes promoting `app.py.bak` → `app.py`.
- **Crash forensics:** Before resetting on wall power, `code.py` writes the latest traceback to `/boot_error.txt` (single overwrite so flash never fills) and preserves the failing script as `/app.py.failed`. Plugging the board back into a Mac later lets you read exactly what went wrong.

---

### Running the Step 16 Focused Validation

#### Part A: Automated Offline Simulation (Mac)
Run the local firmware test suite to verify syntax compilation plus all 12 `boot.py` and `code.py` scenarios (wall-power mount, one-shot USB handoff, physical `BOOT` button override, forced OTA-over-USB, 2-attempt crash rollback, `SyntaxError` rollback, WDT-hang rollback, mid-swap self-heal, pending-OTA health confirmation, and USB read-only developer mode):

```bash
python3 scripts/test_firmware_local.py
```

Confirm you see:
- `[PASS] EPA AQI tests passed ...`
- `[PASS] Firestore REST payload encoding tests passed.`
- `[PASS] Remote config decoding, clamping, reboot gating, and syntax tests passed.`
- `[PASS] Bootloader tests passed (boot.py modes, USB handoff, A/B rollback, WDT hang, mid-swap self-heal).`

#### Part B: Live Wall-Power Rollback Test on the ESP32-S3 Feather
1. Plug the Feather ESP32-S3 into your Mac via USB-C and copy the split bootloader files to `CIRCUITPY`:
   ```bash
   cp -X firmware/boot.py firmware/code.py firmware/app.py firmware/firestore_client.py firmware/aqi.py /Volumes/CIRCUITPY/
   ```
2. Verify normal USB boot first: check `/Volumes/CIRCUITPY/boot_out.txt` and confirm the board publishes a fresh `v1.2.0` reading to Firestore (visible on the Web Dashboard).
3. Stage the intentional crash test on `CIRCUITPY`:
   ```bash
   # Back up the known-good app.py as app.py.bak
   cp -X /Volumes/CIRCUITPY/app.py /Volumes/CIRCUITPY/app.py.bak

   # Replace app.py with a deliberately broken file that crashes on boot
   printf 'raise RuntimeError("Step 16 simulated boot crash")\n' > /Volumes/CIRCUITPY/app.py
   ```
   *(Over USB, `CIRCUITPY` is read-only to Python, so `code.py` will print the crash traceback to serial and wait cleanly without rolling back.)*
4. Eject `CIRCUITPY`, unplug the USB-C cable from your Mac, and plug the Feather into **wall power** (USB power adapter).
5. Watch what happens with **zero USB intervention**:
   - Within ~6–10 seconds, `code.py` catches the crash twice, moves the broken `app.py` to `app.py.failed`, writes `/boot_error.txt`, promotes `app.py.bak` → `app.py`, sets `NVM_OTA_STATE = 2`, and reboots.
   - The NeoPixel turns solid blue while connecting to Wi-Fi/NTP, then pulses green once as the restored `app.py` (`v1.2.0`) publishes a fresh room reading to Firestore!
6. Optional post-mortem inspection: plug the Feather back into your Mac via USB-C. Within ~2 seconds, `code.py` automatically hands off to `boot.py` and mounts `CIRCUITPY` read-write. Inspect `/Volumes/CIRCUITPY/boot_error.txt` (shows `"Step 16 simulated boot crash"`) and `/Volumes/CIRCUITPY/app.py.failed`, then delete those two leftover test artifacts if desired:
   ```bash
   cat /Volumes/CIRCUITPY/boot_error.txt
   rm -f /Volumes/CIRCUITPY/boot_error.txt /Volumes/CIRCUITPY/app.py.failed
   ```

> [!NOTE]
> **Live Hardware Verification (Step 16 Passed):** Staged a deliberately broken `app.py` alongside `app.py.bak` on the Adafruit Feather ESP32-S3 and moved to wall power. The immutable `code.py` bootloader detected the boot crash, automatically restored `app.py.bak` → `app.py`, rebooted, and resumed publishing live `v1.2.0` sensor readings to Firestore with zero USB intervention.

---

### Good to Know & Real-World Troubleshooting (Part 1)

> [!IMPORTANT]
> **Never rely on `supervisor.runtime.usb_connected` inside `boot.py`.**
> Because `boot.py` executes before CircuitPython initializes TinyUSB, `supervisor.runtime.usb_connected` is always `False` there. Always detect USB enumeration in `code.py` and hand off via a one-shot `microcontroller.nvm` flag to `boot.py`.

> [!WARNING]
> **CircuitPython FATFS `os.rename(src, dst)` fails with `Errno 17: File exists` if `dst` exists.**
> Unlike POSIX on macOS/Linux where `os.rename()` silently overwrites the destination, CircuitPython's FAT implementation refuses to overwrite an existing file. Always `os.rename(dst, dst + ".failed")` or `os.remove(dst)` before promoting a `.bak` or `.new` file.

> [!NOTE]
> **CircuitPython's `os` module does not include `os.path`.**
> Keep bootloader utilities free of `os.path.exists` / `os.path.join`—use `os.stat(path)` inside `try ... except OSError` and plain string path joining so the exact same code runs unmodified on both CircuitPython 10 and desktop CPython.

> [!CAUTION]
> **Do not hold the `BOOT` button *while* pressing `RESET`.**
> On ESP32-S3, holding GPIO0 (`BOOT`) low at the exact instant `RESET` is released puts the chip into Espressif ROM serial-download mode (appearing "dead" until you tap `RESET` again). To use the `BOOT` button failsafe, tap and **release** `RESET` first, then press `BOOT`—or simply let the automatic 2-second USB NVM handoff mount `CIRCUITPY` for you.

> [!TIP]
> **Testing OTA or rollback live over USB serial without unplugging (`BOOT_MODE_FORCE_OTA`).**
> If you ever want Python write access (`fs=rw`) *while* watching the USB serial console on your Mac, open the CircuitPython REPL (`Ctrl+C`) and run:
> ```python
> import microcontroller
> microcontroller.nvm[0:4] = bytes((0xA5, 2, 0, 0))
> microcontroller.reset()
> ```
> The board will reboot once with `CIRCUITPY` hidden and `/` writable by Python while keeping USB serial live. Because mode `2` is one-shot, the very next reset automatically returns to normal Mac-writable `CIRCUITPY` mode.

> [!NOTE]
> **Zero steady-state flash wear on `microcontroller.nvm`.**
> Both `boot.py` and `code.py` compare `bytes(nvm[0:4])` before writing and write all 4 bytes in a single atomic slice assignment (`nvm[0:4] = desired`). During normal 24/7 wall-power operation, `microcontroller.nvm` is **never written at all**.

---

## 2. Part 2: Checksummed Release Manifests, Artifact Hosting & Publish CLI (Step 17)

### Why Store `.py` Artifacts in a Firestore Subcollection?

Our complete CircuitPython application (`app.py`, `aqi.py`, `firestore_client.py`, plus `ota_updater.py` in Step 18) is roughly **55–75 KB** of plain UTF-8 Python source—well under Firestore's 1 MiB per-document limit. Hosting versioned payloads in a nested `firmware_releases/{version}/files/{filename}` subcollection keeps the entire OTA pipeline dead simple and low-memory on the ESP32-S3:

- **Zero extra Firebase services:** No Cloud Storage bucket to provision, no `storage.rules` to maintain, and no extra bucket URL in `settings.toml`.
- **Single TLS stack on the microcontroller:** The ESP32-S3 reuses the exact same `firestore.googleapis.com` REST API, pinned Google Trust Services (GTS) Root CA certificates, and Firebase Auth ID token already built into `firestore_client.py`.
- **Low ESP32-S3 RAM footprint:** The parent manifest (`firmware_releases/{version}`) is ~500 bytes, and each `.py` artifact lives in its own `files/{filename}` document (~3–35 KB), so the Feather downloads, hashes, and stages **one small file at a time**.
- **Atomic release publishing:** The publish CLI writes every `files/{filename}` document **and** the parent `firmware_releases/{version}` manifest in a single Firestore `WriteBatch`, so a polling sensor can never observe a half-published release.

```mermaid
flowchart LR
    CLI["publish:release CLI<br/>(Node/TS + firebase-admin)"] -->|"1. Validate & SHA-256 hash<br/>(blocks boot.py/code.py)<br/>Atomic WriteBatch"| REL[("firmware_releases/{version}<br/>Manifest + SHA-256 map")]
    CLI -->|"Same Atomic Batch"| FILES[("firmware_releases/{version}/files/{file.py}<br/>UTF-8 payload + sha256 + size_bytes")]
    CFG[("device_configs/{device_id}<br/>target_firmware_version")] -->|"2. Sensor GET (read-only)"| ESP["ESP32-S3 Sensor<br/>(Step 18 OTA Client)"]
    REL -->|"3. Sensor GET manifest"| ESP
    FILES -->|"4. Sensor GET one .py at a time<br/>& verify SHA-256"| ESP
```

---

### Cloud Data Model

#### A. Release Manifest: `firmware_releases/{version}`
Document ID `{version}` must match strict SemVer with an optional prerelease suffix (`^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]{0,19})?$`, e.g., `1.2.0` or `1.2.0-rc1`).

| Field | Firestore Type | Example | Purpose |
| :--- | :--- | :--- | :--- |
| `version` | `string` | `"1.2.0-rc1"` | Release version (matches document ID) |
| `min_bootloader_version` | `string` | `"1.0.0"` | Minimum compatible immutable `code.py` bootloader version |
| `notes` | `string` | `"Step 17 test release"` | Human-readable release summary (max 2,000 chars) |
| `file_count` | `integer` | `3` | Number of `.py` files included in this release |
| `total_size_bytes` | `integer` | `54819` | Combined UTF-8 byte length across all release files |
| `files` | `map` | `{ "app.py": { doc_id, sha256, size_bytes }, ... }` | Per-file SHA-256 hex digest and exact UTF-8 byte size |
| `created_at` | `timestamp` | RFC 3339 timestamp | Publication timestamp |
| `created_by` | `string` | `"publish-cli"` | Audit label identifying publisher |
| `git_sha` | `string \| null` | `"38598a5"` | Short Git commit SHA captured at publish time |
| `status` | `string` | `"active"` \| `"yanked"` | Marks whether a release is active or yanked from rollout |

#### B. Per-File Payload: `firmware_releases/{version}/files/{filename}`
Document ID `{filename}` must match `^[a-z][a-z0-9_]{0,31}\.py$` and is strictly denied for `boot.py` and `code.py` at **both** the CLI and `firestore.rules` layers.

| Field | Firestore Type | Purpose |
| :--- | :--- | :--- |
| `filename` | `string` | Target module name on `CIRCUITPY` (e.g., `"app.py"`) |
| `version` | `string` | Parent release version |
| `sha256` | `string` | 64-character lowercase hex SHA-256 of `content` encoded as UTF-8 bytes |
| `size_bytes` | `integer` | Exact UTF-8 byte length of `content` (max 512 KiB) |
| `encoding` | `string` | Always `"utf-8"` |
| `content` | `string` | Raw UTF-8 Python source text |
| `created_at` | `timestamp` | Publication timestamp |

#### C. Device Rollout Target: `device_configs/{device_id}`
Step 17 adds one optional field to `device_configs/{device_id}`:
- **`target_firmware_version`** (`string | null`, default `null`): When `null`, the sensor stays on its currently flashed firmware. When set to a SemVer version (e.g., `"1.3.0"`), Step 18's OTA client compares it against `app.FIRMWARE_VERSION` and pulls `firmware_releases/{target_firmware_version}`.
- Both `updateDeviceConfig()` and `requestDeviceReboot()` in [`functions/src/services/firestore.ts`](../functions/src/services/firestore.ts) preserve `target_firmware_version` atomically inside Firestore transactions so saving Layer 1 settings in the web dashboard never clears a pinned firmware target.

---

### Hardened Security Rules (`firestore.rules`)

| Path | Unauthenticated | Allowlisted Sensor (`isSensorDevice()`) | Admin SDK / Console |
| :--- | :---: | :---: | :---: |
| `firmware_releases/{version}` (`get`) | `403 DENIED` | `200 OK` (valid SemVer `{version}` only) | Full access |
| `firmware_releases` (`list`) | `403 DENIED` | `403 DENIED` | Full access |
| `firmware_releases/{version}/files/{fileId}` (`get`) | `403 DENIED` | `200 OK` (valid `.py`, blocks `boot.py` & `code.py`) | Full access |
| `firmware_releases/{version}/files` (`list`) | `403 DENIED` | `403 DENIED` | Full access |
| `firmware_releases/**` (`write`) | `403 DENIED` | `403 DENIED` | Full access |

`isFirmwareVersion()` on `devices/{deviceId}` was also updated to accept optional SemVer prerelease suffixes (like `1.2.0-rc1`) so test releases can report their version cleanly to `devices/{device_id}` during Step 18 staging.

---

### Publishing Releases with `publish:release`

The publish CLI lives in [`functions/src/scripts/publishRelease.ts`](../functions/src/scripts/publishRelease.ts) and reuses Node 22 + `firebase-admin` (zero Python `pip` dependencies).

#### 1. Dry-Run Preview (Zero Cloud Writes)
Preview the exact file list, byte sizes, and SHA-256 digests before touching Firestore:
```bash
npm --prefix functions run publish:release -- --dry-run
```

#### 2. Publish a Real or Staged Test Release
Because `publish:release` writes to Firestore via the Admin SDK, authenticate using any standard Admin path (`GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk.json`, `gcloud auth application-default login`, or `FIRESTORE_ACCESS_TOKEN=...`):

```bash
# Publish a standard release matching FIRMWARE_VERSION in firmware/app.py
GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk.json \
  npm --prefix functions run publish:release -- --notes "Release description"

# Publish a staged release candidate (differs from app.py's FIRMWARE_VERSION)
GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk.json \
  npm --prefix functions run publish:release -- \
  --version 1.2.0-rc1 \
  --allow-version-mismatch \
  --notes "Step 17 release pipeline validation"
```

Useful optional flags:
- `--force`: Overwrite an already-published version (by default, releases are immutable to prevent accidental silent mutation).
- `--set-target <device_id>`: Optionally pin `device_configs/<device_id>.target_firmware_version` in the same run (omitted by default so publishing and rollout stay decoupled).
- `--delete --version <semver>`: Atomically delete a test release and its `files/` subcollection.

---

### Running the Step 17 Focused Validation

1. **Deploy the updated security rules:**
   ```bash
   firebase deploy --only firestore:rules
   ```
2. **Run offline unit tests (SemVer, filename guards, SHA-256 bundling, protected-file rejection):**
   ```bash
   npm --prefix functions run verify:release
   ```
3. **Publish a test release (`1.2.0-rc1`) and run the 9-point live security & SHA-256 verification:**
   ```bash
   npm --prefix functions run publish:release -- \
     --version 1.2.0-rc1 --allow-version-mismatch --notes "Step 17 validation"

   npm --prefix functions run verify:release -- --live --version 1.2.0-rc1
   ```
   Confirm all 9 live checks pass:
   1. Unauthenticated `GET firmware_releases/1.2.0-rc1` → `403 PERMISSION_DENIED`
   2. Unauthenticated `GET .../files/app.py` → `403 PERMISSION_DENIED`
   3. Sensor-authenticated `GET firmware_releases/1.2.0-rc1` → `200 OK`
   4. Sensor-authenticated `LIST firmware_releases` → `403 PERMISSION_DENIED`
   5. Sensor-authenticated `LIST .../files` → `403 PERMISSION_DENIED`
   6. Sensor-authenticated `GET .../files/boot.py` → `403 PERMISSION_DENIED`
   7. Sensor fetches every `.py` artifact and verifies exact UTF-8 byte length + SHA-256 match against both the manifest and the file doc
   8. Sensor-authenticated `PATCH` on manifest → `403 PERMISSION_DENIED`
   9. Sensor-authenticated `DELETE` on artifact file → `403 PERMISSION_DENIED`

> [!NOTE]
> **Live Validation (Step 17 Passed):** Deployed `firestore.rules` cleanly with zero warnings, published `firmware_releases/1.2.0-rc1` (3 files, `54,819` bytes total) via `publish:release`, and passed all 6 offline unit checks, all 9 live Firestore REST security + SHA-256 verification checks in `verify:release --live`, and all 7 Dashboard API regression checks in `verify:api`.

---

### Good to Know & Real-World Troubleshooting (Part 2)

> [!TIP]
> **Working across multiple GCP projects (`GOOGLE_APPLICATION_CREDENTIALS` override).**
> If your shell exports `GOOGLE_APPLICATION_CREDENTIALS` pointing to a service account key for another Google Cloud project, `firebase-admin` prioritizes that key over your default ADC and fails with `PERMISSION_DENIED`. Clear it inline when publishing:
> ```bash
> GOOGLE_APPLICATION_CREDENTIALS= npm --prefix functions run publish:release -- --version 1.2.0-rc1 --allow-version-mismatch
> ```

> [!IMPORTANT]
> **UTF-8 round-trip verification prevents cross-platform SHA-256 mismatches.**
> Because Firestore stores `.py` payloads as UTF-8 strings (`stringValue`) and the ESP32-S3 hashes `content.encode("utf-8")`, `publishRelease.ts` verifies `Buffer.from(rawBytes.toString("utf8"), "utf8").equals(rawBytes)` before hashing. That guarantees the exact byte sequence read on macOS matches the byte sequence decoded from JSON on CircuitPython.

> [!TIP]
> **Decouple publishing from rollout.**
> Running `publish:release` writes `firmware_releases/{version}` without touching `device_configs/{device_id}` unless you explicitly pass `--set-target <device_id>`. This lets you upload and inspect a release safely before promoting it to one test board or your full fleet.

> [!WARNING]
> **Releases are immutable by default.**
> Re-running `publish:release` for an existing version fails intentionally unless you pass `--force`. Never overwrite a version that live sensors have already installed—always bump `FIRMWARE_VERSION` (e.g., `1.2.0` → `1.2.1`) so your fleet telemetry unambiguously shows which code each board is running.
