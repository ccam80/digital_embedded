/**
 * AC Current Source  time-varying independent current source for MNA simulation.
 *
 * Supports the same waveform set as AcVoltageSource (sine, square, triangle,
 * sawtooth, expression, sweep, am, fm, noise). The waveform is evaluated at the
 * current simulation time via getTime().
 *
 * MNA stamp: RHS-only (ngspice ISRCload convention). No matrix entries, no branch row.
 *   RHS[nodePos] += I(t) * srcFact   (current enters nodePos)
 *   RHS[nodeNeg] -= I(t) * srcFact   (current leaves nodeNeg)
 *
 * ngspice anchor: isrcload.c (ISRCload). The current source stamps only into
 * the RHS vector — no TSTALLOC, no branch row, no state slots.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import { formatSI } from "../../editor/si-format.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SparseSolverStamp } from "../../solver/analog/sparse-solver.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { MODEDC, MODEDCOP, MODEDCTRANCURVE, MODETRANOP } from "../../solver/analog/ckt-mode.js";
import { parseExpression, evaluateExpression, ExprParseError } from "../../solver/analog/expression.js";
import type { ExprNode } from "../../solver/analog/expression.js";
import { defineModelParams } from "../../core/model-params.js";
import { almostEqualUlps } from "../../solver/analog/timestep.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import {
  type Waveform,
  type ExtendedWaveformParams,
  type WaveformStepContext,
  type TrnoiseRingBuffer,
  type TrrandomState,
  FunctionType,
  computeWaveformValue,
  evaluateNgspiceWaveform,
  enumWaveformCoeffs,
  parseCoeffVector,
} from "./ac-voltage-source.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: AC_CURRENT_SOURCE_PARAM_DEFS, defaults: AC_CURRENT_SOURCE_DEFAULTS } = defineModelParams({
  primary: {
    amplitude: { default: 0.001, unit: "A",   description: "Peak amplitude in amperes" },
    frequency: { default: 1000,  unit: "Hz",  description: "Frequency in Hz" },
  },
  secondary: {
    phase:    { default: 0,     unit: "rad", description: "Phase offset in radians" },
    dcOffset: { default: 0,     unit: "A",   description: "DC offset added to waveform" },
    riseTime: { default: 1e-12, unit: "s",   description: "Rise time for square wave transitions" },
    fallTime: { default: 1e-12, unit: "s",   description: "Fall time for square/sawtooth wave transitions" },
    noiseSampleTime: { default: 0, unit: "s", description: "Noise sample period TS (ngspice TRNOISE). Default 0 disables breakpoints." },
    acMagnitude: { default: 1, unit: "A",   description: "AC analysis magnitude (ngspice ISRCacMag, default 1)" },
    acPhase:     { default: 0, unit: "deg", description: "AC analysis phase in degrees (ngspice ISRCacPhase, default 0)" },
    // isrc.c:15 / isrctemp.c:62-63 — ISRCmValue parallel multiplier, default 1.
    m: { default: 1, unit: "", description: "Parallel multiplier (ngspice ISRCmValue)" },
  },
});

// ---------------------------------------------------------------------------
// AcCurrentSourceElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class AcCurrentSourceElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("AcCurrentSource", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(AC_CURRENT_SOURCE_PIN_LAYOUT, []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 0.735, width: 4, height: 1.47 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const amplitude = this._properties.getModelParam<number>("amplitude");
    const frequency = this._properties.getModelParam<number>("frequency");
    const label = this._visibleLabel();
    const vNeg = signals?.getPinVoltage("neg");
    const vPos = signals?.getPinVoltage("pos");

    ctx.save();
    ctx.setLineWidth(1);

    // Lead from neg pin (x=0) to body
    drawColoredLead(ctx, signals, vNeg, 0, 0, 1.1875, 0);

    // Lead from pos pin (x=4) to body
    drawColoredLead(ctx, signals, vPos, 2.8125, 0, 4, 0);

    // Body stays COMPONENT color
    ctx.setColor("COMPONENT");

    // Circle at center (r=0.735)
    ctx.drawCircle(2, 0, 0.735, false);

    // Arrow shaft
    ctx.drawLine(1.5625, 0, 2.1875, 0);

    // Arrow head
    ctx.drawPolygon([
      { x: 2.375, y: 0 },
      { x: 2.125, y: -0.25 },
      { x: 2.125, y: 0.25 },
    ], true);

    // Value label below body
    const displayLabel = label.length > 0
      ? label
      : (this._shouldShowValue() ? `${formatSI(amplitude, "A")} ${formatSI(frequency, "Hz")}` : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 2, 1, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const AC_CURRENT_SOURCE_PIN_LAYOUT: PinDeclaration[] = [
  {
    direction: PinDirection.OUTPUT,
    label: "neg",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.INPUT,
    label: "pos",
    defaultBitWidth: 1,
    position: { x: 4, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const AC_CURRENT_SOURCE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "waveform",
    type: PropertyType.ENUM,
    label: "Waveform",
    defaultValue: "sine",
    enumValues: ["sine", "square", "triangle", "sawtooth", "expression", "sweep", "am", "fm", "noise"],
    description: "Waveform shape",
    structural: true,
  },
  {
    key: "expression",
    type: PropertyType.STRING,
    label: "Expression",
    defaultValue: "sin(2 * pi * 1000 * t)",
    description: "Waveform expression with t as time variable",
    visibleWhen: { key: "waveform", values: ["expression"] },
  },
  {
    key: "freqStart",
    type: PropertyType.INT,
    label: "Sweep Start Freq (Hz)",
    defaultValue: 100,
    description: "Start frequency for sweep waveform (Hz)",
    visibleWhen: { key: "waveform", values: ["sweep"] },
  },
  {
    key: "freqEnd",
    type: PropertyType.INT,
    label: "Sweep End Freq (Hz)",
    defaultValue: 10000,
    description: "End frequency for sweep waveform (Hz)",
    visibleWhen: { key: "waveform", values: ["sweep"] },
  },
  {
    key: "sweepDuration",
    type: PropertyType.INT,
    label: "Sweep Duration (s)",
    defaultValue: 1,
    description: "Duration of the frequency sweep in seconds",
    visibleWhen: { key: "waveform", values: ["sweep"] },
  },
  {
    key: "sweepMode",
    type: PropertyType.ENUM,
    label: "Sweep Mode",
    defaultValue: "linear",
    enumValues: ["linear", "log"],
    description: "Sweep interpolation mode",
    visibleWhen: { key: "waveform", values: ["sweep"] },
  },
  {
    key: "modulationFreq",
    type: PropertyType.INT,
    label: "Modulation Freq (Hz)",
    defaultValue: 100,
    description: "Modulation frequency (Hz)",
    visibleWhen: { key: "waveform", values: ["am", "fm"] },
  },
  {
    key: "modulationDepth",
    type: PropertyType.INT,
    label: "Modulation Depth (0-1)",
    defaultValue: 1,
    description: "AM modulation depth (0 = no modulation, 1 = full AM)",
    visibleWhen: { key: "waveform", values: ["am"] },
  },
  {
    key: "modulationIndex",
    type: PropertyType.INT,
    label: "Modulation Index (rad)",
    defaultValue: 1,
    description: "FM modulation index (peak phase deviation in radians)",
    visibleWhen: { key: "waveform", values: ["fm"] },
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label",
  },
];

// ---------------------------------------------------------------------------
// Attribute map
// ---------------------------------------------------------------------------

const AC_CURRENT_SOURCE_ATTRIBUTE_MAP: AttributeMapping[] = [
  { xmlName: "Amplitude", propertyKey: "amplitude", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Frequency", propertyKey: "frequency", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Phase",     propertyKey: "phase",     convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "DCOffset",  propertyKey: "dcOffset",  convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "M",         propertyKey: "m",         convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Waveform",  propertyKey: "waveform",  convert: (v) => v },
  { xmlName: "Label",     propertyKey: "label",     convert: (v) => v },
];

// ---------------------------------------------------------------------------
// AcCurrentSourceAnalogImpl  RHS-only stamp (ngspice ISRCload convention)
//
// ngspice anchor: isrcload.c (ISRCload). Current sources stamp only into
// the RHS vector — no matrix entries, no branch row, no state slots.
// The waveform evaluation mirrors vsrcload.c's time-domain path, applied
// to I(t) instead of V(t). srcFact gating follows the same three-mode
// pattern as AcVoltageSource (MODEDCOP | MODEDCTRANCURVE | MODETRANOP).
// ---------------------------------------------------------------------------

class AcCurrentSourceAnalogImpl extends AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.ISRC;
  readonly deviceFamily: DeviceFamily = "ISRC";

  private readonly _p: Record<string, number>;
  private _amplitude: number;
  private _frequency: number;
  private _phase: number;
  private _dcOffset: number;
  private _riseTime: number;
  private _fallTime: number;
  private _noiseSampleTime: number;
  // AC analysis magnitude / phase. ngspice ISRC mirrors VSRC: srctemp.c sets
  // ISRCacMag = 1 and ISRCacPhase = 0 when an `AC` token is present without
  // explicit values, and isrcacld.c:36-50 stamps acReal = mag·cos(phase·π/180),
  // acImag = mag·sin(...) into CKTrhs / CKTirhs at the terminal nodes.
  private _acMagnitude: number;
  private _acPhase: number;
  // isrc.c:15 — ISRCmValue parallel multiplier; the paramDefs default of 1
  // supplies the isrctemp.c:62-63 `!ISRCmGiven ⇒ 1` rule, so an absent `m`
  // reads 1 and value*1 is bit-identical to the no-multiplier stamp.
  private _M: number;
  private readonly _waveform: Waveform;
  private readonly _ext: ExtendedWaveformParams;
  private readonly _getTime: () => number;

  _parsedExpr: ExprNode | null;
  _parseError: string | null;

  // Captures srcFact from load() for getPinCurrents consistency between iterations.
  private _lastSrcFact = 1;

  // ngspice independent-source waveform model (shared with VSRC; isrcdefs.h
  // mirrors vsrcdefs.h:50-93). A null _functionType means the digiTS-native
  // named-parameter extension path drives the waveform.
  private _functionType: FunctionType | null = null;
  private _functionOrder = 0;
  private _coeffs: Float64Array = new Float64Array(0);
  private _funcTGiven = false;
  private _dcValue = 0;
  private _dcGiven = false;
  private _trnoiseState: TrnoiseRingBuffer | null = null;
  private _trnoiseRng: import("../../solver/analog/monte-carlo.js").SeededRng | null = null;
  private _trrandomState: TrrandomState | null = null;
  // ISRC has no ISRCbreak_time / ISRCrdelay / ISRCr / ISRCrGiven / ISRCrBreakpt
  // (isrcdefs.h:21-67 — none present). ISRCaccept (isrcacct.c) recomputes every
  // breakpoint from ckt->CKTtime with no stored break-time gate, and the ISRC
  // PWL (isrcload.c:278-302) is the non-repeating form with no td=/r= support.
  // Circuit-global transient constants captured from LoadContext during load()
  // (see AcVoltageSourceAnalogImpl for the rationale).
  private _cktStep = 0;
  private _cktFinalTime = 0;
  // True when the coefficient model was derived from the editor-facing waveform
  // enum (square/triangle/sawtooth/sine) rather than an explicit SPICE funcType
  // token (mirrors AcVoltageSourceAnalogImpl; criterion #11).
  private _enumDerivedCoeffs = false;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag, getTime: () => number) {
    super(pinNodes);
    this._getTime = getTime;
    this._p = {
      amplitude: props.getModelParam<number>("amplitude"),
      frequency: props.getModelParam<number>("frequency"),
      phase:     props.getModelParam<number>("phase"),
      dcOffset:  props.getModelParam<number>("dcOffset"),
      riseTime:  props.getModelParam<number>("riseTime"),
      fallTime:  props.getModelParam<number>("fallTime"),
      noiseSampleTime: props.getModelParam<number>("noiseSampleTime"),
      // ISRC AC magnitude / phase defaults mirror ngspice srctemp.c (ISRCacMag = 1,
      // ISRCacPhase = 0); the paramDefs defaults supply those when an `AC` token
      // has no explicit values.
      acMagnitude: props.getModelParam<number>("acMagnitude"),
      acPhase:     props.getModelParam<number>("acPhase"),
      // isrc.c:15 / isrctemp.c:62-63 — ISRCmValue parallel multiplier; the
      // paramDefs default 1 supplies the !ISRCmGiven ⇒ 1 rule.
      m:           props.getModelParam<number>("m"),
    };
    this._amplitude = this._p.amplitude;
    this._frequency = this._p.frequency;
    this._phase = this._p.phase;
    this._dcOffset = this._p.dcOffset;
    this._riseTime = this._p.riseTime;
    this._fallTime = this._p.fallTime;
    this._noiseSampleTime = this._p.noiseSampleTime;
    this._acMagnitude = this._p.acMagnitude;
    this._acPhase = this._p.acPhase;
    this._M = this._p.m;
    this._waveform = props.getOrDefault<string>("waveform", "sine") as Waveform;
    this._ext = {
      freqStart: props.getOrDefault<number>("freqStart", 100),
      freqEnd: props.getOrDefault<number>("freqEnd", 10000),
      sweepDuration: props.getOrDefault<number>("sweepDuration", 1),
      sweepMode: props.getOrDefault<string>("sweepMode", "linear") as "linear" | "log",
      modulationFreq: props.getOrDefault<number>("modulationFreq", 100),
      modulationDepth: props.getOrDefault<number>("modulationDepth", 1),
      modulationIndex: props.getOrDefault<number>("modulationIndex", 1),
      riseTime: this._riseTime,
      fallTime: this._fallTime,
      noiseSampleTime: this._noiseSampleTime,
    };
    this._parsedExpr = null;
    this._parseError = null;
    if (this._waveform === "expression") {
      const exprText = props.getOrDefault<string>("expression", "sin(2 * pi * 1000 * t)");
      try {
        this._parsedExpr = parseExpression(exprText);
      } catch (err) {
        this._parseError = err instanceof ExprParseError ? err.message : String(err);
      }
    }

    // ngspice ISRC DC value / flag (mirrors vsrcpar.c:42-45). ISRCdcGiven is the
    // parse-time *given* flag — true only when the user explicitly set dcOffset.
    this._dcValue = this._dcOffset;
    this._dcGiven = props.isModelParamGiven("dcOffset");
    // SPICE function token + coefficient model (mirrors vsrcpar.c:79-286).
    this._initCoeffModel(props);
    // isrctemp.c:38-61 — value-presence + DC-vs-transient-time-0 notices.
    this._checkTime0DcConsistency();
  }

  /**
   * ISRCtemp value-presence and time-0 consistency notices (isrctemp.c:38-61).
   * When neither a DC value nor a transient function type is given, ngspice
   * emits an ERR_INFO notice that DC 0 is assumed. Otherwise, when both a DC
   * value and a transient function type are given (and the type is not
   * TRNOISE / TRRANDOM / EXTERNAL), the DC value is used for the .OP seed while
   * the transient waveform starts from its time-0 value; ngspice emits an
   * ERR_INFO notice if the two differ by more than 3 ULPs. Both branches are
   * diagnostic only — they change no numeric value.
   */
  private _checkTime0DcConsistency(): void {
    if (!this._dcGiven && !this._funcTGiven) {
      // isrctemp.c:38-43 — no DC value, no transient value.
      // eslint-disable-next-line no-console
      console.warn(
        `${this.label}: has no value, DC 0 assumed`,
      );
    } else if (this._dcGiven && this._funcTGiven
        && this._functionType !== FunctionType.TRNOISE
        && this._functionType !== FunctionType.TRRANDOM
        && this._functionType !== FunctionType.EXTERNAL) {
      // isrctemp.c:51-54 — AM and PWL take coeffs[1]; all others coeffs[0].
      const time0value = (this._functionType === FunctionType.AM
                       || this._functionType === FunctionType.PWL)
        ? this._coeffs[1] : this._coeffs[0];
      // isrctemp.c:56-60 — 3-ULP AlmostEqualUlps tolerance.
      if (!almostEqualUlps(time0value, this._dcValue, 3)) {
        // eslint-disable-next-line no-console
        console.warn(
          `${this.label}: dc value used for op instead of transient time=0 value.`,
        );
      }
    }
  }

  /** Mirror of AcVoltageSourceAnalogImpl._initCoeffModel (vsrcpar.c:79-286). */
  private _initCoeffModel(props: PropertyBag): void {
    const tokenRaw = props.getOrDefault<string>("funcType", "");
    const token = tokenRaw.trim().toUpperCase();
    if (token === "") {
      // Criterion #11: no SPICE function token — re-express the waveform enum
      // (square/triangle/sawtooth/sine) onto the ngspice coefficient engine.
      this._deriveEnumCoeffs();
      return;
    }

    const coeffs = props.has("coeffs")
      ? parseCoeffVector(props.get<number[] | string>("coeffs"))
      : [];

    switch (token) {
      case "PULSE": this.applyCoeffs(FunctionType.PULSE, coeffs); break;
      case "SINE":  this.applyCoeffs(FunctionType.SINE, coeffs); break;
      case "EXP":   this.applyCoeffs(FunctionType.EXP, coeffs); break;
      case "PWL":
        this.applyCoeffs(FunctionType.PWL, coeffs);
        for (let i = 0; i < (this._functionOrder / 2) - 1; i++) {
          if (this._coeffs[2 * (i + 1)] <= this._coeffs[2 * i]) {
            // eslint-disable-next-line no-console
            console.warn(`Warning : current source ${this.label} has non-increasing PWL time points.`);
          }
        }
        break;
      case "SFFM":  this.applyCoeffs(FunctionType.SFFM, coeffs); break;
      case "AM":    this.applyCoeffs(FunctionType.AM, coeffs); break;
      case "TRNOISE":
      case "TRRANDOM":
        this.applyCoeffs(token === "TRNOISE" ? FunctionType.TRNOISE : FunctionType.TRRANDOM, coeffs);
        throw new Error(
          `${token} current source requires the deterministic RNG substrate from `
          + `maths-misc#recon/randnumb (trnoise_state_init / trrandom_state_init), `
          + `which is not present in this worktree.`,
        );
      default:
        throw new Error(`Unrecognized ISRC function token '${tokenRaw}'.`);
    }
    // ISRCparam (isrcpar.c:33-266) has no ISRC_TD / ISRC_R cases — the ISRC PWL
    // is non-repeating, so there is no td=/r= parse route (unlike VSRC).
  }

  /** Mirror of copy_coeffs (vsrcpar.c:17-29). */
  applyCoeffs(fnType: FunctionType, vec: readonly number[]): void {
    this._functionType = fnType;
    this._funcTGiven = true;
    this._coeffs = Float64Array.from(vec);
    this._functionOrder = vec.length;
  }

  /**
   * Mirror of AcVoltageSourceAnalogImpl._deriveEnumCoeffs (criterion #11):
   * re-express the editor-facing waveform enum onto the ngspice coefficient
   * engine. Re-derived on every hot-loadable setParam when enum-driven.
   */
  private _deriveEnumCoeffs(): void {
    this._enumDerivedCoeffs = true;
    const built = enumWaveformCoeffs(
      this._waveform,
      this._amplitude,
      this._frequency,
      this._phase,
      this._dcOffset,
      this._riseTime,
      this._fallTime,
    );
    if (built === null) {
      this._functionType = null;
      this._funcTGiven = false;
      this._coeffs = new Float64Array(0);
      this._functionOrder = 0;
      return;
    }
    this.applyCoeffs(built.functionType, built.coeffs);
  }

  /** Build the per-evaluation engine-step context for evaluateNgspiceWaveform. */
  private _stepContext(): WaveformStepContext {
    return {
      cktStep: this._cktStep,
      cktFinalTime: this._cktFinalTime,
      dcValue: this._dcValue,
      dcGiven: this._dcGiven,
      trnoiseState: this._trnoiseState,
      trnoiseRng: this._trnoiseRng,
      trrandomState: this._trrandomState,
      // ISRC PWL is non-repeating (isrcload.c:278-302): no delay, no repeat.
      // Feeding rdelay=0/rGiven=false/rBreakpt=0 collapses the shared engine's
      // PWL arm to the ISRC form.
      rdelay: 0,
      rGiven: false,
      rBreakpt: 0,
    };
  }

  setup(_ctx: SetupContext): void {
    // ISRC has no *set.c in ngspice (no isrcset.c). No TSTALLOC, no internal
    // nodes, no branch row, no state slots, and no break-time field to seed —
    // ISRCaccept (isrcacct.c) recomputes every breakpoint from ckt->CKTtime.
  }

  setParam(key: string, value: number): void {
    if (key in this._p) {
      this._p[key] = value;
      this._amplitude = this._p.amplitude;
      this._frequency = this._p.frequency;
      this._phase = this._p.phase;
      this._dcOffset = this._p.dcOffset;
      this._riseTime = this._p.riseTime;
      this._fallTime = this._p.fallTime;
      this._noiseSampleTime = this._p.noiseSampleTime;
      this._acMagnitude = this._p.acMagnitude;
      this._acPhase = this._p.acPhase;
      // Keep _M in sync with the hot-loaded `m` param (hot-loadable-params
      // requirement); the next load()/stampAc()/getPinCurrents() reads it.
      this._M = this._p.m;
      this._ext.riseTime = this._riseTime;
      this._ext.fallTime = this._fallTime;
      this._ext.noiseSampleTime = this._noiseSampleTime;
      // Keep the DC value in sync (hot-loadable; mirrors vsrcpar.c:42-44).
      this._dcValue = this._dcOffset;
      this._dcGiven = true;
      // Criterion #11 hot-loadability: re-build PULSE/SINE coefficients from the
      // mutated named params when the waveform enum drives the coefficient engine.
      if (this._enumDerivedCoeffs) this._deriveEnumCoeffs();
    }
  }

  /**
   * Source current at the current time, before the srcFact ramp. Mirrors
   * AcVoltageSourceAnalogImpl._evaluate (the vsrcload.c branch structure).
   */
  private _evaluate(cktMode: number, t: number): number {
    if ((cktMode & (MODEDCOP | MODEDCTRANCURVE)) && this._dcGiven && this._funcTGiven) {
      return this._dcValue;
    }
    const time = (cktMode & MODEDC) ? 0 : t;
    if (this._funcTGiven && this._functionType !== null) {
      return evaluateNgspiceWaveform(this._functionType, this._coeffs, this._functionOrder, time, this._stepContext());
    }
    if (this._waveform === "expression") {
      return this._parsedExpr !== null ? evaluateExpression(this._parsedExpr, { t: time }) : 0;
    }
    return computeWaveformValue(this._waveform, this._amplitude, this._frequency, this._phase, this._dcOffset, time, this._ext);
  }

  load(ctx: LoadContext): void {
    const t = this._getTime();

    // Capture the circuit-global transient constants for acceptStep() /
    // getPinCurrents() (mirrors AcVoltageSourceAnalogImpl).
    this._cktStep = ctx.cktStep;
    this._cktFinalTime = ctx.cktFinalTime;

    // srcFact gating mirrors isrcload.c. The same three-mode pattern as
    // AcVoltageSource: apply srcFact for MODEDCOP | MODEDCTRANCURVE | MODETRANOP.
    const ramp = (ctx.cktMode & (MODEDCOP | MODEDCTRANCURVE | MODETRANOP))
      ? ctx.srcFact
      : 1.0;
    this._lastSrcFact = ramp;

    const I = this._evaluate(ctx.cktMode, t) * ramp;

    const nodePos = this.pinNodes.get("pos")!;
    const nodeNeg = this.pinNodes.get("neg")!;
    // isrcload.c:387-388 — the parallel multiplier scales the RHS stamp. `I`
    // already carries the srcFact ramp (isrcload.c:382-383), matching ngspice's
    // m * (value · srcFact) operand order.
    stampRHS(ctx.rhs, nodePos,  this._M * I);
    stampRHS(ctx.rhs, nodeNeg, -this._M * I);
  }

  stampAc(
    _solver: SparseSolverStamp,
    _omega: number,
    _ctx: LoadContext,
    rhsRe: Float64Array,
    rhsIm: Float64Array,
  ): void {
    // I-source AC stamp — isrcacld.c:43-50. The current source contributes
    // to RHS only at the terminal nodes (no branch row, no matrix entries):
    //   CKTrhs [posNode] += m · acReal     CKTrhs [negNode] -= m · acReal
    //   CKTirhs[posNode] += m · acImag     CKTirhs[negNode] -= m · acImag
    // m is the parallel multiplier (ISRCmValue, isrcacld.c:41).
    //
    // acReal / acImag derive from ISRCacMag / ISRCacPhase via the ISRCtemp
    // formula (isrctemp.c:64-66):
    //   acReal = mag · cos(phase · π / 180)
    //   acImag = mag · sin(phase · π / 180)
    const nodePos = this.pinNodes.get("pos")!;
    const nodeNeg = this.pinNodes.get("neg")!;
    const radians = this._acPhase * Math.PI / 180.0;
    const acReal = this._acMagnitude * Math.cos(radians);
    const acImag = this._acMagnitude * Math.sin(radians);
    // isrcacld.c:43-50 — the parallel multiplier scales all four AC RHS stamps.
    rhsRe[nodePos] += this._M * acReal;
    rhsRe[nodeNeg] -= this._M * acReal;
    rhsIm[nodePos] += this._M * acImag;
    rhsIm[nodeNeg] -= this._M * acImag;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    // No branch row. Pin layout: [neg, pos].
    // Conventional current flows neg→pos through the source. Sample the same
    // engine load() uses (transient time, cktMode=0 so the DC short-circuit is
    // bypassed) and reuse the srcFact captured by the last load().
    // isrcload.c:392 — the recorded current is m-scaled (ISRCcurrent = m * value).
    const I = this._evaluate(0, this._getTime()) * this._lastSrcFact * this._M;
    return [I, -I];
  }

  nextBreakpoint(afterTime: number): number | null {
    if (this._waveform === "square" || this._waveform === "triangle" || this._waveform === "sawtooth") {
      if (this._frequency <= 0) return null;
      const period = 1 / this._frequency;
      const halfPeriod = period / 2;
      const phaseShift = this._phase / (2 * Math.PI * this._frequency);

      let offsets: number[];
      switch (this._waveform) {
        case "square":
          offsets = [0, this._riseTime, halfPeriod, halfPeriod + this._fallTime];
          break;
        case "triangle":
          offsets = [0, halfPeriod];
          break;
        case "sawtooth": {
          const riseSpan = period - this._fallTime;
          offsets = [riseSpan, period];
          break;
        }
      }

      const nMin = Math.floor((afterTime + phaseShift) / period) - 1;
      let best: number | null = null;
      for (let n = nMin; n <= nMin + 2; n++) {
        const tPeriodStart = n * period - phaseShift;
        for (const offset of offsets) {
          const c = tPeriodStart + offset;
          if (c > afterTime + 1e-18) {
            if (best === null || c < best) best = c;
          }
        }
      }
      return best;
    }
    if (this._waveform === "noise") {
      if (this._noiseSampleTime <= 0) return null;
      return (Math.floor(afterTime / this._noiseSampleTime) + 1) * this._noiseSampleTime;
    }
    return null;
  }

  /** Mirror of ISRCaccept (isrcacct.c:25-323). */
  private _acceptNgspice(simTime: number, addBreakpoint: (t: number) => void): void {
    const coeffs = this._coeffs;
    const order = this._functionOrder;
    switch (this._functionType) {
      // isrcacct.c:47-49 — no function specified: no breakpoints.
      default:
        break;

      case FunctionType.PULSE: {
        // isrcacct.c:62-77 — TD TR TF PW PER PHASE with order/zero guards.
        const TD = order > 2 ? coeffs[2] : 0.0;
        const TR = order > 3 && coeffs[3] !== 0.0 ? coeffs[3] : this._cktStep;
        const TF = order > 4 && coeffs[4] !== 0.0 ? coeffs[4] : this._cktStep;
        const PW = order > 5 && coeffs[5] !== 0.0 ? coeffs[5] : this._cktFinalTime;
        const PER = order > 6 && coeffs[6] !== 0.0 ? coeffs[6] : this._cktFinalTime;
        const PHASE = order > 7 ? coeffs[7] : 0.0;
        // isrcacct.c:80-81 — offset time by delay; tshift carries the delay.
        let time = simTime - TD;
        const tshift = TD;
        let basetime = 0.0;
        let tmax = 1e99;
        // isrcacct.c:94-96 — v26 baseline: PHASE>0 ⇒ pulse-count cap. The
        // newcompat.xs branch (isrcacct.c:83-93) is blocked hunk isrcacct.c#h003.
        if (PHASE > 0.0) tmax = PHASE * PER;
        // isrcacct.c:98-100 — past the pulse-count cap: schedule nothing.
        if (time > tmax) break;
        // SAMETIME(a,b) (isrcacct.c:22-23): |a-b| <= TIMETOL*PW, TIMETOL=1e-7.
        const TIMETOL = 1e-7;
        const sametime = (a: number, b: number) => Math.abs(a - b) <= TIMETOL * PW;
        // isrcacct.c:102-107 — fold a repeating signal into one period.
        if (time >= PER) {
          basetime = PER * Math.floor(time / PER);
          time -= basetime;
        }
        if (time <= 0.0 || time >= TR + PW + TF) {
          // isrcacct.c:109-126
          if (sametime(time, 0.0)) {
            addBreakpoint(basetime + TR + tshift);
          } else if (sametime(TR + PW + TF, time)) {
            addBreakpoint(basetime + PER + tshift);
          } else if (time === -tshift) {
            addBreakpoint(basetime + tshift);
          } else if (sametime(PER, time)) {
            addBreakpoint(basetime + tshift + TR + PER);
          }
        } else if (time >= TR && time <= TR + PW) {
          // isrcacct.c:127-136
          if (sametime(time, TR)) {
            addBreakpoint(basetime + tshift + TR + PW);
          } else if (sametime(TR + PW, time)) {
            addBreakpoint(basetime + tshift + TR + PW + TF);
          }
        } else if (time > 0 && time < TR) {
          // isrcacct.c:137-146
          if (sametime(time, 0)) {
            addBreakpoint(basetime + tshift + TR);
          } else if (sametime(time, TR)) {
            addBreakpoint(basetime + tshift + TR + PW);
          }
        } else {
          // isrcacct.c:147-156 — time > TR + PW && < TR + PW + TF.
          if (sametime(time, TR + PW)) {
            addBreakpoint(basetime + tshift + TR + PW + TF);
          } else if (sametime(time, TR + PW + TF)) {
            addBreakpoint(basetime + tshift + PER);
          }
        }
        break;
      }

      // isrcacct.c:161-179 — SINE/EXP/SFFM/AM have no breakpoints.
      case FunctionType.SINE:
      case FunctionType.EXP:
      case FunctionType.SFFM:
      case FunctionType.AM:
        break;

      case FunctionType.PWL: {
        // isrcacct.c:181-197 — non-repeating PWL breakpoint scheduling.
        if (simTime < coeffs[0]) {
          // isrcacct.c:183-188 — before the first knot, break at the first time.
          addBreakpoint(coeffs[0]);
          break;
        }
        // isrcacct.c:189-195 — at a step within 3 ULPs of a knot, break at the next.
        for (let i = 0; i < Math.floor(order / 2) - 1; i++) {
          if (almostEqualUlps(coeffs[2 * i], simTime, 3)) {
            addBreakpoint(coeffs[2 * i + 2]);
            break;
          }
        }
        break;
      }

      case FunctionType.TRNOISE:
      case FunctionType.TRRANDOM:
        throw new Error(
          "TRNOISE/TRRANDOM breakpoint scheduling requires the deterministic RNG "
          + "substrate from maths-misc#recon/randnumb, which is not present in this worktree.",
        );
    }
  }

  acceptStep(
    simTime: number,
    addBreakpoint: (t: number) => void,
    atBreakpoint: boolean,
  ): void {
    if (!atBreakpoint) return;
    if (this._funcTGiven && this._functionType !== null) {
      this._acceptNgspice(simTime, addBreakpoint);
      return;
    }
    if (this._waveform === "sine" || this._waveform === "expression"
        || this._waveform === "am" || this._waveform === "fm" || this._waveform === "sweep") {
      return;
    }
    if (this._frequency <= 0) return;

    const period = 1 / this._frequency;
    const halfP = period / 2;
    const tshift = this._phase / (2 * Math.PI * this._frequency);

    if (this._waveform === "square") {
      const TR = this._riseTime;
      const TF = this._fallTime;
      const PW = Math.max(0, halfP - TR);
      const PER = period;
      const TIMETOL = 1e-7;
      const sametime = (a: number, b: number) => Math.abs(a - b) <= TIMETOL * PW;

      let time = simTime - tshift;
      let basetime = 0;
      if (time >= PER) {
        basetime = PER * Math.floor(time / PER);
        time -= basetime;
      }

      if (time <= 0 || time >= TR + PW + TF) {
        if (sametime(time, 0)) {
          addBreakpoint(basetime + TR + tshift);
        } else if (sametime(TR + PW + TF, time)) {
          addBreakpoint(basetime + PER + tshift);
        } else if (time === -tshift) {
          addBreakpoint(basetime + tshift);
        } else if (sametime(PER, time)) {
          addBreakpoint(basetime + tshift + TR + PER);
        }
      } else if (time >= TR && time <= TR + PW) {
        if (sametime(time, TR)) {
          addBreakpoint(basetime + tshift + TR + PW);
        } else if (sametime(TR + PW, time)) {
          addBreakpoint(basetime + tshift + TR + PW + TF);
        }
      } else if (time > 0 && time < TR) {
        if (sametime(time, 0)) {
          addBreakpoint(basetime + tshift + TR);
        } else if (sametime(time, TR)) {
          addBreakpoint(basetime + tshift + TR + PW);
        }
      } else {
        if (sametime(time, TR + PW)) {
          addBreakpoint(basetime + tshift + TR + PW + TF);
        } else if (sametime(time, TR + PW + TF)) {
          addBreakpoint(basetime + tshift + PER);
        }
      }
      return;
    }

    if (this._waveform === "triangle") {
      const PW = halfP;
      const TIMETOL = 1e-7;
      const sametime = (a: number, b: number) => Math.abs(a - b) <= TIMETOL * PW;

      let time = simTime - tshift;
      let basetime = 0;
      if (time >= period) {
        basetime = period * Math.floor(time / period);
        time -= basetime;
      }

      if (sametime(time, 0)) {
        addBreakpoint(basetime + tshift + halfP);
      } else if (sametime(time, halfP)) {
        addBreakpoint(basetime + tshift + period);
      } else if (sametime(time, period)) {
        addBreakpoint(basetime + tshift + period + halfP);
      } else if (time === -tshift) {
        addBreakpoint(basetime + tshift);
      }
      return;
    }

    if (this._waveform === "sawtooth") {
      const TF = this._fallTime;
      const riseSpan = period - TF;
      const PW = riseSpan;
      const TIMETOL = 1e-7;
      const sametime = (a: number, b: number) => Math.abs(a - b) <= TIMETOL * PW;

      let time = simTime - tshift;
      let basetime = 0;
      if (time >= period) {
        basetime = period * Math.floor(time / period);
        time -= basetime;
      }

      if (sametime(time, 0)) {
        addBreakpoint(basetime + tshift + riseSpan);
      } else if (sametime(time, riseSpan)) {
        addBreakpoint(basetime + tshift + period);
      } else if (sametime(time, period)) {
        addBreakpoint(basetime + tshift + period + riseSpan);
      } else if (time === -tshift) {
        addBreakpoint(basetime + tshift);
      }
      return;
    }

    if (this._waveform === "noise") {
      const TS = this._noiseSampleTime;
      if (TS <= 0) return;
      const n = Math.floor(simTime / TS + 0.5);
      const nearest = n * TS;
      if (almostEqualUlps(nearest, simTime, 3)) {
        addBreakpoint((n + 1) * TS);
      }
      return;
    }
  }

  getBreakpoints(tStart: number, tEnd: number): number[] {
    const out: number[] = [];
    let t = tStart;
    while (true) {
      const next = this.nextBreakpoint(t);
      if (next === null || next >= tEnd) break;
      if (next <= t) {
        throw new Error(`nextBreakpoint returned non-monotonic value: ${next} <= ${t}`);
      }
      out.push(next);
      t = next;
    }
    return out;
  }
}

