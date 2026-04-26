/**
 * Memristor analog component â€” Joglekar window function model.
 *
 * The memristor's resistance depends on an internal state variable w
 * (normalised, 0 to 1) representing the boundary between doped and undoped
 * regions. The state evolves with current:
 *
 *   dw/dt = Âµ_v Â· R_on / DÂ² Â· i(t) Â· f_p(w)
 *
 * where f_p(w) = 1 âˆ’ (2w âˆ’ 1)^(2p) is the Joglekar window function of
 * order p, enforcing 0 â‰¤ w â‰¤ 1. The resistance is:
 *
 *   R(w) = R_on Â· w + R_off Â· (1 âˆ’ w)
 *
 * which can equivalently be written using conductance:
 *
 *   G(w) = w Â· (1/R_on âˆ’ 1/R_off) + 1/R_off
 *
 * The memristor stamps its state-dependent conductance inside load() every
 * NR iteration. The engine calls accept() once per accepted timestep to
 * integrate w forward by Euler forward.
 *
 * MNA topology:
 *   pinNodeIds[0] = node_A  (positive terminal)
 *   pinNodeIds[1] = node_B  (negative terminal)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
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
import { stampG } from "../../solver/analog/stamp-helpers.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: MEMRISTOR_PARAM_DEFS, defaults: MEMRISTOR_DEFAULTS } = defineModelParams({
  primary: {
    rOn:         { default: 100,    unit: "Î©",       description: "Resistance of fully doped (on) state in ohms", min: 1e-3 },
    rOff:        { default: 16000,  unit: "Î©",       description: "Resistance of fully undoped (off) state in ohms", min: 1e-3 },
    initialState:{ default: 0.5,                     description: "Initial normalised doped-region boundary (0=undoped, 1=fully doped)", min: 0 },
  },
  secondary: {
    mobility:    { default: 1e-14,                   description: "Ionic mobility in mÂ² per VÂ·s", min: 1e-20 },
    deviceLength:{ default: 10e-9,                   description: "Device thickness in metres", min: 1e-12 },
    windowOrder: { default: 1,                       description: "Joglekar window function order p (integer >= 1)", min: 1 },
  },
});

// ---------------------------------------------------------------------------
// MemristorElement â€” AnalogElement implementation
// ---------------------------------------------------------------------------

export class MemristorElement implements AnalogElementCore {
  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = false;

  private rOn: number;
  private rOff: number;
  private mobility: number;
  private deviceLength: number;
  private windowOrder: number;

  /** Normalised state variable: 0 = fully undoped, 1 = fully doped. */
  private _w: number;

  constructor(
    rOn: number,
    rOff: number,
    initialState: number,
    mobility: number,
    deviceLength: number,
    windowOrder: number,
  ) {
    this.rOn = rOn;
    this.rOff = rOff;
    this._w = Math.max(0, Math.min(1, initialState));
    this.mobility = mobility;
    this.deviceLength = deviceLength;
    this.windowOrder = windowOrder;
  }

  /**
   * Resistance at current state.
   * R(w) = R_on Â· w + R_off Â· (1 âˆ’ w)
   */
  resistance(): number {
    return this.rOn * this._w + this.rOff * (1 - this._w);
  }

  /**
   * Conductance at current state.
   * G(w) = w Â· (1/R_on âˆ’ 1/R_off) + 1/R_off
   */
  conductance(): number {
    return this._w * (1 / this.rOn - 1 / this.rOff) + 1 / this.rOff;
  }

  /** Current normalised state variable w (read-only access for tests). */
  get w(): number {
    return this._w;
  }

  setParam(key: string, value: number): void {
    if (key === "rOn") this.rOn = value;
    else if (key === "rOff") this.rOff = value;
    else if (key === "mobility") this.mobility = value;
    else if (key === "deviceLength") this.deviceLength = value;
    else if (key === "windowOrder") this.windowOrder = value;
    else if (key === "initialState") this._w = Math.max(0, Math.min(1, value));
  }

  /**
   * Unified load() â€” stamps the state-dependent conductance every NR iteration.
   *
   * The memristor is nonlinear but not reactive: dw/dt integration happens in
   * accept() once per accepted timestep, not in the NR inner loop.
   */
  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const G = this.conductance();

    stampG(solver, nA, nA, G);
    stampG(solver, nA, nB, -G);
    stampG(solver, nB, nA, -G);
    stampG(solver, nB, nB, G);
    // Pure conductance â€” no RHS offset needed (matches resistor Norton stamp).
  }

  /**
   * Euler forward integration of the state variable w once per accepted timestep.
   * The engine calls accept() exactly once per accepted step with the converged
   * terminal voltages on ctx.rhs.
   *
   *   dw/dt = Âµ_v Â· R_on / DÂ² Â· i(t) Â· f_p(w)
   *   f_p(w) = 1 âˆ’ (2w âˆ’ 1)^(2p)
   */
  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const voltages = ctx.rhs;
    const vA = voltages[nA];
    const vB = voltages[nB];
    const vAB = vA - vB;
    const current = this.conductance() * vAB;

    const p = this.windowOrder;
    const twoWMinus1 = 2 * this._w - 1;
    const fp = 1 - Math.pow(twoWMinus1, 2 * p);

    const dWdt = (this.mobility * this.rOn) / (this.deviceLength * this.deviceLength) * current * fp;
    this._w = Math.max(0, Math.min(1, this._w + dWdt * ctx.dt));
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const vA = voltages[nA];
    const vB = voltages[nB];
    const I = this.conductance() * (vA - vB);
    return [I, -I];
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
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// MemristorCircuitElement â€” AbstractCircuitElement (editor/visual layer)
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
    // hs=10*PX=0.625, zigzag spans y:[-0.625, 0.625], x:[0,4]
    return {
      x: this.position.x,
      y: this.position.y - 0.625,
      width: 4,
      height: 1.25,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setLineWidth(1);

    const vA = signals?.getPinVoltage("A");
    const vB = signals?.getPinVoltage("B");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Falstad MemristorElm: total width 4 grid units (64px Ã· 16).
    // calcLeads(32): lead1=(0,0), lead2=(3,0) in grid units (48px Ã· 16 = 3).
    // Body spans x=1â†’3 (16px leads on each end), hs=10pxÃ·16=0.625 grid units.
    // Zigzag body: 4 full teeth, each 8px = 0.5 grid units wide.
    // Segment x positions (px Ã· 16): 1, 1.3125, 1.6875, 2, 2.3125, 2.6875, 3
    // (body subdivided into 8 half-teeth of 5px = 0.3125 grid units)

    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(0, 0, 4, 0, [
        { offset: 0, color: signals!.voltageColor(vA) },
        { offset: 1, color: signals!.voltageColor(vB) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }

    // Lead A: (0,0) â†’ (1,0)
    ctx.drawLine(0, 0, 1, 0);

    // Zigzag body: x positions at 1, 1.3125, 1.6875, 2, 2.3125, 2.6875, 3
    // y alternates: 0, -hs, +hs, -hs, +hs, -hs, +hs, 0
    const hs = 10 / 16; // 0.625
    const xs = [1, 1.3125, 1.6875, 2, 2.3125, 2.6875, 3];
    const ys = [0, -hs, hs, -hs, hs, -hs, hs, 0];

    for (let i = 0; i < xs.length; i++) {
      // Vertical segment at xs[i]: from ys[i] to ys[i+1]
      ctx.drawLine(xs[i], ys[i], xs[i], ys[i + 1]);
      // Horizontal segment from xs[i] to xs[i+1] at ys[i+1]
      if (i < xs.length - 1) {
        ctx.drawLine(xs[i], ys[i + 1], xs[i + 1], ys[i + 1]);
      }
    }

    // Lead B: (3,0) â†’ (4,0)
    ctx.drawLine(3, 0, 4, 0);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

export function createMemristorElement(
  _pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const rOn = props.getModelParam<number>("rOn");
  const rOff = props.getModelParam<number>("rOff");
  const initialState = props.getModelParam<number>("initialState");
  const mobility = props.getModelParam<number>("mobility");
  const deviceLength = props.getModelParam<number>("deviceLength");
  const windowOrder = props.getModelParam<number>("windowOrder");

  return new MemristorElement(
    rOn,
    rOff,
    initialState,
    mobility,
    deviceLength,
    windowOrder,
  );
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const MEMRISTOR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "mobility",
    type: PropertyType.FLOAT,
    label: "Mobility Âµ_v (mÂ²/VÂ·s)",
    defaultValue: 1e-14,
    min: 1e-20,
    description: "Ionic mobility in mÂ² per VÂ·s",
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
    description: "Joglekar window function order p (integer â‰¥ 1)",
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
  { xmlName: "rOn",          propertyKey: "rOn",          modelParam: true, convert: (v) => parseFloat(v) },
  { xmlName: "rOff",         propertyKey: "rOff",         modelParam: true, convert: (v) => parseFloat(v) },
  { xmlName: "initialState", propertyKey: "initialState", modelParam: true, convert: (v) => parseFloat(v) },
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
  factory: memristorCircuitFactory,
  pinLayout: buildMemristorPinDeclarations(),
  propertyDefs: MEMRISTOR_PROPERTY_DEFS,
  attributeMap: MEMRISTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Memristor â€” Joglekar window function model.\n" +
    "Resistance depends on charge history (state variable w, 0â€“1).",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createMemristorElement,
      paramDefs: MEMRISTOR_PARAM_DEFS,
      params: MEMRISTOR_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
