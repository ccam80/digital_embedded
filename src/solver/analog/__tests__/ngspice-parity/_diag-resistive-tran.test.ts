/**
 * DIAGNOSTIC ONLY (delete after triage): dump step 0 contents on both sides
 * for the resistive-divider transient run, to see where alignment breaks.
 */
import { it } from "vitest";
import { resolve } from "path";
import { ComparisonSession } from "../harness/comparison-session.js";
import { describeIfDll, DLL_PATH } from "./parity-helpers.js";

const DTS_PATH = resolve(
  process.cwd(),
  "src/solver/analog/__tests__/ngspice-parity/fixtures/resistive-divider.dts",
);

describeIfDll("DIAG resistive divider transient", () => {
  it("dump step 0 structure", async () => {
    const session = new ComparisonSession({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
    });
    await session.init();
    await session.runTransient(0, 1e-3, 10e-6);

    const ours = session.ourSession!;
    const ng = session.ngspiceSessionAligned!;

    const buf = new ArrayBuffer(8);
    const f64 = new Float64Array(buf);
    const u8 = new Uint8Array(buf);
    const hex = (v: number): string => {
      f64[0] = v;
      return Array.from(u8).reverse().map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const dump = (label: string, sess: typeof ours, maxSteps = 3) => {
      console.log(`\n=== ${label} (steps=${sess.steps.length}) ===`);
      for (let si = 0; si < Math.min(maxSteps, sess.steps.length); si++) {
        const step = sess.steps[si]!;
        console.log(
          `Step ${si}: stepStart=${step.stepStartTime} stepEnd=${step.stepEndTime} ` +
            `accIdx=${step.acceptedAttemptIndex} attempts=${step.attempts.length}`,
        );
        for (let ai = 0; ai < step.attempts.length; ai++) {
          const att = step.attempts[ai]!;
          console.log(
            `  Attempt ${ai}: phase=${att.phase} dt=${att.dt} (${hex(att.dt)}) outcome=${att.outcome} iters=${att.iterations.length}`,
          );
          for (let ii = 0; ii < att.iterations.length; ii++) {
            const it = att.iterations[ii]!;
            console.log(
              `    Iter ${ii}: initMode=${it.initMode} delta=${it.delta} (${hex(it.delta)}) order=${it.order} noncon=${it.noncon}`,
            );
          }
        }
      }
    };

    dump("OURS", ours);
    dump("NGSPICE (aligned)", ng);
  }, 60_000);
});
