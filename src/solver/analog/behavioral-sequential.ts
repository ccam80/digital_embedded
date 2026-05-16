/**
 * Behavioral analog netlist builders for edge-triggered sequential components:
 * N-bit up/down counter with preset, and N-bit parallel-load register.
 *
 * (The plain N-bit counter's builder lives in src/components/memory/counter.ts,
 * co-located with CounterDefinition, not here.)
 *
 * Each builder returns a function-form MnaSubcircuitNetlist. For components
 * with variable bit width the builder is parameterized via PropertyBag so the
 * compiler can resolve the correct port list at instance-expansion time.
 *
 * Driver leaves (BehavioralCounterPresetDriver, BehavioralRegisterDriver) are
 * registered in src/components/register-all.ts.
 */

import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { SubcircuitElement } from "../../core/mna-subcircuit-netlist.js";
import type { PropertyBag } from "../../core/properties.js";

// ---------------------------------------------------------------------------
// buildCounterPresetNetlist
// ---------------------------------------------------------------------------

/**
 * Function-form netlist builder for the behavioral N-bit up/down counter with preset.
 *
 * Port order: en(0), C(1), dir(2), in(3), ld(4), clr(5), out(6), ovf(7), gnd(8).
 *
 * The multi-bit "in" and "out" pins each map to a single bus node (one node per port).
 * Only single-bit control inputs (en, C, dir, ld, clr) route through DIPLs per E2.
 * The wide-bus "in" port stays direct — no DIPL.
 *
 * Sub-elements:
 *   drv      - BehavioralCounterPresetDriver (driver leaf)
 *   inPin_en   - DigitalInputPinLoaded for en (3-port DIPL)
 *   inPin_C    - DigitalInputPinLoaded for C (3-port DIPL)
 *   inPin_dir  - DigitalInputPinLoaded for dir (3-port DIPL)
 *   inPin_ld   - DigitalInputPinLoaded for ld (3-port DIPL)
 *   inPin_clr  - DigitalInputPinLoaded for clr (3-port DIPL)
 *   outPin_i   - DigitalOutputPinLoaded for each out bit
 *   ovfPin     - DigitalOutputPinLoaded for ovf
 */
export function buildCounterPresetNetlist(props: PropertyBag): MnaSubcircuitNetlist {
  const bitWidth = props.getOrDefault<number>("bitWidth", 4);

  const ports = ["en", "C", "dir", "in", "ld", "clr", "out", "ovf", "gnd"];

  const netEn  = 0;
  const netC   = 1;
  const netDir = 2;
  const netIn  = 3;
  const netLd  = 4;
  const netClr = 5;
  const netOut = 6;
  const netOvf = 7;
  const netGnd = 8;

  // P=9 ports. Internal nets:
  //   ctrl_bit_0..N-1  at P..P+N-1
  //   ctrl_ovf         at P+N
  //   result_en        at P+N+1
  //   result_C         at P+N+2
  //   result_dir       at P+N+3
  //   result_ld        at P+N+4
  //   result_clr       at P+N+5
  const P = 9;
  const ctrlBitBase  = P;
  const ctrlOvfNet   = P + bitWidth;
  const resultEnNet  = P + bitWidth + 1;
  const resultCNet   = P + bitWidth + 2;
  const resultDirNet = P + bitWidth + 3;
  const resultLdNet  = P + bitWidth + 4;
  const resultClrNet = P + bitWidth + 5;

  const internalNetLabels: string[] = [];
  for (let i = 0; i < bitWidth; i++) {
    internalNetLabels.push(`ctrl_bit_${i}`);
  }
  internalNetLabels.push("ctrl_ovf");
  internalNetLabels.push("result_en");
  internalNetLabels.push("result_C");
  internalNetLabels.push("result_dir");
  internalNetLabels.push("result_ld");
  internalNetLabels.push("result_clr");

  // drv port order: [result_en, result_C, result_dir, in, result_ld, result_clr, gnd, ctrl_bit_0, ..., ctrl_bit_{N-1}, ctrl_ovf]
  // "in" stays direct (E2: wide-bus data pin, no DIPL)
  const drvNets: number[] = [resultEnNet, resultCNet, resultDirNet, netIn, resultLdNet, resultClrNet, netGnd];
  for (let i = 0; i < bitWidth; i++) {
    drvNets.push(ctrlBitBase + i);
  }
  drvNets.push(ctrlOvfNet);

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];

  elements.push({
    typeId: "BehavioralCounterPresetDriver",
    modelRef: "default",
    subElementName: "drv",
    params: { bitWidth },
  });
  netlist.push(drvNets);

  // Single-bit control inputs get 3-port DIPL rows with string-bound params.
  for (const [name, portIdx, resultNet] of [
    ["en",  netEn,  resultEnNet],
    ["C",   netC,   resultCNet],
    ["dir", netDir, resultDirNet],
    ["ld",  netLd,  resultLdNet],
    ["clr", netClr, resultClrNet],
  ] as const) {
    elements.push({
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: `inPin_${name}`,
      params: { vIH: "vIH", vIL: "vIL", rIn: "rIn", cIn: "cIn" },
    });
    netlist.push([portIdx, netGnd, resultNet]);
  }

  // One outPin_i per bit — each drives the packed bus output node with its ctrl_bit_i net
  for (let i = 0; i < bitWidth; i++) {
    elements.push({
      typeId: "DigitalOutputPinLoaded",
      modelRef: "default",
      subElementName: `outPin_${i}`,
      params: {},
    });
    netlist.push([netOut, netGnd, ctrlBitBase + i]);
  }

  elements.push({
    typeId: "DigitalOutputPinLoaded",
    modelRef: "default",
    subElementName: "ovfPin",
    params: {},
  });
  netlist.push([netOvf, netGnd, ctrlOvfNet]);

  return {
    ports,
    params: {
      vIH: props.getOrDefault<number>("vIH", 2.0),
      vIL: props.getOrDefault<number>("vIL", 0.8),
      rIn: props.getOrDefault<number>("rIn", 1e6),
      cIn: props.getOrDefault<number>("cIn", 1e-12),
    },
    elements,
    internalNetCount: bitWidth + 6,
    internalNetLabels,
    netlist,
  };
}

