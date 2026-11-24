/**
 * Custom Air Quality Sensor Dashboard — Main Application Controller
 *
 * Features:
 * - WorkOS AuthKit PKCE browser sign-in (+ optional Bearer fallback)
 * - Live sensor room cards (°F only, manual refresh only)
 * - Interactive 6h / 24h / 7d SVG trend charts (CO2, PM2.5, Temp °F, Humidity)
 * - Slide-over Device Settings <dialog> drawer with Layer 1 remote config
 *   editing, post-interaction validation, and one-shot remote reboot confirmation
 */

import {
  ApiError,
  fetchAuthConfig,
  fetchDashboardOverview,
  fetchFirmwareReleases,
  fetchReadingsHistory,
  saveDeviceConfig,
  saveSiteLocationConfig,
  setDeviceTargetFirmware,
  triggerDeviceReboot,
  triggerFleetRollout,
  triggerOutdoorRefresh,
} from "./api.js";
import {
  clearSession,
  getRedirectUri,
  handleAuthCallbackIfPresent,
  loadSession,
  signInWithBearerToken,
  startWorkosLogin,
} from "./auth.js";
import { renderTrendChartCard } from "./charts.js";

// ============================================================================
// Application State
// ============================================================================

const state = {
  authConfig: null,
  session: null,
  overview: null,
  releases: [],
  activeTab: "overview",
  selectedDeviceId: null,
  hours: 24,
  period: "24h",
  historyPayload: null,
  editingDeviceId: null,
  pendingRollout: null,
  isRefreshing: false,
};

// ============================================================================
// DOM References
// ============================================================================

const els = {
  topbarActions: document.getElementById("topbar-actions"),
  userEmailBadge: document.getElementById("user-email-badge"),
  refreshBtn: document.getElementById("refresh-btn"),
  signoutBtn: document.getElementById("signout-btn"),
  banner: document.getElementById("banner"),

  loadingView: document.getElementById("loading-view"),
  loadingLabel: document.getElementById("loading-label"),

  authView: document.getElementById("auth-view"),
  authError: document.getElementById("auth-error"),
  workosLoginBtn: document.getElementById("workos-login-btn"),
  authStatusNote: document.getElementById("auth-status-note"),
  bearerLoginForm: document.getElementById("bearer-login-form"),
  bearerTokenInput: document.getElementById("bearer-token-input"),
  bearerLoginBtn: document.getElementById("bearer-login-btn"),

  dashboardView: document.getElementById("dashboard-view"),
  dashboardTablist: document.getElementById("dashboard-tablist"),
  tabOverview: document.getElementById("tab-overview"),
  tabFleet: document.getElementById("tab-fleet"),
  tabFleetBadge: document.getElementById("tab-fleet-badge"),
  panelOverview: document.getElementById("panel-overview"),
  panelFleet: document.getElementById("panel-fleet"),
  lastRefreshed: document.getElementById("last-refreshed"),
  fleetSummaryPills: document.getElementById("fleet-summary-pills"),
  outdoorCardSlot: document.getElementById("outdoor-card-slot"),
  deviceCards: document.getElementById("device-cards"),

  fleetMeta: document.getElementById("fleet-meta"),
  fleetOtaSummaryPills: document.getElementById("fleet-ota-summary-pills"),
  fleetReleaseSelect: document.getElementById("fleet-release-select"),
  fleetReleaseMeta: document.getElementById("fleet-release-meta"),
  fleetPromoteBtn: document.getElementById("fleet-promote-btn"),
  fleetClearBtn: document.getElementById("fleet-clear-btn"),
  fleetTableBody: document.getElementById("fleet-table-body"),
  releasesMeta: document.getElementById("releases-meta"),
  releasesList: document.getElementById("releases-list"),

  trendsMeta: document.getElementById("trends-meta"),
  deviceFilterWrap: document.getElementById("device-filter-wrap"),
  deviceFilterSelect: document.getElementById("device-filter-select"),
  timeButtons: Array.from(document.querySelectorAll(".segmented__btn")),
  chartsGrid: document.getElementById("charts-grid"),
  spikesPanel: document.getElementById("spikes-panel"),

  settingsDialog: document.getElementById("settings-dialog"),
  settingsDeviceSubtitle: document.getElementById("settings-device-subtitle"),
  settingsCloseBtn: document.getElementById("settings-close-btn"),
  settingsCancelBtn: document.getElementById("settings-cancel-btn"),
  settingsSyncBox: document.getElementById("settings-sync-box"),
  settingsError: document.getElementById("settings-error"),
  settingsSuccess: document.getElementById("settings-success"),
  settingsForm: document.getElementById("settings-form"),
  settingsSaveBtn: document.getElementById("settings-save-btn"),
  cfgLocation: document.getElementById("cfg-location"),
  cfgInterval: document.getElementById("cfg-interval"),
  cfgTempOffset: document.getElementById("cfg-temp-offset"),
  cfgTempOffsetF: document.getElementById("cfg-temp-offset-f"),
  cfgAltitude: document.getElementById("cfg-altitude"),
  cfgAltitudeFt: document.getElementById("cfg-altitude-ft"),
  cfgLedEnabled: document.getElementById("cfg-led-enabled"),
  settingsLastReboot: document.getElementById("settings-last-reboot"),
  openRebootConfirmBtn: document.getElementById("open-reboot-confirm-btn"),
  intervalPresets: Array.from(document.querySelectorAll("[data-interval]")),

  rebootDialog: document.getElementById("reboot-dialog"),
  rebootDialogBody: document.getElementById("reboot-dialog-body"),

  rolloutDialog: document.getElementById("rollout-dialog"),
  rolloutDialogTitle: document.getElementById("rollout-dialog-title"),
  rolloutDialogBody: document.getElementById("rollout-dialog-body"),
  rolloutDialogNotes: document.getElementById("rollout-dialog-notes"),
  rolloutConfirmBtn: document.getElementById("rollout-confirm-btn"),

  siteDialog: document.getElementById("site-dialog"),
  siteCloseBtn: document.getElementById("site-close-btn"),
  siteCancelBtn: document.getElementById("site-cancel-btn"),
  siteError: document.getElementById("site-error"),
  siteSuccess: document.getElementById("site-success"),
  siteForm: document.getElementById("site-form"),
  siteSaveBtn: document.getElementById("site-save-btn"),
  siteLabel: document.getElementById("site-label"),
  siteLatitude: document.getElementById("site-latitude"),
  siteLongitude: document.getElementById("site-longitude"),
  sitePollInterval: document.getElementById("site-poll-interval"),
  siteGeolocateBtn: document.getElementById("site-geolocate-btn"),
  outdoorIntervalPresets: Array.from(document.querySelectorAll("[data-outdoor-interval]")),
};

// ============================================================================
// Modern Web Guidance Platform Helpers
// 1. Native switch progressive fallback (for browsers without <input switch>)
// 2. Top-layer exit animation fallback (for browsers without overlay/discrete display)
// 3. Light-dismiss fallback (for Safari without <dialog closedby="any">)
// 4. Accessible :user-invalid + aria-invalid + aria-describedby + live announcer
// ============================================================================

function enhanceNativeSwitches() {
  if ("switch" in HTMLInputElement.prototype) {
    return;
  }
  for (const input of document.querySelectorAll('input[type="checkbox"][switch]')) {
    input.setAttribute("role", "switch");
    input.classList.add("switch-fallback");
  }
}

let supportsDisplayTransition;
function canTransitionDisplay() {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (!window.CSS?.supports?.("transition-behavior", "allow-discrete") || !document.body) {
    return false;
  }
  const probe = document.createElement("div");
  probe.style.cssText = "transition: display 1s allow-discrete !important; display: block;";
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = "none";
  supportsDisplayTransition = getComputedStyle(probe).display === "block";
  probe.remove();
  return supportsDisplayTransition;
}

function supportsTopLayerExit() {
  return Boolean(window.CSS?.supports?.("overlay", "auto") && canTransitionDisplay());
}

async function closeModalDialog(dialog, returnValue) {
  if (!dialog.open) return;
  if (!supportsTopLayerExit()) {
    dialog.setAttribute("data-closing", "");
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((resolve) => setTimeout(resolve, 600)),
      ]);
    }
    if (!dialog.hasAttribute("data-closing")) return;
    dialog.removeAttribute("data-closing");
  }
  if (returnValue !== undefined) {
    dialog.close(returnValue);
  } else {
    dialog.close();
  }
}

function installDialogEnhancements() {
  // Route native cancel (Esc / closedby light-dismiss) through exit animation fallback
  for (const dialog of [els.settingsDialog, els.rebootDialog, els.rolloutDialog, els.siteDialog]) {
    dialog.addEventListener("cancel", (event) => {
      if (!supportsTopLayerExit()) {
        event.preventDefault();
        closeModalDialog(dialog, "");
      }
    });
  }

  // Fallback light-dismiss for Safari (browsers without HTMLDialogElement.prototype.closedBy)
  if (!("closedBy" in HTMLDialogElement.prototype)) {
    const isOutside = (event, dialog) => {
      const r = dialog.getBoundingClientRect();
      return (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      );
    };

    for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
      let pressedOutside = false;
      dialog.addEventListener("pointerdown", (event) => {
        pressedOutside = isOutside(event, dialog);
      });
      dialog.addEventListener("pointerup", (event) => {
        if (pressedOutside && isOutside(event, dialog)) {
          closeModalDialog(dialog, "");
        }
        pressedOutside = false;
      });
    }
  }
}

