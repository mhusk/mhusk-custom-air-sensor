"""Lightweight Firebase Auth + Cloud Firestore REST client.

Pure-Python module compatible with both CircuitPython 9.x (using an
`adafruit_requests.Session` instance) and standard CPython 3 on macOS/Linux
(using a built-in `urllib.request` fallback when `session=None`).
"""

import json
import time

FIREBASE_SIGN_IN_URL = (
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"
)
FIREBASE_REFRESH_URL = "https://securetoken.googleapis.com/v1/token"
FIRESTORE_API_BASE = "https://firestore.googleapis.com/v1"


class FirestoreError(Exception):
    """Raised when Firebase Auth or Firestore REST returns an HTTP error."""

    def __init__(self, message, status_code=None, body=None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class _UrllibResponse:
    """Minimal response wrapper matching the adafruit_requests.Response API."""

    def __init__(self, status_code, body_bytes):
        self.status_code = status_code
        self._body_bytes = body_bytes

    @property
    def text(self):
        return self._body_bytes.decode("utf-8", errors="replace")

    def json(self):
        return json.loads(self.text)

    def close(self):
        pass


class _UrllibSession:
    """Zero-dependency CPython HTTP session adapter for local Mac testing."""

    def __init__(self, timeout=15):
        import urllib.error
        import urllib.request

        self._urllib_request = urllib.request
        self._urllib_error = urllib.error
        self._timeout = timeout

    def _request(self, method, url, json_body=None, headers=None):
        req_headers = dict(headers) if headers else {}
        data = None
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            req_headers.setdefault("Content-Type", "application/json")

        req = self._urllib_request.Request(
            url, data=data, headers=req_headers, method=method
        )
        try:
            with self._urllib_request.urlopen(req, timeout=self._timeout) as resp:
                return _UrllibResponse(resp.status, resp.read())
        except self._urllib_error.HTTPError as err:
            return _UrllibResponse(err.code, err.read())

    def get(self, url, headers=None):
        return self._request("GET", url, json_body=None, headers=headers)

    def post(self, url, json=None, headers=None):  # pylint: disable=redefined-builtin
        return self._request("POST", url, json_body=json, headers=headers)

    def patch(self, url, json=None, headers=None):  # pylint: disable=redefined-builtin
        return self._request("PATCH", url, json_body=json, headers=headers)


def format_utc_timestamp(struct_time=None):
    """Format a UTC time tuple as an RFC 3339 timestamp string (YYYY-MM-DDTHH:MM:SSZ)."""
    if struct_time is not None:
        t = struct_time
    elif hasattr(time, "gmtime"):
        t = time.gmtime()
    else:
        # CircuitPython does not expose time.gmtime(); RTC is synced to UTC (tz_offset=0).
        t = time.localtime()
    return "{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z".format(
        t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec
    )


def encode_firestore_value(value, is_timestamp=False):
    """Convert a Python value into a Firestore REST API Value object."""
    if value is None:
        return {"nullValue": None}
    if is_timestamp:
        return {"timestampValue": str(value)}
    # Check bool before int because bool is a subclass of int in Python.
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, (list, tuple)):
        return {
            "arrayValue": {
                "values": [encode_firestore_value(item) for item in value]
            }
        }
    if isinstance(value, dict):
        return {"mapValue": {"fields": encode_firestore_fields(value)}}
    raise TypeError("Unsupported Firestore value type: {}".format(type(value)))


def encode_firestore_fields(data, timestamp_fields=()):
    """Convert a Python dict into a Firestore REST API `fields` map."""
    fields = {}
    for key, value in data.items():
        fields[key] = encode_firestore_value(
            value, is_timestamp=(key in timestamp_fields)
        )
    return fields


def decode_firestore_value(raw):
    """Convert a Firestore REST API Value object into a plain Python value."""
    if not isinstance(raw, dict):
        return None
    if "nullValue" in raw:
        return None
    if "booleanValue" in raw:
        return bool(raw["booleanValue"])
    if "integerValue" in raw:
        return int(raw["integerValue"])
    if "doubleValue" in raw:
        return float(raw["doubleValue"])
    if "stringValue" in raw:
        return str(raw["stringValue"])
    if "timestampValue" in raw:
        return str(raw["timestampValue"])
    if "arrayValue" in raw:
        items = raw["arrayValue"].get("values", [])
        return [decode_firestore_value(item) for item in items]
    if "mapValue" in raw:
        return decode_firestore_fields(raw["mapValue"].get("fields", {}))
    return None


