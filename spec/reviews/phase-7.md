# Review Report: Phase 7 — Runtime Tools

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 12 (7.1.1, 7.1.2, 7.1.3, 7.1.4, 7.2.1, 7.2.2, 7.2.3, 7.2.4, 7.3.1, 7.3.2, 7.3.3, 7.3.4) |
| Violations — critical | 0 |
| Violations — major | 1 |
| Violations — minor | 3 |
| Gaps | 2 |
| Weak tests | 14 |
| Legacy references | 1 |
| Verdict | has-violations |

---

## Violations

### Violation 1 — Major
- **File**: `src/testing/run-all.ts`
- **Line**: 34
- **Rule violated**: Code Hygiene — no historical-provenance comments; comments may not describe backwards compatibility
- **Quoted evidence**:
  ```
  * Returns 0 if no In elements are found, which causes parseTestData to treat
  * all columns as inputs (backward-compatible behavior).
  ```
- **Severity**: major
- **Explanation**: The phrase "backward-compatible behavior" in a JSDoc comment describes what happens when the code falls back to a prior behavior. This is a historical-provenance comment — it explains why the code does what it does in terms of backwards compatibility, which the rules explicitly ban. The phrase "backward-compatible" also directly matches the banned pattern. A justification comment next to code that soft-degrades behavior (returning 0 to trigger a fallback path) makes the violation worse, not better.

---

### Violation 2 — Minor
- **File**: `src/runtime/value-dialog.ts`
- **Line**: 149
- **Rule violated**: Code Hygiene — comments explain complicated code, not describe behaviour choices
- **Quoted evidence**:
  ```typescript
  // Hexadecimal (strip leading "0x" prefix added by BitVector.toString)
  const hexStr = value.toString("hex").replace(/^0x/i, "");
  ```
- **Severity**: minor
- **Explanation**: The comment describes an implementation detail about what `BitVector.toString` returns, which is implementation-provenance information. The spec requires the hex display to show just the hex digits (e.g. "FF"), and the code achieves this, but the comment explains the stripping in terms of what another function does internally. This is describing how code interacts with internals rather than explaining a non-obvious algorithm. It is borderline but errs toward a violation per the strict reading of the rule.

---

### Violation 3 — Minor
- **File**: `src/testing/run-all.ts`
- **Lines**: 31–34
- **Rule violated**: Code Hygiene — no `pass`, no `raise NotImplementedError`, no `# TODO`; completeness
- **Quoted evidence**:
  ```typescript
  * Returns 0 if no In elements are found, which causes parseTestData to treat
  * all columns as inputs (backward-compatible behavior).
  ```
  And the function:
  ```typescript
  function countInputs(circuit: Circuit): number {
    return circuit.elements.filter((el) => el.typeId === 'In').length;
  }
  ```
- **Severity**: minor
- **Explanation**: The `countInputs` helper is an undocumented internal function that exists to feed `parseTestData`. It is not part of the spec for task 7.3.2. The spec says `runAllTests` takes a `facade`, `engine`, and `circuit`, iterates Testcase components, and calls the parser and executor. The internal `countInputs` call to decide `inputCount` for `parseTestData` is undocumented scope that may introduce incorrect behavior when a circuit has both In elements and Testcase components but no clear input-count convention.

---

### Violation 4 — Minor
- **File**: `src/testing/test-language.ts`
- **Lines**: 229–231
- **Rule violated**: Code Hygiene — no historical-provenance comments; comments must explain complex code, not restate what's already obvious
- **Quoted evidence**:
  ```typescript
  // Loop variable references and other identifiers after the header
  return 'variableName';
  ```
- **Severity**: minor
- **Explanation**: Non-keyword, non-value-token identifiers after the header are classified as `variableName`. This fallback is the same result as the header-line path above it (line 227: `return 'variableName'`). The comment "Loop variable references and other identifiers after the header" is not explaining complex logic — it is simply restating what the code does in slightly different words. This constitutes a trivial description comment that adds no explanatory value for developers reading complicated code. The two identical `return 'variableName'` arms (lines 228 and 231) would be clearer if merged, but the comment suggests the agent was aware of the duplicate and justified it with a comment instead of fixing it.

---

## Gaps

### Gap 1 — Task 7.1.2 (Timing Diagram): Missing time cursor with tooltip
- **Spec requirement**: "Time cursor: vertical crosshair following mouse. Tooltip shows exact time and all signal values at that point."
- **What was found**: `src/runtime/timing-diagram.ts` implements pan and click-to-jump via mouse events (`_onMouseDown`, `_onMouseMove`, `_onMouseUp`, `_onClick`). There is no `_onMouseMove` code path that draws or updates a vertical crosshair cursor. There is no tooltip element created or positioned at the cursor position. The `_onMouseMove` handler only performs pan logic when `_isDragging` is true, and does nothing when the mouse moves without dragging.
- **File**: `src/runtime/timing-diagram.ts`

