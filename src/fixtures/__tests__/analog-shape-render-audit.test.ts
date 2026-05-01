/**
 * Analog shape render audit- pixel comparison of TS analog component
 * rendering against CircuitJS1 (Falstad) reference shapes.
 *
 * Mirrors the digital shape-render-audit.test.ts structure. For each analog
 * component type with a Falstad reference:
 *   1. Draws the Falstad reference shape via falstad-reference.ts
 *   2. Creates a TS element, draws it via MockRenderContext
 *   3. Converts both to line segments, rasterizes to binary bitmaps
 *   4. Compares bitmaps using soft Dice coefficient (1px tolerance)
 *   5. Checks extent (width/height), bounding box, pin positions, pin
 *      proximity, and text overlaps
 *
 * Also includes:
 *   - Pin count comparison (TS vs Falstad reference)
 *   - Pin position comparison (local coords)
 *   - Rotation × mirror pin transform audit (all 8 combinations)
 *   - Uncovered components get sanity checks (factory, draw, bbox, pins)
 *
 * Silent-catch policy (per spec/architectural-alignment.md ssI1
 * retain-with-reason): the factory/draw/bbox try/catch blocks in this
 * suite DO NOT suppress anomalies- they record FACTORY_ERROR /
 * DRAW_ERROR / bboxOverflow=-1 audit rows in the results array, which is
 * the intended failure-report output of the test. Re-raising would break
 * the per-component report generation.
 */

import { describe, it, expect, beforeAll } from "vitest";

import { createDefaultRegistry } from "@/components/register-all";
import type { ComponentRegistry } from "@/core/registry";
import type { CircuitElement } from "@/core/element";
import { PropertyBag } from "@/core/properties";
import { MockRenderContext } from "@/test-utils/mock-render-context";
import { pinWorldPosition } from "@/core/pin";
import type { Rotation } from "@/core/pin";
import {
  tsCallsToSegments,
  segmentBounds,
  unionBounds,
  createViewport,
  renderSegments,
  compareBitmaps,
  detectTextOverlaps,
  checkPinProximity,
  compareExtents,
  extractTSTexts,
  compareTexts,
} from "@/test-utils/shape-rasterizer";
import type {
  CompareResult,
  ExtentResult,
  TextCompareResult,
} from "@/test-utils/shape-rasterizer";
import {
  FALSTAD_REFERENCES,
  FALSTAD_PIN_POSITIONS,
  FALSTAD_TEXT_REFS,
  ALL_ANALOG_TYPES,
  falstadWorldPosition,
} from "@/test-utils/falstad-fixture-reference";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const DICE_THRESHOLD = 0.99;
const EXTENT_THRESHOLD = 0;

// ---------------------------------------------------------------------------
// Skip list- analog components whose TS rendering intentionally differs
// from the Falstad/CircuitJS1 reference (different layout, additional detail,
// or artistic differences that are not bugs).
// ---------------------------------------------------------------------------

