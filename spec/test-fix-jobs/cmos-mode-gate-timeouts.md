# CMOS-mode gate sweep — single-gate compile times out at 30 s

**Category:** `architecture-fix`

## Problem statement

Six per-gate sweep cases in `e2e/gui/component-sweep.spec.ts > 5C — Per-
Component Engine Mode Sweep` time out at the Playwright 30 s wall:

- `And works in cmos mode`
- `Or works in cmos mode`
- `NAnd works in cmos mode`
- `NOr works in cmos mode`
- `XOr works in cmos mode`
- `XNOr works in cmos mode`

Every case follows the same pattern (`component-sweep.spec.ts:766-789`):

```ts
await builder.placeLabeled(entry.type, 10, 8, 'DUT');
if (mode !== 'digital' && (mode === 'cmos' || mode === 'behavioral')) {
  await builder.setComponentProperty('DUT', 'Model', mode);
}
// ... assert placement succeeded ...
await builder.stepViaUI();
```

The test places exactly one gate, switches its `model` property to `cmos`,
and then issues a single `stepViaUI()`. Nothing is wired — neither the
input pins, nor `VDD`, nor `GND`. The 30 s timeout is hit inside
`stepViaUI` (button click → analog NR loop), not in any UI assertion.

The seventh entry in the dual-engine list, `Not works in cmos mode`, is NOT
in the failing set described by the brief. That is consistent with the
inverter being a 2-MOSFET netlist instead of the 6-MOSFET (NAND2 → INV)
netlists used by the other six gates — the convergence search space is
proportional to the number of nonlinear devices, and the 6-MOSFET case
overruns the wall.

The CMOS subcircuit netlists for the six failing gates each instantiate 6
MOSFETs in series-parallel topologies driven by floating gate nodes:

- `src/components/gates/and.ts:130-155` — `CMOS_AND2_NETLIST`
  (NAND2 → INV, 6 MOSFETs)
- `src/components/gates/or.ts` — `CMOS_OR2_NETLIST` (NOR2 → INV, 6
  MOSFETs)
- `src/components/gates/nand.ts` — `CMOS_NAND2_NETLIST` (4 MOSFETs)
- `src/components/gates/nor.ts` — `CMOS_NOR2_NETLIST` (4 MOSFETs)
- `src/components/gates/xor.ts` — `CMOS_XOR2_NETLIST` (XOR with internal
  inverters, ≥10 MOSFETs)
- `src/components/gates/xnor.ts` — `CMOS_XNOR2_NETLIST` (XNOR, ≥10
  MOSFETs)

When the test compiles a single CMOS gate with no wiring, the input nets
are floating, `VDD` is floating, `GND` is floating, and the output
sub-net inside the subcircuit (`nand_out` for AND, `nor_out` for OR, etc.)
is also floating. NR enters a regime where every linearization point sees
zero gate drive but a `gmin`-only path to ground, and the residual is
dominated by `gmin`-scale numerical noise. The Newton iterates oscillate
across the cubic region of `MOS1mod` (cite below) without converging to
a tolerance, the engine retries with progressively smaller `dt` until the
LTE collapse trips the engine's outer wall, and the timestep loop
re-issues the same NR call shape until the Playwright 30 s wall fires.

## Sites

### Test
- `e2e/gui/component-sweep.spec.ts:388-403` — `DUAL_ENGINE_TYPES` array.
  Entries 0..6 (And, Or, Not, NAnd, NOr, XOr, XNOr) all carry `modes:
  ['digital', 'cmos']`. Six of those seven `cmos` cases time out.
- `e2e/gui/component-sweep.spec.ts:766-789` — the per-mode sweep test
  body. The entire body for `mode === 'cmos'` after `setComponentProperty
  ('DUT', 'Model', mode)` is one `stepViaUI()` call with no wiring.

### CMOS gate netlists
- `src/components/gates/and.ts:130-155` — `CMOS_AND2_NETLIST`. Ports:
  `["In_1", "In_2", "out", "VDD", "GND"]`. 6 MOSFETs (2 PMOS pull-up +
  2 NMOS pull-down for NAND2, plus 1 PMOS + 1 NMOS for the output INV).
- `src/components/gates/{or,nand,nor,xor,xnor}.ts` — same shape, varying
  topology and MOSFET count.
