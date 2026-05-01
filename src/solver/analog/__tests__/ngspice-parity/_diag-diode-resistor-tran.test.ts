/**
 * DIAGNOSTIC ONLY (delete after triage): transient parity sweep on the same
 * harness phase 10.2 used for DC-OP (diode + resistor). Phase 10.2 only ran
 * dc_op_pnjlim_match- this dumps the post-fix attempt structure on both
 * sides side-by-side and reports the FIRST per-attempt divergence.
 */

import { it } from "vitest";
import { resolve } from "path";
import { ComparisonSession } from "../harness/comparison-session.js";
import { describeIfDll, DLL_PATH } from "./parity-helpers.js";

const DTS_PATH = resolve(
  process.cwd(),
  "src/solver/analog/__tests__/ngspice-parity/fixtures/diode-resistor.dts",
);

describeIfDll("DIAG diode + resistor transient parity", () => {
  it("dump+compare step 0 attempt structure", async () => {
    const session = new ComparisonSession({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
    });
    await session.init();
    await session.runTransient(0, 1e-3, 10e-6);

    const ours = session.ourSession!;
    const ng = session.ngspiceSessionAligned!;

    const summarize = (label: string, sess: typeof ours, maxSteps = 3) => {
      console.log(`\n=== ${label} (steps=${sess.steps.length}) ===`);
      for (let si = 0; si < Math.min(maxSteps, sess.steps.length); si++) {
        const step = sess.steps[si]!;
        console.log(`Step ${si}: attempts=${step.attempts.length} accIdx=${step.acceptedAttemptIndex}`);
        for (let ai = 0; ai < step.attempts.length; ai++) {
          const att = step.attempts[ai]!;
          const firstIter = att.iterations[0];
          const prevHead = firstIter ? Array.from(firstIter.prevVoltages.slice(0, 3)).join(",") : "(none)";
          console.log(
            `  Attempt ${ai}: phase=${att.phase} outcome=${att.outcome} iters=${att.iterations.length} ` +
              `firstIter.prevV=[${prevHead}]`,
          );
        }
      }
    };

    summarize("OURS", ours);
    summarize("NGSPICE", ng);
  }, 180_000);
});
