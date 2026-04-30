# composite-behavioral-families

## Sites

Already extending `CompositeElement` — audit-only:

- `src/solver/analog/behavioral-gate.ts` — `BehavioralGateElement`
  (line 71)
- `src/solver/analog/behavioral-combinational.ts` — three `extends
  CompositeElement` classes referenced via `getSubElements()` overrides
  (lines 104, 236, 355). The class names use `_selPins` /
  `_childElements` and follow the gate pattern.
- `src/solver/analog/behavioral-remaining.ts` — five `extends
  CompositeElement` classes:
  - `DriverAnalogElement` (line 68)
  - `DriverInvAnalogElement` (line 178)
  - `SplitterAnalogElement` (line 293)
  - `SevenSegAnalogElement` (line 515)
  - `ButtonLEDAnalogElement` (line 563)
- `src/solver/analog/behavioral-sequential.ts` — three `extends
  CompositeElement` classes:
  - `BehavioralCounterElement` (line 62)
  - `BehavioralRegisterElement` (line 225)
  - `BehavioralCounterPresetElement` (line 451)
- `src/solver/analog/behavioral-flipflop.ts` — flip-flop classes (need
  audit; line ~1-330).

## Sub-elements (general shape)

Behavioral families compose `DigitalInputPinModel` and
`DigitalOutputPinModel` (one per gate input/output) plus
`AnalogCapacitorElement[]` from `collectPinModelChildren(...)`. They do
NOT instantiate sub-elements through registered model factories like
`createBjtElement` / `createDiodeElement`. As a result they do NOT call
`new PropertyBag()` followed by `replaceModelParams(...)` — the pin
models are constructed from `ResolvedPinElectrical` literals directly.

**`PropertyBag.forModel` is not needed at any of these sites.**

## Internal nodes

None. The pin models map external pins to MNA nodes; no per-composite
internal node allocation.

## Setup-order

Each subclass already declares its `getSubElements()` order: input pin
models first, output pin model, then capacitor children
(behavioral-gate.ts:99-101 is the canonical shape). This is the
convention; new behavioral classes should follow it.

The base's `super.setup(ctx)` walks them in this order; no override
needed except where pin-model setup must happen alongside an explicit
loop (rare).

## Load delegation

`BehavioralGateElement.load()` (lines 103-130) overrides the base's
default to interleave a truth-table evaluation between input and output
pin-model stamps:

1. Read input voltages from `rhsOld`, evaluate threshold per
   `DigitalInputPinModel.readLogicLevel(...)`, latch indeterminate.
2. Compute output bit via `truthTable(latchedLevels)`.
3. `output.setLogicLevel(outputBit)`.
4. Stamp inputs.
5. Stamp output.
6. Stamp capacitor children.

This shape is composite-specific and stays as an override. The base does
not collapse it.

The other behavioral subclasses (Counter, Register, CounterPreset, Driver,
Splitter, SevenSeg, ButtonLED) have similar custom `load` shapes that
intercalate composite-owned glue with sub-element stamps. All stay as
overrides.

## Specific quirks (per site)

### behavioral-gate.ts

- `getSubElements()` is a manual array build, NOT through `addSubElement`.
  After the refactor the subclass can either:
  1. Call `addSubElement("In_1", inputPin)`, `addSubElement("In_2",
     inputPin)`, …, `addSubElement("out", outputPin)`, then drop the
     manual `getSubElements()` override; OR
  2. Keep the manual override (it's cheap and explicit).

  **Recommendation: option 2 for behavioral families.** The manual
  override is ~3 lines, the input-count is dynamic per gate type
  (NOT/AND/OR/NAND/etc.), and threading the names through `addSubElement`
  adds bookkeeping for no gain. The base accepts both shapes.

- No `(child as any)._pinNodes.set(...)` — pin models are constructed
  with their node IDs at factory time via `pin.init(nodeId, 0)`.
  `bindSubPin` is not needed here.

- No `make*Props` helper — the pin-model constructor takes
  `ResolvedPinElectrical` directly, not a `PropertyBag`.

### behavioral-combinational.ts

Same shape as behavioral-gate. `_selPins` is an array of
`DigitalInputPinModel` for the SEL bus, `_childElements` is
`AnalogCapacitorElement[]`. `getSubElements()` returns the spread.

### behavioral-remaining.ts

Five subclasses (Driver, DriverInv, Splitter, SevenSeg, ButtonLED). Same
shape; each has its own custom `load` override.

### behavioral-sequential.ts

Three subclasses with composite-level state (latch slots, counter values
held across timesteps). Each declares its own `stateSchema` with the
latch slot. `super.initState(pool)` from the base will allocate the
composite's slots at `_stateBase` and the children's after. **This works
correctly today** — these classes are the existing exemplar of how to
compose state with `CompositeElement`.

### behavioral-flipflop.ts (audit pending)

Same family. Likely no `make*Props` helpers; just verify via grep before
the dispatch round.

## Migration shape

Behavioral families do NOT need the `PropertyBag.forModel` change (no
sub-element prop bags). They do NOT need `addSubElement` migration — the
existing manual `getSubElements()` overrides are correct and idiomatic.

The only audit task is to confirm:

1. No site has a hidden `make*Props`-style helper that spreads a model
   defaults record. (Confirmed clean for behavioral-combinational and
   behavioral-remaining via repository search; flag any new site that
   appears.)
2. No site uses `(child as any)._pinNodes.set(...)`. (Confirmed clean
   via repository search.)
3. The state-aggregation contract (`stateSize` getter, `initState(pool)`
   delegation) lines up with the base. The Counter/Register/CounterPreset
   classes are the exemplars.

## Resolves

No active failures listed for behavioral families in
`test-results/test-failures.json`. This site exists in the rollout list
to confirm the refactor does NOT regress any behavioral test (the audit
is preventive, not corrective).

## Category

`architecture-fix` (audit-only — no expected source changes unless an
unflagged `make*Props` or `as any` site is discovered)
