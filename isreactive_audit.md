# `isReactive`/`isNonlinear`/`mayCreateInternalNodes`/etc. — Per-File Edit Audit

Concrete line-level inventory of every file touched by the dead-field cleanup, organized into chunks for haiku execution. Compiled from grep evidence on 2026-04-28.

**Scope confirmed by grep (src/ only):**
- `isReactive` — 268 occurrences across ~100 files
- `isNonlinear` — 260 occurrences across ~95 files
- `mayCreateInternalNodes` — ~50 occurrences in src/ (production + 2 tests)
- `poolBacked` (the literal flag, not the type discriminator) — ~50 occurrences in src/
- `ReactiveAnalogElement` / `ReactiveAnalogElementCore` — ~120 occurrences across ~30 files
- `modelCardPrefix` — 2 production + harness consumers
- `nonlinearElements` / `reactiveElements` / `elementsWithLte` / `elementsWithAcceptStep` — declared in `ckt-context.ts:367–375`, asserted in `ckt-context.test.ts`
- `internalNodeLabels` / `getInternalNodeLabels` — 5 production + 1 harness consumer
- `allNodeIds` — confirmed live (used by harness/capture.ts:118 only) — flagged as borderline; not included in this batch unless §6c-C decision says drop
- `refreshSubElementRefs` — **already gone**; not present in `element.ts`. Inventory line numbers were stale; no action.

Each row below = one file = one batch (or sub-batch). For each, line numbers are the exact strings to delete or rewrite.

---

## Scope decisions (locked-in)

1. **`ReactiveAnalogElement` type — DELETE entirely.** No alias retained. ~30 files (mostly tests + 7 production) need their imports/casts rewritten to `PoolBackedAnalogElement` / `PoolBackedAnalogElementCore`. Covered inline in each phase.
2. **`allNodeIds` / `internalNodeLabels` / `getInternalNodeLabels` — DROP all three.** Test-harness-only metadata; no production engine reads them. Edit list expanded into Phase 1.5 + per-file rows below.
3. **`getInternalNodeCount` — DROP** (added during verification). VERIFIED dead: zero `.getInternalNodeCount(` callers in production; only consumer is `transmission-line.test.ts:717,726–728` (a tautology test). Removal: `registry.ts:97–105` decl + JSDoc; `compiler.ts:358–360` inline composite impl; `compiler.ts:11` stale comment; the dead-test assertions inside the `it("requires branch row")` block in `transmission-line.test.ts`.
4. **`ModelEmissionSpec` / `modelCardPrefix` — DEFERRED out of this batch.** Pending review against a separate spice-model fixing spec. The two `modelCardPrefix` references (`registry.ts:84`, `harness/netlist-generator.ts:263`) and the wrapper interface stay untouched here.
5. **Composite recursion — `CompositeElement` abstract base class.** Phase 2.5b creates `src/solver/analog/composite-element.ts` with full forwarding (`load`, `setup`, `getLteTimestep`, `checkConvergence`, `acceptStep`, `nextBreakpoint`, `initState`, `stateSize`) over `getSubElements()`. Phase 2.5c refactors ~16 composite classes to `extends CompositeElement`, collapsing all the per-class boilerplate into the base. Replaces what would have been per-class `isReactive`/`isNonlinear`/`poolBacked`/`stateSize`/`stateBaseOffset`/`initState`/(missing-method) hand-coded forwarding. Fixes the pre-existing latent bug where composites with reactive children silently miss LTE.
6. **Test-file edits permitted.** The W3 "no test edits" rule is being lifted in a parallel session. Phases 10–12 may proceed.

---

## Phase 1 — Type/interface definitions (4 files, do FIRST, blocks tsc)

