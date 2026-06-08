/**
 * Capacitor analog component.
 *
 * Reactive two-terminal element modelled using companion model (equivalent
 * conductance + history current source). Implements updateCompanion() to
 * recompute geq and ieq at each timestep using one of three integration methods:
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
import { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { IntegrationMethod } from "../../solver/analog/integration.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import {
  MODETRAN, MODEAC, MODETRANOP, MODEDC,
  MODEINITJCT, MODEINITTRAN, MODEINITPRED, MODEUIC,
} from "../../solver/analog/ckt-mode.js";
import { allocNortonStamp, stampNortonAt } from "../../solver/analog/stamp-helpers.js";
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import type { TempContext } from "../../solver/analog/temp-context.js";
import type { SparseSolverStamp } from "../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Physical constants — ngspice const.h
// ---------------------------------------------------------------------------

// const.h:44 — CONSTmuZero = 4·π·1e-7 H/m.
const CONST_MU_ZERO = 4.0 * Math.PI * 1e-7;
// const.h:19 — CONSTc = 299792458 m/s (speed of light).
const CONST_C = 299792458;
// const.h:47 — CONSTepsZero = 1 / (CONSTmuZero · CONSTc²)  F/m (vacuum permittivity).
const EPS0 = 1.0 / (CONST_MU_ZERO * CONST_C * CONST_C);
// const.h:51 — CONSTepsrSiO2 = 3.9 (relative permittivity of SiO₂).
const CONST_EPSR_SIO2 = 3.9;
// const.h:53 — CONSTepsSiO2 = CONSTepsrSiO2 · CONSTepsZero  F/m.
const EPS_SIO2 = CONST_EPSR_SIO2 * EPS0;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

// Partitioning mirrors ngspice's CAPparam (capparam.c:30-83) vs CAPmodel
// (model-level params handled by CAPmParam): instance-level params live in
// the `instance:` bucket so the harness netlist-generator emits them on the
// C-card line via instanceParamSuffix; model-level params live in `secondary:`
// (partition "model") and emit through the `.model` card.
export const { paramDefs: CAPACITOR_PARAM_DEFS, defaults: CAPACITOR_DEFAULTS } = defineModelParams({
  primary: {
    // capparam.c:31-36 — CAP_CAP, the positional VALUE on the C-card; the
    // emitter special-cases it via requireParam, not the partition machinery.
    capacitance: { default: 1e-6, unit: "F", positional: true, description: "Capacitance in farads (positional VALUE on the C-card per inp2c.c:18)", min: 1e-15 },
  },
  secondary: {
    // Model-level reference temperature — ngspice CAPmodel CAPtnom.
    TNOM: { default: 300.15, unit: "K", description: "Nominal temperature for TC coefficients", spiceConverter: kelvinToCelsius },
    // Geometric-capacitance model parameters — ngspice CAPmodel
    // (capsetup.c:31-88, captemp.c:55-68).
    cj:     { default: 0.0,     unit: "F/m^2", description: "Junction bottom capacitance per area" },
    cjsw:   { default: 0.0,     unit: "F/m",   description: "Junction sidewall capacitance per perimeter" },
    defw:   { default: 10e-6,   unit: "m",     description: "Default device width" },
    defl:   { default: 0.0,     unit: "m",     description: "Default device length" },
    narrow: { default: 0.0,     unit: "m",     description: "Width correction factor" },
    short:  { default: 0.0,     unit: "m",     description: "Length correction factor" },
    del:    { default: 0.0,     unit: "m",     description: "Width/length etch correction" },
    di:     { default: 0.0,                    description: "Relative dielectric constant" },
    thick:  { default: 0.0,     unit: "m",     description: "Dielectric thickness" },
    mCap:   { default: 0.0,     unit: "F",     spiceName: "cap", description: "Model default capacitance (cap.c:40 CAP_MOD_CAP)" },
  },
  instance: {
    // Per-instance params accepted by ngspice CAPparam (capparam.c:37-79).
    IC:    { default: 0.0,    unit: "V", description: "Initial condition voltage for UIC" },
    TC1:   { default: 0,                 description: "Linear temperature coefficient" },
    TC2:   { default: 0,                 description: "Quadratic temperature coefficient" },
    SCALE: { default: 1,                 description: "Instance scale factor" },
    M:     { default: 1,                 description: "Parallel multiplicity" },
    // CAPwidth defaults to model defw when not given (captemp.c:49-51);
    // CAPlength defaults to 0 (capsetup.c:95-97).
    w:     { default: 10e-6, unit: "m", spiceName: "W", description: "Instance device width" },
    l:     { default: 0.0,   unit: "m", spiceName: "L", description: "Instance device length" },
    // captemp.c:38-47 — CAPtemp / CAPdtemp.
    TEMP:  { default: 300.15, unit: "K", description: "Instance operating temperature", spiceConverter: kelvinToCelsius },
    DTEMP: { default: 0.0,    unit: "K", description: "Instance temperature delta from ambient" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildCapacitorPinDeclarations(): PinDeclaration[] {
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
// CapacitorElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class CapacitorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Capacitor", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildCapacitorPinDeclarations(), []);
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
    const capacitance = this._properties.getModelParam<number>("capacitance");
    const label = this._visibleLabel();

    ctx.save();
    ctx.setLineWidth(1);

    const vA = signals?.getPinVoltage("pos");
    const vB = signals?.getPinVoltage("neg");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Left lead + plate  colored by pin A voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vA, 0, 0, 1.75, 0);
    ctx.drawLine(1.75, -0.75, 1.75, 0.75);

    // Right lead + plate  colored by pin B voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vB, 2.25, 0, 4, 0);
    ctx.drawLine(2.25, -0.75, 2.25, 0.75);

    // Value label below body
    const displayLabel = label.length > 0 ? label : (this._shouldShowValue() ? formatSI(capacitance, "F") : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 2, 1, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// AnalogCapacitorElement  MNA implementation
// ---------------------------------------------------------------------------

// Slot layout — ngspice CAPstate, 2 slots (capsetup.c:103 `*states += 2`,
// niinteg.c:15 `#define ccap qcap+1`). Q = CKTstate0[CAPqcap]; CCAP =
// CKTstate0[CAPqcap+1]. geq/ieq/V are recomputable on the fly from
// state + ag[] + voltages and live as locals in capload.c, not the state
// vector — so they are not allocated here.
const CAPACITOR_SCHEMA: StateSchema = defineStateSchema("AnalogCapacitorElement", [
  { name: "Q",    doc: "Charge Q=C*V — ngspice CAPqcap (CAPstate+0)" },
  { name: "CCAP", doc: "NIintegrate companion current — ngspice ccap (CAPstate+1) per niinteg.c:15" },
]);

const SLOT_Q    = 0;
const SLOT_CCAP = 1;

/**
 * This class is the runtime element produced by the registered
 * `Capacitor` `StandaloneComponentDefinition`'s factory - see
 * `createCapacitorElement` below. It is the canonical capacitor
 * stamp; do not introduce a parallel non-registered capacitor
 * class.
 */
