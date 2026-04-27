# Task PB-RELAY

**digiTS file:** `src/components/switching/relay.ts`
**ngspice setup anchor (coil IND):** `ref/ngspice/src/spicelib/devices/ind/indsetup.c:84-100`
**ngspice setup anchor (contact SW):** `ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62`
**ngspice load anchor (coil IND):** `ref/ngspice/src/spicelib/devices/ind/indload.c`
**ngspice load anchor (contact SW):** `ref/ngspice/src/spicelib/devices/sw/swload.c`

## Pin mapping (from 01-pin-mapping.md)

Relay is a composite (1× IND coil + 1× SW contact). It has no `ngspiceNodeMap` of its own.

External pins: `in1` (coil+), `in2` (coil-), `A1` (contact side 1), `B1` (contact side 2).

| Sub-element | Pin map | digiTS pins |
|---|---|---|
| `coil_IND` | `{ in1: "pos", in2: "neg" }` | `pinNodes.get("in1")` → `INDposNode`, `pinNodes.get("in2")` → `INDnegNode` |
| `contact_SW` | `{ A1: "pos", B1: "neg" }` | `pinNodes.get("A1")` → `SWposNode`, `pinNodes.get("B1")` → `SWnegNode` |

Additionally, the coil has a series resistance (`coilResistance`) modelled as a RES-like stamp. The coil resistance is NOT a separate sub-element — it is stamped as 4 additional matrix handles inside the IND coil's setup, using the same `(INDposNode, INDnegNode)` node pair as the coil pins. See "TSTALLOC sequence" section for the coil-resistance handle list.

## Internal nodes

none — the IND coil allocates a branch row, not an internal voltage node; the SW contact has no internal nodes.

## Branch rows

1 — allocated by the IND coil via `ctx.makeCur(this.label + "_coil", "branch")`. The same idempotent guard as VSRC applies (`if (here->INDbrEq == 0)` at indsetup.c:84-87).

## State slots

2 (IND: `here->INDflux = *states; *states += 2` at indsetup.c:78-79) + 2 (SW: `SW_NUM_STATES = 2` at swsetup.c:47-48) = 4 total.

IND state slots run first (coil setup runs before contact setup in `subElements[]` order).

## TSTALLOC sequence (line-for-line port)

### Coil IND (indsetup.c:96-100) — runs first:

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 1 | `(INDposNode, INDbrEq)` | `(coilPosNode, coilBranch)` | `coil._hPosBr` |
| 2 | `(INDnegNode, INDbrEq)` | `(coilNegNode, coilBranch)` | `coil._hNegBr` |
| 3 | `(INDbrEq, INDnegNode)` | `(coilBranch, coilNegNode)` | `coil._hBrNeg` |
| 4 | `(INDbrEq, INDposNode)` | `(coilBranch, coilPosNode)` | `coil._hBrPos` |
| 5 | `(INDbrEq, INDbrEq)` | `(coilBranch, coilBranch)` | `coil._hBrBr` |

### Coil resistance (RES-like 4× TSTALLOC for `coilResistance` — stamped on same coil nodes):

The coil resistance is stamped as a conductance quartet on the coil pin nodes, exactly mirroring ressetup.c:46-49. These handles are allocated immediately after the IND handles, still within the coil's setup():

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 6 | `(INDposNode, INDposNode)` | `(coilPosNode, coilPosNode)` | `coil._hRpp` |
| 7 | `(INDnegNode, INDnegNode)` | `(coilNegNode, coilNegNode)` | `coil._hRnn` |
| 8 | `(INDposNode, INDnegNode)` | `(coilPosNode, coilNegNode)` | `coil._hRpn` |
| 9 | `(INDnegNode, INDposNode)` | `(coilNegNode, coilPosNode)` | `coil._hRnp` |

### Contact SW (swsetup.c:59-62) — runs second:

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 10 | `(SWposNode, SWposNode)` | `(A1node, A1node)` | `contact._hPP` |
| 11 | `(SWposNode, SWnegNode)` | `(A1node, B1node)` | `contact._hPN` |
| 12 | `(SWnegNode, SWposNode)` | `(B1node, A1node)` | `contact._hNP` |
| 13 | `(SWnegNode, SWnegNode)` | `(B1node, B1node)` | `contact._hNN` |

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  // IND coil setup runs first (higher ngspiceLoadOrder priority for inductors).
  this._coil.setup(ctx);    // allocates 2 IND state slots + branch row + 5 IND handles + 4 coil-R handles
  this._contact.setup(ctx); // allocates 2 SW state slots + 4 SW handles
}
```

The coil's setup() includes the coil-resistance TSTALLOC quartet (positions 6-9) because coil resistance is an intrinsic property of the inductor model, not a separate element.

## load() body — value writes only

Implementer ports value-side from `indload.c` and `swload.c` line-for-line, stamping through cached handles. No allocElement calls.

```typescript
load(ctx: LoadContext): void {
  this._coil.load(ctx);    // stamps IND Thevenin equiv (req, veq) + coilResistance conductance
  this._contact.load(ctx); // stamps SW conductance based on coil current state
}
```

The contact SW's control voltage is `I_coil` (coil branch current from `ctx.rhsOld[coilBranch]`), compared against a threshold to determine relay state.

## findBranchFor (applicable — IND coil)

```typescript
// Registered on the MnaModel for Relay (forwarded from coil IND).
// Mirrors INDsetup.c:84-87 idempotent guard.
findBranchFor(name: string, ctx: SetupContext): number {
  // Match by coil label convention: `${relayLabel}_coil`
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
- Add `hasBranchRow: true` (coil IND contributes a branch row).
- Add `mayCreateInternalNodes: false` (omit).
- Composite has no `ngspiceNodeMap`.
- Add `findBranchFor` callback (forwards to coil IND's lazy-allocating guard).
- Composite carries `{ _coil: IndElement, _contact: SwitchElement }` as direct refs — no `findDevice` needed.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-RELAY is GREEN (13-entry sequence: 5 IND + 4 coil-R + 4 SW).
2. `src/components/switching/__tests__/relay.test.ts` is GREEN.
3. No banned closing verdicts.
