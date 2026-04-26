/**
 * Auto-generates a SPICE netlist from a compiled analog circuit.
 *
 * Iterates compiled elements, uses element labels for SPICE instance names,
 * reads parameters from property bags, and emits SPICE element lines.
 * Emits model cards for semiconductors.
 */

import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import type { PropertyBag } from "../../../../core/properties.js";
import { ComponentRegistry, type ParamDef } from "../../../../core/registry.js";

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
  ZenerDiode:      { prefix: "D", modelType: "D" },
  VaractorDiode:   { prefix: "D", modelType: "D" },
  TunnelDiode:     { prefix: "D", modelType: "D" },
  NpnBJT:          { prefix: "Q", modelType: "NPN" },
  PnpBJT:          { prefix: "Q", modelType: "PNP" },
  NMOS:            { prefix: "M", modelType: "NMOS" },
  PMOS:            { prefix: "M", modelType: "PMOS" },
  NJFET:           { prefix: "J", modelType: "NMF" },
  PJFET:           { prefix: "J", modelType: "PMF" },
};

// ---------------------------------------------------------------------------
// Per-device ngspice translation rules
// ---------------------------------------------------------------------------

interface DeviceNetlistRules {
  renames?: Record<string, string>;
  modelCardPrefix?: (props: PropertyBag) => string[];
  modelCardDropIfZero?: string[];
  /**
   * Boolean-flag instance params. ngspice expects bare keywords (e.g. `OFF`)
   * — emitting `OFF=0` produces a hard "unknown parameter (0)" parse error
   * because ngspice consumes the keyword and then chokes on the trailing
   * `=0`. Listed keys are emitted as bare uppercase keywords when their
   * value is truthy and dropped when zero/false.
   */
  instanceFlags?: string[];
  /**
   * Instance params to omit when their value equals the listed default. ngspice
   * has its own per-instance defaults (e.g. M=1, TEMP=$TNOM) and emitting them
   * is at best noise and at worst trips parse warnings.
   */
  instanceDropIfDefault?: Record<string, number>;
  /**
   * MOS-style initial-condition triplet. ngspice MOS1 accepts only the combined
   * form `IC=vds,vgs,vbs`; per-key `ICVDS=`/`ICVGS=`/`ICVBS=` are unrecognised
   * and trigger the same "unknown parameter (0)" hard error described above.
   * The listed keys are stripped from the standard instance suffix and, when
   * any of them is non-zero, re-emitted as a single `IC=v1,v2,v3` token in
   * canonical order (vds, vgs, vbs).
   */
  instanceCombineIC?: [string, string, string];
  /**
   * Model-card params that ngspice only accepts at LEVEL≥3 (tunnel-diode
   * extension). For plain Diode and TunnelDiode at LEVEL=1 these would emit
   * `Warning: unrecognized parameter (ibeq) - ignored` lines. Drop them
   * unless the modelCardPrefix has actually requested LEVEL=3.
   */
  modelCardDropUnlessTunnel?: string[];
  /**
   * Instance-partition params that have no ngspice counterpart at all. They
   * are diagnostic / topology hints internal to digiTS (e.g. BJT `SUBS`
   * vertical/lateral flag) and produce hard "unknown parameter" parse
   * errors when emitted on the SPICE instance line.
   */
  instanceDropAlways?: string[];
}

const REFTEMP = 300.15;

function tunnelLevel(props: PropertyBag): string[] {
  const ibeq = props.hasModelParam("IBEQ") ? props.getModelParam<number>("IBEQ") : 0;
  const ibsw = props.hasModelParam("IBSW") ? props.getModelParam<number>("IBSW") : 0;
  return (ibeq > 0 || ibsw > 0) ? ["LEVEL=3"] : [];
}

