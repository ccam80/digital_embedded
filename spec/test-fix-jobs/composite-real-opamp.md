# composite-real-opamp

## Site

- File: `src/components/active/real-opamp.ts`
- Factory: `createRealOpAmpElement` (lines 331-640)
- No class — the factory returns an inline object literal implementing
  `AnalogElement`.

## Recommendation: do NOT make real-opamp a `CompositeElement`

Reasoning:

1. **There are no first-class sub-elements.** The factory does not
   instantiate any other registered analog elements. It allocates 7 MNA
   handles directly (`hInpInp`, `hInnInn`, `hInpInn`, `hInnInp`,
   `hOutOut`, `hOutInp`, `hOutInn` — `real-opamp.ts:411-417`) and stamps
   them itself. There is no diode child, no BJT child, no VSRC child to
   register.

2. **The internal "gain stage" is closure state, not a sub-device.**
   `vInt`, `vIntPrev`, `geq_int`, `aEff`, `outputSaturated`, `slewLimited`,
   etc. (`real-opamp.ts:371-403`) are scalar closure variables updated
   inside `load()` per NR iteration. Modeling them as a "VCVS sub-element
   with companion-integrator state" is technically possible but
   architecturally mismatched: the rail-clamp / current-limit / slew-limit
   logic is a single coupled NR limiter, not three independent
   sub-elements.

3. **The §K1 work (full pool-backing + `railLim` voltage-limited NR) is
   per-element NR-limiter discipline, not composite shape.** Per the
   existing test-fix-jobs notes (§K1, lines 70-104), real-opamp is being
   migrated to:

   - `poolBacked: true`, `stateSize`, `stateSchema`
   - Allocate state slots in `setup()` (instead of closure variables)
   - Migrate `vInt`, `vIntPrev`, `_vOutPrev` to pool slots
   - Add `SLOT_VINT_PREV` and call `railLim` in `load()`

   That is a leaf-element refactor (closure state → pool slots) and is
   independent of `CompositeElement`.

4. **`CompositeElement` is for elements with first-class sub-element
   children that the engine should walk via `getSubElements()`.** Real-
   opamp has none of those. Forcing it through the composite shape would
   require fabricating an empty `getSubElements()` return value, which
   only adds layering without payoff.

## Action

Real-opamp stays a leaf `PoolBackedAnalogElement` (after §K1 lands).
It does NOT extend `CompositeElement`. The composite-base refactor
explicitly skips this site.

The cleanup that DOES apply across composites — eliminating per-component
`make*Props` helpers via `PropertyBag.forModel` — also doesn't apply here
because real-opamp uses the parent `props` directly (no sub-element prop
bags exist).

## Sub-elements

None.

## Internal nodes

None allocated by `setup()`. The MNA handles are between external pin
nodes (`nInp`, `nInn`, `nOut`).

## Setup-order

`NGSPICE_LOAD_ORDER.VCVS = 47` (`real-opamp.ts:421`).

## Load delegation

N/A — leaf element, single `load()` body.

## Specific quirks

- The closure state migration (§K1) is the relevant work; it is captured
  in the existing spec at `spec/test-fix-jobs.md` §K1 and is unaffected
  by the composite-base refactor.
- The `railLim` helper documented in §K1 is not an ngspice port (no
  ngspice analog exists for behavioral-amp rail clamps); the algorithmic
  pattern is canonical NR-limiter discipline (`devsup.c:50-84`
  `DEVpnjlim` and `devsup.c:20-40` `DEVlimvds` for references) but the
  rail-clamp shape is digiTS-specific. This is flagged for user review
  and is out of scope for the composite-base refactor.

## Migration shape

No migration. This site is left as-is by the composite-base rollout.
After §K1 lands separately, real-opamp will be a `PoolBackedAnalogElement`
class with state slots — not a `CompositeElement`.

## Resolves

None directly. The 10 real-opamp test failures listed in §K1 are resolved
by the §K1 pool-backing work, not by this refactor.

## Category

`architecture-fix` (for §K1, unrelated to composite-base)

## Out of scope (escalations)

- **User decision needed**: confirm real-opamp stays a leaf element. The
  user's directive is to "create a base element that handles all of the
  setup, load, etc of subelements", which is well-aligned with leaving
  real-opamp out of the composite scope. If the user wants real-opamp
  modeled as `CompositeElement` with synthetic VCVS / capacitor children
  (a much bigger restructuring that would mirror an `.MODEL`-based opamp
  macromodel), flag here.
