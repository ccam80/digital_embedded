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
 *
 * Sub-elements:
 *   drv      - BehavioralCounterPresetDriver (driver leaf)
 *   enPin    - DigitalInputPinLoaded for en
 *   clockPin - DigitalInputPinLoaded for C
 *   dirPin   - DigitalInputPinLoaded for dir
 *   inPin    - DigitalInputPinLoaded for in (bus)
 *   ldPin    - DigitalInputPinLoaded for ld
 *   clrPin   - DigitalInputPinLoaded for clr
 *   outPin   - DigitalOutputPinLoaded for out (bus)
 *   ovfPin   - DigitalOutputPinLoaded for ovf
 */
export function buildCounterPresetNetlist(props: PropertyBag): MnaSubcircuitNetlist {
  const bitWidth = props.getOrDefault<number>("bitWidth", 4);

  const ports = ["en", "C", "dir", "in", "ld", "clr", "out", "ovf", "gnd"];

  const netEn = 0;
  const netC = 1;
  const netDir = 2;
  const netIn = 3;
  const netLd = 4;
  const netClr = 5;
  const netOut = 6;
  const netOvf = 7;
  const netGnd = 8;

  // Internal ctrl nets: P=9 ports, ctrl_bit_0..N-1 at 9..9+N-1, ctrl_ovf at 9+N
  const P = 9;
  const ctrlBitBase = P;
  const ctrlOvfNet = P + bitWidth;

  const internalNetLabels: string[] = [];
  for (let i = 0; i < bitWidth; i++) {
    internalNetLabels.push(`ctrl_bit_${i}`);
  }
  internalNetLabels.push("ctrl_ovf");

  // drv port order: [en, C, dir, in, ld, clr, gnd, ctrl_bit_0, ..., ctrl_bit_{N-1}, ctrl_ovf]
  const drvNets: number[] = [netEn, netC, netDir, netIn, netLd, netClr, netGnd];
  for (let i = 0; i < bitWidth; i++) {
    drvNets.push(ctrlBitBase + i);
  }
  drvNets.push(ctrlOvfNet);

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralCounterPresetDriver",
      modelRef: "default",
      subElementName: "drv",
      params: { bitWidth },
    },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "enPin",
      params: {},
    },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "clockPin",
      params: {},
    },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "dirPin",
      params: {},
    },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "inPin",
      params: {},
    },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "ldPin",
      params: {},
    },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "clrPin",
      params: {},
    },
  ];

  // drv connectivity row
  const netlist: number[][] = [
    drvNets,           // drv
    [netEn, netGnd],   // enPin
    [netC, netGnd],    // clockPin
    [netDir, netGnd],  // dirPin
    [netIn, netGnd],   // inPin
    [netLd, netGnd],   // ldPin
    [netClr, netGnd],  // clrPin
  ];

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
    params: {},
    elements,
    internalNetCount: bitWidth + 1,
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
 *
 * Sub-elements:
 *   drv      - BehavioralRegisterDriver (driver leaf)
 *   dPin     - DigitalInputPinLoaded for D (bus)
 *   clockPin - DigitalInputPinLoaded for C
 *   enPin    - DigitalInputPinLoaded for en
 *   qPin     - DigitalOutputPinLoaded for Q (bus)
 */
export function buildRegisterNetlist(props: PropertyBag): MnaSubcircuitNetlist {
  const bitWidth = props.getOrDefault<number>("bitWidth", 8);

  const ports = ["D", "C", "en", "Q", "gnd"];

  const netD = 0;
  const netC = 1;
  const netEn = 2;
  const netQ = 3;
  const netGnd = 4;

  // Internal ctrl nets: P=5 ports, ctrl_bit_0..N-1 at 5..5+N-1
  const P = 5;
  const ctrlBitBase = P;

  const internalNetLabels: string[] = [];
  for (let i = 0; i < bitWidth; i++) {
    internalNetLabels.push(`ctrl_bit_${i}`);
  }

  // drv port order: [D, C, en, gnd, ctrl_bit_0, ..., ctrl_bit_{N-1}]
  const drvNets: number[] = [netD, netC, netEn, netGnd];
  for (let i = 0; i < bitWidth; i++) {
    drvNets.push(ctrlBitBase + i);
  }

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralRegisterDriver",
      modelRef: "default",
      subElementName: "drv",
      params: { bitWidth },
    },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "dPin",
      params: {},
    },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "clockPin",
      params: {},
    },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "enPin",
      params: {},
    },
  ];

  // drv connectivity row, then input pins
  const netlist: number[][] = [
    drvNets,            // drv
    [netD, netGnd],     // dPin
    [netC, netGnd],     // clockPin
    [netEn, netGnd],    // enPin
  ];

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
    params: {},
    elements,
    internalNetCount: bitWidth,
    internalNetLabels,
    netlist,
  };
}