def decode_firestore_fields(fields):
    """Convert a Firestore REST API `fields` map into a plain Python dict."""
    if not isinstance(fields, dict):
        return {}
    result = {}
    for key, raw in fields.items():
        result[key] = decode_firestore_value(raw)
    return result


def _days_from_civil(year, month, day):
    """Return days since 1970-01-01 using Howard Hinnant's Gregorian algorithm."""
    if month <= 2:
        year -= 1
    era = year // 400
    yoe = year - era * 400
    mp = month + (9 if month <= 2 else -3)
    doy = (153 * mp + 2) // 5 + day - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def parse_utc_timestamp_epoch(ts_str):
    """Parse an RFC 3339 UTC timestamp string (YYYY-MM-DDTHH:MM:SS[.fff]Z) to Unix epoch.

    Pure-Python arithmetic avoids local-timezone discrepancies between macOS CPython's
    `time.mktime()` and CircuitPython's UTC `time.mktime()`. Returns `None` if invalid.
    """
    if not isinstance(ts_str, str):
        return None
    text = ts_str.strip()
    if len(text) < 20 or not text.endswith("Z"):
        return None
    if text[4] != "-" or text[7] != "-" or text[10] not in ("T", "t"):
        return None
    if text[13] != ":" or text[16] != ":":
        return None
    try:
        year = int(text[0:4])
        month = int(text[5:7])
        day = int(text[8:10])
        hour = int(text[11:13])
        minute = int(text[14:16])
        second = int(text[17:19])
    except ValueError:
        return None

    if not (1970 <= year <= 2100 and 1 <= month <= 12 and 1 <= day <= 31):
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59 and 0 <= second <= 59):
        return None

    days = _days_from_civil(year, month, day)
    return days * 86400 + hour * 3600 + minute * 60 + second


def is_valid_slug(value):
    """Validate device_id / location slug matching `firestore.rules` `isDeviceId`."""
    if not isinstance(value, str):
        return False
    length = len(value)
    if length < 1 or length > 64:
        return False
    first = value[0]
    if not (
        ("A" <= first <= "Z")
        or ("a" <= first <= "z")
        or ("0" <= first <= "9")
    ):
        return False
    for ch in value:
        if not (
            ("A" <= ch <= "Z")
            or ("a" <= ch <= "z")
            or ("0" <= ch <= "9")
            or ch in ("_", "-")
        ):
            return False
    return True


PROTECTED_OTA_FILES = ("boot.py", "code.py", "settings.toml")
VALID_OTA_STATUSES = ("up_to_date", "updating", "rolled_back", "error")


def is_valid_firmware_version(value):
    """Validate SemVer string matching `firestore.rules` `isFirmwareVersion`."""
    if not isinstance(value, str):
        return False
    length = len(value)
    if length < 5 or length > 32:
        return False

    prerelease = None
    if "-" in value:
        core, prerelease = value.split("-", 1)
    else:
        core = value

    parts = core.split(".")
    if len(parts) != 3:
        return False
    for part in parts:
        if not part:
            return False
        for ch in part:
            if not ("0" <= ch <= "9"):
                return False

    if prerelease is not None:
        if len(prerelease) < 1 or len(prerelease) > 20:
            return False
        first = prerelease[0]
        if not (
            ("A" <= first <= "Z")
            or ("a" <= first <= "z")
            or ("0" <= first <= "9")
        ):
            return False
        for ch in prerelease:
            if not (
                ("A" <= ch <= "Z")
                or ("a" <= ch <= "z")
                or ("0" <= ch <= "9")
                or ch in (".", "-")
            ):
                return False
    return True


def is_valid_ota_filename(value):
    """Validate non-bootloader `.py` filename matching `firestore.rules` `isOtaFilename`."""
    if not isinstance(value, str):
        return False
    length = len(value)
    if length < 4 or length > 35:
        return False
    if value in PROTECTED_OTA_FILES or not value.endswith(".py"):
        return False
    stem = value[:-3]
    if not stem or len(stem) > 32:
        return False
    if not ("a" <= stem[0] <= "z"):
        return False
    for ch in stem:
        if not (("a" <= ch <= "z") or ("0" <= ch <= "9") or ch == "_"):
            return False
    return True


def _clamp_number(value, low, high):
    if value < low:
        return low
    if value > high:
        return high
    return value


