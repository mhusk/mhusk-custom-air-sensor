"""Main CircuitPython air quality sensor application for Adafruit Feather ESP32-S3.

Launched by the minimal immutable bootloader in `code.py` so OTA updates and
automatic `.bak` rollbacks can replace this module safely without touching `code.py`.

Reads indoor air quality telemetry from two daisy-chained STEMMA QT I2C sensors:
  - Sensirion SCD-40 (0x62): True photoacoustic CO2, temperature, relative humidity
  - Plantower PMSA003I (0x12): PM1.0, PM2.5, PM10.0, and 6 particle count bins

Computes US EPA AQI on-device (aqi.py), syncs UTC time via NTP, authenticates
with Firebase Auth, polls optional remote settings from `device_configs/{device_id}`,
and publishes readings + device status to Cloud Firestore on the active interval
(default 5 minutes, overridable via cloud config or settings.toml).

Onboard NeoPixel status codes (muted when remote `led_enabled` is false):
  - Solid Blue        : Booting, initializing I2C/Wi-Fi/NTP
  - Solid Cyan        : Downloading and verifying a Cloud OTA firmware update
  - Green pulse (1s)  : Reading published cleanly, then LED turns OFF
  - Slow Amber blink  : Wi-Fi, NTP, or Firestore error (auto-retrying)
  - Fast Red blink    : I2C hardware or sensor read error (auto-retrying)
"""

import gc
import os
import ssl
import time

import adafruit_connection_manager
import adafruit_ntp
import adafruit_requests
import adafruit_scd4x
import board
import microcontroller
import neopixel
import rtc
import wifi
from adafruit_pm25.i2c import PM25_I2C
from microcontroller import watchdog as wdt
from watchdog import WatchDogMode

import aqi
import firestore_client
import ota_updater
from firestore_client import FirestoreClient, FirestoreError

# Firmware & hardware constants
FIRMWARE_VERSION = "1.3.3"
SUPPORTS_HEALTH_CALLBACK = True
SENSORS = ["SCD-40", "PMSA003I"]
SCD40_I2C_ADDR = 0x62
PMSA003I_I2C_ADDR = 0x12

# Timing, calibration & resilience constants
DEFAULT_INTERVAL_SECONDS = 300
MIN_INTERVAL_SECONDS = 60
MAX_INTERVAL_SECONDS = 3600
DEFAULT_TEMPERATURE_OFFSET_C = 4.0  # Sensirion SCD-40 factory default
DEFAULT_ALTITUDE_M = 0
DEFAULT_LED_ENABLED = True
REBOOT_REQUEST_MAX_AGE_SECONDS = 1800
OTA_ERROR_COOLDOWN_SECONDS = 300
NTP_RESYNC_INTERVAL_SECONDS = 21600  # Re-sync UTC clock every 6 hours
WATCHDOG_TIMEOUT_SECONDS = 60
NETWORK_RETRY_SECONDS = 30
HARDWARE_RETRY_SECONDS = 15
MAX_CONSECUTIVE_NETWORK_ERRORS = 10

# Onboard NeoPixel status colors (R, G, B)
COLOR_OFF = (0, 0, 0)
COLOR_BLUE = (0, 0, 255)
COLOR_CYAN = (0, 200, 255)
COLOR_GREEN = (0, 255, 0)
COLOR_AMBER = (255, 140, 0)
COLOR_RED = (255, 0, 0)

# Public Google Trust Services Root CA certificates (valid through 2036-06-22).
# Loading these direct self-signed anchors avoids ESP-IDF's MBEDTLS_ERR_X509_FATAL_ERROR
# (-12288) on Google APIs serving GTS Root R4 cross-signed by GlobalSign Root CA.
GTS_ROOT_R4_PEM = (
    "-----BEGIN CERTIFICATE-----\n"
    "MIICCjCCAZGgAwIBAgIQbkepyIuUtui7OyrYorLBmTAKBggqhkjOPQQDAzBHMQsw\n"
    "CQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEU\n"
    "MBIGA1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAw\n"
    "MDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZp\n"
    "Y2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQA\n"
    "IgNiAATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzu\n"
    "hXyiQHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/l\n"
    "xKvRHYqjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1Ud\n"
    "DgQWBBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNnADBkAjBqUFJ0\n"
    "CMRw3J5QdCHojXohw0+WbhXRIjVhLfoIN+4Zba3bssx9BzT1YBkstTTZbyACMANx\n"
    "sbqjYAuG7ZoIapVon+Kz4ZNkfF6Tpt95LY2F45TPI11xzPKwTdb+mciUqXWi4w==\n"
    "-----END CERTIFICATE-----\n"
)

