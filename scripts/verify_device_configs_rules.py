#!/usr/bin/env python3
"""Firestore security rules checks for device access and mixed-fleet payloads.

Default mode verifies the live `device_configs/{device_id}` boundaries with the
sensor credentials in `firmware/settings.toml`:
  1. Unauthenticated GET on `device_configs/{device_id}` -> 403 PERMISSION_DENIED
  2. Authenticated sensor GET on `device_configs/{device_id}` -> 200 OK
  3. Authenticated sensor LIST on `device_configs` -> 403 PERMISSION_DENIED
  4. Authenticated sensor PATCH (write) on `device_configs/{device_id}` -> 403 PERMISSION_DENIED
  5. Authenticated sensor DELETE on `device_configs/{device_id}` -> 403 PERMISSION_DENIED

`--emulator` checks the local rules file through the Firestore emulator. It
covers a legacy full-hub write, an SCD-40-only satellite write with null
PM/AQI fields, rejection of negative or out-of-range non-null PM values, and
optional `floor` slugs on `device_configs`. It does not read `settings.toml`.

Usage:
  python3 scripts/verify_device_configs_rules.py
  firebase emulators:exec --only firestore --project demo-custom-air-sensor \\
    "python3 scripts/verify_device_configs_rules.py --emulator"
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIRMWARE_DIR = os.path.join(REPO_ROOT, "firmware")
sys.path.insert(0, FIRMWARE_DIR)

import firestore_client  # noqa: E402


def load_toml_settings(path):
    """Load key-value pairs from a CircuitPython settings.toml file."""
    try:
        import tomllib

        with open(path, "rb") as fh:
            return tomllib.load(fh)
    except ImportError:
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


def http_request(method, url, token=None, json_body=None, timeout=15):
    """Send an HTTP request and return (status_code, parsed_json_or_text)."""
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace")
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, raw


def extract_error_status(body):
    if isinstance(body, dict):
        return body.get("error", {}).get("status")
    return None


def b64url(payload):
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def emulator_user_token(uid):
    """Unsigned JWT the Firestore emulator accepts as request.auth."""
    header = b64url({"alg": "none", "typ": "JWT"})
    body = b64url({"sub": uid, "user_id": uid})
    return f"{header}.{body}."


def emulator_origin():
    host = os.environ.get("FIRESTORE_EMULATOR_HOST", "").strip()
    if not host:
        raise SystemExit(
            "[ERROR] FIRESTORE_EMULATOR_HOST is not set. Run this mode with "
            "`firebase emulators:exec --only firestore`."
        )
    if host.startswith("http://") or host.startswith("https://"):
        return host.rstrip("/")
    return f"http://{host}"


def firestore_value(value):
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, datetime):
        text = value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        return {"timestampValue": text}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, list):
        return {"arrayValue": {"values": [firestore_value(item) for item in value]}}
    if isinstance(value, dict):
        return {
            "mapValue": {
                "fields": {key: firestore_value(item) for key, item in value.items()}
            }
        }
    raise TypeError(f"Unsupported Firestore value type: {type(value).__name__}")


def document_body(fields):
    return {"fields": {key: firestore_value(value) for key, value in fields.items()}}


def now_timestamp():
    return datetime.now(timezone.utc)


def reading_fields(device_id, pm_value, aqi_value="Good", particles=0):
    return {
        "device_id": device_id,
        "location": "master-bedroom",
        "timestamp": now_timestamp(),
        "co2_ppm": 800,
        "temperature_c": 22.5,
        "temperature_f": 72.5,
        "humidity_percent": 40.0,
        "pm1_0_ug_m3": pm_value,
        "pm2_5_ug_m3": pm_value,
        "pm10_0_ug_m3": pm_value,
        "aqi_us": None if pm_value is None else 42,
        "aqi_category": None if pm_value is None else aqi_value,
        "particles_0_3um": particles if pm_value is not None else None,
        "particles_0_5um": particles if pm_value is not None else None,
        "particles_1_0um": particles if pm_value is not None else None,
        "particles_2_5um": particles if pm_value is not None else None,
        "particles_5_0um": particles if pm_value is not None else None,
        "particles_10_0um": particles if pm_value is not None else None,
    }


def device_fields(device_id, sensors, pm_value):
    return {
        "device_id": device_id,
        "location": "master-bedroom",
        "last_seen_at": now_timestamp(),
        "firmware_version": "1.3.4",
        "sensors": sensors,
        "reporting_interval_seconds": 300,
        "latest_reading": {
            "co2_ppm": 800,
            "temperature_f": 72.5,
            "humidity_percent": 40.0,
            "pm2_5_ug_m3": pm_value,
            "aqi_us": None if pm_value is None else 42,
            "aqi_category": None if pm_value is None else "Good",
        },
    }


def expect_status(label, status, body, expected):
    assert status == expected, (
        f"{label} failed: expected HTTP {expected}, got {status} ({body})"
    )
    print(f"[PASS] {label} -> {expected}")


def run_emulator_checks():
    project_id = (
        os.environ.get("GCLOUD_PROJECT")
        or os.environ.get("GOOGLE_CLOUD_PROJECT")
        or "demo-custom-air-sensor"
    )
    origin = emulator_origin()
    docs = f"{origin}/v1/projects/{project_id}/databases/(default)/documents"
    uid = "emu-rules-sensor"
    user_token = emulator_user_token(uid)

    status, body = http_request(
        "PATCH",
        f"{docs}/authorized_devices/{uid}?updateMask.fieldPaths=role",
        token="owner",
        json_body=document_body({"role": "sensor"}),
    )
    if status == 404:
        status, body = http_request(
            "POST",
            f"{docs}/authorized_devices?documentId={uid}",
            token="owner",
            json_body=document_body({"role": "sensor"}),
        )
    expect_status("Emulator admin seed authorized_devices", status, body, 200)

    def create_doc(collection, doc_id, fields, token):
        return http_request(
            "POST",
            f"{docs}/{collection}?documentId={doc_id}",
            token=token,
            json_body=document_body(fields),
        )

    status, body = create_doc(
        "readings",
        "rules-hub-reading",
        reading_fields("rules-hub-01", 12),
        user_token,
    )
    expect_status("Full-hub reading create", status, body, 200)

    status, body = create_doc(
        "devices",
        "rules-hub-01",
        device_fields("rules-hub-01", ["SCD-40", "PMSA003I"], 12),
        user_token,
    )
    expect_status("Full-hub device create", status, body, 200)

    status, body = create_doc(
        "readings",
        "rules-sat-reading",
        reading_fields("rules-sat-01", None),
        user_token,
    )
    expect_status("SCD-40 satellite reading create with null PM/AQI", status, body, 200)

    status, body = create_doc(
        "devices",
        "rules-sat-01",
        device_fields("rules-sat-01", ["SCD-40"], None),
        user_token,
    )
    expect_status("SCD-40 satellite device create", status, body, 200)

    status, body = create_doc(
        "readings",
        "rules-negative-pm",
        reading_fields("rules-hub-01", -1),
        user_token,
    )
    expect_status("Negative PM reading rejected", status, body, 403)

    status, body = create_doc(
        "readings",
        "rules-high-pm",
        reading_fields("rules-hub-01", 1001),
        user_token,
    )
    expect_status("Out-of-range PM reading rejected", status, body, 403)

    bogus = reading_fields("rules-hub-01", 12, aqi_value="NotACategory")
    status, body = create_doc("readings", "rules-bogus-aqi", bogus, user_token)
    expect_status("Non-null invalid AQI category rejected", status, body, 403)

    omitted = reading_fields("rules-hub-01", 12)
    del omitted["pm2_5_ug_m3"]
    status, body = create_doc("readings", "rules-missing-pm", omitted, user_token)
    expect_status("Reading missing pm2_5_ug_m3 rejected", status, body, 403)

    status, body = create_doc(
        "devices",
        "rules-pm-only",
        device_fields("rules-pm-only", ["PMSA003I"], 12),
        user_token,
    )
    expect_status("PMSA003I-only sensor list rejected", status, body, 403)

    def seed_config(doc_id, floor):
        fields = {"label": "rules-test", "floor": floor}
        return http_request(
            "POST",
            f"{docs}/device_configs?documentId={doc_id}",
            token="owner",
            json_body=document_body(fields),
        )

    status, body = seed_config("rules-floor-ok", "upstairs")
    expect_status("Admin write device_configs floor slug", status, body, 200)
    status, body = http_request(
        "GET",
        f"{docs}/device_configs/rules-floor-ok",
        token=user_token,
    )
    expect_status("Sensor get device_configs with floor slug", status, body, 200)

    status, body = seed_config("rules-floor-null", None)
    expect_status("Admin write device_configs floor null", status, body, 200)
    status, body = http_request(
        "GET",
        f"{docs}/device_configs/rules-floor-null",
        token=user_token,
    )
    expect_status("Sensor get device_configs with floor null", status, body, 200)

    status, body = seed_config("rules-floor-bad", "not a slug")
    expect_status("Admin write malformed floor", status, body, 200)
    status, body = http_request(
        "GET",
        f"{docs}/device_configs/rules-floor-bad",
        token=user_token,
    )
    expect_status("Sensor get malformed floor rejected", status, body, 403)

    status, body = http_request(
        "PATCH",
        f"{docs}/device_configs/rules-floor-ok?updateMask.fieldPaths=floor",
        token=user_token,
        json_body=document_body({"floor": "basement"}),
    )
    expect_status("Sensor patch device_configs still rejected", status, body, 403)

    print("\nAll emulator mixed-fleet Firestore rules checks passed!")


def main():
    parser = argparse.ArgumentParser(
        description="Verify live Firestore Security Rules for device_configs/{device_id}."
    )
    parser.add_argument(
        "--settings",
        default=os.path.join(FIRMWARE_DIR, "settings.toml"),
        help="Path to local settings.toml (default: firmware/settings.toml).",
    )
    parser.add_argument(
        "--device-id",
        default=None,
        help="Override device ID (default: SENSOR_DEVICE_ID from settings.toml).",
    )
    parser.add_argument(
        "--emulator",
        action="store_true",
        help="Check mixed-fleet payloads against the local Firestore emulator.",
    )
    args = parser.parse_args()

    if args.emulator:
        run_emulator_checks()
        return

    if not os.path.exists(args.settings):
        print(f"[ERROR] {args.settings} not found.")
        sys.exit(1)

    settings = load_toml_settings(args.settings)
    project_id = settings["FIREBASE_PROJECT_ID"]
    device_id = args.device_id or settings.get("SENSOR_DEVICE_ID", "feather-s3-01")

    docs_base = (
        f"https://firestore.googleapis.com/v1/projects/{project_id}"
        "/databases/(default)/documents"
    )
    doc_url = f"{docs_base}/device_configs/{device_id}"
    list_url = f"{docs_base}/device_configs"

    # 1. Unauthenticated GET must return 403 PERMISSION_DENIED
    status, body = http_request("GET", doc_url)
    assert status == 403 and extract_error_status(body) == "PERMISSION_DENIED", (
        f"Check 1 failed: expected 403 PERMISSION_DENIED for unauthenticated GET, "
        f"got HTTP {status} ({body})"
    )
    print(f"[PASS] 1. Unauthenticated GET device_configs/{device_id} -> 403 PERMISSION_DENIED")

    # Sign in as dedicated sensor device
    client = firestore_client.FirestoreClient(
        project_id=project_id,
        web_api_key=settings["FIREBASE_WEB_API_KEY"],
        device_email=settings["FIREBASE_DEVICE_EMAIL"],
        device_password=settings["FIREBASE_DEVICE_PASSWORD"],
    )
    id_token = client.sign_in()

    # 2. Authenticated sensor GET must return 200 OK
    status, body = http_request("GET", doc_url, token=id_token)
    assert status == 200 and isinstance(body, dict) and "fields" in body, (
        f"Check 2 failed: expected 200 OK with document fields for sensor GET, "
        f"got HTTP {status} ({body})"
    )
    cfg_version = body["fields"].get("config_version", {}).get("integerValue")
    location = body["fields"].get("location", {}).get("stringValue")
    print(
        f"[PASS] 2. Sensor-authenticated GET device_configs/{device_id} -> 200 OK "
        f"(config_version={cfg_version}, location={location!r})"
    )

    # 3. Authenticated sensor LIST must return 403 PERMISSION_DENIED
    status, body = http_request("GET", list_url, token=id_token)
    assert status == 403 and extract_error_status(body) == "PERMISSION_DENIED", (
        f"Check 3 failed: expected 403 PERMISSION_DENIED for sensor LIST, "
        f"got HTTP {status} ({body})"
    )
    print("[PASS] 3. Sensor-authenticated LIST device_configs -> 403 PERMISSION_DENIED")

    # 4. Authenticated sensor PATCH (write) must return 403 PERMISSION_DENIED
    tamper_payload = {
        "fields": {
            "reporting_interval_seconds": {"integerValue": "60"},
        }
    }
    status, body = http_request(
        "PATCH",
        f"{doc_url}?updateMask.fieldPaths=reporting_interval_seconds",
        token=id_token,
        json_body=tamper_payload,
    )
    assert status == 403 and extract_error_status(body) == "PERMISSION_DENIED", (
        f"Check 4 failed: expected 403 PERMISSION_DENIED for sensor PATCH, "
        f"got HTTP {status} ({body})"
    )
    print(f"[PASS] 4. Sensor-authenticated PATCH device_configs/{device_id} -> 403 PERMISSION_DENIED")

    # 5. Authenticated sensor DELETE must return 403 PERMISSION_DENIED
    status, body = http_request("DELETE", doc_url, token=id_token)
    assert status == 403 and extract_error_status(body) == "PERMISSION_DENIED", (
        f"Check 5 failed: expected 403 PERMISSION_DENIED for sensor DELETE, "
        f"got HTTP {status} ({body})"
    )
    print(f"[PASS] 5. Sensor-authenticated DELETE device_configs/{device_id} -> 403 PERMISSION_DENIED")

    print("\nAll 5 Step 12 Firestore Security Rules checks passed!")


if __name__ == "__main__":
    main()
