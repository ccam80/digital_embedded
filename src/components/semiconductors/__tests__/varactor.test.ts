/**
 * Tests for Varactor Diode component.
 *
 * The varactor routes through createDiodeElement with capacitance-tuned
 * defaults (CJO=20pF). All load behaviour lives in diode.ts.
 *
 * Covers:
 *   - VARACTOR_PARAM_DEFS partition layout
 *   - Definition shape
 *   - Setup contract: setup() allocates handles before load() is called
 *   - TSTALLOC ordering: RS=0 (default) → 7 entries collapsing to DIO pattern
 */

import { describe, it, expect } from "vitest";
import { VaractorDefinition, VARACTOR_PARAM_DEFS, VARACTOR_PARAM_DEFAULTS } from "../varactor.js";
import { DIODE_PARAM_DEFAULTS, createDiodeElement } from "../diode.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { SetupContext } from "../../../solver/analog/setup-context.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/analog-engine.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Helper: run real setup() on an element, allocating all handles.
// ---------------------------------------------------------------------------

function runSetup(core: AnalogElementCore, solver: SparseSolver): void {
  let stateCount = 0;
  let nodeCount = 100;
  const ctx: SetupContext = {
    solver,
    temp: 300.15,
    nomTemp: 300.15,
    copyNodesets: false,
    makeVolt(_label: string, _suffix: string): number { return ++nodeCount; },
    makeCur(_label: string, _suffix: string): number { return ++nodeCount; },
    allocStates(n: number): number {
      const off = stateCount;
      stateCount += n;
      return off;
    },
    findBranch(_label: string): number { return 0; },
    findDevice(_label: string) { return null; },
  };
  (core as any).setup(ctx);
}

// ---------------------------------------------------------------------------
// Helper: allocate a StatePool for a single element, run real setup(),
// and call initState.
// ---------------------------------------------------------------------------

function withState(core: AnalogElementCore): { element: ReactiveAnalogElement; pool: StatePool; solver: SparseSolver } {
  const solver = new SparseSolver();
  solver._initStructure();
  runSetup(core, solver);
  const re = core as ReactiveAnalogElement;
  const pool = new StatePool(Math.max(re.stateSize, 1));
  re.stateBaseOffset = 0;
  re.initState(pool);
  return { element: re, pool, solver };
}

// ---------------------------------------------------------------------------
// Helper: build minimal ConcreteCompiledAnalogCircuit for engine._setup()
// ---------------------------------------------------------------------------

function makeMinimalCircuit(
  elements: AnalogElement[],
  nodeCount: number,
): ConcreteCompiledAnalogCircuit {
  return {
    nodeCount,
    elements,
    labelToNodeId: new Map(),
    labelPinNodes: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    statePool: null,
    componentCount: elements.length,
    netCount: nodeCount,
    diagnostics: [],
    branchCount: 0,
    matrixSize: nodeCount,
    bridgeOutputAdapters: [],
    bridgeInputAdapters: [],
    elementToCircuitElement: new Map(),
    resolvedPins: [],
  } as unknown as ConcreteCompiledAnalogCircuit;
}

function makeParamBag(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams({ ...DIODE_PARAM_DEFAULTS, ...VARACTOR_PARAM_DEFAULTS, ...params });
  return bag;
}

// ---------------------------------------------------------------------------
// VARACTOR_PARAM_DEFS partition layout tests (pre-existing)
// ---------------------------------------------------------------------------

describe("VARACTOR_PARAM_DEFS partition layout", () => {
  it("AREA OFF IC have partition='instance'", () => {
    const areaDef = VARACTOR_PARAM_DEFS.find((d) => d.key === "AREA");
    const offDef = VARACTOR_PARAM_DEFS.find((d) => d.key === "OFF");
    const icDef = VARACTOR_PARAM_DEFS.find((d) => d.key === "IC");

    expect(areaDef).toBeDefined();
    expect(offDef).toBeDefined();
    expect(icDef).toBeDefined();

    expect(areaDef!.partition).toBe("instance");
    expect(offDef!.partition).toBe("instance");
    expect(icDef!.partition).toBe("instance");
  });

  it("CJO VJ M IS FC TT N RS BV IBV NBV IKF IKR EG XTI KF AF TNOM have partition='model'", () => {
    const modelKeys = ["CJO", "VJ", "M", "IS", "FC", "TT", "N", "RS", "BV", "IBV", "NBV", "IKF", "IKR", "EG", "XTI", "KF", "AF", "TNOM"];
    for (const key of modelKeys) {
      const def = VARACTOR_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("model");
    }
  });
});

