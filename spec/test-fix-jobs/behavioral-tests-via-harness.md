# Behavioral counter / register / pin-loading tests — Facade-vs-Harness duality

## Problem

Nine tests across three files build behavioral analog elements by hand,
bypass the production compile pipeline entirely, and either probe internal
JS state on the element or spy on the sparse-solver allocator. Today they
fail because the elements they hand-construct are not driven through the
flow that gives them meaningful node voltages or `_pinLoading` propagation.

Failing tests, by file:

`src/solver/analog/__tests__/behavioral-sequential.test.ts`
- `Counter > counts_on_clock_edges` — `expected +0 to be 5`
- `Counter > clear_resets_to_zero` — `expected +0 to be 3`
- `Counter > output_voltages_match_logic` — `expected +0 to be 5`
- `Register > latches_all_bits` — `expected +0 to be 165`
- `Register > holds_value_across_timesteps` — `expected +0 to be 85`
- `Task 6.4.3 — sequential_pin_loading_propagates`

`src/solver/analog/__tests__/behavioral-gate.test.ts`
- `Task 6.4.3 — pin_loading_respects_per_net_override_on_gate_input`
- `Task 6.4.3 — gate_output_uses_direct_role`

`src/solver/analog/__tests__/behavioral-combinational.test.ts`
- `Task 6.4.3 — combinational_pin_loading_propagates`

Every one of these constructs a `DigitalInputPinModel` / `DigitalOutputPinModel`
directly, attaches a stub solver of the form
```ts
{ allocElement(_r,_c) { return 0 }, stampElement(_h,_v) {}, stamp(_r,_c,_v) {} }
```
and either:
1. calls `element.accept(...)` with a hand-built `Float64Array` of voltages
   and expects `element.count` / `element.storedValue` to update; or
2. inspects the recorded `(row, col)` pairs from the stub allocator to
   assert which pin diagonals were stamped.

Neither shape exists on the production `SimulatorFacade` and neither is a
contract the editor / postMessage / MCP surface ever calls.

## The Facade-vs-Harness duality

### What `SimulatorFacade` exposes

`src/headless/facade.ts` is a stable contract for production callers
(MCP server, postMessage adapter, `app-init`, headless tests). Its methods
group into:

- **Build / patch** — `createCircuit`, `addComponent`, `connect`, `build`,
  `patch`, `loadDigXml`, `serialize`, `deserialize`, `importSubcircuit`.
- **Compile / run** — `compile`, `step`, `run`, `settle`, `stepToTime`.
- **Drive / read I/O at signal granularity** — `setSignal(label, value)`,
  `readSignal(label)`, `readAllSignals()`. These accept and return *digital
  bus values* or *analog voltages keyed by element label*; they do not
  expose net IDs, MNA matrix rows, NR iteration history, or per-element
  state slots.
- **Tests** — `runTests` against embedded test vectors.
- **Introspection** — `netlist`, `validate`, `describeComponent`.

`DefaultSimulatorFacade` (`src/headless/default-facade.ts`) adds three
groups of methods that are deliberately *not* on the interface — they are
session accessors that reach inside without violating the public contract:

- `getCoordinator()`, `getActiveCoordinator()`, `getCircuit()`,
  `getCompiledUnified()` — return concrete coordinator / circuit.
- `getDcOpResult()` — surface the DC operating-point result struct.
- `setCaptureHook(bundle)`, `setConvergenceLogEnabled`,
  `getConvergenceLog`, `clearConvergenceLog` — wire deeper diagnostics
  for the harness and the convergence log UI.

The capture-hook setter is the single hand-off point between the facade
and the comparison harness. Once installed, the harness owns
per-iteration / per-attempt / per-step recording; the facade does not
expose that data through `readSignal` or any other named API.

### What `ComparisonSession` exposes

`src/solver/analog/__tests__/harness/comparison-session.ts` (≈2500 lines,
public class `ComparisonSession`) is constructed *with a `.dts` path*,
internally builds a `DefaultSimulatorFacade`, calls `facade.deserialize`,
calls `facade.compile`, grabs the resulting coordinator and the underlying
`MNAEngine`, installs a `PhaseAwareCaptureHook` via `facade.setCaptureHook`,
and runs an analysis (`runDcOp` or `runTransient`).

Its query surface (every method here is on the harness, not the facade):

- Topology — `_ourTopology`, `listComponents`, `listNodes`,
  `getComponentsByType`.
- Per-step / per-iteration trace — `getStepEnd`, `getIterations`,
  `getStep`, `getAttempt`, `getStepShape`, `getSessionShape`,
  `getStepAtTime`, `sessionMap`.
