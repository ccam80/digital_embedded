# Task PB-FGPFET

**digiTS file:** `src/components/switching/fgpfet.ts`
**ngspice setup anchor (MOS sub-element):** `ref/ngspice/src/spicelib/devices/mos1/mos1set.c:92-207`
**ngspice setup anchor (CAP sub-element):** `ref/ngspice/src/spicelib/devices/cap/capsetup.c:114-117`
**ngspice load anchor (MOS):** `ref/ngspice/src/spicelib/devices/mos1/mos1load.c`
**ngspice load anchor (CAP):** `ref/ngspice/src/spicelib/devices/cap/capload.c`

## Pin mapping (from 01-pin-mapping.md)

FGPFET is a composite (MOS + CAP). It has no `ngspiceNodeMap` of its own.

External pins: `G` (external gate, not directly connected to MOS gate), `D` (drain), `S` (source).

An auxiliary internal node `fg` (floating gate) is allocated via `ctx.makeVolt(this.label, "fg")`. This node is the MOS gate input and the CAP positive terminal. The external pin `G` is a parameter input for charge injection logic only — it carries no MNA node.

### MOS sub-element pin map

`{ G: "gate", D: "drain", S: "source" }` — but MOS's `G` pin is wired to the floating-gate internal node `fgNode`, **not** to `pinNodes.get("G")`. The MOS type is PMOS (`MOS1type = PMOS`).

| MOS sub-element node | Resolves to |
|---|---|
| `MOS1gNode` (gate) | `fgNode` (floating-gate internal node) |
| `MOS1dNode` (drain) | `pinNodes.get("D")` |
| `MOS1sNode` (source) | `pinNodes.get("S")` |
| `MOS1bNode` (bulk) | `pinNodes.get("S")` (3-terminal: bulk tied to source) |
| `MOS1dNodePrime` | equals `MOS1dNode` (no drain resistance in digital model) |
| `MOS1sNodePrime` | equals `MOS1sNode` (no source resistance in digital model) |

### CAP sub-element pin map

`{ pos: "pos", neg: "neg" }` — CAP's `pos` is wired to `fgNode` (floating gate), CAP's `neg` is wired to ground (0). Same coupling structure as FGNFET.

## Internal nodes

1 — the floating-gate node `fgNode`, allocated via:
```typescript
this._fgNode = ctx.makeVolt(this.label, "fg");
```

## Branch rows

none — neither MOS nor CAP allocates a branch row.

## State slots

MOS1numStates + 2 (CAP).

**Setup order**: sub-elements are sorted by `ngspiceLoadOrder` and processed in ascending order. Concrete values (from `src/core/analog-types.ts`):
- `NGSPICE_LOAD_ORDER.CAP = 17`
- `NGSPICE_LOAD_ORDER.MOS = 35`

Since 17 < 35, the floating-gate CAP sub-element's `setup()` runs before the MOS sub-element's `setup()`. This determines the state-slot offsets: CAP slots are allocated first (lower offsets), MOS slots second (higher offsets). Composite implementers MUST NOT hard-code the order in the setup() body — sort by `ngspiceLoadOrder` so the order remains correct if either anchor's value moves.

## TSTALLOC sequence (line-for-line port)

Identical structure to PB-FGNFET. The MOS type (NMOS vs PMOS) affects load-time computation only — the TSTALLOC sequence in `mos1set.c:186-207` is unconditional and type-independent.

### CAP sub-element (capsetup.c:114-117) — runs first:

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 1 | `(CAPposNode, CAPposNode)` | `(fgNode, fgNode)` | `cap._hPP` |
| 2 | `(CAPnegNode, CAPnegNode)` | `(0, 0)` | `cap._hNN` |
| 3 | `(CAPposNode, CAPnegNode)` | `(fgNode, 0)` | `cap._hPN` |
| 4 | `(CAPnegNode, CAPposNode)` | `(0, fgNode)` | `cap._hNP` |

### MOS sub-element (mos1set.c:186-207) — runs second:

Same 22-entry sequence as PB-FGNFET, with `fgNode` in place of any `MOS1gNode` reference, and `sourceNode` in place of `MOS1bNode` (bulk = source):

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 5 | `(MOS1dNode, MOS1dNode)` | `(drainNode, drainNode)` | `mos._hDd` |
| 6 | `(MOS1gNode, MOS1gNode)` | `(fgNode, fgNode)` | `mos._hGg` |
| 7 | `(MOS1sNode, MOS1sNode)` | `(sourceNode, sourceNode)` | `mos._hSs` |
| 8 | `(MOS1bNode, MOS1bNode)` | `(sourceNode, sourceNode)` | `mos._hBb` |
| 9 | `(MOS1dNodePrime, MOS1dNodePrime)` | `(drainNode, drainNode)` | `mos._hDPdp` |
| 10 | `(MOS1sNodePrime, MOS1sNodePrime)` | `(sourceNode, sourceNode)` | `mos._hSPsp` |
| 11 | `(MOS1dNode, MOS1dNodePrime)` | `(drainNode, drainNode)` | `mos._hDdp` |
| 12 | `(MOS1gNode, MOS1bNode)` | `(fgNode, sourceNode)` | `mos._hGb` |
| 13 | `(MOS1gNode, MOS1dNodePrime)` | `(fgNode, drainNode)` | `mos._hGdp` |
| 14 | `(MOS1gNode, MOS1sNodePrime)` | `(fgNode, sourceNode)` | `mos._hGsp` |
| 15 | `(MOS1sNode, MOS1sNodePrime)` | `(sourceNode, sourceNode)` | `mos._hSsp` |
| 16 | `(MOS1bNode, MOS1dNodePrime)` | `(sourceNode, drainNode)` | `mos._hBdp` |
| 17 | `(MOS1bNode, MOS1sNodePrime)` | `(sourceNode, sourceNode)` | `mos._hBsp` |
| 18 | `(MOS1dNodePrime, MOS1sNodePrime)` | `(drainNode, sourceNode)` | `mos._hDPsp` |
| 19 | `(MOS1dNodePrime, MOS1dNode)` | `(drainNode, drainNode)` | `mos._hDPd` |
| 20 | `(MOS1bNode, MOS1gNode)` | `(sourceNode, fgNode)` | `mos._hBg` |
| 21 | `(MOS1dNodePrime, MOS1gNode)` | `(drainNode, fgNode)` | `mos._hDPg` |
| 22 | `(MOS1sNodePrime, MOS1gNode)` | `(sourceNode, fgNode)` | `mos._hSPg` |
| 23 | `(MOS1sNodePrime, MOS1sNode)` | `(sourceNode, sourceNode)` | `mos._hSPs` |
| 24 | `(MOS1dNodePrime, MOS1bNode)` | `(drainNode, sourceNode)` | `mos._hDPb` |
| 25 | `(MOS1sNodePrime, MOS1bNode)` | `(sourceNode, sourceNode)` | `mos._hSPb` |
| 26 | `(MOS1sNodePrime, MOS1dNodePrime)` | `(sourceNode, drainNode)` | `mos._hSPdp` |

## setup() body — alloc only

```typescript
setup(ctx: SetupContext): void {
  // Allocate the floating-gate internal node first.
  this._fgNode = ctx.makeVolt(this.label, "fg");

  // Sort sub-elements by ngspiceLoadOrder; ascending order = ngspice cktLoad order.
  // CAP (17) loads before MOS (35), so CAP's state slots and handles come first.
  // Do NOT hard-code the order — sort so this remains correct if either anchor's
  // NGSPICE_LOAD_ORDER value moves.
  for (const sub of [this._cap, this._mos].sort((a, b) => a.ngspiceLoadOrder - b.ngspiceLoadOrder)) {
    sub.setup(ctx);
  }
}
```

## load() body — value writes only

Implementer ports value-side from `mos1load.c` (PMOS path, `MOS1type = PMOS`) and `capload.c` line-for-line, stamping through cached handles. No allocElement calls.

```typescript
load(ctx: LoadContext): void {
  this._cap.load(ctx);
  this._mos.load(ctx);  // PMOS: signs on Vgs, Vds are negated relative to NMOS
}
```

- Preserve multiplicity scaling: the MOS sub-element's load() multiplies all current and conductance stamps by the instance `M` parameter (default 1.0). ngspice anchor: `mos1load.c` uses `here->MOS1m` for this scaling. The instance `M` parameter is partition: "instance" per the in-progress phase-instance-vs-model-param-partition work.

## findBranchFor (not applicable)

Neither MOS nor CAP has a branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Add `mayCreateInternalNodes: true`.
- Composite has no `ngspiceNodeMap`.
- No `findBranchFor` callback.
- Composite carries `{ _cap: CapElement, _mos: MosElement, _fgNode: number }` as direct refs.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-FGPFET is GREEN (26-entry sequence: 4 CAP + 22 MOS — identical positions to PB-FGNFET).
2. `src/components/switching/__tests__/fets.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts.
