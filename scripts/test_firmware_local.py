#!/usr/bin/env python3
"""Local macOS/Linux validation test for firmware modules (`aqi.py`, `firestore_client.py`, `boot.py`, `code.py`, `app.py`).

Usage:
  # 1. Offline unit checks only (EPA AQI math, Firestore encoding/decoding, remote config logic):
  python3 scripts/test_firmware_local.py

  # 2. Offline checks + live remote config fetch (`device_configs/{device_id}`):
  python3 scripts/test_firmware_local.py --fetch-config

  # 3. Full live publish check (offline checks + live Firestore publish using firmware/settings.toml):
  python3 scripts/test_firmware_local.py --publish
"""

import argparse
import os
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIRMWARE_DIR = os.path.join(REPO_ROOT, "firmware")
sys.path.insert(0, FIRMWARE_DIR)

import aqi  # noqa: E402
import firestore_client  # noqa: E402
import ota_updater  # noqa: E402


def load_toml_settings(path):
    """Load key-value pairs from a CircuitPython settings.toml file."""
    try:
        import tomllib

        with open(path, "rb") as fh:
            return tomllib.load(fh)
    except ImportError:
        # Simple fallback for Python < 3.11
        settings = {}
        with open(path, "r", encoding="utf-8") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip()
                if (val.startswith('"') and val.endswith('"')) or (
                    val.startswith("'") and val.endswith("'")
                ):
                    settings[key] = val[1:-1]
                else:
                    try:
                        settings[key] = int(val)
                    except ValueError:
                        settings[key] = val
        return settings


def run_aqi_tests():
    """Verify US EPA 2024 PM2.5 and PM10 AQI calculations against reference values."""
    # (pm25, expected_aqi, expected_category)
    pm25_cases = [
        (-1.0, 0, "Good"),
        (0.0, 0, "Good"),
        (4.5, 25, "Good"),
        (9.0, 50, "Good"),
        (9.09, 50, "Good"),  # Truncated to 9.0 per EPA rule
        (9.1, 51, "Moderate"),
        (22.2, 75, "Moderate"),
        (35.4, 100, "Moderate"),
        (35.5, 101, "Unhealthy for Sensitive Groups"),
        (55.4, 150, "Unhealthy for Sensitive Groups"),
        (55.5, 151, "Unhealthy"),
        (125.4, 200, "Unhealthy"),
        (125.5, 201, "Very Unhealthy"),
        (225.4, 300, "Very Unhealthy"),
        (225.5, 301, "Hazardous"),
        (325.4, 500, "Hazardous"),
        (500.0, 500, "Hazardous"),  # Clamped to 500 for Firestore rules
    ]

    for pm25, expected_aqi, expected_cat in pm25_cases:
        actual_aqi, actual_cat = aqi.calculate_aqi(pm25)
        assert actual_aqi == expected_aqi, (
            f"PM2.5={pm25}: expected AQI {expected_aqi}, got {actual_aqi}"
        )
        assert actual_cat == expected_cat, (
            f"PM2.5={pm25}: expected category {expected_cat!r}, got {actual_cat!r}"
        )

    # (pm10, expected_aqi)
    pm10_cases = [
        (0, 0),
        (54, 50),
        (54.9, 50),  # Truncated to integer 54 per EPA rule
        (55, 51),
        (154, 100),
        (155, 101),
        (254, 150),
        (255, 151),
        (354, 200),
        (355, 201),
        (424, 300),
        (425, 301),
        (504, 400),
        (505, 401),
        (604, 500),
        (900, 500),  # Clamped to 500
    ]

    for pm10, expected_aqi in pm10_cases:
        actual_aqi = aqi.pm10_to_aqi(pm10)
        assert actual_aqi == expected_aqi, (
            f"PM10={pm10}: expected AQI {expected_aqi}, got {actual_aqi}"
        )

    # Combined AQI takes the higher sub-index (PM10 dominates here: 154 -> 100 vs PM2.5 5.0 -> 28)
    combined_aqi, combined_cat = aqi.calculate_aqi(5.0, 154)
    assert (combined_aqi, combined_cat) == (100, "Moderate"), (
        f"Combined AQI mismatch: got {(combined_aqi, combined_cat)}"
    )

    print(
        f"[PASS] EPA AQI tests passed ({len(pm25_cases)} PM2.5 cases, "
        f"{len(pm10_cases)} PM10 cases, 1 combined case)."
    )


def run_encoding_tests():
    """Verify Firestore REST document builders and typed value encoders."""
    ts = firestore_client.format_utc_timestamp()
    aqi_val, aqi_cat = aqi.calculate_aqi(6, 11)
    reading = firestore_client.build_reading_document(
        device_id="feather-s3-01",
        location="home-office",
        timestamp=ts,
        co2_ppm=642,
        temperature_c=22.4,
        temperature_f=72.3,
        humidity_percent=44.8,
        pm1_0_ug_m3=3,
        pm2_5_ug_m3=6,
        pm10_0_ug_m3=11,
        aqi_us=aqi_val,
        aqi_category=aqi_cat,
        particles_0_3um=810,
        particles_0_5um=225,
        particles_1_0um=42,
        particles_2_5um=4,
        particles_5_0um=1,
        particles_10_0um=0,
    )
    fields = firestore_client.encode_firestore_fields(
        reading, timestamp_fields=("timestamp",)
    )
    assert len(fields) == 18, f"Expected 18 reading fields, got {len(fields)}"
    assert fields["timestamp"] == {"timestampValue": ts}
    assert fields["co2_ppm"] == {"integerValue": "642"}
    assert fields["temperature_c"] == {"doubleValue": 22.4}
    assert fields["aqi_category"] == {"stringValue": "Good"}

    device_doc = firestore_client.build_device_status_document(
        device_id="feather-s3-01",
        location="home-office",
        last_seen_at=ts,
        firmware_version="1.0.0",
        sensors=["SCD-40", "PMSA003I"],
        reporting_interval_seconds=300,
        reading=reading,
    )
    device_fields = firestore_client.encode_firestore_fields(
        device_doc, timestamp_fields=("last_seen_at",)
    )
    assert len(device_fields) == 7, f"Expected 7 device fields, got {len(device_fields)}"
    assert device_fields["last_seen_at"] == {"timestampValue": ts}
    assert device_fields["sensors"] == {
        "arrayValue": {
            "values": [{"stringValue": "SCD-40"}, {"stringValue": "PMSA003I"}]
        }
    }
    latest_fields = device_fields["latest_reading"]["mapValue"]["fields"]
    assert len(latest_fields) == 6, (
        f"Expected 6 latest_reading fields, got {len(latest_fields)}"
    )

    # Ensure bool is encoded as booleanValue, not integerValue
    assert firestore_client.encode_firestore_value(True) == {"booleanValue": True}

    # Verify v1.1 optional remote-config status fields on devices/{device_id}
    device_doc_v11 = firestore_client.build_device_status_document(
        device_id="feather-s3-01",
        location="master-bedroom",
        last_seen_at=ts,
        firmware_version="1.1.0",
        sensors=["SCD-40", "PMSA003I"],
        reporting_interval_seconds=300,
        reading=reading,
        config_version=2,
        temperature_offset_c=5.5,
        altitude_m=150,
        led_enabled=False,
    )
    device_fields_v11 = firestore_client.encode_firestore_fields(
        device_doc_v11, timestamp_fields=("last_seen_at",)
    )
    assert len(device_fields_v11) == 11, (
        f"Expected 11 device fields with remote config metadata, got {len(device_fields_v11)}"
    )
    assert device_fields_v11["config_version"] == {"integerValue": "2"}
    assert device_fields_v11["temperature_offset_c"] == {"doubleValue": 5.5}
    assert device_fields_v11["altitude_m"] == {"integerValue": "150"}
    assert device_fields_v11["led_enabled"] == {"booleanValue": False}

    print("[PASS] Firestore REST payload encoding tests passed.")


