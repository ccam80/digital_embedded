/**
 * DC transfer-function (.tf) parity — Surface 3 (paired ngspice). Locks in the
 * `analysis#recon/tf` driver (spec/v41-port/reconstruction/analysis-tf.md):
 * digiTS's runTransferFunction re-solves the factored DC-OP Jacobian (tfanal.c)
 * and must match the ngspice DLL's `.tf` outputs[0..2] bit-exact.
 *
 * The ngspice side issues `tf <output> <insrc>` and the tf_register hook
 * (tfanal.c `done:`) captures the three scalars straight from the C `outputs[]`
 * array — no plot round-trip, no vector-name parsing. ComparisonSession.runTf
 * pairs them against coordinator.transferFunction.
 *
 * The deck names nodes by stringified digiTS node id (netlist-generator.ts), so
 * the divider's output net (digiTS node 2) is ngspice `v(2)`.
 */
import { it, expect } from "vitest";
import { resolve } from "path";
import { ComparisonSession } from "../harness/comparison-session.js";
import { describeIfDll, DLL_PATH } from "./parity-helpers.js";

const FX = (name: string): string =>
  resolve(process.cwd(), "src/solver/analog/__tests__/ngspice-parity/fixtures", name);

describeIfDll(".tf (transfer function) parity", () => {
  it("voltage input, node-pair output: transfer/Zin/Zout bit-exact vs ngspice", async () => {
    const s = await ComparisonSession.create({ dtsPath: FX("resistive-divider.dts"), dllPath: DLL_PATH });
    try {
      // V1=5, R1=R2=1k → transfer 0.5, Rin R1+R2=2k, Rout R1||R2=500.
      await s.runTf({ inputSource: "V1", output: "R1:neg", ngOutput: "v(2)" });
      expect(s.errors).toEqual([]);
      const c = s.tfCompare();
      expect(c).not.toBeNull();
      // Anchor: our scalars equal the closed-form divider values.
      expect(c!.transferFunction.ours).toBeCloseTo(0.5, 12);
      expect(c!.inputResistance.ours).toBeCloseTo(2000, 6);
      expect(c!.outputResistance.ours).toBeCloseTo(500, 9);
      // Parity: every scalar matches the ngspice DLL .tf bit-exact.
      expect(c!.maxAbsDelta).toBe(0);
    } finally { s.dispose(); }
  }, 240_000);

  it("voltage input, source-current output (same-source shortcut): bit-exact vs ngspice", async () => {
    const s = await ComparisonSession.create({ dtsPath: FX("resistive-divider.dts"), dllPath: DLL_PATH });
    try {
      // output current is through the input source itself → the TFoutSrc==TFinSrc
      // shortcut (tfanal.c:132-139): Rout is set equal to Rin, no second solve.
      // transfer d(I(V1))/d(V1) = -1/Rin = -5e-4; Rin = Rout = 2k.
      await s.runTf({ inputSource: "V1", output: "I(V1)", ngOutput: "i(v1)" });
      expect(s.errors).toEqual([]);
      const c = s.tfCompare();
      expect(c).not.toBeNull();
      expect(c!.transferFunction.ours).toBeCloseTo(-5e-4, 12);
      expect(c!.inputResistance.ours).toBeCloseTo(2000, 6);
      expect(c!.outputResistance.ours).toBe(c!.inputResistance.ours); // shortcut
      expect(c!.maxAbsDelta).toBe(0);
    } finally { s.dispose(); }
  }, 240_000);
});
