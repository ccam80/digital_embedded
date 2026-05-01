/**
 * setup-stamp-order.test.ts
 *
 * Invariant: each ngspice-anchored component's setup() must call
 * solver.allocElement() in exactly the order the corresponding ngspice
 * *setup.c file calls TSTALLOC- position-for-position.
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
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import { TransGateAnalogElement } from "../../../components/switching/trans-gate.js";
import { RelayDefinition } from "../../../components/switching/relay.js";
import { RelayDTDefinition } from "../../../components/switching/relay-dt.js";
import { createAnalogFuseElement, ANALOG_FUSE_DEFAULTS } from "../../../components/passives/analog-fuse.js";
import { AnalogCapacitorElement, CAPACITOR_DEFAULTS } from "../../../components/passives/capacitor.js";
import { AnalogInductorElement, INDUCTOR_DEFAULTS } from "../../../components/passives/inductor.js";
import { makeCurrentSource } from "../../../components/sources/current-source.js";
import { makeVariableRailElement, VARIABLE_RAIL_DEFAULTS } from "../../../components/sources/variable-rail.js";
import { ScrDefinition, SCR_PARAM_DEFAULTS } from "../../../components/semiconductors/scr.js";
import { TriacDefinition, TRIAC_PARAM_DEFAULTS } from "../../../components/semiconductors/triac.js";
import { createDiacElement } from "../../../components/semiconductors/diac.js";
import { createTriodeElement, TRIODE_PARAM_DEFAULTS } from "../../../components/semiconductors/triode.js";
import { createPJfetElement, PJFET_PARAM_DEFAULTS } from "../../../components/semiconductors/pjfet.js";
import { FGNFETAnalogElement } from "../../../components/switching/fgnfet.js";
import { FGPFETAnalogElement } from "../../../components/switching/fgpfet.js";
import { POTENTIOMETER_DEFAULTS, PotentiometerDefinition } from "../../../components/passives/potentiometer.js";
import { OpAmpDefinition, OPAMP_DEFAULTS } from "../../../components/active/opamp.js";
import { RealOpAmpDefinition, REAL_OPAMP_DEFAULTS } from "../../../components/active/real-opamp.js";
import { OTADefinition, OTA_DEFAULTS } from "../../../components/active/ota.js";
import { VoltageComparatorDefinition, COMPARATOR_DEFAULTS } from "../../../components/active/comparator.js";
import { SchmittInvertingDefinition, SCHMITT_DEFAULTS } from "../../../components/active/schmitt-trigger.js";
import { OptocouplerDefinition, OPTOCOUPLER_DEFAULTS } from "../../../components/active/optocoupler.js";
import { ADCDefinition, ADC_DEFAULTS } from "../../../components/active/adc.js";
import { DACDefinition, DAC_DEFAULTS } from "../../../components/active/dac.js";
import { CrystalDefinition, CRYSTAL_DEFAULTS } from "../../../components/passives/crystal.js";
import { PolarizedCapDefinition, POLARIZED_CAP_MODEL_DEFAULTS } from "../../../components/passives/polarized-cap.js";
import { TransformerDefinition, TRANSFORMER_DEFAULTS } from "../../../components/passives/transformer.js";
import { TappedTransformerDefinition, TAPPED_TRANSFORMER_DEFAULTS } from "../../../components/passives/tapped-transformer.js";
import { TransmissionLineDefinition, TRANSMISSION_LINE_DEFAULTS } from "../../../components/passives/transmission-line.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../../components/sources/dc-voltage-source.js";
import { makeAcVoltageSourceElement, AC_VOLTAGE_SOURCE_DEFAULTS } from "../../../components/sources/ac-voltage-source.js";
import { MemristorElement, MEMRISTOR_DEFAULTS } from "../../../components/passives/memristor.js";
import { ResistorDefinition, RESISTOR_DEFAULTS } from "../../../components/passives/resistor.js";

import { SwitchSPSTDefinition, SwitchSPDTDefinition, ANALOG_SWITCH_DEFAULTS } from "../../../components/active/analog-switch.js";

// ---------------------------------------------------------------------------
// Minimal compiled-circuit fixture builder for setup-stamp-order tests.
//
// Builds the minimal ConcreteCompiledAnalogCircuit shape needed to call
// engine.init() and (engine as any)._setup(). Only `elements` and
// `nodeCount` are structurally required by _setup()- all other fields
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

describe("setup-stamp-order", () => {
  it("PB-ADC TSTALLOC sequence", () => {
    // ADC (CompositeElement): setup() allocates 2 state slots then calls super.setup()
    // which forwards to getSubElements(): [vinPin, clkPin, eocPin, ...digitalPins, ...childElements]
    // DigitalInputPinModel.setup() → 1 entry: (nodeId, nodeId).
    // DigitalOutputPinModel in "direct" role → 1 entry: (nodeId, nodeId).
    // childElements: CAP children. cIn defaults to 5e-12 (nonzero) → vinPin and clkPin each have
    // an AnalogCapacitorElement child. cOut=0 for output pins → no CAP children for output pins.
    // CAP child setup (capsetup.c:114-117): pos=nodeId, neg=0 (gnd) → only (nodeId,nodeId) allocated.
    //
    // Using 2-bit "unipolar-instant" ADC:
    //   Pins: VIN=1, CLK=2, VREF=3, GND=0 (ground), EOC=4, D0=5, D1=6
    //
    // setup() order:
    //   allocStates(2)
    //   vinPin(node=1).setup  → (1,1)
    //   clkPin(node=2).setup  → (2,2)
    //   eocPin(node=4).setup  → (4,4)
    //   digitalPins[0](node=5).setup → (5,5)
    //   digitalPins[1](node=6).setup → (6,6)
    //   childElements[vinCap](pos=1,neg=0).setup  → (1,1)   [capsetup.c:114: pos≠0; 115: neg=0 skipped]
    //   childElements[clkCap](pos=2,neg=0).setup  → (2,2)
    const adcEntry = ADCDefinition.modelRegistry!["unipolar-instant"]!;
    if (adcEntry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const adcFactory = adcEntry.factory;
    const pinNodes = new Map<string, number>([
      ["VIN",  1],
      ["CLK",  2],
      ["VREF", 3],
      ["GND",  0],
      ["EOC",  4],
      ["D0",   5],
      ["D1",   6],
    ]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...ADC_DEFAULTS });
    props.set("bits", 2);
    const el = adcFactory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 6);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // vinPin(node=1) diagonal
      { extRow: 2, extCol: 2 },  // clkPin(node=2) diagonal
      { extRow: 4, extCol: 4 },  // eocPin(node=4) diagonal
      { extRow: 5, extCol: 5 },  // digitalPins[0](node=5) diagonal
      { extRow: 6, extCol: 6 },  // digitalPins[1](node=6) diagonal
      { extRow: 1, extCol: 1 },  // vinCap child: capsetup.c:114 posNode=1
      { extRow: 2, extCol: 2 },  // clkCap child: capsetup.c:114 posNode=2
    ]);
  });
  it("PB-AFUSE TSTALLOC sequence", () => {
    // ngspice anchor: ressetup.c:46-49- 4 TSTALLOC entries (RES pattern).
    // AnalogFuseElement uses pin keys "out1" (posNode) and "out2" (negNode).
    // Already tested above as PB-FUSE. This is a duplicate with canonical pin names.
    // Nodes: posNode=1 ("out1"), negNode=2 ("out2").
    // Expected: (1,1), (2,2), (1,2), (2,1)- PP, NN, PN, NP
    const props = new PropertyBag();
    props.replaceModelParams({ ...ANALOG_FUSE_DEFAULTS });
    const el = createAnalogFuseElement(new Map([["out1", 1], ["out2", 2]]), props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (RESposNode, RESposNode)- ressetup.c:46
      { extRow: 2, extCol: 2 },  // (RESnegNode, RESnegNode)- ressetup.c:47
      { extRow: 1, extCol: 2 },  // (RESposNode, RESnegNode)- ressetup.c:48
      { extRow: 2, extCol: 1 },  // (RESnegNode, RESposNode)- ressetup.c:49
    ]);
  });
  it("PB-ANALOG_SWITCH TSTALLOC sequence", () => {
    // ngspice anchor: swsetup.c:59-62 (SW pattern applied once for SPST, twice for SPDT).
    //
    // SPST (in=1, out=2, ctrl=3): 4 entries- swsetup.c:59-62
    //   (in,in),(in,out),(out,in),(out,out) = (1,1),(1,2),(2,1),(2,2)
    //
    // SPDT (com=1, no=2, nc=3, ctrl=4): 8 entries- swsetup.c:59-62 applied to NO path then NC path
    //   NO path (pos=com=1, neg=no=2): (1,1),(1,2),(2,1),(2,2)
    //   NC path (pos=com=1, neg=nc=3): (1,1),(1,3),(3,1),(3,3)
    const spstProps = new PropertyBag();
    spstProps.replaceModelParams({ ...ANALOG_SWITCH_DEFAULTS });
    const spstPinNodes = new Map<string, number>([
      ["in", 1], ["out", 2], ["ctrl", 3],
    ]);
    const spstEntry = SwitchSPSTDefinition.modelRegistry!["behavioral"]!;
    if (spstEntry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const spstFactory = spstEntry.factory;
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
    const spdtEntry = SwitchSPDTDefinition.modelRegistry!["behavioral"]!;
    if (spdtEntry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const spdtFactory = spdtEntry.factory;
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
    // ngspice anchor: bjtsetup.c:435-464- 23 TSTALLOC entries.
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
    //  1. (2,2) _hCCP - colNode, cp
    //  2. (1,1) _hBBP - baseNode, bp
    //  3. (3,3) _hEEP - emitNode, ep
    //  4. (2,2) _hCPC - cp, colNode
    //  5. (2,1) _hCPBP- cp, bp
    //  6. (2,3) _hCPEP- cp, ep
    //  7. (1,1) _hBPB - bp, baseNode
    //  8. (1,2) _hBPCP- bp, cp
    //  9. (1,3) _hBPEP- bp, ep
    // 10. (3,3) _hEPE - ep, emitNode
    // 11. (3,2) _hEPCP- ep, cp
    // 12. (3,1) _hEPBP- ep, bp
    // 13. (2,2) _hCC  - colNode, colNode
    // 14. (1,1) _hBB  - baseNode, baseNode
    // 15. (3,3) _hEE  - emitNode, emitNode
    // 16. (2,2) _hCPCP- cp, cp
    // 17. (1,1) _hBPBP- bp, bp
    // 18. (3,3) _hEPEP- ep, ep
    // 19. SKIPPED (0,0)- substNode ground → TrashCan, not in _insertionOrder
    // 20. SKIPPED (2,0)- sc, substNode → TrashCan
    // 21. SKIPPED (0,2)- substNode, sc → TrashCan
    // 22. (1,2) _hBCP - baseNode, cp
    // 23. (2,1) _hCPB - cp, baseNode
    const props = new PropertyBag();
    props.replaceModelParams({ ...BJT_NPN_DEFAULTS });
    const el = createBjtElement(new Map([["B", 1], ["C", 2], ["E", 3]]), props, () => 0);
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
  it("PB-CAP TSTALLOC sequence", () => {
    // ngspice anchor: capsetup.c:114-117- 4 TSTALLOC entries with ground guards.
    // Both posNode and negNode non-zero → all 4 entries recorded.
    // Nodes: posNode=1 ("pos"), negNode=2 ("neg").
    // Expected: (1,1), (2,2), (1,2), (2,1)- PP, NN, PN, NP
    const capProps = new PropertyBag();
    capProps.replaceModelParams({ ...CAPACITOR_DEFAULTS, capacitance: 1e-6 });
    const el = new AnalogCapacitorElement(new Map([["pos", 1], ["neg", 2]]), capProps);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // capsetup.c:114 (posNode, posNode)
      { extRow: 2, extCol: 2 },  // capsetup.c:115 (negNode, negNode)
      { extRow: 1, extCol: 2 },  // capsetup.c:116 (posNode, negNode)
      { extRow: 2, extCol: 1 },  // capsetup.c:117 (negNode, posNode)
    ]);
  });
  it("PB-CCCS TSTALLOC sequence", () => {
    // ngspice anchor: cccsset.c:49-50- 2 TSTALLOC entries.
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
      _pinNodes: new Map([["pos", 1], ["neg", 0]]),
      _stateBase: -1,
      get branchIndex(): number { return senseVsrcBranch; },
      set branchIndex(v: number) { senseVsrcBranch = v; },
      ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VSRC,
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

    // nodeCount=2; _maxEqNum starts at nodeCount+1 = 3.
    // CCCS (order 18) runs first → findBranchFor → makeCur → contBranch=3.
    const circuit = makeMinimalCircuit([cccs as unknown as AnalogElement, senseVsrc as unknown as AnalogElement], 2);
    const engine  = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 3 },  // :49 (posNode=1, contBranch=3)- _hPCtBr
      { extRow: 2, extCol: 3 },  // :50 (negNode=2, contBranch=3)- _hNCtBr
    ]);
  });
  it("PB-CCVS TSTALLOC sequence", () => {
    // ngspice anchor: ccvsset.c:58-62- 5 TSTALLOC entries.
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
    //  1. :58 (posNode=1,   ownBranch=3)- _hPIbr
    //  2. :59 (negNode=2,   ownBranch=3)- _hNIbr
    //  3. :60 (ownBranch=3, negNode=2)  - _hIbrN
    //  4. :61 (ownBranch=3, posNode=1)  - _hIbrP
    //  5. :62 (ownBranch=3, contBranch=4)— _hIbrCtBr

    // Build a sense VSRC element with findBranchFor on the instance.
    let senseVsrcBranch = -1;
    const senseVsrc: AnalogElement & { findBranchFor(name: string, ctx: SetupContext): number } = {
      _pinNodes: new Map([["pos", 1], ["neg", 0]]),
      _stateBase: -1,
      get branchIndex(): number { return senseVsrcBranch; },
      set branchIndex(v: number) { senseVsrcBranch = v; },
      ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VSRC,
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
      { extRow: 1, extCol: 3 },  // :58 (posNode=1,   ownBranch=3)- _hPIbr
      { extRow: 2, extCol: 3 },  // :59 (negNode=2,   ownBranch=3)- _hNIbr
      { extRow: 3, extCol: 2 },  // :60 (ownBranch=3, negNode=2)  - _hIbrN
      { extRow: 3, extCol: 1 },  // :61 (ownBranch=3, posNode=1)  - _hIbrP
      { extRow: 3, extCol: 4 },  // :62 (ownBranch=3, contBranch=4)— _hIbrCtBr
    ]);
  });
  it("PB-COMPARATOR TSTALLOC sequence", () => {
    // VoltageComparatorDefinition "open-collector" model (canonical behavioural form).
    // setup() allocates hOutDiag = (nOut, nOut) if nOut > 0, then allocStates,
    // then calls child.setup() for each CAP child (cOut=0 default → no cap children).
    // nOut=3, so 1 entry: (3,3).
    //
    // Pins: in+=1 (nInP), in-=2 (nInN), out=3 (nOut), gnd=0 (GND).
    // Expected: (3,3)
    const entry = VoltageComparatorDefinition.modelRegistry!["open-collector"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([
      ["in+", 1], ["in-", 2], ["out", 3], ["gnd", 0],
    ]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...COMPARATOR_DEFAULTS });
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 3, extCol: 3 },  // (nOut, nOut) open-collector diagonal
    ]);
  });
  it("PB-CRYSTAL TSTALLOC sequence", () => {
    // CrystalElement composite: Rs(RES,4) + Ls(IND,5) + Cs(CAP,4) + C0(CAP,4) = 17 entries.
    //
    // External pins: A=1 (aNode), B=2 (bNode).
    // Internal nodes allocated in setup(): n1=3 (Rs↔Ls junction), n2=4 (Ls↔Cs junction).
    // Branch row allocated: b=5 (Ls branch).
    //
    // Rs (ressetup.c:46-49, pos=aNode=1, neg=n1=3):
    //   (1,1),(3,3),(1,3),(3,1)
    //
    // Ls (indsetup.c:96-100, posNode=n1=3, negNode=n2=4, branch=b=5):
    //   n1≠0: (3,5)  n2≠0: (4,5)  n2≠0: (5,4)  n1≠0: (5,3)  (5,5)
    //
    // Cs (capsetup.c:114-117, posNode=n2=4, negNode=bNode=2):
    //   n2≠0: (4,4)  bNode≠0: (2,2)  n2≠0 & bNode≠0: (4,2),(2,4)
    //
    // C0 (capsetup.c:114-117, posNode=aNode=1, negNode=bNode=2):
    //   aNode≠0: (1,1)  bNode≠0: (2,2)  aNode≠0 & bNode≠0: (1,2),(2,1)
    const props = new PropertyBag();
    props.replaceModelParams({ ...CRYSTAL_DEFAULTS });
    const entry = CrystalDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([["A", 1], ["B", 2]]);
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // Rs (ressetup.c:46-49): aNode=1, n1=3
      { extRow: 1, extCol: 1 },
      { extRow: 3, extCol: 3 },
      { extRow: 1, extCol: 3 },
      { extRow: 3, extCol: 1 },
      // Ls (indsetup.c:96-100): n1=3, n2=4, b=5
      { extRow: 3, extCol: 5 },
      { extRow: 4, extCol: 5 },
      { extRow: 5, extCol: 4 },
      { extRow: 5, extCol: 3 },
      { extRow: 5, extCol: 5 },
      // Cs (capsetup.c:114-117): n2=4, bNode=2
      { extRow: 4, extCol: 4 },
      { extRow: 2, extCol: 2 },
      { extRow: 4, extCol: 2 },
      { extRow: 2, extCol: 4 },
      // C0 (capsetup.c:114-117): aNode=1, bNode=2
      { extRow: 1, extCol: 1 },
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 2 },
      { extRow: 2, extCol: 1 },
    ]);
  });
  it("PB-DAC TSTALLOC sequence", () => {
    // DACCompositeElement (1-bit "unipolar" DAC) setup:
    //   Pins: VREF=1, OUT=2, GND=0, D0=3
    //   vcvsBranch = ctx.makeCur → branch=4 (nodeCount+1=4)
    //
    // VCVS TSTALLOC (vcvsset.c:53-58) with nOut=2, nGnd=0, nVref=1:
    //   :53 nOut>0:  allocElement(nOut=2, branch=4)  → (2,4)  hVCVSPosIbr
    //   :54 nGnd>0:  SKIP (nGnd=0)
    //   :55 nOut>0:  allocElement(branch=4, nOut=2)  → (4,2)  hVCVSIbrPos
    //   :56 nGnd>0:  SKIP
    //   :57 nVref>0: allocElement(branch=4, nVref=1) → (4,1)  hVCVSIbrContPos
    //   :58 nGnd>0:  SKIP
    //
    // super.setup() → getSubElements() = [inputModels[0](D0,node=3), vrefModel(VREF,node=1), childCaps]
    // DigitalInputPinModel.setup(): allocates (nodeId, nodeId) if nodeId>0
    //   D0 input model  → (3,3)
    //   VREF input model → (1,1)
    // childElements: cIn=5e-12 (nonzero default) → vinCap for each input model
    //   D0 cap (pos=3, neg=0) → (3,3)
    //   VREF cap (pos=1, neg=0) → (1,1)
    //
    // Total: 3 VCVS + 2 pin + 2 cap = 7 entries.
    const dacEntry = DACDefinition.modelRegistry!["unipolar"]!;
    if (dacEntry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([
      ["VREF", 1], ["OUT", 2], ["GND", 0], ["D0", 3],
    ]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...DAC_DEFAULTS });
    const el = dacEntry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 2, extCol: 4 },  // :53 hVCVSPosIbr (nOut=2, branch=4)
      { extRow: 4, extCol: 2 },  // :55 hVCVSIbrPos (branch=4, nOut=2)
      { extRow: 4, extCol: 1 },  // :57 hVCVSIbrContPos (branch=4, nVref=1)
      { extRow: 3, extCol: 3 },  // D0 inputModel diagonal
      { extRow: 1, extCol: 1 },  // VREF inputModel diagonal
      { extRow: 3, extCol: 3 },  // D0 cap child (pos=3, neg=0)
      { extRow: 1, extCol: 1 },  // VREF cap child (pos=1, neg=0)
    ]);
  });
  it("PB-DIAC TSTALLOC sequence", () => {
    // Diac composite: dFwd.setup(ctx) + dRev.setup(ctx)- 7 + 7 = 14 entries.
    // dFwd: posNode=A=1, negNode=B=2, RS=0 → _posPrimeNode=posNode=1
    //   (diosetup.c:232-238, 7 entries):
    //   (1,1),(2,1),(1,1),(1,2),(1,1),(2,2),(1,1)
    // dRev: posNode=B=2, negNode=A=1, RS=0 → _posPrimeNode=posNode=2
    //   (diosetup.c:232-238, 7 entries):
    //   (2,2),(1,2),(2,2),(2,1),(2,2),(1,1),(2,2)
    //
    // Nodes: A=1, B=2.
    const props = new PropertyBag();
    props.replaceModelParams({ ...DIODE_PARAM_DEFAULTS });
    const el = createDiacElement(new Map([["A", 1], ["B", 2]]), props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // dFwd (A=1→B=2): diosetup.c:232-238
      { extRow: 1, extCol: 1 },
      { extRow: 2, extCol: 1 },
      { extRow: 1, extCol: 1 },
      { extRow: 1, extCol: 2 },
      { extRow: 1, extCol: 1 },
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 1 },
      // dRev (B=2→A=1): diosetup.c:232-238
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 2 },
      { extRow: 2, extCol: 2 },
      { extRow: 2, extCol: 1 },
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 1 },
      { extRow: 2, extCol: 2 },
    ]);
  });
  it("PB-DIO TSTALLOC sequence", () => {
    // ngspice anchor: diosetup.c:232-238- 7 TSTALLOC entries.
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
    const el = createDiodeElement(new Map([["A", 1], ["K", 2]]), props, () => 0);
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
  it("PB-FGNFET TSTALLOC sequence", () => {
    // FGNFETAnalogElement: setup() allocates fg=internal node (nodeCount+1=4),
    // then calls sub-elements sorted by ngspiceLoadOrder (CAP=17 before MOS=35).
    //
    // Pins: D=1, S=2, G=3 (external gate pin, not used in MNA- fg replaces it).
    // Internal fg node = 4 (makeVolt allocates nodeCount+1).
    //
    // CAP sub (capsetup.c:114-117, pos=fg=4, neg=0):
    //   allocStates(2)
    //   posNode=4≠0: (4,4)  PP
    //   negNode=0: all guards fail → only (4,4) recorded
    //
    // MOS sub (mos1set.c:186-207, 22 entries, G=fg=4, D=1, S=2, B=S=2):
    //   (D,D)=>(1,1), (G,G)=>(4,4), (S,S)=>(2,2), (B,B)=>(2,2)
    //   (dp,dp)=>(1,1), (sp,sp)=>(2,2), (D,dp)=>(1,1)
    //   (G,B)=>(4,2), (G,dp)=>(4,1), (G,sp)=>(4,2)
    //   (S,sp)=>(2,2), (B,dp)=>(2,1), (B,sp)=>(2,2)
    //   (dp,sp)=>(1,2), (dp,D)=>(1,1), (B,G)=>(2,4)
    //   (dp,G)=>(1,4), (sp,G)=>(2,4), (sp,S)=>(2,2)
    //   (dp,B)=>(1,2), (sp,B)=>(2,2), (sp,dp)=>(2,1)
    //
    // Total: 1 + 22 = 23 entries.
    const pinNodes = new Map<string, number>([["D", 1], ["S", 2], ["G", 3]]);
    const el = new FGNFETAnalogElement(pinNodes);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // CAP sub (pos=fg=4, neg=0): only PP entry recorded
      { extRow: 4, extCol: 4 },
      // MOS sub (mos1set.c:186-207): G=fg=4, D=1, S=2, B=2, dp=1, sp=2
      { extRow: 1, extCol: 1 },  // (1)  D,D
      { extRow: 4, extCol: 4 },  // (2)  G,G
      { extRow: 2, extCol: 2 },  // (3)  S,S
      { extRow: 2, extCol: 2 },  // (4)  B,B=S,S
      { extRow: 1, extCol: 1 },  // (5)  dp,dp
      { extRow: 2, extCol: 2 },  // (6)  sp,sp
      { extRow: 1, extCol: 1 },  // (7)  D,dp
      { extRow: 4, extCol: 2 },  // (8)  G,B=G,S
      { extRow: 4, extCol: 1 },  // (9)  G,dp=G,D
      { extRow: 4, extCol: 2 },  // (10) G,sp=G,S
      { extRow: 2, extCol: 2 },  // (11) S,sp
      { extRow: 2, extCol: 1 },  // (12) B,dp=S,D
      { extRow: 2, extCol: 2 },  // (13) B,sp=S,S
      { extRow: 1, extCol: 2 },  // (14) dp,sp=D,S
      { extRow: 1, extCol: 1 },  // (15) dp,D
      { extRow: 2, extCol: 4 },  // (16) B,G=S,G
      { extRow: 1, extCol: 4 },  // (17) dp,G=D,G
      { extRow: 2, extCol: 4 },  // (18) sp,G=S,G
      { extRow: 2, extCol: 2 },  // (19) sp,S
      { extRow: 1, extCol: 2 },  // (20) dp,B=D,S
      { extRow: 2, extCol: 2 },  // (21) sp,B=S,S
      { extRow: 2, extCol: 1 },  // (22) sp,dp=S,D
    ]);
  });
  it("PB-FGPFET TSTALLOC sequence", () => {
    // FGPFETAnalogElement: identical TSTALLOC sequence to FGNFET.
    // setup() allocates fg=internal node (nodeCount+1=4), then CAP (pos=fg=4, neg=0)
    // then MOS (22 entries, G=fg=4, D=1, S=2, B=S=2).
    // Polarity difference (PMOS vs NMOS) is load-time only- stamp order is identical.
    //
    // Pins: D=1, S=2, G=3.
    // Total: 1 (CAP PP) + 22 (MOS) = 23 entries.
    const pinNodes = new Map<string, number>([["D", 1], ["S", 2], ["G", 3]]);
    const el = new FGPFETAnalogElement(pinNodes);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // CAP sub (pos=fg=4, neg=0): only PP entry recorded
      { extRow: 4, extCol: 4 },
      // MOS sub (mos1set.c:186-207): G=fg=4, D=1, S=2, B=2, dp=1, sp=2
      { extRow: 1, extCol: 1 },
      { extRow: 4, extCol: 4 },
      { extRow: 2, extCol: 2 },
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 1 },
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 1 },
      { extRow: 4, extCol: 2 },
      { extRow: 4, extCol: 1 },
      { extRow: 4, extCol: 2 },
      { extRow: 2, extCol: 2 },
      { extRow: 2, extCol: 1 },
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 2 },
      { extRow: 1, extCol: 1 },
      { extRow: 2, extCol: 4 },
      { extRow: 1, extCol: 4 },
      { extRow: 2, extCol: 4 },
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 2 },
      { extRow: 2, extCol: 2 },
      { extRow: 2, extCol: 1 },
    ]);
  });
  it("PB-FUSE TSTALLOC sequence", () => {
    // ngspice anchor: ressetup.c:46-49- 4 TSTALLOC entries (RES pattern).
    // AnalogFuseElement uses pin keys "out1" (posNode) and "out2" (negNode).
    // Nodes: posNode=1, negNode=2.
    //
    // Expected order: (1,1),(2,2),(1,2),(2,1)- PP, NN, PN, NP
    const props = new PropertyBag();
    props.replaceModelParams({ ...ANALOG_FUSE_DEFAULTS });
    const el = createAnalogFuseElement(new Map([["out1", 1], ["out2", 2]]), props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (RESposNode, RESposNode)- ressetup.c:46
      { extRow: 2, extCol: 2 },  // (RESnegNode, RESnegNode)- ressetup.c:47
      { extRow: 1, extCol: 2 },  // (RESposNode, RESnegNode)- ressetup.c:48
      { extRow: 2, extCol: 1 },  // (RESnegNode, RESposNode)- ressetup.c:49
    ]);
  });
  it("PB-IND TSTALLOC sequence", () => {
    // ngspice anchor: indsetup.c:96-100- 5 TSTALLOC entries.
    // posNode=1 ("pos"), negNode=2 ("neg"), branch=3 (nodeCount+1).
    // Both posNode and negNode non-zero → all 5 entries recorded.
    //
    // Expected:
    //  1. (posNode=1, branch=3) - INDposNode, INDbrEq
    //  2. (negNode=2, branch=3) - INDnegNode, INDbrEq
    //  3. (branch=3,  negNode=2)- INDbrEq,    INDnegNode
    //  4. (branch=3,  posNode=1)- INDbrEq,    INDposNode
    //  5. (branch=3,  branch=3) - INDbrEq,    INDbrEq
    const indProps = new PropertyBag();
    indProps.replaceModelParams({ ...INDUCTOR_DEFAULTS, inductance: 1e-3 });
    const el = new AnalogInductorElement(new Map([["pos", 1], ["neg", 2]]), indProps);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 3 },  // (INDposNode, INDbrEq)- indsetup.c:96
      { extRow: 2, extCol: 3 },  // (INDnegNode, INDbrEq)- indsetup.c:97
      { extRow: 3, extCol: 2 },  // (INDbrEq,    INDnegNode)- indsetup.c:98
      { extRow: 3, extCol: 1 },  // (INDbrEq,    INDposNode)- indsetup.c:99
      { extRow: 3, extCol: 3 },  // (INDbrEq,    INDbrEq)  - indsetup.c:100
    ]);
  });
  it("PB-ISRC TSTALLOC sequence", () => {
    // ngspice anchor: isrcset.c- ISRC has an empty setup() body (0 TSTALLOC entries).
    // Current sources stamp only into the RHS vector (no G-matrix entries).
    // Expected: [] (empty insertion order).
    const props = new PropertyBag();
    props.replaceModelParams({ current: 0.01 });
    const el = makeCurrentSource(new Map([["pos", 1], ["neg", 2]]), props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([]);
  });
  it("PB-LDR TSTALLOC sequence", () => {
    // ngspice anchor: ressetup.c:46-49- 4 TSTALLOC entries, RES pattern.
    // Nodes: posNode=1, negNode=2.
    // Expected order: (1,1), (2,2), (1,2), (2,1)- PP, NN, PN, NP
    const props = new PropertyBag();
    props.replaceModelParams({ ...LDR_DEFAULTS });
    const el = createLDRElement(new Map([["pos", 1], ["neg", 2]]), props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 }, // (posNode, posNode)- ressetup.c:46
      { extRow: 2, extCol: 2 }, // (negNode, negNode)- ressetup.c:47
      { extRow: 1, extCol: 2 }, // (posNode, negNode)- ressetup.c:48
      { extRow: 2, extCol: 1 }, // (negNode, posNode)- ressetup.c:49
    ]);
  });
  it("PB-MEMR TSTALLOC sequence", () => {
    // ngspice anchor: ressetup.c:46-49- 4 TSTALLOC entries (RES pattern with ground guards).
    // MemristorElement uses pin keys "A" (posNode) and "B" (negNode).
    // Both nodes non-zero → all 4 entries recorded.
    // Nodes: A=1 (posNode), B=2 (negNode).
    // Expected: (1,1),(2,2),(1,2),(2,1)- PP, NN, PN, NP
    const memrProps = new PropertyBag();
    memrProps.replaceModelParams({ ...MEMRISTOR_DEFAULTS });
    const el = new MemristorElement(new Map([["A", 1], ["B", 2]]), memrProps);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (A, A)- ressetup.c:46
      { extRow: 2, extCol: 2 },  // (B, B)- ressetup.c:47
      { extRow: 1, extCol: 2 },  // (A, B)- ressetup.c:48
      { extRow: 2, extCol: 1 },  // (B, A)- ressetup.c:49
    ]);
  });

  it("PB-NFET TSTALLOC sequence", () => {
    // ngspice anchor: swsetup.c:59-62- 4 stamps, D=posNode, S=negNode
    // drainNode=1, sourceNode=2
    // Expected order: (1,1), (1,2), (2,1), (2,2)- PP, PN, NP, NN
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
    // ngspice anchor: jfetset.c:166-180- 15 TSTALLOC entries.
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
    const el = createNJfetElement(new Map([["G", 1], ["D", 2], ["S", 3]]), props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 2, extCol: 2 },  // (1)  drainNode, dp - _hDDP
      { extRow: 1, extCol: 2 },  // (2)  gateNode, dp  - _hGDP
      { extRow: 1, extCol: 3 },  // (3)  gateNode, sp  - _hGSP
      { extRow: 3, extCol: 3 },  // (4)  sourceNode, sp- _hSSP
      { extRow: 2, extCol: 2 },  // (5)  dp, drainNode - _hDPD
      { extRow: 2, extCol: 1 },  // (6)  dp, gateNode  - _hDPG
      { extRow: 2, extCol: 3 },  // (7)  dp, sp        - _hDPSP
      { extRow: 3, extCol: 1 },  // (8)  sp, gateNode  - _hSPG
      { extRow: 3, extCol: 3 },  // (9)  sp, sourceNode- _hSPS
      { extRow: 3, extCol: 2 },  // (10) sp, dp        - _hSPDP
      { extRow: 2, extCol: 2 },  // (11) drainNode, drainNode- _hDD
      { extRow: 1, extCol: 1 },  // (12) gateNode, gateNode - _hGG
      { extRow: 3, extCol: 3 },  // (13) sourceNode, sourceNode- _hSS
      { extRow: 2, extCol: 2 },  // (14) dp, dp        - _hDPDP
      { extRow: 3, extCol: 3 },  // (15) sp, sp        - _hSPSP
    ]);
  });
  it("PB-NMOS TSTALLOC sequence", () => {
    // ngspice anchor: mos1set.c:186-207- 22 TSTALLOC entries (all unconditional).
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
    const el = createMosfetElement(new Map([["G", 3], ["S", 2], ["D", 1]]), props, () => 0);
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
      { extRow: 1, extCol: 1 },  // (5)  dp, dp = (dNode, dNode)- RD=0
      { extRow: 2, extCol: 2 },  // (6)  sp, sp = (sNode, sNode)- RS=0
      { extRow: 1, extCol: 1 },  // (7)  dNode, dp = (dNode, dNode)- RD=0
      { extRow: 3, extCol: 2 },  // (8)  gNode, bNode = (gNode, sNode)
      { extRow: 3, extCol: 1 },  // (9)  gNode, dp = (gNode, dNode)
      { extRow: 3, extCol: 2 },  // (10) gNode, sp = (gNode, sNode)
      { extRow: 2, extCol: 2 },  // (11) sNode, sp = (sNode, sNode)- RS=0
      { extRow: 2, extCol: 1 },  // (12) bNode, dp = (sNode, dNode)
      { extRow: 2, extCol: 2 },  // (13) bNode, sp = (sNode, sNode)
      { extRow: 1, extCol: 2 },  // (14) dp, sp = (dNode, sNode)- RD=RS=0
      { extRow: 1, extCol: 1 },  // (15) dp, dNode = (dNode, dNode)- RD=0
      { extRow: 2, extCol: 3 },  // (16) bNode, gNode = (sNode, gNode)
      { extRow: 1, extCol: 3 },  // (17) dp, gNode = (dNode, gNode)- RD=0
      { extRow: 2, extCol: 3 },  // (18) sp, gNode = (sNode, gNode)- RS=0
      { extRow: 2, extCol: 2 },  // (19) sp, sNode = (sNode, sNode)- RS=0
      { extRow: 1, extCol: 2 },  // (20) dp, bNode = (dNode, sNode)
      { extRow: 2, extCol: 2 },  // (21) sp, bNode = (sNode, sNode)
      { extRow: 2, extCol: 1 },  // (22) sp, dp = (sNode, dNode)- RS=RD=0
    ]);
  });
  it("PB-NTC TSTALLOC sequence", () => {
    // ngspice anchor: ressetup.c:46-49- 4 TSTALLOC entries, RES pattern.
    // Nodes: posNode=1, negNode=2.
    // Expected order: (1,1), (2,2), (1,2), (2,1)- PP, NN, PN, NP
    const props = new PropertyBag();
    props.replaceModelParams({ ...NTC_DEFAULTS });
    const el = createNTCThermistorElement(new Map([["pos", 1], ["neg", 2]]), props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 }, // (posNode, posNode)- ressetup.c:46
      { extRow: 2, extCol: 2 }, // (negNode, negNode)- ressetup.c:47
      { extRow: 1, extCol: 2 }, // (posNode, negNode)- ressetup.c:48
      { extRow: 2, extCol: 1 }, // (negNode, posNode)- ressetup.c:49
    ]);
  });
  it("PB-OPAMP TSTALLOC sequence", () => {
    // OpAmpDefinition "behavioral" model with rOut=75 (default, >0).
    // setup() with rOut>0:
    //   branch k = ctx.makeCur → 4 (nodeCount+1=4)
    //   nVint = ctx.makeVolt → 5
    //   RES(nVint=5, nOut=3): ressetup.c:46-49 → (5,5),(3,3),(5,3),(3,5)
    //   VCVS entry 1: (posNode=vint=5, branch=4) → (5,4)
    //   VCVS entry 3: (branch=4, posNode=5) → (4,5)
    //   VCVS entry 5: (branch=4, contPos=nInp=1) → (4,1)  [nInp>0]
    //   VCVS entry 6: (branch=4, contNeg=nInn=2) → (4,2)  [nInn>0]
    //
    // Pins: in+=1 (nInp), in-=2 (nInn), out=3 (nOut). nodeCount=3.
    // Total: 4 (RES) + 4 (VCVS entries 1,3,5,6) = 8 entries.
    const entry = OpAmpDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([
      ["in+", 1], ["in-", 2], ["out", 3],
    ]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...OPAMP_DEFAULTS });
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // RES (nVint=5, nOut=3): ressetup.c:46-49
      { extRow: 5, extCol: 5 },  // (vint, vint)
      { extRow: 3, extCol: 3 },  // (nOut, nOut)
      { extRow: 5, extCol: 3 },  // (vint, nOut)
      { extRow: 3, extCol: 5 },  // (nOut, vint)
      // VCVS entries 1,3,5,6 (negNode=0 → entries 2,4 skipped)
      { extRow: 5, extCol: 4 },  // entry 1: (posNode=vint=5, branch=4)
      { extRow: 4, extCol: 5 },  // entry 3: (branch=4, posNode=5)
      { extRow: 4, extCol: 1 },  // entry 5: (branch=4, contPos=nInp=1)
      { extRow: 4, extCol: 2 },  // entry 6: (branch=4, contNeg=nInn=2)
    ]);
  });
  it("PB-OPTO TSTALLOC sequence", () => {
    // OptocouplerCompositeElement: 4 sub-elements in NGSPICE_LOAD_ORDER ascending.
    //
    // Pins: anode=1, cathode=2, collector=3, emitter=4.
    // Internal nodes allocated in setup():
    //   senseMid = makeVolt → 5
    //   nBase    = makeVolt → 6
    //
    // dLed (DIO, A=anode=1, K=senseMid=5, RS=0):
    //   _posPrimeNode=posNode=1
    //   diosetup.c:232-238 → 7 entries:
    //   (1,1),(5,1),(1,1),(1,5),(1,1),(5,5),(1,1)
    //
    // vSense (VSRC, pos=senseMid=5, neg=cathode=2):
    //   branch = makeCur → 7
    //   vsrcset.c:52-55 → 4 entries:
    //   (5,7),(2,7),(7,2),(7,5)
    //
    // cccsCouple (CCCS, pos=nBase=6, neg=emitter=4):
    //   contBranch = findBranch(vSense) → 7
    //   cccsset.c:49-50 → 2 entries:
    //   (6,7),(4,7)
    //
    // bjtPhoto (BJT NPN, B=nBase=6, C=collector=3, E=emitter=4):
    //   bp=6, cp=3, ep=4, substNode=0. RC=RB=RE=0, VERTICAL → sc=cp=3.
    //   bjtsetup.c:435-464 → 23 calls, entries 19-21 skipped (substNode=0):
    //   (3,3),(6,6),(4,4)   _hCCP,_hBBP,_hEEP
    //   (3,3),(3,6),(3,4)   _hCPC,_hCPBP,_hCPEP
    //   (6,6),(6,3),(6,4)   _hBPB,_hBPCP,_hBPEP
    //   (4,4),(4,3),(4,6)   _hEPE,_hEPCP,_hEPBP
    //   (3,3),(6,6),(4,4)   _hCC,_hBB,_hEE
    //   (3,3),(6,6),(4,4)   _hCPCP,_hBPBP,_hEPEP
    //   [19-21 skipped]
    //   (6,3),(3,6)         _hBCP,_hCPB
    //
    // Total: 7+4+2+20 = 33 entries.
    const entry = OptocouplerDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([
      ["anode", 1], ["cathode", 2], ["collector", 3], ["emitter", 4],
    ]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...BJT_NPN_DEFAULTS, ...OPTOCOUPLER_DEFAULTS });
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 4);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // dLed (DIO, A=1, K=senseMid=5, _posPrimeNode=1)
      { extRow: 1, extCol: 1 },
      { extRow: 5, extCol: 1 },
      { extRow: 1, extCol: 1 },
      { extRow: 1, extCol: 5 },
      { extRow: 1, extCol: 1 },
      { extRow: 5, extCol: 5 },
      { extRow: 1, extCol: 1 },
      // vSense (VSRC, pos=5, neg=2, branch=7)
      { extRow: 5, extCol: 7 },
      { extRow: 2, extCol: 7 },
      { extRow: 7, extCol: 2 },
      { extRow: 7, extCol: 5 },
      // cccsCouple (CCCS, pos=6, neg=4, contBranch=7)
      { extRow: 6, extCol: 7 },
      { extRow: 4, extCol: 7 },
      // bjtPhoto (NPN, B=6, C=3, E=4, substNode=0)
      { extRow: 3, extCol: 3 },  // _hCCP
      { extRow: 6, extCol: 6 },  // _hBBP
      { extRow: 4, extCol: 4 },  // _hEEP
      { extRow: 3, extCol: 3 },  // _hCPC
      { extRow: 3, extCol: 6 },  // _hCPBP
      { extRow: 3, extCol: 4 },  // _hCPEP
      { extRow: 6, extCol: 6 },  // _hBPB
      { extRow: 6, extCol: 3 },  // _hBPCP
      { extRow: 6, extCol: 4 },  // _hBPEP
      { extRow: 4, extCol: 4 },  // _hEPE
      { extRow: 4, extCol: 3 },  // _hEPCP
      { extRow: 4, extCol: 6 },  // _hEPBP
      { extRow: 3, extCol: 3 },  // _hCC
      { extRow: 6, extCol: 6 },  // _hBB
      { extRow: 4, extCol: 4 },  // _hEE
      { extRow: 3, extCol: 3 },  // _hCPCP
      { extRow: 6, extCol: 6 },  // _hBPBP
      { extRow: 4, extCol: 4 },  // _hEPEP
      // entries 19-21: substNode=0 → TrashCan, not recorded
      { extRow: 6, extCol: 3 },  // _hBCP
      { extRow: 3, extCol: 6 },  // _hCPB
    ]);
  });
  it("PB-OTA TSTALLOC sequence", () => {
    // OTADefinition "behavioral" model- VCCS pattern with ground guards.
    // vccsset.c:43-46- 4 entries when all nodes non-zero.
    //
    // Pins: V+=1 (nVp), V-=2 (nVm), Iabc=3 (nIabc), OUT+=4 (nOutP), OUT=5 (nOutN).
    //
    // VCCS TSTALLOC sequence:
    //  1. (nOutP=4, nVp=1)  - VCCSposContPosptr
    //  2. (nOutP=4, nVm=2)  - VCCSposContNegptr
    //  3. (nOutN=5, nVp=1)  - VCCSnegContPosptr
    //  4. (nOutN=5, nVm=2)  - VCCSnegContNegptr
    const entry = OTADefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([
      ["V+", 1], ["V-", 2], ["Iabc", 3], ["OUT+", 4], ["OUT", 5],
    ]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...OTA_DEFAULTS });
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 5);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 4, extCol: 1 },  // (nOutP, nVp) - vccsset.c:43
      { extRow: 4, extCol: 2 },  // (nOutP, nVm) - vccsset.c:44
      { extRow: 5, extCol: 1 },  // (nOutN, nVp) - vccsset.c:45
      { extRow: 5, extCol: 2 },  // (nOutN, nVm) - vccsset.c:46
    ]);
  });

  it("PB-PFET TSTALLOC sequence", () => {
    // ngspice anchor: swsetup.c:59-62- 4 stamps, D=posNode, S=negNode
    // Identical to NFET- polarity inversion is load-time only.
    // drainNode=1, sourceNode=2
    // Expected order: (1,1), (1,2), (2,1), (2,2)- PP, PN, NP, NN
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

  it("PB-PJFET TSTALLOC sequence", () => {
    // ngspice anchor: jfetset.c:166-180- 15 TSTALLOC entries.
    // PJFET TSTALLOC sequence is identical to NJFET (polarity difference is load-time only).
    // Nodes: G=1, D=2, S=3. RS=RD=0 (PJFET_PARAM_DEFAULTS) → sp=sourceNode=3, dp=drainNode=2.
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
    props.replaceModelParams({ ...PJFET_PARAM_DEFAULTS });
    const el = createPJfetElement(new Map([["G", 1], ["D", 2], ["S", 3]]), props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 2, extCol: 2 },  // (1)  drainNode, dp
      { extRow: 1, extCol: 2 },  // (2)  gateNode, dp
      { extRow: 1, extCol: 3 },  // (3)  gateNode, sp
      { extRow: 3, extCol: 3 },  // (4)  sourceNode, sp
      { extRow: 2, extCol: 2 },  // (5)  dp, drainNode
      { extRow: 2, extCol: 1 },  // (6)  dp, gateNode
      { extRow: 2, extCol: 3 },  // (7)  dp, sp
      { extRow: 3, extCol: 1 },  // (8)  sp, gateNode
      { extRow: 3, extCol: 3 },  // (9)  sp, sourceNode
      { extRow: 3, extCol: 2 },  // (10) sp, dp
      { extRow: 2, extCol: 2 },  // (11) drainNode, drainNode
      { extRow: 1, extCol: 1 },  // (12) gateNode, gateNode
      { extRow: 3, extCol: 3 },  // (13) sourceNode, sourceNode
      { extRow: 2, extCol: 2 },  // (14) dp, dp
      { extRow: 3, extCol: 3 },  // (15) sp, sp
    ]);
  });
  it("PB-PMOS TSTALLOC sequence", () => {
    // ngspice anchor: mos1set.c:186-207- 22 TSTALLOC entries (all unconditional).
    // PMOS pin layout: G=3, D=1, S=2.  B=S=2 (body tied to source, 3-terminal).
    // RD=RS=RSH=0 → no prime nodes → dp=dNode=1, sp=sNode=2.
    // Identical TSTALLOC sequence to NMOS- mos1set.c:186-207 is polarity-independent.
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
    const el = createMosfetElement(new Map([["G", 3], ["D", 1], ["S", 2]]), props, () => 0);
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
      { extRow: 1, extCol: 1 },  // (5)  dp, dp = (dNode, dNode)- RD=0
      { extRow: 2, extCol: 2 },  // (6)  sp, sp = (sNode, sNode)- RS=0
      { extRow: 1, extCol: 1 },  // (7)  dNode, dp = (dNode, dNode)- RD=0
      { extRow: 3, extCol: 2 },  // (8)  gNode, bNode = (gNode, sNode)
      { extRow: 3, extCol: 1 },  // (9)  gNode, dp = (gNode, dNode)
      { extRow: 3, extCol: 2 },  // (10) gNode, sp = (gNode, sNode)
      { extRow: 2, extCol: 2 },  // (11) sNode, sp = (sNode, sNode)- RS=0
      { extRow: 2, extCol: 1 },  // (12) bNode, dp = (sNode, dNode)
      { extRow: 2, extCol: 2 },  // (13) bNode, sp = (sNode, sNode)
      { extRow: 1, extCol: 2 },  // (14) dp, sp = (dNode, sNode)- RD=RS=0
      { extRow: 1, extCol: 1 },  // (15) dp, dNode = (dNode, dNode)- RD=0
      { extRow: 2, extCol: 3 },  // (16) bNode, gNode = (sNode, gNode)
      { extRow: 1, extCol: 3 },  // (17) dp, gNode = (dNode, gNode)- RD=0
      { extRow: 2, extCol: 3 },  // (18) sp, gNode = (sNode, gNode)- RS=0
      { extRow: 2, extCol: 2 },  // (19) sp, sNode = (sNode, sNode)- RS=0
      { extRow: 1, extCol: 2 },  // (20) dp, bNode = (dNode, sNode)
      { extRow: 2, extCol: 2 },  // (21) sp, bNode = (sNode, sNode)
      { extRow: 2, extCol: 1 },  // (22) sp, dp = (sNode, dNode)- RS=RD=0
    ]);
  });
  it("PB-POLCAP TSTALLOC sequence", () => {
    // AnalogPolarizedCapElement setup():
    //   makeVolt → nCap=3 (internal junction between ESR and cap body)
    //   allocStates (9 slots)
    //
    //   ESR RES (ressetup.c:46-49, pos=posNode=1, neg=nCap=3):
    //     (1,1),(3,3),(1,3),(3,1)
    //
    //   Leakage RES (ressetup.c:46-49, pos=nCap=3, neg=negNode=2):
    //     (3,3),(2,2),(3,2),(2,3)
    //
    //   clampDiode.setup (DIO, A=negNode=2, K=posNode=1, RS=0 → _posPrimeNode=2):
    //     diosetup.c:232-238 (7 entries):
    //     (2,2),(1,2),(2,2),(2,1),(2,2),(1,1),(2,2)
    //
    //   CAP body (capsetup.c:114-117, pos=nCap=3, neg=negNode=2):
    //     (3,3),(2,2),(3,2),(2,3)
    //
    // Pins: pos=1, neg=2. nodeCount=2.
    // Total: 4+4+7+4 = 19 entries.
    const entry = PolarizedCapDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([["pos", 1], ["neg", 2]]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...POLARIZED_CAP_MODEL_DEFAULTS });
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // ESR RES (pos=1, neg=nCap=3): ressetup.c:46-49
      { extRow: 1, extCol: 1 },
      { extRow: 3, extCol: 3 },
      { extRow: 1, extCol: 3 },
      { extRow: 3, extCol: 1 },
      // Leakage RES (pos=nCap=3, neg=2): ressetup.c:46-49
      { extRow: 3, extCol: 3 },
      { extRow: 2, extCol: 2 },
      { extRow: 3, extCol: 2 },
      { extRow: 2, extCol: 3 },
      // clampDiode (DIO, A=2, K=1, _posPrimeNode=2): diosetup.c:232-238
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 2 },
      { extRow: 2, extCol: 2 },
      { extRow: 2, extCol: 1 },
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 1 },
      { extRow: 2, extCol: 2 },
      // CAP body (pos=nCap=3, neg=2): capsetup.c:114-117
      { extRow: 3, extCol: 3 },
      { extRow: 2, extCol: 2 },
      { extRow: 3, extCol: 2 },
      { extRow: 2, extCol: 3 },
    ]);
  });
  it("PB-POT TSTALLOC sequence", () => {
    // PotentiometerDefinition "behavioral" model- two RES sub-elements.
    // setup() calls R_AW then R_WB each following ressetup.c:46-49.
    //
    // Pins: A=1, W=2, B=3. nodeCount=3.
    //
    // R_AW (ressetup.c:46-49, posNode=A=1, negNode=W=2):
    //   (1,1),(2,2),(1,2),(2,1)
    //
    // R_WB (ressetup.c:46-49, posNode=W=2, negNode=B=3):
    //   (2,2),(3,3),(2,3),(3,2)
    //
    // Total: 8 entries.
    const entry = PotentiometerDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([["A", 1], ["W", 2], ["B", 3]]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...POTENTIOMETER_DEFAULTS });
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // R_AW (posNode=A=1, negNode=W=2): ressetup.c:46-49
      { extRow: 1, extCol: 1 },
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 2 },
      { extRow: 2, extCol: 1 },
      // R_WB (posNode=W=2, negNode=B=3): ressetup.c:46-49
      { extRow: 2, extCol: 2 },
      { extRow: 3, extCol: 3 },
      { extRow: 2, extCol: 3 },
      { extRow: 3, extCol: 2 },
    ]);
  });
  it("PB-REAL_OPAMP TSTALLOC sequence", () => {
    // RealOpAmpDefinition "behavioral" model.
    // setup() with nInp=1, nInn=2, nOut=3 (all non-zero):
    //
    // Input resistance stamp (ressetup.c:46-49 pattern with ground guards):
    //   nInp>0: hInpInp=(1,1)
    //   nInn>0: hInnInn=(2,2)
    //   nInp>0 && nInn>0: hInpInn=(1,2), hInnInp=(2,1)
    //
    // Output conductance and gain-stage Jacobian:
    //   nOut>0: hOutOut=(3,3)
    //   nOut>0 && nInp>0: hOutInp=(3,1)
    //   nOut>0 && nInn>0: hOutInn=(3,2)
    //
    // Total: 4 (input RES) + 3 (output) = 7 entries.
    const entry = RealOpAmpDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([
      ["in+", 1], ["in-", 2], ["out", 3],
    ]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...REAL_OPAMP_DEFAULTS });
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // hInpInp (nInp, nInp)
      { extRow: 2, extCol: 2 },  // hInnInn (nInn, nInn)
      { extRow: 1, extCol: 2 },  // hInpInn (nInp, nInn)
      { extRow: 2, extCol: 1 },  // hInnInp (nInn, nInp)
      { extRow: 3, extCol: 3 },  // hOutOut  (nOut, nOut)
      { extRow: 3, extCol: 1 },  // hOutInp  (nOut, nInp)
      { extRow: 3, extCol: 2 },  // hOutInn  (nOut, nInn)
    ]);
  });
  it("PB-RELAY TSTALLOC sequence", () => {
    // ngspice anchor: composite- coilL(IND,5) + coilR(RES,4) + contactSW(SW,4).
    //
    // Pin nodes: in1=1, in2=2, A1=3, B1=4. nodeCount=4.
    // setup() allocates:
    //   coilMid = ctx.makeVolt → 5  (_maxEqNum advances 4→5)
    //   coilL branch = ctx.makeCur → 6  (_maxEqNum advances 5→6)
    //
    // coilL.setup (IND, posNode=in1=1, negNode=coilMid=5, branch=6):
    //   indsetup.c:96-100- 5 entries:
    //   (1,6),(5,6),(6,5),(6,1),(6,6)
    //
    // coilR.setup (RES, posNode=coilMid=5, negNode=in2=2):
    //   ressetup.c:46-49- 4 entries:
    //   (5,5),(2,2),(5,2),(2,5)
    //
    // contactSW.setup (SW, A1=3, B1=4):
    //   swsetup.c:59-62- 4 entries:
    //   (3,3),(3,4),(4,3),(4,4)
    //
    // Total: 13 entries.
    const props = new PropertyBag();
    const pinNodes = new Map<string, number>([
      ["in1", 1], ["in2", 2], ["A1", 3], ["B1", 4],
    ]);
    const relayEntry = RelayDefinition.modelRegistry!["behavioral"]!;
    if (relayEntry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const factory = relayEntry.factory;
    const el = factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 4);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // coilL (IND): posNode=1, negNode=5, branch=6- indsetup.c:96-100
      { extRow: 1, extCol: 6 },  // (INDposNode, INDbrEq)
      { extRow: 5, extCol: 6 },  // (INDnegNode, INDbrEq)
      { extRow: 6, extCol: 5 },  // (INDbrEq, INDnegNode)
      { extRow: 6, extCol: 1 },  // (INDbrEq, INDposNode)
      { extRow: 6, extCol: 6 },  // (INDbrEq, INDbrEq)
      // coilR (RES): posNode=5, negNode=2- ressetup.c:46-49
      { extRow: 5, extCol: 5 },  // (RESposNode, RESposNode)
      { extRow: 2, extCol: 2 },  // (RESnegNode, RESnegNode)
      { extRow: 5, extCol: 2 },  // (RESposNode, RESnegNode)
      { extRow: 2, extCol: 5 },  // (RESnegNode, RESposNode)
      // contactSW (SW): A1=3, B1=4- swsetup.c:59-62
      { extRow: 3, extCol: 3 },  // (SWposNode, SWposNode)
      { extRow: 3, extCol: 4 },  // (SWposNode, SWnegNode)
      { extRow: 4, extCol: 3 },  // (SWnegNode, SWposNode)
      { extRow: 4, extCol: 4 },  // (SWnegNode, SWnegNode)
    ]);
  });
  it("PB-RELAY-DT TSTALLOC sequence", () => {
    // ngspice anchor: composite- coilL(IND,5) + coilR(RES,4) + swNO(SW,4) + swNC(SW,4).
    //
    // Pin nodes: in1=1, in2=2, A1=3, B1=4, C1=5. nodeCount=5.
    // setup() allocates:
    //   coilMid = ctx.makeVolt → 6  (_maxEqNum advances 5→6)
    //   coilL branch = ctx.makeCur → 7  (_maxEqNum advances 6→7)
    //
    // coilL.setup (IND, posNode=in1=1, negNode=coilMid=6, branch=7):
    //   indsetup.c:96-100- 5 entries:
    //   (1,7),(6,7),(7,6),(7,1),(7,7)
    //
    // coilR.setup (RES, posNode=coilMid=6, negNode=in2=2):
    //   ressetup.c:46-49- 4 entries:
    //   (6,6),(2,2),(6,2),(2,6)
    //
    // swNO.setup (SW, A1=3, B1=4, normally-open):
    //   swsetup.c:59-62- 4 entries:
    //   (3,3),(3,4),(4,3),(4,4)
    //
    // swNC.setup (SW, A1=3, B1=C1=5, normally-closed):
    //   swsetup.c:59-62- 4 entries:
    //   (3,3),(3,5),(5,3),(5,5)
    //
    // Total: 17 entries.
    const props = new PropertyBag();
    const pinNodes = new Map<string, number>([
      ["in1", 1], ["in2", 2], ["A1", 3], ["B1", 4], ["C1", 5],
    ]);
    const relayDtEntry = RelayDTDefinition.modelRegistry!["behavioral"]!;
    if (relayDtEntry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const factory = relayDtEntry.factory;
    const el = factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 5);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // coilL (IND): posNode=1, negNode=6, branch=7- indsetup.c:96-100
      { extRow: 1, extCol: 7 },  // (INDposNode, INDbrEq)
      { extRow: 6, extCol: 7 },  // (INDnegNode, INDbrEq)
      { extRow: 7, extCol: 6 },  // (INDbrEq, INDnegNode)
      { extRow: 7, extCol: 1 },  // (INDbrEq, INDposNode)
      { extRow: 7, extCol: 7 },  // (INDbrEq, INDbrEq)
      // coilR (RES): posNode=6, negNode=2- ressetup.c:46-49
      { extRow: 6, extCol: 6 },  // (RESposNode, RESposNode)
      { extRow: 2, extCol: 2 },  // (RESnegNode, RESnegNode)
      { extRow: 6, extCol: 2 },  // (RESposNode, RESnegNode)
      { extRow: 2, extCol: 6 },  // (RESnegNode, RESposNode)
      // swNO (SW): A1=3, B1=4- swsetup.c:59-62
      { extRow: 3, extCol: 3 },  // (SWposNode, SWposNode)
      { extRow: 3, extCol: 4 },  // (SWposNode, SWnegNode)
      { extRow: 4, extCol: 3 },  // (SWnegNode, SWposNode)
      { extRow: 4, extCol: 4 },  // (SWnegNode, SWnegNode)
      // swNC (SW): A1=3, B1=C1=5- swsetup.c:59-62
      { extRow: 3, extCol: 3 },  // (SWposNode, SWposNode)
      { extRow: 3, extCol: 5 },  // (SWposNode, SWnegNode)
      { extRow: 5, extCol: 3 },  // (SWnegNode, SWposNode)
      { extRow: 5, extCol: 5 },  // (SWnegNode, SWnegNode)
    ]);
  });
  it("PB-RES TSTALLOC sequence", () => {
    // ngspice anchor: ressetup.c:46-49- 4 TSTALLOC entries.
    // ResistorDefinition "behavioral" model uses pin keys "A" (posNode) and "B" (negNode).
    // Nodes: A=1 (posNode), B=2 (negNode).
    // Expected: (1,1),(2,2),(1,2),(2,1)- PP, NN, PN, NP
    const entry = ResistorDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const props = new PropertyBag();
    props.replaceModelParams({ ...RESISTOR_DEFAULTS });
    const el = entry.factory(new Map([["A", 1], ["B", 2]]), props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (RESposNode, RESposNode)- ressetup.c:46
      { extRow: 2, extCol: 2 },  // (RESnegNode, RESnegNode)- ressetup.c:47
      { extRow: 1, extCol: 2 },  // (RESposNode, RESnegNode)- ressetup.c:48
      { extRow: 2, extCol: 1 },  // (RESnegNode, RESposNode)- ressetup.c:49
    ]);
  });
  it("PB-SCR TSTALLOC sequence", () => {
    // ScrDefinition "behavioral" model: makeVolt(latch) + Q1.setup(NPN) + Q2.setup(PNP).
    //
    // Pins: A=1, K=2, G=3. Internal: Vint=4 (makeVolt).
    //
    // Q1 NPN: B=G=3, C=Vint=4, E=K=2. substNode=0, RC=RB=RE=0, sc=cp=4.
    //   bjtsetup.c:435-464 (20 of 23 recorded, entries 19-21 skipped):
    //   (4,4),(3,3),(2,2)   _hCCP,_hBBP,_hEEP
    //   (4,4),(4,3),(4,2)   _hCPC,_hCPBP,_hCPEP
    //   (3,3),(3,4),(3,2)   _hBPB,_hBPCP,_hBPEP
    //   (2,2),(2,4),(2,3)   _hEPE,_hEPCP,_hEPBP
    //   (4,4),(3,3),(2,2)   _hCC,_hBB,_hEE
    //   (4,4),(3,3),(2,2)   _hCPCP,_hBPBP,_hEPEP
    //   [entries 19-21: substNode=0 → TrashCan]
    //   (3,4),(4,3)         _hBCP,_hCPB
    //
    // Q2 PNP: B=Vint=4, C=G=3, E=A=1. substNode=0, RC=RB=RE=0, sc=cp=3.
    //   bjtsetup.c:435-464 (20 of 23 recorded):
    //   (3,3),(4,4),(1,1)   _hCCP,_hBBP,_hEEP
    //   (3,3),(3,4),(3,1)   _hCPC,_hCPBP,_hCPEP
    //   (4,4),(4,3),(4,1)   _hBPB,_hBPCP,_hBPEP
    //   (1,1),(1,3),(1,4)   _hEPE,_hEPCP,_hEPBP
    //   (3,3),(4,4),(1,1)   _hCC,_hBB,_hEE
    //   (3,3),(4,4),(1,1)   _hCPCP,_hBPBP,_hEPEP
    //   [entries 19-21: substNode=0 → TrashCan]
    //   (4,3),(3,4)         _hBCP,_hCPB
    //
    // Total: 20+20 = 40 entries.
    const entry = ScrDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([["A", 1], ["K", 2], ["G", 3]]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...SCR_PARAM_DEFAULTS });
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // Q1 NPN (B=3, C=4, E=2): bp=3, cp=4, ep=2, sc=4
      { extRow: 4, extCol: 4 },  // _hCCP
      { extRow: 3, extCol: 3 },  // _hBBP
      { extRow: 2, extCol: 2 },  // _hEEP
      { extRow: 4, extCol: 4 },  // _hCPC
      { extRow: 4, extCol: 3 },  // _hCPBP
      { extRow: 4, extCol: 2 },  // _hCPEP
      { extRow: 3, extCol: 3 },  // _hBPB
      { extRow: 3, extCol: 4 },  // _hBPCP
      { extRow: 3, extCol: 2 },  // _hBPEP
      { extRow: 2, extCol: 2 },  // _hEPE
      { extRow: 2, extCol: 4 },  // _hEPCP
      { extRow: 2, extCol: 3 },  // _hEPBP
      { extRow: 4, extCol: 4 },  // _hCC
      { extRow: 3, extCol: 3 },  // _hBB
      { extRow: 2, extCol: 2 },  // _hEE
      { extRow: 4, extCol: 4 },  // _hCPCP
      { extRow: 3, extCol: 3 },  // _hBPBP
      { extRow: 2, extCol: 2 },  // _hEPEP
      { extRow: 3, extCol: 4 },  // _hBCP
      { extRow: 4, extCol: 3 },  // _hCPB
      // Q2 PNP (B=4, C=3, E=1): bp=4, cp=3, ep=1, sc=3
      { extRow: 3, extCol: 3 },  // _hCCP
      { extRow: 4, extCol: 4 },  // _hBBP
      { extRow: 1, extCol: 1 },  // _hEEP
      { extRow: 3, extCol: 3 },  // _hCPC
      { extRow: 3, extCol: 4 },  // _hCPBP
      { extRow: 3, extCol: 1 },  // _hCPEP
      { extRow: 4, extCol: 4 },  // _hBPB
      { extRow: 4, extCol: 3 },  // _hBPCP
      { extRow: 4, extCol: 1 },  // _hBPEP
      { extRow: 1, extCol: 1 },  // _hEPE
      { extRow: 1, extCol: 3 },  // _hEPCP
      { extRow: 1, extCol: 4 },  // _hEPBP
      { extRow: 3, extCol: 3 },  // _hCC
      { extRow: 4, extCol: 4 },  // _hBB
      { extRow: 1, extCol: 1 },  // _hEE
      { extRow: 3, extCol: 3 },  // _hCPCP
      { extRow: 4, extCol: 4 },  // _hBPBP
      { extRow: 1, extCol: 1 },  // _hEPEP
      { extRow: 4, extCol: 3 },  // _hBCP
      { extRow: 3, extCol: 4 },  // _hCPB
    ]);
  });
  it("PB-SCHMITT TSTALLOC sequence", () => {
    // SchmittInvertingDefinition "behavioral" model.
    // setup():
    //   allocStates(1)- composite OUTPUT_HIGH slot
    //   inModel.setup(ctx)  (DigitalInputPinModel, nodeId=nIn=1>0): allocElement(1,1) → (1,1)
    //   outModel.setup(ctx) (DigitalOutputPinModel "direct", loaded=false, nodeId=nOut=2>0):
    //     allocElement(2,2) → (2,2)
    //   childElements = [inCap] (inModel loaded=true, cIn=5e-12>0 → cap(pos=1,neg=0)):
    //     inCap.setup(ctx): posNode=1>0: (1,1); negNode=0: guards skip NN,PN,NP
    //
    // Pins: in=1, out=2.
    // Total: 3 entries: (1,1),(2,2),(1,1)
    const entry = SchmittInvertingDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([["in", 1], ["out", 2]]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...SCHMITT_DEFAULTS });
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // inModel.setup → (nIn, nIn)
      { extRow: 2, extCol: 2 },  // outModel.setup (direct) → (nOut, nOut)
      { extRow: 1, extCol: 1 },  // inCap.setup (pos=1, neg=0) → posNode diagonal only
    ]);
  });
  it("PB-SCHOTTKY TSTALLOC sequence", () => {
    // ngspice anchor: diosetup.c:232-238- 7 TSTALLOC entries (identical to DIO).
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
    const el = createDiodeElement(new Map([["A", 1], ["K", 2]]), props, () => 0);
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
    // ngspice anchor: swsetup.c:59-62- 4 TSTALLOC entries, SW pattern.
    // Note: SW ordering differs from RES- cross terms come before NN diagonal.
    // Nodes: posNode=1 (SWposNode), negNode=2 (SWnegNode).
    // Expected order: (1,1), (1,2), (2,1), (2,2)- PP, PN, NP, NN
    const props = new PropertyBag();
    props.replaceModelParams({ ...SPARK_GAP_DEFAULTS });
    const el = createSparkGapElement(new Map([["pos", 1], ["neg", 2]]), props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 }, // (SWposNode, SWposNode)- swsetup.c:59
      { extRow: 1, extCol: 2 }, // (SWposNode, SWnegNode)- swsetup.c:60
      { extRow: 2, extCol: 1 }, // (SWnegNode, SWposNode)- swsetup.c:61
      { extRow: 2, extCol: 2 }, // (SWnegNode, SWnegNode)- swsetup.c:62
    ]);
  });
  it.todo("PB-SUBCKT TSTALLOC sequence");
  it("PB-SW TSTALLOC sequence", () => {
    // ngspice anchor: swsetup.c:59-62- 4 TSTALLOC entries, SW pattern.
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
      { extRow: 1, extCol: 1 },  // (1) SWposNode, SWposNode- swsetup.c:59
      { extRow: 1, extCol: 2 },  // (2) SWposNode, SWnegNode- swsetup.c:60
      { extRow: 2, extCol: 1 },  // (3) SWnegNode, SWposNode- swsetup.c:61
      { extRow: 2, extCol: 2 },  // (4) SWnegNode, SWnegNode- swsetup.c:62
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
      { extRow: 1, extCol: 1 },  // (1) A1, A1- swAB._hPP
      { extRow: 1, extCol: 2 },  // (2) A1, B1- swAB._hPN
      { extRow: 2, extCol: 1 },  // (3) B1, A1- swAB._hNP
      { extRow: 2, extCol: 2 },  // (4) B1, B1- swAB._hNN
      // SW_AC (A1↔C1)
      { extRow: 1, extCol: 1 },  // (5) A1, A1- swAC._hPP
      { extRow: 1, extCol: 3 },  // (6) A1, C1- swAC._hPN
      { extRow: 3, extCol: 1 },  // (7) C1, A1- swAC._hNP
      { extRow: 3, extCol: 3 },  // (8) C1, C1- swAC._hNN
    ]);
  });
  it("PB-TAPXFMR TSTALLOC sequence", () => {
    // TappedTransformerDefinition: L1+L2+L3(IND,5 each) + MUT12+MUT13+MUT23(2 each).
    //
    // Pins: P1=1, P2=2, S1=3, CT=4, S2=5. nodeCount=5.
    // Branches allocated in setup():
    //   L1 branch = makeCur → 6
    //   L2 branch = makeCur → 7
    //   L3 branch = makeCur → 8
    //
    // L1 (IND, p1Node=1, p2Node=2, branch=6): indsetup.c:96-100
    //   (1,6),(2,6),(6,2),(6,1),(6,6)
    //
    // L2 (IND, s1Node=3, ctNode=4, branch=7): indsetup.c:96-100
    //   (3,7),(4,7),(7,4),(7,3),(7,7)
    //
    // L3 (IND, ctNode=4, s2Node=5, branch=8): indsetup.c:96-100
    //   (4,8),(5,8),(8,5),(8,4),(8,8)
    //
    // MUT12 (k, L1, L2): mutsetup.c:2 entries
    //   (b1=6, b2=7), (b2=7, b1=6)
    //
    // MUT13 (k, L1, L3): mutsetup.c:2 entries
    //   (b1=6, b3=8), (b3=8, b1=6)
    //
    // MUT23 (k, L2, L3): mutsetup.c:2 entries
    //   (b2=7, b3=8), (b3=8, b2=7)
    //
    // Total: 5+5+5+2+2+2 = 21 entries.
    const entry = TappedTransformerDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([
      ["P1", 1], ["P2", 2], ["S1", 3], ["CT", 4], ["S2", 5],
    ]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...TAPPED_TRANSFORMER_DEFAULTS });
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 5);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // L1 (P1=1, P2=2, branch=6): indsetup.c:96-100
      { extRow: 1, extCol: 6 },
      { extRow: 2, extCol: 6 },
      { extRow: 6, extCol: 2 },
      { extRow: 6, extCol: 1 },
      { extRow: 6, extCol: 6 },
      // L2 (S1=3, CT=4, branch=7): indsetup.c:96-100
      { extRow: 3, extCol: 7 },
      { extRow: 4, extCol: 7 },
      { extRow: 7, extCol: 4 },
      { extRow: 7, extCol: 3 },
      { extRow: 7, extCol: 7 },
      // L3 (CT=4, S2=5, branch=8): indsetup.c:96-100
      { extRow: 4, extCol: 8 },
      { extRow: 5, extCol: 8 },
      { extRow: 8, extCol: 5 },
      { extRow: 8, extCol: 4 },
      { extRow: 8, extCol: 8 },
      // MUT12 (L1 b=6, L2 b=7)
      { extRow: 6, extCol: 7 },
      { extRow: 7, extCol: 6 },
      // MUT13 (L1 b=6, L3 b=8)
      { extRow: 6, extCol: 8 },
      { extRow: 8, extCol: 6 },
      // MUT23 (L2 b=7, L3 b=8)
      { extRow: 7, extCol: 8 },
      { extRow: 8, extCol: 7 },
    ]);
  });
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
    // rDiv1 (RES, A=VCC=4, B=CTRL=5)- ressetup.c:46-49- 4 entries:
    //   (4,4), (4,5), (5,4), (5,5)
    //
    // rDiv2 (RES, A=CTRL=5, B=nLower=9)- 4 entries:
    //   (5,5), (5,9), (9,5), (9,9)
    //
    // rDiv3 (RES, A=nLower=9, B=GND=8)- 4 entries:
    //   (9,9), (9,8), (8,9), (8,8)
    //
    // comp1 (VCVS, ctrl+=THR=3, ctrl-=CTRL=5, out+=nComp1Out=10, out-=GND=8)- vcvsset.c:53-58- 6 entries:
    //   branch=13 (first makeCur call)
    //   1. (out+=10, branch=13)   :53
    //   2. (out-=8,  branch=13)   :54
    //   3. (branch=13, out+=10)   :55
    //   4. (branch=13, out-=8)    :56
    //   5. (branch=13, ctrl+=3)   :57
    //   6. (branch=13, ctrl-=5)   :58
    //
    // comp2 (VCVS, ctrl+=nLower=9, ctrl-=TRIG=2, out+=nComp2Out=11, out-=GND=8)- vcvsset.c:53-58- 6 entries:
    //   branch=14 (second makeCur call)
    //   1. (out+=11, branch=14)   :53
    //   2. (out-=8,  branch=14)   :54
    //   3. (branch=14, out+=11)   :55
    //   4. (branch=14, out-=8)    :56
    //   5. (branch=14, ctrl+=9)   :57
    //   6. (branch=14, ctrl-=2)   :58
    //
    // bjtDis (BJT NPN, B=nDisBase=12, C=DIS=1, E=GND=8)- bjtsetup.c:435-464- 23 calls:
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
    const el = factory(pinNodes, props, () => 0) as unknown as AnalogElement;

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
  it("PB-TLINE TSTALLOC sequence", () => {
    // TransmissionLineDefinition "behavioral"- N=2 segments (lossless: rSeg=gSeg=0).
    //
    // Pins: P1b=1, P2b=2. nodeCount=2, N=2.
    // Internal nodes allocated in setup():
    //   rlMid0 = makeVolt → 3
    //   junc0  = makeVolt → 4
    // Branches allocated in segment inductor/CombinedRL setup():
    //   seg0_L  branch = makeCur → 5
    //   seg1_RL branch = makeCur → 6
    //
    // Sub-elements for N=2 (lossless, no G shunt):
    //   k=0 (not last): SegR(P1b=1, rlMid0=3), SegL(3, junc0=4), SegC(junc0=4→GND=0)
    //   k=1 (last):     CombinedRL(junc0=4, P2b=2)
    //
    // Setup order (sub-elements processed in array order):
    // 1. SegR(1,3)- ressetup.c:46-49 AA,AB,BA,BB order:
    //    (1,1),(1,3),(3,1),(3,3)
    // 2. SegL(3,4) branch=5- indsetup.c:96-100:
    //    (3,5),(4,5),(5,4),(5,3),(5,5)
    // 3. SegC(4→0)- capsetup.c collapsed: neg=0 so only (4,4)
    // 4. CombinedRL(4,2) branch=6- indsetup.c pattern (5 entries):
    //    (4,6),(2,6),(6,2),(6,4),(6,6)
    //
    // Total: 4+5+1+5 = 15 entries.
    const entry = TransmissionLineDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([
      ["P1b", 1], ["P2b", 2], ["P1a", 0], ["P2a", 0],
    ]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...TRANSMISSION_LINE_DEFAULTS });
    props.setModelParam("segments", 2);
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // SegR(P1b=1, rlMid0=3)- ressetup.c AA,AB,BA,BB
      { extRow: 1, extCol: 1 },
      { extRow: 1, extCol: 3 },
      { extRow: 3, extCol: 1 },
      { extRow: 3, extCol: 3 },
      // SegL(rlMid0=3, junc0=4) branch=5- indsetup.c:96-100
      { extRow: 3, extCol: 5 },
      { extRow: 4, extCol: 5 },
      { extRow: 5, extCol: 4 },
      { extRow: 5, extCol: 3 },
      { extRow: 5, extCol: 5 },
      // SegC(junc0=4 → GND=0)- capsetup.c collapsed to (4,4)
      { extRow: 4, extCol: 4 },
      // CombinedRL(junc0=4, P2b=2) branch=6- 5 entries
      { extRow: 4, extCol: 6 },
      { extRow: 2, extCol: 6 },
      { extRow: 6, extCol: 2 },
      { extRow: 6, extCol: 4 },
      { extRow: 6, extCol: 6 },
    ]);
  });
  it("PB-TRANSGATE TSTALLOC sequence", () => {
    // ngspice anchor: swsetup.c:59-62 applied twice (NFET SW then PFET SW).
    //
    // TransGateAnalogElement: composite of _nfetSW + _pfetSW sharing the same
    // signal path (out1=inNode, out2=outNode). Control pins (p1, p2) are not
    // part of the MNA matrix- only the signal path nodes are stamped.
    //
    // Nodes: out1=1 (inNode=SWposNode), out2=2 (outNode=SWnegNode).
    // setup() calls _nfetSW.setup(ctx) then _pfetSW.setup(ctx).
    //
    // NFET SW (D=1, S=2):
    //   swsetup.c:59-62- 4 entries: (1,1),(1,2),(2,1),(2,2)
    //
    // PFET SW (D=1, S=2)- identical signal path:
    //   swsetup.c:59-62- 4 entries: (1,1),(1,2),(2,1),(2,2)
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
      // NFET SW (D=out1=1, S=out2=2)- swsetup.c:59-62
      { extRow: 1, extCol: 1 },  // SWposPosptr
      { extRow: 1, extCol: 2 },  // SWposNegptr
      { extRow: 2, extCol: 1 },  // SWnegPosptr
      { extRow: 2, extCol: 2 },  // SWnegNegptr
      // PFET SW (D=out1=1, S=out2=2)- swsetup.c:59-62
      { extRow: 1, extCol: 1 },  // SWposPosptr
      { extRow: 1, extCol: 2 },  // SWposNegptr
      { extRow: 2, extCol: 1 },  // SWnegPosptr
      { extRow: 2, extCol: 2 },  // SWnegNegptr
    ]);
  });
  it("PB-TRIAC TSTALLOC sequence", () => {
    // TriacDefinition "behavioral": makeVolt(latch1)+makeVolt(latch2) + Q1+Q2+Q3+Q4 BJT setups.
    //
    // Pins: MT1=1, MT2=2, G=3. nodeCount=3.
    // Internal nodes (created in setup()):
    //   latch1 = makeVolt → 4
    //   latch2 = makeVolt → 5
    //
    // Q1 NPN: B=G=3, C=latch1=4, E=MT1=1. substNode=0, cp=4, bp=3, ep=1, sc=4.
    // Q2 PNP: B=latch1=4, C=G=3, E=MT2=2. substNode=0, cp=3, bp=4, ep=2, sc=3.
    // Q3 NPN: B=G=3, C=latch2=5, E=MT2=2. substNode=0, cp=5, bp=3, ep=2, sc=5.
    // Q4 PNP: B=latch2=5, C=G=3, E=MT1=1. substNode=0, cp=3, bp=5, ep=1, sc=3.
    //
    // Each BJT: bjtsetup.c:435-464- 20 of 23 recorded (entries 19-21 = substNode=0 → TrashCan).
    // Total: 4×20 = 80 entries.
    const entry = TriacDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([["MT1", 1], ["MT2", 2], ["G", 3]]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...TRIAC_PARAM_DEFAULTS });
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // Q1 NPN (B=3, C=4, E=1): cp=4, bp=3, ep=1, sc=4- bjtsetup.c:435-464
      { extRow: 4, extCol: 4 },  // _hCCP
      { extRow: 3, extCol: 3 },  // _hBBP
      { extRow: 1, extCol: 1 },  // _hEEP
      { extRow: 4, extCol: 4 },  // _hCPC
      { extRow: 4, extCol: 3 },  // _hCPBP
      { extRow: 4, extCol: 1 },  // _hCPEP
      { extRow: 3, extCol: 3 },  // _hBPB
      { extRow: 3, extCol: 4 },  // _hBPCP
      { extRow: 3, extCol: 1 },  // _hBPEP
      { extRow: 1, extCol: 1 },  // _hEPE
      { extRow: 1, extCol: 4 },  // _hEPCP
      { extRow: 1, extCol: 3 },  // _hEPBP
      { extRow: 4, extCol: 4 },  // _hCC
      { extRow: 3, extCol: 3 },  // _hBB
      { extRow: 1, extCol: 1 },  // _hEE
      { extRow: 4, extCol: 4 },  // _hCPCP
      { extRow: 3, extCol: 3 },  // _hBPBP
      { extRow: 1, extCol: 1 },  // _hEPEP
      // entries 19-21: substNode=0 → TrashCan (not in order)
      { extRow: 3, extCol: 4 },  // _hBCP (baseNode=3, cp=4)
      { extRow: 4, extCol: 3 },  // _hCPB (cp=4, baseNode=3)
      // Q2 PNP (B=4, C=3, E=2): cp=3, bp=4, ep=2, sc=3- bjtsetup.c:435-464
      { extRow: 3, extCol: 3 },  // _hCCP
      { extRow: 4, extCol: 4 },  // _hBBP
      { extRow: 2, extCol: 2 },  // _hEEP
      { extRow: 3, extCol: 3 },  // _hCPC
      { extRow: 3, extCol: 4 },  // _hCPBP
      { extRow: 3, extCol: 2 },  // _hCPEP
      { extRow: 4, extCol: 4 },  // _hBPB
      { extRow: 4, extCol: 3 },  // _hBPCP
      { extRow: 4, extCol: 2 },  // _hBPEP
      { extRow: 2, extCol: 2 },  // _hEPE
      { extRow: 2, extCol: 3 },  // _hEPCP
      { extRow: 2, extCol: 4 },  // _hEPBP
      { extRow: 3, extCol: 3 },  // _hCC
      { extRow: 4, extCol: 4 },  // _hBB
      { extRow: 2, extCol: 2 },  // _hEE
      { extRow: 3, extCol: 3 },  // _hCPCP
      { extRow: 4, extCol: 4 },  // _hBPBP
      { extRow: 2, extCol: 2 },  // _hEPEP
      // entries 19-21: substNode=0 → TrashCan
      { extRow: 4, extCol: 3 },  // _hBCP (baseNode=4, cp=3)
      { extRow: 3, extCol: 4 },  // _hCPB (cp=3, baseNode=4)
      // Q3 NPN (B=3, C=5, E=2): cp=5, bp=3, ep=2, sc=5- bjtsetup.c:435-464
      { extRow: 5, extCol: 5 },  // _hCCP
      { extRow: 3, extCol: 3 },  // _hBBP
      { extRow: 2, extCol: 2 },  // _hEEP
      { extRow: 5, extCol: 5 },  // _hCPC
      { extRow: 5, extCol: 3 },  // _hCPBP
      { extRow: 5, extCol: 2 },  // _hCPEP
      { extRow: 3, extCol: 3 },  // _hBPB
      { extRow: 3, extCol: 5 },  // _hBPCP
      { extRow: 3, extCol: 2 },  // _hBPEP
      { extRow: 2, extCol: 2 },  // _hEPE
      { extRow: 2, extCol: 5 },  // _hEPCP
      { extRow: 2, extCol: 3 },  // _hEPBP
      { extRow: 5, extCol: 5 },  // _hCC
      { extRow: 3, extCol: 3 },  // _hBB
      { extRow: 2, extCol: 2 },  // _hEE
      { extRow: 5, extCol: 5 },  // _hCPCP
      { extRow: 3, extCol: 3 },  // _hBPBP
      { extRow: 2, extCol: 2 },  // _hEPEP
      // entries 19-21: substNode=0 → TrashCan
      { extRow: 3, extCol: 5 },  // _hBCP (baseNode=3, cp=5)
      { extRow: 5, extCol: 3 },  // _hCPB (cp=5, baseNode=3)
      // Q4 PNP (B=5, C=3, E=1): cp=3, bp=5, ep=1, sc=3- bjtsetup.c:435-464
      { extRow: 3, extCol: 3 },  // _hCCP
      { extRow: 5, extCol: 5 },  // _hBBP
      { extRow: 1, extCol: 1 },  // _hEEP
      { extRow: 3, extCol: 3 },  // _hCPC
      { extRow: 3, extCol: 5 },  // _hCPBP
      { extRow: 3, extCol: 1 },  // _hCPEP
      { extRow: 5, extCol: 5 },  // _hBPB
      { extRow: 5, extCol: 3 },  // _hBPCP
      { extRow: 5, extCol: 1 },  // _hBPEP
      { extRow: 1, extCol: 1 },  // _hEPE
      { extRow: 1, extCol: 3 },  // _hEPCP
      { extRow: 1, extCol: 5 },  // _hEPBP
      { extRow: 3, extCol: 3 },  // _hCC
      { extRow: 5, extCol: 5 },  // _hBB
      { extRow: 1, extCol: 1 },  // _hEE
      { extRow: 3, extCol: 3 },  // _hCPCP
      { extRow: 5, extCol: 5 },  // _hBPBP
      { extRow: 1, extCol: 1 },  // _hEPEP
      // entries 19-21: substNode=0 → TrashCan
      { extRow: 5, extCol: 3 },  // _hBCP (baseNode=5, cp=3)
      { extRow: 3, extCol: 5 },  // _hCPB (cp=3, baseNode=5)
    ]);
  });
  it("PB-TRIODE TSTALLOC sequence", () => {
    // createTriodeElement: _vccs.setup(4 VCCS entries) + 2 gds entries = 6 total.
    //
    // Pins: P=1 (plate), G=2 (grid), K=3 (cathode). nodeCount=3.
    // VCCS pin mapping:
    //   ctrl+ = G=2,  ctrl- = K=3,  out+ = P=1,  out- = K=3
    //
    // VCCS setup (vccsset.c:43-46)- 4 entries:
    //   (out+=1, ctrl+=2), (out+=1, ctrl-=3), (out-=3, ctrl+=2), (out-=3, ctrl-=3)
    //
    // gds stamps (plate=nP=1, cathode=nK=3)- 2 entries:
    //   (nP=1, nP=1),  (nK=3, nP=1)
    //
    // Total: 6 entries.
    const props = new PropertyBag();
    props.replaceModelParams({ ...TRIODE_PARAM_DEFAULTS });
    const el = createTriodeElement(new Map([["P", 1], ["G", 2], ["K", 3]]), props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 3);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // VCCS sub-element (vccsset.c:43-46)
      { extRow: 1, extCol: 2 },  // (out+, ctrl+) = (P, G)
      { extRow: 1, extCol: 3 },  // (out+, ctrl-) = (P, K)
      { extRow: 3, extCol: 2 },  // (out-, ctrl+) = (K, G)
      { extRow: 3, extCol: 3 },  // (out-, ctrl-) = (K, K)
      // gds stamps
      { extRow: 1, extCol: 1 },  // (nP, nP) = (plate, plate)
      { extRow: 3, extCol: 1 },  // (nK, nP) = (cathode, plate)
    ]);
  });
  it("PB-VARACTOR TSTALLOC sequence", () => {
    // ngspice anchor: diosetup.c:232-238- 7 TSTALLOC entries (identical to DIO).
    // PB-VARACTOR per spec delegates to createDiodeElement, so the TSTALLOC
    // sequence is identical to PB-DIO with RS=0 (no internal node).
    // Nodes: posNode=1 (A), negNode=2 (K). _posPrimeNode = posNode = 1.
    const props = new PropertyBag();
    props.replaceModelParams({ ...DIODE_PARAM_DEFAULTS });
    const el = createDiodeElement(new Map([["A", 1], ["K", 2]]), props, () => 0);
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
    // ngspice anchor: vccsset.c:43-46- 4 TSTALLOC entries.
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
    // ngspice anchor: vcvsset.c:53-58- 6 TSTALLOC entries.
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
  it("PB-VSRC-AC TSTALLOC sequence", () => {
    // ngspice anchor: vsrcset.c:52-55- 4 TSTALLOC entries.
    // makeAcVoltageSourceElement is a 3-arg ssA.3 factory.
    // Nodes: posNode=1 ("pos"), negNode=2 ("neg").
    // Branch row allocated by engine._setup() at maxEqNum = nodeCount+1 = 3.
    //
    // TSTALLOC sequence (vsrcset.c:52-55):
    //  1. (posNode=1, branch=3)  VSRCposNode, VSRCbranch
    //  2. (negNode=2, branch=3)  VSRCnegNode, VSRCbranch
    //  3. (branch=3,  negNode=2) VSRCbranch,  VSRCnegNode
    //  4. (branch=3,  posNode=1) VSRCbranch,  VSRCposNode
    const props = new PropertyBag();
    props.replaceModelParams({ ...AC_VOLTAGE_SOURCE_DEFAULTS });
    const el = makeAcVoltageSourceElement(
      new Map([["pos", 1], ["neg", 2]]),
      props,
      () => 0,
    );
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 3 },  // (posNode=1, branch=3)- vsrcset.c:52
      { extRow: 2, extCol: 3 },  // (negNode=2, branch=3)- vsrcset.c:53
      { extRow: 3, extCol: 2 },  // (branch=3,  negNode=2)- vsrcset.c:54
      { extRow: 3, extCol: 1 },  // (branch=3,  posNode=1)- vsrcset.c:55
    ]);
  });
  it("PB-VSRC-DC TSTALLOC sequence", () => {
    // ngspice anchor: vsrcset.c:52-55- 4 TSTALLOC entries.
    // makeDcVoltageSource is a 3-arg ssA.3 factory.
    // Nodes: posNode=1 ("pos"), negNode=2 ("neg").
    // Branch row allocated by engine._setup() at maxEqNum = nodeCount+1 = 3.
    //
    // TSTALLOC sequence (vsrcset.c:52-55):
    //  1. (posNode=1, branch=3)  VSRCposNode, VSRCbranch
    //  2. (negNode=2, branch=3)  VSRCnegNode, VSRCbranch
    //  3. (branch=3,  negNode=2) VSRCbranch,  VSRCnegNode
    //  4. (branch=3,  posNode=1) VSRCbranch,  VSRCposNode
    const props = new PropertyBag();
    props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS });
    const el = makeDcVoltageSource(
      new Map([["pos", 1], ["neg", 2]]),
      props,
      () => 0,
    );
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 3 },  // (posNode=1, branch=3)- vsrcset.c:52
      { extRow: 2, extCol: 3 },  // (negNode=2, branch=3)- vsrcset.c:53
      { extRow: 3, extCol: 2 },  // (branch=3,  negNode=2)- vsrcset.c:54
      { extRow: 3, extCol: 1 },  // (branch=3,  posNode=1)- vsrcset.c:55
    ]);
  });
  it("PB-VSRC-VAR TSTALLOC sequence", () => {
    // ngspice anchor: vsrcset.c:52-55- 4 TSTALLOC entries.
    // makeVariableRailElement is a 3-arg ssA.3 factory.
    // Nodes: posNode=1 ("pos"), negNode=0 (ground- variable rail has no neg pin).
    // Branch row allocated by engine._setup() at maxEqNum = nodeCount+1 = 2.
    //
    // negNode=0 → allocElement(0, ...) and allocElement(..., 0) return TrashCan
    // (spbuild.c:272-273: row=0 or col=0 → TrashCan, not recorded).
    //
    // TSTALLOC calls (vsrcset.c:52-55):
    //  1. (posNode=1, branch=2)  → (1,2)  recorded
    //  2. (negNode=0, branch=2)  → TrashCan, not recorded
    //  3. (branch=2,  negNode=0) → TrashCan, not recorded
    //  4. (branch=2,  posNode=1) → (2,1)  recorded
    //
    // Expected: 2 entries.
    const props = new PropertyBag();
    props.replaceModelParams({ ...VARIABLE_RAIL_DEFAULTS });
    const el = makeVariableRailElement(
      new Map([["pos", 1]]),
      props,
      () => 0,
    );
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 1);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 2 },  // (posNode=1, branch=2)- vsrcset.c:52
      { extRow: 2, extCol: 1 },  // (branch=2,  posNode=1)- vsrcset.c:55
    ]);
  });
  it("PB-XFMR TSTALLOC sequence", () => {
    // TransformerDefinition "behavioral" model.
    // ssA.3: createTransformerElement(pinNodes, props, getTime).
    //
    // Pins: P1=1, P2=2, S1=3, S2=4. nodeCount=4.
    // setup() calls _l1.setup(), _l2.setup(), _mut.setup(), then winding
    // resistance handles, then B/C sub-matrix handles.
    //
    // _l1 (IND, posNode=P1=1, negNode=P2=2):
    //   branch b1 = makeCur → 5 (nodeCount+1=5)
    //   indsetup.c:96-100- 5 entries:
    //   (1,5),(2,5),(5,2),(5,1),(5,5)
    //
    // _l2 (IND, posNode=S1=3, negNode=S2=4):
    //   branch b2 = makeCur → 6
    //   indsetup.c:96-100- 5 entries:
    //   (3,6),(4,6),(6,4),(6,3),(6,6)
    //
    // _mut (MUT, b1=5, b2=6):
    //   mutsetup.c- 2 entries:
    //   (5,6),(6,5)
    //
    // Winding resistances (TRANSFORMER_DEFAULTS: primaryResistance=1>0, secondaryResistance=1>0):
    //   rPri > 0, p1=1≠0, p2=2≠0:
    //     (p1,p1)=(1,1), (p2,p2)=(2,2), (p1,p2)=(1,2), (p2,p1)=(2,1)
    //   rSec > 0, s1=3≠0, s2=4≠0:
    //     (s1,s1)=(3,3), (s2,s2)=(4,4), (s1,s2)=(3,4), (s2,s1)=(4,3)
    //
    // B/C sub-matrix (p1=1, p2=2, s1=3, s2=4, b1=5, b2=6):
    //   p1≠0: (1,5), p2≠0: (2,5), s1≠0: (3,6), s2≠0: (4,6)
    //   p1≠0: (5,1), p2≠0: (5,2), s1≠0: (6,3), s2≠0: (6,4)
    //
    // Total: 5+5+2+4+4+8 = 28 entries.
    const entry = TransformerDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
    const pinNodes = new Map<string, number>([
      ["P1", 1], ["P2", 2], ["S1", 3], ["S2", 4],
    ]);
    const props = new PropertyBag();
    props.replaceModelParams({ ...TRANSFORMER_DEFAULTS });
    const el = entry.factory(pinNodes, props, () => 0);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 4);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // _l1 (IND P1=1, P2=2, branch=5): indsetup.c:96-100
      { extRow: 1, extCol: 5 },
      { extRow: 2, extCol: 5 },
      { extRow: 5, extCol: 2 },
      { extRow: 5, extCol: 1 },
      { extRow: 5, extCol: 5 },
      // _l2 (IND S1=3, S2=4, branch=6): indsetup.c:96-100
      { extRow: 3, extCol: 6 },
      { extRow: 4, extCol: 6 },
      { extRow: 6, extCol: 4 },
      { extRow: 6, extCol: 3 },
      { extRow: 6, extCol: 6 },
      // _mut (MUT b1=5, b2=6): mutsetup.c
      { extRow: 5, extCol: 6 },
      { extRow: 6, extCol: 5 },
      // rPri winding resistance (p1=1, p2=2)
      { extRow: 1, extCol: 1 },
      { extRow: 2, extCol: 2 },
      { extRow: 1, extCol: 2 },
      { extRow: 2, extCol: 1 },
      // rSec winding resistance (s1=3, s2=4)
      { extRow: 3, extCol: 3 },
      { extRow: 4, extCol: 4 },
      { extRow: 3, extCol: 4 },
      { extRow: 4, extCol: 3 },
      // B/C sub-matrix
      { extRow: 1, extCol: 5 },
      { extRow: 2, extCol: 5 },
      { extRow: 3, extCol: 6 },
      { extRow: 4, extCol: 6 },
      { extRow: 5, extCol: 1 },
      { extRow: 5, extCol: 2 },
      { extRow: 6, extCol: 3 },
      { extRow: 6, extCol: 4 },
    ]);
  });
  it("PB-ZENER TSTALLOC sequence", () => {
    // ngspice anchor: diosetup.c:232-238- 7 TSTALLOC entries (identical to DIO).
    // ZenerDiode uses createZenerElement (simplified model) which has
    // the same TSTALLOC sequence as createDiodeElement.
    // RS=0 (default in ZENER_PARAM_DEFAULTS): _posPrimeNode = posNode = 1.
    // Nodes: posNode=1 (A), negNode=2 (K).
    //
    // TSTALLOC sequence (same as DIO with RS=0):
    //  1. (1,1), 2. (2,1), 3. (1,1), 4. (1,2), 5. (1,1), 6. (2,2), 7. (1,1)
    const props = new PropertyBag();
    props.replaceModelParams({ ...ZENER_PARAM_DEFAULTS });
    const el = createZenerElement(new Map([["A", 1], ["K", 2]]), props, () => 0);
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