const DEVICE_NETLIST_RULES: Record<string, DeviceNetlistRules> = {
  Diode: {
    renames: { ISW: "JSW" },
    modelCardPrefix: tunnelLevel,
    instanceFlags: ["OFF"],
    instanceDropIfDefault: { TEMP: REFTEMP, AREA: 1, M: 1 },
    modelCardDropUnlessTunnel: ["IBEQ", "IBSW", "NB"],
  },
  ZenerDiode: {
    renames: { ISW: "JSW" },
    instanceFlags: ["OFF"],
    instanceDropIfDefault: { TEMP: REFTEMP, AREA: 1, M: 1 },
  },
  VaractorDiode: {
    renames: { ISW: "JSW" },
    instanceFlags: ["OFF"],
    instanceDropIfDefault: { TEMP: REFTEMP, AREA: 1, M: 1 },
  },
  TunnelDiode: {
    renames: { ISW: "JSW" },
    modelCardPrefix: tunnelLevel,
    instanceFlags: ["OFF"],
    instanceDropIfDefault: { TEMP: REFTEMP, AREA: 1, M: 1 },
    modelCardDropUnlessTunnel: ["IBEQ", "IBSW", "NB"],
  },
  NpnBJT: {
    instanceFlags: ["OFF"],
    instanceDropIfDefault: { TEMP: REFTEMP, AREA: 1, AREAB: 1, AREAC: 1, M: 1 },
    instanceDropAlways: ["SUBS"],
  },
  PnpBJT: {
    instanceFlags: ["OFF"],
    instanceDropIfDefault: { TEMP: REFTEMP, AREA: 1, AREAB: 1, AREAC: 1, M: 1 },
    instanceDropAlways: ["SUBS"],
  },
  NMOS: {
    modelCardDropIfZero: ["NSUB", "NSS"],
    instanceFlags: ["OFF"],
    instanceDropIfDefault: { TEMP: REFTEMP, M: 1, AD: 0, AS: 0, PD: 0, PS: 0 },
    instanceCombineIC: ["ICVDS", "ICVGS", "ICVBS"],
  },
  PMOS: {
    modelCardDropIfZero: ["NSUB", "NSS"],
    instanceFlags: ["OFF"],
    instanceDropIfDefault: { TEMP: REFTEMP, M: 1, AD: 0, AS: 0, PD: 0, PS: 0 },
    instanceCombineIC: ["ICVDS", "ICVGS", "ICVBS"],
  },
  NJFET: {
    instanceFlags: ["OFF"],
    instanceDropIfDefault: { TEMP: REFTEMP, AREA: 1, M: 1 },
  },
  PJFET: {
    instanceFlags: ["OFF"],
    instanceDropIfDefault: { TEMP: REFTEMP, AREA: 1, M: 1 },
  },
};

// ---------------------------------------------------------------------------
// generateSpiceNetlist
// ---------------------------------------------------------------------------

export function generateSpiceNetlist(
  compiled: ConcreteCompiledAnalogCircuit,
  registry: ComponentRegistry,
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

    let paramDefs: ParamDef[] = [];
    if (spec.modelType !== undefined) {
      const def = registry.get(typeId);
      if (!def) {
        throw new Error(`netlist-generator: typeId "${typeId}" not registered`);
      }
      const modelKey = props.has("model")
        ? props.get<string>("model")
        : (def.defaultModel ?? "");
      const modelEntry = def.modelRegistry?.[modelKey];
      if (!modelEntry) {
        throw new Error(`netlist-generator: typeId "${typeId}" has no modelRegistry["${modelKey}"]`);
      }
      paramDefs = modelEntry.paramDefs;
    }

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
      line = `${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${modelName}${instanceParamSuffix(paramDefs, props, typeId)}`;
      if (!modelCards.has(modelName)) {
        modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, typeId));
      }

    } else if (spec.prefix === "Q") {
      const modelName = `${label}_${spec.modelType}`;
      line = `${label} ${nodes[1] ?? 0} ${nodes[0] ?? 0} ${nodes[2] ?? 0} ${modelName}${instanceParamSuffix(paramDefs, props, typeId)}`;
      if (!modelCards.has(modelName)) {
        modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, typeId));
      }

    } else if (spec.prefix === "M") {
      const modelName = `${label}_${spec.modelType}`;
      let d: number, g: number, s: number, b: number;
      if (typeId === "NMOS") {
        d = nodes[2] ?? 0; g = nodes[0] ?? 0; s = nodes[1] ?? 0; b = nodes[1] ?? 0;
      } else if (typeId === "PMOS") {
        d = nodes[1] ?? 0; g = nodes[0] ?? 0; s = nodes[2] ?? 0; b = nodes[2] ?? 0;
      } else {
        throw new Error(`netlist-generator: unknown MOSFET typeId '${typeId}' — add an explicit pin-order branch`);
      }
      line = `${label} ${d} ${g} ${s} ${b} ${modelName}${instanceParamSuffix(paramDefs, props, typeId)}`;
      if (!modelCards.has(modelName)) {
        modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, typeId));
      }

    } else if (spec.prefix === "J") {
      const modelName = `${label}_${spec.modelType}`;
      line = `${label} ${nodes[2] ?? 0} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${modelName}${instanceParamSuffix(paramDefs, props, typeId)}`;
      if (!modelCards.has(modelName)) {
        modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, typeId));
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
// Instance-param suffix (element line)
// ---------------------------------------------------------------------------

