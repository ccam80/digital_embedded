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
import { MODEDC, MODEDCOP, MODEDCTRANCURVE, MODETRANOP } from "../../solver/analog/ckt-mode.js";
import { parseExpression, evaluateExpression, ExprParseError } from "../../solver/analog/expression.js";
import type { ExprNode } from "../../solver/analog/expression.js";
import { defineModelParams } from "../../core/model-params.js";
import { almostEqualUlps } from "../../solver/analog/timestep.js";

// ---------------------------------------------------------------------------
// Waveform computation
// ---------------------------------------------------------------------------

export type Waveform = "sine" | "square" | "triangle" | "sawtooth" | "expression" | "sweep" | "am" | "fm" | "noise";

// ---------------------------------------------------------------------------
// ngspice independent-source function-type model (vsrcdefs.h / vsrcload.c)
// ---------------------------------------------------------------------------

/**
 * Independent-source function-type codes (vsrcdefs.h:131-145), shared with the
 * current source. The numeric values are load-bearing: applyCoeffs() stores
 * them in `_functionType` and computeWaveformValue() dispatches on them. EXTERNAL
 * (vsrcdefs.h:140) is the `#ifdef SHARED_MODULE` embedded-host callback; it is
 * declared for header value-parity but has no load() body (digiTS has no
 * shared-module host). The RFSPICE `PORT` code (vsrcdefs.h:141-144) is out of
 * scope and absent.
 */
export enum FunctionType {
  PULSE = 1,
  SINE = 2,
  EXP = 3,
  SFFM = 4,
  PWL = 5,
  AM = 6,
  TRNOISE = 7,
  TRRANDOM = 8,
  EXTERNAL = 9,
}

/**
 * Deterministic transient-noise generator state (ngspice `struct trnoise_state`,
 * frontend 1-f-code.c). Constructed by `trnoise_state_init` and sampled by
 * `trnoise_state_get` in the `maths-misc#recon/randnumb` reconstruction. The
 * TRNOISE load() arm (vsrcload.c:356-398) interpolates two consecutive samples
 * around floor(time/TS), adds the RTS step when RTSAM>0, and adds the DC value.
 */
export interface TrnoiseState {
  /** Noise sample period TS (vsrcload.c:360). */
  TS: number;
  /** RTS noise amplitude (vsrcload.c:361). */
  RTSAM: number;
  /** RTS trap capture time (vsrcload.c:389). */
  RTScapTime: number;
  /** time==0 reset latch for repeated tran commands (vsrcload.c:365-371). */
  timezero: boolean;
  /** 1/f synthesizer running index, reset on the time=0→time>0 jump (vsrcload.c:369). */
  top: number;
}

/**
 * Deterministic transient-random generator state (ngspice `struct trrandom_state`).
 * Constructed by `trrandom_state_init`; its `value` is refreshed each accepted
 * step by `trrandom_state_get` in acceptStep (vsrcacct.c:303) and read by the
 * TRRANDOM load() arm (vsrcload.c:402). Both live in the
 * `maths-misc#recon/randnumb` reconstruction.
 */
export interface TrrandomState {
  /** Time step TS (vsrcacct.c:283). */
  TS: number;
  /** Initial delay TD (vsrcacct.c:284). */
  TD: number;
  /** Most-recently scheduled random value (vsrcacct.c:303, vsrcload.c:402). */
  value: number;
}

/**
 * Parse a SPICE function-token coefficient vector from a property value. The
 * vector arrives either as a `number[]` (programmatic build) or a
 * whitespace/comma-separated string (`"1 2 3"` / `"1,2,3"`), mirroring how a
 * `PULSE(...)` token's parenthesised list is captured at parse time. Returns a
 * flat numeric array suitable for applyCoeffs / copy_coeffs (vsrcpar.c:17-29).
 */
