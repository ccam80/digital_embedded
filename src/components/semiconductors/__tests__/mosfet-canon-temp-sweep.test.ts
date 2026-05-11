import { describe, it, beforeAll, afterAll } from "vitest";
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
  "src/components/semiconductors/__tests__/fixtures/mosfet-canon-temp-sweep.dts",
);

// ---------------------------------------------------------------------------
// Category 3/5 — Temperature sweep parity (T3)
//
// NMOS common-source amplifier: VDD=5V → RD=1kΩ → M1.D, M1.G driven by
// VGS=1.5V (above VTO=1.0V, saturation region), M1.S and M1.B to GND.
// Three ambient temperatures per spec §5 acceptance:
//   T = 300.15 K  (set temp = 26.85°C — reference temperature, identity math)
//   T = 350 K     (set temp = 76.85°C — shifts KP/VTO via temperature pass)
//   T = 400 K     (set temp = 126.85°C — further KP/VTO shift)
//
// Each describe block opens one ComparisonSession, sets circuit temperature via
// session.engine.setCircuitTemp(K) before runTransient, and asserts
// compareAllAttempts() per spec §5. The ngspice side runs at its default
// temperature (27°C) unless a hand-written .cir with .options TEMP=X is
// provided — at non-default temperatures, divergences are the honest signal
// from the digiTS temperature-pass implementation vs ngspice's ambient model.
//
// Lane discipline: run once, log honestly. Do not chase parity divergences.
// Pre-existing MOSFET engine stagnation (batch-4 regression) causes failures
// at step 0/iter 0; temperature sweep fixtures inherit this regression.
// ---------------------------------------------------------------------------

describeIfDll("NMOS common-source temperature sweep 300.15 K paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_TEMP_SWEEP,
      dllPath: DLL_PATH,
    });
    session.engine.setCircuitTemp(300.15);
    await session.runTransient(0, 1e-4, 1e-6);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("temp_300_15K_compareAllAttempts", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("NMOS common-source temperature sweep 350 K paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_TEMP_SWEEP,
      dllPath: DLL_PATH,
    });
    session.engine.setCircuitTemp(350);
    await session.runTransient(0, 1e-4, 1e-6);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("temp_350K_compareAllAttempts", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("NMOS common-source temperature sweep 400 K paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_TEMP_SWEEP,
      dllPath: DLL_PATH,
    });
    session.engine.setCircuitTemp(400);
    await session.runTransient(0, 1e-4, 1e-6);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("temp_400K_compareAllAttempts", () => {
    session.compareAllAttempts();
  });
});