function installAccessibleFormValidation() {
  const supportsUserInvalid = window.CSS?.supports?.("selector(:user-invalid)") ?? false;
  const dirtyState = new WeakMap();
  const flagged = new WeakSet();
  const announced = new WeakSet();

  const announcer = document.createElement("div");
  announcer.setAttribute("aria-live", "polite");
  announcer.classList.add("visually-hidden");
  document.body.append(announcer);
  let announceTimer;
  let announcedField = null;

  const linkError = (el, shown) => {
    const errorId = el.dataset?.error;
    if (!errorId) return;
    const ids = (el.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter((id) => id && id !== errorId);
    if (shown) ids.push(errorId);
    if (ids.length) {
      el.setAttribute("aria-describedby", ids.join(" "));
    } else {
      el.removeAttribute("aria-describedby");
    }
  };

  const spokenText = (node) => {
    const copy = node.cloneNode(true);
    copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
    copy
      .querySelectorAll('[role="img"][aria-label]')
      .forEach((n) => n.replaceWith(`${n.getAttribute("aria-label")}: `));
    return copy.textContent.replace(/\s+/g, " ").trim();
  };

  const announceError = (el) => {
    const errorEl = el.dataset?.error ? document.getElementById(el.dataset.error) : null;
    if (!errorEl) return;
    const label = el.labels?.[0] ? `${spokenText(el.labels[0])}: ` : "";
    clearTimeout(announceTimer);
    announcer.textContent = "";
    announcedField = el;
    announceTimer = setTimeout(() => {
      announcer.textContent = label + spokenText(errorEl);
    }, 500);
  };

  const syncAria = (el, announce = false) => {
    if (!el?.matches?.("input, select, textarea")) return;
    let invalid = false;
    if (supportsUserInvalid) {
      invalid = el.matches(":user-invalid");
    } else {
      const st = dirtyState.get(el);
      invalid = Boolean(st?.hasInteracted && st?.hasBlurred && !el.validity.valid);
      el.classList.toggle("user-invalid-fallback", invalid);
    }

    if (invalid) {
      if (announce && !announced.has(el)) {
        announceError(el);
        announced.add(el);
      }
      el.setAttribute("aria-invalid", "true");
      linkError(el, true);
      flagged.add(el);
    } else if (flagged.has(el) || el.getAttribute("aria-invalid") !== "true") {
      el.setAttribute("aria-invalid", "false");
      linkError(el, false);
      flagged.delete(el);
      announced.delete(el);
      if (announcedField === el) {
        clearTimeout(announceTimer);
        announcer.textContent = "";
      }
    }
  };

  document.querySelectorAll("input, select, textarea").forEach((el) => syncAria(el));

  document.addEventListener(
    "blur",
    (e) => {
      const el = e.target;
      if (!supportsUserInvalid && el?.matches?.("input, select, textarea")) {
        const st = dirtyState.get(el) || { hasInteracted: false, hasBlurred: false };
        st.hasBlurred = true;
        dirtyState.set(el, st);
      }
      syncAria(el, true);
    },
    true
  );

  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!supportsUserInvalid && el?.matches?.("input, select, textarea")) {
      const st = dirtyState.get(el) || { hasInteracted: false, hasBlurred: false };
      st.hasInteracted = true;
      dirtyState.set(el, st);
    }
    if (el?.hasAttribute?.("aria-invalid")) {
      syncAria(el);
    }
  });

  document.addEventListener(
    "change",
    (e) => {
      const el = e.target;
      if (!supportsUserInvalid && el?.matches?.("input, select, textarea")) {
        const st = dirtyState.get(el) || { hasInteracted: false, hasBlurred: false };
        st.hasInteracted = true;
        dirtyState.set(el, st);
      }
      syncAria(el, true);
    },
    true
  );

  document.addEventListener(
    "invalid",
    (e) => {
      const el = e.target;
      if (!supportsUserInvalid) {
        dirtyState.set(el, { hasInteracted: true, hasBlurred: true });
      }
      announced.add(el);
      syncAria(el);
    },
    true
  );

  document.addEventListener(
    "reset",
    (e) => {
      setTimeout(() => {
        for (const el of e.target.elements || []) {
          dirtyState.delete(el);
          el.classList?.remove("user-invalid-fallback");
          syncAria(el);
        }
      });
    },
    true
  );
}

function installTabsController() {
  const tablist = els.dashboardTablist;
  const tabs = [els.tabOverview, els.tabFleet];
  const panels = [els.panelOverview, els.panelFleet];
  const tabKeys = ["overview", "fleet"];
  const supportsFocusGroup = "focusGroup" in HTMLElement.prototype;

  if (!supportsFocusGroup) {
    tablist.setAttribute("role", "tablist");
    for (const tab of tabs) {
      tab.setAttribute("role", "tab");
    }
  }

  const selectTab = (index, { moveFocus = false } = {}) => {
    const safeIndex = ((index % tabs.length) + tabs.length) % tabs.length;
    state.activeTab = tabKeys[safeIndex];

    tabs.forEach((tab, i) => {
      const selected = i === safeIndex;
      tab.setAttribute("aria-selected", String(selected));
      tab.toggleAttribute("focusgroupstart", selected);
      if (!supportsFocusGroup) {
        tab.tabIndex = selected ? 0 : -1;
      }
      if (selected) {
        tab.scrollIntoView({ block: "nearest", inline: "nearest" });
        if (moveFocus) {
          tab.focus();
        }
      }
    });

    panels.forEach((panel, i) => {
      const selected = i === safeIndex;
      if (selected) {
        panel.hidden = false;
      } else {
        panel.hidden = "until-found";
      }
    });
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => selectTab(i));
    // Selection follows focus when arrowing through tabs
    tab.addEventListener("focus", () => {
      if (tab.getAttribute("aria-selected") !== "true") {
        selectTab(i);
      }
    });
  });

  if (!supportsFocusGroup) {
    tablist.addEventListener("keydown", (event) => {
      const currentIdx = tabs.indexOf(document.activeElement);
      if (currentIdx === -1) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        selectTab(currentIdx + 1, { moveFocus: true });
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        selectTab(currentIdx - 1, { moveFocus: true });
      } else if (event.key === "Home") {
        event.preventDefault();
        selectTab(0, { moveFocus: true });
      } else if (event.key === "End") {
        event.preventDefault();
        selectTab(tabs.length - 1, { moveFocus: true });
      }
    });
  }

  // Sync tab selection when browser find-in-page matches text in a hidden="until-found" panel
  panels.forEach((panel, i) => {
    panel.addEventListener("beforematch", () => {
      selectTab(i);
    });
  });

  selectTab(0);
}

// ============================================================================
// Formatting & Presentation Helpers
// ============================================================================

function formatRoomName(slug) {
  if (!slug) return "Unnamed Room";
  return slug.replace(/[-_]+/g, " ");
}

