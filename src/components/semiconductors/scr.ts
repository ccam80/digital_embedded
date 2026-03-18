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
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  noOpAnalogExecuteFn,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import { pnjlim } from "../../analog/newton-raphson.js";

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
// Stamp helpers — node 0 is ground (skipped)
// ---------------------------------------------------------------------------

function stampG(solver: SparseSolver, row: number, col: number, val: number): void {
  if (row !== 0 && col !== 0) {
    solver.stamp(row - 1, col - 1, val);
  }
}

function stampRHS(solver: SparseSolver, row: number, val: number): void {
  if (row !== 0) {
    solver.stampRHS(row - 1, val);
  }
}

// ---------------------------------------------------------------------------
// createScrElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createScrElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const nodeA = nodeIds[0]; // anode
  const nodeK = nodeIds[1]; // cathode
  const nodeG = nodeIds[2]; // gate

  const propsMap = props as unknown as Record<string, unknown>;
  const vOn: number = (propsMap["vOn"] as number) ?? 1.5;
  const iH: number = (propsMap["iH"] as number) ?? 5e-3;
  const rOn: number = (propsMap["rOn"] as number) ?? 0.01;
  const vBreakover: number = (propsMap["vBreakover"] as number) ?? 100;
  const iS: number = (propsMap["iS"] as number) ?? 1e-12;
  const alpha1: number = (propsMap["alpha1"] as number) ?? 0.5;
  const alpha2_0: number = (propsMap["alpha2_0"] as number) ?? 0.3;
  const iRef: number = (propsMap["i_ref"] as number) ?? 1e-3;
  const n: number = (propsMap["n"] as number) ?? 1;

  const nVt = n * VT;
  const vcrit = nVt * Math.log(nVt / (iS * Math.SQRT2));

  // Internal state
  let _latched = false;
  let _vak = 0;
  let _vgk = 0;
  let _geq = GMIN;
  let _ieq = 0;
  // Gate conductance stamp values
  let _gGateGeq = GMIN;
  let _gGateIeq = 0;

  const vcritGate = nVt * Math.log(nVt / (iS * Math.SQRT2));

  function computeAlpha2(iGate: number): number {
    const raw = 1 - (1 - alpha2_0) * Math.exp(-Math.abs(iGate) / iRef);
    return Math.min(raw, ALPHA_MAX);
  }

  function computeOperatingPoint(vak: number, vgk: number): void {
    // Gate current through a small forward-biased junction (simplified model)
    const iGate = iS * (Math.exp(Math.min(vgk / nVt, 700)) - 1) + GMIN * vgk;

    const a2 = computeAlpha2(iGate);
    const a1clamped = Math.min(alpha1, ALPHA_MAX);
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
      const gOn = 1.0 / rOn;
      // Diode drop: treat V_on as a fixed voltage offset
      // Current in on-state: I_AK = (V_AK - V_on) / R_on
      const iOn = (vak - vOn) / rOn;
      _geq = gOn + GMIN;
      _ieq = iOn - _geq * vak;

      // Check if current has dropped below holding current → unlatch
      const iAk = _geq * vak + _ieq;
      if (iAk < iH && vak >= 0) {
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
    const gGate = (iS * expVgk) / nVt + GMIN;
    const iGateCurrent = iS * (expVgk - 1);
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
      const iRev = iS * (expVal - 1);
      const gRev = (iS * expVal) / nVt + GMIN;
      _geq = gRev;
      _ieq = iRev - gRev * vak;
    }
  }

  return {
    nodeIndices: [nodeA, nodeK, nodeG],
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
      if (!_latched && vakRaw > vBreakover) {
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

    get label(): string | undefined {
      return (propsMap["label"] as string | undefined);
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
      y: this.position.y - 1,
      width: 4,
      height: 2,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Lead lines
    ctx.drawLine(0, 0, 1.5, 0);
    ctx.drawLine(2.5, 0, 4, 0);

    // Thyristor body: triangle (anode left, cathode right)
    ctx.drawPolygon([
      { x: 1.5, y: -0.5 },
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 0 },
    ], true);

    // Cathode bar
    ctx.drawLine(2.5, -0.5, 2.5, 0.5);

    // Gate lead (downward from cathode bar)
    ctx.drawLine(2.5, 0.5, 2.5, 1);
    ctx.drawLine(2.5, 1, 3.5, 1);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 2, -0.75, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "SCR — Silicon Controlled Rectifier.\n" +
      "Pins: A (anode), K (cathode), G (gate).\n" +
      "Triggers when gate current raises α₁+α₂ above 0.95. Latches until I_AK < I_hold."
    );
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
    },
    {
      direction: PinDirection.OUTPUT,
      label: "K",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 3.5, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SCR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
  {
    key: "vOn",
    type: PropertyType.FLOAT,
    label: "V_on (V)",
    defaultValue: 1.5,
    description: "On-state forward voltage drop",
  },
  {
    key: "iGT",
    type: PropertyType.FLOAT,
    label: "I_GT (A)",
    defaultValue: 200e-6,
    description: "Gate trigger current threshold",
  },
  {
    key: "iH",
    type: PropertyType.FLOAT,
    label: "I_hold (A)",
    defaultValue: 5e-3,
    description: "Holding current — minimum anode current to stay on",
  },
  {
    key: "rOn",
    type: PropertyType.FLOAT,
    label: "R_on (Ω)",
    defaultValue: 0.01,
    description: "On-state series resistance",
  },
  {
    key: "vBreakover",
    type: PropertyType.FLOAT,
    label: "V_breakover (V)",
    defaultValue: 100,
    description: "Forward breakover voltage (triggers without gate)",
  },
  {
    key: "iS",
    type: PropertyType.FLOAT,
    label: "I_S (A)",
    defaultValue: 1e-12,
    description: "Reverse saturation current",
  },
  {
    key: "alpha1",
    type: PropertyType.FLOAT,
    label: "α₁",
    defaultValue: 0.5,
    description: "PNP transistor current gain (fixed)",
  },
  {
    key: "alpha2_0",
    type: PropertyType.FLOAT,
    label: "α₂₀",
    defaultValue: 0.3,
    description: "NPN off-state current gain",
  },
  {
    key: "i_ref",
    type: PropertyType.FLOAT,
    label: "I_ref (A)",
    defaultValue: 1e-3,
    description: "Gate current scale factor for α₂ modulation",
  },
  {
    key: "n",
    type: PropertyType.FLOAT,
    label: "N",
    defaultValue: 1,
    description: "Emission coefficient",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const SCR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "vOn", propertyKey: "vOn", convert: (v) => parseFloat(v) },
  { xmlName: "iH", propertyKey: "iH", convert: (v) => parseFloat(v) },
  { xmlName: "rOn", propertyKey: "rOn", convert: (v) => parseFloat(v) },
  { xmlName: "vBreakover", propertyKey: "vBreakover", convert: (v) => parseFloat(v) },
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
  engineType: "analog",
  factory: scrCircuitFactory,
  executeFn: noOpAnalogExecuteFn,
  pinLayout: buildScrPinDeclarations(),
  propertyDefs: SCR_PROPERTY_DEFS,
  attributeMap: SCR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "SCR — Silicon Controlled Rectifier.\n" +
    "Pins: A (anode), K (cathode), G (gate).\n" +
    "Triggers when gate current raises α₁+α₂ above 0.95. Latches until I_AK < I_hold.",
  analogDeviceType: "SCR",
  analogFactory: createScrElement,
};
