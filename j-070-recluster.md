# J-070 List A — recluster by template shape

Replaces the cluster→agent allocation in `j-070-followup.md`. Driven by the
finding that ~40% of List A does not fit the d-flipflop driver template
shape. Re-grouped so each agent's jobs share ONE template — no off-script
improvisation needed when the spec and the canonical reference disagree.

## Status of completed precursor work (this session)

- `src/solver/analog/behavioral-drivers/edge-detect.ts` — written. Three
  pure helpers (`detectRisingEdge`, `detectFallingEdge`, `logicLevel`).
- `src/solver/analog/behavioral-drivers/d-flipflop-driver.ts` — cleaned to
  canonical-exemplar standard (edge-detect import, `setParam` hot-loads
  vIH/vIL, defensive guards removed, `q: 0 | 1`, "Strictly 1-bit" docstring).
- `src/components/flipflops/d.ts` — migrated to `kind: "netlist"` behavioural
  model with `buildDFlipflopNetlist` builder, full `defineModelParams`
  declaration, drv + qPin + nqPin via siblingState.
- 6 sibling parent-composite migrations (`d-async.ts`, `jk.ts`,
  `jk-async.ts`, `rs.ts`, `rs-async.ts`, `t.ts`) — executed.

These are NOT on List A as J-IDs but unblock the J-162–J-169 deletion cluster.

### Wave 2 precursors (completed this session)

- `src/solver/analog/compiler.ts:410` — **siblingState resolver fix**: now
  prefers the constructed sibling's per-instance `stateSchema` over the
  definition's static schema, with fallback. Unblocks variable-arity-schema
  drivers (Counter / Register / Counter-preset) that build their schema in
  the constructor from props. Also corrects a latent bug: the old code
  called `siblingSchema.indexOf(slotName)` as a function, but `indexOf` is a
  `ReadonlyMap<string, number>`; now uses `.get(slotName) ?? -1`. Sibling
  must precede consumer in `netlist.elements` iteration order, which is
  already the de-facto convention (d-flipflop emits `[drv, qPin, nqPin]`;
  counter parent emits `[drv, outBit0, outBit1, ...]`).
- `src/solver/analog/behavioral-drivers/and-driver.ts` — **Template
  A-variable-pin canonical**. Variable input pin count via
  `pinLayoutFactory`, fixed 1-slot schema (`OUTPUT_LOGIC_LEVEL`), per-input
  threshold-classify with hold-on-indeterminate. Per-gate variation surface
  documented in load() docstring (OR / NAND / NOR / XOR / XNOR / mux).
- `src/solver/analog/behavioral-drivers/counter-driver.ts` — **Template
  A-multi-bit-schema canonical**. Fixed pinLayout (en, C, clr, gnd; outputs
  hang off N+1 sibling DigitalOutputPinLoaded subs — N output bits + ovf),
  variable arity schema via module-scope memoised factory
  (`getCounterSchema(bitWidth)`): LAST_CLOCK + COUNT_BITi (internal latch)
  + OUTPUT_LOGIC_LEVEL_BITi (consumed-by-pin) + OUTPUT_LOGIC_LEVEL_OVF
  (consumed-by-pin). Per-instance `stateSchema` / `stateSize` fields (the
  only Template-A shape diff). Spec extension: OUTPUT_LOGIC_LEVEL_OVF
  added beyond J-139's literal acceptance criteria, required because the
  user-facing Counter component has an `ovf` output pin (matches the
  digital-mode `executeCounter` semantic). Per-driver variation surface
  documented for register / counter-preset / shift-register.
- `src/components/gates/and.ts` — **migrated to function-form netlist**
  (J-037 ✅). `modelRegistry.behavioral` now `kind: "netlist"` invoking
  `buildAndGateNetlist`; emits `drv` + N `inPin_${i}` + `outPin` (siblingState
  consumes `OUTPUT_LOGIC_LEVEL`). New `AND_BEHAVIORAL_PARAM_DEFS` (inputCount,
  loaded, vIH, vIL, rOut, cOut, vOH, vOL).
