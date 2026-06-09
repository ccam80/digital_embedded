/**
 * Behavioural function-form netlist builders for combinational wiring
 * components.
 *
 * Currently:
 *   - buildDecoderNetlist  (Decoder, K-bit sel → 2^K one-hot outputs)
 *   - buildDemuxNetlist    (Demultiplexer, K-bit sel + 1-bit data → 2^K outputs)
 *
 * Mux's builder lives alongside its component file (`src/components/wiring/
 * mux.ts`); this module mirrors its shape for the other two combinational
 * wiring components.
 *
 * Both builders emit one BehavioralXxxDriver leaf + per-port loaded/unloaded
 * input pins + per-output loaded/unloaded output pins.
 */

import type { MnaSubcircuitNetlist, SubcircuitElement } from "../../core/mna-subcircuit-netlist.js";
import type { PropertyBag } from "../../core/properties.js";
import { buildBSourceTree } from "./expression.js";

/**
 * Product decode-literal weight for output index `i` over K selector
 * controllers: ∏_b ((i>>b)&1 ? V(s_b) : 1-V(s_b)). On the {0,0.5,1} lattice this
 * is the one-hot minterm select (1 only when every selector bit matches `i`).
 */
function decodeWeightExpr(i: number, K: number): string {
  const lits = Array.from({ length: K }, (_, b) =>
    ((i >>> b) & 1) === 1 ? `V(s${b})` : `(1-V(s${b}))`);
  return lits.join("*");
}

// ---------------------------------------------------------------------------
// buildDecoderNetlist
// ---------------------------------------------------------------------------
//
// Ports: sel_0..sel_{K-1}, out_0..out_{N-1}, gnd      (N = 2^K)
//
// Sub-elements:
//   drv          : BehavioralDecoderDriver (K selector pins + gnd)
//   inPin_sel_i  : DigitalInputPin{Loaded|Unloaded} per selector bit
//   outPin_i     : DigitalOutputPin{Loaded|Unloaded} per decoded output bit
//
// Internal nets (decision P3-D5):
//   ctrl_0..ctrl_{N-1}               at portCount + 0..N-1
//   result_sel_0..result_sel_{K-1}   at portCount + N..N+K-1
//   internalNetCount = N + K

