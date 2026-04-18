/**
 * AC Voltage Source — time-varying independent voltage source.
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
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import { parseExpression, evaluateExpression, ExprParseError } from "../../solver/analog/expression.js";
import type { ExprNode } from "../../solver/analog/expression.js";
import { defineModelParams } from "../../core/model-params.js";

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
  /** Fall time for square wave transitions (seconds). Default 0 = instantaneous. */
  fallTime?: number;
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
      return dcOffset + amplitude * Math.sin(arg);

    case "square": {
      const riseTime = ext?.riseTime ?? 0;
      const fallTime = ext?.fallTime ?? 0;
      if (riseTime === 0 && fallTime === 0) {
        return dcOffset + amplitude * Math.sign(Math.sin(arg));
      }
      // Trapezoidal square wave — ngspice PULSE semantics (vsrcload.c).
      // V1 = dcOffset - amplitude (LOW), V2 = dcOffset + amplitude (HIGH)
      // Rising edge: [0, TR]; HIGH plateau: [TR, TR+PW]; falling edge: [TR+PW, TR+PW+TF]; LOW: rest.
      const period = frequency > 0 ? 1 / frequency : Infinity;
      const halfPeriod = period / 2;
      // Positive phase shifts waveform left (earlier) in time.
      const phaseShift = phase / (2 * Math.PI * frequency);
      const tShifted = t - phaseShift;
      // Position within the full period, always in [0, period).
      const tMod = ((tShifted % period) + period) % period;

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

    case "triangle":
      return dcOffset + amplitude * (2 / Math.PI) * Math.asin(Math.sin(arg));

    case "sawtooth": {
      const normalized = frequency * t + phase / (2 * Math.PI);
      return dcOffset + amplitude * 2 * (normalized - Math.floor(normalized + 0.5));
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
 *   t0 + 0      (start of rising edge — only useful when > tStart)
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
    riseTime: { default: 1e-9, unit: "s",   description: "Rise time for square wave transitions" },
    fallTime: { default: 1e-9, unit: "s",   description: "Fall time for square wave transitions" },
  },
});

// ---------------------------------------------------------------------------
// AcVoltageSourceElement — CircuitElement implementation
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
    // Leads: (0,0)→(15,0) and (49,0)→(64,0)
    // Circle: cx=32, cy=0, r=16.66 → cx=2gu, r=1.04125gu
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

    // Sine wave inside the circle — matches Falstad reference exactly
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
// AcVoltageSourceAnalogElement — AnalogElement with time-varying stamp
// ---------------------------------------------------------------------------

