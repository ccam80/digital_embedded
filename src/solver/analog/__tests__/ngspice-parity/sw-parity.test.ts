/**
 * Voltage-controlled switch (ngspice SW / VSWITCH) parity — Surface 3 (paired
 * ngspice). Locks in the three sw reconstruction-of-record specs:
 *   - sw#recon/trunc   — SWtrunc transient timestep limiter (switching edges).
 *   - sw#recon/acLoad  — SWacLoad AC conductance stamp, including the removed
 *                        resistance floor (open question #34: stamp 1/Ron raw).
 *   - sw#recon/icParam — SW_IC_ON / SW_IC_OFF initial-condition keyword.
 *
 * Each accepted step / swept frequency matches the ngspice DLL bit-exact
 * (firstDivergence null across all classes), per swload.c / swtrunc.c /
 * swacload.c / swparam.c.
 */
import { it, expect } from "vitest";
import { resolve } from "path";
import { ComparisonSession } from "../harness/comparison-session.js";
import { describeIfDll, DLL_PATH } from "./parity-helpers.js";

const FX = (name: string): string =>
  resolve(process.cwd(), "src/solver/analog/__tests__/ngspice-parity/fixtures", name);

describeIfDll("sw (VSWITCH) parity", () => {
  it("sw-gate transient bit-exact vs ngspice (SWtrunc switching edges)", async () => {
    const s = await ComparisonSession.create({ dtsPath: FX("sw-gate.dts"), dllPath: DLL_PATH });
    try {
      await s.runTransient(0, 1e-3);
      expect(s.errors).toEqual([]);
      expect(s.firstDivergence().earliest).toBeNull();
    } finally { s.dispose(); }
  }, 240_000);

  it("sw-gate-lowron transient bit-exact (Ron=1e-4, below the removed 1e-3 floor)", async () => {
    // #34: the resistance floor is removed, so ours stamps 1/Ron = 1e4 raw- the
    // value the netlist generator emits to the ngspice deck (swsetup.c:35).
    const s = await ComparisonSession.create({ dtsPath: FX("sw-gate-lowron.dts"), dllPath: DLL_PATH });
    try {
      await s.runTransient(0, 1e-3);
      expect(s.errors).toEqual([]);
      expect(s.firstDivergence().earliest).toBeNull();
    } finally { s.dispose(); }
  }, 240_000);

  it("sw-gate-on transient bit-exact (SW_IC_ON seeds the switch closed)", async () => {
    // on=1 sets SWzero_stateGiven=TRUE (swparam.c:21-24) on both sides- the
    // generator emits the ngspice S-element trailing ON token- so both engines
    // boot the switch closed at MODEINITJCT (swload.c:43-60).
    const s = await ComparisonSession.create({ dtsPath: FX("sw-gate-on.dts"), dllPath: DLL_PATH });
    try {
      await s.runTransient(0, 1e-3);
      expect(s.errors).toEqual([]);
      expect(s.firstDivergence().earliest).toBeNull();
    } finally { s.dispose(); }
  }, 240_000);

  it("sw-gate-lowron AC sweep bit-exact (SWacLoad conductance stamp)", async () => {
    // SWacLoad propagates the committed state and stamps 1/Ron / 1/Roff raw into
    // the AC matrix (swacload.c:26-33); no resistance floor (#34).
    const s = await ComparisonSession.create({ dtsPath: FX("sw-gate-lowron.dts"), dllPath: DLL_PATH });
    try {
      await s.runAcSweep({ type: "dec", numPoints: 10, fStart: 1, fStop: 1e6, outputNodes: [] });
      expect(s.errors).toEqual([]);
      expect(s.acFirstDivergence().earliestPointIndex).toBeNull();
    } finally { s.dispose(); }
  }, 240_000);
});
