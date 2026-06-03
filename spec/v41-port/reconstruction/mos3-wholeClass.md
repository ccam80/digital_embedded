# Reconstruction spec — `mos3#recon/wholeClass`

Build the **complete ngspice MOS LEVEL 3** (semi-empirical short-channel)
MOSFET device as a new digiTS analog element. MOS3 **does not exist today**:
`src/components/semiconductors/mosfet.ts` implements only MOS **level 1**
(Shichman-Hodges) — verified: there is no `theta`/`kappa`/`vmax`/`xj`/`eta`/
`delta`/`nfs` parameter, no level-3 drain-current core, and its temperature
pass cites `mos1temp.c`. MOS3 is therefore a **whole-class build**, a peer of
`asrc#recon/wholeClass`, `jfet2#recon/wholeClass`, `mes#recon/wholeClass`, and
`vdmos#recon/wholeClass`, not an extension of an existing element.

`mos3` is an **IN** device class (`device-class-scope.md` line 49: "**Missing —
declares `mos3#recon/wholeClass`.** Level-3 semi-empirical never ported"; line
87: "MOS3 covers historical IC and discrete-switching use"). The classical-MOS
scope is fixed at MOS1 + MOS3 + VDMOS; `mos2`/`mos6`/`mos9` are OUT
(`device-class-scope.md:83-93`). All **43** MOS3 ledger hunks (across 26 files)
are currently unmapped (`classification: null`, `tsFile: null`) because there
is no digiTS counterpart; this reconstruction is the counterpart that lets them
classify. The blocked-hunk list is in the final section.

Unlike `mos1`, MOS3 in ngspice is a genuine **4-terminal** device with a
separate Bulk node (`MOS3names[] = {Drain, Gate, Source, Bulk}`,
`mos3.c:162-167`; `MOS3bNode`, `mos3defs.h:44`). The existing MOS1 element is
3-terminal with bulk tied to source (`mosfet.ts:2089-2103`,
`buildNmosPinDeclarations` declares only G/S/D). The 4-terminal shape is a
ratification item (Part B / Ratification items).

ngspice source (all citations verified by hand against the `ref/ngspice`
tree at the lines cited):

- `ref/ngspice/src/spicelib/devices/mos3/mos3defs.h` — instance struct
  (`:32-275`), model struct (`:324-421`), the matrix-pointer field set
  (`:129-173`), the 17 state-slot `#define`s (`:277-302`, `MOS3NUMSTATES 17`
  `:302`), the NMOS/PMOS macros (`:423-426`), and the device/model param id
  enums (`:429-563`).
- `ref/ngspice/src/spicelib/devices/mos3/mos3.c` — the IFparm `MOS3pTable[]`
  (`:13-108`), `MOS3mPTable[]` (`:110-160`), and `MOS3names[]` (`:162-167`).
- `ref/ngspice/src/spicelib/devices/mos3/mos3par.c` — `MOS3param` (`:19-127`),
  the instance-param parse incl. the `ic` vector (`:91-110`) and the
  `cp_getvar("scale")` width/length/area scaling (`:28-58`).
- `ref/ngspice/src/spicelib/devices/mos3/mos3mpar.c` — `MOS3mParam`
  (`:17-198`), the model-param parse incl. `+CONSTCtoK` on `tnom`
  (`:182-185`) and the `nmos`/`pmos` type flags (`:166-177`).
- `ref/ngspice/src/spicelib/devices/mos3/mos3set.c` — `MOS3setup` model
  default block (`:31-141`), per-instance defaults (`:150-186`), internal
  drain/source prime-node allocation (`:188-226`), state allocation
  (`:151-152`), and the 22-cell TSTALLOC sequence (`:234-255`);
  `MOS3unsetup` (`:262-286`).
- `ref/ngspice/src/spicelib/devices/mos3/mos3temp.c` — `MOS3temp`
  (`:17-343`): the model preprocessing (`:39-114`) and the per-instance
  temperature-correction block (`:118-340`).
- `ref/ngspice/src/spicelib/devices/mos3/mos3load.c` — `MOS3load`
  (`:18-1267`): the level-3 semi-empirical drain-current model (`:446-871`)
  plus the bulk diodes, Meyer caps, charge integration, RHS load, and Y-matrix
  stamps.
- `ref/ngspice/src/spicelib/devices/mos3/mos3acld.c` — `MOS3acLoad`
  (`:16-124`).
- `ref/ngspice/src/spicelib/devices/mos3/mos3conv.c` — `MOS3convTest`
  (`:12-99`).
- `ref/ngspice/src/spicelib/devices/mos3/mos3trun.c` — `MOS3trunc`
  (`:12-27`).
- `ref/ngspice/src/spicelib/devices/devsup.c` — `DEVqmeyer` (the Meyer-cap
  helper MOS3load calls at `mos3load.c:1077,1083`), `DEVfetlim`/`DEVlimvds`/
  `DEVpnjlim` (the limiters MOS3load calls at `:350-371`).

digiTS targets:

- `src/components/semiconductors/mosfet3.ts` — **NEW** file (recommended; see
  Ratification item 1), class `Mosfet3AnalogElement` + `Mosfet3NDefinition` /
  `Mosfet3PDefinition`, `MOSFET3_SCHEMA`, the param defs / `modelRegistry`, and
  a private `_computeTempInstance` helper. Peer of `vdmos.ts`, `njfet.ts`.
- `src/components/register-all.ts` — registration calls (sibling of the
  `NmosfetDefinition` / `PmosfetDefinition` registration).
- The limiters `pnjlim`/`fetlim`/`limvds` (`newton-raphson.ts:100,185,243`),
  `niIntegrate` (`ni-integrate.ts:19`), and `cktTerr` (`ckt-terr.ts:103`) are
  **already exported** — MOS3 imports them directly, no new solver primitive is
  required for these (contrast VDMOS, which had to add `devCapVdmos`).
- **Precondition correction (`devQmeyer` is NOT importable today).** The Meyer
  helper `devQmeyer` at `mosfet.ts:581` is **module-private** — declared
  `function devQmeyer(…)` with NO `export` keyword (used only internally at
  `mosfet.ts:1512,1516`). `mosfet3.ts` therefore CANNOT `import { devQmeyer }`
  as written. This recon must make `devQmeyer` reachable, by either:
  (a) **EXPORT `devQmeyer` from `mosfet.ts`** (add the `export` keyword at
  `mosfet.ts:581`), which adds `mosfet.ts` to this recon's touch set; or
  (b) hoist `devQmeyer` into a shared module (e.g. a `devsup`-style helper file)
  that both `mosfet.ts` and `mosfet3.ts` import. Either way the Meyer helper is
  NOT already a usable export — only the limiters, `niIntegrate`, and `cktTerr`
  are.
- A new harness gate fixture (see Ratification item 2 — none exists).

Authoring contract: this spec is **documentation**. No code, no tests, no
ledger edit, no commit. The implementer authors the TypeScript against this
spec; a reviewer verifies every citation against `ref/ngspice`. Comment hygiene
per CLAUDE.md "Code Comments — No Historical Narrative": reconstructed source
comments cite the current `ref/ngspice/src/spicelib/devices/mos3/<file>` line
and explain the mechanism in present tense, with **no** `v26`/`v41`/era tags.

Operation order must match ngspice line-for-line at every site this
reconstruction adds. The per-Part "Forbidden shapes" lists restate the
load-bearing constraints; they are binding.

---

## Part A — State-pool slot schema (rebuild of `mos3defs.h` state `#define`s)

### ngspice baseline

`mos3defs.h:277-302` — 17 state slots, `MOS3NUMSTATES 17`:

```c
#define MOS3vbd MOS3states+ 0
#define MOS3vbs MOS3states+ 1
#define MOS3vgs MOS3states+ 2
#define MOS3vds MOS3states+ 3
#define MOS3capgs MOS3states+ 4   /* gate-source capacitor value */
#define MOS3qgs MOS3states+ 5     /* gate-source capacitor charge */
#define MOS3cqgs MOS3states+ 6    /* gate-source capacitor current */
#define MOS3capgd MOS3states+ 7
#define MOS3qgd MOS3states+ 8
#define MOS3cqgd MOS3states+ 9
#define MOS3capgb MOS3states+ 10
#define MOS3qgb MOS3states+ 11
#define MOS3cqgb MOS3states+ 12
#define MOS3qbd MOS3states+ 13    /* bulk-drain capacitor charge */
#define MOS3cqbd MOS3states+ 14
#define MOS3qbs MOS3states+ 15    /* bulk-source capacitor charge */
#define MOS3cqbs MOS3states+ 16
#define MOS3NUMSTATES 17
```