def run_remote_config_tests():
    """Verify Firestore value decoding, remote config normalization, and reboot gating."""
    # 1. Decode Firestore REST API field types
    raw_fields = {
        "device_id": {"stringValue": "feather-s3-01"},
        "location": {"stringValue": "master-bedroom"},
        "reporting_interval_seconds": {"integerValue": "120"},
        "temperature_offset_c": {"doubleValue": 5.25},
        "altitude_m": {"integerValue": "240"},
        "led_enabled": {"booleanValue": False},
        "config_version": {"integerValue": "3"},
        "reboot_requested_at": {"nullValue": None},
        "updated_at": {"timestampValue": "2026-11-24T14:00:00Z"},
        "tags": {"arrayValue": {"values": [{"stringValue": "bedroom"}]}},
    }
    decoded = firestore_client.decode_firestore_fields(raw_fields)
    assert decoded["location"] == "master-bedroom"
    assert decoded["reporting_interval_seconds"] == 120
    assert decoded["temperature_offset_c"] == 5.25
    assert decoded["altitude_m"] == 240
    assert decoded["led_enabled"] is False
    assert decoded["config_version"] == 3
    assert decoded["reboot_requested_at"] is None
    assert decoded["updated_at"] == "2026-11-24T14:00:00Z"
    assert decoded["tags"] == ["bedroom"]

    defaults = {
        "location": "home-office",
        "reporting_interval_seconds": 300,
        "temperature_offset_c": 4.0,
        "altitude_m": 0,
        "led_enabled": True,
    }

    # 2. Missing cloud doc (None / HTTP 404) falls back cleanly to local defaults (v0)
    fallback = firestore_client.normalize_device_config(None, defaults)
    assert fallback == {
        "location": "home-office",
        "reporting_interval_seconds": 300,
        "temperature_offset_c": 4.0,
        "altitude_m": 0,
        "led_enabled": True,
        "config_version": 0,
        "reboot_requested_at": None,
        "target_firmware_version": None,
    }

    # 3. Valid cloud config overrides defaults cleanly
    applied = firestore_client.normalize_device_config(decoded, defaults)
    assert applied["location"] == "master-bedroom"
    assert applied["reporting_interval_seconds"] == 120
    assert applied["temperature_offset_c"] == 5.25
    assert applied["altitude_m"] == 240
    assert applied["led_enabled"] is False
    assert applied["config_version"] == 3
    assert applied["reboot_requested_at"] is None

    # 4. Malformed / out-of-range cloud values are safely clamped or ignored
    malformed = {
        "location": "bad room name!!",
        "reporting_interval_seconds": 5,  # below 60s min -> clamped to 60
        "temperature_offset_c": 99.9,  # above 20C max -> clamped to 20.0
        "altitude_m": -50,  # below 0 -> clamped to 0
        "led_enabled": "yes",  # non-bool -> fallback to default True
        "config_version": True,  # bool is subclass of int -> must be rejected -> defaults to 1
        "reboot_requested_at": "not-a-timestamp",
    }
    safe = firestore_client.normalize_device_config(malformed, defaults)
    assert safe["location"] == "home-office"
    assert safe["reporting_interval_seconds"] == 60
    assert safe["temperature_offset_c"] == 20.0
    assert safe["altitude_m"] == 0
    assert safe["led_enabled"] is True
    assert safe["config_version"] == 1
    assert safe["reboot_requested_at"] is None

    # 5. Pure-Python RFC 3339 UTC parser matches Unix epoch exactly (including leap years)
    assert firestore_client.parse_utc_timestamp_epoch("1970-01-01T00:00:00Z") == 0
    assert firestore_client.parse_utc_timestamp_epoch("2024-02-29T12:30:45Z") == 1709209845
    assert firestore_client.parse_utc_timestamp_epoch("2026-11-24T13:52:00.123456Z") == 1795528320
    assert firestore_client.parse_utc_timestamp_epoch("invalid") is None

    # 6. One-shot reboot gating prevents infinite reboot loops
    boot_epoch = firestore_client.parse_utc_timestamp_epoch("2026-11-24T14:00:00Z")
    now_epoch = firestore_client.parse_utc_timestamp_epoch("2026-11-24T14:05:00Z")

    # Request older than or equal to boot_epoch -> MUST NOT reboot
    assert not firestore_client.should_trigger_reboot(
        "2026-11-24T13:59:59Z", boot_epoch, now_epoch
    )
    assert not firestore_client.should_trigger_reboot(
        "2026-11-24T14:00:00Z", boot_epoch, now_epoch
    )
    # Request newer than boot_epoch and within max_age -> MUST reboot
    assert firestore_client.should_trigger_reboot(
        "2026-11-24T14:02:00Z", boot_epoch, now_epoch
    )
    # Request older than max_age (30m) -> MUST NOT reboot
    later_now = firestore_client.parse_utc_timestamp_epoch("2026-11-24T15:00:00Z")
    assert not firestore_client.should_trigger_reboot(
        "2026-11-24T14:02:00Z", boot_epoch, later_now, max_age_seconds=1800
    )
    # Null request or unsynced boot_epoch -> MUST NOT reboot
    assert not firestore_client.should_trigger_reboot(None, boot_epoch, now_epoch)
    assert not firestore_client.should_trigger_reboot(
        "2026-11-24T14:02:00Z", None, now_epoch
    )

    # 7. Verify firmware/boot.py, firmware/code.py, and firmware/app.py compile cleanly
    import py_compile

    for filename in ("boot.py", "code.py", "app.py"):
        py_compile.compile(os.path.join(FIRMWARE_DIR, filename), doraise=True)

    print("[PASS] Remote config decoding, clamping, reboot gating, and syntax tests passed.")


