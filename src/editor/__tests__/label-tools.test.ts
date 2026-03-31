/**
 * Tests for label-tools: autoNumberLabels.
 */

import { describe, it, expect } from 'vitest';
import { autoNumberLabels } from '../label-tools.js';
import { PropertyBag } from '@/core/properties.js';

// ---------------------------------------------------------------------------
// Stub element factory
// ---------------------------------------------------------------------------

function makeElement(typeId: string, label?: string) {
  const bag = new PropertyBag();
  if (label !== undefined) {
    bag.set('label', label);
  }
  return {
    typeId,
    instanceId: `${typeId}-${Math.random()}`,
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins: () => [],
    getProperties: () => bag,
    draw: () => {},
    getBoundingBox: () => ({ x: 0, y: 0, width: 2, height: 2 }),
    serialize: () => ({
      typeId,
      instanceId: 'x',
      position: { x: 0, y: 0 },
      rotation: 0 as const,
      mirror: false,
      properties: {},
    }),
    getAttribute: (name: string) => (bag.has(name) ? bag.get(name) : undefined),
  };
}

function getLabel(el: ReturnType<typeof makeElement>): string {
  const bag = el.getProperties();
  return bag.has('label') ? String(bag.get('label')) : '';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LabelTools — autoNumberLabels', () => {
  // -------------------------------------------------------------------------
  // B8: autoNumberLabels sequential numbering
  // -------------------------------------------------------------------------

  it('assigns sequential labels with prefix and start index', () => {
    const elements = [
      makeElement('Register', 'old0'),
      makeElement('Register', 'old1'),
      makeElement('Register', 'old2'),
    ];

    const cmd = autoNumberLabels(elements as any, 'R', 1);
    cmd.execute();

    expect(getLabel(elements[0]!)).toBe('R1');
    expect(getLabel(elements[1]!)).toBe('R2');
    expect(getLabel(elements[2]!)).toBe('R3');
  });

  // -------------------------------------------------------------------------
  // B9: autoNumberLabels undo restores originals
  // -------------------------------------------------------------------------

  it('undo restores original labels', () => {
    const elements = [
      makeElement('Register', 'old0'),
      makeElement('Register', 'old1'),
    ];

    const cmd = autoNumberLabels(elements as any, 'R', 0);
    cmd.execute();

    // After execute, labels should be changed
    expect(getLabel(elements[0]!)).toBe('R0');
    expect(getLabel(elements[1]!)).toBe('R1');

    // After undo, original labels should be restored
    cmd.undo();

    expect(getLabel(elements[0]!)).toBe('old0');
    expect(getLabel(elements[1]!)).toBe('old1');
  });
});
