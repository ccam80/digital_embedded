/**
 * Triac analog component — bidirectional thyristor.
 *
 * Implements two anti-parallel SCR paths sharing a gate terminal.
 * Conducts in both directions when triggered by gate current, and latches
 * until the main terminal current crosses zero (drops below I_hold).
 *
 * Terminal convention:
 *   MT1 — Main Terminal 1 (reference terminal for gate control)
 *   MT2 — Main Terminal 2
 *   G   — Gate
 *
 * Model: two independent latch states (forward path MT2→MT1, reverse path MT1→MT2).
 * The active path is selected based on the sign of V_MT2-MT1. Gate current in
 * either polarity triggers the corresponding SCR path.
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
  noOpAnalogExecuteFn,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement, AnalogElementCore } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import { pnjlim } from "../../analog/newton-raphson.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Thermal voltage at 300 K (kT/q in volts). */
const VT = 0.02585;

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

/** Maximum alpha value — prevents division-by-zero. */
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
// createTriacElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createTriacElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const nodeMT2 = pinNodes.get("MT2")!; // Main Terminal 2
  const nodeMT1 = pinNodes.get("MT1")!; // Main Terminal 1
  const nodeG   = pinNodes.get("G")!;   // Gate

  const vOn: number      = props.getOrDefault<number>("vOn",      1.5);
  const iH: number       = props.getOrDefault<number>("iH",       10e-3);
  const rOn: number      = props.getOrDefault<number>("rOn",      0.01);
  const iS: number       = props.getOrDefault<number>("iS",       1e-12);
  const alpha1: number   = props.getOrDefault<number>("alpha1",   0.5);
  const alpha2_0: number = props.getOrDefault<number>("alpha2_0", 0.3);
  const iRef: number     = props.getOrDefault<number>("i_ref",    1e-3);
  const n: number        = props.getOrDefault<number>("n",        1);

  const nVt = n * VT;
  const vcritMain = nVt * Math.log(nVt / (iS * Math.SQRT2));
  const vcritGate = nVt * Math.log(nVt / (iS * Math.SQRT2));

  // Forward path (MT2→MT1 positive): latch state
  let _latchedFwd = false;
  // Reverse path (MT1→MT2 positive): latch state
  let _latchedRev = false;

  // Internal voltage state (pnjlim tracking)
  let _vmt = 0; // V_MT2 - V_MT1 (positive = forward path active)
  let _vgk = 0; // V_G - V_MT1

  // Cached stamp values
  let _geq = GMIN;
  let _ieq = 0;
  let _gGateGeq = GMIN;
  let _gGateIeq = 0;

  function computeAlpha2(iGate: number): number {
    const raw = 1 - (1 - alpha2_0) * Math.exp(-Math.abs(iGate) / iRef);
    return Math.min(raw, ALPHA_MAX);
  }

  function computeOnState(vmt: number): void {
    // On-state: low-resistance path with V_on offset
    const gOn = 1.0 / rOn;
    const iOn = (vmt - vOn) / rOn;
    _geq = gOn + GMIN;
    _ieq = iOn - _geq * vmt;
  }

  function computeBlockingState(): void {
    // Blocking: high-impedance path (GMIN only)
    _geq = GMIN;
    _ieq = 0;
  }

  function computeOperatingPoint(vmt: number, vg1: number): void {
    // Gate current (forward-biased gate-MT1 junction)
    const iGate = iS * (Math.exp(Math.min(vg1 / nVt, 700)) - 1) + GMIN * vg1;

    const a2 = computeAlpha2(iGate);
    const a1c = Math.min(alpha1, ALPHA_MAX);
    const a2c = Math.min(a2, ALPHA_MAX);
    const alphaSum = a1c + a2c;
    const triggered = alphaSum > 0.95;

    if (vmt >= 0) {
      // Forward path (MT2→MT1)
      if (!_latchedFwd && triggered) {
        _latchedFwd = true;
      }
      if (_latchedFwd) {
        computeOnState(vmt);
        // Unlatch when current falls below I_hold
        const iMt = _geq * vmt + _ieq;
        if (iMt < iH) {
          _latchedFwd = false;
          computeBlockingState();
        }
      } else {
        computeBlockingState();
      }
      // Reset reverse latch when polarity changes
      _latchedRev = false;
    } else {
      // Reverse path (MT1→MT2, vmt < 0)
      // For reverse path: magnitude is |vmt|, on-state at -V_on
      if (!_latchedRev && triggered) {
        _latchedRev = true;
      }
      if (_latchedRev) {
        // Mirror: current flows MT1→MT2, V_drop = -V_on
        const gOn = 1.0 / rOn;
        const iOn = (vmt + vOn) / rOn; // vmt negative, vmt + vOn < 0
        _geq = gOn + GMIN;
        _ieq = iOn - _geq * vmt;
        // Unlatch when |current| falls below I_hold
        const iMt = _geq * vmt + _ieq;
        if (iMt > -iH) {
          _latchedRev = false;
          computeBlockingState();
        }
      } else {
        computeBlockingState();
      }
      // Reset forward latch when polarity changes
      _latchedFwd = false;
    }

    // Gate junction: linearized at (already pnjlim-limited) vg1
    const expVg = Math.exp(Math.min(vg1 / nVt, 700));
    const gGate = (iS * expVg) / nVt + GMIN;
    const iGateCurrent = iS * (expVg - 1);
    _gGateGeq = gGate;
    _gGateIeq = iGateCurrent - gGate * vg1;
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // No topology-constant contributions
    },

    stampNonlinear(solver: SparseSolver): void {
      // MT1-MT2 main path
      stampG(solver, nodeMT2, nodeMT2, _geq);
      stampG(solver, nodeMT2, nodeMT1, -_geq);
      stampG(solver, nodeMT1, nodeMT2, -_geq);
      stampG(solver, nodeMT1, nodeMT1, _geq);
      // Norton current source: positive _ieq means current from MT1 to MT2
      stampRHS(solver, nodeMT2, -_ieq);
      stampRHS(solver, nodeMT1, _ieq);

      // Gate-MT1 path
      stampG(solver, nodeG,   nodeG,   _gGateGeq);
      stampG(solver, nodeG,   nodeMT1, -_gGateGeq);
      stampG(solver, nodeMT1, nodeG,   -_gGateGeq);
      stampG(solver, nodeMT1, nodeMT1, _gGateGeq);
      stampRHS(solver, nodeG,   -_gGateIeq);
      stampRHS(solver, nodeMT1, _gGateIeq);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const v1 = nodeMT1 > 0 ? voltages[nodeMT1 - 1] : 0;
      const v2 = nodeMT2 > 0 ? voltages[nodeMT2 - 1] : 0;
      const vG = nodeG   > 0 ? voltages[nodeG   - 1] : 0;

      const vmtRaw = v2 - v1;
      const vg1Raw = vG - v1;

      // Apply pnjlim to MT1-MT2 voltage for NR stability
      const vmtLimited = pnjlim(vmtRaw, _vmt, nVt, vcritMain);
      // Apply pnjlim to gate-MT1 voltage
      const vg1Limited = pnjlim(vg1Raw, _vgk, nVt, vcritGate);

      // Write limited voltages back
      if (nodeMT2 > 0) {
        voltages[nodeMT2 - 1] = v1 + vmtLimited;
      }
      if (nodeG > 0) {
        voltages[nodeG - 1] = v1 + vg1Limited;
      }

      _vmt = vmtLimited;
      _vgk = vg1Limited;

      computeOperatingPoint(_vmt, _vgk);
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      const v1  = nodeMT1 > 0 ? voltages[nodeMT1 - 1]     : 0;
      const v2  = nodeMT2 > 0 ? voltages[nodeMT2 - 1]     : 0;
      const v1p = nodeMT1 > 0 ? prevVoltages[nodeMT1 - 1] : 0;
      const v2p = nodeMT2 > 0 ? prevVoltages[nodeMT2 - 1] : 0;
      return Math.abs((v2 - v1) - (v2p - v1p)) <= 2 * nVt;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // pinLayout order: [MT2(0), MT1(1), G(2)]
      // Positive = current flowing INTO the element at that pin.
      const v1 = nodeMT1 > 0 ? voltages[nodeMT1 - 1] : 0;
      const v2 = nodeMT2 > 0 ? voltages[nodeMT2 - 1] : 0;
      const vG = nodeG   > 0 ? voltages[nodeG   - 1] : 0;

      // Main path (MT2-MT1): Norton equivalent stamps _geq across MT2-MT1 with _ieq source.
      // stampNonlinear: stampRHS(nodeMT2, -_ieq), stampRHS(nodeMT1, _ieq)
      // Current from MT2 into element: I = _geq * (V_MT2 - V_MT1) + _ieq
      const iMT = _geq * (v2 - v1) + _ieq;

      // Gate-MT1 path: Norton equivalent _gGateGeq across G-MT1 with _gGateIeq source.
      // Current from G into element: I = _gGateGeq * (V_G - V_MT1) + _gGateIeq
      const iG = _gGateGeq * (vG - v1) + _gGateIeq;

      // KCL: I_MT2 + I_MT1 + I_G = 0 → I_MT1 = -(I_MT2 + I_G)
      const iMT2 = iMT;
      const iMT1 = -(iMT2 + iG);

      // Return in pinLayout order [MT2, MT1, G]
      return [iMT2, iMT1, iG];
    },
  };
}