def normalize_device_config(raw_config, defaults):
    """Validate and clamp a decoded `device_configs/{device_id}` dict against safe defaults.

    If `raw_config` is `None` (e.g., document does not exist yet), returns a clean copy
    of `defaults` with `config_version=0` and `reboot_requested_at=None`.
    """
    default_location = str(defaults.get("location", "home-office"))
    default_interval = int(
        _clamp_number(int(defaults.get("reporting_interval_seconds", 300)), 60, 3600)
    )
    default_offset = round(
        float(_clamp_number(float(defaults.get("temperature_offset_c", 4.0)), 0.0, 20.0)),
        2,
    )
    default_altitude = int(
        _clamp_number(int(defaults.get("altitude_m", 0)), 0, 5000)
    )
    default_led = bool(defaults.get("led_enabled", True))

    normalized = {
        "location": default_location,
        "reporting_interval_seconds": default_interval,
        "temperature_offset_c": default_offset,
        "altitude_m": default_altitude,
        "led_enabled": default_led,
        "config_version": 0,
        "reboot_requested_at": None,
        "target_firmware_version": None,
    }

    if not isinstance(raw_config, dict):
        return normalized

    raw_loc = raw_config.get("location")
    if is_valid_slug(raw_loc):
        normalized["location"] = raw_loc

    raw_interval = raw_config.get("reporting_interval_seconds")
    if isinstance(raw_interval, (int, float)) and not isinstance(raw_interval, bool):
        normalized["reporting_interval_seconds"] = int(
            _clamp_number(round(raw_interval), 60, 3600)
        )

    raw_offset = raw_config.get("temperature_offset_c")
    if isinstance(raw_offset, (int, float)) and not isinstance(raw_offset, bool):
        normalized["temperature_offset_c"] = round(
            float(_clamp_number(float(raw_offset), 0.0, 20.0)), 2
        )

    raw_altitude = raw_config.get("altitude_m")
    if isinstance(raw_altitude, (int, float)) and not isinstance(raw_altitude, bool):
        normalized["altitude_m"] = int(_clamp_number(round(raw_altitude), 0, 5000))

    raw_led = raw_config.get("led_enabled")
    if isinstance(raw_led, bool):
        normalized["led_enabled"] = raw_led

    raw_version = raw_config.get("config_version")
    if isinstance(raw_version, int) and not isinstance(raw_version, bool):
        normalized["config_version"] = int(_clamp_number(raw_version, 0, 1000000))
    else:
        # Cloud doc existed without an explicit version; mark as version 1 so callers see cloud origin.
        normalized["config_version"] = 1

    raw_reboot = raw_config.get("reboot_requested_at")
    if isinstance(raw_reboot, str) and parse_utc_timestamp_epoch(raw_reboot) is not None:
        normalized["reboot_requested_at"] = raw_reboot

    raw_target_fw = raw_config.get("target_firmware_version")
    if isinstance(raw_target_fw, str) and is_valid_firmware_version(raw_target_fw):
        normalized["target_firmware_version"] = raw_target_fw

    return normalized


def should_trigger_reboot(
    reboot_requested_at, boot_epoch, now_epoch, max_age_seconds=1800
):
    """Return True if a one-shot `reboot_requested_at` timestamp should trigger a reset.

    Compares the requested UTC timestamp against `boot_epoch` (recorded right after NTP
    sync on startup) so a reboot never loops even though the sensor has read-only access
    to `device_configs/{device_id}` and cannot clear the field.
    """
    if not reboot_requested_at:
        return False
    if boot_epoch is None or now_epoch is None:
        return False
    if boot_epoch < 1700000000 or now_epoch < 1700000000:
        return False

    req_epoch = parse_utc_timestamp_epoch(reboot_requested_at)
    if req_epoch is None:
        return False
    if req_epoch <= boot_epoch:
        return False
    if (now_epoch - req_epoch) > max_age_seconds:
        return False
    return True


def build_reading_document(
    device_id,
    location,
    timestamp,
    co2_ppm,
    temperature_c,
    temperature_f,
    humidity_percent,
    pm1_0_ug_m3,
    pm2_5_ug_m3,
    pm10_0_ug_m3,
    aqi_us,
    aqi_category,
    particles_0_3um,
    particles_0_5um,
    particles_1_0um,
    particles_2_5um,
    particles_5_0um,
    particles_10_0um,
):
    """Build a `readings` document dict matching `firestore.rules`."""
    return {
        "device_id": str(device_id),
        "location": str(location),
        "timestamp": str(timestamp),
        "co2_ppm": int(co2_ppm),
        "temperature_c": round(float(temperature_c), 2),
        "temperature_f": round(float(temperature_f), 2),
        "humidity_percent": round(float(humidity_percent), 2),
        "pm1_0_ug_m3": int(pm1_0_ug_m3),
        "pm2_5_ug_m3": int(pm2_5_ug_m3),
        "pm10_0_ug_m3": int(pm10_0_ug_m3),
        "aqi_us": int(aqi_us),
        "aqi_category": str(aqi_category),
        "particles_0_3um": int(particles_0_3um),
        "particles_0_5um": int(particles_0_5um),
        "particles_1_0um": int(particles_1_0um),
        "particles_2_5um": int(particles_2_5um),
        "particles_5_0um": int(particles_5_0um),
        "particles_10_0um": int(particles_10_0um),
    }


