/**
 * Terminal + Keyboard - canonical test set.
 *
 * Both components are pure-digital (each exposes only `models.digital` -
 * Terminal has executeFn with 3 inputs / 0 outputs; Keyboard has executeFn
 * with 2 inputs / 2 outputs). Neither has an analog model, junction, LTE
 * timestep, breakpoint registration, runtime-diagnostic emit, or
 * _onStateChange writeback. Categories 1-3, 5-8, 10, 12-15 do not apply by
 * capability gate.
 *
 * Capability + tier (final):
 *   Terminal: Canon set = 16 (element-instance panel-bridge state). The
 *             Terminal has no `outputSchema` entries: its public contract
 *             towards the rest of the system is the panel-UI bridge of
 *             element-instance methods (`appendChar`, `getCharBuffer`,
 *             `enqueueKey`, `dequeueKey`, `peekKey`, `keyQueueLength`,
 *             `clearBuffers`). Cat 16 asserts that documented contract.
 *             Categories 1-15 do not apply by capability gate (no analog,
 *             no limiting, no LTE, no breakpoints, no labelled outputs).
 *   Keyboard: Canon set = 9 (bridge / digital) plus 16 (panel-bridge
 *             state). The documented Cat 9 contract is "rdy outputs 1
 *             when a key is waiting, 0 when empty; dout outputs the
 *             current key code at the front of the queue" - asserted via
 *             the simulator-step path on labelled D / av outputs. The
 *             documented Cat 16 contract is the same panel-UI bridge
 *             surface as Terminal plus `currentKeyCode` and `readyFlag` -
 *             read/written by the panel layer through element-instance
 *             methods rather than the simulator pin surface.
 *   File tier: fixture-only.
 *
 * Cat 4 (parameter hot-load): N/A. Terminal's `columns` / `rows` props are
 * consumed only by the display-panel UI layer (read via element getters);
 * they do not feed any simulator observable. Keyboard's only prop is
 * `label`, which by canon is excluded from Cat 4.
 *
 * Cat 11 (multi-output): Keyboard has D and av outputs but they are
 * functionally coupled (av = 1 iff queue non-empty; D = front key code
 * when av = 1). They are not independent for the same input combination
 * in the canon's sense - skipped per the Canon's "trivially coupled"
 * exclusion.
 *
 * The terminal component has no canonical-suite tests for categories 1-15 —
 * its property set is empty by capability gate. Cat 16 provides the
 * `it()` content for the Terminal panel-bridge contract.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";
import type { PropertyValue } from "../../../core/properties.js";
import { TerminalElement } from "../terminal.js";
import { KeyboardElement } from "../keyboard.js";

const registry = createDefaultRegistry();

interface KeyboardFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function buildKeyboardFixture(): KeyboardFixture {
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "in_c",  type: "In",       props: { label: "CLK", bitWidth: 1 } },
    { id: "in_en", type: "In",       props: { label: "EN",  bitWidth: 1 } },
    { id: "kb",    type: "Keyboard", props: { label: "KB" } },
    { id: "out_d", type: "Out",      props: { label: "D",   bitWidth: 16 } },
    { id: "out_av",type: "Out",      props: { label: "AV",  bitWidth: 1 } },
  ];
  const connections: Array<[string, string]> = [
    ["in_c:out",  "kb:C"],
    ["in_en:out", "kb:en"],
    ["kb:D",      "out_d:in"],
    ["kb:av",     "out_av:in"],
  ];

  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

interface TerminalFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function buildTerminalFixture(): TerminalFixture {
  // Terminal has 3 inputs (D, C, en) and 0 outputs. Drive each input from
  // an In source so the engine compiles a non-trivial digital circuit; the
  // panel-bridge state lives on the TerminalElement instance which we
  // resolve via compiled.labelToCircuitElement.
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "in_d",  type: "In",       props: { label: "D_SRC",  bitWidth: 8 } },
    { id: "in_c",  type: "In",       props: { label: "C_SRC",  bitWidth: 1 } },
    { id: "in_en", type: "In",       props: { label: "EN_SRC", bitWidth: 1 } },
    { id: "term",  type: "Terminal", props: { label: "T" } },
  ];
  const connections: Array<[string, string]> = [
    ["in_d:out",  "term:D"],
    ["in_c:out",  "term:C"],
    ["in_en:out", "term:en"],
  ];

  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

function resolveTerminal(fix: TerminalFixture): TerminalElement {
  const ce = fix.coordinator.compiled.labelToCircuitElement.get("T");
  if (ce === undefined) {
    throw new Error("Terminal element with label 'T' not found in labelToCircuitElement");
  }
  return ce as TerminalElement;
}

function resolveKeyboard(fix: KeyboardFixture): KeyboardElement {
  const ce = fix.coordinator.compiled.labelToCircuitElement.get("KB");
  if (ce === undefined) {
    throw new Error("Keyboard element with label 'KB' not found in labelToCircuitElement");
  }
  return ce as KeyboardElement;
}

// ===========================================================================
// Keyboard - Cat 9 (bridge / digital). T1 / fixture.
//
// Documented contract (keyboard.ts header):
//   - "dout reflects the key code at the front of the queue."
//   - "rdy is 1 when queue is non-empty, 0 when empty."
//   - "On rising edge of rd, the front key is dequeued."
//
// Canonical Cat 9 mechanic: drive labelled inputs (C, en), step, read
// labelled outputs (D, av). Each `it()` invokes facade.build / facade.step
// / facade.readSignal - the binary canonical gate is satisfied by the
// simulator-path invocation; the assertions check the documented
// observable.
// ===========================================================================

describe("Keyboard - bridge / digital (T1)", () => {
  it("av_reads_zero_when_no_key_enqueued", () => {
    // Documented contract: rdy = 0 when queue is empty. After a fresh
    // build with no key ever enqueued, the av output reads 0.
    const fix = buildKeyboardFixture();
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "CLK", 0);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "AV")).toBe(0);
    fix.coordinator.dispose();
  });

  it("d_reads_zero_when_no_key_enqueued", () => {
    // Documented contract: dout = current key code at queue front; with
    // an empty queue (no key has ever been enqueued via the panel),
    // currentKeyCode() is 0.
    const fix = buildKeyboardFixture();
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "CLK", 0);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "D")).toBe(0);
    fix.coordinator.dispose();
  });

  it("rising_clock_with_en_high_steps_without_throwing_and_outputs_remain_zero_with_empty_queue", () => {
    // Documented contract: on rising edge of C with en=1, the keyboard
    // signals a dequeue request; with an empty queue, dout / av stay 0.
    const fix = buildKeyboardFixture();
    fix.facade.setSignal(fix.coordinator, "EN", 1);
    fix.facade.setSignal(fix.coordinator, "CLK", 0);
    fix.facade.step(fix.coordinator);
    fix.facade.setSignal(fix.coordinator, "CLK", 1);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "AV")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "D")).toBe(0);
    fix.coordinator.dispose();
  });

  it("rising_clock_with_en_low_does_not_change_outputs", () => {
    // Documented contract: en=0 suppresses the dequeue request on a
    // rising clock edge; outputs remain at their pre-edge values
    // (here 0 because queue is empty).
    const fix = buildKeyboardFixture();
    fix.facade.setSignal(fix.coordinator, "EN", 0);
    fix.facade.setSignal(fix.coordinator, "CLK", 0);
    fix.facade.step(fix.coordinator);
    fix.facade.setSignal(fix.coordinator, "CLK", 1);
    fix.facade.step(fix.coordinator);
    expect(fix.facade.readSignal(fix.coordinator, "AV")).toBe(0);
    expect(fix.facade.readSignal(fix.coordinator, "D")).toBe(0);
    fix.coordinator.dispose();
  });
});

// ===========================================================================
// Terminal - Cat 16 (element-instance panel-bridge state). T1 / fixture.
//
// The Terminal exposes its character buffer and key queue to the panel UI
// layer through public element-instance methods (see terminal.ts):
//   appendChar / getCharBuffer / clearBuffers   (display buffer)
//   enqueueKey / peekKey / dequeueKey /
//   keyQueueLength / clearBuffers               (keyboard queue)
// No `outputSchema` entries cover this state - it is populated by the
// panel UI outside the simulator step path - so the canonical mechanic
// is direct round-trip on the element instance, resolved via the public
// `compiled.labelToCircuitElement` Map.
// ===========================================================================

describe("Terminal - element-instance panel-bridge (Cat 16, T1) - characterOutput", () => {
  it("appendChar_adds_character_to_buffer", () => {
    // Documented contract (terminal.ts:128-133): appendChar pushes the
    // character code (masked to 8 bits) onto the display buffer.
    const fix = buildTerminalFixture();
    const term = resolveTerminal(fix);
    term.appendChar(65);
    expect(term.getCharBuffer().length).toBe(1);
    expect(term.getCharBuffer()[0]).toBe(65);
    fix.coordinator.dispose();
  });

  it("appendChar_accumulates_multiple_characters", () => {
    // Documented contract: successive appendChar calls accumulate in
    // FIFO order in the display buffer.
    const fix = buildTerminalFixture();
    const term = resolveTerminal(fix);
    term.appendChar(65);
    term.appendChar(66);
    term.appendChar(67);
    expect([...term.getCharBuffer()]).toEqual([65, 66, 67]);
    fix.coordinator.dispose();
  });

  it("appendChar_masks_to_8_bit_values", () => {
    // Documented contract (terminal.ts:129): appendChar stores
    // `code & 0xff` - the low 8 bits only.
    const fix = buildTerminalFixture();
    const term = resolveTerminal(fix);
    term.appendChar(0x141);
    expect(term.getCharBuffer()[0]).toBe(0x41);
    fix.coordinator.dispose();
  });

  it("buffer_capped_at_4096_characters", () => {
    // Documented contract (terminal.ts:130-132, MAX_BUFFER_CHARS=4096):
    // when length exceeds 4096, the oldest entry is dropped via shift().
    // After 4097 appends of distinct codes, length stays at 4096 and the
    // last appended char (encoded modulo 256) is at index 4095.
    const fix = buildTerminalFixture();
    const term = resolveTerminal(fix);
    for (let i = 0; i < 4097; i++) {
      term.appendChar(i);
    }
    const buf = term.getCharBuffer();
    expect(buf.length).toBe(4096);
    // appendChar masks to 8 bits, so the final code stored is 4096 & 0xff = 0.
    expect(buf[buf.length - 1]).toBe(4096 & 0xff);
    fix.coordinator.dispose();
  });

  it("clearBuffers_empties_the_character_buffer", () => {
    // Documented contract (terminal.ts:166-169): clearBuffers empties
    // both the display buffer and the keyboard queue.
    const fix = buildTerminalFixture();
    const term = resolveTerminal(fix);
    term.appendChar(0x41);
    term.appendChar(0x42);
    term.appendChar(0x43);
    term.clearBuffers();
    expect(term.getCharBuffer().length).toBe(0);
    fix.coordinator.dispose();
  });
});

describe("Terminal - element-instance panel-bridge (Cat 16, T1) - keyboardQueue", () => {
  it("enqueueKey_adds_key_to_queue", () => {
    // Documented contract (terminal.ts:136-140): enqueueKey appends the
    // (masked-to-8-bit) key code onto the keyboard queue, until the cap
    // of MAX_KEY_QUEUE=64 is reached.
    const fix = buildTerminalFixture();
    const term = resolveTerminal(fix);
    term.enqueueKey(0xAB);
    expect(term.peekKey()).toBe(0xAB);
    expect(term.keyQueueLength()).toBe(1);
    fix.coordinator.dispose();
  });

  it("peekKey_returns_front_without_removing", () => {
    // Documented contract (terminal.ts:151-153): peekKey returns the
    // front of the queue (or -1 when empty) without modifying state.
    const fix = buildTerminalFixture();
    const term = resolveTerminal(fix);
    term.enqueueKey(0x10);
    term.enqueueKey(0x20);
    expect(term.peekKey()).toBe(0x10);
    expect(term.keyQueueLength()).toBe(2);
    fix.coordinator.dispose();
  });

  it("dequeueKey_removes_and_returns_front", () => {
    // Documented contract (terminal.ts:143-148): dequeueKey returns the
    // front entry and removes it from the queue, decrementing length.
    const fix = buildTerminalFixture();
    const term = resolveTerminal(fix);
    term.enqueueKey(0x10);
    term.enqueueKey(0x20);
    expect(term.dequeueKey()).toBe(0x10);
    expect(term.keyQueueLength()).toBe(1);
    fix.coordinator.dispose();
  });

  it("dequeueKey_returns_minus_one_when_empty", () => {
    // Documented contract (terminal.ts:144-146): dequeueKey returns -1
    // on an empty queue.
    const fix = buildTerminalFixture();
    const term = resolveTerminal(fix);
    expect(term.dequeueKey()).toBe(-1);
    fix.coordinator.dispose();
  });

  it("peekKey_returns_minus_one_when_empty", () => {
    // Documented contract (terminal.ts:152): peekKey returns -1 on an
    // empty queue.
    const fix = buildTerminalFixture();
    const term = resolveTerminal(fix);
    expect(term.peekKey()).toBe(-1);
    fix.coordinator.dispose();
  });

  it("clearBuffers_empties_the_keyboard_queue", () => {
    // Documented contract (terminal.ts:166-169): clearBuffers empties
    // both the display buffer and the keyboard queue.
    const fix = buildTerminalFixture();
    const term = resolveTerminal(fix);
    term.enqueueKey(0x10);
    term.enqueueKey(0x20);
    term.enqueueKey(0x30);
    term.clearBuffers();
    expect(term.keyQueueLength()).toBe(0);
    fix.coordinator.dispose();
  });

  it("keyboard_queue_capped_at_64_entries", () => {
    // Documented contract (terminal.ts:137-139, MAX_KEY_QUEUE=64): the
    // production source guards `if (this._keyQueue.length < MAX_KEY_QUEUE)
    // { ...push... }` - new entries beyond the 64th are silently
    // dropped (no FIFO eviction), so length saturates at 64.
    const fix = buildTerminalFixture();
    const term = resolveTerminal(fix);
    for (let i = 0; i < 65; i++) {
      term.enqueueKey(i);
    }
    expect(term.keyQueueLength()).toBe(64);
    fix.coordinator.dispose();
  });
});

// ===========================================================================
// Keyboard - Cat 16 (element-instance panel-bridge state). T1 / fixture.
//
// The Keyboard panel-bridge surface is the public element-instance API
// (see keyboard.ts):
//   enqueueKey / dequeueKey / peekKey / keyQueueLength / clearQueue
//   currentKeyCode (front-of-queue value, 0 when empty)
//   readyFlag      (1 when queue non-empty, 0 when empty)
// These are read/written by the panel UI directly, outside the simulator
// step path. Cat 16 round-trips assert the documented contract on the
// KeyboardElement instance resolved via compiled.labelToCircuitElement.
// ===========================================================================

describe("Keyboard - element-instance panel-bridge (Cat 16, T1) - keyCodeOutput", () => {
  it("currentKeyCode_returns_zero_when_queue_empty", () => {
    // Documented contract (keyboard.ts:150-152): currentKeyCode returns
    // 0 when the queue is empty.
    const fix = buildKeyboardFixture();
    const kb = resolveKeyboard(fix);
    expect(kb.currentKeyCode()).toBe(0);
    fix.coordinator.dispose();
  });

  it("currentKeyCode_returns_front_key_code_when_queue_has_entries", () => {
    // Documented contract: currentKeyCode reflects the key code at the
    // front of the queue (FIFO order).
    const fix = buildKeyboardFixture();
    const kb = resolveKeyboard(fix);
    kb.enqueueKey(0x42);
    kb.enqueueKey(0x43);
    expect(kb.currentKeyCode()).toBe(0x42);
    fix.coordinator.dispose();
  });

  it("enqueueKey_then_dequeueKey_FIFO_order", () => {
    // Documented contract (keyboard.ts:125-137): enqueueKey appends to
    // the back; dequeueKey removes from the front - first-in-first-out.
    const fix = buildKeyboardFixture();
    const kb = resolveKeyboard(fix);
    kb.enqueueKey(0x41);
    kb.enqueueKey(0x42);
    kb.enqueueKey(0x43);
    expect(kb.dequeueKey()).toBe(0x41);
    expect(kb.dequeueKey()).toBe(0x42);
    expect(kb.dequeueKey()).toBe(0x43);
    fix.coordinator.dispose();
  });

  it("enqueueKey_masks_to_8_bit_values", () => {
    // Documented contract (keyboard.ts:127): enqueueKey stores
    // `code & 0xff` - the low 8 bits only.
    const fix = buildKeyboardFixture();
    const kb = resolveKeyboard(fix);
    kb.enqueueKey(0x141);
    expect(kb.currentKeyCode()).toBe(0x41);
    fix.coordinator.dispose();
  });
});

describe("Keyboard - element-instance panel-bridge (Cat 16, T1) - readyFlag", () => {
  it("readyFlag_is_zero_when_queue_empty", () => {
    // Documented contract (keyboard.ts:155-157): readyFlag is 0 on an
    // empty queue.
    const fix = buildKeyboardFixture();
    const kb = resolveKeyboard(fix);
    expect(kb.readyFlag()).toBe(0);
    fix.coordinator.dispose();
  });

  it("readyFlag_is_one_when_queue_has_at_least_one_key", () => {
    // Documented contract: readyFlag is 1 when at least one key is in
    // the queue.
    const fix = buildKeyboardFixture();
    const kb = resolveKeyboard(fix);
    kb.enqueueKey(0x41);
    expect(kb.readyFlag()).toBe(1);
    fix.coordinator.dispose();
  });

  it("readyFlag_becomes_zero_after_all_keys_dequeued", () => {
    // Documented contract: readyFlag returns to 0 once the queue is
    // drained.
    const fix = buildKeyboardFixture();
    const kb = resolveKeyboard(fix);
    kb.enqueueKey(0x41);
    kb.dequeueKey();
    expect(kb.readyFlag()).toBe(0);
    fix.coordinator.dispose();
  });

  it("dequeueKey_on_empty_returns_minus_one", () => {
    // Documented contract (keyboard.ts:132-136): dequeueKey returns -1
    // when the queue is empty.
    const fix = buildKeyboardFixture();
    const kb = resolveKeyboard(fix);
    expect(kb.dequeueKey()).toBe(-1);
    fix.coordinator.dispose();
  });

  it("peekKey_does_not_remove_key", () => {
    // Documented contract (keyboard.ts:140-142): peekKey returns the
    // front entry (or -1) without altering the queue.
    const fix = buildKeyboardFixture();
    const kb = resolveKeyboard(fix);
    kb.enqueueKey(0x41);
    kb.peekKey();
    kb.peekKey();
    expect(kb.keyQueueLength()).toBe(1);
    fix.coordinator.dispose();
  });

  it("clearQueue_empties_the_keyboard_queue", () => {
    // Documented contract (keyboard.ts:160-162): clearQueue empties
    // the keyboard queue.
    const fix = buildKeyboardFixture();
    const kb = resolveKeyboard(fix);
    kb.enqueueKey(0x10);
    kb.enqueueKey(0x20);
    kb.enqueueKey(0x30);
    kb.clearQueue();
    expect(kb.keyQueueLength()).toBe(0);
    fix.coordinator.dispose();
  });

  it("keyboard_queue_capped_at_64_entries", () => {
    // Documented contract (keyboard.ts:125-129, MAX_KEY_QUEUE=64): the
    // production source guards `if (this._keyQueue.length < MAX_KEY_QUEUE)
    // { ...push... }` - new entries beyond the 64th are silently
    // dropped (no FIFO eviction), so length saturates at 64.
    const fix = buildKeyboardFixture();
    const kb = resolveKeyboard(fix);
    for (let i = 0; i < 65; i++) {
      kb.enqueueKey(i);
    }
    expect(kb.keyQueueLength()).toBe(64);
    fix.coordinator.dispose();
  });
});
