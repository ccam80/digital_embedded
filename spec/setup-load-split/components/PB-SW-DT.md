# Task PB-SW-DT

**digiTS file:** `src/components/switching/switch-dt.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62` (applied twice — once per SW sub-element)
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/sw/swload.c`

## Pin mapping (from 01-pin-mapping.md)

SwitchDT is a composite. It has no `ngspiceNodeMap` of its own. Each SW sub-element carries its own map:

| Sub-element | digiTS pin labels | `ngspiceNodeMap` | Connects |
|---|---|---|---|
| `SW_AB` | `A1` → pos, `B1` → neg | `{ A1: "pos", B1: "neg" }` | between A1 and B1 |
| `SW_AC` | `A1` → pos, `C1` → neg | `{ A1: "pos", C1: "neg" }` | between A1 and C1 |

The composite's external pins are `A1`, `B1`, `C1`. The compiler's port-binding mechanism routes `A1` to both sub-elements' pos node, `B1` to SW_AB's neg node, and `C1` to SW_AC's neg node.

## Internal nodes

none — both SW sub-elements have no internal nodes.

## Branch rows

none — SW sub-elements stamp conductance only.

## State slots

4 total — 2 per SW sub-element (`SW_NUM_STATES = 2`). SW_AB allocates its 2 slots first, then SW_AC allocates its 2 slots, in the order sub-elements appear in `subElements[]`.

## TSTALLOC sequence (line-for-line port)

SW_AB (swsetup.c:59-62, first pass):

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 1 | `(SWposNode, SWposNode)` | `(A1node, A1node)` | `swAB._hPP` |
| 2 | `(SWposNode, SWnegNode)` | `(A1node, B1node)` | `swAB._hPN` |
| 3 | `(SWnegNode, SWposNode)` | `(B1node, A1node)` | `swAB._hNP` |
| 4 | `(SWnegNode, SWnegNode)` | `(B1node, B1node)` | `swAB._hNN` |

SW_AC (swsetup.c:59-62, second pass):

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 5 | `(SWposNode, SWposNode)` | `(A1node, A1node)` | `swAC._hPP` |
| 6 | `(SWposNode, SWnegNode)` | `(A1node, C1node)` | `swAC._hPN` |
| 7 | `(SWnegNode, SWposNode)` | `(C1node, A1node)` | `swAC._hNP` |
| 8 | `(SWnegNode, SWnegNode)` | `(C1node, C1node)` | `swAC._hNN` |

## setup() body — alloc only

The composite's `setup(ctx)` forwards to each sub-element in order. Each sub-element runs its own SW setup() body (see PB-SW for the per-element body):

```typescript
setup(ctx: SetupContext): void {
  // Composite forwards to sub-elements in subElements[] order.
  // swAB runs first (A1↔B1), swAC runs second (A1↔C1).
  this.swAB.setup(ctx);  // allocates SW_AB's 2 state slots + 4 matrix handles
  this.swAC.setup(ctx);  // allocates SW_AC's 2 state slots + 4 matrix handles
}
```

Each sub-element's setup() body is identical to PB-SW, using its own pinNodes binding.

## load() body — value writes only

Implementer ports value-side from `swload.c` line-for-line for each sub-element, stamping through the respective cached handles. No allocElement calls.

```typescript
load(ctx: LoadContext): void {
  this.swAB.load(ctx);  // stamps SW_AB conductance onto A1/B1 nodes
  this.swAC.load(ctx);  // stamps SW_AC conductance onto A1/C1 nodes
}
```

`setParam("ron" | "roff", v)` routes to both sub-elements:
```typescript
setParam(key: string, value: unknown): void {
  if (key === "ron" || key === "roff") {
    this.swAB.setParam(key, value);
    this.swAC.setParam(key, value);
  }
}
```

## findBranchFor (not applicable)

Neither SW sub-element has a branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Composite has no `ngspiceNodeMap` (sub-elements carry their own).
- No `findBranchFor` callback.
- Composite carries `{ swAB: SwitchElement, swAC: SwitchElement }` as direct refs — no `findDevice` needed for sub-element traversal.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-SW-DT is GREEN (8-entry sequence: SW_AB's 4 then SW_AC's 4).
2. `src/components/switching/__tests__/switches.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
