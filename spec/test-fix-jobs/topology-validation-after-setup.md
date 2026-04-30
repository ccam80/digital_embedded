# Topology validation must run after setup, not during compile

**Category:** `architecture-fix`

## Problem statement

`compileAnalogPartition` runs `validateTopologyAndEmitDiagnostics` (and the
helpers it dispatches into: `detectVoltageSourceLoops`, `detectInductorLoops`,
`detectCompetingVoltageConstraints`) at compile time, before any element's
`setup()` has been called. Those helpers classify each `topologyInfo` entry
via `element.branchIndex !== -1`, but `branchIndex` is only assigned inside
each element's `setup()` (per the A6.1 lazy-allocation pattern). At validation
time every `branchIndex` is still `-1`, so `isBranch` is always `false`,
`typeHint` is always `"other"`, and all three detectors silently short-circuit
to a no-op. The diagnostics never fire, and the simulator hands a singular MNA
matrix to the LU factorizer instead of refusing the build with a clear
diagnostic.

## Sites

### Production code

- `src/solver/analog/compiler.ts:1437-1448` — `topologyInfo` is built per
  element and reads `element.branchIndex` immediately after the
  `analogFactory(...)` call, before any `setup()` has run:
  ```ts
  topologyInfo.push({
    nodeIds: [...pinNodeIds],
    isBranch: element.branchIndex !== -1,                     // always false
    typeHint: element.branchIndex !== -1                      // always "other"
      ? typeof element.getLteTimestep === "function"
        ? "inductor"
        : "voltage"
      : "other",
    label: ...,
  });
  ```
- `src/solver/analog/compiler.ts:1557` — the validator is called from compile
  with this stale `topologyInfo`:
  ```ts
  validateTopologyAndEmitDiagnostics(topologyInfo, totalNodeCount, diagnostics);
  ```
- `src/solver/analog/compiler.ts:598-722` — the three detector helpers
  (`detectVoltageSourceLoops`, `detectInductorLoops`,
  `detectCompetingVoltageConstraints`) all filter on
  `e.isBranch && e.typeHint === "voltage"` (or `"inductor"`). With every entry
  carrying `isBranch=false, typeHint="other"`, every detector returns the
  empty/false result.
- `src/solver/analog/compiler.ts:812-933` — `validateTopologyAndEmitDiagnostics`
  body. The `competing-voltage-constraints` block at `:912-932` is one of the
  three branches that silently short-circuits.

### Engine setup hook (target site for the fix)

- `src/solver/analog/analog-engine.ts:1310-1327` — `MNAEngine._setup()`. After
  the per-element `el.setup(setupCtx)` loop completes (line 1313-1315) every
  element has a populated `branchIndex`. This is the first program point at
  which topology validation can run with truthful inputs. The post-setup hook
  belongs here, before `this._isSetup = true` flips on line 1326.
- `src/solver/analog/analog-engine.ts:67-181` — engine constructs and owns a
  `DiagnosticCollector` (`_diagnostics: DiagnosticCollector`) and exposes
  `onDiagnostic(callback)` (line 1205). This is the same channel the engine
  uses today for `convergence-failed` and `reactive-state-outside-pool`
  emissions, so the post-setup topology diagnostics route through it
  identically.

### Failing tests this resolves

- `src/solver/analog/__tests__/competing-voltage-constraints.test.ts:129` —
  `expect(competing.length).toBeGreaterThanOrEqual(1)` fails because the
  detector runs on `branchIndex=-1` data and produces zero conflicts. The
  same file at line 162 and 200 covers the negative cases (no diagnostic
  expected) which currently "pass" only because the detector returns nothing
  in every input.
- `src/components/passives/__tests__/transformer.test.ts:734` —
  `it.skip("analogFactory creates element with correct branch indices", ...)`.
  The skip annotation explicitly cites this same architectural ordering issue
  (`branchIndex is assigned during setup(), not construction`). Once branch
  indices are populated by `_setup()` and validation reads them there, the
  same precondition the test depends on becomes true and the skip is
  removable.

## ngspice parity citations (verbatim)

