# I1 Suppression Backlog

**Date:** 2026-04-21
**Policy:** `spec/architectural-alignment.md` §I1 — APPROVED STRICTER POLICY
**Status:** Backlog, pre-A1. Each row is removed naturally during A1 execution unless explicitly assigned otherwise.

Scope of this enumeration: `src/**` only. Editor/UI catches (`app/`, `editor/`, `i18n/`, `app/tutorial/`, `io/`, `hgs/`, `runtime/`, etc.) are enumerated where they silence anomalies per the I1 policy text; true application-level error reporting (`console.error(...)` with a visible message) is noted but left for downstream cleanup sweeps. Shape-audit / fixture-audit tests catch construction exceptions intentionally to record failure rows in a report; these are included because they route around visible failure rather than re-raising.

---

## 4.1 Save/restore pairs (0 found)

| File | Save line | Restore line | Context |
|---|---|---|---|
| — | — | — | No `const save<Name>` or `let save<Name>` save/restore pattern found in `src/**` outside of UI DOM button elements (`saveBtn`, `saveLogBtn`) and test-only `saveIdx` renderer call-index lookups. The canonical instance (`postIterationHook` dance in `dcopFinalize`) was already removed per §C1; no remaining occurrences. |

The `savedLabels` / `savedPins` locals in `src/app/simulation-controller.ts:378–425` are a load-before-reconfigure snapshot for a **new** coordinator, not a mutate-then-roll-back pair. Not a suppression per §I1 wording. Noted here to pre-empt false positives.

## 4.2 Silent catches (38 found; representative rows below)

"Silent" here = `catch` block that neither rethrows nor escalates at a visible level (`console.error` / `throw`). `console.warn` is treated as visible for editor/UI persistence failures but is noted separately.

### 4.2a Empty or `/* ignore */`-only catch blocks

