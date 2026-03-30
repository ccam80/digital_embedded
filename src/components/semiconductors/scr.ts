/**
 * SCR (Silicon Controlled Rectifier) analog component.
 *
 * Implements a thyristor using the two-transistor alpha-dependent model.
 * The device blocks forward and reverse conduction until triggered by
 * gate current, at which point it latches into a low-resistance on-state.
 *
 * Model summary:
 *   - Forward blocking: I = IS * (exp(V_AK/(N*VT)) - 1) / (1 - α₁ - α₂)
 *     (amplified leakage — small current, both alphas clamped ≤ 0.95)
 *   - Forward conduction (latched): diode in series with R_on, clamping V_AK ≈ V_on
 *   - Reverse blocking: standard reverse-biased diode leakage
 *   - Triggering: when α₁ + α₂ > 0.95
 *   - Unlatching: when I_AK < I_hold
 *   - Breakover: when V_AK > V_breakover (triggers without gate)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Thermal voltage at 300 K (kT/q in volts). */
const VT = 0.02585;

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

/** Maximum alpha value — prevents division-by-zero in blocking formula. */
const ALPHA_MAX = 0.95;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: SCR_PARAM_DEFS, defaults: SCR_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    vOn:        { default: 1.5,   unit: "V", description: "On-state forward voltage drop" },
    iH:         { default: 5e-3,  unit: "A", description: "Holding current — minimum anode current to stay on" },
    rOn:        { default: 0.01,  unit: "Ω", description: "On-state series resistance" },
    vBreakover: { default: 100,   unit: "V", description: "Forward breakover voltage (triggers without gate)" },
  },
  secondary: {
    iS:      { default: 1e-12, unit: "A", description: "Reverse saturation current" },
    alpha1:  { default: 0.5,              description: "PNP transistor current gain (fixed)" },
    alpha2_0:{ default: 0.3,              description: "NPN off-state current gain" },
    i_ref:   { default: 1e-3,  unit: "A", description: "Gate current scale factor for α₂ modulation" },
    n:       { default: 1,                description: "Emission coefficient" },
  },
});

