# Reconstruction spec — `parser#recon/nodeAllocOrder`

Align the compiler's MNA **node-ID allocation order** to ngspice's `INPpas2`
deck-walk / `INPtermInsert` first-encounter order, so the assembled matrix is
**structurally bit-identical** to ngspice — same node integer assigned to the
same electrical net, same composite-internal net landing at the same deck
position. This is a structural-match item, not a numerical one: the node-ID
permutation is what feeds the row/col indices into the (frozen, bit-identical)
sparse solver. If the permutation differs, every downstream Jacobian cell sits
at a permuted `(row, col)`, and `harness_matrix_diff` returns
`value-permutation` / `coord-set-differs` even when each device's `load()`
arithmetic is perfect. The target is `harness_topology_diff` reporting
IDENTICAL slot indices and `harness_matrix_diff` verdict `match`.

Per `CLAUDE.md` "Structural match, not semantic": the goal is to reproduce
ngspice's node-numbering **WHERE and HOW** ngspice does it (parse-time, on the
flattened deck, in `INPtermInsert` first-encounter order), not merely to land
on a node count that happens to factor to the same answer. A permutation that
produces the same solved voltages through a different index assignment is
rejected — the matrix coordinate set must match.

Per `CLAUDE.md` "Sparse Solver is Settled": this spec **MUST NOT** edit
`src/solver/analog/sparse-solver.ts`. Matrix ordering / Markowitz / pivoting is
bit-identical to ngspice `spMatrix` and frozen. This recon restructures only
the index-assignment order *feeding* the solver — the compiler's node-map
builder and composite expansion. `solver.solve()` / `reSolveFactored()` call
sites are untouched. If a faithful port appeared to require a solver change,
this spec would FLAG it as an escalation (it does not — node numbering is
entirely upstream of `spOrderAndFactor`).

Authoring contract: this spec is **documentation**. No code. No tests. The
implementer authors the TypeScript edit against this spec; the verifier checks
the edit against the ngspice citations herein. The single edit surface is
`src/solver/analog/compiler.ts` (the `buildAnalogNodeMapFromPartition` deck-walk
node-numbering loop, `walkCompositeForNodeAllocation`, and the
`expandCompositeInstance` internal-net read), plus the deck-pin-order table
`src/solver/analog/ngspice-load-order.ts` (`TYPE_ID_TO_DECK_PIN_LABEL_ORDER`)
where it is incomplete relative to the parsed devices.

Per `CLAUDE.md` comment-hygiene: every reconstructed source comment cites the
current `ref/ngspice/src/spicelib/parser/<file>` (or `analysis/cktnewn.c`,
`devices/cktcrte.c`) line and explains the mechanism in present tense, with no
`v26`/`v41`/era tags and no migration narrative.

## ngspice node-numbering mechanism (the rule being matched)

Three ngspice functions, read by hand, define the rule:

1. **`INPpas2` deck walk** (`inppas2.c:76-264`): pass 2 iterates the card list
   `for (current = data; current != NULL; current = current->nextcard)`
   top-to-bottom (`inppas2.c:76`), reads the leading character (`inppas2.c:90-93`),
   and dispatches to the per-device `INP2*` parser via the `switch (c)`
   (`inppas2.c:94-263`) — `R`→`INP2R` (`inppas2.c:113-116`), `C`→`INP2C`
   (`:118-121`), `L`→`INP2L` (`:123-126`), `D`→`INP2D` (`:148-151`),
   `J`→`INP2J` (`:153-157`), `M`→`INP2M` (`:165-171`), `V`→`INP2V` (`:184-188`),
   `I`→`INP2I` (`:190-194`), `Q`→`INP2Q` (`:196-200`). The internal ground name
   `"0"` is inserted first via `INPgndInsert` (`inppas2.c:48-60`), reserving the
   ground node before any device line is parsed.

2. **`INPtermInsert` first-encounter** (`inpsymt.c:43-72`): each `INP2*` parser
   reads its node tokens left-to-right and calls `INPtermInsert` per token. The
   function hashes the name (`inpsymt.c:49`), scans the bucket chain
   (`inpsymt.c:50-58`); if the name already exists it returns `E_EXISTS` and
   reuses the existing node (`inpsymt.c:51-57`); otherwise it allocates a new
   `INPnTab` and calls `ft_sim->newNode (ckt, &(t->t_node), *token)`
   (`inpsymt.c:59-63`) — the **only** path that mints a fresh node number.

3. **`CKTnewNode` sequential assignment** (`cktnewn.c:22-43`): `newNode`
   resolves to `CKTnewNode`, which assigns
   `ckt->CKTlastNode->number = ckt->CKTmaxEqNum++` (`cktnewn.c:37`) — a strict
   monotone counter. Node 0 (ground) is seeded on the first call
   (`cktnewn.c:25-31`).

**Net rule:** an MNA node's integer is the ordinal at which its net name is
**first** seen by an `INPtermInsert` call, scanning the deck top-to-bottom and,
within each device line, left-to-right across that device's node tokens. Ground
is always 0. A net name reappearing on a later token/line reuses its already-
minted number (`E_EXISTS`), contributing no new number.

Per-line node-token order is device-specific and set by the `INP2*` parser:

| Device | Parser | Token order (node tokens only) | ngspice citation |
|---|---|---|---|
| R | `INP2R` | `n+ n-` | `inp2r.c:61-66` (name, `INPtermInsert(node1)`, `INPtermInsert(node2)`) |
| C | `INP2C` | `n+ n-` | `inp2c.c:53-57` |
| L | `INP2L` | `n+ n-` | `inp2l.c:53-57` |
| V | `INP2V` | `n+ n-` | `inp2v.c:41-46` |
| I | `INP2I` | `n+ n-` | `inp2i.c` (mirrors `INP2V`) |
| D | `INP2D` | `nA nK` (anode, cathode) then model | `inp2d.c` |
| Q | `INP2Q` | `nC nB nE [nSub]` then model; missing substrate ties to `gnode` | `inp2q.c:57-87` (token loop `INPtermInsert(node[i])`, model breaks loop at `i>=3`; `inp2q.c:85-87` ties missing ports to `gnode`) |
| M | `INP2M` | `nD nG nS nB` then model | `inp2m.c:80-104` (token loop, model breaks at `i>=3` once `INPgetMod` resolves) |
| J | `INP2J` | `nD nG nS` then model | `inp2j.c` |

Note the substrate/body subtlety: `INP2Q` ties an unlisted substrate node to
`gnode` (node 0) (`inp2q.c:85-87`), and digiTS BJT decks tie the body the same
way, so only `C B E` mint numbers. `INP2M` reads four node tokens before the
model; digiTS MOSFET decks tie body to source (`netlist-generator.ts`
`TYPE_ID_TO_DECK_PIN_LABEL_ORDER.NMOS = ["D","G","S"]`), so only `D G S` mint
numbers — the 4th token repeats the source net (`E_EXISTS`).

**Branch (current) equation numbers are NOT minted here.** A VSRC/IND/CCVS
branch row comes from `CKTmkCur` in the device's `setup()` (e.g. `VSRCsetup`),
not from `INPpas2`. Branch-slot ordering is therefore a `setup()`/TSTALLOC
concern (governed by the "Sparse Solver is Settled" upstream-`setup()`
directive), **out of scope** for this recon — this recon governs only the
parse-time node integers. The acceptance gate asserts on node slots; branch
slots are asserted only insofar as they already match (no branch reordering is
specified here).

**Instance load order is independent of node numbering.**
`ref/ngspice/src/spicelib/devices/cktcrte.c:62-64` prepends each new instance at
the model's `GENinstances` head — `GENnextInstance = modPtr->GENinstances;`
(`cktcrte.c:62`) then `modPtr->GENinstances = instPtr;` (`cktcrte.c:64`),
`:63` being the intervening blank line — so
the per-model *load walk* is reverse-of-parse. Node *numbering* (above) is
parse order. These two orders are deliberately decoupled; this recon touches
only the numbering order, never the load walk (which `NGSPICE_LOAD_ORDER`
already governs and which is settled).

## Current digiTS state

digiTS assigns node IDs in `buildAnalogNodeMapFromPartition`
(`compiler.ts:739-1018`), called once from `compileAnalogPartition`
(`compiler.ts:1058-1073`). The mechanism already approximates the ngspice rule;
this recon hardens it to bit-exact and closes the enumerated deviations.

Current allocation walk:

- Ground groups → node 0 (`compiler.ts:840-845`); `nextNodeId` starts at 1
  (`compiler.ts:870`).
- Components are sorted into **deck-emission order** by
  `(getNgspiceLoadOrderByTypeId ASC, originalIndex ASC)`
  (`compiler.ts:856-863`) — forward-within-bucket.
- For each component in that order, pins are visited in
  `TYPE_ID_TO_DECK_PIN_LABEL_ORDER[typeId]` order
  (`compiler.ts:887,895-905`); each pin's group, if not already numbered, gets
  `nextNodeId++` (`visitPin`, `compiler.ts:888-894`). Unknown/composite typeIds
  fall back to `pc.resolvedPins` (pinLayout) order (`compiler.ts:906-914`).
- Immediately after a composite's outer pins, `walkCompositeForNodeAllocation`
  (`compiler.ts:256-356`, invoked at `compiler.ts:933-943`) mints composite-
  internal node IDs in flattened-deck first-encounter order via
  `allocateCompositeInternal` (`compiler.ts:871-879`), interleaving them with
  external IDs at the parent's deck position.
- Floating wire-only groups never touched by a pin are appended at the tail
  (`compiler.ts:947-951`).
- `expandCompositeInstance` (`compiler.ts:372-617`) reads each internal net's
  ID by `${parentLabel}#${suffix}` key from `compositeInternalIds`
  (`compiler.ts:393-400`); declared-but-unreferenced internals fall to a
  per-instance straggler allocator (`compiler.ts:405-411`,
  `allocateCompositeNode` at `compiler.ts:1099-1107`).

Mapping the current digiTS machinery onto the ngspice rule:

| ngspice element | ngspice source | digiTS counterpart | digiTS source |
|---|---|---|---|
| `INPpas2` deck top-to-bottom walk | `inppas2.c:76` | `componentsInDeckOrder` sort + loop | `compiler.ts:856-863,880` |
| per-device node-token order | `inp2r.c:61-66` etc. | `TYPE_ID_TO_DECK_PIN_LABEL_ORDER` | `ngspice-load-order.ts:217-255` |
| `INPtermInsert` first-encounter (E_EXISTS reuse) | `inpsymt.c:49-58` | `if (groupToNodeId.has(gid)) return;` | `compiler.ts:891-893` |
| `CKTnewNode` `number = CKTmaxEqNum++` | `cktnewn.c:37` | `groupToNodeId.set(gid, nextNodeId++)` | `compiler.ts:893` |
| ground reserved before device lines | `inppas2.c:48-60`, `cktnewn.c:25-31` | ground groups pre-mapped to 0 | `compiler.ts:840-845` |
| flattened-deck composite-internal first sight | INPpas2 over expanded subckt | `walkCompositeForNodeAllocation` | `compiler.ts:256-356` |
| composite-internal ID consumed by leaf | (subckt node binding) | `compositeInternalIds.get(key)` | `compiler.ts:393-400` |