The cited ngspice source files were opened and read; the line ranges below
were verified against the file contents in this checkout
(`ref/ngspice/src/spicelib/devices/cktinit.c`,
`ref/ngspice/src/spicelib/analysis/cktsetup.c`,
`ref/ngspice/src/spicelib/devices/cktsoachk.c`,
`ref/ngspice/src/maths/ni/niiter.c`,
`ref/ngspice/src/maths/sparse/spfactor.c`).

Note on file locations: this checkout places `cktinit.c` and `cktsoachk.c`
under `src/spicelib/devices/` rather than `src/spicelib/analysis/`. The
contents match what the user described.

### `cktinit.c` (struct allocation only — no topology inspection)

`ref/ngspice/src/spicelib/devices/cktinit.c:23-135` is the body of
`CKTinit(CKTcircuit **ckt)`. Every statement is either a `TMALLOC` of a
sub-struct or an assignment of a scalar default into a freshly allocated
`CKTcircuit`. There is no walk of devices, no node inspection, no matrix,
and no branch counting. Verbatim opening lines:

```c
int
CKTinit(CKTcircuit **ckt)               /* new circuit to create */
{
    int i;
    CKTcircuit *sckt = TMALLOC(CKTcircuit, 1);
    *ckt = sckt;
    if (sckt == NULL)
        return(E_NOMEM);
    sckt->CKThead = TMALLOC(GENmodel *, DEVmaxnum);
    if(sckt->CKThead == NULL) return(E_NOMEM);
    for (i = 0; i < DEVmaxnum; i++)
        sckt->CKThead[i] = NULL;
    sckt->CKTmaxEqNum = 1;
    sckt->CKTnodes = NULL;
    sckt->CKTlastNode = NULL;
    sckt->CKTmatrix = NULL;
```

### `cktsetup.c` (per-device matrix-pointer registration only)

`ref/ngspice/src/spicelib/analysis/cktsetup.c:30-131` is the body of
`CKTsetup(CKTcircuit *ckt)`. The cross-device work is the loop at lines
72-81, which walks `DEVices[i]` and calls each device's own `DEVsetup`
function. Verbatim:

```c
for (i=0;i<DEVmaxnum;i++) {
#ifdef HAS_PROGREP
    SetAnalyse( "Device Setup", 0 );
#endif
    if ( DEVices[i] && DEVices[i]->DEVsetup && ckt->CKThead[i] ) {
        error = DEVices[i]->DEVsetup (matrix, ckt->CKThead[i], ckt,
                &ckt->CKTnumStates);
        if(error) return(error);
    }
}
```

There is no global cross-device topology validator at this stage. Per-device
`DEVsetup` records its own equation indices (`CKTnumStates`, branch rows)
into `ckt`, and that is all that happens. Voltage-source loop detection,
inductor loop detection, and "two ideal sources on one node" detection do
not exist as a separate ngspice pass.

### `cktsoachk.c` (post-convergence only)

`ref/ngspice/src/spicelib/devices/cktsoachk.c:35-53` defines `CKTsoaCheck`,
which is the only ckt-level post-load validator ngspice ships. Its mode mask
gates it to DC/op/transient *operating points*, i.e. after a successful
solve:

```c
int
CKTsoaCheck(CKTcircuit *ckt)
{
    int i, error;

    if (ckt->CKTmode & (MODEDC | MODEDCOP | MODEDCTRANCURVE | MODETRAN | MODETRANOP)) {

        SPICEdev **devs = devices();

        for (i = 0; i < DEVmaxnum; i++) {
            if (devs[i] && devs[i]->DEVsoaCheck && ckt->CKThead[i]) {
                error = devs[i]->DEVsoaCheck (ckt, ckt->CKThead[i]);
                if (error)
                    return error;
            }
        }
    }

    return OK;
}
```

This is per-device safe-operating-area; it is not topology validation.

### `niiter.c` (singular-matrix detection at LU factor time)

`ref/ngspice/src/maths/ni/niiter.c:863-905` is the loop that calls
`SMPreorder` (or `SMPluFac` on subsequent iterations) and inspects its
return code. `E_SINGULAR` is the only failure ngspice raises for the
class of "two voltage sources on one net / inductor loop / floating
node" — and it is raised only after the matrix has been assembled and
the factorizer has tried to pivot it. Verbatim:

```c
if(ckt->CKTniState & NISHOULDREORDER) {
    startTime = SPfrontEnd->IFseconds();
    error = SMPreorder(ckt->CKTmatrix,ckt->CKTpivotAbsTol,
                       ckt->CKTpivotRelTol,ckt->CKTdiagGmin);
    ckt->CKTstat->STATreorderTime +=
        SPfrontEnd->IFseconds() - startTime;
    if(error) {
        /* new feature - we can now find out something about what is
         * wrong - so we ask for the troublesome entry
         */
        SMPgetError(ckt->CKTmatrix,&i,&j);
        SPfrontEnd->IFerrorf (ERR_WARNING, "singular matrix:  check nodes %s and %s\n", NODENAME(ckt,i), NODENAME(ckt,j));
        ...
        return(error); /* can't handle these errors - pass up! */
    }
    ckt->CKTniState &= ~NISHOULDREORDER;
} else {
    startTime = SPfrontEnd->IFseconds();
    error=SMPluFac(ckt->CKTmatrix,ckt->CKTpivotAbsTol,
                   ckt->CKTdiagGmin);
    ...
    if(error) {
        if( error == E_SINGULAR ) {
            ckt->CKTniState |= NISHOULDREORDER;
            DEBUGMSG(" forced reordering....\n");
            continue;
        }
        ...
        return(error);
    }
}
```

### `spfactor.c` (singularity flagged inside the elimination loop)

`ref/ngspice/src/maths/sparse/spfactor.c:260-262` is where
`spOrderAndFactor` flags singularity — the inner pivot search returning
`NULL` is the only path that produces `MatrixIsSingular`:

```c
/* Perform reordering and factorization. */
for (; Step <= Size; Step++) {
    pPivot = SearchForPivot( Matrix, Step, DiagPivoting );
    if (pPivot == NULL) return MatrixIsSingular( Matrix, Step );
    ExchangeRowsAndCols( Matrix, pPivot, Step );
```

### Summary of the ngspice pattern

ngspice runs no pre-flight topology validation. Singularity from competing
voltage sources, voltage-source loops, inductor loops, or completely
floating nodes is detected by `SMPreorder`/`SMPluFac` returning
`E_SINGULAR`, after `CKTsetup` has already assigned every device's branch
rows. The diagnostic emerges from `SMPgetError` reporting the troublesome
row/column pair after the factorizer has stalled.

