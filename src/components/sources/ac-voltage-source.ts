/**
 * AC Voltage Source  time-varying independent voltage source.
 *
 * Supports four waveforms: sine, square, triangle, sawtooth.
 * The waveform is evaluated at the current simulation time via getTime().
 *
 * MNA stamp: same as DC voltage source (branch row for current tracking).
 *   B[nodePos, k] += 1    C[k, nodePos] += 1
 *   B[nodeNeg, k] -= 1    C[k, nodeNeg] -= 1
 *   RHS[k] = V(t) * scale
 *
 * where k is the absolute branch row index.
 *
 * For square wave, getBreakpoints() returns the transition times within a
 * given interval so the timestep controller can land exactly on edges.
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
import { MODEDCOP, MODEDCTRANCURVE, MODETRANOP } from "../../solver/analog/ckt-mode.js";
import { parseExpression, evaluateExpression, ExprParseError } from "../../solver/analog/expression.js";
import type { ExprNode } from "../../solver/analog/expression.js";
import { defineModelParams } from "../../core/model-params.js";
import { almostEqualUlps } from "../../solver/analog/timestep.js";

// ---------------------------------------------------------------------------
// Waveform computation
// ---------------------------------------------------------------------------

export type Waveform = "sine" | "square" | "triangle" | "sawtooth" | "expression" | "sweep" | "am" | "fm" | "noise";

/**
 * Box-Muller transform: produces a standard normal (mean=0, std=1) sample.
 */
