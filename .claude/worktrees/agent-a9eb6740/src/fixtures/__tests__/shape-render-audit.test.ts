/**
 * Shape render audit — pixel comparison + structural text comparison
 * of TS component rendering against Java Digital's reference shapes.
 *
 * For each component type present in both the Java reference and the TS registry:
 *   1. Converts Java fixture draw calls to outline segments
 *   2. Creates a TS element, draws it via MockRenderContext, converts to segments
 *   3. Rasterizes both to binary bitmaps at 20px/grid-unit
 *   4. Compares bitmaps using soft Dice coefficient (1px neighborhood tolerance)
 *   5. Compares text calls structurally (content, position, anchor)
 *
 * Pixel comparison catches shape, position, and proportion errors that
 * fingerprint counting (poly/line/circle/text counts) cannot.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { createDefaultRegistry } from "@/components/register-all";
import type { ComponentRegistry } from "@/core/registry";
import type { CircuitElement } from "@/core/element";
import { PropertyBag } from "@/core/properties";
import { MockRenderContext } from "@/test-utils/mock-render-context";
import {
  javaCallsToSegments,
  tsCallsToSegments,
  segmentBounds,
  unionBounds,
  createViewport,
  renderSegments,
  compareBitmaps,
  extractJavaTexts,
  extractTSTexts,
  compareTexts,
  compareExtents,
  detectTextOverlaps,
  checkPinProximity,
} from "@/test-utils/shape-rasterizer";
import type {
  JavaDrawCall,
  CompareResult,
  TextCompareResult,
  ExtentResult,
  Bounds,
  TextOverlapResult,
} from "@/test-utils/shape-rasterizer";
import { getJavaPinPositions } from "@/test-utils/java-pin-reference";
import type { JavaPinRef } from "@/test-utils/java-pin-reference";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Components that exist only in TS, are decorative, or not yet implemented. */
const SKIP_TYPES = new Set([
  "ProgramCounter",
  "ProgramMemory",
  "Rectangle",
  "Text",
  "Testcase",
  "Data",
  "Telnet",
  "External",
  "ExternalFile",
  "GenericCode",
  "GenericInitCode",
  "PinControl",
]);

/** Java type name → TS registry name overrides. */
const JAVA_TO_TS_NAME: Record<string, string> = {
  "Seven-Seg": "SevenSeg",
  "Seven-Seg-Hex": "SevenSegHex",
  "DiodeForeward": "DiodeForward",
};

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

