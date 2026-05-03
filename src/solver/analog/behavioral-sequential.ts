/**
 * Behavioral analog netlist builders for edge-triggered sequential components:
 * N-bit counter, N-bit up/down counter with preset, and N-bit parallel-load register.
 *
 * Each builder returns a function-form MnaSubcircuitNetlist. For components
 * with variable bit width the builder is parameterized via PropertyBag so the
 * compiler can resolve the correct port list at instance-expansion time.
 *
 * Driver leaves (BehavioralCounterDriver, BehavioralCounterPresetDriver,
 * BehavioralRegisterDriver) are registered in src/components/register-all.ts.
 */

import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { SubcircuitElement } from "../../core/mna-subcircuit-netlist.js";
import type { PropertyBag } from "../../core/properties.js";

// ---------------------------------------------------------------------------
// buildCounterNetlist
// ---------------------------------------------------------------------------

/**
 * Function-form netlist builder for the behavioral N-bit counter.
 *
 * Port order: en(0), C(1), clr(2), out_0..out_{N-1}(3..3+N-1), ovf(3+N), gnd(4+N).
 *
 * Sub-elements:
 *   drv      - BehavioralCounterDriver (driver leaf)
 *   enPin    - DigitalInputPinLoaded for en
 *   clockPin - DigitalInputPinLoaded for C
 *   clrPin   - DigitalInputPinLoaded for clr
 *   outPin_i - DigitalOutputPinLoaded for each output bit
 *   ovfPin   - DigitalOutputPinLoaded for ovf
 */
export function buildCounterNetlist(props: PropertyBag): MnaSubcircuitNetlist {
  const bitWidth: number = (props.has("bitWidth") ? props.get("bitWidth") as number : undefined) ?? 4;

  const ports: string[] = ["en", "C", "clr"];
  for (let i = 0; i < bitWidth; i++) {
    ports.push(`out_${i}`);
  }
  ports.push("ovf");
  ports.push("gnd");

  // Net index helpers
  const netEn = 0;
  const netC = 1;
  const netClr = 2;
  const netOutBase = 3;
  const netOvf = 3 + bitWidth;
  const netGnd = 4 + bitWidth;

  // drv port order must match BehavioralCounterDriver pin declarations:
  // en, C, clr, out_0..out_{N-1}, ovf, gnd
  const drvNets: number[] = [netEn, netC, netClr];
  for (let i = 0; i < bitWidth; i++) {
    drvNets.push(netOutBase + i);
  }
  drvNets.push(netOvf);
  drvNets.push(netGnd);

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralCounterDriver",
      modelRef: "default",
      subElementName: "drv",
      params: { bitWidth },
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "enPin",
      params: {},
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "clockPin",
      params: {},
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "clrPin",
      params: {},
    } as SubcircuitElement & { subElementName: string },
  ];

  const netlist: number[][] = [
    drvNets,           // drv
    [netEn, netGnd],   // enPin
    [netC, netGnd],    // clockPin
    [netClr, netGnd],  // clrPin
  ];

  for (let i = 0; i < bitWidth; i++) {
    elements.push({
      typeId: "DigitalOutputPinLoaded",
      modelRef: "default",
      subElementName: `outPin_${i}`,
      params: {
        inputLogic: { kind: "siblingState", subElementName: "drv", slotName: `OUTPUT_LOGIC_LEVEL_${i}` },
      },
    } as SubcircuitElement & { subElementName: string });
    netlist.push([netOutBase + i, netGnd]);
  }

  elements.push({
    typeId: "DigitalOutputPinLoaded",
    modelRef: "default",
    subElementName: "ovfPin",
    params: {
      inputLogic: { kind: "siblingState", subElementName: "drv", slotName: "OUTPUT_LOGIC_LEVEL_OVF" },
    },
  } as SubcircuitElement & { subElementName: string });
  netlist.push([netOvf, netGnd]);

  return {
    ports,
    params: {},
    elements,
    internalNetCount: 0,
    netlist,
  };
}

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
  const bitWidth: number = (props.has("bitWidth") ? props.get("bitWidth") as number : undefined) ?? 4;

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

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralCounterPresetDriver",
      modelRef: "default",
      subElementName: "drv",
      params: { bitWidth },
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "enPin",
      params: {},
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "clockPin",
      params: {},
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "dirPin",
      params: {},
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "inPin",
      params: {},
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "ldPin",
      params: {},
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "clrPin",
      params: {},
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalOutputPinLoaded",
      modelRef: "default",
      subElementName: "outPin",
      params: {
        inputLogic: { kind: "siblingState", subElementName: "drv", slotName: "OUTPUT_LOGIC_LEVEL_OUT" },
      },
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalOutputPinLoaded",
      modelRef: "default",
      subElementName: "ovfPin",
      params: {
        inputLogic: { kind: "siblingState", subElementName: "drv", slotName: "OUTPUT_LOGIC_LEVEL_OVF" },
      },
    } as SubcircuitElement & { subElementName: string },
  ];

  // drv port order: en, C, dir, in, ld, clr, out, ovf, gnd
  const netlist: number[][] = [
    [netEn, netC, netDir, netIn, netLd, netClr, netOut, netOvf, netGnd], // drv
    [netEn, netGnd],   // enPin
    [netC, netGnd],    // clockPin
    [netDir, netGnd],  // dirPin
    [netIn, netGnd],   // inPin
    [netLd, netGnd],   // ldPin
    [netClr, netGnd],  // clrPin
    [netOut, netGnd],  // outPin
    [netOvf, netGnd],  // ovfPin
  ];

  return {
    ports,
    params: {},
    elements,
    internalNetCount: 0,
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
  const bitWidth: number = (props.has("bitWidth") ? props.get("bitWidth") as number : undefined) ?? 8;

  const ports = ["D", "C", "en", "Q", "gnd"];

  const netD = 0;
  const netC = 1;
  const netEn = 2;
  const netQ = 3;
  const netGnd = 4;

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralRegisterDriver",
      modelRef: "default",
      subElementName: "drv",
      params: { bitWidth },
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "dPin",
      params: {},
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "clockPin",
      params: {},
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "enPin",
      params: {},
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalOutputPinLoaded",
      modelRef: "default",
      subElementName: "qPin",
      params: {
        inputLogic: { kind: "siblingState", subElementName: "drv", slotName: "OUTPUT_LOGIC_LEVEL_Q" },
      },
    } as SubcircuitElement & { subElementName: string },
  ];

  // drv port order: D, C, en, Q, gnd
  const netlist: number[][] = [
    [netD, netC, netEn, netQ, netGnd], // drv
    [netD, netGnd],                    // dPin
    [netC, netGnd],                    // clockPin
    [netEn, netGnd],                   // enPin
    [netQ, netGnd],                    // qPin
  ];

  return {
    ports,
    params: {},
    elements,
    internalNetCount: 0,
    netlist,
  };
}
