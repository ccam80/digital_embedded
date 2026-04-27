/**
 * Quick regression check: run all 5 tmp-hang-circuits fixtures through the
 * harness and report step counts + final V/I. If the order/method sync fix
 * closed the Vc collapse issue, step counts should shrink substantially for
 * the RC/RLC cases.
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

const FIXTURES = [
  "rc-step",
  "rc-ac-lowpass",
  "rl-step",
  "rl-ac",
  "rlc-ringdown",
];

describeIfDll("all-fixtures regression probe (post order/method sync)", () => {
  for (const name of FIXTURES) {
    it(`${name}: runs to stopTime without collapse`, async () => {
      const session = new ComparisonSession({
        dtsPath: resolve(process.cwd(), `tmp-hang-circuits/${name}.dts`),
        dllPath: DLL_PATH,
        maxOurSteps: 500,
      });
      await session.init();
      // Most fixtures target microsecond stopTime; use 1us which should be
      // enough to exercise the post-firsttime path and order promotion.
      await session.runTransient(0, 1e-6, 1e-8);

      const ourSteps = (session as any)._ourSession!.steps;
      const ngSteps = (session as any)._ngSessionAligned()?.steps ?? [];
      const lastOurStep = ourSteps[ourSteps.length - 1];
      const lastRhs = lastOurStep?.attempts[lastOurStep.attempts.length - 1]
        ?.iterations?.at(-1)?.voltages;

      // eslint-disable-next-line no-console
      console.log(
        `${name}: ourSteps=${ourSteps.length}, ngSteps=${ngSteps.length}, ` +
        `lastSimTime=${lastOurStep?.stepEndTime?.toExponential?.(3)}, ` +
        `lastRhs=[${lastRhs ? Array.from(lastRhs as Float64Array).map((v) => v.toExponential(2)).join(",") : "none"}]`,
      );

      expect(ourSteps.length, "must make progress").toBeGreaterThan(3);
      // Did not hit the maxOurSteps cap of 500 — proxy for "no collapse stagnation".
      expect(ourSteps.length).toBeLessThan(500);
    }, 120_000);
  }
});
