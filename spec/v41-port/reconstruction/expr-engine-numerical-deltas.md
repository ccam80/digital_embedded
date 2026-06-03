# Reconstruction spec — `expr-engine#recon/numericalDeltas`

Port the small set of **portable numerical clamps and derivative corrections**
that ngspice's B-source expression machinery applies and the digiTS expression
subsystem currently lacks. The scope is **contained** to the expression
subsystem — `src/solver/analog/expression-evaluate.ts`,
`src/solver/analog/expression-differentiate.ts`,
`src/solver/analog/expression.ts` (both its parser function-set **and** its
runtime evaluator function map `BUILTIN_FUNCTIONS` — see the single-clamped-map
invariant in the STANCE section), and `src/solver/analog/model-parser.ts` (atto
suffix). It does
**not** reach
into protected engine/compiler infra (no `compiler.ts`, no solver, no node
allocation), and it does **not** attempt to reproduce ngspice's parse-tree
architecture.

This spec is the resolution of the four-group expr-engine escalation
(`spec/v41-port/ESCALATIONS.md`, "expr-engine (parser/inpptree.c, inpeval.c,
ptfuncs.c, ifeval.c) — verifier ESCALATE (2026-06-03)", lines 1061–1093). The
escalation's central finding is accepted and made load-bearing below.

### User rulings applied (2026-06-03)

The user has resolved every open decision this spec previously raised:

- **`tanh`/`sinh`/`cosh`: IMPLEMENT.** The hyperbolic functions are added to the
  expression engine's function set (parser + evaluator + differentiator), and
  BOTH `PTdifferentiate` derivative corrections are PORTED — PTF_TAN
  (`1/cos² → 1+tan²`) AND PTF_TANH (`1/cosh² → 1−tanh²`). The PTF_TANH derivative
  therefore moves from NO-COUNTERPART to PORT, and the hyperbolic function-set
  expansion is now in scope for this recon (Delta 4 + Delta 6 below).
- **compatmode (`newcompat.ps`/`.lt`/`.hs`, EXPARGMAX/EXPMAX): OUT →
  NO-COUNTERPART.**
- **RKM (`inpeval.c#h006`): OUT → NO-COUNTERPART.**
- **`PTddt`: OUT for now → NO-COUNTERPART**, tracked as a deferred asrc /
  B-source capability, not built in this recon.
- **Single clamped `BUILTIN_FUNCTIONS` map (mandatory, not optional):** digiTS
  currently has **two** runtime evaluators, each with its own `BUILTIN_FUNCTIONS`
  literal — `expression-evaluate.ts:47–66` (used by `evaluate` /
  `compileExpression`) and `expression.ts:108–127` (used by `evaluateExpression`,
  which the arbitrary-expression sources call on the load path). Both must carry
  the PTexp/PTlog/PTlog10 clamps and the hyperbolic adds, so the two literals are
  **deduped into one exported, clamped `BUILTIN_FUNCTIONS`** that both files
  import. This is a hard requirement, not a "dedupe if convenient" (see the
  STANCE invariant and Acceptance criterion 3).
- **`simplify()` parallel math table:** the `simplify()` constant-fold `mathFns`
  table (`expression-differentiate.ts:336–342`) is a third parallel copy. After
  this recon it folds through the single clamped `BUILTIN_FUNCTIONS` and the
  `mathFns` literal is **deleted** (single source of truth), not kept in sync.
  The implementer verifies coverage before deleting (Acceptance criterion 3).

The USER-DECISION section that previously listed these is retained below only as
a record of the resolved tradeoff; nothing in it remains open.

Authoring contract: this spec is **documentation**. No code. No tests. A later
implementer authors the TypeScript against the ngspice citations herein; the
verifier checks the code against those citations, never the spec against the
code.

Per `CLAUDE.md` comment-hygiene: every reconstructed source comment cites the
current `ref/ngspice` file and line and explains the mechanism in present tense
— no `v41`/`v26`/era tags, no migration narrative.

---

## STANCE — the AST architecture is ACCEPTED DIVERGENCE

digiTS's expression engine is an **independent typed recursive-descent parser
producing an `ExprNode` discriminated-union AST** (`expression.ts`), evaluated
along two runtime paths — `expression.ts`'s `evaluateExpression`
(`expression.ts:408–458`, using the `BUILTIN_FUNCTIONS` literal at
`expression.ts:108–127`) and `expression-evaluate.ts`'s `evaluate` /
`compileExpression` (using the literal at `expression-evaluate.ts:47–66`) — and
differentiated symbolically by `expression-differentiate.ts`. ngspice's B-source
expression engine is a **yacc/bison parse-tree builder** with ref-counted node
constructors and function-pointer dispatch tables.

