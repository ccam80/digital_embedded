# Digital pin model: split into Loaded / Unloaded classes

**Category:** `architecture-fix`

## Problem statement

`DigitalInputPinModel.setup()` calls
`ctx.solver.allocElement(this._nodeId, this._nodeId)` unconditionally — even
for instances constructed with `loaded=false`. The runtime `_loaded` flag
gates `load()` (which early-returns on `!_loaded`), but it does NOT gate
`setup()`. The result is that an "unloaded" input pin still allocates a
matrix slot during structural setup; the slot is just never written to
during NR. The `bridge-adapter.test.ts` "input adapter unloaded stamps
nothing" expectation reads CSC non-zeros after `load()` and demands an
empty entry list — which fails because setup-time `allocElement` registers
a structural non-zero on the diagonal regardless. The behavior is
inconsistent: a no-op `load()` is paired with a non-no-op `setup()`.

The user-direction fix is to split `DigitalInputPinModel` (and, by symmetry,
the loading half of `DigitalOutputPinModel`) into two classes that
implement different setup/load contracts statically, picked by the
compiler at construction:

- `DigitalInputPinLoaded` — allocates the diagonal element in `setup()` and
  stamps `1/rIn` in `load()`. May own a child `AnalogCapacitorElement` for
  `cIn`.
- `DigitalInputPinUnloaded` — `setup()` is a no-op (no `allocElement`),
  `load()` is a no-op, no child capacitor. Threshold detection
  (`readLogicLevel`) remains, since it is a pure-arithmetic node-voltage
  read and is not part of MNA assembly.

The `_loaded: boolean` flag is removed from the runtime. The compiler-side
loading resolution (`resolvePinLoading` at `compiler.ts:94-108`) remains
the single source of truth for which class to instantiate, and its
boolean output is consumed at construction-site choice instead of being
stored on the model.

## Sites

### Production code

- `src/solver/analog/digital-pin-model.ts` (full file) — the runtime
  `_loaded` flag lives at lines 51, 79, 95, 126, 145, 166, 174, 196 (output
  pin) and 260, 271, 273, 282, 303, 319, 322 (input pin). Both classes
  branch on the flag at runtime.
- `src/solver/analog/digital-pin-model.ts:328-331` — the offending
  unconditional `allocElement` in `DigitalInputPinModel.setup`:
  ```ts
  setup(ctx: SetupContext): void {
    if (this._nodeId <= 0) return;
    this._hNodeDiag = ctx.solver.allocElement(this._nodeId, this._nodeId);
  }
  ```
- `src/solver/analog/digital-pin-model.ts:190-203` — the parallel issue in
  `DigitalOutputPinModel.setup`. The branch role gates `_hNodeDiag`
  allocation on `this._loaded`, but the role-direct path (line 199-202)
  unconditionally allocates the diagonal. Output-pin coverage of
  `unloaded` therefore needs the same split.

### Compiler call sites that pass the loaded flag

- `src/solver/analog/compiler.ts:94-108` — `resolvePinLoading(nodeId, mode,
  nodeIdToOverride, isCrossDomain)`. The single function that decides per
  pin/net whether a model should be the loaded or unloaded variant. Its
  current return type is `boolean`. This function stays; only its
  consumption changes.
- `src/solver/analog/compiler.ts:1459-1465` — bridge-stub call site for
  bridge adapters. Today builds a single `loaded` boolean and passes it
  into `makeBridgeOutputAdapter` / `makeBridgeInputAdapter`. After the
  split, the factories still take a boolean (or, equivalently, a discriminator
  that picks the class) but inside the factory the choice of class is the
  branch — see "Implementation shape" below.
- `src/solver/analog/compiler.ts:1366-1380` — behavioural-factory call site.
  Builds `pinLoadingMap: Record<string, boolean>` from `resolvePinLoading`
  for every pin label and stores it on the property bag under
  `_pinLoading`. Behavioural element factories then read this map and pass
  the boolean into `new DigitalInputPinModel(...)` / `new
  DigitalOutputPinModel(...)`. The split moves the class choice inside
  these factories.

