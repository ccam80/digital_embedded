/**
 * NTC Thermistor — negative temperature coefficient temperature-dependent resistor.
 *
 * Resistance model:
 *   B-parameter: R(T) = R₀ · exp(B · (1/T - 1/T₀))
 *   Steinhart-Hart (when shA/shB/shC all provided):
 *     1/T = A + B·ln(R) + C·(ln(R))³
 *     Solved iteratively since R and T are mutually dependent.
 *
 * Self-heating thermal model (when selfHeating=true):
 *   dT/dt = (P_dissipated - (T - T_ambient) / R_thermal) / C_thermal
 *   where P = V² / R(T)
 *   Integrated with forward Euler each accepted timestep via updateState().
 *
 * MNA topology:
 *   pinNodeIds[0] = n_pos
 *   pinNodeIds[1] = n_neg
 *   branchIndex    = -1
 *
 * Stamping:
 *   stamp()         — no-op (conductance is temperature-dependent)
 *   stampNonlinear  — stamps conductance 1/R(T) between terminals
 *   updateState     — integrates thermal ODE if selfHeating enabled
 */

import type { AnalogElement, AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-12;
const MIN_TEMPERATURE = 1.0; // 1 K — prevent division by zero

// ---------------------------------------------------------------------------
// Resistance computation
// ---------------------------------------------------------------------------

/**
 * Compute NTC resistance using the B-parameter model.
 *   R(T) = R₀ · exp(B · (1/T - 1/T₀))
 */
function bParameterResistance(r0: number, beta: number, t0: number, t: number): number {
  const tClamped = Math.max(t, MIN_TEMPERATURE);
  return r0 * Math.exp(beta * (1 / tClamped - 1 / t0));
}

/**
 * Compute NTC resistance using the Steinhart-Hart model.
 *   1/T = A + B·ln(R) + C·(ln(R))³
 *
 * Given T, we invert numerically: binary-search R such that S-H gives back T.
 * Search range: [1 Ω, 10 MΩ] — covers all practical NTC values.
 */
function steinhartHartResistance(shA: number, shB: number, shC: number, t: number): number {
  const tClamped = Math.max(t, MIN_TEMPERATURE);
  const target = 1 / tClamped;

  // Binary search over ln(R)
  let lo = Math.log(1);        // ln(1 Ω)
  let hi = Math.log(1e7);      // ln(10 MΩ)

  for (let iter = 0; iter < 60; iter++) {
    const mid = (lo + hi) / 2;
    const val = shA + shB * mid + shC * mid * mid * mid;
    if (val > target) {
      hi = mid; // 1/T too large → ln(R) too large → reduce upper bound
    } else {
      lo = mid;
    }
  }

  return Math.exp((lo + hi) / 2);
}

// ---------------------------------------------------------------------------
// NTCThermistorElement — MNA implementation
// ---------------------------------------------------------------------------

export class NTCThermistorElement implements AnalogElementCore {
  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean;

  private readonly _r0: number;
  private readonly _beta: number;
  private readonly _t0: number;
  private readonly _selfHeating: boolean;
  private readonly _thermalResistance: number;
  private readonly _thermalCapacitance: number;
  private readonly _shA: number | undefined;
  private readonly _shB: number | undefined;
  private readonly _shC: number | undefined;

  /** Current temperature in Kelvin. */
  private _temperature: number;

  /**
   * @param r0                  - Resistance at T₀ in ohms
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
    this._temperature = Math.max(temperature, MIN_TEMPERATURE);
    this._selfHeating = selfHeating;
    this._thermalResistance = Math.max(thermalResistance, 1e-6);
    this._thermalCapacitance = Math.max(thermalCapacitance, 1e-12);
    this._shA = shA;
    this._shB = shB;
    this._shC = shC;
    // isReactive is true when self-heating is enabled because the element has
    // dynamic state that evolves with the simulation timestep.
    this.isReactive = selfHeating;
  }

  /** Compute resistance at the current temperature. */
  resistance(): number {
    if (
      this._shA !== undefined &&
      this._shB !== undefined &&
      this._shC !== undefined
    ) {
      return Math.max(
        steinhartHartResistance(this._shA, this._shB, this._shC, this._temperature),
        MIN_RESISTANCE,
      );
    }
    return Math.max(
      bParameterResistance(this._r0, this._beta, this._t0, this._temperature),
      MIN_RESISTANCE,
    );
  }

  /** Current temperature in Kelvin — exposed for testing. */
  get temperature(): number {
    return this._temperature;
  }

  stamp(_solver: SparseSolver): void {
    // All conductance is in stampNonlinear (resistance depends on temperature).
  }

  stampNonlinear(solver: SparseSolver): void {
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];

    const G = 1 / this.resistance();

    if (nPos !== 0 && nNeg !== 0) {
      solver.stamp(nPos - 1, nPos - 1, G);
      solver.stamp(nPos - 1, nNeg - 1, -G);
      solver.stamp(nNeg - 1, nPos - 1, -G);
      solver.stamp(nNeg - 1, nNeg - 1, G);
    } else if (nPos !== 0) {
      solver.stamp(nPos - 1, nPos - 1, G);
    } else if (nNeg !== 0) {
      solver.stamp(nNeg - 1, nNeg - 1, G);
    }
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];
    const vPos = nPos > 0 ? voltages[nPos - 1] : 0;
    const vNeg = nNeg > 0 ? voltages[nNeg - 1] : 0;
    const G = 1 / this.resistance();
    const I = G * (vPos - vNeg);
    return [I, -I];
  }

  updateState(dt: number, voltages: Float64Array): void {
    if (!this._selfHeating) return;

    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];
    const vPos = nPos > 0 ? voltages[nPos - 1] : 0;
    const vNeg = nNeg > 0 ? voltages[nNeg - 1] : 0;
    const vDiff = vPos - vNeg;

    const R = this.resistance();
    const P = (vDiff * vDiff) / Math.max(R, MIN_RESISTANCE);

    // Ambient temperature = initial temperature when selfHeating is enabled.
    // The component treats _t0 as the ambient temperature for the thermal model.
    const tAmbient = this._t0;
    const dT = (P - (this._temperature - tAmbient) / this._thermalResistance) / this._thermalCapacitance;
    this._temperature = Math.max(this._temperature + dT * dt, MIN_TEMPERATURE);
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

