# Reconstruction spec — `bjt#recon/quasiSaturation`

Rebuild ngspice's **Kull quasi-saturation (QS) subsystem** for the BJT as new
constructs inside the existing `BjtL1Element` (the SPICE-L1 Gummel-Poon class) in
`src/components/semiconductors/bjt.ts`. The QS subsystem adds a second internal
collector node (`collCX`), nine new state slots, the Kull epitaxial-collector
current/charge model in `load()`, the matched matrix stamps + AC cross-terms, a
third junction in `checkConvergence`, and the QS temperature corrections — all
gated on the model flag `BJTintCollResistGiven` (the `rco` parameter) and
defaulting OFF (classic Gummel-Poon path unchanged when `rco` is unset).

## Scope + classification (RULED — binding, §6e pattern)

The user has RULED: reconstruct BJT to **MATCH ngspice v41** — not "build QS
alone." The governing principle (CORRECTS the earlier draft, which wrongly
declared TLEV/SOA forbidden shapes):

> **NO-COUNTERPART is only for genuine architectural non-counterparts** — C
> struct / dispatch plumbing digiTS has no analog for (the `#define`→`enum`
> param-id table, the sensitivity/noise paths digiTS lacks). **A real
> numerical/behavioral feature digiTS merely lacks is IN scope** — built now, or
> sequenced as a PENDING follow-on recon, **never dropped**. Omitting real ngspice
> behavior violates the IN-class completeness rule.

There are therefore **no "forbidden shapes / drop these lines" exclusions** in
this recon. Every line of `bjttemp.c`/`bjtload.c`/`bjtsetup.c` is either built here
or routed to a sequenced recon.

### IN scope — built in THIS recon (`bjt#recon/quasiSaturation`)

1. **The QS (Kull quasi-saturation) subsystem** — Parts 1–6: the `collCX` node +
   colPrime split, the 9 state slots + renumber, the QS model params, the Kull
   `load()` Irci/Qbci block + collCX stamps, the third-junction
   `checkConvergence`, the QS `getLteTimestep` `qbcx` term, the QS AC re-layout
   (prerequisites for `bjtacld.c#h002`/`#h003`).
2. **The v41 area-scaling / Arrhenius (`pbfact1`) temperature refactor** — Part 7.
   Co-lands here (not a separate recon) because the QS `load()` reads the
   refactored per-instance temp params (`here->BJTtinvRollOffF`, `BJTBEtSatCur`,
   `BJTBCtSatCur`, `BJTtcollectorConduct`, `BJTtbaseResist`, …): with area folded
   into those temp quantities, `load()` no longer multiplies by `AREA`. QS
   **cannot compile** against the old area-in-`load` form, so the refactor is a
   hard prerequisite. **This recon rewrites `computeBjtTempParams`** (see
   "computeBjtTempParams rewrite"); that regression surface — every BJT temp
   result moves from area-in-`load` to area-in-`temp` — is **ACCEPTED**.
3. **The full TLEV / TLEVC temperature subsystem** — Part 7b. **BUILD IT.** This is
   confirmed real numerical behavior at `bjttemp.c:166-305`: the `tlev == 0/1` vs
   `tlev == 3` saturation-current and leakage-current formulas, the `tlevc == 0`
   vs `tlevc == 1` junction-capacitance formulas, the per-parameter
   temperature-coefficient (tempco) arrays (`tbf1`/`tbf2`/`tmje1`/`tikf1`/`tnf1`/…
   in the `(1 + t<x>1·dt + t<x>2·dt²)` multipliers), and the `mje`/`mjc`/`mjs >
   0.999` junction-grading limiting (`bjt.md:3484-3497`). The recon ports the
   **full v41 temperature logic — every `tlev`/`tlevc` branch and every tempco
   multiplier — for bit-exact parity at ANY `tlev`/`tlevc` value**, not only the
   default arm. The ~60 tempco model params (`tbf1`/`tbf2`/`tbr1`/…/`tns1`/`tns2`,
   `tlev`, `tlevc`, `ctc`/`cte`/`cts`, `tvje`/`tvjc`/`tvjs`, etc.) are added to
   `BJT_PARAM_DEFS` with their `bjtsetup.c` defaults (mostly `0.0`; `tlev`/`tlevc`
   default `0`). Their default-0 values make the `(1+0·dt+0·dt²)=1` multiplier
   inert for circuits that don't set them, so this is bit-preserving for existing
   fixtures AND correct for tempco-bearing decks.

### Reclassified — SOA (operating-area diagnostic), sequenced PENDING follow-on