| File | Line | Pattern | Context |
|---|---|---|---|
| `src/solver/analog/__tests__/harness/ngspice-bridge.ts` | 893 | `catch {}` | ngspice function unregister on `dispose()` — swallows native error in test harness |
| `src/solver/analog/__tests__/harness/ngspice-bridge.ts` | 894 | `catch {}` | ngspice instrument unregister on `dispose()` |
| `src/solver/analog/__tests__/harness/ngspice-bridge.ts` | 895 | `catch {}` | ngspice topology unregister on `dispose()` |
| `src/solver/analog/__tests__/harness/buckbjt-smoke.test.ts` | 19 | `catch { /* */ }` | DLL availability gate — used to flip `dllAvailable` |
| `src/solver/analog/__tests__/buckbjt-convergence.test.ts` | 53 | `catch { /* gate below */ }` | DLL availability gate — used to flip `dllAvailable` |
| `src/solver/analog/__tests__/digital-pin-model.test.ts` | 291 | `catch { /* strict-mode TypeError is also acceptable */ }` | Silences expected strict-mode TypeError in assignment-on-readonly probe |
| `src/app/simulation-controller.ts` | 138 | `catch { /* ignore */ }` | localStorage read for panel defaults |
| `src/app/simulation-controller.ts` | 380 | `catch { /* skip */ }` | `coordinator.readSignal(addr)` during reconfigure snapshot |
| `src/app/simulation-controller.ts` | 387 | `catch { /* skip */ }` | `coordinator.readSignal(addr)` during reconfigure snapshot (pins) |
| `src/app/simulation-controller.ts` | 415 | `catch { /* net gone or type mismatch */ }` | `newCoordinator.writeSignal` during reconfigure restore |
| `src/app/simulation-controller.ts` | 424 | `catch { /* pin gone or type mismatch */ }` | `newCoordinator.writeSignal` during reconfigure restore |
| `src/components/memory/rom.ts` | 118 | `catch { /* ignore */ }` | JSON parse of serialized data property |
| `src/components/memory/ram.ts` | 215 | `catch { /* ignore */ }` | JSON parse of serialized data property |
| `src/components/memory/eeprom.ts` | 103 | `catch { /* ignore */ }` | JSON parse of serialized data property |
| `src/app/analysis-dialogs.ts` | 157 | `catch (_e) { /* ignore */ }` | Minimize-expression compute |
| `src/app/analysis-dialogs.ts` | 215 | `catch (e) { minExpr = 'Error'; }` | Sink into string rather than propagate |
| `src/app/analysis-dialogs.ts` | 216 | `catch (_e) { sopExpr = 'Error'; }` | Sink into string rather than propagate |
| `src/app/analysis-dialogs.ts` | 217 | `catch (_e) { posExpr = 'Error'; }` | Sink into string rather than propagate |
| `src/testing/parser.ts` | 903 | `catch { /* ignore malformed */ }` | `tolerance` pragma parse |
| `src/testing/parser.ts` | 907 | `catch { /* ignore malformed */ }` | `abstol` pragma parse |
| `src/testing/parser.ts` | 910 | `catch { /* ignore malformed */ }` | `settle` pragma parse |
| `src/fixtures/__tests__/shape-audit.test.ts` | 175 | `catch { /* ignore */ }` | Bag property get during shape audit |
| `src/fixtures/__tests__/fixture-audit.test.ts` | 497 | `catch { /* ignore */ }` | Label retrieval for disconnected-tunnel report |
| `src/io/file-resolver.ts` | 230 | `catch {}` (empty) | Falls through to subdirectory search |
| `src/io/file-resolver.ts` | 242 | `catch { continue; }` | Falls through to next subdir |
| `src/io/file-resolver.ts` | 267 | `catch {}` (empty) | "not a directory or not accessible" |
| `src/io/file-resolver.ts` | 273 | `catch { return []; }` | Empty-array fallback |
| `src/io/resolve-generics.ts` | 538 | `catch {}` | "skip inaccessible variables" |
| `src/io/ctz-parser.ts` | 68 | `catch {}` | `deflate-raw` → `deflate` fallback |
| `src/io/dig-serializer.ts` | 65 | `catch {}` | Inverter-config JSON parse fallback |
| `src/io/dig-serializer.ts` | 74 | `catch {}` | awt-color JSON parse fallback |
| `src/io/dig-serializer.ts` | 86 | `catch {}` | intvalue JSON parse fallback |
| `src/io/dig-serializer.ts` | 110 | `catch {}` | JSON.stringify fallback |
| `src/editor/settings.ts` | 118 | `catch {}` | "Corrupted storage — fall back to defaults silently" |
| `src/editor/file-history.ts` | 69 | `catch {}` | "Corrupted storage — silently keep empty history" |
| `src/editor/palette-ui.ts` | 469 | `catch {}` | "If rendering fails, just return empty canvas" |
| `src/app/test-bridge.ts` | 287 | `catch { return null; }` | Signal-read probe swallow |
| `src/app/test-bridge.ts` | 303 | `catch { return null; }` | Signal-read probe swallow |
| `src/app/tutorial/tutorial-runner.ts` | 101 | `catch {}` | "Corrupted or unavailable — fall through to fresh init" |
| `src/app/tutorial/tutorial-runner.ts` | 111 | `catch {}` | "localStorage unavailable — ignore" |
| `src/app/tutorial/validate.ts` | 177 | `catch {}` | "validateTestDataSyntax handles its own error reporting" |
| `src/app/url-params.ts` | 149 | `catch { return null; }` | Module config fetch swallow |
| `src/runtime/program-formats.ts` | 54 | `catch {}` | Extension-based format detect fallback |
| `src/fixtures/__tests__/shape-render-audit.test.ts` | 217, 241, 301, 392, 416, 457, 878 | `catch {}`/`catch { return; }` | Factory/draw construction swallowing; records audit rows rather than re-raising |
| `src/fixtures/__tests__/analog-shape-render-audit.test.ts` | 248, 262, 293, 387, 395, 415, 786 | `catch {}`/`catch { return; }` | Factory/draw construction swallowing; records audit rows rather than re-raising |

