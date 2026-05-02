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

### A-variable (1-bit truth function but variable pin/slot count per instance)

These need either (a) variable pinLayout per instance — which the d-flipflop
template's module-level static pinLayout disallows — or (b) a fixed
"max-arity" pinLayout, or (c) per-arity registered driver types. Architectural
clarification needed before these can be assigned to Template A.

| Job | File | Variable in |
|---|---|---|
| J-134 | `and-driver.ts` | inputCount (2..N) |
| J-153 | `or-driver.ts` | inputCount |
| J-150 | `nand-driver.ts` | inputCount |
| J-151 | `nor-driver.ts` | inputCount |
| J-161 | `xor-driver.ts` | inputCount |
| J-160 | `xnor-driver.ts` | inputCount |
| J-149 | `mux-driver.ts` | selector_bits (1..4) → 2..16 inputs |
| J-144 | `demux-driver.ts` | selector_bits |
| J-143 | `decoder-driver.ts` | selector_bits → output count |
| J-158 | `splitter-driver.ts` | port count + widths from string-parsed pattern |

**Subtotal:** 10 jobs blocked on the variable-shape architectural decision.

### A-multi-bit (driver intrinsically owns multi-bit semantics)

These are not "1 driver per bit, parent emits N" — they own the multi-bit
state directly (e.g. counter increments an integer; seven-seg decodes 4
input bits to 7 output segments). Blocked on the separately-specced
multi-bit driver path.

| Job | File | Multi-bit reason |
|---|---|---|
| J-139 | `counter-driver.ts` | integer counter state |
| J-154 | `register-driver.ts` | N-bit storage |
| J-140 | `counter-preset-driver.ts` | integer counter + preset value |
| J-157 | `seven-seg-driver.ts` | 4→7 bit decoder |

**Subtotal:** 4 jobs deferred to the multi-bit work-stream's template.

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
| J-022 | `src/components/active/dac-driver.ts` | needs audit: per user comment may fit Template A (1-bit-per-output-pin) instead, since DAC has N independent single-pin outputs handled by existing mechanism |
| J-018 | `src/components/active/adc-driver.ts` | packed SAR_BITS slot — internal SAR loop is hybrid; comment about ADC/DAC fitting "existing mechanisms" needs reconciliation |

**Subtotal:** 4 jobs (2 firm hybrid; 2 with user-flagged ambiguity).
**Prerequisite:** author canonical Template D file.

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
| A-fixed | Pure-truth 1-bit, fixed pins | 7 | 1 agent (batched) | Spec audit before spawn |
| A-variable | Pure-truth 1-bit, variable pins | 10 | — | **Blocked on architectural decision** |
| A-multi-bit | Multi-bit-intrinsic drivers | 4 | — | **Blocked on multi-bit work-stream template** |
| B | Sibling-only no-pin | 2 | 1 agent | **Blocked on canonical authoring** |
| C | MNA-stamp analog | 9 | 2 agents (passive / branch-bearing split) | **Blocked on canonical authoring** |
| D | Hybrid pin+stamp+state | 4 (2 firm + 2 ambiguous) | 1 agent | **Blocked on canonical authoring** + ambiguity reconciliation |
| E | Mechanical deletion | 8 | — | ✅ COMPLETE (this session, direct execution; +2 same-blast-radius orphan files swept) |

**This-session orderable:** A-fixed (after spec audit). Other buckets
blocked on either canonical authoring or architectural decisions.

---

## Decisions / unblockers needed from user

1. **A-variable architectural decision** (10 jobs): how do drivers handle
   variable input/output count? (a) per-instance pinLayout, (b) fixed
   max-arity with gnd-padded unused pins, (c) per-arity registered driver
   types, (d) something else? The d-flipflop template forbids per-instance
   pinLayout via the module-level-static rule, so the answer is one of
   (b)/(c) or a new template-A2.

2. **A-multi-bit unblocker** (4 jobs): the separately-specced multi-bit
   driver path needs to land before counter/register/seven-seg drivers can
   be authored. Confirm that's downstream of this session.

3. **D-ambiguity** (J-022 + J-018): the DAC/ADC drivers — are they Template
   D (hybrid) or Template A (1-bit-per-output, parent emits N)? User's
   earlier comment said "ADC/DAC handled through existing mechanisms" which
   implies Template A; J-018's "packed SAR_BITS slot" implies Template D.
   Pick one.

4. **E ordering**: do we want E (deletions) to run BEFORE or AFTER the
   live-driver buckets? Doing E first reduces context noise on agents
   spawned later (the broken-import errors disappear). My recommendation:
   E first.

5. **Canonical-template authoring authority**: do we (the user + me
   directly) author Templates B, C, D this session, or spawn dedicated
   "template author" agents per template? My recommendation: direct
   authoring — these need to be exemplar-grade and the d-flipflop refactor
   showed that's not agent-friendly work.

Once these are answered, the next moves are clear.
