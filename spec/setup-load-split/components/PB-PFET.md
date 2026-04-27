# Task PB-PFET

**digiTS file:** `src/components/switching/pfet.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62` (applied once — single SW sub-element)
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/sw/swload.c`

## Pin mapping (from 01-pin-mapping.md)

PFET is a composite that decomposes to a single SW sub-element. The composite has no `ngspiceNodeMap` of its own.

SW sub-element pin map: `{ G: "ctrl", D: "pos", S: "neg" }`

| digiTS composite pin | SW sub-element role | ngspice node variable |
|---|---|---|
| `D` (Drain) | `SWposNode` | `SWposNode` |
| `S` (Source) | `SWnegNode` | `SWnegNode` |
| `G` (Gate) | control input — NOT a switch pin node | inverted control polarity set via setParam at load time |

The gate pin `G` is not wired into the SW MNA stamp. PFET differs from NFET only in the control polarity: the switch turns ON when `V(S) - V(G) > |Vth|` (i.e., `V(G) - V(S) < -|Vth|`). This inversion is applied at load time by negating the control voltage before the threshold comparison, not by changing the SW setup structure.

## Internal nodes

none — the SW sub-element has no internal nodes.

## Branch rows

none — SW stamps conductance only.

## State slots

2 — allocated by the SW sub-element (`SW_NUM_STATES = 2`, swsetup.c:47-48).

## TSTALLOC sequence (line-for-line port)

Single SW sub-element (swsetup.c:59-62). Identical to PB-NFET — the structural allocation is the same; only load-time polarity differs:

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 1 | `(SWposNode, SWposNode)` | `(drainNode, drainNode)` | `sw._hPP` |
| 2 | `(SWposNode, SWnegNode)` | `(drainNode, sourceNode)` | `sw._hPN` |
| 3 | `(SWnegNode, SWposNode)` | `(sourceNode, drainNode)` | `sw._hNP` |
| 4 | `(SWnegNode, SWnegNode)` | `(sourceNode, sourceNode)` | `sw._hNN` |

where `drainNode = pinNodes.get("D")` and `sourceNode = pinNodes.get("S")`.

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  // PFET composite forwards directly to its single SW sub-element.
  // SW sub-element uses D as posNode, S as negNode.
  // Inverted polarity is a load-time concern only — setup is identical to NFET.
  this._sw.setup(ctx);
}
```

The SW sub-element's setup() body is identical to PB-SW with `posNode = pinNodes.get("D")` and `negNode = pinNodes.get("S")`.

## load() body — value writes only

Implementer ports value-side from `swload.c` line-for-line, stamping through cached handles. No allocElement calls.

PFET inverts the control voltage before threshold comparison. When `V(S) - V(G) > |Vth|` (equivalently `V(G) - V(S) < -|Vth|`) the switch turns ON:

```typescript
load(ctx: LoadContext): void {
  // Inverted control: PFET turns ON when source is higher than gate by |Vth|
  // Negate vCtrl so the same SW threshold logic applies
  const vCtrl = ctx.rhsOld[sourceNode] - ctx.rhsOld[gateNode];  // inverted
  this._sw.setCtrlVoltage(vCtrl);  // Defined in PB-SW §"setCtrlVoltage(v) — for composite use only"
  this._sw.load(ctx);  // stamps g_now onto D/S nodes
}
```

## findBranchFor (not applicable)

SW has no branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Composite has no `ngspiceNodeMap` (sub-element carries its own: `{ D: "pos", S: "neg" }`).
- No `findBranchFor` callback.
- Composite carries `{ _sw: SwitchElement }` as a direct ref.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-PFET is GREEN (4-entry sequence matching SW anchor, identical to NFET).
2. `src/components/switching/__tests__/fets.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts.
