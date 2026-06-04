# Reconstruction spec — `asrc#recon/wholeClass`

Build the complete ngspice **ASRC arbitrary/behavioural source** (the SPICE
`B`-element: `V=expr` / `I=expr`) as a new digiTS analog device. This is a
whole-class greenfield build — `src/components/active/bsource.ts` does not exist
today (`asrc OQ-3`, `OPEN-QUESTIONS-WORKLOG.md:290-291`: "`bsource.ts` does not
exist (greenfield element)"). The reconstruction covers the parse-tree-driven
controlled source spanning all four controlled-source topologies (VCVS / VCCS /
CCVS / CCCS) selected by the controlling-variable *types* (node-voltage vs
branch-current), per-iteration parse-tree evaluation returning `rhs` + partial
derivatives, the linearized Jacobian/RHS companion stamp, branch-equation
allocation for the voltage form, temperature coefficients (`tc1`/`tc2`/
`reciproctc`), the small-signal (`ASRCacValues`) precompute + AC reload, and the
convergence test. The unit ALSO OWNS the v41-EXACT expression-engine `IFeval`
contract it depends on (Part 0): the combined multi-variable
`eval(gmin,vals)→{rhs,derivs[]}`, the `/`-operator gmin fudge, and the full
B-source function set built on `expression.ts`/`expression-evaluate.ts`/
`expression-differentiate.ts`. A B-source function or derivative living outside
`bsource.ts` is in scope — it is Part 0 work, not a missing-dependency blocker.

`asrc` is a **Missing** IN-class device that "declares `asrc#recon/wholeClass`"
(`device-class-scope.md:54` — "Behavioural source (`B`-element, `V=expr` /
`I=expr`) never ported."). Because it is an IN device class, the entire ASRC
device ngspice implements but digiTS omits is a baseline reconstruction item —
not an accepted divergence and not an open question. The IN-class completeness
rule forbids OMITTING ngspice behaviour (the full controlled-source matrix +
temperature coefficients + AC precompute must be built faithfully) but permits
ADDITIONAL digiTS behaviour (digiTS may keep its existing extended expression
functions layered over the ngspice core).

This spec implements the **RESOLVED** rulings of the open questions governing
this device:

- **#27 (`asrc OQ-1`, `OPEN-QUESTIONS-WORKLOG.md:90, 366-371`)** — component
  shape is **TWO components, `BV` and `BI`** (user choice, overturning the
  planner's one-`BSource` default). `BV` = branch-row element (V-mode, like a
  voltage source); `BI` = RHS-only element (I-mode, like a current source).
  ngspice's single `ASRCload` function is split across the two digiTS element
  classes — each implements one branch of `asrcload.c` (`:93-107` V-mode,
  `:108-119` I-mode). This mirrors the decomposition posture digiTS already
  takes for vsrc/isrc and vcvs/vccs vs ccvs/cccs.
- **#53 (`asrc OQ-2`, `OPEN-QUESTIONS-WORKLOG.md:116`)** — `m` / `reciprocm` +
  the temperature params are **hot-loadable on all three surfaces** (system
  requirement, `MEMORY.md` hot-loadable-params).
- **#15 (`asrc OQ-4`, `OPEN-QUESTIONS-WORKLOG.md:78, 226-239`)** — the
  `CKTsrcFact` source-ramp factor is **PRESENT** (`ctx.srcFact` is wired). The
  binding applier instruction: asrc ramps **only under `MODETRANOP`**
  (`asrcload.c:58` `if (ckt->CKTmode & MODETRANOP) factor *= ckt->CKTsrcFact;`),
  which is **narrower** than the V/I-source gate
  (`MODEDCOP|MODEDCTRANCURVE|MODETRANOP`, `dc-voltage-source.ts:218-222`). The
  asrc applier must NOT clone the V/I-source gate, or asrc wrongly ramps during
  DC operating-point and DC-transfer-curve sweeps.
- **#10 / #19 (`asrc OQ-3` + parser OQ2, `OPEN-QUESTIONS-WORKLOG.md:73, 81, 281-295`)**
  — the B-source expression engine is **OWNED BY THIS UNIT**. The asrc unit
  builds the v41-EXACT `IFeval` contract on `expression*.ts` itself (Part 0
  below), then builds the B-element wrapper (the two element classes), the
  multi-controlling-variable Jacobian assembly, the `ddt` history wiring, and
  the `MODETRANOP`-only `srcFact` gate (from #15) on top of it. The widened
  `tsFiles` set (`expression.ts` / `expression-evaluate.ts` /
  `expression-differentiate.ts`) is in scope: a B-source function or derivative
  that lives outside `bsource.ts` is **not** a missing-dependency escalation —
  it is the asrc unit's own Part 0 work.

  **The current engine does NOT expose an `IFeval` shape.** Verified against
  `expression-evaluate.ts:61,135` (a scalar `(ctx) → number` evaluator and
  `compileExpression`), `expression.ts:23-32` (the `ExprNode` union has no
  ternary, no `numVars`, no multi-variable derivative vector), and
  `expression-differentiate.ts:70` (`differentiate(expr, variable)` produces one
  symbolic derivative per call). There is **no** combined `eval(gmin, vals) →
  {rhs, derivs[]}`, no `numVars`/`varTypes` collection, no `PTfudge_factor` on
  `/`, and ~18 B-source functions plus the `?:` ternary, `ddt`, `pwl`/
  `pwl_derivative`, and `temper` are absent (the current `BUILTIN_FUNCTIONS`
  table, `expression.ts:155-177`, carries only `sin`…`pow` and lacks
  `sgn`/`u`/`u2`/`uramp`/`eq0`…`le0`/`nint`/`asinh`/`acosh`/`atanh`/`pwr`/`ln`).
  Part 0 specifies that build to match `ifeval.c` / `ptfuncs.c` /
  `inpptree.c` exactly. The prior ledger item `expr-engine#recon/numericalDeltas`
  (`parser-decisions.json`) is **STALE** — it covered only the
  `PTexp`/`PTlog`/`PTlog10` clamps, the `tan`/`tanh` derivative corrections, the
  atto suffix, and the `sinh`/`cosh`/`tanh` function set. Part 0 **subsumes and
  supersedes** it: the asrc build re-verifies and re-establishes that ground as
  part of constructing the full `IFeval` contract.

Authoring contract: this spec is **documentation**. No code. No tests. The
implementer authors the TypeScript edit against this spec; the verifier checks
the edit against the ngspice citations herein.

Per `CLAUDE.md` comment-hygiene: every reconstructed source comment cites the
current `ref/ngspice/src/spicelib/devices/asrc/<file>` line and explains the
mechanism in present tense, with no `v26`/`v41`/era tags and no migration
narrative.

## Current digiTS state

digiTS carries **no** ASRC / B-element device. The four single-controlling-
variable controlled sources exist (`VCVSAnalogElement` `vcvs.ts:138`,
`VCCSAnalogElement` `vccs.ts:124`, plus `cccs.ts` / `ccvs.ts`), all built on
`ControlledSourceElement` (`controlled-source-base.ts:94`), but each is a
single-control-quantity transfer function:

| Existing element | control quantity | output form | ngspice ASRC topology equivalent |
|---|---|---|---|
| `VCVSAnalogElement` (`vcvs.ts:138`) | one `V(ctrl)` | branch-row voltage | ASRC V-mode with one `IF_NODE`-pair controller |
| `VCCSAnalogElement` (`vccs.ts:124`) | one `V(ctrl)` | Norton current | ASRC I-mode with one `IF_NODE`-pair controller |
| `CCVSAnalogElement` (`ccvs.ts`) | one `I(sense)` | branch-row voltage | ASRC V-mode with one `IF_INSTANCE` controller |
| `CCCSAnalogElement` (`cccs.ts`) | one `I(sense)` | Norton current | ASRC I-mode with one `IF_INSTANCE` controller |

ngspice's ASRC is the *general* form of all four at once: its parse tree
declares **N controlling variables** (`ASRCtree->numVars`,
`asrcdefs.h:34-35`), each independently a node voltage (`IF_NODE`) or a branch
current (`IF_INSTANCE`), and the `load()` assembles the Jacobian column-by-
column over all N (`asrcload.c:100-104` V-mode, `:110-115` I-mode). The existing
four digiTS elements are the four `numVars==1` special cases; ASRC must support
arbitrary N and mixed controller types in one expression.

The `ControlledSourceElement` base (`controlled-source-base.ts:94-208`) carries
a single scalar `_ctrlValue` and a single `_compiledExpr` / `_compiledDeriv`
pair — it cannot host N controlling variables or the per-variable derivative
vector ASRC needs. The reconstruction therefore builds `bsource.ts` as a
**standalone `AnalogElement` subclass** (the pattern of vcvs/vccs is the model
for the stamp shape, NOT the base class — ASRC subclasses `AnalogElement`
directly and owns its own multi-variable evaluation loop).

The shared expression engine (`expression-evaluate.ts`,
`expression-differentiate.ts`) and the parser (`expression.ts:438
parseExpression`) exist but do NOT yet expose the `IFeval` contract (no
`numVars`, no combined `eval(gmin,vals)→{rhs,derivs[]}`, no `/`-fudge, ~18
functions + `?:`/`ddt`/`pwl`/`temper` missing). **Building that contract is
Part 0 of this unit** — `expression.ts` / `expression-evaluate.ts` /
`expression-differentiate.ts` are in the widened `tsFiles`. The current AST
already models node voltages (`circuit-voltage`, `expression.ts:29`), branch
currents (`circuit-current`, `expression.ts:30`), and `time` (`builtin-var`,
`expression.ts:31`); Part 0 extends it. The multi-variable derivative extraction
(Part C) is the asrc-specific wrapper over the Part 0 `IFeval` build.

## Part 0 — Expression-engine IFeval contract (owned by this unit)

This part is the v41-EXACT build of the B-source expression engine on
`src/solver/analog/expression.ts` (AST), `expression-evaluate.ts` (the combined
eval), and `expression-differentiate.ts` (the per-variable derivative builder).
It is **part of the asrc unit's scope**, not a separate dependency. The contract
target is ngspice's `IFeval` (`ifeval.c:27-78`), which the ASRC `load()`/
`convTest()` call once per NR iteration. Every formula below is cited to
`ifeval.c` / `ptfuncs.c` / `inpptree.c`, verified by hand against the tree.

### Part 0.A — The combined `eval(gmin, vals) → { rhs, derivs[] }`

ngspice `IFeval` (`ifeval.c:27-78`) takes the parse tree, the gmin floor, a
`vals[]` array (one entry per controlling variable, ordered `0..numVars-1`), and
writes a scalar `result` plus a `derivs[]` array (`∂f/∂var_i`):

```
PTfudge_factor = gmin * 1.0e-20;                          // ifeval.c:86 (set in PTeval)
PTeval(myTree->tree, gmin, result, vals);                 // ifeval.c:46  → rhs
for (i = 0; i < numVars; i++)                             // ifeval.c:58-59
    PTeval(myTree->derivs[i], gmin, &derivs[i], vals);    //   one PTeval per pre-built derivative tree
```

The engine builds the matching surface. A `CompiledBSourceTree` object exposes:

| ngspice `IFparseTree` field / op | `ifeval.c` / `inpptree.c` | digiTS counterpart (Part 0.A) |
|---|---|---|
| `int numVars` | `inpptree.c:226` (`numVars = numvalues`) | `tree.numVars` |
| `int varTypes[i]` (`IF_NODE`/`IF_INSTANCE`) | `inpptree.c:227,1207,1236` | `tree.vars[i].kind` (`"node"`/`"branch"`) |
| `IFvalue vars[i]` (node descriptor / instance name) | `inpptree.c:228,1206,1235` | `tree.vars[i].label` |
| `IFeval(tree, gmin, &rhs, vals, derivs)` | `ifeval.c:46-69` | `tree.eval(gmin, vals) → { rhs, derivs }` |
| `INPparseNode *derivs[i]` (pre-built per-var derivative tree) | `inpptree.c:232-235` | `tree._derivCompiled[i]` (one compiled closure per var) |

**Variable collection (first-encounter order, matching `inpptree.c`).** ngspice
assigns each distinct controlling quantity a `valueIndex` the first time the
lexer encounters it (`mkvnode`/`mkinode`, `inpptree.c:1195-1210,1224-1239`: the
linear scan `for (i=0; i<numvalues; i++) … if (i==numvalues) numvalues++`
appends a new var only on first encounter). The engine replicates this exactly:
walk the parsed AST in source order, and on each distinct `circuit-voltage`
(`expression.ts:29`) / `circuit-current` (`expression.ts:30`) node append a
`{ kind, label, valueIndex }` to `vars[]` if not already present, comparing by
`(kind, label)`. `IF_NODE` ↔ `circuit-voltage`, `IF_INSTANCE` ↔
`circuit-current`. `numVars = vars.length`. The bound value of each var during
`eval` is `vals[valueIndex]` (matching `PT_VAR: *res = vals[tree->valueIndex]`,
`ifeval.c:92-93`).

**Build step** (`buildBSourceTree(exprText)`):

1. `parseExpression(exprText)` (`expression.ts:438`) → AST.
2. Walk the AST in source order collecting `vars[]` (first-encounter dedup as
   above). Assign each collected var its `valueIndex`.
3. For each `i` in `0..numVars-1`: build the symbolic derivative tree
   `differentiate(ast, varKey_i)` where `varKey_i` is `V(label)` / `I(label)`
   (`expression-differentiate.ts:82,85`), then `simplify` it, then compile it
   (`compileExpression`, `expression-evaluate.ts:135`) into a closure. This is
   the digiTS counterpart of `inpptree.c:234-235` (`derivs[i] =
   PTdifferentiate(p, i)`): the derivative trees are built ONCE at parse time,
   not per iteration.
4. Compile the value AST (`compileExpression`) into the `rhs` closure.

**`eval(gmin, vals)`** binds the controlling values into a
`MutableExpressionContext` (`controlled-source-base.ts:41`) keyed by each var's
`(kind, label)` → `vals[valueIndex]`, sets the division fudge floor
`PTfudge_factor = gmin * 1e-20` (Part 0.B), evaluates the value closure for
`rhs`, then evaluates each derivative closure `i` for `derivs[i]`. The eval
order — value first, then derivatives `0..numVars-1` — matches `ifeval.c:46`
then `:58-59`. The result object is `{ rhs: number, derivs: number[] }` of
length `numVars`.

`PTfudge_factor` is module-level mutable state in ngspice (`ptfuncs.c:20`,
written at the top of every `PTeval`, `ifeval.c:86`). digiTS threads `gmin`
into the `MutableExpressionContext` and the `/`-operator reads the
context-scoped fudge floor (Part 0.B) — no module-global, so concurrent B-source
evals do not clobber a shared static. The numeric result is identical:
`fudge = gmin * 1e-20`.

### Part 0.B — The `/`-operator gmin fudge (`PTdivide`, `ptfuncs.c:54-66`)

ngspice's `PTdivide` perturbs the denominator away from zero by
`PTfudge_factor` before dividing, returning `HUGE` (IEEE +∞) only on an exact
zero after the perturbation:

```c
double PTdivide(double arg1, double arg2) {        // ptfuncs.c:54
    if (arg2 >= 0.0)  arg2 += PTfudge_factor;      // ptfuncs.c:57-58
    else              arg2 -= PTfudge_factor;      // ptfuncs.c:59-60
    if (arg2 == 0.0)  return (HUGE);               // ptfuncs.c:62-63
    return (arg1 / arg2);                          // ptfuncs.c:65
}
```

The current engine's `/` is the bare IEEE divide (`expression-evaluate.ts:88,
168`, `evaluate`/`compileExpression`; `expression.ts:484` `evaluateExpression`).
Part 0 replaces the `/` arm in all three evaluators with the `PTdivide`
semantics above, reading `ctx.bsourceFudge` (the `PTfudge_factor` counterpart,
set by `eval` from `gmin*1e-20`, defaulting to `0` outside a B-source eval so a
non-B `/` is unchanged): `den' = den>=0 ? den+fudge : den-fudge; return
den'===0 ? +Infinity : num/den'`. `HUGE` is IEEE `+∞` (matching the
`Number.POSITIVE_INFINITY` already used for the `PTlog` clamp,
`expression.ts:127`).

### Part 0.C — The full v41 B-source function set (`ptfuncs.c`, dispatched in `inpptree.c:135-175`)

The function table `funcs[]` (`inpptree.c:135-175`) is the authoritative v41 set.
The engine's `BUILTIN_FUNCTIONS` (`expression.ts:155-177`) currently carries
`sin`/`cos`/`tan`/`sinh`/`cosh`/`tanh`/`asin`/`acos`/`atan`/`atan2`/`exp`/`log`/
`log10`/`sqrt`/`abs`/`min`/`max`/`floor`/`ceil`/`round`/`pow`. Part 0 ADDS the
following to match `funcs[]` exactly. Each row gives the value semantics
(`ptfuncs.c`) and the derivative rule (`inpptree.c PTdifferentiate`):

| ngspice name (`PTF_*`) | value (`ptfuncs.c`) | derivative (`inpptree.c`) | digiTS function key |
|---|---|---|---|
| `sgn` (`PTF_SGN`) | `arg>0?1:arg<0?-1:0` (`ptfuncs.c:30-34`) | `0` (`inpptree.c:401-403`) | `sgn` |
| `u` (`PTF_USTEP`) | `arg<0?0:arg>0?1:0.5` (`ptfuncs.c:188-197`) | `0` (`inpptree.c:522-530`) | `u` |
| `u2` (`PTF_USTEP2`) | `arg<=0?0:arg<=1?arg:1` (`ptfuncs.c:201-210`) | `u(arg)-u(arg-1)` (`inpptree.c:548-555`) | `u2` |
| `uramp` (`PTF_URAMP`) | `arg<0?0:arg` (`ptfuncs.c:248-255`) | `u(arg)` (`inpptree.c:532-534`) | `uramp` |
| `eq0` (`PTF_EQ0`) | `arg==0?1:0` (`ptfuncs.c:212-216`) | `0` (`inpptree.c:522-530`) | `eq0` |
| `ne0` (`PTF_NE0`) | `arg!=0?1:0` (`ptfuncs.c:218-222`) | `0` (`inpptree.c:522-530`) | `ne0` |
| `gt0` (`PTF_GT0`) | `arg>0?1:0` (`ptfuncs.c:224-228`) | `0` (`inpptree.c:522-530`) | `gt0` |
| `lt0` (`PTF_LT0`) | `arg<0?1:0` (`ptfuncs.c:230-234`) | `0` (`inpptree.c:522-530`) | `lt0` |
| `ge0` (`PTF_GE0`) | `arg>=0?1:0` (`ptfuncs.c:236-240`) | `0` (`inpptree.c:522-530`) | `ge0` |
| `le0` (`PTF_LE0`) | `arg<=0?1:0` (`ptfuncs.c:242-246`) | `0` (`inpptree.c:522-530`) | `le0` |
| `nint` (`PTF_NINT`) | `nearbyint(arg)` (banker's round, `ptfuncs.c:406-414`) | `0` (`inpptree.c:544-546`) | `nint` |
| `asinh` (`PTF_ASINH`) | `asinh(arg)` (`ptfuncs.c:170-174`) | `1/sqrt(u²+1)` (`inpptree.c:433-440`) | `asinh` (`Math.asinh`) |
| `acosh` (`PTF_ACOSH`) | `acosh(arg)` (`ptfuncs.c:158-162`) | `1/sqrt(u²-1)` (`inpptree.c:414-422`) | `acosh` (`Math.acosh`) |
| `atanh` (`PTF_ATANH`) | `atanh(arg)` (`ptfuncs.c:182-186`) | `1/(1-u²)` (`inpptree.c:450-456`) | `atanh` (`Math.atanh`) |
| `pwr` (`PTF_PWR`) | `arg1<0 ? -pow(-arg1,arg2) : pow(arg1,arg2)` (default compat, `ptfuncs.c:127-138`) | per `inpptree.c:683-738` (see below) | `pwr` (2-arg) |
| `ln`=`log` (`PTF_LOG`) | alias for `log` = `PTlog` clamp (`inpptree.c:146`, `ptfuncs.c:286-294`) | `1/u` (`inpptree.c:485-487`) | `ln` → same impl as `log` |

`pow` (`PTF_POW`, `inpptree.c:170`) maps to `PTpower` (`ptfuncs.c:68-89`); in
default compat (`!newcompat.lt`) `PTpower(a,b) = pow(fabs(a), b)`
(`ptfuncs.c:87`). The current `pow` arm uses `Math.pow(a,b)` directly
(`expression-evaluate.ts:88,169`); Part 0 corrects the **B-source** `pow`/`pwr`/
`^` value semantics to the `fabs`/sign forms below. The `^` operator
(`PT_POWER`) dispatches to `PTpowerH` (`inpptree.c:126`); in default compat
(`!newcompat.hs && !newcompat.lt`) `PTpowerH(a,b) = pow(fabs(a), b)`
(`ptfuncs.c:121-122`) — i.e. `^` and `pow` share the `pow(fabs(a),b)` value in
default compat.

The compat-mode branches (`newcompat.ps`/`.hs`/`.lt`, `ptfuncs.c:72-138,275-276`)
are RULED OUT at default compat (`parser-decisions.json`
`parser/ptfuncs.c#h00x` rationale: "compatmode ruled OUT (no numerical effect at
default compat)"). Part 0 builds the default-compat arm only.

`exp`/`log`/`log10`/`sqrt` already carry the v41 clamps in `BUILTIN_FUNCTIONS`
(`expression.ts:113-143`, `ptExp`/`ptLog`/`ptLog10`); the `sqrt` HUGE-on-negative
clamp (`PTsqrt`, `ptfuncs.c:318-324`) and `pow`/`^` `HUGE`-on-overflow check
(`ifeval.c:110-114,165-169`) are re-verified here as part of re-establishing the
STALE `numericalDeltas` ground.

**`pwr`/`pow` derivative shapes** (the two `PT_COMMA`-arg power forms,
`inpptree.c:610-738`). These are 2-argument (`f(a,b)`) functions, so the engine
models them as `pow`/`pwr` 2-arg `call` nodes (the existing `pow` 2-arg path in
`expression-differentiate.ts:233-247` is the template). For `pwr(a,b)` with `b`
constant: `D(pwr(a,b)) = b * pow(a, b-1) * D(a)` (`inpptree.c:711-719`); general:
`D(pwr(a,b)) = pwr(a,b) * (D(b)*ln(|a|) + b*D(a)/a)` (`inpptree.c:721-728`). For
`pow(a,b)` with `b` constant: `D = b * pwr(a, b-1) * D(a)` (`inpptree.c:644-651`);
`a` constant: `D = pow(a,b) * D(b)*ln(|a|)` (`inpptree.c:652-657`); general:
`D = pow(a,b) * (b*D(a)/a + D(b)*ln(|a|))` (`inpptree.c:658-669`). Note ngspice's
`pow` derivative uses `pwr` in the `b`-constant case (`inpptree.c:649`) — the
engine matches that node choice exactly (structural match, not merely numeric).

The `min`/`max` derivative is the ternary form `D(min(a,b)) = (a-b<0) ? D(a) :
D(b)` and `D(max(a,b)) = (a-b>0) ? D(a) : D(b)` (`inpptree.c:575-606`); the
current engine returns `0` for `min`/`max` derivatives
(`expression-differentiate.ts:249-250`) — Part 0 replaces that with the ternary
form using the new `?:` node (Part 0.D). The `abs` derivative is `sgn(u)`
(`inpptree.c:397-399`); the current engine uses `g/abs(g)`
(`expression-differentiate.ts:205`) — Part 0 changes it to `sgn(g)` for a
structural match to `PTF_SGN`.

### Part 0.D — The ternary `?:` (`PT_TERN`, `ifeval.c:134-151`, `inpptree.c:371-390`)

ngspice's parse tree has a dedicated ternary node `PT_TERN` with three children
(`cond`, `then`, `else`); eval picks the branch by `cond != 0.0`:

```c
case PT_TERN: {                                   // ifeval.c:134
    PTeval(arg1, gmin, &r1, vals);                // cond
    PTeval((r1 != 0.0) ? arg2 : arg3, ...);       // ifeval.c:145  (FIXME: != 0.0)
    *res = r2;
}
```

The ternary is parsed from the `a ? b : c` / `ternary_fcn(cond,then,else)`
surface (`inpptree.c:1125-1146` + the `?`/`:` lexer tokens `inpptree.c:1366-1367`).
Part 0 ADDS a ternary AST node `{ kind: "ternary"; cond; then; else }` to the
`ExprNode` union (`expression.ts:23-32`), a parser path for `?`/`:` (lower
precedence than additive) and `ternary_fcn(...)`, an eval arm
(`evaluate`/`compileExpression`/`evaluateExpression`) using the `cond !== 0`
selector (`ifeval.c:145`), and the derivative rule `D(cond ? a : b) = cond ?
D(a) : D(b)` (`inpptree.c:381-383`). The `min`/`max` derivatives (Part 0.C) and
the PSPICE-`exp` derivative (`inpptree.c:466-476`, ruled out at default compat)
consume this node.

### Part 0.E — `temper` (`PT_TEMPERATURE`, `ifeval.c:176-178`, `inpptree.c:1285-1289`)

`temper` evaluates to the circuit temperature in Celsius:

```c
case PT_TEMPERATURE:                               // ifeval.c:176
    *res = ((CKTcircuit*) tree->data)->CKTtemp - CONSTCtoK;   // ifeval.c:177  (Kelvin → Celsius)
```

Its derivative w.r.t. any controlling variable is `0` (`inpptree.c:261-266`,
`PT_TEMPERATURE` → `mkcon(0.0)`). Part 0 extends the `builtin-var` node
(`expression.ts:31`, currently `"time" | "freq"`) to include `"temper"`, wires
the evaluator to read `ctx.temp - CONSTCtoK` (the `MutableExpressionContext`
carries `temp` in Kelvin; `CONSTCtoK = 273.15`), and the differentiator returns
`0` for it (the `builtin-var` arm, `expression-differentiate.ts:78-79`). `time`
(`PT_TIME`, `ifeval.c:172-174`) and `freq`/`hertz` (`PT_FREQUENCY`,
`ifeval.c:180-182` = `CKTomega/2π`) are already modelled; their derivatives are
`0` (`inpptree.c:261-266`), already correct.

### Part 0.F — `ddt` and `pwl`/`pwl_derivative` (state-/data-bearing)

`ddt` (`PTF_DDT`, `ptfuncs.c:422-466`) is a transient time-derivative carrying a
7-slot history buffer (`prepare_PTF_DDT`, `inpptree.c:1089-1102`): on each
accepted timestep it shifts `(t,v)` pairs and returns the backward-difference
slope. Its derivative w.r.t. a controlling variable is `0`
(`inpptree.c:570-573`). Part 0 ADDS a `ddt` AST node carrying a per-node history
buffer (sized 7, `inpptree.c:1096`), an eval arm reading `ctx.time`
(`expression-evaluate.ts:109`) + the `MODETRAN` flag and mutating the buffer
exactly per `ptfuncs.c:430-465` (return `0` at `time==0` or outside transient,
else the `(v1-v3)/(t2-t4)` slope of `ptfuncs.c:454`), and a `0` derivative.

`pwl(arg, x1,y1,x2,y2,…)` (`PTF_PWL`, `ptfuncs.c:345-367`) is a piecewise-linear
lookup whose constant breakpoints are stripped at parse time into an opaque
data array (`prepare_PTF_PWL`, `inpptree.c:1022-1087`): a binary search locates
the bracketing segment and linearly interpolates. Its derivative is
`pwl_derivative(arg, …)` carrying the SAME data (`inpptree.c:561-564`):
`PTpwl_derivative` (`ptfuncs.c:370-392`) returns the bracketing segment slope.
`pwl_derivative`'s own derivative is `0` (`inpptree.c:566-568`). Part 0 ADDS a
`pwl` AST node carrying the parsed constant breakpoint array (ascending-abscissa
check, `inpptree.c:1072-1076`), the binary-search interpolation
(`ptfuncs.c:351-366`), and the `pwl_derivative` segment-slope sibling
(`ptfuncs.c:379-391`) used as the `pwl` derivative.

> Scope caveat (existing `parser-decisions.json` ruling, RATIFIED 2026-06-03):
> the STALE `expr-engine#recon/numericalDeltas` overlay ruled `PTddt`
> NO-COUNTERPART because the *bare* AST evaluator lacked `CKTtime`/`MODETRAN`
> history. The asrc unit OWNS that infrastructure (the
> `MutableExpressionContext` carries `ctx.time` + the `MODETRAN` flag and the
> `ddt`/`pwl` nodes own their own buffers), so within the asrc build `ddt`/`pwl`
> are buildable as specified here. If the implementer finds the
> `MutableExpressionContext` cannot yet carry the `MODETRAN` flag or a per-node
> mutable buffer, that is in-scope Part 0 work on `expression*.ts` — not a
> blocker. (The `ddt`/`pwl` value paths are exercised only by transient B-source
> fixtures; the acceptance #12 gate covers the algebraic/`tc`/multi-controller
> cases.)

### Part 0 acceptance

`expression.ts` exports a `buildBSourceTree(exprText) → CompiledBSourceTree`
with `{ numVars, vars: {kind, label, valueIndex}[], eval(gmin, vals) → {rhs,
derivs[]} }`. The `eval` matches `IFeval` (`ifeval.c:46-69`): value first,
derivatives `0..numVars-1`, `vars[]` in first-encounter order. The `/` operator
applies the `gmin*1e-20` fudge (`ptfuncs.c:54-66`). `BUILTIN_FUNCTIONS` carries
the full `funcs[]` set (`inpptree.c:135-175`) with the value semantics and
derivative rules of Part 0.C–F, each cited to `ptfuncs.c`/`inpptree.c`. The
`?:` ternary, `temper`, `ddt`, and `pwl`/`pwl_derivative` nodes exist with the
specified value + derivative behaviour. This subsumes
`expr-engine#recon/numericalDeltas`.

## Part A — Device parameters, instance state, and the BV/BI split

### Device parameter enum (`asrcdefs.h:78-93`)

ngspice's ASRC device-parameter enum and its `IFparm` table
(`asrc.c:14-28`):

| ngspice enum | `asrcdefs.h` line | `asrc.c` IFparm | meaning |
|---|---|---|---|
| `ASRC_VOLTAGE = 1` | `:79` | `IP("v", …, IF_PARSETREE)` `asrc.c:16` | V-mode + parse tree |
| `ASRC_CURRENT` | `:80` | `IP("i", …, IF_PARSETREE)` `asrc.c:15` | I-mode + parse tree |
| `ASRC_POS_NODE` | `:81` | `OP("pos_node", …)` `asrc.c:26` | (output query) |
| `ASRC_NEG_NODE` | `:82` | `OP("neg_node", …)` `asrc.c:27` | (output query) |
| `ASRC_PARSE_TREE` | `:83` | — | internal |
| `ASRC_OUTPUTVOLTAGE` | `:84` | `OP("v", …)` `asrc.c:25` | (output query) |
| `ASRC_OUTPUTCURRENT` | `:85` | `OP("i", …)` `asrc.c:24` | (output query) |
| `ASRC_TEMP` | `:86` | `IOPZU("temp", …)` `asrc.c:17` | instance temperature |
| `ASRC_DTEMP` | `:87` | `IOPZ("dtemp", …)` `asrc.c:18` | delta-temperature |
| `ASRC_TC1` | `:88` | `IOPU("tc1", …)` `asrc.c:19` | first temp coefficient |
| `ASRC_TC2` | `:89` | `IOPU("tc2", …)` `asrc.c:20` | second temp coefficient |
| `ASRC_RTC` | `:90` | `IOPU("reciproctc", …)` `asrc.c:21` | reciprocal-tc flag |
| `ASRC_M` | `:91` | `IOPU("m", …)` `asrc.c:22` | output multiplier |
| `ASRC_RM` | `:92` | `IOPU("reciprocm", …)` `asrc.c:23` | reciprocal-m flag |

The `v` / `i` parse-tree parameters are mutually exclusive and select the
device topology (`ASRCparam` `asrc.c`→`asrcpar.c:21-28`). In digiTS the topology
is the COMPONENT, not a runtime parameter: **`BV`** owns `v=expr` (V-mode),
**`BI`** owns `i=expr` (I-mode). This is #27's two-component split.

### digiTS model parameters (added to `BV_PARAM_DEFS` / `BI_PARAM_DEFS`)

Both components share the identical temperature + multiplier param block (it is
topology-independent in ngspice — `asrcset.c:46-55` applies to both modes). The
`defineModelParams` declaration (the `vcvs.ts:61-65` / `vccs.ts:61-67` pattern):

| ngspice instance field | digiTS param | default | given-flag source | ngspice source |
|---|---|---|---|---|
| `ASRCtc1` | `TC1` | `0.0` | `ASRCtc1Given` (`asrcpar.c:31`) | `asrcdefs.h:39`; default `asrcset.c:46-47` |
| `ASRCtc2` | `TC2` | `0.0` | `ASRCtc2Given` (`asrcpar.c:35`) | `asrcdefs.h:40`; default `asrcset.c:48-49` |
| `ASRCreciproctc` | `RECIPROCTC` | `0` | `ASRCreciproctcGiven` (`asrcpar.c:43`) | `asrcdefs.h:42`; default `asrcset.c:50-51` |
| `ASRCm` | `M` | `1.0` | `ASRCmGiven` (`asrcpar.c:39`) | `asrcdefs.h:41`; default `asrcset.c:54-55` |
| `ASRCreciprocm` | `RECIPROCM` | `0` | `ASRCreciprocmGiven` (`asrcpar.c:47`) | `asrcdefs.h:43`; default `asrcset.c:52-53` |
| `ASRCtemp` | `TEMP` | (= `CKTtemp`) | `ASRCtempGiven` (`asrcpar.c:51`) | `asrcdefs.h:37`; default `asrctemp.c:23-24` |
| `ASRCdtemp` | `DTEMP` | `0.0` | `ASRCdtempGiven` (`asrcpar.c:55`) | `asrcdefs.h:38`; default `asrctemp.c:26` |

`temp` is netlisted in Celsius and stored Kelvin: `ASRCtemp = value->rValue +
CONSTCtoK` (`asrcpar.c:50`). The digiTS `TEMP` param follows the same
Celsius-in / Kelvin-internal convention used elsewhere (the temperature-default
resolution is Part E).

### Instance state on the element class

ngspice's `sASRCinstance` (`asrcdefs.h:20-57`) carries, beyond the params
above:

| ngspice instance field | `asrcdefs.h` line | digiTS field | meaning |
|---|---|---|---|
| `int ASRCtype` | `:32` | (component identity — `BV`=`ASRC_VOLTAGE`, `BI`=`ASRC_CURRENT`) | topology selector |
| `int ASRCbranch` | `:33` | `this.branchIndex` (BV only) | branch-equation row number |
| `IFparseTree *ASRCtree` | `:34` | `this._tree: ParsedBSourceTree` | the parse tree (Part C) |
| `int *ASRCvars` | `:35` | `this._vars: number[]` | resolved node/branch row indices of the N controllers |
| `double **ASRCposPtr` | `:44` | the `this._h*` matrix handles (Part D) | sparse-matrix element handles |
| `double ASRCprev_value` | `:46` | `this._prevValue: number` | last `rhs` for the convergence test (Part F) |
| `double *ASRCacValues` | `:47` | `this._acValues: Float64Array` | stored derivs + rhs for AC reload (Part G), length `numVars+1` |

`ASRCvOld`/`ASRCcontVOld` (`asrcdefs.h:60-61`) are `GENstate`-relative slots
(`ASRCstates`) that ngspice's ASRC declares but `asrcload.c`/`asrcconv.c` never
read — the convergence test reads `ASRCprev_value`, not the state slots. They
carry no numerical content in the v26 baseline; digiTS allocates no state-pool
slot for them (NO-COUNTERPART, consistent with the "all state in StatePool"
rule applying only to state that is *read*). If the engine's StatePool API
requires a non-zero state count, the implementer allocates the two slots inert;
they are never read.

`asrc_vals` / `asrc_derivs` / `asrc_nvals` (`asrcload.c:13-15`) are
module-static scratch buffers reused across instances, grown by `TREALLOC`
(`asrcload.c:66-70`). In digiTS each element owns its own scratch buffers
sized at `setup()` from `numVars` (the `TREALLOC` grow-on-demand is a v41
blocked hunk, `asrcdefs.h#h001`/`asrcload.c#h…` per the §Blocked-hunks list);
the baseline allocates `_vals: Float64Array(numVars)` and
`_derivs: Float64Array(numVars)` once.

## Part B — Setup: branch allocation, controlling-variable resolution, TSTALLOC

ngspice's `ASRCsetup` (`asrcset.c:24-124`) runs per instance:

1. **Parse-tree presence guard** (`asrcset.c:37-38`): `if (!here->ASRCtree)
   return E_PARMVAL;`.
2. **Shorted-V guard** (`asrcset.c:40-44`): a V-mode source whose
   `ASRCposNode == ASRCnegNode` is fatal (`"instance %s is a shorted ASRC"`).
3. **Temperature-coefficient + multiplier defaults** (`asrcset.c:46-55`): the
   `*Given`-guarded defaults already tabulated in Part A.
4. **Handle-array sizing** (`asrcset.c:57-66`): V-mode needs
   `j = 4 + numVars` handles; I-mode needs `j = 2 * numVars`.
5. **Allocate** `ASRCposPtr[j]`, `ASRCvars[numVars]`,
   `ASRCacValues[numVars+1]` (`asrcset.c:68-70`).
6. **Branch allocation (V-mode only)** (`asrcset.c:77-84`): if `ASRCbranch ==
   0`, `CKTmkCur(ckt, &tmp, ASRCname, "branch")`, store `tmp->number`.
7. **Branch-incidence TSTALLOC (V-mode)** (`asrcset.c:86-89`), in this exact
   order:
   ```
   TSTALLOC(ASRCposPtr[j++], ASRCposNode, ASRCbranch);   // :86
   TSTALLOC(ASRCposPtr[j++], ASRCnegNode, ASRCbranch);   // :87
   TSTALLOC(ASRCposPtr[j++], ASRCbranch,  ASRCnegNode);  // :88
   TSTALLOC(ASRCposPtr[j++], ASRCbranch,  ASRCposNode);  // :89
   ```
8. **Per-controlling-variable resolution + TSTALLOC** (`asrcset.c:92-119`): for
   each of `numVars` controllers, resolve its 1-based row index by type
   (`asrcset.c:95-109`):
   - `IF_INSTANCE` → `CKTfndBranch(ckt, vars[i].uValue)` (the controlling
     source's branch row; `0` ⇒ unknown-source fatal, `asrcset.c:97-102`);
   - `IF_NODE` → `vars[i].nValue->number` (the node id, `asrcset.c:104-105`);

   store into `ASRCvars[i]` (`asrcset.c:111`), then TSTALLOC the Jacobian
   column:
   - **V-mode** (`asrcset.c:114`): `TSTALLOC(ASRCposPtr[j++], ASRCbranch,
     column)`;
   - **I-mode** (`asrcset.c:116-117`): `TSTALLOC(ASRCposPtr[j++], ASRCposNode,
     column); TSTALLOC(ASRCposPtr[j++], ASRCnegNode, column);`.

### digiTS setup (`BVAnalogElement.setup` / `BIAnalogElement.setup`)

`SetupContext` exposes `ctx.makeCur(label, suffix)` (the `CKTmkCur` counterpart,
`vcvs.ts:176`) and `ctx.solver.allocElement(row, col)` (the `TSTALLOC`
counterpart, `vcvs.ts:181-186`). The `_vars[i]` resolution reads the controller
type from the parse tree (Part C) and resolves to the engine's 1-based row
index. The TSTALLOC walk reproduces `asrcset.c:86-119` in the exact handle
order — the order is structurally visible at the harness CSC dump
(`CLAUDE.md` setup-TSTALLOC parity note), so it must match line-for-line.

**BV (V-mode) setup** — port of `asrcset.c:77-119` V-branches:

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = this.pinNodes.get("out+")!;  // ASRCposNode
  const negNode = this.pinNodes.get("out-")!;  // ASRCnegNode

  // asrcset.c:40-44 — a V-mode ASRC across a single node is a shorted source.
  if (posNode === negNode) {
    throw new Error(`instance ${this.label ?? "bv"} is a shorted ASRC`);
  }

  // asrcset.c:79-84 — branch row allocation (idempotent guard mirrors makeCur).
  if (this.branchIndex === -1) {
    this.branchIndex = ctx.makeCur(this.label ?? "bv", "branch");
  }
  const branch = this.branchIndex;

  // asrcset.c:86-89 — branch incidence, exact handle order.
  this._hPosBr = solver.allocElement(posNode, branch);  // :86
  this._hNegBr = solver.allocElement(negNode, branch);  // :87
  this._hBrNeg = solver.allocElement(branch, negNode);  // :88
  this._hBrPos = solver.allocElement(branch, posNode);  // :89

  // asrcset.c:92-119 — one Jacobian column per controlling variable.
  this._varHandles = new Array(this._tree.numVars);
  for (let i = 0; i < this._tree.numVars; i++) {
    const column = this._resolveVarRow(ctx, this._tree.vars[i]); // asrcset.c:95-109
    this._vars[i] = column;                                       // asrcset.c:111
    this._varHandles[i] = solver.allocElement(branch, column);    // asrcset.c:114
  }
}
```

**BI (I-mode) setup** — port of `asrcset.c:92-118` I-branches (no branch row,
two handles per controller):

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = this.pinNodes.get("out+")!;  // ASRCposNode
  const negNode = this.pinNodes.get("out-")!;  // ASRCnegNode

  // asrcset.c:92-118 — two Jacobian columns per controlling variable; no branch.
  this._varHandlesPos = new Array(this._tree.numVars);
  this._varHandlesNeg = new Array(this._tree.numVars);
  for (let i = 0; i < this._tree.numVars; i++) {
    const column = this._resolveVarRow(ctx, this._tree.vars[i]); // asrcset.c:95-109
    this._vars[i] = column;                                       // asrcset.c:111
    this._varHandlesPos[i] = solver.allocElement(posNode, column); // asrcset.c:116
    this._varHandlesNeg[i] = solver.allocElement(negNode, column); // asrcset.c:117
  }
}
```

`_resolveVarRow` maps the controller type to the row index:
`IF_NODE` → `pinNodes`/`labelToNodeId` lookup of the node id (`asrcset.c:104-105`);
`IF_INSTANCE` → the controlling source's branch row via the engine's
branch-find facility (the `findBranchFor` mechanism on the controlling element,
`controlled-source-base.ts:136-141`, is the `CKTfndBranch` counterpart;
`ASRCfindBr` `asrcfbr.c:14-35` is ngspice's own lazy branch-allocation hook for
*controlled* ASRCs — see Part B note below). A `0`/unknown result is fatal,
matching `asrcset.c:97-102`.

### `ASRCfindBr` (`asrcfbr.c:14-35`)

`ASRCfindBr` is the `DEVfindBranch` hook ngspice calls when *another* device
names this ASRC as a current controller: it lazily allocates this instance's
branch row (`CKTmkCur`, `asrcfbr.c:25-30`) and returns it. This is the same
idempotent lazy-allocate pattern as `ControlledSourceElement.findBranchFor`
(`controlled-source-base.ts:136-141`). digiTS's `BVAnalogElement` exposes a
`findBranchFor(name, ctx)` returning `this.branchIndex` (allocating it if
`-1`), so an ASRC controlled by another ASRC's current resolves correctly
regardless of setup order. `BIAnalogElement` owns no branch and is never a
current controller, so it needs no `findBranchFor` (matching ngspice — only the
V-mode ASRC has a branch to find).

## Part C — Parse-tree evaluation: `rhs` + partial-derivative vector

ngspice's `ASRCload` evaluates the parse tree once per NR iteration
(`asrcload.c:62-83`):

```
i = here->ASRCtree->numVars;                       // asrcload.c:65
... grow asrc_vals/asrc_derivs to i ...            // asrcload.c:66-70
for (i = 0; i < numVars; i++)                       // asrcload.c:77-78
    asrc_vals[i] = ckt->CKTrhsOld[here->ASRCvars[i]];
here->ASRCtree->IFeval(tree, ckt->CKTgmin, &rhs,    // asrcload.c:80
                       asrc_vals, asrc_derivs);
```

`IFeval` (`ifeval.c` → `PTeval` → `ptfuncs.c`) returns both `rhs` (the function
value at the current operating point) and `asrc_derivs[i] = ∂f/∂var_i` for each
controlling variable, with `CKTgmin` passed as the small-conductance floor for
the `/` fudge factor (Part 0.B). This is exactly the combined eval+derivative
the Part 0 `IFeval` build produces.

### digiTS parse-tree wrapper (`ParsedBSourceTree`)

The reconstruction wraps the Part 0 `CompiledBSourceTree` into an ASRC-shaped
tree object that exposes ngspice's `IFparseTree` surface (the `numVars`/`vars[]`/
`eval` are Part 0; this wrapper adds the ASRC-instance binding):

