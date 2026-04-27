# Setup/Load Split — Behavioral Subsection (02)

This file specs setup() bodies for digiTS-internal behavioral analog
elements that have **no native ngspice device anchor**. These are
digital-logic primitives (gates, mux, decoders) and behavioral
composites (drivers, splitters, sevenseg, button-LED) that program
against the analog matrix via `DigitalInputPinModel` /
`DigitalOutputPinModel` rather than against named ngspice device types.

Per-component spec files (`components/PB-BEHAV-*.md`) reference the
shape rules defined here.

---

## Scope

Components covered by this file:

| Group | Components | digiTS files |
|---|---|---|
| Gates | NOT, AND, NAND, OR, NOR, XOR, XNOR | `behavioral-gate.ts` |
| Combinational | Mux, Demux, Decoder | `behavioral-combinational.ts` |
| Drivers | Driver (tri-state), DriverInv | `behavioral-remaining.ts` |
| Bus | Splitter / BusSplitter | `behavioral-remaining.ts` |
| Visual | SevenSeg, SevenSegHex | `behavioral-remaining.ts` |
| ButtonLED | ButtonLED | `behavioral-remaining.ts` |
| (Reused-by-composite) | DigitalInputPinModel, DigitalOutputPinModel, AnalogCapacitorElement (child) | `digital-pin-model.ts`, `passives/capacitor.ts` |

Note: Relay / RelayDT are listed in `01-pin-mapping.md` as composites
under "Switching" (IND coil + SW contact) — they have ngspice anchors
through their sub-elements, so they live in `components/PB-RELAY.md`,
not here.

---

## ngspice-anchor status: NONE

Behavioral elements have no `*setup.c` anchor. Their setup() bodies are
NOT bound by line-for-line ngspice equivalence; they are bound by
**replicating the existing `_handlesInit` block from current load()**.
Once the alloc block moves to setup(), load() becomes pure value-write.

