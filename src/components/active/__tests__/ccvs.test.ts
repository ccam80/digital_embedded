/**
 * Tests for Current-Controlled Voltage Source (CCVS) analog element.
 *
 * Circuit pattern:
 *   Vs → R_sense → node2 (sense VSRC forces V(node2)=0 to measure I_sense)
 *   CCVS out+ → R_load → GND
 *
 * The new setup/load split contract:
 *   - CCVS factory takes (pinNodes, props, getTime) — 3-param signature.
 *   - senseSourceLabel MUST be set via setParam("senseSourceLabel", label) before setup().
 *   - setup() calls ctx.makeCur to allocate CCVS's own branch, then calls
 *     ctx.findBranch(senseSourceLabel) to get the controlling branch.
 *   - load() stamps B/C incidence and Jacobian using cached handles.
 *
 * Node layout:
 *   1 = Vs+
 *   2 = R_sense bottom / sense+ / senseVsrc output node
 *   3 = out+
 *   sense- = GND (0), out- = GND (0)
 *
 * Branch layout (3 branches in the test circuit):
 *   branch at vsBranch     = Vs branch
 *   branch at senseBranch  = senseVsrc (lazily allocated via findBranchFor)
 *   branch at ccvsBranch   = CCVS own output branch (allocated in CCVS setup())
 */

import { describe, it, expect } from "vitest";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import { CCVSDefinition } from "../ccvs.js";
import { CCVSAnalogElement } from "../ccvs.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../../solver/analog/element.js";
import type { SetupContext } from "../../../solver/analog/setup-context.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../sources/dc-voltage-source.js";
import { ResistorDefinition, RESISTOR_DEFAULTS } from "../../passives/resistor.js";
import type { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/compiled-analog-circuit.js";
import { StatePool } from "../../../solver/analog/state-pool.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// makeResistor — create a resistor element between two nodes.
// ---------------------------------------------------------------------------
function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const props = new PropertyBag([]);
  props.replaceModelParams({ ...RESISTOR_DEFAULTS, resistance });
  const el = getFactory(ResistorDefinition.modelRegistry!["behavioral"]!)(
    new Map([["A", nodeA], ["B", nodeB]]),
    props,
    () => 0,
  );
  return el;
}

// ---------------------------------------------------------------------------
// makeVsrc — DC voltage source helper
// ---------------------------------------------------------------------------
function makeVsrc(posNode: number, negNode: number, voltage: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS, voltage });
  return makeDcVoltageSource(new Map([["pos", posNode], ["neg", negNode]]), props, () => 0);
}

// ---------------------------------------------------------------------------
// makeSenseVsrc — minimal sense VSRC with findBranchFor on the instance.
//
// CCVS has NGSPICE_LOAD_ORDER=19, which runs BEFORE VSRC (48). So when CCVS
// setup() calls ctx.findBranch(senseLabel), the sense source's setup() has
// not run yet. The lazy findBranchFor callback allocates the branch on demand.
// ---------------------------------------------------------------------------

function makeSenseVsrc(
  nodePlus: number,
  nodeMinus: number,
  label: string,
): AnalogElement & { branchIndex: number; findBranchFor(name: string, ctx: SetupContext): number } {
  let branchIndex = -1;
  // Handles allocated in setup(), written through in load().
  let hPIbr = -1; // B[nodePlus, k]
  let hNIbr = -1; // B[nodeMinus, k]
  let hIbrP = -1; // C[k, nodePlus]
  let hIbrN = -1; // C[k, nodeMinus]
  return {
    get branchIndex(): number { return branchIndex; },
    set branchIndex(v: number) { branchIndex = v; },
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VSRC,
    _pinNodes: new Map([[String(nodePlus), nodePlus], [String(nodeMinus), nodeMinus]]),
    _stateBase: -1,
    label,
    setParam(_key: string, _value: number): void {},

    setup(ctx: SetupContext): void {
      if (branchIndex === -1) {
        branchIndex = ctx.makeCur(label, "branch");
      }
      const k = branchIndex;
      const { solver } = ctx;
      if (nodePlus !== 0)   hPIbr = solver.allocElement(nodePlus,  k);
      if (nodeMinus !== 0)  hNIbr = solver.allocElement(nodeMinus, k);
      if (nodePlus !== 0)   hIbrP = solver.allocElement(k, nodePlus);
      if (nodeMinus !== 0)  hIbrN = solver.allocElement(k, nodeMinus);
    },

    findBranchFor(_name: string, ctx: SetupContext): number {
      if (branchIndex === -1) {
        branchIndex = ctx.makeCur(label, "branch");
      }
      return branchIndex;
    },

    load(ctx: LoadContext): void {
      const k = branchIndex;
      if (k <= 0) return;
      const { solver, rhs } = ctx;
      if (hPIbr !== -1) solver.stampElement(hPIbr,  1);
      if (hNIbr !== -1) solver.stampElement(hNIbr, -1);
      if (hIbrP !== -1) solver.stampElement(hIbrP,  1);
      if (hIbrN !== -1) solver.stampElement(hIbrN, -1);
      rhs[k] += 0; // 0V sense source
    },

    getPinCurrents(rhs: Float64Array): number[] {
      const I = branchIndex > 0 ? rhs[branchIndex] : 0;
      return [I, -I];
    },
  } as AnalogElement & { branchIndex: number; findBranchFor(name: string, ctx: SetupContext): number };
}

// ---------------------------------------------------------------------------
// buildCircuit
// ---------------------------------------------------------------------------