| ngspice `IFparseTree` field/op | `asrcdefs.h`/`ifsim.h` | digiTS counterpart |
|---|---|---|
| `int numVars` | parse-tree var count | `this._tree.numVars` |
| `IFnode/IFinstance *vars[i]` | controlling-variable descriptors | `this._tree.vars[i]` = `{ kind: "node" \| "branch", label }` |
| `int varTypes[i]` (`IF_NODE`/`IF_INSTANCE`) | `asrcset.c:95` | `this._tree.vars[i].kind` |
| `IFeval(tree, gmin, &rhs, vals, derivs)` | `asrcload.c:80` | `this._tree.eval(gmin, vals) → { rhs, derivs }` |

The `vars[]` set is produced by the Part 0.A build step (the ordered list of
distinct `circuit-voltage` / `circuit-current` quantities, deduplicated and
ordered by first-encounter, matching `inpptree.c:1195-1239`). The Part 0
`buildBSourceTree(exprText)` does the parse, the var collection, the per-var
`differentiate`+`simplify`+`compile`, and the value-AST compile (Part 0.A
steps 1–4).

`tree.eval(gmin, vals)` (Part 0.A) binds each `vars[i]` to `vals[i]` in a
`MutableExpressionContext` (`controlled-source-base.ts:41`), evaluates the value
expression for `rhs`, and evaluates each compiled derivative for `derivs[i]`.
`gmin` (`ctx.cktGmin`, `load-context.ts:112`) feeds the `/`-operator fudge floor
(Part 0.B). The eval order — value first, then derivatives `0..numVars-1` —
matches ngspice's single `IFeval` returning the `rhs` then the filled
`asrc_derivs[]`.

