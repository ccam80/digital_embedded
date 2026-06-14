import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import { describeIfDll, DLL_PATH } from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

// RealOpAmp is a modular behavioral macromodel composite (see real-opamp.ts).
// Full-field per-iteration numerical fidelity is verified bit-exact against
// ngspice by the paired harness blocks below; the headless tests cover only the
// op-amp-specific behaviour that motivated the composite — rail-saturation that
// converges (the inline model could not) and linear-region tracking.

const DTS_UNITY_FOLLOWER  = path.resolve("src/components/active/__tests__/fixtures/real-opamp-canon-unity-follower.dts");
const DTS_RAIL_SATURATION = path.resolve("src/components/active/__tests__/fixtures/real-opamp-canon-rail-saturation.dts");

function buildUnityFollower(vinVoltage: number) {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "vin",   type: "DcVoltageSource", props: { label: "vin",  voltage: vinVoltage } },
        { id: "vccp",  type: "DcVoltageSource", props: { label: "vccp", voltage: 15 } },
        { id: "vccn",  type: "DcVoltageSource", props: { label: "vccn", voltage: -15 } },
        { id: "opamp", type: "RealOpAmp",       props: { label: "opamp" } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vin:pos",   "opamp:in+"],
        ["opamp:out", "opamp:in-"],
        ["vccp:pos",  "opamp:Vcc+"],
        ["vccn:pos",  "opamp:Vcc-"],
        ["vin:neg",   "gnd:out"],
        ["vccp:neg",  "gnd:out"],
        ["vccn:neg",  "gnd:out"],
      ],
    }),
    params: { tStop: 1e-4, maxTimeStep: 1e-5 },
  });
}

// ---------------------------------------------------------------------------
// Op-amp-specific behaviour (headless, DLL-independent)
// ---------------------------------------------------------------------------

describe("RealOpAmp behaviour", () => {
  it("unity follower tracks Vin in the linear region", () => {
    const fix = buildUnityFollower(2);
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    // Vout = Vin + vos within finite-gain error (vos default 1e-3).
    expect(fix.engine.getNodeVoltage(nOut)).toBeCloseTo(2, 2);
  });

  it("rail saturation converges and clamps to Vcc+ - vSatPos", () => {
    // The inline model could not converge here; the behavioral rail clamp does.
    const fix = buildUnityFollower(16);
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    // vRailPos = Vcc+ - vSatPos = 15 - 1.5 = 13.5 V.
    expect(fix.engine.getNodeVoltage(nOut)).toBeCloseTo(13.5, 1);
  });
});

// ---------------------------------------------------------------------------
// Numerical verification vs ngspice (paired, full-field per iteration/step)
// ---------------------------------------------------------------------------

describeIfDll("RealOpAmp vs ngspice (T3 paired)", () => {
  let unity: ComparisonSession;
  let railSat: ComparisonSession;

  beforeAll(async () => {
    unity   = await ComparisonSession.create({ dtsPath: DTS_UNITY_FOLLOWER,  dllPath: DLL_PATH });
    railSat = await ComparisonSession.create({ dtsPath: DTS_RAIL_SATURATION, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (unity !== undefined) await unity.dispose();
    if (railSat !== undefined) await railSat.dispose();
  });

  it("unity follower paired all steps", async () => {
    await unity.runTransient(0, 1e-5, 1e-7);
    unity.compareAllSteps();
  });

  it("unity follower paired all iterations", () => {
    unity.compareAllAttempts();
  });

  it("rail saturation paired all steps", async () => {
    await railSat.runTransient(0, 1e-5, 1e-7);
    railSat.compareAllSteps();
  });

  it("rail saturation paired all iterations", () => {
    railSat.compareAllAttempts();
  });
});
