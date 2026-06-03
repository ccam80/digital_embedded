# Reconstruction spec — `mes#recon/wholeClass`

Reconstruct the **GaAs MESFET device class** (`mes`) on a new
`src/components/semiconductors/mesfet.ts`, faithful to the v26 ngspice
baseline. ngspice ships a single `mes` device class (the Statz GaAs MESFET,
`ref/ngspice/src/spicelib/devices/mes/`) with an N/P channel-polarity model
flag (`NMF`/`PMF`); digiTS has **no** MESFET component at all
(`device-class-scope.md:52` — "Missing — declares `mes#recon/wholeClass`. GaAs
MESFET model never ported."). This is a v26-baseline rebuild: every line of the
class — the instance/model fields, the param/model-card setters, the
setup-time node creation + matrix-pointer allocation, the temperature
pre-computation, the Statz DC+transient `load()`, the AC small-signal stamp,
the LTE truncation, and the `.ic` capture — is reconstructed from the v26
ngspice source.

`mes` is an **IN** device class (`device-class-scope.md:52, 95-99`): the IN-list
MESFET covers the canonical GaAs MESFET use case for the power-electronics
target. IN-class completeness forbids OMITTING any ngspice behavior in the
device's analysis scope (DC + transient + AC small-signal + LTE), and the
worklog freezes that completeness explicitly for `mes` (#52 below). The only
ngspice MES behavior carved OUT is flicker-noise (`KF`/`AF`), and that is a
ratified NO-COUNTERPART because digiTS implements no noise analysis (#51 below).

This spec implements three **RESOLVED, BINDING** worklog rulings:

- **#26 (`Q-MES-MODEL-NAME`), `OPEN-QUESTIONS-WORKLOG.md:89, 362-365`:
  TWO components — `NMESFET` and `PMESFET`.** This *overturns* the planner's
  "one `mesfet.ts` with an `NMF`/`PMF` flag" default. `NMF`/`PMF` is the
  invariant channel-polarity axis (`mesdefs.h:219-224` `#define NMF 1` /
  `#define PMF -1`), exactly mirroring the existing `NJFET`/`PJFET` split (one
  ngspice class + a model-type literal → two digiTS components). The worklog
  permits "one factory file or two" — this spec uses **one `mesfet.ts` factory
  file** carrying both `NMESFET` and `PMESFET` element classes, each with its
  own polarity literal (`+1` / `-1`), matching the NJFET/PJFET file layout
  exactly. **Precondition correction (harness netlist-generator plumbing
  REQUIRED).** The claim that this split is harness-invisible / needs no
  netlist-generator plumbing is FALSE: the harness emits ngspice MESFETs as the
  `Z` card (`Z<name> nd ng ns <model>` with `.model <name> NMF`/`PMF`), and the
  generator has no MESFET support today. `ELEMENT_SPECS`
  (`netlist-generator.ts:52-53`) lists only `NJFET`/`PJFET` (prefix `J`); there is
  no `NMESFET`/`PMESFET` row, and `emitPrimitive` (`netlist-generator.ts:661-668`)
  has a `J`-prefix branch but NO `Z`-prefix branch. The parity gate therefore
  REQUIRES, as a coupled harness edit landing WITH this recon:
  (a) two new `ELEMENT_SPECS` rows — `NMESFET: { prefix: "Z", modelType: "NMF" }`
  and `PMESFET: { prefix: "Z", modelType: "PMF" }`; and
  (b) a new `Z`-prefix branch in `emitPrimitive` (modeled on the `J`-branch at
  `netlist-generator.ts:661-668`) emitting `Z<name> D G S <model>` with the NMF/PMF
  model card. The `.MODEL … NMF`/`PMF` card is typeId-driven, but the instance
  card prefix is not — without the `Z`-branch the generator cannot emit a MESFET
  deck at all.
- **#52 (`Q-MES-STATZ-LEVEL`), `OPEN-QUESTIONS-WORKLOG.md:115, 416`:
  full v26 Statz, no reduction.** Reconstruct the complete v26 Statz `MESload`
  drain-current + charge model line-for-line; no simplified "pragmatic" Statz
  variant (IN-class completeness).
- **#51 (`Q-MES-KFAF`), `OPEN-QUESTIONS-WORKLOG.md:114, 415-416`:
  omit `KF`/`AF` flicker noise.** `KF`/`AF` are consumed only by `MESnoise`
  (`mesnoise.c`), and digiTS implements no noise analysis → NO-COUNTERPART.
  The model-card *parses* `kf`/`af` (so a SPICE deck carrying them does not
  error), but they feed no evaluation path.

A fourth ruling bounds Part H:

- **#14 (`Q-MES-GETIC-HOOK`), `OPEN-QUESTIONS-WORKLOG.md:77, 204-224`:
  defer the engine `getic`/`setic` dispatch to the engine phase.** The verified
  finding (independent read-only verifier) is that digiTS has **no**
  engine→device IC-capture dispatch (`DEVsetic = <dev>getic`); `AnalogElement`
  exposes no such hook (`element.ts:43-145`), and a whole-`src/` grep for
  `getic|setic|DEVsetic` returns zero matches. Parts A–G (fields, parse, setup,
  temp, Statz load, AC, trunc, UIC seed) are self-contained element edits that
  ship now and satisfy every blocked hunk in this recon. The `MESgetic` capture
  (Part H) is implemented **iff** the engine exposes the hook; otherwise it is
  deferred to the engine-subsystem planner and does not block device
  completion.

Authoring contract: this spec is **documentation**. No code. No tests. The
implementer authors the TypeScript against this spec; the verifier checks the
edit against the ngspice citations herein. Per `CLAUDE.md` comment-hygiene,
every reconstructed source comment cites the current
`ref/ngspice/src/spicelib/devices/mes/<file>` line and explains the mechanism
in present tense, with no `v26`/`v41`/era tags and no migration narrative.

## Current digiTS state

There is **no** `src/components/semiconductors/mesfet.ts` (the directory holds
`njfet.ts` / `pjfet.ts` / `mosfet.ts` / `vdmos.ts` / `bjt.ts` / `diode.ts` etc.,
but no MESFET). There is no `NMESFET` / `PMESFET` registration in
`register-all.ts` (only `NJfetDefinition` / `PJfetDefinition` are imported,
`register-all.ts:154-155`). There is no `MES` entry in `NGSPICE_LOAD_ORDER`,
the `DeviceFamily` union, the family map, or the pin-layout map
(`ngspice-load-order.ts:34-59, 72-89, 135-136, 182-183, 242-243` carry only
`JFET`/`NJFET`/`PJFET`).

The reconstruction is therefore a greenfield whole-class build. The single
closest in-tree analogue is the JFET pair (`njfet.ts` / `pjfet.ts`): same
3-terminal G/D/S topology, same source-prime/drain-prime internal-node pattern,
same gate-junction dual-charge transient model, same `PoolBackedAnalogElement`
substrate, same `pnjlim`/`fetlim` limiter pair, same `niIntegrate` companion
integration. `mesfet.ts` follows the `njfet.ts` structure exactly; the body is
the Statz model (`mesload.c`) rather than Sydney-University JFET (`jfetload.c`).

The 12 v41 hunks listed in "Blocked hunks" are `blockedBy:
mes#recon/wholeClass` in `ledger.json` (entries at `ledger.json:62693-62704`);
they apply onto the reconstructed baseline as ordinary per-hunk deltas once the
class exists.

## Part A — Instance + model state (`mesdefs.h`)

ngspice's `sMESinstance` (`mesdefs.h:33-148`) and `sMESmodel`
(`mesdefs.h:167-217`) carry the device. The reconstruction maps them onto a
`MesfetParams` interface + element fields + a `MES_SCHEMA` state pool.

### Model parameters (`mesdefs.h:178-214`, model-card setter `mesmpar.c`)

| ngspice model field | `mesdefs.h` line | digiTS param | default (`messetup.c`) | unit | source |
|---|---|---|---|---|---|
| `MESthreshold` | `:178` | `VTO` | `-2.0` (`messetup.c:32-34`) | V | `mesmpar.c:20-23` (`MES_MOD_VTO`); `mes.c:45-46` (`vt0`/`vto`) |
| `MESalpha` | `:179` | `ALPHA` | `2.0` (`messetup.c:41-43`) | 1/V | `mesmpar.c:24-27` (`MES_MOD_ALPHA`); `mes.c:47` |
| `MESbeta` | `:180` | `BETA` | `2.5e-3` (`messetup.c:35-37`) | A/V² | `mesmpar.c:28-31` (`MES_MOD_BETA`); `mes.c:48` |
| `MESlModulation` | `:181` | `LAMBDA` | `0.0` (`messetup.c:44-46`) | 1/V | `mesmpar.c:32-35` (`MES_MOD_LAMBDA`); `mes.c:49` |
| `MESb` | `:182` | `B` | `0.3` (`messetup.c:38-40`) | 1/V | `mesmpar.c:36-39` (`MES_MOD_B`); `mes.c:50` |
| `MESdrainResist` | `:183` | `RD` | `0.0` (`messetup.c:47-49`) | Ω | `mesmpar.c:40-43` (`MES_MOD_RD`); `mes.c:51` |
| `MESsourceResist` | `:184` | `RS` | `0.0` (`messetup.c:50-52`) | Ω | `mesmpar.c:44-47` (`MES_MOD_RS`); `mes.c:53` |
| `MEScapGS` | `:185` | `CGS` | `0.0` (`messetup.c:53-55`) | F | `mesmpar.c:48-51` (`MES_MOD_CGS`); `mes.c:55` |
| `MEScapGD` | `:186` | `CGD` | `0.0` (`messetup.c:56-58`) | F | `mesmpar.c:52-55` (`MES_MOD_CGD`); `mes.c:56` |
| `MESgatePotential` | `:187` | `PB` | `1.0` (`messetup.c:59-61`) | V | `mesmpar.c:56-59` (`MES_MOD_PB`); `mes.c:57` |
| `MESgateSatCurrent` | `:188` | `IS` | `1e-14` (`messetup.c:62-64`) | A | `mesmpar.c:60-63` (`MES_MOD_IS`); `mes.c:58` |
| `MESdepletionCapCoeff` | `:189` | `FC` | `0.5` (`messetup.c:65-67`) | — | `mesmpar.c:64-67` (`MES_MOD_FC`); `mes.c:59` |
| `MESfNcoef` | `:190` | `KF` | `0.0` (`messetup.c:68-70`) | — | `mesmpar.c:78-81` (`MES_MOD_KF`); `mes.c:62` |
| `MESfNexp` | `:191` | `AF` | `1.0` (`messetup.c:71-73`) | — | `mesmpar.c:82-85` (`MES_MOD_AF`); `mes.c:63` |

`KF`/`AF` are PARSED (so a deck carrying them does not error) but feed no
evaluation path — consumed only by `MESnoise`, which is NO-COUNTERPART (#51).

The derived model-temperature quantities (`MESdrainConduct`, `MESsourceConduct`,
`MESdepletionCap`, `MESf1`, `MESf2`, `MESf3`, `MESvcrit`, `mesdefs.h:193-199`)
are NOT params; they are computed in Part D from the params above.

`MEStype` (`mesdefs.h:176`) is the channel-polarity flag, set by the model card
`nmf`/`pmf` (`mesmpar.c:68-77`). In digiTS this is the per-component polarity
literal — `NMESFET` carries `+1` (`NMF`, `mesdefs.h:221`), `PMESFET` carries
`-1` (`PMF`, `mesdefs.h:222`). It is NOT a runtime param (#26: the two
components ARE the two polarities).

### Instance parameters (`mesdefs.h:48-87`, instance setter `mesparam.c`)

| ngspice instance field | `mesdefs.h` line | digiTS param | default (`messetup.c`) | unit | source |
|---|---|---|---|---|---|
| `MESarea` | `:48` | `AREA` | `1.0` (`messetup.c:79-81`) | — | `mesparam.c:24-27` (`MES_AREA`); `mes.c:14` |
| `MESm` | `:49` | `M` | `1.0` (`messetup.c:82-84`) | — | `mesparam.c:28-31` (`MES_M`); `mes.c:15` |
| `MESicVDS` | `:50` | `ICVDS` | `0.0` | V | `mesparam.c:32-35` (`MES_IC_VDS`), `mesparam.c:51-54` (`MES_IC` vec[0]); `mes.c:16` |
| `MESicVGS` | `:51` | `ICVGS` | `0.0` | V | `mesparam.c:36-39` (`MES_IC_VGS`), `mesparam.c:47-50` (`MES_IC` vec[1]); `mes.c:17` |
| `MESoff` | `:83` | `OFF` | `0` | flag | `mesparam.c:40-42` (`MES_OFF`); `mes.c:13` |

### `*Given` guards

| ngspice flag | `mesdefs.h` line | digiTS field | read from |
|---|---|---|---|
| `MESicVDSGiven` | `:86` | `_icVDSGiven` | `props.isModelParamGiven("ICVDS")` |
| `MESicVGSGiven` | `:87` | `_icVGSGiven` | `props.isModelParamGiven("ICVGS")` |
| `MESareaGiven` | `:84` | (folded — `AREA` default 1.0 in `paramDefs`) | — |
| `MESmGiven` | `:85` | (folded — `M` default 1.0 in `paramDefs`) | — |

`MESicVDSGiven`/`MESicVGSGiven` gate `MESgetic` (Part H, `mesgetic.c:28, 33`):
when the netlist did supply the IC, `getic` must NOT overwrite it. They are
read in the constructor mirroring `njfet.ts:371-372`.

### `MesfetParams` interface + element fields

`MesfetParams` declares all params above as `number` plus the index signature
`[key: string]: number` (mirroring `JfetParams`, `njfet.ts:110-139`). The two
element classes (`NMESFETElement` / `PMESFETElement`) each read every param via
`props.getModelParam<number>("…")` in the constructor (mirror
`njfet.ts:373-401`), read `_icVDSGiven`/`_icVGSGiven` via `isModelParamGiven`,
and carry the polarity literal:

```ts
class NMESFETElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MES;
  readonly deviceFamily: DeviceFamily = "MES";
  readonly stateSchema = MES_SCHEMA;
  readonly stateSize = MES_SCHEMA.size;
  // mesdefs.h:221 — `#define NMF 1`. N-channel polarity literal.
  private readonly _polarity: 1 = 1;
  // … PMESFETElement is identical with `private readonly _polarity: -1 = -1;`
  //    (mesdefs.h:222 `#define PMF -1`).
}
```

### State schema (`MES_SCHEMA`, `mesdefs.h:150-162`)

ngspice's `MESnumStates = 13` (`mesdefs.h:15`); the 13 state offsets are
`mesdefs.h:150-162`. The schema mirrors `JFET_SCHEMA` exactly (the offsets are
identical to `jfetdefs.h`):

```ts
// mesdefs.h:150-162 — MESstate offsets. 13 slots (MESnumStates, mesdefs.h:15).
export const MES_SCHEMA: StateSchema = defineStateSchema("MesfetElement", [
  { name: "VGS",  doc: "mesdefs.h MESvgs=MESstate+0" },
  { name: "VGD",  doc: "mesdefs.h MESvgd=MESstate+1" },
  { name: "CG",   doc: "mesdefs.h MEScg=MESstate+2" },
  { name: "CD",   doc: "mesdefs.h MEScd=MESstate+3" },
  { name: "CGD",  doc: "mesdefs.h MEScgd=MESstate+4" },
  { name: "GM",   doc: "mesdefs.h MESgm=MESstate+5" },
  { name: "GDS",  doc: "mesdefs.h MESgds=MESstate+6" },
  { name: "GGS",  doc: "mesdefs.h MESggs=MESstate+7" },
  { name: "GGD",  doc: "mesdefs.h MESggd=MESstate+8" },
  { name: "QGS",  doc: "mesdefs.h MESqgs=MESstate+9" },
  { name: "CQGS", doc: "mesdefs.h MEScqgs=MESstate+10" },
  { name: "QGD",  doc: "mesdefs.h MESqgd=MESstate+11" },
  { name: "CQGD", doc: "mesdefs.h MEScqgd=MESstate+12" },
]);
```

The `MESdCoeffs[27]` distortion-analysis array (`mesdefs.h:99-140`) and the
`MESnVar[NSTATVARS][MESNSRCS]` noise array (`mesdefs.h:142-146`) are
NO-COUNTERPART: distortion analysis is out of digiTS scope and noise is omitted
(#51). Slots resolve by name via `MES_SCHEMA`; no raw `SLOT_*` import in tests
(per `MEMORY.md` schema-lookups-over-exports).

### Engine wiring (`ngspice-load-order.ts`)

ngspice orders `mes` immediately after `jfet`/`jfet2` and before `mos1`
(`dev.c:184-189`: `get_jfet_info, get_jfet2_info, get_ltra_info, get_mes_info,
get_mesa_info, get_mos1_info`). The reconstruction adds a `MES` ordinal between
`JFET (30)` and `MOS (35)`:

| edit | file:line | content |
|---|---|---|
| `NGSPICE_LOAD_ORDER.MES` | `ngspice-load-order.ts:46-47` | `MES: 31,` (between `JFET: 30` and `MOS: 35`) |
| `DeviceFamily` union | `ngspice-load-order.ts:88` | add `\| "MES"` |
| family map | `ngspice-load-order.ts:135-136` | `NMESFET: NGSPICE_LOAD_ORDER.MES, PMESFET: NGSPICE_LOAD_ORDER.MES,` |
| device-family map | `ngspice-load-order.ts:182-183` | `NMESFET: "MES", PMESFET: "MES",` |
| pin-layout map | `ngspice-load-order.ts:242-243` | `NMESFET: ["D", "G", "S"], PMESFET: ["D", "G", "S"],` (`mes.c:66-70` `MESnames` = Drain/Gate/Source) |

Identifier mapping (used across all Parts):

| ngspice identifier | digiTS identifier |
|---|---|
| `model->MEStype` | `this._polarity` (`+1` N, `-1` P) |
| `here->MESarea` | `this._params.AREA` |
| `here->MESm` | `this._params.M` |
| `here->MESicVDS` / `MESicVGS` | `this._params.ICVDS` / `.ICVGS` |
| `here->MESicVDSGiven` / `MESicVGSGiven` | `this._icVDSGiven` / `this._icVGSGiven` |
| `here->MESgateNode` | `this.pinNodes.get("G")!` |
| `here->MESdrainNode` / `MESsourceNode` | `this.pinNodes.get("D")!` / `.get("S")!` |
| `here->MESdrainPrimeNode` / `MESsourcePrimeNode` | `this._drainPrimeNode` / `this._sourcePrimeNode` |
| `ckt->CKTrhsOld[n]` | `ctx.rhsOld[n]` |
| `ckt->CKTgmin` | `ctx.cktGmin` |
| `ckt->CKTmode` | `ctx.cktMode` |
| `CONSTvt0` (`main.c:497` `= CONSTboltz*REFTEMP/CHARGE`) | `VT` (`constants.ts:42` `= REFTEMP*CONSTKoverQ`) |
| `CONSTe` (`main.c:499` `= CONSTnap`) | `Math.E` |
| `CONSTroot2` (`main.c:496` `= CONSTsqrt2`) | `Math.SQRT2` |

## Part B — Param/model-card setters (`mesparam.c` + `mesmpar.c`)

### Instance setter `setParam` (rebuild of `MESparam`, `mesparam.c:23-62`)

`MESparam` switches on the instance-param id (`mesparam.c:23`). The
reconstruction's `setParam(key, value)` mirrors `njfet.ts:1010-1040` and the
JFET `ICVDS`/`ICVGS` *Given handling (`njfet.ts:1030-1031`):

```ts
setParam(key: string, value: number): void {
  // mesparam.c:32-39 (MES_IC_VDS/MES_IC_VGS) — a hot-loaded IC seed sets its
  // *Given bit so MESgetic does not overwrite it from the operating point.
  if (key === "ICVDS") this._icVDSGiven = true;
  else if (key === "ICVGS") this._icVGSGiven = true;
  if (key in this._params) this._params[key] = value;
}
```

All param writes are hot-loadable on all three surfaces (the
`MEMORY.md` hot-loadable-params system requirement); the next `load()`/`temp()`
reads the updated value. Unlike JFET, MES has no per-instance `TEMP` param
(`mes.c:12-39` has no `temp`/`dtemp` row), so there is no temperature-recompute
branch in `setParam` — but the model-temperature derived quantities (Part D) DO
depend on `RD`/`RS`/`PB`/`FC`/`IS`, so a hot write to any of those must
re-trigger the Part-D recompute (mirroring how `njfet.ts:1032-1039` recomputes
`_tp` after any param write).

The bare `ic=vds,vgs` vector (`MES_IC`, `mesparam.c:43-58`) is the
`case 2 → case 1` fallthrough: `ic=vds` sets `ICVDS` only; `ic=vds,vgs` sets
both, `vds` first. digiTS's property bag is scalar-keyed; the attribute mapping
(Part F) splits `ic=…` into the scalar `ICVDS`/`ICVGS` writes at parse time in
`vds`-first order, reproducing the fallthrough.

### Model-card setter (rebuild of `MESmParam`, `mesmpar.c:19-89`)

Model-card params flow through the `paramDefs` defined in Part A — each row's
`spiceName` binds the SPICE token (`vto`/`vt0`, `alpha`, `beta`, `lambda`, `b`,
`rd`, `rs`, `cgs`, `cgd`, `pb`, `is`, `fc`, `kf`, `af`) to the param key. The
`nmf`/`pmf` model flags (`mesmpar.c:68-77`) are NOT params in digiTS — they
select the component (`NMESFET` vs `PMESFET`, #26). The `*Given` bits ngspice
tracks (`mesmpar.c` sets `MES…Given = TRUE` per case) are reproduced by the
`defineModelParams` defaults: a param the netlist omits takes its `messetup.c`
default (Part A table), exactly reproducing ngspice's `if(!…Given) … = default`
sweep (`messetup.c:32-73`).

## Part C — Setup: internal nodes + matrix-pointer allocation (rebuild of `MESsetup`)

`MESsetup` (`messetup.c:15-157`) creates the drain-prime / source-prime internal
nodes (only when the corresponding ohmic resistance is non-zero) and allocates
the 15 sparse-matrix element pointers in a fixed order
(`messetup.c:139-153`). The reconstruction's `setup(ctx)` mirrors
`njfet.ts:413-457`, but with the MES node-order and TSTALLOC order.

### Internal-node creation (`messetup.c:88-131`)

Critically, ngspice creates the **source-prime node FIRST**, then the
drain-prime node (`messetup.c:88-131` — source block precedes drain block),
matching `njfet.ts:425-436`. The guard is on the model resistance, not the
instance:

```ts
setup(ctx: SetupContext): void {
  const solver     = ctx.solver;
  const gateNode   = this.pinNodes.get("G")!;
  const sourceNode = this.pinNodes.get("S")!;
  const drainNode  = this.pinNodes.get("D")!;

  // messetup.c:85-86 — state-pool base allocation.
  this._stateBase = ctx.allocStates(this.stateSize);

  // messetup.c:88-109 — source-prime node created first, only when RS != 0.
  this._internalLabels.length = 0;
  if (this._params.RS === 0) {
    this._sourcePrimeNode = sourceNode;          // messetup.c:107-108
  } else {
    this._sourcePrimeNode = ctx.makeVolt(this.label, "source"); // messetup.c:90-92
    this._internalLabels.push("source");
  }
  // messetup.c:110-131 — drain-prime node created second, only when RD != 0.
  if (this._params.RD === 0) {
    this._drainPrimeNode = drainNode;            // messetup.c:129-130
  } else {
    this._drainPrimeNode = ctx.makeVolt(this.label, "drain");   // messetup.c:112-114
    this._internalLabels.push("drain");
  }
  // … TSTALLOC below
}
```

The `CKTcopyNodesets` blocks (`messetup.c:94-104, 116-126`) copy a node-set onto
the freshly created prime node; digiTS's `makeVolt` + node-set handling is the
engine-level counterpart and needs no per-device code (consistent with
`njfet.ts:428, 434` which omit them).

### Matrix-pointer allocation (`messetup.c:139-153`)

The 15 `TSTALLOC` calls allocate in this EXACT order (the element-pool order is
structurally visible at the harness CSC dump — a swapped pair diverges, per the
Sparse-Solver-Settled directive in `CLAUDE.md`). Mapping to cached handles:

| # | ngspice `TSTALLOC` | `messetup.c` line | (row, col) | handle |
|---|---|---|---|---|
| 1 | `MESdrainDrainPrimePtr` | `:139` | (drain, drainPrime) | `_hDDP` |
| 2 | `MESgateDrainPrimePtr` | `:140` | (gate, drainPrime) | `_hGDP` |
| 3 | `MESgateSourcePrimePtr` | `:141` | (gate, sourcePrime) | `_hGSP` |
| 4 | `MESsourceSourcePrimePtr` | `:142` | (source, sourcePrime) | `_hSSP` |
| 5 | `MESdrainPrimeDrainPtr` | `:143` | (drainPrime, drain) | `_hDPD` |
| 6 | `MESdrainPrimeGatePtr` | `:144` | (drainPrime, gate) | `_hDPG` |
| 7 | `MESdrainPrimeSourcePrimePtr` | `:145` | (drainPrime, sourcePrime) | `_hDPSP` |
| 8 | `MESsourcePrimeGatePtr` | `:146` | (sourcePrime, gate) | `_hSPG` |
| 9 | `MESsourcePrimeSourcePtr` | `:147` | (sourcePrime, source) | `_hSPS` |
| 10 | `MESsourcePrimeDrainPrimePtr` | `:148` | (sourcePrime, drainPrime) | `_hSPDP` |
| 11 | `MESdrainDrainPtr` | `:149` | (drain, drain) | `_hDD` |
| 12 | `MESgateGatePtr` | `:150` | (gate, gate) | `_hGG` |
| 13 | `MESsourceSourcePtr` | `:151` | (source, source) | `_hSS` |
| 14 | `MESdrainPrimeDrainPrimePtr` | `:152` | (drainPrime, drainPrime) | `_hDPDP` |
| 15 | `MESsourcePrimeSourcePrimePtr` | `:153` | (sourcePrime, sourcePrime) | `_hSPSP` |

This order is **identical** to the JFET TSTALLOC sequence (`njfet.ts:442-456`),
so the handle field set and allocation block mirror `njfet.ts` exactly:

```ts
const sp = this._sourcePrimeNode;
const dp = this._drainPrimeNode;
// messetup.c:139-153 — 15 matrix element pointers, fixed order.
this._hDDP  = solver.allocElement(drainNode,  dp);          // (1) messetup.c:139
this._hGDP  = solver.allocElement(gateNode,   dp);          // (2) messetup.c:140
this._hGSP  = solver.allocElement(gateNode,   sp);          // (3) messetup.c:141
this._hSSP  = solver.allocElement(sourceNode, sp);          // (4) messetup.c:142
this._hDPD  = solver.allocElement(dp,         drainNode);   // (5) messetup.c:143
this._hDPG  = solver.allocElement(dp,         gateNode);    // (6) messetup.c:144
this._hDPSP = solver.allocElement(dp,         sp);          // (7) messetup.c:145
this._hSPG  = solver.allocElement(sp,         gateNode);    // (8) messetup.c:146
this._hSPS  = solver.allocElement(sp,         sourceNode);  // (9) messetup.c:147
this._hSPDP = solver.allocElement(sp,         dp);          // (10) messetup.c:148
this._hDD   = solver.allocElement(drainNode,  drainNode);   // (11) messetup.c:149
this._hGG   = solver.allocElement(gateNode,   gateNode);    // (12) messetup.c:150
this._hSS   = solver.allocElement(sourceNode, sourceNode);  // (13) messetup.c:151
this._hDPDP = solver.allocElement(dp,         dp);          // (14) messetup.c:152
this._hSPSP = solver.allocElement(sp,         sp);          // (15) messetup.c:153
```

`MESunsetup` (`messetup.c:159-183`, `CKTdltNNum` prime-node reclamation) is
NO-COUNTERPART: digiTS is fresh-engine-per-`compile()`, the same architectural
posture ratified for `ccvsunsetup`/`mos1unsetup` (#28/#29,
`OPEN-QUESTIONS-WORKLOG.md:383-388`). No per-element teardown.

## Part D — Temperature pre-computation (rebuild of `MEStemp`)

`MEStemp` (`mestemp.c:15-52`) is model-level and temperature-INDEPENDENT (it
takes `NG_IGNORE(ckt)`, `mestemp.c:24` — there is no per-instance temperature
scaling, unlike JFET). It computes the derived model quantities once from the
model params:

```ts
// mestemp.c:29-49 — model-level derived quantities (temperature-independent).
interface MesfetModelTemp {
  drainConduct: number;  sourceConduct: number;
  depletionCap: number;  f1: number;  f2: number;  f3: number;  vcrit: number;
}
function computeMesfetModelTemp(p: MesfetParams): MesfetModelTemp {
  // mestemp.c:29-38 — series-resistance conductances (0 when R == 0).
  const drainConduct  = p.RD !== 0 ? 1 / p.RD : 0;
  const sourceConduct = p.RS !== 0 ? 1 / p.RS : 0;
  // mestemp.c:40-46 — depletion-cap transition voltage + polynomial coeffs.
  const depletionCap = p.FC * p.PB;                 // mestemp.c:40-41
  const xfc  = 1 - p.FC;                            // mestemp.c:42
  const temp = Math.sqrt(xfc);                      // mestemp.c:43
  const f1 = p.PB * (1 - temp) / (1 - 0.5);         // mestemp.c:44
  const f2 = temp * temp * temp;                    // mestemp.c:45
  const f3 = 1 - p.FC * (1 + 0.5);                  // mestemp.c:46
  // mestemp.c:47-48 — junction critical voltage. CONSTvt0 → VT, CONSTroot2 → Math.SQRT2.
  const vcrit = VT * Math.log(VT / (Math.SQRT2 * p.IS));
  return { drainConduct, sourceConduct, depletionCap, f1, f2, f3, vcrit };
}
```

The element computes `_mt` in its constructor (after reading params) and
re-computes it after any hot param write touching `RD`/`RS`/`PB`/`FC`/`IS`
(Part B). Because `MEStemp` ignores `ckt`, there is no `computeTemperature`
engine pass dependency (the JFET `computeTemperature` hook, `njfet.ts:999-1008`,
has no MES analogue — MES quantities are circuit-temperature-invariant).

Note the literal `(1 - .5)` and `(1 + .5)` in `mestemp.c:44,46` reproduce
verbatim as `(1 - 0.5)` / `(1 + 0.5)` for arithmetic-order parity; do not
pre-simplify to `0.5` / `1.5`.

## Part E — Statz DC + transient load (rebuild of `MESload`, full v26 Statz, #52)

`MESload` (`mesload.c:21-461`) is the device core. Reconstruct it line-for-line
into `load(ctx)`, mirroring the `njfet.ts:467-911` structure (mode dispatch →
limiting → junction currents → drain current → charge storage → noncon →
state-write → RHS + Y stamps). The differences from JFET are: the Statz drain
current (saturation/linear via `MESalpha`, `mesload.c:258-333`), the `csat`
gate-junction current with the `-3·CONSTvt0` low-voltage cubic expansion
(`mesload.c:233-252`), and the `qggnew` companion-charge helper
(`mesload.c:464-496`).

### DC model parameters (`mesload.c:97-102`)

```ts
// mesload.c:97-102 — area-scaled dc parameters. csat from gate sat current.
const beta  = params.BETA * params.AREA;
const gdpr  = mt.drainConduct  * params.AREA;
const gspr  = mt.sourceConduct * params.AREA;
const csat  = params.IS * params.AREA;
const vcrit = mt.vcrit;
const vto   = params.VTO;
```

### Linearization-voltage dispatch (`mesload.c:106-227`)

The mode dispatch matches `njfet.ts:508-645` with the SAME branch order. The
UIC branch is the genuine IC seed (Part G); polarity is `MEStype`:

```ts
let icheck = 1;                                    // mesload.c:106
if (mode & MODEINITSMSIG) {                        // mesload.c:107-109
  vgs = s0[base + VGS]; vgd = s0[base + VGD];
} else if (mode & MODEINITTRAN) {                  // mesload.c:110-112
  vgs = s1[base + VGS]; vgd = s1[base + VGD];
} else if ((mode & MODEINITJCT) && (mode & MODETRANOP) && (mode & MODEUIC)) {
  // mesload.c:113-118 — UIC seed: vds = type*icVDS; vgs = type*icVGS; vgd = vgs-vds.
  const vds0 = polarity * params.ICVDS;
  vgs = polarity * params.ICVGS;
  vgd = vgs - vds0;
} else if ((mode & MODEINITJCT) && params.OFF === 0) {
  vgs = -1; vgd = -1;                              // mesload.c:119-122
} else if ((mode & MODEINITJCT) || ((mode & MODEINITFIX) && params.OFF !== 0)) {
  vgs = 0; vgd = 0;                                // mesload.c:123-126
} else {
  // mesload.c:128-168 — MODEINITPRED xfact extrapolation (default #ifndef PREDICTOR
  // is true) else general iteration from CKTrhsOld with polarity premultiply.
  // mesload.c:158-165:
  //   vgs = type*(rhsOld[gate]-rhsOld[sourcePrime]);
  //   vgd = type*(rhsOld[gate]-rhsOld[drainPrime]);
  // then mesload.c:169-226 — delvgs/delvgd, cghat/cdhat, NOBYPASS test,
  // DEVpnjlim (×2, OR-ing ichk1 into icheck, mesload.c:216-222) + DEVfetlim (×2).
}
```

The `MODEINITPRED` 9-slot state copy (`mesload.c:128-153`) and the
delvgs/delvgd/cghat/cdhat + bypass + `pnjlim`/`fetlim` block
(`mesload.c:169-226`) are structurally identical to JFET
(`njfet.ts:538-645`); the implementer ports them from `mesload.c` with the MES
state slots. Note `mesload.c:216-222`: `DEVpnjlim` runs on both junctions with
SEPARATE check vars, and `if (ichk1 == 1) icheck = 1;` — reproduce the OR
exactly (`njfet.ts:581-585` is the pattern). `pnjlim` uses `CONSTvt0` → `VT`
(`mesload.c:216, 218`).

### Gate-junction currents (`mesload.c:233-254`)

The MES gate junction uses the `-3·CONSTvt0` low-voltage cubic expansion (NOT
the JFET form — this is MES-specific):

```ts
// mesload.c:233-242 — gate-source junction: cubic expansion below -3*vt0, else exp.
if (vgs <= -3 * VT) {
  let arg = 3 * VT / (vgs * Math.E);               // mesload.c:234 (CONSTe → Math.E)
  arg = arg * arg * arg;                           // mesload.c:235
  cg  = -csat * (1 + arg) + ctx.cktGmin * vgs;     // mesload.c:236
  ggs = csat * 3 * arg / vgs + ctx.cktGmin;        // mesload.c:237
} else {
  const evgs = Math.exp(vgs / VT);                 // mesload.c:239
  ggs = csat * evgs / VT + ctx.cktGmin;            // mesload.c:240
  cg  = csat * (evgs - 1) + ctx.cktGmin * vgs;     // mesload.c:241
}
// mesload.c:243-252 — gate-drain junction, same shape on vgd.
if (vgd <= -3 * VT) {
  let arg = 3 * VT / (vgd * Math.E);
  arg = arg * arg * arg;
  cgd = -csat * (1 + arg) + ctx.cktGmin * vgd;
  ggd = csat * 3 * arg / vgd + ctx.cktGmin;
} else {
  const evgd = Math.exp(vgd / VT);
  ggd = csat * evgd / VT + ctx.cktGmin;
  cgd = csat * (evgd - 1) + ctx.cktGmin * vgd;
}
cg = cg + cgd;                                     // mesload.c:254
```

The `vgs <= -3*CONSTvt0` comparison uses `<=` (`mesload.c:233`), distinct from
JFET's `<` (`jfetload.c:250`) — preserve `<=` exactly.

### Statz drain current + derivatives (`mesload.c:258-333`, #52 full)

`vds = vgs - vgd` (`mesload.c:231`). Normal mode (`vds >= 0`) and inverse mode
(`vds < 0`) each split cutoff / saturation / linear by `MESalpha`:

```ts
const vds = vgs - vgd;                             // mesload.c:231
let cdrain: number;
if (vds >= 0) {
  // mesload.c:258-293 — normal mode.
  const vgst = vgs - params.VTO;                   // mesload.c:259
  if (vgst <= 0) {                                 // mesload.c:263-266
    cdrain = 0; gm = 0; gds = 0;
  } else {
    const prod = 1 + params.LAMBDA * vds;          // mesload.c:268
    const betap = beta * prod;                     // mesload.c:269
    const denom = 1 + params.B * vgst;             // mesload.c:270
    const invdenom = 1 / denom;                    // mesload.c:271
    if (vds >= 3 / params.ALPHA) {                 // mesload.c:272 — saturation
      cdrain = betap * vgst * vgst * invdenom;                          // :276
      gm  = betap * vgst * (1 + denom) * invdenom * invdenom;           // :277
      gds = params.LAMBDA * beta * vgst * vgst * invdenom;             // :278-279
    } else {                                        // mesload.c:280-292 — linear
      const afact = 1 - params.ALPHA * vds / 3;     // :284
      const lfact = 1 - afact * afact * afact;      // :285
      cdrain = betap * vgst * vgst * invdenom * lfact;                  // :286
      gm  = betap * vgst * (1 + denom) * invdenom * invdenom * lfact;   // :287-288
      gds = beta * vgst * vgst * invdenom *
            (params.ALPHA * afact * afact * prod + lfact * params.LAMBDA); // :289-291
    }
  }
} else {
  // mesload.c:294-333 — inverse mode (vds < 0), driven by vgd.
  const vgdt = vgd - params.VTO;                   // mesload.c:298
  if (vgdt <= 0) {                                 // mesload.c:299-305
    cdrain = 0; gm = 0; gds = 0;
  } else {
    const prod = 1 - params.LAMBDA * vds;          // mesload.c:310
    const betap = beta * prod;                     // mesload.c:311
    const denom = 1 + params.B * vgdt;             // mesload.c:312
    const invdenom = 1 / denom;                    // mesload.c:313
    if (-vds >= 3 / params.ALPHA) {                // mesload.c:314 — inverse saturation
      cdrain = -betap * vgdt * vgdt * invdenom;                        // :315
      gm  = -betap * vgdt * (1 + denom) * invdenom * invdenom;         // :316
      gds = params.LAMBDA * beta * vgdt * vgdt * invdenom - gm;        // :317-318
    } else {                                        // mesload.c:319-331 — inverse linear
      const afact = 1 + params.ALPHA * vds / 3;     // :323
      const lfact = 1 - afact * afact * afact;      // :324
      cdrain = -betap * vgdt * vgdt * invdenom * lfact;                // :325
      gm  = -betap * vgdt * (1 + denom) * invdenom * invdenom * lfact; // :326-327
      gds = beta * vgdt * vgdt * invdenom *
            (params.ALPHA * afact * afact * prod + lfact * params.LAMBDA) - gm; // :328-330
    }
  }
}
cd = cdrain - cgd;                                 // mesload.c:337
```

The `gds` operand order in each arm is load-bearing — keep the parenthesization
(`afact * afact * prod + lfact * MESlModulation`) exactly; do not reassociate.
In the inverse arms `gds … - gm` subtracts the freshly-computed `gm`
(`mesload.c:318, 330`).

### Charge storage + companion integration (`mesload.c:338-402`)

MES uses the `qggnew` helper (`mesload.c:464-496`) computing a 4-point
charge/conductance evaluation, distinct from JFET's per-junction depletion-cap
formula. The transient gate (`mesload.c:338-339`) matches JFET:
`(MODETRAN|MODEINITSMSIG)` OR `(MODETRANOP && MODEUIC)`.

```ts
// mesload.c:464-496 — qggnew: smoothed gate-charge model. Returns qggval and
// writes the two companion capacitances cgsnew/cgdnew.
function qggnew(
  vgs: number, vgd: number, phib: number, vcap: number, vto: number,
  cgs: number, cgd: number,
): { qgg: number; cgsnew: number; cgdnew: number } {
  const veroot = Math.sqrt((vgs - vgd) * (vgs - vgd) + vcap * vcap); // :472
  const veff1 = 0.5 * (vgs + vgd + veroot);        // :473
  const veff2 = veff1 - veroot;                    // :474
  const del = 0.2;                                 // :475
  const vnroot = Math.sqrt((veff1 - vto) * (veff1 - vto) + del * del); // :476
  let vnew1 = 0.5 * (veff1 + vto + vnroot);        // :477
  const vnew3 = vnew1;                             // :478
  const vmax = 0.5;                                // :479
  let ext: number;
  if (vnew1 < vmax) {                              // :480-485
    ext = 0;
  } else {
    vnew1 = vmax;
    ext = (vnew3 - vmax) / Math.sqrt(1 - vmax / phib);
  }
  const qroot = Math.sqrt(1 - vnew1 / phib);       // :487
  const qggval = cgs * (2 * phib * (1 - qroot) + ext) + cgd * veff2; // :488
  const par1 = 0.5 * (1 + (veff1 - vto) / vnroot); // :489
  const cfact = (vgs - vgd) / veroot;              // :490
  const cplus = 0.5 * (1 + cfact);                 // :491
  const cminus = cplus - cfact;                    // :492
  const cgsnew = cgs / qroot * par1 * cplus + cgd * cminus; // :493
  const cgdnew = cgs / qroot * par1 * cminus + cgd * cplus; // :494
  return { qgg: qggval, cgsnew, cgdnew };
}
```

The transient charge block reproduces `mesload.c:343-401`:

```ts
const capGate = (mode & (MODETRAN | MODEINITSMSIG)) !== 0
  || ((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0); // mesload.c:338-339
if (capGate) {
  const czgs = params.CGS * params.AREA;           // mesload.c:343
  const czgd = params.CGD * params.AREA;           // mesload.c:344
  const phib = params.PB;                          // mesload.c:345
  const vgs1 = s1[base + VGS];                     // mesload.c:346
  const vgd1 = s1[base + VGD];                     // mesload.c:347
  const vcap = 1 / params.ALPHA;                   // mesload.c:348
  // mesload.c:350-353 — 4-corner qggnew evaluation (Bernstein–Beleznay smoothing).
  const A = qggnew(vgs,  vgd,  phib, vcap, vto, czgs, czgd);
  const Bq = qggnew(vgs1, vgd,  phib, vcap, vto, czgs, czgd);
  const C = qggnew(vgs,  vgd1, phib, vcap, vto, czgs, czgd);
  const D = qggnew(vgs1, vgd1, phib, vcap, vto, czgs, czgd);
  if (mode & MODEINITTRAN) {                        // mesload.c:355-358
    s1[base + QGS] = A.qgg;
    s1[base + QGD] = A.qgg;
  }
  // mesload.c:359-362 — accumulate half-difference charge updates.
  s0[base + QGS] = s1[base + QGS] + 0.5 * (A.qgg - Bq.qgg + C.qgg - D.qgg);
  s0[base + QGD] = s1[base + QGD] + 0.5 * (A.qgg - C.qgg + Bq.qgg - D.qgg);
  const capgs = A.cgsna; // = A.cgsnew (mesload.c:363)
  const capgd = A.cgdna; // = A.cgdnew (mesload.c:364)

  // mesload.c:369-401 — store small-signal / integrate (skipped for UIC TRANOP).
  if (!((mode & MODETRANOP) && (mode & MODEUIC))) {
    if (mode & MODEINITSMSIG) {                     // mesload.c:371-374
      s0[base + QGS] = capgs;
      s0[base + QGD] = capgd;
      return;  // ngspice `continue` → skip stamps for this instance
    }
    if (mode & MODEINITTRAN) {                       // mesload.c:379-384
      s1[base + QGS] = s0[base + QGS];
      s1[base + QGD] = s0[base + QGD];
    }
    // mesload.c:385-388 — NIintegrate G-S charge: geq → ggs, companion → cg.
    {
      const { geq } = niIntegrate(ctx.method, ctx.order, capgs, ctx.ag,
        s0[base + QGS], s1[base + QGS], [s2[base + QGS], 0, 0, 0, 0],
        s1[base + CQGS]);
      // niIntegrate writes ccap; store into CQGS then read it back as ngspice
      // reads *(CKTstate0+MEScqgs) (mesload.c:388).
      s0[base + CQGS] = /* ccap */ ;
      ggs = ggs + geq;
      cg = cg + s0[base + CQGS];
    }
    // mesload.c:389-394 — NIintegrate G-D charge: geq → ggd, companion → cg/cd/cgd.
    {
      const { geq } = niIntegrate(ctx.method, ctx.order, capgd, ctx.ag,
        s0[base + QGD], s1[base + QGD], [s2[base + QGD], 0, 0, 0, 0],
        s1[base + CQGD]);
      s0[base + CQGD] = /* ccap */ ;
      ggd = ggd + geq;
      cg  = cg + s0[base + CQGD];                   // mesload.c:392
      cd  = cd - s0[base + CQGD];                   // mesload.c:393
      cgd = cgd + s0[base + CQGD];                  // mesload.c:394
    }
    if (mode & MODEINITTRAN) {                       // mesload.c:395-400
      s1[base + CQGS] = s0[base + CQGS];
      s1[base + CQGD] = s0[base + CQGD];
    }
  }
}
```

The `niIntegrate` call shape mirrors `njfet.ts:800-843` (capacitance, `ag`,
q0/q1, [q2,0,0,0,0] history, ccapPrev); the returned `ccap` is written to
`CQGS`/`CQGD` and read back into `cg`/`cd`/`cgd`, exactly as ngspice reads
`*(CKTstate0+MEScqgs)`/`MEScqgd` after `NIintegrate` (`mesload.c:388, 392-394`).

### Convergence + state write (`mesload.c:404-424`)

```ts
// mesload.c:406-415 — noncon bump (suppressed only when both MODEINITFIX
// and MODEUIC are set). Note the `|` (bitwise) in ngspice mesload.c:406.
if ((!(mode & MODEINITFIX)) || (!(mode & MODEUIC))) {
  if (icheck === 1
      || Math.abs(cghat - cg) >= ctx.reltol * Math.max(Math.abs(cghat), Math.abs(cg)) + ctx.iabstol
      || Math.abs(cdhat - cd) >  ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(cd)) + ctx.iabstol) {
    ctx.noncon.value++;
  }
}
// mesload.c:416-424 — write accepted state to state0.
s0[base + VGS] = vgs; s0[base + VGD] = vgd;
s0[base + CG]  = cg;  s0[base + CD]  = cd;  s0[base + CGD] = cgd;
s0[base + GM]  = gm;  s0[base + GDS] = gds; s0[base + GGS] = ggs; s0[base + GGD] = ggd;
```

Note `mesload.c:407` uses `(fabs(cghat-cg) >= …)` and `mesload.c:410` uses
`(fabs(cdhat-cd) > …)` — the cg test is `>=`, the cd test is `>`; reproduce both
exactly (matches `njfet.ts:860, 862`).

### RHS + Y-matrix stamps (`mesload.c:428-457`)

```ts
const m = params.M;                                // mesload.c:430
// mesload.c:432-434 — equivalent source currents (polarity = MEStype).
const ceqgd = polarity * (cgd - ggd * vgd);
const ceqgs = polarity * ((cg - cgd) - ggs * vgs);
const cdreq = polarity * ((cd + cgd) - gds * vds - gm * vgs);
// mesload.c:435-439 — RHS to gate / drainPrime / sourcePrime.
stampRHS(ctx.rhs, nodeG, m * (-ceqgs - ceqgd));
stampRHS(ctx.rhs, dp,    m * (-cdreq + ceqgd));
stampRHS(ctx.rhs, sp,    m * (cdreq + ceqgs));
// mesload.c:443-457 — Y-matrix stamps via cached handles, m-scaled.
solver.stampElement(this._hDDP,  m * (-gdpr));            // :443 MESdrainDrainPrimePtr
solver.stampElement(this._hGDP,  m * (-ggd));             // :444 MESgateDrainPrimePtr
solver.stampElement(this._hGSP,  m * (-ggs));             // :445 MESgateSourcePrimePtr
solver.stampElement(this._hSSP,  m * (-gspr));            // :446 MESsourceSourcePrimePtr
solver.stampElement(this._hDPD,  m * (-gdpr));            // :447 MESdrainPrimeDrainPtr
solver.stampElement(this._hDPG,  m * (gm - ggd));         // :448 MESdrainPrimeGatePtr
solver.stampElement(this._hDPSP, m * (-gds - gm));        // :449 MESdrainPrimeSourcePrimePtr
solver.stampElement(this._hSPG,  m * (-ggs - gm));        // :450 MESsourcePrimeGatePtr
solver.stampElement(this._hSPS,  m * (-gspr));            // :451 MESsourcePrimeSourcePtr
solver.stampElement(this._hSPDP, m * (-gds));             // :452 MESsourcePrimeDrainPrimePtr
solver.stampElement(this._hDD,   m * (gdpr));             // :453 MESdrainDrainPtr
solver.stampElement(this._hGG,   m * (ggd + ggs));        // :454 MESgateGatePtr
solver.stampElement(this._hSS,   m * (gspr));             // :455 MESsourceSourcePtr
solver.stampElement(this._hDPDP, m * (gdpr + gds + ggd)); // :456 MESdrainPrimeDrainPrimePtr
solver.stampElement(this._hSPSP, m * (gspr + gds + gm + ggs)); // :457 MESsourcePrimeSourcePrimePtr
```

The bypass `goto load` (`mesload.c:210, 428`) is handled exactly as JFET
(`njfet.ts:642-644, 853` — a `bypassed` flag skips the recompute block and
falls straight to the stamp phase using the reloaded state values).

### `getPinCurrents` (`mes.c:37-38` `MES_CS`/`MES_POWER`; state reads)

Mirror `njfet.ts:978-988`: `id = polarity * s0[CD]`, `ig = polarity * s0[CG]`,
`iS = -(ig + id)`. Pin order `[G, S, D]` matches the pin declarations.

## Part F — AC small-signal stamp (rebuild of `MESacLoad`)

`MESacLoad` (`mesacl.c:15-72`) reads the operating-point conductances + gate
charges from `CKTstate0`, scales the charges by `CKTomega` to susceptances, and
stamps the complex Y matrix. Reconstruct as `stampAc`, mirroring
`njfet.ts:926-976`:

```ts
stampAc(solver: SparseSolverStamp, omega: number, _ctx, _rhsRe, _rhsIm): void {
  const s0 = this._pool.states[0];
  const base = this._stateBase;
  const m = this._params.M;                        // mesacl.c:36
  // mesacl.c:38-45 — dc conductances + state0 conductances/charges.
  const gdpr = this._mt.drainConduct  * this._params.AREA;  // mesacl.c:38
  const gspr = this._mt.sourceConduct * this._params.AREA;  // mesacl.c:39
  const gm  = s0[base + GM];                        // mesacl.c:40
  const gds = s0[base + GDS];                       // mesacl.c:41
  const ggs = s0[base + GGS];                       // mesacl.c:42
  const xgs = s0[base + QGS] * omega;               // mesacl.c:43
  const ggd = s0[base + GGD];                       // mesacl.c:44
  const xgd = s0[base + QGD] * omega;               // mesacl.c:45
  // mesacl.c:46-67 — Y stamps. Real (conductance) → cell; imag (susceptance)
  // → +1 half via stampElementImag. Each ngspice `-=` rendered as a negated stamp.
  solver.stampElement(this._hDD,    m * (gdpr));                    // mesacl.c:46
  solver.stampElement(this._hGG,    m * (ggd + ggs));              // mesacl.c:47
  solver.stampElementImag(this._hGG, m * (xgd + xgs));             // mesacl.c:48
  solver.stampElement(this._hSS,    m * (gspr));                   // mesacl.c:49
  solver.stampElement(this._hDPDP,  m * (gdpr + gds + ggd));       // mesacl.c:50
  solver.stampElementImag(this._hDPDP, m * (xgd));                 // mesacl.c:51
  solver.stampElement(this._hSPSP,  m * (gspr + gds + gm + ggs));  // mesacl.c:52
  solver.stampElementImag(this._hSPSP, m * (xgs));                 // mesacl.c:53
  solver.stampElement(this._hDDP,   -(m * (gdpr)));                // mesacl.c:54 (-=)
  solver.stampElement(this._hGDP,   -(m * (ggd)));                 // mesacl.c:55 (-=)
  solver.stampElementImag(this._hGDP, -(m * (xgd)));               // mesacl.c:56 (-=)
  solver.stampElement(this._hGSP,   -(m * (ggs)));                 // mesacl.c:57 (-=)
  solver.stampElementImag(this._hGSP, -(m * (xgs)));               // mesacl.c:58 (-=)
  solver.stampElement(this._hSSP,   -(m * (gspr)));                // mesacl.c:59 (-=)
  solver.stampElement(this._hDPD,   -(m * (gdpr)));                // mesacl.c:60 (-=)
  solver.stampElement(this._hDPG,   m * (-ggd + gm));              // mesacl.c:61 (+=)
  solver.stampElementImag(this._hDPG, -(m * (xgd)));               // mesacl.c:62 (-=)
  solver.stampElement(this._hDPSP,  m * (-gds - gm));              // mesacl.c:63 (+=)
  solver.stampElement(this._hSPG,   m * (-ggs - gm));              // mesacl.c:64 (+=)
  solver.stampElementImag(this._hSPG, -(m * (xgs)));               // mesacl.c:65 (-=)
  solver.stampElement(this._hSPS,   -(m * (gspr)));                // mesacl.c:66 (-=)
  solver.stampElement(this._hSPDP,  -(m * (gds)));                 // mesacl.c:67 (-=)
}
```

Each stamp's sign and operand order is taken verbatim from `mesacl.c:46-67`. The
additive solver primitives have no subtract variant, so each ngspice `-=` is
rendered as a stamp of the negated cell expression, preserving the operand order
inside the parentheses (the JFET `stampAc` posture, `njfet.ts:951-976`).

## Part G — LTE truncation (rebuild of `MEStrunc`) + the UIC seed

### `MEStrunc` → `getLteTimestep` (`mestrunc.c:15-29`)

`MEStrunc` calls `CKTterr` on the two gate charges `MESqgs`/`MESqgd`
(`mestrunc.c:24-25`). Reconstruct as `getLteTimestep`, mirroring
`njfet.ts:1042-1070` with the QGS/CQGS and QGD/CQGD pairs:

```ts
// mestrunc.c:24-25 — CKTterr on MESqgs and MESqgd; min over both.
const pairs: [number, number][] = [[QGS, CQGS], [QGD, CQGD]];
// … same cktTerr loop as njfet.ts:1059-1068, returning min dt.
```

### UIC initial-condition seed

The UIC seed is already in the Part-E load dispatch (`mesload.c:113-118`): when
`MODEINITJCT && MODETRANOP && MODEUIC`, `vds = type*ICVDS; vgs = type*ICVGS;
vgd = vgs - vds`. With no netlisted `ic`, `ICVDS`/`ICVGS` default to `0`, so the
seed reduces to `vgs = vgd = 0` — the behavioral change is observable only when
the user netlists `ic=`/`icvds=`/`icvgs=`. This satisfies the `mesparam.c#h001`
(`MES_IC` parse) and `mesload.c#h001` (UIC seed) blocked hunks.

### Attribute mapping (`ic=` vector split)

The component definition's `attributeMap` (mirror `njfet.ts:1203-1206` +
`emitGroup` on `ICVDS`/`ICVGS` like `njfet.ts:101-102`) splits a bare
`ic=vds[,vgs]` into the scalar `ICVDS`/`ICVGS` writes at parse time, `vds`
first, reproducing the `MES_IC` `case 2 → case 1` fallthrough
(`mesparam.c:46-57`). `ic=vds` sets `ICVDS` only; `ic=vds,vgs` sets both.

## Part H — `MESgetic` operating-point IC capture (DEFERRED per #14)

`MESgetic` (`mesgetic.c:15-41`) runs at the `.ic`-without-explicit-values path:
for each instance, if `MESicVDSGiven`/`MESicVGSGiven` is FALSE, it captures the
external-node voltage difference from the converged operating-point rhs:

```ts
// mesgetic.c:28-37 — capture IC from the operating point when the netlist did
// not supply icvds/icvgs. Uses EXTERNAL nodes (drain/gate/source, not prime).
getic(ctx: <engine IC context>): void {
  if (!this._icVDSGiven) {
    this._params.ICVDS = ctx.nodeVoltage(this.pinNodes.get("D")!)
                       - ctx.nodeVoltage(this.pinNodes.get("S")!); // mesgetic.c:29-31
  }
  if (!this._icVGSGiven) {
    this._params.ICVGS = ctx.nodeVoltage(this.pinNodes.get("G")!)
                       - ctx.nodeVoltage(this.pinNodes.get("S")!); // mesgetic.c:34-36
  }
}
```

**Per #14 (`OPEN-QUESTIONS-WORKLOG.md:77, 204-224`):** digiTS has NO
engine→device IC-capture dispatch today (verified: `AnalogElement`,
`element.ts:43-145`, has no `getic`/`setic`; whole-`src/` grep for
`getic|setic|DEVsetic` → zero matches). Part H is implemented **iff** the engine
exposes such a hook. Otherwise it is deferred to the engine-subsystem planner;
Parts A–G ship standalone and satisfy every blocked hunk in this recon
(including `mesgetic.c#h001`, which is an accessor-rename / `GENinstance`
plumbing delta atop whatever IC-capture structure exists — the field
`_icVDSGiven`/`_icVGSGiven` it needs is delivered by Part A regardless of the
hook). This matches the jfet/jfet2 Part-D deferral exactly
(`jfet-initialConditions.md` Part D, `OPEN-QUESTIONS-WORKLOG.md:215-221`).

## Part I — Component definitions + registration

Two `StandaloneComponentDefinition`s (`NMesfetDefinition` / `PMesfetDefinition`)
mirror `NJfetDefinition` (`njfet.ts:1216-1238`): pins `G`/`D`/`S`
(`mes.c:66-70`), category `SEMICONDUCTORS`, `modelRegistry."spice"` with
`paramDefs`/`params` from Part A, `defaultModel: "spice"`. Each definition has
its own render element class (`NMesfetElement` / `PMesfetElement` extending
`AbstractCircuitElement`) — the MESFET symbol; reuse the JFET geometry as the
visual base (3-terminal G/D/S), distinguished per channel polarity. Register
both in `register-all.ts` alongside the JFET pair (`register-all.ts:154-155` for
the import, plus the registration block). The analog factories
`createNMesfetElement` / `createPMesfetElement` return the pool-backed element
classes.

## Acceptance criteria

1. `src/components/semiconductors/mesfet.ts` exists and exports `NMesfetDefinition`
   + `PMesfetDefinition` (two components, #26), `createNMesfetElement` /
   `createPMesfetElement` analog factories, `MesfetParams`, and `MES_SCHEMA`.
   Both are registered in `register-all.ts`; `NGSPICE_LOAD_ORDER.MES = 31`, the
   `DeviceFamily` union, family map, and pin-layout map all carry
   `NMESFET`/`PMESFET` (Part A engine-wiring table).
2. `MesfetParams` declares every model param (`VTO`, `ALPHA`, `BETA`, `LAMBDA`,
   `B`, `RD`, `RS`, `CGS`, `CGD`, `PB`, `IS`, `FC`, `KF`, `AF`) with the
   `messetup.c:32-73` defaults, and the instance params (`AREA`, `M`, `ICVDS`,
   `ICVGS`, `OFF`) per the Part-A tables. `KF`/`AF` parse but feed no evaluation
   path (#51). `nmf`/`pmf` are NOT params — they select the component (#26).
3. `MES_SCHEMA` declares the 13 state slots `VGS … CQGD` per `mesdefs.h:150-162`
   (`MESnumStates = 13`, `mesdefs.h:15`). Tests resolve slots by name via the
   schema; no raw `SLOT_*` import. The `MESdCoeffs[27]` distortion array and
   `MESnVar` noise array are NO-COUNTERPART.
4. `setParam` handles all params hot-loadably on all three surfaces, setting
   `_icVDSGiven`/`_icVGSGiven` on `ICVDS`/`ICVGS` writes (`mesparam.c:32-39`) and
   re-running the Part-D model-temp recompute after any `RD`/`RS`/`PB`/`FC`/`IS`
   write. The `ic=vds[,vgs]` vector splits `vds`-first (`mesparam.c:46-57`
   fallthrough).
5. `setup()` creates the source-prime node FIRST then the drain-prime node, each
   only when the respective model resistance is non-zero (`messetup.c:88-131`),
   and allocates the 15 matrix pointers in the exact `messetup.c:139-153` order
   (Part C table). `MESunsetup` is NO-COUNTERPART (fresh-engine-per-compile).
6. The model-temp pass (`MEStemp`, `mestemp.c:29-49`) computes
   `drainConduct`/`sourceConduct`/`depletionCap`/`f1`/`f2`/`f3`/`vcrit` once from
   params (temperature-independent: `MEStemp` ignores `ckt`), with the literal
   `(1-0.5)`/`(1+0.5)` preserved and `vcrit = VT*log(VT/(Math.SQRT2*IS))`
   (`CONSTvt0`→`VT`, `CONSTroot2`→`Math.SQRT2`).
7. `load()` is the full v26 Statz model (#52) ported line-for-line from
   `mesload.c:97-461`: the mode dispatch (`:106-227`) with the genuine UIC seed
   (`:113-118`), the `-3*VT` cubic gate-junction currents with `<=` and `CONSTe`→
   `Math.E` (`:233-254`), the Statz normal/inverse cutoff/saturation/linear drain
   current with `MESalpha` and the load-bearing `gds` operand order
   (`:258-333`), the `qggnew` 4-corner charge model (`:464-496`) + `niIntegrate`
   companion integration (`:343-401`), the `>=`/`>` noncon tests (`:406-415`),
   the state-write (`:416-424`), and the RHS + 15 Y stamps (`:432-457`) with
   `polarity = MEStype`. No simplified Statz variant.
8. `stampAc()` reproduces `MESacLoad` (`mesacl.c:46-67`) cell-for-cell: real
   terms via `stampElement`, susceptance terms (`*omega`) via `stampElementImag`
   to the `+1` half, each `-=` rendered as a negated stamp, operand order
   verbatim.
9. `getLteTimestep()` reproduces `MEStrunc` (`mestrunc.c:24-25`): `cktTerr` on
   `QGS`/`CQGS` and `QGD`/`CQGD`, min over both.
10. Part H (`MESgetic` capture, `mesgetic.c:28-37`) is implemented **iff** the
    analog engine exposes a `getic`/`setic` element hook; otherwise deferred to
    the engine-subsystem planner per #14, with Parts A–G delivered standalone
    (the `_icVDSGiven`/`_icVGSGiven` fields it would need are delivered by Part A
    regardless).
11. With `mes#recon/wholeClass` `APPLIED`, the 12 blocked v41 hunks (next
    section) apply onto the reconstructed baseline as ordinary per-hunk deltas.
    `node spec/v41-port/build-ledger.mjs` re-runs cleanly with the recon
    `APPLIED` and the 12 hunks unblocked.
12. A DC-OP and a `.tran` run on a canonical MESFET fixture — at minimum one
    `NMESFET` (`NMF`) and one `PMESFET` (`PMF`) instance with non-zero `RD`/`RS`
    (so the prime nodes exist), non-zero `CGS`/`CGD` (so the charge model runs),
    and a `LAMBDA`/`B`/`ALPHA` exercising both saturation and linear Statz
    regions — produce per-NR-iteration internal node voltages, branch currents,
    the Jacobian (matrix) cells, and the state vector matching the ngspice DLL at
    every accepted step and iteration. An AC sweep on the same fixture matches
    the ngspice `MESacLoad` complex matrix. Verified via the `harness_*` MCP tool
    chain: `harness_start` → `harness_run` (and `harness_run_ac`) →
    `harness_first_divergence` → `harness_topology_diff` / `harness_matrix_diff`
    → `harness_get_attempt`, with `firstDivergence.earliest` null across all four
    signal classes (voltage / matrix / state / shape) and `harness_topology_diff`
    reporting no element/node/branch slot-order divergence. Bit-exact under the
    matched-arithmetic-order constraint — no tolerance qualifier. The harness
    netlist-generator MUST be able to emit the fixture's MESFET instances: the
    coupled edit adds the `NMESFET`/`PMESFET` `ELEMENT_SPECS` rows (prefix `Z`,
    model `NMF`/`PMF`) and the `Z`-prefix `emitPrimitive` branch
    (`netlist-generator.ts:52-53, 661-668`) so the ngspice deck carries the same
    MESFET cards digiTS evaluates; without this the harness cannot generate a
    comparable deck and the gate is unrunnable.

## Blocked hunks (apply after the recon)

These 12 v41 hunks are `blockedBy: mes#recon/wholeClass` in `ledger.json`
(`ledger.json:62693-62704`) and apply as ordinary per-hunk deltas once the
baseline above is `APPLIED`:

| Hunk | ngspice anchor | what it adds onto the baseline |
|---|---|---|
| `mes/mes.c#h001` | `mes.c:12-64` (`MESpTable`/`MESmPTable`) | IFparm table accessor/plumbing delta atop the reconstructed param defs |
| `mes/mesacl.c#h001` | `mesacl.c:15-72` (`MESacLoad`) | accessor-rename / `GENmodel` plumbing delta atop the reconstructed AC stamp (Part F) |
| `mes/mesdefs.h#h004` | `mesdefs.h` | portable state-count `#define`/`GENmodel` embed delta atop `MES_SCHEMA` (Part A); compare to the jfet `jfetdefs#h003` correction (`OPEN-QUESTIONS-WORKLOG.md:423-424`) — verify the actual `#h004` content is the state-count define, not the noise-`#define` removal |
| `mes/mesgetic.c#h001` | `mesgetic.c:15-41` (`MESgetic`) | accessor-rename / `GENinstance` plumbing delta atop the IC-capture structure (Part H; the `_icVDSGiven`/`_icVGSGiven` it needs come from Part A) |
| `mes/mesload.c#h001` | `mesload.c:21-461` (`MESload`) | accessor-rename / `GENmodel` plumbing delta atop the reconstructed Statz load (Part E) |
| `mes/mesparam.c#h001` | `mesparam.c:23-62` (`MESparam`) | instance-param setter delta atop the reconstructed parse (Part B), incl. the `MES_IC` fallthrough |
| `mes/mesparam.c#h002` | `mesparam.c:43-58` (`MES_IC`) | FALLTHROUGH-comment / `MES_IC` vector-parse cosmetic atop Part B |
| `mes/messetup.c#h001` | `messetup.c:88-131` (prime-node creation) | node-creation / `CKTcopyNodesets` delta atop Part C |
| `mes/messetup.c#h002` | `messetup.c:139-153` (TSTALLOC) | matrix-pointer-allocation delta atop Part C's 15-pointer sequence |
| `mes/messetup.c#h003` | `messetup.c:15-86` (defaults sweep + state alloc) | model-default / state-base-allocation delta atop Part A defaults + Part C state alloc |
| `mes/mestemp.c#h001` | `mestemp.c:29-49` (`MEStemp`) | model-temp-derivation delta atop Part D |
| `mes/mestrunc.c#h001` | `mestrunc.c:24-25` (`MEStrunc`) | LTE-truncation delta atop Part G's `getLteTimestep` |

(The remaining mes hunks — `mesdisto.c#h001`/`mesnoise.c#h001-003` distortion +
noise, `mesdel.c`/`mesdest.c`/`mesmdel.c`/`mesdset.c`/`mespzld.c` C-free
teardown / distortion-setup / PZ-load, `mesinit.c`/`mesext.h`/`Makefile.am` build
plumbing — are resolved independently as PORT / NO-COUNTERPART per their
`ledger.json` planningNotes: distortion + noise are out of digiTS analysis scope,
PZ analysis is out of scope, and the C-free / build files have no per-element
counterpart in the fresh-engine-per-compile architecture. They do NOT block on
this recon.)

## BUILD NOTE — run-1 gate-fail fix (FIX-011)

When you register `NMESFET`/`PMESFET` you add them to all three tables in
`src/solver/analog/ngspice-load-order.ts` plus the `DeviceFamily` union value
`"MES"`. You MUST ALSO add `"MES"` to `DECK_EMITTING_FAMILIES` in
`src/solver/analog/ngspice-load-order-audit.ts:10-34`. MES is deck-emitting;
omitting that entry makes `auditNgspiceLoadOrderTables` throw at
`createDefaultRegistry` (register-all.ts:584) — "typeId NMESFET/PMESFET is in
TYPE_ID_TO_DECK_PIN_LABEL_ORDER but family MES is not deck-emitting" — reding the
ENTIRE analog compile gate. In run 1 the class built in-worktree but the gate went
RED post-rebase on this single missing row.

Status: RATIFIED 2026-05-30 (user, batch); REVISED 2026-05-31 (precondition fix, pending re-review)
