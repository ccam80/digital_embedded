/**
 * Benign-deck round-trip validation for the ngspice safety-isolation guard.
 *
 * Proves the out-of-process guarded path produces a `CaptureSession`
 * BIT-IDENTICAL to the in-process path — i.e. the worker spawn, the transport
 * serialization (typed arrays + Maps + non-finite numbers), and the result
 * decode preserve the exact contract downstream diff/compare code relies on.
 *
 * Covers all three analysis shapes the VDMOS gate will run — dcop, tran, AC —
 * so the serde is locked for the per-iteration Float64Arrays + topology Maps
 * (dcop/tran) AND the Int32Array CSC colPtr/rowIdx + Map nodeNames (AC) before
 * the gate depends on them.
 *
 * SAFETY: this uses ONLY benign decks ngspice already runs in-process today
 * (resistive divider, RC transient, RC low-pass AC — no semiconductor, no
 * VDMOS). The whole point is to validate marshaling without risk. DLL-gated;
 * skips cleanly when the DLL is absent.
 */

import { it, expect, describe } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { DEFAULT_NGSPICE_DLL_PATH } from "./ngspice-dll-path.js";
import { ComparisonSession } from "./comparison-session.js";
import { runNgspiceInProcess } from "./ngspice-bridge.js";
import type { NgspiceJobSpec } from "./ngspice-bridge.js";
import { runNgspiceGuarded } from "./ngspice-guarded.js";
import type { CaptureSession } from "./types.js";

const FIXTURES = resolve(process.cwd(), "src/solver/analog/__tests__/ngspice-parity/fixtures");
const RC_DTS = resolve(FIXTURES, "rc-transient.dts");
const DIVIDER_DTS = resolve(FIXTURES, "resistive-divider.dts");
const RC_LOWPASS_AC_DTS = resolve(FIXTURES, "rc-lowpass-ac.dts");

// This round-trip needs the INSTRUMENTED DLL (the one with ni_ac_register).
// `NGSPICE_DLL_PATH` may be pointed at a stale build, so resolve the
// in-tree default explicitly rather than via the env-driven DLL_PATH. Skip
// cleanly if even that is absent.
const DLL_PATH = DEFAULT_NGSPICE_DLL_PATH;
const describeIfDll = existsSync(DLL_PATH) ? describe : describe.skip;

/** Structural deep equality for two CaptureSessions, handling Float64Array,
 *  Map, and nested objects. Returns the path of the first difference, or null
 *  when identical. Bit-exact for numbers (===), so a single mismatched matrix
 *  cell or voltage surfaces. */