The SOA limits `icMax`/`ibMax`/`pdMax`/`teMax`/`rth0` (plus the existing
`vbeMax`/`vbcMax`/`vceMax`) are **NOT self-heating and NOT a thermal node.**
Verified by reading `ref/ngspice/src/spicelib/devices/bjt/bjtsoachk.c` end to end
(`BJTsoaCheck`, the device's `DEVsoaCheck` hook):

- Every SOA path **only reads** `CKTrhsOld` / `CKTstate0`, compares against the
  limit, and calls `soa_printf(...)` — a warning to the front end. **There is no
  write to the matrix or the RHS** anywhere in `bjtsoachk.c` (lines 44–138).
- `rth0` is **not** a thermal node and writes no thermal equation. It appears only
  at `bjtsoachk.c:119` as a power-derating divisor inside the `pdMax` warning:
  `pd_max = BJTpdMax - (BJTtemp - BJTtnom) / BJTrth0` (`:114-128`), gated on
  `rth0Given && pdMaxGiven && tnomGiven`. It modifies a **warning threshold**, not
  the solution. There is no `CKTmkVolt` for temperature, no self-heating loop.

Therefore SOA does **not** affect numerical parity. Classification:

- **Consumption** (`BJTsoaCheck` / the `DEVsoaCheck` diagnostic) → a **separate
  low-priority follow-on recon `bjt#recon/soaWarnings`** (`state: PENDING`,
  `specExists: false`). This is the digiTS port of `bjtsoachk.c` as a diagnostic
  warning pass — real behavior digiTS lacks, **NOT NO-COUNTERPART, NOT dropped.**
  The existing ledger hunk `bjt/bjtsoachk.c#h001` (currently mis-filed
  NO-COUNTERPART, outside the 90 PENDING) should be reclassified to
  `blockedBy: bjt#recon/soaWarnings` by the orchestrator (out of this routing's
  scope — flagged for follow-up).
- **The SOA model params** (`icMax`/`ibMax`/`pdMax`/`teMax`/`rth0` defs/defaults/
  setters/IFparm entries) are **sub-hunk-interleaved with the QS params** inside
  QS-PORT hunks (`bjt.c#h009`, `bjtmpar.c#h006`, `bjtsetup.c#h008`,
  `bjtdefs.h#h013` — verified: each carries QS `rco`/`vo`/`gamma`/`qco` AND the
  SOA group in the same diff hunk). They are **ported now as inert model params**
  (added to `BJT_PARAM_DEFS`, defaults `1e99` per `bjtsetup.c:382-403`, hot-
  loadable, round-trip through `setParam`) so the param table matches v41 and the
  follow-on `soaWarnings` recon can consume them without a second param-table
  edit. They have no `load()`/`setup()` numerical effect, so porting the
  declarations is parity-neutral. The per-hunk notes below mark which lines are
  "declare-only (consumed by `soaWarnings`)".

### computeBjtTempParams rewrite (accepted regression surface)

`computeBjtTempParams` (`bjt.ts:348`) is **rewritten** by this recon, not merely
extended:
- Area moves IN: every per-instance temp quantity the load reads gains its
  `· BJTarea` / `/ BJTarea` / `· areab` / `· areac` factor per `bjttemp.c`
  (`bjt.md:3452,3458,3464,3470,3472,3474,3480,3519-3565,3590,3599-3603,3619`). The
  matching `· params.AREA` / `/ params.AREA` factors are REMOVED from `load()`
  (Part 4a) and `stampAc()` (Part 5).
- `pbfact1` (the nominal-temperature band-gap factor, `bjt.md:3505-3509`) is
  ADDED and the `tlevc == 0` junction-cap formulas switch from `pbfact` to
  `pbfact1` (`bjt.md:3606-3607,3621`). Add `egfet1`/`arg1`/`pbfact1` locals.
- The full `tlev == 0/1` and `tlev == 3` saturation-current + leakage arms, the
  BE/BC saturation-current split (`BJTBEtSatCur`/`BJTBCtSatCur`), every tempco
  multiplier, and the `mje/mjc/mjs > 0.999` limiting all land (Part 7, Part 7b).
- The `tlevc == 0` and `tlevc == 1` junction-capacitance formulas both land.
- The QS temp block (`tintCollResist`/`tepiSatVoltage`/`tepiDoping`, gated on
  `rcoGiven` with the `quasimod == 1` fork) lands (Part 7).

Because every BJT (QS or classic) now takes area-in-temp and the full TLEV logic,
the parity bar (Part 9 / acceptance #8) covers a classic-GP control (no `rco`,
default `tlev`), a Kull-active device, AND a `tlev`/`tlevc`-bearing device; all
three reach bit-exact parity against the ngspice DLL.

## CRITICAL FRAMING — scope correction (binding)

The QS subsystem is **FULLY CONTAINED** in `bjt.ts` plus the BJT-class artifacts
that live with it (the `BJT_L1_SCHEMA` state schema, the `BJT_PARAM_DEFS` /
`BJT_NPN_DEFAULTS` / `BJT_PNP_DEFAULTS` model-param tables, and the two
`registry.register(...)` calls in `register-all.ts:446-447`). There is **NO
`compiler.ts` change and NO cross-group dependency.**

A prior run escalated the QS node allocation as "owned by `compiler.ts` /
sparse-solver-settled." **That was a misdiagnosis** and is corrected here:

- The new internal node `BJTcollCXNode` is allocated by the **device's own**
  `setup()` via `ctx.makeVolt(label, suffix)` — digiTS's port of ngspice
  `CKTmkVolt` (`setup-context.ts:31-33`; `ref/ngspice/.../cktmkvol.c:20-41`).
  `bjtsetup.c:433` calls `CKTmkVolt(ckt, &tmp, here->BJTname, "collCX")`; the
  digiTS counterpart is the **same** device-local pattern already used for the
  three existing prime nodes (`bjt.ts:1320,1326,1332`, e.g.
  `nodeC_int = ctx.makeVolt(this.label, "collector")`). Adding `collCX` is one
  more `ctx.makeVolt` call beside those three — not a compiler edit.
- The new collCX matrix cells are `solver.allocElement(row, col)` calls beside
  the existing 23 TSTALLOC calls (`bjt.ts:1345-1383`), exactly as the existing
  cells are allocated. No solver change.
- `expandCompositeInstance` / `compiler.ts` node-ID allocation order
  (CLAUDE.md "Sparse Solver is Settled") concerns **subcircuit expansion order**,
  not device-local `makeVolt`. The escalation confused the two. The sparse solver
  and the per-device TSTALLOC element-pool ordering are unaffected by adding
  device-local internal nodes: the new node is appended to the running MNA
  counter at the device's own `setup()` time, identical to how the existing
  `collector`/`base`/`emitter` prime nodes are appended.

If a fresh investigation finds any construct in this spec that genuinely reaches
outside `bjt.ts` + the BJT-class artifacts named above, it must name the exact
file + symbol and why; this spec asserts (with the evidence in Part 1) that there
is none.

## Two internal collector nodes — read this before Part 1

ngspice v41 BJT has **two** internal collector nodes, gated by **different**
flags. The task framing's shorthand ("collCX gated on intCollResist") is
imprecise; the verified gates from `bjtsetup.c:430-456` are:

| node | ngspice gate | when gate false |
|---|---|---|
| `BJTcollCXNode` | `model->BJTcollectorResist != 0` (i.e. `RC != 0`) | `collCXNode = colNode` (`bjtsetup.c:430-431`) |
| `BJTcolPrimeNode` | `model->BJTintCollResistGiven` (i.e. `rco` given) | `colPrimeNode = collCXNode` (`bjtsetup.c:438-439`) |

So:
- With **no `rco`** (classic GP, the default): `colPrimeNode == collCXNode`. The
  intrinsic collector node and the resistive-collector node collapse to a single
  node; the four `intCollResist`-gated coupling cells (`bjtsetup.c:535-540`) are
  NOT allocated; the Kull `load()` block is skipped. This is the present digiTS
  behavior and must be byte-preserved.
- With **`rco` given** (QS active): `colPrimeNode` is a distinct intrinsic node
  separated from `collCX` by the Kull epitaxial element; both nodes exist and the
  coupling cells are allocated.

digiTS today has ONE internal collector node (`nodeC_int`, allocated when
`RC != 0`, `bjt.ts:1317-1322`) which plays the role of ngspice's pre-v41
`colPrime`. The reconstruction must split this into the v41 pair: `nodeCX`
(`collCX`, gated on `RC`) and `nodeC_int` (`colPrime`, gated on
`BJTintCollResistGiven`, collapsing to `nodeCX` when `rco` unset). The existing 23
matrix cells that today reference `nodeC_int` must be re-pointed per the v41
`bjtsetup.c` cell list (Part 1), because v41 renames `BJTcolColPrimePtr` →
`BJTcollCollCXPtr` and `BJTcolPrimeColPtr` → `BJTcollCXCollPtr` (the col↔collCX
terminal resistor cells), and adds the collCX self/coupling cells.

ngspice source (every citation verified by hand against `ref/ngspice` at the
lines cited):

- `ref/ngspice/src/spicelib/devices/bjt/bjtdefs.h` — instance struct collCX node
  + collCX matrix-pointer fields + BEtSatCur/BCtSatCur + QS temp params
  (diff `bjt.md:466-540`), the state `#define` re-layout + `BJTnumStates 33`
  (`bjt.md:561-620`), the model QS params + Given flags (`bjt.md:648-745`), the
  param-id enum additions (`bjt.md:889-1015`).
- `ref/ngspice/src/spicelib/devices/bjt/bjtsetup.c` — model QS defaults
  (`:163-175`, `:358-381`), collCX/colPrime node allocation (`:430-456`), TSTALLOC
  incl. the renamed col↔collCX cells (`:502,505`), `collCXcollCX` self
  (`:533`), and the four `intCollResist`-gated coupling cells (`:535-540`).
- `ref/ngspice/src/spicelib/devices/bjt/bjtload.c` — the area-scaling refactor
  (csat→BEtSatCur/BCtSatCur, etc.), the vbcx/vrci reads, the Kull Irci/Qbci block
  (`bjt.md:2036-2090`), the QS state writes, predictor/bypass copies, the collCX
  Y-stamps + RHS (`bjt.md:2334-2364`).
- `ref/ngspice/src/spicelib/devices/bjt/bjtconv.c` — the third junction
  vbcx/delvbcx (`bjt.md:375-402`).
- `ref/ngspice/src/spicelib/devices/bjt/bjttemp.c` — the BEtSatCur/BCtSatCur
  split (`:166-213`) and the QS temp params (`:215-229`).
- `ref/ngspice/src/spicelib/devices/bjt/bjtacld.c` — the collCX AC restructure +
  the `BJTintCollResistGiven` AC block (`bjt.md:205-286`). **The AC stamp itself
  is owned by `bjt#recon/stampAc`** (already RATIFIED, `bjt-stampac.md`); this
  recon supplies the prerequisite re-layout (collCX node, collCX cells, the
  `Irci_*`/`cqbcx` state slots) that `bjtacld.c#h002`/`#h003` ride on. See Part 5.

digiTS targets (all within the BJT class):

- `src/components/semiconductors/bjt.ts` — `BjtL1Element` (`bjt.ts:1277`):
  `setup()` (`:1300`), `load()` (`:1393`), `stampAc()` (`:2107`),
  `checkConvergence()` (`:2179`); the `BJT_L1_SCHEMA` (`:1098`); the SLOT_*
  consts (`:1248-1271`); `computeBjtTempParams` (`:348`); the `params` reader
  (`:1146-1199`) and `makeTp()` (`:1204`).
- `BJT_PARAM_DEFS` / `BJT_NPN_DEFAULTS` / `BJT_PNP_DEFAULTS` (`bjt.ts:59-86`,
  `:88-...`) — add the QS model params.
- `src/components/register-all.ts:446-447` — no change required (the QS params
  ride the existing `NpnBjtDefinition`/`PnpBjtDefinition` `modelRegistry` "spice"
  entries; only the param-def tables those entries reference change).

Authoring contract: this spec is **documentation**. No code, no tests, no ledger
edit, no commit. Comment hygiene per CLAUDE.md "Code Comments — No Historical
Narrative": every reconstructed comment cites the current
`ref/ngspice/.../<file>` line and explains the mechanism in present tense, with
no `v26`/`v41`/era tags and no migration narrative. SPICE-correctness per CLAUDE.md
"SPICE-Correct Implementations Only": the Kull block matches `bjtload.c`
operand-for-operand (Part 4) and the full temperature pass matches `bjttemp.c`
operand-for-operand (Part 7).

---

## Part 1 — `setup()`: collCX node + matrix-cell re-layout

### 1a — node allocation (rebuild of `bjtsetup.c:430-456`)

ngspice (`bjtsetup.c:430-456`):

```c
if(model->BJTcollectorResist == 0) {
    here->BJTcollCXNode = here->BJTcolNode;
} else if(here->BJTcollCXNode == 0) {
    error = CKTmkVolt(ckt, &tmp, here->BJTname, "collCX");
    here->BJTcollCXNode = tmp->number;
}
if(!model->BJTintCollResistGiven) {
    here->BJTcolPrimeNode = here->BJTcollCXNode;
} else if(here->BJTcolPrimeNode == 0) {
    error = CKTmkVolt(ckt,&tmp,here->BJTname,"collector");
    here->BJTcolPrimeNode = tmp->number;
    /* CKTcopyNodesets block :444-455 */
}
```

digiTS insertion point — `BjtL1Element.setup()` (`bjt.ts:1317-1334`). The present
code allocates one collector internal node `nodeC_int` gated on `RC`. Re-layout:

- Introduce a closure-`let nodeCX` (the `collCX` node) and a `private _hCollCX*`
  handle set. Allocate `nodeCX` gated on `params.RC`:
  ```ts
  // cite: bjtsetup.c:430-436 — collCX is the resistive-collector internal node,
  // allocated only when RC != 0; otherwise it collapses to the external collector.
  if (params.RC === 0) { nodeCX = colNode; }
  else { nodeCX = ctx.makeVolt(this.label, "collCX"); internalLabels.push("collCX"); }
  ```
- Allocate `nodeC_int` (the intrinsic `colPrime`) gated on
  `props.isModelParamGiven("RCO")` (the digiTS counterpart of
  `BJTintCollResistGiven`):
  ```ts
  // cite: bjtsetup.c:438-443 — colPrime is the intrinsic collector node, distinct
  // from collCX only when the Kull epitaxial resistance rco is given; otherwise
  // colPrime collapses onto collCX.
  if (!rcoGiven) { nodeC_int = nodeCX; }
  else { nodeC_int = ctx.makeVolt(this.label, "collector"); internalLabels.push("collector"); }
  ```
  The internal-label string MUST be `"collector"` for the `colPrime` node and
  `"collCX"` for the resistive node, matching the `CKTmkVolt` suffixes
  (`bjtsetup.c:433,441`) so harness node-name matching aligns.
- The `CKTcopyNodesets` block (`bjtsetup.c:444-455`) is NO-COUNTERPART at the
  element (nodesets are a compiler-layer concern; `ctx.copyNodesets` exists on
  `SetupContext` but the existing prime-node allocations at `bjt.ts:1320-1332` do
  not consume it — match that established convention).

**Add a closure flag** `const rcoGiven = props.isModelParamGiven("RCO")` near
`_tempGiven` (`bjt.ts:1202`); the `load()` block (Part 4) and the coupling-cell
allocation gate on it.

### 1b — matrix-cell re-layout + TSTALLOC order (rebuild of `bjtsetup.c:502-540`)

Per CLAUDE.md "Sparse Solver is Settled" and MEMORY.md
`feedback_structural_match_not_semantic`, the `solver.allocElement(row,col)`
sequence is **line-for-line** the `bjtsetup.c` TSTALLOC order (a swapped pair
changes the element-pool order and is structurally visible at the harness CSC
dump). The v41 sequence renames two existing cells and adds collCX cells. Let
`cp = nodeC_int`, `cx = nodeCX`, `bp = nodeB_int`, `ep = nodeE_int`. The full
`bjtsetup.c:502-540` order:

```
(1)  BJTcollCollCXPtr        (colNode, cx)        bjtsetup.c:502   [v41 RENAME of old BJTcolColPrimePtr → now col↔collCX]
(2)  BJTbaseBasePrimePtr     (baseNode, bp)       :503
(3)  BJTemitEmitPrimePtr     (emitNode, ep)       :504
(4)  BJTcollCXCollPtr        (cx, colNode)        :505   [v41 RENAME of old BJTcolPrimeColPtr → now collCX↔col]
(5)  BJTcolPrimeBasePrimePtr (cp, bp)             :506
(6)  BJTcolPrimeEmitPrimePtr (cp, ep)             :507
(7)  BJTbasePrimeBasePtr     (bp, baseNode)       :508
(8)  BJTbasePrimeColPrimePtr (bp, cp)             :509
(9)  BJTbasePrimeEmitPrimePtr(bp, ep)             :510
(10) BJTemitPrimeEmitPtr     (ep, emitNode)       :511
(11) BJTemitPrimeColPrimePtr (ep, cp)             :512
(12) BJTemitPrimeBasePrimePtr(ep, bp)             :513
(13) BJTcolColPtr            (colNode, colNode)   :514
(14) BJTbaseBasePtr          (baseNode, baseNode) :515
(15) BJTemitEmitPtr          (emitNode, emitNode) :516
(16) BJTcolPrimeColPrimePtr  (cp, cp)             :517
(17) BJTbasePrimeBasePrimePtr(bp, bp)             :518
(18) BJTemitPrimeEmitPrimePtr(ep, ep)             :519
(19) BJTsubstSubstPtr        (substNode, substNode) :520
     [substCon alias block :521-527 — substConSubstCon = basePrimeBasePrime (lateral) / colPrimeColPrime (vertical)]
(20) BJTsubstConSubstPtr     (substConNode, substNode) :528
(21) BJTsubstSubstConPtr     (substNode, substConNode) :529
(22) BJTbaseColPrimePtr      (baseNode, cp)       :530
(23) BJTcolPrimeBasePtr      (cp, baseNode)       :531
(24) BJTcollCXcollCXPtr      (cx, cx)             :533   [ALWAYS allocated, even when rco unset]
     if (BJTintCollResistGiven) {                        :535
(25)   BJTcollCXBasePrimePtr  (cx, bp)            :536
(26)   BJTbasePrimeCollCXPtr  (bp, cx)            :537
(27)   BJTcolPrimeCollCXPtr   (cp, cx)            :538
(28)   BJTcollCXColPrimePtr   (cx, cp)            :539
     }
```

Mapping to the existing digiTS handles (`bjt.ts:1284-1292`):
- `_hCCP` (today `BJTcolColPrimePtr`, alloc `(colNode, cp)` at `bjt.ts:1345`)
  becomes `_hCollCollCX` = `allocElement(colNode, cx)` — entry (1). RENAME.
- `_hCPC` (today `BJTcolPrimeColPtr`, alloc `(cp, colNode)` at `bjt.ts:1348`)
  becomes `_hCollCXColl` = `allocElement(cx, colNode)` — entry (4). RENAME.
- All other existing handles keep their meaning but `cp`/`cx` substitution
  follows the table above (the `colPrime`-referencing cells stay on `cp`; the new
  col↔collCX terminal cells move to `cx`).
- NEW handles: `_hCollCXcollCX` = entry (24); and gated on `rcoGiven`:
  `_hCollCXBasePrime` (25), `_hBasePrimeCollCX` (26), `_hColPrimeCollCX` (27),
  `_hCollCXColPrime` (28). Initialise all `-1`; allocate the four coupling
  handles only inside `if (rcoGiven) {...}`.

**Forbidden shapes:** sorting/grouping the allocations; allocating any cell
inside `load()`/`stampAc()`; allocating the four coupling cells when `rco` is
unset (`bjtsetup.c:535` gates them); allocating `collCXcollCX` (entry 24)
**conditionally** — it is unconditional (`bjtsetup.c:533`, outside the
`if`-guard) so the AC stamp's `gcpr` term has a cell even in classic GP;
substituting the present handle order without re-deriving cell-by-cell against
`bjtsetup.c:502-540`.

---

## Part 2 — State schema: 9 new slots + renumber + `BJTnumStates` 24→33

### ngspice baseline (`bjtdefs.h`, diff `bjt.md:561-620`)

v41 inserts `BJTvbcx`/`BJTvrci` at offsets 2/3 (shifting `cc`/`cb`/… down by 2)
and appends seven QS slots after `BJTgdsub`, giving `BJTnumStates 33`:

```c
#define BJTvbe        BJTstate+0
#define BJTvbc        BJTstate+1
#define BJTvbcx       BJTstate+2    /* NEW */
#define BJTvrci       BJTstate+3    /* NEW */
#define BJTcc         BJTstate+4
... (cb,gpi,gmu,gm,go,qbe,cqbe,qbc,cqbc,qsub,cqsub,qbx,cqbx,gx,cexbc,
     geqcb,gcsub,geqbx,vsub,cdsub,gdsub shifted +2, now ending at +25)
#define BJTgdsub      BJTstate+25
#define BJTirci       BJTstate+26   /* NEW */
#define BJTirci_Vrci  BJTstate+27   /* NEW */
#define BJTirci_Vbci  BJTstate+28   /* NEW */
#define BJTirci_Vbcx  BJTstate+29   /* NEW */
#define BJTqbcx       BJTstate+30   /* NEW */
#define BJTcqbcx      BJTstate+31   /* NEW */
#define BJTgbcx       BJTstate+32   /* NEW */
#define BJTnumStates  33
```

### digiTS counterpart — `BJT_L1_SCHEMA` (`bjt.ts:1098-1123`)

Per CLAUDE.md "No accept() — all state in StatePool" and MEMORY.md
`feedback_schema_lookups_over_exports`, declare one slot per `#define`, **same
order** (the order is the state-vector layout the integrator/predictor index by).
The existing schema (`bjt.ts:1098-1123`) has **exactly 24 slots**, `VBE`(0)
through `GDSUB`(23) — and that includes `VSUB`(21)/`CDSUB`(22)/`GDSUB`(23). It
gains `VBCX`/`VRCI` inserted at indices 2/3 (shifting `CC`..`GDSUB` down by 2) and
seven QS slots appended, for `BJTnumStates 33`:

```ts
// cite: bjtdefs.h state #defines (diff bjt.md:561-620), BJTnumStates 33.
export const BJT_L1_SCHEMA: StateSchema = defineStateSchema("BjtSpiceL1Element", [
  { name: "VBE",   doc: "bjtdefs.h BJTvbe=0" },
  { name: "VBC",   doc: "bjtdefs.h BJTvbc=1" },
  { name: "VBCX",  doc: "bjtdefs.h BJTvbcx=2 — base–collCX voltage (Kull QS)" },
  { name: "VRCI",  doc: "bjtdefs.h BJTvrci=3 — intrinsic-collector resistor voltage (Kull QS)" },
  { name: "CC",    doc: "bjtdefs.h BJTcc=4" },
  { name: "CB",    doc: "bjtdefs.h BJTcb=5" },
  { name: "GPI",   doc: "bjtdefs.h BJTgpi=6" },
  { name: "GMU",   doc: "bjtdefs.h BJTgmu=7" },
  { name: "GM",    doc: "bjtdefs.h BJTgm=8" },
  { name: "GO",    doc: "bjtdefs.h BJTgo=9" },
  { name: "QBE",   doc: "bjtdefs.h BJTqbe=10" },
  { name: "CQBE",  doc: "bjtdefs.h BJTcqbe=11" },
  { name: "QBC",   doc: "bjtdefs.h BJTqbc=12" },
  { name: "CQBC",  doc: "bjtdefs.h BJTcqbc=13" },
  { name: "QSUB",  doc: "bjtdefs.h BJTqsub=14" },
  { name: "CQSUB", doc: "bjtdefs.h BJTcqsub=15" },
  { name: "QBX",   doc: "bjtdefs.h BJTqbx=16" },
  { name: "CQBX",  doc: "bjtdefs.h BJTcqbx=17" },
  { name: "GX",    doc: "bjtdefs.h BJTgx=18" },
  { name: "CEXBC", doc: "bjtdefs.h BJTcexbc=19" },
  { name: "GEQCB", doc: "bjtdefs.h BJTgeqcb=20" },
  { name: "GCSUB", doc: "bjtdefs.h BJTgcsub=21" },
  { name: "GEQBX", doc: "bjtdefs.h BJTgeqbx=22" },
  { name: "VSUB",  doc: "bjtdefs.h BJTvsub=23" },
  { name: "CDSUB", doc: "bjtdefs.h BJTcdsub=24" },
  { name: "GDSUB", doc: "bjtdefs.h BJTgdsub=25" },
  { name: "IRCI",      doc: "bjtdefs.h BJTirci=26 — Kull epi current" },
  { name: "IRCI_VRCI", doc: "bjtdefs.h BJTirci_Vrci=27 — dIrci/dVrci" },
  { name: "IRCI_VBCI", doc: "bjtdefs.h BJTirci_Vbci=28 — dIrci/dVbci" },
  { name: "IRCI_VBCX", doc: "bjtdefs.h BJTirci_Vbcx=29 — dIrci/dVbcx" },
  { name: "QBCX",  doc: "bjtdefs.h BJTqbcx=30 — base–collCX charge" },
  { name: "CQBCX", doc: "bjtdefs.h BJTcqbcx=31 — base–collCX cap value" },
  { name: "GBCX",  doc: "bjtdefs.h BJTgbcx=32 — integrated collCX cap conductance" },
]);
```

The existing `const SLOT_VBE = 0 … SLOT_GDSUB = 23` block (`bjt.ts:1248-1271`) is
**file-private** and currently used by `load()`/`stampAc()`/`checkConvergence()`.
Two options, both binding-equivalent: (a) renumber the existing SLOT_* literals to
the new offsets (VBE=0, VBC=1, **shift CC..GDSUB +2**, then add the nine new
consts), keeping the file-private-const convention; or (b) migrate to schema-name
resolution (`BJT_L1_SCHEMA.indexOf("CC")`) per MEMORY.md
`feedback_schema_lookups_over_exports`. **Prefer (a)** to match the existing file
style and avoid touching unrelated lines; whichever is chosen, **every** SLOT_*
literal that today equals an offset ≥2 must move +2, or the existing
non-QS load/conv code silently corrupts.

**Forbidden shapes:** appending VBCX/VRCI at the end instead of inserting at 2/3
(the integrator's predictor copies index by absolute offset — `bjtload.c` reads
`CKTstate1 + BJTvbcx` with `BJTvbcx == BJTstate+2`); forgetting to shift the
existing CC..GDSUB SLOT_* consts +2; appending the sensitivity slots
(`BJTsensxp*`, `bjtdefs.h:622+`) — sensitivity is NO-COUNTERPART.

---

## Part 3 — Model params (rebuild of the `bjt.c`/`bjtmpar.c`/`bjtsetup.c` QS additions)

### ngspice baseline

New model params (param-id enum `bjt.md:889-1015`; setters `bjtmpar.c`
`bjt.md:2564-2638`; mAsk `bjtmask.c`; defaults `bjtsetup.c`). The QS-relevant set
this recon needs (with `bjtsetup.c` defaults):

| ngspice id | netlist name | field | default (`bjtsetup.c`) |
|---|---|---|---|
| `BJT_MOD_RCO` | `rco` | `BJTintCollResist` (+`BJTintCollResistGiven`) | clamped `max(0.01, given)`; `0.01` if ungiven (`:163-166`) |
| `BJT_MOD_VO` | `vo` | `BJTepiSatVoltage` (+Given) | `10.0` (`:167-169`) |
| `BJT_MOD_GAMMA` | `gamma` | `BJTepiDoping` (+Given) | `1.0e-11` (`:170-172`) |
| `BJT_MOD_QCO` | `qco` | `BJTepiCharge` (+Given) | `0.0` (`:173-175`) |
| `BJT_MOD_QUASIMOD` | `quasimod` | `BJTquasimod` (int, +Given) | `0` (`:364-366`) |
| `BJT_MOD_EGQS` | `vg` | `BJTenergyGapQS` (+Given) | `1.206` (`:367-369`) |
| `BJT_MOD_XRCI` | `cn` | `BJTtempExpRCI` (+Given) | NPN `2.42` / PNP `2.2` (`:370-375`) |
| `BJT_MOD_XD` | `d` | `BJTtempExpVO` (+Given) | NPN `0.87` / PNP `0.52` (`:376-381`) |
| `BJT_MOD_IBE` | `ibe`/`c2` alias | `BJTBEsatCur` (+Given) | `0.0` (`:50-52`) |
| `BJT_MOD_IBC` | `ibc`/`c4` alias | `BJTBCsatCur` (+Given) | `0.0` (`:53-55`) |
| `BJT_MOD_TISS1` | `tiss1` | `BJTtiss1` (+Given) | `0.0` (`:358-360`) |
| `BJT_MOD_TISS2` | `tiss2` | `BJTtiss2` (+Given) | `0.0` (`:361-363`) |

The SOA operating-area limit params (`ic_max`/`ib_max`/`pd_max`/`te_max`/`rth0`)
are ported **declare-only** in this recon (added to `BJT_PARAM_DEFS` so the param
table matches v41 and round-trips through `setParam`), but their numerical
**consumption** is deferred to the diagnostic follow-on `bjt#recon/soaWarnings`
(see the Scope section's "Reclassified — SOA" subsection and the SOA-grep finding:
`bjtsoachk.c` reads `CKTrhsOld`/`CKTstate0` and emits `soa_printf` warnings only —
no matrix/RHS write, `rth0` is a `pd_max` derating divisor at `bjtsoachk.c:119`,
not a thermal node). Defaults from `bjtsetup.c:382-403`: `ic_max`/`ib_max`/
`pd_max`/`te_max` default `1e99`; **`rth0` has NO default** (absent from
`bjtsetup.c:382-403`) — it is consumed only when `rth0Given` (and the consumption
lives in `bjtsoachk.c`, not this recon). Declare `RTH0` given-gated with no
synthesized default. These params have no `load()`/`setup()` numerical effect, so
the declarations are parity-neutral.

### digiTS counterpart

Per CLAUDE.md component-model-architecture and "Hot-loadable params": add the QS
params to `BJT_PARAM_DEFS` (`bjt.ts:59`) under `secondary:` (model params), with
the `bjtsetup.c` defaults, and to **both** `BJT_NPN_DEFAULTS` and
`BJT_PNP_DEFAULTS` (the polarity-dependent `XRCI`/`XD` defaults differ — NPN
2.42/0.87, PNP 2.2/0.52, `bjtsetup.c:370-381`). Read them in the `params` reader
(`bjt.ts:1146-1199`) and thread into `makeTp()` (`bjt.ts:1204`). The
`BJTintCollResistGiven` flag is `props.isModelParamGiven("RCO")` (the closure
`rcoGiven`, Part 1a). The `RCO` clamp (`max(0.01, value)` and the `0.01` default
even when ungiven, `bjtsetup.c:163-166`) is applied where the param is consumed —
note ngspice ALWAYS sets `BJTintCollResist=0.01` minimum, but the **Given** flag
(distinct from the value) is what gates the QS block. So `RCO` default = `0.01`,
and `rcoGiven` independently tracks whether the netlist supplied it.

The `ibe`/`ibc` (`BJTBEsatCur`/`BJTBCsatCur`) split with their `c2`/`c4` aliases
is entangled with the area-scaling refactor (Part 4) and the temp split (Part 6);
add `IBE`/`IBC` params (default `0`) + their Given flags. The `c2`/`c4` legacy
model-param **names** become read-only aliases of `ise`/`isc` in v41
(`bjt.md:95,106` — `IOPR("c2", BJT_MOD_ISE,…)`); that aliasing is a parser/IFparm
concern (NO-COUNTERPART at the element — the element reads `ISE`/`ISC`).

**Forbidden shapes:** pre-evaluating polarity-independent defaults for `XRCI`/`XD`
(they are polarity-dependent); treating `RCO` default and `rcoGiven` as the same
thing (the value defaults to `0.01` always; the Given flag gates QS); pulling in
the SOA limits; computing the `RCO` clamp at a different site than where the value
is consumed.

---

## Part 4 — `load()`: the Kull QS block + area-scaling refactor

`load()` is one pass per device per NR iteration (`bjt.ts:1393`). The v41
QS-relevant insertions, in `bjtload.c` order:

### 4a — area-scaling refactor (entangled, must co-land — `bjt.md:1688-1721, 2162-2187`)

v41 moves area-scaling out of `load()` into `bjttemp` (the `*BJTarea` factors are
folded into the temperature-corrected quantities). In `load()`:
- `csat` → split into `here->BJTBEtSatCur` and `here->BJTBCtSatCur` (no `*AREA`);
  the BE current uses `BEtSatCur`, the BC current uses `BCtSatCur`
  (`bjt.md:1937-1982`). Today digiTS has `csat = tp.tSatCur * params.AREA`
  (`bjt.ts:1409`); replace with `tp.tBEtSatCur` / `tp.tBCtSatCur` (area folded in
  `computeBjtTempParams`, Part 6).
- `rbpi = tbaseResist - tminBaseResist` (no `/AREA`, `bjt.md:1711`); today
  `rbpi = tp.tbaseResist/AREA - rbpr` (`bjt.ts:1418`). `gx = tminBaseResist + rbpi/qb`
  (`bjt.md:2140`).
- `gcpr = tcollectorConduct` / `gepr = temitterConduct` (no `*AREA`,
  `bjt.md:2306,2310`); today `* params.AREA` (`bjt.ts:1419-1420`). Area folds into
  `tcollectorConduct`/`temitterConduct` in `computeBjtTempParams`. **This must move
  in lockstep with the `stampAc` change** (`bjt#recon/stampAc` Part D `#h001`) so
  DC and AC stay consistent — they share `tp.tcollectorConduct`.
- `oik = tinvRollOffF` / `oikr = tinvRollOffR` (no `/AREA`); `c2 = tBEleakCur`,
  `c4 = tBCleakCur` (area/areab/areac folded in temp), `xjrb = tbaseCurrentHalfResist`.
- `csubsat` → `tSubSatCur` with the `BJTsubSatCurGiven` gate
  (`bjt.md:2014-2032`).

This refactor is **not optional** for the Kull block: the Kull stamps read
`BJTtype` and the area-folded conductances; landing the Kull block without the
area refactor double-scales. Per MEMORY.md `feedback_no_latent_bugs`, fold both in
one pass.

### 4b — vbcx / vrci voltage reads + predictor / bypass / init copies

Add `vbcx`/`vrci` locals (init `0`). At every voltage-recovery branch that today
reads `vbe`/`vbc`, add the parallel `vbcx`/`vrci` reads (`bjt.md` lines cited):

- **General NR** (`bjt.md:1857-1862`): `vbcx = polarity*(rhsOld[bp] - rhsOld[cx])`,
  `vrci = polarity*(rhsOld[cx] - rhsOld[cp])`. (digiTS: `bp=nodeB_int`, `cx=nodeCX`,
  `cp=nodeC_int`.)
- **MODEINITSMSIG / MODEINITTRAN** (`bjt.md:1728-1729,1766-1767,1778-1779`):
  `vbcx = state1[VBCX]`/`state0[VBCX]`, `vrci = state1[VRCI]`/`state0[VRCI]`.
- **MODEINITPRED** (`bjt.md:1819-1826`): predictor extrapolation of `vbcx`/`vrci`
  with `(1+xfact)*state1 − xfact*state2`, AND the predictor **copies** of the
  cached operating-point slots into `state0`: `state0[IRCI]=state1[IRCI]`,
  `state0[IRCI_VRCI]=state1[IRCI_VRCI]`, `IRCI_VBCI`, `IRCI_VBCX`
  (`bjt.md:1839-1846`).
- **MODEINITJCT / off / UIC** (`bjt.md:1793-1811`): `vbc=vbcx=…; vrci=0.0` in each
  arm.
- **bypass restore** (`#ifndef NOBYPASS`, `bjt.md:1882-1909`): the three extra
  convergence-gate `if(fabs(delvbcx)<…) if(fabs(delvrci)<…)` clauses
  (`bjt.md:1882-1887`) and the bypass-load restores
  `Irci=state0[IRCI]`, `Irci_Vrci`, `Irci_Vbci`, `Irci_Vbcx`,
  `gbcx=state0[GBCX]`, `cbcx=state0[CQBCX]` (`bjt.md:1904-1909`). If digiTS keeps
  the bypass path, port these line-for-line; if it drops bypass (the sibling
  convention), drop the whole block consistently. `delvbcx = vbcx - state0[VBCX]`,
  `delvrci = vrci - state0[VRCI]` (`bjt.md:1868-1869`).
- After pnjlim on `vbc`: `vrci = vbc - vbcx;` (`bjt.md:1927`, "in case vbc was
  limited").

### 4c — the Kull Irci / Qbci block (rebuild of `bjtload.c`, `bjt.md:2033-2090`)

Gated on `rcoGiven`. Port operand-for-operand (the local helper vars
`Kbci`/`Kbci_Vbci`/`Kbcx`/`Kbcx_Vbcx`/`rKp1`/`xvar1`/`Vcorr`/`Iohm`/`quot` are
the Kull epitaxial-region algebra):

```ts
// cite: bjtload.c (diff bjt.md:2033-2090) — Kull's quasi-saturation model:
// the epitaxial-collector current Irci and base–collector charge Qbci/Qbcx.
if (rcoGiven) {
  if (vrci > 0) {
    const Kbci = Math.sqrt(1 + tp.tepiDoping * Math.exp(vbc / vt));
    const Kbci_Vbci = tp.tepiDoping * Math.exp(vbc / vt) / (2 * vt * Kbci);
    const Kbcx = Math.sqrt(1 + tp.tepiDoping * Math.exp(vbcx / vt));
    const Kbcx_Vbcx = tp.tepiDoping * Math.exp(vbcx / vt) / (2 * vt * Kbcx);
    const rKp1 = (1 + Kbci) / (1 + Kbcx);
    const rKp1_Vbci = Kbci_Vbci / (1 + Kbci);
    const rKp1_Vbcx = -(1 + Kbci) * Kbcx_Vbcx / ((Kbcx + 1) * (Kbcx + 1));
    const xvar1 = Math.log(rKp1);
    const xvar1_Vbci = rKp1_Vbci / rKp1;
    const xvar1_Vbcx = rKp1_Vbcx / rKp1;
    const Vcorr = vt * (Kbci - Kbcx - xvar1);
    const Vcorr_Vbci = vt * (Kbci_Vbci - xvar1_Vbci);
    const Vcorr_Vbcx = vt * (-Kbcx_Vbcx - xvar1_Vbcx);
    const Iohm = (vrci + Vcorr) / tp.tintCollResist;
    const Iohm_Vrci = 1 / tp.tintCollResist;
    const Iohm_Vbci = Vcorr_Vbci / tp.tintCollResist;
    const Iohm_Vbcx = Vcorr_Vbcx / tp.tintCollResist;
    const quot = 1 + Math.abs(vrci) / tp.tepiSatVoltage;
    const quot_Vrci = vrci / (tp.tepiSatVoltage * Math.abs(vrci));
    Irci = Iohm / quot + gmin * vrci;
    Irci_Vrci = Iohm_Vrci / quot - Iohm * quot_Vrci / (quot * quot) + gmin;
    Irci_Vbci = Iohm_Vbci / quot;
    Irci_Vbcx = Iohm_Vbcx / quot;
    Qbci = params.QCO * Kbci;          // model->BJTepiCharge (NOT temp-scaled)
    Qbci_Vbci = params.QCO * Kbci_Vbci;
    Qbcx = params.QCO * Kbcx;
    Qbcx_Vbcx = params.QCO * Kbcx_Vbcx;
    s0[base + SLOT_QBCX] = Qbcx;
    capbcx = Qbcx_Vbcx;                // here->BJTcapbcx
  } else {
    Irci = vrci / tp.tintCollResist + gmin * vrci;
    Irci_Vrci = 1 / tp.tintCollResist + gmin;
    Irci_Vbci = 0; Irci_Vbcx = 0;
    Qbci = 0; Qbci_Vbci = 0; Qbcx = 0; Qbcx_Vbcx = 0;
    s0[base + SLOT_QBCX] = 0;
    capbcx = 0;
  }
}
```

Notes (verified): `tepiDoping`/`tintCollResist`/`tepiSatVoltage` are the
**temperature-corrected** QS quantities (Part 6, `bjttemp.c:215-229`); `epiCharge`
(`QCO`) is used **un-temp-scaled** (`bjt.md:2071`, `model->BJTepiCharge`); `gmin`
is `ctx.gmin` (`ckt->CKTgmin`); `vt` is `tp.vt`. `capbcx` here is the local that
later becomes `here->BJTcapbcx`.

### 4d — BC-charge augmentation + state writes (next2 region)

- In the cap/charge block (gated on transient/AC mode, `bjt.md:2217-2221`): when
  `rcoGiven`, `s0[QBC] += Qbci; capbc += Qbci_Vbci; here->BJTcapbc += Qbci_Vbci`.
- Predictor cap-value save (`bjt.md:2229`): `s0[CQBCX] = Qbcx_Vbcx`.
- MODEINITTRAN history dup of `qbcx` (`bjt.md:2247-2248`):
  `s1[QBCX] = s0[QBCX]`.
- Kull charge integration (`bjt.md:2256-2261`): when `rcoGiven`,
  `niIntegrate(...)` on `(Qbcx_Vbcx, SLOT_QBCX)` → `gbcx = geq`,
  `cbcx = s0[CQBCX]`. MODEINITTRAN dup `s1[CQBCX]=s0[CQBCX]` (`bjt.md:2267-2268`).
- **next2 unconditional state writes** (`bjt.md:2276-2288`):
  `s0[VBCX]=vbcx`, `s0[VRCI]=vrci`, and `s0[IRCI]=Irci`,
  `s0[IRCI_VRCI]=Irci_Vrci`, `s0[IRCI_VBCI]=Irci_Vbci`, `s0[IRCI_VBCX]=Irci_Vbcx`.
  The three `Irci_*` writes (`Irci_Vrci`/`Irci_Vbci`/`Irci_Vbcx`, NOT `Irci`
  itself) are also done inside the SenCond branch (`bjtload.c:784-786`,
  `bjt.md:2237-2239`) — SenCond is NO-COUNTERPART (sensitivity).

### 4e — collCX Y-stamps + RHS (rebuild of `bjtload.c`, `bjt.md:2305-2364`)

The Y-matrix load: the renamed terminal cells use `tcollectorConduct`
(area-folded), and the new collCX self-cell + Kull cross-terms:

- `stampElement(_hCC, m*tcollectorConduct)` (`bjt.md:2306`).
- `_hCPCP += m*(gmu+go+geqbx)` (the `+gcpr` term DROPPED, `bjt.md:2311`).
- `_hCollCXcollCX += m*tcollectorConduct` (`bjt.md:2312`).
- `_hEPEP += m*(gpi+temitterConduct+gm+go)` (`bjt.md:2317`).
- `_hCollCollCX += m*(-tcollectorConduct)` (renamed, `bjt.md:2318`).
- `_hCollCXColl += m*(-tcollectorConduct)` (renamed, `bjt.md:2323`).
- `_hEEP += m*(-temitterConduct)`, `_hEPE += m*(-temitterConduct)` (`bjt.md:2322,2330`).

Then the `if (rcoGiven)` Kull stamp block (`bjt.md:2341-2364`) — RHS + Jacobian:
```ts
// cite: bjtload.c (diff bjt.md:2341-2364) — Kull epitaxial element stamp.
const rhs_current = polarity * m * (Irci - Irci_Vrci*vrci - Irci_Vbci*vbc - Irci_Vbcx*vbcx);
stampRHS(rhsOut, nodeCX,     -rhs_current);
solver.stampElement(_hCollCXcollCX,   m *  Irci_Vrci);
solver.stampElement(_hCollCXColPrime, m * -Irci_Vrci);
solver.stampElement(_hCollCXBasePrime,m *  Irci_Vbci);
solver.stampElement(_hCollCXColPrime, m * -Irci_Vbci);
solver.stampElement(_hCollCXBasePrime,m *  Irci_Vbcx);
solver.stampElement(_hCollCXcollCX,   m * -Irci_Vbcx);
stampRHS(rhsOut, nodeC_int,   rhs_current);
solver.stampElement(_hColPrimeCollCX, m * -Irci_Vrci);
solver.stampElement(_hCPCP,           m *  Irci_Vrci);
solver.stampElement(_hCPBP,           m * -Irci_Vbci);
solver.stampElement(_hCPCP,           m *  Irci_Vbci);
solver.stampElement(_hCPBP,           m * -Irci_Vbcx);
solver.stampElement(_hColPrimeCollCX, m *  Irci_Vbcx);
// base–collCX charge (cbcx/gbcx)
stampRHS(rhsOut, nodeB_int, m * -cbcx);
stampRHS(rhsOut, nodeCX,    m *  cbcx);
solver.stampElement(_hBPBP,            m *  gbcx);
solver.stampElement(_hCollCXcollCX,    m *  gbcx);
solver.stampElement(_hBasePrimeCollCX, m * -gbcx);
solver.stampElement(_hCollCXBasePrime, m * -gbcx);
```
The repeated `+=` into `_hCollCXcollCX`/`_hCollCXColPrime`/`_hCPCP`/`_hCPBP`/
`_hCollCXBasePrime` MUST be emitted in this exact order — they accumulate on
shared cells and the floating-point accumulation order is load-bearing
(CLAUDE.md shared-diagonal directive). `rhs_current` carries `BJTtype` (=
`polarity`) and `m`.

**Forbidden shapes:** re-associating any operand in the Kull block
(`Kbci`/`rKp1`/`Vcorr`/`Iohm`/`quot`/`Irci*` chain is FP-order-sensitive — match
`bjt.md:2042-2089` line-for-line); temp-scaling `QCO`/`epiCharge` (it is used raw,
`bjt.md:2071`); collapsing the duplicate `+=` stamps into single combined
expressions (`_hCollCXcollCX += Irci_Vrci` then `+= -Irci_Vbcx` are TWO stamps,
`bjt.md:2344,2349`); using `Math.pow` where ngspice uses `exp`/`sqrt`; emitting
the Kull stamp block when `rco` unset; dropping the `+gcpr→collCX` migration on
the classic-GP cells (the `_hCPCP` term must lose `+gcpr` and `_hCollCXcollCX`
must gain it even when `rco` unset, because `collCX` exists whenever `RC!=0`).

---

## Part 5 — `stampAc()` (BJTacLoad)

**The AC stamp body is owned by `bjt#recon/stampAc`** (RATIFIED,
`bjt-stampac.md`), which defers its `bjtacld.c#h002` (collCX restructure) and
`#h003` (the `BJTintCollResistGiven` AC block) **explicitly to this recon's Kull
re-layout** (see `bjt-stampac.md` Part D and §"Blocked hunks"). This recon
supplies the prerequisites those two hunks ride on:

1. The `collCX` node + the collCX matrix handles (`_hCollCollCX`,
   `_hCollCXColl`, `_hCollCXcollCX`, and the four `rco`-gated coupling handles) —
   Part 1.
2. The `Irci_Vrci`/`Irci_Vbci`/`Irci_Vbcx`/`CQBCX` state slots — Part 2.

With those in place, the `stampAc` changes are:

- **un-area-scaling of gcpr/gepr** (`bjt.md:220-223` / `bjtacld.c#h001`):
  `gcpr = tp.tcollectorConduct`, `gepr = tp.temitterConduct` (drop `*params.AREA`,
  now folded in temp) — moves in lockstep with the `load()` change (Part 4a) and
  the `bjt#recon/stampAc` Part D `#h001`.
- **collCX restructure** (`bjt.md:240-258` / `bjtacld.c#h002`): the real `gcpr`
  stamps move off `_hCPCP`/`_hCCP`/`_hCPC` onto `_hCollCXcollCX`/`_hCollCollCX`/
  `_hCollCXColl`; `_hCPCP` real loses `+gcpr`; add `xcbcx = s0[CQBCX]*omega`.
- **collCX AC block** (`bjt.md:262-283` / `bjtacld.c#h003`): the
  `if (rcoGiven)` block stamping `Irci_Vrci`/`Irci_Vbci`/`Irci_Vbcx` (read from
  `s0`) into the `collCX*`/`colPrime*` cells (real) and `xcbcx` into the
  base-prime/collCX cells (imaginary half via `stampElementImag`), per
  `bjt.md:266-283`.

**This recon does NOT re-author the v26 AC baseline** (Parts A-C of
`bjt-stampac.md`); it makes `bjtacld.c#h002`/`#h003` applicable by landing the
re-layout. The implementer of THIS recon lands the collCX handles + slots; the AC
deltas land as the two named hunks once both recons are APPLIED. (If the
orchestrator sequences this recon after `bjt#recon/stampAc` is APPLIED, the two AC
hunks can be applied as part of this recon's blast radius — fold them in per
MEMORY.md `feedback_no_latent_bugs` rather than leaving the AC path
half-migrated.)

**Forbidden shapes:** allocating cells in `stampAc`; leaving the AC `gcpr` cells
on the classic-GP `_hCPCP`/`_hCCP`/`_hCPC` after the collCX node exists (DC and AC
must agree on which cell carries `gcpr`); using `capbcx` without the `2*` —
verify against `bjtacld.c` (the cap doubling convention) when landing `#h002`.

---

## Part 6 — `checkConvergence()` (BJTconvTest): the third junction

### ngspice baseline (`bjtconv.c`, diff `bjt.md:375-402`)

v41 adds a third junction voltage `vbcx` and its delta to the convergence
recompute:

```c
vbcx = model->BJTtype*(rhsOld[BJTbasePrimeNode] - rhsOld[BJTcollCXNode]);
delvbcx = vbcx - state0[BJTvbcx];
```

`delvbcx` is declared and computed but — verified against `bjtconv.c` — is **not**
used in the `cchat`/`cbhat` tolerance test itself (the `cchat`/`cbhat` formulas
are unchanged, `bjt.md:403-405` shows the same `delvbe`/`delvbc` terms). The
`vbcx`/`delvbcx` additions are the third-junction reads that keep `convTest`'s
voltage set consistent with `load()`'s (and feed the load's bypass-gate three-way
`if` in 4b). The bjtconv hunks are the accessor renames + these two reads.

### digiTS counterpart

`checkConvergence` (`bjt.ts:2179`) today reads `vbeRaw`/`vbcRaw` from
`ctx.rhsOld` via `nodeB_int`/`nodeC_int`/`nodeE_int`. Add:
```ts
// cite: bjtconv.c (diff bjt.md:397-402) — third junction vbcx = base–collCX.
const vbcxRaw = polarity * (voltages[nodeB_int] - voltages[nodeCX]);
const delvbcx = vbcxRaw - s0[base + SLOT_VBCX];
```
`vbcRaw` continues to use `nodeC_int` (= `colPrime`); the new `vbcx` uses `nodeCX`
(= `collCX`). When `rco` unset, `nodeCX == nodeC_int` so `vbcx == vbc` and
`delvbcx` is the same as the existing path — no behavior change in classic GP.
The `cchat`/`cbhat` test (`bjt.ts:2202-2208`) is **unchanged**; `delvbcx` is
computed for parity of the voltage set, not the tolerance arithmetic.

**Forbidden shapes:** folding `delvbcx` into the `cchat`/`cbhat` tolerance test
(ngspice does not — `bjt.md:403-405`); reading `vbcx` from `nodeC_int` instead of
`nodeCX`.

---

## Part 7 — `computeBjtTempParams()` (BJTtemp): full v41 temperature reconstruction

**This recon rewrites `computeBjtTempParams` (`bjt.ts:348`) to the FULL v41
`bjttemp.c` logic** — every `tlev`/`tlevc` branch, every per-parameter
temperature-coefficient (tempco) multiplier, the area folding, `pbfact1`, the
BE/BC saturation-current split, the `mje`/`mjc`/`mjs > 0.999` grading limit, and
the QS temp block. Nothing in the temperature pass is deferred or dropped. The
formulas below are transcribed operand-for-operand from
`ref/ngspice/src/spicelib/devices/bjt/bjttemp.c` (verified by hand); the
implementer produces bit-exact code from them without re-deriving.

### BjtTempParams field additions

Add to the `BjtTempParams` shape returned by `computeBjtTempParams` and consumed
by `load()`/`stampAc()`: `tBEtSatCur`, `tBCtSatCur` (the split satcurs);
`tintCollResist`, `tepiSatVoltage`, `tepiDoping` (QS). The existing fields
(`tSatCur`, `tSubSatCur`, `tinvRollOffF/R`, `tcollectorConduct`,
`temitterConduct`, `tbaseResist`, `tminBaseResist`, `tbaseCurrentHalfResist`,
`temissionCoeffF/R`, `tleakBEemissionCoeff`, `tleakBCemissionCoeff`,
`ttransitTimeHighCurrentF`, `ttransitTimeF/R`, `tjunctionExpBE/BC/Sub`,
`temissionCoeffS`, `tBetaF/R`, `tBEleakCur`, `tBCleakCur`, `tBEcap`, `tBEpot`,
`tBCcap`, `tBCpot`, `tSubcap`, `tSubpot`, `tDepCap`, `tf1`..`tf7`, `tVcrit`,
`tSubVcrit`, `tinvEarlyVoltF/R`) all keep their meaning but their formulas gain
the tempco multipliers and area factors below.

Thread the new model params into the param object from `makeTp()`
(`bjt.ts:1204-1218`) and the L0 path (`bjt.ts:526`):
`IBE`/`IBC`/`RCO`/`VO`/`GAMMA`/`QUASIMOD`/`EGQS`/`XRCI`/`XD` (QS) plus the full
TLEV/TLEVC tempco set (`TLEV`, `TLEVC`, and the `t<x>1`/`t<x>2` pairs
`TBF1/2`,`TBR1/2`,`TIKF1/2`,`TIKR1/2`,`TIRB1/2`,`TNC1/2`,`TNE1/2`,`TNF1/2`,
`TNR1/2`,`TRB1/2`,`TRC1/2`,`TRE1/2`,`TRM1/2`,`TVAF1/2`,`TVAR1/2`,`TITF1/2`,
`TTF1/2`,`TTR1/2`,`TMJE1/2`,`TMJC1/2`,`TMJS1/2`,`TNS1/2`,`TIS1/2`,`TISE1/2`,
`TISC1/2`,`TISS1/2`, plus `CTC`/`CTE`/`CTS`,`TVJE`/`TVJC`/`TVJS`, `XTB`=`betaExp`)
with their `bjtsetup.c` defaults (the `t<x>1`/`t<x>2` default `0.0`; `tlev`/`tlevc`
default `0`). `dt = temp − tnom`; `vt = temp·CONSTKoverQ`;
`vtnom = CONSTKoverQ·tnom`; `fact1 = tnom/REFTEMP`; `fact2 = temp/REFTEMP`
(`bjttemp.c:44-45,81,149-150`).

### 7a — per-quantity tempco multipliers + area folding (`bjttemp.c:83-147`)

Each per-instance quantity is `model param · (1 + t<x>1·dt + t<x>2·dt²)` then
area-folded. Transcribe (cite each to `bjttemp.c` line):

```ts
// bjttemp.c:83-87 — forward Early-voltage inverse (guarded on VAF given & ≠0)
tinvEarlyVoltF = (vafGiven && VAF !== 0) ? 1/(VAF*(1+TVAF1*dt+TVAF2*dt*dt)) : 0;   // :84
// bjttemp.c:88-93 — forward roll-off inverse, area-folded (/AREA)
if (ikfGiven && IKF !== 0) { tinvRollOffF = 1/(IKF*(1+TIKF1*dt+TIKF2*dt*dt)); tinvRollOffF /= AREA; } else tinvRollOffF = 0; // :89-90
tinvEarlyVoltR = (varGiven && VAR !== 0) ? 1/(VAR*(1+TVAR1*dt+TVAR2*dt*dt)) : 0;   // :95
if (ikrGiven && IKR !== 0) { tinvRollOffR = 1/(IKR*(1+TIKR1*dt+TIKR2*dt*dt)); tinvRollOffR /= AREA; } else tinvRollOffR = 0; // :100-101
// bjttemp.c:105-110 — collector conductance, area-folded (·AREA)
if (rcGiven && RC !== 0) { tcollectorConduct = 1/(RC*(1+TRC1*dt+TRC2*dt*dt)); tcollectorConduct *= AREA; } else tcollectorConduct = 0; // :106-107
if (reGiven && RE !== 0) { temitterConduct = 1/(RE*(1+TRE1*dt+TRE2*dt*dt)); temitterConduct *= AREA; } else temitterConduct = 0;       // :112-113
tbaseResist = RB*(1+TRB1*dt+TRB2*dt*dt);            tbaseResist /= AREA;            // :118-119
tminBaseResist = RBM*(1+TRM1*dt+TRM2*dt*dt);        tminBaseResist /= AREA;          // :120-121
tbaseCurrentHalfResist = IRB*(1+TIRB1*dt+TIRB2*dt*dt); tbaseCurrentHalfResist *= AREA; // :122-123
temissionCoeffF = NF*(1+TNF1*dt+TNF2*dt*dt);                                          // :124
temissionCoeffR = NR*(1+TNR1*dt+TNR2*dt*dt);                                          // :125
tleakBEemissionCoeff = NE*(1+TNE1*dt+TNE2*dt*dt);                                     // :126
tleakBCemissionCoeff = NC*(1+TNC1*dt+TNC2*dt*dt);                                     // :127
ttransitTimeHighCurrentF = ITF*(1+TITF1*dt+TITF2*dt*dt); ttransitTimeHighCurrentF *= AREA; // :128-129
ttransitTimeF = TF*(1+TTF1*dt+TTF2*dt*dt);                                            // :130
ttransitTimeR = TR*(1+TTR1*dt+TTR2*dt*dt);                                            // :131
// bjttemp.c:132-146 — junction grading w/ tempco, then the >0.999 limit clamp
tjunctionExpBE = MJE*(1+TMJE1*dt+TMJE2*dt*dt);                                        // :132
if (tjunctionExpBE > 0.999) { tjunctionExpBE = 0.999; /* warn mje limited */ }       // :133-136
tjunctionExpBC = MJC*(1+TMJC1*dt+TMJC2*dt*dt);                                        // :137
if (tjunctionExpBC > 0.999) { tjunctionExpBC = 0.999; /* warn mjc limited */ }       // :138-141
tjunctionExpSub = MJS*(1+TMJS1*dt+TMJS2*dt*dt);                                       // :142
if (tjunctionExpSub > 0.999) { tjunctionExpSub = 0.999; /* warn mjs limited */ }     // :143-146
temissionCoeffS = NS*(1+TNS1*dt+TNS2*dt*dt);                                          // :147
```
The `> 0.999` clamps are BUILT (they prevent a `1/(1−mj)` blow-up at
`bjttemp.c:316-322`); route the warning through `ctx.diagnostics`. (`MJS` here is
`exponentialSubstrate`.)

### 7b — band-gap factors + the satcur/leakage `tlev` arms (`bjttemp.c:149-258`)

```ts
// bjttemp.c:149-160 — temp & nominal band-gap factors
vt = temp*KoverQ; fact2 = temp/REFTEMP;
egfet  = 1.16 - (7.02e-4*temp*temp)/(temp+1108);                                     // :151-152
arg    = -egfet/(2*CONSTboltz*temp) + 1.1150877/(CONSTboltz*(REFTEMP+REFTEMP));       // :153-154
pbfact = -2*vt*(1.5*Math.log(fact2)+CHARGE*arg);                                     // :155
egfet1 = 1.16 - (7.02e-4*tnom*tnom)/(tnom+1108);                                     // :156-157
arg1   = -egfet1/(2*CONSTboltz*tnom) + 1.1150877/(CONSTboltz*(REFTEMP+REFTEMP));      // :158-159
pbfact1 = -2*vtnom*(1.5*Math.log(fact1)+CHARGE*arg1);                                // :160
ratlog  = Math.log(temp/tnom);                                                       // :162
ratio1  = temp/tnom - 1;                                                             // :163
factlog = ratio1*EG/vt + XTI*ratlog;                                                 // :164-165  (EG=energyGap, XTI=tempExpIS)

// bjttemp.c:166-197 — saturation currents, tlev==0/1 vs tlev==3
if (tlev === 0 || tlev === 1) {
  let factor = Math.exp(factlog);                                                    // :167
  tSatCur = AREA * IS * factor;                                                      // :168
  if (ibeGiven && ibcGiven) { factor = Math.exp(factlog/NF); tBEtSatCur = AREA*IBE*factor; } // :170-171
  else tBEtSatCur = tSatCur;                                                         // :173
  if (ibeGiven && ibcGiven) { factor = Math.exp(factlog/NR); tBCtSatCur = IBC*factor; }      // :176-177
  else tBCtSatCur = tSatCur;                                                         // :179
  if (issGiven) tSubSatCur = ISS * factor;                                           // :181-182  (note: uses the last `factor`)
} else if (tlev === 3) {
  tSatCur = AREA * Math.pow(IS, 1+TIS1*dt+TIS2*dt*dt);                               // :184
  if (ibeGiven && ibcGiven) tBEtSatCur = AREA*Math.pow(IBE, 1+TIS1*dt+TIS2*dt*dt);   // :186
  else tBEtSatCur = tSatCur;                                                         // :188
  if (ibeGiven && ibcGiven) tBCtSatCur = Math.pow(IBC, 1+TIS1*dt+TIS2*dt*dt);        // :191
  else tBCtSatCur = tSatCur;                                                         // :193
  if (issGiven) tSubSatCur = Math.pow(ISS, 1+TISS1*dt+TISS2*dt*dt);                  // :195-196
}
// bjttemp.c:198-213 — BC/sub satcur area folding (subs orientation)
if (!isLateral) tBCtSatCur *= AREAB; else tBCtSatCur *= AREAC;                       // :198-202
if (issGiven) {
  if (ibeGiven && ibcGiven) { if (!isLateral) tSubSatCur *= AREAC; else tSubSatCur *= AREAB; } // :205-209
  else tSubSatCur *= AREA;                                                           // :211
}

// bjttemp.c:215-229 — QS temp block (gated on rcoGiven)
if (rcoGiven) {
  if (QUASIMOD === 1) {
    const rT = temp/tnom;                                                            // :217
    tintCollResist = RCO * Math.pow(rT, XRCI);                                       // :218  (XRCI=tempExpRCI)
    tepiSatVoltage = VO  * Math.pow(rT, XD);                                         // :219  (XD=tempExpVO)
    const xvar1 = Math.pow(rT, XTI);                                                 // :220  (XTI=tempExpIS)
    const xvar2 = -EGQS*(1.0-rT)/vt;                                                 // :221  (EGQS=energyGapQS)
    const xvar3 = Math.exp(xvar2);                                                   // :222
    tepiDoping = GAMMA * xvar1 * xvar3;                                              // :223  (GAMMA=epiDoping)
  } else { tintCollResist = RCO; tepiSatVoltage = VO; tepiDoping = GAMMA; }          // :225-227
}

// bjttemp.c:231-243 — beta temp factor (tlev gates bfactor; tempco overrides)
let bfactor;
if (tlev === 0) bfactor = Math.exp(ratlog*XTB);                                      // :231-232  (XTB=betaExp)
else if (tlev === 1) bfactor = 1 + XTB*dt;                                           // :233-234
tBetaF = (tbf1Given || tbf2Given) ? BF*(1+TBF1*dt+TBF2*dt*dt) : BF*bfactor;          // :236-239
tBetaR = (tbr1Given || tbr2Given) ? BR*(1+TBR1*dt+TBR2*dt*dt) : BR*bfactor;          // :240-243

// bjttemp.c:245-258 — leakage currents, tlev==0/1 vs ==3, then BC area fold
if (tlev === 0 || tlev === 1) {
  tBEleakCur = AREA * ISE * Math.exp(factlog/NE) / bfactor;                          // :246-247
  tBCleakCur =        ISC * Math.exp(factlog/NC) / bfactor;                          // :248-249
} else if (tlev === 3) {
  tBEleakCur = AREA * Math.pow(ISE, 1+TISE1*dt+TISE2*dt*dt);                         // :251
  tBCleakCur =        Math.pow(ISC, 1+TISC1*dt+TISC2*dt*dt);                         // :252
}
if (!isLateral) tBCleakCur *= AREAB; else tBCleakCur *= AREAC;                       // :254-257
```
Note `bfactor` is left undefined for `tlev ∉ {0,1}`; ngspice only ever reaches the
`bfactor` use under the same `tlev` gate, so the port mirrors that (do not
synthesize a default).

### 7c — junction capacitances, tlevc==0 vs tlevc==1 (`bjttemp.c:260-313`)

The `tlevc==0` arm uses `pbfact1` (the NOMINAL-temp factor, the v41 fix — NOT
`pbfact`). Each of BE/BC/Sub follows the same shape; transcribe all three:

```ts
// BE cap — bjttemp.c:260-275
if (tlevc === 0) {
  let pbo = (VJE - pbfact1)/fact1;                                                   // :261
  let gmaold = (VJE - pbo)/pbo;                                                      // :262
  tBEcap = CJE / (1 + tjunctionExpBE*(4e-4*(tnom-REFTEMP) - gmaold));                // :263-265
  tBEpot = fact2*pbo + pbfact;                                                       // :266
  let gmanew = (tBEpot - pbo)/pbo;                                                   // :267
  tBEcap *= 1 + tjunctionExpBE*(4e-4*(temp-REFTEMP) - gmanew);                       // :268-269
} else if (tlevc === 1) {
  tBEcap = CJE*(1 + CTE*dt);                                                         // :271-272
  tBEpot = VJE - TVJE*dt;                                                            // :273
}
tBEcap *= AREA;                                                                      // :275
// BC cap — bjttemp.c:276-294  (same shape with VJC/CJC/CTC/TVJC/tjunctionExpBC)
if (tlevc === 0) {
  let pbo = (VJC - pbfact1)/fact1;                                                   // :277
  let gmaold = (VJC - pbo)/pbo;                                                      // :278
  tBCcap = CJC / (1 + tjunctionExpBC*(4e-4*(tnom-REFTEMP) - gmaold));                // :279-281
  tBCpot = fact2*pbo + pbfact;                                                       // :282
  let gmanew = (tBCpot - pbo)/pbo;                                                   // :283
  tBCcap *= 1 + tjunctionExpBC*(4e-4*(temp-REFTEMP) - gmanew);                       // :284-285
} else if (tlevc === 1) {
  tBCcap = CJC*(1 + CTC*dt);                                                         // :287-288
  tBCpot = VJC - TVJC*dt;                                                            // :289
}
if (!isLateral) tBCcap *= AREAB; else tBCcap *= AREAC;                               // :291-294
// Sub cap — bjttemp.c:295-313  (VJS=potentialSubstrate, CJS=capSub, CTS, TVJS, tjunctionExpSub)
if (tlevc === 0) {
  let pbo = (VJS - pbfact1)/fact1;                                                   // :296
  let gmaold = (VJS - pbo)/pbo;                                                      // :297
  tSubcap = CJS / (1 + tjunctionExpSub*(4e-4*(tnom-REFTEMP) - gmaold));              // :298-300
  tSubpot = fact2*pbo + pbfact;                                                      // :301
  let gmanew = (tSubpot - pbo)/pbo;                                                  // :302
  tSubcap *= 1 + tjunctionExpSub*(4e-4*(temp-REFTEMP) - gmanew);                     // :303-304
} else if (tlevc === 1) {
  tSubcap = CJS*(1 + CTS*dt);                                                        // :306-307
  tSubpot = VJS - TVJS*dt;                                                           // :308
}
if (!isLateral) tSubcap *= AREAC; else tSubcap *= AREAB;                             // :310-313
```
NOTE the substrate cap area fold is **swapped** vs BC (`AREAC` for VERTICAL, `:311`)
— transcribe exactly.

### 7d — depletion-cap fit coefficients (`bjttemp.c:315-333`)

Unchanged by the tempco set but recomputed from the new `tBEpot`/`tBCpot`/
`tjunctionExp*`; `xfc = log(1 − FC)` (`bjttemp.c:68`, `FC=depletionCapCoeff`):

```ts
tDepCap = FC * tBEpot;                                                               // :315
tf1 = tBEpot*(1 - Math.exp((1 - tjunctionExpBE)*xfc))/(1 - tjunctionExpBE);          // :316-318
tf4 = FC * tBCpot;                                                                   // :319
tf5 = tBCpot*(1 - Math.exp((1 - tjunctionExpBC)*xfc))/(1 - tjunctionExpBC);          // :320-322
tVcrit = vt*Math.log(vt/(CONSTroot2*tSatCur));                                       // :323-324
if (issGiven) tSubVcrit = vt*Math.log(vt/(CONSTroot2*tSubSatCur));                   // :325-327
tf2 = Math.exp((1 + tjunctionExpBE)*xfc);                                            // :328
tf3 = 1 - FC*(1 + tjunctionExpBE);                                                   // :329-330
tf6 = Math.exp((1 + tjunctionExpBC)*xfc);                                            // :331
tf7 = 1 - FC*(1 + tjunctionExpBC);                                                   // :332-333
```

### Required constraints

- The area folding here (`·AREA`/`/AREA`/`·AREAB`/`·AREAC`) is the SAME refactor
  Part 4a removes from `load()` and Part 5 removes from `stampAc()`; they must
  move in lockstep.
- `tempExpIS` (=`XTI`), `tempExpRCI` (=`XRCI`/`cn`), `tempExpVO` (=`XD`/`d`),
  `energyGapQS` (=`EGQS`/`vg`), `betaExp` (=`XTB`), `epiDoping` (=`GAMMA`/`gamma`)
  are the model→digiTS name mappings used above.
- `pow` is correct everywhere ngspice writes `pow` (`:184,191,196,218-220,251,252`);
  do NOT substitute the `exp(c·log(arg))` identity there.
- Do NOT cache the temp results across `setCircuitTemp` — recompute on every temp
  change (the MOS1 pattern, `bjt.ts` setParam re-runs the temp pass).
- The QS temp params (`tintCollResist`/`tepiSatVoltage`/`tepiDoping`) are computed
  here; `epiCharge`/`QCO` is NOT temp-scaled (it is used raw in `load()`, Part 4c).

---

## Allowed-difference / NO-COUNTERPART (by design — do NOT reconstruct)

These are the pure C-struct mechanics and analysis surfaces digiTS has no
counterpart for; they are allowed-difference and must NOT generate digiTS work.
(This list is genuine architectural non-counterparts ONLY — every real numerical
feature, including the full TLEV/TLEVC subsystem, is built; see Part 7.)

- **GENinstance/GENmodel embedding** (`bjtdefs.h` `bjt.md:447-465,627-641`): the
  `struct GENinstance gen` embedding and the `BJTmodPtr(inst)`/`BJTnextInstance`/
  `BJTinstances` accessor macros, the `#define BJTname gen.GENname` etc. digiTS
  uses a closure/class model — NO-COUNTERPART. The `const int BJTcolNode` field
  qualifiers are C-only.
- **`#define`→`enum` conversions** for the device/model/quest param ids
  (`bjt.md:753-1130`): IFparm-table identifiers — the digiTS param-def keys are
  strings; NO-COUNTERPART.
- **IFparm `IOP`/`IOPR`/`IOPA` table edits** in `bjt.c` (`bjt.md:79-198`): the
  parser's parameter table; the `c2`/`c4`→`ise`/`isc` aliasing and `pe`/`me`/etc.
  alias flag changes are parser concerns — NO-COUNTERPART at the element.
- **`bjtask.c`/`bjtmask.c` accessor + `*BJTtype` ask changes** (`bjt.md:287-368,
  2369-2471`): the `BJT_QUEST_*`/`BJT_MOD_*` query handlers; digiTS has no IFask
  surface — NO-COUNTERPART (the QS query ids `BJT_QUEST_COLLCXNODE` etc. are
  ask-surface only).
- **`bjtdel.c`/`bjtmdel.c`/`bjtdest.c`/`bjtinit.c`** (`bjt.md:1134-1591`):
  instance/model lifecycle + the `SPICEdev` designated-initializer rewrite —
  C memory management; NO-COUNTERPART.
- **`bjtpzld.c`** PZ-load collCX block (`bjt.md:2759-2850`): pole-zero analysis is
  not a digiTS surface — NO-COUNTERPART.
- **`bjtnoise.c`/`bjtdisto.c`/`bjtsacl.c`** (`bjt.md:2642-2889+`):
  noise / distortion / sensitivity-AC — NO-COUNTERPART subsystems digiTS lacks
  these analysis surfaces.

Items that are **NOT** in this list (they are real behavior, built or sequenced,
never dropped):
- **TLEV/TLEVC** is BUILT here in full (Part 7) — every `tlev`/`tlevc` branch, the
  tempco multipliers, the `>0.999` grading limit. Not out of scope.
- **SOA** (`bjtsoachk.c` `BJTsoaCheck`, the `ic_max`/`ib_max`/`pd_max`/`te_max`/
  `rth0` limits) is a diagnostic warning pass (reads only, `soa_printf`, no
  matrix/RHS write `bjtsoachk.c:44-138`; `rth0` is a `pd_max` derating divisor at
  `:119`, not a thermal node). Its model params are ported declare-only here; the
  consumption is the sequenced follow-on `bjt#recon/soaWarnings` (PENDING,
  specExists:false). The existing ledger hunk `bjt/bjtsoachk.c#h001` (currently
  mis-filed NO-COUNTERPART) should be reclassified to `blockedBy:
  bjt#recon/soaWarnings` — flagged for the orchestrator. NOT NO-COUNTERPART.

## Constructs that genuinely reach outside `bjt.ts`

**NONE.** Verified:
- Node allocation: `ctx.makeVolt` is a `SetupContext` method already consumed by
  `bjt.ts` setup (`:1320,1326,1332`); adding `collCX` is a device-local call.
- Matrix cells: `solver.allocElement` is consumed in `bjt.ts` setup; the new
  cells are device-local.
- State slots: `BJT_L1_SCHEMA` lives in `bjt.ts`.
- Params: `BJT_PARAM_DEFS`/defaults live in `bjt.ts`; registration in
  `register-all.ts` references them by import and needs no edit.
- `niIntegrate`/`cktTerr`/`pnjlim`/`stampRHS` are already-imported solver
  primitives (`bjt.ts:36-41`); the Kull block reuses them — no new primitive.

The prior "compiler.ts-owned / sparse-solver-settled" escalation is contradicted
by `bjtsetup.c:433` (device-local `CKTmkVolt`) and `setup-context.ts:31-33`
(device-local `makeVolt`); recorded here as the correction.

---

## Acceptance criteria

1. `setup()` allocates `nodeCX` (`collCX`) gated on `params.RC` and `nodeC_int`
   (`colPrime`) gated on `rcoGiven`, collapsing each to its parent node when the
   gate is false, with internal-label suffixes `"collCX"`/`"collector"` matching
   `bjtsetup.c:433,441`. The TSTALLOC sequence is the 24-or-28-cell
   `bjtsetup.c:502-540` order line-for-line; the four coupling cells (25-28) and
   only those are gated on `rcoGiven`; `collCXcollCX` (24) is unconditional.
2. `BJT_L1_SCHEMA` has 33 slots in the exact `bjtdefs.h` order (`VBCX`/`VRCI` at
   2/3, the seven QS slots at 26-32); every existing SLOT_* literal ≥2 is shifted
   +2; `stateSize === 33`.
3. The QS model params (`RCO`/`VO`/`GAMMA`/`QCO`/`QUASIMOD`/`EGQS`/`XRCI`/`XD`/
   `IBE`/`IBC`/`TISS1`/`TISS2`) exist in `BJT_PARAM_DEFS` with `bjtsetup.c`
   defaults (polarity-dependent `XRCI`/`XD` in NPN/PNP defaults); they are
   hot-loadable via `setParam`; the SOA limits and TLEV coefficients are NOT
   added.
4. `load()` reconstructs the Kull Irci/Qbci block (`bjt.md:2033-2090`) operand-
   for-operand gated on `rcoGiven`, with `vbcx`/`vrci` reads from `rhsOld[nodeCX]`
   / `rhsOld[nodeC_int]`, the predictor/bypass/init copies, the next2 state
   writes, the BC-charge augmentation, and the collCX Y-stamps + RHS
   (`bjt.md:2305-2364`) in the exact accumulation order. The area-scaling refactor
   (`csat`→`tBEtSatCur`/`tBCtSatCur`, gcpr/gepr/rbpi un-AREA-scaled) co-lands.
   With `rco` unset, DC results are bit-identical to the present classic-GP path.
5. `stampAc` un-area-scales gcpr/gepr and the collCX AC restructure + `rcoGiven`
   AC block (`bjtacld.c#h002`/`#h003`) land on the re-layout, consistent with
   `bjt#recon/stampAc`; no `allocElement` in `stampAc`.
6. `checkConvergence` reads the third junction `vbcx` from `nodeCX` and computes
   `delvbcx` (`bjtconv.c`, `bjt.md:397-402`) without altering the `cchat`/`cbhat`
   tolerance test.
7. `computeBjtTempParams` is rewritten to the FULL v41 `bjttemp.c` pass (Part 7):
   the `tlev==0/1` AND `tlev==3` saturation-current + leakage arms, the
   `tlevc==0` AND `tlevc==1` junction-cap formulas, every per-parameter tempco
   multiplier `(1+t<x>1·dt+t<x>2·dt²)`, the area folding, `pbfact1`, the
   `mje`/`mjc`/`mjs > 0.999` grading clamp, the BE/BC satcur split
   (`tBEtSatCur`/`tBCtSatCur`), and the QS temp params
   `tintCollResist`/`tepiSatVoltage`/`tepiDoping` with the `quasimod==1` vs
   pass-through fork (`bjttemp.c:215-229`). Nothing in the temperature pass is
   deferred or dropped; parity holds at ANY `tlev`/`tlevc` value. (SOA limit
   params are declare-only; their consumption is `bjt#recon/soaWarnings`.)
8. Harness parity (CLAUDE.md harness-first): a `.dts` NPN with `rco`/`vo`/`gamma`/
   `qco` set (Kull active) and a control NPN without `rco` (classic GP) both reach
   `harness_first_divergence` = null across voltage/matrix/state/shape at every
   DC-OP NR iteration and every transient step against the ngspice DLL —
   bit-exact, no tolerance qualifier. The classic-GP control proves the gate-off
   path is byte-preserved; **a third device setting `tlev`/`tlevc` (and a tempco
   pair, e.g. `tbf1`/`tmje1`) proves the full TLEV/TLEVC temperature pass (Part 7)
   reaches bit-exact parity at non-default `tlev`/`tlevc`**. Verified via
   `harness_start`→`harness_run`→`harness_first_divergence`→`harness_topology_diff`
   (confirms collCX node + coupling cells match slot order)→`harness_matrix_diff`.
9. Three-surface tests (CLAUDE.md): Surface 1 headless (`ComparisonSession` per
   `docs/api-reference/test-tools.md`) covering Kull-active DC-OP/transient + the
   classic-GP control; Surface 2 MCP (`circuit_build`→`circuit_compile`→
   `circuit_dc_op`, `rco`/`vo`/`gamma`/`qco` round-trip); Surface 3 E2E
   (`SimulatorHarness`).

## Per-hunk port notes (MIXED hunks — port ALL lines; SOA params declare-only)

The MIXED hunks carry several subsystems interleaved. **No lines are dropped.**
Every line is ported here, EXCEPT the SOA model-param declarations, which are
ported as **inert declare-only params** (added to `BJT_PARAM_DEFS`, consumed later
by `bjt#recon/soaWarnings`). Verified against the diff doc line ranges.

- **`bjt/bjttemp.c#h005`** (`bjt.md:3448-3500`, header `@@ -126,33 +98,52 @@`):
  PORT ALL — the area-folding `/= BJTarea` / `*= BJTarea` on
  `tinvRollOffR`/`tcollectorConduct`/`temitterConduct`/`tbaseResist`/
  `tminBaseResist`/`tbaseCurrentHalfResist`/`ttransitTimeHighCurrentF`
  (`bjt.md:3452,3458,3464,3470,3472,3474,3480`); the per-param tempco multipliers
  `(1+t<x>1·dt+t<x>2·dt²)` with the `t<x>1`/`t<x>2` params now carried (default 0);
  and the three `mje`/`mjc`/`mjs > 0.999` junction-grading limiting blocks
  (`bjt.md:3484-3497`) — BUILD them (TLEV parity).
- **`bjt/bjttemp.c#h006`** (`bjt.md:3501-3584`, header `@@ -162,17 +153,79 @@`):
  PORT ALL — `egfet1`/`arg1`/`pbfact1` (`bjt.md:3505-3509`); the `tlev==0||1`
  BE/BC saturation-current split + `· BJTarea` (`bjt.md:3515-3534`); **the
  `tlev==3` saturation-current arm (`bjt.md:3535-3550`) — BUILD it**; the
  `BCtSatCur *= areab/areac` and `tSubSatCur` area block (`bjt.md:3551-3566`); the
  QS temp block gated on `BJTintCollResistGiven` with the `quasimod==1` fork
  (`bjt.md:3568-3582`).
- **`bjt/bjttemp.c#h007`** (`bjt.md:3585-3610`, header `@@ -190,17 +243,22 @@`):
  PORT ALL — the `tlev==0||1` BE/BC leakage-current `· BJTarea`
  (`bjt.md:3588-3593`); **the `tlev==3` leakage arm (`bjt.md:3594-3597`) — BUILD
  it**; the `tBCleakCur *= areab/areac` block (`bjt.md:3599-3603`); the `pbfact →
  pbfact1` switch in the `tlevc==0` junction-cap formula (`bjt.md:3606-3607`); and
  the `tlevc==1` cap arm that follows (`bjt.md:3613-3618`).
- **`bjt/bjt.c#h009`** and **`bjt/bjtmpar.c#h006`** (the QS+SOA param block,
  `bjt.md:172-200` / `bjt.md:2614-2641`):
  - BUILD: the QS model-param IFparm entries / setters (`rco`/`vo`/`gamma`/`qco`/
    `quasimod`/`vg`/`cn`/`d`/`tiss1`/`tiss2`).
  - DECLARE-ONLY: the SOA entries/setters (`pd_max`/`ic_max`/`ib_max`/`te_max`/
    `rth0`, `bjt.md:193-197` / `bjt.md:2618-2637`) — add to `BJT_PARAM_DEFS`
    (default `1e99`) + `setParam`, parity-neutral (no `load`/`setup` effect);
    consumed by `bjt#recon/soaWarnings`. (`ibe`/`ibc` are in `bjt.c#h002/h003`,
    `bjtmpar.c#h001/h002` — BUILD, they feed the BE/BC satcur split.)
- **`bjt/bjtsetup.c#h008`** (the QS+SOA defaults block, `bjtsetup.c:358-403`):
  BUILD the QS defaults (`:358-381`); DECLARE-ONLY the SOA defaults `1e99`
  (`:392-403`); also carries the collCX TSTALLOC (`bjt.md` collCX cells) — BUILD.
- **`bjt/bjtdefs.h#h013`** (model Given-flag block): BUILD the QS Given flags;
  the SOA Given flags map to digiTS param-givenness (declare-only, parity-neutral).
- **`bjt/bjttrunc.c#h001`** (`bjt.md:3683-3700`): BUILD the `qbcx` `CKTterr`
  gated on `BJTintCollResistGiven` (Part-G `getLteTimestep`); the accessor renames
  are NC-by-mechanism (closure walk — no digiTS line).

## FINAL per-hunk routing (every PENDING bjt hunk, exactly once)

Total currently-PENDING bjt hunks: **90** (verified against
`spec/v41-port/ledger.json`, `state == "PENDING"`). Routing:

- **QS-PORT (84)** — `blockedBy: bjt#recon/quasiSaturation`. All `bjt.c`,
  `bjtmpar.c`, `bjtdefs.h` (except `#h014`), `bjtsetup.c`, `bjtload.c` (except the
  two substrate-polarity hunks), `bjtconv.c`, `bjttemp.c`, `bjttrunc.c` hunks. The
  area/Arrhenius refactor + the FULL TLEV/TLEVC logic co-land, so the per-file
  spans are entangled and routed whole and built in full (SOA param declarations
  ride along as inert declare-only params per the port notes above; no lines
  dropped).
- **bjtdefs.h#h014 → NO-COUNTERPART (1).** The `#define`→`enum` param-id table
  (`BJT_MOD_*` / `BJT_QUEST_*`). digiTS keys params by string name; the enum
  incidentally lists QS+SOA+TLEV ids but the construct (a C integer-id table for
  the IFparm dispatch) has no digiTS counterpart. This is the ONLY legitimate
  NO-COUNTERPART in the PENDING set.
- **bjtload.c#h011, bjtload.c#h036 → PENDING-SEPARATE** (ordinary PENDING, NOT
  blockedBy this recon). Both are the pure substrate-current polarity refactor
  `vsub=ttype·(…)` / `ceqsub=ttype·(…)` where `ttype = BJTtype·BJTsubs`
  (`bjt.md:1757-1758`, `:2296-2297`). digiTS HAS a substrate counterpart (the
  existing `load()` substrate-current path computes `polarity·subs`), so they are
  portable as an algebraic factoring independent of QS — not NO-COUNTERPART. They
  carry no QS content and must not gate on this recon. (h011's specific line sits
  in the SenCond branch, which is itself NC, but the behavioral `vsub` polarity
  has a live counterpart in the non-sensitivity reads.)
- **bjtacld.c#h001/#h002/#h003 → NOT in this recon's `blocks`.** They stay
  `blockedBy: bjt#recon/stampAc`. This recon supplies their re-layout prerequisite
  (collCX node + cells + `Irci_*`/`cqbcx` slots); the AC stamp itself is the other
  recon's deliverable.

Recommended recon ID: **`bjt#recon/quasiSaturation`**. The machine-readable
routing is emitted as the final message of this task.