### Gap 2 — Task 7.1.2 (Timing Diagram): Missing time cursor test
- **Spec requirement**: Tests listed in the spec do not include a `timeCursor` test, but the acceptance criteria state "Time cursor shows values at mouse position." The spec acceptance criteria are binding. The implementation has no time cursor functionality and no test verifying it.
- **What was found**: Neither `src/runtime/__tests__/timing-diagram.test.ts` nor `src/runtime/timing-diagram.ts` contain any time cursor implementation or verification.
- **File**: `src/runtime/__tests__/timing-diagram.test.ts`

---

## Weak Tests

### Weak Test 1
- **Test path**: `src/runtime/__tests__/timing-diagram.test.ts::TimingDiagramPanel::recordsSamples::records one sample per channel per step`
- **Issue**: Checks `clkChannel).toBeDefined()` and `dataChannel).toBeDefined()` before accessing `.count`. These are trivially true — `getChannel` cannot return `undefined` for channels that were constructed in the panel initializer.
- **Quoted evidence**:
  ```typescript
  expect(clkChannel).toBeDefined();
  expect(dataChannel).toBeDefined();
  ```

### Weak Test 2
- **Test path**: `src/runtime/__tests__/waveform-renderer.test.ts::WaveformRenderer::digitalWaveform::draws square wave path segments for [0,1,1,0]`
- **Issue**: Uses `expect(moveToCommands.length).toBeGreaterThanOrEqual(1)` — this is trivially satisfied by any renderer that calls `moveTo` at all. It does not verify that the specific square-wave geometry is correct (e.g., that low-Y and high-Y transitions match expected coordinates).
- **Quoted evidence**:
  ```typescript
  const moveToCommands = ctx.commands.filter((c) => c.kind === "moveTo");
  expect(moveToCommands.length).toBeGreaterThanOrEqual(1);
  ```

### Weak Test 3
- **Test path**: `src/runtime/__tests__/waveform-renderer.test.ts::WaveformRenderer::busWaveform::draws top and bottom rails for bus signal`
- **Issue**: Uses `expect(moveToCommands.length).toBeGreaterThanOrEqual(2)` and `expect(lineToCommands.length).toBeGreaterThanOrEqual(2)`. These are very weak lower bounds that would be satisfied by almost any drawing implementation, even one that draws only two arbitrary lines. No rail coordinates are verified.
- **Quoted evidence**:
  ```typescript
  expect(moveToCommands.length).toBeGreaterThanOrEqual(2);
  const lineToCommands = ctx.commands.filter((c) => c.kind === "lineTo");
  expect(lineToCommands.length).toBeGreaterThanOrEqual(2);
  ```

### Weak Test 4
- **Test path**: `src/runtime/__tests__/waveform-renderer.test.ts::WaveformRenderer::busWaveform::annotates hex value in segment`
- **Issue**: Uses `expect(textCommands.length).toBeGreaterThan(0)` before the specific label check. The `length > 0` check is redundant with the `hasHexLabel` check that follows — if the label is not found, the test fails on the boolean check anyway. But if the code emits text for some other reason (e.g., axis labels leaking into the test), `length > 0` would pass spuriously.
- **Quoted evidence**:
  ```typescript
  expect(textCommands.length).toBeGreaterThan(0);
  ```

### Weak Test 5
- **Test path**: `src/runtime/__tests__/waveform-renderer.test.ts::WaveformRenderer::busWaveform::draws transition markers at value change points`
- **Issue**: Uses `expect(moveToNearTrans.length).toBeGreaterThan(0)`. The check finds moveTo commands near an x position but uses a 2-pixel tolerance without verifying that the y coordinates are at `bandTop` and `bandBot`. A renderer that draws a single diagonal at the right x position but at wrong y coordinates would pass.
- **Quoted evidence**:
  ```typescript
  expect(moveToNearTrans.length).toBeGreaterThan(0);
  ```

### Weak Test 6
- **Test path**: `src/runtime/__tests__/memory-editor.test.ts::HexGrid::generates correct first row for 256-byte DataField`
- **Issue**: Uses `expect(rows.length).toBeGreaterThanOrEqual(1)`. For a 256-byte DataField with 16 visible rows, this should assert `rows.length === 16`, not just `>= 1`.
- **Quoted evidence**:
  ```typescript
  expect(rows.length).toBeGreaterThanOrEqual(1);
  ```