`ddt` and the `pwl` data-bearing functions own their per-node history/breakpoint
buffers inside the Part 0 build (Part 0.F). The asrc wrapper passes `ctx.time`
(`load-context.ts:84`), the `MODETRAN` flag, and the state vectors
(`load-context.ts:159-165`) through to the `MutableExpressionContext`; the asrc
element owns no additional history beyond what the Part 0 `ddt`/`pwl` nodes
need (the Part 0 build owns the buffers, the element supplies time + state +
mode references).

## Part D — Load: temperature factor, srcFact gate, linearized Jacobian/RHS stamp

ngspice's `ASRCload` (`asrcload.c:38-124`) per instance:

### Temperature + multiplier factor (`asrcload.c:41-52`)

```
difference = (ASRCtemp + ASRCdtemp) - 300.15;        // asrcload.c:41
factor = 1.0 + ASRCtc1*difference + ASRCtc2*difference*difference;  // :42-44
if (ASRCreciproctc == 1) factor = 1 / factor;        // :46-47
if (ASRCreciprocm == 1)  factor = factor / ASRCm;    // :49-50
else                     factor = factor * ASRCm;    // :51-52
```

The `300.15` literal is the reference temperature ngspice flags as a FIXME
(`asrcload.c:41` "FIXME: tnmom instead of 300.15"); the baseline reproduces
`300.15` exactly (it is the number the DLL computes — matching it is the parity
bar; the FIXME is not a license to substitute `CONSTRefTemp`).

