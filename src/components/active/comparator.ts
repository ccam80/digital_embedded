/**
 * Analog Comparator component.
 *
 * Similar to an op-amp but optimized for switching speed: no linear region,
 * open-collector or push-pull output, optional input hysteresis (Schmitt
 * window), and an input offset voltage (vos).
 *
 * Open-collector model (default):
 *   - Output active (sinking):  R_sat to ground  → output pulled LOW
 *   - Output inactive (off):    R_off to ground  → output pulled HIGH by
 *                                                   external resistor
 *
 * Push-pull model:
 *   - Stamps a Norton current source driving the output to V_OH or V_OL
 *     through R_out (same model as DigitalOutputPinModel, but simpler).
 *
 * Hysteresis:
 *   - Two thresholds derived from the reference voltage and hysteresis band:
 *       V_TH = V_ref + vos + hysteresis/2   (trip on rising V+)
 *       V_TL = V_ref + vos - hysteresis/2   (trip on falling V+)
 *   - State is held until the input crosses the opposite threshold.
 *
 * Response time is modelled as a single-pole RC filter on the internal
 * _outputHigh state: the effective output conductance ramps between the
 * saturated and off values with time constant responseTime.
 *
 * Node assignment:
 *   nodeIds[0] = V+ (non-inverting input)
 *   nodeIds[1] = V- (inverting input / reference)
 *   nodeIds[2] = out (output)
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
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: COMPARATOR_PARAM_DEFS, defaults: COMPARATOR_DEFAULTS } = defineModelParams({
  primary: {
    hysteresis:   { default: 0,    unit: "V", description: "Hysteresis band width" },
    vos:          { default: 0.001, unit: "V", description: "Input offset voltage" },
    rSat:         { default: 50,   unit: "Ω", description: "Output saturation resistance" },
    responseTime: { default: 1e-6, unit: "s", description: "Propagation delay time constant" },
    vOH:          { default: 3.3,  unit: "V", description: "Output HIGH voltage" },
    vOL:          { default: 0.0,  unit: "V", description: "Output LOW voltage" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildComparatorPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in+",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "in-",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
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
  ];
}

// ---------------------------------------------------------------------------
// ComparatorElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ComparatorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("VoltageComparator", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildComparatorPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 4,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vInp = signals?.getPinVoltage("in+");
    const vInn = signals?.getPinVoltage("in-");
    const vOut = signals?.getPinVoltage("out");

    ctx.save();

    // Triangle body — stays COMPONENT color, thin line
    ctx.setLineWidth(1);
    ctx.setColor("COMPONENT");
    ctx.drawPolygon(
      [{ x: 0.375, y: -2 }, { x: 0.375, y: 2 }, { x: 3.625, y: 0 }],
      false,
    );

    // Input lead in+ (thick)
    ctx.setLineWidth(3);
    drawColoredLead(ctx, signals, vInp, 0, -1, 0.375, -1);

    // Input lead in- (thick)
    drawColoredLead(ctx, signals, vInn, 0, 1, 0.375, 1);

    // Output lead (thick)
    drawColoredLead(ctx, signals, vOut, 3.625, 0, 4, 0);

    // Text labels — body decoration, stays COMPONENT color
    ctx.setLineWidth(1);
    ctx.setColor("COMPONENT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText("-", 1.0, -1.125, { horizontal: "center", vertical: "middle" });
    ctx.drawText("+", 1.0, 1.0, { horizontal: "center", vertical: "middle" });
    ctx.drawText("≥?", 2.0, 0.0, { horizontal: "center", vertical: "middle" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// createComparatorElement — AnalogElement factory
// ---------------------------------------------------------------------------

/**
 * Create the MNA analog element for a comparator.
 *
 * Open-collector output model:
 *   When active (output sinks current): stamp G_sat = 1/rSat between out and ground.
 *   When inactive (output off):         stamp G_off = 1/R_OFF between out and ground.
 *
 * Push-pull output model:
 *   Norton equivalent: G_out = 1/rSat; I_norton = V_target * G_out at out node.
 *
 * The response time is implemented by tracking a continuous _outputWeight in
 * [0.0, 1.0] that blends between the inactive and active conductance values.
 * At each timestep the weight moves toward its target at rate 1/responseTime.
 *
 * Node IDs are 1-based; solver rows/cols are 0-based (nodeId - 1).
 */
export function createOpenCollectorComparatorElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
): AnalogElementCore {
  const p: Record<string, number> = {
    hysteresis:   Math.max(props.getModelParam<number>("hysteresis"),   0),
    vos:          props.getModelParam<number>("vos"),
    rSat:         Math.max(props.getModelParam<number>("rSat"),   1e-9),
    responseTime: Math.max(props.getModelParam<number>("responseTime"), 1e-12),
  };

  const R_OFF = 1e9; // open-collector off-state impedance (1 GΩ)
  const G_off = 1 / R_OFF;

  // G_sat is computed from p.rSat at call time to support setParam hot-loading

  const nInp = pinNodes.get("in+")!; // non-inverting input node (1-based)
  const nInn = pinNodes.get("in-")!; // inverting input node (1-based)
  const nOut = pinNodes.get("out")!; // output node (1-based)

  // Hysteresis state: true when output is active (open-collector sinking)
  let _outputActive = false;

  // Continuous blend weight: 0.0 = fully inactive, 1.0 = fully active
  // Used to model response-time delay via a first-order filter.
  let _outputWeight = 0.0;

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  function computeGeff(): number {
    const G_sat = 1 / Math.max(p.rSat, 1e-9);
    return G_off + _outputWeight * (G_sat - G_off);
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const voltages = ctx.rhsOld;

      // Hysteresis state update from current NR-iterate voltages.
      const vInp = readNode(voltages, nInp);
      const vInn = readNode(voltages, nInn);
      const vDiff = vInp - vInn - p.vos;
      const halfHyst = p.hysteresis / 2;
      if (_outputActive) {
        if (vDiff < -halfHyst) {
          _outputActive = false;
          _outputWeight = 0.0;
        }
      } else {
        if (vDiff > halfHyst) {
          _outputActive = true;
          _outputWeight = 1.0;
        }
      }

      // Stamp the effective conductance from out to ground.
      if (nOut > 0) {
        solver.stampElement(solver.allocElement(nOut - 1, nOut - 1), computeGeff());
      }
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      // Update _outputWeight toward its target using a first-order Euler step.
      // Models the propagation delay specified by responseTime. Called once
      // per accepted timestep.
      const dt = ctx.dt;
      if (dt <= 0) return;
      const target = _outputActive ? 1.0 : 0.0;
      const tau = Math.max(p.responseTime, 1e-12);
      const alpha = dt / (tau + dt);
      _outputWeight = _outputWeight + alpha * (target - _outputWeight);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Input pins: high-impedance load — implicit R_IN to ground
      const R_IN = 1e7;
      const vInp = readNode(voltages, nInp);
      const vInn = readNode(voltages, nInn);
      const iInp = nInp > 0 ? vInp / R_IN : 0;
      const iInn = nInn > 0 ? vInn / R_IN : 0;

      // Output pin: I_out = V_out * G_eff (current sinks to ground)
      const vOut = readNode(voltages, nOut);
      const gEff = computeGeff();
      const iOut = nOut > 0 ? vOut * gEff : 0;

      return [iInp, iInn, iOut];
    },

    setParam(key: string, value: number): void {
      if (key in p) (p as Record<string, number>)[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------
// createPushPullComparatorElement — push-pull output factory
// ---------------------------------------------------------------------------

function createPushPullComparatorElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
): AnalogElementCore {
  const p: Record<string, number> = {
    hysteresis:   Math.max(props.getModelParam<number>("hysteresis"),   0),
    vos:          props.getModelParam<number>("vos"),
    rSat:         Math.max(props.getModelParam<number>("rSat"),   1e-9),
    responseTime: Math.max(props.getModelParam<number>("responseTime"), 1e-12),
    vOH:          props.getModelParam<number>("vOH"),
    vOL:          props.getModelParam<number>("vOL"),
  };

  const R_OFF = 1e9;
  const G_off = 1 / R_OFF;

  const nInp = pinNodes.get("in+")!;
  const nInn = pinNodes.get("in-")!;
  const nOut = pinNodes.get("out")!;

  let _outputActive = false;
  let _outputWeight = 0.0;

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  function computeGeff(): number {
    const G_sat = 1 / Math.max(p.rSat, 1e-9);
    return G_off + _outputWeight * (G_sat - G_off);
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const voltages = ctx.rhsOld;

      const vInp = readNode(voltages, nInp);
      const vInn = readNode(voltages, nInn);
      const vDiff = vInp - vInn - p.vos;
      const halfHyst = p.hysteresis / 2;
      if (_outputActive) {
        if (vDiff < -halfHyst) { _outputActive = false; _outputWeight = 0.0; }
      } else {
        if (vDiff > halfHyst) { _outputActive = true; _outputWeight = 1.0; }
      }

      const gEff = computeGeff();
      if (nOut > 0) {
        solver.stampElement(solver.allocElement(nOut - 1, nOut - 1), gEff);
        // Norton current source drives output toward vOH or vOL
        const vTarget = _outputActive ? p.vOL : p.vOH;
        solver.stampRHS(nOut - 1, vTarget * gEff);
      }
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      const dt = ctx.dt;
      if (dt <= 0) return;
      const target = _outputActive ? 1.0 : 0.0;
      const tau = Math.max(p.responseTime, 1e-12);
      const alpha = dt / (tau + dt);
      _outputWeight = _outputWeight + alpha * (target - _outputWeight);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      const R_IN = 1e7;
      const vInp = readNode(voltages, nInp);
      const vInn = readNode(voltages, nInn);
      const iInp = nInp > 0 ? vInp / R_IN : 0;
      const iInn = nInn > 0 ? vInn / R_IN : 0;

      const vOut = readNode(voltages, nOut);
      const gEff = computeGeff();
      let iOut = 0;
      if (nOut > 0) {
        const vTarget = _outputActive ? p.vOL : p.vOH;
        iOut = (vOut - vTarget) * gEff;
      }
      return [iInp, iInn, iOut];
    },

    setParam(key: string, value: number): void {
      if (key in p) (p as Record<string, number>)[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const COMPARATOR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label.",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

const COMPARATOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "hysteresis",   propertyKey: "hysteresis",   convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vos",          propertyKey: "vos",          convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rSat",         propertyKey: "rSat",         convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "outputType",   propertyKey: "model",         convert: (v) => v },
  { xmlName: "responseTime", propertyKey: "responseTime", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",        propertyKey: "label",        convert: (v) => v },
];

// ---------------------------------------------------------------------------
// AnalogComparatorDefinition
// ---------------------------------------------------------------------------

export const VoltageComparatorDefinition: ComponentDefinition = {
  name: "VoltageComparator",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildComparatorPinDeclarations(),
  propertyDefs: COMPARATOR_PROPERTY_DEFS,
  attributeMap: COMPARATOR_ATTRIBUTE_MAPPINGS,

  helpText:
    "Analog Comparator — 3-terminal (in+, in-, out). " +
    "Switches output based on V+ vs V-. Open-collector output requires external pull-up. " +
    "Optional hysteresis prevents output chatter on noisy inputs.",

  factory(props: PropertyBag): ComparatorElement {
    return new ComparatorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "open-collector": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, _branchIdx, props) =>
        createOpenCollectorComparatorElement(pinNodes, props),
      paramDefs: COMPARATOR_PARAM_DEFS,
      params: COMPARATOR_DEFAULTS,
    },
    "push-pull": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, _branchIdx, props) =>
        createPushPullComparatorElement(pinNodes, props),
      paramDefs: COMPARATOR_PARAM_DEFS,
      params: COMPARATOR_DEFAULTS,
    },
  },
  defaultModel: "open-collector",
};