- `src/components/memory/counter.ts` — **migrated to function-form netlist**
  (no J-ID; bonus migration alongside J-139). `modelRegistry.behavioral`
  now `kind: "netlist"` invoking `buildCounterNetlist`; emits `drv` + 3
  control inPins + N `outBit${i}` + `ovfPin`. Each output pin's `inputLogic`
  is a siblingState ref to the matching driver slot.

Both new canonicals type-check clean (0 errors); compiler.ts has 9 pre-
existing tsc errors unrelated to the line 410 edit.

---

## Template A — Pure-truth-function 1-bit driver leaf

**Canonical reference:** `src/solver/analog/behavioral-drivers/d-flipflop-driver.ts`

Shape: module-level static schema, module-level static pinLayout, no MNA
stamps, writes `OUTPUT_LOGIC_LEVEL_*` slots consumed by sibling
`DigitalOutputPinLoaded` sub-elements via siblingState. 1-bit by design;
multi-bit handled by parent emitting N copies.

### A-fixed (definitive shape match — agent-ready after spec audit pass)

These have fixed pin counts and slot lists; the only per-job variation is
slot names, pin labels, and the load() body math.

| Job | File | Notes |
|---|---|---|
| J-030 | `src/components/active/timer-555-latch-driver.ts` | 7 fixed pins; SR-latch + reset logic |
| J-152 | `src/solver/analog/behavioral-drivers/not-driver.ts` | 1 input, 1 output |
| J-137 | `src/solver/analog/behavioral-drivers/buf-driver.ts` | 1 input, 1 output |
| J-145 | `src/solver/analog/behavioral-drivers/driver-driver.ts` | needs audit: shape may be tri-state, not pure-truth |
| J-146 | `src/solver/analog/behavioral-drivers/driver-inv-driver.ts` | same audit caveat as J-145 |
| J-138 | `src/solver/analog/behavioral-drivers/button-led-driver.ts` | needs audit: button input + led output may need analog coupling |
| J-171 | `src/solver/analog/behavioral-output-driver.ts` | I7 — was deleted as broken; rewrite from spec |

**Subtotal:** 7 jobs (5 firm, 3 with audit caveats).

### A-variable-pin (1-bit truth function, variable input pin count per instance)

**Canonical reference:** `src/solver/analog/behavioral-drivers/and-driver.ts`
(authored this session). Resolved via `pinLayoutFactory` on the
ComponentDefinition (registry.ts:361, already supported by the compiler at
`resolvePinLayout`). Schema stays fixed-1-slot (OUTPUT_LOGIC_LEVEL).

| Job | File | Notes |
|---|---|---|
| J-134 | `and-driver.ts` | ✅ canonical (this session) |
| J-153 | `or-driver.ts` | OR reduction (absorber = "1") + same shape |
| J-150 | `nand-driver.ts` | AND body + final invert |
| J-151 | `nor-driver.ts` | OR body + final invert |
| J-161 | `xor-driver.ts` | XOR-reduce; hold prior on any indeterminate |
| J-160 | `xnor-driver.ts` | XOR body + final invert |
| J-149 | `mux-driver.ts` | sel-indexed pick (`selectorBits` param → 2^selectorBits data inputs) |

**Subtotal:** 7 jobs (1 canonical + 6 derivative).

### A-fixed (re-classified from A-variable via parent-emits-N decomposition)

Demux, decoder, and splitter outputs are independently computable from inputs
(no internal coupling). Parent's `buildXNetlist(params)` emits N independent
1-bit Template A-fixed driver instances, one per output port. **No variable
schema needed; no driver-side architectural change.** The arity moves into
the parent's netlist function, where bit-width replication infrastructure
already lives.

