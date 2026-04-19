/**
 * Targeted probe: dump s0/s1/s2 for the capacitor at step 3, iter 0 of
 * rc-step.dts on BOTH sides. Evidence for whether our engine actually has
 * s1[Q]=0 at step 3 entry (the inferred bug) vs s1[Q]=5uC (trace expectation).
 */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { accessSync } from "node:fs";
import { ComparisonSession } from "./comparison-session.js";

const DLL_PATH = resolve(
  process.cwd(),
  "ref/ngspice/visualc-shared/x64/Release/bin/spice.dll",
);
let _dllAvailable: boolean | null = null;
function dllAvailable(): boolean {
  if (_dllAvailable !== null) return _dllAvailable;
  try { accessSync(DLL_PATH); _dllAvailable = true; }
  catch { _dllAvailable = false; }
  return _dllAvailable;
}
const describeIfDll = dllAvailable() ? describe : describe.skip;

describeIfDll("step-3 cap state probe", () => {
  it("dumps s0/s1/s2 for Vc across every iteration of steps 0-4", async () => {
    const session = new ComparisonSession({
      dtsPath: resolve(process.cwd(), "tmp-hang-circuits/rc-step.dts"),
      dllPath: DLL_PATH,
      maxOurSteps: 20,
    });
    await session.init();
    await session.runTransient(0, 1e-9, 1e-10);

    const ourSteps = (session as any)._ourSession!.steps;
    const ngSteps = (session as any)._ngSessionAligned()?.steps ?? [];

    // Find capacitor label (may be "Vc" or similar on our side).
    const ourCapLabel =
      (session as any)._ourTopology?.elements?.find((el: any) =>
        el.label?.toLowerCase?.().includes("c") ||
        el.kind?.toLowerCase?.() === "capacitor")?.label ?? null;

    // eslint-disable-next-line no-console
    console.log(`\n=== OUR-side capacitor label resolved: ${ourCapLabel ?? "(none)"} ===`);
    // eslint-disable-next-line no-console
    console.log(`=== OUR steps: ${ourSteps.length}, NG steps: ${ngSteps.length} ===\n`);

    const maxStep = Math.min(5, ourSteps.length);
    for (let si = 0; si < maxStep; si++) {
      const step = ourSteps[si];
      // eslint-disable-next-line no-console
      console.log(`\n--- Step ${si} (t=${step.stepStartTime} -> ${step.stepEndTime}, attempts=${step.attempts.length}) ---`);
      for (let ai = 0; ai < step.attempts.length; ai++) {
        const att = step.attempts[ai];
        // eslint-disable-next-line no-console
        console.log(`  attempt ${ai} phase=${att.phase} dt=${att.dt} iters=${att.iterations.length}`);
        for (let ii = 0; ii < att.iterations.length; ii++) {
          const iter = att.iterations[ii];
          const capEs = iter.elementStates.find((es: any) =>
            ourCapLabel ? es.label === ourCapLabel :
            Object.keys(es.slots ?? {}).includes("Q"));
          if (!capEs) continue;
          const s0 = capEs.slots ?? {};
          const s1 = capEs.state1Slots ?? {};
          const s2 = capEs.state2Slots ?? {};
          // eslint-disable-next-line no-console
          console.log(
            `    iter ${ii}: ag0=${iter.ag?.[0]?.toExponential?.(3) ?? "?"} ag1=${iter.ag?.[1]?.toExponential?.(3) ?? "?"} method=${iter.method} order=${iter.order}`,
          );
          // eslint-disable-next-line no-console
          console.log(
            `            s0{ Q=${s0.Q?.toExponential?.(4)} CCAP=${s0.CCAP?.toExponential?.(4)} V=${s0.V?.toExponential?.(4)} GEQ=${s0.GEQ?.toExponential?.(4)} IEQ=${s0.IEQ?.toExponential?.(4)} }`,
          );
          // eslint-disable-next-line no-console
          console.log(
            `            s1{ Q=${s1.Q?.toExponential?.(4)} CCAP=${s1.CCAP?.toExponential?.(4)} V=${s1.V?.toExponential?.(4)} GEQ=${s1.GEQ?.toExponential?.(4)} IEQ=${s1.IEQ?.toExponential?.(4)} }`,
          );
          // eslint-disable-next-line no-console
          console.log(
            `            s2{ Q=${s2.Q?.toExponential?.(4)} CCAP=${s2.CCAP?.toExponential?.(4)} }`,
          );
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log("\n=== NG-side (paired) ===");
    for (let si = 0; si < Math.min(5, ngSteps.length); si++) {
      const step = ngSteps[si];
      // eslint-disable-next-line no-console
      console.log(`\n--- NG Step ${si} (t=${step.stepStartTime} -> ${step.stepEndTime}, attempts=${step.attempts.length}) ---`);
      for (let ai = 0; ai < step.attempts.length; ai++) {
        const att = step.attempts[ai];
        // eslint-disable-next-line no-console
        console.log(`  attempt ${ai} phase=${att.phase} dt=${att.dt} iters=${att.iterations.length}`);
        for (let ii = 0; ii < att.iterations.length; ii++) {
          const iter = att.iterations[ii];
          const capEs = iter.elementStates.find((es: any) =>
            es.label?.toUpperCase?.() === "CVC");
          if (!capEs) continue;
          const s0 = capEs.slots ?? {};
          const s1 = capEs.state1Slots ?? {};
          const s2 = capEs.state2Slots ?? {};
          // eslint-disable-next-line no-console
          console.log(
            `    iter ${ii}: ag0=${iter.ag?.[0]?.toExponential?.(3) ?? "?"} ag1=${iter.ag?.[1]?.toExponential?.(3) ?? "?"}`,
          );
          // eslint-disable-next-line no-console
          console.log(
            `            s0{ Q=${s0.Q?.toExponential?.(4)} CCAP=${s0.CCAP?.toExponential?.(4)} }`,
          );
          // eslint-disable-next-line no-console
          console.log(
            `            s1{ Q=${s1.Q?.toExponential?.(4)} CCAP=${s1.CCAP?.toExponential?.(4)} }`,
          );
          // eslint-disable-next-line no-console
          console.log(
            `            s2{ Q=${s2.Q?.toExponential?.(4)} CCAP=${s2.CCAP?.toExponential?.(4)} }`,
          );
        }
      }
    }

    expect(ourSteps.length).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