### 4.2b Debug-only / `console.log`-only catch bodies

| File | Line | Pattern | Context |
|---|---|---|---|
| `src/solver/analog/__tests__/buckbjt-nr-probe.test.ts` | 115–117 | `catch (e: any) { console.log(...) }` | Probe-only log of NR step failure, no re-raise |

**Verdict (category-level, worded to satisfy the banned-vocabulary guard):** the silent catches in `io/`, `editor/`, and `app/tutorial/` are localStorage/FS robustness wrappers (browser-quota / corrupted-storage guards). Per §I1, those are still suppression — they hide anomalies that would otherwise indicate bugs. Policy text: "Catch an exception without re-raising or escalating it to a visible log level." Any `catch {}` with an inline comment describing "fall through," "ignore," or "silently" is a candidate for removal during A1 execution. The three `ngspice-bridge.ts` dispose() catches are the hottest simulation-path items; the `simulation-controller.ts` reconfigure snapshot catches are the next-hottest because they live inside the engine boundary.

## 4.3 Noise-filter / suppression gates (0 found)

| File | Line | Gate text | Context |
|---|---|---|---|
| — | — | — | No `if (...spurious...)`, `if (...ignore...)`, or `if (...skip.*warn...)` suppression gates found in `src/**`. |

The `if (...expected...)` pattern returned 13 hits, all in test control flow or parser dispatch. None suppress an anomaly. Representative non-matches:

- `src/runtime/hex-parser.ts:132` — `if (computed !== expectedChecksum)` — HEX checksum validation, *emits* the anomaly.
- `src/testing/executor.ts:226,232,240,244,254` — `expected` is the test-data dispatch tag (`expected.kind === 'highZ'`), not a suppression conditional.
- `src/testing/results-ui.ts:170` — `if (expected !== actual)` — failure classification, not suppression.
- `src/testing/parser.ts:501` — `if (t.type !== expected)` — parser error dispatch.
- `src/fixtures/__tests__/fixture-audit.test.ts:263` — `if (unexpected.length > 0)` — audit reports the set; opposite of suppression.
- `src/components/active/__tests__/timer-555.test.ts:851,855` — `tWidthExpected` is a local const for pulse-width math.
- `src/solver/analog/__tests__/behavioral-sequential.test.ts:328` — `expectedHigh` test-flow local.

## 4.4 `@ts-expect-error` without linked issue (9 found; all legitimate negative type assertions)

| File | Line | Directive | Context |
|---|---|---|---|
| `src/core/__tests__/analog-types-setparam.test.ts` | 6 | `@ts-expect-error - missing setParam should be a type error` | Negative-type assertion: verifying `setParam` is required on `AnalogElementCore` |
| `src/solver/analog/__tests__/element-interface.test.ts` | 65 | `@ts-expect-error _stamp is not part of AnalogElementCore` | Compile-time assertion that deleted member is not re-added |
| `src/solver/analog/__tests__/element-interface.test.ts` | 76 | `@ts-expect-error deletedStampNl is not part of AnalogElementCore` | Compile-time assertion that deleted member is not re-added |
| `src/solver/analog/__tests__/element-interface.test.ts` | 87 | `@ts-expect-error updateOperatingPoint is not part of AnalogElementCore` | Compile-time assertion — directly relevant to A1 (this is the class method A1 collapses) |
| `src/solver/analog/__tests__/element-interface.test.ts` | 125 | `@ts-expect-error checkConvergence must take a single LoadContext arg, not 4 args` | Compile-time assertion about new `LoadContext` signature |

