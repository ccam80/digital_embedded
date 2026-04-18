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
 *
 * When CJO > 0 or TT > 0, junction capacitance is added via stampCompanion().
 * The diffusion conductance uses the total dI/dV from tunnelDiodeIV (all
 * current components), not just the Shockley term.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { PoolBackedAnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import type { IntegrationMethod } from "../../solver/analog/element.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import {
  computeJunctionCapacitance,
  computeJunctionCharge,
} from "./diode.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { VT } from "../../core/constants.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

// VT (thermal voltage) imported from ../../core/constants.js

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

/** Excess current voltage scale (V_x in spec). Determines rise rate past valley. */
const VX = 0.1;

/** Maximum voltage step per NR iteration in or near NDR region. */
const NDR_VSTEP_MAX = 0.1;

/** Thermal saturation current (A) — default for Shockley component. */
const IS_THERMAL = 1e-14;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TUNNEL_DIODE_PARAM_DEFS, defaults: TUNNEL_DIODE_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    IP: { default: 1e-3,  unit: "A", description: "Peak tunnel current" },
    VP: { default: 0.065, unit: "V", description: "Peak voltage" },
    IV: { default: 1e-4,  unit: "A", description: "Valley current" },
    VV: { default: 0.35,  unit: "V", description: "Valley voltage" },
  },
  secondary: {
    IS:  { default: 1e-14, unit: "A", description: "Shockley saturation current" },
    N:   { default: 1,                description: "Emission coefficient" },
    CJO: { default: 0,    unit: "F",  description: "Zero-bias junction capacitance" },
    VJ:  { default: 1,    unit: "V",  description: "Junction built-in potential" },
    M:   { default: 0.5,              description: "Grading coefficient" },
    TT:  { default: 0,    unit: "s",  description: "Transit time" },
    FC:  { default: 0.5,              description: "Forward-bias capacitance coefficient" },
  },
});

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
  iS: number = IS_THERMAL,
  nCoeff: number = 1,
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
  const nVt = nCoeff * VT;
  const thermalArg = Math.min(v / nVt, 700);
  const expTh = Math.exp(thermalArg);
  const iThermal = iS * (expTh - 1);
  // dI_thermal/dV = IS / (N*VT) * exp(V/(N*VT))
  const dIThermal = (iS * expTh) / nVt;

  const i = iTunnel + iExcess + iThermal;
  const dIdV = dITunnel + dIExcess + dIThermal + GMIN;

  return { i, dIdV };
}

// ---------------------------------------------------------------------------
// State schema declarations
// ---------------------------------------------------------------------------

// Slot index constants — shared between both schema variants.
const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3;
const SLOT_CAP_GEQ = 4, SLOT_CAP_IEQ = 5, SLOT_V = 6, SLOT_Q = 7;
const SLOT_CCAP = 8;

/** Schema for resistive tunnel diode (no junction capacitance): 4 slots. */
const TUNNEL_DIODE_STATE_SCHEMA = defineStateSchema("TunnelDiodeElement", [
  { name: "VD",  doc: "Tunnel diode junction voltage (V)",    init: { kind: "zero" } },
  { name: "GEQ", doc: "Differential conductance (S)",         init: { kind: "constant", value: 1e-12 } },
  { name: "IEQ", doc: "Linearized current source (A)",        init: { kind: "zero" } },
  { name: "ID",  doc: "Diode current (A)",                    init: { kind: "zero" } },
]);

