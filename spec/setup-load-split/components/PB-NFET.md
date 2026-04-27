# Task PB-NFET

**digiTS file:** `src/components/switching/nfet.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62` (applied once — single SW sub-element)
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/sw/swload.c`

## Pin mapping (from 01-pin-mapping.md)

NFET is a composite that decomposes to a single SW sub-element. The composite has no `ngspiceNodeMap` of its own.

SW sub-element pin map: `{ G: "ctrl", D: "pos", S: "neg" }`

| digiTS composite pin | SW sub-element role | ngspice node variable |
|---|---|---|
| `D` (Drain) | `SWposNode` | `SWposNode` |
| `S` (Source) | `SWnegNode` | `SWnegNode` |
| `G` (Gate) | control input — NOT a switch pin node | control polarity set via setParam at load time |

The gate pin `G` is not wired into the SW MNA stamp. It provides the control voltage, which is read from `CKTrhsOld` in `swload.c`. The SW sub-element's `SWposCntrlNode` / `SWnegCntrlNode` are resolved at load time by reading `pinNodes.get("G")` and ground (0) respectively for an n-channel enhancement MOSFET threshold comparison.

## Internal nodes

none — the SW sub-element has no internal nodes.

## Branch rows

none — SW stamps conductance only.

## State slots

2 — allocated by the SW sub-element (`SW_NUM_STATES = 2`, swsetup.c:47-48).

## TSTALLOC sequence (line-for-line port)

Single SW sub-element (swsetup.c:59-62):

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
  // NFET composite forwards directly to its single SW sub-element.
  // SW sub-element uses D as posNode, S as negNode.
  this._sw.setup(ctx);
}
```

The SW sub-element's setup() body is identical to PB-SW with `posNode = pinNodes.get("D")` and `negNode = pinNodes.get("S")`.

## load() body — value writes only

Implementer ports value-side from `swload.c` line-for-line, stamping through cached handles. No allocElement calls.

At load time the control voltage is `V(G) - V(S)` (gate-to-source). The SW sub-element's threshold (`SWvThreshold`) is set to the NFET threshold voltage via `setParam("threshold", Vth)`. When `V(G) - V(S) > Vth` the switch turns ON (`g_now = ron`), otherwise OFF (`g_now = roff`):

```typescript
load(ctx: LoadContext): void {
  // Control voltage: V(G) - V(S), compared against threshold
  const vCtrl = ctx.rhsOld[gateNode] - ctx.rhsOld[sourceNode];
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

1. `setup-stamp-order.test.ts` row for PB-NFET is GREEN (4-entry sequence matching SW anchor).
2. `src/components/switching/__tests__/fets.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts.
