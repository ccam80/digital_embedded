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
import type { AnalogElement, AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { parseExpression, evaluateExpression, ExprParseError } from "../../solver/analog/expression.js";
import type { ExprNode } from "../../solver/analog/expression.js";

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
 * Extended waveform parameters for sweep, AM, FM, and noise modes.
 */
export interface ExtendedWaveformParams {
  freqStart?: number;
  freqEnd?: number;
  sweepDuration?: number;
  sweepMode?: "linear" | "log";
  modulationFreq?: number;
  modulationDepth?: number;
  modulationIndex?: number;
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

    case "square":
      return dcOffset + amplitude * Math.sign(Math.sin(arg));

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
 * Return the times of square-wave transitions within [tStart, tEnd].
 *
 * A 1kHz square wave has transitions at 0, 0.5ms, 1ms, 1.5ms, ...
 * (half-period edges). Only times strictly inside (tStart, tEnd] are returned.
 *
 * @param frequency - Frequency in Hz
 * @param phase     - Phase offset in radians
 * @param tStart    - Interval start (exclusive) in seconds
 * @param tEnd      - Interval end (inclusive) in seconds
 */
export function squareWaveBreakpoints(
  frequency: number,
  phase: number,
  tStart: number,
  tEnd: number,
): number[] {
  if (frequency <= 0) return [];
  const halfPeriod = 1 / (2 * frequency);
  const phaseShift = phase / (2 * Math.PI * frequency);

  const breakpoints: number[] = [];

  // Transitions occur at t = n*halfPeriod - phaseShift for all integers n.
  // Find first n such that n*halfPeriod - phaseShift > tStart.
  // Include transitions strictly inside (tStart, tEnd) — both endpoints excluded.
  const nMin = Math.ceil((tStart + phaseShift) / halfPeriod);
  for (let n = nMin; ; n++) {
    const t = n * halfPeriod - phaseShift;
    if (t >= tEnd) break;
    if (t > tStart) {
      breakpoints.push(t);
    }
  }

  return breakpoints;
}

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

    // Lead from pos pin to body
    if (vPos !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vPos));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, 15 * PX, 0);

    // Lead from neg pin to body
    if (vNeg !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vNeg));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(49 * PX, 0, 4, 0);

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
    const amplitude = this._properties.getOrDefault<number>("amplitude", 5);
    const frequency = this._properties.getOrDefault<number>("frequency", 1000);
    const displayLabel = label.length > 0
      ? label
      : (this._shouldShowValue() ? `${formatSI(amplitude, "V")} ${formatSI(frequency, "Hz")}` : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    ctx.drawText(displayLabel, 2, 1.3, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }

  getHelpText(): string {
    return "AC Voltage Source — time-varying voltage source (sine, square, triangle, sawtooth).";
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const AC_VOLTAGE_SOURCE_PIN_LAYOUT: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "pos",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "neg",
    defaultBitWidth: 1,
    position: { x: 4, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const AC_VOLTAGE_SOURCE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "amplitude",
    type: PropertyType.INT,
    label: "Amplitude (V)",
    defaultValue: 5,
    description: "Peak amplitude in volts",
  },
  {
    key: "frequency",
    type: PropertyType.INT,
    label: "Frequency (Hz)",
    defaultValue: 1000,
    description: "Frequency in Hz",
  },
  {
    key: "phase",
    type: PropertyType.INT,
    label: "Phase (rad)",
    defaultValue: 0,
    description: "Phase offset in radians",
  },
  {
    key: "dcOffset",
    type: PropertyType.INT,
    label: "DC Offset (V)",
    defaultValue: 0,
    description: "DC offset added to waveform",
  },
  {
    key: "waveform",
    type: PropertyType.ENUM,
    label: "Waveform",
    defaultValue: "sine",
    enumValues: ["sine", "square", "triangle", "sawtooth", "expression", "sweep", "am", "fm", "noise"],
    description: "Waveform shape",
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
  { xmlName: "Amplitude", propertyKey: "amplitude", convert: (v) => parseFloat(v) },
  { xmlName: "Frequency", propertyKey: "frequency", convert: (v) => parseFloat(v) },
  { xmlName: "Phase",     propertyKey: "phase",     convert: (v) => parseFloat(v) },
  { xmlName: "DCOffset",  propertyKey: "dcOffset",  convert: (v) => parseFloat(v) },
  { xmlName: "Waveform",  propertyKey: "waveform",  convert: (v) => v },
  { xmlName: "Label",     propertyKey: "label",     convert: (v) => v },
];

// ---------------------------------------------------------------------------
// AcVoltageSourceAnalogElement — AnalogElement with time-varying stamp
// ---------------------------------------------------------------------------

export interface AcVoltageSourceAnalogElement extends AnalogElement {
  /** Returns transition times within [tStart, tEnd] for square waveforms. */
  getBreakpoints(tStart: number, tEnd: number): number[];
  /**
   * Parsed expression AST for expression waveform mode.
   * Null if waveform is not "expression" or if parsing failed.
   */
  _parsedExpr: ExprNode | null;
  /** Parse error message if expression parsing failed; null otherwise. */
  _parseError: string | null;
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
  const amplitude = props.getOrDefault<number>("amplitude", 5);
  const frequency = props.getOrDefault<number>("frequency", 1000);
  const phase = props.getOrDefault<number>("phase", 0);
  const dcOffset = props.getOrDefault<number>("dcOffset", 0);
  const waveform = props.getOrDefault<string>("waveform", "sine") as Waveform;
  const ext: ExtendedWaveformParams = {
    freqStart: props.getOrDefault<number>("freqStart", 100),
    freqEnd: props.getOrDefault<number>("freqEnd", 10000),
    sweepDuration: props.getOrDefault<number>("sweepDuration", 1),
    sweepMode: props.getOrDefault<string>("sweepMode", "linear") as "linear" | "log",
    modulationFreq: props.getOrDefault<number>("modulationFreq", 100),
    modulationDepth: props.getOrDefault<number>("modulationDepth", 1),
    modulationIndex: props.getOrDefault<number>("modulationIndex", 1),
  };

  let scale = 1;

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

    setSourceScale(factor: number): void {
      scale = factor;
    },

    stamp(solver: SparseSolver): void {
      const k = branchIdx;
      const t = getTime();

      let v: number;
      if (waveform === "expression") {
        if (element._parsedExpr !== null) {
          v = evaluateExpression(element._parsedExpr, { t }) * scale;
        } else {
          v = 0;
        }
      } else {
        v = computeWaveformValue(waveform, amplitude, frequency, phase, dcOffset, t, ext) * scale;
      }

      // B sub-matrix: node rows, branch column k
      if (nodePos !== 0) solver.stamp(nodePos - 1, k, 1);
      if (nodeNeg !== 0) solver.stamp(nodeNeg - 1, k, -1);

      // C sub-matrix: branch row k, node columns
      if (nodePos !== 0) solver.stamp(k, nodePos - 1, 1);
      if (nodeNeg !== 0) solver.stamp(k, nodeNeg - 1, -1);

      // RHS voltage constraint
      solver.stampRHS(k, v);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // MNA branch variable: voltages[branchIdx] = I flowing from nodeNeg
      // through source to nodePos. Convention for getPinCurrents: positive =
      // current from pin 0 → pin 1 through the element body (matching the
      // engine's getElementCurrent fallback [I, -I] at t=0, t=1).
      // Pin layout order: [pos, neg].
      const I = voltages[branchIdx];
      return [I, -I];
    },

    getBreakpoints(tStart: number, tEnd: number): number[] {
      if (waveform === "square") {
        return squareWaveBreakpoints(frequency, phase, tStart, tEnd);
      }
      if (waveform === "noise") {
        // Force timestep controller to sample at each interval so noise is uncorrelated.
        const dt = Math.min(1 / (20 * frequency), (tEnd - tStart));
        if (dt <= 0) return [];
        const pts: number[] = [];
        for (let t = tStart + dt; t < tEnd; t += dt) {
          pts.push(t);
        }
        return pts;
      }
      return [];
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

  models: {
    analog: {
      requiresBranchRow: true,
      factory(
        pinNodes: ReadonlyMap<string, number>,
        internalNodeIds: readonly number[],
        branchIdx: number,
        props: PropertyBag,
        getTime: () => number,
      ): AnalogElementCore {
        return createAcVoltageSourceElement(pinNodes, internalNodeIds, branchIdx, props, getTime);
      },
    },
  },
};