function boxMuller(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1 === 0 ? Number.EPSILON : u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Extended waveform parameters for sweep, AM, FM, noise, and square wave modes.
 */
export interface ExtendedWaveformParams {
  freqStart?: number;
  freqEnd?: number;
  sweepDuration?: number;
  sweepMode?: "linear" | "log";
  modulationFreq?: number;
  modulationDepth?: number;
  modulationIndex?: number;
  /** Rise time for square wave transitions (seconds). Default 0 = instantaneous. */
  riseTime?: number;
  /**
   * Fall time (seconds). Used by:
   *   - square wave: duration of the trapezoidal falling edge (V2  V1).
   *   - sawtooth: duration of the sharp fall from V2 back to V1 at the period
   *     boundary. Default 1 ps so that SPICE PULSE can encode it exactly while
   *     remaining below typical transient timesteps. Must be strictly less
   *     than one period.
   */
  fallTime?: number;
  /**
   * Noise sample period TS (seconds). Mirrors ngspice TRNOISE's TS param
   * (vsrcacct.c:194). Breakpoints are registered at integer multiples of TS
   * via the TRNOISE pattern: at each accepted-step that sits within 3 ULPs of
   * `floor(t/TS + 0.5)*TS`, register `(n+1)*TS`. When TS = 0 no breakpoints
   * are registered (matches ngspice's `if (TS == 0.0 && RTSAM == 0.0) break`).
   */
  noiseSampleTime?: number;
}

/**
 * Compute instantaneous waveform value at time t.
 *
 * @param waveform  - Waveform type
 * @param amplitude - Peak amplitude in volts
 * @param frequency - Carrier frequency in Hz (also used as center/base frequency)
 * @param phase     - Phase offset in radians
 * @param dcOffset  - DC offset added to waveform output
 * @param t         - Simulation time in seconds
 * @param ext       - Extended parameters for sweep/AM/FM/noise modes
 */
export function computeWaveformValue(
  waveform: Waveform,
  amplitude: number,
  frequency: number,
  phase: number,
  dcOffset: number,
  t: number,
  ext?: ExtendedWaveformParams,
): number {
  const arg = 2 * Math.PI * frequency * t + phase;
  switch (waveform) {
    case "sine":
      // ngspice vsrcload.c:159- operand order is `FREQ*time * 2.0 * M_PI + phase`,
      // not `2*PI*FREQ*time + phase`. Floating-point multiply is non-associative,
      // so the difference is observable as 1 ULP in the argument and propagates
      // through sin to a 1-ULP source voltage that drifts the entire MNA solve.
      return dcOffset + amplitude * Math.sin(frequency * t * 2.0 * Math.PI + phase);

    case "square": {
      const riseTime = ext?.riseTime ?? 0;
      const fallTime = ext?.fallTime ?? 0;
      if (riseTime === 0 && fallTime === 0) {
        return dcOffset + amplitude * Math.sign(Math.sin(arg));
      }
      // Trapezoidal square wave  ngspice PULSE semantics (vsrcload.c).
      // V1 = dcOffset - amplitude (LOW), V2 = dcOffset + amplitude (HIGH)
      // Rising edge: [0, TR]; HIGH plateau: [TR, TR+PW]; falling edge: [TR+PW, TR+PW+TF]; LOW: rest.
      const period = frequency > 0 ? 1 / frequency : Infinity;
      const halfPeriod = period / 2;
      // Positive phase shifts waveform left (earlier) in time.
      const phaseShift = phase / (2 * Math.PI * frequency);
      const tShifted = t - phaseShift;
      // Mirrors vsrcload.c:112-117 bit-exact: gate on `time > PER`, then
      // reduce via `time -= PER * floor(time/PER)`. For tShifted <= PER the
      // value is used as-is  preserves f64 precision for tShifted << PER
      // (the failing rc-transient case where ((x%P)+P)%P loses ~2e7 ULPs).
      // Negative tShifted (from positive phase shift) falls through unchanged
      // and is handled by the `tMod <= 0` branch below, matching ngspice's
      // `time <= 0` PULSE branch.
      let tMod = tShifted;
      if (tMod > period) {
        tMod = tMod - period * Math.floor(tMod / period);
      }

      const TR = riseTime;
      const TF = fallTime;
      // HIGH plateau width: period/2 - TR. Clamp to 0 if rise time exceeds half period.
      const PW = Math.max(0, halfPeriod - TR);
      const V1 = dcOffset - amplitude;
      const V2 = dcOffset + amplitude;

      if (tMod <= 0 || tMod >= TR + PW + TF) {
        return V1;
      } else if (tMod >= TR && tMod <= TR + PW) {
        return V2;
      } else if (tMod > 0 && tMod < TR) {
        return V1 + (V2 - V1) * tMod / TR;
      } else {
        // tMod in (TR+PW, TR+PW+TF)
        return V2 + (V1 - V2) * (tMod - TR - PW) / TF;
      }
    }

    case "triangle": {
      // SPICE PULSE triangle semantics: at t=0, phase=0 the wave sits at
      // V1 = dcOffset - amplitude and rises linearly to V2 = dcOffset + amplitude
      // at t = period/2, then falls linearly back to V1 at t = period. The
      // piecewise-linear form is bit-exact against a SPICE PULSE(V1 V2 TD halfP
      // halfP 0 period) emission  indispensable for .tran parity against
      // ngspice (computing via asin(sin(...)) instead drifts by ~1 ulp per
      // sample due to the irrational-Ï€ rounding chain).
      if (frequency <= 0) return dcOffset - amplitude;
      const period = 1 / frequency;
      const halfPeriod = period / 2;
      const phaseShift = phase / (2 * Math.PI * frequency);
      const tShifted = t - phaseShift;
      // ngspice vsrcload.c:112-117 bit-exact reduction.
      let tMod = tShifted;
      if (tMod > period) {
        tMod = tMod - period * Math.floor(tMod / period);
      }
      const V1 = dcOffset - amplitude;
      const V2 = dcOffset + amplitude;
      // Mirrors PULSE branch `time <= 0 || time >= TR + PW + TF` (= period for
      // triangle): handles negative tShifted from phase shift.
      if (tMod <= 0 || tMod >= period) return V1;
      if (tMod < halfPeriod) {
        return V1 + (V2 - V1) * tMod / halfPeriod;
      }
      return V2 - (V2 - V1) * (tMod - halfPeriod) / halfPeriod;
    }

    case "sawtooth": {
      // SPICE PULSE sawtooth semantics: linear rise from V1 to V2 over
      // (period - fallTime), then linear fall from V2 back to V1 over
      // fallTime. At t=0, phase=0 the wave is at V1 rising.
      if (frequency <= 0) return dcOffset - amplitude;
      const period = 1 / frequency;
      const fallTime = ext?.fallTime ?? 1e-12;
      if (fallTime >= period) {
        throw new Error(
          `sawtooth fallTime (${fallTime}s) must be strictly less than period (${period}s)`,
        );
      }
      const riseSpan = period - fallTime;
      const phaseShift = phase / (2 * Math.PI * frequency);
      const tShifted = t - phaseShift;
      // ngspice vsrcload.c:112-117 bit-exact reduction.
      let tMod = tShifted;
      if (tMod > period) {
        tMod = tMod - period * Math.floor(tMod / period);
      }
      const V1 = dcOffset - amplitude;
      const V2 = dcOffset + amplitude;
      // Mirrors PULSE branch `time <= 0 || time >= TR + PW + TF` (= period for
      // sawtooth): handles negative tShifted from phase shift.
      if (tMod <= 0 || tMod >= period) return V1;
      if (tMod < riseSpan) {
        return V1 + (V2 - V1) * tMod / riseSpan;
      }
      return V2 - (V2 - V1) * (tMod - riseSpan) / fallTime;
    }

    case "sweep": {
      const fStart = ext?.freqStart ?? frequency;
      const fEnd = ext?.freqEnd ?? frequency;
      const T = ext?.sweepDuration ?? 1;
      const mode = ext?.sweepMode ?? "linear";
      let ft: number;
      if (mode === "log" && fStart > 0 && fEnd > 0) {
        ft = fStart * Math.pow(fEnd / fStart, Math.min(t, T) / T);
      } else {
        ft = fStart + (fEnd - fStart) * Math.min(t, T) / T;
      }
      return dcOffset + amplitude * Math.sin(2 * Math.PI * ft * t + phase);
    }

    case "am": {
      const modFreq = ext?.modulationFreq ?? 100;
      const depth = ext?.modulationDepth ?? 1.0;
      return dcOffset + (1 + depth * Math.sin(2 * Math.PI * modFreq * t)) * amplitude * Math.sin(arg);
    }

    case "fm": {
      const modFreq = ext?.modulationFreq ?? 100;
      const idx = ext?.modulationIndex ?? 1.0;
      return dcOffset + amplitude * Math.sin(2 * Math.PI * frequency * t + idx * Math.sin(2 * Math.PI * modFreq * t) + phase);
    }

    case "noise":
      return dcOffset + amplitude * boxMuller();

    case "expression":
      return dcOffset;
  }
}

/**
 * Return the times of square-wave edge breakpoints within (tStart, tEnd).
 *
 * Under ngspice PULSE semantics, within each period starting at t0 = n*period - phaseShift,
 * the four breakpoints are:
 *   t0 + 0      (start of rising edge  only useful when > tStart)
 *   t0 + TR     (end of rising edge)
 *   t0 + halfPeriod          (start of falling edge)
 *   t0 + halfPeriod + TF     (end of falling edge)
 *
 * Only times strictly inside (tStart, tEnd) are returned.
 *
 * @param frequency - Frequency in Hz
 * @param phase     - Phase offset in radians
 * @param tStart    - Interval start (exclusive) in seconds
 * @param tEnd      - Interval end (exclusive) in seconds
 */
export function squareWaveBreakpoints(
  frequency: number,
  phase: number,
  tStart: number,
  tEnd: number,
  riseTime = 0,
  fallTime = 0,
): number[] {
  if (frequency <= 0) return [];
  const period = 1 / frequency;
  const halfPeriod = period / 2;
  const phaseShift = phase / (2 * Math.PI * frequency);

  // Offsets within a period for the four breakpoints.
  const offsets = [0, riseTime, halfPeriod, halfPeriod + fallTime];

  const breakpoints: number[] = [];

  // Period n starts at: n * period - phaseShift.
  // Find the first period n whose last breakpoint (halfPeriod + fallTime) could exceed tStart.
  const nMin = Math.floor((tStart + phaseShift - halfPeriod - fallTime) / period);

  let lastPushed = -Infinity;
  for (let n = nMin; ; n++) {
    const tPeriodStart = n * period - phaseShift;
    // Earliest candidate for this period: tPeriodStart + 0.
    // If the earliest candidate is already past tEnd we can stop.
    if (tPeriodStart > tEnd) break;

    for (const offset of offsets) {
      const t = tPeriodStart + offset;
      if (t > tStart && t < tEnd && t !== lastPushed) {
        breakpoints.push(t);
        lastPushed = t;
      }
    }
  }

  return breakpoints;
}

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: AC_VOLTAGE_SOURCE_PARAM_DEFS, defaults: AC_VOLTAGE_SOURCE_DEFAULTS } = defineModelParams({
  primary: {
    amplitude: { default: 5,    unit: "V",   description: "Peak amplitude in volts" },
    frequency: { default: 1000, unit: "Hz",  description: "Frequency in Hz" },
  },
  secondary: {
    phase:    { default: 0,    unit: "rad", description: "Phase offset in radians" },
    dcOffset: { default: 0,    unit: "V",   description: "DC offset added to waveform" },
    riseTime: { default: 1e-12, unit: "s",   description: "Rise time for square wave transitions" },
    fallTime: { default: 1e-12, unit: "s",   description: "Fall time for square/sawtooth wave transitions" },
    noiseSampleTime: { default: 0, unit: "s", description: "Noise sample period TS (ngspice TRNOISE). Default 0 disables breakpoints." },
    acMagnitude: { default: 1, unit: "V",   description: "AC analysis magnitude (ngspice VSRCacMag, default 1)" },
    acPhase:     { default: 0, unit: "deg", description: "AC analysis phase in degrees (ngspice VSRCacPhase, default 0)" },
  },
});