// ---------------------------------------------------------------------------
// Varactor definition tests
// ---------------------------------------------------------------------------

describe("Varactor definition", () => {
  it("definition_has_correct_fields", () => {
    expect(VaractorDefinition.name).toBe("VaractorDiode");
    expect(VaractorDefinition.modelRegistry?.["spice"]).toBeDefined();
    expect(VaractorDefinition.modelRegistry?.["spice"]?.kind).toBe("inline");
    expect((VaractorDefinition.modelRegistry?.["spice"] as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory).toBeDefined();
  });

  it("ngspiceNodeMap_correct", () => {
    expect(VaractorDefinition.ngspiceNodeMap).toEqual({ A: "pos", K: "neg" });
  });

  it("mayCreateInternalNodes_true", () => {
    const entry = VaractorDefinition.modelRegistry?.["spice"];
    expect(entry).toBeDefined();
    expect((entry as { mayCreateInternalNodes?: boolean }).mayCreateInternalNodes).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Varactor setup contract tests
// ---------------------------------------------------------------------------

describe("Varactor setup contract", () => {
  it("isReactive_true_when_cjo_nonzero", () => {
    // VARACTOR_PARAM_DEFAULTS has CJO=20pF → reactive
    const propsObj = makeParamBag({});
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), propsObj);
    expect(core.isReactive).toBe(true);
  });

  it("isNonlinear_true", () => {
    const propsObj = makeParamBag({});
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), propsObj);
    expect(core.isNonlinear).toBe(true);
  });

  it("setup_allocates_handles_before_load", () => {
    // The setup() must allocate 7 TSTALLOC handles (RS=0, so posPrimeNode=posNode).
    // After setup, _hPosPP etc. must be valid handles (non-negative).
    const propsObj = makeParamBag({ RS: 0 });
    const core = createDiodeElement(new Map([["A", 1], ["K", 2]]), propsObj);
    const { element } = withState(core);
    // All 7 handles must be valid (>= 0) after setup
    expect((element as any)._hPosPP).toBeGreaterThanOrEqual(0);
    expect((element as any)._hNegPP).toBeGreaterThanOrEqual(0);
    expect((element as any)._hPPPos).toBeGreaterThanOrEqual(0);
    expect((element as any)._hPPNeg).toBeGreaterThanOrEqual(0);
    expect((element as any)._hPosPos).toBeGreaterThanOrEqual(0);
    expect((element as any)._hNegNeg).toBeGreaterThanOrEqual(0);
    expect((element as any)._hPPPP).toBeGreaterThanOrEqual(0);
  });

  it("TSTALLOC_ordering_RS_zero_7_entries", () => {
    // RS=0 (default in VARACTOR_PARAM_DEFAULTS): _posPrimeNode = posNode = 1.
    // Expected TSTALLOC sequence (same as PB-DIO RS=0):
    //  1. (1,1), 2. (2,1), 3. (1,1), 4. (1,2), 5. (1,1), 6. (2,2), 7. (1,1)
    const propsObj = makeParamBag({ RS: 0 });
    const el = createDiodeElement(new Map([["A", 1], ["K", 2]]), propsObj);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (1) posNode, _posPrimeNode (alias)
      { extRow: 2, extCol: 1 },  // (2) negNode, _posPrimeNode (alias)
      { extRow: 1, extCol: 1 },  // (3) _posPrimeNode (alias), posNode
      { extRow: 1, extCol: 2 },  // (4) _posPrimeNode (alias), negNode
      { extRow: 1, extCol: 1 },  // (5) posNode, posNode
      { extRow: 2, extCol: 2 },  // (6) negNode, negNode
      { extRow: 1, extCol: 1 },  // (7) _posPrimeNode (alias), _posPrimeNode (alias)
    ]);
  });
});
