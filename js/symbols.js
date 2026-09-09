/*
 * SVG code symbols per Trafikverket "Tecken och koder vid utsattning av
 * vagmarkering" (2015-02-24). Base marks reproduce the official Kod dash
 * patterns (Kort 0.5 m / Lang 1.5 m / Uppehall 0.5 m), drawn vertically so
 * the mark order top-to-bottom matches the physical order a painter driving
 * "forward" (up the screen) would encounter them on the pavement.
 *
 * Only 4 base marks + 2 compounds built from them - nothing else.
 */
(function (global) {
  "use strict";

  var VB_W = 240;
  var VB_H = 320;

  function rect(x, y, w, h) {
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="currentColor"/>';
  }

  function svgWrap(inner, viewBox) {
    return '<svg viewBox="' + viewBox + '" xmlns="http://www.w3.org/2000/svg" role="img">' + inner + "</svg>";
  }

  // Varningslinje code: single wide column, long mark + gap + short mark
  // (Borjar, reads as "!" - long over short), or short + gap + long (Slut,
  // reads as "!" upside down) - verified against the reference single-line
  // road diagram (mark order top-to-bottom = physical order of travel).
  function varningMark(begin) {
    var w = 90;
    var x = (VB_W - w) / 2;
    var short = 46;
    var long = 150;
    var gap = 40;
    var total = short + gap + long;
    var top = (VB_H - total) / 2;
    var inner;
    if (begin) {
      inner = rect(x, top, w, long) + rect(x, top + long + gap, w, short);
    } else {
      inner = rect(x, top, w, short) + rect(x, top + short + gap, w, long);
    }
    return svgWrap(inner, "0 0 " + VB_W + " " + VB_H);
  }

  // Tatort 3+3 code: two columns. Left column carries a single mark (at the
  // bottom for Borjar, at the top for Slut); right column always carries
  // three evenly spread marks the full height - verified against the
  // reference single-line road diagram.
  function tatortMark(begin) {
    var colW = 56;
    var gap = 40;
    var totalW = colW * 2 + gap;
    var leftX = (VB_W - totalW) / 2;
    var rightX = leftX + colW + gap;
    var markH = 46;
    var topMargin = 40;
    var spanH = VB_H - topMargin * 2;

    var singleX = leftX;
    var spreadX = rightX;
    var singleY = begin ? VB_H - topMargin - markH : topMargin;

    var inner = rect(singleX, singleY, colW, markH);
    var positions = [0, 0.5, 1];
    for (var i = 0; i < positions.length; i++) {
      var y = topMargin + positions[i] * (spanH - markH);
      inner += rect(spreadX, y, colW, markH);
    }
    return svgWrap(inner, "0 0 " + VB_W + " " + VB_H);
  }

  var BASE = {
    VARNING_BEGIN: function () { return varningMark(true); },
    VARNING_END: function () { return varningMark(false); },
    TATORT_BEGIN: function () { return tatortMark(true); },
    TATORT_END: function () { return tatortMark(false); }
  };

  var BASE_LABELS = {
    VARNING_BEGIN: "Varningslinje börjar",
    VARNING_END: "Varningslinje slutar",
    TATORT_BEGIN: "3+3 börjar",
    TATORT_END: "3+3 slutar"
  };

  // Compound: two base marks stacked with a step badge and a connecting
  // arrow so the physical execution order (which the painter must respect)
  // stays legible even though it renders as a single group (section 4).
  function compoundMark(kindA, kindB) {
    var miniVB = "0 0 " + VB_W + " " + VB_H;
    var cellH = 130;
    var arrowH = 30;
    var totalH = cellH * 2 + arrowH;
    var w = 220;

    function miniCell(kind, index, yOffset) {
      var svgInner = BASE[kind]().replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
      return (
        '<g transform="translate(0,' + yOffset + ')">' +
          '<svg x="0" y="0" width="' + w + '" height="' + cellH + '" viewBox="' + miniVB + '" preserveAspectRatio="xMidYMid meet">' + svgInner + "</svg>" +
          '<circle cx="20" cy="20" r="16" fill="currentColor"/>' +
          '<text x="20" y="26" text-anchor="middle" font-size="20" font-family="sans-serif" fill="var(--bg,#fff)">' + index + "</text>" +
        "</g>"
      );
    }

    // Same "up the screen = farther ahead" convention as the base marks:
    // kindA happens first and sits nearer (bottom, badge 1); kindB happens
    // second and sits farther along (top, badge 2). The arrow points up,
    // from what you paint first to what comes right after it.
    var inner =
      miniCell(kindB, 2, 0) +
      '<g transform="translate(' + (w / 2) + ',' + cellH + ')">' +
        '<path d="M -14 0 L 14 0 M 6 -9 L 14 0 L 6 9" stroke="currentColor" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="rotate(-90)"/>' +
      "</g>" +
      miniCell(kindA, 1, cellH + arrowH);

    return svgWrap(inner, "0 0 " + w + " " + totalH);
  }

  var SYMBOLS = {
    VARNING_BEGIN: BASE.VARNING_BEGIN,
    VARNING_END: BASE.VARNING_END,
    TATORT_BEGIN: BASE.TATORT_BEGIN,
    TATORT_END: BASE.TATORT_END,
    WARNING_TO_TATORT: function () { return compoundMark("VARNING_END", "TATORT_BEGIN"); },
    TATORT_TO_WARNING: function () { return compoundMark("TATORT_END", "VARNING_BEGIN"); }
  };

  var SYMBOL_LABELS = {
    VARNING_BEGIN: BASE_LABELS.VARNING_BEGIN,
    VARNING_END: BASE_LABELS.VARNING_END,
    TATORT_BEGIN: BASE_LABELS.TATORT_BEGIN,
    TATORT_END: BASE_LABELS.TATORT_END,
    WARNING_TO_TATORT: BASE_LABELS.VARNING_END + " → " + BASE_LABELS.TATORT_BEGIN,
    TATORT_TO_WARNING: BASE_LABELS.TATORT_END + " → " + BASE_LABELS.VARNING_BEGIN
  };

  function render(symbolId) {
    var fn = SYMBOLS[symbolId];
    if (!fn) return "";
    return fn();
  }

  function label(symbolId) {
    return SYMBOL_LABELS[symbolId] || symbolId;
  }

  global.Symbols = {
    render: render,
    label: label,
    ids: Object.keys(SYMBOLS)
  };
})(typeof window !== "undefined" ? window : this);
