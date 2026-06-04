# Reconstruction spec — `analysis#recon/cshunt`

Add ngspice's `.option cshunt=val` feature: a real capacitor of value `val`
from **every non-ground voltage node to ground**, instantiated **after** node
setup so device-internal voltage nodes are included. digiTS carries **no**
cshunt today (verified: zero matches for `cshunt`/`cShunt`/`CShunt` under
`src/`), so a circuit run with `.option cshunt=<val>` differs from ngspice by the
entire set of injected ground capacitors — every voltage node is missing its
shunt-cap charge contribution.

`analysis#recon/cshunt` is a **structural-match** reconstruction (`CLAUDE.md`
"Structural match, not semantic"): the faithful port reproduces ngspice's
mechanism **WHERE and HOW** ngspice does it. The single most important fact about
this feature — the one that makes a wrong port easy to write — is that
**`CKTcshunt` is NOT a load-path quantity.** It is assigned exactly once
(`cktdojob.c:74` — `ckt->CKTcshunt = task->TSKcshunt;`) and then **never read**
in any `load()` / iteration / convergence path. Verified by hand: across the
whole ngspice tree `CKTcshunt` appears only at

- `cktdojob.c:74` — the one assignment;
- `frontend/com_option.c:81` — `printf("cshunt = %g\n", circuit->CKTcshunt);`
  (the `options` listing);
- `frontend/spiceif.c:1480` — `_t(CKTcshunt);` (a field-dump macro);
- `xspice/icm/analog/delay/cfunc.mod:152` — an unrelated local in a code model.

None of those is a stamp. The real work is done entirely by the **parser**:
`frontend/inp.c` `eval_opt` scans the option deck for `cshunt=` and stores the
parsed value in a cp-var `cshunt_value` (`inp.c:457-471`), and
`parser/inppas4.c` `INPpas4` (`inppas4.c:29-77`) reads that cp-var and, for every
voltage node, instantiates **one ordinary `Capacitor` device to ground**. So the
ngspice port is NOT a `CKTgshunt`-style diagonal stamp — it is the creation of
real capacitor leaves. The digiTS port reuses the existing `CapacitorElement`
(`src/components/passives/capacitor.ts`) exactly as INPpas4 reuses the Capacitor
device, NOT a new stamp.

> **Distinguish from `gshunt`.** digiTS's `gshunt` (`SimulationParams.gshunt`,
> `analog-engine-interface.ts:93-94`) is the analogue of ngspice `CKTgshunt`,
> which **is** a load-path quantity: `CKTgshunt` is folded into `CKTdiagGmin` and
> stamped onto the diagonal during NR (digiTS does the same — `gshunt` is MAX'd
> into the per-phase diagonal gmin in `dc-operating-point.ts:734,806,874,925,
> 967,990,1132`). `cshunt` is the opposite: ngspice does **not** add `CKTcshunt`
> to any diagonal. This recon MUST NOT port cshunt as a diagonal-conductance
> stamp by analogy with gshunt — that would be the "structural match, not
> semantic" violation. cshunt is real injected capacitor devices; its effect is
> a reactive (charge/`dQ/dt`) contribution that appears only in transient/AC, via
> the capacitor element's existing Norton stamp, exactly as a netlisted
> `C <node> 0 val` would.

Authoring contract: this spec is **documentation**. No code. No tests. No ledger
edits beyond the decisions/progress wiring named in the task. The implementer
authors the TypeScript edit against this spec; the verifier checks the edit
against the ngspice citations herein.

Per `CLAUDE.md` comment-hygiene: every reconstructed source comment cites the
current `ref/ngspice/src/spicelib/parser/<file>` (or `frontend/inp.c`,
`analysis/cktdojob.c`) line and explains the mechanism in present tense, with no
`v26`/`v41`/era tags and no migration narrative.

This recon does **NOT** touch `src/solver/analog/sparse-solver.ts` (`CLAUDE.md`
"Sparse Solver is Settled"). It adds capacitor leaves to the element set before
the matrix is sized/ordered; the factor/solve/ordering is untouched. It also does
not change any device `load()` — the injected capacitors stamp through the
unchanged `CapacitorElement` load path.