export function buildDecoderNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  const K        = params.getModelParam<number>("selectorBits");
  const N        = 1 << K;
  const loaded   = params.getModelParam<number>("loaded") >= 0.5;
  const inputPinType  = loaded ? "DigitalInputPinLoaded"  : "DigitalInputPinUnloaded";
  const outputPinType = loaded ? "DigitalOutputPinLoaded" : "DigitalOutputPinUnloaded";

  // Port order: sel (K=1) or sel_0..sel_{K-1} (K>1), out_0..out_{N-1}, gnd.
  const ports: string[] = [];
  if (K === 1) {
    ports.push("sel");
  } else {
    for (let i = 0; i < K; i++) ports.push(`sel_${i}`);
  }
  for (let i = 0; i < N; i++) ports.push(`out_${i}`);
  ports.push("gnd");

  const selPortBase = 0;
  const outPortBase = K;
  const gndPortIdx  = K + N;
  const portCount   = K + N + 1;

  // Internal nets (decision P3-D5):
  //   ctrl_i        at portCount + i          (i in 0..N-1)
  //   result_sel_b  at portCount + N + b      (b in 0..K-1)
  const ctrlNetBase   = portCount;
  const resultSelBase = portCount + N;

  const internalNetLabels: string[] = [];
  for (let i = 0; i < N; i++) internalNetLabels.push(`ctrl_${i}`);
  for (let b = 0; b < K; b++) internalNetLabels.push(`result_sel_${b}`);

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];

  // One BehavioralLogic I-mode B-source per decoded output: out_i = ∏_b lit_b_i
  // (the product decode literal), each paired with a 1Ω drvR Norton
  // (I + 1Ω -> V(ctrl_i) = expr). Controllers bound in the expression's V()
  // first-encounter order (parsed), out+ -> gnd, out- -> ctrl_i.
  for (let i = 0; i < N; i++) {
    const expr = decodeWeightExpr(i, K);
    const nodeVars = buildBSourceTree(expr).vars.filter((v) => v.kind === "node").map((v) => v.label);
    const pins = nodeVars.map((label) => resultSelBase + Number(label.slice(1)));
    pins.push(gndPortIdx, ctrlNetBase + i);
    elements.push({
      typeId: "BehavioralLogic", modelRef: "default", subElementName: `drv_${i}`,
      params: { expression: { kind: "literal", value: expr } },
    });
    netlist.push(pins);
    elements.push({
      typeId: "Resistor", modelRef: "behavioral", subElementName: `drvR_${i}`,
      params: { resistance: 1 },
    });
    netlist.push([ctrlNetBase + i, gndPortIdx]);
  }

  // Selector input pins — 3-port DIPL, string-bound.
  for (let b = 0; b < K; b++) {
    elements.push({
      typeId: inputPinType,
      modelRef: "default",
      subElementName: `inPin_sel_${b}`,
      params: { vIH: "vIH", vIL: "vIL", rIn: "rIn", cIn: "cIn" },
    });
    netlist.push([selPortBase + b, gndPortIdx, resultSelBase + b]);
  }

  // Output pins — one per decoded output bit.
  for (let i = 0; i < N; i++) {
    elements.push({
      typeId: outputPinType,
      modelRef: "default",
      subElementName: `outPin_${i}`,
      params: {
        rOut: params.getModelParam<number>("rOut"),
        cOut: params.getModelParam<number>("cOut"),
        vOH:  params.getModelParam<number>("vOH"),
        vOL:  params.getModelParam<number>("vOL"),
      },
    });
    netlist.push([outPortBase + i, gndPortIdx, ctrlNetBase + i]);
  }

  return {
    ports,
    params: {
      vIH: params.getModelParam<number>("vIH"),
      vIL: params.getModelParam<number>("vIL"),
      rIn: params.getModelParam<number>("rIn"),
      cIn: params.getModelParam<number>("cIn"),
    },
    elements,
    internalNetCount: N + K,
    internalNetLabels,
    netlist,
  };
}

// ---------------------------------------------------------------------------
// buildDemuxNetlist
// ---------------------------------------------------------------------------
//
// Ports: sel_0..sel_{K-1}, in, out_0..out_{N-1}, gnd  (N = 2^K)
//
// Sub-elements:
//   drv          : BehavioralDemuxDriver (K selector pins + 1 data pin + gnd)
//   inPin_sel_i  : DigitalInputPin{Loaded|Unloaded} per selector bit
//   inPin_in     : DigitalInputPin{Loaded|Unloaded} for data input
//   outPin_i     : DigitalOutputPin{Loaded|Unloaded} per output port
//
// Internal nets (decision P3-D5):
//   ctrl_0..ctrl_{N-1}               at portCount + 0..N-1
//   result_in                         at portCount + N
//   result_sel_0..result_sel_{K-1}   at portCount + N+1..N+K
//   internalNetCount = N + 1 + K

