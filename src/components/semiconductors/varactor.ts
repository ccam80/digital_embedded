/**
 * Varactor Diode analog component — voltage-controlled junction capacitance.
 *
 * Implements a diode optimized for its voltage-dependent depletion capacitance.
 * The primary behavior is the C-V characteristic, not the I-V.
 *
 * C-V model (standard depletion capacitance):
 *   C_j(V_R) = CJO / (1 + V_R / VJ)^M
 *
 * where V_R = -V_d is the reverse bias voltage (positive for reverse bias).
 *
 * Also models standard Shockley forward conduction (not the primary use case).
 * The capacitance companion model is updated every timestep as C changes with
 * the applied reverse bias.
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
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement, AnalogElementCore, IntegrationMethod } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
} from "../../solver/analog/integration.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Thermal voltage at 300 K (kT/q in volts). */
const VT = 0.02585;

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
// computeVaractorCapacitance — exported for tests
// ---------------------------------------------------------------------------

/**
 * Compute depletion capacitance for a varactor diode.
 *
 * Formula: C_j(V_R) = CJO / (1 + V_R / VJ)^M
 *
 * Where V_R = reverse bias voltage (positive for reverse-biased diode).
 * When V_R < 0 (forward bias), clamps to ensure denominator stays positive.
 *
 * @param vReverse - Reverse bias voltage V_R = -V_d (positive = reverse biased)
 * @param cjo      - Zero-bias junction capacitance (F)
 * @param vj       - Built-in potential (V), typically 0.7V
 * @param m        - Grading coefficient, typically 0.5 (abrupt junction)
 */
export function computeVaractorCapacitance(
  vReverse: number,
  cjo: number,
  vj: number,
  m: number,
): number {
  if (cjo <= 0) return 0;
  // Clamp to avoid singularity at V_R = -VJ (denominator = 0)
  const arg = Math.max(1 + vReverse / vj, 1e-4);
  return cjo / Math.pow(arg, m);
}

// ---------------------------------------------------------------------------
// createVaractorElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createVaractorElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const nodeAnode   = pinNodes.get("A")!; // anode (typically more negative in reverse bias)
  const nodeCathode = pinNodes.get("K")!; // cathode (typically more positive in reverse bias)

  const propsMap = props as unknown as Record<string, unknown>;
  const cjo: number = (propsMap["cjo"] as number) ?? 20e-12;
  const vj: number  = (propsMap["vj"] as number)  ?? 0.7;
  const m: number   = (propsMap["m"] as number)   ?? 0.5;
  const iS: number  = (propsMap["iS"] as number)  ?? 1e-14;
  const nParam = 1; // emission coefficient fixed at 1 for varactor

  const nVt = nParam * VT;
  const vcrit = nVt * Math.log(nVt / (iS * Math.SQRT2));

  // NR linearization state for diode I-V
  let _vd = 0; // junction voltage (positive = forward biased)
  let _geq = GMIN;
  let _ieq = 0;
  let _id = 0; // cached junction current for getPinCurrents

  // Capacitance companion model state
  let _capGeq = 0;
  let _capIeq = 0;
  let _vdPrev = NaN;
  let _capFirstCall = true;

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,

    stamp(solver: SparseSolver): void {
      // Stamp capacitance companion model (computed in stampCompanion)
      if (_capGeq !== 0 || _capIeq !== 0) {
        stampG(solver, nodeAnode,   nodeAnode,   _capGeq);
        stampG(solver, nodeAnode,   nodeCathode, -_capGeq);
        stampG(solver, nodeCathode, nodeAnode,   -_capGeq);
        stampG(solver, nodeCathode, nodeCathode, _capGeq);
        stampRHS(solver, nodeAnode,   -_capIeq);
        stampRHS(solver, nodeCathode, _capIeq);
      }
    },

    stampNonlinear(solver: SparseSolver): void {
      // Stamp Shockley diode Norton equivalent
      stampG(solver, nodeAnode,   nodeAnode,   _geq);
      stampG(solver, nodeAnode,   nodeCathode, -_geq);
      stampG(solver, nodeCathode, nodeAnode,   -_geq);
      stampG(solver, nodeCathode, nodeCathode, _geq);
      stampRHS(solver, nodeAnode,   -_ieq);
      stampRHS(solver, nodeCathode, _ieq);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const vA = nodeAnode   > 0 ? voltages[nodeAnode   - 1] : 0;
      const vC = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = vA - vC;

      // Apply pnjlim to prevent exponential runaway
      const vdLimited = pnjlim(vdRaw, _vd, nVt, vcrit);

      if (nodeAnode > 0) {
        voltages[nodeAnode - 1] = vC + vdLimited;
      }

      _vd = vdLimited;

      // Shockley equation linearized at operating point
      const expArg = Math.min(_vd / nVt, 700);
      const expVal = Math.exp(expArg);
      const id = iS * (expVal - 1);
      _id = id;
      _geq = (iS * expVal) / nVt + GMIN;
      _ieq = id - _geq * _vd;
    },

    stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
      const vA = nodeAnode   > 0 ? voltages[nodeAnode   - 1] : 0;
      const vC = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vNow = vA - vC;

      // Reverse bias voltage: V_R = -V_d (positive when reverse biased)
      const vReverse = -vNow;
      const Cj = computeVaractorCapacitance(vReverse, cjo, vj, m);

      // Recover previous capacitor current for trapezoidal history
      const iNow = _capGeq * vNow + _capIeq;
      const vPrevForFormula = _capFirstCall ? vNow : _vdPrev;
      _vdPrev = vNow;
      _capFirstCall = false;

      _capGeq = capacitorConductance(Cj, dt, method);
      _capIeq = capacitorHistoryCurrent(Cj, dt, method, vNow, vPrevForFormula, iNow);
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      const vA  = nodeAnode   > 0 ? voltages[nodeAnode   - 1]     : 0;
      const vC  = nodeCathode > 0 ? voltages[nodeCathode - 1]     : 0;
      const vAp = nodeAnode   > 0 ? prevVoltages[nodeAnode   - 1] : 0;
      const vCp = nodeCathode > 0 ? prevVoltages[nodeCathode - 1] : 0;
      return Math.abs((vA - vC) - (vAp - vCp)) <= 2 * nVt;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      const vA = nodeAnode   > 0 ? voltages[nodeAnode   - 1] : 0;
      const vC = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vd = vA - vC;
      const iDiode = _id;
      const iCap = _capGeq * vd + _capIeq;
      const I = iDiode + iCap;
      return [I, -I];
    },
  };
}