These are two different machines that compute the same numbers. The yacc /
parse-tree machinery has **no AST counterpart by design**, and reproducing it
would be a from-scratch rewrite of a settled, working subsystem — explicitly the
kind of cross-group architecture change that VERIFICATION.md §6 reserves to the
user, and which is hereby ruled **ACCEPTED DIVERGENCE, NOT PORTED**. The
following ngspice constructs are therefore **NO-COUNTERPART** (verifier records
them as such; they are not MISMATCH and not gaps):

- **Tree-node machinery (`inpptree.c`):** `mkb` / `mkcon` / `mkf` ref-counted
  node constructors; `PT_mkbnode` / `PT_mkfnode` / `PT_mknnode` / `PT_mksnode`;
  the `ops[]` and `funcs[]` function-pointer dispatch tables; the `PTcheck`
  placeholder/validation pass; the `PTlex` lexer and its B-source
  instance-param skip; `free_tree` / `INPfreeTree` / `printTree` and their DDT
  free / null-guard hunks; the static→exported visibility flips on the
  `PT_mk*node` constructors. digiTS parses directly to typed `ExprNode` and
  relies on the JS GC — none of this has, or needs, an analogue.
- **Error / debug machinery (`ifeval.c`):** the `IFeval` null-tree guard
  (`if (!myTree) → fprintf(stderr, …) + controlled_exit(EXIT_BAD)`,
  diff-doc 132–135) and the `PTeval` leading-`\n` added to a stderr range-error
  format string (diff-doc 144–145). digiTS reports errors with structured
  `throw` (`UnknownNodeKindError`, `Error(...)` in `evaluate`/`compileExpression`)
  and has no `controlled_exit` / process-exit / `fprintf` surface. The C
  process-exit and stderr-format hunks are **NO-COUNTERPART**.

This stance is what lets the genuinely numerical deltas below be ported
*surgically* into the existing AST evaluator/differentiator without dragging in
the parse-tree scaffolding.

### Single-clamped-map invariant (load-bearing for Deltas 1, 2, 6)

There are **two** live runtime evaluators in this subsystem, each with its own
`BUILTIN_FUNCTIONS` literal, and a **third** parallel math-function table inside
`simplify()`:

1. `expression-evaluate.ts:47–66` — consumed by `evaluate` (tree-walk,
   `expression-evaluate.ts:112–120`) and `compileExpression` (closure,
   `expression-evaluate.ts:193–201`).
2. `expression.ts:108–127` — consumed by `evaluateExpression`
   (`expression.ts:439–446`), a full runtime tree-walk. **This is the map the
   arbitrary-expression sources actually call on the load path:**
   `ac-voltage-source.ts:1285` and `ac-current-source.ts:576` both invoke
   `evaluateExpression(this._parsedExpr, { t: time })` inside `_evaluate()`,
   whose return feeds the DC/transient stamp value
   (`ac-voltage-source.ts:1251`, `ac-current-source.ts:596,642`).
3. `expression-differentiate.ts:336–342` — the `simplify()` constant-fold
   `mathFns` table.

A clamp placed only on map (1) would leave map (2) un-clamped, so a B-source
expression `exp(300)` evaluated through the source load path returns
`Infinity` (bare `Math.exp`) where ngspice's `PTexp` returns `1e99` — precisely
the divergence Deltas 1/2 exist to remove, on the very path they target.
Therefore the **invariant** for this recon is:

> The clamped `exp`/`log`/`log10` implementations and the `sinh`/`cosh`/`tanh`
> additions live in **one exported, clamped `BUILTIN_FUNCTIONS`** that is the
> **single source of truth** for every runtime function lookup. Both
> `expression.ts`'s `evaluateExpression` and `expression-evaluate.ts`'s
> `evaluate`/`compileExpression` import that one map; the two per-file literals
> are deleted. `simplify()` folds through the same map; its `mathFns` literal is
> deleted.

The new import edge is non-circular: today `expression-evaluate.ts` imports only
`type ExprNode` + `UnknownNodeKindError` from `expression.ts`, and
`expression-differentiate.ts` imports only node constructors from
`expression.ts`. The shared clamped map may be defined in (or re-exported from)
`expression.ts` and imported by `expression-evaluate.ts` and
`expression-differentiate.ts`, or hoisted to a small dedicated module the three
import — the implementer picks whichever keeps the dependency acyclic; all three
target files are in scope, so no out-of-scope edit is introduced.