// ---------------------------------------------------------------------------
// Stamp helpers — node 0 is ground (skipped)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// createScrElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createScrElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const nodeA = pinNodes.get("A")!; // anode
  const nodeK = pinNodes.get("K")!; // cathode
  const nodeG = pinNodes.get("G")!; // gate

  const p = {
    vOn:        props.getModelParam<number>("vOn"),
    iH:         props.getModelParam<number>("iH"),
    rOn:        props.getModelParam<number>("rOn"),
    vBreakover: props.getModelParam<number>("vBreakover"),
    iS:         props.getModelParam<number>("iS"),
    alpha1:     props.getModelParam<number>("alpha1"),
    alpha2_0:   props.getModelParam<number>("alpha2_0"),
    i_ref:      props.getModelParam<number>("i_ref"),
    n:          props.getModelParam<number>("n"),
  };

  let nVt = p.n * VT;
  let vcrit = nVt * Math.log(nVt / (p.iS * Math.SQRT2));

  // Internal state
  let _latched = false;
  let _vak = 0;
  let _vgk = 0;
  let _geq = GMIN;
  let _ieq = 0;
  // Gate conductance stamp values
  let _gGateGeq = GMIN;
  let _gGateIeq = 0;

  let vcritGate = nVt * Math.log(nVt / (p.iS * Math.SQRT2));

  function recomputeDerivedConstants(): void {
    nVt = p.n * VT;
    vcrit = nVt * Math.log(nVt / (p.iS * Math.SQRT2));
    vcritGate = nVt * Math.log(nVt / (p.iS * Math.SQRT2));
  }

  function computeAlpha2(iGate: number): number {
    const raw = 1 - (1 - p.alpha2_0) * Math.exp(-Math.abs(iGate) / p.i_ref);
    return Math.min(raw, ALPHA_MAX);
  }

  function computeOperatingPoint(vak: number, vgk: number): void {
    // Gate current through a small forward-biased junction (simplified model)
    const iGate = p.iS * (Math.exp(Math.min(vgk / nVt, 700)) - 1) + GMIN * vgk;

    const a2 = computeAlpha2(iGate);
    const a1clamped = Math.min(p.alpha1, ALPHA_MAX);
    const a2clamped = Math.min(a2, ALPHA_MAX);
    const alphaSum = a1clamped + a2clamped;

    // Check triggering: alpha sum > 0.95
    if (!_latched && alphaSum > 0.95) {
      _latched = true;
    }

    if (_latched) {
      // On-state: model as diode (V_on forward voltage) in series with R_on
      // Effective: V_AK = V_on + I_AK * R_on
      // Linearize: conductance = 1/R_on, Norton current source
      const gOn = 1.0 / p.rOn;
      // Diode drop: treat V_on as a fixed voltage offset
      // Current in on-state: I_AK = (V_AK - V_on) / R_on
      const iOn = (vak - p.vOn) / p.rOn;
      _geq = gOn + GMIN;
      _ieq = iOn - _geq * vak;

      // Check if current has dropped below holding current → unlatch
      const iAk = _geq * vak + _ieq;
      if (iAk < p.iH && vak >= 0) {
        _latched = false;
        // Re-compute in blocking mode
        computeBlockingMode(vak, alphaSum);
      }
    } else {
      computeBlockingMode(vak, alphaSum);
    }

    // Gate junction model: forward-biased diode linearized at the (already
    // pnjlim-limited) vgk operating point.
    const expVgk = Math.exp(Math.min(vgk / nVt, 700));
    const gGate = (p.iS * expVgk) / nVt + GMIN;
    const iGateCurrent = p.iS * (expVgk - 1);
    _gGateGeq = gGate;
    _gGateIeq = iGateCurrent - gGate * vgk;
  }

  function computeBlockingMode(vak: number, _alphaSum: number): void {
    if (vak >= 0) {
      // Forward blocking: the middle junction (J2) is reverse-biased.
      // Current is approximately constant leakage I_S / (1 - α₁ - α₂),
      // independent of V_AK (saturated reverse junction).
      // Model as high-resistance path: G_block = GMIN only.
      // This keeps current in the µA range for any forward voltage below breakover.
      _geq = GMIN;
      _ieq = 0;
    } else {
      // Reverse blocking — reverse-biased diode (J1 junction)
      // Use small-signal conductance: nearly zero current
      const expArg = Math.min(vak / nVt, 0); // never positive for reverse
      const expVal = Math.exp(expArg);
      const iRev = p.iS * (expVal - 1);
      const gRev = (p.iS * expVal) / nVt + GMIN;
      _geq = gRev;
      _ieq = iRev - gRev * vak;
    }
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // No topology-constant linear contributions
    },

    stampNonlinear(solver: SparseSolver): void {
      // Anode-cathode path
      stampG(solver, nodeA, nodeA, _geq);
      stampG(solver, nodeA, nodeK, -_geq);
      stampG(solver, nodeK, nodeA, -_geq);
      stampG(solver, nodeK, nodeK, _geq);
      stampRHS(solver, nodeA, -_ieq);
      stampRHS(solver, nodeK, _ieq);

      // Gate-cathode path (gate junction)
      stampG(solver, nodeG, nodeG, _gGateGeq);
      stampG(solver, nodeG, nodeK, -_gGateGeq);
      stampG(solver, nodeK, nodeG, -_gGateGeq);
      stampG(solver, nodeK, nodeK, _gGateGeq);
      stampRHS(solver, nodeG, -_gGateIeq);
      stampRHS(solver, nodeK, _gGateIeq);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
      const vK = nodeK > 0 ? voltages[nodeK - 1] : 0;
      const vGateNode = nodeG > 0 ? voltages[nodeG - 1] : 0;

      const vakRaw = vA - vK;
      const vgkRaw = vGateNode - vK;

      // Check breakover using raw voltage before pnjlim.
      // Breakover triggers when V_AK exceeds the breakover threshold —
      // this must be evaluated against the actual circuit voltage, not the
      // pnjlim-limited value, so it fires at the right operating point.
      if (!_latched && vakRaw > p.vBreakover) {
        _latched = true;
      }

      // Apply pnjlim to anode-cathode junction voltage for NR stability
      const vakLimited = pnjlim(vakRaw, _vak, nVt, vcrit);

      // Apply pnjlim to gate-cathode junction voltage for NR stability
      const vgkLimited = pnjlim(vgkRaw, _vgk, nVt, vcritGate);

      // Write limited voltages back
      if (nodeA > 0) {
        voltages[nodeA - 1] = vK + vakLimited;
      }
      if (nodeG > 0) {
        voltages[nodeG - 1] = vK + vgkLimited;
      }

      _vak = vakLimited;
      _vgk = vgkLimited;

      computeOperatingPoint(_vak, _vgk);
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
      const vK = nodeK > 0 ? voltages[nodeK - 1] : 0;
      const vAp = nodeA > 0 ? prevVoltages[nodeA - 1] : 0;
      const vKp = nodeK > 0 ? prevVoltages[nodeK - 1] : 0;

      return Math.abs((vA - vK) - (vAp - vKp)) <= 2 * nVt;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // pinLayout order: [A(0), K(1), G(2)]
      // Positive = current flowing INTO the element at that pin.
      const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
      const vK = nodeK > 0 ? voltages[nodeK - 1] : 0;
      const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;

      // Anode-cathode path: Norton equivalent I = _geq * V_AK + _ieq
      // Current into anode (into element at A): iAK flows from A to K through device
      const iAK = _geq * (vA - vK) + _ieq;

      // Gate-cathode path: Norton equivalent I = _gGateGeq * V_GK + _gGateIeq
      // Current into gate (into element at G)
      const iGK = _gGateGeq * (vG - vK) + _gGateIeq;

      // KCL: I_A + I_K + I_G = 0 → I_K = -(I_A + I_G)
      const iA = iAK;
      const iG = iGK;
      const iK = -(iA + iG);

      // Return in pinLayout order [A, K, G]
      return [iA, iK, iG];
    },

    setParam(key: string, value: number): void {
      if (key in p) {
        (p as Record<string, number>)[key] = value;
        recomputeDerivedConstants();
      }
    },

    get label(): string | undefined {
      return props.getOrDefault<string>("label", "");
    },

    // Expose latch state for testing
    get _latchedState(): boolean {
      return _latched;
    },
  } as AnalogElement & { _latchedState: boolean };
}

