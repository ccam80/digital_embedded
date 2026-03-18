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
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  noOpAnalogExecuteFn,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import { parseExpression, evaluateExpression, ExprParseError } from "../../analog/expression.js";
import type { ExprNode } from "../../analog/expression.js";

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
    return { x: this.position.x - 1, y: this.position.y - 1, width: 4, height: 2 };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(1, 0, 1, false);
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    ctx.drawText("~", 1, 0, { horizontal: "center", vertical: "center" });
    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.9 });
      ctx.drawText(label, 1, -1.2, { horizontal: "center", vertical: "bottom" });
    }
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
    position: { x: -2, y: 0 },
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
    type: PropertyType.STRING,
    label: "Waveform",
    defaultValue: "sine",
    description: "Waveform type: sine | square | triangle | sawtooth | sweep | am | fm | noise",
  },
  {
    key: "freqStart",
    type: PropertyType.INT,
    label: "Sweep Start Freq (Hz)",
    defaultValue: 100,
    description: "Start frequency for sweep waveform (Hz)",
  },
  {
    key: "freqEnd",
    type: PropertyType.INT,
    label: "Sweep End Freq (Hz)",
    defaultValue: 10000,
    description: "End frequency for sweep waveform (Hz)",
  },
  {
    key: "sweepDuration",
    type: PropertyType.INT,
    label: "Sweep Duration (s)",
    defaultValue: 1,
    description: "Duration of the frequency sweep in seconds",
  },
  {
    key: "sweepMode",
    type: PropertyType.STRING,
    label: "Sweep Mode",
    defaultValue: "linear",
    description: "Sweep interpolation: linear | log",
  },
  {
    key: "modulationFreq",
    type: PropertyType.INT,
    label: "Modulation Freq (Hz)",
    defaultValue: 100,
    description: "Modulation frequency for AM and FM waveforms (Hz)",
  },
  {
    key: "modulationDepth",
    type: PropertyType.INT,
    label: "Modulation Depth (0-1)",
    defaultValue: 1,
    description: "AM modulation depth (0 = no modulation, 1 = full AM)",
  },
  {
    key: "modulationIndex",
    type: PropertyType.INT,
    label: "Modulation Index (rad)",
    defaultValue: 1,
    description: "FM modulation index (peak phase deviation in radians)",
  },
  {
    key: "expression",
    type: PropertyType.STRING,
    label: "Expression",
    defaultValue: "sin(2 * pi * 1000 * t)",
    description: "Waveform expression with t as time variable (used when waveform=expression)",
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
  nodeIds: number[],
  branchIdx: number,
  props: PropertyBag,
  getTime: () => number,
): AcVoltageSourceAnalogElement {
  const nodePos = nodeIds[0];
  const nodeNeg = nodeIds[1];
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
    nodeIndices: [nodePos, nodeNeg],
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
  engineType: "analog",
  category: ComponentCategory.SOURCES,
  executeFn: noOpAnalogExecuteFn,
  requiresBranchRow: true,

  pinLayout: AC_VOLTAGE_SOURCE_PIN_LAYOUT,
  propertyDefs: AC_VOLTAGE_SOURCE_PROPERTY_DEFS,
  attributeMap: AC_VOLTAGE_SOURCE_ATTRIBUTE_MAP,

  helpText: "AC Voltage Source — time-varying voltage source with configurable waveform.",

  factory(props: PropertyBag): AcVoltageSourceElement {
    return new AcVoltageSourceElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  analogFactory(
    nodeIds: number[],
    branchIdx: number,
    props: PropertyBag,
    getTime: () => number,
  ): AnalogElement {
    return createAcVoltageSourceElement(nodeIds, branchIdx, props, getTime);
  },
};
