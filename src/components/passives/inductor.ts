/**
 * Inductor analog component.
 *
 * Reactive two-terminal element that requires a branch variable (extra MNA row)
 * to track branch current. Uses companion model (equivalent conductance + history
 * current source) recomputed at each timestep with one of three integration methods:
 * trapezoidal or gear (orders 1..2).
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
import { formatSI } from "../../editor/si-format.js";
import { PoolBackedAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { IntegrationMethod } from "../../solver/analog/integration.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import {
  MODEDC, MODEINITTRAN, MODEINITPRED, MODEUIC,
} from "../../solver/analog/ckt-mode.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";
import { defineStateSchema } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";
import type { TempContext } from "../../solver/analog/temp-context.js";
import type { SparseSolverStamp } from "../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// MutSiblingNotifiable — interface for MUT elements that notify partner inductors
// when they need to recompute MUTfactor after an L change. Declared here to avoid
// a circular import with mutual-inductor.ts.
// cite: muttemp.c:35-41 — MUTfactor = k · sqrt(INDinduct1 * INDinduct2)
// ---------------------------------------------------------------------------

export interface MutSiblingNotifiable {
  /** Recompute MUTfactor = k·√(L1·L2) when a partner inductor's L changes.
   *  Called from AnalogInductorElement.setParam("inductance", v).
   *  cite: muttemp.c:38 — MUTfactor = here->MUTcouple * sqrt(here->MUTind1->INDinduct * here->MUTind2->INDinduct)
   */
  recomputeMutFactor(): void;
}

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: INDUCTOR_PARAM_DEFS, defaults: INDUCTOR_DEFAULTS } = defineModelParams({
  primary: {
    inductance: { default: 1e-3, unit: "H", positional: true, description: "Inductance in henries (positional VALUE on the L-card per inp2l.c)", min: 1e-12 },
  },
  secondary: {
    IC:   { default: NaN,    unit: "A",    description: "Initial condition current for UIC" },
    TC1:  { default: 0,                    description: "Linear temperature coefficient" },
    TC2:  { default: 0,                    description: "Quadratic temperature coefficient" },
    TNOM: { default: 300.15, unit: "K",    description: "Nominal temperature for TC coefficients", spiceConverter: kelvinToCelsius },
    SCALE: { default: 1,                   description: "Instance scale factor" },
    M:    { default: 1,                    description: "Parallel multiplicity" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildInductorPinDeclarations(): PinDeclaration[] {
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
// InductorElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class InductorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Inductor", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildInductorPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    const r = 2 / (2 * 3); // segLen / (2 * loopCt) = 1/3
    // Add tiny epsilon to height: sin(PI)  1.22e-16, not exactly 0,
    // so arc endpoint y is ~4e-17 above 0; bbox must cover that.
    return {
      x: this.position.x,
      y: this.position.y - r,
      width: 4,
      height: r + 1e-10,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const inductance = this._properties.getModelParam<number>("inductance");
    const label = this._visibleLabel();

    ctx.save();
    ctx.setLineWidth(1);

    const vA = signals?.getPinVoltage("pos");
    const vB = signals?.getPinVoltage("neg");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Left lead  colored by pos pin voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vA, 0, 0, 1, 0);

    // Right lead  colored by neg pin voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vB, 3, 0, 4, 0);

    // Coil body: 3 semicircular arcs from PI to 2*PI  gradient from vA to vB
    const loopCt = 3;
    const segLen = 2;
    const r = segLen / (2 * loopCt); // arc radius = 1/3 grid unit
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(1, 0, 3, 0, [
        { offset: 0, color: signals!.voltageColor(vA) },
        { offset: 1, color: signals!.voltageColor(vB) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    for (let loop = 0; loop < loopCt; loop++) {
      const cx = 1 + (segLen * (loop + 0.5)) / loopCt;
      ctx.drawArc(cx, 0, r, Math.PI, 2 * Math.PI);
    }

    // Value label above body (matching Falstad reference: pixel (27,-10) = grid (1.6875,-0.625))
    const displayLabel = label.length > 0 ? label : (this._shouldShowValue() ? formatSI(inductance, "H") : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 1.6875, -0.625, { horizontal: "center", vertical: "bottom" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// AnalogInductorElement  MNA implementation
// ---------------------------------------------------------------------------

// State schema  exact ngspice INDinstance layout (inddefs.h:68-69).
// Two slots only:
//   INDflux = INDstate+0   flux Φ = L·i (the qcap fed to NIintegrate)
//   INDvolt = INDstate+1   NIintegrate companion-current cache. Despite the
//                            "INDvolt" name in ngspice, niinteg.c:15
//                            (`#define ccap qcap+1`) makes this slot the
//                            ccap recursion buffer for trap order 2.
// No GEQ/IEQ/I/VOLT-as-node-voltage slots exist in ngspice  req/veq are
// indload.c locals; branch current comes from CKTrhsOld[INDbrEq], not state.
const INDUCTOR_SCHEMA: StateSchema = defineStateSchema("AnalogInductorElement", [
  { name: "PHI",  doc: "Flux Φ = L·i  ngspice INDflux (INDstate+0)" },
  { name: "CCAP", doc: "NIintegrate companion current  ngspice INDvolt (INDstate+1) per niinteg.c:15 `#define ccap qcap+1`" },
]);

// Module-local slot index constants. External code must use
// stateSchema.indexOf.get("PHI") / stateSchema.indexOf.get("CCAP")
// (schema-lookups-over-exports memory entry).
const _SLOT_PHI  = 0;  // ngspice INDflux = INDstate+0
const _SLOT_CCAP = 1;  // ngspice INDvolt = INDstate+1 (= NIintegrate ccap)

export class AnalogInductorElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.IND;
  readonly deviceFamily: DeviceFamily = "IND";
  readonly stateSchema = INDUCTOR_SCHEMA;
  readonly stateSize = INDUCTOR_SCHEMA.size;

  private _nominalL: number;
  // Effective inductance after temperature derating, SCALE, and /M.
  // Corresponds to ngspice `here->INDinduct/m` after indtemp.c:71-72.
  private _effectiveL: number;
  private _IC: number;
  private _TC1: number;
  private _TC2: number;
  private _TNOM: number;
  private _SCALE: number;
  private _M: number;
  protected _hPIbr:   number = -1;
  protected _hNIbr:   number = -1;
  protected _hIbrN:   number = -1;
  protected _hIbrP:   number = -1;
  protected _hIbrIbr: number = -1;


  /**
   * MUT sibling elements registered by MutualInductorElement.setup().
   * Populated by push from MUT so the cascade from setParam("inductance") can
   * call m.recomputeMutFactor() for every coupled MUT element.
   * cite: muttemp.c:35-41 — MUTfactor = k · sqrt(INDinduct1 * INDinduct2);
   * recomputed whenever a partner inductance changes.
   */
  _mutSiblings: MutSiblingNotifiable[] = [];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._nominalL = props.getModelParam<number>("inductance");
    this._IC    = props.hasModelParam("IC")    ? props.getModelParam<number>("IC")    : INDUCTOR_DEFAULTS["IC"]!;
    this._TC1   = props.hasModelParam("TC1")   ? props.getModelParam<number>("TC1")   : INDUCTOR_DEFAULTS["TC1"]!;
    this._TC2   = props.hasModelParam("TC2")   ? props.getModelParam<number>("TC2")   : INDUCTOR_DEFAULTS["TC2"]!;
    this._TNOM  = props.hasModelParam("TNOM")  ? props.getModelParam<number>("TNOM")  : INDUCTOR_DEFAULTS["TNOM"]!;
    this._SCALE = props.hasModelParam("SCALE") ? props.getModelParam<number>("SCALE") : INDUCTOR_DEFAULTS["SCALE"]!;
    this._M     = props.hasModelParam("M")     ? props.getModelParam<number>("M")     : INDUCTOR_DEFAULTS["M"]!;
    // cite: indtemp.c:55-72 — initial effective L at construction uses TNOM as
    // the reference temperature (difference = 0), so factor = 1 and
    // _effectiveL = _nominalL * SCALE / M. computeTemperature() will update
    // this before load() runs.
    this._effectiveL = this._nominalL * this._SCALE / this._M;
  }

  /**
   * Expose the post-temperature effective inductance value for MUT coupling.
   * MUT reads this to compute MUTfactor = k · sqrt(L1 · L2) in its own
   * computeTemperature callback.
   * cite: muttemp.c:38 — sqrt(here->MUTind1->INDinduct * here->MUTind2->INDinduct)
   */
  get inductance(): number {
    return this._effectiveL;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const pinNodes = this.pinNodes;
    const posNode = pinNodes.get("pos")!;  // INDposNode
    const negNode = pinNodes.get("neg")!;  // INDnegNode

    // indsetup.c:78-79 — *states += 2 (INDflux = state+0, INDvolt = state+1)
    this._stateBase = ctx.allocStates(this.stateSize);

    // indsetup.c:84-88 — CKTmkCur guard (idempotent, mirrors VSRCfindBr pattern).
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    const b = this.branchIndex;

    // indsetup.c:96-100 — TSTALLOC sequence, line-for-line.
    this._hPIbr   = solver.allocElement(posNode, b);  // (INDposNode, INDbrEq)
    this._hNIbr   = solver.allocElement(negNode, b);  // (INDnegNode, INDbrEq)
    this._hIbrN   = solver.allocElement(b, negNode);  // (INDbrEq,    INDnegNode)
    this._hIbrP   = solver.allocElement(b, posNode);  // (INDbrEq,    INDposNode)
    this._hIbrIbr = solver.allocElement(b, b);        // (INDbrEq,    INDbrEq)
  }

  findBranchFor(name: string, ctx: SetupContext): number {
    if (name !== this.label) return 0;
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    return this.branchIndex;
  }

  /**
   * computeTemperature — per-instance temperature derating.
   *
   * cite: indtemp.c:55-72 —
   *   difference = (here->INDtemp + here->INDdtemp) - model->INDtnom
   *   factor = 1.0 + tc1*difference + tc2*difference*difference
   *   here->INDinduct = here->INDinduct * factor * INDscale / INDm
   *
   * Our instance TNOM (_TNOM) maps to ngspice’s model->INDtnom for the case
   * where the instance does not override temperature (indtemp.c:35-43).
   * ctx.cktTemp maps to (here->INDtemp + here->INDdtemp) = ckt->CKTtemp.
   */
  computeTemperature(ctx: TempContext): void {
    // cite: indtemp.c:55 — difference = (INDtemp + INDdtemp) - INDtnom
    const difference = ctx.cktTemp - this._TNOM;
    // cite: indtemp.c:69 — factor = 1.0 + tc1*difference + tc2*difference*difference
    const factor = 1.0 + this._TC1 * difference + this._TC2 * difference * difference;
    // cite: indtemp.c:71-72 — INDinduct = INDinduct * factor * INDscale / INDm
    this._effectiveL = this._nominalL * factor * this._SCALE / this._M;
  }

  setParam(key: string, value: number): void {
    if (key === "inductance" || key === "L") {
      this._nominalL = value;
      this._effectiveL = this._nominalL * this._SCALE / this._M;
      // Cascade to MUT siblings so MUTfactor = k·√(L1·L2) stays current.
      // cite: muttemp.c:35-41 — MUTfactor depends on both partner INDinduct values.
      for (const m of this._mutSiblings) {
        m.recomputeMutFactor();
      }
    } else if (key === "IC") {
      this._IC = value;
    } else if (key === "TC1") {
      this._TC1 = value;
    } else if (key === "TC2") {
      this._TC2 = value;
    } else if (key === "TNOM") {
      this._TNOM = value;
    } else if (key === "SCALE") {
      this._SCALE = value;
      this._effectiveL = this._nominalL * this._SCALE / this._M;
    } else if (key === "M") {
      this._M = value;
      this._effectiveL = this._nominalL * this._SCALE / this._M;
    }
  }

  /**
   * loadFluxInit — Pass 1 of the IND_FAMILY 3-pass load.
   *
   * cite: indload.c:43-51 — flux-from-current update, gated on
   *   !(ckt->CKTmode & (MODEDC|MODEINITPRED)).
   *
   * Sets s0[INDflux] = (INDinduct/m) · CKTrhsOld[INDbrEq].
   * Under MODEUIC + MODEINITTRAN with a valid IC, seeds from INDinitCond instead.
   * At DC or INITPRED mode, this method is a no-op — the flux is left unchanged
   * so the INITPRED copy in load() Pass 3 can propagate s1→s0 correctly.
   *
   * Called by IndFamilyLoadHandler before the MUT pass (Pass 2) so that MUT
   * can augment s0[INDflux] with M·i_partner via augmentFlux().
   */
  loadFluxInit(ctx: LoadContext): void {
    const { rhsOld, cktMode: mode } = ctx;
    const b = this.branchIndex;
    const L = this._effectiveL;
    const base = this._stateBase;
    const s0 = this._pool.states[0];

    // cite: indload.c:43 — if(!(ckt->CKTmode & (MODEDC|MODEINITPRED)))
    if (!(mode & (MODEDC | MODEINITPRED))) {
      if ((mode & MODEUIC) && (mode & MODEINITTRAN) && !isNaN(this._IC)) {
        // cite: indload.c:44-46 — UIC seed: INDflux = INDinduct/m * INDinitCond
        s0[base + _SLOT_PHI] = L * this._IC;
      } else {
        // cite: indload.c:48-50 — INDflux = INDinduct/m * CKTrhsOld[INDbrEq]
        s0[base + _SLOT_PHI] = L * rhsOld[b];
      }
    }
  }

  /**
   * augmentFlux — called by MutualInductorElement.loadCouplingPass() (Pass 2)
   * to add M·i_partner to this inductor’s flux accumulator before Pass 3.
   *
   * cite: indload.c:65-67 —
   *   *(ckt->CKTstate0 + muthere->MUTind1->INDflux) +=
   *     muthere->MUTfactor * *(ckt->CKTrhsOld + muthere->MUTind2->INDbrEq);
   *
   * PHI slot is resolved via stateSchema.indexOf to honour the schema-lookup
   * pattern (project memory feedback_schema_lookups_over_exports.md).
   */
  public augmentFlux(delta: number): void {
    // cite: indload.c:65-71 — CKTstate0[INDflux] += MUTfactor * CKTrhsOld[partner->INDbrEq]
    const slotPhi = this.stateSchema.indexOf.get("PHI")!;
    this._pool.states[0][this._stateBase + slotPhi] += delta;
  }

  /**
   * load — Pass 3 of the IND_FAMILY 3-pass load: NIintegrate + 5-stamp.
   *
   * s0[PHI] has been set by loadFluxInit() (Pass 1) and augmented by MUT
   * coupling (Pass 2) before this method runs.
   *
   * cite: indload.c:88-125 —
   *   indload.c:88-90    DC path: req=0, veq=0.
   *   indload.c:93-104   (#ifndef PREDICTOR): MODEINITPRED copies s1→s0 PHI;
   *                        MODEINITTRAN copies s0→s1 PHI before NIintegrate.
   *   indload.c:106-109  NIintegrate(ckt, &req, &veq, newmind, here->INDflux).
   *   indload.c:112      *(CKTrhs + INDbrEq) += veq.
   *   indload.c:114-117  MODEINITTRAN: s1[INDvolt] = s0[INDvolt].
   *   indload.c:119-123  unconditional 5-stamp sequence.
   */
  load(ctx: LoadContext): void {
    const { solver, ag, cktMode: mode } = ctx;
    const b = this.branchIndex;
    const L = this._effectiveL;
    const base = this._stateBase;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    // indload.c:88-110 — req/veq.
    let req = 0;
    let veq = 0;
    if (mode & MODEDC) {
      // cite: indload.c:88-90 — DC path: req = 0, veq = 0.
      req = 0;
      veq = 0;
    } else {
      // cite: indload.c:93-104 (#ifndef PREDICTOR): mutually-exclusive flux copies.
      if (mode & MODEINITPRED) {
        // cite: indload.c:94-96 — predictor: s0[INDflux] = s1[INDflux].
        s0[base + _SLOT_PHI] = s1[base + _SLOT_PHI];
      } else if (mode & MODEINITTRAN) {
        // cite: indload.c:99-102 — transient init: s1[INDflux] = s0[INDflux]
        // BEFORE NIintegrate so the order-2 history is seeded.
        s1[base + _SLOT_PHI] = s0[base + _SLOT_PHI];
      }
      // cite: indload.c:106-109 — NIintegrate(ckt, &geq, &ceq, newmind, here->INDflux).
      // niinteg.c writes state0[INDvolt] = state0[ccap] = s0[_SLOT_CCAP].
      const phi0 = s0[base + _SLOT_PHI];
      const phi1 = s1[base + _SLOT_PHI];
      const phi2 = s2[base + _SLOT_PHI];
      const phi3 = s3[base + _SLOT_PHI];
      const ccapPrev = s1[base + _SLOT_CCAP];
      const ni = niIntegrate(
        ctx.method,
        ctx.order,
        L,
        ag,
        phi0, phi1,
        [phi2, phi3, 0, 0, 0],
        ccapPrev,
      );
      req = ni.geq;
      veq = ni.ceq;
      s0[base + _SLOT_CCAP] = ni.ccap;
    }

    // cite: indload.c:114-117 — MODEINITTRAN: s1[INDvolt] = s0[INDvolt]
    // (= s1[CCAP] = s0[CCAP]; seeds the trap-order-2 recursion buffer).
    if (mode & MODEINITTRAN) {
      s1[base + _SLOT_CCAP] = s0[base + _SLOT_CCAP];
    }

    // cite: indload.c:119-123 — unconditional 5-stamp through cached handles.
    // INDposIbrptr / INDnegIbrptr (B sub-matrix: ±1 at (n, b)).
    solver.stampElement(this._hPIbr, 1);   // *(INDposIbrptr) += 1
    solver.stampElement(this._hNIbr, -1);  // *(INDnegIbrptr) -= 1
    // INDibrPosptr / INDibrNegptr (C sub-matrix: ±1 at (b, n) — KVL incidence).
    solver.stampElement(this._hIbrP, 1);   // *(INDibrPosptr) += 1
    solver.stampElement(this._hIbrN, -1);  // *(INDibrNegptr) -= 1
    // INDibrIbrptr (-req branch diagonal). Stamped even at DC where req=0 so
    // the structural nonzero is preserved across the handle table.
    solver.stampElement(this._hIbrIbr, -req);  // *(INDibrIbrptr) -= req
    // cite: indload.c:112 — *(CKTrhs + INDbrEq) += veq.
    stampRHS(ctx.rhs, b, veq);
  }

  /**
   * stampAc — AC small-signal stamp per indacld.c.
   *
   * cite: indacld.c:27-35 —
   *   m = here->INDm;
   *   val = ckt->CKTomega * here->INDinduct / m;
   *   *(INDposIbrPtr)   +=  1;   (real)
   *   *(INDnegIbrPtr)   -=  1;   (real)
   *   *(INDibrPosPtr)   +=  1;   (real)
   *   *(INDibrNegPtr)   -=  1;   (real)
   *   *(INDibrIbrPtr+1) -=  val; (imaginary branch-diagonal: jωL impedance)
   *
   * _effectiveL already incorporates the /m division from indtemp.c:72.
   *
   * Allocation lives in setup() (the five solver.allocElement calls at
   * indsetup.c:96-100 TSTALLOC order), mirroring ngspice's INDsetup/INDacLoad
   * function boundary: INDsetup TSTALLOCs the five pointers once;
   * INDacLoad performs no allocation and stamps through the same
   * pre-allocated pointers. Under the unified SparseSolver each handle
   * addresses both the real half (written by load() / stampElement) and the
   * imaginary half (written here via stampElementImag) of one cell.
   */
  stampAc(solver: SparseSolverStamp, omega: number, _ctx: LoadContext): void {
    // cite: indacld.c:29 — val = ckt->CKTomega * here->INDinduct / m
    const val = omega * this._effectiveL;

    // cite: indacld.c:31-34 — 4 real ±1 connectivity stamps (`*ptr ±= 1`).
    // The five handles _hPIbr/_hNIbr/_hIbrP/_hIbrN/_hIbrIbr were TSTALLOC'd
    // once in setup() (inductor.ts above; indsetup.c:96-100 order); INDacLoad
    // is a pure stamp on those same pointers.
    solver.stampElement(this._hPIbr,  1);  // *(INDposIbrPtr) += 1
    solver.stampElement(this._hNIbr, -1);  // *(INDnegIbrPtr) -= 1
    solver.stampElement(this._hIbrP,  1);  // *(INDibrPosPtr) += 1
    solver.stampElement(this._hIbrN, -1);  // *(INDibrNegPtr) -= 1
    // cite: indacld.c:35 — `*(INDibrIbrPtr+1) -= val`: imaginary branch diagonal.
    solver.stampElementImag(this._hIbrIbr, -val);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const I = rhs[this.branchIndex];
    return [I, -I];
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
    const phi0 = s0[base + _SLOT_PHI];
    const phi1 = s1[base + _SLOT_PHI];
    const phi2 = s2[base + _SLOT_PHI];
    const phi3 = s3[base + _SLOT_PHI];
    const ccap0 = s0[base + _SLOT_CCAP];
    const ccap1 = s1[base + _SLOT_CCAP];
    return cktTerr(dt, deltaOld, order, method, phi0, phi1, phi2, phi3, ccap0, ccap1, lteParams);
  }
}

function createInductorElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  return new AnalogInductorElement(pinNodes, props);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const INDUCTOR_PROPERTY_DEFS: PropertyDefinition[] = [
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

export const INDUCTOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "inductance",
    propertyKey: "inductance",
    convert: (v) => parseFloat(v),
    modelParam: true,
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// InductorDefinition
// ---------------------------------------------------------------------------

function inductorCircuitFactory(props: PropertyBag): InductorElement {
  return new InductorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const InductorDefinition: StandaloneComponentDefinition = {
  name: "Inductor",
  typeId: -1,
  factory: inductorCircuitFactory,
  pinLayout: buildInductorPinDeclarations(),
  propertyDefs: INDUCTOR_PROPERTY_DEFS,
  attributeMap: INDUCTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Inductor  reactive element with companion model and branch current.\n" +
    "Stamps equivalent conductance, history current, and branch incidence entries.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createInductorElement,
      paramDefs: INDUCTOR_PARAM_DEFS,
      params: INDUCTOR_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
