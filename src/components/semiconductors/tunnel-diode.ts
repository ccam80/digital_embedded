/**
 * Tunnel Diode analog component — N-shaped I-V curve with NDR region.
 *
 * Implements the tunnel diode I-V model:
 *   I_tunnel(V) = I_p * (V/V_p) * exp(1 - V/V_p)           (peak at V_p)
 *   I_excess(V) = I_v * exp((V - V_v) / V_x)               (exponential rise past valley)
 *   I_thermal(V) = I_S * (exp(V / (N*V_T)) - 1)            (standard Shockley)
 *   I(V) = I_tunnel(V) + I_excess(V) + I_thermal(V)
 *
 * The characteristic N-shaped curve has:
 *   - Peak current I_p at V_p (tunnel peak)
 *   - Valley current I_v at V_v (minimum between peak and normal forward)
 *   - Negative differential resistance (NDR) region: V_p < V < V_v
 *   - Normal forward conduction for V > V_v
 *
 * NR convergence in NDR region: voltage steps are clamped to 0.1V per
 * iteration to prevent oscillation between the peak and valley.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement, AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Thermal voltage at 300 K (kT/q in volts). */
const VT = 0.02585;

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

/** Excess current voltage scale (V_x in spec). Determines rise rate past valley. */
const VX = 0.1;

/** Standard diode saturation current for thermal component. */
const IS_THERMAL = 1e-14;

/** Maximum voltage step per NR iteration in or near NDR region. */
const NDR_VSTEP_MAX = 0.1;


// ---------------------------------------------------------------------------
// tunnelDiodeIV — compute I(V) and dI/dV for the tunnel diode model
// ---------------------------------------------------------------------------

/**
 * Compute tunnel diode current and differential conductance at voltage V.
 *
 * @param v   - Junction voltage (V)
 * @param ip  - Peak tunnel current (A)
 * @param vp  - Peak voltage (V)
 * @param iv  - Valley current (A)
 * @param vv  - Valley voltage (V)
 * @returns { i, dIdV } — current and differential conductance
 */
export function tunnelDiodeIV(
  v: number,
  ip: number,
  vp: number,
  iv: number,
  vv: number,
): { i: number; dIdV: number } {
  // --- Tunnel current component ---
  // I_t(V) = I_p * (V/V_p) * exp(1 - V/V_p)
  const uT = v / vp;
  const expT = Math.exp(Math.min(1 - uT, 700));
  const iTunnel = ip * uT * expT;
  // dI_t/dV = I_p/V_p * exp(1 - V/V_p) * (1 - V/V_p)
  //         = (I_p/V_p) * expT * (1 - uT)
  const dITunnel = (ip / vp) * expT * (1 - uT);

  // --- Excess current component ---
  // I_x(V) = I_v * exp((V - V_v) / V_x)
  const excessArg = (v - vv) / VX;
  const expX = Math.exp(Math.min(excessArg, 700));
  const iExcess = iv * expX;
  // dI_x/dV = I_v / V_x * exp((V - V_v) / V_x)
  const dIExcess = (iv / VX) * expX;

  // --- Thermal (Shockley) component ---
  const thermalArg = Math.min(v / VT, 700);
  const expTh = Math.exp(thermalArg);
  const iThermal = IS_THERMAL * (expTh - 1);
  // dI_thermal/dV = IS / VT * exp(V/VT)
  const dIThermal = (IS_THERMAL * expTh) / VT;

  const i = iTunnel + iExcess + iThermal;
  const dIdV = dITunnel + dIExcess + dIThermal + GMIN;

  return { i, dIdV };
}