### Enumerated deviations from the rule (what this recon fixes)

**D-1 — within-bucket tie-break direction is asserted, not proven, and the
deck emitter uses the opposite direction.** The node-map walk sorts
forward-within-bucket (`originalIndex ASC`, `compiler.ts:862`). The deck
emitter (`netlist-generator.ts:264-280`) stores `compiled.elements`
reverse-within-bucket and re-reverses to emit forward, because ngspice's
`cktcrte.c:62-64` LIFO prepend reverses the instance list back. But node
numbering happens at PARSE (`inppas2.c:76`), strictly top-to-bottom of the
EMITTED deck, with no LIFO involvement. So the only thing that fixes the node
integers is: the order the node-map walk visits components must equal the order
the emitter writes device lines. The recon makes the node-map walk consume the
**identical** deck-line ordering the generator emits — a single shared
"deck order" producer — rather than two independently-maintained sorts that can
drift (`originalIndex ASC` here vs the bucket-reversal there). Today they agree
only by the coincidence that "forward-of-stored-reverse" equals
"forward-of-original" within a bucket; any change to how `compiled.elements` is
stored silently desyncs node numbering from the deck. (See Part A.)

**D-2 — `TYPE_ID_TO_DECK_PIN_LABEL_ORDER` omits several parsed device classes,
so they hit the pinLayout fallback** (`compiler.ts:906-914`), which is NOT
guaranteed to equal the deck node-token order. The live table
(`ngspice-load-order.ts:217-255`) already covers the diodes
(`Diode`/`ZenerDiode`/`VaractorDiode`/`SchottkyDiode`), the three-terminal
actives (`NJFET`/`PJFET`, `NMOS`/`PMOS`, `NpnBJT`/`PnpBJT`), the controlled
sources (`VCCS`/`VCVS`/`CCCS`/`CCVS`), and `TransmissionLine`. The GENUINE gaps
are device classes that already have an `NGSPICE_LOAD_ORDER` / family entry in
this same file but NO deck-pin-order row:

- **`CurrentControlledSwitch`** (CSW / ngspice `W` card) — has
  `NGSPICE_LOAD_ORDER.CSW` (`ngspice-load-order.ts:41`) and family `"CSW"`
  (`ngspice-load-order.ts:138,185`), but no `TYPE_ID_TO_DECK_PIN_LABEL_ORDER`
  row. Its deck card is `Wname out+ out- VSENSE model`, sense by device name,
  so its node-token order is `["out+","out-"]`.
- **`Transformer`** / **`TappedTransformer`** / **`MutualInductor`** — all have
  `NGSPICE_LOAD_ORDER` / family entries (`ngspice-load-order.ts:119-121,166-168`)
  but no deck-pin-order row. The harness emits `Transformer`/`TappedTransformer`
  as their per-winding inductor (`L`) lines, node-token order `["pos","neg"]`
  per winding (`inp2l.c:53-57`), and emits `MutualInductor` as ngspice's `K`
  card `Kname Lname1 Lname2 k` (`netlist-generator.ts:1264-1348`), which
  references the two inductors **by name** and mints NO node tokens — its row is
  the empty token list `[]`.

The recon makes the table TOTAL over every analog `typeId` that the generator
can emit (adding the four rows above to reconcile with the Part B table) and
adds a startup audit (Part B) so a missing entry is a loud error, never a
silent pinLayout fallback.

**D-3 — composite-internal first-encounter walk visits pins in pinLayout
order, not the sub-element's deck node-token order**
(`walkCompositeForNodeAllocation`, `compiler.ts:272-281` uses `connectivity[pi]`
in pinLayout order). For composites whose sub-elements are two-terminal
passives this is correct (pinLayout == deck order). For a composite containing a
MOSFET/JFET/BJT sub-element it is WRONG (the comment at `compiler.ts:250-254`
admits "does not currently affect any shipped composite"). The recon closes the
gap now (not "when one is added") by consulting
`TYPE_ID_TO_DECK_PIN_LABEL_ORDER[sub.typeId]` in the composite walk, matching
the outer-device rule (Part C).

**D-4 — straggler internal nets land past the deck-walk range, but ngspice
mints them at the sub-element's deck position even if no *outer* pin
references them.** A declared internal net referenced only by a single
sub-element pin IS seen by ngspice's flattened-deck `INPtermInsert` at that
sub-element's line. digiTS's `walkCompositeForNodeAllocation` already visits
every sub-element pin (`compiler.ts:272-281`), so a net referenced by *any* pin
is covered; the straggler path (`compiler.ts:405-411`) only catches nets
referenced by ZERO pins — which ngspice also never sees on its deck, so
appending them at the tail is correct. The recon confirms (does not change) this
boundary, and documents that a zero-pin internal net is a degenerate declaration
(Part C, acceptance criterion 6).

## Part A — Single shared deck-order producer (fix D-1)

ngspice numbers nodes by walking the parsed deck top-to-bottom
(`inppas2.c:76`). digiTS has two consumers of "deck order": the node-map walk
(`compiler.ts:856-863`) and the harness deck emitter
(`netlist-generator.ts:264-280`). They MUST produce the identical device-line
sequence or node numbering desyncs from the emitted deck. Today each computes
its own ordering; they agree only incidentally.

