/**
 * Tests for Current-Controlled Current Source (CCCS) analog element.
 *
 * Circuit pattern:
 *   Vs → R_sense → node2 (sense VSRC forces V(node2)=0 to measure I_sense)
 *   CCCS out+ → R_load → GND
 *
 * The new setup/load split contract:
 *   - CCCS factory takes (pinNodes, props, getTime) — 3-param signature.
 *   - senseSourceLabel MUST be set via setParam("senseSourceLabel", label) before setup().
 *   - setup() calls ctx.findBranch(senseSourceLabel) which dispatches to the
 *     sense source's findBranchFor callback (lazily allocating the branch).
 *   - load() uses cached handles — no allocElement calls.
 *
 * Node layout:
 *   1 = Vs+
 *   2 = R_sense bottom / sense+ / VSRC output node
 *   3 = out+
 *   sense- = GND (0), out- = GND (0)
 */

import { describe, it, expect } from "vitest";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import { makeResistor, makeVoltageSource } from "../../../solver/analog/__tests__/test-helpers.js";
import { CCCSDefinition } from "../cccs.js";
import { CCCSAnalogElement } from "../cccs.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../../solver/analog/element.js";
import type { SetupContext } from "../../../solver/analog/setup-context.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
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
// withSetup — wrap an AnalogElement that lacks setup() with a no-op setup.
//
// makeVoltageSource from test-helpers does not declare setup() because it
// is a minimal fixture. MNAEngine._setup() calls el.setup(ctx) on every
// element, so all elements entering the engine must expose the method.
// This local wrapper adds a no-op setup() without touching the shared helper.
// ---------------------------------------------------------------------------

function withSetup<T extends AnalogElement>(el: T): T {
  if (typeof (el as any).setup !== "function") {
    (el as any).setup = (_ctx: SetupContext): void => {};
  }
  return el;
}

// ---------------------------------------------------------------------------
// makeSenseVsrc — minimal sense VSRC with findBranchFor on the instance.
//
// CCCS has NGSPICE_LOAD_ORDER=18, which runs BEFORE VSRC (48). So when CCCS
// setup() calls ctx.findBranch(senseLabel), the sense source's setup() has
// not run yet. The lazy findBranchFor callback allocates the branch on demand.
//
// Handles are allocated in setup() / findBranchFor() and cached. load() uses
// only the cached handles — no allocElement calls in load().
// ---------------------------------------------------------------------------

function makeSenseVsrc(
  nodePlus: number,
  nodeMinus: number,
  label: string,
): AnalogElement & { branchIndex: number; findBranchFor(name: string, ctx: SetupContext): number } {
  let branchIndex = -1;
  // Cached stamp handles — allocated in setup() / findBranchFor(), written in load().
  let hPK = -1; // B[nodePlus, k]
  let hNK = -1; // B[nodeMinus, k]
  let hKP = -1; // C[k, nodePlus]
  let hKN = -1; // C[k, nodeMinus]

  function allocHandles(ctx: SetupContext): void {
    if (branchIndex === -1) {
      branchIndex = ctx.makeCur(label, "branch");
    }
    const k = branchIndex;
    if (hPK === -1 && nodePlus !== 0)   hPK = ctx.solver.allocElement(nodePlus, k);
    if (hNK === -1 && nodeMinus !== 0)  hNK = ctx.solver.allocElement(nodeMinus, k);
    if (hKP === -1 && nodePlus !== 0)   hKP = ctx.solver.allocElement(k, nodePlus);
    if (hKN === -1 && nodeMinus !== 0)  hKN = ctx.solver.allocElement(k, nodeMinus);
  }

  return {
    pinNodeIds: [nodePlus, nodeMinus],
    allNodeIds: [nodePlus, nodeMinus],
    get branchIndex(): number { return branchIndex; },
    set branchIndex(v: number) { branchIndex = v; },
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VSRC,
    isNonlinear: false,
    isReactive: false,
    label,
    setParam(_key: string, _value: number): void {},

    setup(ctx: SetupContext): void {
      allocHandles(ctx);
    },

    findBranchFor(_name: string, ctx: SetupContext): number {
      allocHandles(ctx);
      return branchIndex;
    },

    load(ctx: LoadContext): void {
      const k = branchIndex;
      if (k <= 0) return;
      const { solver, rhs } = ctx;
      if (hPK !== -1) solver.stampElement(hPK, 1);
      if (hNK !== -1) solver.stampElement(hNK, -1);
      if (hKP !== -1) solver.stampElement(hKP, 1);
      if (hKN !== -1) solver.stampElement(hKN, -1);
      rhs[k] += 0; // 0V sense source
    },

    getPinCurrents(rhs: Float64Array): number[] {
      const I = branchIndex > 0 ? rhs[branchIndex] : 0;
      return [I, -I];
    },
  } as AnalogElement & { branchIndex: number; findBranchFor(name: string, ctx: SetupContext): number };
}

// ---------------------------------------------------------------------------
// buildCircuit — build a minimal ConcreteCompiledAnalogCircuit.
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
// makeCCCSElement — create a CCCSAnalogElement via the factory with real
//                   setup contract: senseSourceLabel set via setParam.
// ---------------------------------------------------------------------------

