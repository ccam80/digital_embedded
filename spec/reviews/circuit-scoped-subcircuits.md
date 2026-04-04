# Review Report: Circuit-Scoped Subcircuit Resolution

## Summary

- **Tasks reviewed**: All 7 waves (1a, 1b, 1c, 2/A1–A6, 3a, 3b, 4a, 4b, 4c, 5a, 5b, 6a, 6b, 6c, 7)
- **Violations**: 5 (0 critical, 3 major, 2 minor)
- **Gaps**: 4
- **Weak tests**: 1
- **Legacy references**: 3
- **Verdict**: `has-violations`

---

## Violations

### V1 — Major | Historical-Provenance Comment in `subcircuit-loader.ts`

**File:** `src/io/subcircuit-loader.ts` lines 1–55  
**Rule violated:** rules.md — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."

**Evidence (lines 44–54):**
```
 * For each element whose name is not found in the built-in registry:
 *   1. Use resolver.resolve(name) to get the .dig XML
 *   2. Parse and recursively load the subcircuit (cycle + depth checks)
 *   3. Register a new ComponentDefinition in the registry
 *   4. Cache the loaded Circuit so duplicate references are free
 *
 * @param xml       The root .dig XML string
 * @param resolver  FileResolver used for unknown element names
 * @param registry  ComponentRegistry to look up and extend with subcircuits
 * @returns         Populated Circuit with all subcircuits registered
```

The file-level JSDoc and `loadWithSubcircuits` JSDoc still describe the **old** global-registry-mutating behaviour: "Register a new ComponentDefinition in the registry", "to look up and extend with subcircuits", "Populated Circuit with all subcircuits registered". The actual implementation no longer touches the registry for subcircuits — it accumulates into `collectedDefs` and attaches to `circuit.metadata.subcircuits`. These comments are historical-provenance: they describe what the function **used to do**, not what it does now. Per the rules this is banned regardless of whether the body is correct.

---

### V2 — Major | Historical-Provenance Comment in `scripts/mcp/circuit-tools.ts`

**File:** `scripts/mcp/circuit-tools.ts` line 57  
**Rule violated:** rules.md — "No historical-provenance comments."

**Evidence:**
```typescript
// Legacy .dig XML format
```

The comment labels `.dig` as "Legacy". `.dig` is a current supported format, not a legacy one. This comment describes a historical relationship between formats (implying .dts replaced .dig), which is exactly the kind of historical-provenance description the rules ban.

---

### V3 — Major | `palette.ts` `filter()` method does not merge circuit-scoped subcircuits

**File:** `src/editor/palette.ts` lines 244–261  
**Rule violated:** spec section Wave 6c — "Palette reads from `registry.getByCategory(SUBCIRCUIT)` + `circuit.metadata.subcircuits`. The latter takes priority."

**Evidence:**
```typescript
filter(query: string): PaletteNode[] {
  // ...
  for (const category of CATEGORIES_ANALOG) {
    const cat = category as ComponentCategory;
    const all = this._applyAllowlist(this._registry.getByCategory(cat));
    // ...
  }
```

`getTree()` correctly merges circuit-scoped subcircuits into the SUBCIRCUIT category node (lines 186–197). The `filter()` method does not — it only calls `this._registry.getByCategory(cat)` with no circuit-scoped merge. A user searching for an imported subcircuit by name will not find it through the search path. The spec requires both registry AND circuit-scoped sources to feed the palette; the filter path is a gap in the implementation.

---

### V4 — Minor | `postmessage-adapter.ts` `_handleImportSubcircuit()` does not handle `.dig` with nested subcircuits

**File:** `src/io/postmessage-adapter.ts` lines 673–678  
**Rule violated:** spec section Wave 5b — format detection; the spec notes the UI load path must handle both formats equivalently.

**Evidence:**
```typescript
} else {
  const { loadDig } = await import('./dig-loader.js');
  subCircuit = loadDig(data, this._registry);
}
```

For `.dig` content, the adapter uses `loadDig()` (flat load — no resolver, no recursive subcircuit resolution). The facade `importSubcircuit()` at `src/headless/default-facade.ts:271–278` correctly uses `loadWithSubcircuits` when a resolver is provided and falls back to `loadDig` only when no resolver is available. The postMessage path always takes the `loadDig` branch, silently dropping nested subcircuit references in imported `.dig` files. This is a spec divergence: the postMessage surface does not match the headless facade surface.

---

### V5 — Minor | `dts-deserializer.ts` comment describes ordering change

**File:** `src/io/dts-deserializer.ts` lines 299–315  
**Rule violated:** rules.md — "No historical-provenance comments."

**Evidence (lines 299–315):**
```typescript
// Deserialize subcircuit definitions FIRST so they are available as
// circuit-scoped definitions when the main circuit's elements are created.
...
// Deserialize the main circuit, passing subcircuit defs so they are
// set on circuit.metadata before elements are created. This lets
// resolveComponentDef() find subcircuit types during createElement().
```

The comment "FIRST" and the explanation about ordering context explains **why the code was changed** relative to a prior design. Per the rules, comments must only explain complicated code to future developers — not describe what the ordering change replaced or why the ordering was different before. The word "FIRST" in all caps signals historical contrast.

---

## Gaps

### G1 — E2E surface test for `sim-import-subcircuit` missing

