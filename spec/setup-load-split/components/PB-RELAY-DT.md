# Task PB-RELAY-DT

**digiTS file:** `src/components/switching/relay-dt.ts`
**ngspice setup anchor (coil IND):** `ref/ngspice/src/spicelib/devices/ind/indsetup.c:84-100`
**ngspice setup anchor (contacts SW×2):** `ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62`
**ngspice load anchor (coil IND):** `ref/ngspice/src/spicelib/devices/ind/indload.c`
**ngspice load anchor (contacts SW):** `ref/ngspice/src/spicelib/devices/sw/swload.c`

## Pin mapping (from 01-pin-mapping.md)

RelayDT is a composite (1× IND coil + 2× SW contacts). It has no `ngspiceNodeMap` of its own.

External pins: `in1` (coil+), `in2` (coil-), `A1` (common contact), `B1` (normally-open contact), `C1` (normally-closed contact).

| Sub-element | Pin map | digiTS pins |
|---|---|---|
| `coil_IND` | `{ in1: "pos", in2: "neg" }` | `pinNodes.get("in1")` → `INDposNode`, `pinNodes.get("in2")` → `INDnegNode` |
| `SW_AB` (normally-open) | `{ A1: "pos", B1: "neg" }` | `pinNodes.get("A1")` → `SWposNode`, `pinNodes.get("B1")` → `SWnegNode` |
| `SW_AC` (normally-closed) | `{ A1: "pos", C1: "neg" }` | `pinNodes.get("A1")` → `SWposNode`, `pinNodes.get("C1")` → `SWnegNode` |

The coil-resistance stamp is identical to PB-RELAY (4 additional handles on coil pin nodes, allocated inside the coil's setup() after the IND handles).

## Internal nodes

none — IND allocates a branch row only; both SW contacts have no internal nodes.

## Branch rows

1 — allocated by the IND coil via `ctx.makeCur(this.label + "_coil", "branch")`. Same idempotent guard as PB-RELAY.

## State slots

2 (IND) + 2 (SW_AB) + 2 (SW_AC) = 6 total. Allocation order: coil IND first, then SW_AB, then SW_AC, in `subElements[]` order.

## TSTALLOC sequence (line-for-line port)

### Coil IND (indsetup.c:96-100) — runs first:

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 1 | `(INDposNode, INDbrEq)` | `(coilPosNode, coilBranch)` | `coil._hPosBr` |
| 2 | `(INDnegNode, INDbrEq)` | `(coilNegNode, coilBranch)` | `coil._hNegBr` |
| 3 | `(INDbrEq, INDnegNode)` | `(coilBranch, coilNegNode)` | `coil._hBrNeg` |
| 4 | `(INDbrEq, INDposNode)` | `(coilBranch, coilPosNode)` | `coil._hBrPos` |
| 5 | `(INDbrEq, INDbrEq)` | `(coilBranch, coilBranch)` | `coil._hBrBr` |

### Coil resistance (RES-like quartet, allocated inside coil setup()):

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 6 | `(INDposNode, INDposNode)` | `(coilPosNode, coilPosNode)` | `coil._hRpp` |
| 7 | `(INDnegNode, INDnegNode)` | `(coilNegNode, coilNegNode)` | `coil._hRnn` |
| 8 | `(INDposNode, INDnegNode)` | `(coilPosNode, coilNegNode)` | `coil._hRpn` |
| 9 | `(INDnegNode, INDposNode)` | `(coilNegNode, coilPosNode)` | `coil._hRnp` |

### SW_AB normally-open (swsetup.c:59-62) — runs second:

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 10 | `(SWposNode, SWposNode)` | `(A1node, A1node)` | `swAB._hPP` |
| 11 | `(SWposNode, SWnegNode)` | `(A1node, B1node)` | `swAB._hPN` |
| 12 | `(SWnegNode, SWposNode)` | `(B1node, A1node)` | `swAB._hNP` |
| 13 | `(SWnegNode, SWnegNode)` | `(B1node, B1node)` | `swAB._hNN` |

### SW_AC normally-closed (swsetup.c:59-62) — runs third:

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 14 | `(SWposNode, SWposNode)` | `(A1node, A1node)` | `swAC._hPP` |
| 15 | `(SWposNode, SWnegNode)` | `(A1node, C1node)` | `swAC._hPN` |
| 16 | `(SWnegNode, SWposNode)` | `(C1node, A1node)` | `swAC._hNP` |
| 17 | `(SWnegNode, SWnegNode)` | `(C1node, C1node)` | `swAC._hNN` |

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  // Coil runs first; both contacts follow in order.
  this._coil.setup(ctx);  // 2 IND state slots + branch + 5 IND handles + 4 coil-R handles
  this._swAB.setup(ctx);  // 2 SW state slots + 4 SW handles (A1↔B1, normally-open)
  this._swAC.setup(ctx);  // 2 SW state slots + 4 SW handles (A1↔C1, normally-closed)
}
```

## load() body — value writes only

Implementer ports value-side from `indload.c` and `swload.c` line-for-line. No allocElement calls.

SW_AB (normally-open) starts OFF and closes when relay energises. SW_AC (normally-closed) starts ON and opens when relay energises. Both read coil current from `ctx.rhsOld[coilBranch]` for their control value:

```typescript
load(ctx: LoadContext): void {
  this._coil.load(ctx);  // IND Thevenin + coilResistance
  this._swAB.load(ctx);  // normally-open: ON when |I_coil| > pickupCurrent
  this._swAC.load(ctx);  // normally-closed: OFF when |I_coil| > pickupCurrent (inverted)
}
```

`setParam("coilResistance" | "inductance", v)` routes to `this._coil`. `setParam("ron" | "roff", v)` routes to both `this._swAB` and `this._swAC`.

## findBranchFor (applicable — IND coil)

```typescript
// Identical structure to PB-RELAY.
findBranchFor(name: string, ctx: SetupContext): number {
  if (coilInstance.label === name) {
    if (coilInstance.branchIndex === -1) {
      coilInstance.branchIndex = ctx.makeCur(coilInstance.label, "branch");
    }
    return coilInstance.branchIndex;
  }
  return 0;
}
```

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Add `hasBranchRow: true`.
- Composite has no `ngspiceNodeMap`.
- Add `findBranchFor` callback (forwards to coil IND's lazy-allocating guard).
- Composite carries `{ _coil: IndElement, _swAB: SwitchElement, _swAC: SwitchElement }` as direct refs.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-RELAY-DT is GREEN (17-entry sequence: 5 IND + 4 coil-R + 4 SW_AB + 4 SW_AC).
2. `src/components/switching/__tests__/relay.test.ts` is GREEN.
3. No banned closing verdicts.
