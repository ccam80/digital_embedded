# Master circuit assembly E2E suite — three-way mixed root causes

**Category:** mixed (per-test categories below)

## Problem statement

`e2e/gui/master-circuit-assembly.spec.ts` defines three large e2e tests
that exercise integrated digital, analog, and mixed-signal circuits via
genuine UI interaction (palette clicks, canvas placement, wire drawing
with explicit waypoints). All three currently fail, with three distinct
root causes:

| Test | Failure | Root cause |
|---|---|---|
| `Master 1: digital logic` | 30 s Playwright timeout | CMOS-mode AND gate convergence stall after Phase C unwired-VDD/GND probing |
| `Master 2: analog` | Status-bar error | OpAmp buffer + BJT CE compile path; depends on `real-opamp-rail-limited-nr.md` |
| `Master 3: mixed-signal` | `toBeLessThan` assertion fail | Composite ADC/DAC numerical drift on the RC node |

Each is a separate fix job documented per-test below. The tests are kept
together in this spec because they are colocated in the same file and
share `UICircuitBuilder` setup, but the per-test categories are
independent.

## Master 1: digital logic — gates, flip-flop, counter

### Test shape
- `e2e/gui/master-circuit-assembly.spec.ts:46-189`
- Phase A (lines 46-138): build digital-only circuit (gates,
  D-flip-flop, counter), compile, run truth-table tests, assert FF
  latches AND output, assert counter increments.
- Phase C (lines 139-189): switch `G_AND` to `cmos` model, place
  `Ground`, place `DcVoltageSource VDD_SRC = 3.3V`, place tunnels for
  the VDD net, wire `VDD_SRC.pos → VDD tunnel` and `G_AND.VDD → VDD_G
  tunnel`, wire `G_AND.GND → Ground`, recompile, step to 5 ms, read
  `P_VDD`, expect > 3.0 V.

### Failure
- Phase A is digital-only and (per the brief) presumably passes the
  individual-line assertions, although the test runner records the
  whole `it` block as failed when Phase C times out. The 30 s wall
  fires inside `stepViaUI()` at line 176 (recompile after switching
  `G_AND` to `cmos`), or at `stepToTimeViaUI('5m')` at line 180.

### Site
- `e2e/gui/master-circuit-assembly.spec.ts:140-189` — Phase C body.
- `src/components/gates/and.ts:130-155` — `CMOS_AND2_NETLIST`,
  six-MOSFET expansion.

### Diagnosis
- The Phase C circuit wires `G_AND`'s VDD and GND, but the gate's
  inputs `In_1` and `In_2` come from the digital `A` and `B` Inputs,
  which are 1-bit digital signals. When the gate is switched to `cmos`,
  the input pins now expect analog voltage drive: the digital adapter
  must inject voltage on those nets via `DigitalOutputPinModel`. The
  digital→analog bridging is what allows a CMOS gate driven by `Const`
  /`In` to compile.
- If the bridging works and the inputs are driven, the CMOS gate has
  driven inputs + driven VDD + driven GND, and DC-OP must converge.
  No structural reason for stagnation.