// ---------------------------------------------------------------------------
// TriacElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class TriacElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Triac", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTriacPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 3,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vMT2 = signals?.getPinVoltage("MT2");
    const vMT1 = signals?.getPinVoltage("MT1");
    const vG = signals?.getPinVoltage("G");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Reference pixel coords divided by 16 for grid units
    // Component spans x=0..4, y=-2..0 (pin 2 at (4,-2))
    const bar1x = 24 / 16; // 1.5
    const bar2x = 40 / 16; // 2.5

    // Body: two vertical bars and bidirectional arrow triangles
    // Bar 1 at x=1.5, from y=-1 to y=+1
    ctx.drawLine(bar1x, -1,     bar1x, 1);
    // Bar 2 at x=2.5, from y=-1 to y=+1
    ctx.drawLine(bar2x, -1,     bar2x, 1);

    // Forward arrow triangle (pointing right): (bar1x, 0.5) → (bar2x, 1.0) → (bar2x, 0)
    ctx.drawPolygon([
      { x: bar1x, y:  8 / 16 },
      { x: bar2x, y: 16 / 16 },
      { x: bar2x, y: 0 },
    ], true);

    // Reverse arrow triangle (pointing left): (bar2x, -0.5) → (bar1x, -1.0) → (bar1x, 0)
    ctx.drawPolygon([
      { x: bar2x, y:  -8 / 16 },
      { x: bar1x, y: -16 / 16 },
      { x: bar1x, y: 0 },
    ], true);

    // MT2 lead: pin 0 at (0,0) → bar1 at (1.5,0)
    if (signals && vMT2 !== undefined) {
      ctx.setRawColor(signals.voltageColor(vMT2));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, bar1x, 0);

    // MT1 lead: bar2 at (2.5,0) → pin 1 at (4,0)
    if (signals && vMT1 !== undefined) {
      ctx.setRawColor(signals.voltageColor(vMT1));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(bar2x, 0, 4, 0);

    // Gate lead: (2.5,0) → (4,-1.5) → (4,-2) to pin 2
    if (signals && vG !== undefined) {
      ctx.setRawColor(signals.voltageColor(vG));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(bar2x, 0, 4, -24 / 16);
    ctx.drawLine(4, -24 / 16, 4, -2);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Triac — bidirectional thyristor.\n" +
      "Pins: MT1 (main terminal 1), MT2 (main terminal 2), G (gate).\n" +
      "Conducts in both directions when triggered. Turns off at current zero-crossing."
    );
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTriacPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "MT2",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "MT1",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 4, y: -2 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TRIAC_PROPERTY_DEFS: PropertyDefinition[] = [
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
    key: "iH",
    type: PropertyType.FLOAT,
    label: "I_hold (A)",
    defaultValue: 10e-3,
    description: "Holding current — minimum main current to stay on",
  },
  {
    key: "rOn",
    type: PropertyType.FLOAT,
    label: "R_on (Ω)",
    defaultValue: 0.01,
    description: "On-state series resistance",
  },
  {
    key: "iS",
    type: PropertyType.FLOAT,
    label: "I_S (A)",
    defaultValue: 1e-12,
    description: "Reverse saturation current",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TRIAC_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label",      propertyKey: "label", convert: (v) => v },
  { xmlName: "vOn",        propertyKey: "vOn",   convert: (v) => parseFloat(v) },
  { xmlName: "iH",         propertyKey: "iH",    convert: (v) => parseFloat(v) },
  { xmlName: "rOn",        propertyKey: "rOn",   convert: (v) => parseFloat(v) },
];

// ---------------------------------------------------------------------------
// TriacDefinition
// ---------------------------------------------------------------------------

function triacCircuitFactory(props: PropertyBag): TriacElement {
  return new TriacElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TriacDefinition: ComponentDefinition = {
  name: "Triac",
  typeId: -1,
  engineType: "analog",
  factory: triacCircuitFactory,
  executeFn: noOpAnalogExecuteFn,
  pinLayout: buildTriacPinDeclarations(),
  propertyDefs: TRIAC_PROPERTY_DEFS,
  attributeMap: TRIAC_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Triac — bidirectional thyristor.\n" +
    "Pins: MT1 (main terminal 1), MT2 (main terminal 2), G (gate).\n" +
    "Conducts in both directions when triggered. Turns off at current zero-crossing.",
  analogDeviceType: "TRIAC",
  analogFactory: createTriacElement,
};