The reconstruction extracts a single `deckOrder(components)` function that both
consumers call. **`deckOrder()` is PRODUCTION code.** It lives in
`src/solver/analog/ngspice-load-order.ts` — which is production (it sits at
`src/solver/analog/`, NOT under `__tests__/`, and already exports the
production `NGSPICE_LOAD_ORDER` / `getNgspiceLoadOrderByTypeId` /
`TYPE_ID_TO_DECK_PIN_LABEL_ORDER` machinery the compiler consumes) — alongside
those existing exports. The production node-map walk
(`buildAnalogNodeMapFromPartition` in `compiler.ts`) imports `deckOrder` from
there, and the harness deck emitter
(`netlist-generator.ts`, under `__tests__/harness/`) imports the SAME
`deckOrder` from there. Production MUST NOT depend on the
`__tests__/harness/netlist-generator.ts` module; the dependency direction is
strictly harness → production. (`compiler.ts` is the alternative production home
if `ngspice-load-order.ts` is ever demoted to test-only; today it is production,
so `deckOrder()` and the order table stay in `ngspice-load-order.ts`.)

It returns the partition's components in the exact order their device lines
appear on the emitted deck:

```ts
// inppas2.c:76 — ngspice numbers nodes by walking the parsed deck top-to-bottom.
// The MNA node-map walk and the harness deck emitter must iterate device lines
// in this identical order, or parse-time node integers desync from the deck.
// Within an NGSPICE_LOAD_ORDER bucket, the emitted line order is the order this
// function returns; cktcrte.c:62-64's LIFO instance prepend reverses only the
// load walk, never the parse-time numbering.
export function deckOrder<T extends { typeId: string }>(
  components: readonly T[],
): { item: T; originalIndex: number }[] {
  return components
    .map((item, originalIndex) => ({ item, originalIndex }))
    .sort((a, b) => {
      const lhs = getNgspiceLoadOrderByTypeId(a.item.typeId);
      const rhs = getNgspiceLoadOrderByTypeId(b.item.typeId);
      if (lhs !== rhs) return lhs - rhs;
      return a.originalIndex - b.originalIndex; // forward-within-bucket
    });
}
```

Identifier map:

| ngspice identifier | digiTS identifier | source |
|---|---|---|
| card list traversal `current->nextcard` | `deckOrder(partition.components)` | `inppas2.c:76` |
| `DEVices[]` type index (bucket) | `getNgspiceLoadOrderByTypeId(typeId)` | `dev.c` `DEVices[]` / `ngspice-load-order.ts:34-59` |

`buildAnalogNodeMapFromPartition` replaces its inline sort
(`compiler.ts:856-863`) with `deckOrder(partition.components)`. The deck emitter
(`netlist-generator.ts`) is refactored to derive its `emitOrder` from the same
`deckOrder` over the same component set, eliminating the
store-reverse/emit-reverse dance (`netlist-generator.ts:264-280`) — it now emits
in `deckOrder` directly. Because both walk the identical sequence, the device
line at deck position *k* binds to the same node integers digiTS mints at
position *k*. The within-bucket direction is `forward` (`originalIndex ASC`),
matching the line order the emitter writes; the harness then drives ngspice from
that exact deck, so ngspice's `INPpas2` mints the identical integers.

**Solver untouched:** `deckOrder` produces an ordering only; it does not touch
`solver.*`, branch allocation, or `cktLoad` walk order (the load walk remains
`NGSPICE_LOAD_ORDER`-bucketed per `family-dispatch.ts`).

## Part B — Total deck-pin-order table + startup audit (fix D-2)

The per-device node-token order (`TYPE_ID_TO_DECK_PIN_LABEL_ORDER`,
`ngspice-load-order.ts:217-255`) is the digiTS counterpart to each `INP2*`
parser's `INPtermInsert` token sequence. Where an entry is absent, the node-map
walk falls back to `pc.resolvedPins` (pinLayout) order
(`compiler.ts:906-914`), which is the deck order only by coincidence.

The reconstruction makes the table **total** over every analog `typeId` the
deck emitter can produce, with each row's token order matching the
corresponding `INP2*` parser verbatim:

| typeId | deck token order | parser citation |
|---|---|---|
| `Resistor` | `["pos","neg"]` | `inp2r.c:63-66` |
| `Capacitor`,`PolarizedCap` | `["pos","neg"]` | `inp2c.c:53-57` |
| `Inductor`,`Transformer`,`TappedTransformer` | `["pos","neg"]` (per winding `L` line) | `inp2l.c:53-57` |
| `MutualInductor` | `[]` (emitted as `K Lname1 Lname2 k`; references inductors by name, mints no node tokens) | `inp2k.c` |
| `DcVoltageSource`,`AcVoltageSource` | `["pos","neg"]` | `inp2v.c:41-46` |
| `DcCurrentSource`,`AcCurrentSource` | `["pos","neg"]` | `inp2i.c` (mirrors `inp2v.c`) |
| `Diode`,`ZenerDiode`,`VaractorDiode`,`SchottkyDiode` | `["A","K"]` | `inp2d.c` |
| `NpnBJT`,`PnpBJT` | `["C","B","E"]` (substrate→gnd) | `inp2q.c:57-87` |
| `NMOS`,`PMOS` | `["D","G","S"]` (body→source) | `inp2m.c:80-104` |
| `NJFET`,`PJFET` | `["D","G","S"]` | `inp2j.c` |
| `TransmissionLine` | `["P1b","P1a","P2b","P2a"]` | `inp2t.c` / `tra.c` |
| `VCCS`,`VCVS` | `["out+","out-","ctrl+","ctrl-"]` | `inp2g.c`/`inp2e.c` |
| `CCCS`,`CCVS` | `["out+","out-"]` (sense by device name) | `inp2f.c`/`inp2h.c` |
| `CurrentControlledSwitch` | `["out+","out-"]` (sense by device name) | `inp2w.c` |