- Per-element internal state — every `IterationSnapshot` carries
  `elementStates: ElementStateSnapshot[]` populated from
  `captureElementStates(circuit.elements, pool)`, which reads the
  element's `stateSchema` and fills `slots` / `state1Slots` /
  `state2Slots` from the engine's state pool. `getStepEnd` / `getStep`
  expose those slots keyed by component label.
- Matrix / RHS — sparse-solver row/col entries per iteration, retrievable
  via `getIterations` and `getStep` on `iter.matrix` (sparse `(row, col,
  value)` triples) and `iter.preSolveRhs`.
- ngspice comparison — `getDivergences`, `compareSnapshots`,
  `findFirstDivergence`, full `_nodeMap`-based reindex.

Internal accessors that test code reaches into directly:
- `_ourTopology` (matrix-row / matrix-col labels, matrix size).
- `_engine.solver` — the `SparseSolver`. `SparseSolver` itself owns
  `_insertionOrder: Array<{ extRow: number; extCol: number }>`,
  `_getInsertionOrder()`, and `getCSCNonZeros()`.
- `_engine.statePool`, `_engine.elements`, `_engine.compiled`.

### Verdict — keep the duality, name its discipline

The `SimulatorFacade` interface is the **bounded production-call API**:
labels in, labels out, integer step counts, base-64 export. It is the
contract that the postMessage bridge and MCP server stabilize against
and that UI work programs to. Adding "give me element X's NR-iteration
matrix entries" to that interface would expose every NR-loop and
sparse-solver internal to every consumer that just wants to drive a
signal.

The harness is the **bounded numerical-investigation API**: it gets the
fully compiled coordinator + engine + sparse solver after the facade has
finished its job, installs hooks, and emits per-iteration evidence. It
is the only context in the project that legitimately reads matrix
entries and per-iteration state pools — that is what it exists for, and
it is what the hard rule "ngspice Comparison Harness — First Tool for
Numerical Issues" in `CLAUDE.md` tells you to use.

These are not redundant; they are *layered*. The facade is mandatory for
the production path; the harness sits one layer below (it constructs
exactly one facade per session in `init()`/`initSelfCompare()`) and adds
read access to the artifacts the facade deliberately doesn't expose.

The duality should be kept; the name we give it from now on is:

- **Production-API discipline**: `SimulatorFacade` exposes labels +
  values. No NR iteration, no matrix rows, no state slots. Adding any
  of those is a change to the postMessage / MCP contract and must be
  treated as such.
- **Numerical-investigation discipline**: `ComparisonSession` is the
  only sanctioned route to per-iteration / per-element-state / matrix
  data. Its consumer is tests, parity work, and the harness MCP tools,
  not the editor or a postMessage caller.

### What this means for the failing tests

All nine failing tests are written against a third, undocumented surface:
hand-rolled pin models, hand-rolled solver stubs, hand-rolled `accept()`
calls. That surface is a **per-element unit-test bench** that bypasses
both the facade *and* the harness. It exists only because the test files
predate the harness's full topology + matrix surface.

Per the user direction (the sequential-state and matrix-allocation
issues that were previously tracked separately are one root cause, not
two),
the fix is to migrate every one of these tests onto the
`.dts → ComparisonSession` route. None of them needs new facade API.
None of them needs a new harness API. The data they assert on already
flows through the harness:

| Assertion in failing test                               | Harness route                                                 |
|---------------------------------------------------------|---------------------------------------------------------------|
| `element.count === 5`                                   | `getStepEnd(stepIdx).components[label].slots["COUNT"]` (or read the count bit-by-bit from output node voltages via the topology). |
| `element.storedValue === 0xA5`                          | `getStepEnd` slots / per-bit output node voltages.            |
| `allocElement` was called with `(1,1)` but not `(2,2)`  | `_engine.solver._getInsertionOrder()` after `init()` — the topology insertion order is set in `setup()`, before any analysis runs. |
| Output bit at MNA node `n` is V_OH/V_OL                 | `getStepEnd(0).nodes[label]` voltages.                        |

`element.count` and `element.storedValue` are JS getters on the live
element object — those values can be read via
`harness._engine.elements[idx]` in the same way `_ourTopology` is read,
or, more cleanly, exposed through the existing `stateSchema` slot
mechanism (`SEQUENTIAL_COMPOSITE_SCHEMA` already lists slots for the
sequential composite — look up the slot index via `stateSchema.indexOf`,
read `state0[stateBase + idx]`).

## ngspice parity context

ngspice's own test fixtures (`ref/ngspice/tests/general/rc.cir`,
`ref/ngspice/tests/general/diffpair.cir`,
`ref/ngspice/tests/transient/fourbitadder.cir`, etc.) are all
**netlist-as-authored** — the test runs the same `.cir` an end user
would write. ngspice has no concept of a unit test that hand-builds an
internal `CKTcircuit*`, allocates a stub `SMPmatrix*`, and asserts that
a particular `(extRow, extCol)` was passed to `spGetElement`. Internal
data structures are inspected by `cmppar` against a reference
`*.out0.cir.out` file produced by running the netlist.

