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
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: ANALOG_SWITCH_PARAM_DEFS, defaults: ANALOG_SWITCH_DEFAULTS } = defineModelParams({
  primary: {
    rOn:                { default: 10,  unit: "Ω",   description: "On-state resistance" },
    rOff:               { default: 1e9, unit: "Ω",   description: "Off-state resistance" },
    threshold:          { default: 1.65, unit: "V",  description: "Control voltage threshold" },
    transitionSharpness:{ default: 20,  unit: "1/V", description: "Transition sharpness" },
  },
});

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
  if (nodeA > 0) solver.stampElement(solver.allocElement(nodeA - 1, nodeA - 1), g);
  if (nodeB > 0) solver.stampElement(solver.allocElement(nodeB - 1, nodeB - 1), g);
  if (nodeA > 0 && nodeB > 0) {
    solver.stampElement(solver.allocElement(nodeA - 1, nodeB - 1), -g);
    solver.stampElement(solver.allocElement(nodeB - 1, nodeA - 1), -g);
  }
}

// ---------------------------------------------------------------------------
// createSwitchSPSTElement — AnalogElement factory (SPST)
// ---------------------------------------------------------------------------

function createSwitchSPSTElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
): AnalogElementCore {
  const p: Record<string, number> = {
    rOn:                Math.max(props.getModelParam<number>("rOn"),  1e-6),
    rOff:               Math.max(props.getModelParam<number>("rOff"), 1e-6),
    threshold:          props.getModelParam<number>("threshold"),
    transitionSharpness:Math.max(props.getModelParam<number>("transitionSharpness"), 1e-6),
  };

  const nIn   = pinNodes.get("in")!;   // signal in
  const nOut  = pinNodes.get("out")!;  // signal out
  const nCtrl = pinNodes.get("ctrl")!; // control terminal

  // Current operating-point resistance
  let currentR = p.rOff;

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;
      const vCtrl = readNode(voltages, nCtrl);
      currentR = switchResistance(
        vCtrl,
        p.threshold,
        Math.max(p.rOn, 1e-6),
        Math.max(p.rOff, p.rOn + 1),
        p.transitionSharpness,
        false,
      );
      const g = 1 / currentR;
      stampConductance(ctx.solver, nIn, nOut, g);
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

    setParam(key: string, value: number): void {
      if (key in p) (p as Record<string, number>)[key] = value;
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
  const p: Record<string, number> = {
    rOn:                Math.max(props.getModelParam<number>("rOn"),  1e-6),
    rOff:               Math.max(props.getModelParam<number>("rOff"), 1e-6),
    threshold:          props.getModelParam<number>("threshold"),
    transitionSharpness:Math.max(props.getModelParam<number>("transitionSharpness"), 1e-6),
  };

  const nCom  = pinNodes.get("com")!;  // common terminal
  const nNO   = pinNodes.get("no")!;   // normally-open terminal
  const nNC   = pinNodes.get("nc")!;   // normally-closed terminal
  const nCtrl = pinNodes.get("ctrl")!; // control terminal

  let rNO = p.rOff; // COM-NO resistance (closes when V_ctrl > V_th)
  let rNC = p.rOn;  // COM-NC resistance (opens  when V_ctrl > V_th)

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;
      const solver = ctx.solver;
      const vCtrl = readNode(voltages, nCtrl);
      const rOnNow  = Math.max(p.rOn, 1e-6);
      const rOffNow = Math.max(p.rOff, rOnNow + 1);
      rNO = switchResistance(vCtrl, p.threshold, rOnNow, rOffNow, p.transitionSharpness, false);
      rNC = switchResistance(vCtrl, p.threshold, rOnNow, rOffNow, p.transitionSharpness, true);
      stampConductance(solver, nCom, nNO, 1 / rNO);
      stampConductance(solver, nCom, nNC, 1 / rNC);
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

    setParam(key: string, value: number): void {
      if (key in p) (p as Record<string, number>)[key] = value;
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
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "ctrl",
      defaultBitWidth: 1,
      position: { x: 2, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
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
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "no",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "nc",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "ctrl",
      defaultBitWidth: 1,
      position: { x: 2, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
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
    drawColoredLead(ctx, signals, vIn, 0, 0, 1, 0);

    // out lead
    drawColoredLead(ctx, signals, vOut, 3, 0, 4, 0);

    // ctrl lead
    drawColoredLead(ctx, signals, vCtrl, 2, 1, 2, 0.5);

    ctx.restore();
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

    ctx.save();
    ctx.setLineWidth(1);

    // Blade — body, stays COMPONENT
    ctx.setColor("COMPONENT");
    ctx.drawLine(1, 0, 3, -1);

    // COM lead
    drawColoredLead(ctx, signals, vCom, 0, 0, 1, 0);

    // NO lead
    drawColoredLead(ctx, signals, vNo, 3, -1, 4, -1);

    // NC lead
    drawColoredLead(ctx, signals, vNc, 3, 1, 4, 1);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions (shared)
// ---------------------------------------------------------------------------

const ANALOG_SWITCH_PROPERTY_DEFS: PropertyDefinition[] = [
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
  { xmlName: "rOn",                 propertyKey: "rOn",                 convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rOff",                propertyKey: "rOff",                convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "threshold",           propertyKey: "threshold",           convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "transitionSharpness", propertyKey: "transitionSharpness", convert: (v) => parseFloat(v), modelParam: true },
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

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, _branchIdx, props) =>
        createSwitchSPSTElement(pinNodes, props),
      paramDefs: ANALOG_SWITCH_PARAM_DEFS,
      params: ANALOG_SWITCH_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
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

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, _branchIdx, props) =>
        createSwitchSPDTElement(pinNodes, props),
      paramDefs: ANALOG_SWITCH_PARAM_DEFS,
      params: ANALOG_SWITCH_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