### srcFact gate (`asrcload.c:54-60`) — #15 caveat

```c
#ifdef XSPICE_EXP
    value *= ckt->CKTsrcFact;
    value *= cm_analog_ramp_factor();
#else
    if (ckt->CKTmode & MODETRANOP)
        factor *= ckt->CKTsrcFact;
#endif
```

digiTS builds the non-`XSPICE_EXP` branch (the standard ngspice DLL build).
**The gate is `MODETRANOP` ONLY** — narrower than the V/I-source ramp
(`dc-voltage-source.ts:218-222`). Do NOT add `MODEDCOP|MODEDCTRANCURVE`:

```ts
import { MODETRANOP } from "../../solver/analog/ckt-mode.js";
// asrcload.c:58 — the source-ramp factor applies to the B-source ONLY during
// the transient operating-point solve, not the DC operating point or the
// DC-transfer-curve sweep (narrower than the independent-source gate).
if (ctx.cktMode & MODETRANOP) {
  factor *= ctx.srcFact;
}
```

### V-mode stamp (BV) (`asrcload.c:93-107`)

After `tree.eval` returns `rhs` + `derivs`:

```c
*(ASRCposPtr[j++]) += 1.0;   // asrcload.c:95   (posNode, branch)
*(ASRCposPtr[j++]) -= 1.0;   // asrcload.c:96   (negNode, branch)
*(ASRCposPtr[j++]) -= 1.0;   // asrcload.c:97   (branch, negNode)
*(ASRCposPtr[j++]) += 1.0;   // asrcload.c:98   (branch, posNode)
for (i = 0; i < numVars; i++) {
    rhs -= (asrc_vals[i] * asrc_derivs[i]);          // asrcload.c:101
    *(ASRCposPtr[j++]) -= asrc_derivs[i] * factor;   // asrcload.c:103  (branch, var_i)
}
ckt->CKTrhs[ASRCbranch] += factor * rhs;             // asrcload.c:106
```

