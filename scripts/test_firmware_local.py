#!/usr/bin/env python3
"""Local macOS/Linux validation test for firmware modules (`aqi.py`, `firestore_client.py`, `code.py`).

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

    # 7. Verify firmware/code.py compiles cleanly (syntax check on Mac)
    import py_compile

    py_compile.compile(os.path.join(FIRMWARE_DIR, "code.py"), doraise=True)

    print("[PASS] Remote config decoding, clamping, reboot gating, and syntax tests passed.")


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
