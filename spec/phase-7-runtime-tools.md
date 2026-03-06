# Phase 7: Runtime Tools

**Depends on**: Phase 6
**Parallel with**: Phases 8, 9

## Overview

Data visualization, memory inspection, test authoring, and runtime interaction tools. These are the tools that make the simulator usable for teaching — students need to see signal values, inspect memory contents, step through time, and write/run tests.

## Binding Decisions

All decisions from `spec/shared-decisions.md` apply. Additionally:

- **CodeMirror 6 for the test editor.** Bundle cost (~150KB min+gzip) is acceptable. No runtime CDN dependency — bundled by Vite. Provides line numbers, syntax highlighting, bracket matching, find/replace.
- **Timing diagram supports click-to-jump time travel.** Uses the engine snapshot API (Phase 5.5, task 5.5.3) with 512KB ring buffer budget.
- **Hex editor uses virtualized scrolling.** Supports both small memories (256 bytes) and large ones (64KB+).
- **Batch test runner works in both browser and headless.** Browser: multi-file picker. Node.js: filesystem reads.
- **All tools render into panels** using the panel infrastructure from Phase 2 (floating or docked, draggable, resizable, closable).

## Reference Source

| What | Where |
|------|-------|
| Data table / measurement | `ref/Digital/src/main/java/de/neemann/digital/gui/components/data/` |
| Timing diagram | `ref/Digital/src/main/java/de/neemann/digital/gui/components/graphics/` |
| Memory hex editor | `ref/Digital/src/main/java/de/neemann/digital/gui/components/table/` |
| Test execution UI | `ref/Digital/src/main/java/de/neemann/digital/testing/` |
| Program loader | `ref/Digital/src/main/java/de/neemann/digital/gui/components/data/` |

---

## Wave 7.1: Data Visualization

### Task 7.1.1 — Data Table Panel

- **Description**: Live tabular view of all measured signals. Registers as a `MeasurementObserver` on the engine. Updates on each simulation step.

  Features:
  - Columns: signal name, current value
  - Rows: one per measured signal (probes + ordered inputs/outputs)
  - Configurable radix per signal (binary, decimal, hex) via right-click context menu
  - Live update during simulation (observer callback)
  - Sortable by name
  - Signal grouping by component type (inputs, outputs, probes)

- **Files to create**:
  - `src/runtime/data-table.ts` — `DataTablePanel` class implementing `MeasurementObserver`. Renders into a panel container.

- **Tests**:
  - `src/runtime/__tests__/data-table.test.ts::rendersSignals` — create with 3 signals, verify 3 rows rendered with names
  - `src/runtime/__tests__/data-table.test.ts::updatesOnStep` — call `onStep()`, verify values refreshed from engine
  - `src/runtime/__tests__/data-table.test.ts::radixSwitch` — switch signal from decimal to hex, verify display format changes
  - `src/runtime/__tests__/data-table.test.ts::onReset` — call `onReset()`, verify values cleared/reset

- **Acceptance criteria**:
  - Shows all measured signals with current values
  - Updates live during simulation
  - Radix configurable per signal
  - All tests pass

---

### Task 7.1.2 — Timing Diagram

- **Description**: Waveform view of signals over time with interactive features for teaching.

  Data model: append-only ring buffer per channel. Each sample records `{ time: number, value: number }`. Ring buffer sized to fill available history within the timing diagram's allocated memory.

  Rendering:
  - Digital signals (1-bit): square wave (high/low steps)
  - Multi-bit signals: bus-style hatched band with hex value annotated at each transition
  - Multi-channel stacked display (vertical stack, each channel has its own lane)
  - Time axis along the bottom with tick marks and labels

  Interactive features:
  - **Time cursor**: vertical crosshair following mouse. Tooltip shows exact time and all signal values at that point.
  - **Click-to-jump**: click a time point → restore engine state to that point via `engine.restoreSnapshot()`. The timing diagram finds the closest snapshot ID to the clicked time.
  - **Zoom**: mouse wheel zooms the time axis. Range from full history to individual gate delays.
  - **Pan**: click-drag scrolls through time history.

  Snapshot integration: the timing diagram calls `engine.saveSnapshot()` at configurable intervals (default: every clock edge or every N steps). Snapshots tagged with their time value for lookup during click-to-jump.

