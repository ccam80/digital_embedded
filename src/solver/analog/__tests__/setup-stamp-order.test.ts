/**
 * setup-stamp-order.test.ts
 *
 * Invariant: each ngspice-anchored component's setup() must call
 * solver.allocElement() in exactly the order the corresponding ngspice
 * *setup.c file calls TSTALLOC — position-for-position.
 *
 * W3 implementation pattern (for reference when implementing each row):
 *   const engine = new MNAEngine(/* ... *\/);
 *   engine.init(compiled);
 *   (engine as any)._setup();   // private-method bypass, test-only
 *   const order = (engine as any)._solver._getInsertionOrder();
 *   expect(order).toEqual(EXPECTED_TSTALLOC_SEQUENCE);
 *
 * Gate: every row exists with it.todo before any W3 component lands.
 * Initially all rows are red (todo). Turns green as W3 components land.
 *
 * Behavioral elements are excluded per spec/setup-load-split/02-behavioral.md
 * ("There is no setup-stamp-order.test.ts row for behavioral elements").
 */

import { describe, it, expect } from "vitest";
import { MNAEngine } from "../analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../analog-engine.js";
import { NFETAnalogElement } from "../../../components/switching/nfet.js";
import { PFETAnalogElement } from "../../../components/switching/pfet.js";
import { FGNFETAnalogElement } from "../../../components/switching/fgnfet.js";
import { FGPFETAnalogElement } from "../../../components/switching/fgpfet.js";
import type { AnalogElement } from "../element.js";
import { NGSPICE_LOAD_ORDER } from "../element.js";
import { createBjtElement, BJT_NPN_DEFAULTS } from "../../../components/semiconductors/bjt.js";
import { createDiodeElement, DIODE_PARAM_DEFAULTS } from "../../../components/semiconductors/diode.js";
import { createZenerElement, ZENER_PARAM_DEFAULTS } from "../../../components/semiconductors/zener.js";
import { createMosfetElement } from "../../../components/semiconductors/mosfet.js";
import { createNJfetElement, NJFET_PARAM_DEFAULTS } from "../../../components/semiconductors/njfet.js";
import { VCCSAnalogElement } from "../../../components/active/vccs.js";
import { VCVSAnalogElement } from "../../../components/active/vcvs.js";
import { CCCSAnalogElement } from "../../../components/active/cccs.js";
import { CCVSAnalogElement } from "../../../components/active/ccvs.js";
import { Timer555Definition } from "../../../components/active/timer-555.js";
import { SwitchAnalogElement } from "../../../components/switching/switch.js";
import { SwitchDTAnalogElement } from "../../../components/switching/switch-dt.js";
import { createLDRElement, LDR_DEFAULTS } from "../../../components/sensors/ldr.js";
import { createNTCThermistorElement, NTC_DEFAULTS } from "../../../components/sensors/ntc-thermistor.js";
import { createSparkGapElement, SPARK_GAP_DEFAULTS } from "../../../components/sensors/spark-gap.js";
import { parseExpression } from "../expression.js";
import { differentiate, simplify } from "../expression-differentiate.js";
import { PropertyBag } from "../../../core/properties.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import { TransGateAnalogElement } from "../../../components/switching/trans-gate.js";
import { RelayDefinition } from "../../../components/switching/relay.js";
import { RelayDTDefinition } from "../../../components/switching/relay-dt.js";
import { createAnalogFuseElement, ANALOG_FUSE_DEFAULTS } from "../../../components/passives/analog-fuse.js";
import { ADCDefinition, ADC_DEFAULTS } from "../../../components/active/adc.js";
import { DACDefinition, DAC_DEFAULTS } from "../../../components/active/dac.js";
import { SwitchSPSTDefinition, SwitchSPDTDefinition, ANALOG_SWITCH_DEFAULTS } from "../../../components/active/analog-switch.js";
import { OptocouplerDefinition } from "../../../components/active/optocoupler.js";

// ---------------------------------------------------------------------------
// Minimal compiled-circuit fixture builder for setup-stamp-order tests.
//
// Builds the minimal ConcreteCompiledAnalogCircuit shape needed to call
// engine.init() and (engine as any)._setup(). Only `elements` and
// `nodeCount` are structurally required by _setup() — all other fields
// are stubs that satisfy the TypeScript cast.
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

// ---------------------------------------------------------------------------
// Helpers to build NFET/PFET analog elements with known node assignments.
// Nodes: drainNode=1, sourceNode=2, gateNode=3
// ---------------------------------------------------------------------------

function makeNFETElement(): NFETAnalogElement {
  const el = new NFETAnalogElement();
  el._pinNodes = new Map([
    ["D", 1],
    ["S", 2],
    ["G", 3],
  ]);
  el._sw._pinNodes = new Map([
    ["D", 1],
    ["S", 2],
  ]);
  return el;
}

function makePFETElement(): PFETAnalogElement {
  const el = new PFETAnalogElement();
  el._pinNodes = new Map([
    ["D", 1],
    ["S", 2],
    ["G", 3],
  ]);
  el._sw._pinNodes = new Map([
    ["D", 1],
    ["S", 2],
  ]);
  return el;
}

// ---------------------------------------------------------------------------
// Helpers to build FGNFET/FGPFET analog elements with known node assignments.
// External pins: drainNode=1, sourceNode=2. The floating-gate internal node
// is allocated during _setup() as nodeCount+1 = 3 (since nodeCount=2).
// ---------------------------------------------------------------------------

function makeFGNFETElement(): FGNFETAnalogElement {
  const pinNodes = new Map<string, number>([
    ["G", 0],  // external gate — not connected to MNA; placeholder only
    ["D", 1],
    ["S", 2],
  ]);
  return new FGNFETAnalogElement(pinNodes);
}

function makeFGPFETElement(): FGPFETAnalogElement {
  const pinNodes = new Map<string, number>([
    ["G", 0],  // external gate — not connected to MNA; placeholder only
    ["D", 1],
    ["S", 2],
  ]);
  return new FGPFETAnalogElement(pinNodes);
}

