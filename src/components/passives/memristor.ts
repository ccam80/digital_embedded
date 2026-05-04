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
 * The memristor stamps its state-dependent conductance inside load() every
 * NR iteration. State variable w integrates at the bottom of load() reading
 * s1, writing s0.
 *
 * MNA topology:
 *   _pinNodes.get("pos") = node_pos  (positive terminal)
 *   _pinNodes.get("neg") = node_neg  (negative terminal)
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
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { AbstractPoolBackedAnalogElement, type PoolBackedAnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { MODEDC } from "../../solver/analog/ckt-mode.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// State-pool schema
// ---------------------------------------------------------------------------

export const MEMRISTOR_SCHEMA = defineStateSchema("MemristorElement", [
  { name: "W", doc: "Normalised doped-region boundary (0=undoped, 1=fully doped)" },
]) satisfies StateSchema;

const SLOT_W = 0;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: MEMRISTOR_PARAM_DEFS, defaults: MEMRISTOR_DEFAULTS } = defineModelParams({
  primary: {
    rOn:         { default: 100,    unit: "Ω",       description: "Resistance of fully doped (on) state in ohms", min: 1e-3 },
    rOff:        { default: 16000,  unit: "Ω",       description: "Resistance of fully undoped (off) state in ohms", min: 1e-3 },
    initialState:{ default: 0.5,                     description: "Initial normalised doped-region boundary (0=undoped, 1=fully doped)", min: 0 },
  },
  secondary: {
    mobility:    { default: 1e-14,                   description: "Ionic mobility in m² per V·s", min: 1e-20 },
    deviceLength:{ default: 10e-9,                   description: "Device thickness in metres", min: 1e-12 },
    windowOrder: { default: 1,                       description: "Joglekar window function order p (integer ≥ 1)", min: 1 },
  },
});

// ---------------------------------------------------------------------------
// Defensive clamps mirroring `min` values in defineModelParams above.
// Honour the declared minima at the constructor + setParam boundary so
// XML import / programmatic tests with out-of-range values don't trigger
// div-by-zero or NaN in the conductance computation.
// ---------------------------------------------------------------------------

const MIN_R          = 1e-3;
const MIN_MOBILITY   = 1e-20;
const MIN_DEVLENGTH  = 1e-12;
const MIN_WINDOW_P   = 1;

// ---------------------------------------------------------------------------
// MemristorElement  PoolBackedAnalogElement implementation
// ---------------------------------------------------------------------------

