# Task PB-TRIAC

**digiTS file:** `src/components/semiconductors/triac.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/bjt/bjtsetup.c:347-465` (per sub-element)
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/bjt/bjtload.c` (per sub-element)

## Pin mapping (from 01-pin-mapping.md)

TRIAC is a **composite** — it does not stamp into the matrix directly.
It decomposes into 4× BJT (= 2× SCR antiparallel). This gives the
TRIAC its bidirectional conduction capability.

| digiTS parent label | Parent pin | Role |
|---|---|---|
| `MT1` | Main Terminal 1 | SCR1 anode / SCR2 cathode |
| `MT2` | Main Terminal 2 | SCR1 cathode / SCR2 anode |
| `G` | Gate | Both SCRs' trigger input |

## Four-transistor latch — node assignment table

The TRIAC is modelled as two antiparallel SCRs, each built from the
NPN+PNP two-transistor latch (see PB-SCR). The four BJTs are:

- **SCR1** (fires for positive V(MT2,MT1)): Q1 (NPN) + Q2 (PNP)
- **SCR2** (fires for negative V(MT2,MT1)): Q3 (NPN) + Q4 (PNP)

Two separate internal latch nodes are created:

| Node | Variable | Assignment |
|---|---|---|
| MT1 | external | `pinNodes.get("MT1")!` |
| MT2 | external | `pinNodes.get("MT2")!` |
| Gate | external | `pinNodes.get("G")!` |
| Vint1 | SCR1 latch node | `ctx.makeVolt(parentLabel, "latch1")` |
| Vint2 | SCR2 latch node | `ctx.makeVolt(parentLabel, "latch2")` |

### SCR1 — fires for positive MT2→MT1 current

Identical structure to PB-SCR with `A=MT2, K=MT1, G=G`:

**Q1 (NPN):** `B=G, C=Vint1, E=MT1`

**Q2 (PNP):** `B=Vint1, C=G, E=MT2`

### SCR2 — fires for negative MT2→MT1 current (antiparallel)

Identical structure to PB-SCR with `A=MT1, K=MT2, G=G` (roles of MT1 and
MT2 swapped):

**Q3 (NPN):** `B=G, C=Vint2, E=MT2`

**Q4 (PNP):** `B=Vint2, C=G, E=MT1`

### Sub-element construction parameters

**Q1 — NPN (SCR1 NPN)**

| Field | Value |
|---|---|
| Class | BJT analog element, NPN (`polarity = +1`) |
| Label | `${parentLabel}#Q1` |
| `pinNodes` | `{ B: G, C: Vint1, E: MT1 }` |
| `ngspiceNodeMap` | `{ B: "base", C: "col", E: "emit" }` |

**Q2 — PNP (SCR1 PNP)**

| Field | Value |
|---|---|
| Class | BJT analog element, PNP (`polarity = -1`) |
| Label | `${parentLabel}#Q2` |
| `pinNodes` | `{ B: Vint1, C: G, E: MT2 }` |
| `ngspiceNodeMap` | `{ B: "base", C: "col", E: "emit" }` |

**Q3 — NPN (SCR2 NPN)**

| Field | Value |
|---|---|
| Class | BJT analog element, NPN (`polarity = +1`) |
| Label | `${parentLabel}#Q3` |
| `pinNodes` | `{ B: G, C: Vint2, E: MT2 }` |
| `ngspiceNodeMap` | `{ B: "base", C: "col", E: "emit" }` |

**Q4 — PNP (SCR2 PNP)**

| Field | Value |
|---|---|
| Class | BJT analog element, PNP (`polarity = -1`) |
| Label | `${parentLabel}#Q4` |
| `pinNodes` | `{ B: Vint2, C: G, E: MT1 }` |
| `ngspiceNodeMap` | `{ B: "base", C: "col", E: "emit" }` |

### setParam routing rule

`setParam(key, value)` on the parent TRIAC forwards to all four BJT
sub-elements for shared model parameters (`IS`, `RC`, `RB`, `RE`, `AREA`, `TEMP`).
`BF` routes to Q1 and Q3 (NPN forward gain); `BR` routes to Q2 and Q4 (PNP
reverse gain).

| Param | Routed to |
|---|---|
| `BF` | Q1, Q3 (NPN) |
| `BR` | Q2, Q4 (PNP) |
| `IS` | Q1, Q2, Q3, Q4 |
| `RC`, `RB`, `RE` | Q1, Q2, Q3, Q4 |
| `AREA`, `TEMP` | Q1, Q2, Q3, Q4 |