---

## PORTABLE numerical deltas to build

Each of the following is genuine ngspice numerical behavior the AST engine
currently lacks. All citations were verified by hand against `ref/ngspice` and
the diff doc.

### Delta 1 — `PTexp` unconditional overflow ceiling

**ngspice** `ref/ngspice/src/spicelib/parser/ptfuncs.c:269–281`:

```c
/* Limit the exp: If arg > EXPARGMAX (arbitrarily selected to 14), continue with linear output,
   if compatmode PSPICE is selected.
   If arg exceeds 227.9559242, output its exp value 1e99. */
double
PTexp(double arg)
{
    if (newcompat.ps && arg > EXPARGMAX)
        return EXPMAX * (arg - EXPARGMAX + 1.);
    else if (arg > 227.9559242)
        return 1e99;
    else
        return (exp(arg));
}
```

Diff-doc anchor: `spec/ngspice-v41-engine-diffs/parser.md:9679–9692`.

The **portable** part is the *unconditional* `else if (arg > 227.9559242) →
return 1e99` branch — it fires regardless of compat mode. The first branch
(`newcompat.ps && arg > EXPARGMAX`, with `EXPARGMAX = 14.`,
`EXPMAX = 1202604.284`, both from
`ref/ngspice/src/include/ngspice/inpptree.h:171–172`) is the PSPICE-compat path
and is **USER-DECISION** (see below), NOT part of this delta.

**digiTS target:** the shared clamped `BUILTIN_FUNCTIONS` map (per the
single-clamped-map invariant), `exp` entry. The current entries are the bare
`exp: Math.exp` in **both** runtime maps (`expression-evaluate.ts:55` and
`expression.ts:116`). The clamped `exp` must return `1e99` when
`arg > 227.9559242` and `Math.exp(arg)` otherwise, and must be the single
implementation both runtime paths see (so the source load path through
`evaluateExpression` is clamped too — see the invariant).

> Note on operand: `227.9559242` is `ln(1e99)` to ngspice's printed precision;
> the implementation must use the **literal `227.9559242`** and the literal
> `1e99`, matching the C source character-for-character (do not recompute
> `Math.log(1e99)` — that is a different floating-point value).

### Delta 2 — `PTlog` / `PTlog10` unconditional domain clamps

**ngspice** `ptfuncs.c:286–304`:

```c
/* If arg < , returning HUGE will lead to an error message.
   If arg == 0, don't bail out, but return an arbitrarily very negative value (-1e99).
   Arg 0 may happen, when starting iteration for op or dc simulation. */
double
PTlog(double arg)
{
    if (arg < 0.0)
        return (HUGE);
    if (arg == 0)
        return -1e99;
    return (log(arg));
}

double
PTlog10(double arg)
{
    if (arg < 0.0)
        return (HUGE);
    if (arg == 0)
        return -1e99;
    return (log10(arg));
}
```

Diff-doc anchor: `parser.md:9694–9713`.

Both clamps are **unconditional** (no compat gate). `HUGE` is the C library
`HUGE_VAL` = `+Infinity` (IEEE-754 `Number.POSITIVE_INFINITY` in TS). The
`arg == 0 → -1e99` value is the literal `-1e99`.

**digiTS target:** the shared clamped `BUILTIN_FUNCTIONS` map, the `log` and
`log10` entries (currently bare `log: Math.log` / `log10: Math.log10` in both
runtime maps — `expression-evaluate.ts:56`/`:57` and `expression.ts:117`/`:118`).
Each clamped entry must become:

- `arg < 0` → return `Number.POSITIVE_INFINITY` (= C `HUGE`);
- `arg === 0` → return `-1e99`;
- otherwise `Math.log(arg)` / `Math.log10(arg)`.

The order matters: test `< 0` first, then `=== 0`, then the library call —
matching the C control flow line-for-line so the `-0.0` and boundary behavior is
identical. As with `exp`, the clamped `log`/`log10` are the single implementation
both runtime paths see.

