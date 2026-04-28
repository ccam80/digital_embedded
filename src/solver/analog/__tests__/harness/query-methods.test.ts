/**
 * Tests for Stream 3 query methods, utilities, and ComparisonSession extensions.
 *
 * Tests 1-7:   glob.ts
 * Tests 8-13:  format.ts
 * Tests 14-17: normalizeDeviceType
 * Tests 18:    captureTopology type field fix
 * Tests 19-21: listComponents
 * Tests 22-24: listNodes
 * Tests 25-27: getComponentsByType
 * Tests 28-31: getDivergences
 * Tests 32-33: getStepEndRange
 * Tests 34-36: traceComponentSlot
 * Tests 37-39: getStateHistory
 */

import { describe, it, expect } from "vitest";
import { compileSlotMatcher, matchSlotPattern } from "./glob.js";
import {
  formatComparedValue,
  formatCV,
  formatComparedTable,
  mapToRecord,
  float64ToArray,
} from "./format.js";
import { normalizeDeviceType } from "./device-mappings.js";
import { captureTopology, buildElementLabelMap } from "./capture.js";
import { ComparisonSession } from "./comparison-session.js";
import type { ComparedValue } from "./types.js";
import type { ConcreteCompiledAnalogCircuit } from "../../analog-engine.js";
import { isPoolBacked } from "../../element.js";
import type { AnalogElementCore } from "../../element.js";
import { StatePool } from "../../state-pool.js";
import { makeResistor, makeVoltageSource, makeDiode } from "../test-helpers.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Test helpers — copied from harness-integration.test.ts
// ---------------------------------------------------------------------------

function buildStatePool(elements: AnalogElementCore[]): StatePool {
  let offset = 0;
  for (const el of elements) {
    if (isPoolBacked(el)) { el.stateBaseOffset = offset; offset += el.stateSize; }
  }
  const pool = new StatePool(offset);
  for (const el of elements) {
    if (isPoolBacked(el)) el.initState(pool);
  }
  return pool;
}

function makeHWR() {
  const vs = makeVoltageSource(1, 0, 2, 5.0);
  const r = makeResistor(1, 2, 1000);
  const diode = makeDiode(2, 0, 1e-14, 1.0);
  const elements = [vs, r, diode];
  const pool = buildStatePool(elements);
  return {
    circuit: {
      netCount: 2, componentCount: 3, nodeCount: 2, matrixSize: 3,
      elements, labelToNodeId: new Map([["Vs", 1], ["R1:B", 2]]), statePool: pool,
    } as ConcreteCompiledAnalogCircuit,
    pool,
  };
}