## ngspice mechanism (the rule being matched)

Four ngspice functions, read by hand, define the rule:

1. **`eval_opt` parses `cshunt=`** (`inp.c:415-473`): the option-deck scanner
   finds `cshunt=` (`inp.c:457-459`), evaluates the value with `INPevaluate`
   (`inp.c:465`), rejects non-positive / unparseable values with a warning
   (`inp.c:466-467` — `if (sr <= 0 || err) … skipped`), and otherwise stores it
   in the cp-var `cshunt_value` (`inp.c:469` — `cp_vset("cshunt_value",
   CP_REAL, &sr)`). **Gate: `cshunt` is active only when `val > 0`.**

2. **`INPpas4` injects the capacitors** (`inppas4.c:29-77`): returns immediately
   if the cp-var is unset (`inppas4.c:41-42` — `if (!cp_getvar("cshunt_value",
   CP_REAL, &csval, 0)) return;`), creates a default `Capacitor` model
   (`inppas4.c:49-52`), then walks the node list:

   ```c
   /* inppas4.c:54-75 — scan through all nodes, add a new C device for each
      voltage node */
   for (node = ckt->CKTnodes; node; node = node->next) {
       if (node->type == NODE_VOLTAGE && (node->number > 0)) {
           int nn = node->number;
           char* devname = tprintf("capac%dshunt", nn);
           (*(ft_sim->newInstance))(ckt, tab->defCmod, &fast, devname);
           (*(ft_sim->bindNode))(ckt, fast, 1, node);   /* top node; 2nd = gnd */
           ptemp.rValue = csval;
           error = INPpName("capacitance", &ptemp, ckt, mytype, fast);
           …
       }
   }
   ```

   The node selection is exactly **`node->type == NODE_VOLTAGE && node->number >
   0`** — every non-ground voltage node (`NODE_VOLTAGE == SP_VOLTAGE == 3`,
   `cktdefs.h:45,47`; `number > 0` excludes ground node 0). Branch/current
   equation rows (`NODE_CURRENT`) are skipped. Each capacitor's top node is the
   voltage node, its second node is ground (`inppas4.c:62-63`).

3. **Phase order** (`spiceif.c:163-183`): `INPpas4` runs **after** `INPpas2`
   (`spiceif.c:168` — node building, which allocates every node including
   device-internal nodes minted by device setup) and **before** `INPpas3`
   (`spiceif.c:181` — `.nodeset`/`.ic` data). So `ckt->CKTnodes` at INPpas4 time
   already contains **device-internal voltage nodes** (e.g. a BJT internal
   collector/base/emitter, a diode internal anode) — those get a shunt cap too.
   This is the load-bearing timing fact for the digiTS port shape.

4. **`CKTcshunt` is set but unused** (`cktdojob.c:74`): the task→circuit copy
   block assigns `ckt->CKTcshunt = task->TSKcshunt;` and nothing downstream reads
   it for arithmetic. It exists only so the `options` listing can print it
   (`com_option.c:81`) and so the value can be carried on the circuit struct.
   **The injection does not depend on `CKTcshunt`** — INPpas4 reads the parser
   cp-var (`cshunt_value`), not `ckt->CKTcshunt`. The blocked hunks below are
   precisely this set-but-unused surface plus the option-table plumbing that
   feeds the value to the parser.

### ngspice → digiTS identifier map

