import { describe, it } from "vitest";
import { resolve } from "path";
import { accessSync } from "fs";
import { ComparisonSession } from "./comparison-session.js";

const DLL_PATH = resolve(
  process.cwd(), "ref/ngspice/visualc-shared/x64/Release/bin/spice.dll",
);

let dllAvailable = false;
try { accessSync(DLL_PATH); dllAvailable = true; } catch { /* */ }

const describeIfDll = dllAvailable ? describe : describe.skip;

describeIfDll("dump ngspice dt", () => {
  it("prints per-attempt dt for buckbjt with various tran args", async () => {
    const configs = [
      { label: "tran 100n 10u", tStop: 1e-5, maxStep: 1e-7 },
      { label: "tran 10n 10u",  tStop: 1e-5, maxStep: 1e-8 },
      { label: "tran 1u 10u",   tStop: 1e-5, maxStep: 1e-6 },
    ];
    for (const cfg of configs) {
      console.log(`\n========== ${cfg.label} ==========`);
      const session = new ComparisonSession({
        dtsPath: "fixtures/buckbjt.dts",
        dllPath: DLL_PATH,
        maxOurSteps: 5,
      });
      await session.init();
      await session.runTransient(0, cfg.tStop, cfg.maxStep);

      const ngSteps = (session as any)._ngSession!.steps;
      console.log(`ngspice total steps: ${ngSteps.length}`);

      const step0 = ngSteps[0];
      console.log(`step 0 attempts:`);
      for (let ai = 0; ai < step0.attempts.length; ai++) {
        const a = step0.attempts[ai];
        console.log(`  [${ai}] phase=${a.phase} dt=${a.dt} outcome=${a.outcome} iters=${a.iterationCount}`);
      }
    }
  });
});