/** Schema for capacitive tunnel diode (CJO > 0 or TT > 0): 9 slots. */
const TUNNEL_DIODE_CAP_STATE_SCHEMA = defineStateSchema("TunnelDiodeElement_cap", [
  { name: "VD",      doc: "Tunnel diode junction voltage (V)",                      init: { kind: "zero" } },
  { name: "GEQ",     doc: "Differential conductance (S)",                           init: { kind: "constant", value: 1e-12 } },
  { name: "IEQ",     doc: "Linearized current source (A)",                          init: { kind: "zero" } },
  { name: "ID",      doc: "Diode current (A)",                                      init: { kind: "zero" } },
  { name: "CAP_GEQ", doc: "Junction-capacitance companion conductance",             init: { kind: "zero" } },
  { name: "CAP_IEQ", doc: "Junction-capacitance companion history current",         init: { kind: "zero" } },
  { name: "V",       doc: "Junction voltage at current step (for companion)",       init: { kind: "zero" } },
  { name: "Q",       doc: "Junction charge at current step (history from s1/s2/s3)", init: { kind: "zero" } },
  { name: "CCAP",    doc: "Companion current (NIintegrate)",                        init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// createTunnelDiodeElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createTunnelDiodeElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): PoolBackedAnalogElementCore {
  const nodeAnode   = pinNodes.get("A")!;
  const nodeCathode = pinNodes.get("K")!;

  function readParam(key: string): number {
    if (props.hasModelParam(key)) return props.getModelParam<number>(key);
    return TUNNEL_DIODE_PARAM_DEFAULTS[key] as number;
  }

  const params: Record<string, number> = {
    IP:  readParam("IP"),
    VP:  readParam("VP"),
    IV:  readParam("IV"),
    VV:  readParam("VV"),
    IS:  readParam("IS"),
    N:   readParam("N"),
    CJO: readParam("CJO"),
    VJ:  readParam("VJ"),
    M:   readParam("M"),
    TT:  readParam("TT"),
    FC:  readParam("FC"),
  };

  const hasCapacitance = params.CJO > 0 || params.TT > 0;

  // Pool binding — set by initState
  let s0: Float64Array;
  let s1: Float64Array;
  let s2: Float64Array;
  let s3: Float64Array;
  let base: number;
  let pool: StatePoolRef;

  function recompute(v: number): void {
    const { i, dIdV } = tunnelDiodeIV(v, params.IP, params.VP, params.IV, params.VV, params.IS, params.N);
    // dIdV already includes GMIN from tunnelDiodeIV; add GMIN*v to current (DD5)
    s0[base + SLOT_ID] = i + GMIN * v;
    s0[base + SLOT_GEQ] = dIdV;
    s0[base + SLOT_IEQ] = (i + GMIN * v) - dIdV * v;
  }

  function isInNdrRegion(v: number): boolean {
    return v > params.VP * 0.8 && v < params.VV * 1.2;
  }

  const element: PoolBackedAnalogElementCore = {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: hasCapacitance,
    poolBacked: true as const,
    stateSize: hasCapacitance ? 9 : 4,
    stateSchema: hasCapacitance ? TUNNEL_DIODE_CAP_STATE_SCHEMA : TUNNEL_DIODE_STATE_SCHEMA,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      s0 = pool.state0;
      s1 = pool.state1;
      s2 = pool.state2;
      s3 = pool.state3;
      this.s0 = s0;
      this.s1 = s1;
      this.s2 = s2;
      this.s3 = s3;
      base = this.stateBaseOffset;
      applyInitialValues(this.stateSchema, pool, base, params);
    },

    refreshSubElementRefs(newS0: Float64Array, newS1: Float64Array, newS2: Float64Array, newS3: Float64Array): void {
      s0 = newS0;
      s1 = newS1;
      s2 = newS2;
      s3 = newS3;
    },

    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;
      const vA = nodeAnode   > 0 ? voltages[nodeAnode   - 1] : 0;
      const vC = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = vA - vC;

      // Voltage limiting in or near NDR region: clamp step to NDR_VSTEP_MAX
      // This prevents NR from jumping across the negative-resistance valley.
      const vdOld = s0[base + SLOT_VD];
      let vdNew: number;
      let limited = false;
      if (isInNdrRegion(vdOld) || isInNdrRegion(vdRaw)) {
        const step = vdRaw - vdOld;
        if (Math.abs(step) > NDR_VSTEP_MAX) {
          vdNew = vdOld + Math.sign(step) * NDR_VSTEP_MAX;
          limited = true;
        } else {
          vdNew = vdRaw;
        }
      } else {
        vdNew = vdRaw;
      }

      if (limited) ctx.noncon.value++;

      s0[base + SLOT_VD] = vdNew;
      recompute(vdNew);

      const geq = s0[base + SLOT_GEQ];
      const ieq = s0[base + SLOT_IEQ];
      const solver = ctx.solver;
      stampG(solver, nodeAnode,   nodeAnode,   geq);
      stampG(solver, nodeAnode,   nodeCathode, -geq);
      stampG(solver, nodeCathode, nodeAnode,   -geq);
      stampG(solver, nodeCathode, nodeCathode, geq);
      stampRHS(solver, nodeAnode,   -ieq);
      stampRHS(solver, nodeCathode, ieq);

      // Reactive companion: junction capacitance + transit-time diffusion cap
      if (hasCapacitance && ctx.isTransient) {
        const dt = ctx.dt;
        const order = ctx.order;
        const method = ctx.method;
        const deltaOld = ctx.deltaOld;

        const Cj = computeJunctionCapacitance(vdNew, params.CJO, params.VJ, params.M, params.FC);
        const { dIdV: gDiode, i: iNowDiode } = tunnelDiodeIV(vdNew, params.IP, params.VP, params.IV, params.VV, params.IS, params.N);
        const Ct = params.TT * gDiode;
        const Ctotal = Cj + Ct;

        const q0 = computeJunctionCharge(vdNew, params.CJO, params.VJ, params.M, params.FC, params.TT, iNowDiode);
        const q1 = s1[base + SLOT_Q];
        const q2 = s2[base + SLOT_Q];
        const ccapPrev = s1[base + SLOT_CCAP];
        const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
        // Inline NIintegrate (niinteg.c:28-63). Mapping: ag[]=ctx.ag, q0/q1/q2=charges, ccapPrev=ccap at prev step.
        // geq = ag[0] * Ctotal
        // ccap = ag[0]*q0 + ag[1]*q1 + ag[2]*q2 (order terms)
        // ceq  = ccap - geq * vdNew
        const ag = ctx.ag;
        let ccap = ag[0] * q0 + ag[1] * q1;
        if (order >= 2 && method !== "trapezoidal") ccap += ag[2] * q2;
        const capGeq = ag[0] * Ctotal;
        const capIeq = ccap - capGeq * vdNew;
        s0[base + SLOT_CAP_GEQ] = capGeq;
        s0[base + SLOT_CAP_IEQ] = capIeq;
        s0[base + SLOT_V] = vdNew;
        s0[base + SLOT_Q] = q0;
        s0[base + SLOT_CCAP] = ccap;

        if (capGeq !== 0 || capIeq !== 0) {
          stampG(solver, nodeAnode,   nodeAnode,   capGeq);
          stampG(solver, nodeAnode,   nodeCathode, -capGeq);
          stampG(solver, nodeCathode, nodeAnode,   -capGeq);
          stampG(solver, nodeCathode, nodeCathode, capGeq);
          stampRHS(solver, nodeAnode,   -capIeq);
          stampRHS(solver, nodeCathode, capIeq);
        }
      }
    },

    checkConvergence(ctx: LoadContext): boolean {
      const voltages = ctx.voltages;
      const vA = nodeAnode   > 0 ? voltages[nodeAnode   - 1] : 0;
      const vC = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = vA - vC;

      // ngspice DIOconvTest: current-prediction convergence
      // GEQ can be negative in the NDR region; the formula self-scales via max(|cdhat|, |id|)
      const delvd = vdRaw - s0[base + SLOT_VD];
      const id = s0[base + SLOT_ID];
      const gd = s0[base + SLOT_GEQ];
      const cdhat = id + gd * delvd;
      const tol = ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(id)) + ctx.iabstol;
      return Math.abs(cdhat - id) <= tol;
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      // pinLayout order: [A (anode), K (cathode)]
      // Positive = current flowing INTO element at that pin.
      const id = s0[base + SLOT_ID];
      return [id, -id];
    },

    setParam(key: string, value: number): void {
      if (key in params) params[key] = value;
    },
  };

  // Attach getLteTimestep only when junction capacitance is present
  if (hasCapacitance) {
    (element as unknown as { getLteTimestep: (dt: number, deltaOld: readonly number[], order: number, method: IntegrationMethod, lteParams: LteParams) => number }).getLteTimestep = function (
      dt: number,
      deltaOld: readonly number[],
      order: number,
      method: IntegrationMethod,
      lteParams: LteParams,
    ): number {
      const _q0 = s0[base + SLOT_Q];
      const _q1 = s1[base + SLOT_Q];
      const _q2 = s2[base + SLOT_Q];
      const _q3 = s3[base + SLOT_Q];
      const ccap0 = s0[base + SLOT_CCAP];
      const ccap1 = s1[base + SLOT_CCAP];
      return cktTerr(dt, deltaOld, order, method, _q0, _q1, _q2, _q3, ccap0, ccap1, lteParams);
    };
  }

  return element;
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
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "K",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TUNNEL_DIODE_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TUNNEL_DIODE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
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
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createTunnelDiodeElement,
      paramDefs: TUNNEL_DIODE_PARAM_DEFS,
      params: TUNNEL_DIODE_PARAM_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