| ngspice | role | digiTS counterpart | source |
|---|---|---|---|
| `eval_opt` `cshunt=` scan + `sr <= 0` gate | parse + positivity gate | `SimulationParams.cshunt` field, gated `cshunt > 0` | `inp.c:457-471` |
| `cp_vset("cshunt_value", …)` cp-var | the parsed value carried to the injector | `params.cshunt` threaded to the engine | `inp.c:469` |
| `INPpas4` node walk | the injection pass | the post-`_setup` injection pass in `MNAEngine._setup` (Part C) | `inppas4.c:54-75` |
| `node->type == NODE_VOLTAGE && number>0` | node selection | `_nodeTable` entries with `type === "voltage"` and `number > 0` (Part C) | `inppas4.c:56` |
| `ckt->CKTnodes` (post-INPpas2, incl. device-internal) | node set including device-internal nodes | the engine `_nodeTable` after the per-element `setup()` loop (`analog-engine.ts:1824-1826`) | `spiceif.c:168,177` |
| `newInstance` of `Capacitor` + `bindNode(1, node)` / 2nd→gnd | one Capacitor-to-ground per node | a `CapacitorElement` (`capacitor.ts:137`) with `capacitance = val`, pins `pos→node`, `neg→0` | `inppas4.c:60-67` |
| `INPpName("capacitance", csval)` | set the cap value | the injected element's `capacitance` model param = `params.cshunt` | `inppas4.c:67` |
| `ckt->CKTcshunt = task->TSKcshunt` (set, unused) | circuit-struct copy of the option | (no load-path read; the value lives on `params.cshunt`) | `cktdojob.c:74` |
| `tsk->TSKcshunt = -1` (app default) | default = disabled | `params.cshunt` default `-1` (off) | `cktntask.c:90` |
| `tsk->TSKcshunt = def->TSKcshunt` (special-task copy) | def-copy of the option | (no TSKtask layer; the field default is the single source) | `cktntask.c:60` |
| `case OPT_CSHUNT: task->TSKcshunt = val->rValue` | the `.options cshunt` setter | the `cshunt` field populated from config/options | `cktsopt.c:175-177` |
| `{ "cshunt", OPT_CSHUNT, IF_SET\|IF_REAL, … }` | option-table row | the `cshunt?: number` SimulationParams declaration (Part A) | `cktsopt.c:244` |

## Current digiTS state

- **No cshunt anywhere.** `SimulationParams` (`analog-engine-interface.ts:62-223`)
  has `gshunt?` (`:93-94`) but no `cshunt?`. `DEFAULT_SIMULATION_PARAMS`
  (`:232-…`) has `gshunt: 0` (`:247`) but no cshunt. No engine/load/parser path
  references it.
- **The node table that the injection pass consumes already exists.** The engine
  mints every node (external and device-internal) through `_makeNode`
  (`analog-engine.ts:1918-1922`), which pushes `{ name, number, type:
  "voltage"|"current" }` onto `_nodeTable`. Device-internal voltage nodes are
  minted by each element's `setup()` via `ctx.makeVolt` (`_buildSetupContext`,
  `analog-engine.ts:1904`). `_setup()` runs the per-element setup loop
  (`analog-engine.ts:1824-1826`), after which `_nodeTable` holds the full node set
  — the exact `ckt->CKTnodes`-after-INPpas2 analogue. `buildNodeTypes`
  (`ckt-context.ts:1061-1067`) already classifies each slot
  `"voltage"|"current"` from this table (the `NODE_VOLTAGE`/`NODE_CURRENT`
  analogue, ported from `cktload.c:175-178`).
- **The capacitor element is the reuse target.** `CapacitorElement`
  (`capacitor.ts:137-146`) is constructed from `(instanceId, position, rotation,
  mirror, props)` with a `capacitance` model param (`capacitor.ts:71`,
  positional VALUE per `inp2c.c:18`). Its `setup()` (`capacitor.ts:343`) allocates
  the Norton stamp and its `load()` stamps the standard capacitor companion
  model. The injected leaves use this element verbatim — no new element, no new
  stamp.
- **`.options` is not a production-netlist parser path.** digiTS has no
  netlist-`.options` reader in the production load path; `gshunt`/`temp`/etc.
  arrive as typed `SimulationParams` fields (programmatic / facade config), and
  the only `.options` *emission* is the harness deck generator
  (`comparison-session.ts:739-757`, which injects `.options TEMP=<celsius>` into
  the generated ngspice deck). So the digiTS cshunt surface is a typed
  `SimulationParams.cshunt` field (Part A), NOT an `.options cshunt` netlist
  parser — mirroring how `gshunt` is surfaced. The harness-side `.options cshunt`
  injection (so ngspice receives it) is the gate-fixture concern (Part E).