// ---------------------------------------------------------------------------
// ScrElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ScrElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SCR", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildScrPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 2.5,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vA = signals?.getPinVoltage("A");
    const vK = signals?.getPinVoltage("K");
    const vG = signals?.getPinVoltage("G");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Body (triangle and cathode bar) stays COMPONENT color
    ctx.drawPolygon([
      { x: 1.5, y: -0.5 },
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 0 },
    ], true);
    ctx.drawLine(2.5, -0.5, 2.5, 0.5);

    // Anode lead
    drawColoredLead(ctx, signals, vA, 0, 0, 1.5, 0);

    // Cathode lead
    drawColoredLead(ctx, signals, vK, 2.5, 0, 4, 0);

    // Gate lead: diagonal from cathode bar to pin G at (3,1)
    drawColoredLead(ctx, signals, vG, 2.5, 0, 3, 1);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildScrPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "K",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 3, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SCR_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
  {
    key: "model",
    type: PropertyType.STRING,
    label: "Model",
    defaultValue: "behavioral",
    description: "Active model selection",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const SCR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// ScrDefinition
// ---------------------------------------------------------------------------

function scrCircuitFactory(props: PropertyBag): ScrElement {
  return new ScrElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ScrDefinition: ComponentDefinition = {
  name: "SCR",
  typeId: -1,
  factory: scrCircuitFactory,
  pinLayout: buildScrPinDeclarations(),
  propertyDefs: SCR_PROPERTY_DEFS,
  attributeMap: SCR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "SCR — Silicon Controlled Rectifier.\n" +
    "Pins: A (anode), K (cathode), G (gate).\n" +
    "Triggers when gate current raises α₁+α₂ above 0.95. Latches until I_AK < I_hold.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createScrElement(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: SCR_PARAM_DEFS,
      params: SCR_PARAM_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
