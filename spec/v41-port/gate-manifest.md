# v41 Port — Harness Gate Manifest (bootstrap order + per-device gate fixtures)

**Purpose.** The port-loop driver verifies each device with the ngspice parity
harness (`harness_start` → `harness_run`/`harness_run_ac` → `harness_first_divergence`;
pass = `firstDivergence` null across all signal classes — `VERIFICATION.md §1a`).
A device gate is **sound only if every *other* component in the gate circuit is
already verified bit-exact** — otherwise a divergence can't be attributed. This
file fixes (a) the **bootstrap order** devices are ported/verified in, and (b) the
**exact gate fixtures** for each device, where every fixture contains only
`{the device under test} ∪ {devices in a lower, already-verified tier}`.

The driver consumes this file for device ordering and per-device gate selection.
It is a frozen planning input (like `analysis-scope.md` / `device-class-scope.md`);
agents amend it only on user approval.

## The scope rule (non-negotiable)

> A device may be gated only by circuits whose every other component is in a
> strictly lower tier that has already passed its own gate. The single
> unavoidable exception is the **root pair** (Tier 0), where the voltage source
> and the resistor are co-validated on the first pure-resistive circuit because
> neither can be exercised without the other.

## Source split (digiTS ≠ ngspice 1:1)

ngspice's `vsrc`/`isrc` each map to **two** digiTS components plus a waveform set:
- `vsrc` → `DcVoltageSource` **and** `AcVoltageSource` (the latter carries the
  transient waveforms `square`/`sine`/`pulse`/… and the AC small-signal stimulus).
- `isrc` → `DcCurrentSource` **and** `AcCurrentSource`.

Each waveform is a **sub-feature** that must be verified on a lower-tier load
*before* any gate that drives a higher device with it. Concretely:
`rc-transient` is driven by `AcVoltageSource{waveform:"square"}`, so the square
waveform must pass a `vsrc`-tier gate before `rc-transient` can soundly gate `cap`.

`ground` nodes (`Ground [digital]`) are the reference, not a device to verify.

## Fixture-authoring findings (2026-05-30, verified via MCP build + harness smoke-test)

1. **Pipeline proven.** build → save → `harness_start` → `harness_run` works on a
   freshly-authored fixture with `Release.x64/ngspice.dll`: `isrc-dc-rload` and
   linear `vccs-gate` each run **107/107 steps bit-exact** (`firstDivergence`
   null). The generator emits `DcCurrentSource` and linear `E/F/G/H` controlled
   sources; these trivial cases already match (no v26→v41 delta pre-port).
2. **Single-source circuits are degenerate** (floating output pin) — sources gate
   on a minimal source + verified-load circuit (the root co-validation).