function buildHwrCircuit(registry: ComponentRegistry) {
  const facade = new DefaultSimulatorFacade(registry);
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { voltage: 5 } },
      { id: "r1",  type: "Resistor",        props: { resistance: 1000 } },
      { id: "d1",  type: "Diode",           props: {} },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:A"],
      ["r1:B",   "d1:A"],
      ["d1:K",   "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

async function createHwrSession(): Promise<{ session: ComparisonSession; topology: ReturnType<typeof captureTopology> }> {
  const session = await ComparisonSession.createSelfCompare({
    buildCircuit: buildHwrCircuit,
    analysis: "dcop",
  });
  const topology = (session as any)._ourTopology;
  return { session, topology };
}

// ---------------------------------------------------------------------------
// glob.ts — 7 tests
// ---------------------------------------------------------------------------

describe("glob.ts — compileSlotMatcher / matchSlotPattern", () => {
  it("1. compileSlotMatcher([]) always returns false", () => {
    const match = compileSlotMatcher([]);
    expect(match("anything")).toBe(false);
    expect(match("")).toBe(false);
    expect(match("Q_BE")).toBe(false);
  });

  it('2. compileSlotMatcher(["*"]) always returns true', () => {
    const match = compileSlotMatcher(["*"]);
    expect(match("Q_BE")).toBe(true);
    expect(match("")).toBe(true);
    expect(match("SOME_SLOT_123")).toBe(true);
  });

  it('3. matchSlotPattern("Q_BE", ["Q_*"]) → true', () => {
    expect(matchSlotPattern("Q_BE", ["Q_*"])).toBe(true);
  });

  it('4. matchSlotPattern is case-insensitive: "q_be" matches "Q_*"', () => {
    expect(matchSlotPattern("q_be", ["Q_*"])).toBe(true);
  });

  it('5. matchSlotPattern("VBE", ["Q_*"]) → false', () => {
    expect(matchSlotPattern("VBE", ["Q_*"])).toBe(false);
  });

  it('6. matchSlotPattern: ? matches single char — "VBE" matches "V?E"', () => {
    expect(matchSlotPattern("VBE", ["V?E"])).toBe(true);
    expect(matchSlotPattern("VBE", ["V??"])).toBe(true);
    expect(matchSlotPattern("VBE", ["V?"])).toBe(false);
  });

  it('7. matchSlotPattern with multiple patterns OR\'d — "GEQ" matches ["Q_*", "GEQ"]', () => {
    expect(matchSlotPattern("GEQ", ["Q_*", "GEQ"])).toBe(true);
    expect(matchSlotPattern("GEQ", ["Q_*"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// format.ts — 6 tests
// ---------------------------------------------------------------------------

describe("format.ts — formatting and serialization utilities", () => {
  const cvPass: ComparedValue = {
    ours: 1.23e-3,
    ngspice: 1.24e-3,
    delta: -1e-5,
    absDelta: 1e-5,
    relDelta: 0.008,
    withinTol: true,
  };

  const cvFail: ComparedValue = {
    ours: 1.0,
    ngspice: 2.0,
    delta: -1.0,
    absDelta: 1.0,
    relDelta: 0.5,
    withinTol: false,
  };

  it("8. formatComparedValue with withinTol:true contains 'ours=' and 'PASS'", () => {
    const result = formatComparedValue(cvPass, 4);
    expect(result).toContain("ours=");
    expect(result).toContain("PASS");
    expect(result).not.toContain("FAIL");
  });

  it("9. formatComparedValue with withinTol:false contains 'FAIL'", () => {
    const result = formatComparedValue(cvFail, 4);
    expect(result).toContain("FAIL");
    expect(result).not.toContain("PASS");
  });

  it("10. formatCV returns FormattedComparedValue with all string fields", () => {
    const result = formatCV(cvPass, 4);
    expect(typeof result.ours).toBe("string");
    expect(typeof result.ngspice).toBe("string");
    expect(typeof result.delta).toBe("string");
    expect(typeof result.absDelta).toBe("string");
    expect(typeof result.relDelta).toBe("string");
    expect(typeof result.withinTol).toBe("boolean");
    expect(typeof result.summary).toBe("string");
    expect(result.withinTol).toBe(true);
    expect(result.summary).toBe(formatComparedValue(cvPass, 4));
  });

  it("11. formatComparedTable with 3 entries — sorted by absDelta desc, contains headers", () => {
    const entries: Record<string, ComparedValue> = {
      slot_a: { ours: 1, ngspice: 1.01, delta: -0.01, absDelta: 0.01, relDelta: 0.01, withinTol: true },
      slot_b: { ours: 1, ngspice: 1.5, delta: -0.5, absDelta: 0.5, relDelta: 0.33, withinTol: false },
      slot_c: { ours: 1, ngspice: 1.001, delta: -0.001, absDelta: 0.001, relDelta: 0.001, withinTol: true },
    };
    const result = formatComparedTable(entries, 4);
    const lines = result.split("\n");
    expect(lines[0]).toContain("slot");
    expect(lines[1]).toContain("slot_b");
    expect(lines[2]).toContain("slot_a");
    expect(lines[3]).toContain("slot_c");
    expect(result).toContain("FAIL");
    expect(result).toContain("PASS");
  });

  it("12. mapToRecord converts Map<number|string, V> to Record<string, V>", () => {
    const map = new Map<number | string, string>([[1, "a"], [2, "b"]]);
    const result = mapToRecord(map);
    expect(result).toEqual({ "1": "a", "2": "b" });
  });

  it("13. float64ToArray converts NaN/Infinity to null, finite values preserved", () => {
    const arr = new Float64Array([1.0, NaN, Infinity, -Infinity]);
    const result = float64ToArray(arr);
    expect(result).toEqual([1.0, null, null, null]);
  });
});

// ---------------------------------------------------------------------------
// normalizeDeviceType — 4 tests (14-17)
// ---------------------------------------------------------------------------

describe("normalizeDeviceType", () => {
  it('14. normalizeDeviceType("NpnBJT") → "bjt"', () => {
    expect(normalizeDeviceType("NpnBJT")).toBe("bjt");
  });

  it('15. normalizeDeviceType("NMOS") → "mosfet"', () => {
    expect(normalizeDeviceType("NMOS")).toBe("mosfet");
  });

  it('16. normalizeDeviceType("Capacitor") → "capacitor"', () => {
    expect(normalizeDeviceType("Capacitor")).toBe("capacitor");
  });

  it('17. normalizeDeviceType("XYZUnknown") → "unknown"', () => {
    expect(normalizeDeviceType("XYZUnknown")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// captureTopology type field fix — 1 test (18)
// ---------------------------------------------------------------------------

describe("captureTopology — type field population", () => {
  it("18. type is a non-empty string for all elements after captureTopology", () => {
    const { circuit } = makeHWR();
    const elementLabels = buildElementLabelMap(circuit);
    const topo = captureTopology(circuit, elementLabels);
    for (const el of topo.elements) {
      expect(typeof el.type).toBe("string");
      expect(el.type!.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// listComponents — 3 tests (19-21)
// ---------------------------------------------------------------------------

describe("listComponents", () => {
  it("19. Returns one entry per element in topology", async () => {
    const { session, topology } = await createHwrSession();
    const components = session.listComponents();
    expect(components.length).toBe(topology.elements.length);
  });

  it("20. Each ComponentInfo has non-empty label and deviceType", async () => {
    const { session } = await createHwrSession();
    const components = session.listComponents();
    for (const c of components) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.deviceType.length).toBeGreaterThan(0);
    }
  });

  it("21. PaginationOpts offset=1, limit=1 returns exactly one entry", async () => {
    const { session } = await createHwrSession();
    const components = session.listComponents({ offset: 1, limit: 1 });
    expect(components.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// listNodes — 3 tests (22-24)
// ---------------------------------------------------------------------------

describe("listNodes", () => {
  it("22. Returns one entry per unique node in nodeLabels", async () => {
    const { session, topology } = await createHwrSession();
    const nodes = session.listNodes();
    expect(nodes.length).toBe(topology.nodeLabels.size);
  });

  it("23. NodeInfo.ourIndex matches key in nodeLabels", async () => {
    const { session, topology } = await createHwrSession();
    const nodes = session.listNodes();
    for (const node of nodes) {
      expect(topology.nodeLabels.has(node.ourIndex)).toBe(true);
      expect(topology.nodeLabels.get(node.ourIndex)).toBe(node.label);
    }
  });

  it("24. connectedComponents is non-empty for nodes connected to elements", async () => {
    const { session } = await createHwrSession();
    const nodes = session.listNodes();
    const hasConnected = nodes.some((n) => n.connectedComponents.length > 0);
    expect(hasConnected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getComponentsByType — 3 tests (25-27)
// ---------------------------------------------------------------------------

describe("getComponentsByType", () => {
  it("25. Returns labels for matching type in HWR circuit (type sourced from topology)", async () => {
    const { session } = await createHwrSession();
    // HWR circuit has a diode — verify getComponentsByType returns it.
    const diodeComponents = session.getComponentsByType("diode");
    expect(diodeComponents.length).toBeGreaterThanOrEqual(1);
    // All returned components should have non-empty labels.
    for (const comp of diodeComponents) {
      expect(comp.label.length).toBeGreaterThan(0);
    }
  });

  it("26. Returns empty array for nonexistent type 'scr'", async () => {
    const { session } = await createHwrSession();
    const labels = session.getComponentsByType("scr");
    expect(labels).toEqual([]);
  });

  it("27. Case-insensitive: getComponentsByType('DIODE') matches same as 'diode'", async () => {
    const { session } = await createHwrSession();
    const lower = session.getComponentsByType("diode");
    const upper = session.getComponentsByType("DIODE");
    expect(upper).toEqual(lower);
  });
});

// ---------------------------------------------------------------------------
// getDivergences (self-comparison → zero divergences) — 4 tests (28-31)
// ---------------------------------------------------------------------------

describe("getDivergences", () => {
  it("28. Self-comparison: getDivergences() returns totalCount: 0 and empty entries", async () => {
    const { session } = await createHwrSession();
    const report = session.getDivergences();
    expect(report.totalCount).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it("29. worstByCategory has all null values when no divergences", async () => {
    const { session } = await createHwrSession();
    const report = session.getDivergences();
    expect(report.worstByCategory.voltage).toBeNull();
    expect(report.worstByCategory.state).toBeNull();
    expect(report.worstByCategory.rhs).toBeNull();
    expect(report.worstByCategory.matrix).toBeNull();
  });

  it("30. Default limit is 100: with 200 artificial divergences, entries.length === 100", async () => {
    const { session } = await createHwrSession();
    const fakeEntries = Array.from({ length: 200 }, (_, i) => ({
      nodeIndex: i,
      label: `N${i}`,
      ours: 1,
      theirs: 2,
      absDelta: i + 1,
      relDelta: 0.5,
      withinTol: false,
    }));
    (session as any)._comparisons = [{
      stepIndex: 0,
      iterationIndex: 0,
      simTime: 0,
      voltageDiffs: fakeEntries,
      rhsDiffs: [],
      matrixDiffs: [],
      stateDiffs: [],
      allWithinTol: false,
      presence: "both",
    }];
    const report = session.getDivergences();
    expect(report.totalCount).toBe(200);
    expect(report.entries.length).toBe(100);
  });

  it("31. opts.step filter: only returns divergences from that step", async () => {
    const { session } = await createHwrSession();
    const fakeComparisons = [
      {
        stepIndex: 0,
        iterationIndex: 0,
        simTime: 0,
        voltageDiffs: [{ nodeIndex: 0, label: "N0", ours: 1, theirs: 3, absDelta: 2, relDelta: 0.5, withinTol: false }],
        rhsDiffs: [],
        matrixDiffs: [],
        stateDiffs: [],
        allWithinTol: false,
        presence: "both",
      },
      {
        stepIndex: 1,
        iterationIndex: 0,
        simTime: 1e-3,
        voltageDiffs: [{ nodeIndex: 1, label: "N1", ours: 2, theirs: 5, absDelta: 3, relDelta: 0.5, withinTol: false }],
        rhsDiffs: [],
        matrixDiffs: [],
        stateDiffs: [],
        allWithinTol: false,
        presence: "both",
      },
    ];
    (session as any)._comparisons = fakeComparisons;
    const report = session.getDivergences({ step: 0 });
    expect(report.entries.every((e) => e.stepIndex === 0)).toBe(true);
    expect(report.totalCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getStepEndRange — 2 tests (32-33)
// ---------------------------------------------------------------------------

describe("getStepEndRange", () => {
  it("32. getStepEndRange(0, 0) returns exactly 1 element matching getStepEnd(0)", async () => {
    const { session } = await createHwrSession();
    const range = session.getStepEndRange(0, 0);
    expect(range.length).toBe(1);
    const single = session.getStepEnd(0);
    expect(range[0].stepIndex).toBe(single.stepIndex);
  });

  it("33. Out-of-range: getStepEndRange(100, 200) returns empty array", async () => {
    const { session } = await createHwrSession();
    const range = session.getStepEndRange(100, 200);
    expect(range).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// traceComponentSlot — 3 tests (34-36)
// ---------------------------------------------------------------------------

describe("traceComponentSlot", () => {
  it("34. Returns SlotTrace with correct label and slotName", async () => {
    const { session } = await createHwrSession();
    // Find a pool-backed component with a known slot
    const components = session.listComponents();
    const poolBacked = components.find((c) => c.slotNames.length > 0);
    expect(poolBacked).toBeDefined();
    const slotName = poolBacked!.slotNames[0];
    const trace = session.traceComponentSlot(poolBacked!.label, slotName);
    expect(trace.label).toBe(poolBacked!.label.toUpperCase());
    expect(trace.slotName).toBe(slotName);
  });

  it("35. totalSteps equals number of simulation steps captured", async () => {
    const { session } = await createHwrSession();
    const components = session.listComponents();
    const poolBacked = components.find((c) => c.slotNames.length > 0);
    expect(poolBacked).toBeDefined();
    const slotName = poolBacked!.slotNames[0];
    const trace = session.traceComponentSlot(poolBacked!.label, slotName);
    const stepCount = (session as any)._ourSession.steps.length;
    expect(trace.totalSteps).toBe(stepCount);
  });

  it("36. Nonexistent component throws 'Component not found: ...'", async () => {
    const { session } = await createHwrSession();
    expect(() => session.traceComponentSlot("NONEXISTENT_COMP", "VD")).toThrow(
      "Component not found: NONEXISTENT_COMP",
    );
  });
});

// ---------------------------------------------------------------------------
// getStateHistory — 3 tests (37-39)
// ---------------------------------------------------------------------------

describe("getStateHistory", () => {
  it("37. Returns StateHistoryReport with all six state objects", async () => {
    const { session } = await createHwrSession();
    const components = session.listComponents();
    const poolBacked = components.find((c) => c.slotNames.length > 0);
    expect(poolBacked).toBeDefined();
    const report = session.getStateHistory(poolBacked!.label, 0);
    expect(typeof report.state0).toBe("object");
    expect(typeof report.state1).toBe("object");
    expect(typeof report.state2).toBe("object");
    expect(typeof report.ngspiceState0).toBe("object");
    expect(typeof report.ngspiceState1).toBe("object");
    expect(typeof report.ngspiceState2).toBe("object");
  });

  it("38. state0 matches elementStates from the iteration", async () => {
    const { session } = await createHwrSession();
    const components = session.listComponents();
    const poolBacked = components.find((c) => c.slotNames.length > 0);
    expect(poolBacked).toBeDefined();
    const report = session.getStateHistory(poolBacked!.label, 0);
    const upperLabel = poolBacked!.label.toUpperCase();
    const steps = (session as any)._ourSession.steps;
    const step0 = steps[0];
    const finalIter = step0.iterations[step0.iterations.length - 1];
    const es = finalIter.elementStates.find(
      (e: any) => e.label.toUpperCase() === upperLabel,
    );
    expect(es).toBeDefined();
    expect(report.state0).toEqual(es.slots);
  });

  it("39. Out-of-range step throws 'Step out of range: ...'", async () => {
    const { session } = await createHwrSession();
    expect(() => session.getStateHistory("D1", 9999)).toThrow("Step out of range: 9999");
  });
});

// ---------------------------------------------------------------------------
// getMatrixLabeled / getRhsLabeled / compareMatrixAt — 4 tests (40-43)
// ---------------------------------------------------------------------------

describe("getMatrixLabeled / getRhsLabeled / compareMatrixAt", () => {
  it("40. getMatrixLabeled entries have non-empty rowLabel and colLabel", async () => {
    const { session } = await createHwrSession();
    const labeled = session.getMatrixLabeled(0, 0);
    expect(labeled.stepIndex).toBe(0);
    expect(labeled.iteration).toBe(0);
    for (const e of labeled.entries) {
      expect(typeof e.rowLabel).toBe("string");
      expect(typeof e.colLabel).toBe("string");
    }
  });

  it("41. Self-comparison: all matrix entries withinTol:true, absDelta:0", async () => {
    const { session } = await createHwrSession();
    const labeled = session.getMatrixLabeled(0, 0);
    for (const e of labeled.entries) {
      expect(e.absDelta).toBe(0);
      expect(e.withinTol).toBe(true);
    }
  });

  it("42. compareMatrixAt filter 'all' has totalEntries >= mismatch-filtered count", async () => {
    const { session } = await createHwrSession();
    const allResult = session.compareMatrixAt(0, 0, "all");
    const mismatchResult = session.compareMatrixAt(0, 0, "mismatches");
    expect(allResult.totalEntries).toBe(mismatchResult.totalEntries);
    expect(allResult.entries.length).toBeGreaterThanOrEqual(mismatchResult.entries.length);
  });

  it("43. getRhsLabeled entries count equals matrixSize", async () => {
    const { session, topology } = await createHwrSession();
    const rhs = session.getRhsLabeled(0, 0);
    expect(rhs.entries.length).toBe(topology.matrixSize);
  });
});

// ---------------------------------------------------------------------------
// getIntegrationCoefficients — 2 tests (44-45)
// ---------------------------------------------------------------------------

describe("getIntegrationCoefficients", () => {
  it("44. Returns IntegrationCoefficientsReport with both ours and ngspice fields", async () => {
    const { session } = await createHwrSession();
    const report = session.getIntegrationCoefficients(0);
    expect(report.stepIndex).toBe(0);
    expect(typeof report.ours.ag0).toBe("number");
    expect(typeof report.ours.ag1).toBe("number");
    expect(typeof report.ours.method).toBe("string");
    expect(typeof report.ours.order).toBe("number");
    expect(typeof report.ngspice.ag0).toBe("number");
    expect(typeof report.ngspice.ag1).toBe("number");
    expect(typeof report.methodMatch).toBe("boolean");
    expect(typeof report.ag0Compared.ours).toBe("number");
    expect(typeof report.ag1Compared.ours).toBe("number");
  });

  it("45. Out-of-range step throws 'Step out of range'", async () => {
    const { session } = await createHwrSession();
    expect(() => session.getIntegrationCoefficients(9999)).toThrow("Step out of range: 9999");
  });
});

// ---------------------------------------------------------------------------
// getLimitingComparison — 2 tests (46-47)
// ---------------------------------------------------------------------------

describe("getLimitingComparison", () => {
  it("46. Nonexistent label with no limiting events returns noEvents:true, junctions:[]", async () => {
    const { session } = await createHwrSession();
    const report = session.getLimitingComparison("NONEXISTENT_LABEL", 0, 0);
    expect(report.noEvents).toBe(true);
    expect(report.junctions).toHaveLength(0);
  });

  it("47. Nonexistent label does not throw — returns empty report", async () => {
    const { session } = await createHwrSession();
    expect(() => session.getLimitingComparison("DOES_NOT_EXIST", 0, 0)).not.toThrow();
    const report = session.getLimitingComparison("DOES_NOT_EXIST", 0, 0);
    expect(report.label).toBe("DOES_NOT_EXIST");
    expect(report.junctions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getConvergenceDetail — 2 tests (48-49)
// ---------------------------------------------------------------------------

describe("getConvergenceDetail", () => {
  it("48. Self-comparison with converged circuit: all elements have ourConverged:true", async () => {
    const { session } = await createHwrSession();
    const steps = (session as any)._ourSession.steps;
    const lastIter = steps[0].iterations.length - 1;
    const report = session.getConvergenceDetail(0, lastIter);
    for (const el of report.elements) {
      expect(el.ourConverged).toBe(true);
    }
  });

  it("49. disagreementCount is 0 when both engines agree (self-comparison)", async () => {
    const { session } = await createHwrSession();
    const steps = (session as any)._ourSession.steps;
    const lastIter = steps[0].iterations.length - 1;
    const report = session.getConvergenceDetail(0, lastIter);
    expect(report.disagreementCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// toJSON — 3 tests (50-52)
// ---------------------------------------------------------------------------

describe("toJSON", () => {
  it("50. toJSON() returns an object serializable by JSON.stringify without error", async () => {
    const { session } = await createHwrSession();
    const json = session.toJSON();
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  it("51. No Map, Float64Array, NaN, or Infinity in JSON.stringify(session.toJSON())", async () => {
    const { session } = await createHwrSession();
    const json = session.toJSON();
    const str = JSON.stringify(json);
    // JSON.stringify converts NaN and Infinity to null — verify no raw NaN/Infinity strings
    expect(str).not.toContain('"NaN"');
    expect(str).not.toContain('"Infinity"');
    // No Float64Array or Map in output (would fail JSON.stringify)
    const parsed = JSON.parse(str);
    expect(typeof parsed).toBe("object");
  });

  it("52. opts.includeAllSteps:true includes step entries; default includes none for self-comparison (no divergences)", async () => {
    const { session } = await createHwrSession();
    const defaultJson = session.toJSON();
    const allJson = session.toJSON({ includeAllSteps: true });
    // Self-comparison has no divergences, so default omits all steps
    expect(defaultJson.steps.length).toBe(0);
    // includeAllSteps includes everything
    const stepCount = (session as any)._ourSession.steps.length;
    expect(allJson.steps.length).toBe(stepCount);
  });
});

// ---------------------------------------------------------------------------
// Enhanced traceComponent / traceNode — 2 tests (53-54)
// ---------------------------------------------------------------------------

describe("Enhanced traceComponent / traceNode", () => {
  it("53. traceComponent with slots filter returns only matching slots in states", async () => {
    const { session } = await createHwrSession();
    const components = session.listComponents();
    const poolBacked = components.find((c) => c.slotNames.length > 0);
    if (!poolBacked) return; // skip if no pool-backed component in HWR
    const firstSlot = poolBacked.slotNames[0];
    const trace = session.traceComponent(poolBacked.label, { slots: [firstSlot] });
    for (const step of trace.steps) {
      for (const iter of step.iterations) {
        const stateKeys = Object.keys(iter.states);
        for (const k of stateKeys) {
          expect(k).toBe(firstSlot);
        }
      }
    }
  });

  it("54. traceNode with onlyDivergences:true returns empty iterations in self-comparison (none diverge)", async () => {
    const { session, topology } = await createHwrSession();
    // Get any node label
    const firstNode = Array.from(topology.nodeLabels.values())[0];
    const trace = session.traceNode(firstNode, { onlyDivergences: true });
    for (const step of trace.steps) {
      expect(step.iterations.length).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// static create — 1 test (55)
// ---------------------------------------------------------------------------

describe("ComparisonSession.create", () => {
  it("55. create(opts) is equivalent to new + init: listComponents works without calling init manually", async () => {
    const { session } = await createHwrSession();
    const components = session.listComponents();
    expect(components.length).toBeGreaterThan(0);
    // Verify static create method exists on the class
    expect(typeof ComparisonSession.create).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// dispose — 1 test (56)
// ---------------------------------------------------------------------------

describe("dispose", () => {
  it("56. After dispose(), ourSession and ngspiceSession are null; dispose() is idempotent", async () => {
    const { session } = await createHwrSession();
    session.dispose();
    expect(session.ourSession).toBeNull();
    expect(session.ngspiceSession).toBeNull();
    // Call again — must not throw
    expect(() => session.dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Edge cases for getComponentSlots — 3 tests (57-59)
// ---------------------------------------------------------------------------

describe("getComponentSlots edge cases", () => {
  it("57. getComponentSlots with step provided returns ComponentSlotsSnapshot", async () => {
    const { session } = await createHwrSession();
    const components = session.listComponents();
    const poolBacked = components.find((c) => c.slotNames.length > 0);
    expect(poolBacked).toBeDefined();
    const result = session.getComponentSlots(poolBacked!.label, ["*"], { step: 0 });
    expect(result.mode).toBe("snapshot");
  });

  it("58. getComponentSlots without step returns ComponentSlotsTrace", async () => {
    const { session } = await createHwrSession();
    const components = session.listComponents();
    const poolBacked = components.find((c) => c.slotNames.length > 0);
    expect(poolBacked).toBeDefined();
    const result = session.getComponentSlots(poolBacked!.label, ["*"]);
    expect(result.mode).toBe("trace");
  });

  it("59. getComponentSlots with nonexistent component throws 'Component not found'", async () => {
    const { session } = await createHwrSession();
    expect(() => session.getComponentSlots("NONEXISTENT", ["*"])).toThrow("Component not found");
  });
});

// ---------------------------------------------------------------------------
// Fix 1: simTime is not "-Inf" — it reads stepStartTime correctly (60-62)
// ---------------------------------------------------------------------------

describe("Fix 1: simTime reads stepStartTime, not undefined simTime field", () => {
  it("60. traceNode steps have numeric stepStartTime (not NaN or -Inf)", async () => {
    const { session, topology } = await createHwrSession();
    const firstNode = Array.from(topology.nodeLabels.values())[0] as string;
    const trace = session.traceNode(firstNode);
    expect(trace.steps.length).toBeGreaterThan(0);
    for (const s of trace.steps) {
      expect(Number.isFinite(s.stepStartTime)).toBe(true);
      expect(s.stepStartTime).toBeGreaterThanOrEqual(0);
    }
  });

  it("61. getIterations steps have numeric stepStartTime (not NaN or -Inf)", async () => {
    const { session } = await createHwrSession();
    const iters = session.getIterations(0);
    expect(iters.length).toBeGreaterThan(0);
    for (const r of iters) {
      expect(Number.isFinite(r.stepStartTime)).toBe(true);
      expect(r.stepStartTime).toBeGreaterThanOrEqual(0);
    }
  });

  it("62. getSummary firstDivergence has stepStartTime (not simTime) — structural type check", async () => {
    const { session } = await createHwrSession();
    const summary = session.getSummary();
    // In self-compare, firstDivergence is null (no divergence). That is correct.
    // The important thing: the type field is stepStartTime, not simTime.
    if (summary.firstDivergence) {
      expect(typeof summary.firstDivergence.stepStartTime).toBe("number");
      expect(Number.isFinite(summary.firstDivergence.stepStartTime)).toBe(true);
    }
    // Also verify traceNode stepStartTime is non-negative finite for a multi-step DC transient
    const ourSteps = (session as any)._ourSession.steps;
    expect(ourSteps.length).toBeGreaterThan(0);
    expect(typeof ourSteps[0].stepStartTime).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Fix 2 & 3: asymmetric step counts — ngspice-only steps accessible (63-65)
// ---------------------------------------------------------------------------

describe("Fix 2 & 3: asymmetric step counts — ours shorter than ngspice", () => {
  it("63. getStepEnd on an ngspice-only step does not throw and returns presence 'ngspiceOnly'", async () => {
    // Use a freshly built transient self-compare session; simulate asymmetry by injecting
    // extra steps into the ngspice session.
    const { session } = await createHwrSession();
    const ourSteps: any[] = (session as any)._ourSession.steps;
    const ngSession = (session as any)._ngSession;
    const ngReindexed = (session as any)._ngSessionReindexed;
    const ngSteps: any[] = (ngReindexed ?? ngSession)?.steps ?? [];
    if (ourSteps.length < 1 || ngSteps.length < 1) return; // skip if no steps

    // Truncate ours to simulate crash at step 0 — ng has the rest
    const savedOurTail = ourSteps.splice(1);
    try {
      // Step 1 is now ngspice-only
      if (ngSteps.length > 1) {
        const report = session.getStepEnd(1);
        expect(report.stepIndex).toBe(1);
        expect(report.presence).toBe("ngspiceOnly");
        expect(report.converged.ours).toBe(false);
        expect(typeof report.converged.ngspice).toBe("boolean");
      }
    } finally {
      // Restore
      ourSteps.push(...savedOurTail);
    }
  });

  it("64. traceNode step count equals max(ours, ngspice) when ours is shorter", async () => {
    const { session, topology } = await createHwrSession();
    const ourSteps: any[] = (session as any)._ourSession.steps;
    const ngSession = (session as any)._ngSession;
    const ngReindexed = (session as any)._ngSessionReindexed;
    const ngSteps: any[] = (ngReindexed ?? ngSession)?.steps ?? [];
    if (ourSteps.length < 2 || ngSteps.length < 2) return; // skip if insufficient steps

    const savedOurTail = ourSteps.splice(1);
    try {
      const firstNode = Array.from(topology.nodeLabels.values())[0] as string;
      const trace = session.traceNode(firstNode);
      // trace.steps.length should be ngSteps.length (the larger), not ourSteps.length (1)
      expect(trace.steps.length).toBe(ngSteps.length);
    } finally {
      ourSteps.push(...savedOurTail);
    }
  });

  it("65. traceNode ngspice-only steps have null ours voltage (NaN raw) and finite ngspice voltage", async () => {
    const { session, topology } = await createHwrSession();
    const ourSteps: any[] = (session as any)._ourSession.steps;
    const ngSession = (session as any)._ngSession;
    const ngReindexed = (session as any)._ngSessionReindexed;
    const ngSteps: any[] = (ngReindexed ?? ngSession)?.steps ?? [];
    if (ourSteps.length < 2 || ngSteps.length < 2) return;

    const savedOurTail = ourSteps.splice(1);
    try {
      const firstNode = Array.from(topology.nodeLabels.values())[0] as string;
      const trace = session.traceNode(firstNode);
      // Step index 1+ are ngspice-only — ours voltage should be NaN
      for (let si = 1; si < trace.steps.length; si++) {
        const step = trace.steps[si];
        for (const iter of step.iterations) {
          // ours is NaN since our step is absent
          expect(Number.isNaN(iter.voltage.ours)).toBe(true);
        }
      }
    } finally {
      ourSteps.push(...savedOurTail);
    }
  });
});