function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (a instanceof Float64Array || b instanceof Float64Array) {
    if (!(a instanceof Float64Array) || !(b instanceof Float64Array)) {
      return `${path}: one side is Float64Array, the other is not`;
    }
    if (a.length !== b.length) return `${path}.length: ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      // Bit-exact, with NaN treated as equal-to-NaN (Object.is).
      if (!Object.is(a[i], b[i])) return `${path}[${i}]: ${a[i]} vs ${b[i]}`;
    }
    return null;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map)) {
      return `${path}: one side is Map, the other is not`;
    }
    if (a.size !== b.size) return `${path}.size: ${a.size} vs ${b.size}`;
    for (const [k, v] of a) {
      if (!b.has(k)) return `${path}.get(${String(k)}): missing on guarded side`;
      const d = firstDiff(v, b.get(k), `${path}.get(${String(k)})`);
      if (d) return d;
    }
    return null;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array/non-array mismatch`;
    if (a.length !== b.length) return `${path}.length: ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.join(",") !== kb.join(",")) return `${path}: key set differs [${ka}] vs [${kb}]`;
    for (const k of ka) {
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  if (!Object.is(a, b)) return `${path}: ${String(a)} vs ${String(b)}`;
  return null;
}

describeIfDll("ngspice guard- benign-deck round-trip (in-process == guarded)", () => {
  it("RC transient: guarded CaptureSession is bit-identical to in-process", async () => {
    // Build the materialized deck via ComparisonSession (its init compiles the
    // circuit and generates the SPICE netlist), then run that SAME deck both
    // ways with an identical job spec.
    const session = new ComparisonSession({ dtsPath: RC_DTS, dllPath: DLL_PATH });
    await session.init();
    const deck = session.getNgspiceDeck();
    expect(deck.length).toBeGreaterThan(0);

    const spec: NgspiceJobSpec = {
      dllPath: DLL_PATH,
      netlist: deck,
      analysis: { kind: "tran", tStop: "2ms", tStep: "20us", tMax: "10us" },
    };

    // In-process reference.
    const inProc = await runNgspiceInProcess(spec);
    // Out-of-process guarded run with conservative caps (benign deck — plenty
    // of headroom; we are testing marshaling, not the cap).
    const guarded = await runNgspiceGuarded(spec, {
      timeoutMs: 60_000,
      memLimitBytes: 1024 * 1024 * 1024,
    });

    expect(inProc.analysis).toBe("tran");
    expect(guarded.analysis).toBe("tran");

    const a = inProc.session as CaptureSession;
    const g = guarded.session as CaptureSession;
    expect(a).not.toBeNull();
    expect(g).not.toBeNull();
    expect(a.steps.length).toBeGreaterThan(0);

    const diff = firstDiff(a, g);
    expect(diff, `first divergence between in-process and guarded CaptureSession: ${diff}`).toBeNull();
  }, 120_000);

  it("DC operating point: guarded CaptureSession is bit-identical to in-process", async () => {
    // Benign resistive divider (DcVoltageSource + two resistors). Locks the
    // dcop shape of the serde — the VDMOS gate runs dcop first.
    const session = new ComparisonSession({ dtsPath: DIVIDER_DTS, dllPath: DLL_PATH });
    await session.init();
    const deck = session.getNgspiceDeck();
    expect(deck.length).toBeGreaterThan(0);

    const spec: NgspiceJobSpec = {
      dllPath: DLL_PATH,
      netlist: deck,
      analysis: { kind: "dcop" },
    };

    const inProc = await runNgspiceInProcess(spec);
    const guarded = await runNgspiceGuarded(spec, {
      timeoutMs: 60_000,
      memLimitBytes: 1024 * 1024 * 1024,
    });

    expect(inProc.analysis).toBe("dcop");
    expect(guarded.analysis).toBe("dcop");

    const a = inProc.session as CaptureSession;
    const g = guarded.session as CaptureSession;
    expect(a).not.toBeNull();
    expect(g).not.toBeNull();
    expect(a.steps.length).toBeGreaterThan(0);

    // Compare the CaptureSession (topology Maps + per-iter Float64Arrays) AND
    // the parsed ngspice topology (its nodeNames Map) — both ride the serde.
    const sessDiff = firstDiff(a, g);
    expect(sessDiff, `dcop CaptureSession divergence: ${sessDiff}`).toBeNull();
    const topoDiff = firstDiff(inProc.ngspiceTopology, guarded.ngspiceTopology);
    expect(topoDiff, `dcop ngspiceTopology divergence: ${topoDiff}`).toBeNull();
  }, 120_000);

  it("AC sweep: guarded acPoints + topology are bit-identical to in-process", async () => {
    // Benign RC low-pass with an AcVoltageSource. The AC path exercises the
    // serde shapes the VDMOS AC gate depends on: Int32Array colPtr/rowIdx in
    // each acPoint's CSC matrix, Float64Array re/im twins, and the Map
    // nodeNames on ngspiceTopology. No semiconductor anywhere.
    const session = new ComparisonSession({ dtsPath: RC_LOWPASS_AC_DTS, dllPath: DLL_PATH });
    await session.init();
    const deck = session.getNgspiceDeck();
    expect(deck.length).toBeGreaterThan(0);

    const spec: NgspiceJobSpec = {
      dllPath: DLL_PATH,
      netlist: deck,
      analysis: { kind: "ac", type: "dec", n: 10, fStart: 1, fStop: 1e6 },
    };

    const inProc = await runNgspiceInProcess(spec);
    const guarded = await runNgspiceGuarded(spec, {
      timeoutMs: 60_000,
      memLimitBytes: 1024 * 1024 * 1024,
    });

    expect(inProc.analysis).toBe("ac");
    expect(guarded.analysis).toBe("ac");

    expect(inProc.acPoints).not.toBeNull();
    expect(guarded.acPoints).not.toBeNull();
    expect(inProc.acPoints!.length).toBeGreaterThan(0);

    // acPoints carry Int32Array (colPtr/rowIdx) + Float64Array (vals/rhs/sol)
    // — the typed-array serde shapes the gate's AC stage will rely on.
    const pointsDiff = firstDiff(inProc.acPoints, guarded.acPoints);
    expect(pointsDiff, `AC acPoints divergence: ${pointsDiff}`).toBeNull();
    // ngspiceTopology.nodeNames is a Map — lock the Map serde for AC too.
    const topoDiff = firstDiff(inProc.ngspiceTopology, guarded.ngspiceTopology);
    expect(topoDiff, `AC ngspiceTopology divergence: ${topoDiff}`).toBeNull();
  }, 120_000);
});