GTS_ROOT_R1_PEM = (
    "-----BEGIN CERTIFICATE-----\n"
    "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\n"
    "-----END CERTIFICATE-----\n"
)


class HardwareError(Exception):
    """Raised when an I2C sensor is missing or fails to respond."""


class StatusLED:
    """Thin wrapper around the Feather ESP32-S3 onboard RGB NeoPixel."""

    def __init__(self, brightness=0.2, enabled=True):
        self._pixel = neopixel.NeoPixel(
            board.NEOPIXEL, 1, brightness=brightness, auto_write=True
        )
        self.enabled = bool(enabled)

    def set_enabled(self, enabled):
        self.enabled = bool(enabled)
        if not self.enabled:
            self.off()

    def set(self, color):
        self._pixel[0] = color if self.enabled else COLOR_OFF

    def off(self):
        self._pixel[0] = COLOR_OFF

    def pulse_success(self, duration=1.0):
        """Show a brief green pulse, then turn the LED off to stay unobtrusive."""
        if not self.enabled:
            self.off()
            return
        self.set(COLOR_GREEN)
        sleep_with_watchdog(duration)
        self.off()

    def blink_for(self, color, total_seconds, on_seconds, off_seconds):
        """Blink a status color for `total_seconds` while feeding the watchdog."""
        if not self.enabled:
            self.off()
            sleep_with_watchdog(total_seconds)
            return
        deadline = time.monotonic() + total_seconds
        while time.monotonic() < deadline:
            self.set(color)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sleep_with_watchdog(min(on_seconds, remaining))

            self.off()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sleep_with_watchdog(min(off_seconds, remaining))
        self.off()


def init_watchdog(timeout_seconds=WATCHDOG_TIMEOUT_SECONDS):
    """Enable the hardware watchdog so stuck sockets or locks self-recover.

    If `code.py` already armed the watchdog during a pending OTA boot, simply feed it:
    re-assigning `wdt.mode` or `wdt.timeout` while active raises `espidf.IDFError:
    Invalid argument` on ESP32-S3 (CircuitPython 10 / ESP-IDF).
    """
    if wdt.mode == WatchDogMode.RESET:
        wdt.feed()
        return
    wdt.timeout = timeout_seconds
    wdt.mode = WatchDogMode.RESET
    wdt.feed()


def feed_watchdog():
    """Reset the hardware watchdog countdown if it is active."""
    try:
        if wdt.mode is not None:
            wdt.feed()
    except Exception:
        pass


def disable_watchdog():
    """Disable the watchdog on clean exit (e.g., Ctrl+C in the serial REPL)."""
    try:
        wdt.mode = None
    except Exception:
        pass


def sleep_with_watchdog(seconds):
    """Sleep for `seconds` in <=1s increments while feeding the watchdog."""
    if seconds <= 0:
        feed_watchdog()
        return
    deadline = time.monotonic() + seconds
    while True:
        feed_watchdog()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(1.0, remaining))


def _clamp(value, low, high):
    if value < low:
        return low
    if value > high:
        return high
    return value


def load_config():
    """Read required Wi-Fi, Firebase, and sensor settings from settings.toml."""
    required_keys = (
        "CIRCUITPY_WIFI_SSID",
        "CIRCUITPY_WIFI_PASSWORD",
        "FIREBASE_PROJECT_ID",
        "FIREBASE_WEB_API_KEY",
        "FIREBASE_DEVICE_EMAIL",
        "FIREBASE_DEVICE_PASSWORD",
    )
    config = {}
    missing = []
    for key in required_keys:
        val = os.getenv(key)
        if val is None or str(val).strip() == "":
            missing.append(key)
        else:
            config[key] = str(val).strip()

    if missing:
        raise ValueError(
            "Missing required keys in settings.toml: {}".format(", ".join(missing))
        )

    device_id = str(os.getenv("SENSOR_DEVICE_ID") or "feather-s3-01").strip()
    location = str(os.getenv("SENSOR_LOCATION") or "home-office").strip()

    raw_interval = os.getenv("SENSOR_INTERVAL_SECONDS")
    try:
        interval_seconds = int(raw_interval) if raw_interval is not None else DEFAULT_INTERVAL_SECONDS
    except ValueError:
        interval_seconds = DEFAULT_INTERVAL_SECONDS

    interval_seconds = int(
        _clamp(interval_seconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS)
    )

    config["SENSOR_DEVICE_ID"] = device_id
    config["SENSOR_LOCATION"] = location
    config["SENSOR_INTERVAL_SECONDS"] = interval_seconds
    return config