def run_bootloader_tests():
    """Simulate boot.py and code.py (USB handoff, WDT hang, crash rollback, self-heal)."""
    import importlib.util
    import tempfile
    import types

    class _FakeMount:
        def __init__(self, readonly=True):
            self.readonly = readonly

    class _FakeDigitalInOut:
        def __init__(self, pin):
            self.pin = pin
            self.value = pin["pressed_high"]
            self.deinitialized = False

        def switch_to_input(self, pull=None):
            pass

        def deinit(self):
            self.deinitialized = True

    class _FakeWatchdog:
        def __init__(self):
            self.timeout = None
            self.mode = None
            self.feeds = 0

        def feed(self):
            self.feeds += 1

    def _make_hw_env(nvm_bytes=None, button_pressed=False, usb_connected=False, fs_readonly=False):
        nvm = bytearray(nvm_bytes if nvm_bytes is not None else [0xFF] * 16)
        state = {
            "nvm": nvm,
            "usb_drive_disabled": False,
            "remount_calls": [],
            "resets": 0,
            "mount": _FakeMount(readonly=fs_readonly),
            "wdt": _FakeWatchdog(),
        }

        board_mod = types.ModuleType("board")
        board_mod.BUTTON = {"pressed_high": not button_pressed}

        digitalio_mod = types.ModuleType("digitalio")
        digitalio_mod.DigitalInOut = _FakeDigitalInOut
        digitalio_mod.Pull = types.SimpleNamespace(UP="UP")

        storage_mod = types.ModuleType("storage")

        def _disable_usb():
            state["usb_drive_disabled"] = True

        def _remount(path, readonly=True):
            state["remount_calls"].append((path, readonly))
            state["mount"].readonly = readonly

        storage_mod.disable_usb_drive = _disable_usb
        storage_mod.remount = _remount
        storage_mod.getmount = lambda path="/": state["mount"]

        supervisor_mod = types.ModuleType("supervisor")
        supervisor_mod.runtime = types.SimpleNamespace(usb_connected=usb_connected)

        microcontroller_mod = types.ModuleType("microcontroller")
        microcontroller_mod.nvm = nvm
        microcontroller_mod.watchdog = state["wdt"]

        def _reset():
            state["resets"] += 1

        microcontroller_mod.reset = _reset

        watchdog_mod = types.ModuleType("watchdog")
        watchdog_mod.WatchDogMode = types.SimpleNamespace(RESET="RESET")

        modules = {
            "board": board_mod,
            "digitalio": digitalio_mod,
            "storage": storage_mod,
            "supervisor": supervisor_mod,
            "microcontroller": microcontroller_mod,
            "watchdog": watchdog_mod,
        }
        return state, modules

    def _load_fresh(module_name, path, injected_modules):
        saved = {}
        for k, v in injected_modules.items():
            saved[k] = sys.modules.get(k)
            sys.modules[k] = v
        try:
            spec = importlib.util.spec_from_file_location(module_name, path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
        finally:
            for k, old in saved.items():
                if old is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = old

    boot_path = os.path.join(FIRMWARE_DIR, "boot.py")
    code_path = os.path.join(FIRMWARE_DIR, "code.py")

    # 1. boot.py: uninitialized NVM (0xFF) on wall power -> Python R/W OTA mode
    st, mods = _make_hw_env(nvm_bytes=[0xFF] * 8, button_pressed=False)
    boot_mod = _load_fresh("_test_boot_1", boot_path, mods)
    assert boot_mod.configure_filesystem() == "python_rw"
    assert st["usb_drive_disabled"] is True
    assert st["remount_calls"] == [("/", False)]
    assert st["mount"].readonly is False

    # 2. boot.py: one-shot USB handoff flag -> USB host R/W, clears flag & preserves ota_state
    st, mods = _make_hw_env(nvm_bytes=[0xA5, 1, 2, 0, 0, 0, 0, 0])
    boot_mod = _load_fresh("_test_boot_2", boot_path, mods)
    assert boot_mod.configure_filesystem() == "usb_host"
    assert st["usb_drive_disabled"] is False
    assert st["remount_calls"] == []
    assert list(st["nvm"][0:4]) == [0xA5, 0, 2, 0]

    # 3. boot.py: physical BOOT button held -> USB host R/W even on uninitialized NVM
    st, mods = _make_hw_env(nvm_bytes=[0xFF] * 8, button_pressed=True)
    boot_mod = _load_fresh("_test_boot_3", boot_path, mods)
    assert boot_mod.configure_filesystem() == "usb_host"
    assert st["usb_drive_disabled"] is False

    # 4. boot.py: BOOT_MODE_FORCE_OTA -> Python R/W & leaves flag=2 for code.py to consume
    st, mods = _make_hw_env(nvm_bytes=[0xA5, 2, 0, 0, 0, 0, 0, 0])
    boot_mod = _load_fresh("_test_boot_4", boot_path, mods)
    assert boot_mod.configure_filesystem() == "python_rw"
    assert list(st["nvm"][0:4]) == [0xA5, 2, 0, 0]

    # 5. code.py: USB host detected while `/` is Python R/W -> sets one-shot USB flag & resets
    st, mods = _make_hw_env(nvm_bytes=[0xA5, 0, 0, 0], usb_connected=True, fs_readonly=False)
    code_mod = _load_fresh("_test_code_usb", code_path, mods)
    code_mod.USB_DETECT_TIMEOUT_SECONDS = 0.0
    code_mod.time = types.SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda s: None)
    assert code_mod.boot_main("/") == "switched_to_usb"
    assert list(st["nvm"][0:4]) == [0xA5, 1, 0, 0]
    assert st["resets"] == 1

    # 6. code.py: Step 16 wall-power crash -> 2 attempts -> atomic .bak rollback -> healthy recovery
    with tempfile.TemporaryDirectory() as tmpdir:
        with open(os.path.join(tmpdir, "app.py"), "w", encoding="utf-8") as fh:
            fh.write('raise RuntimeError("simulated broken OTA app")\n')
        with open(os.path.join(tmpdir, "app.py.bak"), "w", encoding="utf-8") as fh:
            fh.write(
                "SUPPORTS_HEALTH_CALLBACK = True\n"
                "def main(on_healthy=None):\n"
                "    if on_healthy is not None:\n"
                "        on_healthy()\n"
                "    raise KeyboardInterrupt()\n"
            )
        with open(os.path.join(tmpdir, "aqi.py"), "w", encoding="utf-8") as fh:
            fh.write("VERSION = 'broken'\n")
        with open(os.path.join(tmpdir, "aqi.py.bak"), "w", encoding="utf-8") as fh:
            fh.write("VERSION = 'good'\n")
        with open(os.path.join(tmpdir, "code.py.bak"), "w", encoding="utf-8") as fh:
            fh.write("# protected file backup must never be restored\n")

        st, mods = _make_hw_env(nvm_bytes=[0xA5, 0, 0, 0], usb_connected=False, fs_readonly=False)

        def _run_boot():
            sys.modules.pop("app", None)
            sys.path.insert(0, tmpdir)
            try:
                cm = _load_fresh("_test_code_rb", code_path, mods)
                cm.USB_DETECT_TIMEOUT_SECONDS = 0.0
                cm.time = types.SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda s: None)
                return cm.boot_main(tmpdir)
            finally:
                sys.path.remove(tmpdir)
                sys.modules.pop("app", None)

        # Attempt 1: crash recorded, attempts incremented to 1, reset to retry
        assert _run_boot() == "retry_reset"
        assert list(st["nvm"][0:4]) == [0xA5, 0, 0, 1]
        assert st["resets"] == 1
        assert os.path.exists(os.path.join(tmpdir, "boot_error.txt"))
        with open(os.path.join(tmpdir, "boot_error.txt"), "r", encoding="utf-8") as fh:
            assert "simulated broken OTA app" in fh.read()

        # Attempt 2: hits MAX_BOOT_ATTEMPTS=2 -> restores app.py & aqi.py, ignores code.py.bak
        assert _run_boot() == "rolled_back"
        assert list(st["nvm"][0:4]) == [0xA5, 0, 2, 0]
        assert st["resets"] == 2
        assert os.path.exists(os.path.join(tmpdir, "app.py.failed"))
        assert not os.path.exists(os.path.join(tmpdir, "app.py.bak"))
        assert os.path.exists(os.path.join(tmpdir, "code.py.bak"))
        assert not os.path.exists(os.path.join(tmpdir, "code.py"))
        with open(os.path.join(tmpdir, "aqi.py"), "r", encoding="utf-8") as fh:
            assert "good" in fh.read()

        # Boot 3: restored app.py runs cleanly (KeyboardInterrupt passes through cleanly)
        try:
            _run_boot()
            raise AssertionError("Expected KeyboardInterrupt from stub healthy app.py")
        except KeyboardInterrupt:
            pass
        assert list(st["nvm"][0:4]) == [0xA5, 0, 2, 0]

    # 7. code.py: pending OTA watchdog hang (attempts already >= MAX_BOOT_ATTEMPTS) -> immediate rollback
    with tempfile.TemporaryDirectory() as tmpdir:
        with open(os.path.join(tmpdir, "app.py"), "w", encoding="utf-8") as fh:
            fh.write("while True:\n    pass\n")
        with open(os.path.join(tmpdir, "app.py.bak"), "w", encoding="utf-8") as fh:
            fh.write("def main(): pass\n")
        st, mods = _make_hw_env(nvm_bytes=[0xA5, 0, 1, 2], usb_connected=False, fs_readonly=False)
        cm = _load_fresh("_test_code_wdt", code_path, mods)
        cm.USB_DETECT_TIMEOUT_SECONDS = 0.0
        cm.time = types.SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda s: None)
        assert cm.boot_main(tmpdir) == "rolled_back"
        assert list(st["nvm"][0:4]) == [0xA5, 0, 2, 0]
        assert not os.path.exists(os.path.join(tmpdir, "app.py.bak"))

    # 8. code.py: power-loss mid-swap self-heal (app.py missing, app.py.bak present)
    with tempfile.TemporaryDirectory() as tmpdir:
        with open(os.path.join(tmpdir, "app.py.bak"), "w", encoding="utf-8") as fh:
            fh.write("def main(): pass\n")
        st, mods = _make_hw_env(nvm_bytes=[0xA5, 0, 0, 0], usb_connected=False, fs_readonly=False)
        cm = _load_fresh("_test_code_heal", code_path, mods)
        cm.USB_DETECT_TIMEOUT_SECONDS = 0.0
        cm.time = types.SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda s: None)
        assert cm.boot_main(tmpdir) == "rolled_back"
        assert os.path.exists(os.path.join(tmpdir, "app.py"))
        assert not os.path.exists(os.path.join(tmpdir, "app.py.bak"))

    # 9. code.py: pending OTA healthy confirmation clears OTA_STATE_PENDING -> OTA_STATE_HEALTHY
    with tempfile.TemporaryDirectory() as tmpdir:
        with open(os.path.join(tmpdir, "app.py"), "w", encoding="utf-8") as fh:
            fh.write(
                "SUPPORTS_HEALTH_CALLBACK = True\n"
                "def main(on_healthy=None):\n"
                "    on_healthy()\n"
                "    raise KeyboardInterrupt()\n"
            )
        st, mods = _make_hw_env(nvm_bytes=[0xA5, 0, 1, 0], usb_connected=False, fs_readonly=False)
        sys.modules.pop("app", None)
        sys.path.insert(0, tmpdir)
        try:
            cm = _load_fresh("_test_code_ok", code_path, mods)
            cm.USB_DETECT_TIMEOUT_SECONDS = 0.0
            cm.time = types.SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda s: None)
            try:
                cm.boot_main(tmpdir)
                raise AssertionError("Expected KeyboardInterrupt")
            except KeyboardInterrupt:
                pass
        finally:
            sys.path.remove(tmpdir)
            sys.modules.pop("app", None)
        assert st["wdt"].mode == "RESET"
        assert list(st["nvm"][0:4]) == [0xA5, 0, 0, 0]

    # 10. code.py: USB read-only mode crash does NOT touch flash or reboot-loop
    with tempfile.TemporaryDirectory() as tmpdir:
        with open(os.path.join(tmpdir, "app.py"), "w", encoding="utf-8") as fh:
            fh.write('raise ValueError("syntax or dev bug")\n')
        with open(os.path.join(tmpdir, "app.py.bak"), "w", encoding="utf-8") as fh:
            fh.write("def main(): pass\n")
        st, mods = _make_hw_env(nvm_bytes=[0xA5, 0, 0, 0], usb_connected=True, fs_readonly=True)
        sys.modules.pop("app", None)
        sys.path.insert(0, tmpdir)
        try:
            cm = _load_fresh("_test_code_usb_err", code_path, mods)
            cm.USB_DETECT_TIMEOUT_SECONDS = 0.0
            cm.time = types.SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda s: None)
            assert cm.boot_main(tmpdir) == "usb_error"
        finally:
            sys.path.remove(tmpdir)
            sys.modules.pop("app", None)
        assert st["resets"] == 0
        assert os.path.exists(os.path.join(tmpdir, "app.py.bak"))

    # 11. code.py: BOOT_MODE_FORCE_OTA over USB clears flag back to 0 and stays in Python R/W
    with tempfile.TemporaryDirectory() as tmpdir:
        with open(os.path.join(tmpdir, "app.py"), "w", encoding="utf-8") as fh:
            fh.write("def main():\n    raise KeyboardInterrupt()\n")
        st, mods = _make_hw_env(nvm_bytes=[0xA5, 2, 0, 0], usb_connected=True, fs_readonly=False)
        sys.modules.pop("app", None)
        sys.path.insert(0, tmpdir)
        try:
            cm = _load_fresh("_test_code_force", code_path, mods)
            cm.USB_DETECT_TIMEOUT_SECONDS = 0.0
            cm.time = types.SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda s: None)
            try:
                cm.boot_main(tmpdir)
                raise AssertionError("Expected KeyboardInterrupt")
            except KeyboardInterrupt:
                pass
        finally:
            sys.path.remove(tmpdir)
            sys.modules.pop("app", None)
        assert st["resets"] == 0
        assert list(st["nvm"][0:4]) == [0xA5, 0, 0, 0]

    # 12. code.py: SyntaxError in app.py is caught and rolled back cleanly
    with tempfile.TemporaryDirectory() as tmpdir:
        with open(os.path.join(tmpdir, "app.py"), "w", encoding="utf-8") as fh:
            fh.write("def broken(:\n")
        with open(os.path.join(tmpdir, "app.py.bak"), "w", encoding="utf-8") as fh:
            fh.write("def main(): pass\n")
        st, mods = _make_hw_env(nvm_bytes=[0xA5, 0, 0, 1], usb_connected=False, fs_readonly=False)
        sys.modules.pop("app", None)
        sys.path.insert(0, tmpdir)
        try:
            cm = _load_fresh("_test_code_syntax", code_path, mods)
            cm.USB_DETECT_TIMEOUT_SECONDS = 0.0
            cm.time = types.SimpleNamespace(monotonic=lambda: 0.0, sleep=lambda s: None)
            assert cm.boot_main(tmpdir) == "rolled_back"
        finally:
            sys.path.remove(tmpdir)
            sys.modules.pop("app", None)
        assert list(st["nvm"][0:4]) == [0xA5, 0, 2, 0]
        assert os.path.exists(os.path.join(tmpdir, "app.py.failed"))

    print("[PASS] Bootloader tests passed (boot.py modes, USB handoff, A/B rollback, WDT hang, mid-swap self-heal).")


