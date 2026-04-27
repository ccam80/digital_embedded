/**
 * Polarized electrolytic capacitor analog component.
 *
 * Extends the standard capacitor companion model with three additional effects:
 *   - ESR (equivalent series resistance): a series conductance between an
 *     internal node and the positive terminal
 *   - Leakage current: a parallel conductance across the full component
 *   - Polarity enforcement: emits a diagnostic when the anode voltage falls
 *     below the cathode voltage beyond a configurable reverse threshold
 *
 * Topology (MNA):
 *   pos â”€â”€â”€ ESR â”€â”€â”€ capNode â”€â”€â”€ capacitor+leakage â”€â”€â”€ neg
 *
 * Three MNA nodes are used:
 *   pinNodeIds[0] = n_pos  (positive terminal / anode)
 *   pinNodeIds[1] = n_neg  (negative terminal / cathode)
 *   pinNodeIds[2] = n_cap  (internal node between ESR and capacitor body)
 *
 * Elements stamped inside load() every NR iteration:
 *   - ESR conductance between n_pos and n_cap
 *   - Leakage conductance between n_cap and n_neg
 *   - Capacitor companion model (geq + ieq) between n_cap and n_neg,
 *     computed inline with ctx.ag[] (NIintegrate)
 *   - Polarity check: emits a reverse-biased-cap diagnostic when
 *     V(pos) < V(neg) âˆ’ reverseMax
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElementCore, PoolBackedAnalogElementCore, ReactiveAnalogElement, IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import { MODETRAN, MODETRANOP, MODEINITPRED, MODEINITTRAN, MODEAC, MODEDC, MODEUIC, MODEINITJCT } from "../../solver/analog/ckt-mode.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import type { Diagnostic } from "../../compile/types.js";
import { defineModelParams } from "../../core/model-params.js";
import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import {
  createDiodeElement,
  DIODE_SCHEMA,
  DIODE_PARAM_DEFAULTS,
} from "../semiconductors/diode.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-9;

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

// Slot layout â€” 5 slots total. Previous values are read from s1/s2/s3
// at the same offsets (pointer-rotation history).
const POLARIZED_CAP_SCHEMA: StateSchema = defineStateSchema("AnalogPolarizedCapElement", [
  { name: "GEQ",  doc: "Companion conductance",       init: { kind: "zero" } },
  { name: "IEQ",  doc: "Companion history current",   init: { kind: "zero" } },
  { name: "V",    doc: "Terminal voltage this step",  init: { kind: "zero" } },
  { name: "Q",    doc: "Charge Q=C*V this step",      init: { kind: "zero" } },
  { name: "CCAP", doc: "Companion current (NIintegrate)", init: { kind: "zero" } },
]);

const SLOT_GEQ  = 0;
const SLOT_IEQ  = 1;
const SLOT_V    = 2;
const SLOT_Q    = 3;
const SLOT_CCAP = 4;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: POLARIZED_CAP_PARAM_DEFS, defaults: POLARIZED_CAP_MODEL_DEFAULTS } = defineModelParams({
  primary: {
    capacitance:    { default: 100e-6, unit: "F", description: "Capacitance in farads", min: 1e-12 },
    esr:            { default: 0.1,    unit: "Î©", description: "Equivalent series resistance in ohms", min: 0 },
  },
  secondary: {
    leakageCurrent: { default: 1e-6,  unit: "A", description: "DC leakage current at rated voltage", min: 0 },
    voltageRating:  { default: 25,    unit: "V", description: "Maximum rated voltage", min: 1 },
    reverseMax:     { default: 1.0,   unit: "V", description: "Reverse voltage threshold that triggers a polarity warning", min: 0 },
    // PC-W3-5: IC (alias initCond) param â€” capload.c:46-51 CAPinitCond
    IC:             { default: 0,     unit: "V", description: "Initial condition: junction voltage for UIC (alias: initCond)" },
    // PC-W3-6: M multiplicity param â€” capload.c:44 CAPm, applied at stamp time per user ruling 3
    M:              { default: 1,                description: "Parallel-element multiplicity (applied at stamp time)" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildPolarizedCapPinDeclarations(): PinDeclaration[] {
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
// PolarizedCapElement â€” AbstractCircuitElement (editor/visual layer)
// ---------------------------------------------------------------------------

export class PolarizedCapElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PolarizedCap", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPolarizedCapPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.75,
      width: 4,
      height: 1.5 + 1e-10,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._visibleLabel();

    ctx.save();
    ctx.setLineWidth(1);

    const vPos = signals?.getPinVoltage("pos");
    const vNeg = signals?.getPinVoltage("neg");
    const hasVoltage = vPos !== undefined && vNeg !== undefined;

    const PX = 1 / 16;
    const plateOffset = 28 * PX; // 1.75 â€” matches Falstad lead length (28px)

    // Left lead â€” colored by pos voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vPos, 0, 0, plateOffset, 0);

    // Right lead â€” colored by neg voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vNeg, 4, 0, 4 - plateOffset, 0);

    // Plate 1 â€” straight line (positive/anode plate)
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(plateOffset, 0, 4 - plateOffset, 0, [
        { offset: 0, color: signals!.voltageColor(vPos) },
        { offset: 1, color: signals!.voltageColor(vNeg) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(plateOffset, -0.75, plateOffset, 0.75);

    // Plate 2 â€” curved (exact Falstad 7-segment polyline)
    // Falstad pixel coords: (41,-12),(37,-9),(36,-5),(36,-2),(36,2),(36,5),(37,9),(41,12)
    // Grid coords (Ã·16):   (2.5625,-0.75),(2.3125,-0.5625),(2.25,-0.3125),(2.25,-0.125),
    //                      (2.25,0.125),(2.25,0.3125),(2.3125,0.5625),(2.5625,0.75)
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(plateOffset, 0, 4 - plateOffset, 0, [
        { offset: 0, color: signals!.voltageColor(vPos) },
        { offset: 1, color: signals!.voltageColor(vNeg) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    const curvedPts: [number, number][] = [
      [2.5625, -0.75],
      [2.3125, -0.5625],
      [2.25, -0.3125],
      [2.25, -0.125],
      [2.25, 0.125],
      [2.25, 0.3125],
      [2.3125, 0.5625],
      [2.5625, 0.75],
    ];
    for (let i = 0; i < curvedPts.length - 1; i++) {
      ctx.drawLine(curvedPts[i][0], curvedPts[i][1], curvedPts[i + 1][0], curvedPts[i + 1][1]);
    }

    // Polarity marker "+" at anode side
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText("+", 0.9375, 0.625, { horizontal: "center", vertical: "top" });

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 1.6875, -0.875, { horizontal: "center", vertical: "top" });
    }

    ctx.restore();
  }

}


// ---------------------------------------------------------------------------
// Clamp diode state layout
// ---------------------------------------------------------------------------

// PC-W3-1: The F4b composition embeds a clamp diode (dioload.c:245-265) between
// nPos (A) and nNeg (K) of the capacitor package. Anode = nNeg, Cathode = nPos
// so the diode conducts when the cap is reverse-biased (nPos < nNeg).
// The clamp diode uses the no-capacitance DIODE_SCHEMA (4 slots).
const CLAMP_DIODE_STATE_SIZE = DIODE_SCHEMA.size; // 4 slots

/** Build a PropertyBag for the reverse-bias clamp diode sub-element.
 *  CJO=0, TT=0 â†’ no-capacitance diode schema (4 slots).
 *  IS=1e-14, N=1 are standard small-signal defaults; the clamp diode just
 *  provides a Shockley junction stamp between nPos/nNeg per F4b. */
