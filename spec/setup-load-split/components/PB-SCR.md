# Task PB-SCR

**digiTS file:** `src/components/semiconductors/scr.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/bjt/bjtsetup.c:347-465` (per sub-element)
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/bjt/bjtload.c` (per sub-element)

## Pin mapping (from 01-pin-mapping.md)

SCR is a **composite** — it does not stamp into the matrix directly.
It decomposes into 2× BJT (NPN Q1 + PNP Q2) in a two-transistor latch
configuration.

| digiTS parent label | Parent pin | Role in circuit |
|---|---|---|
| `A` | Anode | Q2 collector; Q1 emitter |
| `K` | Cathode | Q1 collector; Q2 emitter (with R_K if present) |
| `G` | Gate | Q1 base input |

## Two-transistor latch — node assignment table

The two-BJT latch is the classic Ebers-Moll SCR model. Internal node
`Vint` (the interlocking base node) couples Q1's collector to Q2's base
and Q2's collector to Q1's base.

| Node | Variable | Assignment |
|---|---|---|
| Anode | `A` | `pinNodes.get("A")!` |
| Kathode | `K` | `pinNodes.get("K")!` |
| Gate | `G` | `pinNodes.get("G")!` |
| Internal latch node | `Vint` | `ctx.makeVolt(parentLabel, "latch")` — created once by the composite |

### Q1 — NPN transistor

| BJT terminal | digiTS pin | Node |
|---|---|---|
| `B` (base) | — | Gate `G` (external trigger input) |
| `C` (collector) | — | Internal latch node `Vint` |
| `E` (emitter) | — | Cathode `K` |

Q1 conducts when gate is triggered: base current from G turns on Q1,
pulling Vint low.

### Q2 — PNP transistor

| BJT terminal | digiTS pin | Node |
|---|---|---|
| `B` (base) | — | Internal latch node `Vint` |
| `C` (collector) | — | Gate `G` (positive feedback to Q1 base) |
| `E` (emitter) | — | Anode `A` |

Q2 conducts when Vint falls: base–emitter junction of PNP fires,
feeding current back into Q1's base via G — latching the device on.

### Sub-element construction parameters

**Sub-element 1: BJT Q1 (NPN)**

| Field | Value |
|---|---|
| Class | BJT analog element, NPN polarity (`polarity = +1`) |
| Label | `${parentLabel}#Q1` |
| `pinNodes` passed | `{ B: G, C: Vint, E: K }` |
| `ngspiceNodeMap` | `{ B: "base", C: "col", E: "emit" }` |
| Model params | NPN defaults; `BF` set per SCR model; `IS`, `RC`, `RB`, `RE` from SCR model props |

**Sub-element 2: BJT Q2 (PNP)**

| Field | Value |
|---|---|
| Class | BJT analog element, PNP polarity (`polarity = -1`) |
| Label | `${parentLabel}#Q2` |
| `pinNodes` passed | `{ B: Vint, C: G, E: A }` |
| `ngspiceNodeMap` | `{ B: "base", C: "col", E: "emit" }` |
| Model params | PNP defaults; `BR` set per SCR model; same shared params as Q1 |

### setParam routing rule

`setParam(key, value)` on the parent SCR:

| Param | Routed to |
|---|---|
| `BF` | Q1 only (`forward gain`) |
| `BR` | Q2 only (`reverse gain`) |
| `IS` | Both Q1 and Q2 |
| `RC`, `RB`, `RE` | Both Q1 and Q2 |
| `AREA` | Both Q1 and Q2 |
| `TEMP` | Both Q1 and Q2 |

## Internal nodes

**Composite-level:** One internal node `Vint` created by the composite
before forwarding to sub-elements:

```ts
// Created in composite setup() before Q1/Q2 setup() calls
this._vintNode = ctx.makeVolt(this.label, "latch");
```

**Sub-element level:** Each BJT sub-element may create up to 3 additional
internal nodes (colPrime, basePrime, emitPrime) per PB-BJT spec, governed
by `RC`, `RB`, `RE` values.

