/*
 * Section 17 automated tests (A-I). Runs in-browser against the real
 * built road392.json plus Core's pure functions - no server, no node.
 */
(function () {
  "use strict";

  var results = [];

  function assertEqual(name, actual, expected) {
    var pass = actual === expected;
    results.push({ name: name, pass: pass, actual: actual, expected: expected });
  }

  function assertTrue(name, actual) {
    results.push({ name: name, pass: actual === true, actual: actual, expected: true });
  }

  function findEvent(events, m) {
    return events.filter(function (e) { return e.m === m; })[0];
  }

  function run(road) {
    var events = road.events;

    // --- A. Kasvava suunta (UP) ---
    (function () {
      var cursor = new Core.EventCursor(events);
      var r1 = cursor.update(90000, "UP");
      assertEqual("A1 next.m", r1.event.m, 90125);
      assertEqual("A1 distance", r1.distance, 125);
      assertEqual("A1 symbol", Core.resolveDisplayEvent(r1.event, "UP").symbol, "WARNING_TO_TATORT");

      var cursor2 = new Core.EventCursor(events);
      var r2 = cursor2.update(90500, "UP");
      assertEqual("A2 next.m", r2.event.m, 90862);
      assertEqual("A2 distance", r2.distance, 362);
      assertEqual("A2 symbol", Core.resolveDisplayEvent(r2.event, "UP").symbol, "TATORT_TO_WARNING");
    })();

    // --- B. Laskeva suunta (DOWN) ---
    (function () {
      var cursor = new Core.EventCursor(events);
      var r1 = cursor.update(91000, "DOWN");
      assertEqual("B1 next.m", r1.event.m, 90862);
      assertEqual("B1 distance", r1.distance, 138);
      assertEqual("B1 symbol", Core.resolveDisplayEvent(r1.event, "DOWN").symbol, "WARNING_TO_TATORT");

      var cursor2 = new Core.EventCursor(events);
      var r2 = cursor2.update(90500, "DOWN");
      assertEqual("B2 next.m", r2.event.m, 90125);
      assertEqual("B2 distance", r2.distance, 375);
      assertEqual("B2 symbol", Core.resolveDisplayEvent(r2.event, "DOWN").symbol, "TATORT_TO_WARNING");
    })();

    // --- C. Tavallinen tapahtuma ---
    (function () {
      var ev = findEvent(events, 60940); // real Excel row: T=B -> VARNING_BEGIN
      assertEqual("C source type", ev.type, "VARNING_BEGIN");
      assertEqual("C UP", Core.resolveDisplayEvent(ev, "UP").symbol, "VARNING_BEGIN");
      assertEqual("C DOWN", Core.resolveDisplayEvent(ev, "DOWN").symbol, "VARNING_END");
    })();

    // --- D. Pysähtyminen: direction ei saa vaihtua ---
    (function () {
      var jitterHistory = [];
      for (var i = 0; i < 10; i++) { jitterHistory.push({ m: 70000 + (i % 2 === 0 ? 0 : 1), t: i * 1000 }); }
      assertEqual("D no premature lock from jitter", Core.computeDirection(jitterHistory, null), null);
      assertEqual("D locked direction stays UP despite jitter", Core.computeDirection(jitterHistory, "UP"), "UP");
      assertEqual("D locked direction stays DOWN despite jitter", Core.computeDirection(jitterHistory, "DOWN"), "DOWN");
    })();

    // --- E. GPS loss ---
    (function () {
      var uncertain = Core.isGpsUncertain({ accuracy: 5, lastAcceptedFixAgeMs: 4500, onRoute: false, distanceToRoad: null });
      assertTrue("E stale fix (>4s) => GPS EPÄVARMA", uncertain);
      var ok = Core.isGpsUncertain({ accuracy: 5, lastAcceptedFixAgeMs: 1000, onRoute: false, distanceToRoad: null });
      assertEqual("E fresh fix => not uncertain", ok, false);
    })();

    // --- F. APPROACH suuresta päästä ---
    (function () {
      var endPoint = road.approachPoints.filter(function (p) { return p.id === "end"; })[0];
      // The stored data point is still the raw excel-native event (VARNING_END,
      // recorded going UP) - app.js now runs it through resolveDisplayEvent()
      // with expectedDirection before showing it, the same call ON_ROUTE
      // makes, so what actually reaches the screen is the DOWN-translated
      // symbol: VARNING_BEGIN, matching the object's other end (both ends
      // begin with a warning line from their own approach direction).
      assertEqual("F end approach point's raw stored event is VARNING_END", endPoint.event, "VARNING_END");
      assertEqual("F end approach point's expectedDirection is DOWN", endPoint.expectedDirection, "DOWN");
      var displayed = Core.resolveDisplayEvent({ type: endPoint.event }, endPoint.expectedDirection).symbol;
      assertEqual("F what the screen actually shows is the translated VARNING_BEGIN, not raw VARNING_END", displayed, "VARNING_BEGIN");

      var startPoint = road.approachPoints.filter(function (p) { return p.id === "start"; })[0];
      var displayedStart = Core.resolveDisplayEvent({ type: startPoint.event }, startPoint.expectedDirection).symbol;
      assertEqual("F both approach ends show the same translated symbol (VARNING_BEGIN)", displayedStart, displayed);

      var a = { e: 0, n: 0 };
      var b = { e: 0, n: 800 };
      assertEqual("F approachDistance is straight GPS distance", Core.distance2D(a, b), 800);
      assertEqual("F formatMeters(800)", Core.formatMeters(800), "800");
    })();

    // --- G. APPROACH ei saa lukita reitille pelkän geofencen perusteella ---
    (function () {
      // 150 m from an approach point, but 200 m from road geometry.
      var streak = 0;
      streak = Core.onRouteStreakStep(streak, 200);
      assertEqual("G distanceToRoad=200 keeps streak at 0", streak, 0);
      assertEqual("G not ON_ROUTE-ready", Core.isOnRouteReady(streak), false);
    })();

    // --- H. APPROACH -> ON_ROUTE ---
    (function () {
      var streak = 0;
      streak = Core.onRouteStreakStep(streak, 12);
      streak = Core.onRouteStreakStep(streak, 8);
      streak = Core.onRouteStreakStep(streak, 15);
      assertEqual("H 3 consecutive fixes <30m => streak 3", streak, 3);
      assertTrue("H isOnRouteReady after 3 fixes", Core.isOnRouteReady(streak));
    })();

    // --- I. Laskevan suunnan vahvistus (expectedDirection is not enough) ---
    (function () {
      var tooShort = [
        { m: 106000, t: 0 },
        { m: 105980, t: 1000 }
      ];
      assertEqual("I insufficient fixes: no lock even though trend is DOWN", Core.computeDirection(tooShort, null), null);

      // Distance decides, not elapsed time: plenty of time but too little net
      // movement (small oscillation, well under the 25 m threshold) still
      // does not lock, no matter how long it's been sampled.
      var lotsOfTimeLittleMovement = [];
      for (var k = 0; k <= 30; k++) { lotsOfTimeLittleMovement.push({ m: 106000 + (k % 2 === 0 ? 0 : 3), t: k * 1000 }); }
      assertEqual("I plenty of elapsed time but insufficient net movement: still no lock", Core.computeDirection(lotsOfTimeLittleMovement, null), null);

      var confirmedDown = [];
      for (var i = 0; i <= 9; i++) { confirmedDown.push({ m: 106000 - 8 * i, t: i * 1000 }); }
      assertEqual("I confirmed DOWN once net movement clears the 25 m threshold", Core.computeDirection(confirmedDown, null), "DOWN");
    })();

    // --- J. Iso hyppy: yksi fixi ohittaa useamman tapahtuman kerralla ---
    // (esim. GPS-katkon jälkeinen fixi, tai harva 1 Hz -näyte kovalla nopeudella)
    (function () {
      var cursor = new Core.EventCursor(events);
      cursor.update(60940, "UP"); // arm the cursor at the very first event
      var r = cursor.update(70000, "UP"); // jump straight past 62154..69739 (six events)
      assertEqual("J cursor catches up after a multi-event jump", r.event.m, 70468);
      assertEqual("J distance is correct (not stale/negative)", r.distance, 468);
    })();

    // --- K. getNextEvent ilman EventCursoria (section 7:n tila-riippumaton määritelmä) ---
    (function () {
      var upNoBoundary = Core.getNextEvent(events, 70100, "UP", null);
      assertEqual("K UP without a cursor finds the event ahead, not the first in the list", upNoBoundary.event.m, 70468);
      assertEqual("K UP without a cursor: correct positive distance", upNoBoundary.distance, 368);

      var downNoBoundary = Core.getNextEvent(events, 70100, "DOWN", undefined);
      assertEqual("K DOWN without a cursor finds the event behind", downNoBoundary.event.m, 69739);
      assertEqual("K DOWN without a cursor: correct positive distance", downNoBoundary.distance, 361);
    })();

    // --- L. Yksi rajatapaus-heilahdus (marginaalinen ylitys) ei saa ohittaa koodia pysyvästi ---
    (function () {
      var smallEvents = [
        { m: 100, n: 0, e: 0, type: "VARNING_BEGIN" },
        { m: 200, n: 0, e: 0, type: "VARNING_BEGIN" }
      ];
      var cursor = new Core.EventCursor(smallEvents);
      var r1 = cursor.update(80, "UP");
      assertEqual("L arm at m=80, next is 100", r1.event.m, 100);
      var r2 = cursor.update(104, "UP"); // 4 m over hysteresis, well within 25 m accuracy budget
      assertEqual("L a single marginal fix does not yet advance the cursor", r2.event.m, 100);
      var r3 = cursor.update(82, "UP"); // wobbles back below the hysteresis line
      assertEqual("L wobbling back still shows event 100 - not permanently skipped", r3.event.m, 100);
    })();

    // --- M. Kaksi peräkkäistä vahvistavaa fixiä VAHVISTAA marginaalisen ylityksen ---
    (function () {
      var smallEvents = [
        { m: 100, n: 0, e: 0, type: "VARNING_BEGIN" },
        { m: 200, n: 0, e: 0, type: "VARNING_BEGIN" }
      ];
      var cursor = new Core.EventCursor(smallEvents);
      cursor.update(80, "UP");
      cursor.update(104, "UP"); // pending 1/2
      var r = cursor.update(105, "UP"); // pending 2/2 -> confirmed
      assertEqual("M two consecutive marginal fixes confirm the crossing", r.event.m, 200);
      assertEqual("M distance is correct after the confirmed crossing", r.distance, 95);
    })();

    // --- N. Aloitus täsmälleen ensimmäisen/viimeisen tapahtuman paalulla ei saa hypätä sen yli ---
    (function () {
      var startAp = road.approachPoints.filter(function (p) { return p.id === "start"; })[0];
      var endAp = road.approachPoints.filter(function (p) { return p.id === "end"; })[0];

      var cursorUp = new Core.EventCursor(events);
      var rUp = cursorUp.update(startAp.m, "UP");
      assertEqual("N UP: starting exactly on the first event still shows it", rUp.event.m, startAp.m);

      var cursorDown = new Core.EventCursor(events);
      var rDown = cursorDown.update(endAp.m, "DOWN");
      assertEqual("N DOWN: starting exactly on the last event still shows it", rDown.event.m, endAp.m);
    })();

    // --- O. Suunta lukittuu myös realistisella hitaalla maalausnopeudella (6 km/h),
    // riippumatta GPS:n näytteenottotaajuudesta (matka ratkaisee, ei näytteenottotahti) ---
    (function () {
      var speedMps = 6 / 3.6;
      function slowHistory(count, stepMs) {
        var h = [];
        var m = 70000;
        var t = 0;
        for (var i = 0; i < count; i++) {
          h.push({ m: m, t: t });
          m += speedMps * (stepMs / 1000);
          t += stepMs;
        }
        return h;
      }

      var early = Core.computeDirection(slowHistory(10, 1000), null); // ~7.5 m net - under threshold
      assertEqual("O insufficient net movement at 6 km/h still does not lock", early, null);

      var oneHz = Core.computeDirection(slowHistory(41, 1000), null); // 40 s @ 1 Hz, ~25 m+ net
      assertEqual("O 1 Hz: locks UP once slow-speed movement accumulates enough distance", oneHz, "UP");

      var fiveHz = Core.computeDirection(slowHistory(201, 200), null); // same 40 s @ 5 Hz
      assertEqual("O 5 Hz: same distance over the same time locks UP too - sample rate doesn't matter", fiveHz, "UP");
    })();

    // --- Q. Yksittäinen vastasuuntainen poikkeama ei saa estää lukitusta (mediaani vaimentaa sen) ---
    (function () {
      var speedMps = 6 / 3.6;
      var history = [];
      var m = 70000;
      for (var i = 0; i <= 40; i++) {
        history.push({ m: m, t: i * 1000 });
        m += speedMps;
      }
      history[20].m -= 4; // one lone 4 m backward wobble in the middle of an otherwise clean climb
      assertEqual("Q a single outlier fix does not block the lock", Core.computeDirection(history, null), "UP");
    })();

    // --- R. Lukittu suunta ei käänny muutamasta vastakkaisesta fixistä, mutta kääntyy
    // pitkäkestoisen, selvän vastakkaisen trendin jälkeen (40 m käännöskynnys) ---
    (function () {
      var mostlyUp = [];
      for (var i = 0; i < 15; i++) { mostlyUp.push({ m: 70000 + 2 * i, t: i * 1000 }); }
      var lastM = mostlyUp[mostlyUp.length - 1].m;
      mostlyUp.push({ m: lastM - 20, t: 15000 });
      mostlyUp.push({ m: lastM - 40, t: 16000 });
      mostlyUp.push({ m: lastM - 60, t: 17000 });
      assertEqual("R locked UP survives 3 strong DOWN fixes among a mostly-UP window", Core.computeDirection(mostlyUp, "UP"), "UP");

      var sustainedDown = [];
      for (var j = 0; j <= 20; j++) { sustainedDown.push({ m: 90000 - 6 * j, t: j * 1000 }); }
      assertEqual("R locked UP flips to DOWN after a long, clearly sustained reversal (>40 m)", Core.computeDirection(sustainedDown, "UP"), "DOWN");
    })();

    // --- S. EventCursorin ENSIMMÄINEN update()-kutsu käyttää samaa hystereesiä kuin myöhemmät ---
    (function () {
      var smallEvents = [
        { m: 100, n: 0, e: 0, type: "VARNING_BEGIN" },
        { m: 200, n: 0, e: 0, type: "VARNING_BEGIN" }
      ];
      function firstCallResult(startM, direction) {
        return new Core.EventCursor(smallEvents).update(startM, direction);
      }
      assertEqual("S UP first call at 100.1 (just past) still shows 100, not 200", firstCallResult(100.1, "UP").event.m, 100);
      assertEqual("S UP first call at 104 (marginal +4) still shows 100", firstCallResult(104, "UP").event.m, 100);
      assertEqual("S UP first call at 115 (marginal +15) still shows 100", firstCallResult(115, "UP").event.m, 100);
      assertEqual("S UP first call at 145 (unambiguous +45) advances to 200", firstCallResult(145, "UP").event.m, 200);

      assertEqual("S DOWN first call at 199.9 (just past) still shows 200", firstCallResult(199.9, "DOWN").event.m, 200);
      assertEqual("S DOWN first call at 196 (marginal -4) still shows 200", firstCallResult(196, "DOWN").event.m, 200);
      assertEqual("S DOWN first call at 155 (unambiguous -45) advances to 100", firstCallResult(155, "DOWN").event.m, 100);
    })();

    // --- P. onRouteStreak nollautuu pitkän katkon jälkeen vaikka etäisyys olisi kunnossa ---
    (function () {
      var streak = 0;
      streak = Core.onRouteStreakStep(streak, 10, null);
      streak = Core.onRouteStreakStep(streak, 10, 1000);
      assertEqual("P streak builds normally across recent fixes", streak, 2);
      streak = Core.onRouteStreakStep(streak, 10, 10000);
      assertEqual("P streak resets after a long gap even though distance is fine", streak, 0);
    })();

    renderResults();
  }

  function renderResults() {
    var passCount = results.filter(function (r) { return r.pass; }).length;
    var out = document.getElementById("results");
    var summary = document.createElement("div");
    summary.className = "summary " + (passCount === results.length ? "all-pass" : "has-fail");
    summary.textContent = passCount + " / " + results.length + " OK";
    out.appendChild(summary);

    results.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "row " + (r.pass ? "pass" : "fail");
      row.textContent = (r.pass ? "OK   " : "FAIL ") + r.name +
        (r.pass ? "" : "  (got " + JSON.stringify(r.actual) + ", expected " + JSON.stringify(r.expected) + ")");
      out.appendChild(row);
    });

    document.title = (passCount === results.length ? "PASS " : "FAIL ") + passCount + "/" + results.length + " - BD392 tests";
  }

  fetch("data/road392.json")
    .then(function (r) { return r.json(); })
    .then(run)
    .catch(function (err) {
      var out = document.getElementById("results");
      out.textContent = "Datan lataus epäonnistui: " + err;
    });
})();