The MOS3 state layout is **identical** to MOS1's (`mos1defs.h`, mirrored by
`MOSFET_SCHEMA` at `mosfet.ts:694-712`): the level distinction is in the
drain-current math (load), not in the state vector. The `MOS3sensxp*` /
`MOS3numSenStates` slots (`mos3defs.h:305-313`) are sensitivity-analysis state
appended after the 17 core slots; sensitivity is NO-COUNTERPART (see the
blocked-hunk list — `mos3sset.c`/`mos3sld.c`/`mos3sacl.c`/`mos3supd.c`/
`mos3sprt.c`/`mos3dset.c` are all sensitivity/distortion files), so the schema
is the 17 core slots only.

### digiTS counterpart

Per CLAUDE.md "No accept() — all state in StatePool", every non-MNA element
holds state in pool slots; `load()` reads `s1[X]`/`s2[X]` (previous steps) and
writes `s0[X]` (this step). Declare the schema with `defineStateSchema` exactly
as the sibling MOSFET (`mosfet.ts:694-712`), one slot per `#define`, **same
order** (the order is the state-vector layout that `CKTterr`/`NIintegrate`/the
predictor index by):

```ts
// cite: mos3defs.h:277-302 — MOS3NUMSTATES 17. One slot per #define, same
// order: the state-vector layout the integrator/predictor index by. Identical
// to the MOS1 layout (MOSFET_SCHEMA, mosfet.ts:694-712); the level-3
// distinction is in the drain-current math, not the state vector.
export const MOSFET3_SCHEMA: StateSchema = defineStateSchema("Mosfet3Element", [
  { name: "VBD",   doc: "mos3defs.h MOS3vbd=0" },
  { name: "VBS",   doc: "mos3defs.h MOS3vbs=1" },
  { name: "VGS",   doc: "mos3defs.h MOS3vgs=2" },
  { name: "VDS",   doc: "mos3defs.h MOS3vds=3" },
  { name: "CAPGS", doc: "mos3defs.h MOS3capgs=4" },
  { name: "QGS",   doc: "mos3defs.h MOS3qgs=5" },
  { name: "CQGS",  doc: "mos3defs.h MOS3cqgs=6" },
  { name: "CAPGD", doc: "mos3defs.h MOS3capgd=7" },
  { name: "QGD",   doc: "mos3defs.h MOS3qgd=8" },
  { name: "CQGD",  doc: "mos3defs.h MOS3cqgd=9" },
  { name: "CAPGB", doc: "mos3defs.h MOS3capgb=10" },
  { name: "QGB",   doc: "mos3defs.h MOS3qgb=11" },
  { name: "CQGB",  doc: "mos3defs.h MOS3cqgb=12" },
  { name: "QBD",   doc: "mos3defs.h MOS3qbd=13" },
  { name: "CQBD",  doc: "mos3defs.h MOS3cqbd=14" },
  { name: "QBS",   doc: "mos3defs.h MOS3qbs=15" },
  { name: "CQBS",  doc: "mos3defs.h MOS3cqbs=16" },
]);
```

Slot offsets are resolved by name through `stateSchema` per CLAUDE.md "Schema
lookups over slot exports" — no imported `SLOT_*` constants from another
module. (The existing MOS1 element keeps private `SLOT_*` consts at
`mosfet.ts:714-731` for its own file; the MOS3 element resolves through the
schema, matching MEMORY.md `feedback_schema_lookups_over_exports`.)

The per-instance scalar quantities ngspice keeps on `sMOS3instance` but **not**
in the state vector (`mos3defs.h:48-104`) become private number fields on
`Mosfet3AnalogElement` (mirroring the MOSFET pattern at `mosfet.ts:836-860`):
`_m`, `_l`, `_w`, `_drainArea`, `_sourceArea`, `_drainSquares`,
`_sourceSquares`, `_drainPerimiter`, `_sourcePerimiter`, `_sourceConductance`,
`_drainConductance`, `_temp`, `_dtemp`, the temperature-corrected set
`_tTransconductance`/`_tSurfMob`/`_tPhi`/`_tVto`/`_tVbi`/`_tSatCur`/
`_tSatCurDens`/`_tCbd`/`_tCbs`/`_tCj`/`_tCjsw`/`_tBulkPot`/`_tDepCap`, the
junction-cap coefficients `_Cbd`/`_Cbdsw`/`_Cbs`/`_Cbssw`/`_f2d`/`_f3d`/`_f4d`/
`_f2s`/`_f3s`/`_f4s`, the operating-point outputs `_cd`/`_cbs`/`_cbd`/`_gmbs`/
`_gm`/`_gds`/`_gbd`/`_gbs`/`_capbd`/`_capbs`/`_von`/`_vdsat`/`_mode`, and the
critical voltages `_sourceVcrit`/`_drainVcrit`.

**Forbidden shapes:** reordering the 17 slots; appending sensitivity slots
(`MOS3sensxp*`) — sensitivity is NO-COUNTERPART; folding the `_t*` corrected
quantities into the state vector (they are recomputed in `computeTemperature`,
not integrated).

---

## Part B — Model / instance parameters and `modelRegistry` (rebuild of `mos3.c` + `mos3mpar.c` + `mos3par.c`)

### ngspice baseline — instance parameters

Set by `MOS3param` (`mos3par.c:31-126`), declared in `MOS3pTable[]`
(`mos3.c:13-108`). The settable instance inputs:

| ngspice id | name | field | scale | source |
|---|---|---|---|---|
| `MOS3_M` | `m` | `MOS3m` | — | `mos3par.c:32-35` |
| `MOS3_W` | `w` | `MOS3w` | `* scale` | `:36-39` |
| `MOS3_L` | `l` | `MOS3l` | `* scale` | `:40-43` |
| `MOS3_AS` | `as` | `MOS3sourceArea` | `* scale²` | `:44-47` |
| `MOS3_AD` | `ad` | `MOS3drainArea` | `* scale²` | `:48-51` |
| `MOS3_PS` | `ps` | `MOS3sourcePerimiter` | `* scale` | `:52-55` |
| `MOS3_PD` | `pd` | `MOS3drainPerimiter` | `* scale` | `:56-59` |
| `MOS3_NRS` | `nrs` | `MOS3sourceSquares` | — | `:60-63` |
| `MOS3_NRD` | `nrd` | `MOS3drainSquares` | — | `:64-67` |
| `MOS3_OFF` | `off` | `MOS3off` | flag | `:68-70` |
| `MOS3_IC_VBS` | `icvbs` | `MOS3icVBS` | — | `:71-74` |
| `MOS3_IC_VDS` | `icvds` | `MOS3icVDS` | — | `:75-78` |
| `MOS3_IC_VGS` | `icvgs` | `MOS3icVGS` | — | `:79-82` |
| `MOS3_TEMP` | `temp` | `MOS3temp` (`+CONSTCtoK`) | — | `:83-86` |
| `MOS3_DTEMP` | `dtemp` | `MOS3dtemp` | — | `:87-90` |
| `MOS3_IC` | `ic` | vector → icVDS/icVGS/icVBS | — | `:91-110` |

The `ic` vector splits D-S/G-S/B-S in `numValue` 3→2→1 fallthrough order
(`mos3par.c:94-109`). `sens_l`/`sens_w` (`:111-122`) are NO-COUNTERPART
(sensitivity).

### ngspice baseline — model parameters

Set by `MOS3mParam` (`mos3mpar.c:21-196`), declared in `MOS3mPTable[]`
(`mos3.c:110-160`), defaults applied in `MOS3setup` (`mos3set.c:34-141`).
The full model set with `MOS3setup` defaults:

| ngspice id | name(s) | field | default (`mos3set.c`) |
|---|---|---|---|
| `MOS3_MOD_VTO` | `vto`/`vt0` | `MOS3vt0` | `0` (`:79-81`) |
| `MOS3_MOD_KP` | `kp` | `MOS3transconductance` | `2e-5` (`:67-69`) |
| `MOS3_MOD_GAMMA` | `gamma` | `MOS3gamma` | `0` (`:109-111`) |
| `MOS3_MOD_PHI` | `phi` | `MOS3phi` | `.6` (`:106-108`) |
| `MOS3_MOD_RD` | `rd` | `MOS3drainResistance` | `0` (`:58-60`) |
| `MOS3_MOD_RS` | `rs` | `MOS3sourceResistance` | `0` (`:61-63`) |
| `MOS3_MOD_CBD` | `cbd` | `MOS3capBD` | `0` (`:82-84`) |
| `MOS3_MOD_CBS` | `cbs` | `MOS3capBS` | `0` (`:85-87`) |
| `MOS3_MOD_IS` | `is` | `MOS3jctSatCur` | `1e-14` (`:55-57`) |
| `MOS3_MOD_PB` | `pb` | `MOS3bulkJctPotential` | `.8` (`:94-96`) |
| `MOS3_MOD_CGSO` | `cgso` | `MOS3gateSourceOverlapCapFactor` | `0` (`:70-72`) |
| `MOS3_MOD_CGDO` | `cgdo` | `MOS3gateDrainOverlapCapFactor` | `0` (`:73-75`) |
| `MOS3_MOD_CGBO` | `cgbo` | `MOS3gateBulkOverlapCapFactor` | `0` (`:76-78`) |
| `MOS3_MOD_RSH` | `rsh` | `MOS3sheetResistance` | `0` (`:64-66`) |
| `MOS3_MOD_CJ` | `cj` | `MOS3bulkCapFactor` | `0` (`:88-90`) |
| `MOS3_MOD_MJ` | `mj` | `MOS3bulkJctBotGradingCoeff` | `.5` (`:97-99`) |
| `MOS3_MOD_CJSW` | `cjsw` | `MOS3sideWallCapFactor` | `0` (`:91-93`) |
| `MOS3_MOD_MJSW` | `mjsw` | `MOS3bulkJctSideGradingCoeff` | `.33` (`:100-102`) |
| `MOS3_MOD_JS` | `js` | `MOS3jctSatCurDensity` | `0` (`:52-54`) |
| `MOS3_MOD_TOX` | `tox` | `MOS3oxideThickness` | `1e-7` (`:133-135`) |
| `MOS3_MOD_LD` | `ld` | `MOS3latDiff` | `0` (`:37-39`) |
| `MOS3_MOD_XL` | `xl` | `MOS3lengthAdjust` | `0` (`:40-42`) |
| `MOS3_MOD_WD` | `wd` | `MOS3widthNarrow` | `0` (`:43-45`) |
| `MOS3_MOD_XW` | `xw` | `MOS3widthAdjust` | `0` (`:46-48`) |
| `MOS3_MOD_DELVTO` | `delvto`/`delvt0` | `MOS3delvt0` | `0` (`:49-51`) |
| `MOS3_MOD_U0` | `u0`/`uo` | `MOS3surfaceMobility` | `600` (set in temp, `mos3temp.c:64`) |
| `MOS3_MOD_FC` | `fc` | `MOS3fwdCapDepCoeff` | `.5` (`:103-105`) |
| `MOS3_MOD_NSUB` | `nsub` | `MOS3substrateDoping` | (ungiven → skip) |
| `MOS3_MOD_TPG` | `tpg` | `MOS3gateType` | `1` (set in temp, `mos3temp.c:79`) |
| `MOS3_MOD_NSS` | `nss` | `MOS3surfaceStateDensity` | `0` (temp, `:91-92`) |
| `MOS3_MOD_ETA` | `eta` | `MOS3eta` | `0` (`:124-126`) |
| `MOS3_MOD_DELTA` | `delta` | `MOS3delta` | `0` (`:112-114`) |
| `MOS3_MOD_NFS` | `nfs` | `MOS3fastSurfaceStateDensity` | `0` (`:121-123`) |
| `MOS3_MOD_THETA` | `theta` | `MOS3theta` | `0` (`:127-129`) |
| `MOS3_MOD_VMAX` | `vmax` | `MOS3maxDriftVel` | `0` (`:115-117`) |
| `MOS3_MOD_KAPPA` | `kappa` | `MOS3kappa` | `.2` (`:130-132`) |
| `MOS3_MOD_XJ` | `xj` | `MOS3junctionDepth` | `0` (`:118-120`) |
| `MOS3_MOD_NMOS`/`MOS3_MOD_PMOS` | `nmos`/`pmos` | `MOS3type ±1` | `NMOS` (`:34-36`) |
| `MOS3_MOD_TNOM` | `tnom` | `MOS3tnom` (`+CONSTCtoK`) | `CKTnomTemp` (`mos3temp.c:41-43`) |
| `MOS3_MOD_KF` | `kf` | `MOS3fNcoef` | `0` (`:136-138`) |
| `MOS3_MOD_AF` | `af` | `MOS3fNexp` | `1` (`:139-141`) |

`MOS3_MOD_XD`/`MOS3_MOD_ALPHA`/`MOS3_DELTA`/`MOS3_MOD_UEXP`/`MOS3_MOD_NEFF`
appear in the `MOS3pTable`/enum but have **no `MOS3mParam` setter** — they are
read-only output / derived quantities (`alpha`/`coeffDepLayWidth` are computed
in `mos3temp.c:102-104`, `narrowFactor` at `:113-114`); they are not input
params. `kf`/`af`/`nfs` flicker-noise params are stored-but-unused (noise is
NO-COUNTERPART — `mos3noi.c`).

### digiTS counterpart

Per the component-model-architecture hard rule, `model` is the source of truth
after placement and `defaultModel` only seeds the initial model at placement.
Mirror the existing `NMOS`/`PMOS` split (`mosfet.ts:2132-2191,2193-…`): ship
two components `NMOS3`/`PMOS3` (see Ratification item 3 for naming), each with a
`modelRegistry` whose default model (`"spice-l3"`) carries `MOS3type = ±1` via
a polarity closure factory (`createMosfet3Element` / `createPmosfet3Element`
wrapping a `_createMosfet3ElementWithPolarity(polarity, …)`, exactly the MOS1
pattern at `mosfet.ts:743,1923-1946`). Param **set** from `mos3.c`/`mos3mpar.c`;
defaults from `mos3set.c`/`mos3temp.c` as tabulated above.

```ts
export const Mosfet3NDefinition: StandaloneComponentDefinition = {
  name: "NMOS3",
  // pinLayout = D, G, S, B (4-terminal; see Ratification item 1)
  // propertyDefs, attributeMap, category: SEMICONDUCTORS, helpText ...
  modelRegistry: {
    "spice-l3": {
      kind: "inline",
      factory: createMosfet3Element,        // closes over MOS3type = +1 (NMOS)
      paramDefs: MOSFET3_N_PARAM_DEFS,       // from mos3.c / mos3mpar.c
      params: MOSFET3_N_DEFAULTS,            // from mos3set.c / mos3temp.c
    },
    // optional device presets later
  },
  defaultModel: "spice-l3",
};
// Mosfet3PDefinition identical with MOS3type = -1.
```

`setParam()` updates the stored field and is hot-loadable (CLAUDE.md
"Hot-loadable params" + MEMORY.md `feedback_hot_loadable_params`): every param
settable post-placement; the temperature recompute is centralised in
`computeTemperature()` (Part D), **not** folded into `setParam` (the MOS1
element re-runs `computeTemperature(this._lastCtx)` from `setParam`,
`mosfet.ts:1867-1876` — mirror that). The `+CONSTCtoK` conversion applies on
`temp`/`tnom` exactly as ngspice (`mos3par.c:84`, `mos3mpar.c:183`).

The `cp_getvar("scale", …)` lookup in `MOS3param` (`mos3par.c:28-29`) is a C
global-variable read that scales `w`/`l`/`as`/`ad`/`ps`/`pd`. digiTS has no
`scale` global; the netlist parser applies device-geometry scale upstream, so
the `scale` multiply is **NO-COUNTERPART at the element** (the value reaches the
element already scaled, the same treatment the VDMOS spec gave `vdmospar.c`
`scale`). If the digiTS parser does **not** apply geometry scale, flag it — but
the MOS1 element has no `scale` handling either, so the established convention
is that scale is upstream.

The bare `ic=vds,vgs,vbs` vector (`mos3par.c:91-110`) is split by the netlist
parser into scalar `ICVDS`/`ICVGS`/`ICVBS` writes (digiTS's property bag is
scalar-keyed; there is no vector param), reproducing the `numValue` 3→2→1
fallthrough — `ic=vds` sets only ICVDS; `ic=vds,vgs` sets ICVDS+ICVGS; etc.
This is the same treatment `jfet-initialConditions.md` Part C gave the JFET
`ic` vector.

