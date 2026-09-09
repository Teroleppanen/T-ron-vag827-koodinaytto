/*
 * BD392 code display - wiring layer: geolocation, DOM, wake lock, SW.
 * All decision logic lives in core.js (Core.*) so it stays testable.
 */
(function () {
  "use strict";

  var DEBUG = /[?&]debug=1\b/.test(location.search);

  proj4.defs(
    "EPSG:3006",
    "+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9996 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"
  );

  var el = {
    init: document.getElementById("screen-init"),
    uncertain: document.getElementById("screen-uncertain"),
    main: document.getElementById("screen-main"),
    metrics: document.getElementById("metrics"),
    symbol: document.getElementById("symbol"),
    footer: document.getElementById("footer"),
    footerPaalu: document.getElementById("footer-paalu"),
    footerDir: document.getElementById("footer-dir"),
    footerGps: document.getElementById("footer-gps"),
    debugPanel: document.getElementById("debug-panel"),
    debugContent: document.getElementById("debug-content")
  };

  if (DEBUG) el.debugPanel.classList.add("active");

  function showScreen(name) {
    [el.init, el.uncertain, el.main].forEach(function (s) { s.classList.remove("active"); });
    if (name === "init") el.init.classList.add("active");
    if (name === "uncertain") el.uncertain.classList.add("active");
    if (name === "main") el.main.classList.add("active");
  }

  // ---------------------------------------------------------------------
  // Application state
  // ---------------------------------------------------------------------

  var road = null; // loaded from window.ROAD_FILE (index.html)
  var eventCursor = null;

  // Memory-bound only, not a decision gate (computeDirection is distance-
  // based). Must still be generous enough to actually HOLD the distance the
  // thresholds need at slow speed - at 6 km/h (1.667 m/s), reaching the 40 m
  // reversal threshold via the median-halves split needs roughly a 48 s
  // window; a short window would prune the very history needed to ever
  // confirm or reverse at realistic painting speed.
  var MHISTORY_WINDOW_MS = 90000;

  var state = {
    mode: "INIT", // INIT | APPROACH | ON_ROUTE
    direction: null, // null | UP | DOWN - CONFIRMED by real GPS movement only (never guessed)
    expectedDirection: null, // null | UP | DOWN - immediate preliminary guess from the nearest approach point
    mHistory: [], // confirmed {m,t} while ON_ROUTE, time-pruned to MHISTORY_WINDOW_MS
    onRouteStreak: 0,
    lastStreakFixTime: null, // for gap-aware onRouteStreakStep
    lastAcceptedFix: null, // {m, t, speedMps}
    lastAcceptedFixTime: null, // any accuracy-accepted fix (governs APPROACH/INIT staleness)
    lastTrustedPositionTime: null, // only trustedForPosition fixes (governs ON_ROUTE staleness)
    lastAccuracy: null,
    lastRawFix: null, // most recent fix regardless of accuracy, for debug
    lastRoadProjection: null, // {m, distanceToRoad}
    lastApproach: null, // {distance, point}
    nextEvent: null // {event, distance} from eventCursor, set once per accepted fix
  };

  function nowMs() { return Date.now(); }

  // What to actually translate/draw symbols with: the CONFIRMED direction
  // once real GPS movement has established one, otherwise the immediate
  // preliminary guess from the nearest approach point - so a code is shown
  // right-side-up from the first second in both APPROACH and ON_ROUTE,
  // instead of only after ~confirmation. Section 10's "ennakko-oletus"
  // (preliminary assumption) principle still holds: this is never treated
  // as locked/sticky - state.direction is the only thing that is.
  function displayDirection() {
    return state.direction || state.expectedDirection || null;
  }

  // ---------------------------------------------------------------------
  // Load static object data (single JSON, no runtime Excel/NVDB fetches)
  // ---------------------------------------------------------------------

  fetch(window.ROAD_FILE || "data/road392.json")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      road = data;
      eventCursor = new Core.EventCursor(road.events);
      startGeolocation();
    })
    .catch(function (err) {
      el.init.querySelector(".init-text").textContent = "Datan lataus epäonnistui: " + err;
    });

  // ---------------------------------------------------------------------
  // Geolocation
  // ---------------------------------------------------------------------

  function startGeolocation() {
    if (!("geolocation" in navigator)) {
      el.init.querySelector(".init-text").textContent = "Ei GPS-tukea";
      return;
    }
    navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000
    });
  }

  // Desktop/mock-GPS test hook (section 20, step 13). Inert unless
  // dispatched manually from devtools; not wired to any UI control.
  // window.dispatchEvent(new CustomEvent('bd392:mockposition', {detail:{coords:{...}}}))
  window.addEventListener("bd392:mockposition", function (e) { onPosition(e.detail); });

  function onPositionError() {
    state.lastAccuracy = null;
  }

  function onPosition(pos) {
    var c = pos.coords;
    var t = pos.timestamp || nowMs();

    var xy = proj4("EPSG:4326", "EPSG:3006", [c.longitude, c.latitude]);
    var point3006 = { e: xy[0], n: xy[1] };

    state.lastRawFix = {
      t: t,
      lat: c.latitude,
      lon: c.longitude,
      accuracy: c.accuracy,
      speed: c.speed,
      heading: c.heading,
      point3006: point3006
    };
    state.lastAccuracy = c.accuracy;

    var accepted = Core.isFixAccepted(c.accuracy);
    if (!accepted) return; // stale-fix aging is still tracked via lastAcceptedFixTime

    state.lastAcceptedFixTime = t;

    // Nearest approach point / expectedDirection: computed on every accepted
    // fix regardless of mode (cheap - two distance checks), not just while
    // mode is APPROACH. Otherwise a session that reaches the ON_ROUTE streak
    // before ever running this block (e.g. the app starts already sitting on
    // the road) would leave expectedDirection unset with no fallback for
    // displayDirection() to use.
    var nearest = null;
    road.approachPoints.forEach(function (ap) {
      var d = Core.distance2D(point3006, ap);
      if (nearest === null || d < nearest.distance) nearest = { distance: d, point: ap };
    });
    state.lastApproach = nearest;
    if (nearest) state.expectedDirection = nearest.point.expectedDirection;
    if (state.mode !== "ON_ROUTE" && nearest && nearest.distance < Core.CONFIG.APPROACH_TRIGGER_M) {
      state.mode = "APPROACH";
    }

    var roadProjection = Core.projectPointToGeometry(road.geometry, point3006);
    state.lastRoadProjection = roadProjection;
    var distanceToRoad = roadProjection ? roadProjection.distanceToRoad : null;
    // Trusted for updating currentM/direction: within ON_ROUTE_DISTANCE_M of
    // the geometry. A fix between that and the 150 m "implausible" cutoff is
    // accuracy-accepted but positionally unreliable (could be a parallel
    // road or a bad segment match) - keep the last good position on screen
    // instead of quietly steering off it.
    var trustedForPosition = typeof distanceToRoad === "number" && distanceToRoad < Core.CONFIG.ON_ROUTE_DISTANCE_M;

    if (state.mode !== "ON_ROUTE") {
      var gapMs = state.lastStreakFixTime === null ? null : t - state.lastStreakFixTime;
      state.onRouteStreak = Core.onRouteStreakStep(state.onRouteStreak, distanceToRoad, gapMs);
      state.lastStreakFixTime = t;
      if (Core.isOnRouteReady(state.onRouteStreak)) {
        state.mode = "ON_ROUTE";
      }
    }

    if (state.mode === "ON_ROUTE" && roadProjection && trustedForPosition) {
      state.lastTrustedPositionTime = t;
      var speedMps = typeof c.speed === "number" && c.speed >= 0 ? c.speed : estimateSpeed(roadProjection.m, t);
      state.lastAcceptedFix = { m: roadProjection.m, t: t, speedMps: speedMps };

      state.mHistory.push({ m: roadProjection.m, t: t });
      while (state.mHistory.length > 0 && t - state.mHistory[0].t > MHISTORY_WINDOW_MS) state.mHistory.shift();
      // Only real movement can set/confirm state.direction - expectedDirection
      // is never fed in here as a shortcut (section 10: it's a preliminary
      // assumption, not evidence).
      state.direction = Core.computeDirection(state.mHistory, state.direction);

      // eventCursor.update() must run exactly once per genuine accepted fix,
      // not once per render() tick - its crossing-confirmation streak counts
      // calls, and render() ticks every 200ms regardless of new GPS data.
      // Calling it from render() would "confirm" a marginal crossing off a
      // single stale fix within a few ticks, defeating the hysteresis.
      // Uses displayDirection() (confirmed-or-expected) so the cursor - and
      // therefore the symbol - is live from the first ON_ROUTE fix; if the
      // guess later turns out wrong, the cursor's own reinit-on-direction-
      // change logic cleanly re-anchors it once state.direction is confirmed.
      var dir = displayDirection();
      if (dir === "UP" || dir === "DOWN") {
        state.nextEvent = eventCursor.update(state.lastAcceptedFix.m, dir);
      }
    }

    render();
  }

  function estimateSpeed(m, t) {
    var prev = state.lastAcceptedFix;
    if (!prev) return 0;
    var dt = (t - prev.t) / 1000;
    if (dt <= 0) return 0;
    return Math.abs(m - prev.m) / dt;
  }

  // ---------------------------------------------------------------------
  // Render loop - runs continuously so the "meters" number can interpolate
  // smoothly between ~1 Hz GPS fixes, and so "GPS EPÄVARMA" appears even
  // without a new fix arriving (pure time-based staleness).
  // ---------------------------------------------------------------------

  // Capped well under GPS_MAX_FIX_AGE_MS (4000): that ceiling only governs
  // when the screen gives up and shows GPS EPÄVARMA. Extrapolating distance
  // display all the way out to it would let "0 m" show up to ~56 m early at
  // 50 km/h while the fix is still technically "fresh enough" not to be
  // uncertain. 1.5 s bounds that error to normal 1 Hz gaps.
  var DISPLAY_INTERPOLATION_CAP_MS = 1500;

  function computeDisplayM() {
    if (!state.lastAcceptedFix) return null;
    var elapsedMs = nowMs() - state.lastAcceptedFix.t;
    var cappedMs = Math.min(elapsedMs, DISPLAY_INTERPOLATION_CAP_MS);
    var dir = displayDirection();
    var sign = dir === "UP" ? 1 : dir === "DOWN" ? -1 : 0;
    return state.lastAcceptedFix.m + sign * (state.lastAcceptedFix.speedMps || 0) * (cappedMs / 1000);
  }

  function render() {
    // ON_ROUTE: what's on screen (currentM, next event) is only as fresh as
    // the last *trusted* fix - an accuracy-accepted fix 50 m off the
    // geometry keeps lastAcceptedFixTime ticking over without ever updating
    // the displayed position, which would otherwise look confidently
    // current forever. Before ON_ROUTE there's no position-trust concept
    // yet, so any accepted fix's recency is what matters (approach distance
    // itself is accuracy-gated only).
    var relevantFixTime = state.mode === "ON_ROUTE" ? state.lastTrustedPositionTime : state.lastAcceptedFixTime;
    var lastAcceptedFixAgeMs = relevantFixTime === null ? null : nowMs() - relevantFixTime;
    var distanceToRoad = state.lastRoadProjection ? state.lastRoadProjection.distanceToRoad : null;

    var uncertain = Core.isGpsUncertain({
      accuracy: state.lastAccuracy,
      lastAcceptedFixAgeMs: lastAcceptedFixAgeMs,
      onRoute: state.mode === "ON_ROUTE",
      distanceToRoad: distanceToRoad
    });

    if (road === null) {
      showScreen("init");
    } else if (uncertain) {
      showScreen("uncertain");
    } else if (state.mode === "ON_ROUTE") {
      renderOnRoute();
      showScreen("main");
    } else if (state.mode === "APPROACH") {
      renderApproach();
      showScreen("main");
    } else {
      showScreen("init");
    }

    if (DEBUG) renderDebug(uncertain, lastAcceptedFixAgeMs, distanceToRoad);
  }

  // Both APPROACH and ON_ROUTE resolve their symbol through the exact same
  // Core.resolveDisplayEvent(event, direction) call, using whatever
  // displayDirection() currently returns - a raw excel-native event is
  // never shown as-is. That direction is only ever a confirmed one or the
  // approach point's own expectedDirection; it is never guessed from
  // scratch, so this stays consistent with section 6/10's translation rule.
  function renderApproach() {
    var ap = state.lastApproach;
    if (!ap) return;
    el.metrics.textContent = Core.formatMeters(ap.distance) + " m";
    var dir = displayDirection();
    var event = ap.point.event === "COMPOUND"
      ? { type: "COMPOUND", sourceKinds: ap.point.sourceKinds || [] }
      : { type: ap.point.event };
    var resolved = Core.resolveDisplayEvent(event, dir);
    el.symbol.innerHTML = Symbols.render(resolved.symbol);
    el.footerPaalu.textContent = "";
    el.footerDir.textContent = "";
    el.footerGps.textContent = "GPS ±" + Math.round(state.lastAccuracy) + " m";
  }

  function renderOnRoute() {
    var displayM = computeDisplayM();
    if (displayM === null) return;

    var dir = displayDirection();
    if (dir === "UP" || dir === "DOWN") {
      var next = state.nextEvent;
      if (next) {
        var rawDistance = dir === "UP"
          ? next.event.m - displayM
          : displayM - next.event.m;
        // Clamp for display only: extrapolation between fixes, or a
        // crossing still pending confirmation, can otherwise show a
        // confusing negative number for an event we haven't actually
        // reached/passed yet.
        var displayDistance = Math.max(0, rawDistance);
        var resolved = Core.resolveDisplayEvent(next.event, dir);
        el.metrics.textContent = Core.formatMeters(displayDistance) + " m";
        el.symbol.innerHTML = Symbols.render(resolved.symbol);
      } else {
        el.metrics.textContent = "-";
        el.symbol.innerHTML = "";
      }
      el.footerDir.textContent = dir === "UP" ? "↑" : "↓";
    } else {
      el.metrics.textContent = "…";
      el.symbol.innerHTML = "";
      el.footerDir.textContent = "";
    }

    el.footerPaalu.textContent = "paalu " + Core.formatMeters(state.lastAcceptedFix.m);
    el.footerGps.textContent = "GPS ±" + Math.round(state.lastAccuracy) + " m";
  }

  function renderDebug(uncertain, lastAcceptedFixAgeMs, distanceToRoad) {
    var raw = state.lastRawFix;
    var next = state.nextEvent;
    var lines = [
      "state: " + (uncertain ? "GPS_UNCERTAIN" : state.mode),
      "currentM: " + (state.lastAcceptedFix ? state.lastAcceptedFix.m.toFixed(1) : "-"),
      "raw GPS: " + (raw ? raw.lat.toFixed(6) + ", " + raw.lon.toFixed(6) : "-"),
      "accuracy: " + (state.lastAccuracy !== null ? state.lastAccuracy.toFixed(1) + " m" : "-"),
      "distanceToRoad: " + (distanceToRoad !== null ? distanceToRoad.toFixed(1) + " m" : "-"),
      "direction: " + (state.direction || "-") + " (confirmed)",
      "expectedDirection: " + (state.expectedDirection || "-"),
      "displayDirection: " + (displayDirection() || "-"),
      "next event m: " + (next ? next.event.m : "-"),
      "next event source type: " + (next ? next.event.type : "-"),
      "approachDistance: " + (state.lastApproach ? state.lastApproach.distance.toFixed(1) + " m" : "-"),
      "nearest approach point: " + (state.lastApproach ? state.lastApproach.point.id : "-"),
      "lastAcceptedFixAgeMs: " + lastAcceptedFixAgeMs
    ];
    el.debugContent.textContent = lines.join("\n");
  }

  setInterval(render, 200);

  // ---------------------------------------------------------------------
  // Wake Lock (best-effort, app works fine without it)
  // ---------------------------------------------------------------------

  var wakeLock = null;
  function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    navigator.wakeLock.request("screen").then(function (lock) {
      wakeLock = lock;
    }).catch(function () { /* ignore - non-critical */ });
  }
  requestWakeLock();
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") requestWakeLock();
  });

  // ---------------------------------------------------------------------
  // Service worker (offline)
  // ---------------------------------------------------------------------

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () { /* ignore */ });
    });
  }
})();
