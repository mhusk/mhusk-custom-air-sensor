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

    def post(self, url, json=None, headers=None):  # pylint: disable=redefined-builtin
        return self._request("POST", url, json_body=json, headers=headers)

    def patch(self, url, json=None, headers=None):  # pylint: disable=redefined-builtin
        return self._request("PATCH", url, json_body=json, headers=headers)


def format_utc_timestamp(struct_time=None):
    """Format a UTC time tuple as an RFC 3339 timestamp string (YYYY-MM-DDTHH:MM:SSZ)."""
    t = struct_time if struct_time is not None else time.gmtime()
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
):
    """Build a `devices/{device_id}` document dict matching `firestore.rules`."""
    return {
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

    def _authorized_request(self, method, url, payload):
        """Execute an authenticated Firestore REST call, retrying once on HTTP 401."""
        for attempt in range(2):
            token = self.ensure_authenticated()
            headers = {
                "Authorization": "Bearer {}".format(token),
                "Content-Type": "application/json",
            }
            if method == "POST":
                response = self._session.post(url, json=payload, headers=headers)
            elif method == "PATCH":
                response = self._session.patch(url, json=payload, headers=headers)
            else:
                raise ValueError("Unsupported HTTP method: {}".format(method))

            try:
                if response.status_code == 401 and attempt == 0:
                    # Force token refresh and retry once.
                    self._token_expires_at = 0.0
                    continue
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
