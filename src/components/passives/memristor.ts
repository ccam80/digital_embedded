/**
 * Memristor analog component — Joglekar window function model.
 *
 * The memristor's resistance depends on an internal state variable w
 * (normalised, 0 to 1) representing the boundary between doped and undoped
 * regions. The state evolves with current:
 *
 *   dw/dt = µ_v · R_on / D² · i(t) · f_p(w)
 *
 * where f_p(w) = 1 − (2w − 1)^(2p) is the Joglekar window function of
 * order p, enforcing 0 ≤ w ≤ 1. The resistance is:
 *
 *   R(w) = R_on · w + R_off · (1 − w)
 *
 * which can equivalently be written using conductance:
 *
 *   G(w) = w · (1/R_on − 1/R_off) + 1/R_off
 *
 * The memristor stamps its state-dependent conductance in stampNonlinear().
 * The engine calls updateState() each accepted timestep to integrate w.
 *
 * MNA topology:
 *   nodeIndices[0] = node_A  (positive terminal)
 *   nodeIndices[1] = node_B  (negative terminal)
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
import type { AnalogElement } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";

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
// MemristorElement — AnalogElement implementation
// ---------------------------------------------------------------------------

export class MemristorElement implements AnalogElement {
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = false;

  private readonly rOn: number;
  private readonly rOff: number;
  private readonly mobility: number;
  private readonly deviceLength: number;
  private readonly windowOrder: number;

  /** Normalised state variable: 0 = fully undoped, 1 = fully doped. */
  private _w: number;

  constructor(
    nodeIndices: number[],
    rOn: number,
    rOff: number,
    initialState: number,
    mobility: number,
    deviceLength: number,
    windowOrder: number,
  ) {
    this.nodeIndices = nodeIndices;
    this.rOn = rOn;
    this.rOff = rOff;
    this._w = Math.max(0, Math.min(1, initialState));
    this.mobility = mobility;
    this.deviceLength = deviceLength;
    this.windowOrder = windowOrder;
  }

  /**
   * Resistance at current state.
   * R(w) = R_on · w + R_off · (1 − w)
   */
  resistance(): number {
    return this.rOn * this._w + this.rOff * (1 - this._w);
  }

  /**
   * Conductance at current state.
   * G(w) = w · (1/R_on − 1/R_off) + 1/R_off
   */
  conductance(): number {
    return this._w * (1 / this.rOn - 1 / this.rOff) + 1 / this.rOff;
  }

  /** Current normalised state variable w (read-only access for tests). */
  get w(): number {
    return this._w;
  }

  stamp(_solver: SparseSolver): void {
    // No topology-constant linear contributions — all stamping is in stampNonlinear.
  }

  stampNonlinear(solver: SparseSolver): void {
    const nA = this.nodeIndices[0];
    const nB = this.nodeIndices[1];
    const G = this.conductance();

    stampG(solver, nA, nA, G);
    stampG(solver, nA, nB, -G);
    stampG(solver, nB, nA, -G);
    stampG(solver, nB, nB, G);

    // Norton current source: I_norton = I_op − G · V_op
    // At linearisation point the stamp of G·V is already handled by the
    // conductance matrix, so we only need to add the constant term.
    // For a pure conductance (no previous operating-point offset), the RHS
    // contribution is zero — the conductance self-consistently produces the
    // right current from the solution voltages without an extra source term.
    // (This matches the resistor pattern: pure G stamp, no RHS offset.)
  }

  updateOperatingPoint(_voltages: Float64Array): void {
    // No voltage limiting needed; conductance is a smooth function of w.
  }

  /**
   * Integrate state variable w using Euler forward step.
   *
   * dw/dt = µ_v · R_on / D² · i(t) · f_p(w)
   * f_p(w) = 1 − (2w − 1)^(2p)
   *
   * Current i = G(w) · V(t) flows through the element.
   */
  updateState(dt: number, voltages: Float64Array): void {
    const nA = this.nodeIndices[0];
    const nB = this.nodeIndices[1];
    const vA = nA > 0 ? voltages[nA - 1] : 0;
    const vB = nB > 0 ? voltages[nB - 1] : 0;
    const vAB = vA - vB;
    const current = this.conductance() * vAB;

    const p = this.windowOrder;
    const twoWMinus1 = 2 * this._w - 1;
    const fp = 1 - Math.pow(twoWMinus1, 2 * p);

    const dWdt = (this.mobility * this.rOn) / (this.deviceLength * this.deviceLength) * current * fp;
    this._w = Math.max(0, Math.min(1, this._w + dWdt * dt));
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildMemristorPinDeclarations(): PinDeclaration[] {
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
// MemristorCircuitElement — AbstractCircuitElement (editor/visual layer)
// ---------------------------------------------------------------------------

export class MemristorCircuitElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Memristor", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildMemristorPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // hs=10*PX=0.625, zigzag spans y:[-0.625, 0.625], x:[0,2]
    return {
      x: this.position.x,
      y: this.position.y - 0.625,
      width: 2,
      height: 1.25,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setLineWidth(1);

    const vA = signals?.getPinVoltage("A");
    const vB = signals?.getPinVoltage("B");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Falstad MemristorElm: calcLeads(32) on (0,0)→(2,0), bodyLen=2=distance
    // lead1=(0,0), lead2=(2,0). hs=10*PX=0.625
    // Lead wires are zero-length (lead endpoints = pin endpoints)
    // 6 segments: each draws vertical spike then horizontal segment
    // interpPointSingle on horizontal: (2*f, -g)
    const hs = 10 / 16; // 0.625
    const segments = 6;

    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(0, 0, 2, 0, [
        { offset: 0, color: signals!.voltageColor(vA) },
        { offset: 1, color: signals!.voltageColor(vB) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }

    let ox = 0;
    for (let i = 0; i <= segments; i++) {
      const atEnd = i === segments;
      const nx = atEnd ? 0 : (i & 1) === 0 ? 1 : -1;

      // Vertical line from hs*ox to hs*nx at position i/segments
      const px = (i / segments) * 2;
      ctx.drawLine(px, -(hs * ox), px, -(hs * nx));

      if (!atEnd) {
        // Horizontal line from hs*nx at i to hs*nx at i+1
        const px2 = ((i + 1) / segments) * 2;
        ctx.drawLine(px, -(hs * nx), px2, -(hs * nx));
      }
      ox = nx;
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Memristor — Joglekar window function model.\n" +
      "Resistance depends on charge history (state variable w, 0–1).\n" +
      "dw/dt = µ_v · R_on / D² · i · f_p(w), f_p(w) = 1 − (2w−1)^(2p)."
    );
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

export function createMemristorElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const rOn = props.getOrDefault<number>("rOn", 100);
  const rOff = props.getOrDefault<number>("rOff", 16000);
  const initialState = props.getOrDefault<number>("initialState", 0.5);
  const mobility = props.getOrDefault<number>("mobility", 1e-14);
  const deviceLength = props.getOrDefault<number>("deviceLength", 10e-9);
  const windowOrder = props.getOrDefault<number>("windowOrder", 1);

  return new MemristorElement(nodeIds, rOn, rOff, initialState, mobility, deviceLength, windowOrder);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const MEMRISTOR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "rOn",
    type: PropertyType.FLOAT,
    label: "R_on (Ω)",
    defaultValue: 100,
    min: 1e-3,
    description: "Resistance of fully doped (on) state in ohms",
  },
  {
    key: "rOff",
    type: PropertyType.FLOAT,
    label: "R_off (Ω)",
    defaultValue: 16000,
    min: 1e-3,
    description: "Resistance of fully undoped (off) state in ohms",
  },
  {
    key: "initialState",
    type: PropertyType.FLOAT,
    label: "Initial state w₀",
    defaultValue: 0.5,
    min: 0,
    description: "Initial normalised doped-region boundary (0=undoped, 1=fully doped)",
  },
  {
    key: "mobility",
    type: PropertyType.FLOAT,
    label: "Mobility µ_v (m²/V·s)",
    defaultValue: 1e-14,
    min: 1e-20,
    description: "Ionic mobility in m² per V·s",
  },
  {
    key: "deviceLength",
    type: PropertyType.FLOAT,
    label: "Device length D (m)",
    defaultValue: 10e-9,
    min: 1e-12,
    description: "Device thickness in metres",
  },
  {
    key: "windowOrder",
    type: PropertyType.INT,
    label: "Window order p",
    defaultValue: 1,
    min: 1,
    description: "Joglekar window function order p (integer ≥ 1)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown below the component",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const MEMRISTOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "rOn",          propertyKey: "rOn",          convert: (v) => parseFloat(v) },
  { xmlName: "rOff",         propertyKey: "rOff",         convert: (v) => parseFloat(v) },
  { xmlName: "initialState", propertyKey: "initialState", convert: (v) => parseFloat(v) },
  { xmlName: "mobility",     propertyKey: "mobility",     convert: (v) => parseFloat(v) },
  { xmlName: "deviceLength", propertyKey: "deviceLength", convert: (v) => parseFloat(v) },
  { xmlName: "windowOrder",  propertyKey: "windowOrder",  convert: (v) => parseInt(v, 10) },
  { xmlName: "Label",        propertyKey: "label",        convert: (v) => v },
];

// ---------------------------------------------------------------------------
// MemristorDefinition
// ---------------------------------------------------------------------------

function memristorCircuitFactory(props: PropertyBag): MemristorCircuitElement {
  return new MemristorCircuitElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const MemristorDefinition: ComponentDefinition = {
  name: "Memristor",
  typeId: -1,
  engineType: "analog",
  factory: memristorCircuitFactory,
  executeFn: noOpAnalogExecuteFn,
  pinLayout: buildMemristorPinDeclarations(),
  propertyDefs: MEMRISTOR_PROPERTY_DEFS,
  attributeMap: MEMRISTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Memristor — Joglekar window function model.\n" +
    "Resistance depends on charge history (state variable w, 0–1).",
  analogFactory: createMemristorElement,
  requiresBranchRow: false,
  getInternalNodeCount: () => 0,
};
