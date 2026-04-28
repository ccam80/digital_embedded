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

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in the implementation file matches the "setup() body — alloc only" listing in this PB line-for-line.
2. TSTALLOC sequence in `setup()` matches the order in the cited ngspice anchor file (see top of this PB, e.g. `ressetup.c:46-49`).
3. Factory cleanup applied per the "Factory cleanup" section above.
4. `ngspiceNodeMap` registered per the "Pin mapping" section above (or omitted for composites where the spec says so).
5. `load()` writes through cached handles only — zero `solver.allocElement(...)` calls inside `load()`, `accept()`, or any non-`setup()` method.
6. `mayCreateInternalNodes` flag set per spec.
7. `findBranchFor` callback present where spec says (V-output sources, IND, etc.).
8. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence/citation-divergence/partial) used in any commit message or report.
