# Phase 6: Directory Restructure

**Goal**: Directory layout reflects the unified architecture. `engine/` and `analog/` become peer directories under `solver/`, and the compilation front-end lives in `compile/`.

**Depends on**: Phase 5 (all consumer simplification complete).

**Nature**: Purely mechanical file moves + import updates. Zero behaviour change. Single commit.

---

## Move Plan

### Step 1: Create target directories

```
mkdir -p src/solver/digital src/solver/analog
```

### Step 2: Move files

| Source | Destination | Notes |
|--------|-------------|-------|
| `src/engine/*.ts` | `src/solver/digital/` | All 23 .ts files |
| `src/engine/__tests__/*.ts` | `src/solver/digital/__tests__/` | All test files |
| `src/analog/*.ts` | `src/solver/analog/` | All 37 .ts files |
| `src/analog/__tests__/*.ts` | `src/solver/analog/__tests__/` | All test files |
| `src/analog/transistor-models/` | `src/solver/analog/transistor-models/` | Subdirectory |
| `src/compile/coordinator.ts` | `src/solver/coordinator.ts` | SimulationCoordinator impl |
| `src/compile/coordinator-types.ts` | `src/solver/coordinator-types.ts` | SimulationCoordinator interface |

`src/compile/` keeps: `compile.ts`, `types.ts`, `partition.ts`, `extract-connectivity.ts`, `union-find.ts`, `index.ts`

### Step 3: Update import paths

**Categories of imports to update:**

1. **Internal imports within moved directories** — `./foo.js` stays the same (sibling files moved together).

2. **Cross-solver imports** (engine ↔ analog):
   - Before: `src/engine/foo.ts` imports `../analog/bar.js`
   - After: `src/solver/digital/foo.ts` imports `../analog/bar.js` — **SAME** (both under solver/)

3. **External → solver/digital** (files outside engine/ importing engine files):
   - Before: `../engine/foo.js` or `@/engine/foo`
   - After: `../solver/digital/foo.js` or `@/solver/digital/foo`

4. **External → solver/analog** (files outside analog/ importing analog files):
   - Before: `../analog/foo.js` or `@/analog/foo`
   - After: `../solver/analog/foo.js` or `@/solver/analog/foo`

5. **External → solver/coordinator** (files importing coordinator from compile/):
   - Before: `../compile/coordinator.js` or `@/compile/coordinator`
   - After: `../solver/coordinator.js` or `@/solver/coordinator`

6. **compile/ → solver/digital and solver/analog** (compile files importing engine/analog):
   - Before: `../engine/foo.js` or `../analog/foo.js`
   - After: `../solver/digital/foo.js` or `../solver/analog/foo.js`

7. **Vitest config** — update test patterns if they reference `src/engine/` or `src/analog/` paths.

8. **tsconfig paths** — update `@/` path aliases if configured.

9. **CLAUDE.md** — update file path references.

### Step 4: Update re-exports

- `src/compile/index.ts` — update coordinator re-exports to point to `../solver/coordinator.js`
- `src/headless/index.ts` — update any engine/analog re-exports

### Step 5: Run full test suite

`npm test` — must pass with same count as Phase 5 (7511+ passing, 4 pre-existing failures only).

---

## Wave Structure

### Wave 6.1: File moves + import updates (L)

Single large task. Best done by one agent with a systematic approach:
1. git mv all files
2. Global find-and-replace import paths
3. Fix any remaining broken imports
4. Run tests

### Wave 6.2: Verification (S)

- Run full test suite
- Verify no `src/engine/` or `src/analog/` source files remain (only empty dirs)
- Verify all imports resolve correctly

---

## Acceptance Criteria

- Zero .ts files in `src/engine/` or `src/analog/` (directories can be deleted)
- All imports resolve correctly
- Full test suite passes (7511+ tests, 4 pre-existing failures only)
- `git diff --stat` shows only renames (plus import path changes)
