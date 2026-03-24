/**
 * Diac analog component — bidirectional trigger diode.
 *
 * Blocks in both directions until |V| exceeds breakover voltage V_BO,
 * then conducts with a negative-resistance snap (voltage drops to V_hold).
 * Symmetric device — no gate terminal.
 *
 * I-V model (piecewise smooth with tanh for NR stability):
 *   - Blocking region (|V| < V_BO): high resistance R_off
 *   - Conducting region (|V| > V_hold): low resistance R_on with V_hold offset
 *   - Smooth transition via tanh to avoid NR discontinuity
 *
 * The transition sharpness parameter controls the snap width. A sharper snap
 * better models real diac behavior; a moderate value ensures NR convergence.
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

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

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
// diacConductance — smooth piecewise model
// ---------------------------------------------------------------------------

/**
 * Compute the linearized conductance and Norton current for the diac I-V model.
 *
 * Model: I(V) = V / R_off + (V/|V|) * I_on_extra * smooth_transition(|V|)
 * where smooth_transition uses tanh to provide a smooth snap from blocking to
 * conducting regions.
 *
 * The total current is:
 *   I(V) = (g_off + g_extra * s(|V|)) * V - sign(V) * V_hold * g_extra * s(|V|)
 *
 * where s(x) = 0.5 * (1 + tanh((x - V_BO) / sharpness))
 */
function diacModel(
  v: number,
  vBreakover: number,
  vHold: number,
  rOn: number,
  rOff: number,
  sharpness: number,
): { i: number; geq: number; ieq: number } {
  const gOff = 1.0 / rOff;
  const gOn  = 1.0 / rOn;
  const gExtra = gOn - gOff;

  const absV = Math.abs(v);
  const signV = v >= 0 ? 1 : -1;

  // Smooth transition: s(|V|) = 0.5*(1 + tanh((|V| - V_BO) / sharpness))
  const arg = (absV - vBreakover) / sharpness;
  const tanhVal = Math.tanh(arg);
  const s = 0.5 * (1 + tanhVal);
  // ds/d|V| = 0.5 * (1 - tanh²(arg)) / sharpness = 0.5 * sech²(arg) / sharpness
  const sech2 = 1 - tanhVal * tanhVal;
  const dsDAbsV = 0.5 * sech2 / sharpness;

  // Total conductance (symmetric): G(v) = g_off + g_extra * s(|V|)
  const gTot = gOff + gExtra * s;

  // In conducting region, effective voltage is reduced by V_hold offset:
  // I = G_tot * V - sign(V) * V_hold * g_extra * s(|V|)
  const iOffset = signV * vHold * gExtra * s;
  const iTotal = gTot * v - iOffset;

  // Jacobian: dI/dV
  // dI/dV = g_off + g_extra*s + (g_extra * v * sign(V) - sign(V)*v_hold*g_extra) * dsDAbsV
  //       = gTot + g_extra * (v - sign(V)*vHold) * sign(V) * dsDAbsV
  const dIdV = gTot + gExtra * (v - signV * vHold) * signV * dsDAbsV + GMIN;

  // Norton equivalent: I = geq * V + ieq where ieq = I - geq*V
  const geq = dIdV;
  const ieq = iTotal - geq * v;

  return { i: iTotal, geq, ieq };
}

// ---------------------------------------------------------------------------
// createDiacElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createDiacElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const nodeA = pinNodes.get("A")!; // terminal A
  const nodeB = pinNodes.get("B")!; // terminal B

  const vBreakover: number = props.getOrDefault<number>("vBreakover", 32);
  const vHold: number      = props.getOrDefault<number>("vHold",      28);
  const rOn: number        = props.getOrDefault<number>("rOn",        10);
  const rOff: number       = props.getOrDefault<number>("rOff",       1e7);

  // Sharpness of the tanh transition: smaller = sharper snap.
  // V_BO - V_hold gives the snap width; use ~0.5V for good NR convergence.
  const sharpness = 0.5;

  // Cached NR linearization
  let _v = 0;
  let _geq = 1.0 / rOff + GMIN;
  let _ieq = 0;
  let _id = 0; // cached device current for getPinCurrents

  function recompute(v: number): void {
    const { i, geq, ieq } = diacModel(v, vBreakover, vHold, rOn, rOff, sharpness);
    _id = i;
    _geq = geq;
    _ieq = ieq;
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // No topology-constant contributions
    },

    stampNonlinear(solver: SparseSolver): void {
      stampG(solver, nodeA, nodeA, _geq);
      stampG(solver, nodeA, nodeB, -_geq);
      stampG(solver, nodeB, nodeA, -_geq);
      stampG(solver, nodeB, nodeB, _geq);
      stampRHS(solver, nodeA, -_ieq);
      stampRHS(solver, nodeB, _ieq);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      _v = vA - vB;
      recompute(_v);
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      const vA  = nodeA > 0 ? voltages[nodeA - 1]     : 0;
      const vB  = nodeB > 0 ? voltages[nodeB - 1]     : 0;
      const vAp = nodeA > 0 ? prevVoltages[nodeA - 1] : 0;
      const vBp = nodeB > 0 ? prevVoltages[nodeB - 1] : 0;
      // Converge when voltage change is < 10mV (tighter than default for snap region)
      return Math.abs((vA - vB) - (vAp - vBp)) <= 0.01;
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      // pinLayout order: [A (terminal 1), B (terminal 2)]
      // Positive = current flowing INTO element at that pin.
      // Current flows from A to B through the device: into A, out of B.
      return [_id, -_id];
    },
  };
}

