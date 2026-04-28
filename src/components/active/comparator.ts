/**
 * Analog Comparator component.
 *
 * Similar to an op-amp but optimized for switching speed: no linear region,
 * open-collector or push-pull output, optional input hysteresis (Schmitt
 * window), and an input offset voltage (vos).
 *
 * Open-collector model (default):
 *   - Output active (sinking):  R_sat to ground   output pulled LOW
 *   - Output inactive (off):    R_off to ground   output pulled HIGH by
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
import type { LoadContext, StatePoolRef, PoolBackedAnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { collectPinModelChildren } from "../../solver/analog/digital-pin-model.js";
import type { AnalogCapacitorElement } from "../passives/capacitor.js";
import { defineModelParams } from "../../core/model-params.js";
import { applyInitialValues, defineStateSchema } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";

const SLOT_OUTPUT_LATCH = 0;
const SLOT_OUTPUT_WEIGHT = 1;

const COMPARATOR_COMPOSITE_SCHEMA: StateSchema = defineStateSchema("ComparatorComposite", [
  { name: "OUTPUT_LATCH",  doc: "Hysteresis latch (1.0 = output active/sinking, 0.0 = inactive)", init: { kind: "zero" } },
  { name: "OUTPUT_WEIGHT", doc: "Response-time blend weight [0.0, 1.0]",                          init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: COMPARATOR_PARAM_DEFS, defaults: COMPARATOR_DEFAULTS } = defineModelParams({
  primary: {
    hysteresis:   { default: 0,    unit: "V", description: "Hysteresis band width" },
    vos:          { default: 0.001, unit: "V", description: "Input offset voltage" },
    rSat:         { default: 50,   unit: "Î", description: "Output saturation resistance" },
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
// ComparatorElement  CircuitElement implementation
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

    // Triangle body  stays COMPONENT color, thin line
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

    // Text labels  body decoration, stays COMPONENT color
    ctx.setLineWidth(1);
    ctx.setColor("COMPONENT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText("-", 1.0, -1.125, { horizontal: "center", vertical: "middle" });
    ctx.drawText("+", 1.0, 1.0, { horizontal: "center", vertical: "middle" });
    ctx.drawText("â‰¥?", 2.0, 0.0, { horizontal: "center", vertical: "middle" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// createComparatorElement  AnalogElement factory
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
  _getTime: () => number,
): PoolBackedAnalogElement {
  const p: Record<string, number> = {
    hysteresis:   Math.max(props.getModelParam<number>("hysteresis"),   0),
    vos:          props.getModelParam<number>("vos"),
    rSat:         Math.max(props.getModelParam<number>("rSat"),   1e-9),
    responseTime: Math.max(props.getModelParam<number>("responseTime"), 1e-12),
  };

  const R_OFF = 1e9; // open-collector off-state impedance (1 GÎ)
  const G_off = 1 / R_OFF;

  // G_sat is computed from p.rSat at call time to support setParam hot-loading

  const nInp = pinNodes.get("in+")!; // non-inverting input node (1-based)
  const nInn = pinNodes.get("in-")!; // inverting input node (1-based)
  const nOut = pinNodes.get("out")!; // output node (1-based)

  let pool: StatePoolRef;
  let base: number;

  function readNode(rhs: Float64Array, n: number): number {
    return rhs[n];
  }

  function computeGeff(weight: number): number {
    const G_sat = 1 / Math.max(p.rSat, 1e-9);
    return G_off + weight * (G_sat - G_off);
  }

  const childElements: readonly AnalogCapacitorElement[] = collectPinModelChildren([]);
  const childStateSize = childElements.reduce((s, c) => s + c.stateSize, 0);

  // Cached TSTALLOC handle for output node diagonal (nOut, nOut).
  let hOutDiag = -1;

  const el: PoolBackedAnalogElement = {
    label: "",
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    _stateBase: -1,
    _pinNodes: new Map(pinNodes),

    setup(ctx: SetupContext): void {
      // Allocate output diagonal handle (open-collector conductance stamp).
      if (nOut > 0) {
        hOutDiag = ctx.solver.allocElement(nOut, nOut);
      }
      // Allocate state slots for hysteresis latch + response-time weight.
      el._stateBase = ctx.allocStates(COMPARATOR_COMPOSITE_SCHEMA.size);
      // Child elements (capacitor companions) own their own state slots.
      for (const child of childElements) {
        child.setup(ctx);
      }
    },

    poolBacked: true as const,
    stateSchema: COMPARATOR_COMPOSITE_SCHEMA,
    stateSize: COMPARATOR_COMPOSITE_SCHEMA.size + childStateSize,
    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      base = el._stateBase;
      applyInitialValues(COMPARATOR_COMPOSITE_SCHEMA, pool, base, {});
      let offset = base + COMPARATOR_COMPOSITE_SCHEMA.size;
      for (const child of childElements) {
        child._stateBase = offset;
        child.initState(pool);
        offset += child.stateSize;
      }
    },

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const voltages = ctx.rhsOld;
      const s0 = pool.states[0];
      const s1 = pool.states[1];

      // Read latch/weight from the last accepted step. s1 is untouched by
      // failed NR iterations, so hysteresis state is restored correctly on retry.
      let latchActive = s1[base + SLOT_OUTPUT_LATCH] >= 0.5;
      let weight = s1[base + SLOT_OUTPUT_WEIGHT];

      const vInp = readNode(voltages, nInp);
      const vInn = readNode(voltages, nInn);
      const vDiff = vInp - vInn - p.vos;
      const halfHyst = p.hysteresis / 2;
      if (latchActive) {
        if (vDiff < -halfHyst) {
          latchActive = false;
          weight = 0.0;
        }
      } else {
        if (vDiff > halfHyst) {
          latchActive = true;
          weight = 1.0;
        }
      }

      s0[base + SLOT_OUTPUT_LATCH] = latchActive ? 1.0 : 0.0;
      s0[base + SLOT_OUTPUT_WEIGHT] = weight;

      if (nOut > 0 && hOutDiag >= 0) {
        solver.stampElement(hOutDiag, computeGeff(weight));
      }

      for (const child of childElements) { child.load(ctx); }
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      const dt = ctx.dt;
      if (dt <= 0) return;
      const s0 = pool.states[0];
      const latchActive = s0[base + SLOT_OUTPUT_LATCH] >= 0.5;
      const target = latchActive ? 1.0 : 0.0;
      const tau = Math.max(p.responseTime, 1e-12);
      const alpha = dt / (tau + dt);
      const currentWeight = s0[base + SLOT_OUTPUT_WEIGHT];
      s0[base + SLOT_OUTPUT_WEIGHT] = currentWeight + alpha * (target - currentWeight);
    },

    getPinCurrents(rhs: Float64Array): number[] {
      // Input pins: high-impedance load  implicit R_IN to ground
      const R_IN = 1e7;
      const vInp = readNode(rhs, nInp);
      const vInn = readNode(rhs, nInn);
      const iInp = nInp > 0 ? vInp / R_IN : 0;
      const iInn = nInn > 0 ? vInn / R_IN : 0;

      // Output pin: I_out = V_out * G_eff (current sinks to ground)
      const weight = pool.states[0][base + SLOT_OUTPUT_WEIGHT];
      const vOut = readNode(rhs, nOut);
      const gEff = computeGeff(weight);
      const iOut = nOut > 0 ? vOut * gEff : 0;

      return [iInp, iInn, iOut];
    },

    setParam(key: string, value: number): void {
      if (key in p) (p as Record<string, number>)[key] = value;
    },
  };

  return el;
}

// ---------------------------------------------------------------------------
// createPushPullComparatorElement  push-pull output factory
// ---------------------------------------------------------------------------

function createPushPullComparatorElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): PoolBackedAnalogElement {
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

  let pool: StatePoolRef;
  let base: number;

  function readNode(rhs: Float64Array, n: number): number {
    return rhs[n];
  }

  function computeGeff(weight: number): number {
    const G_sat = 1 / Math.max(p.rSat, 1e-9);
    return G_off + weight * (G_sat - G_off);
  }

  const childElements: readonly AnalogCapacitorElement[] = collectPinModelChildren([]);
  const childStateSize = childElements.reduce((s, c) => s + c.stateSize, 0);

  // Cached TSTALLOC handle for output node diagonal (nOut, nOut).
  let hOutDiagPP = -1;

  const elPP: PoolBackedAnalogElement = {
    label: "",
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    _stateBase: -1,
    _pinNodes: new Map(pinNodes),

    setup(ctx: SetupContext): void {
      if (nOut > 0) {
        hOutDiagPP = ctx.solver.allocElement(nOut, nOut);
      }
      elPP._stateBase = ctx.allocStates(COMPARATOR_COMPOSITE_SCHEMA.size);
      for (const child of childElements) {
        child.setup(ctx);
      }
    },

    poolBacked: true as const,
    stateSchema: COMPARATOR_COMPOSITE_SCHEMA,
    stateSize: COMPARATOR_COMPOSITE_SCHEMA.size + childStateSize,
    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      base = elPP._stateBase;
      applyInitialValues(COMPARATOR_COMPOSITE_SCHEMA, pool, base, {});
      let offset = base + COMPARATOR_COMPOSITE_SCHEMA.size;
      for (const child of childElements) {
        child._stateBase = offset;
        child.initState(pool);
        offset += child.stateSize;
      }
    },

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const voltages = ctx.rhsOld;
      const s0 = pool.states[0];
      const s1 = pool.states[1];

      // Read latch/weight from the last accepted step. s1 is untouched by
      // failed NR iterations, so hysteresis state is restored correctly on retry.
      let latchActive = s1[base + SLOT_OUTPUT_LATCH] >= 0.5;
      let weight = s1[base + SLOT_OUTPUT_WEIGHT];

      const vInp = readNode(voltages, nInp);
      const vInn = readNode(voltages, nInn);
      const vDiff = vInp - vInn - p.vos;
      const halfHyst = p.hysteresis / 2;
      if (latchActive) {
        if (vDiff < -halfHyst) { latchActive = false; weight = 0.0; }
      } else {
        if (vDiff > halfHyst) { latchActive = true; weight = 1.0; }
      }

      s0[base + SLOT_OUTPUT_LATCH] = latchActive ? 1.0 : 0.0;
      s0[base + SLOT_OUTPUT_WEIGHT] = weight;

      const gEff = computeGeff(weight);
      if (nOut > 0 && hOutDiagPP >= 0) {
        solver.stampElement(hOutDiagPP, gEff);
        // Norton current source drives output toward vOH or vOL
        const vTarget = latchActive ? p.vOL : p.vOH;
        stampRHS(ctx.rhs, nOut, vTarget * gEff);
      }

      for (const child of childElements) { child.load(ctx); }
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      const dt = ctx.dt;
      if (dt <= 0) return;
      const s0 = pool.states[0];
      const latchActive = s0[base + SLOT_OUTPUT_LATCH] >= 0.5;
      const target = latchActive ? 1.0 : 0.0;
      const tau = Math.max(p.responseTime, 1e-12);
      const alpha = dt / (tau + dt);
      const currentWeight = s0[base + SLOT_OUTPUT_WEIGHT];
      s0[base + SLOT_OUTPUT_WEIGHT] = currentWeight + alpha * (target - currentWeight);
    },

    getPinCurrents(rhs: Float64Array): number[] {
      const R_IN = 1e7;
      const vInp = readNode(rhs, nInp);
      const vInn = readNode(rhs, nInn);
      const iInp = nInp > 0 ? vInp / R_IN : 0;
      const iInn = nInn > 0 ? vInn / R_IN : 0;

      const s0 = pool.states[0];
      const latchActive = s0[base + SLOT_OUTPUT_LATCH] >= 0.5;
      const weight = s0[base + SLOT_OUTPUT_WEIGHT];
      const vOut = readNode(rhs, nOut);
      const gEff = computeGeff(weight);
      let iOut = 0;
      if (nOut > 0) {
        const vTarget = latchActive ? p.vOL : p.vOH;
        iOut = (vOut - vTarget) * gEff;
      }
      return [iInp, iInn, iOut];
    },

    setParam(key: string, value: number): void {
      if (key in p) (p as Record<string, number>)[key] = value;
    },
  };

  return elPP;
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
    "Analog Comparator  3-terminal (in+, in-, out). " +
    "Switches output based on V+ vs V-. Open-collector output requires external pull-up. " +
    "Optional hysteresis prevents output chatter on noisy inputs.",

  factory(props: PropertyBag): ComparatorElement {
    return new ComparatorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "open-collector": {
      kind: "inline",
      factory: (pinNodes, props, getTime) =>
        createOpenCollectorComparatorElement(pinNodes, props, getTime),
      paramDefs: COMPARATOR_PARAM_DEFS,
      params: COMPARATOR_DEFAULTS,
    },
    "push-pull": {
      kind: "inline",
      factory: (pinNodes, props, getTime) =>
        createPushPullComparatorElement(pinNodes, props, getTime),
      paramDefs: COMPARATOR_PARAM_DEFS,
      params: COMPARATOR_DEFAULTS,
    },
  },
  defaultModel: "open-collector",
};
