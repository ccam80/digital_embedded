/**
 * DIAGNOSTIC ONLY (delete after triage): rc-transient first 3 step structure dump.
 */
import { it } from "vitest";
import { resolve } from "path";
import { ComparisonSession } from "../harness/comparison-session.js";
import { describeIfDll, DLL_PATH } from "./parity-helpers.js";

const DTS_PATH = resolve(
  process.cwd(),
  "src/solver/analog/__tests__/ngspice-parity/fixtures/rc-transient.dts",
);

describeIfDll("DIAG rc-transient", () => {
  it("dump step 0..3 structure", async () => {
    const session = new ComparisonSession({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
    });
    await session.init();
    await session.runTransient(0, 2e-3, 10e-6);

    const ours = session.ourSession!;
    const ng = session.ngspiceSessionAligned!;

    const buf = new ArrayBuffer(8);
    const f64 = new Float64Array(buf);
    const u8 = new Uint8Array(buf);
    const hex = (v: number): string => {
      f64[0] = v;
      return Array.from(u8).reverse().map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const dump = (label: string, sess: typeof ours, maxSteps = 4) => {
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
            const rhsOldStr = Array.from(it.prevVoltages).map(v => `${v}(${hex(v)})`).join(",");
            const vStr = Array.from(it.voltages).map(v => `${v}(${hex(v)})`).join(",");
            console.log(
              `    Iter ${ii}: initMode=${it.initMode} delta=${it.delta} order=${it.order} noncon=${it.noncon} converged=${it.globalConverged}`,
            );
            console.log(`      prevV=[${rhsOldStr}]`);
            console.log(`      v    =[${vStr}]`);
            for (const es of it.elementStates) {
              const slotStr = Object.entries(es.slots).map(([k, val]) => `${k}=${val}`).join(",");
              if (slotStr) console.log(`      ${es.label}: ${slotStr}`);
            }
          }
        }
      }
    };

    dump("OURS", ours);
    dump("NGSPICE (aligned)", ng);
  }, 60_000);
});