function instanceParamSuffix(
  paramDefs: readonly ParamDef[],
  props: PropertyBag,
  typeId: string,
): string {
  const rules = DEVICE_NETLIST_RULES[typeId];
  const flagSet = new Set(rules?.instanceFlags ?? []);
  const dropAlways = new Set(rules?.instanceDropAlways ?? []);
  const dropDefaults = rules?.instanceDropIfDefault ?? {};
  const icKeys = rules?.instanceCombineIC;
  const icSet = new Set(icKeys ?? []);

  const parts: string[] = [];
  let icVds = 0, icVgs = 0, icVbs = 0, icAny = false;

  for (const def of paramDefs) {
    if (def.partition !== "instance") continue;
    if (!props.hasModelParam(def.key)) continue;
    if (dropAlways.has(def.key)) continue;
    const v = props.getModelParam<number>(def.key);
    if (typeof v !== "number" || !Number.isFinite(v)) continue;

    // Combined IC=vds,vgs,vbs handling — collect, do not emit individually.
    if (icSet.has(def.key)) {
      if (def.key === icKeys![0]) icVds = v;
      else if (def.key === icKeys![1]) icVgs = v;
      else if (def.key === icKeys![2]) icVbs = v;
      if (v !== 0) icAny = true;
      continue;
    }

    // Boolean flags — bare keyword if truthy, omit if zero/false.
    if (flagSet.has(def.key)) {
      if (v !== 0) parts.push(def.key);
      continue;
    }

    // Drop params that match an ngspice default to avoid noise / parse warnings.
    if (def.key in dropDefaults && v === dropDefaults[def.key]) continue;

    parts.push(`${def.key}=${v}`);
  }

  if (icKeys && icAny) {
    parts.push(`IC=${icVds},${icVgs},${icVbs}`);
  }

  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Model-card suffix (.model line)
// ---------------------------------------------------------------------------

function modelCardSuffix(
  modelName: string,
  spiceModelType: string,
  paramDefs: readonly ParamDef[],
  props: PropertyBag,
  typeId: string,
): string {
  const rules = DEVICE_NETLIST_RULES[typeId];
  const dropIfZero = new Set(rules?.modelCardDropIfZero ?? []);
  const dropUnlessTunnel = new Set(rules?.modelCardDropUnlessTunnel ?? []);
  const parts: string[] = [];

  // Prefix tokens (e.g. LEVEL=3) come first.
  const prefixTokens = rules?.modelCardPrefix ? rules.modelCardPrefix(props) : [];
  if (prefixTokens.length > 0) parts.push(...prefixTokens);
  const tunnelMode = prefixTokens.some(t => /^LEVEL\s*=\s*3$/i.test(t));

  for (const def of paramDefs) {
    if (def.partition === "instance") continue;
    if (!props.hasModelParam(def.key)) continue;
    const v = props.getModelParam<number>(def.key);
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (dropIfZero.has(def.key) && v === 0) continue;
    if (!tunnelMode && dropUnlessTunnel.has(def.key)) continue;
    const emittedKey = rules?.renames?.[def.key] ?? def.key;
    parts.push(`${emittedKey}=${v}`);
  }

  if (parts.length === 0) {
    return `.model ${modelName} ${spiceModelType}`;
  }
  return `.model ${modelName} ${spiceModelType} (${parts.join(" ")})`;
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
