/**
 * Auto-generates a SPICE netlist from a compiled analog circuit.
 *
 * Iterates compiled elements, uses element labels for SPICE instance names,
 * reads parameters from property bags, and emits SPICE element lines.
 * Emits model cards for semiconductors.
 */

import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import type { PropertyBag } from "../../../../core/properties.js";

// ---------------------------------------------------------------------------
// SPICE prefix table (typeId -> SPICE prefix, model type for semiconductors)
// ---------------------------------------------------------------------------

interface ElementSpec {
  prefix: string;
  modelType?: string;
}

const ELEMENT_SPECS: Record<string, ElementSpec> = {
  Resistor:        { prefix: "R" },
  Capacitor:       { prefix: "C" },
  Inductor:        { prefix: "L" },
  DcVoltageSource: { prefix: "V" },
  AcVoltageSource: { prefix: "V" },
  DcCurrentSource: { prefix: "I" },
  AcCurrentSource: { prefix: "I" },
  Diode:           { prefix: "D", modelType: "D" },
  Zener:           { prefix: "D", modelType: "D" },
  Varactor:        { prefix: "D", modelType: "D" },
  TunnelDiode:     { prefix: "D", modelType: "D" },
  NpnBJT:          { prefix: "Q", modelType: "NPN" },
  PnpBJT:          { prefix: "Q", modelType: "PNP" },
  NMOS:            { prefix: "M", modelType: "NMOS" },
  PMOS:            { prefix: "M", modelType: "PMOS" },
  NJFET:           { prefix: "J", modelType: "NMF" },
  PJFET:           { prefix: "J", modelType: "PMF" },
};

// ---------------------------------------------------------------------------
// generateSpiceNetlist
// ---------------------------------------------------------------------------

