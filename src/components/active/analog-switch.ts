/**
 * Analog Switch components — SPST and SPDT.
 *
 * Voltage-controlled variable resistances. The control voltage smoothly
 * transitions resistance from R_off to R_on using a tanh function, providing
 * a continuous, differentiable R(V_ctrl) characteristic for reliable
 * Newton-Raphson convergence.
 *
 * SPST (Single-Pole Single-Throw):
 *   Pins: ctrl, in, out
 *   R(V_ctrl) = R_off - (R_off - R_on) * 0.5 * (1 + tanh(k * (V_ctrl - V_th)))
 *
 * SPDT (Single-Pole Double-Throw):
 *   Pins: ctrl, com, no, nc
 *   COM-NO closes when V_ctrl > V_th (same tanh as SPST)
 *   COM-NC opens  when V_ctrl > V_th (inverted tanh — complementary)
 *
 * MNA stamp: conductance 1/R between signal terminals, updated every NR
 * iteration from the current V_ctrl operating point.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../editor/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement, AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Shared resistance computation
// ---------------------------------------------------------------------------

/**
 * Compute the switch resistance from the control voltage using a tanh
 * transition centred on V_th.
 *
 * @param vCtrl      - Control voltage (V)
 * @param vTh        - Threshold voltage (V)
 * @param rOn        - On-state resistance (Ω)
 * @param rOff       - Off-state resistance (Ω)
 * @param k          - Transition sharpness (1/V); larger values → sharper switch
 * @param invert     - When true, tanh argument is negated (complementary path)
 * @returns Resistance in ohms
 */
function switchResistance(
  vCtrl: number,
  vTh: number,
  rOn: number,
  rOff: number,
  k: number,
  invert: boolean,
): number {
  const arg = invert ? -k * (vCtrl - vTh) : k * (vCtrl - vTh);
  const tanhVal = Math.tanh(arg);
  return rOff - (rOff - rOn) * 0.5 * (1 + tanhVal);
}

// ---------------------------------------------------------------------------
// MNA stamp helpers (1-based node IDs, 0 = ground)
// ---------------------------------------------------------------------------

function stampConductance(
  solver: SparseSolver,
  nodeA: number,
  nodeB: number,
  g: number,
): void {
  if (nodeA > 0) solver.stamp(nodeA - 1, nodeA - 1, g);
  if (nodeB > 0) solver.stamp(nodeB - 1, nodeB - 1, g);
  if (nodeA > 0 && nodeB > 0) {
    solver.stamp(nodeA - 1, nodeB - 1, -g);
    solver.stamp(nodeB - 1, nodeA - 1, -g);
  }
}

// ---------------------------------------------------------------------------
// createSwitchSPSTElement — AnalogElement factory (SPST)
// ---------------------------------------------------------------------------

function createSwitchSPSTElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
): AnalogElementCore {
  const rOn  = Math.max(props.getOrDefault<number>("rOn",  10),   1e-6);
  const rOff = Math.max(props.getOrDefault<number>("rOff", 1e9),  rOn + 1);
  const vTh  = props.getOrDefault<number>("threshold", 1.65);
  const k    = Math.max(props.getOrDefault<number>("transitionSharpness", 20), 1e-6);

  const nIn   = pinNodes.get("in")!;   // signal in
  const nOut  = pinNodes.get("out")!;  // signal out
  const nCtrl = pinNodes.get("ctrl")!; // control terminal

  // Current operating-point resistance
  let currentR = rOff;

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // No linear (topology-constant) contributions — all in stampNonlinear.
    },

    stampNonlinear(solver: SparseSolver): void {
      const g = 1 / currentR;
      stampConductance(solver, nIn, nOut, g);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const vCtrl = readNode(voltages, nCtrl);
      currentR = switchResistance(vCtrl, vTh, rOn, rOff, k, false);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: in, out, ctrl.
      // Conductance 1/currentR stamped between in and out; ctrl has no stamp.
      const g = 1 / currentR;
      const vIn  = readNode(voltages, nIn);
      const vOut = readNode(voltages, nOut);
      const iThrough = g * (vIn - vOut);
      return [iThrough, -iThrough, 0];
    },
  };
}

