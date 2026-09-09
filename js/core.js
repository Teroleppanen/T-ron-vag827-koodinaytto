/*
 * BD392 code display - pure logic core (no DOM, no geolocation).
 * Kept separate from app.js so it can be unit tested directly (see test.html).
 */
(function (global) {
  "use strict";

  // Field-tunable constants - single place to adjust in the field.
  var CONFIG = {
    HYSTERESIS_M: 3,               // event crossing hysteresis
    EVENT_CROSS_CONFIRM_FIXES: 2,  // consecutive fixes needed to confirm a marginal crossing
    EVENT_CROSS_IMMEDIATE_M: 40,   // overshoot past this is unambiguous - advance without waiting
    DIRECTION_LOCK_DELTA_M: 25,    // median-to-median net m movement required to confirm direction
    DIRECTION_REVERSAL_DELTA_M: 40, // once confirmed, an opposite trend needs this much to flip it
    DIRECTION_MIN_FIXES: 3,        // min accepted fixes before direction can even be attempted
    ON_ROUTE_DISTANCE_M: 30,       // max distance from road geometry to count as on it
    ON_ROUTE_MIN_CONSECUTIVE_FIXES: 3,
    ON_ROUTE_IMPLAUSIBLE_DISTANCE_M: 150, // while ON_ROUTE, distance beyond this => GPS uncertain
    APPROACH_TRIGGER_M: 1500,      // start showing approach distance below this
    GPS_MAX_ACCURACY_M: 25,        // fixes worse than this are not "accepted"
    GPS_MAX_FIX_AGE_MS: 4000       // no accepted fix for longer than this => uncertain
  };

  // ---------------------------------------------------------------------
  // Event semantics translation (section 6)
  // ---------------------------------------------------------------------

  var UP_MAP = {
    VARNING_BEGIN: "VARNING_BEGIN",
    VARNING_END: "VARNING_END",
    TATORT_BEGIN: "TATORT_BEGIN",
    TATORT_END: "TATORT_END"
  };
  var DOWN_MAP = {
    VARNING_BEGIN: "VARNING_END",
    VARNING_END: "VARNING_BEGIN",
    TATORT_BEGIN: "TATORT_END",
    TATORT_END: "TATORT_BEGIN"
  };

  function translateSimpleKind(kind, direction) {
    var map = direction === "DOWN" ? DOWN_MAP : UP_MAP;
    return map[kind];
  }

  // Resolve what to actually display for a raw excel-native event, given the
  // current confirmed driving direction. Never mirrors an SVG - translates
  // the semantics of the event itself (section 6).
  function resolveDisplayEvent(event, direction) {
    if (event.type === "COMPOUND") {
      var translated = (event.sourceKinds || []).map(function (k) {
        return translateSimpleKind(k, direction);
      });
      var endKind = translated.filter(function (k) { return k && /_END$/.test(k); })[0];
      var beginKind = translated.filter(function (k) { return k && /_BEGIN$/.test(k); })[0];
      if (!endKind || !beginKind) {
        // Malformed compound data (missing/incomplete sourceKinds). This
        // should never happen with a valid build - parse_excel.py validates
        // it - but the field display must fail safe (blank symbol) rather
        // than throw and freeze the whole screen.
        return { symbol: null, subOrder: null, compound: true };
      }
      var symbol = endKind.indexOf("VARNING") === 0 ? "WARNING_TO_TATORT" : "TATORT_TO_WARNING";
      return { symbol: symbol, subOrder: [endKind, beginKind], compound: true };
    }
    return { symbol: translateSimpleKind(event.type, direction), subOrder: null, compound: false };
  }

  // ---------------------------------------------------------------------
  // Next-event lookup in physical encounter order (section 7)
  // ---------------------------------------------------------------------

  // events: sorted ascending by m. Stateless per spec section 7: with no
  // passedBoundary, "next" is simply the nearest event ahead of currentM in
  // the direction of travel. passedBoundary (optional) overrides that floor/
  // ceiling for the sticky hysteresis case - see EventCursor below.
  function getNextEvent(events, currentM, direction, passedBoundary) {
    if (direction !== "UP" && direction !== "DOWN") return null;
    var candidates;
    var next;
    var distance;
    if (direction === "UP") {
      var floor = passedBoundary === undefined || passedBoundary === null ? currentM : passedBoundary;
      candidates = events.filter(function (e) { return e.m > floor; });
      if (candidates.length === 0) return null;
      next = candidates.reduce(function (a, b) { return b.m < a.m ? b : a; });
      distance = next.m - currentM;
    } else {
      var ceil = passedBoundary === undefined || passedBoundary === null ? currentM : passedBoundary;
      candidates = events.filter(function (e) { return e.m < ceil; });
      if (candidates.length === 0) return null;
      next = candidates.reduce(function (a, b) { return b.m > a.m ? b : a; });
      distance = currentM - next.m;
    }
    return { event: next, distance: distance };
  }

  // Sticky cursor implementing event-crossing hysteresis (section 14).
  // Advances only forward in the direction of travel. A crossing beyond
  // HYSTERESIS_M but still within EVENT_CROSS_IMMEDIATE_M is "marginal" -
  // GPS noise within the accepted accuracy budget can produce it - so it
  // only advances the cursor once EVENT_CROSS_CONFIRM_FIXES consecutive
  // fixes confirm it; a single wobble that falls back below the hysteresis
  // line cancels the pending confirmation instead of skipping the code.
  // A crossing beyond EVENT_CROSS_IMMEDIATE_M (a real signal gap, a fast
  // fix) is unambiguous and advances immediately, one hop per event, until
  // it catches up to wherever confirmedM actually is.
  function EventCursor(events) {
    this.events = events.slice().sort(function (a, b) { return a.m - b.m; });
    this.passedBoundary = null; // null = "include everything", set on first fix
    this.direction = null;
    this.pendingBoundary = null; // m of the event a marginal crossing is pending on
    this.pendingStreak = 0;
  }

  EventCursor.prototype.update = function (confirmedM, direction) {
    if (direction !== "UP" && direction !== "DOWN") return null;
    if (this.direction !== direction) {
      this.direction = direction;
      // Start unbounded (not "at confirmedM") so the very first call goes
      // through the exact same overshoot/immediate/confirm logic below as
      // every later call - it just may need a few extra loop hops to catch
      // up from the object's start. A boundary seeded at confirmedM would
      // let the first fix "confirm" any crossing for free, bypassing
      // hysteresis entirely on exactly the fix where direction just locked.
      this.passedBoundary = direction === "UP" ? -Infinity : Infinity;
      this.pendingBoundary = null;
      this.pendingStreak = 0;
    }
    var hyst = CONFIG.HYSTERESIS_M;
    var immediate = CONFIG.EVENT_CROSS_IMMEDIATE_M;
    var confirmFixes = CONFIG.EVENT_CROSS_CONFIRM_FIXES;
    var result = getNextEvent(this.events, confirmedM, direction, this.passedBoundary);

    while (result) {
      var overshoot = direction === "UP" ? confirmedM - result.event.m : result.event.m - confirmedM;
      if (overshoot <= hyst) {
        this.pendingBoundary = null;
        this.pendingStreak = 0;
        break;
      }
      if (overshoot > immediate) {
        // Unambiguous - advance now, then loop to see if it catches up further.
        this.passedBoundary = result.event.m;
        this.pendingBoundary = null;
        this.pendingStreak = 0;
        result = getNextEvent(this.events, confirmedM, direction, this.passedBoundary);
        continue;
      }
      // Marginal crossing - needs consecutive confirmation, not a single fix.
      if (this.pendingBoundary === result.event.m) {
        this.pendingStreak++;
      } else {
        this.pendingBoundary = result.event.m;
        this.pendingStreak = 1;
      }
      if (this.pendingStreak < confirmFixes) break;
      this.passedBoundary = result.event.m;
      this.pendingBoundary = null;
      this.pendingStreak = 0;
      result = getNextEvent(this.events, confirmedM, direction, this.passedBoundary);
    }
    return result;
  };

  // ---------------------------------------------------------------------
  // Direction detection (section 5)
  // ---------------------------------------------------------------------

  function median(values) {
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // history: array of confirmed {m, t} in chronological order (oldest first),
  // time-pruned by the caller as a memory bound only (app.js keeps ~20 s) -
  // NOT a gate. Confirmation is driven purely by how far the vehicle has
  // actually moved (distance), not by how long that took: at painting
  // speed, waiting on a fixed time window before ever attempting a lock
  // makes slow driving needlessly sluggish, and a fixed distance still
  // needs "however long it takes" regardless of speed. Returns 'UP' | 'DOWN'
  // | null (not yet determined - caller falls back to expectedDirection for
  // display, but this function never uses it: only real movement confirms).
  //
  // Splits the window at its time midpoint and compares the *median* m of
  // each half, not the raw first/last fix, the sum of consecutive deltas
  // (a stationary vehicle's GPS noise would otherwise accumulate fake
  // "distance traveled"), or per-step monotonicity: a single noisy fix
  // (within the accepted 25 m accuracy budget) can easily exceed a tight
  // per-step jitter tolerance, and a per-step check gets stricter (not
  // looser) at higher GPS frequency since each step covers less real
  // distance. Medians are insensitive to any one outlier fix.
  //
  // Once locked, only an opposite trend at least DIRECTION_REVERSAL_DELTA_M
  // (a clearly stronger signal than the initial lock) flips it - so a stop
  // or a few noisy fixes against the grain never flip it (section 5 & test
  // D), but a genuine sustained U-turn eventually can.
  function computeDirection(history, locked) {
    if (!history || history.length < CONFIG.DIRECTION_MIN_FIXES) return locked || null;

    var oldest = history[0];
    var newest = history[history.length - 1];
    var midT = (oldest.t + newest.t) / 2;
    var firstHalf = [];
    var secondHalf = [];
    for (var i = 0; i < history.length; i++) {
      (history[i].t <= midT ? firstHalf : secondHalf).push(history[i].m);
    }
    if (firstHalf.length === 0 || secondHalf.length === 0) return locked || null;

    var net = median(secondHalf) - median(firstHalf);

    if (locked === "UP") return net <= -CONFIG.DIRECTION_REVERSAL_DELTA_M ? "DOWN" : "UP";
    if (locked === "DOWN") return net >= CONFIG.DIRECTION_REVERSAL_DELTA_M ? "UP" : "DOWN";

    if (net >= CONFIG.DIRECTION_LOCK_DELTA_M) return "UP";
    if (net <= -CONFIG.DIRECTION_LOCK_DELTA_M) return "DOWN";
    return null;
  }

  // ---------------------------------------------------------------------
  // Road geometry projection (section 11)
  // ---------------------------------------------------------------------

  // geometry: array of {m, n, e} sorted ascending by m (linear-referenced
  // NVDB points, straight from the source survey - not re-derived).
  // point: {n, e} in EPSG:3006.
  // Returns {m, distanceToRoad} using the nearest segment projection; m is
  // interpolated purely from the segment's own m1/m2 (never from driven
  // distance - see section 11 constraint).
  function projectPointToGeometry(geometry, point) {
    if (!geometry || geometry.length < 2) return null;
    var best = null;
    for (var i = 0; i < geometry.length - 1; i++) {
      var p1 = geometry[i];
      var p2 = geometry[i + 1];
      var dx = p2.e - p1.e;
      var dy = p2.n - p1.n;
      var lenSq = dx * dx + dy * dy;
      var t;
      if (lenSq === 0) {
        t = 0;
      } else {
        t = ((point.e - p1.e) * dx + (point.n - p1.n) * dy) / lenSq;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
      }
      var projE = p1.e + t * dx;
      var projN = p1.n + t * dy;
      var de = point.e - projE;
      var dn = point.n - projN;
      var dist = Math.sqrt(de * de + dn * dn);
      if (best === null || dist < best.dist) {
        var m = p1.m + t * (p2.m - p1.m);
        best = { dist: dist, m: m };
      }
    }
    return { m: best.m, distanceToRoad: best.dist };
  }

  function distance2D(a, b) {
    var de = a.e - b.e;
    var dn = a.n - b.n;
    return Math.sqrt(de * de + dn * dn);
  }

  // ---------------------------------------------------------------------
  // GPS quality (section 13)
  // ---------------------------------------------------------------------

  function isGpsUncertain(params) {
    if (params.accuracy === null || params.accuracy === undefined) return true;
    if (params.accuracy > CONFIG.GPS_MAX_ACCURACY_M) return true;
    if (params.lastAcceptedFixAgeMs === null || params.lastAcceptedFixAgeMs === undefined) return true;
    if (params.lastAcceptedFixAgeMs > CONFIG.GPS_MAX_FIX_AGE_MS) return true;
    if (params.onRoute && params.distanceToRoad !== null && params.distanceToRoad !== undefined &&
        params.distanceToRoad > CONFIG.ON_ROUTE_IMPLAUSIBLE_DISTANCE_M) return true;
    return false;
  }

  function isFixAccepted(accuracy) {
    return typeof accuracy === "number" && accuracy <= CONFIG.GPS_MAX_ACCURACY_M;
  }

  // ---------------------------------------------------------------------
  // APPROACH -> ON_ROUTE gating (section 10). A geofence hit alone is never
  // enough (section 10 / test G) - only sustained proximity to the actual
  // road geometry counts, and a single stray good fix can't flip the mode.
  // ---------------------------------------------------------------------

  // gapMs (optional): time since the previous call. A long gap between
  // "consecutive" accepted fixes (bad fixes in between, quietly skipped
  // rather than counted) shouldn't let three fixes scattered over minutes
  // pass as three genuinely consecutive ones.
  function onRouteStreakStep(prevStreak, distanceToRoad, gapMs) {
    var onRouteNow = typeof distanceToRoad === "number" && distanceToRoad < CONFIG.ON_ROUTE_DISTANCE_M;
    var recentEnough = typeof gapMs !== "number" || gapMs <= CONFIG.GPS_MAX_FIX_AGE_MS;
    return (onRouteNow && recentEnough) ? prevStreak + 1 : 0;
  }

  function isOnRouteReady(streak) {
    return streak >= CONFIG.ON_ROUTE_MIN_CONSECUTIVE_FIXES;
  }

  // ---------------------------------------------------------------------
  // Formatting helpers (section 15)
  // ---------------------------------------------------------------------

  function formatMeters(m) {
    var rounded = Math.max(0, Math.round(m));
    var s = String(rounded);
    var out = "";
    var count = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      out = s[i] + out;
      count++;
      if (count % 3 === 0 && i !== 0) out = " " + out;
    }
    return out;
  }

  global.Core = {
    CONFIG: CONFIG,
    translateSimpleKind: translateSimpleKind,
    resolveDisplayEvent: resolveDisplayEvent,
    getNextEvent: getNextEvent,
    EventCursor: EventCursor,
    computeDirection: computeDirection,
    projectPointToGeometry: projectPointToGeometry,
    distance2D: distance2D,
    isGpsUncertain: isGpsUncertain,
    isFixAccepted: isFixAccepted,
    onRouteStreakStep: onRouteStreakStep,
    isOnRouteReady: isOnRouteReady,
    formatMeters: formatMeters
  };
})(typeof window !== "undefined" ? window : this);