export function generateSpiceNetlist(
  compiled: ConcreteCompiledAnalogCircuit,
  elementLabels: Map<number, string>,
  title?: string,
): string {
  const lines: string[] = [];

  // Title line
  lines.push(title ?? "Auto-generated netlist");

  // Collect model cards: modelName -> ".model <name> <type> (<params>)"
  const modelCards = new Map<string, string>();

  // One element line per compiled element
  for (let i = 0; i < compiled.elements.length; i++) {
    const el = compiled.elements[i];
    const label = elementLabels.get(i) ?? `element_${i}`;
    const circuitEl = compiled.elementToCircuitElement.get(i);

    if (!circuitEl) continue;

    const typeId = circuitEl.typeId;
    const spec = ELEMENT_SPECS[typeId];
    if (!spec) continue;

    const props = circuitEl.getProperties();
    const nodes = el.pinNodeIds;

    let line: string;

    // elementLabels already include the SPICE prefix (e.g., "Q1", "R1"),
    // so we use label directly as the instance name.

    if (typeId === "Resistor") {
      const R = getPropNumber(props, "resistance", 1000);
      line = `${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${R}`;

    } else if (typeId === "Capacitor") {
      const C = getPropNumber(props, "capacitance", 1e-6);
      line = `${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${C}`;

    } else if (typeId === "Inductor") {
      const L = getPropNumber(props, "inductance", 1e-3);
      line = `${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${L}`;

    } else if (typeId === "DcVoltageSource") {
      const V = getPropNumber(props, "voltage", 0);
      // SPICE convention: Vname pos neg value; our pins are [neg, pos]
      line = `${label} ${nodes[1] ?? 0} ${nodes[0] ?? 0} DC ${V}`;

    } else if (typeId === "AcVoltageSource") {
      const amp   = getPropNumber(props, "amplitude", 1);
      const dc    = getPropNumber(props, "dcOffset", 0);
      const freq  = getPropNumber(props, "frequency", 1000);
      const phase = getPropNumber(props, "phase", 0);
      const waveform = props.has("waveform") ? props.get<string>("waveform") : "sine";
      // SPICE convention: Vname pos neg <transient-spec>; our pins are [neg, pos]
      const posNode = nodes[1] ?? 0;
      const negNode = nodes[0] ?? 0;
      line = `${label} ${posNode} ${negNode} ${buildAcSourceSpec(waveform, amp, dc, freq, phase, props)}`;

    } else if (typeId === "DcCurrentSource") {
      const I = getPropNumber(props, "current", 0);
      line = `${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} DC ${I}`;

    } else if (typeId === "AcCurrentSource") {
      const amp      = getPropNumber(props, "amplitude", 1);
      const dc       = getPropNumber(props, "dcOffset", 0);
      const freq     = getPropNumber(props, "frequency", 1000);
      const phase    = getPropNumber(props, "phase", 0);
      const waveform = props.has("waveform") ? props.get<string>("waveform") : "sine";
      // SPICE convention: Iname pos neg <transient-spec>; our pins are [neg, pos]
      // (same pin-order convention as DcCurrentSource: nodes[0]=neg, nodes[1]=pos)
      const posNode = nodes[1] ?? 0;
      const negNode = nodes[0] ?? 0;
      line = `${label} ${posNode} ${negNode} ${buildAcSourceSpec(waveform, amp, dc, freq, phase, props)}`;

    } else if (spec.prefix === "D") {
      const modelName = `${label}_${spec.modelType}`;
      line = `${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${modelName}`;
      if (!modelCards.has(modelName)) {
        modelCards.set(modelName, buildModelCard(modelName, spec.modelType!, props));
      }

    } else if (spec.prefix === "Q") {
      const modelName = `${label}_${spec.modelType}`;
      line = `${label} ${nodes[1] ?? 0} ${nodes[0] ?? 0} ${nodes[2] ?? 0} ${modelName}`;
      if (!modelCards.has(modelName)) {
        modelCards.set(modelName, buildModelCard(modelName, spec.modelType!, props));
      }

    } else if (spec.prefix === "M") {
      const modelName = `${label}_${spec.modelType}`;
      const W = getPropNumber(props, "W", 1e-6);
      const L = getPropNumber(props, "L", 1e-6);
      let d: number, g: number, s: number, b: number;
      if (typeId === "NMOS") {
        // Internal: [G, S, D] → emit D G S body (where body=source)
        d = nodes[2] ?? 0;
        g = nodes[0] ?? 0;
        s = nodes[1] ?? 0;
        b = nodes[1] ?? 0;
      } else if (typeId === "PMOS") {
        // Internal: [G, D, S] → emit D G S body (where body=source)
        d = nodes[1] ?? 0;
        g = nodes[0] ?? 0;
        s = nodes[2] ?? 0;
        b = nodes[2] ?? 0;
      } else {
        // Fallback for any other MOSFET variant
        d = nodes[0] ?? 0;
        g = nodes[1] ?? 0;
        s = nodes[2] ?? 0;
        b = nodes[3] ?? 0;
      }
      line = `${label} ${d} ${g} ${s} ${b} ${modelName} W=${W} L=${L}`;
      if (!modelCards.has(modelName)) {
        modelCards.set(modelName, buildModelCard(modelName, spec.modelType!, props));
      }

    } else if (spec.prefix === "J") {
      const modelName = `${label}_${spec.modelType}`;
      line = `${label} ${nodes[2] ?? 0} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${modelName}`;
      if (!modelCards.has(modelName)) {
        modelCards.set(modelName, buildModelCard(modelName, spec.modelType!, props));
      }

    } else {
      continue;
    }

    lines.push(line);
  }

  // Emit model cards
  for (const card of modelCards.values()) {
    lines.push(card);
  }

  lines.push(".end");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// AC source transient-spec builder (shared by AcVoltageSource and AcCurrentSource)
// ---------------------------------------------------------------------------

/**
 * Build a SPICE transient source specifier for AC sources (voltage or current)
 * so that ngspice drives the same time-varying waveform as our engine during
 * .tran analysis. The SPICE transient spec syntax is identical for V and I sources.
 *
 * Supported waveforms:
 *   sine     → SIN(VO VA FREQ TD THETA PHASE_DEG)
 *   square   → PULSE(V1 V2 TD TR TF PW PER)
 *   triangle → PULSE approximation (TR=TF=PW=period/3, see note below)
 *   sawtooth → PULSE approximation (TR≈period, TF≈0, PW≈0, see note below)
 *   sweep/am/fm/noise/expression → not representable in SPICE transient primitives;
 *              falls back to DC <dcOffset> with a warning comment.
 *   unknown  → DC <dcOffset> fallback.
 *
 * Square-wave note:
 *   Our engine uses ngspice PULSE semantics exactly: at t=0 (phase=0) value is V1 (LOW),
 *   the rising edge spans [0, TR], HIGH plateau is [TR, TR+PW], falling edge is
 *   [TR+PW, TR+PW+TF], then LOW until the next period. The PULSE(V1 V2 TD TR TF PW PER)
 *   emission is therefore exact — no approximation or sub-riseTime discrepancy.
 */
function buildAcSourceSpec(
  waveform: string,
  amp: number,
  dc: number,
  freq: number,
  phase: number,
  props: PropertyBag,
): string {
  const period = freq > 0 ? 1 / freq : 1;

  switch (waveform) {
    case "sine": {
      // Our engine: dc + amp * sin(2π * freq * t + phase)  [phase in radians]
      // SPICE SIN:  SIN(VO VA FREQ TD THETA PHASE_DEG)
      //   PHASE_DEG is phase in degrees (ngspice manual §4.1.2).
      const phaseDeg = phase * (180 / Math.PI);
      return `SIN(${dc} ${amp} ${freq} 0 0 ${phaseDeg})`;
    }

    case "square": {
      // Our engine (ngspice PULSE semantics, vsrcload.c):
      //   V1 = dc - amp (LOW), V2 = dc + amp (HIGH)
      //   Rising edge: [0, TR] within the period-local clock.
      //   HIGH plateau: [TR, TR+PW] where PW = period/2 - TR.
      //   Falling edge: [TR+PW, TR+PW+TF].
      //   LOW: rest of period.
      //
      // SPICE PULSE(V1 V2 TD TR TF PW PER):
      //   V1  = dc - amp
      //   V2  = dc + amp
      //   TD  = delay to first rising edge start in real time
      //         = ((-phaseShift) % period + period) % period
      //         (positive phase → waveform shifted left → rising edge earlier → larger TD wrap)
      //   TR  = riseTime
      //   TF  = fallTime
      //   PW  = period/2 - TR  (HIGH plateau, same as engine)
      //   PER = period
      const riseTime = getPropNumber(props, "riseTime", 1e-9);
      const fallTime = getPropNumber(props, "fallTime", 1e-9);
      const halfPeriod = period / 2;
      const phaseShift = freq > 0 ? phase / (2 * Math.PI * freq) : 0;
      // Rising edge starts at t = -phaseShift in the engine's unwrapped clock.
      // Wrap to [0, period) for SPICE PULSE TD.
      const td = ((-phaseShift % period) + period) % period;
      const pw = halfPeriod - riseTime;
      const v1 = dc - amp;
      const v2 = dc + amp;
      return `PULSE(${v1} ${v2} ${td} ${riseTime} ${fallTime} ${pw} ${period})`;
    }

    case "triangle": {
      // Our engine: dc + amp * (2/π) * arcsin(sin(2π*freq*t + phase))
      // This produces a triangle wave swinging ±amp around dc, with period=1/freq.
      // There is no exact SPICE primitive for this. We approximate with PULSE
      // using TR=TF=PW=period/3 which gives a triangular shape when PW≈0 is wrong,
      // so TR=TF=period/2, PW=0 gives a true triangle (rise half-period, fall half-period).
      // TODO: this is an approximation — triangle wave has no exact SPICE transient primitive.
      // The PULSE with TR=TF=halfPeriod, PW=0, TD=0 approximates our triangle for phase=0.
      const halfP = period / 2;
      const v1 = dc - amp;
      const v2 = dc + amp;
      return `PULSE(${v1} ${v2} 0 ${halfP} ${halfP} 0 ${period})`;
    }

    case "sawtooth": {
      // Our engine: dc + amp * 2 * (freq*t + phase/(2π) - floor(freq*t + phase/(2π) + 0.5))
      // This is a sawtooth swinging [dc-amp, dc+amp] with sharp fall at each period edge.
      // PULSE approximation: very fast fall (TF→0), full-period rise, PW→0.
      // TODO: this is an approximation — sawtooth has no exact SPICE transient primitive.
      // Using a small TF (1ps) to approximate the instantaneous fall edge.
      const tf = 1e-12; // 1 ps fall — negligible compared to any real sim period
      const v1 = dc - amp;
      const v2 = dc + amp;
      return `PULSE(${v1} ${v2} 0 ${period} ${tf} 0 ${period})`;
    }

    case "sweep":
    case "am":
    case "fm":
    case "noise":
    case "expression":
      // These waveforms cannot be represented as SPICE transient primitives.
      // Fall back to a flat DC source at dcOffset. The harness comparison will
      // be meaningless for these waveforms — the caller should not use the harness
      // for sweep/AM/FM/noise/expression sources without a custom SPICE deck.
      // TODO: sweep/am/fm/noise/expression waveforms are not representable in SPICE
      //       PULSE/SIN primitives. A .tran comparison against ngspice is not valid
      //       for these waveforms. A PWL (piecewise-linear) approximation could be
      //       generated for sweep, but that would require knowledge of the sim duration.
      return `DC ${dc}`;

    default:
      // Unrecognized waveform — fall back to flat DC.
      return `DC ${dc}`;
  }
}

// ---------------------------------------------------------------------------
// Model card builder
// ---------------------------------------------------------------------------

function buildModelCard(
  modelName: string,
  spiceModelType: string,
  props: PropertyBag,
): string {
  const paramKeys = props.getModelParamKeys();
  const paramParts: string[] = [];

  for (const key of paramKeys) {
    if (!isSpiceModelParam(key)) continue;
    const value = props.getModelParam<number>(key);
    if (typeof value === "number" && isFinite(value)) {
      paramParts.push(`${key}=${value}`);
    }
  }

  if (paramParts.length === 0) {
    return `.model ${modelName} ${spiceModelType}`;
  }
  return `.model ${modelName} ${spiceModelType} (${paramParts.join(" ")})`;
}

// ---------------------------------------------------------------------------
// Helper: read a numeric property from model params or regular bag
// ---------------------------------------------------------------------------

function getPropNumber(props: PropertyBag, key: string, defaultValue: number): number {
  if (props.hasModelParam(key)) {
    return props.getModelParam<number>(key);
  }
  if (props.has(key)) {
    return props.get<number>(key);
  }
  return defaultValue;
}

// ---------------------------------------------------------------------------
// Filter out non-SPICE model param keys
// ---------------------------------------------------------------------------

const NON_MODEL_KEYS = new Set([
  // UI / component metadata
  "label", "model", "waveform", "expression", "bits", "bitWidth",
  // Instance parameters (belong on the element line, not the .model card)
  "W", "L", "AREA", "M", "TNOM",
  // Zero-valued substrate doping is physically invalid in ngspice
  "NSUB", "NSS",
]);

function isSpiceModelParam(key: string): boolean {
  return !NON_MODEL_KEYS.has(key);
}
