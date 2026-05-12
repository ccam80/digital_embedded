import { it, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

// ---------------------------------------------------------------------------
// .dts path
// ---------------------------------------------------------------------------

const DTS_TEMP_SWEEP = path.resolve(
  "src/components/semiconductors/__tests__/fixtures/bjt-canon-temp-sweep.dts",
);

// ---------------------------------------------------------------------------
// Category 3/5 — Temperature sweep parity (T3)
//
// NPN common-emitter amplifier: 5V VCC -> 1kOhm RC -> Q1.C; 0.7V VBB -> 10kOhm RB
// -> Q1.B; Q1.E -> GND; VCC.neg -> GND; VBB.neg -> GND.
// Three ambient temperatures per spec section 5 acceptance:
//   T = 300.15 K  (set temp = 26.85 degrees C -- reference temperature, identity math)
//   T = 350 K     (set temp = 76.85 degrees C -- raises tSatCur, shifts Vbe/Vc)
//   T = 400 K     (set temp = 126.85 degrees C -- further tSatCur rise, further shift)
//
// Each describe block opens one ComparisonSession, sets circuit temperature via
// session.engine.setCircuitTemp(K) before runTransient, and asserts
// compareAllAttempts() per spec section 5. The ngspice side runs at its default
// temperature (27 degrees C) unless a hand-written .cir with .options TEMP=X is
// provided -- at non-default temperatures, divergences are the honest signal
// from the digiTS temperature-pass implementation vs ngspice's ambient model.
//
// Lane discipline: run once, log honestly. Do not chase parity divergences.
// Pre-existing BJT T3 ULP failures are expected to appear at 300.15 K per
// the 5.1.b progress entry; non-default temperatures will additionally surface
// tSatCur/vt divergence from the ambient-temp delta.
// ---------------------------------------------------------------------------

describeIfDll("NPN common-emitter temperature sweep 300.15 K paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_TEMP_SWEEP,
      dllPath: DLL_PATH,
    });
    session.engine.setCircuitTemp(300.15);
    await session.runTransient(0, 1e-5, 1e-7);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("temp_300_15K_compareAllAttempts", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("NPN common-emitter temperature sweep 350 K paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_TEMP_SWEEP,
      dllPath: DLL_PATH,
    });
    session.engine.setCircuitTemp(350);
    await session.runTransient(0, 1e-5, 1e-7);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("temp_350K_compareAllAttempts", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("NPN common-emitter temperature sweep 400 K paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_TEMP_SWEEP,
      dllPath: DLL_PATH,
    });
    session.engine.setCircuitTemp(400);
    await session.runTransient(0, 1e-5, 1e-7);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("temp_400K_compareAllAttempts", () => {
    session.compareAllAttempts();
  });
});
