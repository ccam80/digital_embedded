# Reconstruction spec — `jfet2#recon/wholeClass`

Build the complete **Parker-Skellern (PS)** short-channel JFET2 field-effect
transistor device on a new `src/components/semiconductors/jfet2.ts`, faithful to
the ngspice baseline (A.E. Parker, Macquarie University 1994). This is a
**whole-class build**: digiTS has no JFET2 element today (`jfet2.ts` does not
exist), so the reconstruction stands up the full device — the PS-model parameter
set, the drain-current + rate-dependent threshold trapping (`vtrap`/`vgstrap`) +
thermal-reduction model, the Statz-based gate-charge model, the depletion-cap
temperature corrections, the prime-node series resistances (`rd`/`rs`), the
DC/transient `load()`, the AC small-signal `acLoad()`, the temperature pass, the
LTE/`trunc` hook, the instance/model parameter setters, and the `.ic`/UIC
initial-condition seed.

`jfet2` is an **IN** device class (`device-class-scope.md:51` — "Missing —
declares `jfet2#recon/wholeClass`. Parker-Skellern model never ported."). The
IN-class completeness rule forbids OMITTING ngspice behavior: the entire PS
model (the `psmodel.c` `PSids`/`qgg`/`PScharge`/`PSacload`/`PSinstanceinit`
routines, the full `jfet2parm.h` 30-param model card, the trap/thermal state
slots) must be rebuilt bit-exact. Because JFET2 was **never** ported to digiTS,
this reconstruction targets the ngspice baseline so the v41 diff hunks
(`jfet2/...#h00x`) apply onto it as ordinary per-hunk deltas afterward.

This spec implements the **RESOLVED** rulings of the frozen open questions
governing this device:

- **OQ-JFET2-SHAPE** (#24, `OPEN-QUESTIONS-WORKLOG.md:87`, detail
  `:359-360`): **TWO components** `Jfet2N` / `Jfet2P` — channel polarity is the
  invariant two-component axis (the NJFET/PJFET precedent: one ngspice class +
  `JFET2type` model flag → two digiTS components). Recommended implementation: a
  single polarity-parameterized factory file (the MOS/BJT/VDMOS precedent,
  `vdmos.ts`) to avoid duplicating the PS body. Harness-invisible (Z/JFET2 card
  is `typeId`-driven), no new generator plumbing.
- **OQ-JFET2-PSMODEL** (#25, `OPEN-QUESTIONS-WORKLOG.md:88`, detail `:361`):
  **INLINE** — the Parker-Skellern model core lives inline in `jfet2.ts`
  (consistent with device model math living in-file, the `njfet.ts`/`vdmos.ts`
  pattern). No separate `psmodel.ts` glue module.
- **OQ-JFET2-GETIC** (#13, `OPEN-QUESTIONS-WORKLOG.md:76`, detail `:204-224`):
  **Defer Part J (`JFET2getic` capture) to the engine phase.** digiTS has no
  engine→device IC-capture dispatch (`DEVsetic`); a whole-`src/` grep for
  `getic|setic|DEVsetic` returns zero matches. Parts A–I (params, state, setup,
  temp, PS core, load, acLoad, trunc, the UIC *seed* in `load()`, the `ic=`
  parse) are self-contained element edits that ship now and satisfy every
  blocked hunk. Part J is engine-subsystem work taken up when the engine
  diff-docs are ported; it does NOT block device completion.
- **OQ-JFET2-NUMSTATES** (#48, `OPEN-QUESTIONS-WORKLOG.md:111`, detail
  `:427-430`): the `jfet2defs.h#h003` state-count change (18→19 + the new
  `JFET2unknown` slot) is split — `#h003a` (portable state-count, → this recon's
  `JFET2_SCHEMA.size = 19`) is PENDING-blocked by this recon; `#h003b` (GENmodel
  C-plumbing) is NO-COUNTERPART.

Authoring contract: this spec is **documentation**. No code. No tests. The
implementer authors the TypeScript against this spec; the verifier checks the
edit against the ngspice citations herein. Per `CLAUDE.md` comment-hygiene:
every reconstructed source comment cites the current
`ref/ngspice/src/spicelib/devices/jfet2/<file>:line` and explains the mechanism
in present tense — no `v26`/`v41`/era tags, no migration narrative.

## Current digiTS state

`src/components/semiconductors/jfet2.ts` **does not exist** (verified — `Read`
returns "File does not exist"). There is no JFET2 element, no JFET2 model-param
set, no JFET2 state schema, no JFET2 registration. The reconstruction creates
the file whole.

The closest existing analog is `njfet.ts` (the Shichman-Hodges JFET), which
this reconstruction mirrors structurally — but the JFET2 device math is the
Parker-Skellern model (`psmodel.c`), NOT Shichman-Hodges, so only the scaffolding
(state-pool plumbing, prime-node alloc, TSTALLOC sequence, the `cktMode`
voltage-dispatch ladder, the `NIintegrate` lump pattern, the RHS/Y stamps, the
two-polarity component split) is shared; the drain-current, gate-charge, and AC
routines are entirely PS-specific.

The two-polarity factory precedent is `vdmos.ts` (`vdmos.ts:1-21`): one file,
one `PoolBackedAnalogElement` subclass parameterized by a polarity literal, two
`StandaloneComponentDefinition`s (`VdmosNDefinition`/`VdmosPDefinition`) seeding
`JFET2type` = `+1`/`-1` via their default model. `jfet2.ts` follows it exactly:
`Jfet2NDefinition` (`JFET2type = NJF = +1`) and `Jfet2PDefinition`
(`JFET2type = PJF = -1`).

Registration: `src/components/register-all.ts` registers both `Jfet2N` and
`Jfet2P`. The netlist generator (`netlist-generator.ts`) emits the JFET2 as a
`Z` card with an `njf`/`pjf` `.model` (harness-invisible per OQ-JFET2-SHAPE).

## Part A — Model parameter set (`jfet2parm.h` + `jfet2defs.h` model struct)

The PS model card is the `PARAM(...)` table in `jfet2parm.h:15-54`, plus the
`vbi`/`pb` and `vt0`/`vto` aliases and the derived model fields in
`jfet2defs.h:202-211`. Every parameter is rebuilt with its ngspice default.

### Model parameters (`JFET2_PARAM_DEFS`, `defineModelParams`)

ngspice `id` codes and defaults are read directly from `jfet2parm.h`. The
`spiceName` is the ngspice token (first `PARAM` string column). `vbi`/`pb` are
aliases writing the same field (`JFET2phi`); `vt0`/`vto` are aliases writing
`JFET2vto`.

| digiTS param | ngspice token | id | default | `jfet2parm.h` line | meaning |
|---|---|---|---|---|---|
| `ACGAM`  | `acgam`  | 107 | `0`     | `:15` | capacitance vds modulation |
| `AF`     | `af`     | 108 | `1`     | `:16` | flicker noise exponent (noise NC — see Part L) |
| `BETA`   | `beta`   | 109 | `1e-4`  | `:17` | transconductance parameter |
| `CAPDS`  | `cds`    | 146 | `0`     | `:18` | D-S junction capacitance (PARAMA: area-scaled) |
| `CAPGD`  | `cgd`    | 110 | `0`     | `:19` | G-D junction capacitance (PARAMA) |
| `CAPGS`  | `cgs`    | 111 | `0`     | `:20` | G-S junction capacitance (PARAMA) |
| `DELTA`  | `delta`  | 113 | `0`     | `:21` | coef of thermal current reduction |
| `HFETA`  | `hfeta`  | 114 | `0`     | `:22` | drain feedback modulation |
| `HFE1`   | `hfe1`   | 115 | `0`     | `:23` | ac source feedback vgd modulation |
| `HFE2`   | `hfe2`   | 116 | `0`     | `:24` | ac source feedback vgs modulation |
| `HFG1`   | `hfg1`   | 117 | `0`     | `:25` | ac drain feedback vgs modulation |
| `HFG2`   | `hfg2`   | 118 | `0`     | `:26` | ac drain feedback vgd modulation |
| `MVST`   | `mvst`   | 119 | `0`     | `:27` | subthreshold vds modulation index |
| `MXI`    | `mxi`    | 120 | `0`     | `:28` | saturation potential modulation |
| `FC`     | `fc`     | 121 | `0.5`   | `:29` | forward bias junction fit param |
| `IBD`    | `ibd`    | 122 | `0`     | `:30` | breakdown current of diode jnc |
| `IS`     | `is`     | 123 | `1e-14` | `:31` | gate junction saturation current |
| `FNCOEF` | `kf`     | 124 | `0`     | `:32` | flicker noise coefficient (noise NC) |
| `LAMBDA` | `lambda` | 125 | `0`     | `:33` | channel length modulation |
| `LFGAM`  | `lfgam`  | 126 | `0`     | `:34` | dc drain feedback |
| `LFG1`   | `lfg1`   | 127 | `0`     | `:35` | dc drain feedback vgs modulation |
| `LFG2`   | `lfg2`   | 128 | `0`     | `:36` | dc drain feedback vgd modulation |
| `N`      | `n`      | 129 | `1`     | `:37` | gate junction ideality factor |
| `P`      | `p`      | 130 | `2`     | `:38` | power law (triode region) |
| `PHI`    | `vbi`/`pb` | 131 | `1`   | `:39-40` | gate junction potential (alias pair) |
| `Q`      | `q`      | 132 | `2`     | `:41` | power law (saturated region) |
| `RD`     | `rd`     | 133 | `0`     | `:42` | drain ohmic resistance |
| `RS`     | `rs`     | 134 | `0`     | `:43` | source ohmic resistance |
| `TAUD`   | `taud`   | 135 | `0`     | `:44` | thermal relaxation time |
| `TAUG`   | `taug`   | 136 | `0`     | `:45` | drain feedback relaxation time |
| `VBD`    | `vbd`    | 137 | `1`     | `:46` | breakdown potential of diode jnc |
| `VER`    | `ver`    | 139 | `0`     | `:47` | version number of PS model |
| `VST`    | `vst`    | 140 | `0`     | `:48` | crit poten subthreshold conductn |
| `VTO`    | `vt0`/`vto`| 141 | `-2`  | `:49-50` | threshold voltage (alias pair) |
| `XC`     | `xc`     | 142 | `0`     | `:51` | amount of cap reduction at pinch-off |
| `XI`     | `xi`     | 143 | `1000`  | `:52` | velocity saturation index |
| `Z`      | `z`      | 144 | `1`     | `:53` | rate of velocity saturation |
| `HFGAM`  | `hfgam`  | 145 | `model->JFET2lfgam` | `:54` | high freq drain feedback (default = LFGAM, see note) |
| `TNOM`   | `tnom`   | 104 | `REFTEMP` | `jfet2mpar.c:24-27` | nominal parameter temperature (CtoK convert) |

**`hfgam` default** (`jfet2parm.h:54`): ngspice's `PARAM` default expression is
`model->JFET2lfgam` — i.e. when `hfgam` is not given, it defaults to the value
of `lfgam`. The `defineModelParams` static default cannot express a cross-param
default, so `HFGAM` declares a static default of `0` and the resolution
`HFGAM = hfgamGiven ? HFGAM : LFGAM` is applied in the temperature/instance-init
pass (Part D), reading `_hfgamGiven` from `props.isModelParamGiven("HFGAM")`.
This reproduces `jfet2set.c:36-38` (`if(!model->flag) {model->ref = default;}`)
where the default is the live `lfgam` field.

**Model-type aliases** (`jfet2parm.h:13`, `jfet2defs.h:223-232`): `vbi`/`pb`
(id 131, `JFET2_MOD_PB`) both write `PHI`; `vt0`/`vto` (id 141, `JFET2_MOD_VTO`)
both write `VTO`. `njf` (id 102, `JFET2_MOD_NJF`) and `pjf` (id 103,
`JFET2_MOD_PJF`) select the polarity — in digiTS these are the
`Jfet2N`/`Jfet2P` component identity, not a settable param (the default-model
seed sets `JFET2type`).

### Derived model fields (`jfet2defs.h:202-211`)

Computed in the temperature pass (Part D), NOT user params:

| ngspice field | digiTS field | `jfet2defs.h` line | source |
|---|---|---|---|
| `JFET2drainConduct`  | `drainConduct`  | `:202` | `jfet2temp.c:60-64` (`1/rd` or `0`) |
| `JFET2sourceConduct` | `sourceConduct` | `:203` | `jfet2temp.c:65-69` (`1/rs` or `0`) |
| `JFET2f2`            | `f2`            | `:204` | `jfet2temp.c:78` |
| `JFET2f3`            | `f3`            | `:205` | `jfet2temp.c:79` |
| `JFET2za`            | `za`            | `:206` | `psmodel.c:374` (`sqrt(1+Z)/2`) |
| `JFET2tnom`          | `TNOM`          | `:207` | model param |

### Instance parameters (`instance` group)

| digiTS param | ngspice token | id | default | unit | source |
|---|---|---|---|---|---|
| `AREA`  | `area`  | `JFET2_AREA`=1   | `1.0` | — | `jfet2par.c:37-39`, `jfet2set.c:44-46` |
| `ICVDS` | `icvds` | `JFET2_IC_VDS`=2 | `0.0` | V | `jfet2par.c:45-48` (+ `JFET2_IC` vec[0]) |
| `ICVGS` | `icvgs` | `JFET2_IC_VGS`=3 | `0.0` | V | `jfet2par.c:49-52` (+ `JFET2_IC` vec[1]) |
| `OFF`   | `off`   | `JFET2_OFF`=5    | `0` (flag) | — | `jfet2par.c:53-55` |
| `TEMP`  | `temp`  | `JFET2_TEMP`=6   | `300.15` | K | `jfet2par.c:29-32` (CtoK convert) |
| `DTEMP` | `dtemp` | `JFET2_DTEMP`=7  | `0.0` | K | `jfet2par.c:33-36` |
| `M`     | `m`     | `JFET2_M`=8      | `1.0` | — | `jfet2par.c:41-44`, `jfet2set.c:48-50` |

`JFET2_IC` (id 4, the bare `ic=vds[,vgs]` vector) is not a stored field — it is
a parse route writing `ICVDS`/`ICVGS` (Part I), mirroring the `njfet.ts`
`emitGroup: { name: "IC", index: 0/1 }` pattern (`njfet.ts:101-102`).

### `Jfet2Params` interface + `*Given` guards

Declare a `Jfet2Params` interface (all params above as `number`, plus the
`[key: string]: number` index signature, mirroring `JfetParams`
`njfet.ts:110-139`). The constructor reads each via
`props.getModelParam<number>("…")`.

`*Given` booleans read from `props.isModelParamGiven("…")` (mirroring
`njfet.ts:366-372`), needed where ngspice branches on givenness:

| Guard | ngspice field | used at |
|---|---|---|
| `_hfgamGiven` | `JFET2hfgGiven` | `jfet2parm.h:54` default-to-`lfgam` (Part D) |
| `_tnomGiven`  | `JFET2tnomGiven` | `jfet2temp.c:46-48` (default `CKTnomTemp`) |
| `_tempGiven`  | `JFET2tempGiven` | `jfet2temp.c:89-91` (default `CKTtemp + dtemp`) |
| `_dtempGiven` | `JFET2dtempGiven` | `jfet2temp.c:85-87` (default `0`) |
| `_icVDSGiven` | `JFET2icVDSGiven` | `jfet2load.c:86-88` UIC seed; Part J getic |
| `_icVGSGiven` | `JFET2icVGSGiven` | `jfet2load.c:86-88` UIC seed; Part J getic |
| `_areaGiven`  | `JFET2areaGiven` | `jfet2set.c:44-46` (default `1`) |
| `_mGiven`     | `JFET2mGiven`    | `jfet2set.c:48-50` (default `1`) |

### Identifier mapping (model card)

| ngspice identifier | digiTS identifier |
|---|---|
| `model->JFET2type`  | `this._polarity` (`+1` NJF, `-1` PJF) |
| `model->JFET2beta`  | `this._params.BETA` |
| `model->JFET2vto`   | `this._params.VTO` |
| `model->JFET2phi`   | `this._params.PHI` |
| `here->JFET2tGatePot` | `this._tp.tGatePot` (= PS macro `VBI`) |
| `here->JFET2tSatCur`  | `this._tp.tSatCur`  (= PS macro `IS`) |
| `here->JFET2area`     | `this._params.AREA` |
| `here->JFET2m`        | `this._params.M` |

## Part B — State schema (`jfet2defs.h:164-184`, the 19-slot pool)

`jfet2defs.h:164-184` defines 19 state offsets (`JFET2numStates = 19`,
`:184`). The reconstruction declares `JFET2_SCHEMA` via `defineStateSchema`
(mirroring `JFET_SCHEMA`, `njfet.ts:158-172`) with exactly these 19 slots in
ngspice offset order. `JFET2_SCHEMA.size` satisfies the portable state-count
sub-item `jfet2defs.h#h003a` (#48).

```ts
// jfet2defs.h:164-184 — the 19 PS-JFET2 state slots in ngspice offset order.
export const JFET2_SCHEMA: StateSchema = defineStateSchema("Jfet2Element", [
  { name: "VGS",     doc: "jfet2defs.h JFET2vgs=0" },
  { name: "VGD",     doc: "jfet2defs.h JFET2vgd=1" },
  { name: "CG",      doc: "jfet2defs.h JFET2cg=2" },
  { name: "CD",      doc: "jfet2defs.h JFET2cd=3" },
  { name: "CGD",     doc: "jfet2defs.h JFET2cgd=4" },
  { name: "GM",      doc: "jfet2defs.h JFET2gm=5" },
  { name: "GDS",     doc: "jfet2defs.h JFET2gds=6" },
  { name: "GGS",     doc: "jfet2defs.h JFET2ggs=7" },
  { name: "GGD",     doc: "jfet2defs.h JFET2ggd=8" },
  { name: "QGS",     doc: "jfet2defs.h JFET2qgs=9" },
  { name: "CQGS",    doc: "jfet2defs.h JFET2cqgs=10" },
  { name: "QGD",     doc: "jfet2defs.h JFET2qgd=11" },
  { name: "CQGD",    doc: "jfet2defs.h JFET2cqgd=12" },
  { name: "QDS",     doc: "jfet2defs.h JFET2qds=13" },
  { name: "CQDS",    doc: "jfet2defs.h JFET2cqds=14" },
  { name: "PAVE",    doc: "jfet2defs.h JFET2pave=15" },
  { name: "VTRAP",   doc: "jfet2defs.h JFET2vtrap=16 (PS VGDTRAP)" },
  { name: "VGSTRAP", doc: "jfet2defs.h JFET2vgstrap=17" },
  { name: "UNKNOWN", doc: "jfet2defs.h JFET2unknown=18 (spare; numStates=19)" },
]);
```

Slot indices are resolved by name through `JFET2_SCHEMA` per the project rule
(MEMORY: schema lookups over slot exports) — the implementer may declare local
`const SLOT_* = JFET2_SCHEMA.indexOf("…")` mirrors as `njfet.ts:175-187` does,
but they must equal these ngspice offsets. The PS-glue macros map onto the slots
thus (`psmodel.h:47-62`):

| PS macro | state slot | which CKTstate |
|---|---|---|
| `VGSTRAP_NOW` / `_BEFORE` | `VGSTRAP` (17) | `s0` / `s1` |
| `VGDTRAP_NOW` / `_BEFORE` | `VTRAP` (16) | `s0` / `s1` |
| `POWR_NOW` / `_BEFORE` | `PAVE` (15) | `s0` / `s1` |
| `QGS_NOW` / `_BEFORE` | `QGS` (9) | `s0` / `s1` |
| `QGD_NOW` / `_BEFORE` | `QGD` (11) | `s0` / `s1` |
| `VGS1` | `VGS` (0) | `s1` |
| `VGD1` | `VGD` (1) | `s1` |

Note `JFET2vtrap` (slot 16) is the *gate-drain* trap (PS `VGDTRAP`) and
`JFET2vgstrap` (slot 17) the *gate-source* trap (PS `VGSTRAP`) — the naming is
intentionally crossed in ngspice (`psmodel.h:47-50`); the reconstruction
preserves the exact slot↔macro binding above.

## Part C — Setup (rebuild of `JFET2setup`, `jfet2set.c:19-124`)

`JFET2setup` allocates the source-prime / drain-prime internal nodes (only when
`rs`/`rd` ≠ 0) and the 15 matrix elements via TSTALLOC. The reconstruction's
`setup(ctx)` mirrors `njfet.ts:413-457` structurally but the prime-node guard
reads the **model** `rs`/`rd` (`jfet2set.c:55, 77`) and the alloc order is
`jfet2set.c:106-120` (identical to JFET).

Model defaults applied at setup (`jfet2set.c:33-38`): the `JFET2type` validity
clamp (`:33-35`, NJF if neither NJF/PJF — moot in digiTS since the component
identity fixes polarity) and the `#include "jfet2parm.h"` default loop
(`:36-38`, `if(!model->flag) model->ref = default`). In digiTS the param
defaults come from `JFET2_PARAM_DEFAULTS`; the only cross-param default
(`hfgam` ← `lfgam`) is resolved in Part D.

### Internal-node allocation (`jfet2set.c:55-98`)

```ts
// jfet2set.c:55-76 — source-prime node iff rs != 0, else collapse to source.
if (this._params.RS === 0) {
  this._sourcePrimeNode = sourceNode;
} else {
  this._sourcePrimeNode = ctx.makeVolt(this.label, "source");
  this._internalLabels.push("source");
}
// jfet2set.c:77-98 — drain-prime node iff rd != 0, else collapse to drain.
if (this._params.RD === 0) {
  this._drainPrimeNode = drainNode;
} else {
  this._drainPrimeNode = ctx.makeVolt(this.label, "drain");
  this._internalLabels.push("drain");
}
```

Source-prime is allocated BEFORE drain-prime (`jfet2set.c:55` then `:77`),
matching `njfet.ts:425-436`. (The `CKTcopyNodesets` nodeset-propagation block,
`jfet2set.c:61-71, 83-93`, is engine-internal nodeset plumbing with no
device-numerical content — NO-COUNTERPART, the digiTS engine handles nodesets
at the node layer.)

### TSTALLOC sequence (`jfet2set.c:106-120`)

Identical 15-element order to JFET (`njfet.ts:442-456`). The order is
structurally visible at the harness CSC dump, so it is reproduced exactly:

```ts
// jfet2set.c:106-120 — 15 matrix elements in ngspice TSTALLOC order. The
// allocation order fixes the sparse element-pool layout (harness-visible).
this._hDDP  = solver.allocElement(drainNode,  dp);          // :106 drainDrainPrime
this._hGDP  = solver.allocElement(gateNode,   dp);          // :107 gateDrainPrime
this._hGSP  = solver.allocElement(gateNode,   sp);          // :108 gateSourcePrime
this._hSSP  = solver.allocElement(sourceNode, sp);          // :109 sourceSourcePrime
this._hDPD  = solver.allocElement(dp,         drainNode);   // :110 drainPrimeDrain
this._hDPG  = solver.allocElement(dp,         gateNode);    // :111 drainPrimeGate
this._hDPSP = solver.allocElement(dp,         sp);          // :112 drainPrimeSourcePrime
this._hSPG  = solver.allocElement(sp,         gateNode);    // :113 sourcePrimeGate
this._hSPS  = solver.allocElement(sp,         sourceNode);  // :114 sourcePrimeSource
this._hSPDP = solver.allocElement(sp,         dp);          // :115 sourcePrimeDrainPrime
this._hDD   = solver.allocElement(drainNode,  drainNode);   // :116 drainDrain
this._hGG   = solver.allocElement(gateNode,   gateNode);    // :117 gateGate
this._hSS   = solver.allocElement(sourceNode, sourceNode);  // :118 sourceSource
this._hDPDP = solver.allocElement(dp,         dp);          // :119 drainPrimeDrainPrime
this._hSPSP = solver.allocElement(sp,         sp);          // :120 sourcePrimeSourcePrime
```

(`JFET2unsetup`, `jfet2set.c:126-150`, is `CKTdltNNum` prime-node reclamation —
NO-COUNTERPART, the digiTS engine is fresh-per-`compile()`, the ratified
`ccvs`/`mos1` unsetup precedent, `OPEN-QUESTIONS-WORKLOG.md:383-388`.)

## Part D — Temperature pass (rebuild of `JFET2temp` + `PSinstanceinit`)

`JFET2temp` (`jfet2temp.c:23-119`) computes the model-level and per-instance
temperature corrections, then calls `PSinstanceinit` (`psmodel.c:362-377`) to
fill the derived PS fields. This is `computeJfet2TempParams(p, given)` returning
a `Jfet2TempParams` struct, invoked from the constructor and `computeTemperature`
(mirroring `njfet.ts:226-302, 999-1008`).

### Model-level corrections (`jfet2temp.c:46-79`)

```ts
// jfet2temp.c:46-48 — tnom defaults to circuit nominal temperature.
const tnom = given.tnomGiven ? p.TNOM : ctx.cktNomTemp;
// jfet2temp.c:49-58 — built-in-potential temperature reference math.
const vtnom = CONSTKoverQ * tnom;
const fact1 = tnom / REFTEMP;
const kt1 = CONSTboltz * tnom;
const egfet1 = 1.16 - (7.02e-4 * tnom * tnom) / (tnom + 1108);
const arg1 = -egfet1 / (kt1 + kt1) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + CHARGE * arg1);
const pbo = (p.PHI - pbfact1) / fact1;
const gmaold = (p.PHI - pbo) / pbo;
const cjfact = 1 / (1 + 0.5 * (4e-4 * (tnom - REFTEMP) - gmaold));
// jfet2temp.c:60-69 — drain/source conductance from rd/rs.
const drainConduct  = p.RD !== 0 ? 1 / p.RD : 0;
const sourceConduct = p.RS !== 0 ? 1 / p.RS : 0;
// jfet2temp.c:70-79 — FC clamp to 0.95, then f2/f3.
const fc = p.FC > 0.95 ? 0.95 : p.FC;
const xfc = Math.log(1 - fc);
const f2 = Math.exp((1 + 0.5) * xfc);
const f3 = 1 - fc * (1 + 0.5);
```

(The `fc > .95` clamp, `jfet2temp.c:70-75`, emits an ngspice warning; the
reconstruction clamps silently — diagnostic-only, no numerical effect.)

### Per-instance corrections (`jfet2temp.c:85-112`)

```ts
// jfet2temp.c:85-91 — dtemp / temp defaults.
const dtemp = given.dtempGiven ? p.DTEMP : 0.0;
const temp = given.tempGiven ? p.TEMP : ctx.cktTemp + dtemp;
// jfet2temp.c:93-96 — thermal voltage + saturation current scaling.
const vt = temp * CONSTKoverQ;
const fact2 = temp / REFTEMP;
const ratio1 = temp / tnom - 1;
const tSatCur = p.IS * Math.exp(ratio1 * 1.11 / vt);
// jfet2temp.c:97-108 — depletion-cap temperature corrections (two cjfact stages).
let tCGS = p.CAPGS * cjfact;
let tCGD = p.CAPGD * cjfact;
const kt = CONSTboltz * temp;
const egfet = 1.16 - (7.02e-4 * temp * temp) / (temp + 1108);
const arg = -egfet / (kt + kt) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
const pbfact = -2 * vt * (1.5 * Math.log(fact2) + CHARGE * arg);
const tGatePot = fact2 * pbo + pbfact;
const gmanew = (tGatePot - pbo) / pbo;
const cjfact1 = 1 + 0.5 * (4e-4 * (temp - REFTEMP) - gmanew);
tCGS *= cjfact1;
tCGD *= cjfact1;
// jfet2temp.c:110-112 — depletion-cap join point, f1, critical voltage.
const corDepCap = fc * tGatePot;
const f1 = tGatePot * (1 - Math.exp((1 - 0.5) * xfc)) / (1 - 0.5);
const vcrit = vt * Math.log(vt / (CONSTroot2 * tSatCur));
```

Note `tSatCur` uses the literal `1.11` bandgap factor (`jfet2temp.c:96`) — NOT
the JFET's `p.EG` (`njfet.ts:261-263`); JFET2 has no `eg`/`xti` params, so the
exponent is fixed at `1.11/vt`.

### `PSinstanceinit` derived fields (`psmodel.c:362-377`)

```ts
// psmodel.c:372-376 — derived PS parameters. woo = VBI - VTO where VBI = tGatePot.
const woo = tGatePot - p.VTO;
const xiwoo = p.XI * woo;                                   // XI_WOO
const za = Math.sqrt(1 + p.Z) / 2;                          // ZA
const alpha = (xiwoo * xiwoo) / (p.XI + 1) / (p.XI + 1) / 4; // ALPHA
const d3 = p.P / p.Q / Math.pow(woo, p.P - p.Q);            // D3
```

(PS macro bindings: `VBI = here->JFET2tGatePot` `psmodel.h:85`,
`XI_WOO = here->JFET2xiwoo` `:112`, `ZA = model->JFET2za` `:113`,
`ALPHA = here->JFET2alpha` `:109`, `D3 = here->JFET2d3` `:110`,
`VMAX = here->JFET2corDepCap` `:111`.)

### `hfgam` cross-default (`jfet2parm.h:54`)

```ts
// jfet2parm.h:54 — hfgam defaults to lfgam when not given (jfet2set.c:36-38).
const hfgam = given.hfgamGiven ? p.HFGAM : p.LFGAM;
```

`Jfet2TempParams` carries: `vt, tSatCur, tGatePot, tCGS, tCGD, corDepCap, vcrit,
f1, f2, f3, drainConduct, sourceConduct, za, xiwoo, alpha, d3, hfgam, fc, tnom`.

## Part E — DC drain current + conductances (rebuild of `PSids`, `psmodel.c:41-205`)

`PSids` is the PS-model heart: gate-junction diode currents (forward conduction
+ reverse breakdown), then the drain current through the rate-dependent
threshold modulation, dual power-law, early-saturation, intrinsic Q-law, channel
length modulation, and thermal-reduction stages. The reconstruction ports it as
a private method `_psIds(ctx, vgs, vgd, out)` returning `idrain` and writing the
six conductance/current outputs (`igs, igd, ggs, ggd, gm, gds`) into `out`. The
constants are `psmodel.c:55-57`:

```ts
const FX = -10.0;                            // psmodel.c:55
const MX = 40.0;                             // psmodel.c:56
const EMX = 2.353852668370199842e17;         // psmodel.c:57 exp(MX)
```

### Gate-junction diodes (`psmodel.c:62-105`)

Forward conduction (`psmodel.c:64-86`) for each of vgs/vgd with the three-zone
`arg = v/Vt` test (`FX`, `MX` bounds), then reverse-breakdown conduction
(`psmodel.c:87-104`). PS-glue macros: `Gmin = ckt->CKTgmin` (`psmodel.h:65`),
`Vt = JFET2temp*CONSTKoverQ*JFET2n` (NVT, `:66`), `isat = IS*area` (`IS`=
`tSatCur`, `:75`), `Vbd = VBD` (`:84`), `ibd = IBD*area` (`:74`):

```ts
// psmodel.c:64-86 — gate-junction forward conduction (gate-source then gate-drain).
const Gmin = ctx.cktGmin;
const Vt = tp.vt * params.N;        // psmodel.h:66 NVT = JFET2temp*CONSTKoverQ*n
const isat = tp.tSatCur * area;     // psmodel.h:75 IS = tSatCur
let arg = vgs / Vt; let zz;
if (arg > FX) {
  if (arg < MX) { ggs = (zz = isat * Math.exp(arg)) / Vt + Gmin; igs = zz - isat + Gmin * vgs; }
  else          { ggs = (zz = isat * EMX) / Vt + Gmin; igs = zz * (arg - MX + 1) - isat + Gmin * vgs; }
} else          { ggs = Gmin; igs = -isat + Gmin * vgs; }
// …vgd branch identical with vgd…
// psmodel.c:87-104 — gate-junction reverse 'breakdown' conduction.
const Vbd = params.VBD; const ibd = params.IBD * area;
arg = -vgs / Vbd;
if (arg > FX) {
  if (arg < MX) { ggs += (zz = ibd * Math.exp(arg)) / Vbd; igs -= zz - ibd; }
  else          { ggs += (zz = ibd * EMX) / Vbd; igs -= zz * ((arg - MX) + 1) - ibd; }
} else          { igs += ibd; }
// …vgd breakdown branch identical…
```

### Drain current — rate-dependent threshold (`psmodel.c:107-180`)

The `vdst = vgs - vgd` channel voltage, the `stepofour = STEP*FOURTH` (`STEP =
ckt->CKTdelta` `psmodel.h:67`, `FOURTH = 0.25` `:68`), the transient 4th-power
trap filter `h = (taug/(taug+stepofour))^4` writing the trap state slots
(`psmodel.c:117-126`), the `vgst` threshold with LF/HF feedback
(`psmodel.c:127-130`), the exponential subthreshold (`psmodel.c:131-139`), dual
power-law (`:140-144`), early-saturation (`:145-157`), intrinsic Q-law
(`:158-163`), the feedback recombination of `gm`/`gds` (`:164-179`):

```ts
const vdst = vgs - vgd;
const stepofour = ctx.cktDelta * 0.25;       // psmodel.c:110 STEP*FOURTH
let h: number, vgdtrap: number, vgstrap: number;
if (mode & MODETRAN) {                        // psmodel.h:42 TRAN_ANAL
  // psmodel.c:117-121 — 4th-power feedback filter on the trap potentials.
  const taug = hfgamResolvedTaug; // = TAUG (model->JFET2taug)
  h = taug / (taug + stepofour); h *= h; h *= h;
  s0[base + SLOT_VTRAP]   = vgdtrap = h * s1[base + SLOT_VTRAP]   + (1 - h) * vgd;
  s0[base + SLOT_VGSTRAP] = vgstrap = h * s1[base + SLOT_VGSTRAP] + (1 - h) * vgs;
} else {
  // psmodel.c:122-126 — non-transient: trap follows the instantaneous bias.
  h = 0;
  s0[base + SLOT_VTRAP]   = vgdtrap = vgd;
  s0[base + SLOT_VGSTRAP] = vgstrap = vgs;
}
// psmodel.c:127-130 — threshold shift from LF (lfgam/lfg1/lfg2) + HF (hfeta/hfg) feedback.
let vgst = vgs - params.VTO;
vgst -= (params.LFGAM - params.LFG1 * vgstrap + params.LFG2 * vgdtrap) * vgdtrap;
const dvgs = vgstrap - vgs;
const eta = params.HFETA - params.HFE1 * vgdtrap + params.HFE2 * vgstrap;
vgst += eta * dvgs;
const dvgd = vgdtrap - vgd;
const gamFb = tp.hfgam - params.HFG1 * vgstrap + params.HFG2 * vgdtrap;
vgst += gamFb * dvgd;
```

The implementer ports `psmodel.c:131-180` verbatim — the subthreshold `vgt`
(`vst = VSUB*(1+mvst*vdst)`, the `EMX/(EMX+1)` numerically-large branch vs the
`vst*log(1+exp(vgst/vst))` limit), the dual-power `dvpd_dvdst = D3*pow(vgt,P-Q)`,
the early-saturation `vsat`/`rpt`/`a_rpt`/`vdt`, the intrinsic Q-law
`pow(vgt-vdt,Q-1)` / `pow(vgt,Q-1)`, and the closing `gds += gm*(...)` /
`gm *= 1 - h*eta + ...` feedback recombination (`psmodel.c:177-179`). PS macros:
`MVST=mvst` `psmodel.h:80`, `VSUB=vst` `:86`, `P=p`/`Q=q` `:82-83`, `D3` `:110`,
`ZA=za` `:113`, `MXI=mxi` `:81`, `XI_WOO=xiwoo` `:112`, `Z=z` `:89`.

### Channel-length modulation + beta scaling (`psmodel.c:181-187`)

```ts
// psmodel.c:181-187 — beta-scale + lambda channel-length modulation.
const beta = params.BETA * area;
const argL = beta * (1 + params.LAMBDA * vdst);
gm *= argL;
gds = beta * params.LAMBDA * idrain + gds * argL;
idrain *= argL;
```

### Thermal reduction of drain current (`psmodel.c:189-202`)

The `pAverage` self-heating power (transient 4th-power filter on `taud`, writing
`PAVE` state), `idrain /= (1 + pAverage*delta)`, and the `*Gm`/`*Gds` corrections
(`psmodel.c:200-201`). `DELT = model->JFET2delta` (`psmodel.h:73`),
`delta = DELT/area` (`psmodel.c:190`):

```ts
// psmodel.c:189-202 — thermal reduction; pAverage tracks dissipated power.
const delta = params.DELTA / area;
let hT: number, pAverage: number;
if (mode & MODETRAN) {
  const taud = params.TAUD;
  hT = taud / (taud + stepofour); hT *= hT; hT *= hT;
  s0[base + SLOT_PAVE] = pAverage = hT * s1[base + SLOT_PAVE] + (1 - hT) * vdst * idrain;
} else {
  s0[base + SLOT_PAVE] = pAverage = vdst * idrain; hT = 0;
  s1[base + SLOT_PAVE] = pAverage; // psmodel.c:197 POWR_BEFORE = pAverage
}
const pfac = 1 + pAverage * delta;
idrain /= pfac;
gm = gm * (hT * delta * s1[base + SLOT_PAVE] + 1) / pfac / pfac;
gds = gds * ((hT * delta * s1[base + SLOT_PAVE] + 1) / pfac / pfac) - (1 - hT) * delta * idrain * idrain;
```

(The implementer must preserve the exact `arg` aliasing of `psmodel.c:200`:
`*Gm = gm * (arg = (h*delta*POWR_BEFORE + 1)/pfac/pfac)` then `*Gds = gds*arg -
(1-h)*delta*idrain*idrain` — the same `arg` multiplies both `gm` and `gds`.)

`_psIds` returns `idrain` and writes `igs/igd/ggs/ggd/gm/gds` to the out-struct.

## Part F — Gate-charge model (rebuild of `qgg` + `PScharge`, `psmodel.c:207-293`)

`qgg` (`psmodel.c:209-249`, the Statz-based charge function) computes gate
charge + `cgs`/`cgd` from `vgs`/`vgd` and the model geometry. `PScharge`
(`psmodel.c:253-293`) calls it once (non-transient/AC-init) or four times
(transient midpoint differencing) to fill `QGS`/`QGD` state and the `capgs`/
`capgd` outputs.

```ts
// psmodel.c:209-249 — Statz et al. gate-charge function (IEEE Trans ED Feb 87).
function qgg(vgs: number, vgd: number, gamma: number, pb: number, alpha: number,
             vto: number, vmax: number, xc: number, cgso: number, cgdo: number,
             out: { cgs: number; cgd: number }): number {
  const vds = vgs - vgd;
  const d1_xc = 1 - xc;
  const vert = Math.sqrt(vds * vds + alpha);
  const veff = 0.5 * (vgs + vgd + vert) + gamma * vds;
  const vnr = d1_xc * (veff - vto);
  const vnrt = Math.sqrt(vnr * vnr + 0.04);
  const vnew = veff + 0.5 * (vnrt - vnr);
  let qrt: number, ext: number, Cgso: number;
  if (vnew < vmax) {
    ext = 0; qrt = Math.sqrt(1 - vnew / pb);
    Cgso = 0.5 * cgso / qrt * (1 + xc + d1_xc * vnr / vnrt);
  } else {
    const vx = 0.5 * (vnew - vmax);
    const par = 1 + vx / (pb - vmax);
    qrt = Math.sqrt(1 - vmax / pb);
    ext = vx * (1 + par) / qrt;
    Cgso = 0.5 * cgso / qrt * (1 + xc + d1_xc * vnr / vnrt) * par;
  }
  const cpm = vds / vert;
  const cplus = 0.5 * (1 + cpm);
  const cminus = cplus - cpm;
  out.cgs = Cgso * (cplus + gamma) + cgdo * (cminus + gamma);
  out.cgd = Cgso * (cminus - gamma) + cgdo * (cplus - gamma);
  return cgso * ((pb + pb) * (1 - qrt) + ext) + cgdo * (veff - vert);
}
```

`PScharge` (`psmodel.c:253-293`) — the `QGG(a,b,c,d)` macro binds
`gac=ACGAM, phib=VBI, alpha, vto, vmax=corDepCap, xc, czgs=CGS*area,
czgd=CGD*area` (`psmodel.c:264-274`; PS macros `psmodel.h:92-103,109-112`):

```ts
// psmodel.c:267-292 — single qgg call when non-transient/AC-init; four-call
// midpoint differencing during transient analysis.
const czgs = tp.tCGS * area; const czgd = tp.tCGD * area;
const gac = params.ACGAM; const phib = tp.tGatePot;
const vto = params.VTO; const vmax = tp.corDepCap; const xc = params.XC;
const alpha = tp.alpha;
if (!(mode & MODETRAN)) {
  // psmodel.c:276-278 — initialize all four charge state cells from one call.
  const q = qgg(vgs, vgd, gac, phib, alpha, vto, vmax, xc, czgs, czgd, out);
  s0[base + SLOT_QGS] = s0[base + SLOT_QGD] = s1[base + SLOT_QGS] = s1[base + SLOT_QGD] = q;
  capgs = out.cgs; capgd = out.cgd;
} else {
  // psmodel.c:279-292 — four-point midpoint differencing for transient charge.
  const vgs1 = s1[base + SLOT_VGS]; const vgd1 = s1[base + SLOT_VGD];
  const a: { cgs: number; cgd: number } = { cgs: 0, cgd: 0 };
  const qgga = qgg(vgs,  vgd,  gac, phib, alpha, vto, vmax, xc, czgs, czgd, a);
  const cgsna = a.cgs, cgdna = a.cgd;
  const qggb = qgg(vgs1, vgd,  gac, phib, alpha, vto, vmax, xc, czgs, czgd, a);
  const cgdnb = a.cgd;
  const qggc = qgg(vgs,  vgd1, gac, phib, alpha, vto, vmax, xc, czgs, czgd, a);
  const cgsnc = a.cgs;
  const qggd = qgg(vgs1, vgd1, gac, phib, alpha, vto, vmax, xc, czgs, czgd, a);
  s0[base + SLOT_QGS] = s1[base + SLOT_QGS] + 0.5 * (qgga - qggb + qggc - qggd);
  s0[base + SLOT_QGD] = s1[base + SLOT_QGD] + 0.5 * (qgga - qggc + qggb - qggd);
  capgs = 0.5 * (cgsna + cgsnc);
  capgd = 0.5 * (cgdna + cgdnb);
}
```

(The `QGS_BEFORE`/`QGD_BEFORE` reads in `psmodel.c:288-289` are `s1[QGS]`/
`s1[QGD]` per `psmodel.h:55-58`.)

## Part G — DC/transient load (rebuild of `JFET2load`, `jfet2load.c:21-328`)

`JFET2load` is the per-iteration driver. It mirrors `njfet.ts:467-911`
structurally — the `cktMode` voltage-dispatch ladder, the bypass test, the
limiting, the `NIintegrate` lump, the noncon gate, the RHS/Y stamps — but the DC
current comes from `_psIds` (Part E) and the caps from `PScharge` (Part F), and
there is an extra `qds`/`capds` D-S branch.

### Voltage dispatch (`jfet2load.c:76-197`)

Identical ladder to JFET (`njfet.ts:508-645`) with the **same** UIC seed
(`jfet2load.c:83-88`): `vds = type*icVDS; vgs = type*icVGS; vgd = vgs-vds`. The
bypass `cghat`/`cdhat` extrapolation (`jfet2load.c:142-148`), the `DEVpnjlim`
twice + `DEVfetlim` twice limiting (`jfet2load.c:186-196`), and the
`MODEINITPRED` predictor block (`jfet2load.c:99-122`) are byte-for-byte the JFET
pattern. Use the same `pnjlim`/`fetlim` from `newton-raphson.js` and the same
`MODE*` flags.

### DC current via `_psIds` with vds-sign swap (`jfet2load.c:201-212`)

The critical PS-specific structure — when `vds < 0`, `PSids` is called with
**swapped** vgd/vgs and the outputs are sign-corrected:

```ts
// jfet2load.c:201-212 — vds sign determines argument order into PSids; the
// inverse-mode call swaps vgd<->vgs and corrects gds/gm afterward.
const vds = vgs - vgd;
let cd: number, cg: number, cgd: number, ggs: number, ggd: number, gm: number, gds: number;
const o = { igs: 0, igd: 0, ggs: 0, ggd: 0, gm: 0, gds: 0 };
if (vds < 0.0) {
  cd = -this._psIds(ctx, vgd, vgs, o);  // swapped args
  cgd = o.igs; cg = o.igd; ggd = o.ggs; ggs = o.ggd; gm = o.gm; gds = o.gds;
  gds += gm;            // jfet2load.c:205
  gm = -gm;             // jfet2load.c:206
} else {
  cd = this._psIds(ctx, vgs, vgd, o);
  cg = o.igs; cgd = o.igd; ggs = o.ggs; ggd = o.ggd; gm = o.gm; gds = o.gds;
}
cg = cg + cgd;          // jfet2load.c:211
cd = cd - cgd;          // jfet2load.c:212
```

(In the `vds<0` branch ngspice passes `&cgd,&cg,&ggd,&ggs` so the `*igs/*igd`
outputs land in `cgd`/`cg` and `*ggs/*ggd` in `ggd`/`ggs` — the table above
encodes exactly that pointer-output remap.)

### Charge storage + NIintegrate (`jfet2load.c:214-269`)

The `capds = JFET2capds*area` D-S linear cap (`jfet2load.c:219`),
`PScharge(...)` for the gate caps (`jfet2load.c:221`), `qds = capds*vds`
(`:223`), then the SMSIG store-and-continue (`:230-235`), the MODEINITTRAN
state1 copies (`:239-246, 260-267`), and three `NIintegrate` calls — `capgs`
into `JFET2qgs`, `capgd` into `JFET2qgd`, `capds` into `JFET2qds`
(`jfet2load.c:247-259`), lumping `geq` into `ggs`/`ggd` and the companion
currents into `cg`/`cd`/`cgd`. Use `niIntegrate` from `ni-integrate.js` (the
JFET pattern, `njfet.ts:800-849`) with the D-S third integration added:

```ts
// jfet2load.c:257-259 — D-S charge integration (capds linear cap, qds slot).
const { ccap: ccapDs, geq: geqDs } = niIntegrate(ctx.method, ctx.order, capds, ctx.ag,
  s0[base + SLOT_QDS], s1[base + SLOT_QDS], [s2[base + SLOT_QDS], 0, 0, 0, 0], s1[base + SLOT_CQDS]);
s0[base + SLOT_CQDS] = ccapDs;
cd = cd + s0[base + SLOT_CQDS];   // jfet2load.c:258
```

Note the gate `NIintegrate` lump order (`jfet2load.c:247-256`):
`ggs += geq; cg += cqgs; ggd += geq; cg += cqgd; cd -= cqgd; cgd += cqgd`. The
D-S integrate result `geqDs` is computed but ngspice does **not** add it to a
conductance — only `cd += cqds` (`jfet2load.c:258`); the D-S susceptance enters
only the AC path via `qds*omega` (Part H). Preserve this: `geqDs` is unused in
DC (it is a `qds`-only state for AC and LTE).

### Noncon gate + state writeback + stamps (`jfet2load.c:271-324`)

The `MODEINITFIX|MODEUIC` noncon-suppression gate (`jfet2load.c:273-282`), the
9-slot state writeback (`:283-291`), the `m = JFET2m` RHS stamps with polarity
(`ceqgd/ceqgs/cdreq`, `jfet2load.c:297-306`), and the 15 Y-matrix stamps
(`jfet2load.c:310-324`) are byte-for-byte the JFET stamp set (`njfet.ts:857-910`)
— same `stampRHS`/`stampElement` handles, same expressions. The `qds`/`capds`
charge does NOT stamp into the DC Y-matrix (no `gds`-equivalent for the linear
D-S cap in `jfet2load.c`); it only contributes `cd += cqds` and the AC `xgds`.

## Part H — AC small-signal load (rebuild of `JFET2acLoad` + `PSacload`)

`JFET2acLoad` (`jfet2acld.c:18-91`) reads the operating-point conductances and
gate charges from state0, scales the charges by `CKTomega` to susceptances,
calls `PSacload` to form the frequency-dependent `gm`/`gds` (real+imag), adds the
`qds*omega` D-S susceptance, and stamps the complex Y-matrix. This is a
`stampAc(solver, omega, ctx, rhsRe, rhsIm)` method mirroring `njfet.ts:926-976`.

### `PSacload` (`psmodel.c:298-359`)

The PS AC routine forms the complex transconductance/output-conductance from the
LF/HF feedback time constants (`taug`/`taud`) and the operating-point `gm`/`gds`:

```ts
// psmodel.c:313-358 — PS small-signal gm/gds with taug/taud frequency dispersion.
function psAcLoad(vgs: number, vgd: number, ids: number, omega: number,
                  gmIn: number, gdsIn: number,
                  out: { gm: number; xgm: number; gds: number; xgds: number }): void {
  const vds = vgs - vgd;
  const LFg2 = params.LFG2 * vgd;
  const HFg2 = params.HFG2 * vgd;
  const HFe2 = params.HFE2 * vgs;
  const hfgam = tp.hfgam - params.HFG1 * vgs + HFg2;
  const eta = params.HFETA - params.HFE1 * vgd + HFe2;
  const lfga = params.LFGAM - params.LFG1 * vgs + LFg2 + LFg2;
  const gmo = gmIn / (1 - lfga + params.LFG1 * vgd);
  const wtg = params.TAUG * omega;
  const wtgdet = 1 + wtg * wtg;
  const gwtgdet = gmo / wtgdet;
  const argA = hfgam - lfga;
  const gdsi = argA * gwtgdet;
  const gdsr = argA * gmo - gdsi;
  const gmi = (eta + params.LFG1 * vgd) * gwtgdet + gdsi;
  const xgds0 = wtg * gdsi;
  const gds0 = gdsIn + gdsr;
  const xgm0 = -wtg * gmi;
  const gm0 = gmi + gmo * (1 - eta - hfgam);
  const delta = params.DELTA / params.AREA;
  const wtd = params.TAUD * omega;
  const wtddet = 1 + wtd * wtd;
  const fac = delta * ids;
  const del = 1 / (1 - fac * vds);
  const dd = (del - 1) / wtddet;
  const dr = del - dd;
  const di = wtd * dd;
  const cdsqr = fac * ids * del * wtd / wtddet;
  out.gm   = dr * gm0  - di * xgm0;
  out.xgm  = di * gm0  + dr * xgm0;
  out.gds  = dr * gds0 - di * xgds0 + cdsqr * wtd;
  out.xgds = di * gds0 + dr * xgds0 + cdsqr;
}
```

### `stampAc` matrix loads (`jfet2acld.c:40-87`)

```ts
// jfet2acld.c:40-54 — read op-point conductances/charges, scale charges by omega.
const gdpr = tp.drainConduct * params.AREA;
const gspr = tp.sourceConduct * params.AREA;
const gm0 = s0[base + SLOT_GM]; const gds0 = s0[base + SLOT_GDS];
const ggs = s0[base + SLOT_GGS]; const xgs = s0[base + SLOT_QGS] * omega;
const ggd = s0[base + SLOT_GGD]; const xgd = s0[base + SLOT_QGD] * omega;
const vgs = s0[base + SLOT_VGS]; const vgd = s0[base + SLOT_VGD]; const cd = s0[base + SLOT_CD];
const o = { gm: gm0, xgm: 0, gds: gds0, xgds: 0 };
psAcLoad(vgs, vgd, cd, omega, gm0, gds0, o);
const xgds = o.xgds + s0[base + SLOT_QDS] * omega;  // jfet2acld.c:54 += qds*omega
```

The 26 complex stamps (`jfet2acld.c:58-86`) are ported one-for-one: real terms
via `solver.stampElement`, imaginary via `solver.stampElementImag`, each
ngspice `-=` rendered as a stamp of the negated expression (the
`njfet.ts:953-975` posture). The full stamp list (with `m = JFET2m`):

| ngspice line | handle | real / imag | expression |
|---|---|---|---|
| `:58` | `_hDPDP +1` | imag | `m*xgds` |
| `:59` | `_hSPSP +1` | imag | `m*(xgds+o.xgm)` |
| `:60` | `_hDPG +1`  | imag | `m*o.xgm` |
| `:61` | `_hDPSP +1` | imag | `-m*(xgds+o.xgm)` |
| `:62` | `_hSPG +1`  | imag | `-m*o.xgm` |
| `:63` | `_hSPDP +1` | imag | `-m*xgds` |
| `:65` | `_hDD`      | real | `m*gdpr` |
| `:66` | `_hGG`      | real | `m*(ggd+ggs)` |
| `:67` | `_hGG +1`   | imag | `m*(xgd+xgs)` |
| `:68` | `_hSS`      | real | `m*gspr` |
| `:69` | `_hDPDP`    | real | `m*(gdpr+gds+ggd)` |
| `:70` | `_hDPDP +1` | imag | `m*xgd` |
| `:71` | `_hSPSP`    | real | `m*(gspr+gds+o.gm+ggs)` |
| `:72` | `_hSPSP +1` | imag | `m*xgs` |
| `:73` | `_hDDP`     | real | `-m*gdpr` |
| `:74` | `_hGDP`     | real | `-m*ggd` |
| `:75` | `_hGDP +1`  | imag | `-m*xgd` |
| `:76` | `_hGSP`     | real | `-m*ggs` |
| `:77` | `_hGSP +1`  | imag | `-m*xgs` |
| `:78` | `_hSSP`     | real | `-m*gspr` |
| `:79` | `_hDPD`     | real | `-m*gdpr` |
| `:80` | `_hDPG`     | real | `m*(-ggd+o.gm)` |
| `:81` | `_hDPG +1`  | imag | `-m*xgd` |
| `:82` | `_hDPSP`    | real | `m*(-gds-o.gm)` |
| `:83` | `_hSPG`     | real | `m*(-ggs-o.gm)` |
| `:84` | `_hSPG +1`  | imag | `-m*xgs` |
| `:85` | `_hSPS`     | real | `-m*gspr` |
| `:86` | `_hSPDP`    | real | `-m*gds` |

Here `gds = o.gds`, `o.gm`, `xgds` are the `psAcLoad` outputs;
`ggs`/`ggd`/`xgs`/`xgd`/`gdpr`/`gspr` are the state/conductance reads above.
(The `gds`/`gm` used in the stamps `:69-86` are the *AC* values from `psAcLoad`,
NOT the raw state0 `gm0`/`gds0` — `jfet2acld.c:52-53` overwrites `gm`/`gds` via
the `&gm,&gds` out-pointers before the stamp block.)

## Part I — Parameter setters + `.ic` parse (rebuild of `JFET2param` + `JFET2mParam`)

### Instance setter (`JFET2param`, `jfet2par.c:21-76`)

`setParam(key, value)` mirrors `njfet.ts:1010-1040`. The instance cases:

```ts
// jfet2par.c:29-55 — instance parameter setters; *Given bits gate temp defaults
// and JFET2getic capture.
if (key === "TEMP")  { this._params.TEMP = value; this._tempGiven = true; … recompute tp }
else if (key === "DTEMP") { this._params.DTEMP = value; this._dtempGiven = true; … recompute tp }
else if (key === "AREA")  { this._params.AREA = value; this._areaGiven = true; }
else if (key === "M")     { this._params.M = value; this._mGiven = true; }
// jfet2par.c:45-52 — IC scalar seeds set their *Given bit.
else if (key === "ICVDS") { this._params.ICVDS = value; this._icVDSGiven = true; }
else if (key === "ICVGS") { this._params.ICVGS = value; this._icVGSGiven = true; }
```

The bare `ic=vds[,vgs]` vector (`jfet2par.c:56-71`, the `case 2 → case 1`
fallthrough: `numValue==2` writes both vgs[1] then vds[0]; `numValue==1` writes
only vds[0]) is split by the netlist parser / attribute map into the scalar
`ICVDS`/`ICVGS` writes in `vds`-first order (the `njfet.ts:101-102`
`emitGroup IC` pattern; digiTS property bags are scalar-keyed). The attribute map
(`JFET2_ATTRIBUTE_MAPPINGS`) gains the `ic`→split rule mirroring the JFET
recon's `ic=` handling.

### Model setter (`JFET2mParam`, `jfet2mpar.c:19-45`)

The model-param hot-load path: `tnom` (CtoK convert, `jfet2mpar.c:24-27`), the
`#include "jfet2parm.h"` generic `case id: model->ref = value` loop
(`:28-30`) — i.e. every model-card param is settable — and the `njf`/`pjf` type
selectors (`:31-40`, fixed by component identity in digiTS). All model params are
hot-loadable via `setParam` recomputing `_tp` (the system requirement, MEMORY
hot-loadable-params). The `_hfgamGiven`/`_tnomGiven` bits are set when their key
is written so the temp pass sees givenness.

(`JFET2ask`/`JFET2mAsk`, `jfet2ask.c`/`jfet2mask.c`, are the `which`-switch
getter that digiTS has no counterpart for — NO-COUNTERPART, the ratified
`cccs`/`res` ask-getter precedent, `OPEN-QUESTIONS-WORKLOG.md:393-396`. The
`JFET2_CS`/`JFET2_POWER` AC-error guards and the `*= JFET2m` output scalings live
in `getPinCurrents`/device-question reads, not a generic ask dispatch.)

## Part J — `JFET2getic` capture (DEFERRED to engine phase — does not block)

`JFET2getic` (`jfet2ic.c:19-44`) captures the IC operating point from the
converged rhs when the netlist did not supply `icvds`/`icvgs`:
`icVDS = rhs[drain] - rhs[source]` (`jfet2ic.c:31-35`),
`icVGS = rhs[gate] - rhs[source]` (`:36-40`), guarded by `!icVDSGiven`/
`!icVGSGiven`. ngspice registers it as `DEVsetic = JFET2getic`.

Per **OQ-JFET2-GETIC** (#13, RESOLVED): digiTS has **no** engine→device
IC-capture dispatch (`DEVsetic`; whole-`src/` grep returns zero matches,
`OPEN-QUESTIONS-WORKLOG.md:204-224`). Parts A–I above (params, state, setup,
temp, PS core, load with the UIC *seed*, acLoad, the `ic=` parse) are
self-contained element edits that ship now and satisfy every blocked hunk. Part J
(the getic capture dispatch) is engine-subsystem work taken up when the engine
diff-docs are ported; it does NOT block device completion. The implementer
declares the `_icVDSGiven`/`_icVGSGiven` bits now (Part A) so the future getic
hook reads them; the capture body is not wired until the engine hook exists.

## Part K — LTE / truncation (rebuild of `JFET2trunc`, `jfet2trun.c:19-33`)

`JFET2trunc` calls `CKTterr` on `JFET2qgs` and `JFET2qgd` (`jfet2trun.c:28-29`)
— only the two gate-charge slots, NOT `qds`. `getLteTimestep` mirrors
`njfet.ts:1042-1070` exactly (the `[SLOT_QGS, SLOT_CQGS], [SLOT_QGD, SLOT_CQGD]`
pair loop through `cktTerr`):

```ts
// jfet2trun.c:28-29 — LTE on the two gate-charge state slots only.
const pairs: [number, number][] = [
  [SLOT_QGS, SLOT_CQGS],
  [SLOT_QGD, SLOT_CQGD],
];
```

## Part L — Noise (NO-COUNTERPART)

`jfet2defs.h:27-35` declares 5 noise sources (`JFET2RDNOIZ`, `JFET2RSNOIZ`,
`JFET2IDNOIZ`, `JFET2FLNOIZ`, `JFET2TOTNOIZ`) and `jfet2parm.h:16,32` declares
`af`/`kf` flicker-noise params. digiTS has no `.noise` analysis — the noise model
is NO-COUNTERPART (the ratified `mes` omit-KF/AF precedent, #51
`OPEN-QUESTIONS-WORKLOG.md:415-416`). `AF`/`FNCOEF` are declared as params for
card-parity (so an `af=`/`kf=` netlist token parses) but feed no `load()` path.

## Part M — Component definitions + registration (OQ-JFET2-SHAPE)

Two `StandaloneComponentDefinition`s in `jfet2.ts`, the `vdmos.ts` two-polarity
factory precedent (`vdmos.ts:17-20`):

- `Jfet2NDefinition` (`name: "JFET2N"`): default model seeds `JFET2type = NJF =
  +1`; factory `createJfet2NElement` → `Jfet2Element` with `_polarity = +1`.
- `Jfet2PDefinition` (`name: "JFET2P"`): default model seeds `JFET2type = PJF =
  -1`; factory `createJfet2PElement` with `_polarity = -1`.

The PS body is a single `Jfet2Element extends PoolBackedAnalogElement` with a
`private readonly _polarity: 1 | -1` literal set by the factory (NOT a
`modelRegistry` polarity key — polarity is the two-component axis, never a model
variant, per #24 + MEMORY v41 device-class-scope). `deviceFamily = "JFET2"`,
`ngspiceLoadOrder = NGSPICE_LOAD_ORDER.JFET2` (the implementer adds the JFET2
entry to `ngspice-load-order.ts` in ngspice device-ordering position).

`register-all.ts` registers both `Jfet2NDefinition` and `Jfet2PDefinition`. The
netlist generator emits a `Z<name> drain gate source <model>` card with an
`njf`/`pjf` `.model` (the JFET2 SPICE card is `Z`-prefixed; harness-invisible per
OQ-JFET2-SHAPE).

## Acceptance criteria

1. `src/components/semiconductors/jfet2.ts` exists and declares `Jfet2Element`
   (`PoolBackedAnalogElement` subclass) plus `Jfet2NDefinition` / `Jfet2PDefinition`
   with `_polarity` literals `+1` (NJF) / `-1` (PJF) — the two-component shape
   per OQ-JFET2-SHAPE (#24). The PS model core is INLINE (OQ-JFET2-PSMODEL #25),
   not a separate module. Both are registered in `register-all.ts`.
2. `JFET2_PARAM_DEFS` declares all 30 PS model-card params + `tnom` with the
   exact ngspice tokens, `id` codes, and defaults of `jfet2parm.h:15-54`
   (including the `vbi`/`pb`→`PHI` and `vt0`/`vto`→`VTO` aliases and the
   `hfgam`←`lfgam` cross-default resolved in the temp pass), plus the 7
   instance params (`area`/`icvds`/`icvgs`/`off`/`temp`/`dtemp`/`m`) of
   `jfet2par.c` with the `JFET2_*` enum codes (`jfet2defs.h:223-232`). All
   hot-loadable via `setParam` on all three surfaces.
3. `JFET2_SCHEMA` declares exactly 19 state slots in `jfet2defs.h:164-184`
   offset order (`JFET2_SCHEMA.size = 19`, satisfying `jfet2defs.h#h003a` #48);
   the PS-glue macro↔slot binding (Part B table, with `vtrap`=slot 16 =
   `VGDTRAP`, `vgstrap`=slot 17 = `VGSTRAP`) is preserved.
4. `setup()` allocates source-prime before drain-prime guarded on model
   `rs`/`rd` (`jfet2set.c:55-98`) and the 15 matrix elements in the exact
   `jfet2set.c:106-120` TSTALLOC order (harness CSC-visible).
5. `computeJfet2TempParams` reproduces `jfet2temp.c:46-112` (model + per-instance
   corrections, the literal `1.11` bandgap factor, the two-stage `cjfact`/
   `cjfact1` cap corrections) and `PSinstanceinit` (`psmodel.c:372-376`:
   `xiwoo`/`za`/`alpha`/`d3` from `woo = tGatePot - VTO`), bit-exact.
6. `_psIds` reproduces `PSids` (`psmodel.c:41-205`) bit-exact: the gate-junction
   forward + breakdown diodes with the `FX`/`MX`/`EMX` three-zone tests, the
   rate-dependent threshold trapping (the 4th-power `taug` filter writing
   `VTRAP`/`VGSTRAP` state), the subthreshold/dual-power/early-saturation/
   intrinsic-Q-law drain current, the feedback `gm`/`gds` recombination, the
   beta/lambda scaling, and the thermal-reduction `pAverage` self-heating (the
   `taud` filter writing `PAVE` state, with the shared `arg` of `psmodel.c:200`).
7. `qgg` + `PScharge` reproduce `psmodel.c:209-293` bit-exact: the Statz charge
   function and the one-call (non-transient) vs four-call (transient midpoint
   differencing) `QGS`/`QGD` state fill + `capgs`/`capgd` outputs.
8. `load()` reproduces `JFET2load` (`jfet2load.c:21-328`) bit-exact: the
   `cktMode` voltage-dispatch ladder (including the UIC seed `vds=type*icVDS;
   vgs=type*icVGS; vgd=vgs-vds`, `jfet2load.c:83-88`), the bypass test, the
   `pnjlim`×2 + `fetlim`×2 limiting, the `vds<0` PSids argument-swap with
   `gds+=gm; gm=-gm` (`jfet2load.c:202-206`), the `capds=JFET2capds*area` D-S
   cap + `qds` state, the three `NIintegrate` lumps (gs/gd into conductances,
   ds into `cd` only), the `MODEINITFIX|MODEUIC` noncon gate, the 9-slot
   writeback, and the polarity-scaled RHS + 15 Y stamps.
9. `stampAc()` reproduces `JFET2acLoad` + `PSacload` (`jfet2acld.c:18-91`,
   `psmodel.c:298-359`) bit-exact: the `psAcLoad` complex `gm`/`gds` with
   `taug`/`taud` dispersion, the `+= qds*omega` D-S susceptance, and all 26
   complex stamps (Part H table) with `-=` rendered as negated stamps and the
   AC `o.gm`/`o.gds` (not the raw state) used in the conductance stamps.
10. `getLteTimestep` runs `cktTerr` on `QGS`/`QGD` only (`jfet2trun.c:28-29`).
11. `setParam` reproduces `JFET2param` + `JFET2mParam` instance/model cases
    (`jfet2par.c:29-71`, `jfet2mpar.c:24-40`); the `ic=vds[,vgs]` vector splits
    into scalar `ICVDS`/`ICVGS` writes in vds-first order (the `case 2→case 1`
    fallthrough), each setting its `*Given` bit. Model-param writes recompute
    `_tp`.
12. Part J (`JFET2getic` capture, `jfet2ic.c`) is implemented **iff** the analog
    engine exposes a `getic`/`setic` element hook; otherwise it is deferred to
    the engine-subsystem planner per OQ-JFET2-GETIC (#13), and Parts A–I + K ship
    standalone with the `_icVDSGiven`/`_icVGSGiven` bits declared for the future
    hook. Noise (`af`/`kf`, 5 noise sources) is NO-COUNTERPART (Part L).
13. With `jfet2#recon/wholeClass` `APPLIED`, the 18 blocked hunks (next section)
    apply onto the rebuilt baseline as ordinary per-hunk deltas; `jfet2defs.h#h003a`
    (state-count 18→19 + `JFET2unknown` slot) maps to `JFET2_SCHEMA.size = 19`.
    `node spec/v41-port/build-ledger.mjs` re-runs cleanly with the recon
    `APPLIED` and the 18 hunks unblocked.
14. A `.tran` and a `.op` run on each polarity — at minimum an NJF and a PJF
    instance with non-trivial `beta`/`vto`/`lambda`/`taug`/`taud`/`rd`/`rs` and a
    netlisted `ic=vds,vgs` under `uic` — produces the per-NR-iteration internal
    node voltages, branch currents, matrix Jacobian cells, and the
    `vtrap`/`vgstrap`/`pave`/`qgs`/`qgd`/`qds` state slots matching the ngspice
    JFET2 DLL at every accepted step, and an AC sweep matches the complex
    `stampAc` admittances. Verified via the `harness_*` MCP tool chain
    (`harness_start` → `harness_run` → `harness_first_divergence` →
    `harness_topology_diff` → `harness_matrix_diff` → `harness_get_attempt`).
    Bit-exact under the matched-arithmetic-order constraint — no tolerance
    qualifier.

## Blocked hunks (apply after the recon)

These 18 v41 hunks are `blockedBy: jfet2#recon/wholeClass` in `ledger.json` and
apply as ordinary per-hunk deltas once the baseline above is `APPLIED`:

| Hunk | ngspice anchor | what it adds onto the baseline |
|---|---|---|
| `jfet2/jfet2.c#h001`      | `jfet2.c` device-table | model/instance IFparm table + DEVfunc registration deltas |
| `jfet2/jfet2defs.h#h003a` | `jfet2defs.h:182-184` | state-count 18→19 + `JFET2unknown` slot (→ `JFET2_SCHEMA.size=19`) |
| `jfet2/jfet2acld.c#h001`  | `jfet2acld.c` | AC-load accessor/pointer-rename deltas onto the stamp block |
| `jfet2/jfet2ic.c#h001`    | `jfet2ic.c` | getic accessor renames (Part J, engine-phase) |
| `jfet2/jfet2load.c#h001`  | `jfet2load.c` | load() accessor renames / `ptr→Ptr` onto the rebuilt driver |
| `jfet2/jfet2par.c#h001`   | `jfet2par.c:29-55` | instance-setter delta (IC/temp cases) |
| `jfet2/jfet2par.c#h002`   | `jfet2par.c:56-71` | `JFET2_IC` FALLTHROUGH-comment + vector-parse delta |
| `jfet2/jfet2parm.h#h001`  | `jfet2parm.h:15-32` | model-card PARAM-row delta (first half) |
| `jfet2/jfet2parm.h#h002`  | `jfet2parm.h:33-48` | model-card PARAM-row delta (second half) |
| `jfet2/jfet2parm.h#h003`  | `jfet2parm.h:49-54` | `vt0`/`vto` alias + `hfgam` default-expr delta |
| `jfet2/jfet2set.c#h001`   | `jfet2set.c:33-53` | setup model-default + state-base delta |
| `jfet2/jfet2set.c#h002`   | `jfet2set.c:55-98` | prime-node alloc delta |
| `jfet2/jfet2set.c#h003`   | `jfet2set.c:106-120` | TSTALLOC sequence delta |
| `jfet2/jfet2set.c#h004`   | `jfet2set.c` | setup tail / unsetup delta |
| `jfet2/jfet2temp.c#h001`  | `jfet2temp.c:46-79` | model-level temp-correction delta |
| `jfet2/jfet2temp.c#h002`  | `jfet2temp.c:85-112` | per-instance temp + cap-correction delta |
| `jfet2/jfet2temp.c#h003`  | `jfet2temp.c:114` | `PSinstanceinit` call-site delta |
| `jfet2/jfet2trun.c#h001`  | `jfet2trun.c:28-29` | LTE `CKTterr` accessor-rename delta |

(The remaining jfet2 hunks — `jfet2defs.h#h003b` GENmodel C-plumbing, the
`jfet2ask.c`/`jfet2mask.c` ask-getter, the `jfet2defs.h#h002` noise-`#define`
removal, RFSPICE/PZ/SHARED_MODULE blocks, GC'd teardown — are resolved
independently as NO-COUNTERPART per their `ledger.json` planningNotes and do NOT
block on this recon.)

## BUILD NOTE — run-1 gate-fail fix (FIX-011)

When you register `JFET2N`/`JFET2P` you add them to all three tables in
`src/solver/analog/ngspice-load-order.ts` (`TYPE_ID_TO_NGSPICE_LOAD_ORDER`,
`TYPE_ID_TO_DEVICE_FAMILY`, `TYPE_ID_TO_DECK_PIN_LABEL_ORDER`) plus the
`DeviceFamily` union value `"JFET2"`. You MUST ALSO add `"JFET2"` to
`DECK_EMITTING_FAMILIES` in `src/solver/analog/ngspice-load-order-audit.ts:10-34`.
JFET2 emits a `Z` deck card, so it is deck-emitting; omitting that one entry makes
`auditNgspiceLoadOrderTables` throw at `createDefaultRegistry` (register-all.ts:584)
— "typeId JFET2N/JFET2P is in TYPE_ID_TO_DECK_PIN_LABEL_ORDER but family JFET2 is
not deck-emitting" — which reds the ENTIRE analog compile gate. In run 1 the class
built in-worktree but the gate went RED post-rebase on this single missing row.

Status: RATIFIED 2026-05-30 (user, batch).