def scan_i2c_addresses(i2c):
    """Return a list of 7-bit I2C addresses currently responding on the bus."""
    deadline = time.monotonic() + 2.0
    while not i2c.try_lock():
        if time.monotonic() > deadline:
            raise HardwareError("Timed out acquiring I2C bus lock")
        time.sleep(0.05)
    try:
        return i2c.scan()
    finally:
        i2c.unlock()


def init_sensors(i2c):
    """Verify both sensors on the STEMMA QT I2C bus and start SCD-40 measurements."""
    feed_watchdog()
    try:
        addresses = scan_i2c_addresses(i2c)
    except OSError as err:
        raise HardwareError("I2C bus scan failed: {}".format(err))

    missing = []
    if SCD40_I2C_ADDR not in addresses:
        missing.append("SCD-40 (0x62)")
    if PMSA003I_I2C_ADDR not in addresses:
        missing.append("PMSA003I (0x12)")
    if missing:
        found_hex = [hex(a) for a in addresses]
        raise HardwareError(
            "Missing I2C sensor(s): {} (found: {})".format(
                ", ".join(missing), found_hex
            )
        )

    try:
        scd4x = adafruit_scd4x.SCD4X(i2c)
        # Stop any stale periodic measurement left running across a soft reload.
        try:
            scd4x.stop_periodic_measurement()
            sleep_with_watchdog(0.5)
        except Exception:
            pass
        scd4x.start_periodic_measurement()

        pm25 = PM25_I2C(i2c, reset_pin=None)
    except Exception as err:
        raise HardwareError("Sensor initialization failed: {}".format(err))

    print("[I2C] SCD-40 (0x62) and PMSA003I (0x12) initialized.")
    return scd4x, pm25


def apply_scd40_calibration(scd4x, temperature_offset_c, altitude_m):
    """Apply temperature offset and altitude compensation in SCD-40 RAM (zero EEPROM wear).

    Per the Sensirion SCD-4x datasheet, `temperature_offset` and `altitude` may only be
    written while periodic measurement is stopped, so this helper pauses measurement for
    500 ms, writes both registers in RAM without calling `persist_settings()`, and resumes.
    """
    feed_watchdog()
    try:
        scd4x.stop_periodic_measurement()
        sleep_with_watchdog(0.5)
        scd4x.temperature_offset = float(temperature_offset_c)
        scd4x.altitude = int(altitude_m)
        scd4x.start_periodic_measurement()
    except Exception as err:
        raise HardwareError("Failed to apply SCD-40 calibration: {}".format(err))

    print(
        "[SCD-40] Applied RAM calibration: temperature_offset={:.2f}C, altitude={}m".format(
            float(temperature_offset_c), int(altitude_m)
        )
    )