### Bridge adapter factories

- `src/solver/analog/bridge-adapter.ts:199-208` — `makeBridgeOutputAdapter`
  takes `loaded: boolean`, constructs a `DigitalOutputPinModel(spec, loaded,
  "branch")`. After the split, the factory selects between the new loaded
  vs. unloaded output-pin classes (or chooses to model the loaded/unloaded
  distinction only on the *node-loading* sub-stamp; see "Implementation
  shape").
- `src/solver/analog/bridge-adapter.ts:214-222` — `makeBridgeInputAdapter`
  takes `loaded: boolean`, constructs `new DigitalInputPinModel(spec,
  loaded)`. After the split, the factory dispatches:
  ```ts
  const model = loaded
    ? new DigitalInputPinLoaded(spec)
    : new DigitalInputPinUnloaded(spec);
  ```

### Behavioural element call sites that must be migrated

Each of these currently calls `new DigitalInputPinModel(spec, flag)` or
`new DigitalOutputPinModel(spec, flag, "direct")` and must be rewritten
to dispatch on `flag` to the new class pair. Per-line evidence:

- `src/solver/analog/behavioral-flipflop.ts:297, 300, 303, 306`
- `src/solver/analog/behavioral-sequential.ts:389, 392, 395, 400, 405,
  673, 676, 679, 686, 691, 694, 701, 706, 775, 780, 783, 790`
- `src/solver/analog/behavioral-remaining.ts:98, 101, 104, 208, 211, 214,
  322, 332, 582`

(Test files like `behavioral-combinational.test.ts:126,128,134,140,...`
also instantiate the models directly; they are listed for migration but
they are tests, not production sites.)

### Failing test this resolves

- `src/solver/analog/__tests__/bridge-adapter.test.ts:206-225` — the
  "input adapter unloaded stamps nothing" case asserts
  `entries.length === 0` after setup + load on the unloaded path. With
  the split, the unloaded class's `setup()` allocates nothing and the
  CSC non-zero list is genuinely empty.

The adjacent cases in the same file remain meaningful:
- `:184-204` "unloaded output adapter does not stamp rOut on node
  diagonal" — same shape on the output side.
- `:163-182` "loaded output adapter stamps rOut conductance on node
  diagonal" — exercises the loaded class.
- `:227-246` "input adapter loaded stamps rIn on node diagonal" —
  exercises the loaded input class.

## Why no ngspice citation

ngspice has no "digital pin" abstraction. The loaded/unloaded distinction
is not present in ngspice because ngspice is a pure analog SPICE solver
and has no concept of a digital signal that crosses an
analog/digital boundary; all of its devices are continuous-time analog
elements that always stamp.

The `DigitalInputPinModel` / `DigitalOutputPinModel` and the
`BridgeInputAdapter` / `BridgeOutputAdapter` are digiTS-specific
constructs that exist to bridge the digital event-driven engine with the
analog MNA engine in mixed-signal partitions. The "loaded" axis lets the
user configure whether a digital input on an otherwise-analog net presents
its specified `rIn`/`cIn` loading to the analog solver, or whether it
samples voltage without contributing any conductance/capacitance. There
is no ngspice analog to this — the closest concept (high-impedance
voltage measurement with no loading) does not exist as a first-class
device in ngspice and would have to be hand-modelled with extra
components.

This item is therefore a digiTS-internal architectural cleanup. There
is no ngspice file to cite, and this spec does not invent one.

## Implementation shape

### 1. Two classes, no `_loaded` flag

In `src/solver/analog/digital-pin-model.ts`, replace
`DigitalInputPinModel` with two classes:

```ts
class DigitalInputPinLoaded {
  // owns _spec, _nodeId, _hNodeDiag, _inputCap (when cIn > 0)
  setup(ctx)  { allocElement(nodeId, nodeId); ... }
  load(ctx)   { stampElement(_hNodeDiag, 1 / rIn); }
  init(nodeId) { ... allocate _inputCap if cIn > 0 ... }
  getChildElements() { return _inputCap ? [_inputCap] : []; }
  setParam, readLogicLevel, getters: as today
}

class DigitalInputPinUnloaded {
  // owns _spec, _nodeId
  setup(_ctx) { /* no-op */ }
  load(_ctx)  { /* no-op */ }
  init(nodeId) { _nodeId = nodeId; /* no capacitor child */ }
  getChildElements() { return []; }
  setParam, readLogicLevel, getters: as today
}
```

A common interface (`DigitalInputPin`) declares the public contract
both classes implement (`init`, `setup`, `load`, `setParam`,
`readLogicLevel`, `getChildElements`, `nodeId`, `rIn`, `capacitance`).
Existing consumers (factories, `delegatePinSetParam`,
`collectPinModelChildren`) are typed against this interface.

The `loaded` getter (`get loaded(): boolean`) survives only if any
caller still asks. From the grep evidence, `BridgeInputAdapter.
getPinCurrents` (`bridge-adapter.ts:170-176`) reads
`this._pinModel.loaded`. Two equivalent paths:

- Replace the read with an instance-of check.
- Keep `get loaded()` as a discriminator that is `true` on the loaded
  class and `false` on the unloaded class. This is the cheaper migration
  and keeps the call site's intent legible.

### 2. Symmetric split on the output side

`DigitalOutputPinModel` carries the same axis: `_loaded` controls
whether the node-side `1/rOut` stamp (and the `cOut` companion child)
exist. Three options:

- **(a)** Same split: `DigitalOutputPinLoaded` and
  `DigitalOutputPinUnloaded`, each with one `role` ("branch" or
  "direct"). Cross-product is four classes total. Acceptable but verbose.
- **(b)** Keep `DigitalOutputPinModel` as one class, but extract the
  loading-stamp responsibility into a separate `OutputLoadingStamp`
  helper that's plugged in at construction time only when loaded. This
  keeps the role discriminator on one class and isolates the
  loaded/unloaded axis to the helper.
- **(c)** Same shape as (a), and use a tagged union internally so the
  load() body remains in one file.

The user direction is "split into two distinct classes" and "delete the
`_loaded` flag from the runtime"; the cleanest faithful reading is (a).
Implementer should choose between (a) and (c) based on duplication
tolerance, but the public contract is the same: no `_loaded` field on
any concrete runtime class.

### 3. Compiler-side selection

`resolvePinLoading` (`compiler.ts:94-108`) is unchanged; it still
returns `boolean`. The compiler currently funnels that boolean two
ways: the `_pinLoading` property-bag map (for behavioural factories)
and the bridge-stub `loaded` arg (for bridge-adapter factories).

The split moves the dispatch into the **factories** that today take
the boolean:

- `makeBridgeInputAdapter(spec, nodeId, loaded)` — internally:
  ```ts
  const model: DigitalInputPin = loaded
    ? new DigitalInputPinLoaded(spec)
    : new DigitalInputPinUnloaded(spec);
  model.init(nodeId, 0);
  return new BridgeInputAdapter(model);
  ```
- Similarly inside `makeBridgeOutputAdapter` for the output split.
- Behavioural factories (`behavioral-flipflop.ts`, `behavioral-
  sequential.ts`, `behavioral-remaining.ts`) read the boolean from
  `_pinLoading[pinLabel]` and dispatch to the appropriate class instead
  of constructing `new DigitalInputPinModel(spec, flag)`.

A small helper inside `digital-pin-model.ts` cleans up duplication:

```ts
export function makeDigitalInputPin(spec, loaded): DigitalInputPin {
  return loaded ? new DigitalInputPinLoaded(spec)
                : new DigitalInputPinUnloaded(spec);
}
export function makeDigitalOutputPin(spec, loaded, role): DigitalOutputPin {
  return loaded ? new DigitalOutputPinLoaded(spec, role)
                : new DigitalOutputPinUnloaded(spec, role);
}
```

Every `new DigitalInputPinModel(...)` / `new DigitalOutputPinModel(...)`
call site listed under "Behavioural element call sites" gets rewritten
to call these helpers. The `_loaded` flag is gone from the runtime; the
compiler-side resolution is unchanged.

### 4. Test migration

`bridge-adapter.test.ts` continues to call `makeBridgeInputAdapter(spec,
NODE, true|false)` and `makeBridgeOutputAdapter(spec, NODE, BRANCH_IDX,
true|false)` — the public factory signatures don't change. The
"unloaded stamps nothing" case at lines 206-225 now passes because the
unloaded class's `setup()` allocates nothing. The "loaded stamps rIn"
case at lines 227-246 still passes via the loaded class.

`behavioral-combinational.test.ts` and the other test files that
construct `new DigitalInputPinModel(CMOS_3V3, true)` directly need the
same migration to `makeDigitalInputPin(CMOS_3V3, true)` (or to direct
`new DigitalInputPinLoaded(CMOS_3V3)`). These are migration mechanics,
not contract changes.

## Tensions / uncertainties

- **`get loaded()` on the public surface.** `BridgeInputAdapter.
  getPinCurrents` reads `this._pinModel.loaded` to gate its current
  computation. Two clean choices: keep `loaded: boolean` on the shared
  interface (each concrete class returns a hardcoded literal), or
  switch the call site to `instanceof DigitalInputPinUnloaded`. The
  former is the lower-friction option and matches the user instruction
  to delete the *runtime* flag (the `_loaded` private field) without
  forcing every reader to learn class identity.
- **Subcircuit composition.** The pin models live inside behavioural
  element factories, which are leaves. Subcircuit composition does not
  see the pin classes directly — it sees the wrapping behavioural
  element. So the split does not affect subcircuit composition: only
  the inner factory constructions migrate.
- **`bridge-adapter.test.ts` expectation under each class.** The test
  invariants:
  - Unloaded input: zero CSC entries, zero RHS writes.
  - Loaded input: `rIn` conductance on diagonal; non-zero matrix entry
    at `(NODE_IDX, NODE_IDX)`. The test at line 245
    (`expect(rhs.every(v => v === 0)).toBe(true)`) is RHS-only and
    correctly stays true for the loaded path because `1/rIn` is a
    matrix-only stamp; the matrix entry presence is asserted by the
    parallel "loaded output adapter stamps rOut conductance on node
    diagonal" pattern. Implementer should add an explicit
    matrix-non-zero assertion in the loaded-input case if it is missing
    today, paralleling the unloaded case's `entries.length === 0`
    assertion. (It is currently missing — the test only checks `rhs`.)
  Folding in that latent assertion gap follows the project's "fold in
  latent bugs" rule (per the user MEMORY entry).
- **Output side companion-capacitor nuance.** `DigitalOutputPinModel.
  init` allocates an `AnalogCapacitorElement` child only when `_loaded
  && cOut > 0`. Splitting into Loaded/Unloaded makes that conditional
  static: only the Loaded class can ever own a capacitor child. The
  unloaded class returns `[]` from `getChildElements()` always.
  Composite aggregation in `BridgeOutputAdapter` and behavioural-element
  composites must continue to work in both shapes — they already do
  because they read through `getChildElements()` rather than through
  `_loaded`.
- **`role` axis is orthogonal.** The output-pin `role: "branch" |
  "direct"` axis is a different dimension from the loaded axis. The
  split is along loaded, not along role. The Loaded output class still
  carries the role discriminator internally; the Unloaded output class
  does too (it still needs to know whether to skip the branch
  equation). No fold of axes is implied.