The branch-incidence ±1 terms (`asrcload.c:95-98`) are the same B/C voltage-
source incidence digiTS already stamps for VCVS (`vcvs.ts:218-221`). The
distinctive ASRC piece is the **loop over N controlling variables**: each
contributes `-derivs[i]*factor` to the branch row's `var_i` column, and the
constant RHS term subtracts `vals[i]*derivs[i]` (the multi-variable NR
linearization — the N-variable generalization of `vcvs.ts:258`'s
`value - derivative*ctrlValue`). The `rhs -=` accumulation order over `i`
matters in floating point and must follow `asrcload.c:101` exactly (the
`CLAUDE.md` per-device accumulation-order note):

```ts
override load(ctx: LoadContext): void {
  const factor = this._tempMultiplierFactor(ctx);  // Part D temp + srcFact

  // asrcload.c:77-78 — controlling-variable values from the prior NR iterate.
  for (let i = 0; i < this._tree.numVars; i++) {
    this._vals[i] = ctx.rhsOld[this._vars[i]];
  }
  // asrcload.c:80 — single eval returns rhs + per-variable partials.
  const ev = this._tree.eval(ctx.cktGmin, this._vals);  // { rhs, derivs }
  let rhs = ev.rhs;
  const derivs = ev.derivs;

  // asrcload.c:86 — store the rhs for the convergence test (Part F).
  this._prevValue = rhs;

  // asrcload.c:89-91 — AC precompute (Part G), MODEINITSMSIG only.
  if (ctx.cktMode & MODEINITSMSIG) {
    for (let i = 0; i < this._tree.numVars; i++) this._acValues[i] = derivs[i];
  }

  const solver = ctx.solver;
  // asrcload.c:95-98 — branch incidence.
  solver.stampElement(this._hPosBr,  1.0);
  solver.stampElement(this._hNegBr, -1.0);
  solver.stampElement(this._hBrNeg, -1.0);
  solver.stampElement(this._hBrPos,  1.0);

  // asrcload.c:100-104 — one Jacobian column + RHS correction per controller.
  for (let i = 0; i < this._tree.numVars; i++) {
    rhs -= this._vals[i] * derivs[i];                       // asrcload.c:101
    solver.stampElement(this._varHandles[i], -derivs[i] * factor); // asrcload.c:103
  }
  // asrcload.c:106 — branch RHS.
  ctx.rhs[this.branchIndex] += factor * rhs;

  // asrcload.c:122-123 — AC rhs store (Part G).
  if (ctx.cktMode & MODEINITSMSIG) {
    this._acValues[this._tree.numVars] = factor * rhs;
  }
}
```

