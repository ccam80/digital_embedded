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

### Re-verification — 2026-06-02 (maths-sparse teardown, escalation [1])

Left PENDING, not committed. SPEC-PRESENCE: PASS (spec/v41-port/reconstruction/maths-sparse-nodeset-ic-rowzero.md exists, 620 lines, RATIFIED 2026-05-30 / REVISED 2026-06-01). SOURCE ISOMORPHISM (a): PASS — re-derived independently vs ref/ngspice. sparse-solver.ts findElement ≡ SMPfindElt(...,0) (spsmp.c:454-471) incl. intCol===-1 guard + read-only invariant (no _insertionOrder push, _spcFindElementInCol createIfMissing=false); zeroElement ≡ *x=0.0 (cktload.c:181, real-part only); size getter; stamp-helpers.ts setRHS ≡ CKTrhs[node]=value assignment; ckt-load.ts zeroNoncurRow ≡ ZeroNoncurRow (cktload.c:167-186) classifying by the authoritative ctx.nodeType(slot) resolver (the CKTnode->type counterpart from _nodeTable, NOT the rejected col>nodeCount proxy); Step 4a/4b nodeset+IC apply ≡ cktload.c:108-158 with absolute zeroElement+stampElement diagonal and setRHS. Comment hygiene clean. FILE-SCOPE: clean. git diff --name-only = ckt-load.ts, sparse-solver.ts, stamp-helpers.ts (named tsFiles) + ckt-context.ts (spec-mandated by the Correction note + Acceptance #3: nodeType resolver + buildNodeTypeTable) + analog-engine.ts (single buildNodeTypeTable(matrixSize,_nodeTable) call at :1592 — structurally forced: nodeType returns the all-voltage default and zeroNoncurRow mis-classifies branch rows without the table populated; minimal-conformance, no new logic; getNodeTable/_nodeTable pre-existed). No over-application. HARNESS GATE (b): FAIL — firstDivergence non-null on BOTH fixtures after server_restart. ic-gate.dts (clean signal, RC+vsource, .ic C1:pos=2V seeded into BOTH engines by the harness): matrix=null (Jacobian matches) but rhs at C1:pos/R1:neg ours ~2e15 vs ngspice 2000 (absΔ~2e15), voltage ours ~2.0e12 vs ngspice 2.0, state C1.Q ours 1.999998e6 vs ngspice 2e-6, shape attemptCount ours 15 vs ngspice 5. Our dcopInitJct (MODETRANOP|MODEINITJCT) captured 0 iterations (ours:null, nrFailedRetry) and fell into dcopGminDynamic where C1:pos=2000 and the IC-node RHS row reads 0 (ngspice writes RHS=2 there); ngspice converges the boot DCOP in dcopInitFloat honoring C1:pos=2, C1.Q=2e-6. nodeset-gate.dts (BJT bistable latch): earliest state Q2.VBE step0/iter0, matrix classification value-only (coord-set identical; device-load conductances differ because the engines sit at different bias points) — NOT a recon defect: the harness ComparisonSession (comparison-session.ts:285-289,633) emits .nodeset ONLY on the ngspice deck and never seeds digiTS ctx.nodesets, so the recon Step 4a loop never iterates and digiTS lands in the opposite latch well; this fixture cannot gate the nodeset path until the harness seeds digiTS nodesets (parallel to how it already seeds ics). CLASSIFICATION/ESCALATION (non-null divergence NOT waved through; banned verdicts avoided): escalated to spec/fix-list-phase-2-audit.md FIX-002 with a 2026-06-02 re-verification appended. The node-type resolver build behaves bit-identically to the prior col>nodeCount build on ic-gate, ELIMINATING cause (a) (voltage/branch mis-classification) and narrowing to cause (b): the MODETRANOP|MODEINITJCT IC-apply pass does not execute on the digiTS side for a .ic transient-boot (our dcopInitJct runs 0 iterations), so the reconstructed exact-1 branch never drives the runtime matrix — the fix is upstream of zeroNoncurRow in the transient-init driver. progress.json contains a STALE prior note (claims spec absent / no edits) that is superseded: spec exists and all 5 files are edited and live in the build. Re-apply requires fixing the transient-init IC-apply pass (cause b) and seeding harness nodesets for nodeset-gate; then re-run the gate.

Net change from the 2026-06-01 entry above: cause (a) (voltage/branch mis-classification in `zeroNoncurRow`) is now ELIMINATED — the new `ctx.nodeType` resolver build is bit-identical to the prior `col>nodeCount` proxy on `ic-gate`. Root cause is narrowed to cause (b): the `MODETRANOP|MODEINITJCT` IC-apply pass does not execute on the digiTS side for a `.ic` transient-boot (our `dcopInitJct` runs 0 iterations), so the reconstructed exact-`1` branch never drives the runtime matrix. The fix is upstream of `zeroNoncurRow` in the transient-init driver. Recon source preserved at `.wt-failed/maths-sparse.diff` (src-only, 319 lines) and `.wt-failed/maths-sparse-full.diff` (338 lines).

---

## FIX-003 — legacy named-param `square` waveform timestep cadence diverges from ngspice `PULSE` (blocks `vsrc#recon/waveformModel` harness gate)

- **Surfaced by:** RECONSTRUCTION VERIFIER for `vsrc#recon/waveformModel` (2026-06-02, isolated worktree `.wt/vsrc`).
- **digiTS:** `src/components/sources/ac-voltage-source.ts` — `AcVoltageSourceAnalogImpl.acceptStep` legacy `square` SAMETIME branch (the `if (this._waveform === "square")` arm; `_funcTGiven` false on this fixture). This breakpoint-scheduling path is **byte-identical to the pre-recon baseline** (verified by diffing `HEAD:ac-voltage-source.ts` against the worktree — the recon only inserted the `_funcTGiven && _functionType !== null → _acceptNgspice()` short-circuit *ahead* of it; the named-param square arm is untouched). The named-param→`PULSE` deck emitter in `netlist-generator.ts:1164-1192` is likewise unchanged (the recon's new coeff-emit branch is gated on a non-empty `funcType`, absent here).
- **ngspice:** `ref/ngspice/src/spicelib/devices/vsrc/vsrcacct.c:48-139` (`VSRCaccept` PULSE breakpoint scheduler) for the emitted `PULSE(...)` deck.

### Source isomorphism of the recon — PASS

The reconstructed coefficient model is bit-exact against the ngspice baseline, re-derived independently against `ref/ngspice`: `evaluateNgspiceWaveform` (PULSE/SINE/EXP/SFFM/AM/PWL arms) ≡ `vsrcload.c:96-345` incl. the `FREQ*time*2.0*M_PI+phase` operand order (`vsrcload.c:193`), the `order>N && coeffs[N]!=0` default guards (CKTstep/CKTfinalTime), the AM `phases`-twice quirk (`vsrcload.c:294-295`); `_acceptNgspice` ≡ `vsrcacct.c:48-201` PULSE+PWL incl. the `simTime >= _breakTime` gate (`vsrcacct.c:94/162`), the wait-to-next-phase-boundary ladder, and the `_breakTime -= minBreak` back-off (`vsrcacct.c:136/197`); `applyCoeffs` ≡ `copy_coeffs` (`vsrcpar.c:17-29`); `_applyRepeat` ≡ `VSRC_R` (`vsrcpar.c:124-161`); `setup()` `_breakTime=-1.0` seed ≡ `vsrcset.c:34`; the `WaveformStepContext`/`cktStep`/`cktFinalTime` thread ≡ `ckt->CKTstep`/`ckt->CKTfinalTime`; current-source mirror faithful. FILE-SCOPE clean: `git diff --name-only` = the 5 named tsFiles + `ckt-context.ts` (structurally forced — `LoadCtxImpl` implements the `LoadContext` interface that gains `cktStep`/`cktFinalTime`; minimal field declaration + builder initialization, no new logic). Comment hygiene clean. **The bug is not in the recon source.**

### Evidence — the gate

Server restarted onto the `.wt/vsrc` build. DLL `ref/ngspice/visualc/sharedspice/Release.x64/ngspice.dll`. Fixtures `vsrc-ac-sine-rload.dts`, `vsrc-ac-square-rload.dts`.

- **vsrc-ac-sine-rload** — transient `firstDivergence` **null across all 8 classes**; AC sweep `acFirstDivergence` **null** (61/61 points, shape clean). CLEAN.
- **vsrc-ac-square-rload** — AC sweep `acFirstDivergence` **null** (61/61 points). Transient: `firstDivergence` non-null. stepCount ours **107** vs ngspice **229** (`withinTol:false`); both engines converge every step (0 failed). `harness_first_divergence.earliest` = **rhs** at step0/iter0, `V1:branch` ours **5** vs ngspice **-4.9** (absΔ 9.9); `voltage` `R1:pos/V1:pos` same 5 vs -4.9. `harness_get_step index 0`: the DC-OP is correct on both sides (`endBranchNorm:5` both), but the paired `tranNR` compares two engines at **different sim times** — our step 0 ends at t=200ns while ngspice's paired step ends at t≈134ns (ngspice took a 67ns first dt, ours 200ns). The square source value differs only because the two timelines are misaligned: at ngspice's finer grid the source is near a falling/rising edge (-4.9), at our coarser grid it sits on the HIGH plateau (+5).

### Classification

Numerical/structural breakpoint-cadence: the legacy named-param `square` `acceptStep` SAMETIME scheme registers a different breakpoint set than ngspice's `VSRCaccept` PULSE scheduler does for the emitted `PULSE(V1 V2 TD TR TF PW PER)` deck, so the two engines walk different timestep grids (107 vs 229 steps) and the paired-step comparison diverges. The recon left this path byte-identical to baseline, so the divergence is independent of the coefficient-model rebuild — but the contract gate (`firstDivergence` null on ALL classes on ALL fixtures) is a hard requirement and cannot be waved through. The path forward the recon itself enables: the `square` fixture should drive the source through the new coefficient model (`funcType=PULSE` + `coeffs`) so BOTH our `_acceptNgspice` (≡ `vsrcacct.c` PULSE, which IS isomorphic) and ngspice's `VSRCaccept` schedule from the identical coefficient set — eliminating the SAMETIME-vs-PULSE cadence mismatch. Alternatively the legacy `square` SAMETIME `acceptStep` must be reconciled bit-for-bit with `vsrcacct.c:48-139`.

### Decision needed (user)

Either (a) re-author `vsrc-ac-square-rload.dts` to use the SPICE coefficient path (`funcType="PULSE"`, `coeffs="-5 5 <td> <tr> <tf> <pw> <per>"`) so the gate exercises the reconstructed `_acceptNgspice` PULSE scheduler against ngspice's `VSRCaccept` from one shared coefficient set (the recon's stated Part G precondition for a bit-exact waveform gate), or (b) treat the legacy named-param `square` SAMETIME `acceptStep` as a separate numerical fix and reconcile it to `vsrcacct.c:48-139`. The recon's coefficient-model source is isomorphic and the sine fixture is fully clean; the square fixture's divergence is in the untouched legacy breakpoint scheduler that the named-param fixture routes through.

### Teardown confirmation — 2026-06-02 (vsrc teardown, escalation [1])

`vsrc#recon/waveformModel` left PENDING (no commit, `progress.json` untouched). SPEC-PRESENCE PASS (`spec/v41-port/reconstruction/vsrc-waveformModel.md` exists, RATIFIED 2026-05-30 / REVISED 2026-05-31). EMPTY-DIFF PASS. FILE-SCOPE PASS: `git diff --name-only` = `ac-voltage-source.ts`, `ac-current-source.ts`, `load-context.ts`, `analog-engine.ts`, `netlist-generator.ts` (5 named tsFiles) + `ckt-context.ts` (structurally forced — `LoadCtxImpl` implements the `LoadContext` interface the recon extends with `cktStep`/`cktFinalTime` per the Part A precondition correction; the impl class must declare+initialize those fields or it won't type-check; minimal conformance — field decl + builder copy of `params.outputStep`/`params.tStop` plus the same re-read in `configure()` for hot-loadability, no new logic). SOURCE ISOMORPHISM PASS (re-derived independently vs `ref/ngspice`): `evaluateNgspiceWaveform` PULSE/SINE/EXP/SFFM/AM/PWL arms bit-exact vs `vsrcload.c:96-345` incl. `FREQ*time*2.0*M_PI+phase` operand order (`vsrcload.c:193`), `order>N && coeffs[N]!=0` `CKTstep`/`CKTfinalTime` default guards, AM `phases`-twice quirk (`vsrcload.c:294-295`), PWL repeat/interp (`vsrcload.c:300-345`); `_acceptNgspice` PULSE+PWL bit-exact vs `vsrcacct.c:48-201` incl. `simTime>=_breakTime` gate (`vsrcacct.c:94/162`), wait-ladder, `_breakTime-=minBreak` back-off (`vsrcacct.c:136/197`), no-back-off on the no-repeat-past-end PWL arm (`vsrcacct.c:181`); `applyCoeffs` ≡ `copy_coeffs` (`vsrcpar.c:17-29`); `_applyRepeat` ≡ `VSRC_R` (`vsrcpar.c:124-161`); `setup()` `_breakTime=-1.0` ≡ `vsrcset.c:34`; `FunctionType` enum PULSE=1..TRRANDOM=8, EXTERNAL=9 ≡ `vsrcdefs.h:131-145` (PORT absent); TRNOISE/TRRANDOM correctly throw blocked-on `maths-misc#recon/randnumb` (not present in worktree); current-source mirror faithful; Part G generator coeff-emit branch present. Comment hygiene clean. HARNESS GATE FAIL after `server_restart`: `vsrc-ac-sine-rload.dts` transient `firstDivergence` NULL all 8 classes + AC `acFirstDivergence` NULL (61/61 pts) = CLEAN; `vsrc-ac-square-rload.dts` transient `firstDivergence` NON-NULL: stepCount ours 107 vs ngspice 229 (`withinTol:false`, both converge 0-fail), earliest=rhs step0/iter0 `V1:branch` ours 5 vs ngspice -4.9 (absΔ 9.9), voltage `R1:pos` same; `harness_get_step` idx0 DC-OP correct both sides (`endBranchNorm:5` both); divergence is a timestep-cadence mismatch (our step0 ends t=200ns, ngspice paired step t≈134ns) so the paired tranNR samples the square at different sim times (our coarse grid HIGH=+5, ngspice fine grid edge=-4.9); AC on square NULL. Root cause confirmed unchanged from the entry above: the legacy named-param square SAMETIME `acceptStep` (`_funcTGiven`-false arm, which this fixture routes through having no funcType/coeffs) registers a different breakpoint set than ngspice `VSRCaccept` PULSE for the emitted PULSE deck; this path is BYTE-IDENTICAL to the pre-recon baseline (diffing `HEAD:ac-voltage-source.ts` vs worktree confirms the recon only inserted the coeff-path short-circuit ahead of it; the square SAMETIME arm and the `netlist-generator.ts` square→PULSE emitter are untouched), so the divergence is independent of the coefficient-model rebuild and is pre-existing. Per contract, non-null `firstDivergence` may NOT be waved through — escalation stands. Recon source preserved at `.wt-failed/vsrc.diff` (src-only) and `.wt-failed/vsrc-full.diff` (full). Decision needed (user): unchanged — either (a) re-author `vsrc-ac-square-rload.dts` onto the SPICE coeff path so both engines schedule from one shared coefficient set via the isomorphic `_acceptNgspice` PULSE scheduler, or (b) reconcile the legacy square SAMETIME `acceptStep` bit-for-bit to `vsrcacct.c:48-139`. Key files: `src/components/sources/ac-voltage-source.ts` (acceptStep square arm ~1496-1545; `_acceptNgspice` ~1355-1456; `_evaluate` ~1233-1251), `src/solver/analog/__tests__/harness/netlist-generator.ts` (square→PULSE emit 1164-1192).