function formatMinutesAgo(minutes) {
  if (!Number.isFinite(minutes)) return "unknown";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function formatLocalTimestamp(isoString) {
  if (!isoString) return "—";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function describeOtaStatus(status) {
  switch (status) {
    case "updating":
      return { label: "Updating…", tone: "info", withDot: true };
    case "pending":
      return { label: "Update pending", tone: "warn", withDot: true };
    case "rolled_back":
      return { label: "Rolled back", tone: "danger", withDot: true };
    case "error":
      return { label: "OTA error", tone: "danger", withDot: true };
    default:
      return { label: "Up to date", tone: "good", withDot: false };
  }
}

function getActiveReleases() {
  return (state.releases || []).filter((r) => r.status !== "yanked");
}

function findReleaseByVersion(version) {
  return (state.releases || []).find((r) => r.version === version) || null;
}

function toneForAqi(aqi) {
  if (aqi <= 50) return "good";
  if (aqi <= 100) return "warn";
  return "danger";
}

function toneForCo2Level(level) {
  if (level === "optimal" || level === "acceptable") return "good";
  if (level === "elevated") return "warn";
  return "danger";
}

function toneForPm25Level(level) {
  if (level === "good") return "good";
  if (level === "moderate") return "warn";
  return "danger";
}

function toneForHumidityLevel(level) {
  return level === "ideal" ? "good" : "warn";
}

function createPill(text, tone = "neutral", withDot = false) {
  const span = document.createElement("span");
  span.className = tone === "neutral" ? "pill" : `pill pill--${tone}`;
  if (withDot) {
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("aria-hidden", "true");
    span.append(dot);
  }
  span.append(document.createTextNode(text));
  return span;
}

function showBanner(message, tone = "info") {
  els.banner.textContent = message;
  els.banner.className = `banner${tone !== "info" ? ` banner--${tone}` : ""}`;
  els.banner.hidden = false;
}

function hideBanner() {
  els.banner.hidden = true;
  els.banner.textContent = "";
}

function showAuthError(message) {
  els.authError.textContent = message;
  els.authError.hidden = false;
}

function clearAuthError() {
  els.authError.textContent = "";
  els.authError.hidden = true;
}

function setView(mode) {
  els.loadingView.hidden = mode !== "loading";
  els.authView.hidden = mode !== "auth";
  els.dashboardView.hidden = mode !== "dashboard";
  els.topbarActions.hidden = mode !== "dashboard";
}

// ============================================================================
// Rendering: Outdoor Weather & AQI, Live Device Cards, Charts & Spikes
// ============================================================================

function formatSignedDelta(value, unit, decimals = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const num = Number(value);
  const sign = num > 0 ? "+" : "";
  const formatted = decimals > 0 ? num.toFixed(decimals) : String(Math.round(num));
  return `${sign}${formatted}${unit}`;
}

function describeWindowRecommendation(rec) {
  if (rec === "open_recommended") {
    return { label: "Open window recommended", tone: "good" };
  }
  if (rec === "keep_closed") {
    return { label: "Keep windows closed", tone: "warn" };
  }
  return { label: "Ventilation neutral", tone: "neutral" };
}

function renderOutdoorCard() {
  els.outdoorCardSlot.replaceChildren();
  const overview = state.overview;
  if (!overview) return;

  const siteConfig = overview.site_config ?? null;
  const outdoorLatest = overview.outdoor_latest ?? null;

  if (!siteConfig) {
    const card = document.createElement("article");
    card.className = "outdoor-card outdoor-card--setup";

    const copy = document.createElement("div");
    const title = document.createElement("h2");
    title.className = "outdoor-card__title";
    title.textContent = "Outdoor Weather & AQI Context";
    const meta = document.createElement("p");
    meta.className = "outdoor-card__meta";
    meta.textContent =
      "Set your home coordinates privately in Firestore to capture Open-Meteo outdoor weather + US EPA AQI alongside sensor readings and see indoor-vs-outdoor deltas.";
    copy.append(title, meta);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn--primary";
    btn.textContent = "Configure Home Location";
    btn.addEventListener("click", () => openSiteLocationDrawer());

    card.append(copy, btn);
    els.outdoorCardSlot.append(card);
    return;
  }

  const card = document.createElement("article");
  card.className = "outdoor-card";

  const top = document.createElement("div");
  top.className = "outdoor-card__top";

  const idWrap = document.createElement("div");
  const title = document.createElement("h2");
  title.className = "outdoor-card__title";
  title.textContent = siteConfig.label || "Home Outdoor";

  const meta = document.createElement("p");
  meta.className = "outdoor-card__meta";
  if (outdoorLatest?.reading) {
    const r = outdoorLatest.reading;
    meta.textContent = `Open-Meteo · ${r.weather_description} · updated ${formatMinutesAgo(outdoorLatest.minutes_ago)} (every ${siteConfig.outdoor_poll_interval_minutes}m)`;
  } else {
    meta.textContent = `Open-Meteo · waiting for first outdoor snapshot (every ${siteConfig.outdoor_poll_interval_minutes}m)`;
  }
  idWrap.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "outdoor-card__actions";
  if (outdoorLatest?.reading) {
    actions.append(
      createPill(
        outdoorLatest.is_stale ? "STALE" : "OUTDOOR LIVE",
        outdoorLatest.is_stale ? "warn" : "info",
        true
      )
    );
  }

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "btn btn--ghost btn--sm";
  refreshBtn.textContent = "Refresh Outdoor";
  refreshBtn.addEventListener("click", () => handleOutdoorRefresh(refreshBtn));

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "btn btn--secondary btn--sm";
  editBtn.textContent = "Location";
  editBtn.addEventListener("click", () => openSiteLocationDrawer());

  actions.append(refreshBtn, editBtn);
  top.append(idWrap, actions);
  card.append(top);

  if (outdoorLatest?.reading) {
    const r = outdoorLatest.reading;
    const grid = document.createElement("div");
    grid.className = "metrics-grid";

    const buildOutdoorTile = (label, valueText, unitText, subText, pillTone) => {
      const tile = document.createElement("div");
      tile.className = "metric-tile";

      const lbl = document.createElement("span");
      lbl.className = "metric-tile__label";
      lbl.textContent = label;

      const val = document.createElement("div");
      val.className = "metric-tile__value";
      val.append(document.createTextNode(valueText));
      if (unitText) {
        const unit = document.createElement("span");
        unit.className = "metric-tile__unit";
        unit.textContent = ` ${unitText}`;
        val.append(unit);
      }

      const sub = document.createElement("div");
      sub.className = "metric-tile__sub";
      if (pillTone) {
        sub.append(createPill(subText, pillTone));
      } else {
        sub.textContent = subText;
      }

      tile.append(lbl, val, sub);
      return tile;
    };

    grid.append(
      buildOutdoorTile(
        "Outdoor US AQI",
        r.us_aqi !== null ? String(Math.round(r.us_aqi)) : "—",
        "",
        r.us_aqi_category || "Unavailable",
        r.us_aqi !== null ? toneForAqi(r.us_aqi) : "neutral"
      ),
      buildOutdoorTile(
        "Outdoor PM2.5",
        r.pm2_5_ug_m3 !== null ? Number(r.pm2_5_ug_m3).toFixed(1) : "—",
        r.pm2_5_ug_m3 !== null ? "µg/m³" : "",
        r.pm10_0_ug_m3 !== null ? `PM10 ${Number(r.pm10_0_ug_m3).toFixed(1)} µg/m³` : "Open-Meteo AQ"
      ),
      buildOutdoorTile(
        "Outdoor Temp",
        `${Number(r.temperature_f).toFixed(1)}°F`,
        "",
        r.apparent_temperature_f !== null
          ? `Feels like ${Number(r.apparent_temperature_f).toFixed(1)}°F`
          : r.weather_description
      ),
      buildOutdoorTile(
        "Outdoor RH",
        `${Math.round(r.humidity_percent)}%`,
        "RH",
        r.wind_speed_mph !== null ? `Wind ${Number(r.wind_speed_mph).toFixed(1)} mph` : r.weather_description
      )
    );
    card.append(grid);
  }

  els.outdoorCardSlot.append(card);
}

function renderDeviceCards() {
  renderOutdoorCard();
  const overview = state.overview;
  els.deviceCards.replaceChildren();
  els.fleetSummaryPills.replaceChildren();

  if (!overview) return;

  els.lastRefreshed.textContent = `Last refreshed ${formatLocalTimestamp(overview.checked_at)} · °F · Manual refresh`;

  els.fleetSummaryPills.append(
    createPill(
      `${overview.online_count} / ${overview.device_count} online`,
      overview.online_count === overview.device_count && overview.device_count > 0 ? "good" : "warn",
      true
    )
  );

  if (!overview.devices.length) {
    const empty = document.createElement("p");
    empty.className = "section__meta";
    empty.textContent = "No sensors have reported to Firestore yet.";
    els.deviceCards.append(empty);
    return;
  }

  // Update multi-device selector for charts
  els.deviceFilterSelect.replaceChildren();
  for (const item of overview.devices) {
    const opt = document.createElement("option");
    opt.value = item.device.device_id;
    opt.textContent = `${formatRoomName(item.device.location)} (${item.device.device_id})`;
    els.deviceFilterSelect.append(opt);
  }
  if (state.selectedDeviceId) {
    els.deviceFilterSelect.value = state.selectedDeviceId;
  }
  els.deviceFilterWrap.hidden = overview.devices.length <= 1;

  for (const item of overview.devices) {
    const { device, desired_config: desired, config_sync_status: syncStatus, health_context: health } = item;
    const latest = device.latest_reading;

    const card = document.createElement("article");
    card.className =
      device.device_id === state.selectedDeviceId && overview.devices.length > 1
        ? "device-card device-card--selected"
        : "device-card";

    // Header: Room name + device ID + online & config sync badges
    const top = document.createElement("div");
    top.className = "device-card__top";

    const idWrap = document.createElement("div");
    const roomEl = document.createElement("h2");
    roomEl.className = "device-card__room";
    roomEl.textContent = formatRoomName(device.location);
    const subEl = document.createElement("p");
    subEl.className = "device-card__id";
    subEl.textContent = `${device.device_id} · seen ${formatMinutesAgo(device.minutes_since_last_seen)}`;
    idWrap.append(roomEl, subEl);

    const badges = document.createElement("div");
    badges.className = "device-card__badges";

    const statusTone = device.status === "online" ? "good" : device.status === "stale" ? "warn" : "danger";
    badges.append(createPill(device.status.toUpperCase(), statusTone, true));

    if (syncStatus === "synced" && desired) {
      badges.append(createPill(`Config v${desired.config_version} synced`, "good"));
    } else if (syncStatus === "pending" && desired) {
      const reportedVer = device.config_version ?? 0;
      badges.append(
        createPill(`Pending sync (v${reportedVer} → v${desired.config_version})`, "warn")
      );
    } else {
      badges.append(createPill("Local defaults", "neutral"));
    }

    if (item.ota_rollout_status && item.ota_rollout_status !== "up_to_date") {
      const otaMeta = describeOtaStatus(item.ota_rollout_status);
      badges.append(createPill(otaMeta.label, otaMeta.tone, otaMeta.withDot));
    }

    top.append(idWrap, badges);
    card.append(top);

    // 4 Hero Metrics
    const grid = document.createElement("div");
    grid.className = "metrics-grid";

    const buildTile = (label, valueText, unitText, subText, pillTone) => {
      const tile = document.createElement("div");
      tile.className = "metric-tile";

      const lbl = document.createElement("span");
      lbl.className = "metric-tile__label";
      lbl.textContent = label;

      const val = document.createElement("div");
      val.className = "metric-tile__value";
      val.append(document.createTextNode(valueText));
      if (unitText) {
        const unit = document.createElement("span");
        unit.className = "metric-tile__unit";
        unit.textContent = ` ${unitText}`;
        val.append(unit);
      }

      const sub = document.createElement("div");
      sub.className = "metric-tile__sub";
      if (pillTone) {
        sub.append(createPill(subText, pillTone));
      } else {
        sub.textContent = subText;
      }

      tile.append(lbl, val, sub);
      return tile;
    };

    if (latest) {
      grid.append(
        buildTile("US AQI", String(Math.round(latest.aqi_us)), "", latest.aqi_category, toneForAqi(latest.aqi_us)),
        buildTile(
          "CO2",
          String(Math.round(latest.co2_ppm)),
          "ppm",
          health ? health.co2_level.replace("_", " ") : "—",
          health ? toneForCo2Level(health.co2_level) : "neutral"
        ),
        buildTile(
          "PM2.5",
          Number(latest.pm2_5_ug_m3).toFixed(1),
          "µg/m³",
          health ? health.pm2_5_level.replace("_", " ") : "—",
          health ? toneForPm25Level(health.pm2_5_level) : "neutral"
        ),
        buildTile(
          "Temp / RH",
          `${Number(latest.temperature_f).toFixed(1)}°F`,
          `${Math.round(latest.humidity_percent)}%`,
          health ? health.humidity_level : "—",
          health ? toneForHumidityLevel(health.humidity_level) : "neutral"
        )
      );
    } else {
      grid.append(buildTile("Telemetry", "—", "", "Waiting for first reading", "neutral"));
    }
    card.append(grid);

    // Indoor vs. Outdoor Delta Strip
    if (item.outdoor_delta) {
      const d = item.outdoor_delta;
      const strip = document.createElement("div");
      strip.className = "delta-strip";

      const row = document.createElement("div");
      row.className = "delta-strip__row";

      const metricsWrap = document.createElement("div");
      metricsWrap.className = "delta-strip__metrics";
      const deltaParts = [
        formatSignedDelta(d.temperature_diff_f, "°F", 1)
          ? `Temp ${formatSignedDelta(d.temperature_diff_f, "°F", 1)}`
          : null,
        formatSignedDelta(d.humidity_diff_percent, "% RH", 0)
          ? `RH ${formatSignedDelta(d.humidity_diff_percent, "%", 0)}`
          : null,
        d.pm2_5_diff_ug_m3 !== null
          ? `PM2.5 ${formatSignedDelta(d.pm2_5_diff_ug_m3, " µg/m³", 1)}`
          : null,
        d.aqi_diff !== null ? `AQI ${formatSignedDelta(d.aqi_diff, "", 0)}` : null,
      ].filter(Boolean);

      const prefix = document.createElement("span");
      prefix.textContent = "vs Outdoor:";
      metricsWrap.append(prefix);
      for (const part of deltaParts) {
        const span = document.createElement("span");
        span.textContent = part;
        metricsWrap.append(span);
      }

      const recMeta = describeWindowRecommendation(d.window_recommendation);
      row.append(metricsWrap, createPill(recMeta.label, recMeta.tone));
      strip.append(row);

      if (d.window_reason) {
        const reasonEl = document.createElement("p");
        reasonEl.className = "delta-strip__reason";
        reasonEl.textContent = d.window_reason;
        strip.append(reasonEl);
      }
      card.append(strip);
    }

    // Health guidance notes
    if (health) {
      const notes = document.createElement("div");
      notes.className = "device-card__notes";
      const co2Note = document.createElement("div");
      co2Note.textContent = `CO2: ${health.co2_note}`;
      const pmNote = document.createElement("div");
      pmNote.textContent = `PM2.5: ${health.pm2_5_note}`;
      notes.append(co2Note, pmNote);
      card.append(notes);
    }

    // Footer: Hardware/config summary + Settings button
    const footer = document.createElement("div");
    footer.className = "device-card__footer";

    const specs = document.createElement("div");
    specs.className = "device-card__specs";

    const activeInterval = device.reporting_interval_seconds ?? desired?.reporting_interval_seconds ?? 300;
    const activeOffset = device.temperature_offset_c ?? desired?.temperature_offset_c;
    const activeAltitude = device.altitude_m ?? desired?.altitude_m;
    const activeLed = device.led_enabled ?? desired?.led_enabled;

    const specStrings = [
      `FW v${device.firmware_version}`,
      `Every ${activeInterval}s`,
      activeOffset !== null && activeOffset !== undefined ? `Offset ${Number(activeOffset).toFixed(1)}°C` : null,
      activeAltitude !== null && activeAltitude !== undefined ? `Alt ${activeAltitude}m` : null,
      activeLed !== null && activeLed !== undefined ? `LED ${activeLed ? "On" : "Muted"}` : null,
    ].filter(Boolean);

    for (const s of specStrings) {
      const span = document.createElement("span");
      span.textContent = s;
      specs.append(span);
    }

    const actions = document.createElement("div");
    actions.className = "pill-row";

    if (overview.devices.length > 1 && device.device_id !== state.selectedDeviceId) {
      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "btn btn--ghost";
      selectBtn.textContent = "Show Charts";
      selectBtn.addEventListener("click", () => {
        state.selectedDeviceId = device.device_id;
        renderDeviceCards();
        loadCharts();
      });
      actions.append(selectBtn);
    }

    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "btn btn--secondary";
    settingsBtn.textContent = "Device Settings";
    settingsBtn.addEventListener("click", () => openSettingsDrawer(item));
    actions.append(settingsBtn);

    footer.append(specs, actions);
    card.append(footer);
    els.deviceCards.append(card);
  }
}

function renderCharts() {
  els.chartsGrid.replaceChildren();
  els.spikesPanel.replaceChildren();
  els.spikesPanel.hidden = true;

  const payload = state.historyPayload;
  if (!payload) return;

  const { history, summary, outdoor_history: outdoorHistory = [] } = payload;
  const readings = history?.readings || [];
  const metrics = summary?.metrics || null;

  const deviceLabel = state.selectedDeviceId ? ` · ${state.selectedDeviceId}` : "";
  const sampleNote = history.downsampled
    ? `${history.returned_count} plotted (${history.total_matching} total samples)`
    : `${history.returned_count} samples`;
  const outdoorNote =
    Array.isArray(outdoorHistory) && outdoorHistory.length > 0
      ? ` · ${outdoorHistory.length} outdoor samples overlaid`
      : "";
  els.trendsMeta.textContent = `Last ${state.period}${deviceLabel} · ${sampleNote}${outdoorNote}`;

  renderTrendChartCard(els.chartsGrid, {
    id: "co2",
    title: "CO2 Concentration",
    unit: "ppm",
    colorVar: "--chart-co2",
    decimals: 0,
    hours: state.hours,
    readings,
    field: "co2_ppm",
    stats: metrics?.co2_ppm ?? null,
    domainOptions: { minFloor: 350, suggestedMin: 400, suggestedMax: 1100 },
    thresholds: [
      { value: 1000, label: "1000 ppm elevated", tone: "warn" },
      { value: 1400, label: "1400 ppm poor", tone: "danger" },
    ],
  });

  renderTrendChartCard(els.chartsGrid, {
    id: "pm25",
    title: "Fine Particles (PM2.5)",
    unit: "µg/m³",
    colorVar: "--chart-pm25",
    decimals: 1,
    hours: state.hours,
    readings,
    field: "pm2_5_ug_m3",
    stats: metrics?.pm2_5_ug_m3 ?? null,
    domainOptions: { minFloor: 0, suggestedMin: 0, suggestedMax: 12 },
    thresholds: [
      { value: 9.0, label: "9.0 EPA Good", tone: "warn" },
      { value: 35.4, label: "35.4 USG", tone: "danger" },
    ],
    overlay:
      outdoorHistory.length > 0
        ? { label: "Outdoor", readings: outdoorHistory, field: "pm2_5_ug_m3" }
        : null,
  });

  renderTrendChartCard(els.chartsGrid, {
    id: "temp",
    title: "Temperature",
    unit: "°F",
    colorVar: "--chart-temp",
    decimals: 1,
    hours: state.hours,
    readings,
    field: "temperature_f",
    stats: metrics?.temperature_f ?? null,
    domainOptions: { suggestedMin: 64, suggestedMax: 76 },
    overlay:
      outdoorHistory.length > 0
        ? { label: "Outdoor", readings: outdoorHistory, field: "temperature_f" }
        : null,
  });

  renderTrendChartCard(els.chartsGrid, {
    id: "humidity",
    title: "Relative Humidity",
    unit: "% RH",
    colorVar: "--chart-hum",
    decimals: 1,
    hours: state.hours,
    readings,
    field: "humidity_percent",
    stats: metrics?.humidity_percent ?? null,
    domainOptions: { minFloor: 0, suggestedMin: 25, suggestedMax: 60 },
    idealBand: { min: 30, max: 50, label: "30–50% ideal" },
    overlay:
      outdoorHistory.length > 0
        ? { label: "Outdoor", readings: outdoorHistory, field: "humidity_percent" }
        : null,
  });

  // Render notable spikes panel
  const spikes = summary?.notable_spikes || [];
  els.spikesPanel.hidden = false;

  const title = document.createElement("h3");
  title.className = "spikes-panel__title";
  title.textContent = `Notable Spikes (${state.period})`;
  els.spikesPanel.append(title);

  if (spikes.length === 0) {
    const clean = document.createElement("p");
    clean.className = "section__meta";
    clean.textContent = "No elevated CO2 (>1000 ppm) or PM2.5 (>9.0 µg/m³) episodes in this time window.";
    els.spikesPanel.append(clean);
    return;
  }

  const list = document.createElement("ul");
  list.className = "spikes-list";
  for (const spike of spikes.slice(0, 6)) {
    const li = document.createElement("li");
    li.className = "spikes-list__item";

    const left = document.createElement("div");
    const metricLabel = spike.metric === "co2_ppm" ? "CO2" : "PM2.5";
    const unitLabel = spike.unit === "ug/m3" ? "µg/m³" : spike.unit;
    left.textContent = `${metricLabel} peaked at ${spike.peak_value} ${unitLabel} (${spike.reading_count} sample${spike.reading_count === 1 ? "" : "s"})`;

    const right = document.createElement("div");
    right.className = "pill-row";
    right.append(
      createPill(spike.severity, spike.severity === "high" ? "danger" : "warn"),
      createPill(formatLocalTimestamp(spike.peak_timestamp), "neutral")
    );

    li.append(left, right);
    list.append(li);
  }
  els.spikesPanel.append(list);
}

// ============================================================================
// Fleet & Firmware Rollout Panel
// ============================================================================

function updateFleetReleasePreview() {
  const version = els.fleetReleaseSelect.value;
  const release = findReleaseByVersion(version);
  if (!release) {
    els.fleetReleaseMeta.textContent =
      "No active firmware releases published yet. Publish one via `npm --prefix functions run publish:release`.";
    return;
  }
  const summaryParts = [
    `v${release.version}`,
    `${release.file_count} file${release.file_count === 1 ? "" : "s"}`,
    formatBytes(release.total_size_bytes),
    release.git_sha ? `git ${release.git_sha.slice(0, 7)}` : null,
  ].filter(Boolean);
  els.fleetReleaseMeta.textContent = release.notes
    ? `${summaryParts.join(" · ")} — ${release.notes}`
    : summaryParts.join(" · ");
}

function renderFleetPanel() {
  const overview = state.overview;
  const devices = overview?.devices || [];
  const activeReleases = getActiveReleases();

  // 1. Summary pills & tab badge
  els.fleetOtaSummaryPills.replaceChildren();
  let upToDateCount = 0;
  let updatingCount = 0;
  let pendingCount = 0;
  let alertCount = 0;
  let anyTargetSet = false;

  for (const item of devices) {
    const status = item.ota_rollout_status || "up_to_date";
    if (item.desired_config?.target_firmware_version) {
      anyTargetSet = true;
    }
    if (status === "up_to_date") upToDateCount += 1;
    else if (status === "updating") updatingCount += 1;
    else if (status === "pending") pendingCount += 1;
    else alertCount += 1;
  }

  els.fleetOtaSummaryPills.append(
    createPill(
      `${upToDateCount} / ${devices.length} up to date`,
      devices.length > 0 && upToDateCount === devices.length ? "good" : "neutral"
    )
  );
  if (updatingCount > 0) {
    els.fleetOtaSummaryPills.append(createPill(`${updatingCount} updating`, "info", true));
  }
  if (pendingCount > 0) {
    els.fleetOtaSummaryPills.append(createPill(`${pendingCount} pending`, "warn", true));
  }
  if (alertCount > 0) {
    els.fleetOtaSummaryPills.append(createPill(`${alertCount} rollback / error`, "danger", true));
  }

  if (alertCount > 0) {
    els.tabFleetBadge.textContent = `${alertCount} !`;
    els.tabFleetBadge.className = "tab-badge tab-badge--danger";
    els.tabFleetBadge.hidden = false;
  } else if (updatingCount > 0) {
    els.tabFleetBadge.textContent = `${updatingCount}`;
    els.tabFleetBadge.className = "tab-badge tab-badge--info";
    els.tabFleetBadge.hidden = false;
  } else if (pendingCount > 0) {
    els.tabFleetBadge.textContent = `${pendingCount}`;
    els.tabFleetBadge.className = "tab-badge";
    els.tabFleetBadge.hidden = false;
  } else {
    els.tabFleetBadge.hidden = true;
    els.tabFleetBadge.textContent = "";
  }

  // 2. Fleet-wide release selector
  const prevSelected = els.fleetReleaseSelect.value;
  els.fleetReleaseSelect.replaceChildren();
  if (activeReleases.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No active releases";
    els.fleetReleaseSelect.append(opt);
    els.fleetReleaseSelect.disabled = true;
    els.fleetPromoteBtn.disabled = true;
  } else {
    for (const rel of activeReleases) {
      const opt = document.createElement("option");
      opt.value = rel.version;
      opt.textContent = `v${rel.version} (${formatLocalTimestamp(rel.created_at)})`;
      els.fleetReleaseSelect.append(opt);
    }
    if (prevSelected && activeReleases.some((r) => r.version === prevSelected)) {
      els.fleetReleaseSelect.value = prevSelected;
    }
    els.fleetReleaseSelect.disabled = false;
    els.fleetPromoteBtn.disabled = devices.length === 0;
  }
  els.fleetClearBtn.disabled = devices.length === 0 || !anyTargetSet;
  updateFleetReleasePreview();

  // 3. Fleet responsive table rows
  els.fleetTableBody.replaceChildren();
  if (devices.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "fleet-empty-cell";
    td.textContent = "No sensors have reported to Firestore yet.";
    tr.append(td);
    els.fleetTableBody.append(tr);
  } else {
    for (const item of devices) {
      const { device, desired_config: desired } = item;
      const rolloutStatus = item.ota_rollout_status || "up_to_date";
      const targetVersion = desired?.target_firmware_version ?? null;

      const tr = document.createElement("tr");

      // Col 1: Sensor (<th scope="row"> for sticky row header & mobile card header)
      const th = document.createElement("th");
      th.scope = "row";
      const sensorWrap = document.createElement("div");
      sensorWrap.className = "fleet-sensor";

      const head = document.createElement("div");
      head.className = "fleet-sensor__head";
      const roomSpan = document.createElement("span");
      roomSpan.className = "fleet-sensor__room";
      roomSpan.textContent = formatRoomName(device.location);
      const onlineTone =
        device.status === "online" ? "good" : device.status === "stale" ? "warn" : "danger";
      head.append(roomSpan, createPill(device.status.toUpperCase(), onlineTone, true));

      const idSpan = document.createElement("span");
      idSpan.className = "fleet-sensor__id";
      idSpan.textContent = `${device.device_id} · seen ${formatMinutesAgo(device.minutes_since_last_seen)}`;

      sensorWrap.append(head, idSpan);
      th.append(sensorWrap);
      tr.append(th);

      // Col 2: Running firmware version
      const tdRunning = document.createElement("td");
      const runningBadge = document.createElement("span");
      runningBadge.className = "version-badge";
      runningBadge.textContent = `v${device.firmware_version}`;
      tdRunning.append(runningBadge);
      tr.append(tdRunning);

      // Col 3: Target firmware version
      const tdTarget = document.createElement("td");
      const targetBadge = document.createElement("span");
      if (targetVersion) {
        targetBadge.className =
          targetVersion !== device.firmware_version
            ? "version-badge version-badge--target"
            : "version-badge";
        targetBadge.textContent = `v${targetVersion}`;
      } else {
        targetBadge.className = "version-badge version-badge--muted";
        targetBadge.textContent = "None";
      }
      tdTarget.append(targetBadge);
      tr.append(tdTarget);

      // Col 4: OTA Status + rollback/error details
      const tdStatus = document.createElement("td");
      const statusWrap = document.createElement("div");
      statusWrap.className = "ota-status-cell";
      const otaMeta = describeOtaStatus(rolloutStatus);
      statusWrap.append(createPill(otaMeta.label, otaMeta.tone, otaMeta.withDot));

      if (device.ota_last_error) {
        const errNote = document.createElement("p");
        errNote.className = "ota-error-note";
        errNote.textContent = device.ota_last_error;
        statusWrap.append(errNote);
      } else if (rolloutStatus === "pending" && targetVersion) {
        const pendingNote = document.createElement("span");
        pendingNote.className = "fleet-sensor__id";
        pendingNote.textContent = `Queued for next check-in (v${device.firmware_version} → v${targetVersion})`;
        statusWrap.append(pendingNote);
      }
      tdStatus.append(statusWrap);
      tr.append(tdStatus);

      // Col 5: Per-device rollout controls
      const tdAction = document.createElement("td");
      const actionGroup = document.createElement("div");
      actionGroup.className = "fleet-action-group";

      if (activeReleases.length > 0) {
        const select = document.createElement("select");
        select.className = "select-input";
        select.setAttribute("aria-label", `Select target firmware for ${device.device_id}`);
        for (const rel of activeReleases) {
          const opt = document.createElement("option");
          opt.value = rel.version;
          opt.textContent = `v${rel.version}`;
          select.append(opt);
        }
        if (targetVersion && activeReleases.some((r) => r.version === targetVersion)) {
          select.value = targetVersion;
        }

        const promoteBtn = document.createElement("button");
        promoteBtn.type = "button";
        promoteBtn.className = "btn btn--primary btn--sm";
        promoteBtn.textContent = "Promote";
        promoteBtn.addEventListener("click", () => {
          openRolloutConfirm({
            scope: "device",
            deviceId: device.device_id,
            deviceLocation: device.location,
            currentVersion: device.firmware_version,
            targetVersion: select.value,
          });
        });

        actionGroup.append(select, promoteBtn);
      } else {
        const noRel = document.createElement("span");
        noRel.className = "fleet-sensor__id";
        noRel.textContent = "Publish a release first";
        actionGroup.append(noRel);
      }

      if (targetVersion) {
        const clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.className = "btn btn--ghost btn--sm";
        clearBtn.textContent = "Clear";
        clearBtn.addEventListener("click", () => {
          openRolloutConfirm({
            scope: "device",
            deviceId: device.device_id,
            deviceLocation: device.location,
            currentVersion: device.firmware_version,
            targetVersion: null,
          });
        });
        actionGroup.append(clearBtn);
      }

      tdAction.append(actionGroup);
      tr.append(tdAction);
      els.fleetTableBody.append(tr);
    }
  }

  renderReleasesList();
}

function renderReleasesList() {
  els.releasesList.replaceChildren();
  const releases = state.releases || [];

  if (releases.length === 0) {
    const empty = document.createElement("p");
    empty.className = "section__meta";
    empty.textContent =
      "No firmware releases found in Firestore yet. Run `npm --prefix functions run publish:release` to publish your first release.";
    els.releasesList.append(empty);
    return;
  }

  for (const rel of releases) {
    const card = document.createElement("article");
    card.className = "release-card";

    const top = document.createElement("div");
    top.className = "release-card__top";

    const ver = document.createElement("span");
    ver.className = "version-badge";
    ver.textContent = `v${rel.version}`;

    const statusPill = createPill(
      rel.status === "yanked" ? "Yanked" : "Active",
      rel.status === "yanked" ? "danger" : "good"
    );

    top.append(ver, statusPill);
    card.append(top);

    const notes = document.createElement("p");
    notes.className = "release-card__notes";
    notes.textContent = rel.notes || "No release notes provided.";
    card.append(notes);

    const meta = document.createElement("div");
    meta.className = "release-card__meta";
    const metaParts = [
      `${rel.file_count} file${rel.file_count === 1 ? "" : "s"}`,
      formatBytes(rel.total_size_bytes),
      `Bootloader >= v${rel.min_bootloader_version}`,
      rel.git_sha ? `git ${rel.git_sha.slice(0, 7)}` : null,
      formatLocalTimestamp(rel.created_at),
    ].filter(Boolean);
    for (const part of metaParts) {
      const span = document.createElement("span");
      span.textContent = part;
      meta.append(span);
    }
    card.append(meta);

    els.releasesList.append(card);
  }
}

function openRolloutConfirm(plan) {
  state.pendingRollout = plan;
  const isClear = plan.targetVersion === null;
  const release = isClear ? null : findReleaseByVersion(plan.targetVersion);

  if (isClear) {
    els.rolloutDialogTitle.textContent =
      plan.scope === "fleet"
        ? "Clear firmware targets across all rooms?"
        : `Clear firmware target for ${plan.deviceId}?`;
    els.rolloutDialogBody.textContent =
      plan.scope === "fleet"
        ? "This removes target_firmware_version from every sensor's device_configs document. Sensors will remain on their currently running firmware."
        : `This removes target_firmware_version from ${plan.deviceId} (${formatRoomName(plan.deviceLocation)}). It will remain on v${plan.currentVersion}.`;
    els.rolloutConfirmBtn.textContent = "Clear Target";
    els.rolloutConfirmBtn.className = "btn btn--danger";
    els.rolloutDialogNotes.hidden = true;
    els.rolloutDialogNotes.textContent = "";
  } else {
    const deviceCount = state.overview?.devices?.length ?? 0;
    els.rolloutDialogTitle.textContent =
      plan.scope === "fleet"
        ? `Promote all ${deviceCount} sensor${deviceCount === 1 ? "" : "s"} to v${plan.targetVersion}?`
        : `Promote ${plan.deviceId} to v${plan.targetVersion}?`;
    els.rolloutDialogBody.textContent =
      plan.scope === "fleet"
        ? `Each sensor on wall power will download the SHA-256 verified v${plan.targetVersion} bundle on its next check-in, reboot, and auto-rollback if boot fails.`
        : `${plan.deviceId} (${formatRoomName(plan.deviceLocation)}) is currently running v${plan.currentVersion}. On its next wall-power check-in, it will download v${plan.targetVersion}, verify SHA-256 checksums, and reboot with automatic rollback protection.`;
    els.rolloutConfirmBtn.textContent =
      plan.scope === "fleet" ? `Promote All to v${plan.targetVersion}` : `Promote to v${plan.targetVersion}`;
    els.rolloutConfirmBtn.className = "btn btn--primary";
    if (release?.notes) {
      els.rolloutDialogNotes.textContent = `Release notes: ${release.notes}`;
      els.rolloutDialogNotes.hidden = false;
    } else {
      els.rolloutDialogNotes.hidden = true;
      els.rolloutDialogNotes.textContent = "";
    }
  }

  els.rolloutDialog.showModal();
}

async function executePendingRollout() {
  const plan = state.pendingRollout;
  state.pendingRollout = null;
  if (!plan) return;

  els.fleetPromoteBtn.disabled = true;
  els.fleetClearBtn.disabled = true;

  try {
    if (plan.scope === "fleet") {
      const res = await triggerFleetRollout(plan.targetVersion);
      const count = res.updated_count ?? 0;
      const msg =
        plan.targetVersion === null
          ? `Cleared target_firmware_version across ${count} sensor${count === 1 ? "" : "s"}.`
          : `Queued firmware v${plan.targetVersion} across ${count} sensor${count === 1 ? "" : "s"}. Sensors will update on their next check-in.`;
      showBanner(msg, plan.targetVersion === null ? "warn" : "success");
    } else {
      await setDeviceTargetFirmware(plan.deviceId, plan.targetVersion);
      const msg =
        plan.targetVersion === null
          ? `Cleared target_firmware_version for ${plan.deviceId}.`
          : `Queued firmware v${plan.targetVersion} for ${plan.deviceId}. Watch status transition from pending → updating → up to date on next check-in.`;
      showBanner(msg, plan.targetVersion === null ? "warn" : "success");
    }

    await refreshDashboard({ silentBanner: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      handleSessionExpired();
      return;
    }
    showBanner(
      err instanceof Error ? err.message : "Failed to update target firmware version.",
      "danger"
    );
  } finally {
    renderFleetPanel();
  }
}

// ============================================================================
// Device Settings Drawer & Remote Reboot Confirmation
// ============================================================================

function updateCalibrationEquivalents() {
  const offsetC = Number(els.cfgTempOffset.value);
  els.cfgTempOffsetF.textContent = Number.isFinite(offsetC)
    ? `(≈ ${(offsetC * 1.8).toFixed(1)} °F shift)`
    : "";

  const altM = Number(els.cfgAltitude.value);
  els.cfgAltitudeFt.textContent = Number.isFinite(altM)
    ? `(≈ ${Math.round(altM * 3.28084).toLocaleString()} ft)`
    : "";
}

function renderSettingsSyncBox(item) {
  const { device, desired_config: desired, config_sync_status: syncStatus } = item;
  els.settingsSyncBox.replaceChildren();

  const row1 = document.createElement("div");
  row1.className = "sync-box__row";
  const lbl1 = document.createElement("strong");
  lbl1.textContent = "Config Sync Status";
  const badge =
    syncStatus === "synced" && desired
      ? createPill(`Synced (v${desired.config_version})`, "good")
      : syncStatus === "pending" && desired
        ? createPill(`Pending (sensor v${device.config_version ?? 0} → cloud v${desired.config_version})`, "warn")
        : createPill("Using local defaults", "neutral");
  row1.append(lbl1, badge);

  const row2 = document.createElement("div");
  row2.className = "sync-box__row";
  const lbl2 = document.createElement("span");
  lbl2.textContent = "Last updated";
  const val2 = document.createElement("span");
  val2.textContent = desired
    ? `${formatLocalTimestamp(desired.updated_at)} by ${desired.updated_by}`
    : "Not yet saved in Firestore";
  row2.append(lbl2, val2);

  els.settingsSyncBox.append(row1, row2);

  els.settingsLastReboot.textContent = desired?.reboot_requested_at
    ? `Last remote reboot requested: ${formatLocalTimestamp(desired.reboot_requested_at)}`
    : "No remote reboot has been requested yet.";
}

function openSettingsDrawer(item) {
  const { device, desired_config: desired } = item;
  state.editingDeviceId = device.device_id;

  els.settingsDeviceSubtitle.textContent = `${device.device_id} · Firmware v${device.firmware_version}`;
  els.settingsError.hidden = true;
  els.settingsSuccess.hidden = true;
  renderSettingsSyncBox(item);

  // Reset form validation state first, then populate from desired_config (falling back to reported)
  els.settingsForm.reset();
  els.cfgLocation.value = desired?.location ?? device.location ?? "home-office";
  els.cfgInterval.value = String(
    desired?.reporting_interval_seconds ?? device.reporting_interval_seconds ?? 300
  );
  els.cfgTempOffset.value = String(
    desired?.temperature_offset_c ?? device.temperature_offset_c ?? 4.0
  );
  els.cfgAltitude.value = String(desired?.altitude_m ?? device.altitude_m ?? 0);
  els.cfgLedEnabled.checked = Boolean(desired?.led_enabled ?? device.led_enabled ?? true);

  updateCalibrationEquivalents();

  if (!els.settingsDialog.open) {
    els.settingsDialog.showModal();
  }
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  if (!state.editingDeviceId) return;

  els.settingsError.hidden = true;
  els.settingsSuccess.hidden = true;

  if (!els.settingsForm.checkValidity()) {
    els.settingsForm.reportValidity();
    const firstInvalid = els.settingsForm.querySelector(":invalid");
    firstInvalid?.focus();
    return;
  }

  const payload = {
    location: els.cfgLocation.value.trim(),
    reporting_interval_seconds: Math.round(Number(els.cfgInterval.value)),
    temperature_offset_c: Math.round(Number(els.cfgTempOffset.value) * 100) / 100,
    altitude_m: Math.round(Number(els.cfgAltitude.value)),
    led_enabled: Boolean(els.cfgLedEnabled.checked),
  };

  els.settingsSaveBtn.disabled = true;
  els.settingsSaveBtn.textContent = "Saving…";

  try {
    const result = await saveDeviceConfig(state.editingDeviceId, payload);
    const ver = result.config?.config_version;
    els.settingsSuccess.textContent = `Saved config v${ver}. The sensor will apply these settings on its next check-in.`;
    els.settingsSuccess.hidden = false;

    await refreshDashboard({ silentBanner: true });
    const updatedItem = state.overview?.devices?.find(
      (d) => d.device.device_id === state.editingDeviceId
    );
    if (updatedItem) {
      renderSettingsSyncBox(updatedItem);
    }
    showBanner(`Updated ${state.editingDeviceId} to config v${ver} (pending next check-in).`, "success");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      handleSessionExpired();
      return;
    }
    els.settingsError.textContent =
      err instanceof Error ? err.message : "Failed to save device settings.";
    els.settingsError.hidden = false;
  } finally {
    els.settingsSaveBtn.disabled = false;
    els.settingsSaveBtn.textContent = "Save Settings";
  }
}

async function executeRemoteReboot() {
  if (!state.editingDeviceId) return;

  els.openRebootConfirmBtn.disabled = true;
  els.settingsError.hidden = true;
  els.settingsSuccess.hidden = true;

  try {
    const result = await triggerDeviceReboot(state.editingDeviceId);
    const ver = result.config?.config_version;
    els.settingsSuccess.textContent = `Reboot requested (config v${ver}). The sensor will reboot once on its next check-in.`;
    els.settingsSuccess.hidden = false;

    await refreshDashboard({ silentBanner: true });
    const updatedItem = state.overview?.devices?.find(
      (d) => d.device.device_id === state.editingDeviceId
    );
    if (updatedItem) {
      renderSettingsSyncBox(updatedItem);
    }
    showBanner(`One-shot reboot queued for ${state.editingDeviceId}.`, "warn");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      handleSessionExpired();
      return;
    }
    els.settingsError.textContent =
      err instanceof Error ? err.message : "Failed to request remote reboot.";
    els.settingsError.hidden = false;
  } finally {
    els.openRebootConfirmBtn.disabled = false;
  }
}

// ============================================================================
// Home Outdoor Location Drawer & On-Demand Outdoor Refresh
// ============================================================================

function openSiteLocationDrawer() {
  const cfg = state.overview?.site_config ?? null;
  els.siteError.hidden = true;
  els.siteSuccess.hidden = true;
  els.siteForm.reset();

  els.siteLabel.value = cfg?.label ?? "Home Outdoor";
  els.siteLatitude.value = cfg?.latitude !== undefined ? String(cfg.latitude) : "";
  els.siteLongitude.value = cfg?.longitude !== undefined ? String(cfg.longitude) : "";
  els.sitePollInterval.value = String(cfg?.outdoor_poll_interval_minutes ?? 15);

  if (!els.siteDialog.open) {
    els.siteDialog.showModal();
  }
}

async function handleSiteLocationSubmit(event) {
  event.preventDefault();
  els.siteError.hidden = true;
  els.siteSuccess.hidden = true;

  if (!els.siteForm.checkValidity()) {
    els.siteForm.reportValidity();
    const firstInvalid = els.siteForm.querySelector(":invalid");
    firstInvalid?.focus();
    return;
  }

  const payload = {
    label: els.siteLabel.value.trim(),
    latitude: Number(els.siteLatitude.value),
    longitude: Number(els.siteLongitude.value),
    outdoor_poll_interval_minutes: Math.round(Number(els.sitePollInterval.value)),
  };

  els.siteSaveBtn.disabled = true;
  els.siteSaveBtn.textContent = "Saving & Fetching…";

  try {
    const res = await saveSiteLocationConfig(payload);
    const syncedTemp = res.outdoor_sync?.reading?.temperature_f;
    els.siteSuccess.textContent =
      syncedTemp !== undefined
        ? `Saved ${payload.label} and fetched live outdoor reading (${Number(syncedTemp).toFixed(1)}°F).`
        : `Saved ${payload.label} to Firestore.`;
    els.siteSuccess.hidden = false;
    await refreshDashboard({ silentBanner: true });
    showBanner(`Outdoor location "${payload.label}" saved and synced from Open-Meteo.`, "success");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      handleSessionExpired();
      return;
    }
    els.siteError.textContent =
      err instanceof Error ? err.message : "Failed to save outdoor location.";
    els.siteError.hidden = false;
  } finally {
    els.siteSaveBtn.disabled = false;
    els.siteSaveBtn.textContent = "Save & Fetch Outdoor";
  }
}