The digiTS analog is exactly the harness's self-compare mode:
`ComparisonSession.createSelfCompare({ dtsPath, analysis: "tran" })`.
The circuit is authored as `.dts`, the harness runs it through the
production compile path, and the per-iteration / per-step / per-element
record is read back through the public harness surface.

This is the parity citation: ngspice fixtures live as `*.cir`, are run
through the production engine, and inspected through the standard
output channels. Our equivalent is `.dts` + `ComparisonSession`.

## Per-test fix-path mapping

### `behavioral-sequential.test.ts` — counter / register state

For the six failing Counter / Register tests:

1. Build a `.dts` fixture under
   `src/solver/analog/__tests__/fixtures/behavioral-sequential/` for each
   topology variant (a 4-bit counter driven by a clock + clr source; an
   8-bit register driven by 8 data sources + clock + en source). Use
   `circuit_build` via MCP or hand-write the JSON to match the schema
   produced by `dtsSerializer`.
2. Replace the test body with:
   ```ts
   const session = await ComparisonSession.createSelfCompare({
     dtsPath: "src/solver/analog/__tests__/fixtures/behavioral-sequential/counter-4bit.dts",
     analysis: "tran",
     tStop: <enough to apply N rising edges>,
   });
   ```
   Drive the clock through scheduled voltage sources (or a piecewise
   source) so that N rising edges fire within `tStop`. Read the output
   bit voltages from `session.getStepEnd(lastIdx).nodes["out_0"..]` and
   reconstruct the count / stored value from the bit pattern. *That*
   is the post-migration assertion.

   For tests that need to assert "value held across timesteps,"
   `getStepEnd` for each step provides the per-step output node
   voltages; assert they remain at V_OH/V_OL across all steps after
   the latch.

3. Read of `element.count` / `element.storedValue` is replaced by the
   bit-pattern reconstruction above. If a test genuinely needs the raw
   integer (e.g., to discriminate between two encodings that produce
   the same MNA voltages), wire it through the existing
   `stateSchema` + state pool route via
   `harness._engine.elements[idx]` and the slot index from
   `stateSchema.indexOf`. No new API.

### `behavioral-sequential.test.ts` — `sequential_pin_loading_propagates`

This test asserts that a per-pin `_pinLoading` override drives the
allocator to stamp `(1,1)` but not `(2,2)`.

`_pinLoading` on the `PropertyBag` is **set by the production compiler**
(`src/solver/analog/compiler.ts` line 1380), populated via
`resolvePinLoading(nodeId, digitalPinLoading, nodeIdToLoadingOverride,
false)`, where `nodeIdToLoadingOverride` is a per-net override map
sourced from `circuit.metadata.digitalPinLoadingOverrides`. The .dts
schema persists `digitalPinLoading` and `digitalPinLoadingOverrides`
attrs at the circuit level (`dts-deserializer.ts` lines 184-195).

Fix path: extend the .dts fixture to set
`digitalPinLoadingOverrides` so the net the counter's `en` pin attaches
to has `loaded: true` and the nets the `C` and `clr` pins attach to have
`loaded: false`. Then assert via the harness:

```ts
const insertionOrder = harness._engine.solver!._getInsertionOrder();
// Translate "en" pin label → MNA node ID via the topology, then check
// that (nodeId, nodeId) appears and (otherNodeId, otherNodeId) does not.
```

`_getInsertionOrder()` is already public on `SparseSolver`; no new API.
The topology's `nodeLabels` / pin-to-node-ID map already lives on
`harness._ourTopology` and `harness._engine.elements[idx]._pinNodes`.

### `behavioral-gate.test.ts` — `pin_loading_respects_per_net_override_on_gate_input` and `gate_output_uses_direct_role`

Same shape as the sequential pin-loading test. Build a `.dts` fixture
with a single AND/OR gate, set per-net `digitalPinLoadingOverrides` so
`In_1` is on a "not loaded" net and `In_2` / `out` are on "loaded"
nets, run a DC OP via `createSelfCompare({ analysis: "dcop" })`, then
inspect `_getInsertionOrder()` and assert which `(row, row)` diagonals
were allocated.

`gate_output_uses_direct_role` reduces to "no branch row was allocated"
— assert by checking that no entry in `_getInsertionOrder()` has
`extRow > nodeCount`. `nodeCount` is on `_ourTopology`.

### `behavioral-combinational.test.ts` — `combinational_pin_loading_propagates`

Same shape: 2:1 mux fixture + per-net override + harness
`_getInsertionOrder()` assertion.