**Forbidden shapes:** computing defaults differently from `mos3set.c`/
`mos3temp.c` (e.g. pre-evaluating `kappa=.2`/`mjsw=.33` to a different literal);
adding `MOS3mParam` setters for `xd`/`alpha`/`uexp`/`neff` (they have no setter
in ngspice — they are derived/output); folding the temperature recompute into
`setParam`; treating `vmax`/`theta`/`eta`/`xj`/`nfs` as MOS1 params (they are
the level-3 distinguishing params and must be present).

---

## Part C — `setup()` (rebuild of `MOS3setup`)

### ngspice baseline

`MOS3setup` (`mos3set.c:18-260`) does, per model then per instance:

1. **Model default block** (`:34-141`) — the ~40 `if(!Given) default` lines
   tabulated in Part B.
2. **State allocation** (`:151-152`): `here->MOS3states = *states;
   *states += MOS3NUMSTATES` (17).
3. **Per-instance geometry/IC defaults** (`:154-186`): `drainArea` ←
   `CKTdefaultMosAD`, `drainPerimiter`←0, `drainSquares`←1, `icVBS/icVDS/icVGS`
   ←0, `sourcePerimiter`←0, `sourceSquares`←1, `vdsat`←0, `von`←0, `mode`←1.
4. **Internal-node allocation** (`:188-226`):
   - `dNodePrime` via `CKTmkVolt(…, "internal#drain")` **only if**
     `(drainResistance != 0 || (sheetResistance != 0 && drainSquares != 0))`,
     else `= dNode` (`:188-206`).
   - `sNodePrime` via `CKTmkVolt(…, "internal#source")` **only if**
     `(sourceResistance != 0 || (sheetResistance != 0 && sourceSquares != 0))`,
     else `= sNode` (`:208-226`).
   - The `CKTcopyNodesets` nodeset-propagation blocks (`:195-202`,`:215-222`)
     are a nodeset-seeding convenience — port if digiTS exposes the equivalent
     nodeset-copy hook, else NO-COUNTERPART (digiTS handles nodesets at the
     compiler layer; the VDMOS spec made the same call, Part C item 4).
5. **TSTALLOC** (`:234-255`) — see Part C-matrix.

### digiTS counterpart

`Mosfet3AnalogElement.setup(ctx)` (sibling of `mosfet.ts:913-963`). Resolve the
conductances (`_drainConductance`/`_sourceConductance` are computed in
`MOS3temp` `:159-196`, **not** in setup — note this differs from some devices;
in MOS3 the conductance values come out of the temperature pass, while setup
only decides whether the prime node is allocated). Allocate internal prime
nodes via `ctx.makeVolt(label, suffix)` (the `CKTmkVolt` counterpart,
`mosfet.ts:923,932`) **under the same gates**:
`dPrime` only if `(rd != 0 || (rsh != 0 && drainSquares != 0))`, `sPrime` only
if `(rs != 0 || (rsh != 0 && sourceSquares != 0))`; default each to the
external node otherwise. State allocation is implicit via
`stateSize = MOSFET3_SCHEMA.size` (17).

### Part C-matrix — TSTALLOC order (Sparse Solver is Settled)

Per CLAUDE.md "Sparse Solver is Settled — Do Not Re-Investigate" and MEMORY.md
`feedback_structural_match_not_semantic`, the `solver.allocElement(row, col)`
sequence is **line-for-line** the `mos3set.c` TSTALLOC order (a swapped pair
changes the matrix element-pool order and is structurally visible at the
harness CSC dump). Handles cached as `_h*` fields, reused in `load()`/
`stampAc()` — **no `allocElement` in `load`/`stampAc`**. This is the identical
22-cell pattern the MOS1 element already uses (`mosfet.ts:942-963`), since the
MOS1 and MOS3 TSTALLOC sequences are the same node set. `mos3set.c:234-255`,
in exactly this order:

```
(1)  MOS3DdPtr   (dNode,   dNode)    mos3set.c:234
(2)  MOS3GgPtr   (gNode,   gNode)    :235
(3)  MOS3SsPtr   (sNode,   sNode)    :236
(4)  MOS3BbPtr   (bNode,   bNode)    :237
(5)  MOS3DPdpPtr (dPrime,  dPrime)   :238
(6)  MOS3SPspPtr (sPrime,  sPrime)   :239
(7)  MOS3DdpPtr  (dNode,   dPrime)   :240
(8)  MOS3GbPtr   (gNode,   bNode)    :241
(9)  MOS3GdpPtr  (gNode,   dPrime)   :242
(10) MOS3GspPtr  (gNode,   sPrime)   :243
(11) MOS3SspPtr  (sNode,   sPrime)   :244
(12) MOS3BdpPtr  (bNode,   dPrime)   :245
(13) MOS3BspPtr  (bNode,   sPrime)   :246
(14) MOS3DPspPtr (dPrime,  sPrime)   :247
(15) MOS3DPdPtr  (dPrime,  dNode)    :248
(16) MOS3BgPtr   (bNode,   gNode)    :249
(17) MOS3DPgPtr  (dPrime,  gNode)    :250
(18) MOS3SPgPtr  (sPrime,  gNode)    :251
(19) MOS3SPsPtr  (sPrime,  sNode)    :252
(20) MOS3DPbPtr  (dPrime,  bNode)    :253
(21) MOS3SPbPtr  (sPrime,  bNode)    :254
(22) MOS3SPdpPtr (sPrime,  dPrime)   :255
```

**Forbidden shapes:** sorting/grouping the allocations; allocating any cell
inside `load()`/`stampAc()`; substituting the MOS1 element's `_h*` handle order
without re-deriving it against `mos3set.c` (the orders happen to match, but the
implementer must verify cell-by-cell, not assume).

---

## Part D — `computeTemperature()` + `_computeTempInstance()` (rebuild of `MOS3temp`)

### ngspice baseline

`MOS3temp` (`mos3temp.c:17-343`) is **two** nested passes:

**Model preprocessing** (`:39-114`, once per model):
- nominal constants `fact1`/`vtnom`/`kt1`/`egfet1`/`arg1`/`pbfact1`/`nifact`/
  `ni_temp` (`:44-54`).
- `phi <= 0` fatal (`:56-60`).
- `oxideCapFactor = 3.9*8.854214871e-12 / oxideThickness` (`:62-63`);
  `surfaceMobility` default 600 (`:64`); `transconductance` default
  `surfaceMobility * oxideCapFactor * 1e-4` (`:65-68`).
- if `substrateDoping` given and `nsub*1e6 > ni`: derive `phi` (`:71-76`),
  `fermis`/`wkfng`/`fermig`/`wkfngs` (`:77-84`), `gamma` (`:85-89`), `vt0`/`vfb`
  (`:90-101`), `alpha`/`coeffDepLayWidth` (`:102-104`); else fatal if `nsub<ni`
  (`:105-110`).
- `narrowFactor = delta * 0.5 * M_PI * EPSSIL / oxideCapFactor` (`:113-114`).
  `EPSSIL = 11.7 * 8.854214871e-12` (`:15`).

**Per-instance correction** (`:118-340`, once per instance):
- `dtemp` default 0 (`:131-133`); `temp = CKTtemp + dtemp` if not given
  (`:135-137`); `vt`/`ratio`/`fact2`/`kt`/`egfet`/`arg`/`pbfact` (`:138-145`).
- geometry defaults `m`/`l`/`sourceArea`/`w` (`:147-158`).
- `drainConductance`/`sourceConductance` from `rd`/`rs`/`rsh*squares`
  (`:159-196`).
- effective-length/width `> 0` fatal checks (`:198-212`).
- `ratio4 = ratio*sqrt(ratio)`; `tTransconductance = transconductance/ratio4`
  (`:214-215`); `tSurfMob = surfaceMobility/ratio4` (`:216`); `tPhi`/`tVbi`/
  `tVto` (`:217-226`); `tSatCur`/`tSatCurDens` Arrhenius (`:227-230`); the
  junction-cap temp-scale `tCbd`/`tCbs`/`tCj`/`tCjsw`/`tBulkPot`/`tDepCap`
  (`:231-251`); `sourceVcrit`/`drainVcrit` (`:253-267`); the `czbd`/`czbdsw`/
  `f2d`/`f3d`/`f4d` drain and `czbs`/`czbssw`/`f2s`/`f3s`/`f4s` source
  junction-charge coefficients (`:268-339`).

Most of the per-instance block is **identical algebra** to MOS1's
`computeTempParams` (`mosfet.ts:399-533`); the MOS3-specific additions are the
`narrowFactor`/`alpha`/`coeffDepLayWidth`/`gamma`-from-`nsub` model
preprocessing the level-3 load consumes.

### digiTS counterpart