- **Files to create**:
  - `src/runtime/timing-diagram.ts` — `TimingDiagramPanel` class. Canvas-based rendering. MeasurementObserver integration.
  - `src/runtime/waveform-renderer.ts` — Drawing logic for digital and bus waveforms
  - `src/runtime/waveform-data.ts` — `WaveformChannel` ring buffer data structure, sample storage

- **Tests**:
  - `src/runtime/__tests__/timing-diagram.test.ts::recordsSamples` — step engine 10 times, verify 10 samples recorded per channel
  - `src/runtime/__tests__/timing-diagram.test.ts::ringBufferEviction` — fill buffer beyond capacity, verify oldest samples evicted
  - `src/runtime/__tests__/waveform-renderer.test.ts::digitalWaveform` — 1-bit signal [0,1,1,0] → verify square wave path segments drawn
  - `src/runtime/__tests__/waveform-renderer.test.ts::busWaveform` — multi-bit signal with transitions → verify hatched band and value annotations
  - `src/runtime/__tests__/timing-diagram.test.ts::snapshotTagging` — verify snapshots saved at configured intervals with correct time tags
  - `src/runtime/__tests__/timing-diagram.test.ts::clickToJump` — simulate click at time T, verify `restoreSnapshot()` called with closest snapshot ID

- **Acceptance criteria**:
  - Waveforms render correctly for both single-bit and multi-bit signals
  - Time cursor shows values at mouse position
  - Click-to-jump restores engine state to the clicked time point
  - Zoom and pan work smoothly
  - Snapshot intervals configurable
  - All tests pass

---

### Task 7.1.3 — Measurement Ordering

- **Description**: UI to select which signals appear in the data table and timing diagram, and in what order.

  Features:
  - List of all available signals with checkboxes (visible/hidden)
  - Drag handles to reorder
  - Persist ordering in circuit metadata (survives save/load)
  - "Show All" / "Hide All" buttons

- **Files to create**:
  - `src/runtime/measurement-order.ts` — `MeasurementOrderPanel` class. Manages the ordered list of visible signals. Emits change events to data table and timing diagram.

- **Tests**:
  - `src/runtime/__tests__/measurement-order.test.ts::initialOrder` — signals listed in default order (inputs, outputs, probes)
  - `src/runtime/__tests__/measurement-order.test.ts::reorder` — move signal from position 0 to position 2, verify order updated
  - `src/runtime/__tests__/measurement-order.test.ts::toggleVisibility` — hide signal, verify data table excludes it
  - `src/runtime/__tests__/measurement-order.test.ts::persistRoundTrip` — save ordering to circuit metadata, reload, verify ordering preserved

- **Acceptance criteria**:
  - Signal ordering is configurable via drag-and-drop
  - Visibility toggles work
  - Ordering persists in circuit metadata
  - Data table and timing diagram respect the ordering
  - All tests pass

---

### Task 7.1.4 — Scope Trigger Integration

- **Description**: Connect the `Scope` component's trigger mechanism to the timing diagram. Triggered recording mode: record data only when the trigger condition fires.

  Features:
  - Scope component declares trigger condition (edge/level on a specific signal)
  - When trigger fires, timing diagram begins recording for a configurable window
  - Pre-trigger buffer: keep N samples before the trigger (retrospective capture)
  - Trigger status indicator (armed, triggered, recording)

- **Files to create**:
  - `src/runtime/scope-trigger.ts` — `ScopeTrigger` class. Monitors trigger signal, controls recording state of timing diagram.

- **Tests**:
  - `src/runtime/__tests__/scope-trigger.test.ts::edgeTrigger` — signal transitions 0→1 → trigger fires, recording starts
  - `src/runtime/__tests__/scope-trigger.test.ts::levelTrigger` — signal held at 1 → trigger fires while high
  - `src/runtime/__tests__/scope-trigger.test.ts::preTriggerBuffer` — 10-sample pre-trigger buffer, trigger fires at sample 20, verify samples 10-20 captured before trigger point
  - `src/runtime/__tests__/scope-trigger.test.ts::noTrigger` — no Scope component → timing diagram records continuously (no trigger filtering)

- **Acceptance criteria**:
  - Edge and level triggers work
  - Pre-trigger buffer captures samples before the trigger
  - Recording starts/stops based on trigger state
  - All tests pass

---