// ---------------------------------------------------------------------------
// createTunnelDiodeElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createTunnelDiodeElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const nodeAnode   = pinNodes.get("A")!;
  const nodeCathode = pinNodes.get("K")!;

  const ip: number = props.getOrDefault<number>("ip", 5e-3);
  const vp: number = props.getOrDefault<number>("vp", 0.08);
  const iv: number = props.getOrDefault<number>("iv", 0.5e-3);
  const vv: number = props.getOrDefault<number>("vv", 0.5);

  // NR linearization state
  let _vd = 0;
  let _geq = GMIN;
  let _ieq = 0;
  let _id = 0; // cached junction current for getPinCurrents

  function recompute(v: number): void {
    const { i, dIdV } = tunnelDiodeIV(v, ip, vp, iv, vv);
    _id = i;
    _geq = dIdV; // dI/dV is the conductance (can be negative in NDR)
    _ieq = i - _geq * v;
  }

  function isInNdrRegion(v: number): boolean {
    return v > vp * 0.8 && v < vv * 1.2;
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // No topology-constant contributions
    },

    stampNonlinear(solver: SparseSolver): void {
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

      // Voltage limiting in or near NDR region: clamp step to NDR_VSTEP_MAX
      // This prevents NR from jumping across the negative-resistance valley.
      let vdNew: number;
      if (isInNdrRegion(_vd) || isInNdrRegion(vdRaw)) {
        const step = vdRaw - _vd;
        if (Math.abs(step) > NDR_VSTEP_MAX) {
          vdNew = _vd + Math.sign(step) * NDR_VSTEP_MAX;
        } else {
          vdNew = vdRaw;
        }
      } else {
        vdNew = vdRaw;
      }

      // Write limited voltage back
      if (nodeAnode > 0) {
        voltages[nodeAnode - 1] = vC + vdNew;
      }

      _vd = vdNew;
      recompute(_vd);
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      const vA  = nodeAnode   > 0 ? voltages[nodeAnode   - 1]     : 0;
      const vC  = nodeCathode > 0 ? voltages[nodeCathode - 1]     : 0;
      const vAp = nodeAnode   > 0 ? prevVoltages[nodeAnode   - 1] : 0;
      const vCp = nodeCathode > 0 ? prevVoltages[nodeCathode - 1] : 0;
      const dvd = Math.abs((vA - vC) - (vAp - vCp));
      // Tighter tolerance in NDR region
      const tol = isInNdrRegion(_vd) ? NDR_VSTEP_MAX * 0.01 : 2 * VT;
      return dvd <= tol;
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      // pinLayout order: [A (anode), K (cathode)]
      // Positive = current flowing INTO element at that pin.
      return [_id, -_id];
    },
  };
}

// ---------------------------------------------------------------------------
// TunnelDiodeElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class TunnelDiodeElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("TunnelDiode", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTunnelDiodePinDeclarations(), []);
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
    drawColoredLead(ctx, signals, vA, 0, 0, 1.5, 0);

    // Cathode lead
    drawColoredLead(ctx, signals, vK, 2.5, 0, 4, 0);

    // Body (triangle, cathode bar, T-wings) stays COMPONENT color
    ctx.setColor("COMPONENT");

    // Diode triangle (anode left, cathode right)
    ctx.drawPolygon([
      { x: 1.5, y: -0.5 },
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 0 },
    ], true);

    // Cathode bar
    ctx.drawLine(2.5, -0.5, 2.5, 0.5);
    // T-wings: cath2={2.3,-0.5}→cath0={2.5,-0.5}; cath3={2.3,0.5}→cath1={2.5,0.5}
    ctx.drawLine(2.3, -0.5, 2.5, -0.5);
    ctx.drawLine(2.3,  0.5, 2.5,  0.5);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 2, -0.75, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTunnelDiodePinDeclarations(): PinDeclaration[] {
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

const TUNNEL_DIODE_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
  {
    key: "ip",
    type: PropertyType.FLOAT,
    label: "I_p (A)",
    defaultValue: 5e-3,
    description: "Peak tunnel current",
  },
  {
    key: "vp",
    type: PropertyType.FLOAT,
    label: "V_p (V)",
    defaultValue: 0.08,
    description: "Peak voltage",
  },
  {
    key: "iv",
    type: PropertyType.FLOAT,
    label: "I_v (A)",
    defaultValue: 0.5e-3,
    description: "Valley current",
  },
  {
    key: "vv",
    type: PropertyType.FLOAT,
    label: "V_v (V)",
    defaultValue: 0.5,
    description: "Valley voltage",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TUNNEL_DIODE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "ip",    propertyKey: "ip",    convert: (v) => parseFloat(v) },
  { xmlName: "vp",    propertyKey: "vp",    convert: (v) => parseFloat(v) },
  { xmlName: "iv",    propertyKey: "iv",    convert: (v) => parseFloat(v) },
  { xmlName: "vv",    propertyKey: "vv",    convert: (v) => parseFloat(v) },
];

// ---------------------------------------------------------------------------
// TunnelDiodeDefinition
// ---------------------------------------------------------------------------

function tunnelDiodeCircuitFactory(props: PropertyBag): TunnelDiodeElement {
  return new TunnelDiodeElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TunnelDiodeDefinition: ComponentDefinition = {
  name: "TunnelDiode",
  typeId: -1,
  factory: tunnelDiodeCircuitFactory,
  pinLayout: buildTunnelDiodePinDeclarations(),
  propertyDefs: TUNNEL_DIODE_PROPERTY_DEFS,
  attributeMap: TUNNEL_DIODE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Tunnel Diode — N-shaped I-V curve with negative differential resistance.\n" +
    "Peak current I_p at V_p, valley current I_v at V_v.\n" +
    "NDR region: V_p < V < V_v.",
  models: {
    analog: {
      factory: createTunnelDiodeElement,
      deviceType: "TUNNEL",
    },
  },
};