export function makeAcCurrentSource(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  getTime: () => number,
): AnalogElement {
  return new AcCurrentSourceAnalogImpl(pinNodes, props, getTime);
}

// ---------------------------------------------------------------------------
// AcCurrentSourceDefinition
// ---------------------------------------------------------------------------

export const AcCurrentSourceDefinition: StandaloneComponentDefinition = {
  name: "AcCurrentSource",
  typeId: -1,
  category: ComponentCategory.SOURCES,

  pinLayout: AC_CURRENT_SOURCE_PIN_LAYOUT,
  voltageProbes: [{ name: "V", pos: "pos", neg: "neg" }],
  propertyDefs: AC_CURRENT_SOURCE_PROPERTY_DEFS,
  attributeMap: AC_CURRENT_SOURCE_ATTRIBUTE_MAP,

  helpText: "AC Current Source  time-varying current source with configurable waveform.",

  factory(props: PropertyBag): AcCurrentSourceElement {
    return new AcCurrentSourceElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: makeAcCurrentSource,
      paramDefs: AC_CURRENT_SOURCE_PARAM_DEFS,
      params: AC_CURRENT_SOURCE_DEFAULTS,
      spice: { device: "ISRC", deckNodeTokens: ["pos", "neg"] },
    },
  },
  defaultModel: "behavioral",
};