describe("setup-stamp-order", () => {
  it.todo("PB-ADC TSTALLOC sequence");
  it.todo("PB-AFUSE TSTALLOC sequence");
  it("PB-ANALOG_SWITCH TSTALLOC sequence", () => {
    // ngspice anchor: swsetup.c:59-62 (SW pattern applied once for SPST, twice for SPDT).
    //
    // SPST (in=1, out=2, ctrl=3): 4 entries — swsetup.c:59-62
    //   (in,in),(in,out),(out,in),(out,out) = (1,1),(1,2),(2,1),(2,2)
    //
    // SPDT (com=1, no=2, nc=3, ctrl=4): 8 entries — swsetup.c:59-62 applied to NO path then NC path
    //   NO path (pos=com=1, neg=no=2): (1,1),(1,2),(2,1),(2,2)
    //   NC path (pos=com=1, neg=nc=3): (1,1),(1,3),(3,1),(3,3)
    const spstProps = new PropertyBag();
    spstProps.replaceModelParams({ ...ANALOG_SWITCH_DEFAULTS });
    const spstPinNodes = new Map<string, number>([
      ["in", 1], ["out", 2], ["ctrl", 3],
    ]);
    const spstFactory = SwitchSPSTDefinition.modelRegistry!["behavioral"]!.factory;
    const spstEl = spstFactory(spstPinNodes, spstProps, () => 0);
    const spstCircuit = makeMinimalCircuit([spstEl as unknown as AnalogElement], 3);
    const spstEngine = new MNAEngine();
    spstEngine.init(spstCircuit);
    (spstEngine as any)._setup();
    const spstOrder = (spstEngine as any)._solver._getInsertionOrder();
    expect(spstOrder).toEqual([
      { extRow: 1, extCol: 1 },  // SWposPosptr
      { extRow: 1, extCol: 2 },  // SWposNegptr
      { extRow: 2, extCol: 1 },  // SWnegPosptr
      { extRow: 2, extCol: 2 },  // SWnegNegptr
    ]);

    const spdtProps = new PropertyBag();
    spdtProps.replaceModelParams({ ...ANALOG_SWITCH_DEFAULTS });
    const spdtPinNodes = new Map<string, number>([
      ["com", 1], ["no", 2], ["nc", 3], ["ctrl", 4],
    ]);
    const spdtFactory = SwitchSPDTDefinition.modelRegistry!["behavioral"]!.factory;
    const spdtEl = spdtFactory(spdtPinNodes, spdtProps, () => 0);
    const spdtCircuit = makeMinimalCircuit([spdtEl as unknown as AnalogElement], 4);
    const spdtEngine = new MNAEngine();
    spdtEngine.init(spdtCircuit);
    (spdtEngine as any)._setup();
    const spdtOrder = (spdtEngine as any)._solver._getInsertionOrder();
    expect(spdtOrder).toEqual([
      { extRow: 1, extCol: 1 },  // NO path: SWposPosptr (com,com)
      { extRow: 1, extCol: 2 },  // NO path: SWposNegptr (com,no)
      { extRow: 2, extCol: 1 },  // NO path: SWnegPosptr (no,com)
      { extRow: 2, extCol: 2 },  // NO path: SWnegNegptr (no,no)
      { extRow: 1, extCol: 1 },  // NC path: SWposPosptr (com,com)
      { extRow: 1, extCol: 3 },  // NC path: SWposNegptr (com,nc)
      { extRow: 3, extCol: 1 },  // NC path: SWnegPosptr (nc,com)
      { extRow: 3, extCol: 3 },  // NC path: SWnegNegptr (nc,nc)
    ]);
  });
  it("PB-BJT TSTALLOC sequence", () => {
    // ngspice anchor: bjtsetup.c:435-464 — 23 TSTALLOC entries.
    // L0 element: RC=RB=RE=0, so primeNodes alias external nodes.
    // Nodes: B=baseNode=1, C=colNode=2, E=emitNode=3. substNode=0 (ground).
    // With RC=RB=RE=0: cp=colNode=2, bp=baseNode=1, ep=emitNode=3.
    // VERTICAL (default): sc=cp=2.
    //
    // Entries 19-21 reference substNode=0 → allocElement returns TrashCan
    // (row=0 or col=0) WITHOUT recording to _insertionOrder (spbuild.c:272-273).
    // So only 20 of the 23 calls appear in _insertionOrder.
    //
    // Expected sequence (entries 1-18, 22-23):
    //  1. (2,2) _hCCP  — colNode, cp
    //  2. (1,1) _hBBP  — baseNode, bp
    //  3. (3,3) _hEEP  — emitNode, ep
    //  4. (2,2) _hCPC  — cp, colNode
    //  5. (2,1) _hCPBP — cp, bp
    //  6. (2,3) _hCPEP — cp, ep
    //  7. (1,1) _hBPB  — bp, baseNode
    //  8. (1,2) _hBPCP — bp, cp
    //  9. (1,3) _hBPEP — bp, ep
    // 10. (3,3) _hEPE  — ep, emitNode
    // 11. (3,2) _hEPCP — ep, cp
    // 12. (3,1) _hEPBP — ep, bp
    // 13. (2,2) _hCC   — colNode, colNode
    // 14. (1,1) _hBB   — baseNode, baseNode
    // 15. (3,3) _hEE   — emitNode, emitNode
    // 16. (2,2) _hCPCP — cp, cp
    // 17. (1,1) _hBPBP — bp, bp
    // 18. (3,3) _hEPEP — ep, ep
    // 19. SKIPPED (0,0) — substNode ground → TrashCan, not in _insertionOrder
    // 20. SKIPPED (2,0) — sc, substNode → TrashCan
    // 21. SKIPPED (0,2) — substNode, sc → TrashCan
    // 22. (1,2) _hBCP  — baseNode, cp
    // 23. (2,1) _hCPB  — cp, baseNode
    const props = createTestPropertyBag();
    props.replaceModelParams({ ...BJT_NPN_DEFAULTS });
    const el = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 1 },
      { extRow: 3, extCol: 3 },
      { extRow: 2, extCol: 2 },
      { extRow: 2, extCol: 1 },
      { extRow: 2, extCol: 3 },
      { extRow: 1, extCol: 1 },
      { extRow: 1, extCol: 2 },
      { extRow: 1, extCol: 3 },
      { extRow: 3, extCol: 3 },
      { extRow: 3, extCol: 2 },
      { extRow: 3, extCol: 1 },
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 1 },
      { extRow: 3, extCol: 3 },
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 1 },
      { extRow: 3, extCol: 3 },
      { extRow: 1, extCol: 2 },
      { extRow: 2, extCol: 1 },
    ]);
  });
  it.todo("PB-CAP TSTALLOC sequence");
  it("PB-CCCS TSTALLOC sequence", () => {
    // ngspice anchor: cccsset.c:49-50 — 2 TSTALLOC entries.
    // No own branch row. Controlling branch resolved via findBranchFor (lazy).
    //
    // Setup order:
    //   CCCS (order=18) runs BEFORE senseVsrc (order=48).
    //   CCCS.setup() calls ctx.findBranch("senseVsrc") which calls
    //   senseVsrc.findBranchFor → ctx.makeCur → contBranch = nodeCount+1 = 3.
    //
    // Nodes: posNode=1 (out+), negNode=2 (out-)
    // contBranch = 3 (1-based, allocated lazily)
    //
    // Expected TSTALLOC sequence (cccsset.c:49-50):
    //  1. :49 (CCCSposNode=1, CCCScontBranch=3)  _hPCtBr
    //  2. :50 (CCCSnegNode=2, CCCScontBranch=3)  _hNCtBr

    // Build a sense VSRC element with findBranchFor on the instance.
    let senseVsrcBranch = -1;
    const senseVsrc: AnalogElement & { findBranchFor(name: string, ctx: SetupContext): number } = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      get branchIndex(): number { return senseVsrcBranch; },
      set branchIndex(v: number) { senseVsrcBranch = v; },
      ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VSRC,
      isNonlinear: false,
      isReactive: false,
      label: "senseVsrc",
      setParam(_k: string, _v: number): void {},
      setup(ctx: SetupContext): void {
        if (senseVsrcBranch === -1) senseVsrcBranch = ctx.makeCur("senseVsrc", "branch");
      },
      findBranchFor(_name: string, ctx: SetupContext): number {
        if (senseVsrcBranch === -1) senseVsrcBranch = ctx.makeCur("senseVsrc", "branch");
        return senseVsrcBranch;
      },
      load(_ctx: LoadContext): void {},
      getPinCurrents(_rhs: Float64Array): number[] { return [0, 0]; },
    } as unknown as AnalogElement & { findBranchFor(name: string, ctx: SetupContext): number };

    // Build CCCS element.
    const rawExpr  = parseExpression("1 * I(sense)");
    const deriv    = simplify(differentiate(rawExpr, "I(sense)"));
    const cccs     = new CCCSAnalogElement(rawExpr, deriv, "I(sense)", "current");
    cccs.label     = "cccs1";
    cccs._pinNodes = new Map([["out+", 1], ["out-", 2]]);
    cccs.setParam("senseSourceLabel", "senseVsrc");
    Object.assign(cccs, { pinNodeIds: [0, 0, 1, 2], allNodeIds: [0, 0, 1, 2] });

    // nodeCount=2; _maxEqNum starts at nodeCount+1 = 3.
    // CCCS (order 18) runs first → findBranchFor → makeCur → contBranch=3.
    const circuit = makeMinimalCircuit([cccs as unknown as AnalogElement, senseVsrc as unknown as AnalogElement], 2);
    const engine  = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 3 },  // :49 (posNode=1, contBranch=3) — _hPCtBr
      { extRow: 2, extCol: 3 },  // :50 (negNode=2, contBranch=3) — _hNCtBr
    ]);
  });
  it("PB-CCVS TSTALLOC sequence", () => {
    // ngspice anchor: ccvsset.c:58-62 — 5 TSTALLOC entries.
    // Own branch row allocated first via ctx.makeCur (ccvsset.c:40-43).
    // Controlling branch resolved lazily via findBranchFor (ccvsset.c:45).
    //
    // Setup order:
    //   CCVS (order=19) runs BEFORE senseVsrc (order=48).
    //   CCVS.setup():
    //     1. ctx.makeCur("ccvs1","branch") → ownBranch = nodeCount+1 = 3
    //     2. ctx.findBranch("senseVsrc") → senseVsrc.findBranchFor →
    //        ctx.makeCur("senseVsrc","branch") → contBranch = 4
    //
    // Nodes: posNode=1 (out+), negNode=2 (out-)
    // ownBranch=3, contBranch=4
    //
    // Expected TSTALLOC sequence (ccvsset.c:58-62, negNode then posNode for ibr):
    //  1. :58 (posNode=1,   ownBranch=3) — _hPIbr
    //  2. :59 (negNode=2,   ownBranch=3) — _hNIbr
    //  3. :60 (ownBranch=3, negNode=2)   — _hIbrN
    //  4. :61 (ownBranch=3, posNode=1)   — _hIbrP
    //  5. :62 (ownBranch=3, contBranch=4)— _hIbrCtBr

    // Build a sense VSRC element with findBranchFor on the instance.
    let senseVsrcBranch = -1;
    const senseVsrc: AnalogElement & { findBranchFor(name: string, ctx: SetupContext): number } = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      get branchIndex(): number { return senseVsrcBranch; },
      set branchIndex(v: number) { senseVsrcBranch = v; },
      ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VSRC,
      isNonlinear: false,
      isReactive: false,
      label: "senseVsrc",
      setParam(_k: string, _v: number): void {},
      setup(ctx: SetupContext): void {
        if (senseVsrcBranch === -1) senseVsrcBranch = ctx.makeCur("senseVsrc", "branch");
      },
      findBranchFor(_name: string, ctx: SetupContext): number {
        if (senseVsrcBranch === -1) senseVsrcBranch = ctx.makeCur("senseVsrc", "branch");
        return senseVsrcBranch;
      },
      load(_ctx: LoadContext): void {},
      getPinCurrents(_rhs: Float64Array): number[] { return [0, 0]; },
    } as unknown as AnalogElement & { findBranchFor(name: string, ctx: SetupContext): number };

    // Build CCVS element.
    const rawExpr  = parseExpression("1000 * I(sense)");
    const deriv    = simplify(differentiate(rawExpr, "I(sense)"));
    const ccvs     = new CCVSAnalogElement(rawExpr, deriv, "I(sense)", "current");
    ccvs.label     = "ccvs1";
    ccvs._pinNodes = new Map([["out+", 1], ["out-", 2]]);
    ccvs.setParam("senseSourceLabel", "senseVsrc");
    Object.assign(ccvs, { pinNodeIds: [0, 0, 1, 2], allNodeIds: [0, 0, 1, 2] });

    // nodeCount=2; _maxEqNum starts at nodeCount+1 = 3.
    // CCVS (order 19) runs first:
    //   makeCur("ccvs1","branch") → ownBranch=3
    //   findBranch → findBranchFor → makeCur("senseVsrc","branch") → contBranch=4
    const circuit = makeMinimalCircuit([ccvs as unknown as AnalogElement, senseVsrc as unknown as AnalogElement], 2);
    const engine  = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 3 },  // :58 (posNode=1,   ownBranch=3) — _hPIbr
      { extRow: 2, extCol: 3 },  // :59 (negNode=2,   ownBranch=3) — _hNIbr
      { extRow: 3, extCol: 2 },  // :60 (ownBranch=3, negNode=2)   — _hIbrN
      { extRow: 3, extCol: 1 },  // :61 (ownBranch=3, posNode=1)   — _hIbrP
      { extRow: 3, extCol: 4 },  // :62 (ownBranch=3, contBranch=4)— _hIbrCtBr
    ]);
  });
  it.todo("PB-COMPARATOR TSTALLOC sequence");
  it.todo("PB-CRYSTAL TSTALLOC sequence");
  it.todo("PB-DAC TSTALLOC sequence");
  it.todo("PB-DIAC TSTALLOC sequence");
  it("PB-DIO TSTALLOC sequence", () => {
    // ngspice anchor: diosetup.c:232-238 — 7 TSTALLOC entries.
    // RS=0 (default): _posPrimeNode = posNode = 1. No internal node.
    // Nodes: posNode=1 (A/anode), negNode=2 (K/cathode).
    //
    // TSTALLOC sequence:
    //  1. (posNode=1, _posPrimeNode=1)   → (1,1)
    //  2. (negNode=2, _posPrimeNode=1)   → (2,1)
    //  3. (_posPrimeNode=1, posNode=1)   → (1,1)
    //  4. (_posPrimeNode=1, negNode=2)   → (1,2)
    //  5. (posNode=1, posNode=1)         → (1,1)
    //  6. (negNode=2, negNode=2)         → (2,2)
    //  7. (_posPrimeNode=1, _posPrimeNode=1) → (1,1)
    const props = new PropertyBag();
    props.replaceModelParams({ ...DIODE_PARAM_DEFAULTS });
    const el = createDiodeElement(new Map([["A", 1], ["K", 2]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (1) posNode, _posPrimeNode
      { extRow: 2, extCol: 1 },  // (2) negNode, _posPrimeNode
      { extRow: 1, extCol: 1 },  // (3) _posPrimeNode, posNode
      { extRow: 1, extCol: 2 },  // (4) _posPrimeNode, negNode
      { extRow: 1, extCol: 1 },  // (5) posNode, posNode
      { extRow: 2, extCol: 2 },  // (6) negNode, negNode
      { extRow: 1, extCol: 1 },  // (7) _posPrimeNode, _posPrimeNode
    ]);
  });
  it.todo("PB-FGNFET TSTALLOC sequence");
  it.todo("PB-FGPFET TSTALLOC sequence");
  it("PB-FUSE TSTALLOC sequence", () => {
    // ngspice anchor: ressetup.c:46-49 — 4 TSTALLOC entries (RES pattern).
    // AnalogFuseElement uses pin keys "out1" (posNode) and "out2" (negNode).
    // Nodes: posNode=1, negNode=2.
    //
    // Expected order: (1,1),(2,2),(1,2),(2,1) — PP, NN, PN, NP
    const props = new PropertyBag();
    props.replaceModelParams({ ...ANALOG_FUSE_DEFAULTS });
    const el = createAnalogFuseElement(new Map([["out1", 1], ["out2", 2]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (RESposNode, RESposNode) — ressetup.c:46
      { extRow: 2, extCol: 2 },  // (RESnegNode, RESnegNode) — ressetup.c:47
      { extRow: 1, extCol: 2 },  // (RESposNode, RESnegNode) — ressetup.c:48
      { extRow: 2, extCol: 1 },  // (RESnegNode, RESposNode) — ressetup.c:49
    ]);
  });
  it.todo("PB-IND TSTALLOC sequence");
  it.todo("PB-ISRC TSTALLOC sequence");
  it("PB-LDR TSTALLOC sequence", () => {
    // ngspice anchor: ressetup.c:46-49 — 4 TSTALLOC entries, RES pattern.
    // Nodes: posNode=1, negNode=2.
    // Expected order: (1,1), (2,2), (1,2), (2,1) — PP, NN, PN, NP
    const props = new PropertyBag();
    props.replaceModelParams({ ...LDR_DEFAULTS });
    const el = createLDRElement(new Map([["pos", 1], ["neg", 2]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 }, // (posNode, posNode) — ressetup.c:46
      { extRow: 2, extCol: 2 }, // (negNode, negNode) — ressetup.c:47
      { extRow: 1, extCol: 2 }, // (posNode, negNode) — ressetup.c:48
      { extRow: 2, extCol: 1 }, // (negNode, posNode) — ressetup.c:49
    ]);
  });
  it.todo("PB-MEMR TSTALLOC sequence");

  it("PB-NFET TSTALLOC sequence", () => {
    // ngspice anchor: swsetup.c:59-62 — 4 stamps, D=posNode, S=negNode
    // drainNode=1, sourceNode=2
    // Expected order: (1,1), (1,2), (2,1), (2,2) — PP, PN, NP, NN
    const el = makeNFETElement();
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },
      { extRow: 1, extCol: 2 },
      { extRow: 2, extCol: 1 },
      { extRow: 2, extCol: 2 },
    ]);
  });

  it("PB-NJFET TSTALLOC sequence", () => {
    // ngspice anchor: jfetset.c:166-180 — 15 TSTALLOC entries.
    // Nodes: G=1, D=2, S=3. RS=RD=0 (defaults) → sp=sourceNode=3, dp=drainNode=2.
    //
    // TSTALLOC sequence (jfetset.c:166-180, all unconditional):
    //  1. (drainNode=2, dp=2)       → (2,2)  _hDDP
    //  2. (gateNode=1,  dp=2)       → (1,2)  _hGDP
    //  3. (gateNode=1,  sp=3)       → (1,3)  _hGSP
    //  4. (sourceNode=3, sp=3)      → (3,3)  _hSSP
    //  5. (dp=2, drainNode=2)       → (2,2)  _hDPD
    //  6. (dp=2, gateNode=1)        → (2,1)  _hDPG
    //  7. (dp=2, sp=3)              → (2,3)  _hDPSP
    //  8. (sp=3, gateNode=1)        → (3,1)  _hSPG
    //  9. (sp=3, sourceNode=3)      → (3,3)  _hSPS
    // 10. (sp=3, dp=2)              → (3,2)  _hSPDP
    // 11. (drainNode=2, drainNode=2)→ (2,2)  _hDD
    // 12. (gateNode=1,  gateNode=1) → (1,1)  _hGG
    // 13. (sourceNode=3, sourceNode=3) → (3,3) _hSS
    // 14. (dp=2, dp=2)              → (2,2)  _hDPDP
    // 15. (sp=3, sp=3)              → (3,3)  _hSPSP
    const props = new PropertyBag();
    props.replaceModelParams({ ...NJFET_PARAM_DEFAULTS });
    const el = createNJfetElement(new Map([["G", 1], ["D", 2], ["S", 3]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 2, extCol: 2 },  // (1)  drainNode, dp  — _hDDP
      { extRow: 1, extCol: 2 },  // (2)  gateNode, dp   — _hGDP
      { extRow: 1, extCol: 3 },  // (3)  gateNode, sp   — _hGSP
      { extRow: 3, extCol: 3 },  // (4)  sourceNode, sp — _hSSP
      { extRow: 2, extCol: 2 },  // (5)  dp, drainNode  — _hDPD
      { extRow: 2, extCol: 1 },  // (6)  dp, gateNode   — _hDPG
      { extRow: 2, extCol: 3 },  // (7)  dp, sp         — _hDPSP
      { extRow: 3, extCol: 1 },  // (8)  sp, gateNode   — _hSPG
      { extRow: 3, extCol: 3 },  // (9)  sp, sourceNode — _hSPS
      { extRow: 3, extCol: 2 },  // (10) sp, dp         — _hSPDP
      { extRow: 2, extCol: 2 },  // (11) drainNode, drainNode — _hDD
      { extRow: 1, extCol: 1 },  // (12) gateNode, gateNode  — _hGG
      { extRow: 3, extCol: 3 },  // (13) sourceNode, sourceNode — _hSS
      { extRow: 2, extCol: 2 },  // (14) dp, dp         — _hDPDP
      { extRow: 3, extCol: 3 },  // (15) sp, sp         — _hSPSP
    ]);
  });
  it("PB-NMOS TSTALLOC sequence", () => {
    // ngspice anchor: mos1set.c:186-207 — 22 TSTALLOC entries (all unconditional).
    // Nodes: G=3, S=2, D=1.  B=S=2 (body tied to source, 3-terminal).
    // RD=RS=RSH=0 → no prime nodes → dp=dNode=1, sp=sNode=2.
    // Ground-involving entries return TrashCan (handle 0) without recording.
    const props = new PropertyBag();
    props.replaceModelParams({
      VTO: 0.7, KP: 120e-6, LAMBDA: 0.02, PHI: 0.6, GAMMA: 0.37,
      CBD: 0, CBS: 0, CGDO: 0, CGSO: 0, CGBO: 0,
      W: 1e-6, L: 1e-6, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
      CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.33, JS: 0, RSH: 0,
      AD: 0, AS: 0, PD: 0, PS: 0, TNOM: 300.15, TOX: 0,
      TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5, M: 1, OFF: 0,
      ICVDS: 0, ICVGS: 0, ICVBS: 0, TEMP: 300.15,
      drainSquares: 0, sourceSquares: 0,
    });
    const el = createMosfetElement(1, new Map([["G", 3], ["S", 2], ["D", 1]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (1)  dNode, dNode
      { extRow: 3, extCol: 3 },  // (2)  gNode, gNode
      { extRow: 2, extCol: 2 },  // (3)  sNode, sNode
      { extRow: 2, extCol: 2 },  // (4)  bNode, bNode = (sNode, sNode)
      { extRow: 1, extCol: 1 },  // (5)  dp, dp = (dNode, dNode) — RD=0
      { extRow: 2, extCol: 2 },  // (6)  sp, sp = (sNode, sNode) — RS=0
      { extRow: 1, extCol: 1 },  // (7)  dNode, dp = (dNode, dNode) — RD=0
      { extRow: 3, extCol: 2 },  // (8)  gNode, bNode = (gNode, sNode)
      { extRow: 3, extCol: 1 },  // (9)  gNode, dp = (gNode, dNode)
      { extRow: 3, extCol: 2 },  // (10) gNode, sp = (gNode, sNode)
      { extRow: 2, extCol: 2 },  // (11) sNode, sp = (sNode, sNode) — RS=0
      { extRow: 2, extCol: 1 },  // (12) bNode, dp = (sNode, dNode)
      { extRow: 2, extCol: 2 },  // (13) bNode, sp = (sNode, sNode)
      { extRow: 1, extCol: 2 },  // (14) dp, sp = (dNode, sNode) — RD=RS=0
      { extRow: 1, extCol: 1 },  // (15) dp, dNode = (dNode, dNode) — RD=0
      { extRow: 2, extCol: 3 },  // (16) bNode, gNode = (sNode, gNode)
      { extRow: 1, extCol: 3 },  // (17) dp, gNode = (dNode, gNode) — RD=0
      { extRow: 2, extCol: 3 },  // (18) sp, gNode = (sNode, gNode) — RS=0
      { extRow: 2, extCol: 2 },  // (19) sp, sNode = (sNode, sNode) — RS=0
      { extRow: 1, extCol: 2 },  // (20) dp, bNode = (dNode, sNode)
      { extRow: 2, extCol: 2 },  // (21) sp, bNode = (sNode, sNode)
      { extRow: 2, extCol: 1 },  // (22) sp, dp = (sNode, dNode) — RS=RD=0
    ]);
  });
  it("PB-NTC TSTALLOC sequence", () => {
    // ngspice anchor: ressetup.c:46-49 — 4 TSTALLOC entries, RES pattern.
    // Nodes: posNode=1, negNode=2.
    // Expected order: (1,1), (2,2), (1,2), (2,1) — PP, NN, PN, NP
    const props = new PropertyBag();
    props.replaceModelParams({ ...NTC_DEFAULTS });
    const el = createNTCThermistorElement(new Map([["pos", 1], ["neg", 2]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 }, // (posNode, posNode) — ressetup.c:46
      { extRow: 2, extCol: 2 }, // (negNode, negNode) — ressetup.c:47
      { extRow: 1, extCol: 2 }, // (posNode, negNode) — ressetup.c:48
      { extRow: 2, extCol: 1 }, // (negNode, posNode) — ressetup.c:49
    ]);
  });
  it.todo("PB-OPAMP TSTALLOC sequence");
  it.todo("PB-OPTO TSTALLOC sequence");
  it.todo("PB-OTA TSTALLOC sequence");

  it("PB-PFET TSTALLOC sequence", () => {
    // ngspice anchor: swsetup.c:59-62 — 4 stamps, D=posNode, S=negNode
    // Identical to NFET — polarity inversion is load-time only.
    // drainNode=1, sourceNode=2
    // Expected order: (1,1), (1,2), (2,1), (2,2) — PP, PN, NP, NN
    const el = makePFETElement();
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },
      { extRow: 1, extCol: 2 },
      { extRow: 2, extCol: 1 },
      { extRow: 2, extCol: 2 },
    ]);
  });

  it.todo("PB-PJFET TSTALLOC sequence");
  it("PB-PMOS TSTALLOC sequence", () => {
    // ngspice anchor: mos1set.c:186-207 — 22 TSTALLOC entries (all unconditional).
    // PMOS pin layout: G=3, D=1, S=2.  B=S=2 (body tied to source, 3-terminal).
    // RD=RS=RSH=0 → no prime nodes → dp=dNode=1, sp=sNode=2.
    // Identical TSTALLOC sequence to NMOS — mos1set.c:186-207 is polarity-independent.
    const props = new PropertyBag();
    props.replaceModelParams({
      VTO: -0.7, KP: 60e-6, LAMBDA: 0.02, PHI: 0.6, GAMMA: 0.37,
      CBD: 0, CBS: 0, CGDO: 0, CGSO: 0, CGBO: 0,
      W: 1e-6, L: 1e-6, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
      CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.33, JS: 0, RSH: 0,
      AD: 0, AS: 0, PD: 0, PS: 0, TNOM: 300.15, TOX: 0,
      TPG: -1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5, M: 1, OFF: 0,
      ICVDS: 0, ICVGS: 0, ICVBS: 0, TEMP: 300.15,
      drainSquares: 0, sourceSquares: 0,
    });
    const el = createMosfetElement(-1, new Map([["G", 3], ["D", 1], ["S", 2]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (1)  dNode, dNode
      { extRow: 3, extCol: 3 },  // (2)  gNode, gNode
      { extRow: 2, extCol: 2 },  // (3)  sNode, sNode
      { extRow: 2, extCol: 2 },  // (4)  bNode, bNode = (sNode, sNode)
      { extRow: 1, extCol: 1 },  // (5)  dp, dp = (dNode, dNode) — RD=0
      { extRow: 2, extCol: 2 },  // (6)  sp, sp = (sNode, sNode) — RS=0
      { extRow: 1, extCol: 1 },  // (7)  dNode, dp = (dNode, dNode) — RD=0
      { extRow: 3, extCol: 2 },  // (8)  gNode, bNode = (gNode, sNode)
      { extRow: 3, extCol: 1 },  // (9)  gNode, dp = (gNode, dNode)
      { extRow: 3, extCol: 2 },  // (10) gNode, sp = (gNode, sNode)
      { extRow: 2, extCol: 2 },  // (11) sNode, sp = (sNode, sNode) — RS=0
      { extRow: 2, extCol: 1 },  // (12) bNode, dp = (sNode, dNode)
      { extRow: 2, extCol: 2 },  // (13) bNode, sp = (sNode, sNode)
      { extRow: 1, extCol: 2 },  // (14) dp, sp = (dNode, sNode) — RD=RS=0
      { extRow: 1, extCol: 1 },  // (15) dp, dNode = (dNode, dNode) — RD=0
      { extRow: 2, extCol: 3 },  // (16) bNode, gNode = (sNode, gNode)
      { extRow: 1, extCol: 3 },  // (17) dp, gNode = (dNode, gNode) — RD=0
      { extRow: 2, extCol: 3 },  // (18) sp, gNode = (sNode, gNode) — RS=0
      { extRow: 2, extCol: 2 },  // (19) sp, sNode = (sNode, sNode) — RS=0
      { extRow: 1, extCol: 2 },  // (20) dp, bNode = (dNode, sNode)
      { extRow: 2, extCol: 2 },  // (21) sp, bNode = (sNode, sNode)
      { extRow: 2, extCol: 1 },  // (22) sp, dp = (sNode, dNode) — RS=RD=0
    ]);
  });
  it.todo("PB-POLCAP TSTALLOC sequence");
  it.todo("PB-POT TSTALLOC sequence");
  it.todo("PB-REAL_OPAMP TSTALLOC sequence");
  it("PB-RELAY TSTALLOC sequence", () => {
    // ngspice anchor: composite — coilL(IND,5) + coilR(RES,4) + contactSW(SW,4).
    //
    // Pin nodes: in1=1, in2=2, A1=3, B1=4. nodeCount=4.
    // setup() allocates:
    //   coilMid = ctx.makeVolt → 5  (_maxEqNum advances 4→5)
    //   coilL branch = ctx.makeCur → 6  (_maxEqNum advances 5→6)
    //
    // coilL.setup (IND, posNode=in1=1, negNode=coilMid=5, branch=6):
    //   indsetup.c:96-100 — 5 entries:
    //   (1,6),(5,6),(6,5),(6,1),(6,6)
    //
    // coilR.setup (RES, posNode=coilMid=5, negNode=in2=2):
    //   ressetup.c:46-49 — 4 entries:
    //   (5,5),(2,2),(5,2),(2,5)
    //
    // contactSW.setup (SW, A1=3, B1=4):
    //   swsetup.c:59-62 — 4 entries:
    //   (3,3),(3,4),(4,3),(4,4)
    //
    // Total: 13 entries.
    const props = new PropertyBag();
    const pinNodes = new Map<string, number>([
      ["in1", 1], ["in2", 2], ["A1", 3], ["B1", 4],
    ]);
    const factory = RelayDefinition.modelRegistry!["behavioral"]!.factory;
    const el = factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 4);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // coilL (IND): posNode=1, negNode=5, branch=6 — indsetup.c:96-100
      { extRow: 1, extCol: 6 },  // (INDposNode, INDbrEq)
      { extRow: 5, extCol: 6 },  // (INDnegNode, INDbrEq)
      { extRow: 6, extCol: 5 },  // (INDbrEq, INDnegNode)
      { extRow: 6, extCol: 1 },  // (INDbrEq, INDposNode)
      { extRow: 6, extCol: 6 },  // (INDbrEq, INDbrEq)
      // coilR (RES): posNode=5, negNode=2 — ressetup.c:46-49
      { extRow: 5, extCol: 5 },  // (RESposNode, RESposNode)
      { extRow: 2, extCol: 2 },  // (RESnegNode, RESnegNode)
      { extRow: 5, extCol: 2 },  // (RESposNode, RESnegNode)
      { extRow: 2, extCol: 5 },  // (RESnegNode, RESposNode)
      // contactSW (SW): A1=3, B1=4 — swsetup.c:59-62
      { extRow: 3, extCol: 3 },  // (SWposNode, SWposNode)
      { extRow: 3, extCol: 4 },  // (SWposNode, SWnegNode)
      { extRow: 4, extCol: 3 },  // (SWnegNode, SWposNode)
      { extRow: 4, extCol: 4 },  // (SWnegNode, SWnegNode)
    ]);
  });
  it("PB-RELAY-DT TSTALLOC sequence", () => {
    // ngspice anchor: composite — coilL(IND,5) + coilR(RES,4) + swNO(SW,4) + swNC(SW,4).
    //
    // Pin nodes: in1=1, in2=2, A1=3, B1=4, C1=5. nodeCount=5.
    // setup() allocates:
    //   coilMid = ctx.makeVolt → 6  (_maxEqNum advances 5→6)
    //   coilL branch = ctx.makeCur → 7  (_maxEqNum advances 6→7)
    //
    // coilL.setup (IND, posNode=in1=1, negNode=coilMid=6, branch=7):
    //   indsetup.c:96-100 — 5 entries:
    //   (1,7),(6,7),(7,6),(7,1),(7,7)
    //
    // coilR.setup (RES, posNode=coilMid=6, negNode=in2=2):
    //   ressetup.c:46-49 — 4 entries:
    //   (6,6),(2,2),(6,2),(2,6)
    //
    // swNO.setup (SW, A1=3, B1=4, normally-open):
    //   swsetup.c:59-62 — 4 entries:
    //   (3,3),(3,4),(4,3),(4,4)
    //
    // swNC.setup (SW, A1=3, B1=C1=5, normally-closed):
    //   swsetup.c:59-62 — 4 entries:
    //   (3,3),(3,5),(5,3),(5,5)
    //
    // Total: 17 entries.
    const props = new PropertyBag();
    const pinNodes = new Map<string, number>([
      ["in1", 1], ["in2", 2], ["A1", 3], ["B1", 4], ["C1", 5],
    ]);
    const factory = RelayDTDefinition.modelRegistry!["behavioral"]!.factory;
    const el = factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 5);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // coilL (IND): posNode=1, negNode=6, branch=7 — indsetup.c:96-100
      { extRow: 1, extCol: 7 },  // (INDposNode, INDbrEq)
      { extRow: 6, extCol: 7 },  // (INDnegNode, INDbrEq)
      { extRow: 7, extCol: 6 },  // (INDbrEq, INDnegNode)
      { extRow: 7, extCol: 1 },  // (INDbrEq, INDposNode)
      { extRow: 7, extCol: 7 },  // (INDbrEq, INDbrEq)
      // coilR (RES): posNode=6, negNode=2 — ressetup.c:46-49
      { extRow: 6, extCol: 6 },  // (RESposNode, RESposNode)
      { extRow: 2, extCol: 2 },  // (RESnegNode, RESnegNode)
      { extRow: 6, extCol: 2 },  // (RESposNode, RESnegNode)
      { extRow: 2, extCol: 6 },  // (RESnegNode, RESposNode)
      // swNO (SW): A1=3, B1=4 — swsetup.c:59-62
      { extRow: 3, extCol: 3 },  // (SWposNode, SWposNode)
      { extRow: 3, extCol: 4 },  // (SWposNode, SWnegNode)
      { extRow: 4, extCol: 3 },  // (SWnegNode, SWposNode)
      { extRow: 4, extCol: 4 },  // (SWnegNode, SWnegNode)
      // swNC (SW): A1=3, B1=C1=5 — swsetup.c:59-62
      { extRow: 3, extCol: 3 },  // (SWposNode, SWposNode)
      { extRow: 3, extCol: 5 },  // (SWposNode, SWnegNode)
      { extRow: 5, extCol: 3 },  // (SWnegNode, SWposNode)
      { extRow: 5, extCol: 5 },  // (SWnegNode, SWnegNode)
    ]);
  });
  it.todo("PB-RES TSTALLOC sequence");
  it.todo("PB-SCR TSTALLOC sequence");
  it.todo("PB-SCHMITT TSTALLOC sequence");
  it("PB-SCHOTTKY TSTALLOC sequence", () => {
    // ngspice anchor: diosetup.c:232-238 — 7 TSTALLOC entries (identical to DIO).
    // SchottkyDiode delegates to createDiodeElement with SCHOTTKY_DEFAULTS.
    // RS=1Ω (Schottky default): _posPrimeNode = internal node = 3 (nodeCount+1).
    // Nodes: posNode=1 (A), negNode=2 (K), internal _posPrimeNode=3.
    //
    // TSTALLOC sequence:
    //  1. (posNode=1, _posPrimeNode=3)   → (1,3)
    //  2. (negNode=2, _posPrimeNode=3)   → (2,3)
    //  3. (_posPrimeNode=3, posNode=1)   → (3,1)
    //  4. (_posPrimeNode=3, negNode=2)   → (3,2)
    //  5. (posNode=1, posNode=1)         → (1,1)
    //  6. (negNode=2, negNode=2)         → (2,2)
    //  7. (_posPrimeNode=3, _posPrimeNode=3) → (3,3)
    const props = new PropertyBag();
    // SCHOTTKY_PARAM_DEFAULTS has RS=1 → internal node allocated
    props.replaceModelParams({
      IS: 1e-8, N: 1.05, RS: 1, CJO: 1e-12, VJ: 0.6, M: 0.5, TT: 0,
      FC: 0.5, BV: 40, IBV: 1e-3, EG: 0.69, XTI: 2, KF: 0, AF: 1,
      NBV: NaN, IKF: Infinity, IKR: Infinity, AREA: 1, OFF: 0, IC: NaN,
      ISW: 0, NSW: NaN, TEMP: 300.15, TNOM: 300.15,
    });
    const el = createDiodeElement(new Map([["A", 1], ["K", 2]]), props);
    // nodeCount=2; internal node will be allocated at maxEqNum=3 by engine._setup()
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 3 },  // (1) posNode, _posPrimeNode
      { extRow: 2, extCol: 3 },  // (2) negNode, _posPrimeNode
      { extRow: 3, extCol: 1 },  // (3) _posPrimeNode, posNode
      { extRow: 3, extCol: 2 },  // (4) _posPrimeNode, negNode
      { extRow: 1, extCol: 1 },  // (5) posNode, posNode
      { extRow: 2, extCol: 2 },  // (6) negNode, negNode
      { extRow: 3, extCol: 3 },  // (7) _posPrimeNode, _posPrimeNode
    ]);
  });
  it("PB-SPARK TSTALLOC sequence", () => {
    // ngspice anchor: swsetup.c:59-62 — 4 TSTALLOC entries, SW pattern.
    // Note: SW ordering differs from RES — cross terms come before NN diagonal.
    // Nodes: posNode=1 (SWposNode), negNode=2 (SWnegNode).
    // Expected order: (1,1), (1,2), (2,1), (2,2) — PP, PN, NP, NN
    const props = new PropertyBag();
    props.replaceModelParams({ ...SPARK_GAP_DEFAULTS });
    const el = createSparkGapElement(new Map([["pos", 1], ["neg", 2]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 }, // (SWposNode, SWposNode) — swsetup.c:59
      { extRow: 1, extCol: 2 }, // (SWposNode, SWnegNode) — swsetup.c:60
      { extRow: 2, extCol: 1 }, // (SWnegNode, SWposNode) — swsetup.c:61
      { extRow: 2, extCol: 2 }, // (SWnegNode, SWnegNode) — swsetup.c:62
    ]);
  });
  it.todo("PB-SUBCKT TSTALLOC sequence");
  it("PB-SW TSTALLOC sequence", () => {
    // ngspice anchor: swsetup.c:59-62 — 4 TSTALLOC entries, SW pattern.
    // Nodes: posNode=A1=1, negNode=B1=2.
    // TSTALLOC sequence (swsetup.c:59-62, line-for-line):
    //  1. (SWposNode=1, SWposNode=1) → (1,1)  _hPP
    //  2. (SWposNode=1, SWnegNode=2) → (1,2)  _hPN
    //  3. (SWnegNode=2, SWposNode=1) → (2,1)  _hNP
    //  4. (SWnegNode=2, SWnegNode=2) → (2,2)  _hNN
    const props = new PropertyBag();
    props.set("Ron", 1);
    props.set("Roff", 1e9);
    props.set("normallyClosed", false);
    props.set("closed", false);
    const el = new SwitchAnalogElement(new Map([["A1", 1], ["B1", 2]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (1) SWposNode, SWposNode — swsetup.c:59
      { extRow: 1, extCol: 2 },  // (2) SWposNode, SWnegNode — swsetup.c:60
      { extRow: 2, extCol: 1 },  // (3) SWnegNode, SWposNode — swsetup.c:61
      { extRow: 2, extCol: 2 },  // (4) SWnegNode, SWnegNode — swsetup.c:62
    ]);
  });
  it("PB-SW-DT TSTALLOC sequence", () => {
    // ngspice anchor: swsetup.c:59-62 applied twice (composite SW_AB + SW_AC).
    // Nodes: A1=1 (common), B1=2 (upper), C1=3 (lower).
    // SW_AB sub-element runs first (A1↔B1): posNode=1, negNode=2.
    // SW_AC sub-element runs second (A1↔C1): posNode=1, negNode=3.
    // Total: 8 entries.
    //
    // SW_AB TSTALLOC (swsetup.c:59-62):
    //  1. (A1=1, A1=1) → (1,1)  swAB._hPP
    //  2. (A1=1, B1=2) → (1,2)  swAB._hPN
    //  3. (B1=2, A1=1) → (2,1)  swAB._hNP
    //  4. (B1=2, B1=2) → (2,2)  swAB._hNN
    // SW_AC TSTALLOC (swsetup.c:59-62):
    //  5. (A1=1, A1=1) → (1,1)  swAC._hPP
    //  6. (A1=1, C1=3) → (1,3)  swAC._hPN
    //  7. (C1=3, A1=1) → (3,1)  swAC._hNP
    //  8. (C1=3, C1=3) → (3,3)  swAC._hNN
    const props = new PropertyBag();
    props.set("Ron", 1);
    props.set("Roff", 1e9);
    props.set("normallyClosed", false);
    props.set("closed", false);
    const el = new SwitchDTAnalogElement(new Map([["A1", 1], ["B1", 2], ["C1", 3]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // SW_AB (A1↔B1)
      { extRow: 1, extCol: 1 },  // (1) A1, A1 — swAB._hPP
      { extRow: 1, extCol: 2 },  // (2) A1, B1 — swAB._hPN
      { extRow: 2, extCol: 1 },  // (3) B1, A1 — swAB._hNP
      { extRow: 2, extCol: 2 },  // (4) B1, B1 — swAB._hNN
      // SW_AC (A1↔C1)
      { extRow: 1, extCol: 1 },  // (5) A1, A1 — swAC._hPP
      { extRow: 1, extCol: 3 },  // (6) A1, C1 — swAC._hPN
      { extRow: 3, extCol: 1 },  // (7) C1, A1 — swAC._hNP
      { extRow: 3, extCol: 3 },  // (8) C1, C1 — swAC._hNN
    ]);
  });
  it.todo("PB-TAPXFMR TSTALLOC sequence");
  it("PB-TIMER555 TSTALLOC sequence", () => {
    // Timer555 composite: setup() calls sub-elements in NGSPICE_LOAD_ORDER order,
    // then allocates the RS-FF glue handle last.
    //
    // Pin assignment (pinLayout: DIS, TRIG, THR, VCC, CTRL, OUT, RST, GND):
    //   DIS=1, TRIG=2, THR=3, VCC=4, CTRL=5, OUT=6, RST=7, GND=8  nodeCount=8
    //
    // Internal nodes (allocated in setup(), _maxEqNum starts at 9):
    //   nLower=9, nComp1Out=10, nComp2Out=11, nDisBase=12
    //
    // VCVS branch rows (allocated via makeCur inside vcvsset.c setup):
    //   comp1 branch=13, comp2 branch=14
    //
    // Sub-element TSTALLOC sequence:
    //
    // rDiv1 (RES, A=VCC=4, B=CTRL=5) — ressetup.c:46-49 — 4 entries:
    //   (4,4), (4,5), (5,4), (5,5)
    //
    // rDiv2 (RES, A=CTRL=5, B=nLower=9) — 4 entries:
    //   (5,5), (5,9), (9,5), (9,9)
    //
    // rDiv3 (RES, A=nLower=9, B=GND=8) — 4 entries:
    //   (9,9), (9,8), (8,9), (8,8)
    //
    // comp1 (VCVS, ctrl+=THR=3, ctrl-=CTRL=5, out+=nComp1Out=10, out-=GND=8) — vcvsset.c:53-58 — 6 entries:
    //   branch=13 (first makeCur call)
    //   1. (out+=10, branch=13)   :53
    //   2. (out-=8,  branch=13)   :54
    //   3. (branch=13, out+=10)   :55
    //   4. (branch=13, out-=8)    :56
    //   5. (branch=13, ctrl+=3)   :57
    //   6. (branch=13, ctrl-=5)   :58
    //
    // comp2 (VCVS, ctrl+=nLower=9, ctrl-=TRIG=2, out+=nComp2Out=11, out-=GND=8) — vcvsset.c:53-58 — 6 entries:
    //   branch=14 (second makeCur call)
    //   1. (out+=11, branch=14)   :53
    //   2. (out-=8,  branch=14)   :54
    //   3. (branch=14, out+=11)   :55
    //   4. (branch=14, out-=8)    :56
    //   5. (branch=14, ctrl+=9)   :57
    //   6. (branch=14, ctrl-=2)   :58
    //
    // bjtDis (BJT NPN, B=nDisBase=12, C=DIS=1, E=GND=8) — bjtsetup.c:435-464 — 23 calls:
    //   bp=12, cp=1, ep=8, substNode=0 (TrashCan, entries 19-21 skipped)
    //   sc=cp=1 (VERTICAL). 20 entries recorded:
    //   1. (cp=1,  cp=1)    _hCCP
    //   2. (bp=12, bp=12)   _hBBP
    //   3. (ep=8,  ep=8)    _hEEP
    //   4. (cp=1,  cp=1)    _hCPC
    //   5. (cp=1,  bp=12)   _hCPBP
    //   6. (cp=1,  ep=8)    _hCPEP
    //   7. (bp=12, bp=12)   _hBPB
    //   8. (bp=12, cp=1)    _hBPCP
    //   9. (bp=12, ep=8)    _hBPEP
    //  10. (ep=8,  ep=8)    _hEPE
    //  11. (ep=8,  cp=1)    _hEPCP
    //  12. (ep=8,  bp=12)   _hEPBP
    //  13. (cp=1,  cp=1)    _hCC
    //  14. (bp=12, bp=12)   _hBB
    //  15. (ep=8,  ep=8)    _hEE
    //  16. (cp=1,  cp=1)    _hCPCP
    //  17. (bp=12, bp=12)   _hBPBP
    //  18. (ep=8,  ep=8)    _hEPEP
    //  19. (substNode=0, substNode=0) → TrashCan, not recorded
    //  20. (sc=1,  substNode=0) → TrashCan, not recorded
    //  21. (substNode=0, sc=1) → TrashCan, not recorded
    //  22. (bp=12, cp=1)    _hBCP
    //  23. (cp=1,  bp=12)   _hCPB
    //
    // RS-FF glue (composite-owned, allocated last in setup()):
    //   (nDisBase=12, nDisBase=12)
    const entry = Timer555Definition.modelRegistry!["bipolar"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline model");
    const factory = entry.factory;
    const pinNodes = new Map<string, number>([
      ["DIS",  1],
      ["TRIG", 2],
      ["THR",  3],
      ["VCC",  4],
      ["CTRL", 5],
      ["OUT",  6],
      ["RST",  7],
      ["GND",  8],
    ]);
    const props = new PropertyBag();
    props.replaceModelParams({ vDrop: 1.5, rDischarge: 10 });
    const core = factory(pinNodes, props, () => 0);
    const el = Object.assign(core, {
      pinNodeIds: [1, 2, 3, 4, 5, 6, 7, 8],
      allNodeIds:  [1, 2, 3, 4, 5, 6, 7, 8],
    }) as unknown as AnalogElement;

    const circuit = makeMinimalCircuit([el], 8);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();

    expect(order).toEqual([
      // rDiv1: VCC=4, CTRL=5
      { extRow: 4, extCol: 4 },
      { extRow: 4, extCol: 5 },
      { extRow: 5, extCol: 4 },
      { extRow: 5, extCol: 5 },
      // rDiv2: CTRL=5, nLower=9
      { extRow: 5, extCol: 5 },
      { extRow: 5, extCol: 9 },
      { extRow: 9, extCol: 5 },
      { extRow: 9, extCol: 9 },
      // rDiv3: nLower=9, GND=8
      { extRow: 9, extCol: 9 },
      { extRow: 9, extCol: 8 },
      { extRow: 8, extCol: 9 },
      { extRow: 8, extCol: 8 },
      // comp1 VCVS: out+=10, out-=8, branch=13, ctrl+=3, ctrl-=5
      { extRow: 10, extCol: 13 },
      { extRow:  8, extCol: 13 },
      { extRow: 13, extCol: 10 },
      { extRow: 13, extCol:  8 },
      { extRow: 13, extCol:  3 },
      { extRow: 13, extCol:  5 },
      // comp2 VCVS: out+=11, out-=8, branch=14, ctrl+=9, ctrl-=2
      { extRow: 11, extCol: 14 },
      { extRow:  8, extCol: 14 },
      { extRow: 14, extCol: 11 },
      { extRow: 14, extCol:  8 },
      { extRow: 14, extCol:  9 },
      { extRow: 14, extCol:  2 },
      // bjtDis: B=nDisBase=12, C=DIS=1, E=GND=8
      { extRow:  1, extCol:  1 },  // _hCCP
      { extRow: 12, extCol: 12 },  // _hBBP
      { extRow:  8, extCol:  8 },  // _hEEP
      { extRow:  1, extCol:  1 },  // _hCPC
      { extRow:  1, extCol: 12 },  // _hCPBP
      { extRow:  1, extCol:  8 },  // _hCPEP
      { extRow: 12, extCol: 12 },  // _hBPB
      { extRow: 12, extCol:  1 },  // _hBPCP
      { extRow: 12, extCol:  8 },  // _hBPEP
      { extRow:  8, extCol:  8 },  // _hEPE
      { extRow:  8, extCol:  1 },  // _hEPCP
      { extRow:  8, extCol: 12 },  // _hEPBP
      { extRow:  1, extCol:  1 },  // _hCC
      { extRow: 12, extCol: 12 },  // _hBB
      { extRow:  8, extCol:  8 },  // _hEE
      { extRow:  1, extCol:  1 },  // _hCPCP
      { extRow: 12, extCol: 12 },  // _hBPBP
      { extRow:  8, extCol:  8 },  // _hEPEP
      // entries 19-21: substNode=0 → TrashCan, not recorded
      { extRow: 12, extCol:  1 },  // _hBCP
      { extRow:  1, extCol: 12 },  // _hCPB
      // outModel (DigitalOutputPinModel) setup: OUT=6 self-stamp
      { extRow:  6, extCol:  6 },
      // RS-FF glue handle (composite-owned, last)
      { extRow: 12, extCol: 12 },
    ]);
  });
  it.todo("PB-TLINE TSTALLOC sequence");
  it("PB-TRANSGATE TSTALLOC sequence", () => {
    // ngspice anchor: swsetup.c:59-62 applied twice (NFET SW then PFET SW).
    //
    // TransGateAnalogElement: composite of _nfetSW + _pfetSW sharing the same
    // signal path (out1=inNode, out2=outNode). Control pins (p1, p2) are not
    // part of the MNA matrix — only the signal path nodes are stamped.
    //
    // Nodes: out1=1 (inNode=SWposNode), out2=2 (outNode=SWnegNode).
    // setup() calls _nfetSW.setup(ctx) then _pfetSW.setup(ctx).
    //
    // NFET SW (D=1, S=2):
    //   swsetup.c:59-62 — 4 entries: (1,1),(1,2),(2,1),(2,2)
    //
    // PFET SW (D=1, S=2) — identical signal path:
    //   swsetup.c:59-62 — 4 entries: (1,1),(1,2),(2,1),(2,2)
    //
    // Total: 8 entries.
    const pinNodes = new Map<string, number>([
      ["p1", 3], ["p2", 4], ["out1", 1], ["out2", 2],
    ]);
    const el = new TransGateAnalogElement(pinNodes);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 4);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // NFET SW (D=out1=1, S=out2=2) — swsetup.c:59-62
      { extRow: 1, extCol: 1 },  // SWposPosptr
      { extRow: 1, extCol: 2 },  // SWposNegptr
      { extRow: 2, extCol: 1 },  // SWnegPosptr
      { extRow: 2, extCol: 2 },  // SWnegNegptr
      // PFET SW (D=out1=1, S=out2=2) — swsetup.c:59-62
      { extRow: 1, extCol: 1 },  // SWposPosptr
      { extRow: 1, extCol: 2 },  // SWposNegptr
      { extRow: 2, extCol: 1 },  // SWnegPosptr
      { extRow: 2, extCol: 2 },  // SWnegNegptr
    ]);
  });
  it.todo("PB-TRIAC TSTALLOC sequence");
  it.todo("PB-TRIODE TSTALLOC sequence");
  it.todo("PB-TUNNEL TSTALLOC sequence");
  it("PB-VARACTOR TSTALLOC sequence", () => {
    // ngspice anchor: diosetup.c:232-238 — 7 TSTALLOC entries (identical to DIO).
    // PB-VARACTOR per spec delegates to createDiodeElement, so the TSTALLOC
    // sequence is identical to PB-DIO with RS=0 (no internal node).
    // Nodes: posNode=1 (A), negNode=2 (K). _posPrimeNode = posNode = 1.
    const props = new PropertyBag();
    props.replaceModelParams({ ...DIODE_PARAM_DEFAULTS });
    const el = createDiodeElement(new Map([["A", 1], ["K", 2]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (1) posNode, _posPrimeNode
      { extRow: 2, extCol: 1 },  // (2) negNode, _posPrimeNode
      { extRow: 1, extCol: 1 },  // (3) _posPrimeNode, posNode
      { extRow: 1, extCol: 2 },  // (4) _posPrimeNode, negNode
      { extRow: 1, extCol: 1 },  // (5) posNode, posNode
      { extRow: 2, extCol: 2 },  // (6) negNode, negNode
      { extRow: 1, extCol: 1 },  // (7) _posPrimeNode, _posPrimeNode
    ]);
  });
  it("PB-VCCS TSTALLOC sequence", () => {
    // ngspice anchor: vccsset.c:43-46 — 4 TSTALLOC entries.
    // Nodes: ctrl+=1 (ctrlPosNode), ctrl-=2 (ctrlNegNode), out+=3 (posNode), out-=4 (negNode).
    // No branch row, no internal nodes.
    //
    // TSTALLOC sequence (vccsset.c:43-46):
    //  1. (posNode=3, ctrlPosNode=1)   :43
    //  2. (posNode=3, ctrlNegNode=2)   :44
    //  3. (negNode=4, ctrlPosNode=1)   :45
    //  4. (negNode=4, ctrlNegNode=2)   :46
    const rawExpr = parseExpression("0.001 * V(ctrl)");
    const deriv = simplify(differentiate(rawExpr, "V(ctrl)"));
    const el = new VCCSAnalogElement(rawExpr, deriv, "V(ctrl)", "voltage");
    el._pinNodes = new Map([["ctrl+", 1], ["ctrl-", 2], ["out+", 3], ["out-", 4]]);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 4);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 3, extCol: 1 },  // (1) posNode, ctrlPosNode   :43
      { extRow: 3, extCol: 2 },  // (2) posNode, ctrlNegNode   :44
      { extRow: 4, extCol: 1 },  // (3) negNode, ctrlPosNode   :45
      { extRow: 4, extCol: 2 },  // (4) negNode, ctrlNegNode   :46
    ]);
  });
  it("PB-VCVS TSTALLOC sequence", () => {
    // ngspice anchor: vcvsset.c:53-58 — 6 TSTALLOC entries.
    // Nodes: ctrl+=1 (ctrlPosNode), ctrl-=2 (ctrlNegNode), out+=3 (posNode), out-=4 (negNode).
    // Branch row allocated by engine._setup() at maxEqNum = nodeCount+1 = 5.
    //
    // TSTALLOC sequence (vcvsset.c:53-58):
    //  1. (posNode=3, branch=5)       :53
    //  2. (negNode=4, branch=5)       :54
    //  3. (branch=5, posNode=3)       :55
    //  4. (branch=5, negNode=4)       :56
    //  5. (branch=5, ctrlPosNode=1)   :57
    //  6. (branch=5, ctrlNegNode=2)   :58
    const rawExpr = parseExpression("1.0 * V(ctrl)");
    const deriv = simplify(differentiate(rawExpr, "V(ctrl)"));
    const el = new VCVSAnalogElement(rawExpr, deriv, "V(ctrl)", "voltage");
    el._pinNodes = new Map([["ctrl+", 1], ["ctrl-", 2], ["out+", 3], ["out-", 4]]);
    el.label = "vcvs1";
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 4);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 3, extCol: 5 },  // (1) posNode, branch    :53
      { extRow: 4, extCol: 5 },  // (2) negNode, branch    :54
      { extRow: 5, extCol: 3 },  // (3) branch,  posNode   :55
      { extRow: 5, extCol: 4 },  // (4) branch,  negNode   :56
      { extRow: 5, extCol: 1 },  // (5) branch,  ctrlPos   :57
      { extRow: 5, extCol: 2 },  // (6) branch,  ctrlNeg   :58
    ]);
  });
  it.todo("PB-VSRC-AC TSTALLOC sequence");
  it.todo("PB-VSRC-DC TSTALLOC sequence");
  it.todo("PB-VSRC-VAR TSTALLOC sequence");
  it.todo("PB-XFMR TSTALLOC sequence");
  it("PB-ZENER TSTALLOC sequence", () => {
    // ngspice anchor: diosetup.c:232-238 — 7 TSTALLOC entries (identical to DIO).
    // ZenerDiode uses createZenerElement (simplified model) which has
    // the same TSTALLOC sequence as createDiodeElement.
    // RS=0 (default in ZENER_PARAM_DEFAULTS): _posPrimeNode = posNode = 1.
    // Nodes: posNode=1 (A), negNode=2 (K).
    //
    // TSTALLOC sequence (same as DIO with RS=0):
    //  1. (1,1), 2. (2,1), 3. (1,1), 4. (1,2), 5. (1,1), 6. (2,2), 7. (1,1)
    const props = new PropertyBag();
    props.replaceModelParams({ ...ZENER_PARAM_DEFAULTS });
    const el = createZenerElement(new Map([["A", 1], ["K", 2]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (1) posNode, _posPrimeNode
      { extRow: 2, extCol: 1 },  // (2) negNode, _posPrimeNode
      { extRow: 1, extCol: 1 },  // (3) _posPrimeNode, posNode
      { extRow: 1, extCol: 2 },  // (4) _posPrimeNode, negNode
      { extRow: 1, extCol: 1 },  // (5) posNode, posNode
      { extRow: 2, extCol: 2 },  // (6) negNode, negNode
      { extRow: 1, extCol: 1 },  // (7) _posPrimeNode, _posPrimeNode
    ]);
  });
});