async function handleOutdoorRefresh(button) {
  button.disabled = true;
  const prevText = button.textContent;
  button.textContent = "Fetching…";
  try {
    await triggerOutdoorRefresh();
    await refreshDashboard({ silentBanner: true });
    showBanner("Fetched fresh outdoor weather & AQI snapshot from Open-Meteo.", "success");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      handleSessionExpired();
      return;
    }
    showBanner(
      err instanceof Error ? err.message : "Failed to refresh outdoor weather.",
      "danger"
    );
  } finally {
    button.disabled = false;
    button.textContent = prevText;
  }
}

// ============================================================================
// Data Loading & Auth Lifecycle
// ============================================================================

function handleSessionExpired() {
  clearSession();
  state.session = null;
  if (els.rolloutDialog.open) els.rolloutDialog.close("");
  if (els.rebootDialog.open) els.rebootDialog.close("");
  if (els.settingsDialog.open) els.settingsDialog.close("");
  if (els.siteDialog.open) els.siteDialog.close("");
  setView("auth");
  showAuthError("Your session expired. Please sign in again.");
}

async function loadCharts() {
  try {
    const limit = state.hours >= 168 ? 240 : 200;
    state.historyPayload = await fetchReadingsHistory({
      hours: state.hours,
      limit,
      period: state.period,
      deviceId: state.selectedDeviceId || undefined,
    });
    renderCharts();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      handleSessionExpired();
      return;
    }
    showBanner(
      err instanceof Error ? err.message : "Unable to load historical readings.",
      "danger"
    );
  }
}