With this recon `APPLIED`, the four blocked hunks (final section) — all the
set-but-unused / option-plumbing surface of cshunt — apply onto the rebuilt
baseline as ordinary per-hunk deltas.

## Part A — The `cshunt` field on `SimulationParams`

ngspice's option-table row (`cktsopt.c:244`) and the app-default (`cktntask.c:90`)
define the field and its default. The reconstruction adds it to `SimulationParams`
beside `gshunt` (`analog-engine-interface.ts:93-94`):

```ts
/**
 * Shunt capacitance (F) added from every non-ground voltage node to ground,
 * realized as one real capacitor leaf per node — ngspice `.option cshunt`
 * (cktsopt.c:244, OPTtbl row). Unlike gshunt (a diagonal-conductance stamp,
 * ngspice CKTgshunt), cshunt is NOT a load-path quantity: ngspice's CKTcshunt
 * is set once (cktdojob.c:74) and never read; the real work is INPpas4
 * (inppas4.c:54-75) instantiating a Capacitor-to-ground per voltage node.
 * Active only when > 0 (inp.c:466 — sr <= 0 is skipped). Default -1 = off
 * (cktntask.c:90 — tsk->TSKcshunt = -1).
 */
cshunt?: number;
```

The `DEFAULT_SIMULATION_PARAMS` default is `-1` (off), matching `cktntask.c:90`:

```ts
// cktntask.c:90 — application default tsk->TSKcshunt = -1 (disabled).
cshunt: -1,
```

The gate is `cshunt > 0` (Part C), reproducing ngspice's `inp.c:466` `sr <= 0`
rejection: any value `<= 0` (including the `-1` default) leaves the feature off.

The field is hot-loadable like every other SimulationParams field
(`MEMORY.md` hot-loadable-params): a `configure()` that sets `cshunt` re-runs the
injection on the next `_setup()` (the engine re-runs `_setup` on the next analysis
when params change; the injection pass is part of `_setup`, Part C).

## Part B — Options threading (no new parser; field flows to the engine)

cshunt arrives as a typed `SimulationParams.cshunt` field, exactly as `gshunt`
does — there is no production `.options` netlist parser to extend. The value is
already carried to the engine via the existing `ResolvedSimulationParams` →
`MNAEngine._params` plumbing (the same path `gshunt` rides). No new threading
code is required beyond reading `this._params.cshunt` in the injection pass
(Part C).

The ngspice option-table / setter / def-copy lines (`cktsopt.c:175-177,244`,
`cktntask.c:60,90`, `cktdojob.c:74`) are the C `.options cshunt` → `TSKtask` →
`CKTcircuit` transfer **mechanism**; their digiTS counterpart is the single typed
field of Part A, the same way the present `gshunt`/`indVerbosity`/`epsmin` options
are surfaced as typed fields rather than an `OPTtbl`/`TSKtask` struct walk. Those
four lines are the blocked hunks; this recon supplies the field they target.

## Part C — The INPpas4-faithful post-`_setup` injection pass

This is the core of the reconstruction. It reproduces `INPpas4`
(`inppas4.c:29-77`) at the digiTS phase that corresponds to
"after INPpas2, before INPpas3" — i.e. **inside `MNAEngine._setup()`, after the
per-element `setup()` loop has minted every device-internal node into
`_nodeTable`, and before the matrix-size-dependent state/handle allocation that
consumes the final element/node set.**

### Placement

`_setup()` (`analog-engine.ts:1820-1890`) runs, in order:

1. `_buildSetupContext()` (`:1823`);
2. the per-element `setup()` loop (`:1824-1826`) — this is the
   `INPpas2`-node-building analogue: every element, including composites,
   mints its external and **device-internal voltage nodes** via `ctx.makeVolt`,
   so `_nodeTable` is complete here;
3. state-buffer / row-buffer allocation, nodeset/IC handles, `buildNodeTypes`,
   topology diagnostics, the initial temperature pass (`:1832-1869`).

