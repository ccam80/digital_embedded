/**
 * Resistor analog component.
 *
 * Stamps a conductance matrix: G = 1/R at four positions in the MNA matrix.
 * Two-terminal element with no branch variable (branchIndex = -1).
 * Two-terminal pins are labelled pos (positive terminal) and neg (negative terminal).
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
import { AnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { TempContext } from "../../solver/analog/temp-context.js";
import type { SparseSolverStamp } from "../../solver/analog/sparse-solver.js";
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Minimum resistance clamp  prevents G  ∞ for degenerate values
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-9;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: RESISTOR_PARAM_DEFS, defaults: RESISTOR_DEFAULTS } = defineModelParams({
  primary: {
    resistance: { default: 1000, unit: "Ω", description: "Resistance in ohms. Minimum clamped to 1e-9 Ω.", min: 1e-9 },
  },
  secondary: {
    // Model-card geometry / temperature parameters — ngspice RESmodel fields.
    // Defaults seeded in setup() (ressetup.c:29-37); the geometry params drive
    // the sheet-resistance derivation rsh·(L−short)/(W−narrow) in
    // updateConduct() (restemp.c geometry block).
    rsh:      { default: 0.0,    unit: "Ohm/sq", spiceName: "rsh",    description: "Sheet resistance (ressetup.c:30 RESsheetRes)" },
    narrow:   { default: 0.0,    unit: "m",      spiceName: "narrow", description: "Narrowing due to side etching (ressetup.c:36 RESnarrow)" },
    short:    { default: 0.0,    unit: "m",      spiceName: "short",  description: "Shortening due to end etching (ressetup.c:37 RESshort)" },
    defw:     { default: 10e-6,  unit: "m",      spiceName: "defw",   description: "Default width (ressetup.c:31 RESdefWidth)" },
    defl:     { default: 10e-6,  unit: "m",      spiceName: "defl",   description: "Default length (ressetup.c:32 RESdefLength)" },
    modTc1:   { default: 0.0,    unit: "1/K",    spiceName: "tc1",    description: "Model first-order temperature coefficient (ressetup.c:33 REStempCoeff1)" },
    modTc2:   { default: 0.0,    unit: "1/K^2",  spiceName: "tc2",    description: "Model second-order temperature coefficient (ressetup.c:34 REStempCoeff2)" },
    modTce:   { default: 0.0,    unit: "%/K",    spiceName: "tce",    description: "Model exponential temperature coefficient (ressetup.c:35 REStempCoeffe)" },
    tnom:     { default: 300.15, unit: "K",      spiceName: "tnom",   description: "Model nominal temperature (ressetup.c:29 REStnom)", spiceConverter: kelvinToCelsius },
    r:        { default: 0.0,    unit: "Ohm",    spiceName: "r",      description: "Model default resistance (RESres)" },
    modBvMax: { default: 1e99,   unit: "V",      spiceName: "bv_max", description: "Model maximum voltage over resistor (ressetup.c:44-45 RESbv_max)" },
  },
  instance: {
    // Per-instance parameters — ngspice RESinstance fields. TEMP/DTEMP mirror
    // the cap pilot per-instance temperature override (captemp.c:38-47);
    // w/l/SCALE/M/tc1/tc2/acres feed updateConduct() (restemp.c body).
    TEMP:  { default: 300.15, unit: "K", description: "Instance operating temperature (REStemp)", spiceConverter: kelvinToCelsius },
    DTEMP: { default: 0.0,    unit: "K", description: "Instance temperature delta from ambient (RESdtemp)" },
    w:     { default: 0.0,    unit: "m", description: "Instance width, defaults to model defw (RESwidth)" },
    l:     { default: 0.0,    unit: "m", description: "Instance length, defaults to model defl (RESlength)" },
    SCALE: { default: 1.0,               description: "Instance scale factor (RESscale)" },
    M:     { default: 1.0,               description: "Parallel multiplicity (RESm)" },
    tc1:   { default: 0.0,    unit: "1/K",   description: "Instance first-order temperature coefficient (resparam.c RES_TC1, overrides model)" },
    tc2:   { default: 0.0,    unit: "1/K^2", description: "Instance second-order temperature coefficient (resparam.c RES_TC2, overrides model)" },
    tce:   { default: 0.0,    unit: "%/K",   description: "Instance exponential temperature coefficient (resparam.c RES_TCE, overrides model)" },
    acres: { default: 0.0,    unit: "Ohm",   description: "AC resistance (resparam.c RES_ACRESIST)" },
    bv_max: { default: 1e99,  unit: "V", description: "Instance maximum voltage, defaults to model bv_max (RESbv_max)" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildResistorPinDeclarations(): PinDeclaration[] {
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
// ResistorElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class ResistorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Resistor", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildResistorPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.375,
      width: 4,
      height: 0.75,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const resistance = this._properties.getModelParam<number>("resistance");
    const label = this._visibleLabel();

    ctx.save();
    ctx.setLineWidth(1);

    const vA = signals?.getPinVoltage("pos");
    const vB = signals?.getPinVoltage("neg");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Lead wires  colored by their respective node voltages
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vA, 0, 0, 1, 0);
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vB, 3, 0, 4, 0);

    // Zigzag body: 4 iterations producing 8 peaks + start/end
    const hs = 6 / 16; // 0.375 grid units
    const segLen = 2; // distance(lead1, lead2)
    const pts: Array<{ x: number; y: number }> = [{ x: 1, y: 0 }];
    for (let i = 0; i < 4; i++) {
      pts.push({ x: 1 + ((1 + 4 * i) * segLen) / 16, y: hs });
      pts.push({ x: 1 + ((3 + 4 * i) * segLen) / 16, y: -hs });
    }
    pts.push({ x: 3, y: 0 });

    // Body gradient: interpolate voltage from vAvB along the zigzag
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(1, 0, 3, 0, [
        { offset: 0, color: signals!.voltageColor(vA) },
        { offset: 1, color: signals!.voltageColor(vB) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    for (let i = 0; i < pts.length - 1; i++) {
      ctx.drawLine(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    }

    // Value label below body
    const displayLabel = label.length > 0 ? label : (this._shouldShowValue() ? formatSI(resistance, "Ω") : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText(displayLabel, 2, 0.75, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// ResistorAnalogElement- AnalogElement class implementation
// ---------------------------------------------------------------------------

class ResistorAnalogElement extends AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;
  readonly deviceFamily: DeviceFamily = "RES";

  // Per-instance resistance the temperature pass derates — ngspice
  // here->RESresist (resdefs.h). When a resistance is supplied on the instance
  // line this is the netlisted value; otherwise updateConduct() derives it from
  // the geometry ((L−2·short)/(W−2·narrow)·rsh) or the model default.
  private _resistance: number;
  // DC/transient conductance — ngspice here->RESconduct. Carries the RESm fold
  // (restemp.c:104 RESconduct = RESm/(resist·factor·scale)).
  private _G: number;
  // AC conductance — ngspice here->RESacConduct. Equals _G unless acres is given.
  private _Gac: number;
  // AC resistance the acres branch derates — ngspice here->RESacResist.
  private _acResist: number;

  // Per-instance parameters — ngspice RESinstance fields.
  private _TEMP: number;
  private _DTEMP: number;
  private _w: number;
  private _l: number;
  private _SCALE: number;
  private _M: number;
  private _tc1: number;
  private _tc2: number;
  private _tce: number;
  private _acres: number;
  private _bvMax: number;
  // Instance-side *Given guards — ngspice here->RESxxxGiven.
  private _resGiven: boolean;
  private _tempGiven: boolean;
  private _dtempGiven: boolean;
  private _wGiven: boolean;
  private _lGiven: boolean;
  private _scaleGiven: boolean;
  private _mGiven: boolean;
  private _tc1Given: boolean;
  private _tc2Given: boolean;
  private _tceGiven: boolean;
  private _acresGiven: boolean;
  private _bvMaxGiven: boolean;

  // Model-card parameters — ngspice RESmodel fields.
  private _rsh: number;
  private _narrow: number;
  private _short: number;
  private _defw: number;
  private _defl: number;
  private _modTc1: number;
  private _modTc2: number;
  private _modTce: number;
  private _tnom: number;
  private _modRes: number;
  private _modBvMax: number;
  // Model-card *Given guards — ngspice model->RESxxxGiven.
  private _rshGiven: boolean;
  private _narrowGiven: boolean;
  private _shortGiven: boolean;
  private _defwGiven: boolean;
  private _deflGiven: boolean;
  private _modTc1Given: boolean;
  private _modTc2Given: boolean;
  private _modTceGiven: boolean;
  private _tnomGiven: boolean;
  private _modResGiven: boolean;
  private _modBvMaxGiven: boolean;

  // Cached element-pool handles allocated in setup() and consumed by
  // load() via solver.stampElement. Mirror ngspice RES instance pointers
  // RESposPosPtr / RESnegNegPtr / RESposNegPtr / RESnegPosPtr.

  /**
   * AC resistance the acres branch derates — ngspice here->RESacResist
   * (resdefs.h). Equals the DC resistance unless acres is given; updateConduct()
   * keeps it in sync with the AC conductance _Gac.
   */
  get acResistance(): number {
    return this._acResist;
  }

  /**
   * Maximum voltage over the resistor — ngspice here->RESbv_max (resdefs.h),
   * defaulting to the model bv_max (ressetup.c:57-58). The breakdown limit a
   * downstream operating-point check reads against the terminal voltage.
   */
  get breakdownVoltageMax(): number {
    return this._bvMax;
  }

  private _hPP: number = -1;
  private _hNN: number = -1;
  private _hPN: number = -1;
  private _hNP: number = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);

    // *Given guards mirror ngspice's per-instance/model `<x>Given` flags: true
    // only when the netlist actually supplied `<x>`, matching the cap pilot
    // (capacitor.ts:293-333) and inductor (inductor.ts:396-439).
    this._resGiven = props.isModelParamGiven("resistance");
    const rawRes = this._resGiven ? props.getModelParam<number>("resistance") : RESISTOR_DEFAULTS["resistance"]!;
    this._resistance = Math.max(rawRes, MIN_RESISTANCE);

    // Per-instance parameters.
    this._tempGiven  = props.isModelParamGiven("TEMP");
    this._TEMP       = this._tempGiven  ? props.getModelParam<number>("TEMP")  : RESISTOR_DEFAULTS["TEMP"]!;
    this._dtempGiven = props.isModelParamGiven("DTEMP");
    this._DTEMP      = this._dtempGiven ? props.getModelParam<number>("DTEMP") : RESISTOR_DEFAULTS["DTEMP"]!;
    this._wGiven     = props.isModelParamGiven("w");
    this._w          = this._wGiven     ? props.getModelParam<number>("w")     : RESISTOR_DEFAULTS["w"]!;
    this._lGiven     = props.isModelParamGiven("l");
    this._l          = this._lGiven     ? props.getModelParam<number>("l")     : RESISTOR_DEFAULTS["l"]!;
    this._scaleGiven = props.isModelParamGiven("SCALE");
    this._SCALE      = this._scaleGiven ? props.getModelParam<number>("SCALE") : RESISTOR_DEFAULTS["SCALE"]!;
    this._mGiven     = props.isModelParamGiven("M");
    this._M          = this._mGiven     ? props.getModelParam<number>("M")     : RESISTOR_DEFAULTS["M"]!;
    this._tc1Given   = props.isModelParamGiven("tc1");
    this._tc1        = this._tc1Given   ? props.getModelParam<number>("tc1")   : RESISTOR_DEFAULTS["tc1"]!;
    this._tc2Given   = props.isModelParamGiven("tc2");
    this._tc2        = this._tc2Given   ? props.getModelParam<number>("tc2")   : RESISTOR_DEFAULTS["tc2"]!;
    this._tceGiven   = props.isModelParamGiven("tce");
    this._tce        = this._tceGiven   ? props.getModelParam<number>("tce")   : RESISTOR_DEFAULTS["tce"]!;
    this._acresGiven = props.isModelParamGiven("acres");
    this._acres      = this._acresGiven ? props.getModelParam<number>("acres") : RESISTOR_DEFAULTS["acres"]!;
    this._bvMaxGiven = props.isModelParamGiven("bv_max");
    this._bvMax      = this._bvMaxGiven ? props.getModelParam<number>("bv_max") : RESISTOR_DEFAULTS["bv_max"]!;

    // Model-card parameters.
    this._rshGiven      = props.isModelParamGiven("rsh");
    this._rsh           = this._rshGiven      ? props.getModelParam<number>("rsh")      : RESISTOR_DEFAULTS["rsh"]!;
    this._narrowGiven   = props.isModelParamGiven("narrow");
    this._narrow        = this._narrowGiven   ? props.getModelParam<number>("narrow")   : RESISTOR_DEFAULTS["narrow"]!;
    this._shortGiven    = props.isModelParamGiven("short");
    this._short         = this._shortGiven    ? props.getModelParam<number>("short")    : RESISTOR_DEFAULTS["short"]!;
    this._defwGiven     = props.isModelParamGiven("defw");
    this._defw          = this._defwGiven     ? props.getModelParam<number>("defw")     : RESISTOR_DEFAULTS["defw"]!;
    this._deflGiven     = props.isModelParamGiven("defl");
    this._defl          = this._deflGiven     ? props.getModelParam<number>("defl")     : RESISTOR_DEFAULTS["defl"]!;
    this._modTc1Given   = props.isModelParamGiven("modTc1");
    this._modTc1        = this._modTc1Given   ? props.getModelParam<number>("modTc1")   : RESISTOR_DEFAULTS["modTc1"]!;
    this._modTc2Given   = props.isModelParamGiven("modTc2");
    this._modTc2        = this._modTc2Given   ? props.getModelParam<number>("modTc2")   : RESISTOR_DEFAULTS["modTc2"]!;
    this._modTceGiven   = props.isModelParamGiven("modTce");
    this._modTce        = this._modTceGiven   ? props.getModelParam<number>("modTce")   : RESISTOR_DEFAULTS["modTce"]!;
    this._tnomGiven     = props.isModelParamGiven("tnom");
    this._tnom          = this._tnomGiven     ? props.getModelParam<number>("tnom")     : RESISTOR_DEFAULTS["tnom"]!;
    this._modResGiven   = props.isModelParamGiven("r");
    this._modRes        = this._modResGiven   ? props.getModelParam<number>("r")        : RESISTOR_DEFAULTS["r"]!;
    this._modBvMaxGiven = props.isModelParamGiven("modBvMax");
    this._modBvMax      = this._modBvMaxGiven ? props.getModelParam<number>("modBvMax") : RESISTOR_DEFAULTS["modBvMax"]!;

    // At construction the reference temperature equals tnom, so difference = 0,
    // factor = 1 and _G = RESm/(resist·scale). setup() and computeTemperature()
    // overwrite this with the geometry/TC/SCALE fold before load() runs. RESm is
    // folded into RESconduct by RESupdate_conduct (restemp.c:104). _acResist
    // mirrors ngspice RESacResist, set from acres by RESparam (resparam.c:45).
    this._acResist = this._acresGiven ? this._acres : this._resistance;
    this._G = this._M / (this._resistance * this._SCALE);
    this._Gac = this._G;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this.pinNodes.get("pos")!;  // RESposNode
    const negNode = this.pinNodes.get("neg")!;  // RESnegNode

    // Default-value processing (ressetup.c:29-58). model->REStnom defaults to
    // ckt->CKTnomTemp; the geometry/TC model defaults seed their !*Given arms;
    // instance w/l default to model defw/defl, SCALE/M default to 1, and
    // bv_max defaults to model bv_max.
    if (!this._tnomGiven)     this._tnom     = ctx.nomTemp;       // ressetup.c:29
    if (!this._rshGiven)      this._rsh      = 0.0;               // ressetup.c:30
    if (!this._defwGiven)     this._defw     = 10e-6;             // ressetup.c:31
    if (!this._deflGiven)     this._defl     = 10e-6;             // ressetup.c:32
    if (!this._modTc1Given)   this._modTc1   = 0.0;               // ressetup.c:33
    if (!this._modTc2Given)   this._modTc2   = 0.0;               // ressetup.c:34
    if (!this._modTceGiven)   this._modTce   = 0.0;               // ressetup.c:35
    if (!this._narrowGiven)   this._narrow   = 0.0;               // ressetup.c:36
    if (!this._shortGiven)    this._short    = 0.0;               // ressetup.c:37
    if (!this._modBvMaxGiven) this._modBvMax = 1e99;              // ressetup.c:44-45

    if (!this._wGiven)        this._w        = this._defw;        // ressetup.c:51
    if (!this._lGiven)        this._l        = this._defl;        // ressetup.c:52
    if (!this._scaleGiven)    this._SCALE    = 1.0;               // ressetup.c:53
    if (!this._mGiven)        this._M        = 1.0;               // ressetup.c:54
    if (!this._bvMaxGiven)    this._bvMax    = this._modBvMax;    // ressetup.c:57-58

    // ressetup.c:72-75- TSTALLOC sequence, line-for-line.
    this._hPP = solver.allocElement(posNode, posNode);  // (RESposNode, RESposNode)
    this._hNN = solver.allocElement(negNode, negNode);  // (RESnegNode, RESnegNode)
    this._hPN = solver.allocElement(posNode, negNode);  // (RESposNode, RESnegNode)
    this._hNP = solver.allocElement(negNode, posNode);  // (RESnegNode, RESposNode)
  }

  /**
   * computeTemperature — per-instance temperature pass (REStemp body).
   *
   * cite: restemp.c:35-45 — per-instance temperature override, then the
   * conductance recompute. When temp is given the instance uses its absolute
   * TEMP and dtemp is forced 0 (ngspice prints a warning if dtemp was also
   * supplied); otherwise dtemp defaults to 0 and the operating temperature is
   * ckt->CKTtemp + dtemp.
   */
  computeTemperature(ctx: TempContext): void {
    // restemp.c:35-43 — instance temperature override.
    if (!this._tempGiven) {
      // restemp.c:36-38 — !REStempGiven → REStemp = CKTtemp; dtemp defaults 0.
      this._TEMP = ctx.cktTemp;
      if (!this._dtempGiven) {
        this._DTEMP = 0.0;
      }
    } else {
      // restemp.c:39-43 — REStempGiven → dtemp forced 0; warn if dtemp supplied.
      this._DTEMP = 0.0;
      if (this._dtempGiven) {
        console.warn(`${this.label}: Instance temperature specified, dtemp ignored`);
      }
    }

    // restemp.c:45 — RESupdate_conduct(here, TRUE).
    this.updateConduct(true);
  }

  /**
   * updateConduct — geometry/temperature conductance recompute
   * (RESupdate_conduct body). Rebuilds _resistance (geometry), _G and _Gac from
   * the stored parameters; never mutated in place. RESm is folded into the
   * conductance (restemp.c:104), so the stamp sites carry no separate m.
   *
   * cite: restemp.c:53-113 (RESupdate_conduct). spill_warnings gates the
   * "resistance too low" warning so the setParam recompute (FALSE) stays quiet.
   */
  private updateConduct(spillWarning: boolean): void {
    let factor: number;
    let tc1: number;
    let tc2: number;
    let tce: number;

    // restemp.c:61-75 — geometry-derived resistance when no resistance supplied.
    if (!this._resGiven) {
      if (this._l * this._w * this._rsh > 0.0) {
        // restemp.c:63-66 — (L − 2·short) / (W − 2·narrow) · rsh.
        this._resistance =
          (this._l - 2 * this._short) /
          (this._w - 2 * this._narrow) *
          this._rsh;
      } else if (this._modResGiven) {
        // restemp.c:67-68 — model default resistance.
        this._resistance = this._modRes;
      } else {
        // restemp.c:69-74 — degenerate: warn and clamp to 1 mOhm.
        if (spillWarning) {
          console.warn(`${this.label}: resistance to low, set to 1 mOhm`);
        }
        this._resistance = 1e-03;
      }
    }

    // restemp.c:77 — difference = (REStemp + RESdtemp) − REStnom.
    const difference = (this._TEMP + this._DTEMP) - this._tnom;

    // restemp.c:79-94 — instance tc1/tc2/tce override model coefficients.
    if (this._tc1Given)
      tc1 = this._tc1; // instance
    else
      tc1 = this._modTc1; // model

    if (this._tc2Given)
      tc2 = this._tc2;
    else
      tc2 = this._modTc2;

    if (this._tceGiven)
      tce = this._tce;
    else
      tce = this._modTce;

    // restemp.c:96-99 — tce path: factor = 1.01^(tce·difference); otherwise the
    // Horner-form polynomial (((tc2·diff)+tc1)·diff)+1.0.
    if (this._tceGiven || this._modTceGiven)
      factor = Math.pow(1.01, tce * difference);
    else
      factor = (((tc2 * difference) + tc1) * difference) + 1.0;

    // restemp.c:101-102 — scale defaults to 1 when not given.
    if (!this._scaleGiven)
      this._SCALE = 1;

    // restemp.c:104 — conductance = RESm / (resist · factor · scale).
    this._G = this._M / (this._resistance * factor * this._SCALE);

    // restemp.c:106-112 — Paolo Nenzi AC value: when acres is given the AC
    // conductance derates the separate acResist; otherwise it equals _G.
    if (this._acresGiven) {
      this._Gac = this._M / (this._acResist * factor * this._SCALE);
    } else {
      this._Gac = this._G;
      this._acResist = this._resistance;
    }
  }

  setParam(key: string, value: number): void {
    switch (key) {
      case "resistance":
        this._resistance = Math.max(value, MIN_RESISTANCE);
        this._resGiven = true;
        break;
      case "TEMP":
        // resparam.c:29-32 — REStemp = value + CONSTCtoK; clamp to 0 below 1e-6 K.
        this._TEMP = value;
        if (this._TEMP < 1e-6)
          this._TEMP = 0;
        this._tempGiven = true;
        break;
      case "DTEMP":
        this._DTEMP = value;
        this._dtempGiven = true;
        break;
      case "w":
        this._w = value;
        this._wGiven = true;
        break;
      case "l":
        this._l = value;
        this._lGiven = true;
        break;
      case "SCALE":
        this._SCALE = value;
        this._scaleGiven = true;
        break;
      case "M":
        this._M = value;
        this._mGiven = true;
        break;
      case "tc1":
        this._tc1 = value;
        this._tc1Given = true;
        break;
      case "tc2":
        this._tc2 = value;
        this._tc2Given = true;
        break;
      case "tce":
        this._tce = value;
        this._tceGiven = true;
        break;
      case "acres":
        // resparam.c:44-46 — RES_ACRESIST stores acres into RESacResist.
        this._acres = value;
        this._acResist = value;
        this._acresGiven = true;
        break;
      case "bv_max":
        this._bvMax = value;
        this._bvMaxGiven = true;
        break;
      case "rsh":
        this._rsh = value;
        this._rshGiven = true;
        break;
      case "narrow":
        this._narrow = value;
        this._narrowGiven = true;
        break;
      case "short":
        this._short = value;
        this._shortGiven = true;
        break;
      case "defw":
        this._defw = value;
        this._defwGiven = true;
        break;
      case "defl":
        this._defl = value;
        this._deflGiven = true;
        break;
      case "modTc1":
        this._modTc1 = value;
        this._modTc1Given = true;
        break;
      case "modTc2":
        this._modTc2 = value;
        this._modTc2Given = true;
        break;
      case "modTce":
        this._modTce = value;
        this._modTceGiven = true;
        break;
      case "tnom":
        this._tnom = value;
        this._tnomGiven = true;
        break;
      case "r":
        this._modRes = value;
        this._modResGiven = true;
        break;
      case "modBvMax":
        this._modBvMax = value;
        this._modBvMaxGiven = true;
        break;
      default:
        return;
    }
    // resparam.c — RESupdate_conduct(here, FALSE) re-runs on any parameter
    // change; the FALSE suppresses the degenerate-resistance warning.
    this.updateConduct(false);
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    // resload.c:31-34 — value-side stamps through cached handles. RESm is folded
    // into RESconduct by RESupdate_conduct, so the stamps carry no separate m.
    solver.stampElement(this._hPP, this._G);
    solver.stampElement(this._hNN, this._G);
    solver.stampElement(this._hPN, -this._G);
    solver.stampElement(this._hNP, -this._G);
  }

  stampAc(solver: SparseSolverStamp, _omega: number, _ctx: LoadContext): void {
    // resload.c:59-67 (RESacload) — the conductance is frequency-independent and
    // purely real. RESm is folded into RESacConduct/RESconduct, so the stamps
    // carry no separate m.
    let g: number;
    if (this._acresGiven)
      g = this._Gac;
    else
      g = this._G;

    solver.stampElement(this._hPP, g);
    solver.stampElement(this._hNN, g);
    solver.stampElement(this._hPN, -g);
    solver.stampElement(this._hNP, -g);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const n0 = this.pinNodes.get("pos")!;
    const n1 = this.pinNodes.get("neg")!;
    const vA = rhs[n0];
    const vB = rhs[n1];
    // resload.c:28-29 — REScurrent = (Vpos − Vneg) · RESconduct. RESconduct now
    // carries the RESm fold (restemp.c:104), matching the m·G matrix stamp.
    const I = this._G * (vA - vB);
    return [I, -I];
  }
}

function createResistorElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
): AnalogElement {
  const el = new ResistorAnalogElement(pinNodes, props);
  return el;
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const RESISTOR_PROPERTY_DEFS: PropertyDefinition[] = [
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

export const RESISTOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "resistance",
    propertyKey: "resistance",
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
// ResistorDefinition
// ---------------------------------------------------------------------------

function resistorCircuitFactory(props: PropertyBag): ResistorElement {
  return new ResistorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ResistorDefinition: StandaloneComponentDefinition = {
  name: "Resistor",
  typeId: -1,
  factory: resistorCircuitFactory,
  pinLayout: buildResistorPinDeclarations(),
  voltageProbes: [{ name: "V", pos: "pos", neg: "neg" }],
  propertyDefs: RESISTOR_PROPERTY_DEFS,
  attributeMap: RESISTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Resistor  stamps conductance G=1/R into the MNA matrix.\n" +
    "Minimum resistance is clamped to 1e-9 Ω.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createResistorElement,
      paramDefs: RESISTOR_PARAM_DEFS,
      params: RESISTOR_DEFAULTS,
      spice: { device: "RES", deckNodeTokens: ["pos", "neg"] },
    },
  },
  defaultModel: "behavioral",
};
