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
    const rawLabel = elementLabels.get(i) ?? `element_${i}`;
    const circuitEl = compiled.elementToCircuitElement.get(i);

    if (!circuitEl) continue;

    const typeId = circuitEl.typeId;
    const spec = ELEMENT_SPECS[typeId];
    if (!spec) continue;

    const props = circuitEl.getProperties();
    const nodes = el.pinNodeIds;

    let line: string;

    // SPICE infers the element type from the first letter of the instance name.
    // User-authored labels (e.g. "Vc" for a capacitor, "Vs" for a voltage source,
    // "r1" vs "R1") may not start with the correct SPICE prefix for their type —
    // emitting them verbatim silently reinterprets the device on the ngspice side
    // (a capacitor labeled "Vc" becomes a voltage source in ngspice). When the
    // label's first letter (case-insensitive) does not match the required SPICE
    // prefix, prepend the prefix so ngspice parses the element as the correct type.
    const requiredPrefix = spec.prefix.toUpperCase();
    const label = rawLabel.charAt(0).toUpperCase() === requiredPrefix
      ? rawLabel
      : `${requiredPrefix}${rawLabel}`;

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
        throw new Error(`netlist-generator: unknown MOSFET typeId '${typeId}' — add an explicit pin-order branch`);
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
 * Supported waveforms (all exact — no approximations):
 *   sine     → SIN(VO VA FREQ TD THETA PHASE_DEG)
 *   square   → PULSE(V1 V2 TD TR TF PW PER)
 *   triangle → PULSE(V1 V2 TD halfPeriod halfPeriod 0 PER)
 *   sawtooth → PULSE(V1 V2 TD (period-fallTime) fallTime 0 PER)
 *
 * Rejected waveforms (throw): sweep, am, fm, noise, expression — none of these
 * are representable as a SPICE transient primitive. A .tran parity comparison
 * against ngspice is not valid for these; callers must author a custom SPICE
 * deck (e.g. PWL) if they need a ngspice counterpart.
 *
 * Square-wave note:
 *   Our engine uses ngspice PULSE semantics exactly: at t=0 (phase=0) value is V1 (LOW),
 *   the rising edge spans [0, TR], HIGH plateau is [TR, TR+PW], falling edge is
 *   [TR+PW, TR+PW+TF], then LOW until the next period. The PULSE(V1 V2 TD TR TF PW PER)
 *   emission is therefore exact — no approximation or sub-riseTime discrepancy.
 *
 * Triangle-wave note:
 *   After the -π/2 phase alignment in computeWaveformValue, at t=0 (phase=0) our
 *   triangle sits at V1 = dc - amp and rises linearly to V2 over the first half
 *   period, then falls linearly back to V1 over the second half. SPICE PULSE with
 *   TR=TF=halfPeriod and PW=0 reproduces this exactly (the rising edge is the
 *   rise half-period, the falling edge is the fall half-period, zero plateau).
 *   Non-zero phase is encoded via TD just like the square case.
 *
 * Sawtooth note:
 *   Our engine rises linearly from V1 to V2 over (period - fallTime) and falls
 *   linearly from V2 back to V1 over fallTime. SPICE PULSE with TR=(period-fallTime),
 *   TF=fallTime, PW=0 reproduces this exactly. Non-zero phase is encoded via TD.
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
      const riseTime = getPropNumber(props, "riseTime", 1e-12);
      const fallTime = getPropNumber(props, "fallTime", 1e-12);
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
      // PULSE-aligned triangle (see ac-voltage-source.ts computeWaveformValue):
      // rises V1 → V2 over halfPeriod, then falls V2 → V1 over halfPeriod.
      // At t=0 (phase=0) the wave sits at V1 rising. Non-zero phase shifts the
      // waveform left in time by phase/(2π*freq); encode that as a positive TD
      // wrapped into [0, period) just like the square case.
      const halfP = period / 2;
      const phaseShift = freq > 0 ? phase / (2 * Math.PI * freq) : 0;
      const td = ((-phaseShift % period) + period) % period;
      const v1 = dc - amp;
      const v2 = dc + amp;
      return `PULSE(${v1} ${v2} ${td} ${halfP} ${halfP} 0 ${period})`;
    }

    case "sawtooth": {
      // PULSE-aligned sawtooth (see ac-voltage-source.ts computeWaveformValue):
      // rises V1 → V2 over (period - fallTime), then falls V2 → V1 over fallTime.
      // At t=0 (phase=0) the wave sits at V1 rising. Default fallTime = 1 ps so
      // the sharp fall is below typical transient timesteps while remaining
      // losslessly encodable in PULSE.
      const fallTime = getPropNumber(props, "fallTime", 1e-12);
      if (fallTime >= period) {
        throw new Error(
          `sawtooth fallTime (${fallTime}s) must be strictly less than period (${period}s)`,
        );
      }
      const riseSpan = period - fallTime;
      const phaseShift = freq > 0 ? phase / (2 * Math.PI * freq) : 0;
      const td = ((-phaseShift % period) + period) % period;
      const v1 = dc - amp;
      const v2 = dc + amp;
      return `PULSE(${v1} ${v2} ${td} ${riseSpan} ${fallTime} 0 ${period})`;
    }

    case "sweep":
    case "am":
    case "fm":
    case "noise":
    case "expression":
      throw new Error(
        `SPICE transient parity is not valid for waveform "${waveform}". ` +
        `Sweep/AM/FM/noise/expression sources have no exact SPICE transient primitive — ` +
        `author a custom SPICE deck (e.g. PWL) if you need a ngspice counterpart.`,
      );

    default:
      throw new Error(`Unrecognized AC source waveform: "${waveform}"`);
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