`computeTemperature` is invoked by the engine after `setup()` and on every
`setCircuitTemp()` (the MOS1 element's `computeTemperature` at
`mosfet.ts:882`). Split the same way ngspice does:

```ts
computeTemperature(ctx: TempContext): void {
  // cite: mos3temp.c:39-114 — model preprocessing (oxideCapFactor, gamma/phi
  // from nsub, alpha, coeffDepLayWidth, narrowFactor), once.
  this._computeModelTemp(ctx);
  // cite: mos3temp.c:131-137 — dtemp default, temp = CKTtemp + dtemp.
  if (!this._dtempGiven) this._dtemp = 0.0;
  if (!this._tempGiven)  this._temp  = ctx.cktTemp + this._dtemp;
  // cite: mos3temp.c:118-340 — per-instance temperature correction.
  this._computeTempInstance(this._temp, ctx);
}
```

Both helpers are **private** methods (not the hook), porting their ngspice
blocks line-for-line. The two fatal paths (`phi<=0` `:56-60`; `nsub<ni`
`:107-109`) and the two effective-dimension fatals (`:200-203`,`:208-211`)
route through `ctx.diagnostics` as the cap/MOS1 pilots did. The MOS1 element's
`computeTempParams` (`mosfet.ts:399`) is the reference for the shared algebra,
but MOS3 keeps its **own** copy (the MOS3 model preprocessing computes
`gamma`/`alpha`/`coeffDepLayWidth`/`narrowFactor`, which MOS1 does not) — do
**not** import MOS1's helper.

**Forbidden shapes:** caching `_computeTempInstance` results across temperature
changes; re-associating the `egfet`/`pbfact`/`tVbi` operand trees (match
`mos3temp.c:142-145,217-226` exactly); replacing `ratio*sqrt(ratio)` with
`Math.pow(ratio,1.5)` (use the `ratio4 = ratio*sqrt(ratio)` form,
`mos3temp.c:214`); sharing MOS1's `computeTempParams` (it lacks the level-3
model preprocessing).

---

## Part E — `load()` (rebuild of `MOS3load`)

`MOS3load` (`mos3load.c:18-1267`) is one pass per device per NR iteration (the
digiTS unified-interface model, like the MOS1 element's `load()`). The
structure, with verified line ranges:

1. **Per-instance useful values** (`:130-155`): `EffectiveWidth`/
   `EffectiveLength`, `DrainSatCur`/`SourceSatCur`, the three overlap caps,
   `Beta = tTransconductance*m*W/L`, `OxideCap`.
2. **Voltage recovery** (`:206-397`): predictor (`MODEINITPRED|MODEINITTRAN`,
   `:210-229`), general NR (read `rhsOld`, `:235-243`), `delv*`/`cdhat`/`cbhat`
   convergence extrapolation (`:250-281`), the `#ifndef NOBYPASS` bypass block
   (`:282-336`) — digiTS may keep or drop bypass per the sibling-device
   convention; if kept, port the reltol gates line-for-line — `von` recovery
   (`:339`), the `#ifndef NODELIMITING` limiting (`DEVfetlim`→`fetlim`,
   `DEVlimvds`→`limvds`, `DEVpnjlim`→`pnjlim`, `:349-372`), and the
   `MODEINITJCT`/off init branch (`:375-397`).
3. **Bulk-source / bulk-drain diodes** (`next1:`, `:414-433`): the ideal-diode
   current + conductance, with the `vbs <= -3*vt` series-expansion branch and
   the `CKTgmin` add — identical structure to the MOS1 element.
4. **Mode determination** (`:438-444`): `mode = (vds>=0) ? 1 : -1`.
5. **The level-3 semi-empirical drain-current model** (`moseq3`, `:446-871`) —
   **the load-bearing MOS3-specific port.** This is the block that distinguishes
   MOS3 from MOS1. It must be ported BIT-EXACT, line-for-line, with the
   ngspice operand order preserved. The sub-blocks, with verified lines:
   - the empirical constants `coeff0=0.0631353`/`coeff1=0.8013292`/
     `coeff2=-0.01110777` (`:457-459`).
   - `oneoverxl`, `eta = MOS3eta*8.15e-22/(oxideCapFactor*L³)` (`:560-562`).
   - **square-root term** `phibs`/`sqphbs`/`dsqdvb` with the `vbs<=0` vs `>0`
     branch (`:566-577`).
   - **short-channel effect factor** `fshort` via `wps`/`oneoverxj`/`xjonxl`/
     `djonxj`/`wponxj`/`wconxj`/`arga`/`argb`/`argc`, gated on
     `(junctionDepth!=0 && coeffDepLayWidth!=0)` (`:581-600`). This is the
     **XJ short-channel** term.
   - **body effect** `gammas = gamma*fshort`/`fbodys`/`fbody`/`onfbdy`/`dfbdvb`/
     `qbonco`/`dqbdvb` with the `narrowFactor/W` **narrow-channel** add
     (`:604-611`).
   - **static feedback** `vbix = tVbi*type - eta*(mode*vds)` (`:615`) — the
     **ETA** drain-induced threshold shift.
   - **threshold voltage** `vth`/`dvtdvd=-eta`/`dvtdvb` (`:619-621`).
   - **weak/strong inversion join** via `NFS` (`fastSurfaceStateDensity`):
     `csonco`/`cdonco`/`xn`/`von`/`dxndvb` when `nfs!=0`, else the cutoff
     early-out (`goto innerline1000`) when `vgs<=von` (`:625-647`).
   - **mobility modulation by gate voltage** (**THETA**): `onfg = 1+theta*
     (vgsx-vth)`, `fgate=1/onfg`, `us = tSurfMob*1e-4*fgate`,
     `dfgdvg`/`dfgdvd`/`dfgdvb` (`:651-660`).
   - **saturation voltage** `vdsat` with the **VMAX** (`maxDriftVel`) velocity-
     saturation branch (`vdsc`/`onvdsc`/`arga`/`argb`) vs the `vmax<=0` branch
     (`:664-679`).
   - **linear-region current factors** `cdo`/`dcodvb`/`cdnorm`, the
     `gm`/`gds`/`gmbs` partials, `cd1`, `Beta*=fgate`, `cdrain=Beta*cdnorm`
     (`:683-703`).
   - **velocity-saturation factor** `fdrain`/`fd2` when `vmax>0`, updating
     `gm`/`gds`/`gmbs`/`cdrain`/`Beta` (`:707-723`).
   - **channel-length modulation** (**KAPPA**): the `line510`/`line520`/
     `line700` branches with `delxl`/`dldvd`/`ddld*`, the `emax`/`emoncd`/
     `emongd` field block, the punch-through approximation (`:726-826`), and
     the `xlfact` saturation-region scaling.
   - **weak-inversion** `wfact = exp((vgs-von)*ondvt)` tail (`line700`,
     `:831-849`).
   - the `vds==0` special case (`line900`, `:857-866`).
6. **Polarity + cd** (`:874-882`): `MOS3von`/`MOS3vdsat`/`MOS3cd`.
7. **Bulk-junction caps + charge** (`:884-1012`): the `vbs<vtDepCap` depletion-
   cap vs `f2/f3/f4` polynomial branch for `qbs`/`capbs` and `qbd`/`capbd`,
   with the `mj==mjsw==.5` sqrt fast-path.
8. **Charge integration of the bulk caps** (`:1015-1038`): `NIintegrate`
   (→`niIntegrate`) for `capbd`/`qbd` and `capbs`/`qbs`.
9. **Convergence flag** (`:1045-1051`): `Check==1 → ckt->CKTnoncon++` inline
   (the `convTest` fold; see Part E-conv).
10. **State save** `vbs`/`vbd`/`vgs`/`vds` (`:1056-1059`).
11. **Meyer caps via `DEVqmeyer`** (`:1065-1156`): `devQmeyer` (already in
    `mosfet.ts:581`) with the `mode>0` vs `<0` arg swap, the double-vs-add-half
    `capgs`/`capgd`/`capgb` protocol, the predictor charge extrapolation, and
    the `MODETRAN`/`TRANOP` charge update.
12. **Meyer charge integration** (`:1162-1194`): `NIintegrate` for
    `capgs`/`qgs`, `capgd`/`qgd`, `capgb`/`qgb`, then the `ceqg*` assembly.
13. **RHS load** (`:1202-1224`): `ceqbs`/`ceqbd`/`cdreq` with the
    `mode>=0`/`<0` branch and the `MOS3type` polarity, into the gate/bulk/
    dPrime/sPrime rows.
14. **Y-matrix stamps** (`:1236-1263`): the full 22-cell stamp via the cached
    `_h*` handles (no `allocElement`).

All stamps go through the `_h*` handles cached in `setup()`. Limiters and
`niIntegrate`/`devQmeyer` are the existing exports — reuse, do not re-derive.

### Part E-conv — convergence (the `MOS3convTest` fold)

`MOS3convTest` (`mos3conv.c:12-99`) recomputes `cdhat`/`cbhat` from the latest
`rhs` and increments `CKTnoncon` when `|cdhat-cd|` or `|cbhat-(cbs+cbd)|`
exceeds the reltol/abstol tolerance. In the digiTS unified-interface model
there is no separate `convTest` vtable slot — the convergence check is folded
inline into `load()` at the `Check`-flag site (`mos3load.c:1045-1051`),
incrementing `ctx.noncon` exactly as the MOS1 element does. Per MEMORY.md
`feedback_structural_match_not_semantic`, do **not** author a standalone
`convTest()` method; the check lands where ngspice's `Check` flag is consumed.

**Forbidden shapes (level-3 drain-current, §load):** re-associating any operand
in the `moseq3` block (`:457-871`) — the `wconxj`/`fshort`/`gammas`/`qbonco`/
`vbix`/`vth`/`onfg`/`vdsat`/`cdnorm`/`delxl`/`xlfact`/`wfact` chain is
floating-point-order-sensitive and must match line-for-line; dropping the XJ
short-channel `fshort` factor, the ETA static-feedback term, the THETA mobility
modulation, the VMAX velocity-saturation branch, or the KAPPA channel-length
modulation (these five are what make it level-3 — omitting any reduces it to a
different model); reordering the `line510`/`line520`/`line700`/`line900`
goto structure; substituting the MOS1 drain-current core; using `Math.pow`
where ngspice uses `exp(c*log(arg))` (`:284-285,931-932`).

---

## Part F — `stampAc()` (rebuild of `MOS3acLoad`)

### ngspice baseline

`MOS3acLoad` (`mos3acld.c:16-124`): stamps the **imaginary half** (the `+1`
pointer offset) of the Meyer-cap admittances `xgd`/`xgs`/`xgb` and the
bulk-junction-cap admittances `xbd`/`xbs` (`xgs = capgs*CKTomega` etc.,
`:74-78`; `capgs = 2*state0[capgs] + GateSourceOverlapCap` `:65-67`), plus the
real conductances `drainConductance`/`sourceConductance`/`gbd`/`gbs`/`gds`/
`gm`/`gmbs` with the `xnrm`/`xrev` mode factors (`:84-120`).

### digiTS counterpart

`Mosfet3AnalogElement.stampAc(solver, omega, loadCtx, rhsRe, rhsIm)` (the
`stampAc?` hook; sibling `mosfet.ts:1719`). AC is implemented and unified
(MEMORY.md `project_ac_solver_unified` — AC uses `SparseSolver` complex mode,
not a separate complex solver). Reads the cap/conduct state slots populated by
the last DC `load()`, stamps the imaginary half into the **same** `_h*`
handles allocated in `setup()`. **No `allocElement` in `stampAc`.**

Per OPEN-QUESTIONS-WORKLOG #46 (`mos1 Q2 — full MOS1acLoad vs caps-only`,
ratified **full**: "IN-class completeness"), the MOS3 `stampAc` likewise
rebuilds the **full** `MOS3acLoad` — both the imaginary cap admittances **and**
the real conductances (`mos3acld.c:98-120`) — not a caps-only subset.