- `src/core/mna-subcircuit-netlist.ts` — `MnaSubcircuitNetlist` type and
  the runtime walk that flattens it into the engine's element list.

### Compile/step path
- `src/components/gates/gate-shared.ts:175-203` — `appendPowerPins(...)`
  inserts `VDD` and `GND` pins on a CMOS-active gate. `getPins` in
  `src/components/gates/and.ts:52-63` only appends the power pins when
  the active model exists in `modelRegistry`. The single-gate test does
  set `model = 'cmos'`, so the power pins do appear on the canvas, but
  they are not wired by the test.
- `src/solver/analog/analog-engine.ts` — the NR loop. (No specific line
  cited; the failure is a global stagnation, not a single line of bad
  code in the engine.)

### MOSFET load
- `src/components/semiconductors/mosfet.ts:992-1144` — the SPICE-L1 MOS1
  load. The general-iteration block reads `vbs/vgs/vds` from `CKTrhsOld`
  with polarity sign-flip (lines 1011-1019); applies `fetlim`+`limvds`
  inside the `if (!bypassed)` gate (lines 1094-1144); the bypass test
  uses `delvbs/delvbd/delvgs/delvds` against the previous iterate's
  cached values (lines 1052-1055, 1069-1078).

## Verified ngspice citation

Opened `ref/ngspice/src/spicelib/devices/mos1/mos1load.c` directly. The
relevant region for the convergence behaviour in this failure is:

### `mos1load.c:153-200` — start-up dispatch table for `vbs/vgs/vds`

The comment block at lines 153-161:

```c
/*
 * ok - now to do the start-up operations
 *
 * we must get values for vbs, vds, and vgs from somewhere
 * so we either predict them or recover them from last iteration
 */
```

is followed by the dispatch ladder (lines 202-242 in the actual file).
The relevant entry for "no IC, OFF=0, post-DC-OP regular iteration" is the
general-iteration branch:

```c
/* general iteration */
vbs = model->MOS1type * (
    *(ckt->CKTrhsOld+here->MOS1bNode) -
    *(ckt->CKTrhsOld+here->MOS1sNodePrime));
vgs = model->MOS1type * (
    *(ckt->CKTrhsOld+here->MOS1gNode) -
    *(ckt->CKTrhsOld+here->MOS1sNodePrime));
vds = model->MOS1type * (
    *(ckt->CKTrhsOld+here->MOS1dNodePrime) -
    *(ckt->CKTrhsOld+here->MOS1sNodePrime));
```

`mos1load.c:226-240`. This is the value source for the linearization
voltages on every NR iteration after the first. With every node floating,
`CKTrhsOld[bNode] = CKTrhsOld[sNode] = CKTrhsOld[gNode] = CKTrhsOld
[dNode]` are all whatever `gmin`-stamped result the previous iteration
produced — so `vgs`, `vds`, `vbs` are all near zero, the gate is below
threshold, and `cdrain ≈ 0`. The NR step is then dominated by the
`gmin`-shunt residual, which floats above `CKTabstol` indefinitely.

### `mos1load.c:412-434` — initial-junction branch (MODEINITJCT, OFF, default)

```c
} else if (ckt->CKTmode & MODEINITJCT) {
    vbs = -1;
    vgs = model->MOS1type * here->MOS1tVto;
    vds = 0;
}
```

(line numbers approximate from local file; verified the symbolic
behaviour by inspection of the `if (ckt->CKTmode & ...)` ladder). The
`MODEINITJCT` arm seeds `vgs = MOS1type * tVto` so that on first DC-OP
iteration the gate is biased to threshold rather than zero. This is the
only "warm-start" path that biases the device into a definite region. If
the digiTS engine never enters this arm before the first general-
iteration step (i.e. the first NR iteration of the first DC-OP attempt),
the MOSFETs start with `vgs = 0`, immediately fall to subthreshold, and
the search begins from a degenerate point.

### `mos1load.c:362-406` — fetlim / limvds gate

The limiting block runs only inside `if (!bypassed)` and only when not in
`MODEINITPRED|MODEINITTRAN|MODEINITSMSIG`. The first DC-OP iterations
under `MODEINITFLOAT|MODEINITFIX` go through limiting. The structure:

```c
if (vds_old >= 0) {
    vgs_new = DEVfetlim(vgs_new, vgs_old, von);
    vds_new = vgs_new - vgd;
    vds_new = DEVlimvds(vds_new, vds_old);
    ...
} else {
    /* reverse mode */
}
```