| Job | File | Decomposition |
|---|---|---|
| J-144 | (was demux-driver.ts) | parent emits N × `BehavioralDemuxBitDriver` (1-bit each: read in + sel, output bit i) |
| J-143 | (was decoder-driver.ts) | parent emits N × `BehavioralDecoderBitDriver` (1-bit each: assert if sel == i) |
| J-158 | (was splitter-driver.ts) | parent emits N × pass-through driver per parsed bit-port |

**Subtotal:** 3 jobs collapse to A-fixed shape; per-bit driver matches the
existing canonical Template A pattern.

### A-multi-bit-schema (driver intrinsically owns multi-bit, fixed pinLayout)

**Canonical reference:** `src/solver/analog/behavioral-drivers/counter-driver.ts`
(authored this session). Variable arity schema via memoised factory; fixed
control-input pinLayout (no driver-side output pins — outputs hang off N
sibling DigitalOutputPinLoaded sub-elements that consume
`OUTPUT_LOGIC_LEVEL_BITi` slots via siblingState).

| Job | File | Notes |
|---|---|---|
| J-139 | `counter-driver.ts` | ✅ canonical (this session); integer counter, en/clr |
| J-018 | `adc-driver.ts` | reclassified out of Template D — driver has only INPUT pin reads (VIN/CLK/VREF/GND) and writes per-bit `OUTPUT_EOC` + `OUTPUT_D{i}` slots consumed via siblingState by N+1 sibling DigitalOutputPinLoaded sub-elements (per `adc.ts:144-205`); no MNA stamps. The "packed SAR_BITS slot" wording in the J-018 spec is stale — the live `buildAdcNetlist` already lays out per-bit slots. Same shape as `counter-driver.ts`. |

**Subtotal:** 2 jobs (1 canonical + J-018 ADC reclassified from Template D).

### A-variable+multi-bit (composed of both shapes)

Drivers that have BOTH variable input pin count AND variable output schema.
Composes the A-variable-pin canonical (`pinLayoutFactory`) with the A-multi-
bit-schema canonical (memoised arity-indexed schema factory). No new
canonical needed: agents implement these by importing both patterns.

| Job | File | Variable axes |
|---|---|---|
| J-140 | `counter-preset-driver.ts` | bitWidth (output schema) + ld/preset_BITi pins (input pinLayout) |

**Subtotal:** 1 job. (J-154 register reclassified to A-fixed parent-decomposed
— see next section. No shift-register component exists in the repo, so the
A-composed bucket has only counter-preset.)

### A-fixed (re-classified from A-multi-bit: fixed-arity multi-output)

Seven-seg has fixed 4 inputs → 7 outputs. Schema is module-static (7
OUTPUT_LOGIC_LEVEL_SEG_A..G slots); pinLayout is module-static; behaves
exactly like the d-flipflop canonical, just with 7 output slots instead of
2. **No variable schema needed.**

| Job | File | Notes |
|---|---|---|
| J-157 | `seven-seg-driver.ts` | A-fixed shape: fixed schema with 7 output slots, fixed 4-in pinLayout |

**Subtotal:** 1 job.

### A-fixed (re-classified from A-composed: parent-emits-N parallel-load Register)

J-154 Register is parallel-load N-bit storage with enable (per
`src/components/memory/register.ts:42-79` bus-wide D/Q pins and the flat
`executeRegister` body at `register.ts:144-149` which atomically copies the
entire D bus to stored, no per-bit shift). Output bit i depends only on
D_i plus broadcast C / en / gnd — no inter-bit coupling. Parent's
`buildRegisterNetlist(bitWidth)` emits N copies of a 1-bit
`BehavioralRegisterBitDriver` (D, C, en, gnd → `OUTPUT_LOGIC_LEVEL`), one
per bit, plus N sibling `DigitalOutputPinLoaded` on Q0..Q_{N-1}. The 1-bit
driver is the d-flipflop driver shape with an `en`-guard on the
edge-triggered sample (~2-line load() delta vs `d-flipflop-driver.ts`).