The cshunt injection pass is inserted **immediately after the per-element
`setup()` loop (after `:1826`) and before the state/matrix allocation
(`:1832`)** — so the injected capacitor leaves are part of the element set the
matrix sizing, state allocation, family-dispatch grouping, and load walk all see,
exactly as ngspice's INPpas4-created capacitors are part of the circuit before
`CKTsetup` sizes the matrix. (ngspice order: INPpas2 → INPpas4 → CKTsetup; the
injected caps exist before the matrix is allocated. The digiTS `_setup`
per-element loop is the setup pass; the cshunt caps are appended to the element
set after it so they participate in every downstream `_setup` step.)

> **Insertion-point precondition.** The injected `CapacitorElement` leaves must
> themselves be `setup()`-driven (they allocate a Norton stamp in `setup()`,
> `capacitor.ts:343`). Therefore the pass (a) constructs the leaves, then (b)
> runs `el.setup(setupCtx)` on each injected leaf with the SAME `setupCtx`, then
> (c) appends them to `this._elements` so the subsequent state/matrix/family
> steps include them. The injected leaf's `pos` pin binds to the voltage node's
> slot and its `neg` pin binds to ground (slot 0) — the `bindNode(1, node)` /
> "2nd node is gnd" analogue (`inppas4.c:62-63`). The implementer wires the
> leaf's two pins to `(nodeSlot, 0)` directly (these leaves are engine-injected,
> not compiler-placed, so they carry an explicit node binding rather than a
> pin-layout resolution). No new node is minted for the cap — it reuses the
> existing voltage node and ground.

### The pass (rebuild of `inppas4.c:41-76`)

```ts
// inppas4.c:29-77 — `.option cshunt`: add a capacitor from every non-ground
// voltage node to ground. ngspice runs this in INPpas4, AFTER INPpas2 builds the
// node table (so device-internal nodes are present, spiceif.c:168,177) and
// before the matrix is sized. Here it runs after the per-element setup() loop
// (which minted every device-internal voltage node into _nodeTable) and before
// the state/matrix allocation, the same phase boundary.
const cshunt = this._params.cshunt ?? -1;
// inp.c:466 — sr <= 0 is skipped; cshunt is active only when > 0. The -1
// default (cktntask.c:90) therefore leaves the circuit untouched.
if (cshunt > 0) {
  for (const node of this._nodeTable) {
    // inppas4.c:56 — node->type == NODE_VOLTAGE && node->number > 0. Skip branch
    // (current) rows and the ground node (number 0).
    if (node.type !== "voltage" || node.number <= 0) continue;
    // inppas4.c:58-67 — one Capacitor device to ground, value = csval, named
    // capac<n>shunt. Reuse the existing CapacitorElement; bind pos→node,
    // neg→ground (inppas4.c:62-63 "the top node, second node is gnd").
    const leaf = this._makeCshuntCapacitor(`capac${node.number}shunt`, cshunt);
    leaf.setup(setupCtx);                 // capacitor.ts:343 — allocate the Norton stamp
    this._bindCshuntLeafNodes(leaf, node.number, /*ground*/ 0);
    this._elements.push(leaf);
  }
}
```

The helper `_makeCshuntCapacitor(name, value)` constructs a `CapacitorElement`
with a `PropertyBag` carrying `capacitance = value` (the `INPpName("capacitance",
csval)` analogue, `inppas4.c:67`); `_bindCshuntLeafNodes(leaf, nodeSlot, 0)`
binds the leaf's `pos`/`neg` pin slots to `(nodeSlot, 0)`. The implementer reuses
whatever node-binding mechanism the engine already uses for an element's resolved
pin slots — the load-bearing requirement is `pos = nodeSlot`, `neg = 0`.

### Node selection — deck-encounter order

ngspice walks `ckt->CKTnodes` in **node-list order** (`inppas4.c:55` — `for (node
= ckt->CKTnodes; node; node = node->next)`), which is first-encounter (node
number) order — the order `INPpas2`/`INPtermInsert` minted the numbers (see
`parser#recon/nodeAllocOrder`). digiTS's `_nodeTable` is appended in mint order by
`_makeNode` (`analog-engine.ts:1920`), so iterating `_nodeTable` in array order
**is** node-number / deck-encounter order. The injected capacitors are therefore
created in the same node order ngspice creates them, so the per-model instance
list and the matrix element-pool order match — required for matrix element-pool
parity (the same first-encounter discipline `nodeAllocOrder` enforces for node
numbering).

