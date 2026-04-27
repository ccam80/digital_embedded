# Task PB-RELAY-DT

**digiTS file:** `src/components/switching/relay-dt.ts`
**ngspice setup anchor (coil IND):** `ref/ngspice/src/spicelib/devices/ind/indsetup.c:84-100`
**ngspice setup anchor (coil RES):** `ref/ngspice/src/spicelib/devices/res/ressetup.c:46-49`
**ngspice setup anchor (contacts SW×2):** `ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62`
**ngspice load anchor (coil IND):** `ref/ngspice/src/spicelib/devices/ind/indload.c`
**ngspice load anchor (coil RES):** `ref/ngspice/src/spicelib/devices/res/resload.c`
**ngspice load anchor (contacts SW):** `ref/ngspice/src/spicelib/devices/sw/swload.c`

## Architecture

RelayDT is a composite of 4 sub-elements: `coilL` (IND) + `coilR` (RES) + `swNO` (SW,
normally-open) + `swNC` (SW, normally-closed).

The coil resistance is a separate RES sub-element in series with `coilL`. A mid-node `_nCoilMid`
sits between `coilL` and `coilR`. All 17 TSTALLOC entries are owned by named sub-elements with
ngspice anchors; there are no composite-level `allocElement` calls.

## Pin mapping

RelayDT has no `ngspiceNodeMap` of its own.

External pins: `in1` (coil+), `in2` (coil-), `A1` (common contact), `B1` (normally-open contact),
`C1` (normally-closed contact).

| Sub-element | label suffix | ngspice anchor | Pin assignments |
|---|---|---|---|
| `coilL` | `_coilL` | `ind/indsetup.c` | `in1`→`A` (INDposNode), `_nCoilMid`→`B` (INDnegNode) |
| `coilR` | `_coilR` | `res/ressetup.c` | `_nCoilMid`→`A` (RESposNode), `in2`→`B` (RESnegNode) |
| `swNO` | `_swNO` | `sw/swsetup.c` | `A1`→`pos` (SWposNode), `B1`→`neg` (SWnegNode) |
| `swNC` | `_swNC` | `sw/swsetup.c` | `A1`→`pos` (SWposNode), `C1`→`neg` (SWnegNode) |

Circuit topology: `in1` → `coilL` (inductance) → `_nCoilMid` → `coilR` (resistance) → `in2`.
Contacts: `A1` ↔ `B1` via `swNO`; `A1` ↔ `C1` via `swNC`.

## Internal nodes

1 — `_nCoilMid`: the junction between `coilL` and `coilR`. Allocated via
`ctx.makeVolt(label, "coilMid")` in `setup()`.

## Branch rows

1 — allocated by `coilL` (IND) via `ctx.makeCur(label + "_coilL", "branch")`. Same idempotent
guard as PB-RELAY.

## State slots

| Sub-element | Slots | Source |
|---|---|---|
| `coilL` (IND) | 2 | `indsetup.c:78-79`: `*states += 2` |
| `coilR` (RES) | 0 | `ressetup.c`: `NG_IGNORE(state)`, no allocation |
| `swNO` (SW) | 2 | `swsetup.c:47-48`: `SW_NUM_STATES = 2` |
| `swNC` (SW) | 2 | `swsetup.c:47-48`: `SW_NUM_STATES = 2` |

Total: 6 state slots. Allocation order: coilL first, then swNO, then swNC (coilR has none).

## TSTALLOC sequence (17 entries — line-for-line port, all ngspice-anchored)

### coilL (IND) — indsetup.c:96-100, runs first:

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 1 | `(INDposNode, INDbrEq)` | `(in1node, coilBranch)` | `coilL._hPIbr` |
| 2 | `(INDnegNode, INDbrEq)` | `(_nCoilMid, coilBranch)` | `coilL._hNIbr` |
| 3 | `(INDbrEq, INDnegNode)` | `(coilBranch, _nCoilMid)` | `coilL._hIbrN` |
| 4 | `(INDbrEq, INDposNode)` | `(coilBranch, in1node)` | `coilL._hIbrP` |
| 5 | `(INDbrEq, INDbrEq)` | `(coilBranch, coilBranch)` | `coilL._hIbrIbr` |

### coilR (RES) — ressetup.c:46-49, runs second:

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 6 | `(RESposNode, RESposNode)` | `(_nCoilMid, _nCoilMid)` | `coilR._hPP` |
| 7 | `(RESnegNode, RESnegNode)` | `(in2node, in2node)` | `coilR._hNN` |
| 8 | `(RESposNode, RESnegNode)` | `(_nCoilMid, in2node)` | `coilR._hPN` |
| 9 | `(RESnegNode, RESposNode)` | `(in2node, _nCoilMid)` | `coilR._hNP` |

