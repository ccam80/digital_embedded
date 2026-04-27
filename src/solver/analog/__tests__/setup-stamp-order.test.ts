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
import { createBjtElement, BJT_NPN_DEFAULTS } from "../../../components/semiconductors/bjt.js";
import { createDiodeElement, DIODE_PARAM_DEFAULTS } from "../../../components/semiconductors/diode.js";
import { createZenerElement, ZENER_PARAM_DEFAULTS } from "../../../components/semiconductors/zener.js";
import { PropertyBag } from "../../../core/properties.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";

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
  it.todo("PB-ANALOG_SWITCH TSTALLOC sequence");
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
  it.todo("PB-CCCS TSTALLOC sequence");
  it.todo("PB-CCVS TSTALLOC sequence");
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
  it("PB-FGNFET TSTALLOC sequence", () => {
    // ngspice anchors: capsetup.c:114-117 (4 CAP entries) + mos1set.c:186-207 (22 MOS entries)
    // nodeCount=2: drainNode=1, sourceNode=2.
    // fgNode allocated during setup() by makeVolt = nodeCount+1 = 3.
    // CAP sub-element runs first (NGSPICE_LOAD_ORDER.CAP=17 < MOS=35):
    //   pos=fgNode=3, neg=0 (ground)
    // Note: SparseSolver.allocElement returns TrashCan (handle 0) and does NOT
    // push to _insertionOrder when row=0 or col=0 (spbuild.c:272-273 port).
    // The three ground-involving CAP entries (0,0), (3,0), (0,3) are not recorded.
    // MOS sub-element runs second:
    //   gate=fgNode=3, drain=1, source=2, bulk=source=2, dPrime=drain=1, sPrime=source=2
    const el = makeFGNFETElement();
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // CAP — capsetup.c:114-117 (fgNode=3, negNode=0)
      // Only (3,3) is recorded; (0,0), (3,0), (0,3) return TrashCan without recording.
      { extRow: 3, extCol: 3 },  // (CAPposNode, CAPposNode)
      // MOS — mos1set.c:186-207 (gate=fgNode=3, drain=1, source=2, bulk=source=2)
      { extRow: 1, extCol: 1 },  // (MOS1dNode, MOS1dNode)
      { extRow: 3, extCol: 3 },  // (MOS1gNode, MOS1gNode)
      { extRow: 2, extCol: 2 },  // (MOS1sNode, MOS1sNode)
      { extRow: 2, extCol: 2 },  // (MOS1bNode, MOS1bNode) = bulk=source
      { extRow: 1, extCol: 1 },  // (MOS1dNodePrime, MOS1dNodePrime) = dNode (RD=0)
      { extRow: 2, extCol: 2 },  // (MOS1sNodePrime, MOS1sNodePrime) = sNode (RS=0)
      { extRow: 1, extCol: 1 },  // (MOS1dNode, MOS1dNodePrime)
      { extRow: 3, extCol: 2 },  // (MOS1gNode, MOS1bNode) = (fgNode, source)
      { extRow: 3, extCol: 1 },  // (MOS1gNode, MOS1dNodePrime) = (fgNode, drain)
      { extRow: 3, extCol: 2 },  // (MOS1gNode, MOS1sNodePrime) = (fgNode, source)
      { extRow: 2, extCol: 2 },  // (MOS1sNode, MOS1sNodePrime)
      { extRow: 2, extCol: 1 },  // (MOS1bNode, MOS1dNodePrime) = (source, drain)
      { extRow: 2, extCol: 2 },  // (MOS1bNode, MOS1sNodePrime) = (source, source)
      { extRow: 1, extCol: 2 },  // (MOS1dNodePrime, MOS1sNodePrime) = (drain, source)
      { extRow: 1, extCol: 1 },  // (MOS1dNodePrime, MOS1dNode)
      { extRow: 2, extCol: 3 },  // (MOS1bNode, MOS1gNode) = (source, fgNode)
      { extRow: 1, extCol: 3 },  // (MOS1dNodePrime, MOS1gNode) = (drain, fgNode)
      { extRow: 2, extCol: 3 },  // (MOS1sNodePrime, MOS1gNode) = (source, fgNode)
      { extRow: 2, extCol: 2 },  // (MOS1sNodePrime, MOS1sNode)
      { extRow: 1, extCol: 2 },  // (MOS1dNodePrime, MOS1bNode) = (drain, source)
      { extRow: 2, extCol: 2 },  // (MOS1sNodePrime, MOS1bNode) = (source, source)
      { extRow: 2, extCol: 1 },  // (MOS1sNodePrime, MOS1dNodePrime) = (source, drain)
    ]);
  });

  it("PB-FGPFET TSTALLOC sequence", () => {
    // ngspice anchors: capsetup.c:114-117 (4 CAP entries) + mos1set.c:186-207 (22 MOS entries)
    // Identical TSTALLOC structure to FGNFET — MOS type (NMOS vs PMOS) affects
    // load-time computation only; mos1set.c:186-207 is unconditional and type-independent.
    // nodeCount=2: drainNode=1, sourceNode=2.
    // fgNode allocated during setup() by makeVolt = nodeCount+1 = 3.
    // Ground-involving CAP entries (0,0), (3,0), (0,3) not recorded per spbuild.c:272-273.
    const el = makeFGPFETElement();
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      // CAP — capsetup.c:114-117 (fgNode=3, negNode=0)
      // Only (3,3) is recorded; (0,0), (3,0), (0,3) return TrashCan without recording.
      { extRow: 3, extCol: 3 },  // (CAPposNode, CAPposNode)
      // MOS — mos1set.c:186-207 (gate=fgNode=3, drain=1, source=2, bulk=source=2)
      { extRow: 1, extCol: 1 },  // (MOS1dNode, MOS1dNode)
      { extRow: 3, extCol: 3 },  // (MOS1gNode, MOS1gNode)
      { extRow: 2, extCol: 2 },  // (MOS1sNode, MOS1sNode)
      { extRow: 2, extCol: 2 },  // (MOS1bNode, MOS1bNode) = bulk=source
      { extRow: 1, extCol: 1 },  // (MOS1dNodePrime, MOS1dNodePrime) = dNode (RD=0)
      { extRow: 2, extCol: 2 },  // (MOS1sNodePrime, MOS1sNodePrime) = sNode (RS=0)
      { extRow: 1, extCol: 1 },  // (MOS1dNode, MOS1dNodePrime)
      { extRow: 3, extCol: 2 },  // (MOS1gNode, MOS1bNode) = (fgNode, source)
      { extRow: 3, extCol: 1 },  // (MOS1gNode, MOS1dNodePrime) = (fgNode, drain)
      { extRow: 3, extCol: 2 },  // (MOS1gNode, MOS1sNodePrime) = (fgNode, source)
      { extRow: 2, extCol: 2 },  // (MOS1sNode, MOS1sNodePrime)
      { extRow: 2, extCol: 1 },  // (MOS1bNode, MOS1dNodePrime) = (source, drain)
      { extRow: 2, extCol: 2 },  // (MOS1bNode, MOS1sNodePrime) = (source, source)
      { extRow: 1, extCol: 2 },  // (MOS1dNodePrime, MOS1sNodePrime) = (drain, source)
      { extRow: 1, extCol: 1 },  // (MOS1dNodePrime, MOS1dNode)
      { extRow: 2, extCol: 3 },  // (MOS1bNode, MOS1gNode) = (source, fgNode)
      { extRow: 1, extCol: 3 },  // (MOS1dNodePrime, MOS1gNode) = (drain, fgNode)
      { extRow: 2, extCol: 3 },  // (MOS1sNodePrime, MOS1gNode) = (source, fgNode)
      { extRow: 2, extCol: 2 },  // (MOS1sNodePrime, MOS1sNode)
      { extRow: 1, extCol: 2 },  // (MOS1dNodePrime, MOS1bNode) = (drain, source)
      { extRow: 2, extCol: 2 },  // (MOS1sNodePrime, MOS1bNode) = (source, source)
      { extRow: 2, extCol: 1 },  // (MOS1sNodePrime, MOS1dNodePrime) = (source, drain)
    ]);
  });
  it.todo("PB-FUSE TSTALLOC sequence");
  it.todo("PB-IND TSTALLOC sequence");
  it.todo("PB-ISRC TSTALLOC sequence");
  it.todo("PB-LDR TSTALLOC sequence");
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

  it.todo("PB-NJFET TSTALLOC sequence");
  it.todo("PB-NMOS TSTALLOC sequence");
  it.todo("PB-NTC TSTALLOC sequence");
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
  it.todo("PB-PMOS TSTALLOC sequence");
  it.todo("PB-POLCAP TSTALLOC sequence");
  it.todo("PB-POT TSTALLOC sequence");
  it.todo("PB-REAL_OPAMP TSTALLOC sequence");
  it.todo("PB-RELAY TSTALLOC sequence");
  it.todo("PB-RELAY-DT TSTALLOC sequence");
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
  it.todo("PB-SPARK TSTALLOC sequence");
  it.todo("PB-SUBCKT TSTALLOC sequence");
  it.todo("PB-SW TSTALLOC sequence");
  it.todo("PB-SW-DT TSTALLOC sequence");
  it.todo("PB-TAPXFMR TSTALLOC sequence");
  it.todo("PB-TIMER555 TSTALLOC sequence");
  it.todo("PB-TLINE TSTALLOC sequence");
  it.todo("PB-TRANSGATE TSTALLOC sequence");
  it.todo("PB-TRIAC TSTALLOC sequence");
  it.todo("PB-TRIODE TSTALLOC sequence");
  it.todo("PB-TUNNEL TSTALLOC sequence");
  it.todo("PB-VARACTOR TSTALLOC sequence");
  it.todo("PB-VCCS TSTALLOC sequence");
  it.todo("PB-VCVS TSTALLOC sequence");
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