// ---------------------------------------------------------------------------
// AcVoltageSourceElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class AcVoltageSourceElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("AcVoltageSource", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(AC_VOLTAGE_SOURCE_PIN_LAYOUT, []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1.04125, width: 4, height: 2.0825 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    // All coordinates from Falstad reference (px / 16 = grid units):
    // Leads: (0,0)(15,0) and (49,0)(64,0)
    // Circle: cx=32, cy=0, r=16.66  cx=2gu, r=1.04125gu
    // Sine wave: 21 line segments from x=22..42 px
    const PX = 1 / 16;

    const vPos = signals?.getPinVoltage("pos");
    const vNeg = signals?.getPinVoltage("neg");

    ctx.save();
    ctx.setLineWidth(1);

    // Lead from neg pin (x=0) to body
    drawColoredLead(ctx, signals, vNeg, 0, 0, 15 * PX, 0);

    // Lead from pos pin (x=4) to body
    drawColoredLead(ctx, signals, vPos, 49 * PX, 0, 4, 0);

    // Circle body and sine wave stay COMPONENT color
    ctx.setColor("COMPONENT");
    ctx.drawCircle(2, 0, 16.66 * PX, false);

    // Sine wave inside the circle  matches Falstad reference exactly
    // 21 segments from x=22 to x=42 px, y values trace one full sine cycle
    const sinePoints: [number, number][] = [
      [22, 0], [23, -2], [24, -4], [25, -6], [26, -7],
      [27, -7], [28, -7], [29, -6], [30, -4], [31, -2],
      [32, 0], [33, 2], [34, 4], [35, 6], [36, 7],
      [37, 7], [38, 7], [39, 6], [40, 4], [41, 2],
      [42, 0],
    ];
    for (let i = 0; i < sinePoints.length - 1; i++) {
      const [x1, y1] = sinePoints[i];
      const [x2, y2] = sinePoints[i + 1];
      ctx.drawLine(x1 * PX, y1 * PX, x2 * PX, y2 * PX);
    }

    // Value label below body
    const label = this._visibleLabel();
    const amplitude = this._properties.getModelParam<number>("amplitude");
    const frequency = this._properties.getModelParam<number>("frequency");
    const displayLabel = label.length > 0
      ? label
      : (this._shouldShowValue() ? `${formatSI(amplitude, "V")} ${formatSI(frequency, "Hz")}` : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    ctx.drawText(displayLabel, 2, 1.3, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const AC_VOLTAGE_SOURCE_PIN_LAYOUT: PinDeclaration[] = [
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

const AC_VOLTAGE_SOURCE_PROPERTY_DEFS: PropertyDefinition[] = [
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

const AC_VOLTAGE_SOURCE_ATTRIBUTE_MAP: AttributeMapping[] = [
  { xmlName: "Amplitude", propertyKey: "amplitude", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Frequency", propertyKey: "frequency", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Phase",     propertyKey: "phase",     convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "DCOffset",  propertyKey: "dcOffset",  convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Waveform",  propertyKey: "waveform",  convert: (v) => v },
  { xmlName: "Label",     propertyKey: "label",     convert: (v) => v },
];

// ---------------------------------------------------------------------------
// AcVoltageSourceAnalogElement  AnalogElement with time-varying stamp
// ---------------------------------------------------------------------------

export interface AcVoltageSourceAnalogElement extends AnalogElement {
  /** Returns transition times within [tStart, tEnd] for square waveforms. */
  getBreakpoints(tStart: number, tEnd: number): number[];
  /** Returns the strictly-next breakpoint strictly after afterTime, or null. */
  nextBreakpoint(afterTime: number): number | null;
  /**
   * Parsed expression AST for expression waveform mode.
   * Null if waveform is not "expression" or if parsing failed.
   */
  _parsedExpr: ExprNode | null;
  /** Parse error message if expression parsing failed; null otherwise. */
  _parseError: string | null;
  /** Live parameter mutation. */
  setParam(key: string, value: number): void;
}

class AcVoltageSourceAnalogImpl extends AnalogElement implements AcVoltageSourceAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VSRC;
  readonly deviceFamily: DeviceFamily = "VSRC";

  // Cached matrix-entry handles — vsrcset.c TSTALLOC sequence
  private _hPosBr = -1;
  private _hNegBr = -1;
  private _hBrNeg = -1;
  private _hBrPos = -1;

  // Mutable param record (hot-loadable via setParam)
  private readonly _p: Record<string, number>;
  private _amplitude: number;
  private _frequency: number;
  private _phase: number;
  private _dcOffset: number;
  private _riseTime: number;
  private _fallTime: number;
  private _noiseSampleTime: number;
  // AC analysis magnitude / phase (vsrctemp.c:39, 42, 68-70 — VSRCacMag and
  // VSRCacPhase, with default 1 / 0 deg; stamped each frequency in stampAc).
  private _acMagnitude: number;
  private _acPhase: number;
  private readonly _waveform: Waveform;
  private readonly _ext: ExtendedWaveformParams;
  private readonly _getTime: () => number;

  _parsedExpr: ExprNode | null;
  _parseError: string | null;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag, getTime: () => number) {
    super(pinNodes);
    this._getTime = getTime;
    this._p = {
      amplitude: props.getModelParam<number>("amplitude"),
      frequency: props.getModelParam<number>("frequency"),
      phase:     props.getModelParam<number>("phase"),
      dcOffset:  props.getModelParam<number>("dcOffset"),
      riseTime:  props.hasModelParam("riseTime") ? props.getModelParam<number>("riseTime") : 1e-12,
      fallTime:  props.hasModelParam("fallTime") ? props.getModelParam<number>("fallTime") : 1e-12,
      noiseSampleTime: props.hasModelParam("noiseSampleTime") ? props.getModelParam<number>("noiseSampleTime") : 0,
      // vsrctemp.c:39, 42 — VSRCacMag defaults to 1 and VSRCacPhase to 0 when
      // an `AC` token is given without explicit values.
      acMagnitude: props.hasModelParam("acMagnitude") ? props.getModelParam<number>("acMagnitude") : 1,
      acPhase:     props.hasModelParam("acPhase")     ? props.getModelParam<number>("acPhase")     : 0,
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

    // Parse expression once at creation for expression waveform mode.
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
  }

  setup(ctx: SetupContext): void {
    const posNode    = this.pinNodes.get("pos")!;
    const negNode    = this.pinNodes.get("neg")!;

    // Port of vsrcset.c:40-43- idempotent branch allocation
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    const branchNode = this.branchIndex;

    // Port of vsrcset.c:52-55- TSTALLOC sequence (line-for-line)
    this._hPosBr = ctx.solver.allocElement(posNode,    branchNode); // VSRCposNode, VSRCbranch
    this._hNegBr = ctx.solver.allocElement(negNode,    branchNode); // VSRCnegNode, VSRCbranch
    this._hBrNeg = ctx.solver.allocElement(branchNode, negNode);    // VSRCbranch,  VSRCnegNode
    this._hBrPos = ctx.solver.allocElement(branchNode, posNode);    // VSRCbranch,  VSRCposNode
  }

  findBranchFor(name: string, ctx: SetupContext): number {
    // Mirrors VSRCfindBr (vsrc/vsrcfbr.c:26-39).
    const dev = ctx.findDevice(name);
    if (!dev) return 0;
    if (dev.branchIndex === -1) {
      dev.branchIndex = ctx.makeCur(name, "branch");
    }
    return dev.branchIndex;
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
      this._ext.riseTime = this._riseTime;
      this._ext.fallTime = this._fallTime;
      this._ext.noiseSampleTime = this._noiseSampleTime;
    }
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    const t = this._getTime();

    // ngspice srcFact gating mirrors vsrcload.c. The waveform-evaluation path
    // (vsrcload.c:56-401) is followed by `if (CKTmode & MODETRANOP) value *= srcFact`
    // at vsrcload.c:410-412. The dcGiven branch (vsrcload.c:47-55) applies srcFact
    // when MODEDCOP|MODEDCTRANCURVE bits are set with a DC value present. digiTS's
    // AC source folds dcOffset into the waveform computation, so we treat the
    // combined output as having an effective DC content and gate srcFact across
    // all three source-stepping modes- matching the ssA.13 canonical pattern.
    // Outside these modes (regular MODETRAN steps, MODEAC), srcFact must NOT be
    // applied: AC small-signal analysis goes through stampAc / vsrcacld.c which
    // never multiplies by srcFact (vsrcacld.c:29-30).
    const ramp = (ctx.cktMode & (MODEDCOP | MODEDCTRANCURVE | MODETRANOP))
      ? ctx.srcFact
      : 1.0;

    let v: number;
    if (this._waveform === "expression") {
      if (this._parsedExpr !== null) {
        v = evaluateExpression(this._parsedExpr, { t }) * ramp;
      } else {
        v = 0;
      }
    } else {
      v = computeWaveformValue(this._waveform, this._amplitude, this._frequency, this._phase, this._dcOffset, t, this._ext) * ramp;
    }

    // vsrcload.c:43-46
    solver.stampElement(this._hPosBr, +1.0);
    solver.stampElement(this._hNegBr, -1.0);
    solver.stampElement(this._hBrPos, +1.0);
    solver.stampElement(this._hBrNeg, -1.0);
    // vsrcload.c:416- RHS
    ctx.rhs[this.branchIndex] += v;
  }

  stampAc(
    solver: SparseSolverStamp,
    _omega: number,
    _ctx: LoadContext,
    rhsRe: Float64Array,
    rhsIm: Float64Array,
  ): void {
    // V-source AC stamp — vsrcacld.c:175-180. The ±1 incidence pattern mirrors
    // the DC/transient stamp (vsrcload.c:43-46) and reuses the same four matrix
    // handles allocated in setup() (vsrcset.c TSTALLOC order); AC analysis runs
    // against the engine's setup-allocated solver in complex mode, so the
    // cached handles address the same cells CKTacLoad writes.
    //
    // acReal / acImag derive from VSRCacMag and VSRCacPhase per vsrctemp.c:68-70:
    //   VSRCacReal = VSRCacMag * cos(VSRCacPhase * π / 180)
    //   VSRCacImag = VSRCacMag * sin(VSRCacPhase * π / 180)
    solver.stampElement(this._hPosBr, +1.0);
    solver.stampElement(this._hNegBr, -1.0);
    solver.stampElement(this._hBrPos, +1.0);
    solver.stampElement(this._hBrNeg, -1.0);
    const radians = this._acPhase * Math.PI / 180.0;
    rhsRe[this.branchIndex] += this._acMagnitude * Math.cos(radians);
    rhsIm[this.branchIndex] += this._acMagnitude * Math.sin(radians);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    // MNA branch variable: rhs[branchIndex] = I flowing from nodeNeg
    // through source to nodePos.
    // Pin layout order: [neg, pos].
    // "Into element at neg" = -I (current exits neg into external circuit).
    // "Into element at pos" = +I (current enters pos from external circuit).
    const I = rhs[this.branchIndex];
    return [-I, I];
  }

  nextBreakpoint(afterTime: number): number | null {
    if (this._waveform === "square" || this._waveform === "triangle" || this._waveform === "sawtooth") {
      if (this._frequency <= 0) return null;
      const period = 1 / this._frequency;
      const halfPeriod = period / 2;
      const phaseShift = this._phase / (2 * Math.PI * this._frequency);

      // Per-period offsets of points where the waveform has a first-derivative
      // discontinuity (square: edge endpoints; triangle: valley + peak;
      // sawtooth: start of sharp fall + start of next rise).
      let offsets: number[];
      switch (this._waveform) {
        case "square":
          // ngspice PULSE: rising-edge start/end and falling-edge start/end.
          offsets = [0, this._riseTime, halfPeriod, halfPeriod + this._fallTime];
          break;
        case "triangle":
          // PULSE-aligned triangle (Fix 1): valley at tMod=0, peak at tMod=halfPeriod.
          offsets = [0, halfPeriod];
          break;
        case "sawtooth": {
          // PULSE-aligned sawtooth (Fix 2): start of fall at tMod=riseSpan,
          // end of fall / start of next rise at tMod=period (≡ 0 of next cycle).
          const riseSpan = period - this._fallTime;
          offsets = [riseSpan, period];
          break;
        }
      }

      // Start searching from the period that could contain afterTime.
      const nMin = Math.floor((afterTime + phaseShift) / period) - 1;

      let best: number | null = null;

      for (let n = nMin; n <= nMin + 2; n++) {
        const tPeriodStart = n * period - phaseShift;
        for (const offset of offsets) {
          const c = tPeriodStart + offset;
          if (c > afterTime + 1e-18) {
            if (best === null || c < best) {
              best = c;
            }
          }
        }
      }

      return best;
    }
    if (this._waveform === "noise") {
      // ngspice TRNOISE schedule (vsrcacct.c:209-224): samples land at integer
      // multiples of TS. The next sample strictly after `afterTime` is
      // (floor(afterTime/TS) + 1) * TS  works whether afterTime is exactly
      // n*TS (returns (n+1)*TS) or in between (returns next n*TS).
      if (this._noiseSampleTime <= 0) return null;
      return (Math.floor(afterTime / this._noiseSampleTime) + 1) * this._noiseSampleTime;
    }
    return null;
  }

  /**
   * Mirrors ngspice VSRCaccept (vsrcacct.c:24-310). Registers at most one
   * breakpoint per call, gated on:
   *   - CKTbreak (atBreakpoint flag)  non-boundary acceptances do nothing
   *   - SAMETIME(time, phase-boundary)  current CKTtime must sit on a
   *     phase boundary; the registration target is the NEXT phase boundary
   *
   * SAMETIME(a,b) := |a-b| <= 1e-7 * PW (vsrcacct.c:21). PW maps to
   * `halfPeriod - riseTime` for our square wave (matches load() math). For
   * triangle/sawtooth (digiTS-only waveforms with no ngspice analogue) we
   * apply the same SAMETIME pattern using each waveform's natural phase
   * boundaries; PW is taken as halfPeriod (triangle) or riseSpan (sawtooth)
   * so the tolerance scales with the local phase width.
   */
  acceptStep(
    simTime: number,
    addBreakpoint: (t: number) => void,
    atBreakpoint: boolean,
  ): void {
    // ngspice gates every CKTsetBreak inside VSRCaccept on CKTbreak.
    if (!atBreakpoint) return;

    // SINE / EXP / SFFM / AM-equivalent / expression: ngspice empty cases
    // (vsrcacct.c:147-165). No breakpoints to register.
    if (this._waveform === "sine" || this._waveform === "expression"
        || this._waveform === "am" || this._waveform === "fm" || this._waveform === "sweep") {
      return;
    }
    if (this._frequency <= 0) return;

    const period = 1 / this._frequency;
    const halfP = period / 2;
    const tshift = this._phase / (2 * Math.PI * this._frequency);

    if (this._waveform === "square") {
      // Direct port of vsrcacct.c:50-145 PULSE branch.
      // PW maps to halfPeriod - riseTime (consistent with load() math).
      const TR = this._riseTime;
      const TF = this._fallTime;
      const PW = Math.max(0, halfP - TR);
      const PER = period;
      const TIMETOL = 1e-7;
      const sametime = (a: number, b: number) => Math.abs(a - b) <= TIMETOL * PW;

      // ngspice: time = CKTtime - TD; tshift = TD. We use phase-derived tshift
      // (TD-equivalent for sinusoidal alignment); same algebra applies.
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
        // time in (TR + PW, TR + PW + TF)
        if (sametime(time, TR + PW)) {
          addBreakpoint(basetime + tshift + TR + PW + TF);
        } else if (sametime(time, TR + PW + TF)) {
          addBreakpoint(basetime + tshift + PER);
        }
      }
      return;
    }

    if (this._waveform === "triangle") {
      // digiTS extension (no ngspice analogue). Phase boundaries: tMod = 0
      // (valley) and tMod = halfP (peak). PW = halfP for SAMETIME scaling.
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
      // digiTS extension (no ngspice analogue). Phase boundaries:
      // tMod = riseSpan (start of sharp fall) and tMod = period (valley of
      // next cycle). PW = riseSpan for SAMETIME scaling (the dominant
      // phase width).
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
      // Direct port of vsrcacct.c:209-224 TRNOISE branch.
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

export function makeAcVoltageSourceElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  getTime: () => number,
): AcVoltageSourceAnalogElement {
  return new AcVoltageSourceAnalogImpl(pinNodes, props, getTime);
}

// ---------------------------------------------------------------------------
// AcVoltageSourceDefinition
// ---------------------------------------------------------------------------

export const AcVoltageSourceDefinition: StandaloneComponentDefinition = {
  name: "AcVoltageSource",
  typeId: -1,
  category: ComponentCategory.SOURCES,

  pinLayout: AC_VOLTAGE_SOURCE_PIN_LAYOUT,
  propertyDefs: AC_VOLTAGE_SOURCE_PROPERTY_DEFS,
  attributeMap: AC_VOLTAGE_SOURCE_ATTRIBUTE_MAP,

  helpText: "AC Voltage Source  time-varying voltage source with configurable waveform.",

  factory(props: PropertyBag): AcVoltageSourceElement {
    return new AcVoltageSourceElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: makeAcVoltageSourceElement,
      paramDefs: AC_VOLTAGE_SOURCE_PARAM_DEFS,
      params: AC_VOLTAGE_SOURCE_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