// ---------------------------------------------------------------------------
// DiacElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DiacElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Diac", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildDiacPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 4,
      height: 2,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._properties.getOrDefault<string>("label", "");

    const vA = signals?.getPinVoltage("A");
    const vB = signals?.getPinVoltage("B");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    const hs = 1.0;

    // A lead
    if (signals && vA !== undefined) {
      ctx.setRawColor(signals.voltageColor(vA));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, 1.5, 0);

    // B lead
    if (signals && vB !== undefined) {
      ctx.setRawColor(signals.voltageColor(vB));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(2.5, 0, 4, 0);

    // Body (plate bars and triangles) stays COMPONENT color
    ctx.setColor("COMPONENT");

    // plate1 bar at x=1.5
    ctx.drawLine(1.5, -hs, 1.5, hs);
    // plate2 bar at x=2.5
    ctx.drawLine(2.5, -hs, 2.5, hs);

    // arr0: forward triangle pointing right
    ctx.drawPolygon([
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 1.0 },
      { x: 2.5, y: 0 },
    ], true);

    // arr1: reverse triangle pointing left
    ctx.drawPolygon([
      { x: 2.5, y: -0.5 },
      { x: 1.5, y: -1.0 },
      { x: 1.5, y: 0 },
    ], true);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 2, -1.25, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Diac — bidirectional trigger diode.\n" +
      "Pins: A (terminal 1), B (terminal 2).\n" +
      "Blocks until |V| > V_breakover, then snaps to V_hold."
    );
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildDiacPinDeclarations(): PinDeclaration[] {
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
      label: "B",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const DIAC_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
  {
    key: "vBreakover",
    type: PropertyType.FLOAT,
    label: "V_breakover (V)",
    defaultValue: 32,
    description: "Breakover voltage — conduction threshold",
  },
  {
    key: "vHold",
    type: PropertyType.FLOAT,
    label: "V_hold (V)",
    defaultValue: 28,
    description: "On-state holding voltage",
  },
  {
    key: "rOn",
    type: PropertyType.FLOAT,
    label: "R_on (Ω)",
    defaultValue: 10,
    description: "On-state resistance",
  },
  {
    key: "rOff",
    type: PropertyType.FLOAT,
    label: "R_off (Ω)",
    defaultValue: 1e7,
    description: "Off-state resistance",
  },
  {
    key: "iH",
    type: PropertyType.FLOAT,
    label: "I_hold (A)",
    defaultValue: 1e-3,
    description: "Holding current",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const DIAC_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label",       propertyKey: "label",       convert: (v) => v },
  { xmlName: "vBreakover",  propertyKey: "vBreakover",  convert: (v) => parseFloat(v) },
  { xmlName: "vHold",       propertyKey: "vHold",       convert: (v) => parseFloat(v) },
  { xmlName: "rOn",         propertyKey: "rOn",         convert: (v) => parseFloat(v) },
  { xmlName: "rOff",        propertyKey: "rOff",        convert: (v) => parseFloat(v) },
];

// ---------------------------------------------------------------------------
// DiacDefinition
// ---------------------------------------------------------------------------

function diacCircuitFactory(props: PropertyBag): DiacElement {
  return new DiacElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DiacDefinition: ComponentDefinition = {
  name: "Diac",
  typeId: -1,
  engineType: "analog",
  factory: diacCircuitFactory,
  executeFn: noOpAnalogExecuteFn,
  pinLayout: buildDiacPinDeclarations(),
  propertyDefs: DIAC_PROPERTY_DEFS,
  attributeMap: DIAC_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Diac — bidirectional trigger diode.\n" +
    "Pins: A (terminal 1), B (terminal 2).\n" +
    "Blocks until |V| > V_breakover, then snaps to V_hold.",
  analogDeviceType: "DIAC",
  analogFactory: createDiacElement,
};