**Forbidden shapes:** allocating cells in `stampAc`; omitting the real
conductance stamps (`:98-120`) — the full ac-load per #46; using `capgs`/
`capgd`/`capgb` without the `2*` doubling (`mos3acld.c:65-73`); reordering the
imaginary stamps relative to `mos3acld.c:84-97`.

---

## Part G — `getLteTimestep()` (rebuild of `MOS3trunc`)

`MOS3trunc` (`mos3trun.c:12-27`) calls `CKTterr` on three charge slots:
`MOS3qgs`, `MOS3qgd`, `MOS3qgb` (`:21-23`). digiTS counterpart:
`Mosfet3AnalogElement.getLteTimestep(...)` (the `getLteTimestep?` hook; sibling
`mosfet.ts:1878`) calls `cktTerr` (`ckt-terr.ts:103`) on the `QGS`, `QGD`, and
`QGB` slots, resolved by name through `stateSchema`, in that order.

**Forbidden shapes:** including the bulk-junction charges `QBD`/`QBS` — `MOS3trunc`
truncates only on the three Meyer-gate charges (`mos3trun.c:21-23`); do not add
`QBD`/`QBS` (the bulk caps are LTE-controlled through their own integration, not
this trunc list — match ngspice's three calls exactly).

---

## Part H — Registration

`src/components/register-all.ts` gains `registry.register(Mosfet3NDefinition)`
and `registry.register(Mosfet3PDefinition)` in the analog-component
registration block (the same place `NmosfetDefinition`/`PmosfetDefinition` are
registered, `register-all.ts` near the MOS1 lines). MOS3 has **no** new solver
primitive to register (it reuses `devQmeyer`/`pnjlim`/`fetlim`/`limvds`/
`niIntegrate`/`cktTerr`), so there is no `newton-raphson.ts` landing site
(contrast VDMOS Part H/`devCapVdmos`).

---

## Part I — Three-surface test plan (CLAUDE.md three-surface rule)

Per the CLAUDE.md three-surface testing rule, the MOS3 feature is tested across
all three surfaces, plus a harness parity gate.

### Surface 1 — Headless API (`src/components/semiconductors/__tests__/mosfet3.test.ts`)

Per `docs/api-reference/test-tools.md`, a Tier-2/Tier-3 analog component test.
Use the sanctioned `ComparisonSession` / `buildFixture` helpers — **do not**
hand-assemble `LoadContext`/`SetupContext`/`StatePool`, do not call
`element.setup()`/`load()` directly, do not import `SLOT_*` constants (CLAUDE.md
"Component Test Authoring" + MEMORY.md `feedback_schema_lookups_over_exports`).
Cover:

- DC operating point of an NMOS3 common-source stage (gate on / off): drain
  current, `gm`, `gds`, `von`, `vdsat` via the facade, exercising the level-3
  THETA/VMAX/KAPPA terms (a short channel `L` with `theta`/`vmax`/`kappa`/`xj`/
  `eta`/`nfs` set so the level-3 corrections are non-trivial).
- A 4-terminal configuration with the bulk node biased separately from the
  source (the body-effect / `gamma`-from-`nsub` path) — distinct from MOS1's
  bulk=source shape.
- Transient turn-on/turn-off through the Meyer gate caps.
- Hot-loadable params: `setParam` on `kp`/`vto`/`theta`/`kappa`/`vmax`/`rd`
  re-takes effect on the next compile/step (CLAUDE.md "Hot-loadable params").
- AC small-signal: a gate-driven AC sweep showing the Cgs/Cgd roll-off (full
  ac-load per #46).

### Surface 2 — MCP tool (`src/components/semiconductors/__tests__/mosfet3-mcp.test.ts`)

Exercise via the MCP server tool handlers (`circuit_build` → `circuit_compile`
→ `circuit_dc_op`/`circuit_step`/`circuit_ac_sweep`). Validate the agent-facing
contract: `NMOS3`/`PMOS3` discoverable (`circuit_describe`), the level-3 model
params (`theta`/`kappa`/`vmax`/`xj`/`eta`/`delta`/`nfs`) serialize round-trip,
the 4-terminal pin set forwards, and DC-OP/transient/AC results serialize.

### Surface 3 — E2E / UI (`e2e/parity/mos3.spec.ts`)

Playwright via `SimulatorHarness` (`e2e/fixtures/simulator-harness.ts`). Load a
MOS3 circuit over postMessage (`sim-load-json`), drive the gate (`sim-set-signal`),
step (`sim-step`), read the drain node (`sim-read-signal`), assert the switch /
amplifier behavior. Per MEMORY.md `feedback_e2e_ui_alignment`, this surface is
non-negotiable even when headless passes.

### Harness parity gate (§device-completion bar) — FIXTURE MUST BE AUTHORED

**No MOS3 gate fixture exists** (Ratification item 2). A NEW fixture — a
level-3 MOSFET amplifier / inverter (`NMOS3` with a short channel + a load,
gate drive, supplies) — must be authored, following the existing
`mosfet-inverter.dts` fixture format (`{ "format": "dts", "version": 1,
"circuit": { elements, wires, _modelParams } }`). Suggested location/name:
`src/solver/analog/__tests__/ngspice-parity/fixtures/mos3-amp.dts` (the
implementer confirms the canonical fixtures directory against the MOS1
fixture's actual path). Driven through the harness MCP tools per the CLAUDE.md
triage path (`harness_start` → `harness_run` → `harness_first_divergence` →
`harness_topology_diff`/`harness_matrix_diff` → `harness_get_attempt`), the
device must reach bit-exact per-NR-iteration parity against the instrumented
ngspice DLL for DC-OP and transient. A second AC fixture (`mos3-ac.dts`) gates
the `stampAc` path.

---

## Blocked hunks (the 43 MOS3 ledger hunks this reconstruction unblocks)

All entries below are currently `classification: null, tsFile: null` in
`spec/v41-port/ledger.json` (the mos3 block, `ledger.json:2737-2970`). This
reconstruction is the digiTS counterpart against which they classify. **43
hunks across 26 files** (tally verified against the ledger):

| ngspice file | hunks | role under this reconstruction |
|---|---|---|
| `mos3/Makefile.am` | 2 | NO-COUNTERPART (build system) |
| `mos3/mos3.c` | 2 | Part B (IFparm tables → param defs) |
| `mos3/mos3acld.c` | 1 | Part F (`stampAc`) |
| `mos3/mos3ask.c` | 3 | NO-COUNTERPART (IFparm readback plumbing; res.c precedent) |
| `mos3/mos3conv.c` | 1 | Part E-conv (folded into `load`) |
| `mos3/mos3defs.h` | 4 | Parts A/B (state schema + param enums) |
| `mos3/mos3del.c` | 2 | NO-COUNTERPART (instance teardown; fresh-engine-per-compile, #29 precedent) |
| `mos3/mos3dest.c` | 1 | NO-COUNTERPART (model teardown; C-free) |
| `mos3/mos3dist.c` | 1 | NO-COUNTERPART (distortion analysis OUT) |
| `mos3/mos3dset.c` | 1 | NO-COUNTERPART (distortion setup OUT) |
| `mos3/mos3ext.h` | 1 | NO-COUNTERPART (IFparm extern decls) |
| `mos3/mos3ic.c` | 1 | Part B (IC capture; or gated on a `getic` hook — see Q-MOS3-IC-GETIC) |
| `mos3/mos3init.c` | 1 | Part H (registration; DEVice-dispatch C-array, NO-COUNTERPART-shaped) |
| `mos3/mos3load.c` | 1 | Part E (the level-3 drain-current load) |
| `mos3/mos3mdel.c` | 1 | NO-COUNTERPART (model teardown; C-free) |
| `mos3/mos3noi.c` | 3 | NO-COUNTERPART (noise analysis OUT) |
| `mos3/mos3par.c` | 2 | Part B (instance param parse) |
| `mos3/mos3pzld.c` | 1 | NO-COUNTERPART (pole-zero analysis OUT) |
| `mos3/mos3sacl.c` | 2 | NO-COUNTERPART (sensitivity ac-load OUT) |
| `mos3/mos3set.c` | 3 | Part C (`setup` + TSTALLOC); `MOS3unsetup` NO-COUNTERPART (#29 mos1 precedent) |
| `mos3/mos3sld.c` | 2 | NO-COUNTERPART (sensitivity load OUT) |
| `mos3/mos3sprt.c` | 1 | NO-COUNTERPART (sensitivity print OUT) |
| `mos3/mos3sset.c` | 1 | NO-COUNTERPART (sensitivity setup OUT) |
| `mos3/mos3supd.c` | 2 | NO-COUNTERPART (sensitivity update OUT) |
| `mos3/mos3temp.c` | 2 | Part D (temperature) |
| `mos3/mos3trun.c` | 1 | Part G (`getLteTimestep`) |

Sum: 2+2+1+3+1+4+2+1+1+1+1+1+1+1+1+3+2+1+2+3+2+1+1+2+2+1 = **43**. The
NO-COUNTERPART classifications (sensitivity / distortion / noise / pole-zero /
teardown / build / IFparm-plumbing) follow the ratified precedents:
sensitivity/distortion/noise/PZ are non-implemented analyses; teardown is
fresh-engine-per-compile (OPEN-QUESTIONS #28/#29 ccvs/mos1 unsetup); IFparm
readback (`mos3ask.c`) matches the `res.c`/`cccsask.c` precedent (#32/#49). The
final classification of each NO-COUNTERPART line is a user action on the overlay
(MEMORY.md `feedback_no_architectural_alignment_doc`) — this spec **proposes**
the routing; it does not edit the ledger.

---

## Ratification items (require USER decision before implementation)

1. **File placement — NEW `src/components/semiconductors/mosfet3.ts` (recommended)
   vs extending `mosfet.ts`.** Recommended: a new peer file `mosfet3.ts`, sibling
   of `vdmos.ts`/`njfet.ts`/`pjfet.ts`. Rationale: MOS3's load() is an entirely
   different drain-current core (THETA/VMAX/KAPPA/ETA/XJ/NFS semi-empirical),
   not a variant of the MOS1 Shichman-Hodges core; folding it into `mosfet.ts`
   would bloat that file and entangle two distinct model levels. This matches
   the wholeClass precedent (asrc/jfet2/mes/vdmos each got their own file). The
   limiters, `niIntegrate`, and `cktTerr` are already module-level exports MOS3
   imports — no code is duplicated for those. The Meyer helper `devQmeyer`
   (`mosfet.ts:581`) is the exception: it is **module-private** (no `export`), so
   this recon must EXPORT it from `mosfet.ts` (adding `mosfet.ts` to the touch
   set) or hoist it to a shared module before `mosfet3.ts` can reuse it — see the
   "Files touched" precondition correction above.

2. **MOS3 gate fixture must be authored — none exists.** The §device-completion
   harness bar requires a level-3 MOSFET fixture (`mos3-amp.dts` + `mos3-ac.dts`),
   which does **not** exist today. Authoring it (a short-channel NMOS3 amp /
   inverter exercising the level-3 corrections) is in-scope for the
   implementation but is called out here because the parity gate cannot run
   without it.

3. **N/P-channel shape — one polarity-factory file, two components `NMOS3`/`PMOS3`.**
   Recommended: the MOS1 precedent (`mosfet.ts`: one file,
   `_createMosfetElementWithPolarity(±1)`, two definitions `NMOS`/`PMOS`) and
   the ratified MES decision (OPEN-QUESTIONS #26: NMESFET/PMESFET as channel
   polarity = an invariant two-component axis). Ship `Mosfet3NDefinition` /
   `Mosfet3PDefinition` from one `mosfet3.ts` with a polarity closure. Component
   names `NMOS3`/`PMOS3` are a user-confirmable naming choice (alternatives:
   `NMOSFET3`/`PMOSFET3`).

4. **4-terminal (separate Bulk pin) vs 3-terminal (bulk=source).** ngspice MOS3
   is genuinely 4-terminal (`MOS3bNode`, `MOS3names[] = {Drain,Gate,Source,Bulk}`,
   `mos3.c:162-167`); the existing MOS1 element is 3-terminal with bulk tied to
   source (`mosfet.ts:2089-2103`). Recommended: ship MOS3 **4-terminal** (D/G/S/B)
   to preserve the body-effect / separately-biased-bulk capability the level-3
   model targets (IC use). This is a genuine shape decision: a 4-terminal pin
   layout changes the editor symbol and the netlist addressing. (If the user
   prefers a 3-terminal default with bulk auto-tied to source, that is a
   reduction of ngspice's capability and must be an explicit ratification, not
   an implementer default.)

5. **Open question Q-MOS3-IC-GETIC (`mos3ic.c`).** `MOS3getic` captures the
   operating-point IC when `icvds`/`icvgs`/`icvbs` are not netlisted — the same
   `getic`/`setic` engine-hook dependency flagged for JFET
   (`jfet-initialConditions.md` Part D / Q-JFET-IC-GETIC). If the analog engine
   exposes a `setic`/`getic` element hook, port `MOS3getic`; otherwise the IC
   *parse* (Part B) is self-contained and the operating-point *capture* routes
   to the engine-subsystem planner. This is unresolved in
   OPEN-QUESTIONS-WORKLOG (no MOS3-specific OQ exists; the JFET analog governs)
   — flag for the same resolution as Q-JFET-IC-GETIC.

No frozen OPEN-QUESTIONS resolution governs MOS3's file placement or N/P shape
directly; #29 (`MOS3unsetup`→NO-COUNTERPART) and #46 (full ac-load) are the only
MOS3-adjacent rulings, both honored above.

---

## Acceptance criteria (enumerated, checkable)

1. `MOSFET3_SCHEMA` (`mosfet3.ts`) declares exactly **17** slots in the
   `mos3defs.h:277-302` order; `stateSize === 17`. Slot offsets resolved by name
   via `stateSchema`, never via imported `SLOT_*` constants. No sensitivity
   slots appended.
2. `MOSFET3_N_PARAM_DEFS` / `MOSFET3_P_PARAM_DEFS` declare the full instance set
   (`m`/`w`/`l`/`as`/`ad`/`ps`/`pd`/`nrs`/`nrd`/`off`/`icvds`/`icvgs`/`icvbs`/
   `ic`/`temp`/`dtemp`) and the full model set (`vto`/`kp`/`gamma`/`phi`/`rd`/
   `rs`/`cbd`/`cbs`/`is`/`pb`/`cgso`/`cgdo`/`cgbo`/`rsh`/`cj`/`mj`/`cjsw`/`mjsw`/
   `js`/`tox`/`ld`/`xl`/`wd`/`xw`/`delvto`/`u0`/`fc`/`nsub`/`tpg`/`nss`/
   **`eta`/`delta`/`nfs`/`theta`/`vmax`/`kappa`/`xj`**/`tnom`/`kf`/`af`).
   Defaults match `mos3set.c`/`mos3temp.c` (`kappa=.2`, `mjsw=.33`, `tox=1e-7`,
   `is=1e-14`, `kp=2e-5`, `u0=600`, etc.). `temp`/`tnom` apply `+CONSTCtoK`. No
   setters for the derived `xd`/`alpha`/`uexp`/`neff`.
3. `Mosfet3NDefinition`/`Mosfet3PDefinition` (Ratification 3) register a
   `modelRegistry` whose default model (`"spice-l3"`) carries `MOS3type = +1`/`-1`
   via a polarity closure factory; `defaultModel` only seeds the initial model
   (component-model-architecture rule). 4-terminal D/G/S/B pin layout
   (Ratification 4). All params hot-loadable via `setParam`.
4. `setup()` allocates `dPrime` iff `(rd!=0 || (rsh!=0 && drainSquares!=0))` and
   `sPrime` iff `(rs!=0 || (rsh!=0 && sourceSquares!=0))` per `mos3set.c:188-226`,
   defaulting each to the external node otherwise.
5. `setup()`'s `allocElement` sequence is line-for-line the `mos3set.c:234-255`
   TSTALLOC order (the 22 cells of Part C-matrix). No allocation in
   `load()`/`stampAc()`.
6. `computeTemperature(ctx)` runs the model-preprocessing pass
   (`mos3temp.c:39-114`: `oxideCapFactor`, `gamma`/`phi`/`vt0` from `nsub`,
   `alpha`, `coeffDepLayWidth`, `narrowFactor`) then the per-instance correction
   (`:118-340`); `dtemp` default, `temp = cktTemp + dtemp`. Both as private
   helpers; not shared with MOS1's `computeTempParams`. The four fatal paths
   (`phi<=0`, `nsub<ni`, eff-L<=0, eff-W<=0) route through `ctx.diagnostics`.
   No caching across temperature changes.
7. `load()` ports `MOS3load` (`mos3load.c:18-1267`): useful-values, voltage
   recovery (predictor + IC + `fetlim`/`limvds`/`pnjlim` limiting), the bulk
   diodes, **the level-3 semi-empirical `moseq3` drain-current model
   (`:446-871`) bit-exact** — with the XJ short-channel `fshort`, the ETA
   static-feedback `vbix`, the THETA mobility modulation, the VMAX velocity-
   saturation branch, and the KAPPA channel-length modulation all present and in
   ngspice operand order — the bulk-junction caps + `niIntegrate`, the Meyer
   caps via `devQmeyer` + `niIntegrate`, the RHS load, and the 22-cell Y stamp
   via cached handles. Convergence increments `ctx.noncon` inline (the
   `MOS3convTest` fold); no standalone `convTest()` method.
8. `stampAc()` ports the **full** `MOS3acLoad` (`mos3acld.c:16-124`): the `2*`-
   doubled Meyer-cap admittances, the bulk-cap admittances, the imaginary stamps,
   **and the real conductance stamps** (per OPEN-QUESTIONS #46 IN-class
   completeness). No allocation in `stampAc`.
9. `getLteTimestep()` calls `cktTerr` on `QGS`/`QGD`/`QGB` only
   (`mos3trun.c:21-23`); not `QBD`/`QBS`.
10. `register-all.ts` registers `Mosfet3NDefinition`/`Mosfet3PDefinition`. No
    new `newton-raphson.ts` solver primitive (MOS3 reuses the existing
    `devQmeyer`/`pnjlim`/`fetlim`/`limvds`/`niIntegrate`/`cktTerr`).
11. The IC vector `ic=vds,vgs,vbs` is split by the netlist parser into scalar
    `ICVDS`/`ICVGS`/`ICVBS` writes in `numValue` 3→2→1 order (`mos3par.c:91-110`).
    `MOS3getic` operating-point capture is implemented iff a `setic`/`getic`
    engine hook exists (Q-MOS3-IC-GETIC, Ratification 5); otherwise deferred to
    the engine-subsystem planner with the IC parse delivered standalone.
12. All three surface tests pass (headless / MCP / E2E) and the newly authored
    `mos3-amp.dts` (+ `mos3-ac.dts`) harness fixtures reach **bit-exact**
    per-NR-iteration parity against the instrumented ngspice DLL for DC-OP,
    transient, and AC — driven through the `harness_*` MCP tool chain
    (`harness_start` → `harness_run` → `harness_first_divergence` →
    `harness_topology_diff`/`harness_matrix_diff` → `harness_get_attempt`). No
    tolerance qualifier; strict bit-exact under the matched-arithmetic-order
    constraint per the CLAUDE.md ngspice-parity-vocabulary rule.
13. With this reconstruction `APPLIED`, the 43 blocked MOS3 hunks
    (`ledger.json:2737-2970`) classify per the Blocked-hunks table: the
    Part-mapped hunks against the new `mosfet3.ts` / `register-all.ts`, the
    NO-COUNTERPART hunks (sensitivity / distortion / noise / pole-zero /
    teardown / build / IFparm-plumbing) per the ratified precedents. The ledger
    edit is a user action on the overlay, not part of this spec.

## BUILD NOTE — run-1 MISMATCH fix (load() bypass path)

`load()` must implement the goto-bypass SKIP, not just the bypass GATE. When
`ctx.bypass` triggers and the reltol/voltTol/cdhat criterion passes
(mos3load.c:282-336), SKIP the bulk diodes + the entire `moseq3` drain-current
core + the `cd` assignment, and instead RELOAD the saved converged scalars from
instance state, setting `cdrain = opMode*(cd+cbd)` — mirror the MOS1 sibling at
`mosfet.ts:1320-1340`:
`if (bypassed) { gmNR=this._gm; gdsNR=this._gds; gmbsNR=this._gmbs; gbd=this._gbd; gbs=this._gbs; cbd=this._cbd; cbs=this._cbs; cd=this._cd; cdrain = opMode*(cd+cbd); } else { <bulk diodes>; <moseq3>; cd = opMode*cdrain - cbd; }`
The GATE alone is insufficient: re-running `moseq3` at the snapped state0 voltages
does NOT reproduce the previously-converged cdrain/gm/gds/gmbs (the criterion is a
tolerance band), so the Y-stamps + RHS diverge bit-exactly from ngspice whenever a
device bypasses. Run 1 produced a mos3 MISMATCH on exactly this. Fully contained in
`mosfet3.ts`.

Status: RATIFIED 2026-05-31 (user). Citation-review GOOD (12 ngspice citations verified, 43-hunk/26-file tally confirmed, OQ #29/#46 honored). Ratified resolutions: (1) NEW file src/components/semiconductors/mosfet3.ts (peer of vdmos.ts); (2) gate fixture mos3-amp.dts/mos3-ac.dts to be authored (follow-on); (3) NMOS3/PMOS3 polarity-factory; (4) 4-TERMINAL (separate bulk node — faithful to ngspice MOS3, not bulk-tied-to-source); (5) Q-MOS3-IC-GETIC operating-point IC capture deferred to the engine getic-hook resolution (JFET #13 analog), IC parse ships in-spec.; REVISED 2026-05-31 (precondition fix, pending re-review)