// ---------------------------------------------------------------------------
// createSwitchSPDTElement — AnalogElement factory (SPDT)
// ---------------------------------------------------------------------------

function createSwitchSPDTElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
): AnalogElementCore {
  const rOn  = Math.max(props.getOrDefault<number>("rOn",  10),   1e-6);
  const rOff = Math.max(props.getOrDefault<number>("rOff", 1e9),  rOn + 1);
  const vTh  = props.getOrDefault<number>("threshold", 1.65);
  const k    = Math.max(props.getOrDefault<number>("transitionSharpness", 20), 1e-6);

  const nCom  = pinNodes.get("com")!;  // common terminal
  const nNO   = pinNodes.get("no")!;   // normally-open terminal
  const nNC   = pinNodes.get("nc")!;   // normally-closed terminal
  const nCtrl = pinNodes.get("ctrl")!; // control terminal

  let rNO = rOff; // COM-NO resistance (closes when V_ctrl > V_th)
  let rNC = rOn;  // COM-NC resistance (opens  when V_ctrl > V_th)

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // No linear contributions — all in stampNonlinear.
    },

    stampNonlinear(solver: SparseSolver): void {
      stampConductance(solver, nCom, nNO, 1 / rNO);
      stampConductance(solver, nCom, nNC, 1 / rNC);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const vCtrl = readNode(voltages, nCtrl);
      rNO = switchResistance(vCtrl, vTh, rOn, rOff, k, false);
      rNC = switchResistance(vCtrl, vTh, rOn, rOff, k, true);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: com, no, nc, ctrl.
      // Conductance 1/rNO between com/no, 1/rNC between com/nc; ctrl has no stamp.
      const vCom = readNode(voltages, nCom);
      const vNo  = readNode(voltages, nNO);
      const vNc  = readNode(voltages, nNC);
      const iNO = (1 / rNO) * (vCom - vNo);
      const iNC = (1 / rNC) * (vCom - vNc);
      return [iNO + iNC, -iNO, -iNC, 0];
    },
  };
}

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

function buildSPSTPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "ctrl",
      defaultBitWidth: 1,
      position: { x: 2, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

function buildSPDTPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "com",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "no",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "nc",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "ctrl",
      defaultBitWidth: 1,
      position: { x: 2, y: -1 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// CircuitElement classes
// ---------------------------------------------------------------------------

export class SwitchSPSTElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SwitchSPST", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSPSTPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 1 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vIn   = signals?.getPinVoltage("in");
    const vOut  = signals?.getPinVoltage("out");
    const vCtrl = signals?.getPinVoltage("ctrl");

    ctx.save();
    ctx.setLineWidth(1);

    // Blade — body, stays COMPONENT
    ctx.setColor("COMPONENT");
    ctx.drawLine(1, 0, 3, 0);

    // in lead
    if (vIn !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vIn));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, 1, 0);

    // out lead
    if (vOut !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vOut));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(3, 0, 4, 0);

    // ctrl lead
    if (vCtrl !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vCtrl));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(2, 1, 2, 0.5);

    ctx.restore();
  }

  getHelpText(): string {
    return "Analog Switch (SPST) — voltage-controlled variable resistance. " +
      "Transitions smoothly from R_off to R_on as control voltage crosses threshold.";
  }
}

export class SwitchSPDTElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SwitchSPDT", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSPDTPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1, width: 4, height: 2 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vCom  = signals?.getPinVoltage("com");
    const vNo   = signals?.getPinVoltage("no");
    const vNc   = signals?.getPinVoltage("nc");
    const vCtrl = signals?.getPinVoltage("ctrl");

    ctx.save();
    ctx.setLineWidth(1);

    // Blade — body, stays COMPONENT
    ctx.setColor("COMPONENT");
    ctx.drawLine(1, 0, 3, -1);

    // COM lead
    if (vCom !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vCom));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, 1, 0);

    // NO lead
    if (vNo !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vNo));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(3, -1, 4, -1);

    // NC lead
    if (vNc !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vNc));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(3, 1, 4, 1);

    ctx.restore();
  }

  getHelpText(): string {
    return "Analog Switch (SPDT) — voltage-controlled double-throw switch. " +
      "COM-NO closes and COM-NC opens as control voltage crosses threshold.";
  }
}