There is **no shift-register component** in the repo (`register.ts` and
`register-file.ts` are the only register* sources). So the J-154 spec
ambiguity collapses — parallel-load is the only shape that exists.

| Job | File | Notes |
|---|---|---|
| J-154 | `register-bit-driver.ts` (1-bit leaf) + `register.ts` netlist builder | parent emits N × 1-bit driver; mirrors d-flipflop driver shape with en-guard |

**Subtotal:** 1 job.

---

## Template B — Sibling-only no-pin coupling driver

**Canonical reference:** none yet — needs authoring.

Shape: zero MNA pins (`netlist: []`). Reads `siblingBranch` (current through
a named sibling element) and/or `siblingState` (named slot of a named
sibling). Writes its own state. No `_pinNodes` reads, no `stamp()`, no
matrix touches. Has a state schema like Template A.

| Job | File | siblingBranch user? |
|---|---|---|
| J-095 | `src/components/switching/relay-coupling.ts` | YES — first siblingBranch user (coil current) |
| J-063 | `src/components/passives/transformer-coupling.ts` | likely YES — primary current → secondary |

**Subtotal:** 2 jobs. **Prerequisite:** author canonical Template B file.

---

## Template C — MNA-stamping analog leaf

**Canonical reference:** none in `behavioral-drivers/`. Existing `Resistor` /
`Inductor` / `Capacitor` element files are the closest shape — these are
NOT behavioural drivers, they're low-level MNA stamp elements that touch
the matrix and RHS in `load()`. Needs per-cluster canonical authoring.

| Job | File | Stamp shape |
|---|---|---|
| J-068 | `src/components/passives/transmission-segment-r.ts` | resistor stamp |
| J-067 | `src/components/passives/transmission-segment-l.ts` | inductor stamp + branch |
| J-066 | `src/components/passives/transmission-segment-g.ts` | conductance stamp |
| J-065 | `src/components/passives/transmission-segment-c.ts` | capacitor companion stamp |
| J-069 | `src/components/passives/transmission-segment-rl.ts` | combined R+L stamp |
| J-024 | `src/components/active/internal-cccs.ts` | controlled current source (reads sibling branch) |
| J-025 | `src/components/active/internal-zero-volt-sense.ts` | 0V VSRC, branch current sensor |
| J-091 | `src/components/switching/fgnfet-blown-driver.ts` | conditional clamp resistor stamp + defines `stampBlownClamp` helper |
| J-093 | `src/components/switching/fgpfet-blown-driver.ts` | mirrors J-091, imports `stampBlownClamp` |

**Subtotal:** 9 jobs. **Prerequisite:** author canonical Template C file
(probably one for "passive 2-terminal" and one for "branch-bearing"
sub-shapes).

---

## Template D — Hybrid pin+stamp+state driver

**Canonical reference:** none yet. Existing `comparator.ts`'s `ComparatorDriver`
sub-element is the closest shape but lives inline in the composite file.

Shape: has MNA pins, stamps the matrix in `load()` (typically a Norton
current source on the output node), AND maintains state slots with edge /
threshold / latch logic. Uses `defineStateSchema` like Template A but
combines it with stamp-on-load.

| Job | File | State + stamp |
|---|---|---|
| J-020 | `src/components/active/comparator-driver.ts` | hysteresis latch + Norton stamp on out |
| J-028 | `src/components/active/schmitt-trigger-driver.ts` | Schmitt latch + stamp |
| J-022 | `src/components/active/dac-driver.ts` | DAC has ONE analog output (`OUT`) whose value `V_ref · code / 2^N` is a global function of all N input bits — not per-bit decomposable. Per `dac.ts:200-232`, driver has `branchCount: 1` and "stamps target at OUT via VCVS shape". State payload mirrors comparator (settling-time weight per `settlingTime` property + threshold-classification holds). Reads N digital input voltages, stamps OUT branch. Use `comparator-driver.ts` as the canonical reference. |