3. **Controlled sources & the B-source — all harness-parity-gated.** The generator
   TODAY emits only the linear controlled-source form (a constant gain on the
   `E/F/G/H` element line) and rejects an arbitrary expression ("non-linear
   expressions cannot be emitted bit-exact"). **That rejection is a current
   generator limitation, not the design endpoint.**
   - `vccs`/`vcvs`/`cccs`/`ccvs` with a **constant gain** → ngspice `E/F/G/H`,
     harness-gated now (confirmed: linear `vccs-gate` emits + matches 107/107).
   - **`asrc` (ngspice B source) is IN scope** (`device-class-scope.md`) and is
     ported to ngspice-equivalence and **harness-parity-verified** (freeze #19:
     complete B-source function set via the shared `expression-evaluate.ts` port).
     An arbitrary expression source is **NOT** self-compared — it is **flipped to
     its ngspice B-source equivalent** for the deck. This requires extending
     `netlist-generator.ts` with a behavioral-source emitter (digiTS expression →
     ngspice `B n+ n- V=<expr>` / `I=<expr>`, with the expression grammar
     translated to ngspice's). That generator extension **is part of the asrc port
     (#19)**; the asrc gate is a real harness gate once it + the digiTS B-source
     evaluator land. Expression-based controlled sources route the same way (→ B
     source), not self-compare.
   - `createSelfCompare` is reserved for genuinely digiTS-only features with **no**
     ngspice counterpart — never for an in-scope device like asrc.

## "Already-applied" devices — complete, but gate-blocked on vsrc (NOT pre-verified anchors)

Per the ledger, `cap` (14 APPLIED / 0 PENDING) and `ind` (25 / 0) are
**device-complete** — recons APPLIED, every non-NC hunk APPLIED; `mut` is folded
into `ind.md` and likewise complete. So they need **no re-porting**.

But they are **not usable anchors yet**, and re-gating them now is premature:
every reactive/AC fixture is **vsrc-driven**, and `vsrc` is unported (0 APPLIED /
28 PENDING). Confirmed 2026-05-30 (5 ms runs): `cap`/`rc-transient` (square
`AcVoltageSource`) diverges 107 vs 219 steps and `mut`/`transformer-coupled-built`
364 vs 344 — the divergence is the **unverified source**, not the device. `ind`
re-gated clean (107/107) only because `inductor-rl-step` is DC-*step*-driven (the
trivial vsrc case). This is the bootstrap rule firing: a device can't be gated on
an unverified source.

**Consequence:** cap/ind/mut re-gate clean automatically once `vsrc` (and its AC
waveforms) is verified, in the normal bootstrap order — there is no separate
"anchor confirmation" step. Until vsrc is verified, treat them as "complete,
gate-pending-vsrc," not as a trusted foundation.

## Engine-first (overrides "engine last")

A device gate compares per-NR-iteration matrix / RHS / solved values, so it is
only meaningful on a **v41 engine**. If the NR loop, integration, limiting,
gmin/source-stepping, or the DC-OP/transient/AC driver is still v26, every device
gate diverges from v41 ngspice for reasons that have nothing to do with the
device — the engine delta confounds the device delta. **Therefore the engine is
ported first** (this overrides `TASK.md §4`'s placeholder "engine last").

The engine has no pure standalone fixtures — it is exercised through circuits.
So the engine and the **root foundation** are co-validated on the smallest
circuits, each engine driver gated by the simplest fixture that exercises it:
- **DC-OP driver + sparse solve + NR + DcVoltageSource** → co-validated on
  `vsrc-dc-only` (2 unknowns: engine-core + DC source), then `res` localized on
  `resistive-divider`.
- **transient driver + integration** → re-validated when the first reactive
  device (`cap`/`ind`) comes online (Tier 2 RC/RL fixtures).
- **AC driver** → re-validated on the `*-ac` fixtures (Tier 2).
- **engine reconstructions** (`nodesetIcRowZero`, `tf`) → dedicated fixtures,
  gated as soon as their prerequisite devices (`vsrc`/`res`) are verified.

### Tier E — engine (applied first; gated through the root + first-reactive fixtures)
| Subsystem / recon | What | Gate fixture | Status |
|---|---|---|---|
| analysis (PENDING) | DC-OP (`cktop`/`dcop`), transient (`dctran`/`traninit`/`transetp`/`cktsetbk`/`ckttrunc`), AC drivers | `vsrc-dc-only` (DC-OP); cap/ind RC-RL (transient); `*-ac` (AC) | gated via device fixtures |
| maths-ni (PENDING) | Newton iteration / convergence | `vsrc-dc-only` + every later gate | gated via device fixtures |
| include-ngspice (PENDING) | CKTepsmin + the engine-relevant `cktdefs`/`cktntask`/`cktsopt` bits | `vsrc-dc-only` + later gates | gated via device fixtures |
| `maths-sparse#recon/nodesetIcRowZero` | ZeroNoncurRow nodeset/IC stamping | gateKind=`harness`; `nodeset-gate.dts` (`.nodeset` DC-OP) + `ic-gate.dts` (`.ic` transient-boot) | RUNNABLE (harness) — input surface exists |
| `analysis#recon/tf` | `.tf` transfer-function driver | `tf-gate.dts` | ＋AUTHOR |
| `maths-misc#recon/randnumb` | deterministic CombLCGTaus RNG | **self-compare** — gateKind=`self-compare`, gateFixtures=[`src/solver/analog/__tests__/monte-carlo.test.ts -t SeededRng`] (the `SeededRng` describe block ONLY — the recon's own RNG-algorithm tests). The `MonteCarloRunner`/`ParameterSweepRunner` integration tests in the same file are a DIFFERENT feature and carry a separate PRE-EXISTING failure (a circuit-solve 0V bug that fails identically on HEAD with no recon, runner-specific not engine — `resistive-divider` is bit-exact); they are out of randnumb's blast radius and are NOT part of its gate. Bit-exact-via-TRNOISE (Acceptance #9) defers to vsrc. | RUNNABLE (self-compare, scoped) |

> maths-cmaths / maths-poly / maths-fft / maths-dense and most `include-ngspice`
> /`maths-sparse` hunks are NO-COUNTERPART (RFSPICE/noise/PZ/sensitivity or the
> settled solver) and carry no PENDING work — they need no gate.

## Tier table (devices, applied after the engine)

Legend — fixture status: **✓EXISTS** (composition MCP-confirmed) · **~EXISTS**
(present, composition to be MCP-confirmed by the gate at runtime) · **＋AUTHOR**
(must be created before this device's gate can run).

### Tier 0 — root pair (co-validated with engine-core)
| Device | digiTS component | Gate fixture(s) | Status |
|---|---|---|---|
| vsrc (DC) + res + engine-core | `DcVoltageSource`, `Resistor` | `resistive-divider.dts` (DcVsrc + R + R) | ✓EXISTS |

**Finding (2026-05-30):** a pure single-source circuit (`DcVoltageSource`→gnd, no
load) is degenerate in digiTS — the output pin floats (`floating-terminal`
warning), no DC path besides the source. So a source device cannot be gated truly
alone; its gate is a minimal source + verified-load circuit. `resistive-divider`
(DcVsrc + 2R) therefore IS the DC root gate, co-validating engine-core +
`DcVoltageSource` + `Resistor` together (the accepted unavoidable root
co-validation). No separate `vsrc-dc-only` fixture (dropped as degenerate).

### Tier 1 — on {DC-vsrc, res}
| Device | digiTS component | Gate fixture(s) | Status |
|---|---|---|---|
| vsrc (AC/waveform) | `AcVoltageSource` | `vsrc-ac-square-rload.dts` (AcVsrc{square}+R); `vsrc-ac-sine-rload.dts` (AcVsrc{sine}+R) | ＋AUTHOR |
| isrc | `DcCurrentSource`, `AcCurrentSource` | `isrc-dc-rload.dts` (DcIsrc+R); `isrc-ac-rload.dts` (AcIsrc+R) | ＋AUTHOR |

The vsrc waveform core is the `vsrc#recon` rebuild (#16/#17). Each waveform a
higher fixture uses (square for `rc-transient`, sine for the AC fixtures) must
pass here first.

### Tier 2 — on {vsrc(Dc+Ac+waveforms), res, isrc}
| Device | digiTS component | Gate fixture(s) | Status |
|---|---|---|---|
| cap | `Capacitor` | `rc-transient.dts` (AcVsrc{square}+R+C); `rc-lowpass-ac.dts` (AC) | ✓EXISTS — anchor |
| ind | `Inductor` | `inductor-rl-step.dts` (DcVsrc+R+L); `inductor-geometry-rl.dts` | ✓EXISTS / ~EXISTS — anchor |
| mut | `MutualInductor` | `transformer-coupled-built.dts`, `transformer-coupled-sine.dts` (ind+mut) | ~EXISTS — anchor |
| dio | `Diode` | `diode-resistor.dts` (DcVsrc+R+D); `diode-bridge.dts` | ✓EXISTS / ~EXISTS |
| vccs | `VCCS` | `vccs-gate.dts` (DcVsrc input + VCCS + R load) | ＋AUTHOR |
| vcvs | `VCVS` | `vcvs-gate.dts` (DcVsrc input + VCVS + R load) | ＋AUTHOR |
| cccs | `CCCS` | `cccs-gate.dts` (DcVsrc + sense branch + CCCS + R load) | ＋AUTHOR |
| ccvs | `CCVS` | `ccvs-gate.dts` (DcVsrc + sense branch + CCVS + R load) | ＋AUTHOR |
| sw | (voltage-controlled switch — confirm type) | `sw-gate.dts` (DcVsrc + R + Switch + control vsrc) | ＋AUTHOR |
| csw | `CurrentControlledSwitchAnalogElement` | `csw-gate.dts` (DcVsrc + R + CSW + controlling branch) | ＋AUTHOR |
| asrc | (behavioral/arbitrary source — confirm type) | `asrc-gate.dts` (ASRC expression + R) | ＋AUTHOR |

### Tier 3 — on Tier 2
| Device | digiTS component | Gate fixture(s) | Status |
|---|---|---|---|
| bjt | `NpnBJT`, `PnpBJT` | `bjt-common-emitter.dts`, `bjt-bistable-latch.dts` | ~EXISTS |
| mos1 | `NMOS`, `PMOS` | `mosfet-inverter.dts` | ~EXISTS |
| vdmos | `VDMOSN`, `VDMOSP` | `vdmos-power-switch.dts` (+ ac/primenode/bodydiode/quasisat/selfheat) | ~EXISTS |
| jfet | `NJFET`, `PJFET` | `jfet-gate.dts` (DcVsrc + R + JFET amp) | ＋AUTHOR |
| jfet2 | (built by `jfet2#recon/wholeClass`) | `jfet2-gate.dts` | ＋AUTHOR (with recon) |
| mes | (built by `mes#recon/wholeClass`) | `mes-gate.dts` | ＋AUTHOR (with recon) |

### Engine reconstructions (own targeted fixtures)
The shared solver / NR / integration / sparse paths are gated implicitly by every
device gate above; these recons need dedicated stimulus:
| Recon | Gate fixture | Status |
|---|---|---|
| `maths-sparse#recon/nodesetIcRowZero` | gateKind=`harness`; `nodeset-gate.dts` (bistable BJT latch + `circuit.nodesets` `.nodeset` DC-OP guess) **and** `ic-gate.dts` (RC + `circuit.ics` `.ic` transient-boot), only verified devices | RUNNABLE (harness) — input surface now exists (`.nodeset`/`.ic` read from `.dts`, resolved + emitted to ngspice deck and seeded into digiTS ics). Both fixtures DRIVE pre-port: `harness_run` → 107/107 both sides, stimulus-driven divergence on the constrained node (digiTS still uses the blanket 1e10 pin → FAILS as expected until the recon lands). |
| `analysis#recon/tf` | `tf-gate.dts` (`.tf` transfer-function on a verified resistive/controlled-source net) | ＋AUTHOR |
| `maths-misc#recon/randnumb` | **RUNNABLE** — gateKind=`self-compare`, gateFixtures=[`src/solver/analog/__tests__/monte-carlo.test.ts -t SeededRng`] (the `SeededRng` block only; the MonteCarlo/Sweep integration tests are a different feature with a separate pre-existing 0V-solve failure — out of scope). Bit-exact-via-TRNOISE (Acceptance #9) defers to vsrc's noise arm. | self-compare (scoped) |
| `parser#recon/nodeAllocOrder` | `resistive-divider` / `diode-resistor` / `vccs-gate` / `jfet-gate` (FLAT slot-index parity, VERIFIED-device fixtures only) | ✓ node-ordering bit-identical (topology/coords match every fixture; orderingDiffs none). NOTE: `bjt-common-emitter` / `mosfet-inverter` are NOT used here — their DUTs (bjt, mos1) are UNPORTED (recons PENDING), so `harness_first_divergence` flags their device-model numerics (Q1.VBE state, M1 convergence flag), which are the pending bjt/mos1 ports, NOT node-ordering. Per the composition rule a fixture gates an engine recon only when its devices are verified bit-exact. Composite/subcircuit node-ordering DEFERRED post-migration (see Deferred list). |

## Fixture work list (tier-ordered — "fixtures set up")
Status: ✅ built+saved+emits-to-ngspice · ⛔ deferred (authored with the device's own port/recon — reason given).
1. **Tier 0/1:** ~~`vsrc-dc-only` (dropped — degenerate)~~ · ✅`vsrc-ac-square-rload` · ✅`vsrc-ac-sine-rload` · ✅`isrc-dc-rload` · ✅`isrc-ac-rload`.
2. **Tier 2:** ✅`vccs-gate` · ✅`vcvs-gate` · ✅`cccs-gate` · ✅`ccvs-gate` · ✅`sw-gate` · ⛔`csw-gate` · ⛔`asrc-gate`.
3. **Tier 3:** ✅`jfet-gate` · ⛔`jfet2-gate` · ⛔`mes-gate`.
4. **Engine:** ✅`nodeset-gate` + ✅`ic-gate` (input surface built — `.nodeset`/`.ic` read from `.dts`, emitted to ngspice + seeded into digiTS ics; both DRIVE pre-port) · ⛔`tf-gate` · ✅ randnumb (self-compare via `monte-carlo.test.ts` — no `.dts`).

**Built (10) — all emit to ngspice; smoke-tested bit-exact pre-port (107/107, firstDivergence null):**
`isrc-dc-rload`, `vccs-gate`, `vcvs-gate`, `cccs-gate`, `jfet-gate`, `sw-gate`. Also built+saved: `isrc-ac-rload`, `ccvs-gate` (canon-derived linear H), `vsrc-ac-square-rload`, `vsrc-ac-sine-rload` (waveform gates, run when the driver gates `vsrc`).

**Deferred — cannot be a standalone `.dts` now; authored when the device's own port/recon lands:**
- `csw-gate` — `CurrentControlledSwitchDefinition` is `internalOnly: true` (typeId −1), not placeable via the builder. csw IS ported, but its parity needs the component made placeable, or a hand-built deck / Surface-1 element test — a harness-surface gap.
- `asrc-gate` — `src/components/active/bsource.ts` does not exist yet; the B source is built by the asrc port (#19/#27), which also adds the generator's B-source emitter. Fixture authored then.
- `jfet2-gate`, `mes-gate` — components built by their `wholeClass` recons; fixtures authored with the recon.
- `nodeset-gate` / `ic-gate` — **NO LONGER DEFERRED** (input surface built 2026-06-01). The harness input surface for `.nodeset`/`.ic` now exists: `ComparisonSession` resolves author/`.dts`-supplied nodeset/IC NAMES → digiTS node IDs (`_resolveNodesetNames` / `_resolveIcNames`), emits them as `.nodeset`/`.ic` cards on the auto-generated ngspice deck (`netlist-generator.ts`), seeds the resolved ICs into the digiTS compiled circuit's `ics` Map, and `harness_start` reads optional `circuit.nodesets`/`circuit.ics` objects from the `.dts` JSON so `harness_start({dtsPath})` alone self-contains the stimulus. Both fixtures DRIVE the harness pre-port (ngspice honours the cards; digiTS still uses the blanket 1e10 pin, so a stimulus-driven divergence surfaces — the recon's job to close).
- `tf-gate` — no `.tf` surface in `src/headless` or `scripts/mcp`; built by `analysis#recon/tf`. Fixture authored then.
- randnumb — RUNNABLE NOW (not deferred): gateKind=`self-compare`, the loop runs `monte-carlo.test.ts` (seeded reproducibility) as the gate; no `.dts` divergence circuit. Only the bit-exact-via-TRNOISE check (Acceptance #9) defers to vsrc's noise arm.
- `composite-mosfet-stage` / any **user-subcircuit analog gate** — **DEFERRED POST-MIGRATION** (niche; user 2026-06-01). ngspice returns 0 elements: an analog net loses its identity when it crosses a user-subcircuit `Port` boundary, so the MOSFET gate net collapses to gnd. Proven NOT node-ordering and NOT a general high-Z bug — the FLAT `mosfet-inverter` (same gate-bias topology) is 122/122 bit-exact. The real bug is the flatten Port-stitch / analog partition (`src/solver/digital/flatten.ts` + the analog partitioner); `nodeAllocOrder`'s `mintPort` Part E targeted the in-registry-composite path (`walkCompositeForNodeAllocation`), which never runs for a flattened user subcircuit. Fixed after the whole migration; `nodeAllocOrder` gates flat-only until then.

Each authored fixture is built via the MCP circuit tools (`circuit_build`/`circuit_save`),
must load with zero diagnostics, must be well-posed (a DC path to ground), and must
contain **only** its device-under-test plus lower-tier verified components. Before
the driver runs a device's gate it MCP-inspects the fixture and asserts that
composition rule — the manifest assigns, the gate enforces.

## How the driver consumes this
- Device order = Tier 0 → 1 → 2 → 3 → engine recons (top-to-bottom here).
- For each device, the gate runs every fixture listed for it; **all** must report
  `firstDivergence` null (DC-OP + transient; AC for `*-ac` fixtures) with
  `Release.x64/ngspice.dll`, after a `server_restart` to pick up applied `src/`.
- A non-null divergence blocks that device's completion and escalates to the
  fix-list with harness evidence; the run continues with later devices.
