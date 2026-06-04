/**
 * `.option cshunt` parity — Surface 3 (paired ngspice). Locks in the
 * `analysis#recon/cshunt` injection pass
 * (spec/v41-port/reconstruction/analysis-cshunt.md): MNAEngine._setup injects
 * one capacitor-to-ground per external/netlist voltage node (inppas4.c:54-75),
 * and the result must match the ngspice DLL's own INPpas4 injection bit-exact.
 *
 * The fixture (cshunt-gate.dts) is V1 sine -> R1 -> mid; D1(RS=10) mid->gnd;
 * R2 mid->gnd. RS != 0 makes the diode mint a device-internal anode node
 * (diosetup.c:303-312; diode.ts:838-843) numbered above nodeCount. That node
 * is the load-bearing exclusion probe: ngspice mints it in CKTsetup, AFTER
 * INPpas4 has finished injecting shunt caps (spiceif.c:177,195; cktdojob.c:161),
 * and digiTS mints it in the per-element setup() loop, AFTER the injection pass.
 * So neither side puts a shunt cap on it. Bit-exact transient parity here is
 * positive proof that (a) the two external voltage nodes (in, mid) each get a
 * matching shunt cap and (b) the diode internal anode is correctly excluded on
 * both sides.
 *
 * The matching `.options cshunt=<val>` deck card is injected by
 * ComparisonSession._materializeCir so ngspice's INPpas4 runs; digiTS gets the
 * value via params.cshunt (configured in _initWithCircuit before the lazy
 * _setup()). Both sides therefore see the identical injected-cap set.
 */
import { it, expect } from "vitest";
import { resolve } from "path";
import { ComparisonSession } from "../harness/comparison-session.js";
import { describeIfDll, DLL_PATH } from "./parity-helpers.js";

const DTS_PATH = resolve(
  process.cwd(),
  "src/solver/analog/__tests__/ngspice-parity/fixtures/cshunt-gate.dts",
);

const CSHUNT = 1e-9;
const STOP = 2e-3;
const MAX_STEP = 10e-6;

describeIfDll(".option cshunt parity", () => {
  it("baseline (cshunt unset): transient bit-exact, no injected caps", async () => {
    // Criterion 2: default cshunt (-1, off) leaves the circuit byte-identical to
    // cshunt-absent (inp.c:466 sr<=0 rejection). No shunt caps on either side.
    const s = await ComparisonSession.create({ dtsPath: DTS_PATH, dllPath: DLL_PATH });
    try {
      await s.runTransient(0, STOP, MAX_STEP);
      expect(s.errors).toEqual([]);
      const fd = s.firstDivergence();
      expect(fd.earliest).toBeNull();

      // No `capac<n>shunt` device exists on either side at the default.
      const topo = s.topologyDiff();
      const ourShunts = topo.ourElementCount;
      expect(ourShunts).toBe(topo.ngspiceElementCount);
      expect(topo.elementDiffs).toEqual([]);
    } finally { s.dispose(); }
  }, 240_000);

  it("cshunt=1e-9: external/netlist nodes shunted, diode internal node excluded, bit-exact", async () => {
    // Criterion 7: cshunt on BOTH engines -> firstDivergence.earliest === null
    // across all signal classes. Criterion 4/5: one real AnalogCapacitorElement
    // per external/netlist voltage node (in, mid); the diode internal anode
    // (number > nodeCount) gets none.
    const s = await ComparisonSession.create({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
      cshunt: CSHUNT,
    });
    try {
      await s.runTransient(0, STOP, MAX_STEP);
      expect(s.errors).toEqual([]);

      const fd = s.firstDivergence();
      // Strict bit-exact: every signal class null (no tolerance qualifier).
      expect(fd.voltage).toBeNull();
      expect(fd.rhs).toBeNull();
      expect(fd.matrix).toBeNull();
      expect(fd.state).toBeNull();
      expect(fd.integration).toBeNull();
      expect(fd.limiting).toBeNull();
      expect(fd.convergence).toBeNull();
      expect(fd.shape).toBeNull();
      expect(fd.earliest).toBeNull();
    } finally { s.dispose(); }
  }, 240_000);

  it("cshunt=1e-9: injected caps appear identically on both sides (topology parity)", async () => {
    // Criterion 8: the injected caps appear IDENTICALLY on both sides — same
    // per-node coverage, same node order, same value. elementDiffs empty (no
    // oursOnly / ngspiceOnly), no slot-index orderingDiffs. This proves the
    // node set and the element-pool order match ngspice's INPpas4 instance
    // creation. The fixture has 2 external voltage nodes (in, mid), so exactly
    // 2 capac<n>shunt devices are injected per side; the diode internal anode
    // (minted in setup(), number > nodeCount) is NOT among them.
    const s = await ComparisonSession.create({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
      cshunt: CSHUNT,
    });
    try {
      await s.runTransient(0, STOP, MAX_STEP);
      expect(s.errors).toEqual([]);

      const topo = s.topologyDiff();
      // No element present on one side but not the other (the injected caps are
      // matched by their `capac<n>shunt` label on both sides).
      expect(topo.elementDiffs).toEqual([]);
      // No matched node/branch allocated in a different slot order.
      expect(topo.orderingDiffs).toEqual([]);
      // Element counts agree: original 4 (V1, R1, R2, D1) + 2 injected shunt caps.
      expect(topo.ourElementCount).toBe(topo.ngspiceElementCount);
      expect(topo.ourElementCount).toBe(6);
    } finally { s.dispose(); }
  }, 240_000);
});