**Subtotal:** 3 firm hybrid jobs (J-018 ADC reclassified to A-multi-bit-schema —
ADC writes per-bit slots consumed by sibling DigitalOutputPinLoaded VSRCs and
has no driver-side stamps; only DAC has a single coupled analog output that
forces hybrid shape). **Prerequisite:** Template D canonical authored
(`comparator-driver.ts`).

---

## Template E — Mechanical deletion ✅ COMPLETE

**Status:** all 8 J-listed files plus 2 same-blast-radius orphans deleted in
this session. tsc error count 623 -> 617 (the 6 broken parent-composite
imports cleared), no new errors introduced.

| Job | File | Status |
|---|---|---|
| J-162 | `src/solver/analog/behavioral-flipflop.ts` | ✅ deleted |
| J-163 | `src/solver/analog/behavioral-flipflop/d-async.ts` | ✅ deleted |
| J-164 | `src/solver/analog/behavioral-flipflop/jk-async.ts` | ✅ deleted |
| J-165 | `src/solver/analog/behavioral-flipflop/jk.ts` | ✅ deleted |
| J-166 | `src/solver/analog/behavioral-flipflop/rs-async.ts` | ✅ deleted |
| J-167 | `src/solver/analog/behavioral-flipflop/rs.ts` | ✅ deleted |
| J-168 | `src/solver/analog/behavioral-flipflop/shared.ts` | ✅ deleted |
| J-169 | `src/solver/analog/behavioral-flipflop/t.ts` | ✅ deleted |
| (n/a)  | `src/solver/analog/behavioral-flipflop/index.ts` | ✅ deleted (orphan barrel) |
| (n/a)  | `src/solver/analog/behavioral-flipflop-variants.ts` | ✅ deleted (orphan re-export, zero importers verified) |
| (n/a)  | `src/solver/analog/behavioral-flipflop/` directory | ✅ removed |

The two `(n/a)` deletions were not on List A but were strictly required for
deletion coherence (orphans pointing into the deleted directory).

---

## Cluster→agent allocation

Total in this recluster: **35 List-A jobs + 8 deletion jobs = 43 jobs.**

| Template | Bucket | Jobs | Agent count | Status |
|---|---|---|---|---|
| A-fixed | Pure-truth 1-bit, fixed pins (incl. seven-seg, decomposed demux/decoder/splitter, register parent-decomposed) | 7 + 1 (seven-seg) + 3 (parent-decomposed gates) + 1 (register) = 12 | 2 agents (batched by sub-bucket) | Spec audit before spawn |
| A-variable-pin | Variable inputs, fixed schema | 6 (gates + mux; canonical and-driver done) | 1 agent (batched) | ✅ Canonical ready; spec audit before spawn |
| A-multi-bit-schema | Fixed pins, variable schema | 1 (J-018 ADC reclassified from D) + canonical counter-driver done | 1 agent (J-018 alongside canonical) | ✅ Canonical ready |
| A-composed (variable-pin + variable-schema) | Both axes vary | 1 firm (counter-preset) | 1 agent | ✅ Canonicals available (compose A-variable-pin + A-multi-bit-schema) |
| B | Sibling-only no-pin | 2 | 1 agent | ✅ Canonical authored (transformer-coupling.ts) |
| C | MNA-stamp analog | 9 | 2 agents (passive / branch-bearing split) | ✅ Canonicals authored (transmission-segment-r/l.ts) |
| D | Hybrid pin+stamp+state | 3 firm (J-020 comparator, J-028 schmitt, J-022 DAC) | 1 agent | ✅ Canonical authored (comparator-driver.ts) |
| E | Mechanical deletion | 8 | — | ✅ COMPLETE (this session, direct execution; +2 same-blast-radius orphan files swept) |

**This-session orderable:** all live-driver buckets are now unambiguous; no
reconciliation pending.

