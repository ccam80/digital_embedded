/**
 * Tests for the 74xx IC library manifest and registration.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { LIBRARY_74XX, register74xxLibrary } from '../library-74xx.js';
import { parseDigXml } from '../../io/dig-parser.js';
import { ComponentRegistry, ComponentCategory } from '../../core/registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LIB_DIR = join(process.cwd(), 'lib', '74xx');

function readDigFile(filename: string): string {
  return readFileSync(join(LIB_DIR, filename), 'utf-8');
}

// ---------------------------------------------------------------------------
// manifestComplete
// ---------------------------------------------------------------------------

describe('library-74xx', () => {
  it('manifestComplete: manifest has entries for all .dig files in lib/74xx', () => {
    const filesOnDisk = readdirSync(LIB_DIR)
      .filter((f) => f.endsWith('.dig'))
      .sort();

    const manifestFiles = LIBRARY_74XX.map((e) => e.file).sort();

    // Every file on disk must be in the manifest
    const missingFromManifest = filesOnDisk.filter((f) => !manifestFiles.includes(f));
    expect(missingFromManifest).toEqual([]);

    // Every manifest entry must point to a file that exists on disk
    const missingFromDisk = manifestFiles.filter((f) => !filesOnDisk.includes(f));
    expect(missingFromDisk).toEqual([]);
  });

  it('manifestComplete: all manifest entries have non-empty name, description, and file', () => {
    for (const entry of LIBRARY_74XX) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.file.length).toBeGreaterThan(0);
      expect(entry.file.endsWith('.dig')).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // loadRepresentative — 7400 quad NAND
  // ---------------------------------------------------------------------------

  it('loadRepresentative: 7400 parses and contains 4 NAND gates', () => {
    const xml = readDigFile('7400.dig');
    const circuit = parseDigXml(xml);

    const nandGates = circuit.visualElements.filter(
      (el) => el.elementName === 'NAnd',
    );
    expect(nandGates.length).toBe(4);
  });

  it('loadRepresentative: 7400 description matches manifest', () => {
    const entry = LIBRARY_74XX.find((e) => e.name === '7400');
    expect(entry).toBeDefined();
    expect(entry!.description).toBe('quad 2-input NAND gate');
  });

  // ---------------------------------------------------------------------------
  // load7474 — dual D flip-flop pin layout
  // ---------------------------------------------------------------------------

  it('load7474: parses and contains D flip-flop elements', () => {
    const xml = readDigFile('7474.dig');
    const circuit = parseDigXml(xml);

    // 7474 is a dual D flip-flop; contains D_FF_AS elements
    const dffElements = circuit.visualElements.filter(
      (el) => el.elementName === 'D_FF_AS',
    );
    expect(dffElements.length).toBe(2);
  });

  it('load7474: has correct input and output pins', () => {
    const xml = readDigFile('7474.dig');
    const circuit = parseDigXml(xml);

    const inputs = circuit.visualElements.filter((el) => el.elementName === 'In');
    const outputs = circuit.visualElements.filter((el) => el.elementName === 'Out');

    // 7474 has: ~1SD, 1D, 1CP, ~1RD, ~2SD, 2D, 2CP, ~2RD, VCC, GND = 10 inputs
    // outputs: 1Q, ~1Q, 2Q, ~2Q = 4 outputs
    expect(inputs.length).toBe(10);
    expect(outputs.length).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // allLoadable — every manifest entry parses without error
  // ---------------------------------------------------------------------------

  it('allLoadable: every .dig file in the manifest parses without error', () => {
    const errors: string[] = [];

    for (const entry of LIBRARY_74XX) {
      try {
        const xml = readDigFile(entry.file);
        const circuit = parseDigXml(xml);
        // Must have a non-empty visualElements array
        expect(circuit.visualElements.length).toBeGreaterThan(0);
      } catch (err) {
        errors.push(`${entry.file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    expect(errors).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // register74xxLibrary — palette registration
  // ---------------------------------------------------------------------------

  it('register74xxLibrary: registers all manifest entries under SEVENTY_FOUR_XX category', () => {
    const registry = new ComponentRegistry();
    register74xxLibrary(registry);

    const registered = registry.getByCategory(ComponentCategory.SEVENTY_FOUR_XX);
    expect(registered.length).toBe(LIBRARY_74XX.length);
  });

  it('register74xxLibrary: each registered entry has the correct category', () => {
    const registry = new ComponentRegistry();
    register74xxLibrary(registry);

    const registered = registry.getByCategory(ComponentCategory.SEVENTY_FOUR_XX);
    for (const def of registered) {
      expect(def.category).toBe(ComponentCategory.SEVENTY_FOUR_XX);
    }
  });

  it('register74xxLibrary: 7400 is accessible by name after registration', () => {
    const registry = new ComponentRegistry();
    register74xxLibrary(registry);

    const def = registry.get('7400');
    expect(def).toBeDefined();
    expect(def!.name).toBe('7400');
    expect(def!.category).toBe(ComponentCategory.SEVENTY_FOUR_XX);
  });
});