### Weak Test 7
- **Test path**: `src/runtime/__tests__/memory-editor.test.ts::HexGrid::scrolls to address 0xFF00 in a 64KB DataField`
- **Issue**: Uses `expect(rows.length).toBeGreaterThanOrEqual(1)` and `expect(targetRow).toBeDefined()`. The first check is too weak; virtualization should render exactly `visibleRowCount` rows (16) unless at the very end of the memory. The second check (`toBeDefined`) does not assert any content, and the content check is done in a conditional block that silently passes if `targetRow` is undefined.
- **Quoted evidence**:
  ```typescript
  expect(rows.length).toBeGreaterThanOrEqual(1);
  ...
  expect(targetRow).toBeDefined();
  if (targetRow !== undefined) {
    const col = 0xFF00 - targetRow.baseAddress;
    expect(targetRow.hexCells[col]).toBe("AB");
  }
  ```

### Weak Test 8
- **Test path**: `src/runtime/__tests__/memory-editor.test.ts::MemoryEditorDialog::displaysData::renders hex-row elements for visible addresses`
- **Issue**: Uses `expect(rows.length).toBeGreaterThan(0)` instead of asserting the exact expected row count. For a 4096-word DataField with 16 visible rows, the test should assert `rows.length === 16`.
- **Quoted evidence**:
  ```typescript
  expect(rows.length).toBeGreaterThan(0);
  ```

### Weak Test 9
- **Test path**: `src/runtime/__tests__/memory-editor.test.ts::MemoryEditorDialog::virtualScroll::scrolls to address 0xFF00 in a 64KB DataField without rendering all rows`
- **Issue**: Uses `expect(rows.length).toBeGreaterThan(0)` — the point of the virtualization test is to confirm that significantly fewer than all 4096 rows are rendered. `> 0` does not verify this at all. Should assert `rows.length <= 16`.
- **Quoted evidence**:
  ```typescript
  expect(rows.length).toBeGreaterThan(0);
  ```

### Weak Test 10
- **Test path**: `src/runtime/__tests__/memory-viewer.test.ts::MemoryEditorDialog live update (Task 7.2.2)::liveUpdate::displayed values refresh after engine step when live update is active`
- **Issue**: Uses `expect(cellEl).not.toBeNull()` guarding the meaningful assertion inside an `if` block. If `cellEl` is null, the test passes without verifying that displayed values refreshed.
- **Quoted evidence**:
  ```typescript
  expect(cellEl).not.toBeNull();
  if (cellEl !== null) {
    expect((cellEl as unknown as StubElement).textContent).toBe("AA");
  }
  ```

### Weak Test 11
- **Test path**: `src/runtime/__tests__/memory-viewer.test.ts::MemoryEditorDialog live update (Task 7.2.2)::changedHighlight::address 0x10 cell gets hex-changed class when value changes during live step`
- **Issue**: Uses `expect(cellEl).not.toBeNull()` with the actual class check inside an `if` block. Same issue as Weak Test 10 — if `getCellElement(0x10)` returns null, the test passes vacuously without verifying the highlight.
- **Quoted evidence**:
  ```typescript
  expect(cellEl).not.toBeNull();
  if (cellEl !== null) {
    const stubCell = cellEl as unknown as StubElement;
    expect(stubCell.classList.contains("hex-changed")).toBe(true);
  }
  ```

### Weak Test 12
- **Test path**: `src/runtime/__tests__/value-dialog.test.ts::SingleValueDialog (Task 7.2.4)::displayFormats::shows binary, unsigned decimal, signed decimal, and hex for 0xFF 8-bit`
- **Issue**: Uses `expect(dlgEl).not.toBeNull()` but then unconditionally accesses `dlgEl` — the null guard has no effect because the code would throw on `allTextContent(dlgEl)` if it were null. Additionally, the binary check uses `.includes("11111111")` which would match even if the binary string were embedded in a larger string (e.g. "0b11111111X"), not an exact match of the expected "0b11111111" binary representation.
- **Quoted evidence**:
  ```typescript
  expect(dlgEl).not.toBeNull();
  ...
  expect(texts.some((t) => t.includes("11111111"))).toBe(true);
  ```

### Weak Test 13
- **Test path**: `src/testing/__tests__/batch-runner.test.ts::runBatchTests::errorFile::1 file has invalid XML → status: error with message, others still tested`
- **Issue**: Uses `expect(errResult!.error!.length).toBeGreaterThan(0)` to verify that an error message is present. This does not verify the error message content at all — any non-empty string passes. The spec requires the error field to contain meaningful diagnostic information.
- **Quoted evidence**:
  ```typescript
  expect(errResult!.error).toBeDefined();
  expect(errResult!.error!.length).toBeGreaterThan(0);
  ```