---

## Decisions / unblockers needed from user

1. ~~**A-variable architectural decision** (10 jobs)~~ ✅ **RESOLVED**: variable
   pinLayout via `pinLayoutFactory` was already supported by the compiler;
   canonical `and-driver.ts` written this session. 7 of the original 10 jobs
   fit this template directly (gates + mux); the other 3 (demux, decoder,
   splitter) decompose to A-fixed via parent-emits-N (their outputs are
   independently computable from inputs, no internal coupling).

2. ~~**A-multi-bit unblocker** (4 jobs)~~ ✅ **RESOLVED**: variable arity
   schemas are realised via module-scope memoised factory (one frozen
   schema per bitWidth value, defined first time it is seen, reused
   thereafter). One-line compiler.ts:410 fix lets siblingState resolution
   read the per-instance schema from the constructed sibling. Canonical
   `counter-driver.ts` written this session. J-157 seven-seg re-classified
   to A-fixed (no variable arity needed). J-139 counter / J-140
   counter-preset / J-154 register fit Template A-multi-bit-schema (or
   compose with A-variable-pin for runtime data inputs).

3. ~~**D-ambiguity** (J-022 + J-018)~~ ✅ **RESOLVED**: split, don't pick one.
   - **J-022 DAC = Template D firm.** DAC has ONE analog output (`OUT`)
     whose value `V_ref · code / 2^N` is a global function of all N input
     bits — not per-bit decomposable. Per `dac.ts:200-232`, the netlist
     declares `branchCount: 1` and the comment says the driver "stamps
     target at OUT via VCVS shape". State payload mirrors `comparator.ts`
     (settling-time weight + threshold-classification holds). Use
     `comparator-driver.ts` as canonical.
   - **J-018 ADC = Template A-multi-bit-schema** (reclassified out of D).
     Per `adc.ts:144-205`, the `ADCDriver` reads only INPUT pins
     (VIN/CLK/VREF/GND), no MNA stamps; writes per-bit slots
     (`OUTPUT_EOC`, `OUTPUT_D{i}`) consumed by N+1 sibling
     `DigitalOutputPinLoaded` sub-elements via siblingState. The "packed
     SAR_BITS slot" wording in the J-018 spec is stale — the live netlist
     already lays out per-bit slots. Same shape as `counter-driver.ts`.
   - The user's earlier "ADC/DAC fit existing mechanisms" comment was right
     but conflated two different mechanisms: DAC fits Template D's
     hybrid-stamp mechanism; ADC fits A-multi-bit-schema's
     siblings-own-the-VSRC mechanism.

4. ~~**Register spec clarification** (J-154)~~ ✅ **RESOLVED**:
   parallel-load → A-fixed via parent-emits-N decomposition.
   - `register.ts:42-79` declares D and Q as bus-wide pins (widths scale
     with `bitWidth` property), no shift-in / shift-out / chain-direction
     pins.
   - `register.ts:144-149` (flat `executeRegister`) atomically copies the
     entire D bus to stored on `(C↑ ∧ en)`; combinational
     `Q = stored`. No per-bit shift; no inter-bit dependency.
   - Output bit i = stored bit i, depends only on D_i + broadcast
     C / en / gnd. Parent `buildRegisterNetlist(bitWidth)` emits N copies
     of a 1-bit `BehavioralRegisterBitDriver` (D, C, en, gnd →
     `OUTPUT_LOGIC_LEVEL`) plus N sibling `DigitalOutputPinLoaded` on
     Q0..Q_{N-1}. Same parent-decomposition pattern as J-144 demux /
     J-143 decoder / J-158 splitter.
   - The 1-bit driver is `d-flipflop-driver.ts` shape with an `en`-guard
     on the edge-triggered sample (~2-line load() delta).
   - There is **no shift-register component** in the repo (`Glob
     register*.ts` returns only `register.ts` and `register-file.ts`), so
     the J-154 ambiguity collapses — parallel-load is the only shape that
     exists.