def run_ota_updater_tests():
    """Verify Step 18 pull-based OTA manifest validation, SHA-256 verification, atomic swap, and rollback safety."""
    import hashlib
    import tempfile
    import types

    # 1. Syntax check on ota_updater.py and updated app.py / firestore_client.py
    for fname in ("ota_updater.py", "app.py", "firestore_client.py"):
        fpath = os.path.join(FIRMWARE_DIR, fname)
        with open(fpath, "r", encoding="utf-8") as fh:
            compile(fh.read(), fpath, "exec")

    # 2. SemVer & OTA filename validators
    assert firestore_client.is_valid_firmware_version("1.3.0")
    assert firestore_client.is_valid_firmware_version("1.3.0-rc1")
    assert firestore_client.is_valid_firmware_version("10.20.30-beta.2")
    assert not firestore_client.is_valid_firmware_version("1.3")
    assert not firestore_client.is_valid_firmware_version("v1.3.0")
    assert not firestore_client.is_valid_firmware_version("../1.3.0")

    assert firestore_client.is_valid_ota_filename("app.py")
    assert firestore_client.is_valid_ota_filename("ota_updater.py")
    assert not firestore_client.is_valid_ota_filename("boot.py")
    assert not firestore_client.is_valid_ota_filename("code.py")
    assert not firestore_client.is_valid_ota_filename("settings.toml")
    assert not firestore_client.is_valid_ota_filename("../app.py")
    assert not firestore_client.is_valid_ota_filename("App.py")

    # 3. Remote config target_firmware_version normalization & device status OTA fields
    defaults = {
        "location": "home-office",
        "reporting_interval_seconds": 300,
        "temperature_offset_c": 4.0,
        "altitude_m": 0,
        "led_enabled": True,
    }
    cfg_with_target = firestore_client.normalize_device_config(
        {"target_firmware_version": "1.3.1-rc1", "config_version": 4}, defaults
    )
    assert cfg_with_target["target_firmware_version"] == "1.3.1-rc1"
    cfg_bad_target = firestore_client.normalize_device_config(
        {"target_firmware_version": "not-semver"}, defaults
    )
    assert cfg_bad_target["target_firmware_version"] is None

    sample_reading = {
        "co2_ppm": 550,
        "temperature_f": 71.0,
        "humidity_percent": 45.0,
        "pm2_5_ug_m3": 4,
        "aqi_us": 22,
        "aqi_category": "Good",
    }
    dev_doc = firestore_client.build_device_status_document(
        device_id="feather-s3-01",
        location="home-office",
        last_seen_at="2026-11-24T19:00:00Z",
        firmware_version="1.3.0",
        sensors=["SCD-40", "PMSA003I"],
        reporting_interval_seconds=300,
        reading=sample_reading,
        ota_status="error",
        ota_target_version="1.3.1",
        ota_last_error="x" * 250,
    )
    assert dev_doc["ota_status"] == "error"
    assert dev_doc["ota_target_version"] == "1.3.1"
    assert len(dev_doc["ota_last_error"]) == 200

    # 4. SHA-256 helper & bootloader compatibility (including CircuitPython hashlib.new-only fallback)
    payload_bytes = b'FIRMWARE_VERSION = "1.3.1"\n'
    expected_hex = hashlib.sha256(payload_bytes).hexdigest()
    assert ota_updater.sha256_hex(payload_bytes) == expected_hex
    orig_hashlib = ota_updater.hashlib
    try:
        ota_updater.hashlib = types.SimpleNamespace(new=hashlib.new)
        assert ota_updater.sha256_hex(payload_bytes) == expected_hex
    finally:
        ota_updater.hashlib = orig_hashlib
    assert ota_updater.is_bootloader_compatible("1.0.0", "1.0.0")
    assert ota_updater.is_bootloader_compatible("1.2.0", "1.0.0")
    assert not ota_updater.is_bootloader_compatible("1.0.0", "1.1.0")

    def _make_release(version, files_dict, status="active", min_bl="1.0.0"):
        manifest_files = {}
        artifacts = {}
        for fname, content in files_dict.items():
            raw = content.encode("utf-8")
            digest = hashlib.sha256(raw).hexdigest()
            manifest_files[fname] = {
                "doc_id": fname,
                "sha256": digest,
                "size_bytes": len(raw),
            }
            artifacts[fname] = {
                "filename": fname,
                "version": version,
                "sha256": digest,
                "size_bytes": len(raw),
                "encoding": "utf-8",
                "content": content,
            }
        manifest = {
            "version": version,
            "min_bootloader_version": min_bl,
            "status": status,
            "files": manifest_files,
        }
        return manifest, artifacts

    class _FakeOtaClient:
        def __init__(self, manifest, artifacts):
            self.manifest = manifest
            self.artifacts = artifacts
            self.calls = []

        def fetch_firmware_release(self, version):
            self.calls.append(("manifest", version))
            return self.manifest

        def fetch_firmware_release_file(self, version, filename):
            self.calls.append(("file", version, filename))
            return self.artifacts.get(filename)

    # 5. Manifest validation rejections (yanked, old bootloader, missing app.py, protected boot.py)
    good_manifest, _ = _make_release("1.3.1", {"app.py": "def main(): pass\n"})
    for bad_m, expected_substr in (
        (None, "not found"),
        ({**good_manifest, "status": "yanked"}, "not active"),
        ({**good_manifest, "version": "1.3.2"}, "mismatch"),
        ({**good_manifest, "min_bootloader_version": "2.0.0"}, "older than required"),
        ({**good_manifest, "files": {"aqi.py": good_manifest["files"]["app.py"]}}, "missing required app.py"),
        (
            {
                **good_manifest,
                "files": {
                    **good_manifest["files"],
                    "boot.py": {
                        "doc_id": "boot.py",
                        "sha256": "a" * 64,
                        "size_bytes": 10,
                    },
                },
            },
            "Blocked or invalid",
        ),
    ):
        try:
            ota_updater.validate_release_manifest(bad_m, "1.3.1", bootloader_version="1.0.0")
            raise AssertionError(f"Expected OtaError containing {expected_substr!r}")
        except ota_updater.OtaError as err:
            assert expected_substr in str(err), f"Unexpected error: {err}"

    # 6. Happy-path full OTA update: download -> SHA-256 -> on_before_swap -> backup -> swap -> reset
    with tempfile.TemporaryDirectory() as tmpdir:
        with open(os.path.join(tmpdir, "app.py"), "w", encoding="utf-8") as fh:
            fh.write('FIRMWARE_VERSION = "1.3.0"\n')
        with open(os.path.join(tmpdir, "aqi.py"), "w", encoding="utf-8") as fh:
            fh.write("OLD_AQI = True\n")
        with open(os.path.join(tmpdir, "stale.py.bak"), "w", encoding="utf-8") as fh:
            fh.write("# stale backup from older OTA\n")

        manifest, artifacts = _make_release(
            "1.3.1",
            {
                "app.py": 'FIRMWARE_VERSION = "1.3.1"\n',
                "aqi.py": "NEW_AQI = True\n",
                "ota_updater.py": "# new updater\n",
            },
        )
        client = _FakeOtaClient(manifest, artifacts)
        nvm = bytearray([0xA5, 0, 0, 0])
        events = []

        def _before_swap(ver):
            events.append(("before_swap", ver))
            # Live app.py must still be old when on_before_swap runs!
            with open(os.path.join(tmpdir, "app.py"), "r", encoding="utf-8") as fh:
                assert "1.3.0" in fh.read()

        def _reset():
            events.append(("reset",))

        res = ota_updater.perform_ota_update(
            client=client,
            current_version="1.3.0",
            target_version="1.3.1",
            root_dir=tmpdir,
            nvm=nvm,
            bootloader_version="1.0.0",
            fs_readonly=False,
            on_before_swap=_before_swap,
            reset_fn=_reset,
        )
        assert res["action"] == "updated"
        assert res["swapped_files"][-1] == "app.py", "app.py must be swapped last"
        assert events == [("before_swap", "1.3.1"), ("reset",)]
        assert list(nvm) == [0xA5, 0, ota_updater.OTA_STATE_PENDING, 0]
        assert not os.path.exists(os.path.join(tmpdir, "stale.py.bak"))
        assert not os.path.exists(os.path.join(tmpdir, "app.py.new"))
        assert not os.path.exists(os.path.join(tmpdir, "aqi.py.new"))
        with open(os.path.join(tmpdir, "app.py"), "r", encoding="utf-8") as fh:
            assert "1.3.1" in fh.read()
        with open(os.path.join(tmpdir, "app.py.bak"), "r", encoding="utf-8") as fh:
            assert "1.3.0" in fh.read()
        with open(os.path.join(tmpdir, "aqi.py.bak"), "r", encoding="utf-8") as fh:
            assert "OLD_AQI" in fh.read()
        with open(os.path.join(tmpdir, "ota_pending.txt"), "r", encoding="utf-8") as fh:
            assert fh.read().strip() == "1.3.1"

    # 7. Corrupted SHA-256 hash rejection: aborts cleanly, deletes .new, no reboot, live untouched
    with tempfile.TemporaryDirectory() as tmpdir:
        with open(os.path.join(tmpdir, "app.py"), "w", encoding="utf-8") as fh:
            fh.write('FIRMWARE_VERSION = "1.3.0"\n')
        with open(os.path.join(tmpdir, "aqi.py"), "w", encoding="utf-8") as fh:
            fh.write("OLD_AQI = True\n")

        manifest, artifacts = _make_release(
            "1.3.1",
            {
                "aqi.py": "NEW_AQI = True\n",
                "app.py": 'FIRMWARE_VERSION = "1.3.1"\n',
            },
        )
        # Tamper 1 character of app.py content without changing byte length so SHA-256 catches it
        artifacts["app.py"]["content"] = 'FIRMWARE_VERSION = "1.3.9"\n'

        client = _FakeOtaClient(manifest, artifacts)
        nvm = bytearray([0xA5, 0, 0, 0])
        resets = []
        before_swaps = []

        res = ota_updater.perform_ota_update(
            client=client,
            current_version="1.3.0",
            target_version="1.3.1",
            root_dir=tmpdir,
            nvm=nvm,
            bootloader_version="1.0.0",
            fs_readonly=False,
            on_before_swap=lambda v: before_swaps.append(v),
            reset_fn=lambda: resets.append(1),
        )
        assert res["action"] == "error"
        assert res["ota_status"] == "error"
        assert "SHA-256 mismatch" in res["ota_last_error"]
        assert len(resets) == 0
        assert len(before_swaps) == 0
        assert list(nvm) == [0xA5, 0, 0, 0]
        assert not os.path.exists(os.path.join(tmpdir, "aqi.py.new"))
        assert not os.path.exists(os.path.join(tmpdir, "app.py.new"))
        assert not os.path.exists(os.path.join(tmpdir, "app.py.bak"))
        with open(os.path.join(tmpdir, "app.py"), "r", encoding="utf-8") as fh:
            assert "1.3.0" in fh.read()
        with open(os.path.join(tmpdir, "aqi.py"), "r", encoding="utf-8") as fh:
            assert "OLD_AQI" in fh.read()

    # 8. USB read-only mode skips cleanly with zero network calls or resets
    with tempfile.TemporaryDirectory() as tmpdir:
        client = _FakeOtaClient(None, {})
        resets = []
        res = ota_updater.perform_ota_update(
            client=client,
            current_version="1.3.0",
            target_version="1.3.1",
            root_dir=tmpdir,
            fs_readonly=True,
            reset_fn=lambda: resets.append(1),
        )
        assert res["action"] == "skipped_usb"
        assert len(client.calls) == 0
        assert len(resets) == 0

    # 9. Post-rollback detection & rollback-loop prevention
    with tempfile.TemporaryDirectory() as tmpdir:
        with open(os.path.join(tmpdir, "ota_pending.txt"), "w", encoding="utf-8") as fh:
            fh.write("1.3.1")
        with open(os.path.join(tmpdir, "boot_error.txt"), "w", encoding="utf-8") as fh:
            fh.write("Traceback:\nRuntimeError: simulated crash\n")
        nvm = bytearray([0xA5, 0, ota_updater.OTA_STATE_ROLLED_BACK, 0])

        post = ota_updater.check_post_boot_ota_state(
            "1.3.0", root_dir=tmpdir, nvm=nvm, fs_readonly=False
        )
        assert post["ota_status"] == "rolled_back"
        assert post["failed_version"] == "1.3.1"
        assert "1.3.1" in post["ota_last_error"]
        assert "simulated crash" in post["ota_last_error"]
        assert not os.path.exists(os.path.join(tmpdir, "ota_pending.txt"))
        assert os.path.exists(os.path.join(tmpdir, "ota_failed_version.txt"))

        # Re-polling the same broken target_firmware_version must skip without downloading
        client = _FakeOtaClient(None, {})
        skip_res = ota_updater.perform_ota_update(
            client=client,
            current_version="1.3.0",
            target_version="1.3.1",
            failed_version=post["failed_version"],
            root_dir=tmpdir,
            nvm=nvm,
            fs_readonly=False,
        )
        assert skip_res["action"] == "skipped_rolled_back"
        assert skip_res["ota_status"] == "rolled_back"
        assert len(client.calls) == 0

        # Clearing rolled-back state removes ota_failed_version.txt and calls on_healthy
        cleared = []
        ota_updater.confirm_ota_healthy(
            on_healthy=lambda clear_rolled_back=False: cleared.append(clear_rolled_back),
            clear_rolled_back=True,
            root_dir=tmpdir,
            fs_readonly=False,
        )
        assert cleared == [True]
        assert not os.path.exists(os.path.join(tmpdir, "ota_failed_version.txt"))

    print("[PASS] OTA updater tests passed (manifest guards, SHA-256 verification, atomic swap, hash-mismatch rejection, rollback-loop prevention).")