export function buildDemuxNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  const K        = params.getModelParam<number>("selectorBits");
  const N        = 1 << K;
  const loaded   = params.getModelParam<number>("loaded") >= 0.5;
  const inputPinType  = loaded ? "DigitalInputPinLoaded"  : "DigitalInputPinUnloaded";
  const outputPinType = loaded ? "DigitalOutputPinLoaded" : "DigitalOutputPinUnloaded";

  // Port order: sel (K=1) or sel_0..sel_{K-1} (K>1), in, out_0..out_{N-1}, gnd.
  const ports: string[] = [];
  if (K === 1) {
    ports.push("sel");
  } else {
    for (let i = 0; i < K; i++) ports.push(`sel_${i}`);
  }
  ports.push("in");
  for (let i = 0; i < N; i++) ports.push(`out_${i}`);
  ports.push("gnd");

  const selPortBase = 0;
  const inPortIdx   = K;
  const outPortBase = K + 1;
  const gndPortIdx  = K + 1 + N;
  const portCount   = K + 1 + N + 1;

  // Internal nets (decision P3-D5):
  //   ctrl_i        at portCount + i          (i in 0..N-1)
  //   result_in     at portCount + N
  //   result_sel_b  at portCount + N + 1 + b  (b in 0..K-1)
  const ctrlNetBase   = portCount;
  const resultInNet   = portCount + N;
  const resultSelBase = portCount + N + 1;

  const internalNetLabels: string[] = [];
  for (let i = 0; i < N; i++) internalNetLabels.push(`ctrl_${i}`);
  internalNetLabels.push("result_in");
  for (let b = 0; b < K; b++) internalNetLabels.push(`result_sel_${b}`);

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];

  // One BehavioralLogic I-mode B-source per output: out_i = (∏_b lit_b_i)·V(in),
  // each paired with a 1Ω drvR Norton. Controllers (selector literals + data)
  // bound in the expression's V() first-encounter order, out+ -> gnd,
  // out- -> ctrl_i.
  for (let i = 0; i < N; i++) {
    const expr = `(${decodeWeightExpr(i, K)})*V(in)`;
    const nodeVars = buildBSourceTree(expr).vars.filter((v) => v.kind === "node").map((v) => v.label);
    const pins = nodeVars.map((label) => (label === "in" ? resultInNet : resultSelBase + Number(label.slice(1))));
    pins.push(gndPortIdx, ctrlNetBase + i);
    elements.push({
      typeId: "BehavioralLogic", modelRef: "default", subElementName: `drv_${i}`,
      params: { expression: { kind: "literal", value: expr } },
    });
    netlist.push(pins);
    elements.push({
      typeId: "Resistor", modelRef: "behavioral", subElementName: `drvR_${i}`,
      params: { resistance: 1 },
    });
    netlist.push([ctrlNetBase + i, gndPortIdx]);
  }

  // Selector input pins — 3-port DIPL, string-bound.
  for (let b = 0; b < K; b++) {
    elements.push({
      typeId: inputPinType,
      modelRef: "default",
      subElementName: `inPin_sel_${b}`,
      params: { vIH: "vIH", vIL: "vIL", rIn: "rIn", cIn: "cIn" },
    });
    netlist.push([selPortBase + b, gndPortIdx, resultSelBase + b]);
  }

  // Data input pin — 3-port DIPL, string-bound.
  elements.push({
    typeId: inputPinType,
    modelRef: "default",
    subElementName: "inPin_in",
    params: { vIH: "vIH", vIL: "vIL", rIn: "rIn", cIn: "cIn" },
  });
  netlist.push([inPortIdx, gndPortIdx, resultInNet]);

  // Output pins — one per demux output port.
  for (let i = 0; i < N; i++) {
    elements.push({
      typeId: outputPinType,
      modelRef: "default",
      subElementName: `outPin_${i}`,
      params: {
        rOut: params.getModelParam<number>("rOut"),
        cOut: params.getModelParam<number>("cOut"),
        vOH:  params.getModelParam<number>("vOH"),
        vOL:  params.getModelParam<number>("vOL"),
      },
    });
    netlist.push([outPortBase + i, gndPortIdx, ctrlNetBase + i]);
  }

  return {
    ports,
    params: {
      vIH: params.getModelParam<number>("vIH"),
      vIL: params.getModelParam<number>("vIL"),
      rIn: params.getModelParam<number>("rIn"),
      cIn: params.getModelParam<number>("cIn"),
    },
    elements,
    internalNetCount: N + 1 + K,
    internalNetLabels,
    netlist,
  };
}