function makeCCCSElement(
  nSenseP: number,
  nSenseN: number,
  nOutP: number,
  nOutN: number,
  senseSourceLabel: string,
  opts: { currentGain?: number; expression?: string } = {},
): CCCSAnalogElement {
  const gain = opts.currentGain ?? 1.0;
  const expression = opts.expression ?? "I(sense)";
  const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>([
    ["expression", expression],
    ["label", "cccs1"],
  ]).entries());
  props.replaceModelParams({ currentGain: gain });

  const core = getFactory(CCCSDefinition.modelRegistry!["behavioral"]!)(
    new Map([["sense+", nSenseP], ["sense-", nSenseN], ["out+", nOutP], ["out-", nOutN]]),
    props,
    () => 0,
  );
  const el = core as CCCSAnalogElement;
  el.label = "cccs1";
  el.setParam("senseSourceLabel", senseSourceLabel);
  Object.assign(el, {
    pinNodeIds: [nSenseP, nSenseN, nOutP, nOutN],
    allNodeIds: [nSenseP, nSenseN, nOutP, nOutN],
  });
  return el;
}

// ---------------------------------------------------------------------------
// Standard CCCS test circuit:
//
// Nodes: 1=Vs+, 2=sense+/R_sense bottom, 3=out+
//   Vs: node1→GND, source voltage vsVoltage
//   R_sense: node1→node2
//   senseVsrc (0V): node2→GND  (forces V(node2)=0, measures I_sense = Vs/R_sense)
//   CCCS: senses senseVsrc branch current; output: node3→GND
//   R_load: node3→GND
//
// Branch layout (2 branches):
//   branch 0 = Vs branch (vsBranch = nodeCount+0 = 4 in 1-based)
//   branch 1 = sense branch (senseVsrc, allocated lazily by findBranchFor)
// ---------------------------------------------------------------------------

function makeGainCircuit(
  vsVoltage: number,
  rSense: number,
  rLoad: number,
  opts: { currentGain?: number; expression?: string } = {},
): ConcreteCompiledAnalogCircuit {
  const nodeCount = 3;
  const branchCount = 2;
  const vsBranch = nodeCount + 1; // 4 (1-based)

  const vs        = withSetup(makeVoltageSource(1, 0, vsBranch, vsVoltage));
  vs.label = "vs1";
  const rS        = makeResistor(1, 2, rSense);
  const senseVsrc = makeSenseVsrc(2, 0, "senseVsrc");
  const cccs      = makeCCCSElement(2, 0, 3, 0, "senseVsrc", opts);
  const rL        = makeResistor(3, 0, rLoad);

  return buildCircuit({ nodeCount, branchCount, elements: [vs, rS, senseVsrc, cccs, rL] });
}

// ---------------------------------------------------------------------------
// CCCS tests
// ---------------------------------------------------------------------------

describe("CCCS", () => {
  it("current_mirror_gain_1", () => {
    // I_sense = Vs/R_sense = 5V/1kΩ = 5mA, gain=1 → I_out=5mA
    // V_out = I_out * R_load = 5mA * 1kΩ = 5V
    const compiled = makeGainCircuit(5.0, 1000, 1000, { currentGain: 1 });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
  });

  it("current_gain_10", () => {
    // I_sense = 1V/1kΩ = 1mA, gain=10 → I_out=10mA
    // V_out = 10mA * 1kΩ = 10V
    const compiled = makeGainCircuit(1.0, 1000, 1000, { currentGain: 10 });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
  });

  it("nonlinear_expression", () => {
    // expression: 0.1 * I(sense)^2; I_sense = 10V/1kΩ = 10mA
    // I_out = 0.1 * (0.01)^2 = 1e-5 A = 10µA
    const compiled = makeGainCircuit(10.0, 1000, 1000, { expression: "0.1 * I(sense)^2" });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
  });

  it("setup_throws_without_senseSourceLabel", () => {
    // If senseSourceLabel is not set, setup() must throw.
    const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>([
      ["expression", "I(sense)"],
      ["label", "cccs_bad"],
    ]).entries());
    props.replaceModelParams({ currentGain: 1.0 });

    const core = getFactory(CCCSDefinition.modelRegistry!["behavioral"]!)(
      new Map([["sense+", 1], ["sense-", 0], ["out+", 2], ["out-", 0]]),
      props,
      () => 0,
    );
    const el = core as CCCSAnalogElement;
    el.label = "cccs_bad";
    Object.assign(el, {
      pinNodeIds: [1, 0, 2, 0],
      allNodeIds: [1, 0, 2, 0],
    });
    // Do NOT call setParam("senseSourceLabel", ...) — should throw in setup()

    const senseVsrc = makeSenseVsrc(1, 0, "senseVsrc");
    const compiled = buildCircuit({ nodeCount: 2, branchCount: 1, elements: [senseVsrc, el] });
    const engine = new MNAEngine();
    engine.init(compiled);
    expect(() => engine.dcOperatingPoint()).toThrow(/senseSourceLabel not set/);
  });
});