export class AnalogCapacitorElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.CAP;
  readonly deviceFamily: DeviceFamily = "CAP";
  readonly stateSchema = CAPACITOR_SCHEMA;
  readonly stateSize = CAPACITOR_SCHEMA.size;

  private _nominalC: number;
  private C: number;
  private _IC: number;
  private _TC1: number;
  private _TC2: number;
  private _TNOM: number;
  private _SCALE: number;
  private _M: number;

  // Geometric-capacitance model parameters — ngspice CAPmodel
  // (capsetup.c:31-88, captemp.c:55-68). _cj / _narrow / _short may be
  // overwritten by the setup() default-processing block (Part B.0).
  private _cj: number;
  private _cjsw: number;
  private _defw: number;
  private _narrow: number;
  private _short: number;
  private _del: number;
  private _di: number;
  private _thick: number;
  private _mCap: number;
  // *Given guards — true when the netlist supplied the param. Gate the
  // capsetup.c:71-88 cj/narrow/short derivation and the captemp.c:55-68
  // base-capacitance selection.
  private _cjGiven: boolean;
  private _mCapGiven: boolean;
  private _narrowGiven: boolean;
  private _shortGiven: boolean;
  private _delGiven: boolean;
  private _diGiven: boolean;
  private _thickGiven: boolean;

  // Per-instance geometry — ngspice CAPwidth / CAPlength (captemp.c:49-51,
  // capsetup.c:95-97).
  private _w: number;
  private _l: number;
  private _wGiven: boolean;
  private _lGiven: boolean;
  // True when the netlist supplied an instance capacitance — gates the
  // captemp.c:55-70 base-capacitance selection.
  private _capGiven: boolean;

  // Per-instance temperature parameters — ngspice CAPtemp / CAPdtemp
  // (captemp.c:38-47).
  private _TEMP: number;
  private _DTEMP: number;
  private _tempGiven: boolean;
  private _dtempGiven: boolean;

  // Cached Norton-stamp handles [hPP, hNN, hPN, hNP] allocated in setup()
  // per capsetup.c:114-117 (TSTALLOC sequence). Under the unified solver
  // these four handles address both the real half (stampElement, written by
  // CAPload at load() time) and the imaginary half (stampElementImag,
  // written by CAPacLoad at stampAc() time) of the same four matrix cells —
  // mirroring ngspice's *(CAPposPosPtr) / *(CAPposPosPtr+1) pointer pair.
  // No separate AC-side handle fields exist: CAPsetup allocates once,
  // CAPload and CAPacLoad both stamp through the same pointers.
  private _handles: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    // *Given guards mirror ngspice's per-instance/model `<x>Given` flags:
    // true only when the netlist actually supplied `<x>`. PropertyBag seeds
    // every registered param's default into the model-param partition
    // (builder.ts:214-215) without marking it given, so hasModelParam(<any
    // declared param>) is permanently true. isModelParamGiven mirrors the
    // ngspice flag (properties.ts:200-203), matching the semiconductors
    // (diode.ts:528, bjt.ts:525, mosfet.ts:849, njfet.ts:315, pjfet.ts:284,
    // zener.ts:218). Value reads use it too: a seeded default and an absent
    // param both fall to CAPACITOR_DEFAULTS, so the two ternary branches
    // converge — but isModelParamGiven keeps the read consistent with the
    // guards.
    this._capGiven = props.isModelParamGiven("capacitance");
    this._nominalC = this._capGiven ? props.getModelParam<number>("capacitance") : CAPACITOR_DEFAULTS["capacitance"]!;
    this._IC       = props.isModelParamGiven("IC")    ? props.getModelParam<number>("IC")    : CAPACITOR_DEFAULTS["IC"]!;
    this._TC1      = props.isModelParamGiven("TC1")   ? props.getModelParam<number>("TC1")   : CAPACITOR_DEFAULTS["TC1"]!;
    this._TC2      = props.isModelParamGiven("TC2")   ? props.getModelParam<number>("TC2")   : CAPACITOR_DEFAULTS["TC2"]!;
    this._TNOM     = props.isModelParamGiven("TNOM")  ? props.getModelParam<number>("TNOM")  : CAPACITOR_DEFAULTS["TNOM"]!;
    this._SCALE    = props.isModelParamGiven("SCALE") ? props.getModelParam<number>("SCALE") : CAPACITOR_DEFAULTS["SCALE"]!;
    this._M        = props.isModelParamGiven("M")     ? props.getModelParam<number>("M")     : CAPACITOR_DEFAULTS["M"]!;

    // Geometric-capacitance model parameters — *Given guards gate the
    // capsetup.c:71-88 cj/narrow/short derivation and the captemp.c:55-68
    // base-capacitance selection.
    this._cjGiven     = props.isModelParamGiven("cj");
    this._cj          = this._cjGiven ? props.getModelParam<number>("cj") : CAPACITOR_DEFAULTS["cj"]!;
    this._cjsw        = props.isModelParamGiven("cjsw")   ? props.getModelParam<number>("cjsw")   : CAPACITOR_DEFAULTS["cjsw"]!;
    this._defw        = props.isModelParamGiven("defw")   ? props.getModelParam<number>("defw")   : CAPACITOR_DEFAULTS["defw"]!;
    this._narrowGiven = props.isModelParamGiven("narrow");
    this._narrow      = this._narrowGiven ? props.getModelParam<number>("narrow") : CAPACITOR_DEFAULTS["narrow"]!;
    this._shortGiven  = props.isModelParamGiven("short");
    this._short       = this._shortGiven ? props.getModelParam<number>("short") : CAPACITOR_DEFAULTS["short"]!;
    this._delGiven    = props.isModelParamGiven("del");
    this._del         = this._delGiven ? props.getModelParam<number>("del") : CAPACITOR_DEFAULTS["del"]!;
    this._diGiven     = props.isModelParamGiven("di");
    this._di          = this._diGiven ? props.getModelParam<number>("di") : CAPACITOR_DEFAULTS["di"]!;
    this._thickGiven  = props.isModelParamGiven("thick");
    this._thick       = this._thickGiven ? props.getModelParam<number>("thick") : CAPACITOR_DEFAULTS["thick"]!;
    this._mCapGiven   = props.isModelParamGiven("mCap");
    this._mCap        = this._mCapGiven ? props.getModelParam<number>("mCap") : CAPACITOR_DEFAULTS["mCap"]!;

    // Per-instance geometry — CAPwidth defaults to model defw when not given
    // (captemp.c:49-51); CAPlength defaults to 0 (capsetup.c:95-97).
    this._wGiven = props.isModelParamGiven("w");
    this._w      = this._wGiven ? props.getModelParam<number>("w") : this._defw;
    this._lGiven = props.isModelParamGiven("l");
    this._l      = this._lGiven ? props.getModelParam<number>("l") : 0;

    // Per-instance temperature — captemp.c:38-47.
    this._tempGiven  = props.isModelParamGiven("TEMP");
    this._TEMP       = this._tempGiven ? props.getModelParam<number>("TEMP") : CAPACITOR_DEFAULTS["TEMP"]!;
    this._dtempGiven = props.isModelParamGiven("DTEMP");
    this._DTEMP      = this._dtempGiven ? props.getModelParam<number>("DTEMP") : CAPACITOR_DEFAULTS["DTEMP"]!;

    // capload.c:44  CAPm is applied at stamp time, not folded into CAPcapac.
    // Construction-time C uses the inductor-pattern init (inductor.ts:248-252):
    // the reference temperature is TNOM, so difference = 0, factor = 1, and
    // C = base · SCALE with base = _nominalC. computeTemperature() overwrites
    // C with the geometry/TC/SCALE fold before the first NR iteration.
    this.C = this._nominalC * this._SCALE;
  }

  setup(ctx: import("../../solver/analog/setup-context.js").SetupContext): void {
    const posNode = this.pinNodes.get("pos")!;  // CAPposNode
    const negNode = this.pinNodes.get("neg")!;  // CAPnegNode

    // capsetup.c:71-81 — cj-from-thickness derivation. When cj was not
    // supplied directly, derive it from di/thick: di·ε₀/thick if di is given,
    // else εSiO2/thick when thick > 0, else 0.
    if (!this._cjGiven) {
      if (this._thickGiven && this._thick > 0.0) {
        if (this._diGiven) {
          this._cj = (this._di * EPS0) / this._thick;
        } else {
          this._cj = EPS_SIO2 / this._thick;
        }
      } else {
        this._cj = 0.0;
      }
    }

    // capsetup.c:83-87 — del-driven narrow/short derivation. When del was
    // supplied, narrow/short default to 2·del where not explicitly given.
    if (this._delGiven) {
      if (!this._narrowGiven) this._narrow = 2 * this._del;
      if (!this._shortGiven)  this._short  = 2 * this._del;
    }

    // capsetup.c:102-103 — `*states += 2` (CAPqcap slot, with ccap = qcap+1
    // per niinteg.c:15).
    this._stateBase = ctx.allocStates(this.stateSize);

    // capsetup.c:114-117  TSTALLOC sequence. ngspice makes these
    // allocations unconditionally (TSTALLOC has no ground guard);
    // allocElement(0,X) / allocElement(X,0) returns the TrashCan handle
    // 0, whose elVal[0] is zeroed every NR iter.
    this._handles = allocNortonStamp(ctx.solver, posNode, negNode);
  }

  /**
   * computeTemperature — per-instance temperature pass.
   *
   * cite: captemp.c:38-89 (CAPtemp instance body). Selects the base
   * capacitance (instance value / model mCap / area·cj + perimeter·cjsw),
   * resolves the per-instance operating temperature, and folds the TC/SCALE
   * correction into the effective capacitance this.C.
   *
   * The base-capacitance selection covers the two `!CAPcapGiven` arms
   * (captemp.c:55-68): the geometry formula and the model-mCap default. When
   * an instance capacitance is given, the base is the netlisted value
   * (this._nominalC).
   */
  computeTemperature(ctx: TempContext): void {
    // captemp.c:38-47 — per-instance temperature override. When temp is given
    // the instance uses its absolute TEMP and dtemp is forced 0 and ignored
    // (ngspice prints a warning if dtemp was also supplied); otherwise the
    // operating temperature is ambient + DTEMP.
    let effectiveTemp: number;
    if (this._tempGiven) {
      effectiveTemp = this._TEMP;
      if (this._dtempGiven) {
        console.warn(`${this.label}: Instance temperature specified, dtemp ignored`);
      }
    } else {
      effectiveTemp = ctx.cktTemp + this._DTEMP;
    }

    // captemp.c:49-51 — CAPwidth defaults to model defw when not given.
    if (!this._wGiven) this._w = this._defw;

    // captemp.c:55-70 — base capacitance selection. When no instance
    // capacitance is given, the base is either the geometry formula or the
    // model mCap default; when an instance capacitance is given, the base is
    // the netlisted value (this._nominalC).
    let base: number;
    if (!this._capGiven) {
      if (!this._mCapGiven) {
        // captemp.c:57-63 — area·cj + perimeter·cjsw. _cj / _narrow / _short
        // were resolved in setup() (capsetup.c:71-88).
        base =
          this._cj *
          (this._w - this._narrow) *
          (this._l - this._short) +
          this._cjsw * 2 * (
            (this._l - this._short) +
            (this._w - this._narrow));
      } else {
        // captemp.c:66 — model default capacitance.
        base = this._mCap;
      }
    } else {
      base = this._nominalC;
    }

    // captemp.c:72-89 — TC/SCALE fold.
    const difference = effectiveTemp - this._TNOM;
    const factor = 1.0 + this._TC1 * difference + this._TC2 * difference * difference;
    this.C = base * factor * this._SCALE;
  }

  /**
   * stampAc — AC small-signal stamp per ngspice CAPacLoad (capacld.c).
   *
   * cite: capacld.c:28-35 —
   *   m   = here->CAPm;
   *   val = ckt->CKTomega * here->CAPcapac;
   *   *(CAPposPosPtr+1) += m*val;   *(CAPnegNegPtr+1) += m*val;
   *   *(CAPposNegPtr+1) -= m*val;   *(CAPnegPosPtr+1) -= m*val;
   *
   * The capacitor AC admittance Y = jωC has no conductance: only the
   * susceptance ωC exists, written into the imaginary half of each cell
   * (the `+1` offset in ngspice). Real part of every stamp is 0.
   *
   * Allocation lives in setup() (the allocNortonStamp call that returns the
   * _handles tuple), mirroring ngspice's CAPsetup/CAPacLoad function
   * boundary: CAPsetup TSTALLOCs the four pointers once (capsetup.c:114-117);
   * CAPacLoad performs no allocation and writes the imaginary half of the
   * same pre-allocated cells. Under the unified SparseSolver each of the
   * four _handles[i] addresses both the real half (written by load()) and
   * the imaginary half (written here via stampElementImag) of one cell.
   */
  stampAc(solver: SparseSolverStamp, omega: number, _ctx: LoadContext): void {
    // capacld.c:30 — val = ckt->CKTomega * here->CAPcapac.
    const val = omega * this.C;
    // capacld.c:28 — m = here->CAPm; applied at stamp time, not folded into C.
    const m = this._M;

    // capacld.c:32-35 — `*(...Ptr+1) ±= m*val`: the imaginary half only, the
    // capacitor's AC admittance jωC has no conductance (real part is 0).
    // _handles is the tuple [hPP, hNN, hPN, hNP] from allocNortonStamp in
    // setup() — capsetup.c:114-117 TSTALLOC order, the same four matrix
    // pointers CAPload writes the real half of.
    const [hPP, hNN, hPN, hNP] = this._handles;
    solver.stampElementImag(hPP,  m * val);  // *(CAPposPosPtr+1) += m*val
    solver.stampElementImag(hNN,  m * val);  // *(CAPnegNegPtr+1) += m*val
    solver.stampElementImag(hPN, -m * val);  // *(CAPposNegPtr+1) -= m*val
    solver.stampElementImag(hNP, -m * val);  // *(CAPnegPosPtr+1) -= m*val
  }

  /**
   * setParam — hot-loadable parameter update.
   *
   * Each branch updates the stored field only; the capacitance recompute is
   * centralised in computeTemperature(), which the engine invokes after
   * setup() and on every setCircuitTemp() (analog-engine.ts:1364-1372). This
   * mirrors the inductor's setParam (inductor.ts:328-352): no hardcoded
   * temperature term lives here.
   */
  setParam(key: string, value: number): void {
    if (key === "capacitance") {
      this._nominalC = value;
      this._capGiven = true;
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
    } else if (key === "M") {
      // capload.c:44  M is applied at stamp time; C is not recomputed when M changes.
      this._M = value;
    } else if (key === "cj") {
      this._cj = value;
      this._cjGiven = true;
    } else if (key === "cjsw") {
      this._cjsw = value;
    } else if (key === "defw") {
      this._defw = value;
    } else if (key === "narrow") {
      this._narrow = value;
      this._narrowGiven = true;
    } else if (key === "short") {
      this._short = value;
      this._shortGiven = true;
    } else if (key === "del") {
      this._del = value;
      this._delGiven = true;
    } else if (key === "di") {
      this._di = value;
      this._diGiven = true;
    } else if (key === "thick") {
      this._thick = value;
      this._thickGiven = true;
    } else if (key === "mCap") {
      this._mCap = value;
      this._mCapGiven = true;
    } else if (key === "w") {
      this._w = value;
      this._wGiven = true;
    } else if (key === "l") {
      this._l = value;
      this._lGiven = true;
    } else if (key === "TEMP") {
      this._TEMP = value;
      this._tempGiven = true;
    } else if (key === "DTEMP") {
      this._DTEMP = value;
      this._dtempGiven = true;
    }
  }

  /**
   * Unified load()  ngspice capload.c CAPload.
   *
   * Reads terminal voltage, computes charge Q = C*V, NIintegrates inline using
   * ctx.ag[], and stamps the companion model (geq conductance + ceq current
   * source). Matches the Appendix D2 reference pattern.
   */
  load(ctx: LoadContext): void {
    const { rhsOld: voltages, ag, cktMode: mode } = ctx;
    const n0 = this.pinNodes.get("pos")!;
    const n1 = this.pinNodes.get("neg")!;
    const C = this.C;
    // capload.c:44  m = CAPm; applied at every stamp site, not folded into C.
    const m = this._M;
    const base = this._stateBase;
    // pool.states[N] accessed at call time  no cached Float64Array refs (A4).
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    // ngspice capload.c:30  participate only in MODETRAN | MODEAC | MODETRANOP.
    if (!(mode & (MODETRAN | MODEAC | MODETRANOP))) return;

    // capload.c:32-36  IC gate.
    const cond1 =
      ((mode & MODEDC) && (mode & MODEINITJCT)) ||
      ((mode & MODEUIC) && (mode & MODEINITTRAN));

    // Read terminal voltage (capload.c:49-51).
    let vcap: number;
    if (cond1) {
      vcap = this._IC;
    } else {
      const v0 = voltages[n0];
      const v1 = voltages[n1];
      vcap = v0 - v1;
    }

    if (mode & (MODETRAN | MODEAC)) {
      // #ifndef PREDICTOR (capload.c:53-65).
      if (mode & MODEINITPRED) {
        // Copy state1 charge to state0 (capload.c:55-56).
        s0[base + SLOT_Q] = s1[base + SLOT_Q];
      } else {
        // Compute charge Q = C * V (capload.c:58).
        s0[base + SLOT_Q] = C * vcap;
        if (mode & MODEINITTRAN) {
          // Seed state1 from state0 (capload.c:60-62).
          s1[base + SLOT_Q] = s0[base + SLOT_Q];
        }
      }

      // NIintegrate via shared helper (capload.c:67-68, niinteg.c:17-80).
      const q0 = s0[base + SLOT_Q];
      const q1 = s1[base + SLOT_Q];
      const q2 = s2[base + SLOT_Q];
      const q3 = s3[base + SLOT_Q];
      const ccapPrev = s1[base + SLOT_CCAP];
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

      // Seed state1 companion current on first tran step (capload.c:70-72).
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_CCAP] = s0[base + SLOT_CCAP];
      }

      // Stamp companion model (capload.c:74-79  all entries scaled by m = CAPm).
      // ngspice writes unconditionally; ground rows/cols land in the TrashCan
      // (matrix) or rhs[0] (post-solve cleared). No caller-side ground guards.
      // capload.c:78-79 writes `-ceq` at posNode and `+ceq` at negNode; passing
      // I = -m*ceq to stampNortonAt yields rhs[n0] += -m*ceq, rhs[n1] += m*ceq.
      stampNortonAt(ctx, this._handles, n0, n1, m * geq, -m * ceq);
    } else {
      // DC operating point — just store charge, no matrix stamp (capload.c:80-81).
      s0[base + SLOT_Q] = C * vcap;
    }
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    // Capacitor current at the converged step = CCAP (NIintegrate companion
    // current). At the converged operating point the companion-stamp formula
    // `geq*V + ceq` collapses to ccap (since ceq = ccap - ag[0]*Q and Q=C*V),
    // so ngspice device queries (e.g. dioask.c CKTstate0[ccap] reads) return
    // the stored slot directly instead of recomputing. DC-OP holds CCAP at 0
    // because the DC branch of load() doesn't touch it (capload.c:80-81 only
    // writes Q).
    const I = this._pool.states[0][this._stateBase + SLOT_CCAP];
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
    const q0 = s0[base + SLOT_Q];
    const q1 = s1[base + SLOT_Q];
    const q2 = s2[base + SLOT_Q];
    const q3 = s3[base + SLOT_Q];
    const ccap0 = s0[base + SLOT_CCAP];
    const ccap1 = s1[base + SLOT_CCAP];
    return cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
  }
}

function createCapacitorElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): PoolBackedAnalogElement {
  return new AnalogCapacitorElement(pinNodes, props);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CAPACITOR_PROPERTY_DEFS: PropertyDefinition[] = [
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

export const CAPACITOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "capacitance",
    propertyKey: "capacitance",
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
// CapacitorDefinition
// ---------------------------------------------------------------------------

function capacitorCircuitFactory(props: PropertyBag): CapacitorElement {
  return new CapacitorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const CapacitorDefinition: StandaloneComponentDefinition = {
  name: "Capacitor",
  typeId: -1,
  factory: capacitorCircuitFactory,
  pinLayout: buildCapacitorPinDeclarations(),
  voltageProbes: [{ name: "V", pos: "pos", neg: "neg" }],
  propertyDefs: CAPACITOR_PROPERTY_DEFS,
  attributeMap: CAPACITOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Capacitor  reactive element with companion model.\n" +
    "Stamps equivalent conductance and history current source at each timestep.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createCapacitorElement,
      paramDefs: CAPACITOR_PARAM_DEFS,
      params: CAPACITOR_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