def build_device_status_document(
    device_id,
    location,
    last_seen_at,
    firmware_version,
    sensors,
    reporting_interval_seconds,
    reading,
    config_version=None,
    temperature_offset_c=None,
    altitude_m=None,
    led_enabled=None,
    ota_status=None,
    ota_target_version=None,
    ota_last_error=None,
):
    """Build a `devices/{device_id}` document dict matching `firestore.rules`."""
    doc = {
        "device_id": str(device_id),
        "location": str(location),
        "last_seen_at": str(last_seen_at),
        "firmware_version": str(firmware_version),
        "sensors": list(sensors),
        "reporting_interval_seconds": int(reporting_interval_seconds),
        "latest_reading": {
            "co2_ppm": int(reading["co2_ppm"]),
            "temperature_f": round(float(reading["temperature_f"]), 2),
            "humidity_percent": round(float(reading["humidity_percent"]), 2),
            "pm2_5_ug_m3": int(reading["pm2_5_ug_m3"]),
            "aqi_us": int(reading["aqi_us"]),
            "aqi_category": str(reading["aqi_category"]),
        },
    }
    if config_version is not None:
        doc["config_version"] = int(config_version)
    if temperature_offset_c is not None:
        doc["temperature_offset_c"] = round(float(temperature_offset_c), 2)
    if altitude_m is not None:
        doc["altitude_m"] = int(round(altitude_m))
    if led_enabled is not None:
        doc["led_enabled"] = bool(led_enabled)
    if ota_status is not None and ota_status in VALID_OTA_STATUSES:
        doc["ota_status"] = str(ota_status)
    if ota_target_version is not None and is_valid_firmware_version(ota_target_version):
        doc["ota_target_version"] = str(ota_target_version)
    if ota_last_error is not None:
        err_text = str(ota_last_error).replace("\r", " ").replace("\n", " ").strip()
        if err_text:
            doc["ota_last_error"] = err_text[:200]
    return doc