## Summary table

| Test                                                          | Fix path                                                                                          |
|---------------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| `counts_on_clock_edges`                                       | `.dts` counter fixture + `ComparisonSession.createSelfCompare({analysis:"tran"})` + bit-reconstruct from output node voltages |
| `clear_resets_to_zero`                                        | same                                                                                              |
| `output_voltages_match_logic`                                 | same — assertions are already voltage-shaped, just route via harness                              |
| `latches_all_bits`                                            | `.dts` 8-bit register fixture + same harness route                                                |
| `holds_value_across_timesteps`                                | same; assert per-step output voltages stay at V_OH/V_OL                                           |
| `sequential_pin_loading_propagates`                           | `.dts` counter fixture + `digitalPinLoadingOverrides` per-net + `_getInsertionOrder()` assertion  |
| `pin_loading_respects_per_net_override_on_gate_input`         | `.dts` 2-input gate fixture + `digitalPinLoadingOverrides` + `_getInsertionOrder()`               |
| `gate_output_uses_direct_role`                                | same; assert no `extRow > nodeCount` in insertion order                                           |
| `combinational_pin_loading_propagates`                        | `.dts` 2:1 mux fixture + `digitalPinLoadingOverrides` + `_getInsertionOrder()`                    |

## Category

**`contract-update`** — the failing tests assert against a contract
(hand-rolled pin model + stub solver) that is not the one production
implements. Nothing in the production path needs to change; the
production path already routes per-net pin-loading overrides through
the compiler and exposes the resulting matrix shape via the existing
`SparseSolver._getInsertionOrder()` and harness topology surface. The
work is rewriting tests against the existing two-tier contract
(facade for label-driven I/O, harness for matrix / per-iteration / per-element-state inspection).

## Tensions and uncertainties

1. **Should `_pinLoading` be expressible directly per-element in `.dts`,
   or only via `digitalPinLoadingOverrides` keyed by net?** Production
   keys it by net (a pin "is loaded" if any element on the net wants
   loading). Per-pin override on the *element* would be a new schema
   field and a new compiler path. Recommendation: **per-net only** —
   it matches production. The failing tests' "set `_pinLoading` directly
   on the element's PropertyBag" pattern is artificial; production
   never does that.

2. **Harness-internal access (`harness._engine`, `harness._ourTopology`)
   is via protected fields cast to `any` in the existing tests.** The
   harness exposes typed query methods (`listComponents`, `listNodes`,
   `getStepEnd`) but no typed accessor for `_getInsertionOrder()` or for
   the live `_pinNodes` map of an element. If we want strict typing in
   the migrated tests, the harness should grow a single typed accessor
   for those — e.g. `getMatrixInsertionOrder(): readonly { extRow:
   number; extCol: number }[]`. This is the only place a harness API
   addition is plausibly justified, and it is small. *Escalation point*:
   user decision whether to add or to keep `(harness as any)._engine`
   tunneling in test-only code.

3. **Whether matrix-allocation assertions belong in tests at all.**
   "Element X allocates `(1,1)` but not `(2,2)`" is a *structural*
   assertion about the production compiler's pin-loading lowering. It
   is currently the only direct evidence that the per-net override was
   honored. The architecturally clean form is observable behavior: load
   a net through a finite-impedance source and assert the voltage sag
   matches a loaded vs. ideal pin's `rIn`. That requires a `.dts`
   fixture with a non-ideal source on the targeted net and a numerical
   tolerance on the resulting sag. The structural-assertion form is
   cheaper and more direct. Recommendation: **keep the structural
   form** via `_getInsertionOrder()`; it is the cheapest, most direct
   evidence and the harness was built to expose exactly this kind of
   matrix-shape information. *Escalation point*: user decision.

4. **`output_voltages_match_logic` and the register / counter "load &
   read" tests already had voltage-shaped intent — they read pin
   voltages.** The failing assertions write to internal `count` /
   `storedValue`; those are getters, not the production output. Once
   migrated to harness + `.dts`, the assertion *is* the output voltage,
   not the JS-side getter. This is an improvement, not a loss.

5. **The harness today reads `.dts` via `readFileSync` from a path.**
   Tests that build the circuit programmatically via
   `createSelfCompare({ buildCircuit })` skip the file. Both routes are
   acceptable; `buildCircuit` keeps the test self-contained. Either is
   fine for the migration.

## Out-of-scope for this spec

- Adding any method to `SimulatorFacade`. None of these tests needs new
  facade surface.
- Unifying facade and harness. They are layered, not redundant; see
  duality verdict.
- Changing production `_pinLoading` semantics. The production compiler
  already keys it by net via `digitalPinLoadingOverrides`; the test
  migration must use that path, not invent a new one.