> Adjacent note (informational, NOT in this delta's scope): `PTsqrt`
> (`ptfuncs.c:318–324`) also returns `HUGE` for `arg < 0`, and `PTdiv`
> (`ptfuncs.c:62–63`) returns `HUGE` on divide-by-zero. They are listed here
> only so the implementer recognizes the pattern; this recon ports **only** the
> `exp` / `log` / `log10` deltas named above. If the verifier finds digiTS's
> `sqrt` / `/` are reachable from B-source expressions and diverge, that is a
> separate item — do not silently fold it in without a ruling.

### Delta 3 — `PTdifferentiate` PTF_TAN derivative correction (`1/cos² → 1 + tan²`)

**ngspice** `ref/ngspice/src/spicelib/parser/inpptree.c:508–513`:

```c
case PTF_TAN:                /* 1 + (tan(u) ^ 2) */
    arg1 = mkb(PT_PLUS, mkcon(1.0), mkb(PT_POWER,
                                                 mkf(PTF_TAN,
                                                     p->left),
                                                 mkcon(2.0)));
    break;
```

Diff-doc anchor: `parser.md:8915–8923` (the `-` lines show the prior
`1 / (cos(u)^2)` form being replaced by the `+` `1 + (tan(u)^2)` form).

This is the inner `f'(g)` factor for `d/dx tan(g)`; the chain-rule `* g'`
multiply is applied by the surrounding differentiator in both engines.

**digiTS current form** (`expression-differentiate.ts:157–159`), confirmed by
hand:

```ts
case "tan":
  // d/dx(tan(g)) = 1/cos²(g) * g'
  fPrimeG = div(one(), pow(callNode("cos", [g]), two()));
  break;
```

This is the **pre-correction** `1/cos²(g)` form. It must be rebuilt to the v41
`1 + tan²(g)` form, i.e. `add(one(), pow(callNode("tan", [g]), two()))`, and the
inline comment updated to cite `inpptree.c:508–513` and describe the present-tense
mechanism (`d/dx tan(g) = (1 + tan²(g)) · g'`).

`1/cos²(θ)` and `1 + tan²(θ)` are algebraically identical, but they are
**different floating-point evaluations**; per the project's structural-match rule
(match ngspice's WHERE/HOW, not merely the algebraic result) the digiTS derivative
must build the same `1 + tan²` expression ngspice builds, so the evaluated
derivative is bit-identical.

`tan` is present in digiTS's `BUILTIN_FUNCTIONS`
(`expression.ts:111`, `expression-evaluate.ts:50`), so the rebuilt derivative is
fully evaluable — no new function is required.

### Delta 4 — `PTdifferentiate` PTF_TANH derivative correction (`1/cosh² → 1 − tanh²`)

**ngspice** `inpptree.c:515–520`:

```c
case PTF_TANH:                /* 1 - (tanh(u) ^ 2) */
    arg1 = mkb(PT_MINUS, mkcon(1.0), mkb(PT_POWER,
                                                 mkf(PTF_TANH,
                                                     p->left),
                                                 mkcon(2.0)));
    break;
```

Diff-doc anchor: `parser.md:8925–8933`.

**digiTS state and ruling:** digiTS's expression engine currently has **no
`tanh` / `sinh` / `cosh` function** (`expression.ts:108–127`,
`expression-evaluate.ts:47–66`) and no `tanh` case in
`expression-differentiate.ts`. The user has ruled the hyperbolic functions
**IN** (function-set expansion — Delta 6 below), so the PTF_TANH derivative now
has a counterpart to build.

**Build:** add a `tanh` case to `expression-differentiate.ts`'s single-argument
dispatch (alongside the existing `tan` case) whose inner `f'(g)` factor is
`1 − tanh²(g)`, i.e. `sub(one(), pow(callNode("tanh", [g]), two()))`, matching
`inpptree.c:515–520`. The chain-rule `* g'` multiply is applied by the
surrounding `mul(fPrimeG, dg)` (`expression-differentiate.ts:204`), exactly as
for `tan`. As with Delta 3, `1 − tanh²(θ)` (not `1/cosh²(θ)`) must be the built
expression so the evaluated derivative is bit-identical to ngspice's — match the
WHERE/HOW, not merely the algebraic result. The comment cites `inpptree.c:515–520`
in present tense, no era tag.

This delta depends on Delta 6 (the `tanh` function must be parseable and
evaluable before its derivative can be exercised).

### Delta 6 — hyperbolic function-set expansion (`sinh` / `cosh` / `tanh`)

**ngspice** registers `sinh` / `cosh` / `tanh` in the B-source function table
(`funcs[]`, `inpptree.c:144,151,154` — `cosh` at 144, `sinh` at 151, `tanh` at
154) dispatching to `PTcosh` / `PTsinh` / `PTtanh`
(`ptfuncs.c:263–267,312–316,332–336`), each a bare `cosh` / `sinh` / `tanh`
library call (no range clamp). The user has ruled these **IN**.

**digiTS targets (function-set is three-surface — parser + evaluator +
differentiator must agree):**

- **Shared clamped `BUILTIN_FUNCTIONS`** (per the single-clamped-map invariant):
  add `sinh: Math.sinh`, `cosh: Math.cosh`, `tanh: Math.tanh` to the single
  exported map. Because that one map is the source of truth for **both**
  `evaluateExpression` (`expression.ts`) and `evaluate`/`compileExpression`
  (`expression-evaluate.ts`), all three runtime lookup paths pick the new
  functions up from one place — there is no second literal to keep in sync.
- The parser (`expression.ts` `_parsePrimary`, line 357) already builds a
  `call` node for **any** identifier followed by `(...)` — it does not consult
  `BUILTIN_FUNCTIONS` at parse time. The function-name gate is at **evaluate**
  time: `evaluateExpression` (`expression.ts:441–443`) and
  `evaluate`/`compileExpression` throw "Unknown function" when the name is absent
  from the map. So `sinh(...)` / `cosh(...)` / `tanh(...)` already parse today and
  currently throw only at evaluation; adding the three entries to the shared map
  makes them **evaluable** (and, with the differentiate cases below,
  differentiable). No separate parser accept-list exists or is added.
- `expression-differentiate.ts`: add `sinh` (derivative `cosh(g)`) and `cosh`
  (derivative `sinh(g)`) single-arg cases, plus the `tanh` case from Delta 4
  (`1 − tanh²(g)`). ngspice has no `PTdifferentiate` case for `sinh`/`cosh`
  beyond the standard library-pair derivatives; build them as the textbook
  `d/dx sinh = cosh`, `d/dx cosh = sinh` (no sign flip — hyperbolic, not
  circular).

`Math.sinh` / `Math.cosh` / `Math.tanh` are ES2015 standard and match the C
library `sinh` / `cosh` / `tanh` bit-for-bit on the project's ucrt-libm-shimmed
runtime (per the project's transcendental-parity note). No clamp is applied
(ngspice's `PTsinh`/`PTcosh`/`PTtanh` apply none).

### Delta 5 — atto suffix `'a'/'A' → 1e-18` (already ruled APPLIED upstream; verify on this branch)

**ngspice** `inpeval.c` h005: the metric suffix `'a'`/`'A'` maps to `1e-18`
(atto). Diff-doc: parser/inpeval section.

**Recorded state (per the escalation):** APPLIED via commit `ca384593` as
`SPICE_SUFFIXES` entry `["A", 1e-18]` at `model-parser.ts:96`.

**Discrepancy this spec must flag for the implementer/verifier:** on the
**current `v41-port` branch working tree**, `model-parser.ts`'s `SPICE_SUFFIXES`
array (`model-parser.ts:85–95`) contains exactly nine entries
(`MEG, T, G, K, M, U, N, P, F`) and does **NOT** contain an `["A", 1e-18]`
entry. Commit `ca384593` lives on the `.wt/expr-engine` worktree and is **not
merged into this branch** (the escalation itself notes this:
`ESCALATIONS.md:1064` — "committed in an earlier pass and NOT staged this
pass"). So the atto suffix is recorded done but is **absent here**.

**Disposition:** treat Delta 5 as **PORT-via-this-recon, trivial** — when this
recon is implemented on a branch where `ca384593` is not present, add `["A",
1e-18]` to `SPICE_SUFFIXES`. Placement: the parsed suffix is matched
**first-match-wins** by iterating the array in order and testing
`suffix === sfx || suffix.startsWith(sfx)` (`model-parser.ts:131–135`), against
the suffix extracted at `model-parser.ts:117–124`. `"A"` is safe to append after
`["F", 1e-15]`: none of the existing nine entries (`MEG, T, G, K, M, U, N, P, F`)
is a prefix of an atto suffix, so a leading-`A` suffix falls through to the new
entry; and `"A"` being a single character cannot, via `startsWith`, wrongly
swallow any existing metric suffix. If the implementer's
branch already carries `ca384593` (entry present), record Delta 5 as **already
APPLIED — no action**, do not duplicate the entry. This spec does not re-port a
present entry; it only records the requirement and the branch discrepancy so the
verifier checks the actual working tree rather than trusting the ledger note.

---

## Resolved decisions (was: USER-DECISION) — all closed 2026-06-03

Every item here is **resolved**; nothing remains open. Retained as a record of
the tradeoff and the ruling.

1. **`tanh` / `sinh` / `cosh` function-set expansion** — **RULED IN.** The
   hyperbolic functions are added to the engine's function set and both
   derivative corrections (PTF_TAN, PTF_TANH) are ported. Built per Delta 4 +
   Delta 6.

2. **RKM notation `INPevaluateRKM_R / _C / _L` (`inpeval.c#h006`, diff-doc
   4151–4876, ~725 lines, "4k7"-style)** — **RULED OUT → NO-COUNTERPART.** No
   digiTS caller exists; digiTS does not accept RKM input. Accepted divergence,
   zero code.

3. **`PTddt` transient derivative (`ptfuncs.c` PTddt, in hunk `ptfuncs.c#h007`,
   diff-doc 9716–9771)** — **RULED OUT for now → NO-COUNTERPART.** The `ddt()`
   B-source operator needs `CKTtime`/`MODETRAN` history + per-instance ddt state
   the AST evaluator does not carry. Tracked as a deferred asrc / B-source
   capability, not built in this recon.

4. **compatmode clamps (`newcompat.ps` / `.lt` / `.hs` — PSPICE / HSPICE /
   spice-2 branches), including the `PTexp` `newcompat.ps && arg > EXPARGMAX →
   EXPMAX*(arg−EXPARGMAX+1.)` linear arm, the `PTpower`/`PTpowerH`
   `newcompat.lt/.hs` branches, and the `PTpwr` PSPICE `PTfudge_factor` path** —
   **RULED OUT → NO-COUNTERPART.** digiTS has no `newcompat` selector and runs
   the native non-compat numeric path only. Accepted divergence.

---

## Acceptance criteria

1. The shared clamped `BUILTIN_FUNCTIONS` `exp` entry returns `1e99` when
   `arg > 227.9559242` (literal operands, character-matching
   `ptfuncs.c:277–278`) and `Math.exp(arg)` otherwise. The `newcompat.ps`
   EXPARGMAX linear branch is **absent** (it is USER-DECISION #3).
2. The shared clamped `BUILTIN_FUNCTIONS` `log` and `log10` entries each
   return `Number.POSITIVE_INFINITY` for `arg < 0`, `-1e99` for `arg === 0`, and
   the library value otherwise — in that test order, matching `ptfuncs.c:286–304`
   line-for-line.
3. **Single-clamped-map invariant (BLOCKING).** There is exactly **one**
   exported, clamped `BUILTIN_FUNCTIONS` map, and it is the source of truth for
   every runtime function lookup. The verifier confirms:
   (i) `expression.ts`'s `evaluateExpression` (`expression.ts:439–446`) and
   `expression-evaluate.ts`'s `evaluate` (`:112–120`) and `compileExpression`
   (`:193–201`) all resolve `exp`/`log`/`log10`/`sinh`/`cosh`/`tanh` from that
   one map — the per-file literals at `expression.ts:108–127` and
   `expression-evaluate.ts:47–66` are deleted, not edited-in-parallel;
   (ii) **no** un-clamped `Math.exp`/`Math.log`/`Math.log10` call site for these
   three functions survives in either runtime evaluator — in particular the
   source load path through `evaluateExpression`
   (`ac-voltage-source.ts:1285`, `ac-current-source.ts:576`) sees the clamped
   `exp` so a B-source `exp(300)` returns `1e99`, not `Infinity`;
   (iii) the `simplify()` constant-fold table (`mathFns` at
   `expression-differentiate.ts:336–342`) is **deleted** and `simplify` folds
   through the same shared clamped map, so a constant `exp(300)` folds to `1e99`
   (matching runtime), not `Infinity`. The shared map covers every function the
   old `mathFns` listed (`sin cos tan asin acos atan exp log log10 sqrt abs
   floor ceil round`) plus the new hyperbolics, so deletion loses no
   constant-fold coverage; the implementer confirms this coverage before
   deleting. The new import edge is acyclic (per the STANCE invariant: define or
   re-export the shared map from `expression.ts` or a small dedicated module the
   three files import).
4. `expression-differentiate.ts` `tan` case (currently lines 157–159) builds the
   derivative `1 + tan²(g)` (`add(one(), pow(callNode("tan", [g]), two()))`),
   matching `inpptree.c:508–513`; the prior `1/cos²(g)` form is gone. The chain
   rule `* g'` continues to be applied by the surrounding `mul(fPrimeG, dg)`
   (`expression-differentiate.ts:204`). The comment cites `inpptree.c:508–513`
   in present tense with no era tag.
5. The hyperbolic functions `sinh` / `cosh` / `tanh` are added to the **shared
   clamped `BUILTIN_FUNCTIONS`** (`Math.sinh`/`Math.cosh`/`Math.tanh`), so both
   runtime evaluators resolve and evaluate them from one map (no second literal);
   they already parse (the parser builds a `call` node for any `ident(...)`), so
   the map addition is what makes them evaluate instead of throwing "Unknown
   function". `expression-differentiate.ts` gains `tanh` (`1 − tanh²(g)`,
   matching `inpptree.c:515–520`), `sinh` (`cosh(g)`), and `cosh` (`sinh(g)`)
   single-arg cases. No clamp is applied to any of the three (ngspice
   `PTcosh`/`PTsinh`/`PTtanh` apply none).
6. `model-parser.ts` `SPICE_SUFFIXES` contains exactly one `["A", 1e-18]` entry
   (atto), added if and only if not already present on the building branch (no
   duplicate). The verifier checks the **actual working tree**, not the ledger
   note.
7. No file outside `expression-evaluate.ts`, `expression-differentiate.ts`,
   `expression.ts`, and `model-parser.ts` is touched. No parse-tree / yacc
   machinery, no `controlled_exit`, no compat-mode flag, no `ddt`, no RKM are
   introduced. (`expression.ts` is touched to host or import the shared clamped
   `BUILTIN_FUNCTIONS` — clamps + hyperbolics — and to delete its now-redundant
   local literal; it is **not** touched to build any tree-node machinery. The
   ASRC source files `ac-voltage-source.ts` / `ac-current-source.ts` are **not**
   edited — they already call `evaluateExpression`, which now resolves through
   the shared clamped map by virtue of the dedupe, so the load path is clamped
   without changing the call sites.)
8. The numerical behavior is verified with targeted unit tests on the expression
   subsystem (per the project test policy for engine-numerical changes — targeted
   tests, not the full suite): `exp(228) === 1e99`, `exp(227) === Math.exp(227)`;
   `log(-1) === Infinity`, `log(0) === -1e99`, `log10(0) === -1e99`,
   `log10(-1) === Infinity`; the symbolic derivative of `tan(x)` evaluates
   bit-identically to `1 + tan(x)²`, and of `tanh(x)` to `1 − tanh(x)²`, at
   representative `x`; `sinh`/`cosh`/`tanh` parse, evaluate (`=== Math.sinh` etc.),
   and differentiate (`d sinh = cosh`, `d cosh = sinh`); `parseSpiceValue("1a")
   === 1e-18`. Additionally, the clamp must be asserted on **both** runtime
   paths, not just one: `evaluateExpression(parseExpression("exp(300)"), {})
   === 1e99` (the `expression.ts` path the ASRC sources use) AND
   `evaluate(parseExpression("exp(300)"), ctx) === 1e99` (the
   `expression-evaluate.ts` path) — both must return `1e99`, proving the single
   shared map is wired into both evaluators. These assert the ngspice numeric
   contract directly (no harness is required — these functions are not on the
   matrix/RHS path and have no ngspice per-iteration signal to diff; the contract
   is the scalar return value).

---

## Affected ledger hunk-ID classification

Every PENDING ledger hunk (`spec/v41-port/ledger.json`) in the four parser files
routes into exactly one of two buckets — PORT or NO-COUNTERPART. With the user
rulings applied there is no remaining open USER-DECISION bucket. The
authoritative per-hunk routing JSON the ledger refile consumes accompanies this
spec in the agent report. Total PENDING parser hunks in these four files: **48**
(inpptree 33 + inpeval 6 + ptfuncs 7 + ifeval 2) — PORT 4, NO-COUNTERPART 44.

### PORT-via-this-recon (the numerical deltas) — 4 hunks

| Hunk ID | ngspice anchor | digiTS target | what ports |
|---|---|---|---|
| `parser/ptfuncs.c#h005` | `PTexp` unconditional `>227.9559242 → 1e99` (`ptfuncs.c:277–278`, diff-doc 9679–9692) **and** `PTlog` `==0 → -1e99` (diff-doc 9694–9704) | `expression-evaluate.ts` `BUILTIN_FUNCTIONS.exp` + `.log` | Delta 1 + Delta 2 (the `newcompat.ps` exp arm inside this hunk is the OUT sub-part, not built) |
| `parser/ptfuncs.c#h006` | `PTlog10` `==0 → -1e99` (diff-doc 9707–9713) | `expression-evaluate.ts` `BUILTIN_FUNCTIONS.log10` | Delta 2 |
| `parser/inpptree.c#h010` | `PTdifferentiate` PTF_TAN `1/cos² → 1+tan²` **and** PTF_TANH `1/cosh² → 1−tanh²` (`inpptree.c:508–520`, diff-doc 8911–8933) | `expression-differentiate.ts` `tan`/`tanh`/`sinh`/`cosh` cases + hyperbolic add to the shared clamped `BUILTIN_FUNCTIONS` | Delta 3 + Delta 4 + Delta 6 |
| `parser/inpeval.c#h005` | `'a'/'A' → 1e-18` atto suffix | `model-parser.ts` `SPICE_SUFFIXES` | Delta 5 (verify present on branch; add if absent) |

> `parser/ptfuncs.c#h005` straddles `PTexp` and `PTlog`; both clamps are the
> portable content, so the hunk routes PORT. The `newcompat.ps`/EXPARGMAX exp arm
> physically inside this hunk is NOT built (compatmode RULED OUT, criterion 1) —
> when the hunk applies, that arm is the documented omission, not a gap.

### NO-COUNTERPART (yacc parse-tree, compatmode, RKM, PTddt, error/debug) — 44 hunks

| Hunk ID(s) | ngspice construct | why no counterpart |
|---|---|---|
| `parser/inpptree.c#h001–h009`, `#h011–h033` (all inpptree except `#h010`) | `ops[]`/`funcs[]` tables, PT_POWER `PTpower→PTpowerH` ptr swap, the PTF_EXP/PTF_POW/PTF_PWR `newcompat`/EXPARGMAX derivative rewrites, `mkb`/`mkcon`/`mkf`, `PT_mk*node` (static→exported), `PTcheck` (+`char* tline`), `prepare_PTF_*`, `PTlex` (B-source param skip), `mkfnode`/`mkinode`/`mknnode`, `free_tree`/`INPfreeTree`/`printTree` DDT-free + null-guard | digiTS parses directly to typed `ExprNode`; no node pool, no func-ptr tables, no manual free. Architectural per STANCE. (PTF_EXP `newcompat` derivative is compatmode, also RULED OUT.) |
| `parser/inpeval.c#h001–h004` | `isdigit → isdigit_c` C-locale predicate | digiTS uses regex `\d` in `parseSpiceValue` (`model-parser.ts:117`); allowed C↔TS difference, no behavioral delta. |
| `parser/inpeval.c#h006` | `INPevaluateRKM_R/_C/_L` (~725 lines, "4k7" notation) | RKM RULED OUT; no digiTS caller, accepted divergence. |
| `parser/ptfuncs.c#h001` | author/copyright header line | non-numerical header cosmetic; no behavioral delta. |
| `parser/ptfuncs.c#h002` | file-header comment block + include tweak | comment/include scaffolding; no behavioral delta. |
| `parser/ptfuncs.c#h003` | `PTfudge_factor` global decl context | PSPICE-compat fudge-factor scaffolding (compatmode); RULED OUT. |
| `parser/ptfuncs.c#h004` | `PTdivide`→`PTpower`/`PTpowerH`/`PTpwr` `newcompat.lt/.hs` + `PTfudge_factor` block (diff-doc 9599–9674) | compatmode power/pwr branches RULED OUT; digiTS uses native `Math.pow`. |
| `parser/ptfuncs.c#h007` | `PTnint` tail → adds `PTddt` transient derivative (diff-doc 9716–9771) | `PTddt` RULED OUT for now; needs CKTtime/MODETRAN history infra digiTS lacks. |
| `parser/ifeval.c#h001` | `IFeval` null-tree guard `fprintf + controlled_exit(EXIT_BAD)` (diff-doc 132–135) | digiTS uses structured `throw`; no process-exit surface. Error-machinery, accepted divergence per STANCE. |
| `parser/ifeval.c#h002` | `PTeval` leading-`\n` in stderr range-error format (diff-doc 144–145) | debug-output cosmetic; digiTS has no `fprintf`/stderr formatting. Accepted divergence per STANCE. |

---

## Recommended recon ID

`expr-engine#recon/numericalDeltas`

Once this recon is `APPLIED`: the 4 PORT-via-this-recon hunks
(`ptfuncs.c#h005`, `ptfuncs.c#h006`, `inpptree.c#h010`, `inpeval.c#h005`) are
satisfied; the 44 NO-COUNTERPART hunks resolve as accepted divergence (verifier
records, does not block). With all user rulings applied there is no remaining
open decision and no blocked-pending bucket. `build-ledger.mjs` re-runs with the
4 hunks `blockedBy` this recon ID and the 44 marked NO-COUNTERPART.

Status: RATIFIED 2026-06-03 (user) — all open decisions resolved; ready for the
implementer.
