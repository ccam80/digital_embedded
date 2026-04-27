# Task PB-TRANSGATE

**digiTS file:** `src/components/switching/trans-gate.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62` (applied twice — once per SW sub-element, NFET and PFET each contribute one SW)
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/sw/swload.c`

## Pin mapping (from 01-pin-mapping.md)

TransGate is a composite (NFET + PFET sub-elements, each backed by a single SW). It has no `ngspiceNodeMap` of its own.

External pins: `in`, `out`, `ctrl` (gate-enable), `ctrlN` (inverted gate-enable for PFET).

Both NFET and PFET carry the signal on the same `in`↔`out` path. They are wired in parallel between the same two signal nodes:

| Sub-element | pos node | neg node | control |
|---|---|---|---|
| NFET's SW | `pinNodes.get("in")` | `pinNodes.get("out")` | `ctrl` — turns ON when `V(ctrl) > Vth` |
| PFET's SW | `pinNodes.get("in")` | `pinNodes.get("out")` | `ctrlN` — turns ON when `V(ctrlN) < Vth` (inverted) |

Both SW sub-elements share the same pair of signal nodes (`in`, `out`), so their TSTALLOC pairs overlap (same external node indices). The insertion-order tracker in the solver must still record all 8 calls; the solver deduplicates structurally but `_getInsertionOrder()` shows 8 entries.

## Internal nodes

none — neither SW sub-element has internal nodes.

## Branch rows

none — SW stamps conductance only.

## State slots

4 total — 2 per SW sub-element (`SW_NUM_STATES = 2`). NFET's SW allocates first, PFET's SW second, in `subElements[]` order.

## TSTALLOC sequence (line-for-line port)

NFET SW (swsetup.c:59-62, first pass):

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 1 | `(SWposNode, SWposNode)` | `(inNode, inNode)` | `nfetSW._hPP` |
| 2 | `(SWposNode, SWnegNode)` | `(inNode, outNode)` | `nfetSW._hPN` |
| 3 | `(SWnegNode, SWposNode)` | `(outNode, inNode)` | `nfetSW._hNP` |
| 4 | `(SWnegNode, SWnegNode)` | `(outNode, outNode)` | `nfetSW._hNN` |

PFET SW (swsetup.c:59-62, second pass):

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 5 | `(SWposNode, SWposNode)` | `(inNode, inNode)` | `pfetSW._hPP` |
| 6 | `(SWposNode, SWnegNode)` | `(inNode, outNode)` | `pfetSW._hPN` |
| 7 | `(SWnegNode, SWposNode)` | `(outNode, inNode)` | `pfetSW._hNP` |
| 8 | `(SWnegNode, SWnegNode)` | `(outNode, outNode)` | `pfetSW._hNN` |

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  // Both sub-elements share the same signal path (in, out).
  // NFET's SW setup runs first, PFET's SW setup runs second.
  this._nfetSW.setup(ctx);  // in↔out, control = ctrl pin
  this._pfetSW.setup(ctx);  // in↔out, control = ctrlN pin (inverted)
}
```

Each sub-element's setup() body is identical to PB-SW with `posNode = inNode`, `negNode = outNode`.

## load() body — value writes only

Implementer ports value-side from `swload.c` line-for-line for each sub-element. Both SW sub-elements stamp their conductance onto the same `(in, out)` node pair, so their contributions add at load time:

```typescript
load(ctx: LoadContext): void {
  this._nfetSW.load(ctx);  // stamps g_nfet onto in/out nodes
  this._pfetSW.load(ctx);  // stamps g_pfet onto in/out nodes (adds to same elements)
}
```

Control polarity:
- NFET SW: ON when `V(ctrl) - V(0) > Vth_n`
- PFET SW: ON when `V(0) - V(ctrlN) > |Vth_p|` (inverted; `ctrlN` is the complement of `ctrl`)

## findBranchFor (not applicable)

Neither SW sub-element has a branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Composite has no `ngspiceNodeMap`.
- No `findBranchFor` callback.
- Composite carries `{ _nfetSW: SwitchElement, _pfetSW: SwitchElement }` as direct refs.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-TRANSGATE is GREEN (8-entry sequence: NFET SW's 4 then PFET SW's 4).
2. `src/components/switching/__tests__/switches.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