// ---------------------------------------------------------------------------
// VaractorElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class VaractorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("VaractorDiode", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildVaractorPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.5,
      width: 4,
      height: 1,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._visibleLabel();

    const vA = signals?.getPinVoltage("A");
    const vK = signals?.getPinVoltage("K");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Anode lead
    if (signals && vA !== undefined) {
      ctx.setRawColor(signals.voltageColor(vA));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, 1.5, 0);

    // Cathode lead
    if (signals && vK !== undefined) {
      ctx.setRawColor(signals.voltageColor(vK));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(2.5, 0, 4, 0);

    // Body (triangle, plate bars) stays COMPONENT color
    ctx.setColor("COMPONENT");

    // Diode triangle: tip at platef=0.6 along lead1(1.5)→lead2(2.5) = x:2.1
    const hs = 0.5;
    ctx.drawPolygon([
      { x: 1.5, y: -hs },
      { x: 1.5, y: hs },
      { x: 2.1, y: 0 },
    ], true);

    // plate1 bar at x=2.1 (arrowTip)
    ctx.drawLine(2.1, -hs, 2.1, hs);
    // plate2 bar at x=2.5 (lead2)
    ctx.drawLine(2.5, -hs, 2.5, hs);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 2, -0.75, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Varactor Diode — voltage-controlled junction capacitance.\n" +
      "C_j(V_R) = CJO / (1 + V_R/VJ)^M\n" +
      "Used for voltage-controlled oscillators and tuned circuits."
    );
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildVaractorPinDeclarations(): PinDeclaration[] {
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
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const VARACTOR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
  {
    key: "cjo",
    type: PropertyType.FLOAT,
    label: "CJO (F)",
    defaultValue: 20e-12,
    description: "Zero-bias junction capacitance",
  },
  {
    key: "vj",
    type: PropertyType.FLOAT,
    label: "VJ (V)",
    defaultValue: 0.7,
    description: "Junction built-in potential",
  },
  {
    key: "m",
    type: PropertyType.FLOAT,
    label: "M (grading coeff)",
    defaultValue: 0.5,
    description: "Junction grading coefficient (0.5 = abrupt junction)",
  },
  {
    key: "iS",
    type: PropertyType.FLOAT,
    label: "I_S (A)",
    defaultValue: 1e-14,
    description: "Reverse saturation current",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const VARACTOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "cjo",   propertyKey: "cjo",   convert: (v) => parseFloat(v) },
  { xmlName: "vj",    propertyKey: "vj",    convert: (v) => parseFloat(v) },
  { xmlName: "m",     propertyKey: "m",     convert: (v) => parseFloat(v) },
];

// ---------------------------------------------------------------------------
// VaractorDefinition
// ---------------------------------------------------------------------------

function varactorCircuitFactory(props: PropertyBag): VaractorElement {
  return new VaractorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const VaractorDefinition: ComponentDefinition = {
  name: "VaractorDiode",
  typeId: -1,
  factory: varactorCircuitFactory,
  pinLayout: buildVaractorPinDeclarations(),
  propertyDefs: VARACTOR_PROPERTY_DEFS,
  attributeMap: VARACTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Varactor Diode — voltage-controlled junction capacitance.\n" +
    "C_j(V_R) = CJO / (1 + V_R/VJ)^M\n" +
    "Used for voltage-controlled oscillators and tuned circuits.",
  models: {
    analog: {
      factory: createVaractorElement,
      deviceType: "D",
    },
  },
};
