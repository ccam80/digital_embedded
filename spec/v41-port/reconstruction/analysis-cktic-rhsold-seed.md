# Reconstruction spec — `analysis#recon/cktIcRhsOldSeed`

Status: DRAFT 2026-06-02 (user ruling: "port cktrhsold"), **pending re-review**.

Port ngspice's `CKTic` six-buffer seeding — the `CKTrhsOld[n] = CKTrhs[n] = value`
**dual-write** of nodeset/IC constraints into BOTH the current RHS and the
*previous-solution* buffer (`cktic.c:31,39`) — onto the digiTS IC/nodeset
setup path. This is the escalated `analysis/cktic.c#h001/#h002` hunks and the
standing **ESC-002** "six-buffer `CKTrhs`/`CKTrhsOld` model" gap.

## Why (the divergence)

`CKTic` runs once before the transient/DC-OP solve. For every node carrying a
`.nodeset` or `.ic`, it writes the constrained value into **two** buffers
(`cktic.c:31,39`):

```c
ckt->CKTrhsOld[node->number] = ckt->CKTrhs[node->number] = node->nodeset;  /* :31 */
ckt->CKTrhsOld[node->number] = ckt->CKTrhs[node->number] = node->ic;       /* :39 */
```

`CKTrhsOld` is the **last-accepted solution** buffer that the Newton solve reads
as its starting voltage vector (and that the gmin/source-stepping continuation
loops checkpoint/restore — `cktop.c:210-211,242-243` dynamic_gmin,
`cktop.c:568-569,635-636` gillespie_src). Seeding it with the nodeset/IC value
means the **first NR iteration starts from the constrained voltage**, not from
zero/garbage.

digiTS has a `rhsOld` buffer (`LoadCtxImpl.rhsOld`, wired in `analog-engine.ts`)
but seeds nodeset/IC **only** through the per-iteration large-conductance /
exact-`1` stamp in `cktLoad` (the `maths-sparse#recon/nodesetIcRowZero` /
FIX-002 path). It does **not** perform `CKTic`'s setup-time `rhsOld` dual-write,
so on a `.nodeset`/`.ic` circuit the first NR iteration's previous-solution
vector differs from ngspice's — a real per-setup divergence, not an accepted one.

**Relation to FIX-002 / `nodesetIcRowZero`:** complementary, not overlapping.
`nodesetIcRowZero` is the *per-iteration matrix/RHS stamp* inside `cktLoad`;
this recon is the *one-time setup seed* of the previous-solution buffer in the
`CKTic` counterpart. Both are needed for full `.nodeset`/`.ic` parity.

## ngspice mechanism (`cktic.c:13-53`, read in full)

`CKTic(ckt)`:
1. Zero `CKTrhs[0..size]` (`cktic.c:21-24`).
2. Walk `CKTnodes`; per node: if `nsGiven`, allocate the diagonal element, set
   `CKThadNodeset=1`, and `CKTrhsOld[n] = CKTrhs[n] = node->nodeset`
   (`cktic.c:27-32`); if `icGiven`, allocate the diagonal if not already, and
   `CKTrhsOld[n] = CKTrhs[n] = node->ic` (`cktic.c:33-40`).
3. If `MODEUIC`, call each device's `DEVsetic` (`cktic.c:43-50`).

The load-bearing line for this recon is the **dual-write** (`:31,39`): the value
lands in `CKTrhsOld` (previous solution) as well as `CKTrhs` (current).

## digiTS target + approach

Target: the digiTS `CKTic` counterpart — the IC/nodeset setup that runs once
before the first NR iteration and initialises the solution buffers. From the
engine structure this is in `MNAEngine` (`src/solver/analog/analog-engine.ts`)
on the transient-boot / DC-OP entry where `this.rhs` / `this.rhsOld` are
prepared (the `transientDcOp` / init path that constructs `LoadCtxImpl` with
`rhs`/`rhsOld`). The implementer locates the exact method against the live tree.

Add a `CKTic`-equivalent step: after the RHS buffers are zeroed and before the
first NR solve, for each `(node, value)` in `ctx.nodesets` and `ctx.ics`, write
the value into **both** `rhs[node]` and `rhsOld[node]` via a direct
`rhsOld[node] = rhs[node] = value` assignment — NOT `stampRHS`'s `+=` (the buffers
are freshly zeroed at setup so the numeric result is identical, but use plain
assignment to mirror `cktic.c`'s `=`). Gate it exactly as ngspice gates the
two branches (nodeset: always at IC-setup; IC: present-when-icGiven), and honor
`MODEUIC` device `setic` if/where digiTS has a `DEVsetic` counterpart (if it
does not, that sub-branch is a separate accept/port decision — escalate it, do
not invent one).

| ngspice (`cktic.c`) | digiTS | source |
|---|---|---|
| `CKTrhs[node->number]` | `rhs[node]` | `cktic.c:23,31,39` |
| `CKTrhsOld[node->number]` | `rhsOld[node]` (`LoadCtxImpl.rhsOld`) | `cktic.c:31,39` |
| `CKTrhsOld[n]=CKTrhs[n]=node->nodeset` | `rhsOld[node]=rhs[node]=value` for `ctx.nodesets` | `cktic.c:31` |
| `CKTrhsOld[n]=CKTrhs[n]=node->ic` | `rhsOld[node]=rhs[node]=value` for `ctx.ics` | `cktic.c:39` |
| zero `CKTrhs[0..size]` first | the existing buffer zero before seeding | `cktic.c:21-24` |
| `MODEUIC` -> `DEVsetic` | digiTS `DEVsetic` counterpart **if present**, else ESCALATE that sub-branch | `cktic.c:43-50` |

## Acceptance criteria

1. A `CKTic`-equivalent runs once at IC/nodeset setup (before the first NR
   iteration) and writes each nodeset value and each IC value into **both**
   `rhs[node]` and `rhsOld[node]` — bit-exact to `cktic.c:31,39`.
2. The `rhsOld` seed is the previous-solution buffer the first NR iteration
   reads, so iteration 0 of a `.ic`/`.nodeset` circuit starts from the
   constrained voltage (matching ngspice).
3. A circuit with no nodeset/IC is byte-for-byte unaffected (the seed loop is
   empty; `rhsOld` initialises as before).
4. `MODEUIC` device-IC seeding (`cktic.c:43-50`) is either ported against a real
   digiTS `DEVsetic` counterpart or ESCALATED as a separate item — never faked.
5. Harness parity on a `.ic` transient-boot fixture (`ic-gate.dts`) and a
   `.nodeset` DC-OP fixture (`nodeset-gate.dts`): `harness_first_divergence`
   `state`/`voltage`/`rhs` classes null at the first captured iteration, with the
   constrained node's `rhsOld` matching the ngspice DLL. Bit-exact, no tolerance.

## tsFiles (implementer-confirmed against the live tree)

`src/solver/analog/analog-engine.ts` (the `CKTic`-counterpart IC/nodeset setup +
`rhsOld` seed). No `stamp-helpers.ts` change is needed — the seed is a direct
`rhsOld[node]=rhs[node]=value` assignment in the engine setup, not a `stampRHS`
(`+=`) call. Structurally-forced files per the standard scope rule.

## Blocked hunks

`analysis/cktic.c#h001`, `analysis/cktic.c#h002` (the `CKTrhsOld[n]=CKTrhs[n]=v`
dual-write) apply onto this baseline as ordinary deltas once it is APPLIED.