def _read_scd40(scd4x, timeout_seconds=15.0):
    """Wait for a fresh SCD-40 sample and return (co2_ppm, temp_c, temp_f, rh)."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        feed_watchdog()
        try:
            if scd4x.data_ready:
                co2 = scd4x.CO2
                temp_c = scd4x.temperature
                humidity = scd4x.relative_humidity
                if co2 is not None and co2 > 0 and temp_c is not None and humidity is not None:
                    co2_ppm = int(_clamp(round(co2), 0, 40000))
                    temp_c_val = _clamp(float(temp_c), -40.0, 85.0)
                    temp_f_val = _clamp((temp_c_val * 9.0 / 5.0) + 32.0, -40.0, 185.0)
                    humidity_val = _clamp(float(humidity), 0.0, 100.0)
                    return co2_ppm, temp_c_val, temp_f_val, humidity_val
        except OSError as err:
            raise HardwareError("SCD-40 I2C read error: {}".format(err))
        sleep_with_watchdog(0.5)

    raise HardwareError("Timed out waiting for SCD-40 data_ready")


def _read_pmsa003i(pm25, max_attempts=5):
    """Read PMSA003I particulate concentrations and particle counts with retries."""
    last_err = None
    for attempt in range(max_attempts):
        feed_watchdog()
        try:
            aqdata = pm25.read()
            # Plantower naming: pm10=PM1.0, pm25=PM2.5, pm100=PM10.0 (env = ambient air)
            return {
                "pm1_0_ug_m3": int(_clamp(aqdata["pm10 env"], 0, 1000)),
                "pm2_5_ug_m3": int(_clamp(aqdata["pm25 env"], 0, 1000)),
                "pm10_0_ug_m3": int(_clamp(aqdata["pm100 env"], 0, 1000)),
                "particles_0_3um": int(_clamp(aqdata["particles 03um"], 0, 65535)),
                "particles_0_5um": int(_clamp(aqdata["particles 05um"], 0, 65535)),
                "particles_1_0um": int(_clamp(aqdata["particles 10um"], 0, 65535)),
                "particles_2_5um": int(_clamp(aqdata["particles 25um"], 0, 65535)),
                "particles_5_0um": int(_clamp(aqdata["particles 50um"], 0, 65535)),
                "particles_10_0um": int(_clamp(aqdata["particles 100um"], 0, 65535)),
            }
        except (RuntimeError, OSError, KeyError) as err:
            last_err = err
            if attempt < max_attempts - 1:
                sleep_with_watchdog(0.5)

    raise HardwareError("PMSA003I read failed after {} attempts: {}".format(max_attempts, last_err))


def read_sensors(scd4x, pm25):
    """Collect a combined snapshot from SCD-40 and PMSA003I and compute EPA AQI."""
    co2_ppm, temp_c, temp_f, humidity = _read_scd40(scd4x)
    pm_data = _read_pmsa003i(pm25)
    aqi_us, aqi_cat = aqi.calculate_aqi(pm_data["pm2_5_ug_m3"], pm_data["pm10_0_ug_m3"])

    return {
        "co2_ppm": co2_ppm,
        "temperature_c": temp_c,
        "temperature_f": temp_f,
        "humidity_percent": humidity,
        "pm1_0_ug_m3": pm_data["pm1_0_ug_m3"],
        "pm2_5_ug_m3": pm_data["pm2_5_ug_m3"],
        "pm10_0_ug_m3": pm_data["pm10_0_ug_m3"],
        "aqi_us": aqi_us,
        "aqi_category": aqi_cat,
        "particles_0_3um": pm_data["particles_0_3um"],
        "particles_0_5um": pm_data["particles_0_5um"],
        "particles_1_0um": pm_data["particles_1_0um"],
        "particles_2_5um": pm_data["particles_2_5um"],
        "particles_5_0um": pm_data["particles_5_0um"],
        "particles_10_0um": pm_data["particles_10_0um"],
    }


def ensure_wifi(ssid, password):
    """Ensure the ESP32-S3 is connected to 2.4GHz Wi-Fi with an IPv4 address."""
    feed_watchdog()
    if wifi.radio.connected and wifi.radio.ipv4_address is not None:
        return wifi.radio.ipv4_address

    print("[Wi-Fi] Connecting to 2.4GHz network...")
    wifi.radio.connect(ssid, password)
    feed_watchdog()
    if not wifi.radio.connected or wifi.radio.ipv4_address is None:
        raise OSError("Wi-Fi connected without an IPv4 address")
    print("[Wi-Fi] Connected (IP: {})".format(wifi.radio.ipv4_address))
    return wifi.radio.ipv4_address


def _build_google_ssl_context():
    """Build an SSLContext anchored on Google Trust Services Root R4 & R1."""
    ssl_context = ssl.create_default_context()
    try:
        ssl_context.load_verify_locations(
            cadata=GTS_ROOT_R4_PEM + "\n" + GTS_ROOT_R1_PEM
        )
    except Exception:
        ssl_context.load_verify_locations(cadata=GTS_ROOT_R4_PEM)
    return ssl_context


def sync_ntp_utc(pool):
    """Sync the ESP32-S3 hardware RTC to UTC via NTP (required by firestore.rules)."""
    feed_watchdog()
    ntp = adafruit_ntp.NTP(pool, tz_offset=0)
    rtc.RTC().datetime = ntp.datetime
    now = time.localtime()
    if now.tm_year < 2024:
        raise RuntimeError("NTP returned invalid year: {}".format(now.tm_year))
    ts = firestore_client.format_utc_timestamp(now)
    print("[NTP] Clock synced to UTC: {}".format(ts))
    return time.monotonic()


def main(on_healthy=None):
    led = StatusLED(brightness=0.2)
    led.set(COLOR_BLUE)
    print("\n=== Custom ESP32-S3 Air Quality Sensor (v{}) ===".format(FIRMWARE_VERSION))

    try:
        config = load_config()
    except ValueError as err:
        print("[CONFIG ERROR] {}".format(err))
        print("Copy firmware/settings.toml.example to CIRCUITPY/settings.toml and fill in values.")
        while True:
            led.set(COLOR_AMBER)
            time.sleep(1.0)
            led.set(COLOR_RED)
            time.sleep(1.0)

    device_id = config["SENSOR_DEVICE_ID"]
    local_defaults = {
        "location": config["SENSOR_LOCATION"],
        "reporting_interval_seconds": config["SENSOR_INTERVAL_SECONDS"],
        "temperature_offset_c": DEFAULT_TEMPERATURE_OFFSET_C,
        "altitude_m": DEFAULT_ALTITUDE_M,
        "led_enabled": DEFAULT_LED_ENABLED,
    }
    active_config = firestore_client.normalize_device_config(None, local_defaults)
    print(
        "[Config] Local defaults: device_id={}, location={}, interval={}s".format(
            device_id,
            active_config["location"],
            active_config["reporting_interval_seconds"],
        )
    )

    init_watchdog(WATCHDOG_TIMEOUT_SECONDS)

    # Give the PMSA003I internal fan & MCU 2 seconds to settle after cold power-on.
    sleep_with_watchdog(2.0)
    i2c = board.STEMMA_I2C()

    scd4x = None
    pm25 = None
    pool = None
    client = None
    last_ntp_sync = None
    boot_epoch = None
    applied_scd40_offset = None
    applied_scd40_altitude = None
    consecutive_network_errors = 0
    first_boot = True
    boot_confirmed = False

    boot_ota = ota_updater.check_post_boot_ota_state(FIRMWARE_VERSION)
    ota_status = boot_ota["ota_status"]
    ota_last_error = boot_ota["ota_last_error"]
    ota_failed_version = boot_ota["failed_version"]
    ota_target_version = None
    last_attempted_ota_target = None
    ota_retry_after_mono = 0.0
    if boot_ota["ota_state"] == ota_updater.OTA_STATE_ROLLED_BACK:
        print("[OTA WARN] {}".format(ota_last_error))

    try:
        while True:
            cycle_start = time.monotonic()
            if first_boot:
                led.set(COLOR_BLUE)

            try:
                # 1. Initialize or recover I2C sensors
                if scd4x is None or pm25 is None:
                    scd4x, pm25 = init_sensors(i2c)
                    applied_scd40_offset = None
                    applied_scd40_altitude = None

                # 2. Ensure Wi-Fi and HTTPS session / Firestore client
                ensure_wifi(
                    config["CIRCUITPY_WIFI_SSID"],
                    config["CIRCUITPY_WIFI_PASSWORD"],
                )
                if pool is None or client is None:
                    pool = adafruit_connection_manager.get_radio_socketpool(wifi.radio)
                    ssl_context = _build_google_ssl_context()
                    requests_session = adafruit_requests.Session(pool, ssl_context)
                    client = FirestoreClient(
                        project_id=config["FIREBASE_PROJECT_ID"],
                        web_api_key=config["FIREBASE_WEB_API_KEY"],
                        device_email=config["FIREBASE_DEVICE_EMAIL"],
                        device_password=config["FIREBASE_DEVICE_PASSWORD"],
                        session=requests_session,
                    )

                # 3. Sync UTC clock on boot and every 6 hours to prevent drift
                now_mono = time.monotonic()
                if (
                    last_ntp_sync is None
                    or (now_mono - last_ntp_sync) >= NTP_RESYNC_INTERVAL_SECONDS
                ):
                    last_ntp_sync = sync_ntp_utc(pool)
                    if boot_epoch is None:
                        boot_epoch = firestore_client.parse_utc_timestamp_epoch(
                            firestore_client.format_utc_timestamp(time.localtime())
                        )

                # 4. Poll remote config (`device_configs/{device_id}`) non-fatally in RAM
                try:
                    feed_watchdog()
                    raw_remote_cfg = client.fetch_device_config(device_id)
                    new_config = firestore_client.normalize_device_config(
                        raw_remote_cfg, local_defaults
                    )
                    if (
                        new_config["config_version"] != active_config["config_version"]
                        or new_config["location"] != active_config["location"]
                        or new_config["reporting_interval_seconds"]
                        != active_config["reporting_interval_seconds"]
                        or new_config["temperature_offset_c"]
                        != active_config["temperature_offset_c"]
                        or new_config["altitude_m"] != active_config["altitude_m"]
                        or new_config["led_enabled"] != active_config["led_enabled"]
                        or new_config["target_firmware_version"]
                        != active_config["target_firmware_version"]
                    ):
                        source = (
                            "cloud v{}".format(new_config["config_version"])
                            if raw_remote_cfg is not None
                            else "local defaults"
                        )
                        print(
                            "[Config] Active ({}): location={}, interval={}s, "
                            "temp_offset={:.2f}C, altitude={}m, led={}, target_fw={}".format(
                                source,
                                new_config["location"],
                                new_config["reporting_interval_seconds"],
                                new_config["temperature_offset_c"],
                                new_config["altitude_m"],
                                new_config["led_enabled"],
                                new_config["target_firmware_version"],
                            )
                        )
                    active_config = new_config
                except Exception as cfg_err:
                    print(
                        "[Config WARN] Remote config fetch skipped (keeping v{}): {}".format(
                            active_config["config_version"], cfg_err
                        )
                    )

                # Reconcile OTA target & clear prior rollback warning if operator changed target
                target_fw = active_config["target_firmware_version"]
                ota_target_version = target_fw
                if ota_status == "rolled_back":
                    if (
                        target_fw is None
                        or target_fw == FIRMWARE_VERSION
                        or (ota_failed_version is not None and target_fw != ota_failed_version)
                    ):
                        ota_updater.confirm_ota_healthy(
                            on_healthy=on_healthy,
                            clear_rolled_back=True,
                        )
                        ota_status = "up_to_date"
                        ota_last_error = None
                        ota_failed_version = None
                elif target_fw is None or target_fw == FIRMWARE_VERSION:
                    if ota_status == "error":
                        ota_status = "up_to_date"
                        ota_last_error = None
                        last_attempted_ota_target = None

                # 4a. Check one-shot remote reboot command
                now_epoch = firestore_client.parse_utc_timestamp_epoch(
                    firestore_client.format_utc_timestamp(time.localtime())
                )
                if firestore_client.should_trigger_reboot(
                    active_config["reboot_requested_at"],
                    boot_epoch,
                    now_epoch,
                    REBOOT_REQUEST_MAX_AGE_SECONDS,
                ):
                    print(
                        "[Config] Remote reboot requested ({}); resetting microcontroller...".format(
                            active_config["reboot_requested_at"]
                        )
                    )
                    led.off()
                    time.sleep(0.5)
                    microcontroller.reset()

                # 4b. Apply LED preference & SCD-40 RAM calibration (only when changed)
                led.set_enabled(active_config["led_enabled"])
                desired_offset = active_config["temperature_offset_c"]
                desired_altitude = active_config["altitude_m"]
                if (
                    applied_scd40_offset is None
                    or abs(desired_offset - applied_scd40_offset) >= 0.01
                    or desired_altitude != applied_scd40_altitude
                ):
                    apply_scd40_calibration(scd4x, desired_offset, desired_altitude)
                    applied_scd40_offset = desired_offset
                    applied_scd40_altitude = desired_altitude

                location = active_config["location"]
                interval_seconds = active_config["reporting_interval_seconds"]

                # 5. Read SCD-40 + PMSA003I and compute EPA AQI
                sample = read_sensors(scd4x, pm25)
                now_utc = time.localtime()
                if now_utc.tm_year < 2024:
                    last_ntp_sync = sync_ntp_utc(pool)
                    now_utc = time.localtime()

                ts = firestore_client.format_utc_timestamp(now_utc)
                reading = firestore_client.build_reading_document(
                    device_id=device_id,
                    location=location,
                    timestamp=ts,
                    co2_ppm=sample["co2_ppm"],
                    temperature_c=sample["temperature_c"],
                    temperature_f=sample["temperature_f"],
                    humidity_percent=sample["humidity_percent"],
                    pm1_0_ug_m3=sample["pm1_0_ug_m3"],
                    pm2_5_ug_m3=sample["pm2_5_ug_m3"],
                    pm10_0_ug_m3=sample["pm10_0_ug_m3"],
                    aqi_us=sample["aqi_us"],
                    aqi_category=sample["aqi_category"],
                    particles_0_3um=sample["particles_0_3um"],
                    particles_0_5um=sample["particles_0_5um"],
                    particles_1_0um=sample["particles_1_0um"],
                    particles_2_5um=sample["particles_2_5um"],
                    particles_5_0um=sample["particles_5_0um"],
                    particles_10_0um=sample["particles_10_0um"],
                )
                device_status = firestore_client.build_device_status_document(
                    device_id=device_id,
                    location=location,
                    last_seen_at=ts,
                    firmware_version=FIRMWARE_VERSION,
                    sensors=SENSORS,
                    reporting_interval_seconds=interval_seconds,
                    reading=reading,
                    config_version=active_config["config_version"],
                    temperature_offset_c=active_config["temperature_offset_c"],
                    altitude_m=active_config["altitude_m"],
                    led_enabled=active_config["led_enabled"],
                    ota_status=ota_status,
                    ota_target_version=ota_target_version,
                    ota_last_error=ota_last_error,
                )

                # 6. Publish reading and update device registry in Firestore
                doc_id = "{}_{}".format(device_id, int(time.time()))
                feed_watchdog()
                client.publish_reading(reading, document_id=doc_id)
                feed_watchdog()
                client.update_device_status(device_status)

                consecutive_network_errors = 0
                first_boot = False

                if not boot_confirmed:
                    try:
                        ota_updater.confirm_ota_healthy(
                            on_healthy=on_healthy,
                            clear_rolled_back=False,
                        )
                    except Exception as boot_err:
                        print("[BOOT WARN] Health callback failed: {}".format(boot_err))
                    boot_confirmed = True

                print(
                    "[OK {}] cfg=v{} | ota={} | CO2={} ppm | Temp={:.1f}F ({:.1f}C) | RH={:.1f}% | "
                    "PM1.0={} PM2.5={} PM10={} ug/m3 | AQI={} ({})".format(
                        ts,
                        active_config["config_version"],
                        ota_status,
                        reading["co2_ppm"],
                        reading["temperature_f"],
                        reading["temperature_c"],
                        reading["humidity_percent"],
                        reading["pm1_0_ug_m3"],
                        reading["pm2_5_ug_m3"],
                        reading["pm10_0_ug_m3"],
                        reading["aqi_us"],
                        reading["aqi_category"],
                    )
                )

                # 7. Check for pull-based Cloud OTA update after healthy publish
                if (
                    boot_confirmed
                    and target_fw is not None
                    and target_fw != FIRMWARE_VERSION
                    and (
                        target_fw != last_attempted_ota_target
                        or time.monotonic() >= ota_retry_after_mono
                    )
                ):
                    print(
                        "[OTA] Target firmware v{} differs from running v{}; checking release...".format(
                            target_fw, FIRMWARE_VERSION
                        )
                    )
                    led.set(COLOR_CYAN)

                    def _report_updating(ver):
                        updating_doc = firestore_client.build_device_status_document(
                            device_id=device_id,
                            location=location,
                            last_seen_at=ts,
                            firmware_version=FIRMWARE_VERSION,
                            sensors=SENSORS,
                            reporting_interval_seconds=interval_seconds,
                            reading=reading,
                            config_version=active_config["config_version"],
                            temperature_offset_c=active_config["temperature_offset_c"],
                            altitude_m=active_config["altitude_m"],
                            led_enabled=active_config["led_enabled"],
                            ota_status="updating",
                            ota_target_version=ver,
                            ota_last_error=None,
                        )
                        feed_watchdog()
                        client.update_device_status(updating_doc)

                    ota_result = ota_updater.perform_ota_update(
                        client=client,
                        current_version=FIRMWARE_VERSION,
                        target_version=target_fw,
                        failed_version=ota_failed_version,
                        feed_watchdog_fn=feed_watchdog,
                        on_before_swap=_report_updating,
                    )
                    # Only reached if OTA was skipped or failed before reset.
                    ota_status = ota_result["ota_status"]
                    ota_target_version = ota_result["ota_target_version"]
                    if not (
                        ota_result["action"] == "skipped_rolled_back"
                        and ota_last_error
                    ):
                        ota_last_error = ota_result["ota_last_error"]
                    last_attempted_ota_target = target_fw
                    ota_retry_after_mono = time.monotonic() + OTA_ERROR_COOLDOWN_SECONDS
                    print(
                        "[OTA WARN] {} (status={}, error={})".format(
                            ota_result["action"], ota_status, ota_last_error
                        )
                    )
                    try:
                        err_doc = firestore_client.build_device_status_document(
                            device_id=device_id,
                            location=location,
                            last_seen_at=ts,
                            firmware_version=FIRMWARE_VERSION,
                            sensors=SENSORS,
                            reporting_interval_seconds=interval_seconds,
                            reading=reading,
                            config_version=active_config["config_version"],
                            temperature_offset_c=active_config["temperature_offset_c"],
                            altitude_m=active_config["altitude_m"],
                            led_enabled=active_config["led_enabled"],
                            ota_status=ota_status,
                            ota_target_version=ota_target_version,
                            ota_last_error=ota_last_error,
                        )
                        feed_watchdog()
                        client.update_device_status(err_doc)
                    except Exception as status_err:
                        print(
                            "[OTA WARN] Failed to report OTA error status: {}".format(
                                status_err
                            )
                        )
                    led.off()

                gc.collect()
                led.pulse_success(1.0)

                elapsed = time.monotonic() - cycle_start
                sleep_remaining = interval_seconds - elapsed
                if sleep_remaining > 0:
                    sleep_with_watchdog(sleep_remaining)

            except HardwareError as err:
                print("[HARDWARE ERROR] {}".format(err))
                # Force re-scan and re-init on next attempt so unplug/replug self-heals.
                scd4x = None
                pm25 = None
                applied_scd40_offset = None
                applied_scd40_altitude = None
                gc.collect()
                led.blink_for(COLOR_RED, HARDWARE_RETRY_SECONDS, 0.2, 0.2)

            except Exception as err:
                consecutive_network_errors += 1
                print(
                    "[NETWORK/PUBLISH ERROR ({}/{})] {}".format(
                        consecutive_network_errors,
                        MAX_CONSECUTIVE_NETWORK_ERRORS,
                        err,
                    )
                )
                if isinstance(err, FirestoreError) and err.body:
                    print("[Firestore response] {}".format(err.body[:200]))

                # Close any lingering sockets and rebuild client if Wi-Fi dropped
                if pool is not None and hasattr(
                    adafruit_connection_manager, "connection_manager_close_all"
                ):
                    try:
                        adafruit_connection_manager.connection_manager_close_all(pool)
                    except Exception:
                        pass

                if not wifi.radio.connected or consecutive_network_errors >= 2:
                    pool = None
                    client = None

                gc.collect()
                led.blink_for(COLOR_AMBER, NETWORK_RETRY_SECONDS, 0.8, 0.8)

                if consecutive_network_errors >= MAX_CONSECUTIVE_NETWORK_ERRORS:
                    print(
                        "[RECOVERY] {} consecutive network errors; resetting microcontroller...".format(
                            consecutive_network_errors
                        )
                    )
                    time.sleep(0.5)
                    microcontroller.reset()

    except KeyboardInterrupt:
        print("\n[INFO] Interrupted by user; returning to REPL.")
        raise
    finally:
        led.off()
        disable_watchdog()


if __name__ == "__main__":
    main()