## Internal nodes

**Composite-level:** Two internal latch nodes, created before sub-element
setup() calls:

```ts
this._vint1Node = ctx.makeVolt(this.label, "latch1");  // SCR1 latch
this._vint2Node = ctx.makeVolt(this.label, "latch2");  // SCR2 latch
```

**Sub-element level:** Each of the 4 BJT sub-elements may additionally
create up to 3 prime nodes per PB-BJT spec.

## Branch rows

None.

## State slots

Each BJT sub-element allocates 24 state slots:

```ts
// Q1.setup(ctx): ctx.allocStates(24)
// Q2.setup(ctx): ctx.allocStates(24)
// Q3.setup(ctx): ctx.allocStates(24)
// Q4.setup(ctx): ctx.allocStates(24)
```

Total for TRIAC instance: 96 state slots (4 × 24). Allocated in order Q1, Q2, Q3, Q4.

## TSTALLOC sequence (line-for-line port)

Each BJT sub-element follows the 23-entry BJT TSTALLOC sequence from
`bjtsetup.c:435-464` independently (see PB-BJT for full table). The
composite's `setup()` forwards to Q1, Q2, Q3, Q4 in that order.

**Node resolution summary:**

| BJT var | Q1 (NPN SCR1) | Q2 (PNP SCR1) | Q3 (NPN SCR2) | Q4 (PNP SCR2) |
|---|---|---|---|---|
| `BJTbaseNode` | G | Vint1 | G | Vint2 |
| `BJTcolNode` | Vint1 | G | Vint2 | G |
| `BJTemitNode` | MT1 | MT2 | MT2 | MT1 |
| `BJTsubstNode` | 0 | 0 | 0 | 0 |

Prime nodes (colPrime, basePrime, emitPrime) alias external or are internal
per RC/RB/RE values — same rule as PB-BJT.

## setup() body — alloc only

```ts
// TRIAC composite setup()
setup(ctx: SetupContext): void {
  // Create internal latch nodes before sub-elements
  this._vint1Node = ctx.makeVolt(this.label, "latch1");
  this._vint2Node = ctx.makeVolt(this.label, "latch2");

  // Bind sub-element pin nodes using direct pinNodeIds array assignment.
  // Sub-element pin rebinding uses direct pinNodeIds array assignment
  // (consistent with PB-OPTO, PB-DAC, PB-OPAMP, PB-TIMER555). No setPinNode API is added
  // to AnalogElementCore.
  // BJT pin order [B, C, E] per buildBJTPinDeclarations().

  // Q1 NPN SCR1: B=G, C=Vint1, E=MT1
  this._q1.pinNodeIds = [this._gNode, this._vint1Node, this._mt1Node];

  // Q2 PNP SCR1: B=Vint1, C=G, E=MT2
  this._q2.pinNodeIds = [this._vint1Node, this._gNode, this._mt2Node];

  // Q3 NPN SCR2: B=G, C=Vint2, E=MT2
  this._q3.pinNodeIds = [this._gNode, this._vint2Node, this._mt2Node];

  // Q4 PNP SCR2: B=Vint2, C=G, E=MT1
  this._q4.pinNodeIds = [this._vint2Node, this._gNode, this._mt1Node];

  // Forward to each BJT sub-element in order
  this._q1.setup(ctx);   // 23× TSTALLOC
  this._q2.setup(ctx);   // 23× TSTALLOC
  this._q3.setup(ctx);   // 23× TSTALLOC
  this._q4.setup(ctx);   // 23× TSTALLOC
}
```

## load() body — value writes only

```ts
// TRIAC composite load()
load(ctx: LoadContext): void {
  this._q1.load(ctx);   // NPN bjtload.c
  this._q2.load(ctx);   // PNP bjtload.c (polarity = -1)
  this._q3.load(ctx);   // NPN bjtload.c
  this._q4.load(ctx);   // PNP bjtload.c (polarity = -1)
}
```

## findBranchFor (if applicable)

Not applicable.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- Add `mayCreateInternalNodes: true`.
- Composite does not carry `ngspiceNodeMap` — sub-elements carry their own.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-TRIAC is GREEN (verifies Vint1, Vint2 alloc then Q1–Q4 TSTALLOC order).
2. `src/components/semiconductors/__tests__/triac.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts.
