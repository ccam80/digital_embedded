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
import { MODEDCOP, MODEDCTRANCURVE, MODETRANOP } from "../../solver/analog/ckt-mode.js";
import { parseExpression, evaluateExpression, ExprParseError } from "../../solver/analog/expression.js";
import type { ExprNode } from "../../solver/analog/expression.js";
import { defineModelParams } from "../../core/model-params.js";
import { almostEqualUlps } from "../../solver/analog/timestep.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import {
  type Waveform,
  type ExtendedWaveformParams,
  computeWaveformValue,
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
  private readonly _waveform: Waveform;
  private readonly _ext: ExtendedWaveformParams;
  private readonly _getTime: () => number;

  _parsedExpr: ExprNode | null;
  _parseError: string | null;

  // Captures srcFact from load() for getPinCurrents consistency between iterations.
  private _lastSrcFact = 1;

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
      // ISRC AC magnitude / phase defaults mirror ngspice srctemp.c (ISRCacMag = 1,
      // ISRCacPhase = 0 when an `AC` token is present without explicit values).
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

  setup(_ctx: SetupContext): void {
    // ISRC has no *set.c in ngspice. No TSTALLOC, no internal nodes,
    // no branch row, no state slots. Body is intentionally empty.
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
    const t = this._getTime();

    // srcFact gating mirrors isrcload.c. The same three-mode pattern as
    // AcVoltageSource: apply srcFact for MODEDCOP | MODEDCTRANCURVE | MODETRANOP.
    const ramp = (ctx.cktMode & (MODEDCOP | MODEDCTRANCURVE | MODETRANOP))
      ? ctx.srcFact
      : 1.0;
    this._lastSrcFact = ramp;

    let I: number;
    if (this._waveform === "expression") {
      if (this._parsedExpr !== null) {
        I = evaluateExpression(this._parsedExpr, { t }) * ramp;
      } else {
        I = 0;
      }
    } else {
      I = computeWaveformValue(this._waveform, this._amplitude, this._frequency, this._phase, this._dcOffset, t, this._ext) * ramp;
    }

    const nodePos = this.pinNodes.get("pos")!;
    const nodeNeg = this.pinNodes.get("neg")!;
    // isrcload.c:33-34: unconditional RHS stamp.
    stampRHS(ctx.rhs, nodePos,  I);
    stampRHS(ctx.rhs, nodeNeg, -I);
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
    // m is the parallel-multiplier (`m=...`); digiTS does not expose `m` for
    // sources, so m ≡ 1 — the stamp collapses to a single ± at each node.
    //
    // acReal / acImag derive from ISRCacMag / ISRCacPhase via the same
    // VSRCtemp formula (vsrctemp.c:68-70 — the ngspice ISRC code path
    // mirrors the V-source ac-token parser):
    //   acReal = mag · cos(phase · π / 180)
    //   acImag = mag · sin(phase · π / 180)
    const nodePos = this.pinNodes.get("pos")!;
    const nodeNeg = this.pinNodes.get("neg")!;
    const radians = this._acPhase * Math.PI / 180.0;
    const acReal = this._acMagnitude * Math.cos(radians);
    const acImag = this._acMagnitude * Math.sin(radians);
    rhsRe[nodePos] += acReal;
    rhsRe[nodeNeg] -= acReal;
    rhsIm[nodePos] += acImag;
    rhsIm[nodeNeg] -= acImag;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    // No branch row. Pin layout: [neg, pos].
    // Conventional current flows neg→pos through the source.
    const I = computeWaveformValue(
      this._waveform,
      this._amplitude, this._frequency, this._phase, this._dcOffset,
      this._getTime(), this._ext,
    ) * this._lastSrcFact;
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

  acceptStep(
    simTime: number,
    addBreakpoint: (t: number) => void,
    atBreakpoint: boolean,
  ): void {
    if (!atBreakpoint) return;
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
    },
  },
  defaultModel: "behavioral",
};
