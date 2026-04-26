/**
 * Tunnel Diode analog component â€” N-shaped I-V curve with NDR region.
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
import { MODETRAN, MODEAC } from "../../solver/analog/ckt-mode.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import {
  computeJunctionCapacitance,
  computeJunctionCharge,
  diodeLoadTunnel,
} from "./diode.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Boltzmann constant (ngspice CONSTboltz, const.h). */
const CONSTboltz = 1.3806226e-23;
/** Electron charge (ngspice CHARGE, const.h). */
const CHARGE = 1.6021918e-19;

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

/** Excess current voltage scale (V_x in spec). Determines rise rate past valley. */
const VX = 0.1;

/** Maximum voltage step per NR iteration in or near NDR region. */
const NDR_VSTEP_MAX = 0.1;

/** Thermal saturation current (A) â€” default for Shockley component. */
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
    IS:   { default: 1e-14,  unit: "A", description: "Shockley saturation current" },
    N:    { default: 1,                  description: "Emission coefficient" },
    CJO:  { default: 0,      unit: "F",  description: "Zero-bias junction capacitance" },
    VJ:   { default: 1,      unit: "V",  description: "Junction built-in potential" },
    M:    { default: 0.5,                description: "Grading coefficient" },
    TT:   { default: 0,      unit: "s",  description: "Transit time" },
    FC:   { default: 0.5,                description: "Forward-bias capacitance coefficient" },
    // D-W3-7: tunnel current params â€” dioload.c:267-285 (consumed via diodeLoadTunnel)
    IBEQ: { default: 0,      unit: "A",  description: "Tunnel bottom saturation current (DIOtunSatCur)" },
    IBSW: { default: 0,      unit: "A",  description: "Tunnel sidewall saturation current (DIOtunSatSWCur)" },
    NB:   { default: 1,                  description: "Tunnel emission coefficient (DIOtunEmissionCoeff)" },
  },
  instance: {
    TEMP: { default: 300.15, unit: "K",  description: "Per-instance operating temperature" },
  },
});

// ---------------------------------------------------------------------------
// tunnelDiodeIV â€” compute I(V) and dI/dV for the tunnel diode model
// ---------------------------------------------------------------------------

/**
 * Compute tunnel diode current and differential conductance at voltage V.
 *
 * @param v      - Junction voltage (V)
 * @param ip     - Peak tunnel current (A)
 * @param vp     - Peak voltage (V)
 * @param iv     - Valley current (A)
 * @param vv     - Valley voltage (V)
 * @param iS     - Shockley saturation current (A)
 * @param nCoeff - Emission coefficient
 * @param vt     - Thermal voltage (V) â€” derived from per-instance TEMP
 * @returns { i, dIdV } â€” current and differential conductance
 */
export function tunnelDiodeIV(
  v: number,
  ip: number,
  vp: number,
  iv: number,
  vv: number,
  iS: number = IS_THERMAL,
  nCoeff: number = 1,
  vt: number = 300.15 * CONSTboltz / CHARGE,
): { i: number; dIdV: number } {
  // --- Tunnel current component ---
  // I_t(V) = I_p * (V/V_p) * exp(1 - V/V_p)
  const uT = v / vp;
  const expT = Math.exp(1 - uT);
  const iTunnel = ip * uT * expT;
  // dI_t/dV = I_p/V_p * exp(1 - V/V_p) * (1 - V/V_p)
  //         = (I_p/V_p) * expT * (1 - uT)
  const dITunnel = (ip / vp) * expT * (1 - uT);

  // --- Excess current component ---
  // I_x(V) = I_v * exp((V - V_v) / V_x)
  const excessArg = (v - vv) / VX;
  const expX = Math.exp(excessArg);
  const iExcess = iv * expX;
  // dI_x/dV = I_v / V_x * exp((V - V_v) / V_x)
  const dIExcess = (iv / VX) * expX;

  // --- Thermal (Shockley) component â€” cite: dioload.c, per-instance TEMP ---
  const nVt = nCoeff * vt;
  const expTh = Math.exp(v / nVt);
  const iThermal = iS * (expTh - 1);
  // dI_thermal/dV = IS / (N*vt) * exp(V/(N*vt))
  const dIThermal = (iS * expTh) / nVt;

  const i = iTunnel + iExcess + iThermal;
  const dIdV = dITunnel + dIExcess + dIThermal + GMIN;

  return { i, dIdV };
}

// ---------------------------------------------------------------------------
// State schema declarations
// ---------------------------------------------------------------------------