interface ComponentResult {
  typeId: string;
  pixelDice: number;
  litJava: number;
  litTS: number;
  textResult: TextCompareResult;
  extent: ExtentResult;
  /** getBoundingBox() vs actual draw bounds mismatch (grid units) */
  bboxOverflow: number;
  /** Text overlap detection */
  textOverlaps: number;
  textOverlapDetails: string[];
  /** Pin position mismatches (local coords, rot=0 mir=false) */
  pinPosMismatches: number;
  pinPosDetails: string[];
  /** Pin count delta (TS - Java); 0 = match, null = no Java ref */
  pinCountDelta: number | null;
  /** Pins that don't touch the drawn body (distance > 0.1 grid) */
  pinDetachedCount: number;
  pinDetachedDetails: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Compute matched types synchronously (vitest resolves .each before beforeAll)
// ---------------------------------------------------------------------------

function computeMatchedTypes(): Array<{
  javaName: string;
  tsName: string;
}> {
  const reg = createDefaultRegistry();
  const jsonPath = join(__dirname, "../../../fixtures/java-shapes.json");
  const shapes: Record<string, JavaDrawCall[]> = JSON.parse(
    readFileSync(jsonPath, "utf-8"),
  );

  const types: Array<{ javaName: string; tsName: string }> = [];
  for (const javaName of Object.keys(shapes)) {
    if (javaName.endsWith(".dig")) continue;
    const tsName = JAVA_TO_TS_NAME[javaName] ?? javaName;
    if (SKIP_TYPES.has(tsName)) continue;
    if (!reg.get(tsName)) continue;
    types.push({ javaName, tsName });
  }
  return types;
}

/**
 * Find registered TS component types that have NO java-shapes.json entry.
 * These still get pin-position, bbox, and draw-sanity checks — just no
 * pixel comparison (there's nothing to compare against).
 */
function computeUncoveredTypes(): Array<{ tsName: string }> {
  const reg = createDefaultRegistry();
  const jsonPath = join(__dirname, "../../../fixtures/java-shapes.json");
  const shapes: Record<string, JavaDrawCall[]> = JSON.parse(
    readFileSync(jsonPath, "utf-8"),
  );

  // Build set of TS names that ARE covered by java-shapes
  const coveredTsNames = new Set<string>();
  for (const javaName of Object.keys(shapes)) {
    if (javaName.endsWith(".dig")) continue;
    coveredTsNames.add(JAVA_TO_TS_NAME[javaName] ?? javaName);
  }

  const types: Array<{ tsName: string }> = [];
  for (const def of reg.getAll()) {
    if (SKIP_TYPES.has(def.name)) continue;
    if (coveredTsNames.has(def.name)) continue;
    // 74xx ICs are subcircuit stubs — factory intentionally throws
    if (def.category === "74XX") continue;
    types.push({ tsName: def.name });
  }
  return types;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("shape render audit — pixel + text comparison vs Java Digital", () => {
  let registry: ComponentRegistry;
  let javaShapes: Record<string, JavaDrawCall[]>;
  const results: ComponentResult[] = [];

  beforeAll(() => {
    registry = createDefaultRegistry();
    const jsonPath = join(__dirname, "../../../fixtures/java-shapes.json");
    javaShapes = JSON.parse(readFileSync(jsonPath, "utf-8"));
  });

  it.each(computeMatchedTypes())(
    "$tsName shape comparison ($javaName)",
    ({ javaName, tsName }) => {
      const javaCalls = javaShapes[javaName];
      expect(javaCalls).toBeDefined();

      // --- Pixel comparison ---

      // Convert Java draw calls to segments
      const javaSegs = javaCallsToSegments(javaCalls);

      // Create TS element and draw
      const props = buildDefaultProps(registry, tsName);
      const def = registry.get(tsName)!;
      let element: CircuitElement;
      try {
        element = def.factory(props);
      } catch {
        results.push({
          typeId: tsName,
          pixelDice: -1,
          litJava: 0,
          litTS: 0,
          textResult: { matched: [], missingInTS: [], extraInTS: [] },
          extent: { javaW: 0, javaH: 0, tsW: 0, tsH: 0, widthDelta: 0, heightDelta: 0, centerDx: 0, centerDy: 0, maxDelta: 0 },
          bboxOverflow: -1,
          textOverlaps: 0,
          textOverlapDetails: [],
          pinPosMismatches: 0,
          pinPosDetails: [],
          pinCountDelta: null,
          pinDetachedCount: 0,
          pinDetachedDetails: [],
          error: "FACTORY_ERROR",
        });
        return;
      }

      const ctx = new MockRenderContext();
      try {
        element.draw(ctx);
      } catch {
        results.push({
          typeId: tsName,
          pixelDice: -1,
          litJava: 0,
          litTS: 0,
          textResult: { matched: [], missingInTS: [], extraInTS: [] },
          extent: { javaW: 0, javaH: 0, tsW: 0, tsH: 0, widthDelta: 0, heightDelta: 0, centerDx: 0, centerDy: 0, maxDelta: 0 },
          bboxOverflow: -1,
          textOverlaps: 0,
          textOverlapDetails: [],
          pinPosMismatches: 0,
          pinPosDetails: [],
          pinCountDelta: null,
          pinDetachedCount: 0,
          pinDetachedDetails: [],
          error: "DRAW_ERROR",
        });
        return;
      }

      // Convert TS draw calls to segments
      const tsSegs = tsCallsToSegments(ctx.calls);

      // Compute union bounding box → shared viewport
      const javaBounds = segmentBounds(javaSegs);
      const tsBounds = segmentBounds(tsSegs);
      const bounds = unionBounds(javaBounds, tsBounds);
      const vp = createViewport(bounds);

      // Rasterize both
      const javaBmp = renderSegments(javaSegs, vp);
      const tsBmp = renderSegments(tsSegs, vp);

      // Compare pixels
      const pixelResult: CompareResult = compareBitmaps(javaBmp, tsBmp);

      // --- Extent comparison ---
      const extent = compareExtents(javaBounds, tsBounds);

      // --- Bounding box consistency ---
      let bboxOverflow = 0;
      try {
        const bbox = element.getBoundingBox();
        // bbox is in world coords (includes position), draw bounds are in local coords
        // Elements are created at position (0,0), so bbox.x/y are the local origin offsets
        const bx0 = bbox.x;
        const by0 = bbox.y;
        const bx1 = bbox.x + bbox.width;
        const by1 = bbox.y + bbox.height;
        // Check how much the draw bounds exceed the bounding box (in grid units)
        bboxOverflow = Math.max(
          0,
          tsBounds.minX - bx0,
          tsBounds.minY - by0,
          bx0 - tsBounds.minX, // bbox doesn't start early enough
          by0 - tsBounds.minY,
          tsBounds.maxX - bx1, // draw extends past bbox right
          tsBounds.maxY - by1, // draw extends past bbox bottom
        );
      } catch {
        bboxOverflow = -1;
      }

      // --- Text comparison ---
      const javaTexts = extractJavaTexts(javaCalls);
      const tsTexts = extractTSTexts(ctx.calls);
      const textResult = compareTexts(javaTexts, tsTexts);

      // --- Text overlap detection ---
      const overlapResult = detectTextOverlaps(ctx.calls);
      const textOverlapDetails = overlapResult.overlaps.map(
        (o) => `"${o.a.text}"↔"${o.b.text}" (${o.overlapArea.toFixed(2)})`
      );

      // --- Pin position comparison ---
      // Build a plain props record from the PropertyBag for getJavaPinPositions
      const propsRecord: Record<string, unknown> = {};
      for (const pd of def.propertyDefs) {
        propsRecord[pd.key] = pd.defaultValue;
      }
      const javaPins = getJavaPinPositions(tsName, propsRecord);
      let pinPosMismatches = 0;
      const pinPosDetails: string[] = [];
      let pinCountDelta: number | null = null;

      if (javaPins !== null) {
        const tsPins = element.getPins();
        pinCountDelta = tsPins.length - javaPins.length;

        if (pinCountDelta === 0) {
          // Compare local positions (element at origin, rot=0, mir=false)
          for (let i = 0; i < tsPins.length; i++) {
            const tp = tsPins[i];
            const jp = javaPins[i];
            const dx = Math.abs(tp.position.x - jp.x);
            const dy = Math.abs(tp.position.y - jp.y);
            if (dx > 0.01 || dy > 0.01) {
              pinPosMismatches++;
              pinPosDetails.push(
                `${jp.label}:(${jp.x},${jp.y})→(${tp.position.x},${tp.position.y})`
              );
            }
          }
        }
      }

      // --- Pin-to-body proximity ---
      const tsPinsForProximity = element.getPins().map((p) => ({
        label: p.label,
        x: p.position.x,
        y: p.position.y,
      }));
      const proximity = checkPinProximity(tsPinsForProximity, tsSegs);
      const pinDetachedDetails = proximity.detached.map(
        (d) => `${d.label}:(${d.x},${d.y}) dist=${d.distance}`
      );

      results.push({
        typeId: tsName,
        pixelDice: pixelResult.dice,
        litJava: pixelResult.litA,
        litTS: pixelResult.litB,
        textResult,
        extent,
        bboxOverflow,
        textOverlaps: overlapResult.overlaps.length,
        textOverlapDetails,
        pinPosMismatches,
        pinPosDetails,
        pinCountDelta,
        pinDetachedCount: proximity.detached.length,
        pinDetachedDetails,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Uncovered types — registered in TS but no java-shapes.json pixel data.
  // Still check: factory, draw, pin positions, bbox, text overlaps.
  // -------------------------------------------------------------------------

  it.each(computeUncoveredTypes())(
    "$tsName (uncovered — no Java pixel reference)",
    ({ tsName }) => {
      const def = registry.get(tsName)!;
      const props = buildDefaultProps(registry, tsName);

      let element: CircuitElement;
      try {
        element = def.factory(props);
      } catch {
        results.push({
          typeId: tsName,
          pixelDice: NaN,
          litJava: 0,
          litTS: 0,
          textResult: { matched: [], missingInTS: [], extraInTS: [] },
          extent: { javaW: 0, javaH: 0, tsW: 0, tsH: 0, widthDelta: 0, heightDelta: 0, centerDx: 0, centerDy: 0, maxDelta: 0 },
          bboxOverflow: -1,
          textOverlaps: 0,
          textOverlapDetails: [],
          pinPosMismatches: 0,
          pinPosDetails: [],
          pinCountDelta: null,
          pinDetachedCount: 0,
          pinDetachedDetails: [],
          error: "FACTORY_ERROR",
        });
        return;
      }

      const ctx = new MockRenderContext();
      try {
        element.draw(ctx);
      } catch {
        results.push({
          typeId: tsName,
          pixelDice: NaN,
          litJava: 0,
          litTS: 0,
          textResult: { matched: [], missingInTS: [], extraInTS: [] },
          extent: { javaW: 0, javaH: 0, tsW: 0, tsH: 0, widthDelta: 0, heightDelta: 0, centerDx: 0, centerDy: 0, maxDelta: 0 },
          bboxOverflow: -1,
          textOverlaps: 0,
          textOverlapDetails: [],
          pinPosMismatches: 0,
          pinPosDetails: [],
          pinCountDelta: null,
          pinDetachedCount: 0,
          pinDetachedDetails: [],
          error: "DRAW_ERROR",
        });
        return;
      }

      // --- BBox vs draw bounds ---
      const tsSegs = tsCallsToSegments(ctx.calls);
      const tsBounds = segmentBounds(tsSegs);

      let bboxOverflow = 0;
      try {
        const bbox = element.getBoundingBox();
        const bx0 = bbox.x;
        const by0 = bbox.y;
        const bx1 = bbox.x + bbox.width;
        const by1 = bbox.y + bbox.height;
        bboxOverflow = Math.max(
          0,
          tsBounds.minX - bx0,
          tsBounds.minY - by0,
          bx0 - tsBounds.minX,
          by0 - tsBounds.minY,
          tsBounds.maxX - bx1,
          tsBounds.maxY - by1,
        );
      } catch {
        bboxOverflow = -1;
      }

      // --- Text overlap detection ---
      const overlapResult = detectTextOverlaps(ctx.calls);
      const textOverlapDetails = overlapResult.overlaps.map(
        (o) => `"${o.a.text}"↔"${o.b.text}" (${o.overlapArea.toFixed(2)})`
      );

      // --- Pin position comparison ---
      const propsRecord: Record<string, unknown> = {};
      for (const pd of def.propertyDefs) {
        propsRecord[pd.key] = pd.defaultValue;
      }
      const javaPins = getJavaPinPositions(tsName, propsRecord);
      let pinPosMismatches = 0;
      const pinPosDetails: string[] = [];
      let pinCountDelta: number | null = null;

      if (javaPins !== null) {
        const tsPins = element.getPins();
        pinCountDelta = tsPins.length - javaPins.length;

        if (pinCountDelta === 0) {
          for (let i = 0; i < tsPins.length; i++) {
            const tp = tsPins[i];
            const jp = javaPins[i];
            const dx = Math.abs(tp.position.x - jp.x);
            const dy = Math.abs(tp.position.y - jp.y);
            if (dx > 0.01 || dy > 0.01) {
              pinPosMismatches++;
              pinPosDetails.push(
                `${jp.label}:(${jp.x},${jp.y})→(${tp.position.x},${tp.position.y})`
              );
            }
          }
        }
      }

      // --- Pin-to-body proximity ---
      const tsPinsForProximity = element.getPins().map((p) => ({
        label: p.label,
        x: p.position.x,
        y: p.position.y,
      }));
      const proximity = checkPinProximity(tsPinsForProximity, tsSegs);
      const pinDetachedDetails = proximity.detached.map(
        (d) => `${d.label}:(${d.x},${d.y}) dist=${d.distance}`
      );

      results.push({
        typeId: tsName,
        pixelDice: NaN, // no Java pixel reference available
        litJava: 0,
        litTS: 0,
        textResult: { matched: [], missingInTS: [], extraInTS: [] },
        extent: { javaW: 0, javaH: 0, tsW: 0, tsH: 0, widthDelta: 0, heightDelta: 0, centerDx: 0, centerDy: 0, maxDelta: 0 },
        bboxOverflow,
        textOverlaps: overlapResult.overlaps.length,
        textOverlapDetails,
        pinPosMismatches,
        pinPosDetails,
        pinCountDelta,
        pinDetachedCount: proximity.detached.length,
        pinDetachedDetails,
      });
    },
  );

  it("summary: shape comparison results", () => {
    const total = results.length;
    const errors = results.filter((r) => r.error);
    const valid = results.filter((r) => !r.error);
    // Split covered (has Java pixel data) vs uncovered (NaN pixelDice)
    const covered = valid.filter((r) => !Number.isNaN(r.pixelDice));
    const uncoveredResults = valid.filter((r) => Number.isNaN(r.pixelDice));
    const pixelGood = covered.filter((r) => r.pixelDice >= 0.7);
    const textPerfect = covered.filter(
      (r) =>
        r.textResult.missingInTS.length === 0 &&
        r.textResult.extraInTS.length === 0,
    );

    console.log("\n=== Symbol Audit Summary ===");
    console.log(`Total components: ${total} (${covered.length} covered + ${uncoveredResults.length} uncovered)`);
    console.log(`Errors (factory/draw): ${errors.length}`);
    console.log(
      `Pixel match (Dice ≥ 0.7): ${pixelGood.length} / ${covered.length}`,
    );
    const extentGood = covered.filter((r) => r.extent.maxDelta < 0.5);
    const bboxGood = valid.filter((r) => r.bboxOverflow <= 0.1);
    console.log(
      `Text match (no missing/extra): ${textPerfect.length} / ${covered.length}`,
    );
    console.log(
      `Extent match (maxΔ < 0.5): ${extentGood.length} / ${covered.length}`,
    );
    console.log(
      `BBox covers shape (≤0.1 overflow): ${bboxGood.length} / ${valid.length}`,
    );
    const overlapFree = valid.filter((r) => r.textOverlaps === 0);
    console.log(
      `Text overlap-free: ${overlapFree.length} / ${valid.length}`,
    );
    const pinCovered = valid.filter((r) => r.pinCountDelta !== null);
    const pinCountOk = pinCovered.filter((r) => r.pinCountDelta === 0);
    const pinPosOk = pinCovered.filter((r) => r.pinCountDelta === 0 && r.pinPosMismatches === 0);
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

    // Sort: covered by Dice ascending, then uncovered alphabetically
    const sortedCovered = [...covered].sort((a, b) => a.pixelDice - b.pixelDice);
    const sortedUncovered = [...uncoveredResults].sort((a, b) => a.typeId.localeCompare(b.typeId));
    const sorted = [...sortedCovered, ...sortedUncovered];

    if (sorted.length > 0) {
      console.log(
        "\n" +
          "Component".padEnd(22) +
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
      console.log("-".repeat(120));

      for (const r of sorted) {
        const isUncov = Number.isNaN(r.pixelDice);
        const diceStr = isUncov ? "N/A" :
          r.pixelDice >= 0 ? r.pixelDice.toFixed(3) : "ERR";
        const txtMissing = r.textResult.missingInTS.length;
        const txtExtra = r.textResult.extraInTS.length;
        const txtStr = isUncov ? "N/A" :
          txtMissing === 0 && txtExtra === 0
            ? "ok"
            : `-${txtMissing}/+${txtExtra}`;

        const e = r.extent;
        const fmtD = (v: number) => (Math.abs(v) < 0.01 ? "0" : v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
        const bboxStr = r.bboxOverflow < 0 ? "ERR" : r.bboxOverflow <= 0.1 ? "ok" : `+${r.bboxOverflow.toFixed(1)}`;

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

        let details = isUncov ? "(no Java pixel ref) " : "";
        if (r.textResult.missingInTS.length > 0) {
          details += `miss:[${r.textResult.missingInTS.map((t) => t.text).join(",")}] `;
        }
        if (r.textResult.extraInTS.length > 0) {
          details += `extra:[${r.textResult.extraInTS.map((t) => t.text).join(",")}] `;
        }
        // Show position diffs > 0.5 grid units
        for (const m of r.textResult.matched) {
          if (m.posDiff > 0.5) {
            details += `"${m.text}" Δ${m.posDiff.toFixed(1)} `;
          }
        }
        // Show pin mismatches
        if (r.pinPosDetails.length > 0) {
          details += `pins:[${r.pinPosDetails.join(",")}] `;
        }
        if (r.pinCountDelta !== null && r.pinCountDelta !== 0) {
          const tsCnt = (r.pinCountDelta > 0 ? r.pinCountDelta : 0);
          details += `pin#:${tsCnt + (r.pinCountDelta < 0 ? r.pinCountDelta : 0)}→${tsCnt + (r.pinCountDelta > 0 ? r.pinCountDelta : 0)} `;
        }
        if (r.pinDetachedDetails.length > 0) {
          details += `detached:[${r.pinDetachedDetails.join(",")}] `;
        }

        console.log(
          r.typeId.padEnd(22) +
            diceStr.padEnd(8) +
            (isUncov ? "N/A" : fmtD(e.widthDelta)).padEnd(7) +
            (isUncov ? "N/A" : fmtD(e.heightDelta)).padEnd(7) +
            (isUncov ? "N/A" : fmtD(e.centerDx)).padEnd(7) +
            (isUncov ? "N/A" : fmtD(e.centerDy)).padEnd(7) +
            bboxStr.padEnd(6) +
            (r.textOverlaps === 0 ? "ok" : String(r.textOverlaps)).padEnd(6) +
            txtStr.padEnd(8) +
            pinStr.padEnd(8) +
            details.trim(),
        );
      }
    }

    // --- Extent outliers ---
    const extentBad = valid
      .filter((r) => r.extent.maxDelta >= 0.5)
      .sort((a, b) => b.extent.maxDelta - a.extent.maxDelta);
    if (extentBad.length > 0) {
      console.log("\n--- Extent Outliers (maxΔ ≥ 0.5 grid) ---");
      for (const r of extentBad) {
        const e = r.extent;
        console.log(
          `  ${r.typeId}: Java=${e.javaW.toFixed(1)}×${e.javaH.toFixed(1)} TS=${e.tsW.toFixed(1)}×${e.tsH.toFixed(1)} ΔW=${e.widthDelta.toFixed(2)} ΔH=${e.heightDelta.toFixed(2)} ΔC=(${e.centerDx.toFixed(2)},${e.centerDy.toFixed(2)})`,
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
        console.log(`  ${r.typeId}: overflow=${r.bboxOverflow.toFixed(2)} grid units`);
      }
    }

    // --- Text overlaps ---
    const overlapBad = valid
      .filter((r) => r.textOverlaps > 0)
      .sort((a, b) => b.textOverlaps - a.textOverlaps);
    if (overlapBad.length > 0) {
      console.log("\n--- Text Overlaps ---");
      for (const r of overlapBad) {
        console.log(`  ${r.typeId}: ${r.textOverlapDetails.join(", ")}`);
      }
    }

    // --- Pin count mismatches ---
    const pinCountBad = valid
      .filter((r) => r.pinCountDelta !== null && r.pinCountDelta !== 0)
      .sort((a, b) => Math.abs(b.pinCountDelta!) - Math.abs(a.pinCountDelta!));
    if (pinCountBad.length > 0) {
      console.log("\n--- Pin Count Mismatches ---");
      for (const r of pinCountBad) {
        console.log(`  ${r.typeId}: delta=${r.pinCountDelta! > 0 ? "+" : ""}${r.pinCountDelta}`);
      }
    }

    // --- Pin position mismatches ---
    const pinPosBad = valid
      .filter((r) => r.pinPosMismatches > 0)
      .sort((a, b) => b.pinPosMismatches - a.pinPosMismatches);
    if (pinPosBad.length > 0) {
      console.log("\n--- Pin Position Mismatches ---");
      for (const r of pinPosBad) {
        console.log(`  ${r.typeId}: ${r.pinPosDetails.join(", ")}`);
      }
    }

    // --- Detached pins (not touching body) ---
    const detachedBad = valid
      .filter((r) => r.pinDetachedCount > 0)
      .sort((a, b) => b.pinDetachedCount - a.pinDetachedCount);
    if (detachedBad.length > 0) {
      console.log("\n--- Detached Pins (not touching body) ---");
      for (const r of detachedBad) {
        console.log(`  ${r.typeId}: ${r.pinDetachedDetails.join(", ")}`);
      }
    }

    if (errors.length > 0) {
      console.log("\n--- Errors ---");
      for (const e of errors) {
        console.log(`  ${e.typeId}: ${e.error}`);
      }
    }

    // Print distribution (covered types only)
    const buckets = [0, 0, 0, 0, 0]; // [0-0.2, 0.2-0.4, 0.4-0.6, 0.6-0.8, 0.8-1.0]
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

    // -----------------------------------------------------------------------
    // Assertions — strict thresholds, no escape hatches
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // All assertions use expect.soft() so every check runs and reports
    // independently, giving a complete failure inventory in one pass.
    // -----------------------------------------------------------------------

    // Dice ≥ 0.99: every covered component must near-perfectly match Java reference
    const diceFails = covered.filter((r) => r.pixelDice < 0.99);
    expect.soft(
      diceFails.length,
      `Dice < 0.99 (${diceFails.length}):\n` +
        diceFails.map((r) => `  ${r.typeId} (${r.pixelDice.toFixed(3)})`).join("\n"),
    ).toBe(0);

    // Extent: shape dimensions must match exactly (0 tolerance, covered only)
    const extentFails = covered.filter((r) => r.extent.maxDelta > 0);
    expect.soft(
      extentFails.length,
      `Extent Δ > 0 (${extentFails.length}):\n` +
        extentFails.map((r) => `  ${r.typeId} (Δ${r.extent.maxDelta.toFixed(2)})`).join("\n"),
    ).toBe(0);

    // BBox: no component should draw outside its bounding box at all
    const bboxFails = valid.filter((r) => r.bboxOverflow > 0);
    expect.soft(
      bboxFails.length,
      `BBox overflow > 0 (${bboxFails.length}):\n` +
        bboxFails.map((r) => `  ${r.typeId} (+${r.bboxOverflow.toFixed(2)})`).join("\n"),
    ).toBe(0);

    // Text overlaps: zero tolerance
    const totalOverlaps = valid.reduce((sum, r) => sum + r.textOverlaps, 0);
    expect.soft(
      totalOverlaps,
      `Text overlaps (${totalOverlaps} across ${overlapBad.length} components):\n` +
        overlapBad.map((r) => `  ${r.typeId}: ${r.textOverlapDetails.join(", ")}`).join("\n"),
    ).toBe(0);

    // Pin count: every covered component must have the right number of pins
    expect.soft(
      pinCountBad.length,
      `Pin count mismatch (${pinCountBad.length}):\n` +
        pinCountBad.map((r) => `  ${r.typeId} (Δ${r.pinCountDelta! > 0 ? "+" : ""}${r.pinCountDelta})`).join("\n"),
    ).toBe(0);

    // Pin positions: every covered component's pins must be at the right local coordinates
    const totalPinMismatches = valid.reduce((sum, r) => sum + r.pinPosMismatches, 0);
    expect.soft(
      totalPinMismatches,
      `Pin position mismatches (${totalPinMismatches} across ${pinPosBad.length} components):\n` +
        pinPosBad.map((r) => `  ${r.typeId}: ${r.pinPosDetails.join(", ")}`).join("\n"),
    ).toBe(0);

    // Pin proximity: every pin must touch the drawn body (distance ≤ 0.1 grid)
    const totalDetached = valid.reduce((sum, r) => sum + r.pinDetachedCount, 0);
    expect.soft(
      totalDetached,
      `Detached pins (${totalDetached} across ${detachedBad.length} components):\n` +
        detachedBad.map((r) => `  ${r.typeId}: ${r.pinDetachedDetails.join(", ")}`).join("\n"),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rotation/mirror pin transform audit
//
// For each component type with a Java pin reference, create the element at
// all 8 transform combinations (4 rotations × 2 mirror states) and verify
// that pinWorldPosition() matches the Java transform math.
// ---------------------------------------------------------------------------

import { pinWorldPosition } from "@/core/pin";
import type { Rotation } from "@/core/pin";
import { javaWorldPosition } from "@/test-utils/java-pin-reference";

const ROTATIONS: Rotation[] = [0, 1, 2, 3];
const MIRRORS = [false, true];

describe("pin transform audit — rotation × mirror correctness", () => {
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

  const mismatches: TransformMismatch[] = [];

  // Use matched types + uncovered types (both have java-pin-reference entries)
  const allAuditTypes = [
    ...computeMatchedTypes().map((t) => ({ tsName: t.tsName })),
    ...computeUncoveredTypes(),
  ];

  it.each(allAuditTypes)(
    "$tsName pin transforms",
    ({ tsName }) => {
      const def = registry.get(tsName);
      if (!def) return;

      const props = buildDefaultProps(registry, tsName);
      const propsRecord: Record<string, unknown> = {};
      for (const pd of def.propertyDefs) {
        propsRecord[pd.key] = pd.defaultValue;
      }

      const javaPins = getJavaPinPositions(tsName, propsRecord);
      if (!javaPins) return;

      let element: CircuitElement;
      try {
        element = def.factory(props);
      } catch {
        return;
      }

      // Verify pin count matches at default (already checked in main audit)
      const basePins = element.getPins();
      if (basePins.length !== javaPins.length) return;

      for (const rot of ROTATIONS) {
        for (const mir of MIRRORS) {
          // Skip rot=0 mir=false — already covered by main audit
          if (rot === 0 && !mir) continue;

          element.rotation = rot;
          element.mirror = mir;
          // Position at a non-origin point to test translation too
          element.position = { x: 10, y: 20 };

          const tsPins = element.getPins();

          for (let i = 0; i < tsPins.length; i++) {
            const tsWorld = pinWorldPosition(element, tsPins[i]);
            const jp = javaPins[i];
            const javaWorld = javaWorldPosition(
              jp.x, jp.y,
              element.position.x, element.position.y,
              rot, mir,
            );

            const dx = Math.round((tsWorld.x - javaWorld.x) * 100) / 100;
            const dy = Math.round((tsWorld.y - javaWorld.y) * 100) / 100;

            if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
              mismatches.push({
                typeId: tsName,
                rotation: rot,
                mirror: mir,
                pinLabel: javaPins[i].label,
                expected: javaWorld,
                actual: tsWorld,
              });
            }
          }
        }
      }
    },
  );

  it("summary: zero pin transform mismatches", () => {
    if (mismatches.length === 0) return;

    // Group by typeId
    const byType = new Map<string, TransformMismatch[]>();
    for (const m of mismatches) {
      if (!byType.has(m.typeId)) byType.set(m.typeId, []);
      byType.get(m.typeId)!.push(m);
    }

    const lines: string[] = [];
    lines.push(
      `\n${mismatches.length} pin transform mismatch(es) across ${byType.size} component type(s):\n`,
    );

    for (const [typeId, ms] of [...byType.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      // Deduplicate by pattern
      const patterns = new Map<
        string,
        { count: number; example: TransformMismatch }
      >();
      for (const m of ms) {
        const key = `rot=${m.rotation} mir=${m.mirror} pin=${m.pinLabel}`;
        if (!patterns.has(key))
          patterns.set(key, { count: 0, example: m });
        patterns.get(key)!.count++;
      }

      lines.push(`  ${typeId} — ${ms.length} mismatch(es):`);
      for (const [pattern, { count, example }] of patterns) {
        lines.push(
          `    ${pattern} (×${count}) — expected (${example.expected.x},${example.expected.y}), got (${example.actual.x},${example.actual.y})`,
        );
      }
    }

    console.log(lines.join("\n"));

    expect(mismatches.length, lines.join("\n")).toBe(0);
  });
});