function makeClampDiodeProps(): PropertyBag {
  const bag = new PropertyBag(new Map<string, number>().entries());
  bag.replaceModelParams({ ...DIODE_PARAM_DEFAULTS, CJO: 0, TT: 0 });
  return bag;
}

// ---------------------------------------------------------------------------
// AnalogPolarizedCapElement â€” MNA implementation
// ---------------------------------------------------------------------------

export class AnalogPolarizedCapElement implements ReactiveAnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.CAP;
  readonly isNonlinear: boolean = true;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  setParam(_key: string, _value: number): void {}

  readonly stateSchema = POLARIZED_CAP_SCHEMA;
  // PC-W3-1: total state = cap-body slots + clamp diode slots (dioload.c:245-265)
  readonly stateSize = POLARIZED_CAP_SCHEMA.size + CLAMP_DIODE_STATE_SIZE; // 5 + 4 = 9 slots
  stateBaseOffset = -1;
  s0: Float64Array = new Float64Array(0);
  s1: Float64Array = new Float64Array(0);
  s2: Float64Array = new Float64Array(0);
  s3: Float64Array = new Float64Array(0);
  s4: Float64Array = new Float64Array(0);
  s5: Float64Array = new Float64Array(0);
  s6: Float64Array = new Float64Array(0);
  s7: Float64Array = new Float64Array(0);

  private C: number;
  private G_esr: number;
  private G_leak: number;
  private reverseMax: number;
  private _IC: number;     // PC-W3-5: capload.c:46-51 CAPinitCond
  private _M: number;      // PC-W3-6: capload.c:44 CAPm â€” applied at stamp time
  private _pool!: StatePoolRef;

  // PC-W3-1: clamp diode sub-element (F4b composition â€” dioload.c:245-265)
  // Oriented: A=nNeg, K=nPos so it conducts when cap is reverse-biased.
  private readonly _clampDiode: PoolBackedAnalogElementCore;

  private readonly _emitDiagnostic: (diag: Diagnostic) => void;
  private _reverseBiasDiagEmitted: boolean = false;

  /**
   * @param pinNodeIds    - [n_pos, n_neg, n_cap] â€” n_cap is the internal node
   * @param capacitance    - Capacitance in farads
   * @param esr            - Equivalent series resistance in ohms
   * @param rLeak          - Leakage resistance in ohms (V_rated / I_leak)
   * @param reverseMax     - Reverse voltage threshold in volts (positive value)
   * @param emitDiagnostic - Callback invoked when polarity violation is detected
   * @param IC             - PC-W3-5: Initial condition voltage (capload.c:46-51)
   * @param M              - PC-W3-6: Multiplicity factor (capload.c:44)
   */
  constructor(
    pinNodeIds: number[],
    capacitance: number,
    esr: number,
    rLeak: number,
    reverseMax: number,
    emitDiagnostic?: (diag: Diagnostic) => void,
    IC: number = 0,
    M: number = 1,
  ) {
    this.pinNodeIds = pinNodeIds;
    this.allNodeIds = pinNodeIds;
    this.C = capacitance;
    this.G_esr = 1 / Math.max(esr, MIN_RESISTANCE);
    this.G_leak = 1 / Math.max(rLeak, MIN_RESISTANCE);
    this.reverseMax = reverseMax;
    this._IC = IC;
    this._M = M;
    this._emitDiagnostic = emitDiagnostic ?? (() => {});

    // PC-W3-1: create clamp diode sub-element (dioload.c:245-265).
    // A = nNeg (index [1]), K = nPos (index [0]) â€” conducts when cap is reverse-biased.
    const clampPinNodes = new Map<string, number>([
      ["A", pinNodeIds[1]], // anode = nNeg
      ["K", pinNodeIds[0]], // cathode = nPos
    ]);
    this._clampDiode = createDiodeElement(clampPinNodes, [], -1, makeClampDiodeProps());
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(POLARIZED_CAP_SCHEMA, pool, this.stateBaseOffset, {});
    // PC-W3-1: wire clamp diode to its partitioned state region (after cap-body slots).
    this._clampDiode.stateBaseOffset = this.stateBaseOffset + POLARIZED_CAP_SCHEMA.size;
    this._clampDiode.initState(pool);
  }

  /**
   * Unified load() â€” ESR + leakage stamps + capacitor companion + clamp diode + polarity check.
   *
   * Topology: pos â”€â”€ ESR â”€â”€ nCap â”€â”€ (C || leakage) â”€â”€ neg.
   * Clamp diode stamps between nPos (K) and nNeg (A) per PC-W3-1 / dioload.c:245-265.
   * Stamps in one pass:
   *   - ESR conductance between nPos and nCap (topology-constant, stamped always).
   *   - Leakage conductance between nCap and nNeg (topology-constant).
   *   - PC-W3-1: Clamp diode Shockley stamp between nNeg (A) and nPos (K).
   *   - Capacitor companion (geq, ceq) between nCap and nNeg using inline
   *     NIintegrate with ctx.ag[] â€” gated by capload.c:30 outer gate.
   *   - Polarity diagnostic when reverse-biased beyond reverseMax.
   *   - M multiplicity applied at every stamp site (PC-W3-6 / capload.c:44).
   */
  load(ctx: LoadContext): void {
    const { solver, rhsOld: voltages, ag } = ctx;
    const mode = ctx.cktMode;
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];
    const nCap = this.pinNodeIds[2];
    const base = this.stateBaseOffset;
    const m = this._M; // PC-W3-6: capload.c:44 CAPm
    // pool.states[N] accessed at call time â€” no cached Float64Array refs (A4).
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    // ESR conductance (nPos â†” nCap) â€” digiTS extension (no ngspice capload.c counterpart).
    // Scaled by m (PC-W3-6: user ruling 3 â€” apply m at stamp time, not by folding into C).
    stampG(solver, nPos, nPos, m * this.G_esr);
    stampG(solver, nPos, nCap, -m * this.G_esr);
    stampG(solver, nCap, nPos, -m * this.G_esr);
    stampG(solver, nCap, nCap, m * this.G_esr);

    // Leakage conductance (nCap â†” nNeg) â€” scaled by m.
    stampG(solver, nCap, nCap, m * this.G_leak);
    stampG(solver, nCap, nNeg, -m * this.G_leak);
    stampG(solver, nNeg, nCap, -m * this.G_leak);
    stampG(solver, nNeg, nNeg, m * this.G_leak);

    // PC-W3-1: Clamp diode stamp between nNeg (A) and nPos (K).
    // cite: dioload.c:245-265 â€” Shockley forward/reverse structure for clamp junction.
    // The diode sub-element calls dioload.c:245-265 through createDiodeElement's load().
    this._clampDiode.load(ctx);

    // Polarity detection â€” check anode vs cathode voltage.
    const vAnode = voltages[nPos];
    const vCathode = voltages[nNeg];
    const vDiff = vAnode - vCathode;
    if (vDiff < -this.reverseMax) {
      if (!this._reverseBiasDiagEmitted) {
        this._reverseBiasDiagEmitted = true;
        this._emitDiagnostic({
          code: "reverse-biased-cap",
          severity: "warning",
          message: `Polarized capacitor reverse biased by ${(-vDiff).toFixed(2)} V (threshold: ${this.reverseMax} V)`,
          explanation:
            "Electrolytic capacitors are damaged by reverse bias. " +
            "Check circuit polarity and ensure the anode (positive terminal) " +
            "is at a higher potential than the cathode.",
          suggestions: [
            {
              text: "Reverse the capacitor polarity in the schematic.",
              automatable: false,
            },
          ],
        });
      }
    } else {
      this._reverseBiasDiagEmitted = false;
    }

    // Capacitor body (between nCap and nNeg).
    // PC-W3-2: outer gate per capload.c:30 â€” MODEAC added.
    // cite: capload.c:30 if(ckt->CKTmode & (MODETRAN|MODEAC|MODETRANOP))
    if (!(mode & (MODETRAN | MODETRANOP | MODEAC))) return;
    const C = this.C;

    // PC-W3-5: cond1 per capload.c:32-37 and 46-50.
    // cite: capload.c:32-37 cond1 = (MODEDC&&MODEINITJCT)||(MODEUIC&&MODEINITTRAN)
    // cite: capload.c:46    vcap = here->CAPinitCond  (when cond1)
    // cite: capload.c:49-50 vcap = CKTrhsOld[pos] - CKTrhsOld[neg]  (otherwise)
    const cond1 =
      ((mode & MODEDC) !== 0 && (mode & MODEINITJCT) !== 0) ||
      ((mode & MODEUIC) !== 0 && (mode & MODEINITTRAN) !== 0);
    let vNow: number;
    if (cond1) {
      vNow = this._IC;
    } else {
      const vCapNode = voltages[nCap];
      const vNegNode = voltages[nNeg];
      vNow = vCapNode - vNegNode;
    }

    // PC-W3-3: inner fork per capload.c:52 â€” MODEAC added.
    // cite: capload.c:52 if(ckt->CKTmode & (MODETRAN | MODEAC))
    if (mode & (MODETRAN | MODEAC)) {
      // Charge update (capload.c:54-66 pattern).
      if (mode & MODEINITPRED) {
        // cite: capload.c:55-56 state0[CAPqcap] = state1[CAPqcap]
        s0[base +SLOT_Q] = s1[base +SLOT_Q];
      } else {
        // cite: capload.c:59 state0[CAPqcap] = here->CAPcapac * vcap
        s0[base +SLOT_Q] = C * vNow;
        if (mode & MODEINITTRAN) {
          // cite: capload.c:60-62 state1[CAPqcap] = state0[CAPqcap]
          s1[base +SLOT_Q] = s0[base +SLOT_Q];
        }
      }

      const q0 = s0[base +SLOT_Q];
      const q1 = s1[base +SLOT_Q];
      const q2 = s2[base +SLOT_Q];
      const q3 = s3[base +SLOT_Q];
      const ccapPrev = s1[base +SLOT_CCAP];
      // cite: capload.c:67-69 NIintegrate(ckt,&geq,&ceq,here->CAPcapac,here->CAPqcap)
      const { ccap, ceq, geq } = niIntegrate(
        ctx.method,
        ctx.order,
        C,
        ag,
        q0, q1,
        [q2, q3, 0, 0, 0],
        ccapPrev,
      );
      s0[base +SLOT_CCAP] = ccap;

      if (mode & MODEINITTRAN) {
        // cite: capload.c:70-72 state1[CAPccap] = state0[CAPccap]
        s1[base +SLOT_CCAP] = s0[base +SLOT_CCAP];
      }

      s0[base +SLOT_GEQ] = geq;
      s0[base +SLOT_IEQ] = ceq;
      s0[base +SLOT_V]   = vNow;

      // Stamp companion between nCap and nNeg, scaled by m (PC-W3-6).
      // cite: capload.c:74-79 *(ptr) += m * geq / *(rhs) -= m * ceq
      stampG(solver, nCap, nCap, m * geq);
      stampG(solver, nCap, nNeg, -m * geq);
      stampG(solver, nNeg, nCap, -m * geq);
      stampG(solver, nNeg, nNeg, m * geq);
      if (nCap !== 0) stampRHS(ctx.rhs,nCap, -m * ceq);
      if (nNeg !== 0) stampRHS(ctx.rhs,nNeg, m * ceq);
    } else {
      // DC operating point.
      // cite: capload.c:81 state0[CAPqcap] = here->CAPcapac * vcap
      s0[base +SLOT_Q] = C * vNow;
      s0[base +SLOT_V] = vNow;
      s0[base +SLOT_GEQ] = 0;
      s0[base +SLOT_IEQ] = 0;
    }
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const nPos = this.pinNodeIds[0];
    const nCap = this.pinNodeIds[2];
    const vPos = rhs[nPos];
    const vCap = rhs[nCap];
    // Current into pos pin = current through ESR flowing into the element
    const I = this.G_esr * (vPos - vCap);
    return [I, -I];
  }

  updatePhysicalParams(C: number, G_esr: number, G_leak: number, reverseMax: number, IC: number = 0, M: number = 1): void {
    this.C = C;
    this.G_esr = G_esr;
    this.G_leak = G_leak;
    this.reverseMax = reverseMax;
    this._IC = IC;
    this._M = M;
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
  ): number {
    const base = this.stateBaseOffset;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];
    const q0 = s0[base + SLOT_Q];
    const q1 = s1[base + SLOT_Q];
    const q2 = s2[base + SLOT_Q];
    const q3 = s3[base + SLOT_Q];
    const ccap0 = s0[base + SLOT_CCAP];
    const ccap1 = s1[base + SLOT_CCAP];
    return cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