def run_hardening_tests():
    """Verify F1-F3 firmware timeouts, TLS close-before-fallback, monotonic_ns timing, and slug/NaN guards."""
    import importlib.util
    import types

    # 1. NaN / Infinity / invalid default slug guards in normalize_device_config
    bad_defaults = {
        "location": "../bad location",
        "reporting_interval_seconds": 300,
        "temperature_offset_c": 4.0,
        "altitude_m": 100,
        "led_enabled": True,
    }
    norm_bad_default = firestore_client.normalize_device_config(None, bad_defaults)
    assert norm_bad_default["location"] == "home-office"

    nan_cfg = firestore_client.normalize_device_config(
        {
            "reporting_interval_seconds": float("nan"),
            "temperature_offset_c": float("inf"),
            "altitude_m": float("-inf"),
            "config_version": 5,
        },
        {"location": "bedroom"},
    )
    assert nan_cfg["reporting_interval_seconds"] == 300
    assert nan_cfg["temperature_offset_c"] == 4.0
    assert nan_cfg["altitude_m"] == 0

    # 2. FirestoreClient timeout= forwarding + close-before-sign_in on refresh_id_token + slug/doc-id guards
    class _TrackedResponse:
        def __init__(self, status_code, body, tracker):
            self.status_code = status_code
            self._body = body
            self._tracker = tracker
            self.closed = False
            self._tracker["open"] += 1
            self._tracker["max_open"] = max(self._tracker["max_open"], self._tracker["open"])

        @property
        def text(self):
            return json.dumps(self._body)

        def json(self):
            return self._body

        def close(self):
            if not self.closed:
                self.closed = True
                self._tracker["open"] -= 1

    class _TrackedSession:
        def __init__(self):
            self.tracker = {"open": 0, "max_open": 0}
            self.calls = []
            self.refresh_calls = 0

        def post(self, url, json=None, headers=None, timeout=None):
            self.calls.append(("POST", url, timeout))
            if "securetoken" in url:
                self.refresh_calls += 1
                # First refresh fails with 400 -> must close BEFORE calling sign_in()
                return _TrackedResponse(400, {"error": "TOKEN_EXPIRED"}, self.tracker)
            return _TrackedResponse(
                200,
                {
                    "idToken": "tok_new",
                    "refreshToken": "ref_new",
                    "localId": "uid_1",
                    "expiresIn": "3600",
                },
                self.tracker,
            )

        def get(self, url, headers=None, timeout=None):
            self.calls.append(("GET", url, timeout))
            return _TrackedResponse(404, {}, self.tracker)

        def patch(self, url, json=None, headers=None, timeout=None):
            self.calls.append(("PATCH", url, timeout))
            return _TrackedResponse(200, {"name": "ok"}, self.tracker)

    session = _TrackedSession()
    client = firestore_client.FirestoreClient(
        project_id="demo-proj",
        web_api_key="demo-key",
        device_email="sensor@example.com",
        device_password="demo-password",
        session=session,
        request_timeout=12,
    )
    client._refresh_token = "ref_old"
    client._id_token = "tok_old"
    new_tok = client.refresh_id_token()
    assert new_tok == "tok_new"
    assert session.refresh_calls == 1
    assert session.tracker["max_open"] == 1, f"Expected <=1 concurrent response, got {session.tracker['max_open']}"
    assert session.tracker["open"] == 0
    assert all(timeout == 12 for _, _, timeout in session.calls)

    # Slug & document_id URL interpolation guards
    for bad_id in ("../secret", "has space", "a/b", ""):
        for fn in (
            lambda: client.fetch_device_config(bad_id),
            lambda: client.update_device_status({"device_id": bad_id, "location": "room"}),
        ):
            try:
                fn()
                raise AssertionError(f"Expected ValueError for bad slug {bad_id!r}")
            except ValueError:
                pass
    try:
        client.publish_reading({"co2_ppm": 500}, document_id="../escape")
        raise AssertionError("Expected ValueError for bad document_id")
    except ValueError:
        pass

    assert client.fetch_device_config("feather-s3-01") is None
    assert session.calls[-1][2] == 12

    # 3. app.py monotonic_ns timing, load_config slug validation & _read_scd40 RuntimeError handling
    stub_names = (
        "adafruit_connection_manager",
        "adafruit_ntp",
        "adafruit_requests",
        "adafruit_scd4x",
        "board",
        "microcontroller",
        "neopixel",
        "rtc",
        "wifi",
        "adafruit_pm25",
        "adafruit_pm25.i2c",
        "watchdog",
    )
    saved = {name: sys.modules.get(name) for name in stub_names}
    try:
        for name in stub_names:
            sys.modules[name] = types.ModuleType(name)
        sys.modules["adafruit_pm25.i2c"].PM25_I2C = object
        wdt_stub = types.SimpleNamespace(mode=None, timeout=None, feed=lambda: None)
        sys.modules["microcontroller"].watchdog = wdt_stub
        sys.modules["watchdog"].WatchDogMode = types.SimpleNamespace(RESET="RESET")

        spec = importlib.util.spec_from_file_location(
            "_test_app_hardening", os.path.join(FIRMWARE_DIR, "app.py")
        )
        app_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(app_mod)

        # _monotonic_ms uses monotonic_ns even when float monotonic() has coarse resolution
        orig_time = app_mod.time
        try:
            ns_vals = iter(
                [1_700_000_000_000_000, 1_700_000_000_000_000, 1_700_000_600_000_000]
            )
            sleeps = []
            app_mod.time = types.SimpleNamespace(
                monotonic_ns=lambda: next(ns_vals, 1_700_000_600_000_000),
                monotonic=lambda: 2_097_152.0,  # coarse float where +0.5 == 2_097_152.0
                sleep=lambda s: sleeps.append(s),
            )
            app_mod.sleep_with_watchdog(0.5)
            assert sleeps and abs(sleeps[0] - 0.5) < 0.01
        finally:
            app_mod.time = orig_time

        # load_config rejects invalid SENSOR_DEVICE_ID / SENSOR_LOCATION
        orig_getenv = app_mod.os.getenv
        try:
            env_map = {
                "CIRCUITPY_WIFI_SSID": "ssid",
                "CIRCUITPY_WIFI_PASSWORD": "pw",
                "FIREBASE_PROJECT_ID": "proj",
                "FIREBASE_WEB_API_KEY": "key",
                "FIREBASE_DEVICE_EMAIL": "a@b.com",
                "FIREBASE_DEVICE_PASSWORD": "pw",
                "SENSOR_DEVICE_ID": "bad/device",
                "SENSOR_LOCATION": "office",
            }
            app_mod.os.getenv = lambda k, d=None: env_map.get(k, d)
            try:
                app_mod.load_config()
                raise AssertionError("Expected ValueError for invalid SENSOR_DEVICE_ID")
            except ValueError as err:
                assert "SENSOR_DEVICE_ID" in str(err)
        finally:
            app_mod.os.getenv = orig_getenv

        # _read_scd40 catches RuntimeError CRC errors as HardwareError
        class _CrcScd40:
            @property
            def data_ready(self):
                raise RuntimeError("CRC check failed")

        try:
            app_mod._read_scd40(_CrcScd40(), timeout_seconds=1.0)
            raise AssertionError("Expected HardwareError on SCD-40 RuntimeError")
        except app_mod.HardwareError as err:
            assert "CRC check failed" in str(err)
    finally:
        for name, old in saved.items():
            if old is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = old

    print("[PASS] Firmware hardening tests passed (timeouts, TLS close order, monotonic_ns, slug/NaN/CRC guards).")