> **Match ngspice's node set exactly — do NOT minimize.** Per the task directive
> and `CLAUDE.md` "No Pragmatic Patches": the injection covers **every**
> non-ground voltage node, **including device-internal voltage nodes** (BJT
> internal C/B/E, diode internal anode, MOSFET internal D/S, etc.). It is NOT
> restricted to user-facing external nodes. A device-internal node is in
> `_nodeTable` with `type === "voltage"` after that device's `setup()`, so the
> pass picks it up automatically — exactly as ngspice's `CKTnodes` walk does.
> Current/branch rows (`type === "current"`, the `NODE_CURRENT` analogue) get no
> cap.

## Part D — The capacitor-reuse mechanism (no new stamp)

INPpas4 reuses ngspice's stock `Capacitor` device (`inppas4.c:44` —
`INPtypelook("Capacitor")`; `:60` — `newInstance`). digiTS reuses
`CapacitorElement` (`capacitor.ts:137`) identically. The consequences:

- **No new `load`/`stampAc`/`stampDc` code.** The injected leaves stamp through
  the unchanged `CapacitorElement` load path. The cshunt effect is a reactive
  (`dQ/dt`) contribution — zero at DC steady state (a cap is an open at DC, so a
  pure DC-OP is unchanged except for the standard MODEINITJCT/`vcrit`-free cap
  init), nonzero in transient and AC, exactly as a netlisted `C <node> 0 <val>`
  would be. This matches ngspice: the injected caps are ordinary capacitors, so
  they affect transient/AC and leave DC-OP steady state alone.
- **The injected cap participates in `_setup` like any element.** Because it is
  appended to `this._elements` and `setup()`-driven before the state/matrix
  steps, its Norton-stamp state slots are allocated in the single `StatePool`
  (`MEMORY.md` no-accept / all-state-in-StatePool), its family-dispatch grouping
  is correct, and the topology/temperature passes see it.
- **No `CKTcshunt` field is added to `CKTCircuitContext`.** Because `CKTcshunt`
  is set-but-unused in ngspice (no load-path read), there is nothing for a
  digiTS `cktCshunt` field to feed. The value lives on `params.cshunt` and is
  consumed only by the injection pass. (Adding a dead `cktCshunt` field would be
  a structural-match violation in the opposite direction — modelling the
  set-but-unused C struct member rather than the behavior. The blocked
  `cktdojob.c#h003` set-but-unused assignment maps to "the value is carried on
  `params.cshunt`", not to a new dead field.)

## Part E — The cshunt gate fixture

The acceptance gate (criterion 7) needs a fixture that sets `.option cshunt` on
**both** sides — digiTS via `params.cshunt`, ngspice via an `.options cshunt`
deck card — on a small multi-node circuit, and shows `harness_first_divergence`
null.

**Circuit (`cshunt-gate.dts`).** A small multi-node circuit with at least one
device-internal voltage node so the gate proves the device-internal coverage of
Part C — e.g. a voltage source driving an RC into a diode (the diode mints an
internal anode node) plus a second resistive node, run in **transient** (so the
shunt caps' reactive contribution is observable; a pure DC-OP would show the caps
as opens and under-exercise the feature). The fixture sets a `cshunt` value large
enough to perturb the transient waveform measurably (e.g. `cshunt=1e-9`).

**digiTS side.** The fixture / `ComparisonSession` configures the engine with
`params.cshunt = 1e-9` (the typed field of Part A). The injection pass (Part C)
adds one cap per voltage node, including the diode's internal anode.

**ngspice side — harness deck injection.** ngspice must receive an `.options
cshunt=1e-9` card so its INPpas4 injects the matching caps. The harness deck
generator already injects an `.options` card into the generated ngspice deck:
`comparison-session.ts:749-757` splices `.options TEMP=<celsius>` after the title
line in `_materializeCir`. The fixture path needs the analogous **`.options
cshunt=<val>`** injection: when the session is created with a `cshunt` option,
`_materializeCir` splices `.options cshunt=<val>` after the title (the same
`lines.splice(1, 0, …)` mechanism). **Authoring note for the implementer/fixture
author:** confirm whether `ComparisonSession.create` already threads an arbitrary
`.options` value through `_materializeCir`; if it only injects `TEMP`, extend the
`_materializeCir` option-injection to also emit `cshunt=<val>` when the session's
digiTS params carry `cshunt > 0`, so both engines see the identical option. This
is the one harness-side touch the gate requires; it is a deck-text injection
(adding one `.options` line), NOT a change to any comparison/divergence logic.

Because both engines then inject the **same** set of caps (same value, same
per-voltage-node coverage, same node order), the loaded matrix, the RHS, and the
per-step solution match bit-exact.

## Acceptance criteria

1. `SimulationParams` (`analog-engine-interface.ts:62-223`) declares
   `cshunt?: number` beside `gshunt` (`:93-94`), cited to `cktsopt.c:244`
   (OPTtbl row) + `cktntask.c:90` (default `-1`) + the set-but-unused note
   (`cktdojob.c:74`). `DEFAULT_SIMULATION_PARAMS` declares `cshunt: -1`
   (`cktntask.c:90`). The field is hot-loadable (a `configure()` change re-runs
   the injection on the next `_setup`).
2. The feature is gated `cshunt > 0` (the `inp.c:466` `sr <= 0` rejection); the
   `-1` default and any value `<= 0` leave the circuit byte-identical to
   cshunt-absent. A DC-OP / transient with default params produces NO injected
   caps and is unchanged from today.
3. The injection pass lives in `MNAEngine._setup()`
   (`analog-engine.ts:1820-1890`), inserted **after** the per-element `setup()`
   loop (`:1826`) and **before** the state/matrix/handle allocation (`:1832`),
   reproducing ngspice's INPpas4 phase (after INPpas2 node-building, before the
   matrix is sized — `spiceif.c:168,177`). It reads `this._params.cshunt`.