function buildPolarizedCapFromParams(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  p: { capacitance: number; esr: number; leakageCurrent: number; voltageRating: number; reverseMax: number; IC: number; M: number },
): AnalogElementCore {
  const rLeak = p.leakageCurrent > 0 ? p.voltageRating / p.leakageCurrent : 1e12;

  // nodeIds = [n_pos, n_neg, n_cap_internal] â€” compiler provides the internal node
  const el = new AnalogPolarizedCapElement(
    [pinNodes.get("pos")!, pinNodes.get("neg")!, internalNodeIds[0]],
    p.capacitance,
    p.esr,
    rLeak,
    p.reverseMax,
    undefined,
    p.IC,
    p.M,
  );

  (el as AnalogElementCore).setParam = function(key: string, value: number): void {
    if (key in p) {
      (p as Record<string, number>)[key] = value;
      const newRLeak = p.leakageCurrent > 0 ? p.voltageRating / p.leakageCurrent : 1e12;
      // PC-W3-6: M threaded through updatePhysicalParams so hot-reload propagates.
      // PC-W3-5: IC threaded through so UIC initial condition is live.
      el.updatePhysicalParams(
        p.capacitance,
        1 / Math.max(p.esr, MIN_RESISTANCE),
        1 / Math.max(newRLeak, MIN_RESISTANCE),
        p.reverseMax,
        p.IC,
        p.M,
      );
    }
  };
  return el;
}