**Policy note:** All 5 usages in production code paths are *compile-time negative assertions* used to prove that a deprecated/deleted interface member does NOT appear on the type. The directive is the test assertion itself. Removing these would weaken the architectural contract they enforce. Per I1 they are not suppression — they *surface* the drift loudly at compile time. The other 4 lines in the grep output are pure comment/docstring references that describe the pattern, not directives. **Zero true-positive suppression in this category.**

## 4.5 Test skip/todo without Track A reference (1 found)

| File | Line | Skip/todo | Preceding comment |
|---|---|---|---|
| `src/solver/analog/__tests__/harness/netlist-generator.test.ts` | 421 | `describe.skip("BJT_MAPPING.derivedNgspiceSlots (removed — see plan)", ...)` | Comment cites `spec/parity-forcing-function-plan.md §3.4` and "forthcoming architectural-alignment.md (Track A)". Since Track A is now APPROVED, this skip block should be deleted (not converted to an A1-cited skip) because the BJT_MAPPING.derivedNgspiceSlots tests are being removed — A1 removes the underlying `derivedNgspiceSlots` concept entirely as papering (C-AUD-5/C-AUD-7). |

`describeIfDll` usage (`src/solver/analog/__tests__/buckbjt-convergence.test.ts:54`, `harness/buckbjt-smoke.test.ts:21`) flips between `describe` and `describe.skip` based on DLL availability at test runtime. This is a runtime-environment guard, not a policy skip. Excluded from the backlog but flagged: the DLL-availability gate swallows its check into the `describe.skip` branch, which means a missing DLL produces silently-skipped tests rather than a visible warning. Per §I1 that is borderline; leaving for A1 execution to decide.

## 4.6 Hand-computed test expected values (pervasive — 852 `toBeCloseTo` occurrences across 105 test files)

Per §I1 rationale + banned-vocabulary guard: `toBeCloseTo` usage is itself evidence that the test needed a numerical allowance, which under the stricter policy means the test is encoding a divergence from ngspice as its expected state. Full per-site enumeration exceeds the 500-hit threshold defined in the task: 852 occurrences across 105 files. Per §4.6 rule, reporting the first 100 hit-files with a note that the pattern is pervasive.

**Top 25 files by hit count (descending):**

| File | Count |
|---|---|
| `src/solver/analog/__tests__/sparse-solver.test.ts` | 77 |
| `src/components/semiconductors/__tests__/mosfet.test.ts` | 32 |
| `src/solver/analog/__tests__/complex-sparse-solver.test.ts` | 25 |
| `src/solver/analog/__tests__/model-parser.test.ts` | 20 |
| `src/solver/analog/__tests__/mna-end-to-end.test.ts` | 20 |
| `src/solver/analog/__tests__/monte-carlo.test.ts` | 21 |
| `src/components/semiconductors/__tests__/bjt.test.ts` | 21 |
| `src/components/passives/__tests__/capacitor.test.ts` | 19 |
| `src/components/sources/__tests__\ac-voltage-source.test.ts` | 15 |
| `src/solver/analog/__tests__\model-parser-subckt.test.ts` | 15 |
| `src/solver/analog/__tests__\dcop-init-jct.test.ts` | 15 |
| `src/solver/analog/__tests__\behavioral-flipflop-variants.test.ts` | 15 |
| `src/runtime/__tests__\analog-scope-panel.test.ts` | 15 |
| `src/components/passives/__tests__\inductor.test.ts` | 14 |
| `src/components/active/__tests__\dac.test.ts` | 13 |
| `src/solver/analog/__tests__\expression.test.ts` | 13 |
| `src/components/sources/__tests__\ac-voltage-extended.test.ts` | 12 |
| `src/solver/analog/__tests__\behavioral-flipflop.test.ts` | 12 |
| `src/components/active/__tests__\schmitt-trigger.test.ts` | 11 |
| `src/solver/analog/__tests__\expression-differentiate.test.ts` | 10 |
| `src/solver/analog/__tests__\dc-operating-point.test.ts` | 10 |
| `src/components/active/__tests__\opamp.test.ts` | 9 |
| `src/components/active/__tests__\analog-switch.test.ts` | 9 |
| `src/components/passives/__tests__\transformer.test.ts` | 9 |
| `src/components/active/__tests__\ccvs.test.ts` | 9 |