// ---------------------------------------------------------------------------
// Property definitions (shared)
// ---------------------------------------------------------------------------

const ANALOG_SWITCH_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "rOn",
    type: PropertyType.INT,
    label: "On resistance (Ω)",
    defaultValue: 10,
    min: 1e-6,
    description: "Resistance when fully on (V_ctrl >> V_th). Default 10 Ω.",
  },
  {
    key: "rOff",
    type: PropertyType.INT,
    label: "Off resistance (Ω)",
    defaultValue: 1e9,
    min: 1,
    description: "Resistance when fully off (V_ctrl << V_th). Default 1 GΩ.",
  },
  {
    key: "threshold",
    type: PropertyType.INT,
    label: "Threshold voltage (V)",
    defaultValue: 1.65,
    description: "Control voltage at midpoint of transition. Default 1.65 V (VDD/2 for 3.3 V CMOS).",
  },
  {
    key: "transitionSharpness",
    type: PropertyType.INT,
    label: "Transition sharpness (1/V)",
    defaultValue: 20,
    min: 1e-6,
    description: "Controls how sharply resistance transitions. Default 20 V⁻¹ (~0.2 V transition range).",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label.",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings (shared)
// ---------------------------------------------------------------------------

const ANALOG_SWITCH_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "rOn",                 propertyKey: "rOn",                 convert: (v) => parseFloat(v) },
  { xmlName: "rOff",                propertyKey: "rOff",                convert: (v) => parseFloat(v) },
  { xmlName: "threshold",           propertyKey: "threshold",           convert: (v) => parseFloat(v) },
  { xmlName: "transitionSharpness", propertyKey: "transitionSharpness", convert: (v) => parseFloat(v) },
  { xmlName: "Label",               propertyKey: "label",               convert: (v) => v },
];

// ---------------------------------------------------------------------------
// ComponentDefinitions
// ---------------------------------------------------------------------------

export const SwitchSPSTDefinition: ComponentDefinition = {
  name: "SwitchSPST",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildSPSTPinDeclarations(),
  propertyDefs: ANALOG_SWITCH_PROPERTY_DEFS,
  attributeMap: ANALOG_SWITCH_ATTRIBUTE_MAPPINGS,

  helpText:
    "Analog Switch (SPST) — three-terminal (ctrl, in, out). " +
    "Voltage-controlled resistance using tanh transition for NR-friendly behavior.",

  factory(props: PropertyBag): SwitchSPSTElement {
    return new SwitchSPSTElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {
    analog: {
      factory(
        pinNodes: ReadonlyMap<string, number>,
        _internalNodeIds: readonly number[],
        _branchIdx: number,
        props: PropertyBag,
      ): AnalogElementCore {
        return createSwitchSPSTElement(pinNodes, props);
      },
    },
  },
};

export const SwitchSPDTDefinition: ComponentDefinition = {
  name: "SwitchSPDT",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildSPDTPinDeclarations(),
  propertyDefs: ANALOG_SWITCH_PROPERTY_DEFS,
  attributeMap: ANALOG_SWITCH_ATTRIBUTE_MAPPINGS,

  helpText:
    "Analog Switch (SPDT) — four-terminal (ctrl, com, no, nc). " +
    "COM-NO closes and COM-NC opens as control voltage rises through threshold.",

  factory(props: PropertyBag): SwitchSPDTElement {
    return new SwitchSPDTElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {
    analog: {
      factory(
        pinNodes: ReadonlyMap<string, number>,
        _internalNodeIds: readonly number[],
        _branchIdx: number,
        props: PropertyBag,
      ): AnalogElementCore {
        return createSwitchSPDTElement(pinNodes, props);
      },
    },
  },
};