**Spec requirement (Wave 5b):** "E2E: `sim-import-subcircuit` postMessage, verify placement mode, verify palette refresh"  
**CLAUDE.md Three-Surface Testing Rule:** "Every user-facing feature MUST be tested across all three surfaces: Headless API test, MCP tool test, E2E / UI test."

**What was found:** No E2E test file covers `sim-import-subcircuit`. Searching `e2e/**/*.spec.ts` for `sim-import-subcircuit` or `importSubcircuit` returns no matches. The headless and MCP surfaces have tests; the E2E / postMessage parity surface does not.

**File:** `e2e/` — no file exists

---

### G2 — `deserializeDts()` return type still described as returning `{ circuit, subcircuits }` in Wave 3b comment

**Spec requirement (Wave 3b):** "The returned `{ circuit, subcircuits }` tuple is vestigial — subcircuits now live on `circuit.metadata.subcircuits`. Change return to just `Circuit`."

**What was found:** The implementation correctly returns `Circuit`. However, the JSDoc at `src/io/dts-deserializer.ts:277–286` still says: "Returns the main circuit and a map of subcircuit names to Circuit objects. The subcircuits map is empty when the document has no `subcircuitDefinitions`." This is a stale docstring describing the old tuple return contract — the function now returns only `Circuit`. The consumers listed in the spec (postmessage-adapter, file-io-controller) have been updated, but the JSDoc itself still documents the removed tuple return, creating a contract mismatch in the public API docs.

**File:** `src/io/dts-deserializer.ts` lines 277–286

---

### G3 — `serializeWithSubcircuits()` not deprecated or removed as specified

**Spec requirement (Wave 3a):** "`serializeWithSubcircuits()` (line 289) can be deprecated or become a thin wrapper."

**What was found:** Searching `src/io/dts-serializer.ts` for `serializeWithSubcircuits` finds no such function. This means either it was removed (acceptable per the spec's "scorched earth" rule) or was never present in this form. If removed — this is a non-issue. If the spec referred to a function that existed before this implementation session, its absence needs to be confirmed as intentional removal rather than oversight. Given no exports referencing `serializeWithSubcircuits` exist anywhere in the codebase, it was either removed cleanly or the spec's line number reference was imprecise. Noting for completeness as a gap to confirm.

**File:** `src/io/dts-serializer.ts`

---

### G4 — Wave 6a menu-toolbar uses `loadDig` (flat) instead of `loadWithSubcircuits` for `.dig` imports

**Spec requirement (Wave 6a):** "Parse file -> create `SubcircuitDefinition` -> store on circuit metadata -> Enter `placement.start(definition)` for immediate placement"

**What was found:** `src/app/menu-toolbar.ts` line 164:
```typescript
const { loadDig } = await import('../io/dig-loader.js');
subCircuit = loadDig(text, ctx.registry);
```

The UI import path uses `loadDig` (flat, no resolver) for `.dig` files. A multi-level subcircuit `.dig` file imported through the "Import Subcircuit..." menu item will silently fail to resolve nested references. The spec does not explicitly call for `loadWithSubcircuits` here, but `loadDig` without a resolver contradicts the intent of the import feature (which is to bring in complete subcircuit definitions). The headless facade's `importSubcircuit()` uses `loadWithSubcircuits` when a resolver is available. The UI path has no resolver at all. This creates an inconsistency between surfaces.

**File:** `src/app/menu-toolbar.ts` lines 161–166

---

## Weak Tests

### WT1 — `subcircuit-loader.test.ts` — `subEl.definition` assertion trivially weak

**Test path:** `src/io/__tests__/subcircuit-loader.test.ts::subcircuit-loader::recursiveLoad — main .dig references sub .dig, resolver returns both, verify both loaded and registered`

**Evidence (lines 97–98):**
```typescript
expect(subEl.definition).toBeDefined();
expect(subEl.definition.circuit.elements).toHaveLength(3); // In, And, Out
```

The first assertion `expect(subEl.definition).toBeDefined()` is a weak "is not null" check. It passes trivially if `SubcircuitElement` always initialises `definition` (which it does — it's required in the constructor). The second assertion `toHaveLength(3)` is behaviorally meaningful, but the first contributes nothing beyond a pass/fail of the cast. Not a blocking concern but flagged per the rules requirement.

---

## Legacy References

### LR1 — `src/io/subcircuit-loader.ts` lines 1–55 — file-level JSDoc describes old registry-mutation behaviour

**Evidence:**
```
 *   3. Register a new ComponentDefinition in the registry
```
and:
```
 * @param registry  ComponentRegistry to look up and extend with subcircuits
 * @returns         Populated Circuit with all subcircuits registered
```

These strings describe the removed global registry mutation path. They are stale references to the old design.

---

### LR2 — `src/io/subcircuit-loader.ts` lines 44–50 — `loadWithSubcircuits` JSDoc describes old registry-mutation behaviour

**Evidence:**
```
 *   3. Register a new ComponentDefinition in the registry
 *   4. Cache the loaded Circuit so duplicate references are free
```

and JSDoc parameter:
```
 * @returns         Populated Circuit with all subcircuits registered
```

The function no longer registers into the registry. "All subcircuits registered" is false; they are accumulated into `collectedDefs` and attached to `circuit.metadata.subcircuits`.

---

### LR3 — `scripts/mcp/circuit-tools.ts` line 57 — "Legacy .dig XML format"

**Evidence:**
```typescript
// Legacy .dig XML format
```

`.dig` is a current supported input format. Labeling it "legacy" is a stale reference to the historical relationship between formats that implies .dig has been deprecated or superseded.