// Slot index constants â€” shared between both schema variants.
const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3;
const SLOT_Q = 4, SLOT_CCAP = 5;

/** Schema for resistive tunnel diode (no junction capacitance): 4 slots. */
const TUNNEL_DIODE_STATE_SCHEMA = defineStateSchema("TunnelDiodeElement", [
  { name: "VD",  doc: "Tunnel diode junction voltage (V)",    init: { kind: "zero" } },
  { name: "GEQ", doc: "Differential conductance (S)",         init: { kind: "constant", value: 1e-12 } },
  { name: "IEQ", doc: "Linearized current source (A)",        init: { kind: "zero" } },
  { name: "ID",  doc: "Diode current (A)",                    init: { kind: "zero" } },
]);

/** Schema for capacitive tunnel diode (CJO > 0 or TT > 0): 6 slots. */
const TUNNEL_DIODE_CAP_STATE_SCHEMA = defineStateSchema("TunnelDiodeElement_cap", [
  { name: "VD",   doc: "Tunnel diode junction voltage (V)",              init: { kind: "zero" } },
  { name: "GEQ",  doc: "Differential conductance (S)",                   init: { kind: "constant", value: 1e-12 } },
  { name: "IEQ",  doc: "Linearized current source (A)",                  init: { kind: "zero" } },
  { name: "ID",   doc: "Diode current (A)",                              init: { kind: "zero" } },
  { name: "Q",    doc: "Junction charge (NIintegrate history from s1/s2/s3)", init: { kind: "zero" } },
  { name: "CCAP", doc: "Companion current (NIintegrate history)",        init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// createTunnelDiodeElement â€” AnalogElement factory
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
    IP:   readParam("IP"),
    VP:   readParam("VP"),
    IV:   readParam("IV"),
    VV:   readParam("VV"),
    IS:   readParam("IS"),
    N:    readParam("N"),
    CJO:  readParam("CJO"),
    VJ:   readParam("VJ"),
    M:    readParam("M"),
    TT:   readParam("TT"),
    FC:   readParam("FC"),
    // D-W3-7: tunnel current params (dioload.c:267-285), consumed via diodeLoadTunnel
    IBEQ: readParam("IBEQ"),
    IBSW: readParam("IBSW"),
    NB:   readParam("NB"),
    TEMP: readParam("TEMP"),
  };

  const hasCapacitance = params.CJO > 0 || params.TT > 0;

  // Per-instance thermal voltage â€” cite: dioload.c / diotemp.c, per-instance TEMP (maps to ngspice DIOtemp).
  let vt = params.TEMP * CONSTboltz / CHARGE;

  // Pool reference â€” set by initState. State arrays accessed via pool.states[N]
  // at call time. No cached Float64Array refs.
  let pool: StatePoolRef;
  let base: number;

  function recompute(s0: Float64Array, v: number): void {
    const { i, dIdV } = tunnelDiodeIV(v, params.IP, params.VP, params.IV, params.VV, params.IS, params.N, vt);
    // Hoisted SPICE tunnel band-to-band contribution (dioload.c:267-285) folded
    // additively into the Norton pair. Gated internally on IBEQ/IBSW > 0.
    const { cdb: tunCd, gdb: tunGd } = diodeLoadTunnel(
      v, vt, params.IBEQ, params.IBSW, params.NB,
      i, dIdV, 0, 0,
    );
    // dIdV already includes GMIN from tunnelDiodeIV; add GMIN*v to current (DD5)
    const idTotal = tunCd + GMIN * v;
    const gdTotal = tunGd;
    s0[base + SLOT_ID] = idTotal;
    s0[base + SLOT_GEQ] = gdTotal;
    s0[base + SLOT_IEQ] = idTotal - gdTotal * v;
  }

  function isInNdrRegion(v: number): boolean {
    return v > params.VP * 0.8 && v < params.VV * 1.2;
  }

  const element: PoolBackedAnalogElementCore = {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: hasCapacitance,
    poolBacked: true as const,
    stateSize: hasCapacitance ? 6 : 4,
    stateSchema: hasCapacitance ? TUNNEL_DIODE_CAP_STATE_SCHEMA : TUNNEL_DIODE_STATE_SCHEMA,
    stateBaseOffset: -1,

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      base = this.stateBaseOffset;
      applyInitialValues(this.stateSchema, pool, base, params);
    },

    load(ctx: LoadContext): void {
      // Access state arrays at call time â€” no cached Float64Array refs.
      const s0 = pool.states[0];
      const s1 = pool.states[1];
      const s2 = pool.states[2];
      const s3 = pool.states[3];

      const voltages = ctx.rhsOld;
      const vA = voltages[nodeAnode];
      const vC = voltages[nodeCathode];
      const vdRaw = vA - vC;

      // Voltage limiting in or near NDR region: clamp step to NDR_VSTEP_MAX.
      // Prevents NR from jumping across the negative-resistance valley.
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
      recompute(s0, vdNew);

      const geq = s0[base + SLOT_GEQ];
      const ieq = s0[base + SLOT_IEQ];
      const solver = ctx.solver;
      stampG(solver, nodeAnode,   nodeAnode,   geq);
      stampG(solver, nodeAnode,   nodeCathode, -geq);
      stampG(solver, nodeCathode, nodeAnode,   -geq);
      stampG(solver, nodeCathode, nodeCathode, geq);
      stampRHS(ctx.rhs, nodeAnode,   -ieq);
      stampRHS(ctx.rhs, nodeCathode, ieq);

      // Reactive companion: junction capacitance + transit-time diffusion cap
      if (hasCapacitance && (ctx.cktMode & (MODETRAN | MODEAC))) {
        const order = ctx.order;
        const method = ctx.method;

        const Cj = computeJunctionCapacitance(vdNew, params.CJO, params.VJ, params.M, params.FC);
        const { dIdV: gDiode, i: iNowDiode } = tunnelDiodeIV(vdNew, params.IP, params.VP, params.IV, params.VV, params.IS, params.N, vt);
        const Ct = params.TT * gDiode;
        const Ctotal = Cj + Ct;

        const q0 = computeJunctionCharge(vdNew, params.CJO, params.VJ, params.M, params.FC, params.TT, iNowDiode);
        const q1 = s1[base + SLOT_Q];
        const q2 = s2[base + SLOT_Q];
        const q3 = s3[base + SLOT_Q];
        const ag = ctx.ag;
        const ccapPrev = s1[base + SLOT_CCAP];
        const { ccap, geq: capGeq } = niIntegrate(
          method,
          order,
          Ctotal,
          ag,
          q0, q1,
          [q2, q3, 0, 0, 0],
          ccapPrev,
        );
        const capIeq = ccap - capGeq * vdNew;
        s0[base + SLOT_Q] = q0;
        s0[base + SLOT_CCAP] = ccap;

        if (capGeq !== 0 || capIeq !== 0) {
          stampG(solver, nodeAnode,   nodeAnode,   capGeq);
          stampG(solver, nodeAnode,   nodeCathode, -capGeq);
          stampG(solver, nodeCathode, nodeAnode,   -capGeq);
          stampG(solver, nodeCathode, nodeCathode, capGeq);
          stampRHS(ctx.rhs, nodeAnode,   -capIeq);
          stampRHS(ctx.rhs, nodeCathode, capIeq);
        }
      }
    },

    checkConvergence(ctx: LoadContext): boolean {
      const s0 = pool.states[0];
      const voltages = ctx.rhsOld;
      const vA = voltages[nodeAnode];
      const vC = voltages[nodeCathode];
      const vdRaw = vA - vC;

      // Current-prediction convergence test.
      // GEQ can be negative in the NDR region; max(|cdhat|, |id|) self-scales.
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
      const id = pool.states[0][base + SLOT_ID];
      return [id, -id];
    },

    setParam(key: string, value: number): void {
      if (key in params) {
        params[key] = value;
        if (key === "TEMP") vt = params.TEMP * CONSTboltz / CHARGE;
      }
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
      const _q0 = pool.states[0][base + SLOT_Q];
      const _q1 = pool.states[1][base + SLOT_Q];
      const _q2 = pool.states[2][base + SLOT_Q];
      const _q3 = pool.states[3][base + SLOT_Q];
      const ccap0 = pool.states[0][base + SLOT_CCAP];
      const ccap1 = pool.states[1][base + SLOT_CCAP];
      return cktTerr(dt, deltaOld, order, method, _q0, _q1, _q2, _q3, ccap0, ccap1, lteParams);
    };
  }

  return element;
}

// ---------------------------------------------------------------------------
// TunnelDiodeElement â€” CircuitElement implementation
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
    // T-wings: cath2={2.3,-0.5}â†’cath0={2.5,-0.5}; cath3={2.3,0.5}â†’cath1={2.5,0.5}
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
    "Tunnel Diode â€” N-shaped I-V curve with negative differential resistance.\n" +
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