| # | File | Edits |
|---|------|-------|
| 1.1 | `src/solver/analog/element.ts` | DELETE: 142 + JSDoc 133–141 (`allNodeIds`), 149 + JSDoc 144–148 (`internalNodeLabels?`), 174 (`isNonlinear`), 182 (`isReactive`), 233 (`poolBacked: true`), 248–250 (`ReactiveAnalogElementCore` interface), 261 (`ReactiveAnalogElement` type alias). REWRITE: 263–267 (`isPoolBacked` overloads & impl) → method-presence check `typeof (el as any).initState === "function"`. |
| 1.2 | `src/core/analog-types.ts` | DELETE: 157, 160 (JSDoc references to `allNodeIds`), 298 (`isNonlinear`), 306 (`isReactive`). Verify no `allNodeIds` field decl in the duplicate type. |
| 1.3 | `src/core/registry.ts` | DELETE: 97–98 + JSDoc 99–105 (`getInternalNodeCount?:` — verified dead, see below), 106 (`getInternalNodeLabels?:` + JSDoc continuation), 109–112 (`mayCreateInternalNodes?:` + JSDoc). **DO NOT TOUCH** lines 76–85 (`ModelEmissionSpec`) or 108, 123 (`spice?:`) — deferred batch. |
| 1.4 | `src/compile/types.ts` | DELETE: 142–146 (`mayCreateInternalNodes?` + JSDoc). |
| 1.5 | **§6c-C component sweep — `allNodeIds` deletion across components** | See Phase 4–7 rows: every `readonly allNodeIds: ...` decl + matching `this.allNodeIds = ...` constructor assignment must come out. Files: bridge-adapter (54, 79, 176, 196), transmission-line (236, 255, 296, 312, 356, 382, 497, 518, 615, 642, 758, 796), transformer (228, 284), tapped-transformer (220, 250), crystal (248, 306), polarized-cap (262, 619), potentiometer (172, 192), analog-fuse (91, 277), controlled-source-base (90), behavioral-sequential (80, 281, 553), behavioral-flipflop (96), behavioral-flipflop/{jk,rs,t}.ts (60, 65, 60). Behavioral-remaining: lines 424, 434, 444 use `allNodeIds` as a local variable inside a function — keep the local, just rename if needed (it's not the field). Compiler write at `compiler.ts:1216` deleted in Phase 2.4. |

---

## Phase 2 — Engine consumers (7 files; behavior-changing rewrites)

| # | File | Edits |
|---|------|-------|
| 2.1 | `src/solver/analog/timestep.ts` | DELETE the `if (!el.isReactive) continue;` lines: **398, 679**. The subsequent `typeof el.getLteTimestep === "function"` check stays. |
| 2.2 | `src/solver/analog/newton-raphson.ts` | DELETE line 614 (`if (!el.isNonlinear) continue;`). Loop now iterates all elements. |
| 2.3 | `src/solver/analog/ckt-context.ts` | DELETE field declarations: **366 (JSDoc) + 367 (`nonlinearElements`), 368 (JSDoc) + 369 (`reactiveElements`), 372 (JSDoc) + 373 (`elementsWithLte`), 374 (JSDoc) + 375 (`elementsWithAcceptStep`)**. DELETE filter assignments: **611, 612, 614, 615**. Keep `_poolBackedElements` (356, 616, 792) and `elementsWithConvergence`. |
| 2.4 | `src/solver/analog/compiler.ts` | DELETE: 11 (stale comment "Allocate internal nodes via getInternalNodeCount"), 313–314 (`anyNonlinear` / `anyReactive` aggregation), 326–327 (composite core literal entries `isNonlinear`/`isReactive`). REWRITE 1250: `element.isReactive ? "inductor" : "voltage"` → `typeof element.getLteTimestep === "function" ? "inductor" : "voltage"`. DELETE 358–360 (`getInternalNodeCount` inline composite — VERIFIED DEAD: zero `.getInternalNodeCount(` callers in production; only consumer is `transmission-line.test.ts:717,726–728` tautology), 362–366 (`getInternalNodeLabels` inline composite), 1216 (`allNodeIds: [...pinNodeIds]` write). REWRITE the inline composite at 316–353: convert from object literal to a `class extends CompositeElement` (see Phase 2.5b) so it inherits the recursing forwarders. |
| 2.5 | `src/solver/analog/bridge-adapter.ts` | REFACTOR both classes to `extends CompositeElement` (Phase 2.5b). All field declarations and per-class forwarding logic move to the base class. Class-specific code that stays: `_pinModel`, `setLogicLevel`/`setHighZ`/`outputNodeId`/`rOut` (output adapter), `readLogicLevel` (input adapter), constructor wiring, `load()` body (which now calls `super.load()` for child stamping after primary pin-model stamps), `getPinCurrents` (application-specific), `setParam`. DELETE all of: field decls 54–62, 175–185; getter blocks 88–90, 205–207; JSDoc lines 43, 47, 168, 169; constructor assignments 79–80, 196–197 (`allNodeIds` / `internalNodeLabels`). |
| 2.5b | **NEW: `src/solver/analog/composite-element.ts` — abstract base** | Create new file. Defines `abstract class CompositeElement implements PoolBackedAnalogElementCore` with: (a) abstract `protected getSubElements(): readonly AnalogElement[]` — returns the union of every child the composite owns (pin models, child caps, sub-elements). (b) Concrete forwarding implementations of every engine-iterated method that uses `typeof === "function"` guards on each sub-element (so it works even when sub-elements aren't full `AnalogElement`s, e.g. `DigitalInputPinModel` which has only `load`/`setup`): `setup(ctx)` — forward; `load(ctx)` — forward (subclasses may override and call `super.load(ctx)` after class-specific logic); `getLteTimestep(...)` — `min` over children that implement it, `Infinity` if none; `checkConvergence(ctx)` — AND over children's; `acceptStep(t, addBp, atBp)` — forward to children that implement it; `nextBreakpoint(after)` — `min` of non-null child results; `initState(pool)` — walk pool-backed children, assign cumulative `stateBaseOffset`, recurse. (c) Concrete `get stateSize()` — sum of pool-backed children's `stateSize`. (d) Subclass-mandated abstract: `getPinCurrents(rhs)` (shape varies per gate type), `setParam(key, value)` (delegation pattern varies). (e) Subclass-required-to-supply field: `ngspiceLoadOrder`, `stateSchema`, `pinNodeIds` (compiler-stamped). |
| 2.5c | **NEW: refactor every composite to `extends CompositeElement`** | Targets (~16 classes): `BehavioralGateElement` (behavioral-gate.ts:70); 3 classes in behavioral-combinational.ts (70, ~237, ~380); 3 classes in behavioral-sequential.ts (62, 266, 532); `BehavioralDFlipflopElement` (behavioral-flipflop.ts:57) + 6 sibling classes in `behavioral-flipflop/{d-async,jk,jk-async,rs,rs-async,t}.ts`; 6 classes in behavioral-remaining.ts (88, 235, 387, 562, 645, 707); `BridgeOutputAdapter` and `BridgeInputAdapter` (bridge-adapter.ts:49, 171); the inline composite core in compiler.ts:316–353 (convert object literal to anonymous class extending the base). Each refactor: delete the duplicated `pinNodeIds`/`branchIndex`/`ngspiceLoadOrder`/`isNonlinear`/`isReactive`/`poolBacked`/`stateSize`/`stateBaseOffset`/`stateSchema`/`isReactive` getter/`initState` boilerplate; implement `getSubElements()` returning the union of pin models + `_childElements`; keep class-specific `load()` body but call `super.load(ctx)` (or omit and let the base class's default forward handle it) after the application-specific logic; keep class-specific `getPinCurrents` and `setParam`. **Verify before refactor:** `polarized-cap.ts:260` `AnalogPolarizedCapElement` — leaf reactive (no sub-elements) per current grep; SKIP unless it holds children. `transformer.ts:226`, `tapped-transformer.ts:218`, `crystal.ts:246` — leaf reactive, SKIP. Transmission-line sub-classes — leaf reactive segments, SKIP (the wrapper class at the top of the file is not in `AnalogElement` form). |
| 2.6 | `src/solver/analog/controlled-source-base.ts` | DELETE: 90 (`allNodeIds!:` field decl), 95 (`isNonlinear = true as const`), 96 (`isReactive = false as const`). |
| 2.7 | `scripts/mcp/harness-tools.ts` | DELETE pairs: 180–181, 321–322, 634–635 (`isNonlinear` / `isReactive` blob fields). Verify no harness-fixture JSON consumes these keys (`Grep "isReactive\|isNonlinear" **/*.json`). |

---

## Phase 3 — Behavioral solver elements (~12 files)

**Subsumed by Phase 2.5c (CompositeElement refactor).** Each class in this list becomes `extends CompositeElement`, and all per-line strips below disappear into the base class. Files included in the 2.5c refactor:

- `src/solver/analog/behavioral-gate.ts` — `BehavioralGateElement` (line 70)
- `src/solver/analog/behavioral-combinational.ts` — 3 classes at 70, ~237, ~380
- `src/solver/analog/behavioral-sequential.ts` — 3 classes at 62, 266, 532 (drop import line 10)
- `src/solver/analog/behavioral-flipflop.ts` — 1 class at 57 (drop import line 15)
- `src/solver/analog/behavioral-flipflop/d-async.ts`
- `src/solver/analog/behavioral-flipflop/jk.ts` (drop import line 5)
- `src/solver/analog/behavioral-flipflop/jk-async.ts`
- `src/solver/analog/behavioral-flipflop/rs.ts` (drop import line 5)
- `src/solver/analog/behavioral-flipflop/rs-async.ts`
- `src/solver/analog/behavioral-flipflop/t.ts` (drop import line 5)
- `src/solver/analog/behavioral-remaining.ts` — 6 classes at 88, 235, 387, 562, 645, 707

After Phase 2.5c each class loses (auto-delete via base inheritance): `pinNodeIds!` decl, `allNodeIds!` decl, `branchIndex`, `ngspiceLoadOrder`, `isNonlinear`, `isReactive` getter, `poolBacked`, `stateSchema`, `stateSize`, `stateBaseOffset`, `initState()`. Each class keeps: `_inputs`/`_dPin`/`_clockPin`/etc. private fields, `_childElements`, application-specific `load()` body, `getPinCurrents()`, `setParam()`, plus a new `protected getSubElements()` that returns `[...primaryPinModels, ...this._childElements]`.

Behavioral-remaining.ts:424, 434, 444 use `allNodeIds` as a local variable name inside a function — that's a local, not the field; leave it (or rename to `_pinNodeIds` for clarity).

---

## Phase 4 — Passive components (12 files)

| # | File | Edits |
|---|------|-------|
| 4.1 | `src/components/passives/resistor.ts` | 155 isNonlinear, 156 isReactive. |
| 4.2 | `src/components/passives/capacitor.ts` | Import 24; 171 isNonlinear, 172 isReactive, 173 poolBacked. |
| 4.3 | `src/components/passives/inductor.ts` | Import 26; 187 isNonlinear, 188 isReactive, 189 poolBacked; 471 mayCreateInternalNodes. |
| 4.4 | `src/components/passives/polarized-cap.ts` | Import 41; 262 allNodeIds (decl), 268 isNonlinear, 269 isReactive, 270 poolBacked; 619 (allNodeIds assign — `el.allNodeIds = el.pinNodeIds;`); 746 mayCreateInternalNodes. |
| 4.5 | `src/components/passives/transformer.ts` | Import 35; 228 allNodeIds (decl), 233 isNonlinear, 234 isReactive, 235 poolBacked; 284 allNodeIds (assign). |
| 4.6 | `src/components/passives/tapped-transformer.ts` | Import 44; 220 allNodeIds (decl), 225 isNonlinear, 226 isReactive, 227 poolBacked; 250 allNodeIds (assign). |
| 4.7 | `src/components/passives/transmission-line.ts` | Import 48 (`AnalogElement, ReactiveAnalogElementCore` → drop `ReactiveAnalogElementCore`). Strip `allNodeIds`/`isNonlinear`/`isReactive`/`poolBacked` at: SegmentInductor (236, 239–240), SegmentCapacitor (296, 299–300), Class C (356, 359–361), Class D (497, 500–502), Class E (615, 618–620), Class F (758, 763–765). DELETE constructor allNodeIds assigns: 255, 312, 382, 518, 642, 796. REWRITE in-file LTE iteration: 883, 914, 938 (`if (el.isReactive) {` / `if (!el.isReactive) continue;`) → use `getLteTimestep` typeof check. UPDATE casts at 884, 915, 939 (`as ReactiveAnalogElementCore` → `as PoolBackedAnalogElementCore`). UPDATE class declarations to `implements PoolBackedAnalogElementCore`: 354, 495, 613. 1154 mayCreateInternalNodes. (No `getInternalNodeLabels` implementation in this file — verified clean.) |
| 4.8 | `src/components/passives/crystal.ts` | Import 49; 246 (impl); 248 allNodeIds (decl), 253 isNonlinear, 254 isReactive, 255 poolBacked; 306 allNodeIds (assign); 758 mayCreateInternalNodes. |
| 4.9 | `src/components/passives/memristor.ts` | 70 isNonlinear, 71 isReactive. |
| 4.10 | `src/components/passives/analog-fuse.ts` | 91 allNodeIds (decl), 94 isNonlinear, 95 isReactive; 277 allNodeIds (assign). |
| 4.11 | `src/components/passives/potentiometer.ts` | 172 allNodeIds (decl), 175 isNonlinear, 176 isReactive; 192 allNodeIds (assign). |
| 4.12 | `src/components/passives/mutual-inductor.ts` | 55 poolBacked; 60 isNonlinear, 61 isReactive (`true`), 246 isNonlinear, 247 isReactive (`false`). |

---

## Phase 5 — Semiconductors (13 files)

| # | File | Edits |
|---|------|-------|
| 5.1 | `src/components/semiconductors/diode.ts` | 534, 535, 536 (object literal: isNonlinear, isReactive, poolBacked); 1086 mayCreateInternalNodes. |
| 5.2 | `src/components/semiconductors/zener.ts` | 230, 231, 232; 662 mayCreateInternalNodes. |
| 5.3 | `src/components/semiconductors/tunnel-diode.ts` | 275, 276, 277. |
| 5.4 | `src/components/semiconductors/varactor.ts` | 220 mayCreateInternalNodes (no isReactive/isNonlinear in the file body — already-clean for those flags; only mayCreateInternalNodes needs removal). |
| 5.5 | `src/components/semiconductors/schottky.ts` | 224 mayCreateInternalNodes only. |
| 5.6 | `src/components/semiconductors/bjt.ts` | 576, 577, 578 (block 1) and 1204, 1205, 1206 (block 2); 12 × mayCreateInternalNodes at 2329, 2337, 2345, 2353, 2361, 2369, 2404, 2412, 2420, 2428, 2436, 2444. |
| 5.7 | `src/components/semiconductors/mosfet.ts` | 852, 853, 854; 12 × mayCreateInternalNodes at 1995, 2004, 2013, 2022, 2031, 2040, 2069, 2078, 2087, 2096, 2105, 2114. |
| 5.8 | `src/components/semiconductors/njfet.ts` | 320, 321, 322; 1043 mayCreateInternalNodes. |
| 5.9 | `src/components/semiconductors/pjfet.ts` | 298, 299, 300; 1004 mayCreateInternalNodes. |
| 5.10 | `src/components/semiconductors/triac.ts` | 74 isNonlinear, 75 isReactive; 390 mayCreateInternalNodes. |
| 5.11 | `src/components/semiconductors/triode.ts` | 146 isNonlinear, 147 isReactive. |
| 5.12 | `src/components/semiconductors/diac.ts` | 76, 77; 266 mayCreateInternalNodes. |
| 5.13 | `src/components/semiconductors/scr.ts` | 82, 83; 337 mayCreateInternalNodes. |

---

## Phase 6 — Switching / FETs (9 files)

| # | File | Edits |
|---|------|-------|
| 6.1 | `src/components/switching/switch.ts` | 309, 310. |
| 6.2 | `src/components/switching/switch-dt.ts` | 322, 323. |
| 6.3 | `src/components/switching/relay.ts` | 125, 126 (off class), 194, 195 (on class); 583 mayCreateInternalNodes. |
| 6.4 | `src/components/switching/relay-dt.ts` | 66, 67; 456 mayCreateInternalNodes. |
| 6.5 | `src/components/switching/nfet.ts` | 194, 195 (class A), 258, 259 (class B). |
| 6.6 | `src/components/switching/pfet.ts` | 195, 196. |
| 6.7 | `src/components/switching/fgnfet.ts` | 322, 323; 442, 443; 947, 948 (3 classes); 1041 mayCreateInternalNodes. |
| 6.8 | `src/components/switching/fgpfet.ts` | 325, 326; 447, 448; 895, 896; 984 mayCreateInternalNodes. |
| 6.9 | `src/components/switching/trans-gate.ts` | 216, 217. |

---

## Phase 7 — Active / mixed-signal (10 files)

| # | File | Edits |
|---|------|-------|
| 7.1 | `src/components/active/opamp.ts` | 194, 195; 354 mayCreateInternalNodes. |
| 7.2 | `src/components/active/real-opamp.ts` | 435, 436. |
| 7.3 | `src/components/active/ota.ts` | 175, 176. |
| 7.4 | `src/components/active/comparator.ts` | 241 isNonlinear, 242 isReactive (getter — delete), 259 poolBacked; 392, 393 (getter), 407 poolBacked. |
| 7.5 | `src/components/active/schmitt-trigger.ts` | 169 isNonlinear, 170 isReactive (getter), 186 poolBacked. |
| 7.6 | `src/components/active/timer-555.ts` | 138, 139 (class A); 376, 377 (class B — `get isReactive()` getter at 377 delete), 382 poolBacked; 808, 815 mayCreateInternalNodes. |
| 7.7 | `src/components/active/optocoupler.ts` | 140, 141; 221, 222; 295, 296; 606 mayCreateInternalNodes. |
| 7.8 | `src/components/active/analog-switch.ts` | 274, 275, 291 poolBacked; 384, 385, 406 poolBacked; 693, 725 mayCreateInternalNodes. |
| 7.9 | `src/components/active/adc.ts` | 384 isNonlinear, 385 isReactive (getter), 408 poolBacked; 583, 591, 599, 607 mayCreateInternalNodes. |
| 7.10 | `src/components/active/dac.ts` | 318 isNonlinear, 319 isReactive (getter), 366 poolBacked; 541, 549 mayCreateInternalNodes. |

---

## Phase 8 — Sources / sensors / IO (11 files)

| # | File | Edits |
|---|------|-------|
| 8.1 | `src/components/sources/dc-voltage-source.ts` | 171, 172. |
| 8.2 | `src/components/sources/ac-voltage-source.ts` | 602, 603. |
| 8.3 | `src/components/sources/current-source.ts` | 179, 180. |
| 8.4 | `src/components/sources/variable-rail.ts` | 173, 174. |
| 8.5 | `src/components/sensors/ldr.ts` | 77, 78. |
| 8.6 | `src/components/sensors/ntc-thermistor.ts` | 116, 117 (declarations), 168–170 (delete the constructor lines that compute `selfHeating` and assign `this.isReactive = selfHeating`). |
| 8.7 | `src/components/sensors/spark-gap.ts` | 109, 110. |
| 8.8 | `src/components/io/led.ts` | **VERIFIED CLEAN** — grep returns no matches for `isReactive`/`isNonlinear`/`poolBacked`. Already-clean for these flags. (The inventory's reference to "(2)" was stale.) |
| 8.9 | `src/components/io/clock.ts` | 268, 269. |
| 8.10 | `src/components/io/probe.ts` | 223, 224. |
| 8.11 | `src/components/io/ground.ts` | 121, 122. |

---

## Phase 9 — Wiring / memory / flipflops (mayCreateInternalNodes only) (10 files)

These files have NO `isReactive`/`isNonlinear` to strip — only `mayCreateInternalNodes`.

| # | File | Edits |
|---|------|-------|
| 9.1 | `src/components/wiring/driver-inv.ts` | 239 mayCreateInternalNodes. |
| 9.2 | `src/components/memory/register.ts` | 237. |
| 9.3 | `src/components/memory/counter.ts` | 277. |
| 9.4 | `src/components/memory/counter-preset.ts` | 365. |
| 9.5 | `src/components/flipflops/t.ts` | 283. |
| 9.6 | `src/components/flipflops/rs.ts` | 221. |
| 9.7 | `src/components/flipflops/rs-async.ts` | 205. |
| 9.8 | `src/components/flipflops/jk.ts` | 287. |
| 9.9 | `src/components/flipflops/jk-async.ts` | 321. |
| 9.10 | `src/components/flipflops/d.ts` | 353. |
| 9.11 | `src/components/flipflops/d-async.ts` | 292. |

---

## Phase 10 — Test infrastructure / fixtures (8 files; do BEFORE Phase 11)

| # | File | Edits |
|---|------|-------|
| 10.1 | `src/solver/analog/__tests__/test-helpers.ts` | Import 29 (drop `ReactiveAnalogElement` → `PoolBackedAnalogElement`). Strip `isNonlinear`/`isReactive` keys at: 122,123 — 184,185 — 244,245 — 325,326 — 327 (poolBacked) — 439,440 — 561,562 — 690,691. Update return-type annotation at 309 (`ReactiveAnalogElement` → `PoolBackedAnalogElement`). Update casts: 754, 1028, 1030. Comment cleanup: 1020. |
| 10.2 | `src/test-fixtures/registry-builders.ts` | 64, 65. |
| 10.3 | `src/test-fixtures/model-fixtures.ts` | 18, 19. |
| 10.4 | `src/solver/analog/__tests__/harness/types.ts` | 145 (`isNonlinear`), 146 (`isReactive`) — drop both fields from the capture-blob type. |
| 10.5 | `src/solver/analog/__tests__/harness/capture.ts` | 172, 173 (drop `isNonlinear`/`isReactive` from blob). DELETE the internal-node label loop at 111–118 — `el.allNodeIds[pinCount + p]` and `el.internalNodeLabels` consumers (§6c-C). The capture path will need to derive labels from another source or accept generic placeholders; verify no fixture-comparison script depends on labels being present. |
| 10.6 | `src/solver/analog/__tests__/harness/ngspice-bridge.ts` | 895 (single literal — drop both fields). |
| 10.7 | `src/solver/analog/__tests__/harness/netlist-generator.ts` | **DEFERRED** (left untouched in this batch). Lines 14, 80, 259, 263 use `ModelEmissionSpec` / `modelCardPrefix` — pending separate spice-spec review. |
| 10.8 | `src/solver/analog/__tests__/harness/netlist-generator.test.ts` | 73 (drop `isNonlinear`/`isReactive` from literal — also at 74). |
| 10.9 | `src/solver/analog/__tests__/harness/slice.test.ts` | 34, 35, 36 (three literals, strip both fields from each). |

---

## Phase 11 — Engine/solver tests (mechanical strips, ~25 files)

Most are object-literal property strips. Files with `expect(el.isReactive/.isNonlinear).toBe(...)` need those `expect()` lines removed; if a whole `it(...)` only tests these flags, delete the block.

| # | File | Edits (line numbers) |
|---|------|-------|
| 11.1 | `src/solver/analog/__tests__/ckt-context.test.ts` | Strip comments referencing the flags: 51, 52, 53. Asserts: 141, 142. **Delete the entire "precomputed lists" describe block (≈ 200–242)** which tests `nonlinearElements`/`reactiveElements`/`elementsWithLte`/`elementsWithAcceptStep`. |
| 11.2 | `src/solver/analog/__tests__/element-interface.test.ts` | Literal entries at 25, 26, 69, 70, 81, 82, 93, 94, 119, 120, 133, 134. The contract has changed — review whether the file still has a reason to exist. |
| 11.3 | `src/solver/analog/__tests__/timestep.test.ts` | 45 (comment), 53 (`allNodeIds` keep), 56, 57 — strip flags from fixture; verify `getLteTimestep` is set. |
| 11.4 | `src/solver/analog/__tests__/rc-ac-transient.test.ts` | 429 (`compiled.elements.filter(e => e.isReactive)`), 433 (same). Replace predicate with `typeof e.getLteTimestep === "function"`. |
| 11.5 | `src/solver/analog/__tests__/analog-engine.test.ts` | 515, 516. |
| 11.6 | `src/solver/analog/__tests__/ac-analysis.test.ts` | 53, 54, 83, 84, 112, 113. |
| 11.7 | `src/solver/analog/__tests__/compiler.test.ts` | 101, 102, 116, 117, 131, 132. |
| 11.8 | `src/solver/analog/__tests__/compile-analog-partition.test.ts` | 88, 89; 537 (`expect(element.isReactive).toBe(false)` — delete `expect`); 560 (`poolBacked: true as const,` — strip); 565, 566. |
| 11.9 | `src/solver/analog/__tests__/dc-operating-point.test.ts` | 74, 75, 141, 142, 223, 224. |
| 11.10 | `src/solver/analog/__tests__/dcop-init-jct.test.ts` | **VERIFIED CLEAN** for `isReactive`/`isNonlinear`. Still imports `ReactiveAnalogElement` (line 30); cast 42; rewrite import & cast to `PoolBackedAnalogElement`. |
| 11.11 | `src/solver/analog/__tests__/digital-pin-loading.test.ts` | 72, 73, 112, 113. |
| 11.12 | `src/solver/analog/__tests__/spice-import-dialog.test.ts` | 147, 183, 222, 260, 300, 301, 430 (literal stub factories). |
| 11.13 | `src/solver/analog/__tests__/convergence-regression.test.ts` | 4 occurrences — strip from `ReactiveAnalogElement` casts (use `PoolBackedAnalogElement`). |
| 11.14 | `src/solver/analog/__tests__/setup-stamp-order.test.ts` | 296, 297, 362, 363. |
| 11.15 | `src/solver/digital/__tests__/flatten-pipeline-reorder.test.ts` | 34. |
| 11.16 | `src/compile/__tests__/compile.test.ts` | 177, 178, 260, 261. |
| 11.17 | `src/compile/__tests__/compile-integration.test.ts` | 105, 106, 120, 121, 135, 136. |
| 11.18 | `src/compile/__tests__/coordinator.test.ts` | 127, 128, 211. |
| 11.19 | `src/compile/__tests__/pin-loading-menu.test.ts` | 59, 60. |
| 11.20 | `src/solver/__tests__/coordinator-capability.test.ts` | 46, 47, 109. |
| 11.21 | `src/solver/__tests__/coordinator-clock.test.ts` | 57, 89. |
| 11.22 | `src/solver/__tests__/coordinator-speed-control.test.ts` | 58, 113. |
| 11.23 | `src/editor/__tests__/wire-current-resolver.test.ts` | 41, 42. |
| 11.24 | `src/core/__tests__/analog-types-setparam.test.ts` | 10, 11, 24, 25. |
| 11.25 | `src/solver/analog/__tests__/behavioral-gate.test.ts` | 387, 388, 436, 437, 447, 458, 469. Inspect for `it(...)` blocks that only check the flags — delete those wholesale. |
| 11.26 | `src/solver/analog/__tests__/behavioral-combinational.test.ts` | 375, 376, 387, 388, 399, 400. Same `it(...)` audit. |
| 11.27 | `src/solver/analog/__tests__/behavioral-sequential.test.ts` | 412, 413, 414, 431, 432, 433. |
| 11.28 | `src/solver/analog/__tests__/behavioral-remaining.test.ts` | **VERIFIED CLEAN** for `isReactive`/`isNonlinear`. Still imports `ReactiveAnalogElement` (line 34); cast 67–68; rewrite to `PoolBackedAnalogElement`. |
| 11.29 | `src/solver/analog/__tests__/phase-3-relay-composite.test.ts` | 40, 55 — replace assertion with `getLteTimestep` presence check. |

---

## Phase 12 — Component tests (~40 files; mechanical strips, do LAST)

These are object-literal strips and `expect(...).toBe(...)` deletions. For files with explicit `it("declares isReactive===true")` / `it("isReactive_true_when_...")` blocks, **delete the whole `it(...)`**.

### 12a. Passives tests
| # | File | Edits |
|---|------|-------|
| 12.1 | `src/components/passives/__tests__/resistor.test.ts` | 107, 108, 130, 131, 310. |
| 12.2 | `src/components/passives/__tests__/capacitor.test.ts` | Import 22, withState 115–116; comments 8; **delete `it("declares isReactive === true")` at 218–224**. State assertions at 280, 289, 307, 324, 344, 367, 396 use `as ReactiveAnalogElement` — rewrite cast to `as PoolBackedAnalogElement`. |
| 12.3 | `src/components/passives/__tests__/inductor.test.ts` | Import 23, withState 98–99; comments 9; **delete `it("declares isReactive === true")` at 230–236**. Casts 99, 296. |
| 12.4 | `src/components/passives/__tests__/polarized-cap.test.ts` | Import 25, 46–47; literal 138–139; **delete `it("PolarizedCapDefinition isReactive")` at 449–454 and `it("PolarizedCapDefinition isNonlinear")` at 456–461**. |
| 12.5 | `src/components/passives/__tests__/transformer.test.ts` | Import 42, 136–137; **delete `it("isReactive is true")` at 666–669**. |
| 12.6 | `src/components/passives/__tests__/tapped-transformer.test.ts` | Casts at 103, 110 use `poolBacked` flag — replace with method-presence check. |
| 12.7 | `src/components/passives/__tests__/transmission-line.test.ts` | Comment 236; **delete `expect(el.isReactive).toBe(true)` at 237 and `expect(el.isNonlinear).toBe(false)` at 238 — and the `it("isReactive is true")` block 784–794 plus `it("isNonlinear is false")` block 796–805**. Casts 215, 279, 822 (`ReactiveAnalogElement` → `PoolBackedAnalogElement`). 142, 149, 880 (`poolBacked` flag check → method-presence). **§Dead-test cleanup inside `it("requires branch row")` (716–729):** delete the `getInternalNodeCount?:` field from the local `BehavioralEntry` type at line 717, and delete assertion lines 726, 727, 728. KEEP the `branchCount` part of the same `it(...)` (lines 719, 724–725) — `branchCount` VERIFIED alive: production consumer at `compiler.ts:198` (`totalBranches += subEl.branchCount ?? 0`). |
| 12.8 | `src/components/passives/__tests__/crystal.test.ts` | Import 34, 43–44; literal 238, 241, 242; **delete `it("CrystalDefinition isReactive")` at 354–362 and `it("CrystalDefinition isNonlinear is false")` at 364–372**. Cast 403. |
| 12.9 | `src/components/passives/__tests__/memristor.test.ts` | 348, 349, 364 (comment). |
| 12.10 | `src/components/passives/__tests__/analog-fuse.test.ts` | Literal 353, 354; expect 459, 460. |

### 12b. Semiconductors tests
| # | File | Edits |
|---|------|-------|
| 12.11 | `src/components/semiconductors/__tests__/diode.test.ts` | Import 32, 73, 77; **delete `it("isReactive should be true when CJO > 0")` at 257–258 and `it("isReactive_false_when_cjo_zero")` at 290–293 and `it("isNonlinear_true")` at 284–287**. Casts 492, 675, 727. Literal 343, 346, 347. |
| 12.12 | `src/components/semiconductors/__tests__/zener.test.ts` | Import 18, 55, 59; **delete `it("isReactive_false")` at 125–129 and `it("isNonlinear_true")` at 118–122**. |
| 12.13 | `src/components/semiconductors/__tests__/tunnel-diode.test.ts` | Import 27, 53, 54; literals 293, 296, 297, 313, 316, 317. |
| 12.14 | `src/components/semiconductors/__tests__/varactor.test.ts` | Import 21, 58, 62; **delete `it("isReactive_true_when_cjo_nonzero")` 160–164, `it("isNonlinear_true")` 167–170, `it("mayCreateInternalNodes_true")` 148–152**. |
| 12.15 | `src/components/semiconductors/__tests__/schottky.test.ts` | Import 21, 65, 69; **delete `it("isReactive_true_when_cjo_nonzero")` 166–170 and `it("isNonlinear_true")` 160–163**. |
| 12.16 | `src/components/semiconductors/__tests__/bjt.test.ts` | Import 38, 75, 79; comment 6; **delete `it("isNonlinear_true")` 138–141, `it("pnp_isNonlinear_true")` 162–165, `it("isReactive_false")` 144–147**. Asserts 235, 244, 253, 262, 359, 366. |
| 12.17 | `src/components/semiconductors/__tests__/mosfet.test.ts` | Import 32, 76, 112; literal 244, 247, 248; **delete `it("isNonlinear_true")` 289–292 and `it("isReactive_false_when_no_capacitances")` 295–299 and `it("isReactive_true_when_cbd_nonzero")` 302–306**; comment 1022; line 870 (`isNonlinear` runtime check). |
| 12.18 | `src/components/semiconductors/__tests__/jfet.test.ts` | Import 53, 63, 64; casts 220, 320, 534, 536, 612, 614; literal 180, 183, 184. |
| 12.19 | `src/components/semiconductors/__tests__/scr.test.ts` | Import 26, 37, 38; literal 87, 90, 91; casts 496, 574, 608, 668. |
| 12.20 | `src/components/semiconductors/__tests__/triac.test.ts` | Import 22, 31, 32. |
| 12.21 | `src/components/semiconductors/__tests__/triode.test.ts` | **Delete `it("analogFactory creates a triode element with isNonlinear=true")` 384–390 and `expect(elem.isReactive).toBe(false)` 390**. |
| 12.22 | `src/components/semiconductors/__tests__/diac.test.ts` | (no occurrences in grep — skip) |

### 12c. Active / mixed-signal tests
| # | File | Edits |
|---|------|-------|
| 12.23 | `src/components/active/__tests__/opamp.test.ts` | 178, 214 (literal stubs). |
| 12.24 | `src/components/active/__tests__/real-opamp.test.ts` | 94, 95, 119, 120; expect 187, 291, 292, 536, 537, 558, 560, 561; comment 558. |
| 12.25 | `src/components/active/__tests__/comparator.test.ts` | 69 (cast — `ReactiveAnalogElement` → `PoolBackedAnalogElement`). |
| 12.26 | `src/components/active/__tests__/timer-555.test.ts` | 530, 531. |
| 12.27 | `src/components/active/__tests__/timer-555-debug.test.ts` | (only `allNodeIds` per grep — skip unless §6c-C drops). |
| 12.28 | `src/components/active/__tests__/optocoupler.test.ts` | **Delete `it("modelRegistry behavioral entry has mayCreateInternalNodes=true")` 116–120 and `it("isNonlinear is true...")` 111–113**. expect 90; line 102 comment, 103 (`expect(...poolBacked).toBeFalsy()` — keep or delete based on whether the test is still meaningful), 159 (`core.poolBacked = true`). |
| 12.29 | `src/components/active/__tests__/analog-switch.test.ts` | Comment 6; **delete `it("poolBacked flag is true")` 60–66 and 170–176, `it("isNonlinear is true")` 97–103 and 198–204, `it("isReactive is false ...")` 106–112 and 207–213**. |
| 12.30 | `src/components/active/__tests__/adc.test.ts` | 370 (cast — `ReactiveAnalogElement` → `PoolBackedAnalogElement`). |
| 12.31 | `src/components/active/__tests__/dac.test.ts` | 406 (cast). |
| 12.32 | `src/components/active/__tests__/cccs.test.ts` | 100, 101. |
| 12.33 | `src/components/active/__tests__/ccvs.test.ts` | 88, 89. |
| 12.34 | `src/components/active/__tests__/ota.test.ts` | 84. |

### 12d. Sources / sensors / IO tests
| # | File | Edits |
|---|------|-------|
| 12.35 | `src/components/sources/__tests__/dc-voltage-source.test.ts` | 143, 144. |
| 12.36 | `src/components/sources/__tests__/current-source.test.ts` | 130, 131. |
| 12.37 | `src/components/sources/__tests__/ground.test.ts` | 99, 100. |
| 12.38 | `src/components/sources/__tests__/variable-rail.test.ts` | 32, 33; expect 124, 125, 148. |
| 12.39 | `src/components/sensors/__tests__/ldr.test.ts` | 264, 265. |
| 12.40 | `src/components/sensors/__tests__/ntc-thermistor.test.ts` | 337. |
| 12.41 | `src/components/sensors/__tests__/spark-gap.test.ts` | 379, 380. |
| 12.42 | `src/components/io/__tests__/led.test.ts` | Imports 56; withState 78–79; literals 743, 746, 747; expect 797, 798. |
| 12.43 | `src/components/io/__tests__/probe.test.ts` | 473, 474. |
| 12.44 | `src/components/io/__tests__/analog-clock.test.ts` | 152, 153. |
| 12.45 | `src/components/switching/__tests__/trans-gate.test.ts` | **Delete the whole `describe("isNonlinear and isReactive")` block 514–522** if it is dedicated to these flags. |

---

## Suggested execution order for haiku

1. **Phase 1** (sequential, single-pass) — types collapse, tsc errors anchor the rest.
2. **Phase 2** in parallel after Phase 1 commits — engine consumers.
3. **Phases 3 → 9** in parallel batches (≈10 files at a time) — element declarations.
4. **Phase 10** — fixtures (must precede Phase 11/12 because test files import from `test-helpers.ts`).
5. **Phases 11–12** in parallel (no inter-file deps) — strip from object literals and `expect()` calls.
6. After all phases land: full-suite `tsc --noEmit` should be clean. Run targeted vitest per `targeted_tests_only` rule, not the full suite.

---

## Verification grep (post-cleanup)

```
Grep "\\bisReactive\\b|\\bisNonlinear\\b|\\bmayCreateInternalNodes\\b|\\bReactiveAnalogElement\\b|\\bnonlinearElements\\b|\\breactiveElements\\b|\\bmodelCardPrefix\\b" src
```

Expected: zero hits in `src/`. (The `spec/`, `vitest-output.log`, `tsc-output.txt`, and `.phase*-*.log` matches are historical and ignored.)