def run_live_fetch_config(settings_path):
    """Sign in as the sensor device and fetch/normalize live `device_configs/{device_id}`."""
    if not os.path.exists(settings_path):
        print(f"[ERROR] {settings_path} not found.")
        sys.exit(1)

    settings = load_toml_settings(settings_path)
    device_id = settings.get("SENSOR_DEVICE_ID", "feather-s3-01")
    defaults = {
        "location": settings.get("SENSOR_LOCATION", "home-office"),
        "reporting_interval_seconds": int(settings.get("SENSOR_INTERVAL_SECONDS", 300)),
        "temperature_offset_c": 4.0,
        "altitude_m": 0,
        "led_enabled": True,
    }

    client = firestore_client.FirestoreClient(
        project_id=settings["FIREBASE_PROJECT_ID"],
        web_api_key=settings["FIREBASE_WEB_API_KEY"],
        device_email=settings["FIREBASE_DEVICE_EMAIL"],
        device_password=settings["FIREBASE_DEVICE_PASSWORD"],
    )

    print(f"1. Fetching live remote config for device_configs/{device_id}...")
    raw_cfg = client.fetch_device_config(device_id)
    normalized = firestore_client.normalize_device_config(raw_cfg, defaults)
    assert raw_cfg is not None, f"Expected device_configs/{device_id} document to exist."
    print(f"[PASS] Live remote config fetched & normalized: {normalized}")

    print("2. Verifying missing config doc returns None (graceful 404 fallback)...")
    missing_cfg = client.fetch_device_config("nonexistent-device-check")
    assert missing_cfg is None, f"Expected None on 404, got {missing_cfg!r}"
    fallback = firestore_client.normalize_device_config(missing_cfg, defaults)
    assert fallback["config_version"] == 0
    print("[PASS] Missing device config returned None and fell back to local defaults (v0).")


