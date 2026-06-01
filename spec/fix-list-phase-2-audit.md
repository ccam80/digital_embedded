# Phase-2 Audit — Numerical Fix List

Numerical (not architectural) parity divergences surfaced during the v41-port
verification loop. Each item is a genuine arithmetic-order or structural
divergence against ngspice at the bit-exact bar; none are "tolerance" /
"pre-existing" wave-throughs. Items here block the harness gate of the recon
that surfaced them until resolved.

---

## FIX-001 — BJT DC operating-point junction-solve arithmetic-order floor (blocks `bjt#recon/stampAc` harness gate)

- **Surfaced by:** RECONSTRUCTION VERIFIER for `bjt#recon/stampAc` (2026-05-30).
- **digiTS:** `src/components/semiconductors/bjt.ts` — `createSpiceL1BjtElement` `load()` (the BJT junction exp/log operating-point Newton solve that writes the `VBE` / `GPI` / `GMU` / `GM` / `GO` / `GX` state slots). The recon's new `BjtL1Element.stampAc` only *reads* these slots; it does not introduce the divergence.
- **ngspice:** `ref/ngspice/src/spicelib/devices/bjt/bjtload.c` (junction current/conductance evaluation) feeding `bjtacld.c::BJTacLoad`.

### Evidence

Harness gate run on the two task fixtures
(`src/solver/analog/__tests__/ngspice-parity/fixtures/bjt-common-emitter.dts`,
`bjt-bistable-latch.dts`), DLL `ref/ngspice/visualc/sharedspice/Release.x64/ngspice.dll`.

**AC sweep** (`harness_run_ac` — exercises the new `stampAc`):

| fixture | class | cell | ours | ngspice | absDelta | relDelta |
|---|---|---|---|---|---|---|
| common-emitter | matrix (re, im=0 both) | row 2, col 1 @ 1 Hz | -1.3866230645868108e-12 | -1.3866230646249369e-12 | 3.81e-23 | 2.75e-11 |
| bistable-latch | matrix (re, im=0 both) | row 1, col 2 @ 1 Hz | 0.15015689031346008 | 0.15015689031346113 | 1.05e-15 | 7.02e-15 |

