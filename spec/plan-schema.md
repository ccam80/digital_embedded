# State-Pool Schema — Execution Plan

## Spec
`spec/state-pool-schema.md`

## Wave Dependency Graph
```
Wave A (Infrastructure) → Wave B (Clean elements) → Wave C (Bug-fix migrations)
                                                   → Wave D (MOSFET finalisation)
Wave C + Wave D → Wave E (Schema retrofit)
```

## Waves and Tasks

### Wave A: Infrastructure (non-breaking)
Spec: `spec/state-pool-schema.md` §1.2, §1.3, §1.6, §5.1 items 1-5

#### Wave A.1
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| WA1 | Create state-schema.ts (§1.2 types + helpers + §1.6 fragments) | M | `src/solver/analog/state-schema.ts` (new) |
| WA2 | Amend element.ts + add ReactiveAnalogElement to analog-types.ts | S | `src/solver/analog/element.ts`, `src/core/analog-types.ts` |
| WA3 | Wire dev-probe in MNAEngine (first-step _devProbeRan flag) | M | `src/solver/analog/analog-engine.ts` |
| WA4 | Delete redundant initState call at analog-engine.ts:186, promote elements to this._elements | S | `src/solver/analog/analog-engine.ts` |
| WA5 | Fix reset() re-init gap — call initState after statePool.reset() | S | `src/solver/analog/analog-engine.ts` |

Note: WA3, WA4, WA5 all touch analog-engine.ts — must be done by SAME implementer or sequenced.

### Wave B: Convert clean elements
Spec: `spec/state-pool-schema.md` §1.4, §5.1 items 5-6

#### Wave B.1
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| WB1 | capacitor.ts — adopt schema (§1.4 worked example) | M | `src/components/passives/capacitor.ts` |
| WB2 | inductor.ts — adopt schema | M | `src/components/passives/inductor.ts` |

### Wave C: Bug-fix migrations (add pool infrastructure from scratch)
Spec: `spec/state-pool-schema.md` §4.1, §4.2, §5.1 items 7-13

#### Wave C.1 (parallel safe — independent files)
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| WC1 | polarized-cap.ts — 3 slots from scratch (§4.1) | M | `src/components/passives/polarized-cap.ts` |
| WC2 | diode.ts — add SLOT_CAP_FIRST_CALL, stateSize 4→8 (Amendment E2) | M | `src/components/semiconductors/diode.ts` |
| WC3 | crystal.ts — 9 slots via suffixed fragments | M | `src/components/passives/crystal.ts` |
| WC4 | transmission-line.ts — add pool infra to 3 sub-element classes | L | `src/components/passives/transmission-line.ts` |

#### Wave C.2 (sequential — transformer depends on coupled-inductor cleanup)
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| WC5 | transformer.ts — 13 slots, inline BDF-2, delete CoupledInductorState | L | `src/components/passives/transformer.ts`, `src/solver/analog/coupled-inductor.ts` |
| WC6 | tapped-transformer.ts — 12 slots | M | `src/components/passives/tapped-transformer.ts` |
| WC7 | njfet.ts/pjfet.ts — 3-slot JFET extension schema | M | `src/components/semiconductors/njfet.ts`, `src/components/semiconductors/pjfet.ts` |

### Wave D: MOSFET finalisation
Spec: `spec/state-pool-schema.md` §5.3

#### Wave D.1
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| WD1 | fet-base.ts — defineStateSchema, export SLOT constants, delete static mirrors | M | `src/solver/analog/fet-base.ts` |
| WD2 | mosfet.ts — rewrite AbstractFetElement.SLOT_* to imported constants | M | `src/components/semiconductors/mosfet.ts` |

### Wave E: Schema retrofit on remaining pool-compliant elements
Spec: `spec/state-pool-schema.md` §5.1 items 15-21

#### Wave E.1 (parallel safe — independent files)
| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| WE1 | bjt.ts simple — 10-slot schema + warm-start VBE seed (Amendment M) | M | `src/components/semiconductors/bjt.ts` (simple factory) |
| WE2 | bjt.ts L1 — 24-slot schema + warm-start VBE seed (Amendment M) | M | `src/components/semiconductors/bjt.ts` (L1 factory) |
| WE3 | zener.ts — add stateSchema declaration | S | `src/components/semiconductors/zener.ts` |
| WE4 | tunnel-diode.ts — add stateSchema declaration | S | `src/components/semiconductors/tunnel-diode.ts` |
| WE5 | varactor.ts — add stateSchema declaration | S | `src/components/semiconductors/varactor.ts` |
| WE6 | scr.ts — add stateSchema declaration | S | `src/components/semiconductors/scr.ts` |
| WE7 | triac.ts — add stateSchema declaration | S | `src/components/semiconductors/triac.ts` |
| WE8 | led.ts — add stateSchema declaration | S | `src/components/io/led.ts` |
| WE9 | test-helpers.ts — add stateSchema declaration | S | `src/solver/analog/__tests__/test-helpers.ts` |

## Test Command
```bash
npm run test:q
```

## Acceptance Criteria
- Every reactive element declares a `StateSchema` via `defineStateSchema`
- Zero `private _xxx: number = 0` mutable state fields on pool-backed elements (outside pool)
- Dev probe (`assertPoolIsSoleMutableState`) fires on first step in DEV mode
- All existing tests pass
- `reset()` correctly re-inits non-zero pool slots