The four rows beyond the live table (`ngspice-load-order.ts:217-255`) —
`MutualInductor`, plus the already-present-by-bucket-only
`Transformer`/`TappedTransformer` (folded into the `Inductor` row) and
`CurrentControlledSwitch` — are exactly the D-2 gaps: each has an
`NGSPICE_LOAD_ORDER` / family entry but no deck-pin-order row today. Adding them
makes the table total and the startup audit (below) silent on a clean registry.

A registry-startup audit asserts every analog `typeId` present in the registry's
`pinLayout` (and emittable by the generator) has a
`TYPE_ID_TO_DECK_PIN_LABEL_ORDER` row:

```ts
// inppas2.c:94-263 — every device class ngspice's pass-2 switch dispatches has a
// fixed node-token order in its INP2* parser. The MNA node-map walk reproduces
// that order from this table; a missing row would silently fall back to
// pinLayout order, which is the deck order only by coincidence. Audit at startup
// so a gap is a loud error, not a parity drift discovered three layers down.
export function auditDeckPinOrderCoverage(registry: ComponentRegistry): void {
  for (const typeId of registry.analogTypeIds()) {
    if (!(typeId in TYPE_ID_TO_DECK_PIN_LABEL_ORDER)) {
      throw new Error(
        `TYPE_ID_TO_DECK_PIN_LABEL_ORDER missing "${typeId}"; node numbering ` +
        `would silently use pinLayout order (inppas2.c:94-263).`,
      );
    }
  }
}
```

The node-map walk's `else` fallback branch (`compiler.ts:906-914`) is retained
only for genuine non-ngspice / composite outer typeIds (which legitimately have
no SPICE card — their sub-element lines drive numbering). For any device with a
SPICE card the table entry now always exists, so the fallback never fires for a
numbering-relevant device.

## Part C — Composite-internal token order (fix D-3, confirm D-4)

ngspice flattens a subcircuit before `INPpas2`, so a composite's sub-element
lines appear inline on the deck and their node tokens mint numbers in the same
`INP2*` token order as top-level devices. digiTS reproduces flattening in
`walkCompositeForNodeAllocation` (`compiler.ts:256-356`), but it walks
`connectivity[pi]` in pinLayout order (`compiler.ts:272-281`), which diverges
from deck token order for non-two-terminal sub-elements (D-3).

The reconstruction visits each sub-element's pins in its **deck token order**,
consulting `TYPE_ID_TO_DECK_PIN_LABEL_ORDER[sub.typeId]` exactly as the
outer-device walk does (`compiler.ts:887,895-905`):

```ts
// inppas2.c:76 + the per-device INP2* token order: a composite's sub-element
// lines are flattened inline onto ngspice's deck, so their internal nets mint
// numbers in deck-token order, not pinLayout order. Resolve the sub-element's
// connectivity through its deck-pin-order row, falling back to pinLayout only
// for sub-elements with no SPICE card (nested composites, handled by recursion).
const subDeck = TYPE_ID_TO_DECK_PIN_LABEL_ORDER[sub.typeId];
const visitOrder: number[] = subDeck
  ? subDeck.map((lbl) => subPinLayout.findIndex((p) => p.label === lbl))
            .filter((i) => i >= 0)
  : connectivity.map((_, i) => i); // pinLayout order for card-less sub-elements
for (const pi of visitOrder) {
  const netIdx = connectivity[pi];
  if (netIdx === undefined || netIdx < portCount) continue;
  const slot = netIdx - portCount;
  const suffix = netlist.internalNetLabels?.[slot] ?? `int${slot}`;
  const key = `${parentLabel}#${suffix}`;
  if (!internalIds.has(key)) allocateInternal(parentLabel, suffix);
}
```

This requires `subPinLayout = resolvePinLayout(subDef, subProps)` to be resolved
before the pin loop (the function already resolves it for the nested-composite
recursion at `compiler.ts:317`; hoist it above the internal-net loop). The
nested-composite recursion (`compiler.ts:283-355`) is unchanged — it already
recurses through the same allocator so deeper internals land at their flattened
deck position.

`expandCompositeInstance` (`compiler.ts:393-400`) is unchanged: it reads the IDs
by `${parentLabel}#${suffix}` key, and the keys are identical regardless of the
walk order — only the *values* (the minted integers) change to the correct
deck-position order. The straggler path (`compiler.ts:405-411`, D-4) is
confirmed correct: it fires only for an internal net referenced by zero
sub-element pins, which ngspice's flattened deck also never sees, so tail
allocation is faithful. The implementer adds a comment at the straggler loop
citing this:

```ts
// A declared internal net referenced by no sub-element pin never appears on
// ngspice's flattened deck (no INPtermInsert ever names it, inpsymt.c:43-72),
// so ngspice mints no number for it. Appending past the deck-walk range here
// is the faithful counterpart; such a net is a degenerate declaration.
```

## Part E — Composite Port-net identity for high-impedance-only endpoints (fold-in: FIND-composite-path bug 1)

> **DEFERRED POST-MIGRATION (user, 2026-06-01).** Part E + criteria 10 & 11 (the
> `composite-mosfet-stage` gate) are OFF the active list. Investigation 2026-06-01
> proved the composite gate-net collapse is NOT node-ordering and NOT a general
> high-Z bug — the FLAT `mosfet-inverter` (same gate-bias topology) is 122/122
> bit-exact. The real bug is the flatten `Port`-stitch / analog partition losing an
> analog net's identity across a USER-SUBCIRCUIT port; the `mintPort` approach below
> is MISPLACED (it lives in the in-registry-composite `walkCompositeForNodeAllocation`,
> which never runs for a flattened user subcircuit). `nodeAllocOrder` ships its
> VERIFIED flat node-ordering only (gated on flat device fixtures); Part E is revisited
> as a standalone flatten-Port-stitch fix after the migration. See gate-manifest.md
> "Deferred" list.