## Wave 7.2: Memory & Data Tools

### Task 7.2.1 — Memory Hex Editor

- **Description**: Click a RAM/ROM/EEPROM component → open a hex editor dialog showing the full address space. Standard hex editor layout.

  Features:
  - Address column (hex addresses)
  - Hex bytes (grouped by data width)
  - ASCII decode column
  - Editable: click a byte, type new hex value → applies to engine's DataField backing store
  - Virtualized scrolling for large memories (only render visible rows)
  - Go-to-address input
  - Data width display options: 8-bit bytes, 16-bit words, 32-bit dwords

- **Files to create**:
  - `src/runtime/memory-editor.ts` — `MemoryEditorDialog` class. Opens as a floating panel. Takes a DataField reference.
  - `src/runtime/hex-grid.ts` — Virtualized hex grid renderer. Renders only visible rows.

- **Tests**:
  - `src/runtime/__tests__/memory-editor.test.ts::displaysData` — open editor on 256-byte DataField, verify first row shows addresses 0x00-0x0F with correct values
  - `src/runtime/__tests__/memory-editor.test.ts::editByte` — edit byte at address 0x10, verify DataField updated
  - `src/runtime/__tests__/memory-editor.test.ts::virtualScroll` — 64KB DataField, scroll to address 0xFF00, verify correct row displayed without rendering all rows
  - `src/runtime/__tests__/memory-editor.test.ts::goToAddress` — enter "0x100" in go-to field, verify view scrolls to that address
  - `src/runtime/__tests__/memory-editor.test.ts::dataWidthSwitch` — switch from 8-bit to 16-bit display, verify columns re-render

- **Acceptance criteria**:
  - Hex editor displays memory contents correctly
  - Edits apply to simulation state
  - Virtualized scrolling handles large memories
  - All tests pass

---

### Task 7.2.2 — Live Memory Viewer

- **Description**: Hex editor contents update in real-time during simulation. Extends the memory editor with live update capability.

  Features:
  - Registers as MeasurementObserver
  - On each step, refreshes visible memory addresses
  - Highlights addresses that changed since last step (transient highlight color)
  - Can be paused (stop live updates for manual inspection)

- **Files to modify**:
  - `src/runtime/memory-editor.ts` — Add `enableLiveUpdate(engine: SimulationEngine): void`, `disableLiveUpdate(): void`. When live, registers as MeasurementObserver and refreshes visible rows on each step.

- **Tests**:
  - `src/runtime/__tests__/memory-viewer.test.ts::liveUpdate` — enable live, step engine, verify displayed values refreshed
  - `src/runtime/__tests__/memory-viewer.test.ts::changedHighlight` — step engine (value at 0x10 changes), verify address 0x10 has highlight styling
  - `src/runtime/__tests__/memory-viewer.test.ts::pauseLive` — disable live update, step engine, verify display NOT updated

- **Acceptance criteria**:
  - Memory contents update in real-time during simulation
  - Changed addresses visually highlighted
  - Live update can be paused
  - All tests pass

---

### Task 7.2.3 — Program Memory Loader

- **Description**: Load binary/hex data into memory components from files. Also serves as the backend for the `digital-load-memory` postMessage command.

  Supported formats:
  - Intel HEX (`.hex`, `.ihex`)
  - Raw binary
  - CSV (address, value pairs)
  - Logisim format (v2.0 raw, v3.0 raw)

  Features:
  - File picker dialog (browser) or file path (Node.js)
  - Format auto-detection from file extension and content
  - Big-endian import option
  - Apply to selected memory component's DataField

- **Files to create**:
  - `src/runtime/program-loader.ts` — `loadProgram(data: ArrayBuffer | string, format: ProgramFormat, target: DataField): void`
  - `src/runtime/hex-parser.ts` — Intel HEX format parser
  - `src/runtime/program-formats.ts` — Format detection, CSV parser, Logisim parser, raw binary handler

- **Tests**:
  - `src/runtime/__tests__/program-loader.test.ts::intelHex` — parse Intel HEX string, verify DataField contains correct values at correct addresses
  - `src/runtime/__tests__/program-loader.test.ts::rawBinary` — load raw binary, verify sequential byte loading
  - `src/runtime/__tests__/program-loader.test.ts::csv` — parse `"0x00,0xFF\n0x01,0xAB"`, verify values at addresses
  - `src/runtime/__tests__/program-loader.test.ts::logisimV2` — parse Logisim v2.0 raw format
  - `src/runtime/__tests__/program-loader.test.ts::formatDetection` — `.hex` → Intel HEX, `.bin` → raw binary, `.csv` → CSV
  - `src/runtime/__tests__/program-loader.test.ts::bigEndian` — load with big-endian option, verify byte order swapped

