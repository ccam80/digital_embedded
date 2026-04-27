# Task PB-SW

**digiTS file:** `src/components/switching/switch.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/sw/swload.c`

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { A1: "pos", B1: "neg" }`

| digiTS pin label | ngspice node variable | pinNodes.get() key |
|---|---|---|
| `A1` | `SWposNode` | `"A1"` |
| `B1` | `SWnegNode` | `"B1"` |

Note: `SWposCntrlNode` / `SWnegCntrlNode` are the control-voltage nodes used in `swload.c`. In digiTS, the switch control polarity/threshold is set via `setParam` at load time (not as MNA nodes), so these control node variables have no pin-map entry. The load() implementer reads the control signal from the digital domain via the existing mechanism.

## Internal nodes

none

## Branch rows

none — SW stamps a conductance, not a branch row.

## State slots

2 — `swsetup.c:47-48`:
```c
here->SWstate = *states;
*states += SW_NUM_STATES;  // SW_NUM_STATES = 2 (swdefs.h:56)
```

`SW_NUM_STATES = 2` confirmed at `ref/ngspice/src/spicelib/devices/sw/swdefs.h:56`.

State slot 0 (`SWstate + 0`): current switch state (REALLY_OFF=0, REALLY_ON=1, HYST_OFF=2, HYST_ON=3).
State slot 1 (`SWstate + 1`): control voltage at last evaluation.

## TSTALLOC sequence (line-for-line port)

`swsetup.c:59-62` — 4 allocations, in order:

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 1 | `(SWposNode, SWposNode)` | `(posNode, posNode)` | `_hPP` |
| 2 | `(SWposNode, SWnegNode)` | `(posNode, negNode)` | `_hPN` |
| 3 | `(SWnegNode, SWposNode)` | `(negNode, posNode)` | `_hNP` |
| 4 | `(SWnegNode, SWnegNode)` | `(negNode, negNode)` | `_hNN` |

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  const posNode = this.pinNodes.get("A1")!;
  const negNode = this.pinNodes.get("B1")!;

  // Port of swsetup.c:47-48 — state slot allocation
  this._stateBase = ctx.allocStates(2);  // SW_NUM_STATES = 2

  // Port of swsetup.c:59-62 — TSTALLOC sequence (line-for-line)
  this._hPP = ctx.solver.allocElement(posNode, posNode); // SWposNode, SWposNode
  this._hPN = ctx.solver.allocElement(posNode, negNode); // SWposNode, SWnegNode
  this._hNP = ctx.solver.allocElement(negNode, posNode); // SWnegNode, SWposNode
  this._hNN = ctx.solver.allocElement(negNode, negNode); // SWnegNode, SWnegNode
}
```

## load() body — value writes only

Implementer ports value-side from `swload.c` line-for-line, stamping through cached handles. No allocElement calls.

Key stamps (swload.c:149-152):
```typescript
// swload.c:149-152
solver.stampElement(this._hPP, +g_now);
solver.stampElement(this._hPN, -g_now);
solver.stampElement(this._hNP, -g_now);
solver.stampElement(this._hNN, +g_now);
```
where `g_now` is `model.SWonConduct` (when ON) or `model.SWoffConduct` (when OFF), derived from the switch state stored in state slots.

## findBranchFor (not applicable)

SW has no branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Add `ngspiceNodeMap: { A1: "pos", B1: "neg" }`.
- No `findBranchFor` callback.

## Public API

### `setCtrlVoltage(v: number): void` — for composite use only

Stores `v` as the pending control voltage for the next `load()` call. The composite caller (e.g., AnalogSwitch, NFET, PFET) reads its own control input voltage and pushes it into the SW sub-element via this setter before calling `sw.load(ctx)`. Used because the SW sub-element does not know about its parent composite's control wiring.

Spec:
- `setCtrlVoltage(v: number): void` — stores `v` in `this._pendingCtrlVoltage`. Default initial value: 0.
- `load(ctx)` reads `this._pendingCtrlVoltage` (instead of computing control voltage from a node) when running the SW state machine (vThreshold / vHysteresis comparison).
- This is a digiTS extension; no ngspice anchor (ngspice SW reads control directly from CKTrhsOld via positive/negative control nodes — our composites need this indirection because the control source isn't always a node).

Add field: `private _pendingCtrlVoltage: number = 0;`

### `setSwState(on: boolean): void` — for composite use only

Forces the SW state machine into the given on/off state, skipping the threshold comparison for the next `load()` call. Used by composites (e.g., AnalogSwitch SPDT) that compute ON/OFF externally and need to drive each sub-switch independently.

Spec:
- `setSwState(on: boolean): void` — stores the forced state in an internal field (e.g., `this._forcedState: boolean | null`). When non-null, `load()` uses this state directly instead of evaluating `_pendingCtrlVoltage` against vThreshold/vHysteresis; resets to `null` after each `load()` call.
- Default: `null` (no forced state — threshold comparison applies).

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-SW is GREEN.
2. `src/components/switching/__tests__/switches.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
