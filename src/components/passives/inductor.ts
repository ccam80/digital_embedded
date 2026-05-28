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
// Type-only import: erased at compile time, so the inductor↔mutual-inductor
// reference is structural only and introduces no runtime import cycle. Mirrors
// ngspice's forward-declared `struct INDsystem *system;` in inddefs.h:72, whose
// full definition (inddefs.h:169-174) lives alongside the MUTtemp verify pass.
import type { IndSystem } from "./mutual-inductor.js";

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
// Physical constants — ngspice const.h
// ---------------------------------------------------------------------------

// const.h:44 — CONSTmuZero = 4·π·1e-7 H/m (vacuum permeability).
const CONST_MU_ZERO = 4.0 * Math.PI * 1e-7;

// indsetup.c:13 — #define PI 3.141592654. The geometry derivation and Lundin's
// correction factor use this truncated literal, NOT Math.PI; matching it
// bit-for-bit is required for csect ← π·dia²/4 and the Lundin x ratio.
const PI = 3.141592654;

// indsetup.c:142-173 — Lundin(): Nagaoka's coefficient via Lundin's handbook
// formula (D: W. Knight, https://g3ynh.info/zdocs/magnetics/Solenoids.pdf p.36).
// `l` is the coil length, `csec` its cross-section area; returns the geometry
// correction factor multiplied into INDspecInd. Returns 1 (no correction) when
// the coil geometry is below the 1um floor.
function Lundin(l: number, csec: number): number {
  // x = solenoid diam. / length
  let num: number, den: number, kk: number, x: number, xx: number, xxxx: number;

  // indsetup.c:151-155 — geometry below the floor: no correction.
  if (csec < 1e-12 || l < 1e-6) {
    console.warn("Warning: coil geometries too small (< 1um length dimensions),");
    console.warn("    Lundin's correction factor will not be calculated");
    return 1;
  }

  // indsetup.c:157 — x = sqrt(csec / PI) * 2. / l.
  x = Math.sqrt(csec / PI) * 2.0 / l;

  // indsetup.c:159-160 — xx = x*x; xxxx = xx*xx.
  xx = x * x;
  xxxx = xx * xx;

  if (x < 1) {
    // indsetup.c:162-166 — slender-solenoid branch.
    num = 1 + 0.383901 * xx + 0.017108 * xxxx;
    den = 1 + 0.258952 * xx;
    return num / den - 4 * x / (3 * PI);
  } else {
    // indsetup.c:167-172 — short-solenoid branch.
    num = (Math.log(4 * x) - 0.5) * (1 + 0.383901 / xx + 0.017108 / xxxx);
    den = 1 + 0.258952 / xx;
    kk = 0.093842 / xx + 0.002029 / xxxx - 0.000801 / (xx * xxxx);
    return 2 * (num / den + kk) / (PI * x);
  }
}

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: INDUCTOR_PARAM_DEFS, defaults: INDUCTOR_DEFAULTS } = defineModelParams({
  primary: {
    inductance: { default: 1e-3, unit: "H", positional: true, description: "Inductance in henries (positional VALUE on the L-card per inp2l.c)", min: 1e-12 },
  },
  secondary: {
    // Model-card geometry / temperature parameters — ngspice INDmPTable
    // (ind.c:42-50). These emit on the `.model L …` card; defaults seeded in
    // setup() (indsetup.c:32-58). The derived INDspecInd is computed in
    // setup(), not a netlist parameter (no INDmPTable row).
    mInd:      { default: 0.0, unit: "H",  spiceName: "ind",    description: "Model inductance (ind.c:42 IND_MOD_IND)" },
    modelTnom: { default: 300.15, unit: "K", spiceName: "tnom", description: "Model nominal temperature (ind.c:45 IND_MOD_TNOM)", spiceConverter: kelvinToCelsius },
    modelTC1:  { default: 0.0,             spiceName: "tc1",    description: "Model first-order temperature coefficient (ind.c:43 IND_MOD_TC1)" },
    modelTC2:  { default: 0.0,             spiceName: "tc2",    description: "Model second-order temperature coefficient (ind.c:44 IND_MOD_TC2)" },
    csect:     { default: 0.0, unit: "m^2", spiceName: "csect", description: "Inductor cross section (ind.c:46 IND_MOD_CSECT)" },
    dia:       { default: 0.0, unit: "m",  spiceName: "dia",    description: "Inductor diameter (ind.c:47 IND_MOD_DIA)" },
    length:    { default: 0.0, unit: "m",  spiceName: "length", description: "Inductor length (ind.c:48 IND_MOD_LENGTH)" },
    modNt:     { default: 0.0,             spiceName: "nt",     description: "Model number of turns (ind.c:49 IND_MOD_NT)" },
    mu:        { default: 0.0,             spiceName: "mu",     description: "Relative magnetic permeability (ind.c:50 IND_MOD_MU)" },
  },
  instance: {
    IC:   { default: NaN,    unit: "A",    description: "Initial condition current for UIC" },
    TC1:  { default: 0,                    description: "Linear temperature coefficient" },
    TC2:  { default: 0,                    description: "Quadratic temperature coefficient" },
    SCALE: { default: 1,                   description: "Instance scale factor" },
    M:    { default: 1,                    description: "Parallel multiplicity" },
    // Per-instance number of turns — ngspice here->INDnt (inddefs.h:46), card
    // row IND_NT (ind.c:24). Distinct from the model-side modNt.
    nt:   { default: 0,                    description: "Instance number of turns" },
    // Per-instance temperature — ngspice here->INDtemp / INDdtemp
    // (inddefs.h:43-44), card rows IND_TEMP / IND_DTEMP (ind.c:17-19).
    TEMP:  { default: 300.15, unit: "K", description: "Instance operating temperature", spiceConverter: kelvinToCelsius },
    DTEMP: { default: 0.0,    unit: "K", description: "Instance temperature delta from ambient" },
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

  // Raw instance-line inductance — ngspice here->INDinductinst (inddefs.h:39).
  private _nominalL: number;
  // Working inductance after temperature derating and SCALE — ngspice
  // here->INDinduct after indtemp.c:74. Does NOT carry /M: the parallel
  // multiplier is applied at each stamp site (load / stampAc / stampAcCoupling),
  // matching indload.c:43 / indacld.c:29 / indpzld.c:30.
  private _effectiveL: number;
  private _IC: number;
  private _TC1: number;
  private _TC2: number;
  private _SCALE: number;
  private _M: number;
  // Instance-side *Given guards — ngspice here->INDxxxGiven (inddefs.h:60-68).
  private _indGiven: boolean;
  private _TC1Given: boolean;
  private _TC2Given: boolean;
  private _scaleGiven: boolean;
  private _mGiven: boolean;

  // Instance-side number of turns — ngspice here->INDnt (inddefs.h:46).
  private _instanceNt: number;
  private _instanceNtGiven: boolean;
  // Instance-side temperature — ngspice here->INDtemp / INDdtemp
  // (inddefs.h:43-44).
  private _TEMP: number;
  private _DTEMP: number;
  private _tempGiven: boolean;
  private _dtempGiven: boolean;

  // Model-card parameters — ngspice sINDmodel fields (inddefs.h:100-118).
  private _mInd: number;
  private _modelTnom: number;
  private _modelTC1: number;
  private _modelTC2: number;
  private _csect: number;
  // Coil diameter — ngspice model->INDdia (inddefs.h:105). Drives the
  // csect ← π·dia²/4 derivation in setup() (indsetup.c:61-63).
  private _dia: number;
  private _length: number;
  private _modNt: number;
  private _mu: number;
  // Model-card *Given guards — ngspice model->INDxxxGiven (inddefs.h:110-118).
  private _mIndGiven: boolean;
  private _modelTnomGiven: boolean;
  private _modelTC1Given: boolean;
  private _modelTC2Given: boolean;
  private _csectGiven: boolean;
  // ngspice model->INDdiaGiven (inddefs.h:114).
  private _diaGiven: boolean;
  private _lengthGiven: boolean;
  private _modNtGiven: boolean;
  private _muGiven: boolean;
  // Derived specific (one-turn) inductance — ngspice model->INDspecInd
  // (inddefs.h:120). Computed in setup() from mu/csect/length; not a netlist
  // parameter (no INDmPTable row).
  private _specInd: number = 0.0;

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

  // INDsystem bookkeeping for the MUTtemp Cholesky verify pass.
  // cite: inddefs.h:72-74 — struct INDsystem *system; INDinstance
  //   *system_next_ind; int system_idx. Initialised in setup() per
  //   indsetup.c:103-104; system_idx is (re)assigned inside the verify pass at
  //   muttemp.c:146 and read only there, so -1 is the between-passes sentinel.
  private _system: IndSystem | null = null;
  private _systemNextInd: AnalogInductorElement | null = null;
  private _systemIdx: number = -1;

  // -------------------------------------------------------------------------
  // Package-private accessors consumed by verifyInductiveSystems
  // (ind-family-temperature.ts). Coupled surface used only by the MUTtemp
  // verify pass — no public surface, mirroring the _mutSiblings pattern above.
  // -------------------------------------------------------------------------

  /** ngspice INDinstance.system — INDsystem the inductor belongs to, or null. */
  get _systemPtr(): IndSystem | null { return this._system; }
  set _systemPtr(s: IndSystem | null) { this._system = s; }

  /** ngspice INDinstance.system_next_ind — next IND in same system, or null. */
  get _systemNextIndPtr(): AnalogInductorElement | null { return this._systemNextInd; }
  set _systemNextIndPtr(n: AnalogInductorElement | null) { this._systemNextInd = n; }

  /** ngspice INDinstance.system_idx — index within the system matrix. */
  get _systemIdxPtr(): number { return this._systemIdx; }
  set _systemIdxPtr(i: number) { this._systemIdx = i; }

  /**
   * Effective inductance the verify pass reads for the system-matrix diagonal.
   * cite: muttemp.c:145 — INDmatrix[i*sz+i] = ind->INDinduct (the post-Pass-1
   * temperature-folded inductance). digiTS's `_effectiveL` carries no /M after
   * Q-IND-LDIVM (ind-review §6e Directive 2), which is the same value the rest
   * of the analysis sees; alias to the existing `inductance` getter for read.
   */
  get _effectiveLForVerify(): number { return this._effectiveL; }

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    // *Given guards mirror ngspice's per-instance/model `<x>Given` flags
    // (inddefs.h:60-118): true only when the netlist actually supplied `<x>`.
    // isModelParamGiven reads the property bag's given-set, matching the cap
    // pilot (capacitor.ts:293-333).
    this._indGiven = props.isModelParamGiven("inductance");
    this._nominalL = this._indGiven ? props.getModelParam<number>("inductance") : INDUCTOR_DEFAULTS["inductance"]!;
    this._IC    = props.isModelParamGiven("IC")    ? props.getModelParam<number>("IC")    : INDUCTOR_DEFAULTS["IC"]!;
    this._TC1Given   = props.isModelParamGiven("TC1");
    this._TC1   = this._TC1Given   ? props.getModelParam<number>("TC1")   : INDUCTOR_DEFAULTS["TC1"]!;
    this._TC2Given   = props.isModelParamGiven("TC2");
    this._TC2   = this._TC2Given   ? props.getModelParam<number>("TC2")   : INDUCTOR_DEFAULTS["TC2"]!;
    this._scaleGiven = props.isModelParamGiven("SCALE");
    this._SCALE = this._scaleGiven ? props.getModelParam<number>("SCALE") : INDUCTOR_DEFAULTS["SCALE"]!;
    this._mGiven     = props.isModelParamGiven("M");
    this._M     = this._mGiven     ? props.getModelParam<number>("M")     : INDUCTOR_DEFAULTS["M"]!;

    // Instance-side number of turns + temperature — inddefs.h:46, 43-44.
    this._instanceNtGiven = props.isModelParamGiven("nt");
    this._instanceNt = this._instanceNtGiven ? props.getModelParam<number>("nt") : INDUCTOR_DEFAULTS["nt"]!;
    this._tempGiven  = props.isModelParamGiven("TEMP");
    this._TEMP       = this._tempGiven  ? props.getModelParam<number>("TEMP")  : INDUCTOR_DEFAULTS["TEMP"]!;
    this._dtempGiven = props.isModelParamGiven("DTEMP");
    this._DTEMP      = this._dtempGiven ? props.getModelParam<number>("DTEMP") : INDUCTOR_DEFAULTS["DTEMP"]!;

    // Model-card parameters — sINDmodel fields (inddefs.h:100-118). Defaults
    // from INDUCTOR_DEFAULTS; the !*Given seeding in setup() (indsetup.c:32-58)
    // reapplies them idempotently.
    this._mIndGiven      = props.isModelParamGiven("mInd");
    this._mInd           = this._mIndGiven      ? props.getModelParam<number>("mInd")      : INDUCTOR_DEFAULTS["mInd"]!;
    // Nominal temperature the TC factor is measured against (indtemp.c:58,
    // model->INDtnom). Model-card only — ind.c:45 IND_MOD_TNOM; ngspice has no
    // instance tnom (ind.c:13-22 instance table carries only tc1/tc2).
    this._modelTnomGiven = props.isModelParamGiven("modelTnom");
    this._modelTnom      = this._modelTnomGiven ? props.getModelParam<number>("modelTnom") : INDUCTOR_DEFAULTS["modelTnom"]!;
    this._modelTC1Given  = props.isModelParamGiven("modelTC1");
    this._modelTC1       = this._modelTC1Given  ? props.getModelParam<number>("modelTC1")  : INDUCTOR_DEFAULTS["modelTC1"]!;
    this._modelTC2Given  = props.isModelParamGiven("modelTC2");
    this._modelTC2       = this._modelTC2Given  ? props.getModelParam<number>("modelTC2")  : INDUCTOR_DEFAULTS["modelTC2"]!;
    this._csectGiven     = props.isModelParamGiven("csect");
    this._csect          = this._csectGiven     ? props.getModelParam<number>("csect")     : INDUCTOR_DEFAULTS["csect"]!;
    this._diaGiven       = props.isModelParamGiven("dia");
    this._dia            = this._diaGiven       ? props.getModelParam<number>("dia")       : INDUCTOR_DEFAULTS["dia"]!;
    this._lengthGiven    = props.isModelParamGiven("length");
    this._length         = this._lengthGiven    ? props.getModelParam<number>("length")    : INDUCTOR_DEFAULTS["length"]!;
    this._modNtGiven     = props.isModelParamGiven("modNt");
    this._modNt          = this._modNtGiven     ? props.getModelParam<number>("modNt")     : INDUCTOR_DEFAULTS["modNt"]!;
    this._muGiven        = props.isModelParamGiven("mu");
    this._mu             = this._muGiven        ? props.getModelParam<number>("mu")        : INDUCTOR_DEFAULTS["mu"]!;

    // indtemp.c:74 — at construction the reference temperature equals tnom, so
    // difference = 0, factor = 1, and _effectiveL = _nominalL * SCALE. The /M
    // division is applied at the stamp sites, not folded here. setup() and
    // computeTemperature() overwrite this before load() runs.
    this._effectiveL = this._nominalL * this._SCALE;
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

  /**
   * Raw initial-condition current — ngspice here->INDinitCond (inddefs.h:47).
   * The MUT MODEUIC IC-seeding branch (indload.c:64-68) reads the partner's
   * INDinitCond unconditionally; ngspice leaves INDinitCond at its 0.0 struct
   * default when no IC card is given (only INDicGiven flips). digiTS stores the
   * NaN sentinel for "not given", so map that back to 0.0 here to reproduce the
   * raw field value the MUT branch reads.
   * cite: indload.c:65 — muthere->MUTind2->INDinitCond.
   */
  get ic(): number {
    return isNaN(this._IC) ? 0.0 : this._IC;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const pinNodes = this.pinNodes;
    const posNode = pinNodes.get("pos")!;  // INDposNode
    const negNode = pinNodes.get("neg")!;  // INDnegNode

    // ----------------------------------------------------------------------
    // INDsetup model-default processing (indsetup.c:31-58).
    // ----------------------------------------------------------------------

    // indsetup.c:32-34 — !INDmIndGiven → INDmInd = 0.0
    if (!this._mIndGiven) {
      this._mInd = 0.0;
    }
    // indsetup.c:35-37 — !INDtnomGiven → INDtnom = ckt->CKTnomTemp
    if (!this._modelTnomGiven) {
      this._modelTnom = ctx.nomTemp;
    }
    // indsetup.c:38-40 — !INDtc1Given → INDtempCoeff1 = 0.0
    if (!this._modelTC1Given) {
      this._modelTC1 = 0.0;
    }
    // indsetup.c:41-43 — !INDtc2Given → INDtempCoeff2 = 0.0
    if (!this._modelTC2Given) {
      this._modelTC2 = 0.0;
    }
    // indsetup.c:44-46 — !INDcsectGiven → INDcsect = 0.0
    if (!this._csectGiven) {
      this._csect = 0.0;
    }
    // indsetup.c:47-49 — !INDdiaGiven → INDdia = 0.0
    if (!this._diaGiven) {
      this._dia = 0.0;
    }
    // indsetup.c:50-52 — !INDlengthGiven → INDlength = 0.0
    if (!this._lengthGiven) {
      this._length = 0.0;
    }
    // indsetup.c:53-55 — !INDmodNtGiven → INDmodNt = 0.0
    if (!this._modNtGiven) {
      this._modNt = 0.0;
    }
    // indsetup.c:56-58 — !INDmuGiven → INDmu = 1.0
    if (!this._muGiven) {
      this._mu = 1.0;
    }

    // Specific-inductance + turns-folding derivation (indsetup.c:65-85).
    // Extracted so the geometry hot-load path (setParam csect/length/
    // mu/modNt) can rebuild _specInd / _mInd without a full setup() re-run.
    this._deriveSpecIndAndMInd();

    // indsetup.c:91-92 — *states += INDnumStates (INDflux = state+0,
    // INDvolt = state+1)
    this._stateBase = ctx.allocStates(this.stateSize);

    // indsetup.c:97-101 — CKTmkCur guard (idempotent, mirrors VSRCfindBr pattern).
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    const b = this.branchIndex;

    // cite: indsetup.c:103-104 — per-instance INDsystem bookkeeping init. The
    // two assignments sit between CKTmkCur (above) and the five TSTALLOC
    // allocElement calls (below). Operation order is line-for-line as v41.
    this._system = null;
    this._systemNextInd = null;

    // indsetup.c:112-116 — TSTALLOC sequence, line-for-line.
    this._hPIbr   = solver.allocElement(posNode, b);  // (INDposNode, INDbrEq)
    this._hNIbr   = solver.allocElement(negNode, b);  // (INDnegNode, INDbrEq)
    this._hIbrN   = solver.allocElement(b, negNode);  // (INDbrEq,    INDnegNode)
    this._hIbrP   = solver.allocElement(b, posNode);  // (INDbrEq,    INDposNode)
    this._hIbrIbr = solver.allocElement(b, b);        // (INDbrEq,    INDbrEq)
  }

  /**
   * _deriveSpecIndAndMInd — model-side geometry → specific-inductance →
   * turns-folding derivation. ngspice INDsetup (indsetup.c:60-85):
   *   if (INDdiaGiven) INDcsect = PI * INDdia * INDdia / 4.;
   *   if (INDlengthGiven && INDlength > 0.0)
   *     INDspecInd = (INDmu * CONSTmuZero * INDcsect) / INDlength;
   *   else INDspecInd = 0.0;
   *   if (INDlengthGiven && (INDdiaGiven || INDcsectGiven))
   *     INDspecInd *= Lundin(INDlength, INDcsect);
   *   if (!INDmIndGiven) INDmInd = INDmodNt * INDmodNt * INDspecInd;
   *
   * Folded into a helper so the geometry hot-load path (setParam) rebuilds it
   * without a setup() re-run, which the engine does not perform after setParam
   * (analog-engine.ts:1389).
   */
  private _deriveSpecIndAndMInd(): void {
    // indsetup.c:60-63 — diameter takes preference over cross section.
    if (this._diaGiven) {
      this._csect = PI * this._dia * this._dia / 4.0;
    }

    // indsetup.c:65-71 — precompute specific inductance (one turn).
    if (this._lengthGiven && this._length > 0.0) {
      this._specInd = (this._mu * CONST_MU_ZERO * this._csect) / this._length;
    } else {
      this._specInd = 0.0;
    }

    // indsetup.c:73-75 — Lundin's geometry correction factor.
    if (this._lengthGiven && (this._diaGiven || this._csectGiven)) {
      this._specInd *= Lundin(this._length, this._csect);
    }

    // indsetup.c:83-85 — fold the turns count into the model inductance.
    if (!this._mIndGiven) {
      this._mInd = this._modNt * this._modNt * this._specInd;
    }
  }

  findBranchFor(name: string, ctx: SetupContext): number {
    if (name !== this.label) return 0;
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    return this.branchIndex;
  }

  /**
   * computeTemperature — per-instance temperature pass (INDtemp body).
   *
   * cite: indtemp.c:33-74 — instance default-value processing, base-inductance
   * selection (instance value / model mInd / specInd·nt²), the
   * instance-overrides-model TC selection, and the TC/SCALE fold.
   *
   * The /M division is applied at the stamp sites, not folded into the working
   * inductance here. The body rebuilds _effectiveL from a fresh base on every
   * call — no in-place compounding.
   */
  computeTemperature(ctx: TempContext): void {
    // indtemp.c:35-43 — per-instance temperature override. When temp is given
    // the instance uses its absolute TEMP and dtemp is forced 0 (ngspice warns
    // if dtemp was also supplied); otherwise temp is ambient and dtemp is the
    // additive delta.
    let effectiveTemp: number;
    if (this._tempGiven) {
      // indtemp.c:38-42 — instance temperature specified; dtemp forced 0.
      this._DTEMP = 0.0;
      if (this._dtempGiven) {
        // indtemp.c:40-41 — printf warning, delegated to the host console.
        console.warn(`${this.label}: Instance temperature specified, dtemp ignored`);
      }
      effectiveTemp = this._TEMP;
    } else {
      // indtemp.c:35-37 — instance ambient = circuit ambient; dtemp default 0.
      this._TEMP = ctx.cktTemp;
      if (!this._dtempGiven) {
        this._DTEMP = 0.0;
      }
      effectiveTemp = this._TEMP + this._DTEMP;
    }

    // indtemp.c:45-47 — instance default-value processing.
    if (!this._scaleGiven)      this._SCALE = 1.0;
    if (!this._mGiven)          this._M = 1.0;
    if (!this._instanceNtGiven) this._instanceNt = 0.0;

    // indtemp.c:49-56 — base-inductance selection. When no instance
    // inductance is given, the base is specInd·nt² (instance turns) or the
    // model mInd; otherwise the base is the raw instance value (_nominalL,
    // ngspice's INDinductinst). The indtemp.c:56 `else INDinduct =
    // INDinductinst` reset is the right-hand-side _nominalL read here.
    let base: number;
    if (!this._indGiven) {
      if (this._instanceNtGiven) {
        // indtemp.c:50-51 — INDinduct = INDspecInd * INDnt * INDnt.
        base = this._specInd * this._instanceNt * this._instanceNt;
      } else {
        // indtemp.c:52-53 — INDinduct = model->INDmInd.
        base = this._mInd;
      }
    } else {
      // indtemp.c:56 — INDinduct = INDinductinst.
      base = this._nominalL;
    }

    // indtemp.c:58 — difference = (INDtemp + INDdtemp) - INDtnom. effectiveTemp
    // already folds INDtemp+INDdtemp per the branch above.
    const difference = effectiveTemp - this._modelTnom;

    // indtemp.c:62-70 — instance parameters tc1/tc2 override model parameters.
    const tc1 = this._TC1Given ? this._TC1 : this._modelTC1;
    const tc2 = this._TC2Given ? this._TC2 : this._modelTC2;

    // indtemp.c:72 — factor = 1.0 + tc1*difference + tc2*difference*difference.
    const factor = 1.0 + tc1 * difference + tc2 * difference * difference;

    // indtemp.c:74 — INDinduct = INDinduct * factor * INDscale. The /M division
    // is applied at the stamp sites, not folded in here. Rebuilt from `base`,
    // not an in-place mutation.
    this._effectiveL = base * factor * this._SCALE;
  }

  setParam(key: string, value: number): void {
    if (key === "inductance" || key === "L") {
      // indparam.c — the chained assignment
      //   here->INDinductinst = here->INDinduct = value->rValue;
      // as two statements in right-to-left evaluation order.
      this._effectiveL = value;   // INDinduct = rValue
      this._nominalL  = value;    // INDinductinst = INDinduct (= rValue)
      // indparam.c:25-26 — !INDmGiven → INDm = 1.0.
      this._indGiven  = true;
      if (!this._mGiven) this._M = 1.0;
      // Cascade to MUT siblings so MUTfactor = k·√(L1·L2) stays current.
      // cite: muttemp.c:35-41 — MUTfactor depends on both partner INDinduct values.
      for (const m of this._mutSiblings) {
        m.recomputeMutFactor();
      }
    } else if (key === "IC") {
      this._IC = value;
    } else if (key === "TC1") {
      this._TC1 = value;
      this._TC1Given = true;
    } else if (key === "TC2") {
      this._TC2 = value;
      this._TC2Given = true;
    } else if (key === "SCALE") {
      this._SCALE = value;
      this._scaleGiven = true;
      // No /M here — it is applied at the stamp sites.
      this._effectiveL = this._nominalL * this._SCALE;
    } else if (key === "M") {
      this._M = value;
      this._mGiven = true;
      // /M is applied at the stamp sites, so _effectiveL is unchanged here.
    } else if (key === "nt") {
      this._instanceNt = value;
      this._instanceNtGiven = true;
    } else if (key === "TEMP") {
      this._TEMP = value;
      this._tempGiven = true;
    } else if (key === "DTEMP") {
      this._DTEMP = value;
      this._dtempGiven = true;
    } else if (key === "mInd") {
      // indmpar.c:20-23 — case IND_MOD_IND.
      this._mInd = value;
      this._mIndGiven = true;
    } else if (key === "modelTnom") {
      // indmpar.c:24-27 — case IND_MOD_TNOM.
      this._modelTnom = value;
      this._modelTnomGiven = true;
    } else if (key === "modelTC1") {
      // indmpar.c:28-31 — case IND_MOD_TC1.
      this._modelTC1 = value;
      this._modelTC1Given = true;
    } else if (key === "modelTC2") {
      // indmpar.c:32-35 — case IND_MOD_TC2.
      this._modelTC2 = value;
      this._modelTC2Given = true;
    } else if (key === "csect") {
      // indmpar.c:36-39 — case IND_MOD_CSECT.
      this._csect = value;
      this._csectGiven = true;
      this._deriveSpecIndAndMInd();
    } else if (key === "dia") {
      // indmpar.c:40-43 — case IND_MOD_DIA.
      this._dia = value;
      this._diaGiven = true;
      this._deriveSpecIndAndMInd();
    } else if (key === "length") {
      // indmpar.c:44-47 — case IND_MOD_LENGTH.
      this._length = value;
      this._lengthGiven = true;
      this._deriveSpecIndAndMInd();
    } else if (key === "modNt") {
      // indmpar.c:48-51 — case IND_MOD_NT.
      this._modNt = value;
      this._modNtGiven = true;
      this._deriveSpecIndAndMInd();
    } else if (key === "mu") {
      // indmpar.c:52-55 — case IND_MOD_MU.
      this._mu = value;
      this._muGiven = true;
      this._deriveSpecIndAndMInd();
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
    // indload.c:39 — m = here->INDm. /M is applied at the stamp site, not
    // folded into _effectiveL.
    const m = this._M;
    const base = this._stateBase;
    const s0 = this._pool.states[0];

    // cite: indload.c:41 — if(!(ckt->CKTmode & (MODEDC|MODEINITPRED)))
    if (!(mode & (MODEDC | MODEINITPRED))) {
      if ((mode & MODEUIC) && (mode & MODEINITTRAN) && !isNaN(this._IC)) {
        // cite: indload.c:43-44 — INDflux = INDinduct / m * INDinitCond.
        // Operand order: (INDinduct / m) * INDinitCond (C left-to-right).
        s0[base + _SLOT_PHI] = L / m * this._IC;
      } else {
        // cite: indload.c:46-47 — INDflux = INDinduct / m * CKTrhsOld[INDbrEq].
        s0[base + _SLOT_PHI] = L / m * rhsOld[b];
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
    // indload.c:111 — m = here->INDm; the parallel divisor is applied at the
    // stamp site (newmind = INDinduct/m), not folded into _effectiveL.
    const m = this._M;
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
      // cite: indload.c:112-113 — newmind = INDinduct/m;
      //   NIintegrate(ckt, &req, &veq, newmind, here->INDflux).
      // niinteg.c writes state0[INDvolt] = state0[ccap] = s0[_SLOT_CCAP].
      const newmind = L / m;
      const phi0 = s0[base + _SLOT_PHI];
      const phi1 = s1[base + _SLOT_PHI];
      const phi2 = s2[base + _SLOT_PHI];
      const phi3 = s3[base + _SLOT_PHI];
      const ccapPrev = s1[base + _SLOT_CCAP];
      const ni = niIntegrate(
        ctx.method,
        ctx.order,
        newmind,
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
   * The /m divisor is applied here at the stamp statement (omega * L / m),
   * not folded into _effectiveL.
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
    // cite: indacld.c:29 — val = ckt->CKTomega * here->INDinduct / m.
    // Operand order ((omega * INDinduct) / m), C left-to-right; /M is applied
    // here at the stamp, not folded into _effectiveL.
    const val = omega * this._effectiveL / this._M;

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
