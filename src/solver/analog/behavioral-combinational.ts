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

export function buildDecoderNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  const K        = params.getModelParam<number>("selectorBits");
  const N        = 1 << K;
  const loaded   = params.getModelParam<number>("loaded") >= 0.5;
  const inputPinType  = loaded ? "DigitalInputPinLoaded"  : "DigitalInputPinUnloaded";
  const outputPinType = loaded ? "DigitalOutputPinLoaded" : "DigitalOutputPinUnloaded";

  // Port order: sel (K=1) or sel_0..sel_{K-1} (K>1), out_0..out_{N-1}, gnd.
  // Single-bit `sel` matches the decoder's user-visible pinLayout label
  // exactly. K>1 still emits per-bit `sel_${i}` ports because the analog
  // domain needs one node per selector bit; that path requires a follow-up
  // to split the user-visible `sel` pin into per-bit pins when an analog
  // model is selected.
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

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];

  // Driver leaf- pin order MUST match buildDecoderDriverPinLayout
  // (sel_0..sel_{K-1}, gnd).
  const drvNets: number[] = [];
  for (let i = 0; i < K; i++) drvNets.push(selPortBase + i);
  drvNets.push(gndPortIdx);
  elements.push({
    typeId: "BehavioralDecoderDriver",
    modelRef: "default",
    subElementName: "drv",
    params: {
      selectorBits: K,
      vIH: params.getModelParam<number>("vIH"),
      vIL: params.getModelParam<number>("vIL"),
    },
  });
  netlist.push(drvNets);

  // Selector input pins- one per selector bit.
  for (let i = 0; i < K; i++) {
    elements.push({
      typeId: inputPinType,
      modelRef: "default",
      subElementName: `inPin_sel_${i}`,
    });
    netlist.push([selPortBase + i, gndPortIdx]);
  }

  // Output pins- one per decoded output bit.
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
    netlist.push([outPortBase + i, gndPortIdx]);
  }

  return {
    ports,
    elements,
    internalNetCount: 0,
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
// Analog model treats data as 1-bit (matches mux's analog-model limitation:
// multi-bit data falls through to the digital path).

export function buildDemuxNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  const K        = params.getModelParam<number>("selectorBits");
  const N        = 1 << K;
  const loaded   = params.getModelParam<number>("loaded") >= 0.5;
  const inputPinType  = loaded ? "DigitalInputPinLoaded"  : "DigitalInputPinUnloaded";
  const outputPinType = loaded ? "DigitalOutputPinLoaded" : "DigitalOutputPinUnloaded";

  // Port order: sel (K=1) or sel_0..sel_{K-1} (K>1), in, out_0..out_{N-1}, gnd.
  // Single-bit `sel` matches the demux's user-visible pinLayout label
  // exactly. K>1 still emits per-bit `sel_${i}` ports because the analog
  // domain needs one node per selector bit; that path requires a follow-up
  // to split the user-visible `sel` pin into per-bit pins when an analog
  // model is selected.
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

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];

  // Driver leaf- pin order MUST match buildDemuxDriverPinLayout
  // (sel_0..sel_{K-1}, in, gnd).
  const drvNets: number[] = [];
  for (let i = 0; i < K; i++) drvNets.push(selPortBase + i);
  drvNets.push(inPortIdx, gndPortIdx);
  elements.push({
    typeId: "BehavioralDemuxDriver",
    modelRef: "default",
    subElementName: "drv",
    params: {
      selectorBits: K,
      vIH: params.getModelParam<number>("vIH"),
      vIL: params.getModelParam<number>("vIL"),
    },
  });
  netlist.push(drvNets);

  // Selector input pins.
  for (let i = 0; i < K; i++) {
    elements.push({
      typeId: inputPinType,
      modelRef: "default",
      subElementName: `inPin_sel_${i}`,
    });
    netlist.push([selPortBase + i, gndPortIdx]);
  }

  // Data input pin.
  elements.push({
    typeId: inputPinType,
    modelRef: "default",
    subElementName: "inPin_in",
  });
  netlist.push([inPortIdx, gndPortIdx]);

  // Output pins- one per demux output port.
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
    netlist.push([outPortBase + i, gndPortIdx]);
  }

  return {
    ports,
    elements,
    internalNetCount: 0,
    netlist,
  };
}
