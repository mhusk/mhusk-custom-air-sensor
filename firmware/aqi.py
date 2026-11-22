"""US EPA Air Quality Index (AQI) calculator for PM2.5 and PM10.

Pure-Python module compatible with both CircuitPython 9.x (ESP32-S3) and
standard CPython 3 (macOS/Linux local testing).

Uses the revised 2024 US EPA PM2.5 AQI breakpoints (effective May 6, 2024)
and standard US EPA PM10 breakpoints from the EPA Technical Assistance
Document for the Reporting of Daily Air Quality (EPA-454/B-24-002).
"""

# (C_low, C_high, I_low, I_high)
# PM2.5 concentrations are truncated to 1 decimal place per EPA guidance.
PM25_BREAKPOINTS = (
    (0.0, 9.0, 0, 50),
    (9.1, 35.4, 51, 100),
    (35.5, 55.4, 101, 150),
    (55.5, 125.4, 151, 200),
    (125.5, 225.4, 201, 300),
    (225.5, 325.4, 301, 500),
)

# PM10 concentrations are truncated to an integer per EPA guidance.
PM10_BREAKPOINTS = (
    (0, 54, 0, 50),
    (55, 154, 51, 100),
    (155, 254, 101, 150),
    (255, 354, 151, 200),
    (355, 424, 201, 300),
    (425, 504, 301, 400),
    (505, 604, 401, 500),
)

AQI_CATEGORIES = (
    (50, "Good"),
    (100, "Moderate"),
    (150, "Unhealthy for Sensitive Groups"),
    (200, "Unhealthy"),
    (300, "Very Unhealthy"),
    (500, "Hazardous"),
)


def _truncate_1_decimal(value):
    """Truncate a non-negative float to 1 decimal place (EPA PM2.5 rule)."""
    if value <= 0.0:
        return 0.0
    # Add tiny epsilon to avoid IEEE-754 representation drops like 9.1 * 10 = 90.99999999999999
    return int(value * 10.0 + 1e-9) / 10.0


def _linear_aqi(conc, breakpoints):
    """Compute rounded linear AQI across a breakpoint table, clamped to [0, 500]."""
    if conc <= 0:
        return 0

    for c_low, c_high, i_low, i_high in breakpoints:
        if c_low <= conc <= c_high:
            aqi = ((i_high - i_low) / (c_high - c_low)) * (conc - c_low) + i_low
            return int(aqi + 0.5)

    # Concentrations above the top breakpoint clamp to 500 (matches Firestore rules)
    return 500


def pm25_to_aqi(pm25_ug_m3):
    """Convert PM2.5 concentration (ug/m3) to US EPA AQI (0-500)."""
    conc = _truncate_1_decimal(float(pm25_ug_m3))
    return _linear_aqi(conc, PM25_BREAKPOINTS)


def pm10_to_aqi(pm10_ug_m3):
    """Convert PM10 concentration (ug/m3) to US EPA AQI (0-500)."""
    if pm10_ug_m3 <= 0:
        return 0
    conc = int(float(pm10_ug_m3))
    return _linear_aqi(conc, PM10_BREAKPOINTS)


def aqi_category(aqi_value):
    """Map a numeric US EPA AQI value (0-500) to its official category string."""
    for upper_bound, label in AQI_CATEGORIES:
        if aqi_value <= upper_bound:
            return label
    return "Hazardous"


def calculate_aqi(pm25_ug_m3, pm10_ug_m3=None):
    """Return (aqi_us, aqi_category) using the worst sub-index of PM2.5 and PM10."""
    aqi = pm25_to_aqi(pm25_ug_m3)
    if pm10_ug_m3 is not None:
        pm10_aqi = pm10_to_aqi(pm10_ug_m3)
        if pm10_aqi > aqi:
            aqi = pm10_aqi

    if aqi < 0:
        aqi = 0
    elif aqi > 500:
        aqi = 500

    return aqi, aqi_category(aqi)
