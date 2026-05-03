/**
 * NTC Thermistor - negative temperature coefficient temperature-dependent resistor.
 *
 * Resistance model:
 *   B-parameter: R(T) = R0 * exp(B * (1/T - 1/T0))
 *   Steinhart-Hart (when shA/shB/shC all provided):
 *     1/T = A + B*ln(R) + C*(ln(R))^3
 *     Solved iteratively since R and T are mutually dependent.
 *
 * Self-heating thermal model (when selfHeating=true):
 *   dT/dt = (P_dissipated - (T - T_ambient) / R_thermal) / C_thermal
 *   where P = V^2 / R(T)
 *   Integrated with forward Euler each timestep at the bottom of load().
 *
 * MNA topology:
 *   _pinNodes["pos"] = n_pos
 *   _pinNodes["neg"] = n_neg
 *   branchIndex    = -1
 *
 * Unified load() pipeline:
 *   load(ctx)   stamps conductance 1/R(T) between terminals every NR iteration;
 *               bottom-of-load integrates thermal ODE reading s1, writing s0.
 */

import type { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { defineModelParams } from "../../core/model-params.js";
import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-12;
const MIN_TEMPERATURE = 1.0; // 1 K - prevent division by zero

// ---------------------------------------------------------------------------
// State-pool schema
// ---------------------------------------------------------------------------

export const NTC_SCHEMA = defineStateSchema("NTCThermistorElement", [
  { name: "TEMPERATURE", doc: "Operating temperature in Kelvin" },
]) satisfies StateSchema;

const SLOT_TEMPERATURE = 0;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: NTC_PARAM_DEFS, defaults: NTC_DEFAULTS } = defineModelParams({
  primary: {
    r0:          { default: 10000,  unit: "Ohm", description: "Resistance at reference temperature T0" },
    beta:        { default: 3950,   unit: "K",   description: "B-parameter (material constant) in Kelvin" },
    temperature: { default: 298.15, unit: "K",   description: "Operating temperature in Kelvin" },
  },
  secondary: {
    t0:                { default: 298.15, unit: "K",   description: "Reference temperature in Kelvin" },
    thermalResistance: { default: 50,     unit: "K/W", description: "Thermal resistance to ambient in K/W" },
    thermalCapacitance:{ default: 0.01,   unit: "J/K", description: "Thermal mass in J/K" },
  },
});

// ---------------------------------------------------------------------------
// Resistance computation
// ---------------------------------------------------------------------------

/**
 * Compute NTC resistance using the B-parameter model.
 *   R(T) = R0 * exp(B * (1/T - 1/T0))
 */
function bParameterResistance(r0: number, beta: number, t0: number, t: number): number {
  const tClamped = Math.max(t, MIN_TEMPERATURE);
  return r0 * Math.exp(beta * (1 / tClamped - 1 / t0));
}

/**
 * Compute NTC resistance using the Steinhart-Hart model.
 *   1/T = A + B*ln(R) + C*(ln(R))^3
 *
 * Given T, we invert numerically: binary-search R such that S-H gives back T.
 * Search range: [1 Ohm, 10 MOhm] covers all practical NTC values.
 */