export function createNTCThermistorElement(
  _pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElementCore {
  const r0 = props.getOrDefault<number>("r0", 10000);
  const beta = props.getOrDefault<number>("beta", 3950);
  const t0 = props.getOrDefault<number>("t0", 298.15);
  const temperature = props.getOrDefault<number>("temperature", 298.15);
  const selfHeating = props.getOrDefault<boolean>("selfHeating", false);
  const thermalResistance = props.getOrDefault<number>("thermalResistance", 50);
  const thermalCapacitance = props.getOrDefault<number>("thermalCapacitance", 0.01);
  const shA = props.has("shA") ? props.getOrDefault<number>("shA", 0) : undefined;
  const shB = props.has("shB") ? props.getOrDefault<number>("shB", 0) : undefined;
  const shC = props.has("shC") ? props.getOrDefault<number>("shC", 0) : undefined;
  return new NTCThermistorElement(
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
    },
    {
      direction: PinDirection.OUTPUT,
      label: "neg",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// NTCThermistorCircuitElement — editor/visual layer
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

    // Lead lines: (0,0)→(1,0) and (3,0)→(4,0)
    // Zigzag body spanning x=1→x=3, ±0.375gu amplitude
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

    // Zigzag gradient from pos→neg
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

    // NTC hockey stick: horizontal then diagonal — temperature indicator decoration
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
    key: "r0",
    type: PropertyType.FLOAT,
    label: "R₀ (Ω)",
    defaultValue: 10000,
    min: 1e-6,
    description: "Resistance at reference temperature T₀",
  },
  {
    key: "beta",
    type: PropertyType.FLOAT,
    label: "Beta (K)",
    defaultValue: 3950,
    min: 1,
    description: "B-parameter (material constant) in Kelvin",
  },
  {
    key: "t0",
    type: PropertyType.FLOAT,
    label: "T₀ (K)",
    defaultValue: 298.15,
    min: 1,
    description: "Reference temperature in Kelvin (default 25°C = 298.15 K)",
  },
  {
    key: "temperature",
    type: PropertyType.FLOAT,
    label: "Temperature (K)",
    defaultValue: 298.15,
    min: 1,
    description: "Operating temperature in Kelvin (used when self-heating is disabled)",
  },
  {
    key: "selfHeating",
    type: PropertyType.BOOL,
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
  { xmlName: "r0", propertyKey: "r0", convert: (v) => parseFloat(v) },
  { xmlName: "beta", propertyKey: "beta", convert: (v) => parseFloat(v) },
  { xmlName: "t0", propertyKey: "t0", convert: (v) => parseFloat(v) },
  { xmlName: "temperature", propertyKey: "temperature", convert: (v) => parseFloat(v) },
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

export const NTCThermistorDefinition: ComponentDefinition = {
  name: "NTCThermistor",
  typeId: -1,
  factory: ntcCircuitFactory,
  pinLayout: buildNTCPinDeclarations(),
  propertyDefs: NTC_PROPERTY_DEFS,
  attributeMap: NTC_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "NTC Thermistor — negative temperature coefficient resistor. " +
    "Resistance decreases exponentially with temperature (B-parameter model).",
  models: { analog: { factory: createNTCThermistorElement } },
};