is mirrored verbatim in `mosfet.ts:1109-1144`. The mirror is faithful, so
the convergence stall is NOT a stamp-sign or limiter-placement bug in the
digiTS port. The stall is in the seeding regime that feeds limiter inputs
that all read `0`.

## Architecture diagnosis

The convergence stall is not localizable to a single SPICE-correctness
defect in any one MOSFET stamp. The architectural shape is:

1. **Test fixture programs an unsolvable circuit.** A CMOS gate with all
   external nets floating (`In_1`, `In_2`, `VDD`, `GND`, `out`) has no
   ground reference and no driven inputs. ngspice would refuse such a
   netlist with `singular matrix: check nodes ...` from `niiter.c:885-
   904` once the LU factorizer pivots through the floating subnet — see
   `topology-validation-after-setup.md` for that escalation path. digiTS
   currently bypasses pre-flight validation (also covered in that spec)
   and hands the singular matrix to the NR loop, which damps via `gmin`
   and never returns.

2. **Test contract — what should happen.** The test brief at
   `component-sweep.spec.ts:783-787` says: "Compile and step — may
   produce unconnected-input warnings but should not crash or produce
   type errors." It does NOT require the analog circuit to converge
   numerically. The test's verification is the `getCircuitInfo()`
   placement check at lines 779-782, plus `stepViaUI()` returning
   without throwing. Producing a status-bar diagnostic that says "CMOS
   gate has unwired VDD/GND" is a legitimate outcome; hanging the engine
   for 30 s is not.

3. **Production fix — emit a structural diagnostic before NR.** Once
   the topology validator runs post-`setup()` (per
   `topology-validation-after-setup.md`), it sees a CMOS gate's
   subcircuit-expanded MOSFET drains/sources/gates connected to a net
   that has no `vsrc`/`isrc`/`gnd` anchor. That is the
   `competing-voltage-constraints` /
   `floating-net-with-only-nonlinear-devices` shape that the validator
   is supposed to catch. With validation gated correctly:
   - `compile` returns a diagnostic list including
     `code: "floating-net"` (or whichever code the validator emits for
     "no DC ground reference for this nonlinear sub-net").
   - `stepViaUI` displays the diagnostic in the status bar and does NOT
     enter the NR loop.
   - The test's `stepViaUI()` returns within wall time.
   - `verifyNoErrors()` is NOT called by the cmos test (line 786 has
     `await builder.stepViaUI();` only — no `verifyNoErrors()`), so a
     status-bar warning is acceptable.

4. **Why the digital-mode case passes.** When `mode === 'digital'`, the
   gate uses the discrete `executeAnd` path with no analog elements. No
   NR loop, no MOSFETs, no convergence requirement. The
   `setComponentProperty('DUT', 'Model', 'cmos')` call is what flips the
   gate into the analog-subcircuit code path that exposes the missing
   pre-flight validation.

The architectural fix is therefore the SAME fix as
`topology-validation-after-setup.md`. That spec already documents the
defect (`compiler.ts:1437-1448` reads `branchIndex` before `setup()`
populates it; the validator silently short-circuits) and the fix shape
(post-setup hook in `analog-engine.ts:_setup`, route diagnostics through
`DiagnosticCollector`).

The CMOS-gate timeouts are the **first observable symptom** of that
upstream defect on the e2e surface. They cannot be fixed in isolation
without re-implementing topology validation; they will be fixed
automatically once topology validation runs at the correct lifecycle
phase. **Dependency: this spec is resolved by
`topology-validation-after-setup.md` plus a CMOS-specific augmentation to
the validator's catch list (see "Required validator coverage" below).**

## Required validator coverage

The existing detector list in `compiler.ts` covers:
- `voltage-source-loop`
- `inductor-loop`
- `competing-voltage-constraints`

For the CMOS-gate timeouts, the validator must additionally detect
**"nonlinear-only subnet with no DC ground path"** — the shape where a
connected subnet contains only MOSFETs / BJTs / diodes / nonlinear
elements with no path through a `vsrc`, `isrc`, or `gnd` to a node-0
reference. ngspice catches this implicitly via `niiter.c:885-904` (the
`E_SINGULAR` retry-then-error path); digiTS's pre-flight detectors
should catch it explicitly so the message is actionable.