async function refreshDashboard({ silentBanner = false } = {}) {
  if (state.isRefreshing) return;
  state.isRefreshing = true;
  els.refreshBtn.disabled = true;
  els.refreshBtn.querySelector(".btn__label").textContent = "Refreshing…";
  if (!silentBanner) {
    hideBanner();
  }

  try {
    const [overview, releasesPayload] = await Promise.all([
      fetchDashboardOverview(),
      fetchFirmwareReleases().catch(() => ({ count: 0, releases: [] })),
    ]);
    state.overview = overview;
    state.releases = Array.isArray(releasesPayload?.releases) ? releasesPayload.releases : [];

    if (
      !state.selectedDeviceId ||
      !overview.devices.some((d) => d.device.device_id === state.selectedDeviceId)
    ) {
      state.selectedDeviceId = overview.devices[0]?.device.device_id ?? null;
    }

    renderDeviceCards();
    renderFleetPanel();
    await loadCharts();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      handleSessionExpired();
      return;
    }
    showBanner(
      err instanceof Error ? err.message : "Unable to load dashboard data.",
      "danger"
    );
  } finally {
    state.isRefreshing = false;
    els.refreshBtn.disabled = false;
    els.refreshBtn.querySelector(".btn__label").textContent = "Refresh";
  }
}