**Scope note (user-approved fold-in).** This Part folds in a latent
composite-node-handling bug isolated during fixture authoring, per the
"fold in latent bugs" directive. It is in the SAME `compiler.ts` composite
node-handling that Parts A–C already restructure (the `expandCompositeInstance`
Port-net resolution and the `walkCompositeForNodeAllocation` Port-skip), so it
belongs in this recon's blast radius. DOCUMENTATION ONLY; the implementer
authors the TypeScript against this Part.

### The bug

A subcircuit **Port** net whose ONLY internal endpoint is a no-DC-conductance
pin (e.g. a MOSFET `GATE`, a JFET gate, a capacitor terminal seen only across
an open at DC) collapses to MNA node 0 (ground) instead of retaining its own
node identity. Effect on a composite gate-driven stage: the gate drive is
severed — the gate leaf's `subPinNodes` entry resolves to node 0, so the gate
reads 0 V instead of the driven net's voltage — and because the driving net's
own group then degenerates (its only consumer was the now-grounded gate port),
a spurious `voltage-source-loop` diagnostic is raised
(`topology-diagnostics.ts:81-83`, via `detectVoltageSourceLoops` over the
`buildTopologyInfo` entries whose `nodeIds` now include a collapsed-to-0 port).

A **flat** (non-composite) MOSFET does NOT exhibit this: its gate pin is
numbered directly by the outer-pin deck walk (`visitPin`,
`compiler.ts:888-905`), which mints a fresh `nextNodeId` for the gate's group
regardless of DC conductance. The collapse is specific to the composite
**Port-net resolution path**, where a port's identity is taken from
`outerPinNodes` rather than minted locally.

### Mechanism (present tense), with verified citations

The composite Port-skip and its fallbacks are the collapse site:

1. `walkCompositeForNodeAllocation` mints node IDs **only** for internal nets:
   the pin loop continues past any net with `netIdx < portCount`
   (`compiler.ts:274` — `if (netIdx === undefined || netIdx < portCount) continue;`).
   A Port net is therefore never minted here; its identity is expected to arrive
   entirely from the parent-side group walk.

2. The parent-side group walk numbers a Port net's group only if some pin lands
   in a group present in `positionToGroupId` and that group is not already
   ground (`visitPin`, `compiler.ts:888-893`; `groupToNodeId.set(gid, nextNodeId++)`
   at `compiler.ts:893`). The composite's `outerPortNodes` map is then built from
   exactly those minted groups (`compiler.ts:925-932`): a port label is added
   only when `groupToNodeId.get(gid)` returns a defined id (`compiler.ts:930-931`).

3. When a Port net's external side carries no independently-numbered group — the
   degenerate case where the port's only electrical endpoint is the
   high-impedance internal pin — the port label is absent from `outerPinNodes`,
   and resolution falls through the ground branch:
   - in the allocation walk's inner-port resolution,
     `compiler.ts:330` returns `nodeId = 0` for a `gnd`/`GND` label and
     `compiler.ts:333` `continue`s (drops the binding) otherwise;
   - in `expandCompositeInstance`'s `resolveNetToNode`, the same absent-port
     path returns `0` for `gnd`/`GND` (`compiler.ts:437`) or throws
     (`compiler.ts:438-440`).
   The net effect on the shipped gate fixture is that the gate port resolves to
   node 0: the high-impedance endpoint never forced a fresh mint upstream, and
   the port fell into the ground-resolving branch.

**The rule (matched against ngspice).** ngspice flattens the subcircuit before
`INPpas2`, so the gate net appears as an ordinary node token on the flattened
deck and `INPtermInsert` mints it a real, sequential node number
(`inpsymt.c:59-63` → `CKTnewNode` `number = CKTmaxEqNum++`, `cktnewn.c:37`) the
first time the flattened gate device line names it — its DC conductance is
irrelevant to numbering. The driving device line on the other side of that same
net reuses the identical number (`E_EXISTS`, `inpsymt.c:51-57`). The gate
therefore sees the **driven** net's voltage, and no voltage-source loop arises.