### Weak Test 14
- **Test path**: `src/testing/__tests__/test-language.test.ts::Digital test language tokenizer::tokenizeComment::inline comment after values → comment token at end`
- **Issue**: After finding the `commentToken`, only checks that `text.includes('#')` — it does not assert the full text of the inline comment. This would pass if only the `#` character were captured, not the full `# inline comment` text.
- **Quoted evidence**:
  ```typescript
  const commentToken = tokens.find((t) => t.token === 'comment');
  expect(commentToken).toBeDefined();
  expect(commentToken!.text).toContain('#');
  ```

---

## Legacy References

### Legacy Reference 1
- **File**: `src/testing/run-all.ts`
- **Line**: 34
- **Quoted evidence**:
  ```
  * all columns as inputs (backward-compatible behavior).
  ```
- **Explanation**: The phrase "backward-compatible behavior" references a compatibility path with older behavior (treating all columns as inputs when no `In` elements are found). This is a reference to a former behavioral mode, not a description of new, clean functionality. The phrasing implies the code is maintaining compatibility with a previous design rather than implementing a definitive new design.

---

## Detailed Notes

### Task 7.1.1 — Data Table Panel
Implementation is complete and correct. `DataTablePanel` implements `MeasurementObserver`, supports radix switching, sorting, grouping, and reset. All four spec-required test methods (`rendersSignals`, `updatesOnStep`, `radixSwitch`, `onReset`) are present and have meaningful assertions. No violations beyond those noted above.

### Task 7.1.2 — Timing Diagram
The time cursor feature (vertical crosshair + tooltip) is absent from both the implementation (`timing-diagram.ts`) and all tests. The remaining features (ring buffer, waveform rendering, snapshot tagging, click-to-jump, zoom, pan) are fully implemented with strong tests. The missing time cursor is a significant acceptance-criteria gap.

### Task 7.1.3 — Measurement Ordering
Fully implemented. `MeasurementOrderPanel` supports ordering, visibility toggles, show/hide all, change listeners, persistence via `toJSON`/`fromJSON`, and DOM rendering. All four spec tests are present. Implementation is clean.

### Task 7.1.4 — Scope Trigger
Fully implemented with edge and level trigger modes, pre-trigger buffer, recording window, and status listeners. All four spec tests (`edgeTrigger`, `levelTrigger`, `preTriggerBuffer`, `noTrigger`) are present with meaningful assertions.

### Task 7.2.1 — Memory Hex Editor
`MemoryEditorDialog` and `HexGrid` implemented correctly. Virtualization is functional. Five spec tests present. Several assertions use overly weak lower bounds (see Weak Tests section).

### Task 7.2.2 — Live Memory Viewer
`enableLiveUpdate`/`disableLiveUpdate` implemented in `memory-editor.ts`. Three spec tests (`liveUpdate`, `changedHighlight`, `pauseLive`) present. Two tests use guarded `if` blocks that can silently pass if cell lookup fails (see Weak Tests 10 and 11).

### Task 7.2.3 — Program Memory Loader
Intel HEX parser, CSV parser, Logisim parser, raw binary handler, and format detection all implemented and tested. All six spec tests present with specific, exact-value assertions. No violations.

### Task 7.2.4 — Single Value Dialog
`SingleValueDialog` implements all four display formats, HIGH_Z, override input, and Escape/outside-click dismissal. All four spec tests (`displayFormats`, `highZ`, `override`, `bitWidth`) present. Binary display check uses `.includes()` rather than an exact match (see Weak Test 12).

### Task 7.3.1 — Test Case Editor
`TestEditorPanel` wraps CodeMirror 6 with buffer-only mode for headless tests. `test-language.ts` provides both a CodeMirror `StreamLanguage` and a standalone `tokenizeLine` utility. All six spec tests present. Duplicate `return 'variableName'` arms with a justification comment noted (see Violation 4).

### Task 7.3.2 — Run All Tests (F11)
`runAllTests` and `registerRunAllShortcut` implemented. All four spec tests (`multipleTestcases`, `summaryCorrect`, `noTestcases`, `shortcutTriggered`) present. The "backward-compatible behavior" comment in `countInputs` is a rule violation (Violation 1).

### Task 7.3.3 — Batch Test Runner
`runBatchTests` implemented with per-file error isolation. All four spec tests (`multipleFiles`, `mixedResults`, `errorFile`, `externalTestData`) present. Error message content is not verified precisely (Weak Test 13).

### Task 7.3.4 — Behavioral Fixture Generator
`generateTestFixture` implemented with exhaustive (≤4 inputs) and partial (>4 inputs) generation strategies. All four spec tests (`headerLine`, `exhaustive2bit`, `partial5bit`, `dontCareOutputs`) present with exact assertions. Clean implementation.