function enterAuthenticatedApp(session) {
  state.session = session;
  els.userEmailBadge.textContent = session.user?.email || "Authenticated Owner";
  clearAuthError();
  setView("dashboard");
  refreshDashboard();
}

async function loadAuthScreen() {
  setView("auth");
  els.workosLoginBtn.disabled = true;
  els.authStatusNote.textContent = "Checking WorkOS AuthKit configuration…";

  try {
    state.authConfig = await fetchAuthConfig();
    if (state.authConfig.oauth_configured) {
      els.workosLoginBtn.disabled = false;
      els.authStatusNote.textContent = `WorkOS Redirect URI: ${getRedirectUri()}`;
    } else {
      els.workosLoginBtn.disabled = true;
      els.authStatusNote.textContent =
        "WorkOS AuthKit is not configured on this server. Use the Bearer fallback token below.";
    }
  } catch (err) {
    els.workosLoginBtn.disabled = true;
    els.authStatusNote.textContent =
      err instanceof Error ? err.message : "Unable to reach /api/auth/config.";
  }
}

async function init() {
  enhanceNativeSwitches();
  installDialogEnhancements();
  installAccessibleFormValidation();
  installTabsController();
  setView("loading");

  // 1. Check if returning from WorkOS AuthKit redirect (/auth/callback?code=...)
  els.loadingLabel.textContent = "Completing sign-in…";
  const callbackResult = await handleAuthCallbackIfPresent();
  if (callbackResult.handled) {
    if (callbackResult.ok) {
      enterAuthenticatedApp(callbackResult.session);
      return;
    }
    await loadAuthScreen();
    showAuthError(callbackResult.error);
    return;
  }

  // 2. Restore existing session if present
  const existing = loadSession();
  if (existing) {
    enterAuthenticatedApp(existing);
    return;
  }

  // 3. Otherwise show WorkOS Sign-In view
  await loadAuthScreen();
}