digiTS implements a **richer** pre-flight check — the three graph-walk
detectors emit clearer, source-attributed diagnostics ("vs1 and vs2 are
both driving net N") instead of ngspice's bare `singular matrix: check
nodes A and B`. That is a deliberate digiTS addition. The bug is not
about whether the check exists; it is that the check runs at a phase
where the data it inspects (`branchIndex`) has not yet been populated.
The fix is to move the check to the same lifecycle phase where ngspice's
factorizer would have run — i.e. after `CKTsetup`-equivalent work has
finished assigning branch rows.

## Implementation shape

### 1. Hoist `topologyInfo` capture out of compile-time element-pin coordinates

`topologyInfo` currently records `nodeIds[]` from
`pinNodeIds` (which are valid at compile time) plus `isBranch` and
`typeHint` (which are not). The fix:

- At compile time, build only what compile time has: a per-element record
  of `{ element, nodeIds, label }`. Stop reading `branchIndex`/inductor-ness
  at compile time.
- Stop calling `validateTopologyAndEmitDiagnostics` from
  `compileAnalogPartition` (`compiler.ts:1557`).
- Pass the new compile-time `Array<{ element, nodeIds, label }>` through to
  the engine via the existing compiled-circuit payload (`CompiledAnalogCircuit`
  / `ConcreteCompiledAnalogCircuit`).

### 2. Add a post-setup validation pass in `_setup`

In `MNAEngine._setup()` (`analog-engine.ts:1310-1327`), after the
`for (const el of this._elements) el.setup(setupCtx);` loop and before
`this._isSetup = true`:

- Re-derive `topologyInfo` entries from the now-populated elements:
  `isBranch = element.branchIndex !== -1`, and `typeHint` from
  `getLteTimestep` presence (the same logic compiler.ts uses today, just
  evaluated at the right phase).
- Call the same `detectVoltageSourceLoops`, `detectInductorLoops`,
  `detectCompetingVoltageConstraints` helpers — these are pure functions
  over the topology array and are already exported-internally, so they move
  with the validator.
- Route the resulting diagnostics through `this._diagnostics.emit(...)` —
  the existing `DiagnosticCollector` instance the engine already uses for
  `convergence-failed`. Tests that inspect diagnostics through the unified
  compile result must pull from a channel that includes these post-setup
  emissions.

### 3. Plumb post-setup diagnostics back to compile-result consumers

The failing test asserts on `result.analog!.diagnostics`, where `result` is
`compileUnified(circuit, registry)` output. After this fix the
`competing-voltage-constraints` diagnostic is produced by the engine, not
the compiler. Two possible plumbing paths:

- **(a)** Have `compileUnified` (or `compileAnalogPartition`) instantiate a
  short-lived `MNAEngine` after build, force `_setup()`, drain
  `_diagnostics`, append to the returned diagnostics array, and discard the
  engine. This keeps the compile-result contract identical to today —
  callers see all topology diagnostics on `result.analog.diagnostics`.
- **(b)** Add a new `setupDiagnostics` field on the compile result that
  callers must check separately, with engine `_setup` populating it.

Option (a) is the route consistent with this project's "no shortcut, do the
real architectural work" rule — the compile-result diagnostic surface is
the public contract, and the validation must remain visible there. The work
is: in the unified compile pipeline, after the analog partition is built and
its compiled circuit is in hand, instantiate the engine, call its
public-or-internal "trigger setup" hook, drain, and merge.

### 4. Delete the dead pre-flight call site

Remove `validateTopologyAndEmitDiagnostics` and its three detector helpers
from `compiler.ts`'s pre-setup phase. The detectors themselves move with
the validator into the engine module (or a shared `topology-diagnostics`
module both sides can import).

### 5. Unblock `transformer.test.ts:734`

The skip annotation explicitly says `branchIndex is assigned during
setup(), not construction. This white-box assertion on internal branch
assignment order will hold after K2 lands. Do not delete; keep as
documentation of the expected invariant.` Once `_setup()` is the
authoritative phase that assigns `branchIndex`, the test can be unskipped
and rewritten to call `setup()` (or trigger compile + first step) before
asserting the expected branch indices, instead of asserting on
construction.

## Tensions / uncertainties

- **Diagnostic collector event type.** `DiagnosticCollector` already
  carries arbitrary `Diagnostic` records — there is no separate event type
  for setup-phase vs. NR-phase emissions. No new event type is required.
  The existing `code: "competing-voltage-constraints" | "voltage-source-loop"
  | "inductor-loop" | ...` strings remain.
- **Compile-result vs. engine-result diagnostic surface.** Option (a) above
  requires the unified compile pipeline to perform a setup-only engine
  warm-up so the diagnostics surface on the compile result, not the run
  result. The cleanest shape is a public `MNAEngine.warmupForDiagnostics()`
  method (or simply `engine.compileSetup()`) that the compile pipeline
  calls in lieu of waiting until the first `step()`. Naming is a design
  choice for the implementer.
- **Post-`_setup` re-entry.** `_setup()` short-circuits on `this._isSetup`,
  and the existing reset path on `analog-engine.ts:153` clears the flag.
  Triggering `_setup()` from compile-result construction means the engine
  is "warm" before any step() call — which matches today's first-step path
  (`step()` itself calls `_setup()` at line 252). This is consistent.
- **Singular-matrix runtime path.** Even with the post-setup detectors
  emitting, ngspice-style runtime singularity detection in `SMPreorder`/
  `SMPluFac` still applies — a circuit that confuses the structural
  detectors (e.g. nonlinear-element-mediated short) can still produce
  E_SINGULAR at run time. The post-setup detectors are the early-exit; the
  LU factorizer remains the floor. No change required there; just noting
  it for completeness.
- **Subcircuit composition.** `topologyInfo` today is built per
  partition-component leaf; subcircuits expand into composite elements
  whose internal branch rows are also assigned during setup. Those
  internal rows need to participate in detector input if competing-voltage
  detection inside a subcircuit is to fire. Implementer should verify
  whether the existing detectors traverse composite sub-elements or only
  partition-level elements. If only partition-level, this fix narrows to
  partition-level diagnostics and a follow-up item is needed for
  intra-subcircuit topology validation. The current `competing-voltage-
  constraints.test.ts` cases are at partition level, so the narrow fix
  resolves the listed failing test as written.