- **Acceptance criteria**:
  - All four formats load correctly
  - Format auto-detection works
  - Big-endian option works
  - Loaded data applies to DataField
  - All tests pass

---

### Task 7.2.4 — Single Value Dialog

- **Description**: Click a wire or pin → popup showing the signal value in all radix formats. Optionally override the value.

  Features:
  - Display: binary, decimal (unsigned), decimal (signed), hexadecimal
  - Bit width shown
  - HIGH_Z indication
  - Override: text input to set a new value (calls `engine.setSignalValue()`)
  - Dismisses on click outside or Escape

- **Files to create**:
  - `src/runtime/value-dialog.ts` — `SingleValueDialog` class. Positioned near the clicked wire/pin.

- **Tests**:
  - `src/runtime/__tests__/value-dialog.test.ts::displayFormats` — value 0xFF, 8-bit → shows "11111111", "255", "-1", "FF"
  - `src/runtime/__tests__/value-dialog.test.ts::highZ` — HIGH_Z value → shows "High-Z" indication
  - `src/runtime/__tests__/value-dialog.test.ts::override` — enter "0x42" in override field, verify engine.setSignalValue called with 0x42
  - `src/runtime/__tests__/value-dialog.test.ts::bitWidth` — 16-bit signal → shows "16 bits"

- **Acceptance criteria**:
  - All radix formats displayed correctly
  - HIGH_Z displayed correctly
  - Value override works
  - All tests pass

---

## Wave 7.3: Test Authoring

### Task 7.3.1 — Test Case Editor

- **Description**: Code editor panel for writing/editing truth table test vectors. Uses CodeMirror 6 with custom syntax highlighting for Digital's test format.

  Features:
  - CodeMirror 6 editor with custom language mode for Digital test syntax
  - Syntax highlighting: signal names (header), values, keywords (loop, repeat, bits), comments
  - Line numbers, bracket matching
  - Save: writes test data into the circuit's `Testcase` component
  - "Run" button (triggers test execution inline)
  - Error underlines for syntax errors (feedback from parser)

  CodeMirror language mode highlights:
  - Comments (`#...`) → comment color
  - Keywords (`loop`, `end loop`, `repeat`, `bits`) → keyword color
  - Values (`0`, `1`, `X`, `C`, `Z`, hex literals) → value color
  - Signal names (first line) → identifier color

- **Files to create**:
  - `src/testing/test-editor.ts` — `TestEditorPanel` class wrapping CodeMirror instance
  - `src/testing/test-language.ts` — CodeMirror 6 language support for Digital test syntax (tokenizer, highlighting rules)

- **Files to modify**:
  - `package.json` — Add `@codemirror/state`, `@codemirror/view`, `@codemirror/language` dependencies

- **Tests**:
  - `src/testing/__tests__/test-editor.test.ts::createEditor` — create editor, verify CodeMirror instance mounted
  - `src/testing/__tests__/test-editor.test.ts::setContent` — set editor content to test string, verify getText() returns it
  - `src/testing/__tests__/test-language.test.ts::tokenizeComment` — `# comment` → classified as comment
  - `src/testing/__tests__/test-language.test.ts::tokenizeKeyword` — `loop(3)` → `loop` classified as keyword
  - `src/testing/__tests__/test-language.test.ts::tokenizeHexValue` — `0xFF` classified as value
  - `src/testing/__tests__/test-editor.test.ts::saveToTestcase` — edit content, save, verify Testcase component's test data updated

- **Acceptance criteria**:
  - CodeMirror editor mounts and works
  - Syntax highlighting correct for all token types
  - Save writes data to Testcase component
  - All tests pass

---

### Task 7.3.2 — Run All Tests (F11)

- **Description**: Batch-execute every `Testcase` component in the circuit. Keyboard shortcut F11.

  Features:
  - Finds all Testcase components in the current circuit
  - Runs each through the test executor (Phase 6)
  - Shows summary: "All Tests: 45/50 passed (3 test cases)"
  - Links to per-testcase results in the test results panel (Phase 6)
  - Status bar indicator: green checkmark (all pass) or red X (failures)