// ============================================================================
// Event Wiring
// ============================================================================

els.workosLoginBtn.addEventListener("click", async () => {
  clearAuthError();
  els.workosLoginBtn.disabled = true;
  els.workosLoginBtn.textContent = "Redirecting to WorkOS…";
  try {
    await startWorkosLogin(state.authConfig);
  } catch (err) {
    els.workosLoginBtn.disabled = false;
    els.workosLoginBtn.textContent = "Sign in with WorkOS";
    showAuthError(err instanceof Error ? err.message : "Unable to start WorkOS sign-in.");
  }
});

els.bearerLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearAuthError();
  if (!els.bearerLoginForm.checkValidity()) {
    els.bearerLoginForm.reportValidity();
    els.bearerTokenInput.focus();
    return;
  }

  els.bearerLoginBtn.disabled = true;
  els.bearerLoginBtn.textContent = "Verifying…";
  try {
    const session = await signInWithBearerToken(els.bearerTokenInput.value);
    els.bearerTokenInput.value = "";
    enterAuthenticatedApp(session);
  } catch (err) {
    showAuthError(err instanceof Error ? err.message : "Bearer token sign-in failed.");
  } finally {
    els.bearerLoginBtn.disabled = false;
    els.bearerLoginBtn.textContent = "Verify & Sign In";
  }
});