digiTS MUST reproduce this: **a composite Port net retains a distinct MNA node
identity even when its only internal endpoint is a high-impedance /
no-DC-conductance pin; it MUST NOT be merged to ground.** Concretely, the
node-map walk must mint a node for such a port's net at the flattened-deck
first-encounter position (the gate sub-element's line) exactly as ngspice does,
so the port is present in `outerPinNodes` with a real id and neither the
`compiler.ts:330`/`compiler.ts:437` `gnd`→0 branch nor the
`compiler.ts:333`/`compiler.ts:438-440` drop/throw branch is reached for a
legitimately-driven gate. The `gnd`/`GND`→0 convention
(`compiler.ts:437`) is retained ONLY for ports explicitly labelled ground; it is
not a catch-all for an unresolved port.

Mechanism in one line: the high-impedance endpoint must not suppress the
flattened-deck first-encounter mint of its net — the mint is driven by
`INPtermInsert` naming the token (`inpsymt.c:59-63`), not by the pin's DC
stamp — so the composite Port-net resolution path numbers the gate net like any
other flattened node and binds the gate leaf to that number, never to 0.

### Identifier map (this Part)

| ngspice | digiTS | ngspice source | digiTS source |
|---|---|---|---|
| flattened gate node minted by first `INPtermInsert` regardless of DC conductance | composite Port net minted at gate sub-element's deck position; port present in `outerPinNodes` | `inpsymt.c:59-63`, `cktnewn.c:37` | `compiler.ts:274` (skip site to fix), `compiler.ts:925-932` (port map) |
| driver line reuses the gate net's number (`E_EXISTS`) | gate leaf binds to the driven net's node, not 0 | `inpsymt.c:51-57` | `compiler.ts:527` (`resolveNetToNode(netIdx)`), `compiler.ts:429-443` |
| `gnode` reserved only for explicit ground tokens | `gnd`/`GND`→0 retained only for ground-labelled ports | `inppas2.c:48-60` | `compiler.ts:437` |

## Part D — Identifier map (ngspice → digiTS), consolidated

| ngspice | digiTS | ngspice source | digiTS source |
|---|---|---|---|
| `INPpas2` card walk | `deckOrder(partition.components)` loop | `inppas2.c:76` | `compiler.ts:880` (Part A) |
| `INP2*` switch dispatch by leading char | `getNgspiceLoadOrderByTypeId(typeId)` bucket + `TYPE_ID_TO_DECK_PIN_LABEL_ORDER[typeId]` | `inppas2.c:94-263` | `ngspice-load-order.ts:34-59,217-255` |
| `INPtermInsert` per node token L→R | `visitPin(rp)` over deck-pin-order | `inpsymt.c:43-72` | `compiler.ts:888-905` |
| `E_EXISTS` reuse of an already-seen net | `if (groupToNodeId.has(gid)) return;` | `inpsymt.c:51-57` | `compiler.ts:891-893` |
| `ft_sim->newNode` → `CKTnewNode` | `nextNodeId++` mint | `inpsymt.c:63`, `cktnewn.c:37` | `compiler.ts:893` |
| `CKTmaxEqNum` counter (ground=0 seeded) | `nextNodeId` (ground groups pre-set to 0) | `cktnewn.c:25-37` | `compiler.ts:840-845,870` |
| flattened subckt sub-element lines | `walkCompositeForNodeAllocation` | INPpas2 over expanded deck | `compiler.ts:256-356` (Part C) |
| `gnode` substrate tie (BJT) | body→source / substrate→gnd in deck-pin-order | `inp2q.c:85-87` | `ngspice-load-order.ts:235` |
| `cktcrte.c` LIFO instance prepend (load walk only) | `NGSPICE_LOAD_ORDER` load-bucket walk (untouched) | `cktcrte.c:62-64` | `family-dispatch.ts` |

## Acceptance criteria

1. A single `deckOrder(components)` producer exists in **production** code
   (`src/solver/analog/ngspice-load-order.ts`, the production module that
   already exports `NGSPICE_LOAD_ORDER` / `getNgspiceLoadOrderByTypeId` /
   `TYPE_ID_TO_DECK_PIN_LABEL_ORDER`; `compiler.ts` is the only acceptable
   alternative home) and is the sole source of device-line ordering for **both**
   the node-map walk (`buildAnalogNodeMapFromPartition`, replacing
   `compiler.ts:856-863`) and the harness deck emitter
   (`netlist-generator.ts:264-280`). Both consumers IMPORT `deckOrder` from that
   production module; production code does NOT import anything from
   `__tests__/harness/netlist-generator.ts` (dependency direction is strictly
   harness → production, never the reverse). Within an `NGSPICE_LOAD_ORDER`
   bucket the order is forward (`originalIndex ASC`), mirroring `inppas2.c:76`
   top-to-bottom parse of the emitted deck. The two consumers can no longer
   drift.
2. `TYPE_ID_TO_DECK_PIN_LABEL_ORDER` is TOTAL over every analog `typeId` the
   deck generator can emit, each row's token order matching the cited `INP2*`
   parser (Part B table). A startup audit (`auditDeckPinOrderCoverage`) throws on
   any missing row; the pinLayout fallback (`compiler.ts:906-914`) fires only for
   genuinely card-less composite outer typeIds.
3. `walkCompositeForNodeAllocation` visits each sub-element's pins in its deck
   token order via `TYPE_ID_TO_DECK_PIN_LABEL_ORDER[sub.typeId]` (Part C),
   matching the outer-device rule, so a composite containing a MOSFET/JFET/BJT
   sub-element mints its internal nets at the correct flattened-deck position —
   not in pinLayout order.
4. The straggler internal-net path (`compiler.ts:405-411`) is unchanged and
   documented as the faithful counterpart for zero-pin internal nets (which
   ngspice's flattened deck never names, `inpsymt.c:43-72`).
5. `expandCompositeInstance` (`compiler.ts:393-400`) is unchanged in structure;
   it reads internal IDs by the same `${parentLabel}#${suffix}` keys, now
   carrying deck-position-correct integers.
6. **No edit to `src/solver/analog/sparse-solver.ts`.** `solver.solve()` /
   `reSolveFactored()` call sites and the `cktLoad` load-walk order are
   untouched. This recon changes only the node-integer permutation feeding the
   solver.
7. Comment hygiene: every reconstructed/added comment cites the current
   `ref/ngspice/src/spicelib/parser/<file>` (or `analysis/cktnewn.c`,
   `devices/cktcrte.c`) line and explains the mechanism in present tense — no
   `v26`/`v41` tags, no migration narrative.
8. **STRICT bit-exact harness gate.** Across the device fixtures (at minimum:
   a two-terminal RC, a diode, a BJT (`Q … C B E`), a MOSFET (`M … D G S B`,
   body tied to source), a JFET (`J … D G S`), a VCVS/VCCS with control nodes,
   and the NEW composite-gate fixture from criterion 10),
   `harness_topology_diff` reports **IDENTICAL** node/branch slot indices — no
   `value-permutation`, no `coord-set-differs`, empty `oursOnly` /
   `ngspiceOnly` node lists, and no slot-index-mismatch entries — and
   `harness_matrix_diff` returns verdict `match` at the reference iteration.
   Verified via `harness_start` → `harness_run` → `harness_first_divergence`
   (with `firstDivergence.matrix` and `firstDivergence.shape` both null) →
   `harness_topology_diff` → `harness_matrix_diff`. Bit-exact under the
   matched-arithmetic-order constraint — no tolerance qualifier. (Per
   `engine-flow.md` §6, the matrix coordinate set at an NR iteration is a
   harness-only observable; the gate asserts on that harness surface, which is
   the sanctioned route for structural node/matrix parity.)
9. With `parser#recon/nodeAllocOrder` `APPLIED`, the four blocked v41 hunks
   (next section) apply onto the rebuilt baseline as ordinary per-hunk deltas.
   `build-ledger.mjs` re-runs cleanly with the recon `APPLIED` and the four
   hunks unblocked.
10. **NEW composite-gate fixture exercising D-3.** A new fixture is added: a
    composite / subcircuit whose definition contains at least one
    non-two-terminal active sub-element (a MOSFET, JFET, or BJT) wired to a
    declared composite-internal net, so the Part C deck-token-order walk
    (`walkCompositeForNodeAllocation` consulting
    `TYPE_ID_TO_DECK_PIN_LABEL_ORDER[sub.typeId]`) actually fires on a
    `["D","G","S"]` / `["C","B","E"]` sub-element rather than only on two-terminal
    passives where pinLayout order and deck-token order coincide. Without this
    fixture, D-3 ships unproven — the existing composite fixtures (two-terminal
    sub-elements) cannot distinguish the pinLayout-order walk from the
    deck-token-order walk, since the two orders are identical for those. The
    fixture runs the same STRICT bit-exact gate as criterion 8: `harness_start`
    → `harness_run` → `harness_first_divergence` (`firstDivergence.matrix` and
    `firstDivergence.shape` both null) → `harness_topology_diff` IDENTICAL slot
    indices (empty `oursOnly` / `ngspiceOnly`, no slot-index-mismatch entries) →
    `harness_matrix_diff` verdict `match`. This fixture is the gate that proves
    the composite-internal net of the active sub-element lands at its correct
    flattened-deck node integer, not a permuted one.
11. **Composite Port-net identity for high-impedance-only endpoints (Part E,
    fold-in).** On the composite gate fixture (`composite-mosfet-stage.dts` — a
    subcircuit whose internal MOSFET `GATE` is driven through a composite Port
    net whose only internal endpoint is that high-impedance gate pin), the
    digiTS DC-OP gate node reads the **DRIVEN** voltage — the voltage of the net
    bound to the port from outside the composite — **NOT 0 V**, and **NO**
    `voltage-source-loop` diagnostic (`topology-diagnostics.ts:81-83`) is raised.
    The gate port retains a distinct MNA node identity (it is present in
    `outerPinNodes` with a real id, `compiler.ts:925-932`; neither the
    `compiler.ts:330`/`compiler.ts:437` `gnd`→0 branch nor the
    `compiler.ts:333`/`compiler.ts:438-440` drop/throw branch fires for the
    driven gate). Together with the node-ordering work (criteria 8 and 10),
    `harness_topology_diff` on this fixture is **IDENTICAL** (empty `oursOnly` /
    `ngspiceOnly`, no slot-index-mismatch entries) and `harness_matrix_diff`
    returns verdict `match`, once the harness deck generator emits the composite
    (cross-ref the generator prerequisite below — this criterion shares the same
    composite-emission generator gap as criterion 10's bit-exact gate; until the
    generator emits the composite, the headless DC-OP "gate reads driven V, no
    `voltage-source-loop`" assertion stands on its own and the
    `harness_topology_diff` IDENTICAL assertion is gated on that generator work).

## Blocked hunks (apply after the recon)

These v41 hunks are `blockedBy: parser#recon/nodeAllocOrder` in `ledger.json`
and apply as ordinary per-hunk deltas once the baseline above is `APPLIED`:

| Hunk | ngspice anchor | what it adds onto the baseline |
|---|---|---|
| `parser/inppas2.c#h001` | `inppas2.c:94-263` | new/updated device-class dispatch arms in the pass-2 switch (the leading-char → `INP2*` routing the deck-order table must mirror) |
| `parser/inppas2.c#h002` | `inppas2.c:48-60` | internal-ground-name insertion / `INPgndInsert` ordering refinements (ground reserved before device lines) |
| `parser/inppas2.c#h003` | `inppas2.c:76-264` | deck-walk traversal / card-list iteration deltas feeding first-encounter numbering |
| `parser/inpsymt.c#h001` | `inpsymt.c:43-72` | `INPtermInsert` first-encounter / hash / `newNode` path refinements (the E_EXISTS-reuse vs mint boundary) |

Status: RATIFIED 2026-05-30; REVISED + RE-RATIFIED 2026-05-31 — folded in the compiler.ts composite gate-net-collapse fix (FIND-composite-path; Part E + criterion 11) per user; the added Part passed independent citation-review (all compiler.ts/topology-diagnostics/ngspice citations verified, collapse locus confirmed at compiler.ts node-allocation, not compile.ts). FIND-composite-path "bug 2 (generator)" was a misdiagnosis — the generator is healthy; the composite path is this single compiler node-collapse, fixed by this recon.