## Branch rows

None (BJT has no branch row).

## State slots

Each BJT sub-element allocates 24 state slots:

```ts
// Q1.setup(ctx): ctx.allocStates(24) → offset_Q1
// Q2.setup(ctx): ctx.allocStates(24) → offset_Q2
```

Total for SCR instance: 48 state slots (2 × 24). Allocated Q1 first, Q2 second.

## TSTALLOC sequence (line-for-line port)

Each BJT sub-element follows the 23-entry BJT TSTALLOC sequence from
`bjtsetup.c:435-464` independently (see PB-BJT for full table). The
composite's `setup()` forwards to Q1 then Q2 in that order.

**Node resolution for Q1 (NPN: B=G, C=Vint, E=K):**

The BJT TSTALLOC template uses `colNode`, `baseNode`, `emitNode`,
`colPrimeNode`, `basePrimeNode`, `emitPrimeNode`, `substNode`.
For Q1:

| BJT variable | Actual node |
|---|---|
| `BJTcolNode` | `Vint` |
| `BJTbaseNode` | `G` |
| `BJTemitNode` | `K` |
| `BJTcolPrimeNode` | `Vint` or internal (if RC≠0) |
| `BJTbasePrimeNode` | `G` or internal (if RB≠0) |
| `BJTemitPrimeNode` | `K` or internal (if RE≠0) |
| `BJTsubstNode` | 0 (ground) |

**Node resolution for Q2 (PNP: B=Vint, C=G, E=A):**

| BJT variable | Actual node |
|---|---|
| `BJTcolNode` | `G` |
| `BJTbaseNode` | `Vint` |
| `BJTemitNode` | `A` |
| `BJTcolPrimeNode` | `G` or internal (if RC≠0) |
| `BJTbasePrimeNode` | `Vint` or internal (if RB≠0) |
| `BJTemitPrimeNode` | `A` or internal (if RE≠0) |
| `BJTsubstNode` | 0 (ground) |

## setup() body — alloc only

```ts
// SCR composite setup()
setup(ctx: SetupContext): void {
  // Create the shared internal latch node first
  this._vintNode = ctx.makeVolt(this.label, "latch");

  // Bind sub-element pin nodes by mutating each BJT's _pinNodes map.
  // BJT sub-elements are not compiler-augmented, so pinNodeIds is unset on
  // them and bjt.ts::setup() reads node IDs from this._pinNodes.get("B"|"C"|"E").
  // pinNodeIds is irrelevant for sub-elements; this matches the actual working
  // pattern in optocoupler.ts and timer-555.ts.

  // Q1 NPN: B=G, C=Vint, E=K
  (this._q1 as any)._pinNodes.set("B", this._gNode);
  (this._q1 as any)._pinNodes.set("C", this._vintNode);
  (this._q1 as any)._pinNodes.set("E", this._kNode);

  // Q2 PNP: B=Vint, C=G, E=A
  (this._q2 as any)._pinNodes.set("B", this._vintNode);
  (this._q2 as any)._pinNodes.set("C", this._gNode);
  (this._q2 as any)._pinNodes.set("E", this._aNode);

  // Forward to each BJT sub-element (Q1 then Q2)
  this._q1.setup(ctx);   // NPN: 23× TSTALLOC per bjtsetup.c:435-464
  this._q2.setup(ctx);   // PNP: 23× TSTALLOC per bjtsetup.c:435-464
}
```

## load() body — value writes only

```ts
// SCR composite load()
load(ctx: LoadContext): void {
  this._q1.load(ctx);   // NPN BJT load per bjtload.c
  this._q2.load(ctx);   // PNP BJT load per bjtload.c (polarity = -1)
}
```

Each sub-element ports from `bjtload.c` independently, stamping through
its own cached handles.

## findBranchFor (if applicable)

Not applicable.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- Add `mayCreateInternalNodes: true`.
- Composite does not carry `ngspiceNodeMap` — sub-elements carry their own.

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
