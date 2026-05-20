// Capacitor geometric-cap T3 temperature-sweep paired-parity tests. Category 3
// (transient response) per docs/api-reference/test-tools.md.
//
// Coverage gap this closes: the cap's model-partition params (cj, cjsw, defw,
// defl, narrow, short, del, di, thick, mCap) are declared in capacitor.ts and
// digiTS's computeTemperature has the full geometric implementation
// (capacitor.ts:424-430), but no prior test exercises them — every existing
// cap fixture sets `capacitance` positionally, which forces ngspice's direct-
// value path (captemp.c:69-70) and bypasses the geometric branch.
//
// Fixture leaves `capacitance` unset and supplies cj/cjsw/W/L + TC1=0.01, so
// the netlist emitter takes the no-positional-VALUE branch and emits a
// `.model NAME C (cj=... cjsw=... TC1=0.01 ...)` card. ngspice's CAPtemp then
// enters the !CAPcapGiven && !CAPmCapGiven arm and computes effective C from
// process params; the TC1 fold then makes the effective C temperature-
// dependent. Three describeIfDll blocks mirror capacitor-temp-sweep.test.ts:
// 300.15K (default, no setCircuitTemp) / 350K / 400K — all paired bit-exact
// against ngspice across every captured iteration.

import { it, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

const DTS_GEOMETRIC = path.resolve(
  "src/components/passives/__tests__/fixtures/capacitor-geometric-rc.dts",
);

describeIfDll("Capacitor geometric-cap 300.15K vs ngspice — paired (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_GEOMETRIC, dllPath: DLL_PATH });
    // 300.15K is the default circuit temperature; setCircuitTemp is omitted
    // here as the baseline. The 350K / 400K describes call it because their
    // target differs from the default.
    await session.runTransient(0, 5e-6, 5e-9);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("geometric_temp_300_15K_compareAllAttempts", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Capacitor geometric-cap 350K vs ngspice — paired (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_GEOMETRIC, dllPath: DLL_PATH });
    session.engine.setCircuitTemp(350);
    await session.runTransient(0, 5e-6, 5e-9);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("geometric_temp_350K_compareAllAttempts", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Capacitor geometric-cap 400K vs ngspice — paired (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_GEOMETRIC, dllPath: DLL_PATH });
    session.engine.setCircuitTemp(400);
    await session.runTransient(0, 5e-6, 5e-9);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("geometric_temp_400K_compareAllAttempts", () => {
    session.compareAllAttempts();
  });
});
