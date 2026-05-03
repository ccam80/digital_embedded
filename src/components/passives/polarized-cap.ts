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
 *   pos € ESR € capNode € capacitor+leakage € neg
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
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement, PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { IntegrationMethod } from "../../solver/analog/integration.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { MODETRAN, MODETRANOP, MODEINITPRED, MODEINITTRAN, MODEAC, MODEDC, MODEUIC, MODEINITJCT } from "../../solver/analog/ckt-mode.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import type { Diagnostic } from "../../compile/types.js";
import { defineModelParams } from "../../core/model-params.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";
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

// Slot layout  5 slots total. Previous values are read from s1/s2/s3
// at the same offsets (pointer-rotation history).
const POLARIZED_CAP_SCHEMA: StateSchema = defineStateSchema("AnalogPolarizedCapElement", [
  { name: "GEQ",  doc: "Companion conductance" },
  { name: "IEQ",  doc: "Companion history current" },
  { name: "V",    doc: "Terminal voltage this step" },
  { name: "Q",    doc: "Charge Q=C*V this step" },
  { name: "CCAP", doc: "Companion current (NIintegrate)" },
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
    esr:            { default: 0.1,    unit: "Î", description: "Equivalent series resistance in ohms", min: 0 },
  },
  secondary: {
    leakageCurrent: { default: 1e-6,  unit: "A", description: "DC leakage current at rated voltage", min: 0 },
    voltageRating:  { default: 25,    unit: "V", description: "Maximum rated voltage", min: 1 },
    reverseMax:     { default: 1.0,   unit: "V", description: "Reverse voltage threshold that triggers a polarity warning", min: 0 },
    // PC-W3-5: IC (alias initCond) param  capload.c:46-51 CAPinitCond
    IC:             { default: 0,     unit: "V", description: "Initial condition: junction voltage for UIC (alias: initCond)" },
    // PC-W3-6: M multiplicity param  capload.c:44 CAPm, applied at stamp time per user ruling 3
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
// PolarizedCapElement  AbstractCircuitElement (editor/visual layer)
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
    const plateOffset = 28 * PX; // 1.75  matches Falstad lead length (28px)

    // Left lead  colored by pos voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vPos, 0, 0, plateOffset, 0);

    // Right lead  colored by neg voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vNeg, 4, 0, 4 - plateOffset, 0);

    // Plate 1  straight line (positive/anode plate)
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(plateOffset, 0, 4 - plateOffset, 0, [
        { offset: 0, color: signals!.voltageColor(vPos) },
        { offset: 1, color: signals!.voltageColor(vNeg) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(plateOffset, -0.75, plateOffset, 0.75);

    // Plate 2  curved (exact Falstad 7-segment polyline)
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
 *  CJO=0, TT=0  no-capacitance diode schema (4 slots).
 *  IS=1e-14, N=1 are standard small-signal defaults; the clamp diode just
 *  provides a Shockley junction stamp between nPos/nNeg per F4b. */
function makeClampDiodeProps(): PropertyBag {
  const bag = new PropertyBag(new Map<string, number>().entries());
  bag.replaceModelParams({ ...DIODE_PARAM_DEFAULTS, CJO: 0, TT: 0 });
  return bag;
}

// ---------------------------------------------------------------------------
// AnalogPolarizedCapElement  MNA implementation
// ---------------------------------------------------------------------------

export class AnalogPolarizedCapElement implements PoolBackedAnalogElement {
  label: string = "";
  branchIndex: number = -1;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();

  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.CAP;
  readonly poolBacked = true as const;

  readonly stateSchema = POLARIZED_CAP_SCHEMA;
  // PC-W3-1: total state = cap-body slots + clamp diode slots (dioload.c:245-265)
  readonly stateSize = POLARIZED_CAP_SCHEMA.size + CLAMP_DIODE_STATE_SIZE; // 5 + 4 = 9 slots

  private _nCap: number = -1;
  private readonly _internalLabels: string[] = [];
  private _hESR_PP: number = -1;      private _hESR_NN: number = -1;
  private _hESR_PN: number = -1;      private _hESR_NP: number = -1;
  private _hLEAK_PP: number = -1;     private _hLEAK_NN: number = -1;
  private _hLEAK_PN: number = -1;     private _hLEAK_NP: number = -1;
  private _hCAP_PP: number = -1;      private _hCAP_NN: number = -1;
  private _hCAP_PN: number = -1;      private _hCAP_NP: number = -1;

  private C: number;
  private G_esr: number;
  private G_leak: number;
  private reverseMax: number;
  private _IC: number;     // PC-W3-5: capload.c:46-51 CAPinitCond
  private _M: number;      // PC-W3-6: capload.c:44 CAPm  applied at stamp time
  private _pool!: StatePoolRef;

  // PC-W3-1: clamp diode sub-element (F4b composition  dioload.c:245-265)
  // Oriented: A=nNeg, K=nPos so it conducts when cap is reverse-biased.
  private readonly _clampDiode: PoolBackedAnalogElement;

  private readonly _emitDiagnostic: (diag: Diagnostic) => void;
  private _reverseBiasDiagEmitted: boolean = false;

  /**
   * @param capacitance    - Capacitance in farads
   * @param esr            - Equivalent series resistance in ohms
   * @param rLeak          - Leakage resistance in ohms (V_rated / I_leak)
   * @param reverseMax     - Reverse voltage threshold in volts (positive value)
   * @param emitDiagnostic - Callback invoked when polarity violation is detected
   * @param IC             - PC-W3-5: Initial condition voltage (capload.c:46-51)
   * @param M              - PC-W3-6: Multiplicity factor (capload.c:44)
   * @param clampDiode     - Pre-constructed clamp diode sub-element
   */
  constructor(
    capacitance: number,
    esr: number,
    rLeak: number,
    reverseMax: number,
    emitDiagnostic: (diag: Diagnostic) => void,
    IC: number,
    M: number,
    clampDiode: PoolBackedAnalogElement,
  ) {
    this.C = capacitance;
    this.G_esr = 1 / Math.max(esr, MIN_RESISTANCE);
    this.G_leak = 1 / Math.max(rLeak, MIN_RESISTANCE);
    this.reverseMax = reverseMax;
    this._IC = IC;
    this._M = M;
    this._emitDiagnostic = emitDiagnostic;
    this._clampDiode = clampDiode;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this._pinNodes.get("pos")!;  // pos pin
    const negNode = this._pinNodes.get("neg")!;  // neg pin

    // Allocate internal node n_cap (junction between ESR and cap body).
    // No ngspice primitive equivalent- digiTS-internal topology extension.
    const nCap = ctx.makeVolt(this.label, "cap");
    this._nCap = nCap;
    this._internalLabels.length = 0;
    this._internalLabels.push("cap");

    // State slots- 9 total (5 cap body + 4 clamp diode).
    this._stateBase = ctx.allocStates(this.stateSize);

    // ESR RES stamps (ressetup.c:46-49, pos ↔ nCap).
    this._hESR_PP = solver.allocElement(posNode, posNode);
    this._hESR_NN = solver.allocElement(nCap,    nCap);
    this._hESR_PN = solver.allocElement(posNode, nCap);
    this._hESR_NP = solver.allocElement(nCap,    posNode);

    // Leakage RES stamps (ressetup.c:46-49, nCap ↔ neg).
    this._hLEAK_PP = solver.allocElement(nCap,    nCap);
    this._hLEAK_NN = solver.allocElement(negNode, negNode);
    this._hLEAK_PN = solver.allocElement(nCap,    negNode);
    this._hLEAK_NP = solver.allocElement(negNode, nCap);

    // Pre-partition the clamp diode's state region inside the composite's
    // 9-slot allocation (5 cap-body + 4 diode). The diode's setup has an
    // idempotent guard so it skips its own allocStates when _stateBase is
    // already set. C.4 fix- eliminates the per-step state-base patching
    // dance previously needed in tests.
    this._clampDiode._stateBase = this._stateBase + POLARIZED_CAP_SCHEMA.size;
    // Clamp diode sub-element setup (diosetup.c pattern, anode=neg, cathode=pos).
    this._clampDiode.setup(ctx);

    // CAP body stamps (capsetup.c:114-117, nCap ↔ neg).
    this._hCAP_PP = solver.allocElement(nCap,    nCap);
    this._hCAP_NN = solver.allocElement(negNode, negNode);
    this._hCAP_PN = solver.allocElement(nCap,    negNode);
    this._hCAP_NP = solver.allocElement(negNode, nCap);
  }

  initState(pool: StatePoolRef): void {
    if (this._stateBase === -1) {
      throw new Error("AnalogPolarizedCapElement.initState called before setup()");
    }
    this._pool = pool;
    // _clampDiode._stateBase was pre-partitioned inside setup() (C.4 fix);
    // initState only needs to forward to the diode now.
    this._clampDiode.initState(pool);
  }

  setParam(_key: string, _value: number): void {}

  getInternalNodeLabels(): readonly string[] {
    return this._internalLabels;
  }

  /**
   * Unified load()  ESR + leakage stamps + capacitor companion + clamp diode + polarity check.
   *
   * Topology: pos ─ ESR ─ nCap ─ (C || leakage) ─ neg.
   * Clamp diode stamps between nNeg (A) and nPos (K) per PC-W3-1 / dioload.c:245-265.
   * Stamps in one pass:
   *   - ESR conductance between nPos and nCap (cached handles).
   *   - Leakage conductance between nCap and nNeg (cached handles).
   *   - PC-W3-1: Clamp diode Shockley stamp between nNeg (A) and nPos (K).
   *   - Capacitor companion (geq, ceq) between nCap and nNeg using inline
   *     NIintegrate with ctx.ag[]  gated by capload.c:30 outer gate.
   *   - Polarity diagnostic when reverse-biased beyond reverseMax.
   *   - M multiplicity applied at every stamp site (PC-W3-6 / capload.c:44).
   */
  load(ctx: LoadContext): void {
    const { solver, rhsOld: voltages, ag } = ctx;
    const mode = ctx.cktMode;
    const nPos = this._pinNodes.get("pos")!;
    const nNeg = this._pinNodes.get("neg")!;
    const nCap = this._nCap;
    const base = this._stateBase;
    const m = this._M; // PC-W3-6: capload.c:44 CAPm
    // pool.states[N] accessed at call time  no cached Float64Array refs (A4).
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    // ESR conductance (nPos ↔ nCap)  cached handles.
    // Scaled by m (PC-W3-6: user ruling 3  apply m at stamp time, not by folding into C).
    solver.stampElement(this._hESR_PP,  m * this.G_esr);
    solver.stampElement(this._hESR_NN,  m * this.G_esr);
    solver.stampElement(this._hESR_PN, -m * this.G_esr);
    solver.stampElement(this._hESR_NP, -m * this.G_esr);

    // Leakage conductance (nCap ↔ nNeg)  cached handles, scaled by m.
    solver.stampElement(this._hLEAK_PP,  m * this.G_leak);
    solver.stampElement(this._hLEAK_NN,  m * this.G_leak);
    solver.stampElement(this._hLEAK_PN, -m * this.G_leak);
    solver.stampElement(this._hLEAK_NP, -m * this.G_leak);

    // PC-W3-1: Clamp diode stamp between nNeg (A) and nPos (K).
    // cite: dioload.c:245-265  Shockley forward/reverse structure for clamp junction.
    this._clampDiode.load(ctx);

    // Polarity detection  check anode vs cathode voltage.
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
    // PC-W3-2: outer gate per capload.c:30  MODEAC added.
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

    // PC-W3-3: inner fork per capload.c:52  MODEAC added.
    // cite: capload.c:52 if(ckt->CKTmode & (MODETRAN | MODEAC))
    if (mode & (MODETRAN | MODEAC)) {
      // Charge update (capload.c:54-66 pattern).
      if (mode & MODEINITPRED) {
        // cite: capload.c:55-56 state0[CAPqcap] = state1[CAPqcap]
        s0[base + SLOT_Q] = s1[base + SLOT_Q];
      } else {
        // cite: capload.c:59 state0[CAPqcap] = here->CAPcapac * vcap
        s0[base + SLOT_Q] = C * vNow;
        if (mode & MODEINITTRAN) {
          // cite: capload.c:60-62 state1[CAPqcap] = state0[CAPqcap]
          s1[base + SLOT_Q] = s0[base + SLOT_Q];
        }
      }

      const q0 = s0[base + SLOT_Q];
      const q1 = s1[base + SLOT_Q];
      const q2 = s2[base + SLOT_Q];
      const q3 = s3[base + SLOT_Q];
      const ccapPrev = s1[base + SLOT_CCAP];
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
      s0[base + SLOT_CCAP] = ccap;

      if (mode & MODEINITTRAN) {
        // cite: capload.c:70-72 state1[CAPccap] = state0[CAPccap]
        s1[base + SLOT_CCAP] = s0[base + SLOT_CCAP];
      }

      s0[base + SLOT_GEQ] = geq;
      s0[base + SLOT_IEQ] = ceq;
      s0[base + SLOT_V]   = vNow;

      // Stamp companion between nCap and nNeg via cached handles, scaled by m (PC-W3-6).
      // cite: capload.c:74-79 *(ptr) += m * geq / *(rhs) -= m * ceq
      solver.stampElement(this._hCAP_PP,  m * geq);
      solver.stampElement(this._hCAP_NN,  m * geq);
      solver.stampElement(this._hCAP_PN, -m * geq);
      solver.stampElement(this._hCAP_NP, -m * geq);
      if (nCap !== 0) stampRHS(ctx.rhs, nCap, -m * ceq);
      if (nNeg !== 0) stampRHS(ctx.rhs, nNeg,  m * ceq);
    } else {
      // DC operating point.
      // cite: capload.c:81 state0[CAPqcap] = here->CAPcapac * vcap
      s0[base + SLOT_Q] = C * vNow;
      s0[base + SLOT_V] = vNow;
      s0[base + SLOT_GEQ] = 0;
      s0[base + SLOT_IEQ] = 0;
    }
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const nPos = this._pinNodes.get("pos")!;
    const nCap = this._nCap;
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
    const base = this._stateBase;
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

function createPolarizedCapElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  const p = {
    capacitance:    props.getModelParam<number>("capacitance"),
    esr:            props.getModelParam<number>("esr"),
    leakageCurrent: props.getModelParam<number>("leakageCurrent"),
    voltageRating:  props.getModelParam<number>("voltageRating"),
    reverseMax:     props.getModelParam<number>("reverseMax"),
    // PC-W3-5: IC (alias initCond)  capload.c:46-51 CAPinitCond
    IC:             props.getModelParam<number>("IC"),
    // PC-W3-6: M multiplicity  capload.c:44 CAPm
    M:              props.getModelParam<number>("M"),
  };
  const rLeak = p.leakageCurrent > 0 ? p.voltageRating / p.leakageCurrent : 1e12;

  // PC-W3-1: construct clamp diode sub-element at factory time.
  // A = nNeg, K = nPos  conducts when cap is reverse-biased.
  const clampPinNodes = new Map<string, number>([
    ["A", pinNodes.get("neg")!], // anode = nNeg
    ["K", pinNodes.get("pos")!], // cathode = nPos
  ]);
  const clampDiode = createDiodeElement(clampPinNodes, makeClampDiodeProps(), () => 0) as PoolBackedAnalogElement;

  const el = new AnalogPolarizedCapElement(
    p.capacitance,
    p.esr,
    rLeak,
    p.reverseMax,
    () => {},
    p.IC,
    p.M,
    clampDiode,
  );

  el._pinNodes = new Map(pinNodes);

  el.setParam = function(key: string, value: number): void {
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

export const PolarizedCapDefinition: StandaloneComponentDefinition = {
  name: "PolarizedCap",
  typeId: -1,
  factory: polarizedCapCircuitFactory,
  pinLayout: buildPolarizedCapPinDeclarations(),
  propertyDefs: POLARIZED_CAP_PROPERTY_DEFS,
  attributeMap: POLARIZED_CAP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Polarized electrolytic capacitor  extends the standard capacitor with ESR,\n" +
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