export function parseCoeffVector(raw: number[] | string): number[] {
  if (Array.isArray(raw)) return raw.slice();
  return raw
    .split(/[\s,]+/)
    .filter((s) => s.length > 0)
    .map((s) => parseFloat(s));
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

// ---------------------------------------------------------------------------
// ngspice coefficient-model waveform engine (rebuild of VSRCload's switch)
// ---------------------------------------------------------------------------

/**
 * Per-evaluation engine-step context for the ngspice coefficient model. Carries
 * the circuit-global transient constants the order-guard defaults read
 * (ckt->CKTstep, ckt->CKTfinalTime) plus the source's DC value/flag for the
 * noise arms (vsrcload.c:394-405).
 */
export interface WaveformStepContext {
  /** ckt->CKTstep — analysis TSTEP; PULSE TR/TF and EXP TD1/TAU1 default to it. */
  cktStep: number;
  /** ckt->CKTfinalTime — stop time; PULSE PW/PER and SINE/SFFM/AM FREQ default off it. */
  cktFinalTime: number;
  /** here->VSRCdcValue — added to TRNOISE/TRRANDOM output when dcGiven. */
  dcValue: number;
  /** here->VSRCdcGiven flag (vsrcload.c:395, 404). */
  dcGiven: boolean;
  /** here->VSRCtrnoise_state — deterministic noise generator (maths-misc#recon/randnumb). */
  trnoiseState: TrnoiseState | null;
  /** here->VSRCtrrandom_state — deterministic random generator (maths-misc#recon/randnumb). */
  trrandomState: TrrandomState | null;
  /** here->VSRCrdelay — pwl delay period `td=` (vsrcload.c:304). */
  rdelay: number;
  /** here->VSRCrGiven — pwl repeat flag (vsrcload.c:316). */
  rGiven: boolean;
  /** here->VSRCrBreakpt — pwl repeat start-coefficient index (vsrcload.c:320-323). */
  rBreakpt: number;
}

/**
 * Evaluate the ngspice independent-source waveform at `time` from the flat
 * coefficient array, exactly mirroring the `switch(here->VSRCfunctionType)` of
 * vsrcload.c:90-425. `time` is `ckt->CKTtime` in transient (0 under MODEDC).
 * The arms read `coeffs[i]` by index with `order` (VSRCfunctionOrder) guards,
 * bit-for-bit against the cited ngspice lines.
 */
export function evaluateNgspiceWaveform(
  functionType: FunctionType,
  coeffs: Float64Array,
  order: number,
  time: number,
  ctx: WaveformStepContext,
): number {
  let value = 0.0;
  switch (functionType) {
    default:
      // vsrcload.c:92-94 — no function type set: DC value.
      value = ctx.dcValue;
      break;

    case FunctionType.PULSE: {
      // vsrcload.c:104-119 — V1 V2 TD TR TF PW PER with order/zero guards.
      const V1 = coeffs[0];
      const V2 = coeffs[1];
      const TD = order > 2 ? coeffs[2] : 0.0;
      const TR = order > 3 && coeffs[3] !== 0.0 ? coeffs[3] : ctx.cktStep;
      const TF = order > 4 && coeffs[4] !== 0.0 ? coeffs[4] : ctx.cktStep;
      const PW = order > 5 && coeffs[5] !== 0.0 ? coeffs[5] : ctx.cktFinalTime;
      const PER = order > 6 && coeffs[6] !== 0.0 ? coeffs[6] : ctx.cktFinalTime;
      // vsrcload.c:122 — shift time by delay TD.
      let tt = time - TD;
      // vsrcload.c:124-139 — 8th coeff is the pulse-count cap (the newcompat.xs
      // phase-normalization branch, vsrcload.c:127-136, is a blocked v41 hunk;
      // the baseline takes the PHASE>0 ⇒ pulse-count path, vsrcload.c:137-139).
      const PHASE = order > 7 ? coeffs[7] : 0.0;
      let tmax = 1e99;
      if (PHASE > 0.0) tmax = PHASE * PER;
      if (tt > tmax) {
        // vsrcload.c:141-143 — past the pulse-count cap: hold V1.
        value = V1;
      } else {
        // vsrcload.c:145-150 — fold a repeating signal into one period.
        if (tt > PER) tt -= PER * Math.floor(tt / PER);
        // vsrcload.c:151-162 — piecewise V1 / rise / V2 / fall.
        if (tt <= 0 || tt >= TR + PW + TF) value = V1;
        else if (tt >= TR && tt <= TR + PW) value = V2;
        else if (tt > 0 && tt < TR) value = V1 + (V2 - V1) * tt / TR;
        else value = V2 + (V1 - V2) * (tt - (TR + PW)) / TF;
      }
      break;
    }

    case FunctionType.SINE: {
      // vsrcload.c:173-187 — VO VA FREQ TD THETA PHASE; FREQ defaults to 1/finalTime.
      const PHASE = order > 5 ? coeffs[5] : 0.0;
      const phase = PHASE * Math.PI / 180.0;            // vsrcload.c:177
      const VO = coeffs[0];
      const VA = coeffs[1];
      const FREQ = order > 2 && coeffs[2] !== 0.0 ? coeffs[2] : (1 / ctx.cktFinalTime);
      const TD = order > 3 ? coeffs[3] : 0.0;
      const THETA = order > 4 ? coeffs[4] : 0.0;
      const tt = time - TD;                              // vsrcload.c:189
      if (tt <= 0) {
        value = VO + VA * Math.sin(phase);               // vsrcload.c:191
      } else {
        // vsrcload.c:193-194 — operand order FREQ*time*2π+phase is load-bearing
        // (non-associative f64 multiply): 1 ULP here propagates through sin.
        value = VO + VA * Math.sin(FREQ * tt * 2.0 * Math.PI + phase) * Math.exp(-tt * THETA);
      }
      break;
    }

    case FunctionType.EXP: {
      // vsrcload.c:202-215 — V1 V2 TD1 TAU1 TD2 TAU2 with CKTstep defaults.
      const V1 = coeffs[0];
      const V2 = coeffs[1];
      const TD1 = order > 2 && coeffs[2] !== 0.0 ? coeffs[2] : ctx.cktStep;
      const TAU1 = order > 3 && coeffs[3] !== 0.0 ? coeffs[3] : ctx.cktStep;
      const TD2 = order > 4 && coeffs[4] !== 0.0 ? coeffs[4] : TD1 + ctx.cktStep;
      const TAU2 = order > 5 && coeffs[5] ? coeffs[5] : ctx.cktStep;
      // vsrcload.c:217-224 — two-stage charge/discharge exponential.
      if (time <= TD1) value = V1;
      else if (time <= TD2) value = V1 + (V2 - V1) * (1 - Math.exp(-(time - TD1) / TAU1));
      else value = V1 + (V2 - V1) * (1 - Math.exp(-(time - TD1) / TAU1))
                      + (V1 - V2) * (1 - Math.exp(-(time - TD2) / TAU2));
      break;
    }

    case FunctionType.SFFM: {
      // vsrcload.c:235-253 — VO VA FC MDI FS PHASEC PHASES; FC/FS default 1/finalTime.
      const PHASEC = order > 5 ? coeffs[5] : 0.0;
      const PHASES = order > 6 ? coeffs[6] : 0.0;
      const phasec = PHASEC * Math.PI / 180.0;
      const phases = PHASES * Math.PI / 180.0;
      const VO = coeffs[0];
      const VA = coeffs[1];
      const FC = order > 2 && coeffs[2] ? coeffs[2] : (1 / ctx.cktFinalTime);
      const MDI = order > 3 ? coeffs[3] : 0.0;
      const FS = order > 4 && coeffs[4] ? coeffs[4] : (1 / ctx.cktFinalTime);
      // vsrcload.c:256-258 — carrier modulated by sin of the modulating tone.
      value = VO + VA * Math.sin((2.0 * Math.PI * FC * time + phasec)
                  + MDI * Math.sin(2.0 * Math.PI * FS * time + phases));
      break;
    }

    case FunctionType.AM: {
      // vsrcload.c:269-287 — VA VO MF FC TD PHASEC PHASES; MF defaults 1/finalTime.
      const PHASES = order > 6 ? coeffs[6] : 0.0;
      const phases = PHASES * Math.PI / 180.0;
      const VA = coeffs[0];
      const VO = coeffs[1];
      const MF = order > 2 && coeffs[2] ? coeffs[2] : (1 / ctx.cktFinalTime);
      const FC = order > 3 ? coeffs[3] : 0.0;
      const TD = order > 4 && coeffs[4] ? coeffs[4] : 0.0;
      const tt = time - TD;
      if (tt <= 0) {
        value = 0;
      } else {
        // vsrcload.c:294-295 — both factors read `phases` (ngspice uses it twice).
        value = VA * (VO + Math.sin(2.0 * Math.PI * MF * tt + phases))
                   * Math.sin(2.0 * Math.PI * FC * tt + phases);
      }
      break;
    }

    case FunctionType.PWL: {
      // vsrcload.c:304-309 — delay, then clamp to the first value before the first knot.
      let tt = time - ctx.rdelay;
      if (tt < coeffs[0]) { value = coeffs[1]; break; }
      // vsrcload.c:311-329 — past the last knot: repeat (rGiven) or hold final value.
      const endTime = coeffs[order - 2];
      if (tt > endTime) {
        if (ctx.rGiven) {
          // vsrcload.c:319-323 — fold into the repeat window [rBreakpt, end_time].
          const period = endTime - coeffs[ctx.rBreakpt];
          tt -= coeffs[ctx.rBreakpt];
          tt -= period * Math.floor(tt / period);
          tt += coeffs[ctx.rBreakpt];
        } else {
          // vsrcload.c:324-328 — hold the final value.
          value = coeffs[order - 1];
          break;
        }
      }
      // vsrcload.c:331-343 — linear interpolation within the bracketing pair.
      for (let i = 2; i < order; i += 2) {
        const itime = coeffs[i];
        if (itime >= tt) {
          tt -= coeffs[i - 2];
          tt /= coeffs[i] - coeffs[i - 2];
          value = coeffs[i - 1];
          value += tt * (coeffs[i + 1] - coeffs[i - 1]);
          break;
        }
      }
      break;
    }

    case FunctionType.TRNOISE:
    case FunctionType.TRRANDOM:
      // vsrcload.c:356-407 — the TRNOISE/TRRANDOM value arms consume the
      // deterministic generators (trnoise_state_get / state->value) from
      // maths-misc#recon/randnumb, which has not landed in this worktree. The
      // structural state (TrnoiseState / TrrandomState, the _functionType, the
      // switch shell) is in place; the value evaluation is blocked on that RNG
      // reconstruction. See ESCALATIONS.md.
      throw new Error(
        "TRNOISE/TRRANDOM waveform evaluation requires the deterministic RNG "
        + "substrate from maths-misc#recon/randnumb (trnoise_state_get / "
        + "trrandom_state_get), which is not present in this worktree.",
      );
  }
  return value;
}

/**
 * Re-express a digiTS editor-facing waveform enum on the ngspice coefficient
 * engine (criterion #11). `square` / `triangle` / `sawtooth` map onto a PULSE
 * coefficient vector and `sine` onto a SINE vector, so the verified
 * `evaluateNgspiceWaveform` switch is the SINGLE evaluation path for these
 * waveforms — they have no `computeWaveformValue` arm. Returning
 * `null` means the waveform has no ngspice VSRCfunctionType counterpart
 * (`sweep` / `am` / `fm`) or is owned by another device path (`expression` →
 * ASRC, `noise` → deterministic TRNOISE) and stays on the extension/throw path.
 *
 * The coefficient math mirrors ngspice PULSE / SIN semantics (vsrcload.c):
 *   square   → PULSE(V1 V2 TD TR TF PW PER)   V1=dc−amp (LOW start), V2=dc+amp
 *   triangle → PULSE(V1 V2 TD halfP halfP 0 PER)
 *   sawtooth → PULSE(V1 V2 TD (PER−TF) TF 0 PER)
 *   sine     → SINE(VO VA FREQ 0 0 PHASE_DEG)
 * TD is the phase-derived delay `wrap(-phaseShift, PER)` so a positive phase
 * shifts the waveform left in time, identical to the harness deck emitter.
 *
 * @returns the (functionType, coeffs) pair, or null when the enum has no
 *   ngspice counterpart and must drive the digiTS-native extension path.
 */
export function enumWaveformCoeffs(
  waveform: Waveform,
  amplitude: number,
  frequency: number,
  phase: number,
  dcOffset: number,
  riseTime: number,
  fallTime: number,
): { functionType: FunctionType; coeffs: number[] } | null {
  const period = frequency > 0 ? 1 / frequency : Infinity;
  const halfPeriod = period / 2;
  const phaseShift = frequency > 0 ? phase / (2 * Math.PI * frequency) : 0;
  // Wrap the phase-derived delay into [0, PER) — vsrcload.c TD semantics.
  const td = Number.isFinite(period) ? (((-phaseShift % period) + period) % period) : 0;
  const V1 = dcOffset - amplitude; // PULSE LOW level (ngspice starts at V1).
  const V2 = dcOffset + amplitude; // PULSE HIGH level.

  switch (waveform) {
    case "sine": {
      // vsrcload.c:173-194 — VO VA FREQ TD THETA PHASE; phase in degrees.
      const phaseDeg = phase * (180 / Math.PI);
      return { functionType: FunctionType.SINE, coeffs: [dcOffset, amplitude, frequency, 0, 0, phaseDeg] };
    }
    case "square": {
      // PULSE(V1 V2 TD TR TF PW PER): PW = halfPeriod − TR (HIGH plateau).
      const pw = halfPeriod - riseTime;
      return { functionType: FunctionType.PULSE, coeffs: [V1, V2, td, riseTime, fallTime, pw, period] };
    }
    case "triangle": {
      // PULSE(V1 V2 TD halfP halfP 0 PER): symmetric rise/fall, zero plateau.
      return { functionType: FunctionType.PULSE, coeffs: [V1, V2, td, halfPeriod, halfPeriod, 0, period] };
    }
    case "sawtooth": {
      // PULSE(V1 V2 TD (PER−TF) TF 0 PER): linear rise then sharp fall.
      if (fallTime >= period) {
        throw new Error(
          `sawtooth fallTime (${fallTime}s) must be strictly less than period (${period}s)`,
        );
      }
      const riseSpan = period - fallTime;
      return { functionType: FunctionType.PULSE, coeffs: [V1, V2, td, riseSpan, fallTime, 0, period] };
    }
    default:
      // sweep / am / fm — digiTS-only extension; expression / noise — other paths.
      return null;
  }
}

/**
 * Compute instantaneous extension-waveform value at time t.
 *
 * The ngspice coefficient model (PULSE / SINE / EXP / SFFM / AM / PWL /
 * TRNOISE / TRRANDOM) is evaluated by `evaluateNgspiceWaveform`. This function
 * carries the digiTS-only waveforms layered over that core (#16 §2,
 * IN-class additive-behavior rule): `sweep` / `fm` have no ngspice
 * VSRCfunctionType counterpart, and `am` is the digiTS-native named-parameter
 * form (a `.dig` file may set it directly, distinct from the SPICE-token AM
 * path). The `square` / `triangle` / `sawtooth` / `sine` enums are re-expressed
 * onto the coefficient engine via `enumWaveformCoeffs` and evaluated by
 * `evaluateNgspiceWaveform` — they no longer have a `computeWaveformValue` arm.
 * `noise` is removed (replaced by the deterministic TRNOISE arm).
 *
 * @param waveform  - Waveform type
 * @param amplitude - Peak amplitude in volts
 * @param frequency - Carrier frequency in Hz (also used as center/base frequency)
 * @param phase     - Phase offset in radians
 * @param dcOffset  - DC offset added to waveform output
 * @param t         - Simulation time in seconds
 * @param ext       - Extended parameters for sweep/AM/FM modes
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
    case "square":
    case "triangle":
    case "sawtooth":
      // Re-expressed onto the ngspice coefficient engine (criterion #11): the
      // element builds a PULSE/SINE coefficient vector via enumWaveformCoeffs
      // and evaluates it through evaluateNgspiceWaveform. computeWaveformValue
      // has no arm for these — reaching here means the element failed to route
      // the enum onto the coefficient path.
      throw new Error(
        `Waveform '${waveform}' is evaluated through the ngspice coefficient `
        + `engine (enumWaveformCoeffs + evaluateNgspiceWaveform), not the `
        + `extension engine.`,
      );

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
      // The live-Math.random() Box-Muller `noise` arm is removed (#16 §3): noise
      // is the deterministic ngspice TRNOISE function type, evaluated by
      // evaluateNgspiceWaveform from the seeded generator (maths-misc#recon/randnumb).
      // The element routes a `noise` waveform onto _functionType = TRNOISE, so the
      // extension engine never sees it.
      throw new Error(
        "noise waveform is evaluated through the deterministic TRNOISE function "
        + "type (evaluateNgspiceWaveform), not the extension engine.",
      );

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
    // SPICE function token (vsrcpar.c:79-286): PULSE / SINE / EXP / SFFM / AM /
    // PWL / TRNOISE / TRRANDOM. When set, the coefficient model drives the
    // waveform from `coeffs`; when empty, the digiTS-native named-parameter
    // waveform above drives evaluation.
    key: "funcType",
    type: PropertyType.STRING,
    label: "SPICE Function",
    defaultValue: "",
    description: "ngspice independent-source function token (PULSE/SINE/EXP/SFFM/AM/PWL/TRNOISE/TRRANDOM)",
  },
  {
    // Flat coefficient vector for the SPICE function token (vsrcdefs.h:54,
    // copy_coeffs vsrcpar.c:17-29). Whitespace/comma-separated list.
    key: "coeffs",
    type: PropertyType.STRING,
    label: "SPICE Coefficients",
    defaultValue: "",
    description: "Coefficient vector for the SPICE function token (e.g. \"0 5 1u 1n 1n 5u 10u\")",
  },
  {
    key: "td",
    type: PropertyType.STRING,
    label: "PWL Delay",
    defaultValue: "",
    description: "PWL delay period td= (vsrcpar.c:120-122)",
  },
  {
    key: "r",
    type: PropertyType.STRING,
    label: "PWL Repeat",
    defaultValue: "",
    description: "PWL repeat start time r= (vsrcpar.c:124-161); -1 disables, 0 repeats from 0",
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
  // SPICE function token + coefficient model (vsrcpar.c:79-286).
  { xmlName: "FuncType",  propertyKey: "funcType",  convert: (v) => v },
  { xmlName: "Coeffs",    propertyKey: "coeffs",    convert: (v) => v },
  { xmlName: "TD",        propertyKey: "td",        convert: (v) => v },
  { xmlName: "R",         propertyKey: "r",         convert: (v) => v },
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

  // ngspice independent-source waveform model (sVSRCinstance, vsrcdefs.h:50-93).
  // _functionType is null when no SPICE function token is given (the
  // digiTS-native named-parameter extension path drives the waveform instead).
  private _functionType: FunctionType | null = null;   // VSRCfunctionType (vsrcdefs.h:50)
  private _functionOrder = 0;                            // VSRCfunctionOrder (vsrcdefs.h:51)
  private _coeffs: Float64Array = new Float64Array(0);   // VSRCcoeffs (vsrcdefs.h:54)
  private _funcTGiven = false;                           // VSRCfuncTGiven (vsrcdefs.h:88)
  private _rdelay = 0;                                   // VSRCrdelay (vsrcdefs.h:73)
  private _r = 0;                                        // VSRCr (vsrcdefs.h:72)
  private _rGiven = false;                               // VSRCrGiven (vsrcdefs.h:93)
  private _rBreakpt = 0;                                 // VSRCrBreakpt (vsrcdefs.h:52)
  private _dcValue = 0;                                  // VSRCdcValue (vsrcdefs.h:56)
  private _dcGiven = false;                              // VSRCdcGiven (vsrcdefs.h:84)
  private _trnoiseState: TrnoiseState | null = null;     // VSRCtrnoise_state (vsrcdefs.h:69)
  private _trrandomState: TrrandomState | null = null;   // VSRCtrrandom_state (vsrcdefs.h:70)
  // VSRCbreak_time (vsrcdefs.h:53) — time of the most-recent scheduled
  // breakpoint. Seeded to -1.0 in setup() (vsrcset.c:34).
  private _breakTime = -1.0;

  // Circuit-global transient constants captured from LoadContext during load()
  // (ckt->CKTstep / ckt->CKTfinalTime / ckt->CKTminBreak). acceptStep() and
  // getPinCurrents() receive no LoadContext, so the most-recent load() values
  // are reused there (the constants are run-invariant; only minBreak is read by
  // acceptStep's back-off, sourced from the same TimestepController.minBreak
  // that syncs ctx.minBreak per load-context.ts).
  private _cktStep = 0;
  private _cktFinalTime = 0;
  private _minBreak = 0;

  // True when the coefficient model was derived from the editor-facing waveform
  // enum (square/triangle/sawtooth/sine) rather than an explicit SPICE funcType
  // token. Enum-derived coefficients are re-built from named params on every
  // hot-loadable setParam (criterion #11); explicit-token coefficients are not.
  private _enumDerivedCoeffs = false;

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
      riseTime:  props.getModelParam<number>("riseTime"),
      fallTime:  props.getModelParam<number>("fallTime"),
      noiseSampleTime: props.getModelParam<number>("noiseSampleTime"),
      // vsrctemp.c:39, 42 — VSRCacMag defaults to 1 and VSRCacPhase to 0; the
      // paramDefs defaults supply those when an `AC` token has no explicit values.
      acMagnitude: props.getModelParam<number>("acMagnitude"),
      acPhase:     props.getModelParam<number>("acPhase"),
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

    // vsrcpar.c:42-45 — VSRC_DC: the source DC value / flag. digiTS folds the DC
    // value into dcOffset; VSRCdcGiven (vsrcdefs.h:84) is the parse-time *given*
    // flag — true only when the user explicitly set dcOffset, so the
    // TRNOISE/TRRANDOM arms add it only then (vsrcload.c:395, 404).
    this._dcValue = this._dcOffset;
    this._dcGiven = props.isModelParamGiven("dcOffset");

    // vsrcpar.c:79-286 — a SPICE-style function token (PULSE/SINE/EXP/SFFM/AM/
    // PWL/TRNOISE/TRRANDOM) populates the coefficient model via applyCoeffs.
    // The token + coefficient vector arrive through the property bag (`funcType`
    // + `coeffs`); when absent, _functionType stays null and the digiTS-native
    // named-parameter waveform drives evaluation through the extension engine.
    this._initCoeffModel(props);

    // vsrctemp.c:44-67 — value-presence + DC-vs-transient-time-0 notices. Runs
    // on the as-parsed VSRCdcGiven / VSRCfuncTGiven, before the function-token
    // dcGiven clearing below (which is a digiTS stamp-path concern, not part of
    // VSRCtemp).
    this._checkTime0DcConsistency();

    // A transient function token bakes the offset into its own coefficients
    // (SINE VO; PULSE V1/V2 = dcOffset ∓ amplitude — see enumWaveformCoeffs), so
    // the emitted ngspice card carries no separate `DC` token and VSRCdcGiven is
    // false. Match it: with a function present the MODEDCOP/MODEDCTRANCURVE
    // DC-value short-circuit (vsrcload.c:74-82) must NOT fire — the operating
    // point comes from sampling the function at time 0 (vsrcload.c:84-88), which
    // is PULSE V1 (= dcOffset − amplitude) for square/triangle/sawtooth and VO
    // for sine, not the bare dcOffset.
    if (this._funcTGiven) {
      this._dcGiven = false;
    }

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

  /**
   * VSRCtemp value-presence and time-0 consistency notices (vsrctemp.c:44-67).
   * When neither a DC value nor a transient function type is given, ngspice
   * emits an ERR_INFO notice that DC 0 is assumed. Otherwise, when both a DC
   * value and a transient function type are given (and the type is not
   * TRNOISE / TRRANDOM / EXTERNAL), the DC value seeds the .OP while the
   * transient waveform starts from its time-0 value; ngspice emits an ERR_INFO
   * notice when the two differ by more than 3 ULPs. AM and PWL read the time-0
   * value from VSRCcoeffs[1]; all other function types from VSRCcoeffs[0]. Both
   * branches are diagnostic only — they change no numeric value.
   */
  private _checkTime0DcConsistency(): void {
    if (!this._dcGiven && !this._funcTGiven) {
      // vsrctemp.c:44-49 — no DC value, no transient value.
      // eslint-disable-next-line no-console
      console.warn(`${this.label}: has no value, DC 0 assumed`);
    } else if (this._dcGiven && this._funcTGiven
        && this._functionType !== FunctionType.TRNOISE
        && this._functionType !== FunctionType.TRRANDOM
        && this._functionType !== FunctionType.EXTERNAL) {
      // vsrctemp.c:57-60 — AM and PWL take coeffs[1]; all others coeffs[0].
      const time0value = (this._functionType === FunctionType.AM
                       || this._functionType === FunctionType.PWL)
        ? this._coeffs[1] : this._coeffs[0];
      // vsrctemp.c:62-66 — 3-ULP AlmostEqualUlps tolerance on the notice gate.
      if (!almostEqualUlps(time0value, this._dcValue, 3)) {
        // eslint-disable-next-line no-console
        console.warn(`${this.label}: dc value used for op instead of transient time=0 value.`);
      }
    }
  }

  /**
   * Read a SPICE function token + coefficient vector from the property bag and
   * route it into the ngspice coefficient model (rebuild of VSRCparam,
   * vsrcpar.c:79-286). The function token (`funcType`) names the
   * VSRCfunctionType; `coeffs` is its flat coefficient vector; `td`/`r` carry
   * the PWL delay (vsrcpar.c:120-122) and repeat (vsrcpar.c:124-161). When no
   * `funcType` is present the coefficient model stays unset.
   */
  private _initCoeffModel(props: PropertyBag): void {
    const tokenRaw = props.getOrDefault<string>("funcType", "");
    const token = tokenRaw.trim().toUpperCase();
    if (token === "") {
      // Criterion #11: no SPICE function token, but the editor-facing waveform
      // enum (square/triangle/sawtooth/sine) drives off the ngspice coefficient
      // engine — build its PULSE/SINE coefficient vector so the single
      // evaluateNgspiceWaveform path serves these waveforms. sweep/am/fm/
      // expression/noise return null and stay on the extension/other paths.
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
        // vsrcpar.c:110-116 — non-increasing PWL time-point diagnostic.
        for (let i = 0; i < (this._functionOrder / 2) - 1; i++) {
          if (this._coeffs[2 * (i + 1)] <= this._coeffs[2 * i]) {
            // eslint-disable-next-line no-console
            console.warn(`Warning : voltage source ${this.label} has non-increasing PWL time points.`);
          }
        }
        break;
      case "SFFM":  this.applyCoeffs(FunctionType.SFFM, coeffs); break;
      case "AM":    this.applyCoeffs(FunctionType.AM, coeffs); break;
      case "TRNOISE":
      case "TRRANDOM":
        // vsrcpar.c:221-286 — the TRNOISE/TRRANDOM cases construct the
        // deterministic generator state via trnoise_state_init /
        // trrandom_state_init, which live in maths-misc#recon/randnumb (not
        // present in this worktree). The coefficient array + function type are
        // applied here; the generator construction is blocked on that recon.
        this.applyCoeffs(token === "TRNOISE" ? FunctionType.TRNOISE : FunctionType.TRRANDOM, coeffs);
        throw new Error(
          `${token} voltage source requires the deterministic RNG substrate from `
          + `maths-misc#recon/randnumb (trnoise_state_init / trrandom_state_init), `
          + `which is not present in this worktree.`,
        );
      default:
        throw new Error(`Unrecognized VSRC function token '${tokenRaw}'.`);
    }

    // vsrcpar.c:120-122 — VSRC_TD: pwl delay period.
    const tdRaw = props.getOrDefault<string>("td", "").trim();
    if (tdRaw !== "") this._rdelay = parseFloat(tdRaw);
    // vsrcpar.c:124-161 — VSRC_R: pwl repeat coefficient + breakpoint scan.
    const rRaw = props.getOrDefault<string>("r", "").trim();
    if (rRaw !== "") this._applyRepeat(parseFloat(rRaw));
  }

  /**
   * Rebuild of copy_coeffs (vsrcpar.c:17-29): store the coefficient vector, set
   * the function type + order, and mark the function-type-given flag. The
   * coefficient array is a Float64Array (ngspice's flat `double *VSRCcoeffs`),
   * so reading _coeffs[i] reproduces VSRCcoeffs[i] bit-for-bit. Hot-loadable:
   * the next load() reads the rewritten array (MEMORY.md hot-loadable-params).
   */
  applyCoeffs(fnType: FunctionType, vec: readonly number[]): void {
    this._functionType = fnType;
    this._funcTGiven = true;
    this._coeffs = Float64Array.from(vec);
    this._functionOrder = vec.length;
  }

  /**
   * Re-express the editor-facing waveform enum (square/triangle/sawtooth/sine)
   * onto the ngspice coefficient engine (criterion #11). Called when no SPICE
   * `funcType` token is given: builds the PULSE/SINE coefficient vector from the
   * current named params via enumWaveformCoeffs and applies it, so the verified
   * evaluateNgspiceWaveform switch is the single evaluation path for these
   * waveforms. The digiTS-only extension waveforms (sweep/am/fm) and the
   * other-path waveforms (expression/noise) return null and leave the
   * coefficient model unset (the extension engine / throw arms handle them).
   * Re-derived on every hot-loadable setParam so the coefficient array tracks
   * live amplitude/frequency/phase/rise/fall mutations (MEMORY.md
   * hot-loadable-params).
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
      // No ngspice counterpart: clear the coefficient model so the
      // extension / throw path drives evaluation.
      this._functionType = null;
      this._funcTGiven = false;
      this._coeffs = new Float64Array(0);
      this._functionOrder = 0;
      return;
    }
    this.applyCoeffs(built.functionType, built.coeffs);
  }

  /**
   * Rebuild of VSRC_R (vsrcpar.c:124-161): apply the pwl repeat coefficient.
   * r < -0.5 disables repeat; otherwise scan for the matching breakpoint index
   * and validate against the final time point.
   */
  private _applyRepeat(r: number): void {
    // vsrcpar.c:130-133 — r < -0.5: no repetition.
    if (r < -0.5) { this._rGiven = false; return; }
    // vsrcpar.c:136-139 — buggy input guard: r is not a repetition coefficient.
    if (this._coeffs.length === 0 || this._functionOrder < 2) { this._rGiven = false; return; }

    this._r = r;
    this._rGiven = true;

    // vsrcpar.c:144-147 — find the breakpoint index whose time equals r.
    for (let i = 0; i < this._functionOrder; i += 2) {
      this._rBreakpt = i;
      if (this._r === this._coeffs[i]) break;
    }

    // vsrcpar.c:149-153 — r must be smaller than the final time point.
    const endTime = this._coeffs[this._functionOrder - 2];
    if (this._r >= endTime) {
      throw new Error(
        `ERROR: repeat start time value ${this._r} for pwl voltage source must be `
        + `smaller than final time point given!`,
      );
    }
    // vsrcpar.c:155-158 — r must match one of the given time points.
    if (this._r !== this._coeffs[this._rBreakpt]) {
      throw new Error(
        `ERROR: repeat start time value ${this._r} for pwl voltage source does not `
        + `match any time point given!`,
      );
    }
  }

  /** Build the per-evaluation engine-step context for evaluateNgspiceWaveform. */
  private _stepContext(): WaveformStepContext {
    return {
      cktStep: this._cktStep,
      cktFinalTime: this._cktFinalTime,
      dcValue: this._dcValue,
      dcGiven: this._dcGiven,
      trnoiseState: this._trnoiseState,
      trrandomState: this._trrandomState,
      rdelay: this._rdelay,
      rGiven: this._rGiven,
      rBreakpt: this._rBreakpt,
    };
  }

  setup(ctx: SetupContext): void {
    // vsrcset.c:34 — seed the most-recent-breakpoint time so the first accepted
    // step schedules from t=0 (the gate `CKTtime >= VSRCbreak_time` passes at t=0).
    this._breakTime = -1.0;

    const posNode    = this.pinNodes.get("pos")!;
    const negNode    = this.pinNodes.get("neg")!;

    // vsrcset.c:35-39 — VSRCposNode == VSRCnegNode → ERR_FATAL "instance %s is a
    // shorted VSRC", then return(E_UNSUPP) so the degenerate instance never
    // reaches branch allocation / TSTALLOC. The ERR_FATAL + early-return maps to
    // a thrown Error (the digiTS fatal stop); the message text is the v41 wording.
    if (posNode === negNode) {
      throw new Error(`instance ${this.label ?? "vsrc"} is a shorted VSRC`);
    }

    // Port of vsrcset.c:41-44- idempotent branch allocation
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
      // vsrcpar.c:42-44 — keep VSRCdcValue in sync (hot-loadable DC value).
      this._dcValue = this._dcOffset;
      this._dcGiven = true;
      // Criterion #11 hot-loadability: when the waveform enum drives the
      // coefficient engine, re-build the PULSE/SINE coefficients from the
      // mutated named params so the next load() reads coefficients consistent
      // with the new amplitude/frequency/phase/rise/fall.
      if (this._enumDerivedCoeffs) this._deriveEnumCoeffs();
      // A baked-offset function carries no separate `DC` token (VSRCdcGiven
      // false); keep the .op short-circuit disabled so the operating point
      // samples the function at time 0 (vsrcload.c:74-88).
      if (this._funcTGiven) this._dcGiven = false;
    }
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    const t = this._getTime();

    // Capture the circuit-global transient constants for acceptStep() /
    // getPinCurrents(), which receive no LoadContext. CKTstep / CKTfinalTime are
    // run-invariant; minBreak comes from the same TimestepController.minBreak
    // that syncs ctx.minBreak (load-context.ts:128-134).
    this._cktStep = ctx.cktStep;
    this._cktFinalTime = ctx.cktFinalTime;
    this._minBreak = ctx.minBreak;

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

    const v = this._evaluate(ctx.cktMode, t) * ramp;

    // vsrcload.c:43-46
    solver.stampElement(this._hPosBr, +1.0);
    solver.stampElement(this._hNegBr, -1.0);
    solver.stampElement(this._hBrPos, +1.0);
    solver.stampElement(this._hBrNeg, -1.0);
    // vsrcload.c:416- RHS
    ctx.rhs[this.branchIndex] += v;
  }

  /**
   * Source value at the current time, before the srcFact ramp. Mirrors the
   * vsrcload.c branch structure: the DC-value short-circuit (vsrcload.c:74-82)
   * under MODEDCOP|MODEDCTRANCURVE with dcGiven, the MODEDC time=0 gate
   * (vsrcload.c:84-88), then either the ngspice coefficient switch
   * (evaluateNgspiceWaveform) when a SPICE function token is given, or the
   * digiTS-native named-parameter extension engine (computeWaveformValue).
   */
  private _evaluate(cktMode: number, t: number): number {
    // vsrcload.c:74-82 — DC-value branch: short-circuit when in a DC-op /
    // DC-transfer-curve solve with a DC value present.
    if ((cktMode & (MODEDCOP | MODEDCTRANCURVE)) && this._dcGiven && this._funcTGiven) {
      return this._dcValue;
    }
    // vsrcload.c:84-88 — under MODEDC the waveform is sampled at time 0.
    const time = (cktMode & MODEDC) ? 0 : t;

    if (this._funcTGiven && this._functionType !== null) {
      // ngspice coefficient model (PULSE/SINE/EXP/SFFM/AM/PWL/TRNOISE/TRRANDOM).
      return evaluateNgspiceWaveform(this._functionType, this._coeffs, this._functionOrder, time, this._stepContext());
    }
    // digiTS-native named-parameter extension path.
    if (this._waveform === "expression") {
      return this._parsedExpr !== null ? evaluateExpression(this._parsedExpr, { t: time }) : 0;
    }
    return computeWaveformValue(this._waveform, this._amplitude, this._frequency, this._phase, this._dcOffset, time, this._ext);
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
   * ngspice VSRCaccept for the coefficient model (vsrcacct.c:42-306), re-rooted
   * on _breakTime + _coeffs[]. The newcompat.xs phase-normalization branch
   * (vsrcacct.c:79-87) and the TRNOISE RTS capture/emission breaks
   * (vsrcacct.c:239-277) are deferred v41 hunks and are not part of this
   * baseline. addBreakpoint(t) is the CKTsetBreak surrogate; minBreak is the
   * captured CKTminBreak back-off (vsrcacct.c:136).
   */
  private _acceptNgspice(simTime: number, addBreakpoint: (t: number) => void): void {
    const coeffs = this._coeffs;
    const order = this._functionOrder;
    switch (this._functionType) {
      default:
        // vsrcacct.c:44-46 — DC: no breakpoints.
        break;

      case FunctionType.PULSE: {
        // vsrcacct.c:59-74 — TD/TR/TF/PW/PER/PHASE with CKTstep/CKTfinalTime defaults.
        const TD = order > 2 ? coeffs[2] : 0.0;
        const TR = order > 3 && coeffs[3] !== 0.0 ? coeffs[3] : this._cktStep;
        const TF = order > 4 && coeffs[4] !== 0.0 ? coeffs[4] : this._cktStep;
        const PW = order > 5 && coeffs[5] !== 0.0 ? coeffs[5] : this._cktFinalTime;
        const PER = order > 6 && coeffs[6] !== 0.0 ? coeffs[6] : this._cktFinalTime;
        const PHASE = order > 7 ? coeffs[7] : 0.0;

        // vsrcacct.c:77 — offset time by delay.
        let time = simTime - TD;

        // vsrcacct.c:88-92 — PHASE>0 pulse-count cap (newcompat.xs branch deferred).
        if (PHASE > 0.0) {
          const tmax = PHASE * PER;
          if (time > tmax) break;
        }

        // vsrcacct.c:94 — gate on the most-recent scheduled break time.
        if (simTime >= this._breakTime) {
          // vsrcacct.c:97-102 — repeating signal: where in the period are we?
          if (time >= PER) {
            const basetime = PER * Math.floor(time / PER);
            time -= basetime;
          }

          // vsrcacct.c:104-125 — compute the wait to the next phase boundary.
          let wait: number;
          if (time < 0.0) wait = -time;
          else if (time < TR) wait = TR - time;
          else if (time < TR + PW) wait = TR + PW - time;
          else if (time < TR + PW + TF) wait = TR + PW + TF - time;
          else wait = PER - time;

          // vsrcacct.c:126-129 — schedule and store the next break.
          this._breakTime = simTime + wait;
          addBreakpoint(this._breakTime);
          // vsrcacct.c:131-136 — back off by CKTminBreak so a step ending just
          // before the target still triggers the following schedule.
          this._breakTime -= this._minBreak;
        }
        break;
      }

      case FunctionType.SINE:
      case FunctionType.EXP:
      case FunctionType.SFFM:
      case FunctionType.AM:
        // vsrcacct.c:141-159 — no breakpoints.
        break;

      case FunctionType.PWL:
        // vsrcacct.c:162-201 — gated on _breakTime; schedule the next knot.
        if (simTime >= this._breakTime) {
          let time = simTime - this._rdelay;
          const end = coeffs[order - 2];
          if (time > end) {
            if (this._rGiven) {
              // vsrcacct.c:173-179 — fold into the repeat window.
              const period = end - coeffs[this._rBreakpt];
              time -= coeffs[this._rBreakpt];
              time -= period * Math.floor(time / period);
              time += coeffs[this._rBreakpt];
            } else {
              // vsrcacct.c:181-182 — hold until final time.
              this._breakTime = this._cktFinalTime;
              break;
            }
          }
          // vsrcacct.c:186-200 — schedule the next knot strictly after `time`.
          for (let i = 0; i < order; i += 2) {
            if (coeffs[i] > time) {
              this._breakTime = simTime + coeffs[i] - time;
              addBreakpoint(this._breakTime);
              this._breakTime -= this._minBreak;
              break;
            }
          }
        }
        break;

      case FunctionType.TRNOISE:
      case FunctionType.TRRANDOM:
        // vsrcacct.c:210-306 — TRNOISE/TRRANDOM scheduling reads state->TS /
        // state->TD and (TRRANDOM) refreshes state->value via trrandom_state_get,
        // all from maths-misc#recon/randnumb (not present). The break_time gate
        // shell is structurally in place; the generator-backed scheduling is
        // blocked on that recon. See ESCALATIONS.md.
        throw new Error(
          "TRNOISE/TRRANDOM breakpoint scheduling requires the deterministic RNG "
          + "substrate from maths-misc#recon/randnumb, which is not present in this worktree.",
        );
    }
  }

  /**
   * Mirrors ngspice VSRCaccept (vsrcacct.c:22-321): registers the source's next
   * transient breakpoint. square/triangle/sawtooth/sine carry a SPICE coefficient
   * model (enumWaveformCoeffs → PULSE/SINE), and PULSE/SINE/EXP/SFFM/AM/PWL/TRNOISE/
   * TRRANDOM tokens populate one directly, so _acceptNgspice (vsrcacct.c:50-321) owns
   * all breakpoint scheduling. Waveforms with no coefficient model
   * (sweep/am/fm/expression) register no breakpoints.
   */
  acceptStep(
    simTime: number,
    addBreakpoint: (t: number) => void,
    _atBreakpoint: boolean,
  ): void {
    // vsrcacct.c:22-49 — VSRCaccept runs on EVERY accepted transient step (its only
    // early-out is the non-transient-mode check at line 37); the next-edge schedule is
    // gated solely by the per-source `CKTtime >= VSRCbreak_time` test inside
    // _acceptNgspice (vsrcacct.c:94). There is no CKTbreak gate — gating on a
    // breakpoint-landing flag would drop every periodic edge whose break_time
    // threshold is crossed on a step that did not itself land on a breakpoint, so the
    // source would step over later edges at maxStep and the waveform would desync.
    if (this._funcTGiven && this._functionType !== null) {
      this._acceptNgspice(simTime, addBreakpoint);
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
  voltageProbes: [{ name: "V", pos: "pos", neg: "neg" }],
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
