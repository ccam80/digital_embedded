// Capacitor temperature-sweep T3 paired-parity tests. Category 3 (transient
// response) per docs/api-reference/test-tools.md — no analytical truth at
// arbitrary transient time, so this is paired bit-exact against an
// instrumented ngspice DLL.
//
// Circuit: AcVoltageSource(1V, 1kHz) -> R(1kΩ) -> C(1µF, TC1=0.01) -> GND.
// With TC1≠0 the effective capacitance folds with ambient temperature
// (CAPtemp / captemp.c:72-89), so node voltages, branch currents, and
// per-element slot values diverge across {300.15K, 350K, 400K} — and must
// match ngspice bit-exact at every captured iteration.
//
// One describe per ambient temperature, mirroring bjt-canon-temp-sweep.test.ts
// structure: session.runTransient inside beforeAll so the ngspice bridge
// data is fully populated before the it()-level compareAllAttempts() assertion.

import { it, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

const DTS_TEMP_SWEEP = path.resolve(
  "src/components/passives/__tests__/fixtures/capacitor-temp-sweep.dts",
);

describeIfDll("Capacitor temp-sweep 300.15K vs ngspice — paired (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_TEMP_SWEEP, dllPath: DLL_PATH });
    // 300.15K is the default circuit temperature; setCircuitTemp is omitted
    // for this baseline. The 350K / 400K describes call it because their
    // target differs from the default.
    await session.runTransient(0, 5e-3, 5e-6);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("temp_300_15K_compareAllAttempts", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Capacitor temp-sweep 350K vs ngspice — paired (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_TEMP_SWEEP, dllPath: DLL_PATH });
    session.engine.setCircuitTemp(350);
    await session.runTransient(0, 5e-3, 5e-6);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("temp_350K_compareAllAttempts", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Capacitor temp-sweep 400K vs ngspice — paired (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_TEMP_SWEEP, dllPath: DLL_PATH });
    session.engine.setCircuitTemp(400);
    await session.runTransient(0, 5e-3, 5e-6);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("temp_400K_compareAllAttempts", () => {
    session.compareAllAttempts();
  });
});