// ---------------------------------------------------------------------------
// buildRegisterNetlist
// ---------------------------------------------------------------------------

/**
 * Function-form netlist builder for the behavioral N-bit parallel-load register.
 *
 * Port order: D(0), C(1), en(2), Q(3), gnd(4).
 *
 * The multi-bit "D" and "Q" pins each map to a single bus node (one node per port).
 * Only single-bit control inputs (C, en) route through DIPLs per E2.
 * The wide-bus "D" port stays direct — no DIPL.
 *
 * Sub-elements:
 *   drv      - BehavioralRegisterDriver (driver leaf)
 *   inPin_C  - DigitalInputPinLoaded for C (3-port DIPL)
 *   inPin_en - DigitalInputPinLoaded for en (3-port DIPL)
 *   outPin_i - DigitalOutputPinLoaded for each Q bit
 */
export function buildRegisterNetlist(props: PropertyBag): MnaSubcircuitNetlist {
  const bitWidth = props.getOrDefault<number>("bitWidth", 8);

  const ports = ["D", "C", "en", "Q", "gnd"];

  const netD   = 0;
  const netC   = 1;
  const netEn  = 2;
  const netQ   = 3;
  const netGnd = 4;

  // P=5 ports. Internal nets:
  //   ctrl_bit_0..N-1  at P..P+N-1
  //   result_C         at P+N
  //   result_en        at P+N+1
  const P = 5;
  const ctrlBitBase = P;
  const resultCNet  = P + bitWidth;
  const resultEnNet = P + bitWidth + 1;

  const internalNetLabels: string[] = [];
  for (let i = 0; i < bitWidth; i++) {
    internalNetLabels.push(`ctrl_bit_${i}`);
  }
  internalNetLabels.push("result_C");
  internalNetLabels.push("result_en");

  // drv port order: [D, result_C, result_en, gnd, ctrl_bit_0, ..., ctrl_bit_{N-1}]
  // "D" stays direct (E2: wide-bus data pin, no DIPL)
  const drvNets: number[] = [netD, resultCNet, resultEnNet, netGnd];
  for (let i = 0; i < bitWidth; i++) {
    drvNets.push(ctrlBitBase + i);
  }

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];

  elements.push({
    typeId: "BehavioralRegisterDriver",
    modelRef: "default",
    subElementName: "drv",
    params: { bitWidth },
  });
  netlist.push(drvNets);

  // Single-bit control inputs get 3-port DIPL rows with string-bound params.
  for (const [name, portIdx, resultNet] of [
    ["C",  netC,  resultCNet],
    ["en", netEn, resultEnNet],
  ] as const) {
    elements.push({
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: `inPin_${name}`,
      params: { vIH: "vIH", vIL: "vIL", rIn: "rIn", cIn: "cIn" },
    });
    netlist.push([portIdx, netGnd, resultNet]);
  }

  // One outPin_i per bit — each drives the packed Q bus output node with its ctrl_bit_i net
  for (let i = 0; i < bitWidth; i++) {
    elements.push({
      typeId: "DigitalOutputPinLoaded",
      modelRef: "default",
      subElementName: `outPin_${i}`,
      params: {},
    });
    netlist.push([netQ, netGnd, ctrlBitBase + i]);
  }

  return {
    ports,
    params: {
      vIH: props.getOrDefault<number>("vIH", 2.0),
      vIL: props.getOrDefault<number>("vIL", 0.8),
      rIn: props.getOrDefault<number>("rIn", 1e6),
      cIn: props.getOrDefault<number>("cIn", 1e-12),
    },
    elements,
    internalNetCount: bitWidth + 2,
    internalNetLabels,
    netlist,
  };
}