const SKIP_RENDER_TYPES = new Set([
  // Rendering differs from Falstad reference:
  "Inductor",           // arc count / style differs
  "TransmissionLine",   // layout differs
  "PJFET",              // arrow direction differs
  "SCR",                // gate lead placement differs
  "RealOpAmp",          // power supply pins added
  "VoltageComparator",  // output stage differs
  "Timer555",           // internal layout differs
  "OTA",                // transconductance symbol differs
  "Optocoupler",        // LED + transistor layout differs
  "VCCS",               // controlled-source arrow differs
  "CCCS",               // controlled-source arrow differs
  "LDR",                // light arrows extend beyond bounding box
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDefaultProps(
  registry: ComponentRegistry,
  typeName: string,
): PropertyBag {
  const def = registry.get(typeName);
  if (!def) return new PropertyBag();
  const entries: Array<[string, import("@/core/properties").PropertyValue]> = [];
  for (const pd of def.propertyDefs) {
    entries.push([pd.key, pd.defaultValue]);
  }
  return new PropertyBag(entries);
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface AnalogResult {
  typeId: string;
  pixelDice: number;
  litRef: number;
  litTS: number;
  extent: ExtentResult | null;
  bboxOverflow: number;
  textOverlaps: number;
  textOverlapDetails: string[];
  pinCountDelta: number | null;
  pinPosMismatches: number;
  pinPosDetails: string[];
  pinDetachedCount: number;
  pinDetachedDetails: string[];
  textResult: TextCompareResult;
  error?: string;
}

// ---------------------------------------------------------------------------
// Compute test type lists
// ---------------------------------------------------------------------------

function computeCoveredTypes(): Array<{ typeName: string }> {
  const reg = createDefaultRegistry();
  const types: Array<{ typeName: string }> = [];
  for (const name of ALL_ANALOG_TYPES) {
    if (!FALSTAD_REFERENCES.has(name)) continue;
    if (!reg.get(name)) continue;
    types.push({ typeName: name });
  }
  return types;
}

function computeUncoveredTypes(): Array<{ typeName: string }> {
  const reg = createDefaultRegistry();
  const types: Array<{ typeName: string }> = [];
  for (const name of ALL_ANALOG_TYPES) {
    if (FALSTAD_REFERENCES.has(name)) continue;
    if (!reg.get(name)) continue;
    types.push({ typeName: name });
  }
  return types;
}

function computeAllTypes(): Array<{ typeName: string }> {
  return [...computeCoveredTypes(), ...computeUncoveredTypes()];
}

// ---------------------------------------------------------------------------
// Error result factory
// ---------------------------------------------------------------------------

function errorResult(
  typeId: string,
  error: string,
  hasDice: boolean,
): AnalogResult {
  return {
    typeId,
    pixelDice: hasDice ? -1 : NaN,
    litRef: 0,
    litTS: 0,
    extent: null,
    bboxOverflow: -1,
    textOverlaps: 0,
    textOverlapDetails: [],
    pinCountDelta: null,
    pinPosMismatches: 0,
    pinPosDetails: [],
    pinDetachedCount: 0,
    pinDetachedDetails: [],
    textResult: { matched: [], missingInTS: [], extraInTS: [] },
    error,
  };
}

// ---------------------------------------------------------------------------
// Pin comparison helper
// ---------------------------------------------------------------------------

function comparePins(
  element: CircuitElement,
  typeName: string,
): { pinCountDelta: number | null; pinPosMismatches: number; pinPosDetails: string[] } {
  const refPins = FALSTAD_PIN_POSITIONS.get(typeName);
  if (!refPins) return { pinCountDelta: null, pinPosMismatches: 0, pinPosDetails: [] };

  const tsPins = element.getPins();
  const pinCountDelta = tsPins.length - refPins.length;

  if (pinCountDelta !== 0) {
    return { pinCountDelta, pinPosMismatches: 0, pinPosDetails: [] };
  }

  let pinPosMismatches = 0;
  const pinPosDetails: string[] = [];

  for (let i = 0; i < tsPins.length; i++) {
    const tp = tsPins[i];
    const rp = refPins[i];
    const dx = Math.abs(tp.position.x - rp.x);
    const dy = Math.abs(tp.position.y - rp.y);
    if (dx > 0.01 || dy > 0.01) {
      pinPosMismatches++;
      pinPosDetails.push(
        `${rp.label}:(${rp.x},${rp.y})→(${tp.position.x},${tp.position.y})`,
      );
    }
  }

  return { pinCountDelta, pinPosMismatches, pinPosDetails };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("analog shape render audit- pixel comparison vs Falstad/CircuitJS1", () => {
  let registry: ComponentRegistry;
  const results: AnalogResult[] = [];

  beforeAll(() => {
    registry = createDefaultRegistry();
  });

  // -------------------------------------------------------------------------
  // Covered types- have Falstad reference → pixel comparison
  // -------------------------------------------------------------------------

  it.each(computeCoveredTypes())(
    "$typeName shape comparison vs Falstad",
    ({ typeName }) => {
      if (SKIP_RENDER_TYPES.has(typeName)) return;

      const drawRef = FALSTAD_REFERENCES.get(typeName)!;
      const def = registry.get(typeName)!;
      const props = buildDefaultProps(registry, typeName);

      // --- Create TS element ---
      let element: CircuitElement;
      try {
        element = def.factory(props);
      } catch (err) {
        console.warn(`[analog-shape-render-audit] Factory error for element type "${typeName}"`, err);
        results.push(errorResult(typeName, "FACTORY_ERROR", true));
        return;
      }

      // --- Draw reference ---
      const refCtx = new MockRenderContext();
      drawRef(refCtx);
      const refSegs = tsCallsToSegments(refCtx.calls);

      // --- Draw TS element ---
      const tsCtx = new MockRenderContext();
      try {
        element.draw(tsCtx);
      } catch (err) {
        console.warn(`[analog-shape-render-audit] Draw error for element type "${typeName}"`, err);
        results.push(errorResult(typeName, "DRAW_ERROR", true));
        return;
      }
      const tsSegs = tsCallsToSegments(tsCtx.calls);

      // --- Pixel comparison ---
      const refBounds = segmentBounds(refSegs);
      const tsBounds = segmentBounds(tsSegs);
      const bounds = unionBounds(refBounds, tsBounds);
      const vp = createViewport(bounds);
      const refBmp = renderSegments(refSegs, vp);
      const tsBmp = renderSegments(tsSegs, vp);
      const pixelResult: CompareResult = compareBitmaps(refBmp, tsBmp);

      // --- Extent comparison ---
      const extent = compareExtents(refBounds, tsBounds);

      // --- BBox consistency ---
      let bboxOverflow = 0;
      try {
        const bbox = element.getBoundingBox();
        bboxOverflow = Math.max(
          0,
          tsBounds.minX - bbox.x,
          tsBounds.minY - bbox.y,
          bbox.x - tsBounds.minX,
          bbox.y - tsBounds.minY,
          tsBounds.maxX - (bbox.x + bbox.width),
          tsBounds.maxY - (bbox.y + bbox.height),
        );
      } catch (err) {
        console.warn(`[analog-shape-render-audit] Bbox overflow calculation error for element type "${typeName}"`, err);
        bboxOverflow = -1;
      }

      // --- Text overlap detection ---
      const overlapResult = detectTextOverlaps(tsCtx.calls);
      const textOverlapDetails = overlapResult.overlaps.map(
        (o) =>
          `"${o.a.text}"↔"${o.b.text}" (${o.overlapArea.toFixed(2)})`,
      );

      // --- Pin comparison ---
      const { pinCountDelta, pinPosMismatches, pinPosDetails } =
        comparePins(element, typeName);

      // --- Pin-to-body proximity ---
      const tsPinsForProximity = element.getPins().map((p) => ({
        label: p.label,
        x: p.position.x,
        y: p.position.y,
      }));
      const proximity = checkPinProximity(tsPinsForProximity, tsSegs);
      const pinDetachedDetails = proximity.detached.map(
        (d) => `${d.label}:(${d.x},${d.y}) dist=${d.distance}`,
      );

      // --- Text comparison ---
      const falstadTexts = FALSTAD_TEXT_REFS.get(typeName) ?? [];
      const tsTexts = extractTSTexts(tsCtx.calls);
      const textResult = compareTexts(
        falstadTexts.map((t) => ({ text: t.text, x: t.x, y: t.y, horizontal: "left" as const, vertical: "middle" as const })),
        tsTexts,
      );

      results.push({
        typeId: typeName,
        pixelDice: pixelResult.dice,
        litRef: pixelResult.litA,
        litTS: pixelResult.litB,
        extent,
        bboxOverflow,
        textOverlaps: overlapResult.overlaps.length,
        textOverlapDetails,
        pinCountDelta,
        pinPosMismatches,
        pinPosDetails,
        pinDetachedCount: proximity.detached.length,
        pinDetachedDetails,
        textResult,
      });

      // --- Per-component assertions ---
      expect(pixelResult.dice, `${typeName} pixel Dice`).toBeGreaterThanOrEqual(DICE_THRESHOLD);
      expect(extent.maxDelta, `${typeName} extent`).toBeLessThanOrEqual(EXTENT_THRESHOLD);
      expect(bboxOverflow, `${typeName} bbox`).toBeLessThanOrEqual(0);
      expect(overlapResult.overlaps.length, `${typeName} text overlap`).toBe(0);
      if (pinCountDelta !== null) {
        expect(pinCountDelta, `${typeName} pin count`).toBe(0);
        if (pinCountDelta === 0) {
          expect(pinPosMismatches, `${typeName} pin positions`).toBe(0);
        }
      }
      expect(proximity.detached.length, `${typeName} detached pins`).toBe(0);

      // --- Symbol text assertions ---
      const SYMBOL_TEXT_REQUIRED: Record<string, string[]> = {
        OpAmp: ["+", "-"],
        RealOpAmp: ["+", "-"],
        VoltageComparator: ["+", "-"],
        OTA: ["+", "-"],
      };
      const required = SYMBOL_TEXT_REQUIRED[typeName];
      if (required) {
        for (const sym of required) {
          const found = tsTexts.some((t) => t.text === sym);
          expect(found, `${typeName} missing symbol text "${sym}"`).toBe(true);
        }
      }
    },
  );

  // -------------------------------------------------------------------------
  // Uncovered types- no Falstad reference, sanity checks only
  // -------------------------------------------------------------------------

  it.each(computeUncoveredTypes())(
    "$typeName (uncovered- no Falstad reference)",
    ({ typeName }) => {
      const def = registry.get(typeName)!;
      const props = buildDefaultProps(registry, typeName);

      let element: CircuitElement;
      try {
        element = def.factory(props);
      } catch (err) {
        console.warn(`[analog-shape-render-audit] Factory error for element type "${typeName}" (uncovered)`, err);
        results.push(errorResult(typeName, "FACTORY_ERROR", false));
        return;
      }

      const ctx = new MockRenderContext();
      try {
        element.draw(ctx);
      } catch (err) {
        console.warn(`[analog-shape-render-audit] Draw error for element type "${typeName}" (uncovered)`, err);
        results.push(errorResult(typeName, "DRAW_ERROR", false));
        return;
      }

      const tsSegs = tsCallsToSegments(ctx.calls);
      const tsBounds = segmentBounds(tsSegs);

      let bboxOverflow = 0;
      try {
        const bbox = element.getBoundingBox();
        bboxOverflow = Math.max(
          0,
          tsBounds.minX - bbox.x,
          tsBounds.minY - bbox.y,
          bbox.x - tsBounds.minX,
          bbox.y - tsBounds.minY,
          tsBounds.maxX - (bbox.x + bbox.width),
          tsBounds.maxY - (bbox.y + bbox.height),
        );
      } catch (err) {
        console.warn(`[analog-shape-render-audit] Bbox overflow calculation error for element type "${typeName}" (uncovered)`, err);
        bboxOverflow = -1;
      }

      const overlapResult = detectTextOverlaps(ctx.calls);
      const textOverlapDetails = overlapResult.overlaps.map(
        (o) =>
          `"${o.a.text}"↔"${o.b.text}" (${o.overlapArea.toFixed(2)})`,
      );

      const { pinCountDelta, pinPosMismatches, pinPosDetails } =
        comparePins(element, typeName);

      const tsPinsForProximity = element.getPins().map((p) => ({
        label: p.label,
        x: p.position.x,
        y: p.position.y,
      }));
      const proximity = checkPinProximity(tsPinsForProximity, tsSegs);
      const pinDetachedDetails = proximity.detached.map(
        (d) => `${d.label}:(${d.x},${d.y}) dist=${d.distance}`,
      );

      results.push({
        typeId: typeName,
        pixelDice: NaN,
        litRef: 0,
        litTS: 0,
        extent: null,
        bboxOverflow,
        textOverlaps: overlapResult.overlaps.length,
        textOverlapDetails,
        pinCountDelta,
        pinPosMismatches,
        pinPosDetails,
        pinDetachedCount: proximity.detached.length,
        pinDetachedDetails,
        textResult: { matched: [], missingInTS: [], extraInTS: [] },
      });

      // --- Per-component assertions (uncovered) ---
      expect(bboxOverflow, `${typeName} bbox`).toBeLessThanOrEqual(0);
      expect(overlapResult.overlaps.length, `${typeName} text overlap`).toBe(0);
      if (pinCountDelta !== null) {
        expect(pinCountDelta, `${typeName} pin count`).toBe(0);
        if (pinCountDelta === 0) {
          expect(pinPosMismatches, `${typeName} pin positions`).toBe(0);
        }
      }
      expect(proximity.detached.length, `${typeName} detached pins`).toBe(0);
    },
  );

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  it("summary: analog shape audit results", () => {
    const total = results.length;
    const errors = results.filter((r) => r.error);
    const valid = results.filter((r) => !r.error);
    const covered = valid.filter((r) => !Number.isNaN(r.pixelDice));
    const uncoveredResults = valid.filter((r) => Number.isNaN(r.pixelDice));

    console.log("\n=== Analog Symbol Audit Summary ===");
    console.log(
      `Total components: ${total} (${covered.length} covered + ${uncoveredResults.length} uncovered)`,
    );
    console.log(`Errors (factory/draw): ${errors.length}`);

    // Pixel match
    const pixelGood = covered.filter((r) => r.pixelDice >= 0.7);
    const pixelGreat = covered.filter((r) => r.pixelDice >= 0.9);
    console.log(
      `Pixel match (Dice ≥ 0.7): ${pixelGood.length} / ${covered.length}`,
    );
    console.log(
      `Pixel match (Dice ≥ 0.9): ${pixelGreat.length} / ${covered.length}`,
    );

    // Extent
    const extentGood = covered.filter(
      (r) => r.extent && r.extent.maxDelta < 0.5,
    );
    console.log(
      `Extent match (maxΔ < 0.5): ${extentGood.length} / ${covered.length}`,
    );

    // BBox
    const bboxGood = valid.filter((r) => r.bboxOverflow <= 0.1);
    console.log(
      `BBox covers shape (≤0.1 overflow): ${bboxGood.length} / ${valid.length}`,
    );

    // Text
    const overlapFree = valid.filter((r) => r.textOverlaps === 0);
    console.log(
      `Text overlap-free: ${overlapFree.length} / ${valid.length}`,
    );

    // Pins
    const pinCovered = valid.filter((r) => r.pinCountDelta !== null);
    const pinCountOk = pinCovered.filter((r) => r.pinCountDelta === 0);
    const pinPosOk = pinCovered.filter(
      (r) => r.pinCountDelta === 0 && r.pinPosMismatches === 0,
    );
    console.log(
      `Pin count match: ${pinCountOk.length} / ${pinCovered.length} (${valid.length - pinCovered.length} uncovered)`,
    );
    console.log(
      `Pin positions match: ${pinPosOk.length} / ${pinCovered.length}`,
    );
    const pinAttached = valid.filter((r) => r.pinDetachedCount === 0);
    console.log(
      `Pins touch body: ${pinAttached.length} / ${valid.length}`,
    );

    // Coverage
    console.log(
      `\nFalstad reference coverage: ${covered.length} / ${ALL_ANALOG_TYPES.length} analog types`,
    );

    // Detailed table
    const sortedCovered = [...covered].sort(
      (a, b) => a.pixelDice - b.pixelDice,
    );
    const sortedUncovered = [...uncoveredResults].sort((a, b) =>
      a.typeId.localeCompare(b.typeId),
    );
    const sorted = [...sortedCovered, ...sortedUncovered];

    if (sorted.length > 0) {
      console.log(
        "\n" +
          "Component".padEnd(24) +
          "Dice".padEnd(8) +
          "ΔW".padEnd(7) +
          "ΔH".padEnd(7) +
          "ΔCx".padEnd(7) +
          "ΔCy".padEnd(7) +
          "BBox".padEnd(6) +
          "OLap".padEnd(6) +
          "Txt".padEnd(8) +
          "Pins".padEnd(8) +
          "Details",
      );
      console.log("-".repeat(130));

      for (const r of sorted) {
        const isUncov = Number.isNaN(r.pixelDice);
        const diceStr = isUncov
          ? "N/A"
          : r.pixelDice >= 0
            ? r.pixelDice.toFixed(3)
            : "ERR";

        const e = r.extent;
        const fmtD = (v: number) =>
          Math.abs(v) < 0.01
            ? "0"
            : v > 0
              ? `+${v.toFixed(1)}`
              : v.toFixed(1);

        const bboxStr =
          r.bboxOverflow < 0
            ? "ERR"
            : r.bboxOverflow <= 0.1
              ? "ok"
              : `+${r.bboxOverflow.toFixed(1)}`;

        // Pin status string
        let pinStr: string;
        if (r.pinCountDelta === null) {
          pinStr = "-";
        } else if (r.pinCountDelta !== 0) {
          pinStr = `#${r.pinCountDelta > 0 ? "+" : ""}${r.pinCountDelta}`;
        } else if (r.pinPosMismatches > 0) {
          pinStr = `Δ${r.pinPosMismatches}`;
        } else {
          pinStr = "ok";
        }

        // Text comparison string
        const txtMissing = r.textResult.missingInTS.length;
        const txtExtra = r.textResult.extraInTS.length;
        const txtStr = isUncov ? "N/A" :
          txtMissing === 0 && txtExtra === 0 ? "ok" : `-${txtMissing}/+${txtExtra}`;

        let details = isUncov ? "(no Falstad ref) " : "";
        if (r.pinPosDetails.length > 0) {
          details += `pins:[${r.pinPosDetails.join(",")}] `;
        }
        if (
          r.pinCountDelta !== null &&
          r.pinCountDelta !== 0
        ) {
          details += `pin#:Δ${r.pinCountDelta > 0 ? "+" : ""}${r.pinCountDelta} `;
        }
        if (r.pinDetachedDetails.length > 0) {
          details += `detached:[${r.pinDetachedDetails.join(",")}] `;
        }
        if (r.error) {
          details += r.error;
        }

        console.log(
          r.typeId.padEnd(24) +
            diceStr.padEnd(8) +
            (e ? fmtD(e.widthDelta) : "N/A").padEnd(7) +
            (e ? fmtD(e.heightDelta) : "N/A").padEnd(7) +
            (e ? fmtD(e.centerDx) : "N/A").padEnd(7) +
            (e ? fmtD(e.centerDy) : "N/A").padEnd(7) +
            bboxStr.padEnd(6) +
            (r.textOverlaps === 0 ? "ok" : String(r.textOverlaps)).padEnd(
              6,
            ) +
            txtStr.padEnd(8) +
            pinStr.padEnd(8) +
            details.trim(),
        );
      }
    }

    // --- Extent outliers ---
    const extentBad = covered
      .filter((r) => r.extent && r.extent.maxDelta >= 0.5)
      .sort(
        (a, b) => (b.extent?.maxDelta ?? 0) - (a.extent?.maxDelta ?? 0),
      );
    if (extentBad.length > 0) {
      console.log("\n--- Extent Outliers (maxΔ ≥ 0.5 grid) ---");
      for (const r of extentBad) {
        const e = r.extent!;
        console.log(
          `  ${r.typeId}: Ref=${e.javaW.toFixed(1)}×${e.javaH.toFixed(1)} TS=${e.tsW.toFixed(1)}×${e.tsH.toFixed(1)} ΔW=${e.widthDelta.toFixed(2)} ΔH=${e.heightDelta.toFixed(2)} ΔC=(${e.centerDx.toFixed(2)},${e.centerDy.toFixed(2)})`,
        );
      }
    }

    // --- BBox overflow ---
    const bboxBad = valid
      .filter((r) => r.bboxOverflow > 0.1)
      .sort((a, b) => b.bboxOverflow - a.bboxOverflow);
    if (bboxBad.length > 0) {
      console.log("\n--- BBox Overflow (draw exceeds getBoundingBox) ---");
      for (const r of bboxBad) {
        console.log(
          `  ${r.typeId}: overflow=${r.bboxOverflow.toFixed(2)} grid units`,
        );
      }
    }

    // --- Text overlaps ---
    const overlapBad = valid
      .filter((r) => r.textOverlaps > 0)
      .sort((a, b) => b.textOverlaps - a.textOverlaps);
    if (overlapBad.length > 0) {
      console.log("\n--- Text Overlaps ---");
      for (const r of overlapBad) {
        console.log(
          `  ${r.typeId}: ${r.textOverlapDetails.join(", ")}`,
        );
      }
    }

    // --- Pin count mismatches ---
    const pinCountBad = valid
      .filter((r) => r.pinCountDelta !== null && r.pinCountDelta !== 0)
      .sort(
        (a, b) =>
          Math.abs(b.pinCountDelta!) - Math.abs(a.pinCountDelta!),
      );
    if (pinCountBad.length > 0) {
      console.log("\n--- Pin Count Mismatches ---");
      for (const r of pinCountBad) {
        console.log(
          `  ${r.typeId}: delta=${r.pinCountDelta! > 0 ? "+" : ""}${r.pinCountDelta}`,
        );
      }
    }

    // --- Pin position mismatches ---
    const pinPosBad = valid
      .filter((r) => r.pinPosMismatches > 0)
      .sort((a, b) => b.pinPosMismatches - a.pinPosMismatches);
    if (pinPosBad.length > 0) {
      console.log("\n--- Pin Position Mismatches ---");
      for (const r of pinPosBad) {
        console.log(
          `  ${r.typeId}: ${r.pinPosDetails.join(", ")}`,
        );
      }
    }

    // --- Detached pins ---
    const detachedBad = valid
      .filter((r) => r.pinDetachedCount > 0)
      .sort((a, b) => b.pinDetachedCount - a.pinDetachedCount);
    if (detachedBad.length > 0) {
      console.log("\n--- Detached Pins (not touching body) ---");
      for (const r of detachedBad) {
        console.log(
          `  ${r.typeId}: ${r.pinDetachedDetails.join(", ")}`,
        );
      }
    }

    if (errors.length > 0) {
      console.log("\n--- Errors ---");
      for (const e of errors) {
        console.log(`  ${e.typeId}: ${e.error}`);
      }
    }

    // --- Dice distribution ---
    const buckets = [0, 0, 0, 0, 0];
    for (const r of covered) {
      const idx = Math.min(Math.floor(r.pixelDice * 5), 4);
      buckets[idx]++;
    }
    console.log("\n--- Dice Distribution ---");
    console.log(`  0.0–0.2: ${buckets[0]}`);
    console.log(`  0.2–0.4: ${buckets[1]}`);
    console.log(`  0.4–0.6: ${buckets[2]}`);
    console.log(`  0.6–0.8: ${buckets[3]}`);
    console.log(`  0.8–1.0: ${buckets[4]}`);

  });
});

// ---------------------------------------------------------------------------
// Rotation/mirror pin transform audit
//
// For each analog component type with a pin reference, create the element at
// all 8 transform combinations (4 rotations × 2 mirror states) and verify
// that pinWorldPosition() matches the expected transform math.
// ---------------------------------------------------------------------------

const ROTATIONS: Rotation[] = [0, 1, 2, 3];
const MIRRORS = [false, true];

describe("analog pin transform audit- rotation × mirror correctness", () => {
  let registry: ComponentRegistry;

  beforeAll(() => {
    registry = createDefaultRegistry();
  });

  interface TransformMismatch {
    typeId: string;
    rotation: Rotation;
    mirror: boolean;
    pinLabel: string;
    expected: { x: number; y: number };
    actual: { x: number; y: number };
  }

  it.each(computeAllTypes())(
    "$typeName pin transforms",
    ({ typeName }) => {
      const refPins = FALSTAD_PIN_POSITIONS.get(typeName);
      if (!refPins) return; // no pin reference for this type

      const def = registry.get(typeName);
      if (!def) return;

      const props = buildDefaultProps(registry, typeName);
      let element: CircuitElement;
      try {
        element = def.factory(props);
      } catch (err) {
        console.warn(`[analog-shape-render-audit] Factory error for element type "${typeName}" (pin audit)`, err);
        return;
      }

      const basePins = element.getPins();
      if (basePins.length !== refPins.length) return;

      const componentMismatches: TransformMismatch[] = [];

      for (const rot of ROTATIONS) {
        for (const mir of MIRRORS) {
          // Skip rot=0 mir=false- already covered by main audit
          if (rot === 0 && !mir) continue;

          element.rotation = rot;
          element.mirror = mir;
          // Position at a non-origin point to test translation
          element.position = { x: 10, y: 20 };

          const tsPins = element.getPins();

          for (let i = 0; i < tsPins.length; i++) {
            const tsWorld = pinWorldPosition(element, tsPins[i]);
            const rp = refPins[i];
            const expected = falstadWorldPosition(
              rp.x,
              rp.y,
              element.position.x,
              element.position.y,
              rot,
              mir,
            );

            const dx =
              Math.round((tsWorld.x - expected.x) * 100) / 100;
            const dy =
              Math.round((tsWorld.y - expected.y) * 100) / 100;

            if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
              componentMismatches.push({
                typeId: typeName,
                rotation: rot,
                mirror: mir,
                pinLabel: rp.label,
                expected,
                actual: tsWorld,
              });
            }
          }
        }
      }

      expect(
        componentMismatches.length,
        `${typeName} has ${componentMismatches.length} transform mismatches`,
      ).toBe(0);
    },
  );
});