4. Node selection matches `inppas4.c:56` exactly: every `_nodeTable` entry with
   `type === "voltage"` and `number > 0` gets one capacitor; `type === "current"`
   (branch) rows and the ground node (`number 0`) get none. **Device-internal
   voltage nodes are included** — the pass runs after every element's `setup()`
   has minted them into `_nodeTable`. The walk is in `_nodeTable` array order
   (= node-number / deck-encounter order, `_makeNode` mint order), matching
   `inppas4.c:55`'s `CKTnodes` first-encounter walk for matrix element-pool
   parity.
5. Each injected leaf is a real `CapacitorElement` (`capacitor.ts:137`) with
   `capacitance = params.cshunt` (the `INPpName("capacitance", csval)` analogue,
   `inppas4.c:67`), `pos` bound to the voltage node slot and `neg` bound to
   ground slot 0 (the `bindNode(1, node)` / "2nd node = gnd" analogue,
   `inppas4.c:62-63`), named `capac<n>shunt` (`inppas4.c:58`). Each leaf is
   `setup()`-driven and appended to `this._elements` so it participates in state
   allocation, family dispatch, matrix sizing, and the load walk. **No new
   stamp / load code is added** — the leaves stamp through the unchanged
   `CapacitorElement` load path.
6. No `cktCshunt` field is added to `CKTCircuitContext` — `CKTcshunt` is
   set-but-unused in ngspice (no load-path read, verified: only `cktdojob.c:74`
   assign + `com_option.c:81`/`spiceif.c:1480` print/dump). The value is carried
   on `params.cshunt` and consumed only by the injection pass. The recon does
   NOT stamp cshunt onto any diagonal (it is not a `gshunt`-style conductance).
   `src/solver/analog/sparse-solver.ts` is unmodified.