- **Files to create**:
  - `src/testing/run-all.ts` — `runAllTests(facade, engine, circuit): AggregateTestResults`. Iterates Testcase components, runs each, aggregates.

- **Tests**:
  - `src/testing/__tests__/run-all.test.ts::multipleTestcases` — circuit with 3 Testcase components → all 3 executed, results aggregated
  - `src/testing/__tests__/run-all.test.ts::summaryCorrect` — 2 testcases: one with 5/5 pass, one with 3/5 pass → aggregate shows 8/10
  - `src/testing/__tests__/run-all.test.ts::noTestcases` — circuit with no Testcase components → returns empty results (not an error)
  - `src/testing/__tests__/run-all.test.ts::shortcutTriggered` — F11 keydown event triggers run-all

- **Acceptance criteria**:
  - All Testcase components found and executed
  - Aggregate results correct
  - F11 keyboard shortcut works
  - All tests pass

---

### Task 7.3.3 — Batch Test Runner

- **Description**: Run tests across multiple .dig files. In browser: multi-file picker. In headless: filesystem reads. Useful for grading student submissions.

  Features:
  - Browser: `<input type="file" multiple>` to select .dig files
  - Headless: `runBatchTests(filePaths: string[], testData?: string): BatchTestResults`
  - Per-file results: file name, pass/fail counts, errors
  - Aggregate summary across all files
  - Support for external test vectors (same test data applied to all files)

  ```typescript
  interface BatchTestResults {
    totalFiles: number;
    passedFiles: number;
    failedFiles: number;
    errorFiles: number;
    results: FileTestResult[];
  }

  interface FileTestResult {
    fileName: string;
    status: 'passed' | 'failed' | 'error';
    testResults?: TestResults;
    error?: string;
  }
  ```

- **Files to create**:
  - `src/testing/batch-runner.ts` — `runBatchTests(facade, files: Map<string, string>, testData?: string): BatchTestResults`. Takes a map of filename → content.

- **Tests**:
  - `src/testing/__tests__/batch-runner.test.ts::multipleFiles` — 3 files, all pass → `passedFiles: 3`
  - `src/testing/__tests__/batch-runner.test.ts::mixedResults` — 2 pass, 1 fail → correct counts
  - `src/testing/__tests__/batch-runner.test.ts::errorFile` — 1 file has invalid XML → `status: 'error'` with error message, other files still tested
  - `src/testing/__tests__/batch-runner.test.ts::externalTestData` — external test vectors applied to all files

- **Acceptance criteria**:
  - Batch testing works for multiple files
  - External test vectors supported
  - Errors in one file don't block others
  - All tests pass

---

### Task 7.3.4 — Behavioral Fixture Generator

- **Description**: Auto-generate a test template from a circuit's I/O. Extracts input and output signal names, creates a skeleton test with headers pre-filled and example rows.

  Generated template:
  ```
  # Auto-generated test template for: <circuit name>
  # Fill in expected output values, then run tests
  <input1> <input2> ... <output1> <output2> ...
  0        0            X         X
  0        1            X         X
  1        0            X         X
  1        1            X         X
  ```

  For circuits with ≤4 single-bit inputs, generates all 2^N combinations. For larger circuits, generates a partial template with representative rows.

- **Files to create**:
  - `src/testing/fixture-generator.ts` — `generateTestFixture(circuit: Circuit): string`

- **Tests**:
  - `src/testing/__tests__/fixture-generator.test.ts::headerLine` — circuit with inputs A, B and output Y → header line `A B Y`
  - `src/testing/__tests__/fixture-generator.test.ts::exhaustive2bit` — 2 single-bit inputs → 4 rows with all combinations
  - `src/testing/__tests__/fixture-generator.test.ts::partial5bit` — 5 single-bit inputs → partial template (not all 32 rows)
  - `src/testing/__tests__/fixture-generator.test.ts::dontCareOutputs` — all output values are `X` (don't-care placeholder)

- **Acceptance criteria**:
  - Template includes correct signal names
  - Exhaustive generation for small circuits
  - Partial generation for larger circuits
  - Output values are don't-care placeholders
  - All tests pass
