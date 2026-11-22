#!/usr/bin/env python3
"""Local macOS/Linux validation test for Step 4 (firmware/aqi.py & firestore_client.py).

Usage:
  # 1. Offline unit checks only (EPA AQI math + Firestore payload encoding):
  python3 scripts/test_firmware_local.py

  # 2. Full Step 4 validation (offline checks + live Firestore publish using firmware/settings.toml):
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

    print("[PASS] Firestore REST payload encoding tests passed.")


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

    if args.publish:
        run_live_publish(args.settings)
    else:
        print(
            "\nOffline checks passed. Re-run with `--publish` to test live Firebase Auth "
            "and Firestore writes using firmware/settings.toml."
        )


if __name__ == "__main__":
    main()