export interface AcVoltageSourceAnalogElement extends AnalogElementCore {
  /** Returns transition times within [tStart, tEnd] for square waveforms. */
  getBreakpoints(tStart: number, tEnd: number): number[];
  /** Returns the strictly-next breakpoint strictly after afterTime, or null. */
  nextBreakpoint(afterTime: number): number | null;
  /** Register a callback to be invoked when a setParam change invalidates the outstanding breakpoint. */
  registerRefreshCallback(cb: () => void): void;
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

function createAcVoltageSourceElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
  getTime: () => number,
): AcVoltageSourceAnalogElement {
  const nodePos = pinNodes.get("pos")!;
  const nodeNeg = pinNodes.get("neg")!;
  const p: Record<string, number> = {
    amplitude: props.getModelParam<number>("amplitude"),
    frequency: props.getModelParam<number>("frequency"),
    phase:     props.getModelParam<number>("phase"),
    dcOffset:  props.getModelParam<number>("dcOffset"),
    riseTime:  props.hasModelParam("riseTime") ? props.getModelParam<number>("riseTime") : 1e-9,
    fallTime:  props.hasModelParam("fallTime") ? props.getModelParam<number>("fallTime") : 1e-9,
  };
  let amplitude = p.amplitude;
  let frequency = p.frequency;
  let phase = p.phase;
  let dcOffset = p.dcOffset;
  let riseTime = p.riseTime;
  let fallTime = p.fallTime;
  let refreshCallback: (() => void) | null = null;
  const waveform = props.getOrDefault<string>("waveform", "sine") as Waveform;
  const ext: ExtendedWaveformParams = {
    freqStart: props.getOrDefault<number>("freqStart", 100),
    freqEnd: props.getOrDefault<number>("freqEnd", 10000),
    sweepDuration: props.getOrDefault<number>("sweepDuration", 1),
    sweepMode: props.getOrDefault<string>("sweepMode", "linear") as "linear" | "log",
    modulationFreq: props.getOrDefault<number>("modulationFreq", 100),
    modulationDepth: props.getOrDefault<number>("modulationDepth", 1),
    modulationIndex: props.getOrDefault<number>("modulationIndex", 1),
    riseTime,
    fallTime,
  };

  // Parse expression once at creation for expression waveform mode.
  let parsedExpr: ExprNode | null = null;
  let parseError: string | null = null;
  if (waveform === "expression") {
    const exprText = props.getOrDefault<string>("expression", "sin(2 * pi * 1000 * t)");
    try {
      parsedExpr = parseExpression(exprText);
    } catch (err) {
      parseError = err instanceof ExprParseError ? err.message : String(err);
    }
  }

  const element: AcVoltageSourceAnalogElement = {
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,

    _parsedExpr: parsedExpr,
    _parseError: parseError,

    setParam(key: string, value: number): void {
      if (key in p) {
        (p as Record<string, number>)[key] = value;
        amplitude = p.amplitude;
        frequency = p.frequency;
        phase = p.phase;
        dcOffset = p.dcOffset;
        riseTime = p.riseTime;
        fallTime = p.fallTime;
        ext.riseTime = riseTime;
        ext.fallTime = fallTime;
        if ((key === "frequency" || key === "phase") && refreshCallback !== null) {
          refreshCallback();
        }
      }
    },

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const k = branchIdx;
      const t = getTime();

      let v: number;
      if (waveform === "expression") {
        if (element._parsedExpr !== null) {
          v = evaluateExpression(element._parsedExpr, { t }) * ctx.srcFact;
        } else {
          v = 0;
        }
      } else {
        v = computeWaveformValue(waveform, amplitude, frequency, phase, dcOffset, t, ext) * ctx.srcFact;
      }

      // B sub-matrix: node rows, branch column k
      if (nodePos !== 0) solver.stampElement(solver.allocElement(nodePos - 1, k), 1);
      if (nodeNeg !== 0) solver.stampElement(solver.allocElement(nodeNeg - 1, k), -1);

      // C sub-matrix: branch row k, node columns
      if (nodePos !== 0) solver.stampElement(solver.allocElement(k, nodePos - 1), 1);
      if (nodeNeg !== 0) solver.stampElement(solver.allocElement(k, nodeNeg - 1), -1);

      // RHS voltage constraint (ctx.srcFact folded in above).
      solver.stampRHS(k, v);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // MNA branch variable: voltages[branchIdx] = I flowing from nodeNeg
      // through source to nodePos.
      // Pin layout order: [neg, pos].
      // "Into element at neg" = -I (current exits neg into external circuit).
      // "Into element at pos" = +I (current enters pos from external circuit).
      const I = voltages[branchIdx];
      return [-I, I];
    },

    nextBreakpoint(afterTime: number): number | null {
      if (waveform === "square") {
        const period = 1 / frequency;
        const halfPeriod = period / 2;
        const phaseShift = phase / (2 * Math.PI * frequency);

        // Under ngspice PULSE semantics, the breakpoints within period n
        // (starting at n*period - phaseShift) are at offsets:
        //   0, riseTime, halfPeriod, halfPeriod + fallTime
        const offsets = [0, riseTime, halfPeriod, halfPeriod + fallTime];

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
      if (waveform === "noise") {
        return afterTime + 1 / (20 * frequency);
      }
      return null;
    },

    registerRefreshCallback(cb: () => void): void {
      refreshCallback = cb;
    },

    acceptStep(simTime: number, addBreakpoint: (t: number) => void): void {
      const next = element.nextBreakpoint(simTime);
      if (next !== null) {
        addBreakpoint(next);
      }
    },

    getBreakpoints(tStart: number, tEnd: number): number[] {
      const out: number[] = [];
      let t = tStart;
      while (true) {
        const next = element.nextBreakpoint(t);
        if (next === null || next >= tEnd) break;
        if (next <= t) {
          throw new Error(`nextBreakpoint returned non-monotonic value: ${next} <= ${t}`);
        }
        out.push(next);
        t = next;
      }
      return out;
    },
  };

  return element;
}

// ---------------------------------------------------------------------------
// AcVoltageSourceDefinition
// ---------------------------------------------------------------------------

export const AcVoltageSourceDefinition: ComponentDefinition = {
  name: "AcVoltageSource",
  typeId: -1,
  category: ComponentCategory.SOURCES,

  pinLayout: AC_VOLTAGE_SOURCE_PIN_LAYOUT,
  propertyDefs: AC_VOLTAGE_SOURCE_PROPERTY_DEFS,
  attributeMap: AC_VOLTAGE_SOURCE_ATTRIBUTE_MAP,

  helpText: "AC Voltage Source — time-varying voltage source with configurable waveform.",

  factory(props: PropertyBag): AcVoltageSourceElement {
    return new AcVoltageSourceElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory(
        pinNodes: ReadonlyMap<string, number>,
        internalNodeIds: readonly number[],
        branchIdx: number,
        props: PropertyBag,
        getTime: () => number,
      ): AnalogElementCore {
        return createAcVoltageSourceElement(pinNodes, internalNodeIds, branchIdx, props, getTime);
      },
      paramDefs: AC_VOLTAGE_SOURCE_PARAM_DEFS,
      params: AC_VOLTAGE_SOURCE_DEFAULTS,
      branchCount: 1,
    },
  },
  defaultModel: "behavioral",
};
