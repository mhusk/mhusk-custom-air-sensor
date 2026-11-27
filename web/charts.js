/**
 * Zero-dependency interactive SVG time-series charts for CO2, PM2.5,
 * Temperature (°F), and Relative Humidity (% RH).
 *
 * Pure geometry helpers are exported for offline Node.js unit testing.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

const CHART_WIDTH = 560;
const CHART_HEIGHT = 216;
const PAD_TOP = 16;
const PAD_RIGHT = 14;
const PAD_BOTTOM = 30;
const PAD_LEFT = 46;

/**
 * Computes clean Y-axis bounds and tick values for a numeric series.
 *
 * @param {number[]} values
 * @param {{
 *   minFloor?: number,
 *   suggestedMin?: number,
 *   suggestedMax?: number,
 *   ticks?: number,
 * }} [options]
 * @returns {{ min: number, max: number, ticks: number[] }}
 */
export function computeNiceDomain(values, options = {}) {
  const { minFloor, suggestedMin, suggestedMax, ticks = 4 } = options;
  let minVal = values.length > 0 ? Math.min(...values) : (suggestedMin ?? 0);
  let maxVal = values.length > 0 ? Math.max(...values) : (suggestedMax ?? 100);

  if (suggestedMin !== undefined) {
    minVal = Math.min(minVal, suggestedMin);
  }
  if (suggestedMax !== undefined) {
    maxVal = Math.max(maxVal, suggestedMax);
  }

  if (minVal === maxVal) {
    const pad = Math.max(Math.abs(minVal) * 0.15, 5);
    minVal -= pad;
    maxVal += pad;
  } else {
    const span = maxVal - minVal;
    minVal -= span * 0.08;
    maxVal += span * 0.1;
  }

  if (minFloor !== undefined) {
    minVal = Math.max(minFloor, minVal);
  }

  const rawStep = (maxVal - minVal) / Math.max(ticks - 1, 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep || 1));
  const normalized = rawStep / magnitude;
  let niceFactor = 1;
  if (normalized <= 1) niceFactor = 1;
  else if (normalized <= 2) niceFactor = 2;
  else if (normalized <= 2.5) niceFactor = 2.5;
  else if (normalized <= 5) niceFactor = 5;
  else niceFactor = 10;

  const step = niceFactor * magnitude;
  const niceMin = Math.floor(minVal / step) * step;
  const clampedMin = minFloor !== undefined ? Math.max(minFloor, niceMin) : niceMin;
  let niceMax = Math.ceil(maxVal / step) * step;
  if (niceMax <= clampedMin) {
    niceMax = clampedMin + step;
  }

  const tickValues = [];
  const count = Math.min(8, Math.round((niceMax - clampedMin) / step) + 1);
  for (let i = 0; i < count; i += 1) {
    const t = clampedMin + i * step;
    if (t <= niceMax + step * 0.001) {
      tickValues.push(Number(t.toFixed(4)));
    }
  }

  return {
    min: clampedMin,
    max: tickValues[tickValues.length - 1] ?? niceMax,
    ticks: tickValues,
  };
}

/**
 * Splits a sorted time series into contiguous segments so long sensor offline
 * gaps don't draw misleading straight interpolation lines.
 *
 * @param {Array<{ timeMs: number, value: number }>} points
 * @param {number} maxGapMs
 * @returns {Array<Array<{ timeMs: number, value: number }>>}
 */
export function buildSeriesSegments(points, maxGapMs) {
  if (!points.length) return [];
  const segments = [];
  let current = [points[0]];

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const next = points[i];
    if (next.timeMs - prev.timeMs > maxGapMs) {
      segments.push(current);
      current = [next];
    } else {
      current.push(next);
    }
  }
  segments.push(current);
  return segments;
}

/**
 * Finds the nearest point index to a target epoch timestamp using binary search.
 *
 * @param {Array<{ timeMs: number }>} points
 * @param {number} targetTimeMs
 * @returns {number}
 */
export function findNearestPointIndex(points, targetTimeMs) {
  if (!points.length) return -1;
  if (points.length === 1) return 0;

  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].timeMs < targetTimeMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  if (lo === 0) return 0;
  const prevDist = Math.abs(targetTimeMs - points[lo - 1].timeMs);
  const currDist = Math.abs(points[lo].timeMs - targetTimeMs);
  return prevDist <= currDist ? lo - 1 : lo;
}

/**
 * Helper to create a namespaced SVG element with attributes.
 *
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 * @returns {SVGElement}
 */
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  return el;
}