The detector lives at the same layer as the existing three. Spec
ownership: this is an addition the
`topology-validation-after-setup.md` implementation should fold in,
since both detectors share the same post-setup `topologyInfo` walk.

## Convergence-log capture procedure (if root cause needs in-engine
verification)

Per `CLAUDE.md` "Diagnosing engine crashes/stagnation":

1. Open the simulator UI in a browser (`npm run dev`).
2. Place a single `And` gate, set `Model = cmos` via the property
   panel, do not wire anything.
3. **Before** clicking Step: Analysis menu → Convergence Log → Enable.
4. Click Step. The button will appear to hang; wait 5-10 seconds, then
   click Stop.
5. Analysis menu → Convergence Log → Export. Save the JSON.
6. The exported log records `step` records with per-NR-iteration
   `vMaxRes`, `iMaxRes`, `blameElement`, and the dt-collapse pattern
   (`dt → dt/2 → dt/4 …`). Expect to see:
   - `blameElement` cycling between the 6 MOSFET sub-element labels
     (`P1`, `P2`, `N1`, `N2`, `Pinv`, `Ninv`), never stabilising.
   - `dt` collapsing toward `cktMinTimestep` and the engine entering the
     "minimum dt reached" recovery branch.
   - `vMaxRes` stuck above `vntol` for indefinite iterations because
     every NR step lands at `vgs ≈ 0` and the limiter has nothing to
     limit.

The procedure validates the architectural diagnosis above. If the
recorded log shows a different blame pattern (e.g. all blame on a single
MOSFET, or a clear sign-error oscillation), the diagnosis is wrong and
this spec must be re-issued. Until the in-engine capture is collected,
the diagnosis above stands as the most consistent explanation given the
test fixture (single gate, no wiring) and the known engine behaviour
(no pre-flight validation per K2).

## Resolves

6 e2e tests:
- `Component sweep tests > 5C — Per-Component Engine Mode Sweep > And
  works in cmos mode`
- … same shape for `Or`, `NAnd`, `NOr`, `XOr`, `XNOr`.

## Tensions / uncertainties

1. **Sub-element label stability.** The convergence log's `blameElement`
   uses whatever label the subcircuit-expanded MOSFETs receive at
   compile time. The `MnaSubcircuitNetlist` walk in
   `src/core/mna-subcircuit-netlist.ts` synthesises labels from the
   parent gate's instance ID. If the labels are not stable across runs
   (e.g. UUID-suffixed), the capture procedure above needs adjustment.
   Verify on first run.

2. **Could the fix instead be: "wire VDD and GND in the test"?** That
   would silence the test but would NOT fix the underlying engine
   defect. Per `CLAUDE.md` "No Pragmatic Patches", the production fix
   is required. The test fixture is intentionally minimal — it is a
   placement+compile sweep, not a circuit-correctness test — and the
   contract at line 783-787 says "may produce unconnected-input
   warnings but should not crash". Hanging for 30 s is the bug; a
   diagnostic message is the contract.

3. **Does the brief's phrasing "production fix, not test" match this
   spec's conclusion?** Yes — the brief says "CMOS path triggers
   slow/hanging convergence path. Production fix, not test." The
   architectural diagnosis above identifies the production defect (no
   pre-flight detection of floating nonlinear-only subnets) and ties it
   to the in-flight `topology-validation-after-setup.md` spec.

4. **Could there be a second, independent CMOS-only convergence bug
   (e.g. stamp sign in CMOS_AND2_NETLIST's MNA expansion)?** Inspection
   of `CMOS_AND2_NETLIST` shows P1 has `(D=VDD, G=In_1, S=nand_out)`,
   P2 has `(D=VDD, G=In_2, S=nand_out)`, etc. — a standard NAND2 +
   inverter topology. The PMOS `S→D` polarity convention in digiTS
   matches ngspice (`MOS1type` sign flip in `mos1load.c:226-240`
   mirrored at `mosfet.ts:1017-1019`). No stamp-sign bug is visible
   from inspection; running the convergence-log capture above would
   confirm. **Escalation candidate** if the post-setup-validation fix
   lands and a subset of the 6 cases still time out: that would
   indicate a CMOS-specific stamp bug independent of the floating-net
   issue, which would be a `few-ULP` or `architecture-fix` item to be
   filed as its own spec.