7. **STRICT bit-exact harness gate.** A `cshunt-gate` fixture (Part E) — a small
   multi-node transient circuit with at least one device-internal voltage node
   (e.g. a diode internal anode) — run with `cshunt=1e-9` on **both** engines
   (digiTS via `params.cshunt`; ngspice via an `.options cshunt=1e-9` deck card
   injected by `_materializeCir`) produces `harness_first_divergence`
   `earliest === null` across all four signal classes
   (voltage / matrix / state / shape) — i.e. `firstDivergence.voltage`, `.matrix`,
   `.state`, `.shape` all null. Verified via the `harness_*` MCP chain
   (`harness_start` → `harness_run` → `harness_first_divergence`, drilling with
   `harness_topology_diff` / `harness_matrix_diff` / `harness_get_attempt` only if
   a class is non-null). A companion run with `cshunt` unset (default `-1`) shows
   the fixture is identical to the no-cshunt baseline on both sides (criterion 2).
   Bit-exact under the matched-arithmetic-order constraint — no tolerance
   qualifier.
8. The injected caps appear on `harness_topology_diff` IDENTICALLY on both sides
   (same per-node coverage, same node order, same value) — `oursOnly` /
   `ngspiceOnly` element lists empty, no slot-index-mismatch entries — confirming
   the node set and the element-pool order match ngspice's INPpas4 instance
   creation. (Per `engine-flow.md`, topology/matrix coordinate parity is a
   harness observable reached via the diff tools.)
9. Comment hygiene: every reconstructed/added comment cites the current
   `ref/ngspice/src/spicelib/parser/inppas4.c` (or `frontend/inp.c`,
   `analysis/cktdojob.c`, `analysis/cktsopt.c`, `analysis/cktntask.c`) line and
   explains the mechanism in present tense — no `v26`/`v41` tags, no migration
   narrative.
10. With `analysis#recon/cshunt` `APPLIED`, the four blocked hunks (next section)
    apply onto the rebuilt baseline as ordinary per-hunk deltas.
    `build-ledger.mjs` re-runs cleanly with the recon `APPLIED` and the four
    hunks unblocked.

## Blocked hunks (apply after the recon)

These four v41 hunks are `blocks: analysis#recon/cshunt` in
`planning/analysis-decisions.json` (and `ledger.json`) and apply as ordinary
per-hunk deltas once the cshunt feature above is `APPLIED`. They are the
set-but-unused / option-plumbing surface of cshunt — currently ESCALATED
(ESC-024) precisely because cshunt was unported; this recon supplies the field +
injection they target, so they revert to PENDING-blocked-by this recon and apply
as ordinary deltas:

| Hunk | ngspice anchor | what it adds onto the baseline |
|---|---|---|
| `analysis/cktdojob.c#h003` | `cktdojob.c:74` | the `ckt->CKTcshunt = task->TSKcshunt` task→circuit copy (the set-but-unused assignment, alongside the present `CKTindverbosity`/`CKTxmu` copies). Maps to "the value is carried on `params.cshunt`"; no dead `cktCshunt` field is added (Part D). |
| `analysis/cktntask.c#h002` | `cktntask.c:60` | the special-task def-copy row `tsk->TSKcshunt = def->TSKcshunt`. digiTS has no TSKtask layer; the `params.cshunt` field default is the single source (Part A). |
| `analysis/cktntask.c#h004` | `cktntask.c:90` | the application-default `tsk->TSKcshunt = -1` (disabled). Maps to `DEFAULT_SIMULATION_PARAMS.cshunt = -1` (Part A). |
| `analysis/cktsopt.c#h003` | `cktsopt.c:175-177,244` | the `case OPT_CSHUNT: task->TSKcshunt = val->rValue` setter case + the `{ "cshunt", OPT_CSHUNT, IF_SET\|IF_REAL, … }` OPTtbl row (alongside the present `OPT_EPSMIN` case). Maps to the typed `SimulationParams.cshunt` field surfacing the option (Part B). |

(The sibling hunks `cktdojob.c#h004/#h005`, `cktntask.c#h001/#h003/#h005/#h006`,
`cktsopt.c#h001/#h002` remain NO-COUNTERPART — they carry the present
indverbosity/xmu/epsmin params or the C struct-copy/dispatch-table plumbing, and
do NOT block on this recon, per their `analysis-decisions.json` rationales.)

Status: PENDING — authored 2026-06-05, awaiting user ratification.