### I-mode stamp (BI) (`asrcload.c:108-119`)

No branch row; two Jacobian columns per controller; the constant term lands on
the output node RHS pair:

```c
for (i = 0; i < numVars; i++) {
    rhs -= (asrc_vals[i] * asrc_derivs[i]);          // asrcload.c:111
    *(ASRCposPtr[j++]) += asrc_derivs[i] * factor;   // asrcload.c:113  (posNode, var_i)
    *(ASRCposPtr[j++]) -= asrc_derivs[i] * factor;   // asrcload.c:114  (negNode, var_i)
}
ckt->CKTrhs[ASRCposNode] -= factor * rhs;            // asrcload.c:117
ckt->CKTrhs[ASRCnegNode] += factor * rhs;            // asrcload.c:118
```

The digiTS BI `load()` mirrors the V-mode structure (same temp/srcFact factor,
same eval, same `_prevValue`/`_acValues` capture) but stamps the I-mode columns
and the `posNode`/`negNode` RHS pair (`asrcload.c:113-118`). The sign
convention — `+derivs[i]*factor` at `posNode`, `-derivs[i]*factor` at `negNode`,
RHS `-=`/`+=` — is the SPICE source-leaves-pos / arrives-neg convention digiTS
already uses for VCCS (`vccs.ts:194-203`), generalized over N controllers.

The `MODEINITSMSIG` AC-precompute and the `_prevValue` capture are
topology-independent (both stamp arms share `asrcload.c:86-91` and `:122-123`),
so they live in a shared helper consumed by both element classes.

## Part E — Temperature defaults (rebuild of `ASRCtemp`)

ngspice's `ASRCtemp` (`asrctemp.c:12-37`) resolves the per-instance temperature
before `load()`:

```c
if (!here->ASRCtempGiven) {                  // asrctemp.c:23
    here->ASRCtemp = ckt->CKTtemp;           // asrctemp.c:24
    if (!here->ASRCdtempGiven)               // asrctemp.c:25
        here->ASRCdtemp = 0.0;               // asrctemp.c:26
} else {                                     // asrctemp.c:27
    here->ASRCdtemp = 0.0;                   // asrctemp.c:28
    if (here->ASRCdtempGiven)                // asrctemp.c:29
        printf("%s: Instance temperature specified, dtemp ignored\n", ...);  // :30
}
```

i.e. when `temp` is not netlisted, the instance temperature is the circuit
temperature `CKTtemp` and `dtemp` defaults to `0`; when `temp` IS netlisted,
`dtemp` is forced to `0` (and a warning prints if `dtemp` was also given). The
digiTS element resolves this in a `temp()`-equivalent step (or lazily at the
top of `load()` if no separate temp pass exists), reading `ctx.temp`
(`load-context.ts:124`, the `CKTtemp` counterpart) as the fallback:

```ts
// asrctemp.c:23-31 — resolve instance temperature against the circuit temp.
private _resolveTemp(ctx: LoadContext): { temp: number; dtemp: number } {
  if (!this._tempGiven) {
    return { temp: ctx.temp, dtemp: this._dtempGiven ? this._dtemp : 0.0 };
  }
  // temp given ⇒ dtemp forced to 0 (asrctemp.c:28); dtemp-given warning is a diagnostic.
  return { temp: this._temp, dtemp: 0.0 };
}
```