function buildCircuit(opts: {
  nodeCount: number;
  branchCount: number;
  elements: AnalogElement[];
}): ConcreteCompiledAnalogCircuit {
  return {
    nodeCount: opts.nodeCount,
    branchCount: opts.branchCount,
    elements: opts.elements,
    labelToNodeId: new Map(),
    labelPinNodes: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    statePool: new StatePool(0),
    componentCount: opts.elements.length,
    netCount: opts.nodeCount,
    diagnostics: [],
    matrixSize: opts.nodeCount + opts.branchCount,
    bridgeOutputAdapters: [],
    bridgeInputAdapters: [],
    elementToCircuitElement: new Map(),
    resolvedPins: [],
  } as unknown as ConcreteCompiledAnalogCircuit;
}

// ---------------------------------------------------------------------------
// makeCCVSElement — create a CCVSAnalogElement via the factory with real
//                   setup contract: senseSourceLabel set via setParam.
// ---------------------------------------------------------------------------

function makeCCVSElement(
  nSenseP: number,
  nSenseN: number,
  nOutP: number,
  nOutN: number,
  senseSourceLabel: string,
  opts: { transresistance?: number; expression?: string } = {},
): CCVSAnalogElement {
  const rm = opts.transresistance ?? 1000;
  const expression = opts.expression ?? "I(sense)";
  const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>([
    ["expression", expression],
    ["label", "ccvs1"],
  ]).entries());
  props.replaceModelParams({ transresistance: rm });

  const core = getFactory(CCVSDefinition.modelRegistry!["behavioral"]!)(
    new Map([["sense+", nSenseP], ["sense-", nSenseN], ["out+", nOutP], ["out-", nOutN]]),
    props,
    () => 0,
  );
  const el = core as CCVSAnalogElement;
  el.label = "ccvs1";
  el.setParam("senseSourceLabel", senseSourceLabel);
  return el;
}

// ---------------------------------------------------------------------------
// Standard CCVS test circuit:
//
// Nodes: 1=Vs+, 2=sense+/R_sense bottom, 3=out+
//   Vs: node1→GND, source voltage 5V
//   R_sense: node1→node2
//   senseVsrc (0V): node2→GND  (forces V(node2)=0, measures I_sense = Vs/R_sense)
//   CCVS: senses senseVsrc branch; output voltage V_out = rm * I_sense → node3→GND
//   (no R_load needed — CCVS is a stiff voltage source)
//
// Branch layout (3 branches):
//   branch 0 = Vs branch (absolute index 4 in 1-based with nodeCount=3)
//   branch 1 = senseVsrc branch (lazily allocated)
//   branch 2 = CCVS own output branch (allocated in CCVS setup())
// ---------------------------------------------------------------------------

function makeTransresistanceCircuit(opts: { transresistance?: number; expression?: string }) {
  const nodeCount = 3;
  const branchCount = 3;

  const vs        = makeVsrc(1, 0, 5.0);
  vs.label = "vs1";
  const rSense    = makeResistor(1, 2, 5000);
  const senseVsrc = makeSenseVsrc(2, 0, "senseVsrc");
  const ccvs      = makeCCVSElement(2, 0, 3, 0, "senseVsrc", opts);

  return buildCircuit({ nodeCount, branchCount, elements: [vs, rSense, senseVsrc, ccvs] });
}

// ---------------------------------------------------------------------------
// CCVS tests
// ---------------------------------------------------------------------------

describe("CCVS", () => {
  it("transresistance_1k", () => {
    // I_sense = 5V/5kΩ = 1mA, rm=1000Ω → V_out = 1mA*1kΩ = 1V
    const compiled = makeTransresistanceCircuit({ transresistance: 1000 });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
  });

  it("zero_current_zero_output", () => {
    // Vs=0V → I_sense=0 → V_out=0
    const nodeCount = 3;
    const branchCount = 3;

    const vs        = makeVsrc(1, 0, 0.0);
    vs.label = "vs1";
    const rSense    = makeResistor(1, 2, 5000);
    const senseVsrc = makeSenseVsrc(2, 0, "senseVsrc");
    const ccvs      = makeCCVSElement(2, 0, 3, 0, "senseVsrc", { transresistance: 1000 });

    const compiled  = buildCircuit({ nodeCount, branchCount, elements: [vs, rSense, senseVsrc, ccvs] });
    const engine    = new MNAEngine();
    engine.init(compiled);
    const result    = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
  });

  it("sense_port_zero_voltage_drop", () => {
    // The 0V sense source enforces V(sense+) = V(sense-) = 0V.
    // With sense-=GND, V(node2) must equal 0V.
    const compiled = makeTransresistanceCircuit({ transresistance: 1000 });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
  });

  it("setup_throws_without_senseSourceLabel", () => {
    // If senseSourceLabel is not set, setup() must throw.
    const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>([
      ["expression", "I(sense)"],
      ["label", "ccvs_bad"],
    ]).entries());
    props.replaceModelParams({ transresistance: 1000 });

    const core = getFactory(CCVSDefinition.modelRegistry!["behavioral"]!)(
      new Map([["sense+", 1], ["sense-", 0], ["out+", 2], ["out-", 0]]),
      props,
      () => 0,
    );
    const el = core as CCVSAnalogElement;
    el.label = "ccvs_bad";
    // Do NOT call setParam("senseSourceLabel", ...) — should throw in setup()

    const senseVsrc = makeSenseVsrc(1, 0, "senseVsrc");
    const compiled = buildCircuit({ nodeCount: 2, branchCount: 2, elements: [senseVsrc, el] });
    const engine = new MNAEngine();
    engine.init(compiled);
    expect(() => engine.dcOperatingPoint()).toThrow(/senseSourceLabel not set/);
  });
});
