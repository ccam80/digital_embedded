# ngspice netlist-generator cleanup — handoff for a fresh session

This document captures the work done in one session on 2026-04-26, the bugs
found, the workarounds applied, and the cleaner fixes that should land before
this work is considered complete. It is written for a future session that does
not have the conversation history.

---

## Background

The user reported `performance_50_node` and `mna_50node_realistic_circuit_performance`
in `src/solver/analog/__tests__/sparse-solver.test.ts` were "hanging the worker"
after a pivoting refactor. While investigating, two distinct issues surfaced:

1. **Stale test fixture** — fixed.
2. **ngspice silently rejecting our generated netlists** — root cause confirmed,
   partial fix landed, with caveats described below.

A third issue — **`Worker exited unexpectedly` at full fork concurrency** — is
**still open** at the end of the session and needs separate investigation
(see "Open question" at the bottom).

---

## What was changed

### 1. `mna_50node_realistic_circuit_performance` fixture (FIXED)

**File:** `src/solver/analog/__tests__/sparse-solver.test.ts:438-460`

The `LoadContext` literal in the test still used the pre-`a029864f` shape:
- it set `voltages: rawVoltages` (field deleted in commit `a029864f` —
  "Phase 2.5 W4.B.4 follow-up — delete voltages alias; LoadContext names
  rhsOld + rhs distinctly")
- it omitted the now-required `rhs`, `rhsOld`, `matrix`, `convergenceCollector`,
  `temp`, `vt`, `cktFixLimit`, and `time` fields

The diode test helper at `src/solver/analog/__tests__/test-helpers.ts:343` reads
`ctx.rhsOld[…]`; with the old fixture, `rhsOld` was `undefined` and the test
failed with `TypeError: Cannot read properties of undefined (reading '6')`
inside the post-engine "isolated solver timing" section. Note that the
preceding `engine.dcOperatingPoint()` + 100 `engine.step()` calls *already
completed* — so the engine itself was never hanging; only the raw-solver
fixture section was crashing.

The replacement provides every field LoadContext now requires. Test passes in
~21 ms.

This fix is sound and should stay.

### 2. ngspice bridge stops swallowing every diagnostic (FIXED — keep)

**File:** `src/solver/analog/__tests__/harness/ngspice-bridge.ts:179-194`

Before, the koffi `SendChar`, `SendStat`, and `ControlledExit` callbacks were
registered as `() => 0` — they discarded every line ngspice would have
printed. That hid every "Warning: parameter X ignored" and every
"Error on line N" ngspice was emitting about our auto-generated netlists.

After: the same stub behaviour by default, but `NGSPICE_LOG=1` makes them
write to stderr with `[ngspice]` / `[ngspice-stat]` / `[ngspice-exit]` prefixes.

This is how the bad netlist params were finally surfaced. Keep it. Future
parity / harness work should run with `NGSPICE_LOG=1` whenever something is
unexpectedly wrong on the ngspice side.

### 3. netlist-generator per-device rules (PARTIAL — see "Cleanup needed")

**File:** `src/solver/analog/__tests__/harness/netlist-generator.ts`

The bridge logging revealed three real ngspice-side rejections of our
generated netlists, plus two warning streams:

| Symptom (ngspice output)                                          | Our cause                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| `Error on line N: m1 … off=0 …  unknown parameter (0)`            | `OFF` is bare-keyword grammar; `OFF=0` won't parse    |
| `Error on line N: m1 … icvds=0 icvgs=0 icvbs=0 … unknown (0)`     | ngspice MOS1 only accepts combined `IC=vds,vgs,vbs`   |
| `Error on line N: q1 … subs=1 …  unknown parameter (subs)`        | `SUBS` doesn't exist as an ngspice param at all       |
| `Warning: Model issue: unrecognized parameter (ad/as/pd/ps)`      | These are MOS *instance* params, not model-card       |
| `Warning: Model issue: unrecognized parameter (ibeq/ibsw/nb)`     | Tunnel-only LEVEL=3 params on plain-Diode model card  |

The patch added five new fields to `DeviceNetlistRules` and wired them into
`instanceParamSuffix` / `modelCardSuffix`:

```ts
interface DeviceNetlistRules {
  // pre-existing
  renames?: Record<string, string>;
  modelCardPrefix?: (props: PropertyBag) => string[];
  modelCardDropIfZero?: string[];

  // new
  instanceFlags?: string[];                 // emit as bare keyword if truthy
  instanceDropIfDefault?: Record<string, number>;
  instanceCombineIC?: [string, string, string]; // → IC=v1,v2,v3
  modelCardDropUnlessTunnel?: string[];     // gated on LEVEL=3 prefix
  instanceDropAlways?: string[];            // params with no ngspice equivalent
}
```

And applied them per device:

- **Diode / TunnelDiode**: `instanceFlags=["OFF"]`,
  `instanceDropIfDefault={TEMP:REFTEMP, AREA:1, M:1}`,
  `modelCardDropUnlessTunnel=["IBEQ","IBSW","NB"]`
- **NMOS / PMOS**: `instanceFlags=["OFF"]`,
  `instanceCombineIC=["ICVDS","ICVGS","ICVBS"]`,
  `instanceDropIfDefault={TEMP:REFTEMP, M:1, AD:0, AS:0, PD:0, PS:0}`
- **NpnBJT / PnpBJT**: `instanceFlags=["OFF"]`,
  `instanceDropAlways=["SUBS"]`,
  `instanceDropIfDefault={TEMP:REFTEMP, AREA:1, AREAB:1, AREAC:1, M:1}`
- **NJFET / PJFET / ZenerDiode / VaractorDiode**: `instanceFlags`+default-drop
  for symmetry.

Verification: every test under `src/solver/analog/__tests__/harness/` and
`src/solver/analog/__tests__/ngspice-parity/` now produces zero
`Error on` / `unrecognized parameter` / `unknown parameter` lines from
ngspice when run with `NGSPICE_LOG=1`.

### 4. MOSFET param partition fix (FIXED — keep)

**File:** `src/components/semiconductors/mosfet.ts`

`AD`, `AS`, `PD`, `PS` were declared in the `secondary` group of
`defineModelParams` for both NMOS and PMOS (which gives them
`partition: "model"`). They are ngspice MOS1 *instance* parameters, not model
card parameters — that's why ngspice was logging `unrecognized parameter (ad)
- ignored` etc. Moved them to the `instance` group for both. No other code
path depends on the partition field (only the netlist generator reads it).

This fix is sound and should stay.

### 5. netlist-generator unit tests updated (FIXED — keep)

**File:** `src/solver/analog/__tests__/harness/netlist-generator.test.ts`

Three tests asserted the old ngspice-incompatible format
(`OFF=1`, `M=1`, `ICVDS=0`, `SUBS=1` all expected on the instance line).
Updated to the new format:
- diode test: expect bare `OFF`, no `OFF=`
- MOSFET test: use non-default values so tokens survive the default-drop
  filter; assert combined `IC=1.5,0.7,-0.2`; assert no `ICVDS=`/`ICVGS=`/
  `ICVBS=`
- BJT test: use non-default values; assert bare `OFF`; assert `SUBS` is
  absent from the netlist entirely

All 53 tests pass.

---

## What I suggest reverting / reconsidering

### A. The `instanceDropIfDefault` entries

These were added defensively while I was still chasing the worker crash with
the (incorrect) hypothesis that "every byte we emit may be relevant". They
are not strictly needed:

- `M=1` is a valid ngspice instance param at its default value — emitting it
  is redundant but not erroneous.
- `TEMP=300.15` is similarly redundant. (ngspice converts to °C internally;
  no warning is emitted.)
- `AD=0`, `AS=0`, `PD=0`, `PS=0` are valid; ngspice treats zero area as
  "use TPG/W·L derivation". Harmless.
- `AREA=1`, `AREAB=1`, `AREAC=1` are valid BJT instance defaults. Harmless.

**Recommendation:** drop the `instanceDropIfDefault` field from
`DeviceNetlistRules` entirely. Remove every `instanceDropIfDefault: {…}`
entry. Leaves the netlist a little more verbose but removes a layer of
"why is this here" config. The unit tests in section 5 already use
non-default values, so they'd keep passing.

**Resolved by:** `spec/ngspice-netlist-generator-architecture.md` §3.7 (`instanceDropIfDefault` deleted as a concept).

### B. The `instanceDropAlways: ["SUBS"]` rule masks a data-model bug

`SUBS` ("Substrate topology: 1=VERTICAL, 0=LATERAL") is a digiTS-internal
flag that has no ngspice counterpart. It is *currently* declared in the
`instance` group of `bjt.ts:168-178` (and the PNP equivalent at :230-240),
which makes the netlist generator try to emit it.

**Cleaner fix:** remove `SUBS` from the `instance` group in `bjt.ts` for
both NPN and PNP. Either (a) put it in `secondary` so it's metadata that
isn't ngspice-emitted at all, or (b) introduce a `partition: "internal"`
value (or `"none"`) in `core/registry.ts` that the netlist generator skips
unconditionally.

If that change lands, `instanceDropAlways` and the rule entry for it can be
deleted from `netlist-generator.ts`.

**Resolved by:** `spec/ngspice-netlist-generator-architecture.md` §3.5 (BJT topology becomes a `modelRegistry` entry — `"spice"` for vertical, `"spice-lateral"` for lateral. `SUBS` deleted from the schema; `instanceDropAlways` deleted from the generator).

### C. `modelCardDropUnlessTunnel: ["IBEQ","IBSW","NB"]` masks a paramDefs
       sharing bug

`Diode` and `TunnelDiode` currently share the same paramDefs schema, so
plain Diode carries `IBEQ`, `IBSW`, `NB` even though those keys only exist
in ngspice's level-3 (tunnel) extension. The `modelCardPrefix: tunnelLevel`
function emits `LEVEL=3` only when one of those is non-zero, but the keys
themselves are still emitted to the model card and ignored by ngspice.

**Cleaner fix:** split the schemas. Plain Diode's paramDefs should not
contain `IBEQ`, `IBSW`, `NB`. Only TunnelDiode's should. Once split, the
`modelCardDropUnlessTunnel` rule disappears, and `modelCardPrefix:
tunnelLevel` only needs to remain on TunnelDiode (where the params actually
exist).

**Resolved by:** `spec/ngspice-netlist-generator-architecture.md` §3.4 (Diode/TunnelDiode schemas split — `IBEQ`/`IBSW`/`NB` move to `TUNNEL_DIODE_PARAM_DEFS`; `modelCardDropUnlessTunnel` deleted; TunnelDiode excluded from ngspice parity, see §3.7a).

### D. Pre-existing `modelCardDropIfZero: ["NSUB","NSS"]` (not added by me)

Same flavour as the above: ngspice MOS1 silently uses the simple-Level-1
derivation when `nsub=0`, which is what we want, but a `dropIfZero` rule is
indirect. If we want to be explicit, we should not declare `NSUB`/`NSS` in
paramDefs at all unless the model genuinely uses them. Out of scope for
this cleanup but flagged.

**Resolved by:** `spec/ngspice-netlist-generator-architecture.md` §3.7b (`modelCardDropIfZero` deleted AND `NSUB`/`NSS` removed from MOS-L1 schema and all preset constants — Step 3c).

---

## Open question — the worker crash that started this thread

After all five fixes above landed, the full vitest suite at default fork
concurrency (`os.cpus()-1` = 19 forks on a 20-core box) **still crashes**
mid-run with:

```
node:events:487
      throw er; // Unhandled 'error' event
      ^
Error: Worker exited unexpectedly
    at ChildProcess.onUnexpectedExit (…/tinypool/dist/index.js:118:30)
…
Node.js v25.9.0
```

Empirical observations:

- 4-fork run: no crash (limited only by outer 5-min timeout).
- 8-fork run (config: `poolOptions.forks.maxForks: 8, minForks: 1`): no
  crash, suite ~95% complete in 9 min.
- 19-fork (default) run before netlist fixes: crashes after ~5800 lines of
  output, last completed test was `truth-table-ui.test.ts` or
  `fixture-audit.test.ts` depending on run.
- 19-fork run after netlist fixes: still crashes, now after ~3260 lines,
  last completed test was `data-table.test.ts`.

The crash signature is identical before and after the netlist fixes:
silent worker exit, no JS-level stack trace, reported by tinypool's
parent process. The last completed test differs every run — implying the
crash isn't tied to a particular test file but to whatever sibling worker
happens to be doing at that moment.

The user's working hypothesis was "bad netlist puts ngspice's DLL state
into a corrupted state, eventually crashing a fork". That hypothesis
predicts the crash should disappear after the netlist fix. It didn't.
Either (a) there is *another* bad netlist somewhere that the bridge isn't
seeing (e.g. a path that doesn't go through `netlist-generator.ts`), or
(b) the OOM hypothesis is correct after all, or (c) Node v25.9.0 +
tinypool + koffi has a stability bug at high fork counts that's
independent of any of our code.

The user explicitly stated "the machine is perfectly capable of running at
full concurrency" — so option (b) is rejected from above. That leaves (a)
and (c).

### Suggested next steps for the next session

1. **Audit non-`netlist-generator.ts` paths into the bridge.** Search for
   any `circbyline` / `loadNetlist` call that constructs a SPICE deck
   without going through `generateSpiceNetlist`. Run each with
   `NGSPICE_LOG=1` and check for `Error on` / `unrecognized parameter`
   lines.

2. **Audit `harness-export.test.ts`** — it shows up in vitest output as
   `(0 test)` with a yellow-arrow marker. Empty test files are usually
   benign but worth checking that this isn't masking a collection-time
   crash.

3. **Reproduce the crash deterministically.** Try running just the heavy
   test files in parallel forks (fixture-audit, shape-render-audit,
   analog-shape-render-audit, every harness/, every ngspice-parity/) at
   `--maxForks=19` with `NGSPICE_LOG=1` and see if the crash happens with
   a smaller fileset.

4. **Check koffi's lifecycle.** Each test fork that runs a bridge test
   does a `koffi.load(spice.dll)` and a `koffi.register(...)` for a
   per-fork unique-named callback. We never call `koffi.unregister` or
   any DLL unload. With Node v25 + 19 forks each holding a DLL handle,
   investigate whether shared static state inside ngspice is the issue.

5. **Consider downgrading Node** to the current LTS (22.x) for the test
   harness only, to rule out (c).

---

## Files touched in this session

- `src/solver/analog/__tests__/sparse-solver.test.ts` — fixture fix only
- `src/solver/analog/__tests__/harness/ngspice-bridge.ts` — `NGSPICE_LOG=1`
  diagnostic plumbing
- `src/solver/analog/__tests__/harness/netlist-generator.ts` — per-device
  ngspice grammar rules (see "Cleanup needed")
- `src/solver/analog/__tests__/harness/netlist-generator.test.ts` — three
  test bodies updated to assert the new format
- `src/components/semiconductors/mosfet.ts` — moved AD/AS/PD/PS to the
  instance partition for both NMOS and PMOS

## Files NOT touched but referenced for cleanup

- `src/components/semiconductors/bjt.ts` — `SUBS` partition needs to change
  (lines 168 and 230 area, both NPN and PNP)
- `src/components/semiconductors/diode.ts` and `tunnel-diode.ts` — schema
  split for `IBEQ/IBSW/NB`
- `vitest.config.ts` — left at defaults (a `maxForks` cap was tried during
  the session and reverted at the user's direction)
