# Audit: stale pin-node IDs in device factories / constructors

## TL;DR

A device leaf that reads `pinNodes.get("X")` **before `setup(ctx)` runs** will
freeze the value at the moment of the read. When the leaf sits inside a
composite (`MnaSubcircuitNetlist`) and the pin maps onto an internal net, that
read returns the placeholder `-1`, because the parent compiler patches the Map
*after construction and before setup*. The closure / field then stays at `-1`
forever, and every later stamp into `rhs[-1]` is silently dropped while every
`solver.allocElement(-1, X)` routes to the TrashCan slot. Stamps and RHS
contributions vanish without any error.

Two flavours of the same bug:

1. **Factory-closure form** (semiconductors): `const nodeA = pinNodes.get("A")!`
   at the top of the factory function, used inside the inner class's methods.
2. **Constructor-field form** (behavioral drivers): `this._inputNode =
   pinNodes.get("in")!` inside the constructor, stored in a private (often
   `private readonly`) field, used inside `load()`.

Both fix the same way: defer the read to `setup(ctx)` (which fires after the
patcher) and assign into either the closure variable or the instance field
there.

## Why it didn't show up earlier

Top-level placement always works because the parent fully resolves every
external pin before invoking the factory. The bug only fires when the leaf is
*inside a composite* and the pin maps to a *composite-internal net* (not a
composite port). The Optocoupler bench (Diode + InternalZeroVoltSense +
InternalCccs + NpnBJT) is the smallest example where this happens for both a
diode and a BJT. Most other composites (Transformer, gates' two-input cases
that don't use ground-coupling, etc.) happened to keep their leaves on
composite *ports* where the pin Map is fully resolved at construction time.

## Repair shape A: factory-closure form

```ts
function createWidgetElement(pinNodes, props, ...) {
  // Closure-level placeholders. setup() reassigns from `this.pinNodes` after
  // the PatcherLeaf has run.
  let nodeA = -1;
  let nodeB = -1;
  class WidgetAnalogElement extends ... {
    setup(ctx) {
      nodeA = this.pinNodes.get("A")!;
      nodeB = this.pinNodes.get("B")!;
      // ... rest of setup ...
    }
    load(ctx) { /* unchanged: reads `nodeA`/`nodeB` (now resolved) */ }
  }
  return new WidgetAnalogElement(pinNodes);
}
```

## Repair shape B: constructor-field form

```ts
export class FooDriver extends PoolBackedAnalogElement {
  // BEFORE
  private readonly _inNode: number;
  constructor(pinNodes, props) {
    super(pinNodes);
    this._inNode = pinNodes.get("in")!;   // BUG inside composite
  }
  // AFTER
  private _inNode: number;                  // drop `readonly`
  constructor(pinNodes, props) {
    super(pinNodes);
    this._inNode = -1;                     // placeholder until setup
  }
  setup(ctx) {
    this._stateBase = ctx.allocStates(...);
    this._inNode = this.pinNodes.get("in")!;
  }
}
```

Drop `readonly` on the offending field(s); assign in `setup()` from
`this.pinNodes`. Many drivers' setup() bodies are currently a single
`allocStates(...)` line — the field reads slot in cleanly there.

## Already fixed in this session

| File | Symbol | Fields/closure rewired |
|---|---|---|
| `src/components/semiconductors/diode.ts` | `createDiodeElement` | `nodeAnode`, `nodeCathode` (closure form) |
| `src/components/semiconductors/bjt.ts` | `_createBjtElementWithPolarity` (level-0) | `nodeB`, `nodeC`, `nodeE` (closure form) |
| `src/components/semiconductors/bjt.ts` | `createSpiceL1BjtElement` (level-1) | `nodeB_ext`, `nodeC_ext`, `nodeE_ext` (closure form). `nodeB_int` / `nodeC_int` / `nodeE_int` / `substConNode` are derived inside `setup()` so they pick up the right values automatically. |
| `src/components/semiconductors/mosfet.ts` | `_createMosfetElementWithPolarity` | `nodeG`, `nodeS_ext`, `nodeD_ext` (closure form). `nodeD` / `nodeS` / `nodeB` derived in `setup()`. |
| `src/solver/analog/behavioral-drivers/and-driver.ts` | `BehavioralAndDriverElement` | `_inputNodes[]`, `_gndNode` (constructor-field form) — exemplar of repair shape B. |

**Empirical impact so far:** full `vitest` run dropped from **782 → 474**
failures (-308). Optocoupler bench (Cat 1/2/4 tests) now converges in 34 NR
iterations on direct NR, matching ngspice's converged solution
`V_base ≈ -2.15 GV`, `V_collector ≈ 2.846 V` to ~6 significant figures. (The
gigavolt base is the legitimate gmin-shunt converged solution on this
underdetermined topology — both engines reach it.)

## Constructor-field unsafe pattern: behavioral drivers to fix

All of these read `pinNodes.get(...)` in the constructor and stash into
private fields, then read those fields inside `load()`. Same fix shape (B
above). Each one is independent, parallelizable.

| File | Class | Lines |
|---|---|---|
| `src/solver/analog/behavioral-drivers/buf-driver.ts` | `BehavioralBufDriverElement` | ~91-92 |
| `src/solver/analog/behavioral-drivers/button-led-driver.ts` | `ButtonLedDriverElement` | ~90-91 |
| `src/solver/analog/behavioral-drivers/counter-driver.ts` | `BehavioralCounterDriverElement` | ~171-174 |
| `src/solver/analog/behavioral-drivers/counter-preset-driver.ts` | `BehavioralCounterPresetDriverElement` | ~130-136 |
| `src/solver/analog/behavioral-drivers/decoder-driver.ts` | `BehavioralDecoderDriverElement` | ~131-133 |
| `src/solver/analog/behavioral-drivers/demux-driver.ts` | `BehavioralDemuxDriverElement` | ~131-134 |
| `src/solver/analog/behavioral-drivers/mux-driver.ts` | `BehavioralMuxDriverElement` | ~140-146 |
| `src/solver/analog/behavioral-drivers/nand-driver.ts` | `BehavioralNandDriverElement` | ~89 |
| `src/solver/analog/behavioral-drivers/nor-driver.ts` | `BehavioralNorDriverElement` | (sibling shape; verify) |
| `src/solver/analog/behavioral-drivers/not-driver.ts` | `BehavioralNotDriverElement` | (sibling shape; verify) |
| `src/solver/analog/behavioral-drivers/or-driver.ts` | `BehavioralOrDriverElement` | (sibling shape; verify) |
| `src/solver/analog/behavioral-drivers/xnor-driver.ts` | `BehavioralXnorDriverElement` | (sibling shape; verify) |
| `src/solver/analog/behavioral-drivers/xor-driver.ts` | `BehavioralXorDriverElement` | (sibling shape; verify) |
| `src/solver/analog/behavioral-drivers/edge-detect.ts` | (verify) |
| `src/solver/analog/behavioral-drivers/splitter-driver.ts` | (verify) |
| `src/solver/analog/behavioral-drivers/register-driver.ts` | (verify) |
| `src/solver/analog/behavioral-drivers/seven-seg-driver.ts` | (verify) |
| `src/solver/analog/behavioral-drivers/rs-async-latch-driver.ts` | (verify) |
| `src/solver/analog/behavioral-drivers/rs-flipflop-driver.ts` | (verify) |
| `src/solver/analog/behavioral-drivers/t-flipflop-driver.ts` | (verify) |
| `src/solver/analog/behavioral-drivers/bridge-output-driver.ts` | (verify) |
| `src/solver/analog/behavioral-drivers/bridge-input-driver.ts` | (verify) |

**Already safe** in this folder (these read `this.pinNodes.get(...)` *live*
inside `load()` rather than caching at construction — no fix needed):

- `d-flipflop-driver.ts`, `d-async-flipflop-driver.ts`
- `jk-flipflop-driver.ts`, `jk-async-flipflop-driver.ts`
- `driver-driver.ts`, `driver-inv-driver.ts`

## Constructor-field unsafe pattern: digital pin sub-elements

These are the per-pin leaves the gate / counter / register composites emit
around their behavioural drivers (loaded vs unloaded variants). They follow
the same constructor-field pattern and need the same fix.

| File | Notes |
|---|---|
| `src/components/digital-pins/digital-input-pin-loaded.ts` | verify |
| `src/components/digital-pins/digital-input-pin-unloaded.ts` | verify |
| `src/components/digital-pins/digital-output-pin-loaded.ts` | verify |
| `src/components/digital-pins/digital-output-pin-unloaded.ts` | verify |

## Other components that may need audit

| File | Pattern | Notes |
|---|---|---|
| `src/components/active/adc-driver.ts` | constructor-field at lines 168-171 | Verify whether it lives inside an ADC composite and whether VIN/CLK/VREF/GND ever map to internal nets. |
| `src/components/active/comparator-driver.ts`, `comparator-pushpull-driver.ts` | inside-method-only | Looks safe; verify by composite stress. |
| `src/components/active/dac-driver.ts` | inside-method-only | Looks safe; verify by composite stress. |
| `src/components/active/analog-switch.ts` | constructor-field at lines 267-269, 374-377 | Verify. |
| `src/components/switching/behavioral-fet-driver.ts` | constructor-field at lines 100-101 | Verify. |
| `src/components/switching/switch-dt.ts` | factory-closure at lines 346-348 | Verify whether switch-dt is ever a composite leaf. |
| `src/components/switching/fet-sw.ts` | inside-method-only | Looks safe. |
| `src/components/switching/fgnfet-blown-driver.ts`, `fgpfet-blown-driver.ts` | constructor-field at lines 57-58 / 58-59 | Verify. |
| `src/components/io/clock.ts` | factory-closure at line 444 | Likely top-level only; verify. |
| `src/components/io/led.ts` | adapter-closure at line 171 (constructs a fresh Map) | LED is currently top-level only, but the adapter freezes `pinNodes.get("in")` at adapter call time. If LED ever becomes a composite leaf, this freezes -1. Recommend: replace the Map-rebuild with a wrapper element that reads "in" inside its own setup() and forwards to a delegated diode element. |
| `src/components/passives/polarized-cap.ts` | direct `createDiodeElement(clampPinNodes, ...)` at line 603 | Verify that `clampPinNodes` is fully resolved at the moment of the call (i.e. the clamp is wired to externally-allocated nodes, not waiting for a patch). If polarized-cap allocates the clamp's nodes itself, this is safe. |

## Detection greps

Constructor-field unsafe pattern (most common):

```
Grep(
  pattern=`this\\._\\w+\\s*=\\s*pinNodes\\.get`,
  path=`src`,
)
```

Factory-closure unsafe pattern:

```
Grep(
  pattern=`^\\s*(const|let)\\s+\\w+\\s*=\\s*pinNodes\\.get`,
  path=`src`,
)
```

For each hit, classify:
- **safe** if the read is inside a class method body (e.g., inside `setup()`,
  `load()`, `getPinCurrents()`, etc.) — these read `this.pinNodes` live every
  call.
- **unsafe** if the read is in the factory function body (before the inner
  class is constructed) or inside the inner class's *constructor* (which fires
  during `compileSubcircuitToMnaModel`'s factory call, before the patcher).

## Test that locks this in

`src/solver/analog/__tests__/probes/probe-stagnation.test.ts` builds the
Optocoupler bench in five variants (varying `vLed`, `vCC`, `ctr`) and asserts
DCOP convergence. It also dumps our iter-0 matrix and pre-solve RHS for
side-by-side comparison against ngspice's output captured by
`probe-ngspice-direct.test.ts` (a hand-rolled SPICE deck through the ngspice
DLL). With the closure bug present, our iter-0 RHS at the LED's senseMid node
was 0 instead of `-0.498` — that mismatch is the canonical signature of this
bug and should be the assertion shape for any new test that locks down the
fix for a freshly-audited driver.

For each driver fixed via repair shape B, the regression test should:

1. Build the host composite (gate / latch / counter / etc.) at top level.
2. Run `coordinator.dcOperatingPoint()` (must converge).
3. Compare iter-0 RHS values for the driver's pin nodes against ngspice (when
   the harness can emit the deck) or against an analytical expectation.