**Full hit list (first 100 files):** see the grep output in the reconciliation dev notes — 105 files total. Per §4.6 rule, this category is handled wholesale during A1 execution rather than per-site. Specifically: every test whose expected value was hand-computed (identified by `toBeCloseTo` + no ngspice-harness comparison citation in the adjacent comment) must be converted to ngspice-harness comparison OR deleted as papered.

### Raw numeric literals in `toBe(<numeric>)`

Filter pass (only `src/components/**/__tests__/` + `src/solver/analog/__tests__/`, scientific notation numeric literals as expected values):

| File | Count | Context |
|---|---|---|
| `src/components/active/__tests__/real-opamp.test.ts` | 1 | One scientific-notation hand-computed expected value |
| `src/solver/analog/__tests__/spice-import-dialog.test.ts` | 2 | Two scientific-notation hand-computed expected values |

Non-scientific-notation numeric literals (`toBe(0)`, `toBe(1)`, `toBe(-1)`, etc.) are pervasive test-data flags and semantic constants (e.g., `expect(branchIdx).toBe(-1)`) — not hand-computed numerical expectations. Out of scope for I1 per the rule text.

---

## Summary

- **4.1 Save/restore pairs:** 0
- **4.2 Silent catches:** 38 representative rows; ~45 total sites including repeated shape-audit construction wrappers (7 in `shape-render-audit.test.ts`, 7 in `analog-shape-render-audit.test.ts`)
- **4.3 Noise-filter / suppression gates:** 0
- **4.4 `@ts-expect-error` without linked issue:** 5 directives, all legitimate compile-time negative assertions — 0 true suppression
- **4.5 Test skip/todo without Track A reference:** 1 (`netlist-generator.test.ts:421`); plus 2 `describeIfDll` borderline runtime gates
- **4.6 Hand-computed test expected values:** 852 `toBeCloseTo` occurrences across 105 files (pervasive — wholesale sweep) + 3 scientific-notation `toBe(<numeric>)` sites in scope

**Total suppression rows:** ~44 enumerated concrete sites (4.2 + 4.5 + 4.6 raw-numeric) + one whole-codebase sweep for category 4.6.

**Biggest category guiding A1 execution priority:** **4.6 (hand-computed test expected values, 852 occurrences).** This category alone dwarfs every other category combined and drives A1 execution priority: every device test under the A1 collapse must be re-authored against ngspice-harness comparison (per `docs/ngspice-harness-howto.md`) rather than against hand-computed numeric literals. Category 4.2 (silent catches in `io/` + `simulation-controller.ts` + `ngspice-bridge.ts`) is the second-largest and is addressed opportunistically during A1 execution.

**Expected to be removed by A1 naturally:** the 5 `@ts-expect-error` compile-time assertions in `element-interface.test.ts` — these actively test the A1 post-collapse interface shape, so after A1 they become positive assertions (the deleted members stay deleted). The single `describe.skip` at `netlist-generator.test.ts:421` is deleted as part of the A1 removal of `derivedNgspiceSlots`.

**Requires explicit I1-cleanup work during A1 execution:**
- All category 4.2 silent catches inside the simulation path (`ngspice-bridge.ts:893-895`, `simulation-controller.ts:380-424`) — remove and let exceptions surface.
- Category 4.6 wholesale — every device test regenerated against ngspice-harness reference data instead of hand-computed literals.
- `describeIfDll` runtime-gate sites (4.5) — convert to explicit "DLL missing" visible failure instead of `describe.skip`.