els.refreshBtn.addEventListener("click", () => refreshDashboard());

els.signoutBtn.addEventListener("click", async () => {
  clearSession();
  state.session = null;
  state.overview = null;
  state.releases = [];
  state.historyPayload = null;
  hideBanner();
  await loadAuthScreen();
});

els.fleetReleaseSelect.addEventListener("change", updateFleetReleasePreview);

els.fleetPromoteBtn.addEventListener("click", () => {
  const targetVersion = els.fleetReleaseSelect.value;
  if (!targetVersion) return;
  openRolloutConfirm({
    scope: "fleet",
    targetVersion,
  });
});

els.fleetClearBtn.addEventListener("click", () => {
  openRolloutConfirm({
    scope: "fleet",
    targetVersion: null,
  });
});

els.rolloutDialog.addEventListener("close", () => {
  const choice = els.rolloutDialog.returnValue;
  els.rolloutDialog.returnValue = "";
  if (choice === "confirm") {
    executePendingRollout();
  } else {
    state.pendingRollout = null;
  }
});

els.deviceFilterSelect.addEventListener("change", () => {
  state.selectedDeviceId = els.deviceFilterSelect.value || null;
  renderDeviceCards();
  loadCharts();
});

for (const btn of els.timeButtons) {
  btn.addEventListener("click", () => {
    const hours = Number(btn.dataset.hours);
    const period = btn.dataset.period;
    if (!Number.isFinite(hours) || !period) return;
    if (state.hours === hours && state.period === period) return;

    state.hours = hours;
    state.period = period;
    for (const b of els.timeButtons) {
      const active = b === btn;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", String(active));
    }
    loadCharts();
  });
}

// Device Settings drawer controls
els.settingsCloseBtn.addEventListener("click", () => closeModalDialog(els.settingsDialog, ""));
els.settingsCancelBtn.addEventListener("click", () => closeModalDialog(els.settingsDialog, ""));
els.settingsDialog.addEventListener("close", () => {
  els.settingsDialog.returnValue = "";
});

els.settingsForm.addEventListener("submit", handleSettingsSubmit);
els.cfgTempOffset.addEventListener("input", updateCalibrationEquivalents);
els.cfgAltitude.addEventListener("input", updateCalibrationEquivalents);

for (const chip of els.intervalPresets) {
  chip.addEventListener("click", () => {
    els.cfgInterval.value = chip.dataset.interval;
    els.cfgInterval.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

els.openRebootConfirmBtn.addEventListener("click", () => {
  if (!state.editingDeviceId) return;
  els.rebootDialogBody.textContent = `Request a one-shot remote reboot for ${state.editingDeviceId}? It will restart cleanly on its next check-in and resume normal publishing.`;
  els.rebootDialog.showModal();
});

els.rebootDialog.addEventListener("close", () => {
  const choice = els.rebootDialog.returnValue;
  // Reset returnValue immediately so Esc/subsequent closes cannot inherit a stale choice.
  els.rebootDialog.returnValue = "";
  if (choice === "reboot") {
    executeRemoteReboot();
  }
});

// Outdoor Home Location drawer controls
els.siteCloseBtn.addEventListener("click", () => closeModalDialog(els.siteDialog, ""));
els.siteCancelBtn.addEventListener("click", () => closeModalDialog(els.siteDialog, ""));
els.siteDialog.addEventListener("close", () => {
  els.siteDialog.returnValue = "";
});
els.siteForm.addEventListener("submit", handleSiteLocationSubmit);

for (const chip of els.outdoorIntervalPresets) {
  chip.addEventListener("click", () => {
    els.sitePollInterval.value = chip.dataset.outdoorInterval;
    els.sitePollInterval.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

els.siteGeolocateBtn.addEventListener("click", () => {
  els.siteError.hidden = true;
  if (!("geolocation" in navigator)) {
    els.siteError.textContent = "Browser geolocation is not available. Enter coordinates manually.";
    els.siteError.hidden = false;
    return;
  }
  els.siteGeolocateBtn.disabled = true;
  els.siteGeolocateBtn.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      els.siteLatitude.value = pos.coords.latitude.toFixed(5);
      els.siteLongitude.value = pos.coords.longitude.toFixed(5);
      els.siteLatitude.dispatchEvent(new Event("input", { bubbles: true }));
      els.siteLongitude.dispatchEvent(new Event("input", { bubbles: true }));
      els.siteGeolocateBtn.disabled = false;
      els.siteGeolocateBtn.textContent = "Use Browser Location";
    },
    (err) => {
      els.siteError.textContent = `Unable to read browser location (${err.message}). Enter latitude/longitude manually.`;
      els.siteError.hidden = false;
      els.siteGeolocateBtn.disabled = false;
      els.siteGeolocateBtn.textContent = "Use Browser Location";
    },
    { enableHighAccuracy: false, timeout: 10000 }
  );
});

init();
