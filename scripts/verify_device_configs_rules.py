#!/usr/bin/env python3
"""Focused Step 12 security rules validation for `device_configs/{device_id}`.

Verifies live Firestore rules boundaries using the sensor device credentials in
`firmware/settings.toml`:
  1. Unauthenticated GET on `device_configs/{device_id}` -> 403 PERMISSION_DENIED
  2. Authenticated sensor GET on `device_configs/{device_id}` -> 200 OK
  3. Authenticated sensor LIST on `device_configs` -> 403 PERMISSION_DENIED
  4. Authenticated sensor PATCH (write) on `device_configs/{device_id}` -> 403 PERMISSION_DENIED
  5. Authenticated sensor DELETE on `device_configs/{device_id}` -> 403 PERMISSION_DENIED

Usage:
  python3 scripts/verify_device_configs_rules.py
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

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
    args = parser.parse_args()

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