### swNO (SW normally-open) — swsetup.c:59-62, runs third:

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 10 | `(SWposNode, SWposNode)` | `(A1node, A1node)` | `swNO._hPP` |
| 11 | `(SWposNode, SWnegNode)` | `(A1node, B1node)` | `swNO._hPN` |
| 12 | `(SWnegNode, SWposNode)` | `(B1node, A1node)` | `swNO._hNP` |
| 13 | `(SWnegNode, SWnegNode)` | `(B1node, B1node)` | `swNO._hNN` |

### swNC (SW normally-closed) — swsetup.c:59-62, runs fourth:

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 14 | `(SWposNode, SWposNode)` | `(A1node, A1node)` | `swNC._hPP` |
| 15 | `(SWposNode, SWnegNode)` | `(A1node, C1node)` | `swNC._hPN` |
| 16 | `(SWnegNode, SWposNode)` | `(C1node, A1node)` | `swNC._hNP` |
| 17 | `(SWnegNode, SWnegNode)` | `(C1node, C1node)` | `swNC._hNN` |

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  const in1node = this._pinNodes.get("in1")!;
  const in2node = this._pinNodes.get("in2")!;

  // Allocate mid-node between coilL and coilR
  this._nCoilMid = ctx.makeVolt(this._label, "coilMid");

  // Wire coilL: in1 → coilMid
  this._coilL.setPinNode("B", this._nCoilMid);

  // Wire coilR: coilMid → in2
  this._coilR.setPinNode("A", this._nCoilMid);

  // Sub-element setup in NGSPICE_LOAD_ORDER
  this._coilL.setup(ctx);  // 2 IND state slots + branch row + 5 IND handles
  this._coilR.setup(ctx);  // 0 state slots + 4 RES handles
  this._swNO.setup(ctx);   // 2 SW state slots + 4 SW handles (A1↔B1, normally-open)
  this._swNC.setup(ctx);   // 2 SW state slots + 4 SW handles (A1↔C1, normally-closed)
}
```

## load() body — value writes only

Ports value-side from `indload.c`, `resload.c`, and `swload.c` line-for-line. No `allocElement`
calls.

`swNO` (normally-open) starts OFF and closes when relay energises.
`swNC` (normally-closed) starts ON and opens when relay energises.
Both read coil current from `ctx.rhsOld[coilBranch]` for their control value.

```typescript
load(ctx: LoadContext): void {
  this._coilL.load(ctx);  // IND Thevenin equivalent (req, veq)
  this._coilR.load(ctx);  // RES conductance stamp (coilResistance)
  this._swNO.load(ctx);   // normally-open: ON when |I_coil| > pickupCurrent
  this._swNC.load(ctx);   // normally-closed: OFF when |I_coil| > pickupCurrent (inverted)
}
```

`setParam("coilResistance", v)` routes to `this._coilR`. `setParam("inductance", v)` routes to
`this._coilL`. `setParam("ron" | "roff", v)` routes to both `this._swNO` and `this._swNC`.

## findBranchFor (applicable — coilL IND)

Relay coil sub-element label is `${relayLabel}/_coilL`. External callers reference the coil via
its full namespaced name. The `/` separator matches the engine's `_deviceMap` keying
(see `00-engine.md` §A4.1).

```typescript
findBranchFor(name: string, ctx: SetupContext): number {
  const coilEl = ctx.findDevice(name);
  if (!coilEl) return 0;
  if (coilEl.branchIndex === -1) {
    coilEl.branchIndex = ctx.makeCur(name, "branch");
  }
  return coilEl.branchIndex;
}
```

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Add `mayCreateInternalNodes: true` (`_nCoilMid` allocated in `setup()`).
- Composite has no `ngspiceNodeMap`.
- Add `findBranchFor` callback (forwards to coilL IND's lazy-allocating guard).
- Composite carries `{ _coilL: IndElement, _coilR: ResElement, _swNO: SwitchElement,
  _swNC: SwitchElement }` as direct refs.
- Remove the old `coil._hRpp`, `coil._hRnn`, `coil._hRpn`, `coil._hRnp` handle fields from the
  IND coil class; these are now owned by `coilR` (ResElement) with its own ngspice anchor.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-RELAY-DT is GREEN (17-entry sequence: 5 IND + 4 RES +
   4 SW_NO + 4 SW_NC, all ngspice-anchored).
2. `src/components/switching/__tests__/relay.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts.