These reads feed `difference = (temp + dtemp) - 300.15` in Part D. All of
`TEMP`/`DTEMP`/`TC1`/`TC2`/`M`/`RECIPROCTC`/`RECIPROCM` are hot-loadable via
`setParam` (#53): a `setParam` write updates the field and the next `load()`
recomputes `factor` from the new value (no recompile). `setParam` mirrors the
`asrcpar.c:29-56` branches — store the value, set the matching `*Given` flag:

```ts
setParam(key: string, value: number): void {
  switch (key) {
    case "TC1": this._tc1 = value; this._tc1Given = true; break;       // asrcpar.c:30-31
    case "TC2": this._tc2 = value; this._tc2Given = true; break;       // asrcpar.c:34-35
    case "M":   this._m = value;   this._mGiven = true; break;          // asrcpar.c:38-39
    case "RECIPROCTC": this._reciproctc = value; this._reciproctcGiven = true; break; // :42-43
    case "RECIPROCM":  this._reciprocm = value;  this._reciprocmGiven = true; break;  // :46-47
    case "TEMP":  this._temp = value + CONSTCtoK; this._tempGiven = true; break;       // :50-51
    case "DTEMP": this._dtemp = value; this._dtempGiven = true; break;  // asrcpar.c:54-55
  }
}
```

## Part F — Convergence test (rebuild of `ASRCconvTest`)

ngspice's `ASRCconvTest` (`asrcconv.c:13-60`) re-evaluates the parse tree at the
current iterate and compares against the stored `ASRCprev_value`:

```c
for (i = 0; i < numVars; i++)                          // asrcconv.c:34-35
    asrc_vals[i] = ckt->CKTrhsOld[here->ASRCvars[i]];
IFeval(tree, ckt->CKTgmin, &rhs, asrc_vals, asrc_derivs);  // asrcconv.c:37
prev = here->ASRCprev_value;                            // asrcconv.c:41
diff = fabs(prev - rhs);                                // asrcconv.c:42
if (ASRCtype == ASRC_VOLTAGE)                           // asrcconv.c:44
    tol = CKTreltol * MAX(fabs(rhs), fabs(prev)) + CKTvoltTol;   // :45-46
else
    tol = CKTreltol * MAX(fabs(rhs), fabs(prev)) + CKTabstol;    // :48-49
if (diff > tol) { CKTnoncon++; CKTtroubleElt = here; return OK; }  // :51-55
```

The voltage form uses `CKTvoltTol`; the current form uses `CKTabstol`. digiTS's
per-element convergence check (the `ConvergenceEvent` mechanism,
`load-context.ts:42-53`) reproduces this: BV uses `ctx.voltTol`
(`load-context.ts:147`), BI uses `ctx.iabstol` (`load-context.ts:123`), both
with `ctx.reltol` (`load-context.ts:121`). The element re-evaluates the tree at
`rhsOld`, compares to `this._prevValue`, and on `diff > tol` pushes a
non-converged `ConvergenceEvent` (the `CKTnoncon++` + `CKTtroubleElt`
counterpart). The `MAX(fabs(rhs), fabs(prev))` operand and the `diff > tol`
strict comparison are reproduced exactly.

## Part G — Small-signal (AC) precompute and reload (rebuild of `ASRCacLoad`)

ngspice splits the AC path: `ASRCload` under `MODEINITSMSIG` stores the
derivatives + the `factor*rhs` constant into `ASRCacValues[]`
(`asrcload.c:89-91, 122-123`, Part D), then `ASRCacLoad` (`asrcacld.c:19-79`)
reloads them into the (complex) matrix at each AC frequency WITHOUT
re-evaluating the tree:

```c
factor = ... (same temp+m factor, asrcacld.c:34-45) ...
derivs = here->ASRCacValues;                            // asrcacld.c:55
if (ASRCtype == ASRC_VOLTAGE) {
    *(ASRCposPtr[j++]) += 1.0; ... -= 1.0; ... -= 1.0; ... += 1.0;  // asrcacld.c:59-62
    for (i = 0; i < numVars; i++)
        *(ASRCposPtr[j++]) -= derivs[i] * factor;        // asrcacld.c:64-65
} else {
    for (i = 0; i < numVars; i++) {
        *(ASRCposPtr[j++]) += derivs[i] * factor;        // asrcacld.c:70
        *(ASRCposPtr[j++]) -= derivs[i] * factor;        // asrcacld.c:71
    }
}
```

`ASRCacLoad` stamps ONLY the Jacobian (the conductance/incidence matrix) — no
RHS, because in AC analysis the linearized companion model's constant term is
the AC excitation, supplied separately. The stamp pattern is identical to the
`load()` matrix side (Part D) minus the RHS lines, reading the *stored*
`ASRCacValues[i]` instead of a fresh `tree.eval`.

digiTS's AC path runs the unified `SparseSolver` in complex mode
(`MEMORY.md` AC-solver-unified). The reconstruction adds an `acLoad(ctx)`
(or the engine's AC-stamp hook) on both element classes that recomputes
`factor` (Part D temp+m — note `asrcacld.c:34-45` recomputes it; it does NOT
re-apply the `MODETRANOP` srcFact, which is a transient-only gate) and stamps:

- **BV** (`asrcacld.c:59-65`): the four ±1 branch-incidence handles, then
  `-_acValues[i]*factor` into each `_varHandles[i]`.
- **BI** (`asrcacld.c:70-71`): `+_acValues[i]*factor` / `-_acValues[i]*factor`
  into the two per-controller handles.

The `_acValues[i]` are the partials captured during the `MODEINITSMSIG`
operating-point `load()` (Part D), exactly as ngspice precomputes them.
`_acValues[numVars]` (the `factor*rhs` slot, `asrcload.c:123`) is captured for
completeness but is unused by `ASRCacLoad` (ngspice stores it but `asrcacld.c`
never reads it — the AC stamp is Jacobian-only); the slot is reproduced for
structural parity.

## Part H — Component definitions, registration, expression-engine consumption

Both `BV` and `BI` are `StandaloneComponentDefinition`s (the `vcvs.ts:377` /
`vccs.ts:324` pattern): a 2-pin device (`out+`, `out-`) plus the controlling
variables referenced symbolically inside the expression (resolved at setup, not
declared as pins — ASRC's controllers are netlist references, not device
terminals). The `modelRegistry` carries one `behavioral` inline model whose
factory parses the `expression` property, builds the `ParsedBSourceTree`
(Part C), and constructs the element with `ASRC_VOLTAGE`/`ASRC_CURRENT`
identity:

```ts
modelRegistry: {
  behavioral: {
    kind: "inline",
    factory: (pinNodes, props, getTime) => {
      const exprText = props.getOrDefault<string>("expression", "0");
      const tree = buildBSourceTree(exprText);   // Part C: parse + per-var derivatives
      return new BVAnalogElement(pinNodes, tree, getTime);  // BI: BIAnalogElement
    },
    paramDefs: BV_PARAM_DEFS,
    params: BV_DEFAULTS,
  },
},
defaultModel: "behavioral",
```

`defaultModel` selects the initial model in the property bag at placement only
(`CLAUDE.md` Component Model Architecture); the element's `model` property is
the source of truth after placement. Both components register in
`register-all.ts` alongside the existing controlled sources, each with
`deviceFamily: "ASRC"` (a new `DeviceFamily` value + a `NGSPICE_LOAD_ORDER.ASRC`
slot placed per the ngspice device-load dispatch order).

**Expression-engine build (#10/#19) — OWNED BY THIS UNIT (Part 0).** This recon
BUILDS the v41-EXACT `IFeval` contract on `expression.ts` /
`expression-evaluate.ts` / `expression-differentiate.ts` (Part 0): the combined
`eval(gmin,vals)→{rhs,derivs[]}` (Part 0.A), the `/` gmin fudge (Part 0.B), the
complete B-source function set — MODULUS range-reduction on `sin`/`cos`/`tan`
(`ptfuncs.c:258-330`), `HUGE`/`±1e99` clamps on `exp`/`log`/`sqrt`, the `/`
fudge, `pow(fabs(a),b)` on `^`/`pow`, the ~18 missing scalar functions
(`sgn`/`u`/`u2`/`uramp`/`eq0..le0`/`nint`/`asinh`/`acosh`/`atanh`/`pwr`/`ln`,
Part 0.C), the ternary `?:` (Part 0.D), `temper` (Part 0.E), and `ddt` +
`pwl`/`pwl_derivative` (Part 0.F). A B-source function or derivative that lives
in `expression*.ts` rather than `bsource.ts` is **in scope** — it is Part 0
work, not a missing-dependency escalation. The STALE
`expr-engine#recon/numericalDeltas` overlay is subsumed by Part 0; the asrc
build re-verifies its clamp/hyperbolic ground. The bit-exact harness gate
(acceptance #12) presupposes Part 0 is built so the tree evaluation matches
`IFeval` function-for-function.

## Acceptance criteria

0. **Part 0 — the `IFeval` contract is built on `expression*.ts`.**
   `expression.ts` exports `buildBSourceTree(exprText) → CompiledBSourceTree`
   with `{ numVars, vars: {kind, label, valueIndex}[], eval(gmin, vals) → {rhs,
   derivs[]} }`; `eval` matches `IFeval` (`ifeval.c:46-69`) — value first, then
   derivatives `0..numVars-1`; `vars[]` is first-encounter order
   (`inpptree.c:1195-1239`). The `/` operator applies the `gmin*1e-20` fudge
   (`PTdivide`, `ptfuncs.c:54-66`) in all three evaluators. `BUILTIN_FUNCTIONS`
   carries the full `funcs[]` set (`inpptree.c:135-175`): the ~18 added scalar
   functions (`sgn`/`u`/`u2`/`uramp`/`eq0..le0`/`nint`/`asinh`/`acosh`/`atanh`/
   `pwr`/`ln`) with the `ptfuncs.c` value semantics and the
   `inpptree.c PTdifferentiate` derivative rules of Part 0.C, the `^`/`pow`
   `pow(fabs(a),b)` default-compat value (`ptfuncs.c:87,121-122`), the `?:`
   ternary node (`ifeval.c:134-151`, derivative `inpptree.c:381-383`), the
   `temper` builtin-var (`ifeval.c:176-178`, derivative `0`), and the `ddt`
   (`ptfuncs.c:422-466`) + `pwl`/`pwl_derivative` (`ptfuncs.c:345-392`)
   data-/state-bearing nodes. This subsumes the STALE
   `expr-engine#recon/numericalDeltas`.

1. `src/components/active/bsource.ts` exists and exports **two**
   `StandaloneComponentDefinition`s, `BV` (V-mode, `ASRC_VOLTAGE`) and `BI`
   (I-mode, `ASRC_CURRENT`), per #27; both registered in `register-all.ts` with
   `deviceFamily: "ASRC"` and an `NGSPICE_LOAD_ORDER.ASRC` slot. `BV` is a
   branch-row element; `BI` is RHS-only.
2. Both components declare the model-param block `TC1`/`TC2`/`M`/`RECIPROCTC`/
   `RECIPROCM`/`TEMP`/`DTEMP` with the defaults of Part A
   (`asrcset.c:46-55`, `asrctemp.c:23-26`), each with its `*Given` flag read
   from the property bag. `temp` is Celsius-in / Kelvin-internal
   (`asrcpar.c:50` `+ CONSTCtoK`).
3. `setup()` ports `asrcset.c:37-119`: the parse-tree-present guard
   (`:37-38`), the V-mode shorted guard (`:40-44`, BV only), the
   handle-array sizing (`4+numVars` BV / `2*numVars` BI, `:57-66`), the BV
   branch allocation via `makeCur` (`:79-84`), the BV branch-incidence TSTALLOC
   in exact order (`:86-89`), and the per-controlling-variable row resolution
   (`IF_NODE`→node id / `IF_INSTANCE`→branch row, `:95-111`) + Jacobian-column
   TSTALLOC (BV `:114`; BI `:116-117`). The TSTALLOC handle order matches
   line-for-line (harness-CSC-visible).
4. The parse-tree wrapper (`ParsedBSourceTree`) wraps the Part 0
   `CompiledBSourceTree` (built on `expression.ts`/`expression-evaluate.ts`/
   `expression-differentiate.ts`): `numVars` distinct controlling quantities
   collected in first-encounter order with `kind` (node/branch), a single
   `eval(gmin, vals)` returning `{ rhs, derivs[] }` matching ngspice `IFeval`
   (`asrcload.c:80`), `gmin` from `ctx.cktGmin`.
5. `BV.load()` ports `asrcload.c:93-106`: branch incidence `±1`
   (`:95-98`), the N-controller loop accumulating `rhs -= vals[i]*derivs[i]`
   (`:101`) and stamping `-derivs[i]*factor` into `_varHandles[i]` (`:103`) in
   exact order, and `rhs[branch] += factor*rhs` (`:106`).
6. `BI.load()` ports `asrcload.c:108-118`: the N-controller loop
   (`+derivs[i]*factor` at posNode `:113`, `-derivs[i]*factor` at negNode
   `:114`) and the `rhs[posNode] -= factor*rhs` / `rhs[negNode] += factor*rhs`
   pair (`:117-118`).
7. The temperature+multiplier `factor` is computed per `asrcload.c:41-52`
   (`difference = (temp+dtemp) - 300.15`; `tc1`/`tc2` quadratic; `reciproctc`
   inverse; `reciprocm` divide-vs-multiply by `m`), with the `300.15` literal
   reproduced exactly. The `srcFact` ramp is gated on **`MODETRANOP` ONLY**
   (`asrcload.c:58`), narrower than the independent-source gate — #15 caveat.
8. `ASRCtemp` defaults are reproduced (`asrctemp.c:23-31`): `temp` unset ⇒
   `temp = ctx.temp`, `dtemp` defaults `0`; `temp` set ⇒ `dtemp` forced `0`.
   All of `TC1`/`TC2`/`M`/`RECIPROCTC`/`RECIPROCM`/`TEMP`/`DTEMP` are
   hot-loadable via `setParam` on all three surfaces (#53), each storing the
   value and setting its `*Given` flag (`asrcpar.c:29-56`).
9. The convergence test is ported (`asrcconv.c:34-55`): re-eval at `rhsOld`,
   `diff = |prev - rhs|`, `tol = reltol*MAX(|rhs|,|prev|) + voltTol` (BV) /
   `+ abstol` (BI), non-converged on `diff > tol`, via the `ConvergenceEvent`
   mechanism. `_prevValue` is captured in `load()` (`asrcload.c:86`).
10. The AC path is ported: `load()` under `MODEINITSMSIG` stores
    `derivs[i]`→`_acValues[i]` and `factor*rhs`→`_acValues[numVars]`
    (`asrcload.c:89-91, 122-123`); the AC stamp hook reloads the stored
    `_acValues[]` into the complex matrix Jacobian-only (BV `asrcacld.c:59-65`,
    BI `asrcacld.c:70-71`), recomputing `factor` WITHOUT the `MODETRANOP`
    srcFact and WITHOUT re-evaluating the tree.
11. `BV` exposes `findBranchFor(name, ctx)` (the `ASRCfindBr` counterpart,
    `asrcfbr.c:14-35`) so an ASRC current-controlled by another ASRC resolves
    regardless of setup order; `BI` owns no branch and exposes none.
12. **Fixture + harness deck-generator emit path are built so the harness gate
    is runnable.** A `src/solver/analog/__tests__/ngspice-parity/fixtures/
    asrc-gate.dts` fixture exists carrying, at minimum: a BV
    (`B1 out 0 V=2*V(in)`, single `IF_NODE` controller), a BI
    (`B2 out 0 I=...`, single controller), a multi-controller case
    (`V(a)*V(b)+I(Vsense)` — mixed `IF_NODE` + `IF_INSTANCE`, `numVars>1`,
    exercising the `*` derivative product rule and the `vals[i]*derivs[i]` RHS
    accumulation order), and a temperature-coefficient case
    (`tc1`/`tc2`/`m`/`reciprocm`). The `.dts` is in the canonical structured
    fixture format (`circuit.elements[]` + `wires[]`, `"format": "dts"`), NOT a
    hand-written SPICE deck (Hard Rule: never read `.dig`/`.dts` XML for
    topology). The harness deck-generator
    (`src/solver/analog/__tests__/harness/netlist-generator.ts`) gains a
    `BV`/`BI` emit branch: an `ELEMENT_SPECS` entry (`prefix: "B"`) and an
    `emitPrimitive` branch emitting the ngspice B-card
    `B<name> <out+> <out-> V=<expr>` (BV) / `I=<expr>` (BI) with the
    `tc1=`/`tc2=`/`temp=`/`dtemp=`/`reciproctc=`/`m=`/`reciprocm=` instance
    tokens, so that the harness can build the matching ngspice deck. Then a
    `.tran` (and `.op`) run of that fixture produces the source RHS value, the
    per-controller Jacobian columns, and the convergence verdict matching the
    ngspice DLL at every accepted NR iteration. Verified via the `harness_*`
    MCP tool chain (`harness_start` → `harness_run` →
    `harness_first_divergence` → `harness_matrix_diff` → `harness_get_attempt`),
    with `firstDivergence` null across voltage / matrix / state / shape classes.
    Bit-exact under the matched-arithmetic-order constraint — no tolerance
    qualifier. (Full bit-exact tree evaluation presupposes Part 0 is built.)
13. With `asrc#recon/wholeClass` `APPLIED`, the 17 blocked v41 hunks (next
    section) apply onto the rebuilt baseline as ordinary per-hunk deltas.
    `build-ledger.mjs` re-runs cleanly with the recon `APPLIED` and the 17
    hunks unblocked.

## Blocked hunks (apply after the recon)

These 17 v41 hunks are `blockedBy: asrc#recon/wholeClass` in `ledger.json` and
apply as ordinary per-hunk deltas once the baseline above is `APPLIED`:

| Hunk | ngspice anchor | what it adds onto the baseline |
|---|---|---|
| `asrc/asrcdefs.h#h001` | `asrcdefs.h` | `m`/`reciprocm` instance fields + `*Given` bits + `ASRCacValues`/`ASRCvars` declarations |
| `asrc/asrcdefs.h#h002` | `asrcdefs.h` | param-enum additions (`ASRC_M`/`ASRC_RM`) + accessor-macro deltas |
| `asrc/asrc.c#h001` | `asrc.c:14-28` | `m`/`reciprocm` IFparm rows in `ASRCpTable` |
| `asrc/asrcpar.c#h001` | `asrcpar.c:37-48` | `ASRC_M`/`ASRC_RM` param-set cases + `*Given` |
| `asrc/asrcpar.c#h002` | `asrcpar.c` | reciproc-flag param plumbing |
| `asrc/asrcset.c#h001` | `asrcset.c:52-55` | `reciprocm`/`m` default-init in setup |
| `asrc/asrcset.c#h002` | `asrcset.c:57-119` | restructured TSTALLOC walk / handle-array sizing for the multiplier path |
| `asrc/asrctemp.c#h001` | `asrctemp.c:23-31` | temp/dtemp default-resolution delta |
| `asrc/asrcload.c#h001` | `asrcload.c:49-52` | `reciprocm` divide-vs-multiply-by-`m` factor branch |
| `asrc/asrcload.c#h002` | `asrcload.c:54-60` | `MODETRANOP` srcFact gate (+ `XSPICE_EXP` guard) |
| `asrc/asrcload.c#h003` | `asrcload.c:66-70` | `TREALLOC` scratch grow-on-demand (`asrc_vals`/`asrc_derivs`) |
| `asrc/asrcacld.c#h001` | `asrcacld.c:34-45` | AC-path `m`/`reciprocm` factor recompute |
| `asrc/asrcacld.c#h002` | `asrcacld.c:64-65` | V-mode AC Jacobian `*factor` scaling |
| `asrc/asrcacld.c#h003` | `asrcacld.c:70-71` | I-mode AC Jacobian `*factor` scaling |
| `asrc/asrcconv.c#h001` | `asrcconv.c:34-55` | convergence-test re-eval + `ASRCvars[]` index-cache read |
| `asrc/asrcfbr.c#h001` | `asrcfbr.c:25-30` | lazy branch allocation via `CKTmkCur` |
| `asrc/asrcfbr.c#h002` | `asrcfbr.c` | branch-find accessor / return-value delta |

(Any remaining asrc hunks — accessor renames, `ptr→Ptr`, `XSPICE_EXP`/
`SHARED_MODULE` blocks, GC'd teardown in `ASRCunsetup` `asrcset.c:127-145` —
resolve independently as PORT / NO-COUNTERPART per their `ledger.json`
planningNotes and do NOT block on this recon.)

Status: RATIFIED 2026-05-30 (user, batch). Widened 2026-06-05 (user): the asrc
unit OWNS the full v41 `IFeval` expression-engine build (Part 0) on
`expression.ts`/`expression-evaluate.ts`/`expression-differentiate.ts`; a
needed B-source function living outside `bsource.ts` is in scope, not a
missing-dependency blocker. Subsumes the STALE
`expr-engine#recon/numericalDeltas`.
