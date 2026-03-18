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
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const nodeMT1 = nodeIds[0]; // Main Terminal 1
  const nodeMT2 = nodeIds[1]; // Main Terminal 2
  const nodeG   = nodeIds[2]; // Gate

  const propsMap = props as unknown as Record<string, unknown>;
  const vOn: number      = (propsMap["vOn"] as number)      ?? 1.5;
  const iH: number       = (propsMap["iH"] as number)       ?? 10e-3;
  const rOn: number      = (propsMap["rOn"] as number)      ?? 0.01;
  const iS: number       = (propsMap["iS"] as number)       ?? 1e-12;
  const alpha1: number   = (propsMap["alpha1"] as number)   ?? 0.5;
  const alpha2_0: number = (propsMap["alpha2_0"] as number) ?? 0.3;
  const iRef: number     = (propsMap["i_ref"] as number)    ?? 1e-3;
  const n: number        = (propsMap["n"] as number)        ?? 1;

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
    nodeIndices: [nodeMT1, nodeMT2, nodeG],
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

    // Forward triangle (MT1→MT2 direction)
    ctx.drawPolygon([
      { x: 1.5, y: -0.4 },
      { x: 1.5, y: 0.4 },
      { x: 2.3, y: 0 },
    ], true);

    // Reverse triangle (MT2→MT1 direction — anti-parallel)
    ctx.drawPolygon([
      { x: 2.5, y: -0.4 },
      { x: 2.5, y: 0.4 },
      { x: 1.7, y: 0 },
    ], true);

    // Cathode bars
    ctx.drawLine(1.5, -0.4, 1.5, 0.4);
    ctx.drawLine(2.5, -0.4, 2.5, 0.4);

    // Gate lead
    ctx.drawLine(2.5, 0.4, 2.5, 1.0);
    ctx.drawLine(2.5, 1.0, 3.5, 1.0);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 2, -0.75, { horizontal: "center", vertical: "bottom" });
    }

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
      label: "MT1",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "MT2",
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