This is an intentional architectural divergence — behavioral elements
are digiTS primitives. Listed in this file rather than in
`spec/architectural-alignment.md` because the divergence is a category
choice (we have behavioral elements; ngspice doesn't), not a numerical
divergence.

---

**Pre-requisite — W2.5 wave.** Shape rules 2 and 3 below reference field names (`_branchIndex`, `_outputCap`, `_inputPins`, `_outputPins`, `_subElements`, `_childElements`) and a class-based element structure that do not exist in the pre-W2.5 source. Per `plan.md` §Wave plan, the W2.5 wave (a) renames source fields in `src/solver/analog/digital-pin-model.ts` to match the spec names and (b) converts factory-closure analog elements to classes with the listed instance fields. This file describes the **post-W2.5 target architecture**. W3 implementer agents must not start any PB-BEHAV-* component before W2.5 is complete; running PB-BEHAV-* against pre-W2.5 source produces TypeScript compile errors at every setup() body.

**Pin-node access**: per `00-engine.md` §A3, every behavioral element class stores `_pinNodes: Map<string, number>` as an instance field. Shape rules below reference `this._pinNodes.get("label")!` consistently; if a Shape rule code block uses bare `pinNodes` or `pinNodeIds[N]`, treat it as a typo and use `this._pinNodes.get("label")!`.

## Shape rule 1 — `DigitalInputPinModel.setup(ctx)`

**File:** `src/solver/analog/digital-pin-model.ts`

Add a new method:

```ts
setup(ctx: SetupContext): void {
  if (this._nodeId <= 0) return;        // ground or unset
  // _loaded is a load-time-only flag — controls stamp value (1/rIn ≈ 0 for unloaded), never gates allocation. Matches ngspice unconditional TSTALLOC.

  // TSTALLOC: (node, node) — input loading conductance 1/rIn
  this._hNodeDiag = ctx.solver.allocElement(this._nodeId, this._nodeId);

  // Forward to capacitor child (created by init() when loaded && cIn > 0)
  if (this._inputCap) {
    this._inputCap.setup(ctx);
  }
}
```

> **Why no `_loaded` guard at setup time**: ngspice elements always allocate their full TSTALLOC pattern in *setup() regardless of whether the surrounding circuit has loaded the device. The matrix entries exist; load() decides what to stamp. digiTS follows this pattern: setup() always allocates the diagonal handle, and `_loaded`'s only consumer is the load() body, which stamps a near-zero conductance (1/rIn) when the pin is unloaded.

Also add a `setup(ctx)` method to `AnalogCapacitorElement` per the
`PB-CAP.md` spec (calls `solver.allocElement` 4× for the capacitor's
own (pos, pos), (neg, neg), (pos, neg), (neg, pos) entries).

**Load body change:** delete the `_handlesInit` block from `load()`. The
load() body now only does `solver.stampElement(this._hNodeDiag, 1 / this._rIn)`
when loaded.

## Shape rule 2 — `DigitalOutputPinModel.setup(ctx)`

```ts
setup(ctx: SetupContext): void {
  if (this._role === "branch") {
    if (this._branchIndex <= 0 || this._nodeId <= 0) return;
    // TSTALLOC: 3 fixed entries + 1 conditional
    this._hBranchNode   = ctx.solver.allocElement(this._branchIndex, this._nodeId);
    this._hBranchBranch = ctx.solver.allocElement(this._branchIndex, this._branchIndex);
    this._hNodeBranch   = ctx.solver.allocElement(this._nodeId,      this._branchIndex);
    if (this._loaded) {
      this._hNodeDiag   = ctx.solver.allocElement(this._nodeId,      this._nodeId);
    }
  } else {
    // role === "direct"
    if (this._nodeId <= 0) return;
    this._hNodeDiag     = ctx.solver.allocElement(this._nodeId, this._nodeId);
  }

  // Forward to capacitor child (created by init() when loaded && cOut > 0)
  if (this._outputCap) {
    this._outputCap.setup(ctx);
  }
}
```

**Load body change:** delete the `_handlesInit` block. Stamp through the
cached handles only.

The `init(nodeId, branchIdx)` method continues to do its existing job
(create capacitor child, set `_nodeId`, set `_branchIndex`) — but
**no longer resets `_handlesInit`** because that flag is gone. The
`load()` body trusts that `setup()` has run before the first
`load()` call (engine guarantee per `00-engine.md` §A4.3).

**Composite sub-element registration.** Composites do not need to call `ctx.registerDevice` from their `setup()`. Sub-elements are auto-registered in `_deviceMap` by the engine's recursive walk during `init()` (see `00-engine.md` §A4.1). The composite's `setup()` only forwards `setup(ctx)` to each sub-element for matrix-entry allocation — discovery is already done.

## Shape rule 3 — Composite behavioral element `setup(ctx)`

Every behavioral composite (BehavioralGateElement, BehavioralMuxElement,
BehavioralDemuxElement, BehavioralDecoderElement, Driver, DriverInv,
Splitter, SevenSeg, ButtonLED, RelayElement, RelayDTElement,
TransGateElement, NFETElement, PFETElement, FGNFETElement,
FGPFETElement. All elements above are class-based as of W2.5; pre-W2.5 closure factories (`createDriverAnalogElement`, etc.) are converted to classes in W2.5.) implements:

```ts
setup(ctx: SetupContext): void {
  // Forward to every input pin model
  for (const pin of this._inputPins) pin.setup(ctx);
  // Forward to every output pin model
  for (const pin of this._outputPins) pin.setup(ctx);
  // Forward to every capacitor child collected from pin models
  for (const child of this._childElements) child.setup(ctx);
  // Forward to any other primitive sub-elements (segDiode, coilInductor, etc.)
  for (const sub of this._subElements ?? []) sub.setup(ctx);
}
```

Forward order does not matter for correctness (composite owns all sub-
elements; no cross-device label lookup is needed) but should be:
**inputs → outputs → children → other sub-elements** for readability.

**Concrete field names per composite class** (P-behav-D8 resolution):

| Class | Input pins field | Output pins field | Selector pins field | Children/sub-elements field |
|---|---|---|---|---|
| BehavioralGateElement | `_inputs` | `_output` (single) | n/a | `_childElements` |
| BehavioralMuxElement | `_dataPins` (2D: `DigitalInputPinModel[][]` indexed by data-input group, then bit) | `_outPins` | `_selPins` | `_childElements` |
| BehavioralDemuxElement | `_inPin` (single `DigitalInputPinModel`) | `_outPins` | `_selPins` | `_childElements` |
| BehavioralDecoderElement | (merged into `_selPins`) — decoder has no separate data input; selector is the only input | `_outPins` | `_selPins` | `_childElements` |
| Driver / DriverInv / Splitter / SevenSeg / ButtonLED / Relay / RelayDT | factory closures — local variables, not class fields (see Shape rule 3 closure variant) |

The Shape rule 3 generic body (`for (const pin of this._inputPins) ...`) is a TEMPLATE. Per-class implementers substitute the actual field name from this table.

## Shape rule 4 — Variable-input gates (AND, OR, NAND, NOR, XOR, XNOR)

`BehavioralGateElement` already supports variable input count via the
`_inputs[]` array. Its setup() forwards to every entry in `_inputs[]`
plus `_output` plus `_childElements` per Shape rule 3. No special
handling needed; the for-loop covers all input counts.

## Shape rule 5 — Driver / DriverInv (tri-state)

Exactly the same shape as gates: setup() forwards to inputPin, selPin,
outputPin, and childElements. No additional sub-elements.

## Shape rule 6 — Splitter / BusSplitter

setup() forwards to every entry in `inputPins[]`, every entry in
`outputPins[]`, and `_childElements`. No further sub-elements.

## Shape rule 7 — SevenSeg / SevenSegHex

The 7-segment factory currently constructs 7 (or 8 with dp) inline
"segment diode" elements via `createSegmentDiodeElement`. Each segment
diode currently calls `solver.allocElement` from its load() — that must
move to a setup() method on the segment diode helper.

**Action item for SevenSeg setup:** add a `setup(ctx)` method to the
inline `SegmentDiodeElement` helper:

```ts
function createSegmentDiodeElement(nodeAnode, nodeCathode) {
  // ... existing fields ...
  let _hNN: number = -1;
  let _hCC: number = -1;
  let _hNC: number = -1;
  let _hCN: number = -1;
  return {
    setup(ctx: SetupContext): void {
      const s = ctx.solver;
      if (nodeAnode > 0)   _hNN = s.allocElement(nodeAnode, nodeAnode);
      if (nodeCathode > 0) _hCC = s.allocElement(nodeCathode, nodeCathode);
      if (nodeAnode > 0 && nodeCathode > 0) {
        _hNC = s.allocElement(nodeAnode, nodeCathode);
        _hCN = s.allocElement(nodeCathode, nodeAnode);
      }
    },
    load(ctx: LoadContext): void {
      // ... existing diode model logic, but use stampElement(_hNN, ...) etc.
      // instead of stampG() (which calls allocElement under the hood).
    },
    // ...
  };
}
```

Composite SevenSeg setup() forwards to each of the 7 (or 8) segment
diodes per Shape rule 3.

## Shape rule 8 — ButtonLED

Forwards to `outputPin.setup(ctx)` and `ledDiode.setup(ctx)` — the LED
diode is the same `SegmentDiodeElement` helper as SevenSeg uses, so
its setup() body comes from Shape rule 7.

## Shape rule 9 — Relay / RelayDT

Listed in `01-pin-mapping.md` as Switching composites. Their setup()
forwards to `coilInductor.setup(ctx)` (which carries the IND anchor
from `PB-IND.md`) and stamps the contact-conductance allocs directly:

```ts
setup(ctx: SetupContext): void {
  // Coil DC resistance: stamp between coil1 and coil2 (mirror RES TSTALLOC)
  this._hC1C1 = ctx.solver.allocElement(nodeCoil1, nodeCoil1);
  this._hC2C2 = ctx.solver.allocElement(nodeCoil2, nodeCoil2);
  this._hC1C2 = ctx.solver.allocElement(nodeCoil1, nodeCoil2);
  this._hC2C1 = ctx.solver.allocElement(nodeCoil2, nodeCoil1);
  // Contact: variable resistance, same TSTALLOC quartet
  this._hCAA = ctx.solver.allocElement(nodeContactA, nodeContactA);
  this._hCBB = ctx.solver.allocElement(nodeContactB, nodeContactB);
  this._hCAB = ctx.solver.allocElement(nodeContactA, nodeContactB);
  this._hCBA = ctx.solver.allocElement(nodeContactB, nodeContactA);
  // Coil inductor branch + state (delegated to AnalogInductorElement)
  this._coilInductor.setup(ctx);
}
```

`load()` body becomes pure stamps through the cached handles.

RelayDT adds a third contact pair for the C1 (rest) terminal.

## Shape rule 10 — TransGate / NFET / PFET / FGNFET / FGPFET

These are switching composites. NFET / PFET use a single SW sub-element
internally (per `01-pin-mapping.md`); their setup() forwards to that
sub-element (whose body comes from `components/PB-SW.md`).

TransGate is NFET + PFET sharing the (in, out) signal path. Its setup()
forwards to both sub-elements.

FGNFET / FGPFET are MOS + CAP. Their setup() forwards to both
sub-elements (bodies from `PB-MOSFET.md` and `PB-CAP.md`).

---

## Behavioral element list with composite-shape declaration

For implementer reference. Each row links to its component spec file
(which exists once per-component agents complete W3).

| Component | Pin layout (digiTS labels) | Sub-elements / pin-model layout | Spec file |
|---|---|---|---|
| NOT | `In_1`, `out` | 1× DigitalInputPinModel + 1× DigitalOutputPinModel + childCaps | `PB-BEHAV-NOT.md` |
| AND-N (variable inputs) | `In_1`...`In_N`, `out` | N× DigitalInputPinModel + 1× DigitalOutputPinModel + childCaps | `PB-BEHAV-AND.md` |
| NAND-N | same as AND | same | `PB-BEHAV-NAND.md` |
| OR-N | same | same | `PB-BEHAV-OR.md` |
| NOR-N | same | same | `PB-BEHAV-NOR.md` |
| XOR-N | same | same | `PB-BEHAV-XOR.md` |
| XNOR-N | same | same | `PB-BEHAV-XNOR.md` |
| Mux | `sel`, `in_0`...`in_(2^bits-1)`, `out` (each multi-bit) | selectorBits× sel pins + 2^bits data pin groups + bitWidth× output pins + childCaps | `PB-BEHAV-MUX.md` |
| Demux | `sel`, `out_0`...`out_(2^bits-1)`, `in` | selectorBits× sel pins + 1× input pin + 2^bits output pins + childCaps | `PB-BEHAV-DEMUX.md` |
| Decoder | `sel`, `out_0`...`out_(2^bits-1)` | selectorBits× sel pins + 2^bits output pins + childCaps | `PB-BEHAV-DECODER.md` |
| Driver | `in`, `sel`, `out` | 2× DigitalInputPinModel + 1× DigitalOutputPinModel + childCaps | `PB-BEHAV-DRIVER.md` |
| DriverInv | `in`, `sel`, `out` | same shape; load() body inverts sel | `PB-BEHAV-DRIVERINV.md` |
| Splitter | dynamic per input/output count | N× input + M× output pin models + childCaps | `PB-BEHAV-SPLITTER.md` |
| SevenSeg | `a`,`b`,`c`,`d`,`e`,`f`,`g`,`dp` | 7 or 8× SegmentDiodeElement (inline) | `PB-BEHAV-SEVENSEG.md` |
| SevenSegHex | same as SevenSeg | same | `PB-BEHAV-SEVENSEGHEX.md` |
| ButtonLED | `out`, `in` | 1× DigitalOutputPinModel + 1× SegmentDiodeElement (LED) | `PB-BEHAV-BUTTONLED.md` |
| Ground | `out` | None — Ground is a pure node-zero sentinel; setup() is empty (returns immediately) | `PB-BEHAV-GROUND.md` |

**Variable-N gates:** the per-component spec file applies to every N-input variant of that gate. Implementer agent uses the same file for AND-2, AND-3, AND-4, etc.

---

## Per-task verification gate (W3)

For behavioral components:

1. The component's existing test file is GREEN. Concrete test-file mapping:

   | Component group | Test file |
   |---|---|
   | Gates: NOT, AND, NAND, OR, NOR, XOR, XNOR | `src/solver/analog/__tests__/behavioral-gate.test.ts` |
   | Combinational: Mux, Demux, Decoder | `src/solver/analog/__tests__/behavioral-combinational.test.ts` |
   | Closure-based: Driver, DriverInv, Splitter, SevenSeg, SevenSegHex, ButtonLED, Relay, RelayDT | `src/solver/analog/__tests__/behavioral-remaining.test.ts` |
   | Switching: TransGate, NFET, PFET, FGNFET, FGPFET | `src/components/switching/__tests__/fets.test.ts` (FETs) and `src/components/switching/__tests__/relay.test.ts` (Relay variants) |
   | Ground | `src/solver/analog/__tests__/behavioral-ground.test.ts` if it exists; otherwise the gate is satisfied by `behavioral-remaining.test.ts` not regressing |

   The implementer marks the W3 row green only when the listed file passes after migration.
2. The component's `setup()` body alloc-only (no value writes) and `load()` body stamp-only (no `solver.allocElement` calls). Verified by `Grep "allocElement" <component-file>` returning only setup() matches.
3. The behavioral element's setup() forward order matches Shape rule 3 (inputs → outputs → children → others).

There is no `setup-stamp-order.test.ts` row for behavioral elements — the row applies only to ngspice-anchored components. `setup-stamp-order.test.ts` does not test behaviorals because they have no anchor to compare against.

---

## Pin-map field on behavioral models

Behavioral elements do **NOT** populate `ComponentDefinition.ngspiceNodeMap`. The field remains `undefined` for these components. The pin-map-coverage test in `01-pin-mapping.md` §Verification must allow-list behavioral components (skip the assertion that `ngspiceNodeMap` is defined).

---

## Why behaviorals are still in the migration

Even though behaviorals have no ngspice anchor, they currently call `solver.allocElement` from load() (via the `_handlesInit` flag, the `stampG()` helper, or direct calls inside SegmentDiodeElement). After A7's "no allocElement from load()" convention lands, every behavioral element breaks unless migrated.

This subsection makes the migration mechanical: copy the existing alloc-block from load() into a new setup() method, then remove the `_handlesInit` flag (or equivalent). No new architecture, no decisions per element.