The divergence is **purely in the real part** (every imaginary susceptance cell
matched bit-exact — i.e. the recon's `stampElementImag` ωC stamps are clean).
Shape clean: 61/61 AC points present both sides, no frequency deltas.

**Transient** (`harness_run` — does NOT touch `stampAc`, exercises `load()` only):
both fixtures, 107/107 steps converged both engines, stepCount delta 0,
avgIterations 2.047 both. `harness_first_divergence` `earliest` is the **state**
class at step 0 / iter 0:

| fixture | earliest attribute | ours | ngspice | absDelta |
|---|---|---|---|---|
| common-emitter | Q1.VBE | 0.6928875984089286 | 0.6928875984089307 | 2.11e-15 |
| bistable-latch | Q2.VBE | 0.6902044442373514 | 0.6902044442373494 | 2.00e-15 |

The transient matrix cell `(R_B:pos/R_C:pos/V_CC:pos, Q1:B/R_B:neg)` is the SAME
~1.386623e-12 near-zero cell that diverges in the AC run, at the SAME floor —
confirming the AC real-part matrix divergence is the downstream image of the
operating-point `VBE` divergence carried through the state slots, NOT a fault in
the recon's stamp.

### Classification

Genuine arithmetic-order divergence in the BJT junction exp/log Newton solve
(~10× f64 epsilon on `VBE`, ~3e-15 relative). It is present in the transient
path that never calls the recon's `stampAc`, so it is upstream of and
independent of `bjt#recon/stampAc`. It is NOT transcendental-shim ULP noise
(that floor was eliminated 2026-05-13). Root cause to locate: the per-device
`load()` accumulation order / junction evaluation sequence in `bjt.ts` vs
`bjtload.c` (the exp/log argument assembly and the gpi/gmu/gm/go derivation
order), per CLAUDE.md's "look upstream" directive for a bit-identical-matrix
1-ULP class.

### Decision needed (user)

Locate and close the `VBE` operating-point arithmetic-order divergence in the
BJT `load()` junction solve so the `bjt#recon/stampAc` harness gate goes null
across all classes. The recon source itself is isomorphic to the `bjtacld.c`
v26 baseline (verified independently) and its imaginary stamps are bit-exact;
only the inherited real-part floor blocks the gate.

---

## FIX-002 — nodeset/IC exact-`1` pure-voltage constraint not applied at runtime (blocks `maths-sparse#recon/nodesetIcRowZero` harness gate)

- **Surfaced by:** RECONSTRUCTION VERIFIER for `maths-sparse#recon/nodesetIcRowZero` (2026-06-01, via the A2 isolated loop).
- **digiTS:** `src/solver/analog/ckt-load.ts` — `cktLoad` Step 4a nodeset apply + Step 4b IC apply (and the `zeroNoncurRow` helper they call).
- **ngspice:** `ref/ngspice/src/spicelib/analysis/cktload.c:108-158`; `ref/ngspice/src/maths/sparse/spsmp.c:454-471`.
- **Recon source preserved at:** `.wt-failed/maths-sparse.diff` (the worktree was captured + destroyed on the gate fail; not committed; ledger stays PENDING).

### Source isomorphism — PASS (the port is correct; the divergence is at RUNTIME)

Re-derived independently against `ref/ngspice`: `findElement` (`sparse-solver.ts`) ≡ `SMPfindElt(...,0)` incl. the `intCol===-1` guard + read-only invariant (no `_insertionOrder` push); `zeroElement` ≡ `*x=0.0` (real-part only); `size` getter; `setRHS` (`stamp-helpers.ts`) ≡ `CKTrhs[node]=value` assignment; `zeroNoncurRow` ≡ `ZeroNoncurRow` (`col>nodeCount` as the `SP_CURRENT` counterpart); nodeset/IC apply ≡ `cktload.c:108-158`. Comment hygiene clean. **The bug is not in the source.**

### Evidence — the exact-`1` branch is not reached at runtime

`ic-gate.dts` (capacitor + resistor + vsource — isolates the IC mechanism, no BJT confound) is **decisive**. Topology identical (`topology_diff` empty, matrixSize 3=3 — numerical, not structural):

| phase | ngspice | ours |
|---|---|---|
| `dcopInitJct` (`MODETRANOP\|MODEINITJCT`) iter0, C1 IC node | diag=1, RHS=2, V=2.0V, C1.Q=2e-6 (exact pure-voltage pin) | **no captured `dcopInitJct` iteration** (iterationCount 0, outcome `nrFailedRetry`) |
| `tranInit`, C1 node | V=2.0V, Q=2e-6, rhs row=2000 | V≈2.0e12, Q≈2.0e6, rhs row≈2e15 |

ours behaves as if the **1e10 soft-pin path is still active** (1e10·ic·srcFact RHS ÷ near-unity diagonal) — the reconstructed pure-voltage `1·v=value` branch never drives the runtime matrix. `harness_run` passed 0/107. (`nodeset-gate.dts` — BJT bistable — also fails, earliest `state` Q2.VBE step0/iter0, but that confounds FIX-001's BJT floor with the unapplied nodeset; `ic-gate` is the clean signal.)

### Classification

Numerical/runtime: an isomorphic stamping mechanism that does not execute. Likely causes to investigate (harness-first): (a) `zeroNoncurRow` returning `currents=true` for the pure-voltage cap node (a voltage column mis-classified as a branch column → wrong branch taken); (b) the `MODETRANOP|MODEINITJCT` IC-apply pass not running on our side at all for a `.ic` transient-boot (our `dcopInitJct` captured **0** iterations) — an engine init-pass gap upstream of the apply; (c) the `nodesetHandles`/`icHandles` diagonal handle not addressing the same cell `findElement`/`zeroElement` see. **Next probe:** `harness_matrix_diff` on the C1 row at the IC-apply iteration, and confirm whether our transient-init runs a `MODETRANOP|MODEINITJCT` pass for an IC circuit at all.

### Decision needed (user)

Resolve why the reconstructed exact-`1` nodeset/IC constraint does not reach the runtime matrix so the `maths-sparse#recon/nodesetIcRowZero` harness gate (`ic-gate.dts`, `nodeset-gate.dts`) goes null. The source is isomorphic; the gap is in which init-pass runs and which matrix row it writes.