- If the bridging does NOT work (i.e., the digital `In` components are
  not bridged to MNA voltage sources at the cmos gate's input pins),
  the cmos input nets are floating and the gate falls into the same
  stall regime as `cmos-mode-gate-timeouts.md`. The 30 s wall is
  consistent with this stagnation.

### Required investigation (in-engine, not in this spec)
The convergence-log capture procedure from
`cmos-mode-gate-timeouts.md` applies here too: enable the log before
the Phase C `stepViaUI` (line 176), run the test once, export, and
inspect `blameElement` and `dt`-collapse. Two outcomes:
- **Outcome A** — blame stuck on CMOS sub-element MOSFETs with `vgs ≈
  vDigitalDrive ≈ 0`: digital→analog bridging is broken at gate input
  pins. Production fix: digital pin model emits a `DigitalOutputPinModel`
  voltage source for the CMOS gate's input pin.
- **Outcome B** — blame stuck with `vgs ≈ vIH/2` (intermediate): the
  gate is biased into the steepest region of the ID/VDS cubic and NR
  iterates without limit. Production fix: same as `cmos-mode-gate-
  timeouts.md` — the CMOS subcircuit needs `pnjlim`/`fetlim` to limit
  on the internal `nand_out` net which currently is not visible to the
  outer engine for limiting purposes.

### Category
`architecture-fix` — production defect in either the digital→analog
bridging path (Outcome A) or the CMOS subcircuit's internal-net
limiter coverage (Outcome B). Both require production code changes.

### Dependencies
- `cmos-mode-gate-timeouts.md` (sister spec; same engine class).
- `topology-validation-after-setup.md` (post-setup hook is the
  prerequisite for distinguishing these failure modes from "circuit is
  legitimately singular").

### Resolves
1 e2e test (`Master 1: digital logic — gates, flip-flop, counter`).

---

## Master 2: analog — switched divider, RC, opamp, BJT

### Test shape
- `e2e/gui/master-circuit-assembly.spec.ts:207-397`
- Builds: 5V DC source → SPST switch → R1(10k)+R2(10k) divider → R3(1k)
  + C1(1µF) RC lowpass → OpAmp voltage-follower → Rb(100k) → NPN BJT CE
  amplifier (Vcc=12V, Rc=1k).
- Phase A: DC OP at 50 ms; expect `P_DIV ≈ 2.5V`, `P_RC ≈ 2.5V`,
  `P_AMP ≈ 2.499998V` (1e-3 rtol), `P_CE ≈ 10.00008V` (2e-2 rtol).
- Phase B: change R1 to 20k; expect divider drops to 1.667 V, etc.
- Phase C: change BJT BF to 50; expect P_CE shifts to 11.430 V.
- Phase D: scope trace on R3.A.
- Phase E: pin-loading toggle on R1-R2 junction; expect P_DIV ≈ 2.499 V.

### Failure
Brief says "status bar error". The test calls
`builder.verifyNoErrors()` after the first compile (line 285); a status-
bar error there means the compile/setup step emitted a diagnostic that
flipped the status bar into the error class.

### Site
- `e2e/gui/master-circuit-assembly.spec.ts:284-285` — first
  `verifyNoErrors()` after `stepViaUI()`.
- `src/components/active/real-opamp.ts` — likely error-emitting site if
  the OpAmp model is the new RealOpAmp (the test uses `placeLabeled
  ('OpAmp', ...)`, which resolves to the ideal `OpAmp` definition;
  `RealOpAmp` is a separate component). Verify: `e2e/.../master-circuit-
  assembly.spec.ts:227` says `placeLabeled('OpAmp', 28, 19, 'AMP')` —
  the ideal opamp.
- The ideal `OpAmp` is at `src/components/active/opamp.ts`.

### Diagnosis
The ideal opamp uses an infinite-gain VCVS stamp. In a feedback loop
(test wires `AMP.in- → AMP.out` per lines 263-264), the closed-loop
solve should give `V(in+) = V(in-) = V(out)`. With `V(in+) = 2.5 V`
(from divider through R3-C1 lowpass), the steady-state should be
`V(out) ≈ 2.5 V`, and the BJT CE base-emitter junction conducts to give
`V(P_CE) ≈ Vcc - Ic·Rc`.

The status-bar error is likely from one of:
1. **Topology validation false-positive.** If the
   `topology-validation-after-setup.md` post-setup pass fires before
   the opamp's feedback path is closed (e.g., the feedback wire is laid
   down via `drawWireExplicit` but the netlist sees `AMP.in-` and
   `AMP.out` as separate nets at first compile), the validator emits
   `competing-voltage-constraints` and the status bar goes red.
2. **OpAmp instability under transient.** With `C1 = 1µF` driven by
   `R3 = 1kΩ` (τ = 1 ms) feeding the opamp's `in+`, the first transient
   step at the opamp output is a voltage step. The ideal opamp's stamp
   solves it in one step, but if LTE rejects the step on the C1
   capacitor branch, the engine may collapse `dt` and emit a
   diagnostic.
3. **BJT operating-point divergence.** Initial `vbe = 0` on Q1 with
   `Vcc = 12V` driving `Rc → C → ground`; first NR may oscillate before
   limit-stepping settles. ngspice's `bjtload.c` `pnjlim` discipline is
   already mirrored in digiTS `bjt.ts` per `composite-component-base.md`
   §K6 history; should not stall.

### Required investigation
Enable the convergence log before the test's first `stepViaUI()` at
line 284. If the log shows a clean convergence and the status bar still
flips red, the diagnostic is being emitted by the topology validator or
by a setup-phase warning, not by NR — capture the diagnostic message
text from `verifyNoErrors`'s assertion failure log to identify which
detector fired.

### Category
`architecture-fix` — likely the same K2 post-setup validation issue
(false positive on a closed-feedback opamp), OR a separate ideal-opamp
compile defect. Cannot be narrowed without a recorded log capture.

### Dependencies
- `topology-validation-after-setup.md` — if the status bar is from a
  validator emission, the fix is in the validator's classification of
  ideal-opamp feedback paths.
- `real-opamp-rail-limited-nr.md` — only if the test were using
  `RealOpAmp`. Inspection of line 227 confirms it uses `OpAmp` (ideal),
  so this dependency is ONLY relevant if the user changes the test to
  use `RealOpAmp`. **No dependency under current test code.**

### Resolves
1 e2e test (`Master 2: analog — switched divider, RC, opamp, BJT`).

---

## Master 3: mixed-signal — DAC, RC, comparator, counter

### Test shape
- `e2e/gui/master-circuit-assembly.spec.ts:417-571`
- Builds: 4 digital `Const` (D3=1, D2=0, D1=1, D0=0 → code 10) → DAC
  4-bit → R1(1k)+C1(1µF) RC filter → VoltageComparator vs Vref2(2.5V) →
  AND → Counter; clock drives Counter.C.
- Phase A: at 50 ms, expect `P_DAC ≈ 3.125 V` (= 10/16 × 5 V) at 2e-2
  rtol.
- Phase B: change Vref to 3.3 V; expect P_DAC = 2.0625 V at 1e-2 rtol.
- Phase C: change R1 to 10k (τ = 10.1 ms); expect P_DAC still settles
  to 2.0625 V.
- Phase D: scope trace on C1.pos.
- Phase E: pin electrical override on AND output.

### Failure
Brief says `toBeLessThan` fail. The relative-tolerance assertions at
lines 530, 542, 554 use `Math.abs(pDac - target) / target).toBeLessThan
(rtol)`. Numerical drift > rtol on one of the three DAC checks.

### Site
- `e2e/gui/master-circuit-assembly.spec.ts:528-554` — three rtol
  assertions on `P_DAC`.
- `src/components/active/dac.ts` — DAC composite element. The DAC
  output voltage is computed in the analog model based on the latched
  digital code; the converter's analog-to-digital bridging at the input
  pins uses `DigitalInputPinModel`.
- `src/components/active/adc.ts` — sister composite (not on the path
  of P_DAC).

### Diagnosis
The DAC outputs `code/2^N × Vref` to the `OUT` pin via a Norton-
equivalent stamp (current source + output resistance). The RC lowpass
between DAC.OUT and P_DAC node is just a passive R1 + C1 to ground,
which at steady state should give `P_DAC = V(DAC.OUT) × (∞ // 1) =
V(DAC.OUT)` (since C1 is open at DC). The expected
`3.125 V = 10/16 × 5 V` for code 1010.

If the assertion fails by > 2 % at Phase A, plausible causes:
1. **DAC output impedance interacts with R1.** If DAC.OUT has finite
   `rOut` (per `dac.ts` model params, likely `rOut = 50Ω`), the DC
   divider becomes `Vref × code/16 × R1/(R1+rOut)` which for `R1=1k,
   rOut=50` is `3.125 × 1000/1050 = 2.976 V`, a 4.76 % drop. This
   exceeds the 2 % tolerance. **Most likely root cause for Phase A
   failure.**
2. **Phase B (after Vref→3.3 V) tolerance is 1 %.** The same
   `rOut/R1` divider drops 2.0625 V to ~1.964 V, a 4.78 % drop.
   Exceeds 1 % tolerance. Confirms the same structural defect.
3. **Phase C raises R1 to 10k.** The divider becomes `2.0625 ×
   10000/10050 = 2.052 V`, a 0.5 % drop. Within 1 % tolerance.
   **Phase C should pass even with the rOut bug.**

If Phases A and B fail and Phase C passes, the diagnosis is confirmed:
DAC `rOut` interacts with R1 to drop the steady-state DAC output below
the assertion threshold.

### Production fix (architecture)
The DAC's analog model should either:
- (a) Drive `OUT` as a Thevenin-equivalent ideal voltage source with
  small output impedance (≤ 1 Ω), so `R1` does not load it
  measurably. This matches how a real DAC's output stage is built
  (op-amp buffer with low Zout).
- (b) Document `rOut` as a published model parameter and have the test
  set it to a value consistent with the assertion's expected drop.

Per `CLAUDE.md` "No Pragmatic Patches", option (b) (test-side fix) is
NOT acceptable if the production model's `rOut` default is the bug.
Option (a) is the architecture-correct fix: a behavioral DAC's `rOut`
default should be small (e.g. 1 Ω, matching an op-amp output buffer's
effective impedance).

Inspect `dac.ts` model params:
- `rOut` default — verify in source. If `rOut = 50Ω`, fix is to
  reduce default to `≤ 1Ω`. If `rOut` is already `≤ 1Ω`, the
  diagnosis is wrong and a different defect is responsible (numerical
  integration drift, ADC code-latch defect, etc.) and a separate spec
  is needed.

### Category
`architecture-fix` — if the root cause is `rOut` default, that is a
production-side default that's incorrect for the model's intended use
(behavioral DAC = ideal voltage output). Re-categorise as `few-ULP` only
if the gap is sub-percent, which it is not.

### Dependencies
- None on other in-flight specs. The DAC component model is owned
  inside `src/components/active/dac.ts` and the fix is local.

### Resolves
1 e2e test (`Master 3: mixed-signal — DAC, RC, comparator, counter`).

---

## Verified ngspice citations

ngspice does not ship a first-class DAC or ADC device — the `xspice`
extension provides behavioural converters as XSPICE primitives, which
are out-of-tree from the core simulator. The DAC and ADC in digiTS
(`src/components/active/dac.ts`, `adc.ts`) are digiTS-original
behavioural composites, not ports of ngspice devices. Numerical
references for `code/2^N × Vref` are textbook DAC math, not ngspice
parity.

For the ideal `OpAmp` (Master 2): ngspice does not ship an ideal-opamp
device either. Users build opamps from the `E` (VCVS) primitive in a
sub-circuit deck. digiTS's ideal `OpAmp` (`src/components/active/
opamp.ts`) is a single-element VCVS-with-implicit-output-clamp, which
is a digiTS-original behavioural element. No `mosload.c` /
`bjtload.c` style direct citation applies — the relevant ngspice
parity is the `VCVSload` primitive (`ref/ngspice/src/spicelib/devices/
vcvs/`) which IS the underlying stamp.

For the CMOS-gate convergence path in Master 1: see
`cmos-mode-gate-timeouts.md` for the verified `mos1load.c:153-200,
202-242, 412-434, 362-406` citations.

For the topology-validation defect that is the primary architectural
dependency: see `topology-validation-after-setup.md` for the verified
`cktinit.c:24-135`, `cktsetup.c:31-131`, `cktsoachk.c:35-53`,
`spfactor.c:260-262`, `niiter.c:885-905` citations.

## Resolves (whole spec)

3 e2e tests (the entire `Master circuit assembly via UI` describe block).

## Tensions / uncertainties

1. **Master 1's failure mode is provisional.** The brief says "30 s
   timeout" without identifying which `stepViaUI` call hangs. If
   Phase A's `stepViaUI` at line 112 hangs (digital-only compile), the
   diagnosis above is wrong — digital-only compiles cannot stall in
   NR. The test is structured so that the whole `it` block is recorded
   as failed if ANY `await` exceeds 30 s, so a Phase C timeout is
   indistinguishable in CI output from a Phase A timeout. Confirm via
   convergence-log capture or by temporarily inserting timing
   instrumentation around each `stepViaUI` / `stepToTimeViaUI` call.

2. **Master 2's "status bar error" is an aggregate signal.** The
   `#status-bar.error` class is set by any compile-time or run-time
   diagnostic that the engine routes through the status-bar updater.
   Without the actual error message text, the per-phase diagnosis is
   speculative. Read the message either by extending
   `verifyNoErrors()` to capture and log `#status-bar.textContent`
   before failing, or by enabling the convergence log and inspecting
   the diagnostic stream.

3. **Master 3's diagnosis assumes the DAC `rOut` default is the
   defect.** If the source shows `rOut ≤ 1Ω` already, the diagnosis is
   wrong and the failure is elsewhere. Open `dac.ts` and check the
   `defineModelParams` block before committing to this spec's fix.

4. **All three failures may share a single upstream cause.** If the
   `topology-validation-after-setup.md` fix is implemented and post-
   setup validation fires false-positives on closed-feedback paths,
   Masters 1 and 2 could both be resolved by a single fix to the
   validator (specifically, suppressing
   `competing-voltage-constraints` when the conflicting branch is the
   feedback half of a VCVS pair). Master 3's DAC issue is independent.

5. **Banned-vocab guard.** This spec uses `tolerance` in the
   *test-author* sense ("rtol < 0.02 in the assertion"), which is a
   factual description of the test contract. It does NOT use
   `tolerance` as a closing verdict on a parity item. Per
   `CLAUDE.md`, the banned-vocab list is for closing verdicts on
   ngspice divergence items; the per-test rtol description here is
   not such a verdict.