function createPolarizedCapElement(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const p = {
    capacitance:    props.getModelParam<number>("capacitance"),
    esr:            props.getModelParam<number>("esr"),
    leakageCurrent: props.getModelParam<number>("leakageCurrent"),
    voltageRating:  props.getModelParam<number>("voltageRating"),
    reverseMax:     props.getModelParam<number>("reverseMax"),
    // PC-W3-5: IC (alias initCond) â€” capload.c:46-51 CAPinitCond
    IC:             props.getModelParam<number>("IC"),
    // PC-W3-6: M multiplicity â€” capload.c:44 CAPm
    M:              props.getModelParam<number>("M"),
  };
  return buildPolarizedCapFromParams(pinNodes, internalNodeIds, p);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const POLARIZED_CAP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "leakageCurrent",
    type: PropertyType.FLOAT,
    label: "Leakage Current (A)",
    unit: "A",
    defaultValue: 1e-6,
    min: 0,
    description: "DC leakage current at rated voltage",
  },
  {
    key: "voltageRating",
    type: PropertyType.FLOAT,
    label: "Voltage Rating (V)",
    unit: "V",
    defaultValue: 25,
    min: 1,
    description: "Maximum rated voltage",
  },
  {
    key: "reverseMax",
    type: PropertyType.FLOAT,
    label: "Reverse Threshold (V)",
    unit: "V",
    defaultValue: 1.0,
    min: 0,
    description: "Reverse voltage threshold that triggers a polarity warning",
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

export const POLARIZED_CAP_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "capacitance",
    propertyKey: "capacitance",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "esr",
    propertyKey: "esr",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "leakageCurrent",
    propertyKey: "leakageCurrent",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "voltageRating",
    propertyKey: "voltageRating",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "reverseMax",
    propertyKey: "reverseMax",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// PolarizedCapDefinition
// ---------------------------------------------------------------------------

function polarizedCapCircuitFactory(props: PropertyBag): PolarizedCapElement {
  return new PolarizedCapElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PolarizedCapDefinition: ComponentDefinition = {
  name: "PolarizedCap",
  typeId: -1,
  factory: polarizedCapCircuitFactory,
  pinLayout: buildPolarizedCapPinDeclarations(),
  propertyDefs: POLARIZED_CAP_PROPERTY_DEFS,
  attributeMap: POLARIZED_CAP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Polarized electrolytic capacitor â€” extends the standard capacitor with ESR,\n" +
    "leakage current, and reverse-bias polarity enforcement.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createPolarizedCapElement,
      paramDefs: POLARIZED_CAP_PARAM_DEFS,
      params: POLARIZED_CAP_MODEL_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