def run_live_publish(settings_path):
    """Sign in as the sensor device, test token refresh, and publish 1 synthetic reading."""
    if not os.path.exists(settings_path):
        print(
            f"[ERROR] {settings_path} not found.\n"
            "Copy firmware/settings.toml.example to firmware/settings.toml and fill in\n"
            "your Firebase project ID, Web API key, and dedicated device credentials."
        )
        sys.exit(1)

    settings = load_toml_settings(settings_path)
    required_keys = (
        "FIREBASE_PROJECT_ID",
        "FIREBASE_WEB_API_KEY",
        "FIREBASE_DEVICE_EMAIL",
        "FIREBASE_DEVICE_PASSWORD",
    )
    missing = [k for k in required_keys if not settings.get(k)]
    if missing:
        print(f"[ERROR] Missing required keys in {settings_path}: {', '.join(missing)}")
        sys.exit(1)

    device_id = settings.get("SENSOR_DEVICE_ID", "feather-s3-01")
    location = settings.get("SENSOR_LOCATION", "home-office")
    interval_s = int(settings.get("SENSOR_INTERVAL_SECONDS", 300))

    client = firestore_client.FirestoreClient(
        project_id=settings["FIREBASE_PROJECT_ID"],
        web_api_key=settings["FIREBASE_WEB_API_KEY"],
        device_email=settings["FIREBASE_DEVICE_EMAIL"],
        device_password=settings["FIREBASE_DEVICE_PASSWORD"],
    )

    print("1. Signing in to Firebase Auth as dedicated sensor device...")
    client.sign_in()
    print("[PASS] Firebase Auth sign-in succeeded.")

    print("2. Verifying Firebase ID token refresh flow...")
    client.refresh_id_token()
    print("[PASS] Firebase ID token refresh succeeded.")

    ts = firestore_client.format_utc_timestamp()
    pm25 = 6
    pm10 = 11
    aqi_val, aqi_cat = aqi.calculate_aqi(pm25, pm10)

    reading = firestore_client.build_reading_document(
        device_id=device_id,
        location=location,
        timestamp=ts,
        co2_ppm=642,
        temperature_c=22.4,
        temperature_f=72.3,
        humidity_percent=44.8,
        pm1_0_ug_m3=3,
        pm2_5_ug_m3=pm25,
        pm10_0_ug_m3=pm10,
        aqi_us=aqi_val,
        aqi_category=aqi_cat,
        particles_0_3um=810,
        particles_0_5um=225,
        particles_1_0um=42,
        particles_2_5um=4,
        particles_5_0um=1,
        particles_10_0um=0,
    )

    device_status = firestore_client.build_device_status_document(
        device_id=device_id,
        location=location,
        last_seen_at=ts,
        firmware_version="1.0.0",
        sensors=["SCD-40", "PMSA003I"],
        reporting_interval_seconds=interval_s,
        reading=reading,
    )

    doc_id = f"{device_id}_{int(time.time())}"
    print(f"3. Publishing synthetic reading to readings/{doc_id}...")
    reading_resp = client.publish_reading(reading, document_id=doc_id)
    print(f"[PASS] Created reading document: {reading_resp.get('name', doc_id).split('/')[-1]}")

    print(f"4. Updating device status at devices/{device_id}...")
    device_resp = client.update_device_status(device_status)
    print(f"[PASS] Updated device document: {device_resp.get('name', device_id).split('/')[-1]}")
    print(
        f"\nSynthetic reading published at {ts} "
        f"(CO2=642 ppm, PM2.5={pm25} ug/m3, AQI={aqi_val} {aqi_cat}).\n"
        "Verify both documents in the Firebase Console under `readings` and `devices`."
    )


def main():
    parser = argparse.ArgumentParser(
        description="Validate EPA AQI math and Firestore REST client locally."
    )
    parser.add_argument(
        "--fetch-config",
        action="store_true",
        help="Fetch live device_configs/{device_id} using firmware/settings.toml (no writes).",
    )
    parser.add_argument(
        "--publish",
        action="store_true",
        help="Publish 1 synthetic reading to live Firestore using firmware/settings.toml.",
    )
    parser.add_argument(
        "--settings",
        default=os.path.join(FIRMWARE_DIR, "settings.toml"),
        help="Path to local settings.toml (default: firmware/settings.toml).",
    )
    args = parser.parse_args()

    run_aqi_tests()
    run_encoding_tests()
    run_remote_config_tests()
    run_bootloader_tests()
    run_ota_updater_tests()
    run_hardening_tests()

    if args.fetch_config:
        run_live_fetch_config(args.settings)

    if args.publish:
        run_live_publish(args.settings)
    elif not args.fetch_config:
        print(
            "\nOffline checks passed. Re-run with `--fetch-config` or `--publish` to test "
            "against live Firestore using firmware/settings.toml."
        )


if __name__ == "__main__":
    main()