5. **E ordering**: do we want E (deletions) to run BEFORE or AFTER the
   live-driver buckets? Doing E first reduces context noise on agents
   spawned later (the broken-import errors disappear). My recommendation:
   E first. (E itself is already complete this session.)

6. **Canonical-template authoring authority**: do we (the user + me
   directly) author Templates B, C, D this session, or spawn dedicated
   "template author" agents per template? My recommendation: direct
   authoring — these need to be exemplar-grade and the d-flipflop refactor
   showed that's not agent-friendly work. ✅ All canonicals (A current, A
   variable-pin, A multi-bit-schema, B, C, D) now exist.

All open questions resolved. Next moves: spec-audit each cluster's spec
excerpts, harden any gaps, then spawn per-cluster agents against the
now-correct templates.

---

## Resolved this session (D1 verification + missing-file audit)

### siblingBranch / siblingState — confirmed implemented

Both resolvers are live in the compiler. D1 question "does the siblingBranch resolver exist?" → **yes**, with documented contract.

- **Type contract:** `src/core/mna-subcircuit-netlist.ts:18-22` — `SubcircuitElementParam` 4-arm closed union: `number | string | { kind: "siblingBranch"; subElementName } | { kind: "siblingState"; subElementName; slotName }`.
- **Resolution path:** `src/solver/analog/compiler.ts:381-431`:
  - `siblingBranch` → compiler stamps the global label `${parentLabel}:${subElementName}` into the dependent leaf's prop bag at the param key. Dependent leaf's `setup()` calls `ctx.findBranch(label)` to resolve to the branch index.
  - `siblingState` → compiler resolves slot via `siblingSchema.indexOf(slotName)`; flat pool index = `sibling._stateBase + slotIdx`.
- **Live consumers:** `tapped-transformer.ts` (TransformerCoupling, 3 siblingBranch refs); all flipflop parents (DigitalOutputPinLoaded via siblingState); timer-555.ts (siblingState); comparator.ts (state schema participates).

### D2 (push vs pull cross-element state) — answered by the compiler

`compiler.ts:428-432` enforces:

> "Cross-leaf coupling MUST go through pool slots (siblingState) to preserve StatePool rollback. See composite-architecture-job.md ss11.2."

This is a **hard requirement**, not a preference. RelayCoupling MUST write to its own slot; contactSW MUST read it via siblingState. Push-model writes (RelayCoupling mutating contactSW's slot directly) would break StatePool rollback across NR retries / LTE rejections. Template B agents do not have a choice here; the spec must reflect this constraint.

### Missing-file audit — 2 files referenced but not on disk

- `src/components/switching/relay-coupling.ts` (J-095) — does not exist
- `src/components/passives/transformer-coupling.ts` (J-063) — does not exist

Both `RelayCoupling` and `TransformerCoupling` typeIds are referenced by:
- `src/components/switching/relay.ts` (RelayCoupling in netlist)
- `src/components/switching/relay-dt.ts` (RelayCoupling in netlist)
- `src/components/passives/tapped-transformer.ts` (TransformerCoupling in netlist)
- `src/components/register-all.ts` (registration site)

Implication: **three user-facing parent composites are likely currently broken at registration time** (their netlists reference unresolvable typeIds). J-095 + J-063 are not "new functionality" — they are unblockers for already-shipped parents.

### Priority elevation: Template B → top of Wave 2 work order

Template B authoring (sibling-only no-pin coupling driver) jumps ahead of Templates C and D in this session's authoring order. Recommended sequence:

1. Author canonical Template B (`transformer-coupling.ts` first as the worked example, `relay-coupling.ts` second following the same shape). Both directly authored, not delegated.
2. Verify the 3 broken parents now register cleanly.
3. Then resume the original decision queue: A1 (multi-bit output), then Templates C / D / A-variable.

This sequencing is locked in unless the user redirects.