function steinhartHartResistance(shA: number, shB: number, shC: number, t: number): number {
  const tClamped = Math.max(t, MIN_TEMPERATURE);
  const target = 1 / tClamped;

  // Binary search over ln(R)
  let lo = Math.log(1);        // ln(1 Ohm)
  let hi = Math.log(1e7);      // ln(10 MOhm)

  for (let iter = 0; iter < 60; iter++) {
    const mid = (lo + hi) / 2;
    const val = shA + shB * mid + shC * mid * mid * mid;
    if (val > target) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return Math.exp((lo + hi) / 2);
}

// ---------------------------------------------------------------------------
// NTCThermistorElement - MNA implementation
// ---------------------------------------------------------------------------

export class NTCThermistorElement implements PoolBackedAnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;
  readonly poolBacked = true as const;
  readonly stateSchema = NTC_SCHEMA;
  readonly stateSize = NTC_SCHEMA.size;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();

  private _hPP: number = -1; // (posNode, posNode) - ressetup.c:46
  private _hNN: number = -1; // (negNode, negNode) - ressetup.c:47
  private _hPN: number = -1; // (posNode, negNode) - ressetup.c:48
  private _hNP: number = -1; // (negNode, posNode) - ressetup.c:49

  private readonly _selfHeating: boolean;
  private readonly _shA: number | undefined;
  private readonly _shB: number | undefined;
  private readonly _shC: number | undefined;
  private _r0: number;
  private _beta: number;
  private _t0: number;
  private _tAmbient: number;
  private _rTh: number;
  private _cTh: number;

  private _pool!: StatePoolRef;

  /**
   * @param r0                  - Resistance at T0 in ohms
   * @param beta                - B-parameter in Kelvin
   * @param t0                  - Reference temperature in Kelvin
   * @param temperature         - Initial/fixed temperature in Kelvin
   * @param selfHeating         - Enable self-heating thermal model
   * @param thermalResistance   - K/W, thermal resistance to ambient
   * @param thermalCapacitance  - J/K, thermal mass
   * @param shA                 - Steinhart-Hart A coefficient (optional)
   * @param shB                 - Steinhart-Hart B coefficient (optional)
   * @param shC                 - Steinhart-Hart C coefficient (optional)
   */
  constructor(
    r0: number,
    beta: number,
    t0: number,
    temperature: number,
    selfHeating: boolean,
    thermalResistance: number,
    thermalCapacitance: number,
    shA?: number,
    shB?: number,
    shC?: number,
  ) {
    this._r0 = Math.max(r0, MIN_RESISTANCE);
    this._beta = beta;
    this._t0 = Math.max(t0, MIN_TEMPERATURE);
    this._tAmbient = Math.max(temperature, MIN_TEMPERATURE);
    this._rTh = Math.max(thermalResistance, 1e-6);
    this._cTh = Math.max(thermalCapacitance, 1e-12);
    this._selfHeating = selfHeating;
    this._shA = shA;
    this._shB = shB;
    this._shC = shC;
  }

  setup(ctx: SetupContext): void {
    if (this._stateBase === -1) {
      this._stateBase = ctx.allocStates(this.stateSize);
    }

    const solver = ctx.solver;
    const posNode = this._pinNodes.get("pos")!; // RESposNode
    const negNode = this._pinNodes.get("neg")!; // RESnegNode

    // TSTALLOC sequence: ressetup.c:46-49, line-for-line
    this._hPP = solver.allocElement(posNode, posNode); // :46 (RESposNode, RESposNode)
    this._hNN = solver.allocElement(negNode, negNode); // :47 (RESnegNode, RESnegNode)
    this._hPN = solver.allocElement(posNode, negNode); // :48 (RESposNode, RESnegNode)
    this._hNP = solver.allocElement(negNode, posNode); // :49 (RESnegNode, RESposNode)
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    // Seed temperature slot from ambient
    pool.state0[this._stateBase + SLOT_TEMPERATURE] = this._tAmbient;
  }

  setParam(key: string, value: number): void {
    if (key === "r0") this._r0 = Math.max(value, MIN_RESISTANCE);
    else if (key === "beta") this._beta = value;
    else if (key === "t0") this._t0 = Math.max(value, MIN_TEMPERATURE);
    else if (key === "temperature") this._tAmbient = Math.max(value, MIN_TEMPERATURE);
    else if (key === "thermalResistance") this._rTh = Math.max(value, 1e-6);
    else if (key === "thermalCapacitance") this._cTh = Math.max(value, 1e-12);
  }

  /** Compute resistance at the given temperature. */
  private computeRFromT(t: number): number {
    if (
      this._shA !== undefined &&
      this._shB !== undefined &&
      this._shC !== undefined
    ) {
      return Math.max(
        steinhartHartResistance(this._shA, this._shB, this._shC, t),
        MIN_RESISTANCE,
      );
    }
    return Math.max(
      bParameterResistance(this._r0, this._beta, this._t0, t),
      MIN_RESISTANCE,
    );
  }

  load(ctx: LoadContext): void {
    const base = this._stateBase;
    const s1 = this._pool.states[1];
    const s0 = this._pool.states[0];

    // In self-heating mode, T evolves dynamically and lives in the slot.
    // In non-self-heating mode, T = ambient — read from the live instance
    // field so setParam("temperature", ...) propagates without recompile.
    const tOld = this._selfHeating
      ? s1[base + SLOT_TEMPERATURE]
      : this._tAmbient;
    const rTerm = this.computeRFromT(tOld);
    const G = 1 / Math.max(rTerm, MIN_RESISTANCE);

    ctx.solver.stampElement(this._hPP,  G);
    ctx.solver.stampElement(this._hNN,  G);
    ctx.solver.stampElement(this._hPN, -G);
    ctx.solver.stampElement(this._hNP, -G);

    // ngspice CKTstate0 idiom - bjtload.c:744-746, dioload.c:325-326
    if (this._selfHeating) {
      const nPos = this._pinNodes.get("pos")!;
      const nNeg = this._pinNodes.get("neg")!;
      // ngspice DEVload reads CKTrhsOld (prior NR iterate) for stamp
      // stability across the iter loop; load-context.ts:79-82 + bjtload.c:208-209.
      const voltages = ctx.rhsOld;
      const vTerm = voltages[nPos] - voltages[nNeg];
      const pDiss = (vTerm * vTerm) / rTerm;
      const dt = ctx.dt ?? 0;
      const tNew = tOld + ((pDiss - (tOld - this._tAmbient) / this._rTh) / this._cTh) * dt;
      s0[base + SLOT_TEMPERATURE] = Math.max(tNew, MIN_TEMPERATURE);
    } else {
      // Track ambient so setParam("temperature") takes effect immediately.
      s0[base + SLOT_TEMPERATURE] = this._tAmbient;
    }
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const nPos = this._pinNodes.get("pos")!;
    const nNeg = this._pinNodes.get("neg")!;
    const vPos = rhs[nPos];
    const vNeg = rhs[nNeg];
    const s1 = this._pool.states[1];
    const tOld = s1[this._stateBase + SLOT_TEMPERATURE];
    const G = 1 / this.computeRFromT(tOld);
    const I = G * (vPos - vNeg);
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

export function createNTCThermistorElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): NTCThermistorElement {
  const r0 = props.getModelParam<number>("r0");
  const beta = props.getModelParam<number>("beta");
  const t0 = props.getModelParam<number>("t0");
  const temperature = props.getModelParam<number>("temperature");
  const selfHeating = props.getOrDefault<boolean>("selfHeating", false);
  const thermalResistance = props.getModelParam<number>("thermalResistance");
  const thermalCapacitance = props.getModelParam<number>("thermalCapacitance");
  const shA = props.has("shA") ? props.getOrDefault<number>("shA", 0) : undefined;
  const shB = props.has("shB") ? props.getOrDefault<number>("shB", 0) : undefined;
  const shC = props.has("shC") ? props.getOrDefault<number>("shC", 0) : undefined;
  const el = new NTCThermistorElement(
    r0,
    beta,
    t0,
    temperature,
    selfHeating,
    thermalResistance,
    thermalCapacitance,
    shA,
    shB,
    shC,
  );
  el._pinNodes = new Map(pinNodes);
  return el;
}

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

function buildNTCPinDeclarations(): PinDeclaration[] {
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
// NTCThermistorCircuitElement - editor/visual layer
// ---------------------------------------------------------------------------

export class NTCThermistorCircuitElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NTCThermistor", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildNTCPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.75,
      width: 4,
      height: 1.5,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._visibleLabel();

    const vPos = signals?.getPinVoltage("pos");
    const vNeg = signals?.getPinVoltage("neg");
    const hasVoltage = vPos !== undefined && vNeg !== undefined;

    ctx.save();
    ctx.setLineWidth(1);

    // Lead lines: (0,0)-(1,0) and (3,0)-(4,0)
    // Zigzag body spanning x=1-x=3, +-0.375gu amplitude
    const pts: Array<{ x: number; y: number }> = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1.125, y: 0.375 },
      { x: 1.375, y: -0.375 },
      { x: 1.625, y: 0.375 },
      { x: 1.875, y: -0.375 },
      { x: 2.125, y: 0.375 },
      { x: 2.375, y: -0.375 },
      { x: 2.625, y: 0.375 },
      { x: 2.875, y: -0.375 },
      { x: 3, y: 0 },
      { x: 4, y: 0 },
    ];

    // Zigzag gradient from pos-neg
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(0, 0, 4, 0, [
        { offset: 0, color: signals!.voltageColor(vPos!) },
        { offset: 1, color: signals!.voltageColor(vNeg!) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    for (let i = 0; i < pts.length - 1; i++) {
      ctx.drawLine(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    }

    // NTC hockey stick: horizontal then diagonal - temperature indicator decoration
    ctx.setColor("COMPONENT");
    ctx.drawLine(0.625, 0.75, 1.375, 0.75);
    ctx.drawLine(1.375, 0.75, 3, -0.75);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 0.5, 0.375, { horizontal: "center", vertical: "top" });
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const NTC_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "t0",
    type: PropertyType.FLOAT,
    label: "T0 (K)",
    defaultValue: 298.15,
    min: 1,
    description: "Reference temperature in Kelvin (default 25C = 298.15 K)",
  },
  {
    key: "selfHeating",
    type: PropertyType.BOOLEAN,
    label: "Self-Heating",
    defaultValue: false,
    description: "Enable thermal self-heating model",
  },
  {
    key: "thermalResistance",
    type: PropertyType.FLOAT,
    label: "Thermal Resistance (K/W)",
    defaultValue: 50,
    min: 1e-6,
    description: "Thermal resistance to ambient in K/W",
  },
  {
    key: "thermalCapacitance",
    type: PropertyType.FLOAT,
    label: "Thermal Capacitance (J/K)",
    defaultValue: 0.01,
    min: 1e-12,
    description: "Thermal mass in J/K",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional component label",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const NTC_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "r0", propertyKey: "r0", modelParam: true, convert: (v) => parseFloat(v) },
  { xmlName: "beta", propertyKey: "beta", modelParam: true, convert: (v) => parseFloat(v) },
  { xmlName: "t0", propertyKey: "t0", convert: (v) => parseFloat(v) },
  { xmlName: "temperature", propertyKey: "temperature", modelParam: true, convert: (v) => parseFloat(v) },
  { xmlName: "selfHeating", propertyKey: "selfHeating", convert: (v) => v === "true" },
  { xmlName: "thermalResistance", propertyKey: "thermalResistance", convert: (v) => parseFloat(v) },
  { xmlName: "thermalCapacitance", propertyKey: "thermalCapacitance", convert: (v) => parseFloat(v) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// NTCThermistorDefinition
// ---------------------------------------------------------------------------

function ntcCircuitFactory(props: PropertyBag): NTCThermistorCircuitElement {
  return new NTCThermistorCircuitElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const NTCThermistorDefinition: StandaloneComponentDefinition = {
  name: "NTCThermistor",
  typeId: -1,
  factory: ntcCircuitFactory,
  pinLayout: buildNTCPinDeclarations(),
  propertyDefs: NTC_PROPERTY_DEFS,
  attributeMap: NTC_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "NTC Thermistor - negative temperature coefficient resistor. " +
    "Resistance decreases exponentially with temperature (B-parameter model).",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createNTCThermistorElement,
      paramDefs: NTC_PARAM_DEFS,
      params: NTC_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