const AXIS_TIME_SHORT_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const AXIS_TIME_LONG_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const HOVER_TIME_SHORT_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  day: "numeric",
});
const HOVER_TIME_LONG_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Converts a telemetry field to a finite number, returning NaN for null/undefined/blank
 * so missing sensor samples create gaps instead of coercing `null` to `0`.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function toFiniteNumberOrNaN(value) {
  if (value === null || value === undefined || value === "") {
    return Number.NaN;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : Number.NaN;
}

/**
 * Formats an axis timestamp according to the selected time window.
 *
 * @param {number} timeMs
 * @param {number} hours
 * @returns {string}
 */
function formatAxisTime(timeMs, hours) {
  const date = new Date(timeMs);
  return hours <= 24 ? AXIS_TIME_SHORT_FMT.format(date) : AXIS_TIME_LONG_FMT.format(date);
}

/**
 * Formats a detailed tooltip timestamp.
 *
 * @param {number} timeMs
 * @param {number} hours
 * @returns {string}
 */
function formatHoverTime(timeMs, hours) {
  const date = new Date(timeMs);
  return hours <= 24 ? HOVER_TIME_SHORT_FMT.format(date) : HOVER_TIME_LONG_FMT.format(date);
}

/**
 * Renders one interactive SVG trend chart card into `container`.
 *
 * @param {HTMLElement} container
 * @param {{
 *   id: string,
 *   title: string,
 *   unit: string,
 *   colorVar: string,
 *   decimals?: number,
 *   hours: number,
 *   readings: Array<Record<string, unknown>>,
 *   field: string,
 *   stats?: { min: number, max: number, avg: number, p95: number } | null,
 *   domainOptions?: { minFloor?: number, suggestedMin?: number, suggestedMax?: number },
 *   thresholds?: Array<{ value: number, label: string, tone: "warn" | "danger" }>,
 *   idealBand?: { min: number, max: number, label: string } | null,
 *   overlay?: {
 *     label: string,
 *     readings: Array<Record<string, unknown>>,
 *     field: string,
 *   } | null,
 * }} spec
 */
export function renderTrendChartCard(container, spec) {
  const decimals = spec.decimals ?? 0;
  const formatVal = (v) => (decimals > 0 ? Number(v).toFixed(decimals) : String(Math.round(v)));

  const points = (spec.readings || [])
    .map((r) => ({
      timeMs: Date.parse(String(r.timestamp)),
      value: toFiniteNumberOrNaN(r[spec.field]),
    }))
    .filter((p) => Number.isFinite(p.timeMs) && Number.isFinite(p.value))
    .sort((a, b) => a.timeMs - b.timeMs);

  const overlayPoints = spec.overlay
    ? (spec.overlay.readings || [])
        .map((r) => ({
          timeMs: Date.parse(String(r.timestamp)),
          value: toFiniteNumberOrNaN(r[spec.overlay.field]),
        }))
        .filter((p) => Number.isFinite(p.timeMs) && Number.isFinite(p.value))
        .sort((a, b) => a.timeMs - b.timeMs)
    : [];

  const card = document.createElement("article");
  card.className = "chart-card";

  // Header with title, optional outdoor legend, and live/hover readout
  const header = document.createElement("div");
  header.className = "chart-card__header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "chart-card__title-wrap";
  const titleEl = document.createElement("h3");
  titleEl.className = "chart-card__title";
  titleEl.textContent = spec.title;
  titleWrap.append(titleEl);

  if (overlayPoints.length > 0 && spec.overlay) {
    const legend = document.createElement("span");
    legend.className = "chart-legend";
    const indoorSwatch = document.createElement("span");
    indoorSwatch.className = "chart-legend__item";
    const indoorBar = document.createElement("span");
    indoorBar.className = "chart-legend__line";
    indoorBar.style.backgroundColor = `var(${spec.colorVar})`;
    indoorSwatch.append(indoorBar, document.createTextNode("Indoor"));

    const outdoorSwatch = document.createElement("span");
    outdoorSwatch.className = "chart-legend__item";
    const outdoorBar = document.createElement("span");
    outdoorBar.className = "chart-legend__line chart-legend__line--dashed";
    outdoorSwatch.append(outdoorBar, document.createTextNode(spec.overlay.label));

    legend.append(indoorSwatch, outdoorSwatch);
    titleWrap.append(legend);
  }

  const readoutEl = document.createElement("div");
  readoutEl.className = "chart-card__readout";
  const latestPoint = points[points.length - 1] ?? null;
  const latestOverlay = overlayPoints[overlayPoints.length - 1] ?? null;

  const readoutValSpan = document.createElement("strong");
  const readoutOutSpan = document.createElement("span");
  readoutOutSpan.className = "chart-card__outdoor-val";
  const readoutTimeSpan = document.createElement("span");
  readoutTimeSpan.className = "chart-card__time";
  let readoutShowingDefaultEmpty = false;

  const applyReadout = (valText, outText, timeText) => {
    if (readoutShowingDefaultEmpty || readoutEl.childElementCount === 0) {
      readoutEl.replaceChildren(readoutValSpan, readoutOutSpan, readoutTimeSpan);
      readoutShowingDefaultEmpty = false;
    }
    readoutValSpan.textContent = valText;
    if (outText) {
      readoutOutSpan.textContent = outText;
      readoutOutSpan.hidden = false;
    } else {
      readoutOutSpan.textContent = "";
      readoutOutSpan.hidden = true;
    }
    readoutTimeSpan.textContent = timeText;
  };

  const setDefaultReadout = () => {
    if (!latestPoint) {
      readoutEl.replaceChildren();
      readoutEl.textContent = "No samples";
      readoutShowingDefaultEmpty = true;
      return;
    }
    const outText =
      latestOverlay && spec.overlay
        ? `Out ${formatVal(latestOverlay.value)} ${spec.unit}`
        : "";
    applyReadout(
      `${formatVal(latestPoint.value)} ${spec.unit}`,
      outText,
      `Latest · ${formatHoverTime(latestPoint.timeMs, spec.hours)}`
    );
  };
  setDefaultReadout();

  header.append(titleWrap, readoutEl);
  card.append(header);

  if (points.length === 0) {
    const empty = document.createElement("div");
    empty.className = "chart-card__empty";
    empty.textContent = `No ${spec.title.toLowerCase()} readings in this window.`;
    card.append(empty);
    container.append(card);
    return;
  }

  const plotWidth = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

  const domain = computeNiceDomain(
    [...points.map((p) => p.value), ...overlayPoints.map((p) => p.value)],
    spec.domainOptions
  );

  const minTime = points[0].timeMs;
  const maxTime =
    points.length > 1 && points[points.length - 1].timeMs > minTime
      ? points[points.length - 1].timeMs
      : minTime + 60_000;

  const xScale = (timeMs) =>
    PAD_LEFT + ((timeMs - minTime) / (maxTime - minTime)) * plotWidth;
  const yScale = (val) =>
    PAD_TOP + (1 - (val - domain.min) / (domain.max - domain.min || 1)) * plotHeight;

  const svg = svgEl("svg", {
    class: "chart-svg",
    viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`,
    role: "img",
    "aria-label": `${spec.title} trend over the last ${spec.hours} hours. Latest value ${formatVal(latestPoint.value)} ${spec.unit}.`,
  });

  // Gradient definition for subtle area fill
  const defs = svgEl("defs");
  const gradId = `grad-${spec.id}`;
  const gradient = svgEl("linearGradient", {
    id: gradId,
    x1: "0",
    y1: "0",
    x2: "0",
    y2: "1",
  });
  gradient.append(
    svgEl("stop", { offset: "0%", "stop-color": `var(${spec.colorVar})`, "stop-opacity": "0.24" }),
    svgEl("stop", { offset: "100%", "stop-color": `var(${spec.colorVar})`, "stop-opacity": "0.01" })
  );
  defs.append(gradient);
  svg.append(defs);

  // Optional ideal comfort band (e.g. 30%-50% RH)
  if (spec.idealBand) {
    const bandTop = Math.max(PAD_TOP, yScale(spec.idealBand.max));
    const bandBottom = Math.min(PAD_TOP + plotHeight, yScale(spec.idealBand.min));
    if (bandBottom > bandTop) {
      svg.append(
        svgEl("rect", {
          class: "chart-ideal-band",
          x: PAD_LEFT,
          y: bandTop,
          width: plotWidth,
          height: bandBottom - bandTop,
          rx: 2,
        })
      );
      const bandLabel = svgEl("text", {
        class: "chart-threshold-label chart-threshold-label--ideal",
        x: PAD_LEFT + plotWidth - 4,
        y: bandTop + 12,
        "text-anchor": "end",
      });
      bandLabel.textContent = spec.idealBand.label;
      svg.append(bandLabel);
    }
  }

  // Horizontal gridlines + Y labels
  for (const tick of domain.ticks) {
    const y = yScale(tick);
    svg.append(
      svgEl("line", {
        class: "chart-gridline",
        x1: PAD_LEFT,
        y1: y,
        x2: PAD_LEFT + plotWidth,
        y2: y,
      })
    );
    const label = svgEl("text", {
      class: "chart-axis-label",
      x: PAD_LEFT - 8,
      y: y + 3.5,
      "text-anchor": "end",
    });
    label.textContent = decimals > 0 && tick % 1 !== 0 ? tick.toFixed(1) : String(Math.round(tick));
    svg.append(label);
  }

  // Threshold dashed reference lines
  if (Array.isArray(spec.thresholds)) {
    for (const threshold of spec.thresholds) {
      if (threshold.value >= domain.min && threshold.value <= domain.max) {
        const y = yScale(threshold.value);
        svg.append(
          svgEl("line", {
            class: `chart-threshold chart-threshold--${threshold.tone}`,
            x1: PAD_LEFT,
            y1: y,
            x2: PAD_LEFT + plotWidth,
            y2: y,
          })
        );
        const tLabel = svgEl("text", {
          class: `chart-threshold-label chart-threshold-label--${threshold.tone}`,
          x: PAD_LEFT + plotWidth - 4,
          y: Math.max(PAD_TOP + 10, y - 4),
          "text-anchor": "end",
        });
        tLabel.textContent = threshold.label;
        svg.append(tLabel);
      }
    }
  }

  // X-axis time ticks (4 evenly spaced timestamps)
  const xTickCount = 4;
  for (let i = 0; i < xTickCount; i += 1) {
    const ratio = i / (xTickCount - 1);
    const timeMs = minTime + ratio * (maxTime - minTime);
    const x = PAD_LEFT + ratio * plotWidth;
    const anchor = i === 0 ? "start" : i === xTickCount - 1 ? "end" : "middle";
    const xLabel = svgEl("text", {
      class: "chart-axis-label",
      x,
      y: CHART_HEIGHT - 8,
      "text-anchor": anchor,
    });
    xLabel.textContent = formatAxisTime(timeMs, spec.hours);
    svg.append(xLabel);
  }

  // Data segments (split across large offline gaps)
  const maxGapMs = spec.hours <= 24 ? 45 * 60 * 1000 : 4 * 60 * 60 * 1000;
  const segments = buildSeriesSegments(points, maxGapMs);
  const baseY = PAD_TOP + plotHeight;

  for (const segment of segments) {
    if (segment.length === 1) {
      svg.append(
        svgEl("circle", {
          cx: xScale(segment[0].timeMs),
          cy: yScale(segment[0].value),
          r: 3.5,
          fill: `var(${spec.colorVar})`,
        })
      );
      continue;
    }

    const coords = segment.map((p) => `${xScale(p.timeMs).toFixed(2)},${yScale(p.value).toFixed(2)}`);
    const areaPath = [
      `M ${xScale(segment[0].timeMs).toFixed(2)},${baseY.toFixed(2)}`,
      ...segment.map((p) => `L ${xScale(p.timeMs).toFixed(2)},${yScale(p.value).toFixed(2)}`),
      `L ${xScale(segment[segment.length - 1].timeMs).toFixed(2)},${baseY.toFixed(2)}`,
      "Z",
    ].join(" ");

    svg.append(
      svgEl("path", {
        d: areaPath,
        fill: `url(#${gradId})`,
      })
    );

    svg.append(
      svgEl("polyline", {
        class: "chart-line",
        points: coords.join(" "),
        stroke: `var(${spec.colorVar})`,
      })
    );
  }

  // Optional dashed outdoor comparison overlay
  if (overlayPoints.length > 0) {
    const inWindowOverlay = overlayPoints.filter(
      (p) => p.timeMs >= minTime - 30 * 60_000 && p.timeMs <= maxTime + 30 * 60_000
    );
    const outdoorGapMs = spec.hours <= 24 ? 90 * 60 * 1000 : 6 * 60 * 60 * 1000;
    const outdoorSegments = buildSeriesSegments(inWindowOverlay, outdoorGapMs);
    for (const seg of outdoorSegments) {
      if (seg.length === 1) {
        const clampedTime = Math.min(maxTime, Math.max(minTime, seg[0].timeMs));
        svg.append(
          svgEl("circle", {
            class: "chart-outdoor-dot",
            cx: xScale(clampedTime),
            cy: yScale(seg[0].value),
            r: 3,
          })
        );
        continue;
      }
      const oCoords = seg.map((p) => {
        const clampedTime = Math.min(maxTime, Math.max(minTime, p.timeMs));
        return `${xScale(clampedTime).toFixed(2)},${yScale(p.value).toFixed(2)}`;
      });
      svg.append(
        svgEl("polyline", {
          class: "chart-line chart-line--outdoor",
          points: oCoords.join(" "),
        })
      );
    }
  }

  // Interactive hover crosshair & active point marker
  const crosshair = svgEl("line", {
    class: "chart-crosshair",
    x1: 0,
    y1: PAD_TOP,
    x2: 0,
    y2: baseY,
    visibility: "hidden",
  });
  const activeDot = svgEl("circle", {
    class: "chart-active-dot",
    cx: 0,
    cy: 0,
    r: 4.5,
    fill: `var(${spec.colorVar})`,
    visibility: "hidden",
  });
  svg.append(crosshair, activeDot);

  // Invisible hit area covering the plot for smooth pointer scrubbing
  const hitRect = svgEl("rect", {
    x: PAD_LEFT,
    y: PAD_TOP,
    width: plotWidth,
    height: plotHeight,
    fill: "transparent",
    class: "chart-hit-area",
  });

  const highlightPoint = (point) => {
    const cx = xScale(point.timeMs);
    const cy = yScale(point.value);
    crosshair.setAttribute("x1", cx.toFixed(2));
    crosshair.setAttribute("x2", cx.toFixed(2));
    crosshair.setAttribute("visibility", "visible");
    activeDot.setAttribute("cx", cx.toFixed(2));
    activeDot.setAttribute("cy", cy.toFixed(2));
    activeDot.setAttribute("visibility", "visible");

    let outText = "";
    if (overlayPoints.length > 0) {
      const oIdx = findNearestPointIndex(overlayPoints, point.timeMs);
      if (oIdx >= 0 && Math.abs(overlayPoints[oIdx].timeMs - point.timeMs) <= 2 * 60 * 60_000) {
        outText = `Out ${formatVal(overlayPoints[oIdx].value)} ${spec.unit}`;
      }
    }
    applyReadout(
      `${formatVal(point.value)} ${spec.unit}`,
      outText,
      formatHoverTime(point.timeMs, spec.hours)
    );
  };

  let cachedRect = null;
  let lastHighlightedIdx = -1;

  const clearHighlight = () => {
    cachedRect = null;
    lastHighlightedIdx = -1;
    crosshair.setAttribute("visibility", "hidden");
    activeDot.setAttribute("visibility", "hidden");
    setDefaultReadout();
  };

  hitRect.addEventListener("pointerenter", () => {
    cachedRect = svg.getBoundingClientRect();
  });

  hitRect.addEventListener("pointermove", (event) => {
    const rect = cachedRect && cachedRect.width ? cachedRect : svg.getBoundingClientRect();
    if (!rect.width) return;
    cachedRect = rect;
    const svgX = ((event.clientX - rect.left) / rect.width) * CHART_WIDTH;
    const clampedRatio = Math.min(1, Math.max(0, (svgX - PAD_LEFT) / plotWidth));
    const targetTimeMs = minTime + clampedRatio * (maxTime - minTime);
    const idx = findNearestPointIndex(points, targetTimeMs);
    if (idx >= 0 && idx !== lastHighlightedIdx) {
      lastHighlightedIdx = idx;
      highlightPoint(points[idx]);
    }
  });

  hitRect.addEventListener("pointerleave", clearHighlight);
  svg.append(hitRect);
  card.append(svg);

  // Footer summary stats bar (Min / Avg / P95 / Max)
  if (spec.stats) {
    const formatStat = (raw) =>
      typeof raw === "number" && Number.isFinite(raw) ? `${formatVal(raw)} ${spec.unit}` : "—";
    const footer = document.createElement("dl");
    footer.className = "chart-stats";
    const items = [
      ["Min", formatStat(spec.stats.min)],
      ["Avg", formatStat(spec.stats.avg)],
      ["P95", formatStat(spec.stats.p95)],
      ["Max", formatStat(spec.stats.max)],
    ];
    for (const [label, value] of items) {
      const wrap = document.createElement("div");
      wrap.className = "chart-stats__item";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      wrap.append(dt, dd);
      footer.append(wrap);
    }
    card.append(footer);
  }

  container.append(card);
}