class FirestoreClient:
    """Authenticates a dedicated sensor device with Firebase Auth and writes to Firestore."""

    def __init__(
        self,
        project_id,
        web_api_key,
        device_email,
        device_password,
        session=None,
        token_refresh_margin=300,
    ):
        self.project_id = project_id
        self.web_api_key = web_api_key
        self.device_email = device_email
        self.device_password = device_password
        self._session = session if session is not None else _UrllibSession()
        self._token_refresh_margin = token_refresh_margin

        self._id_token = None
        self._refresh_token = None
        self._token_expires_at = 0.0
        self.user_id = None

    @property
    def documents_base_url(self):
        return "{}/projects/{}/databases/(default)/documents".format(
            FIRESTORE_API_BASE, self.project_id
        )

    def sign_in(self):
        """Authenticate via Firebase Auth Email/Password REST API."""
        url = "{}?key={}".format(FIREBASE_SIGN_IN_URL, self.web_api_key)
        payload = {
            "email": self.device_email,
            "password": self.device_password,
            "returnSecureToken": True,
        }
        response = self._session.post(url, json=payload)
        try:
            if response.status_code != 200:
                raise FirestoreError(
                    "Firebase sign-in failed (HTTP {})".format(response.status_code),
                    status_code=response.status_code,
                    body=response.text,
                )
            data = response.json()
            self._id_token = data["idToken"]
            self._refresh_token = data["refreshToken"]
            self.user_id = data.get("localId")
            expires_in = int(data.get("expiresIn", 3600))
            self._token_expires_at = time.monotonic() + expires_in
            return self._id_token
        finally:
            response.close()

    def refresh_id_token(self):
        """Exchange the refresh token for a fresh 1-hour Firebase ID token."""
        if not self._refresh_token:
            return self.sign_in()

        url = "{}?key={}".format(FIREBASE_REFRESH_URL, self.web_api_key)
        payload = {
            "grant_type": "refresh_token",
            "refresh_token": self._refresh_token,
        }
        response = self._session.post(url, json=payload)
        try:
            if response.status_code != 200:
                # Refresh token may be revoked or expired; fall back to full sign-in.
                return self.sign_in()
            data = response.json()
            # Note: securetoken.googleapis.com returns snake_case keys (unlike signInWithPassword).
            self._id_token = data["id_token"]
            self._refresh_token = data.get("refresh_token", self._refresh_token)
            self.user_id = data.get("user_id", self.user_id)
            expires_in = int(data.get("expires_in", 3600))
            self._token_expires_at = time.monotonic() + expires_in
            return self._id_token
        finally:
            response.close()

    def ensure_authenticated(self):
        """Return a valid Firebase ID token, signing in or refreshing proactively."""
        if not self._id_token:
            return self.sign_in()
        if time.monotonic() >= (self._token_expires_at - self._token_refresh_margin):
            return self.refresh_id_token()
        return self._id_token

    def _authorized_request(self, method, url, payload=None, allow_not_found=False):
        """Execute an authenticated Firestore REST call, retrying once on HTTP 401."""
        for attempt in range(2):
            token = self.ensure_authenticated()
            headers = {
                "Authorization": "Bearer {}".format(token),
            }
            if method == "GET":
                response = self._session.get(url, headers=headers)
            elif method == "POST":
                headers["Content-Type"] = "application/json"
                response = self._session.post(url, json=payload, headers=headers)
            elif method == "PATCH":
                headers["Content-Type"] = "application/json"
                response = self._session.patch(url, json=payload, headers=headers)
            else:
                raise ValueError("Unsupported HTTP method: {}".format(method))

            try:
                if response.status_code == 401 and attempt == 0:
                    # Force token refresh and retry once.
                    self._token_expires_at = 0.0
                    continue
                if allow_not_found and response.status_code == 404:
                    return None
                if response.status_code not in (200, 201):
                    raise FirestoreError(
                        "Firestore {} failed (HTTP {})".format(
                            method, response.status_code
                        ),
                        status_code=response.status_code,
                        body=response.text,
                    )
                return response.json()
            finally:
                response.close()

        raise FirestoreError("Firestore request failed after authentication retry")

    def fetch_device_config(self, device_id):
        """Fetch and decode `device_configs/{device_id}` (returns None on HTTP 404)."""
        url = "{}/device_configs/{}".format(self.documents_base_url, device_id)
        doc = self._authorized_request("GET", url, allow_not_found=True)
        if not doc:
            return None
        return decode_firestore_fields(doc.get("fields", {}))

    def fetch_firmware_release(self, version):
        """Fetch and decode `firmware_releases/{version}` (returns None on HTTP 404)."""
        if not is_valid_firmware_version(version):
            raise ValueError("Invalid firmware version: {!r}".format(version))
        url = "{}/firmware_releases/{}".format(self.documents_base_url, version)
        doc = self._authorized_request("GET", url, allow_not_found=True)
        if not doc:
            return None
        return decode_firestore_fields(doc.get("fields", {}))

    def fetch_firmware_release_file(self, version, filename):
        """Fetch and decode `firmware_releases/{version}/files/{filename}` (None on 404)."""
        if not is_valid_firmware_version(version):
            raise ValueError("Invalid firmware version: {!r}".format(version))
        if not is_valid_ota_filename(filename):
            raise ValueError("Invalid or protected OTA filename: {!r}".format(filename))
        url = "{}/firmware_releases/{}/files/{}".format(
            self.documents_base_url, version, filename
        )
        doc = self._authorized_request("GET", url, allow_not_found=True)
        if not doc:
            return None
        return decode_firestore_fields(doc.get("fields", {}))

    def publish_reading(self, reading, document_id=None):
        """Create a new immutable document in the `readings` collection."""
        url = "{}/readings".format(self.documents_base_url)
        if document_id:
            url = "{}?documentId={}".format(url, document_id)

        payload = {
            "fields": encode_firestore_fields(
                reading, timestamp_fields=("timestamp",)
            )
        }
        return self._authorized_request("POST", url, payload)

    def update_device_status(self, device_status):
        """Create or update the `devices/{device_id}` registry document."""
        device_id = device_status["device_id"]
        url = "{}/devices/{}".format(self.documents_base_url, device_id)
        payload = {
            "fields": encode_firestore_fields(
                device_status, timestamp_fields=("last_seen_at",)
            )
        }
        return self._authorized_request("PATCH", url, payload)