export class MemristorElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;
  readonly stateSchema = MEMRISTOR_SCHEMA;
  readonly stateSize = MEMRISTOR_SCHEMA.size;

  private _hPP: number = -1;
  private _hNN: number = -1;
  private _hPN: number = -1;
  private _hNP: number = -1;

  private rOn: number;
  private rOff: number;
  private mobility: number;
  private deviceLength: number;
  private windowOrder: number;
  private initialState: number;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    const rOn          = props.hasModelParam("rOn")          ? props.getModelParam<number>("rOn")          : MEMRISTOR_DEFAULTS["rOn"]!;
    const rOff         = props.hasModelParam("rOff")         ? props.getModelParam<number>("rOff")         : MEMRISTOR_DEFAULTS["rOff"]!;
    const mobility     = props.hasModelParam("mobility")     ? props.getModelParam<number>("mobility")     : MEMRISTOR_DEFAULTS["mobility"]!;
    const deviceLength = props.hasModelParam("deviceLength") ? props.getModelParam<number>("deviceLength") : MEMRISTOR_DEFAULTS["deviceLength"]!;
    const windowOrder  = props.hasModelParam("windowOrder")  ? props.getModelParam<number>("windowOrder")  : MEMRISTOR_DEFAULTS["windowOrder"]!;
    const w0           = props.hasModelParam("initialState") ? props.getModelParam<number>("initialState") : MEMRISTOR_DEFAULTS["initialState"]!;
    this.rOn          = Math.max(rOn,          MIN_R);
    this.rOff         = Math.max(rOff,         MIN_R);
    this.mobility     = Math.max(mobility,     MIN_MOBILITY);
    this.deviceLength = Math.max(deviceLength, MIN_DEVLENGTH);
    this.windowOrder  = Math.max(windowOrder,  MIN_WINDOW_P);
    this.initialState = Math.max(0, Math.min(1, w0));
  }

  /**
   * Resistance at current pool state.
   * R(w) = R_on · w + R_off · (1 − w)
   */
  resistanceAt(w: number): number {
    return this.rOn * w + this.rOff * (1 - w);
  }

  /**
   * Conductance at current pool state.
   * G(w) = w · (1/R_on − 1/R_off) + 1/R_off
   */
  conductanceAt(w: number): number {
    return w * (1 / this.rOn - 1 / this.rOff) + 1 / this.rOff;
  }

  setup(ctx: SetupContext): void {
    if (this._stateBase === -1) {
      this._stateBase = ctx.allocStates(this.stateSize);
    }

    const solver = ctx.solver;
    const posNode = this._pinNodes.get("pos")!;  // pos pin - RESposNode
    const negNode = this._pinNodes.get("neg")!;  // neg pin - RESnegNode

    // ressetup.c:46-49 TSTALLOC sequence, line-for-line.
    if (posNode !== 0) this._hPP = solver.allocElement(posNode, posNode);
    if (negNode !== 0) this._hNN = solver.allocElement(negNode, negNode);
    if (posNode !== 0 && negNode !== 0) {
      this._hPN = solver.allocElement(posNode, negNode);
      this._hNP = solver.allocElement(negNode, posNode);
    }
  }

  override initState(pool: StatePoolRef): void {
    super.initState(pool);
    // Apply initial state from params into s0 slot W
    pool.state0[this._stateBase + SLOT_W] = this.initialState;
  }

  setParam(key: string, value: number): void {
    if (key === "rOn") this.rOn = Math.max(value, MIN_R);
    else if (key === "rOff") this.rOff = Math.max(value, MIN_R);
    else if (key === "mobility") this.mobility = Math.max(value, MIN_MOBILITY);
    else if (key === "deviceLength") this.deviceLength = Math.max(value, MIN_DEVLENGTH);
    else if (key === "windowOrder") this.windowOrder = Math.max(value, MIN_WINDOW_P);
    else if (key === "initialState") {
      this.initialState = Math.max(0, Math.min(1, value));
      if (this._stateBase !== -1 && this._pool) {
        // Hard reset W: write both state0 (current) AND state1 (last-accepted)
        // so the next load() reads the new value from s1 and stamps the
        // corresponding conductance. Writing only s0 left s1 stale, causing
        // the next iteration to stamp the OLD conductance after a runtime
        // hot-load — broke LTE-rollback consistency too.
        this._pool.state0[this._stateBase + SLOT_W] = this.initialState;
        this._pool.state1[this._stateBase + SLOT_W] = this.initialState;
      }
    }
  }

  /**
   * Unified load()  stamps the state-dependent conductance every NR iteration.
   *
   * Reads w from s1 (last-accepted) for stamp stability across the NR loop.
   * Integrates w at the bottom of load() reading s1, writing s0 — but ONLY in
   * transient mode. In any DC analysis (MODEDCOP / MODETRANOP / MODEDCTRANCURVE)
   * dt = 0 and the W integration would unconditionally overwrite the seeded
   * `state0[W] = initialState` with `s1[W] + 0 = 0` (s1 is zero-init at the
   * point _seedFromDcop runs `state1.set(state0)`). DCOP must be a memoryless
   * resistive linearisation around `initialState`, so the integration is gated
   * out of the DC family. Mirrors the inductor's `!(mode & MODEDC)` gate
   * (inductor.ts:319) and ngspice's MODEDC bypass (cktdefs.h:170-172).
   *
   * Latent fold-in (2026-05-03 §4e, surfaced by §3 poison-pattern migration of
   * memristor.test.ts): without the gate, every DCOP collapsed W to 0,
   * regardless of the user-set `initialState` prop, and the memristor
   * presented R_off to the rest of the circuit at the operating point.
   */
  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    const base = this._stateBase;
    const s1 = this._pool.states[1];
    const s0 = this._pool.states[0];

    // In DCOP s1 is still zero (the engine's _seedFromDcop runs `state1.set(
    // state0)` only AFTER DCOP converges), so the seeded `state0[W] =
    // initialState` is the only valid source of W during the DC NR loop.
    const inDc = (ctx.cktMode & MODEDC) !== 0;
    const wOld = inDc ? s0[base + SLOT_W] : s1[base + SLOT_W];
    const G = this.conductanceAt(wOld);

    if (this._hPP !== -1) solver.stampElement(this._hPP, G);
    if (this._hNN !== -1) solver.stampElement(this._hNN, G);
    if (this._hPN !== -1) solver.stampElement(this._hPN, -G);
    if (this._hNP !== -1) solver.stampElement(this._hNP, -G);

    if (inDc) {
      // No state evolution at the DC operating point — preserve the seeded
      // state0[W] verbatim so _seedFromDcop's state1.set(state0) propagates
      // initialState into transient.
      return;
    }

    // ngspice CKTstate0 idiom - bjtload.c:744-746, dioload.c:325-326
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;
    const voltages = ctx.rhsOld;
    const vPos = voltages[posNode];
    const vNeg = voltages[negNode];
    const vAB = vPos - vNeg;
    const iIter = G * vAB;

    const p = this.windowOrder;
    const D = this.deviceLength;
    const twoWMinus1 = 2 * wOld - 1;
    const fp = 1 - Math.pow(twoWMinus1, 2 * p);
    const dw = (this.mobility * this.rOn) / (D * D) * iIter * fp;
    const dt = ctx.dt ?? 0;
    const wNew = Math.max(0, Math.min(1, wOld + dw * dt));
    s0[base + SLOT_W] = wNew;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;
    const vPos = rhs[posNode];
    const vNeg = rhs[negNode];
    const s1 = this._pool.states[1];
    const wOld = s1[this._stateBase + SLOT_W];
    const I = this.conductanceAt(wOld) * (vPos - vNeg);
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
      label: "pos",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "neg",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// MemristorCircuitElement  AbstractCircuitElement (editor/visual layer)
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

    const vA = signals?.getPinVoltage("pos");
    const vB = signals?.getPinVoltage("neg");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Falstad MemristorElm: total width 4 grid units (64px ÷ 16).
    // calcLeads(32): lead1=(0,0), lead2=(3,0) in grid units (48px ÷ 16 = 3).
    // Body spans x=13 (16px leads on each end), hs=10px÷16=0.625 grid units.
    // Zigzag body: 4 full teeth, each 8px = 0.5 grid units wide.
    // Segment x positions (px ÷ 16): 1, 1.3125, 1.6875, 2, 2.3125, 2.6875, 3
    // (body subdivided into 8 half-teeth of 5px = 0.3125 grid units)

    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(0, 0, 4, 0, [
        { offset: 0, color: signals!.voltageColor(vA) },
        { offset: 1, color: signals!.voltageColor(vB) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }

    // Lead pos: (0,0)  (1,0)
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

    // Lead neg: (3,0)  (4,0)
    ctx.drawLine(3, 0, 4, 0);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

export function createMemristorElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): PoolBackedAnalogElement {
  return new MemristorElement(pinNodes, props);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const MEMRISTOR_PROPERTY_DEFS: PropertyDefinition[] = [
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

export const MemristorDefinition: StandaloneComponentDefinition = {
  name: "Memristor",
  typeId: -1,
  factory: memristorCircuitFactory,
  pinLayout: buildMemristorPinDeclarations(),
  propertyDefs: MEMRISTOR_PROPERTY_DEFS,
  attributeMap: MEMRISTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Memristor  Joglekar window function model.\n" +
    "Resistance depends on charge history (state variable w, 0-1).",
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
