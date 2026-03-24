/**
 * Tests for translation completeness and correctness.
 * Verifies that zh.json and de.json cover all keys in en.json
 * and that parameter placeholders are preserved.
 */

import { describe, it, expect } from 'vitest';
import enJson from '../locales/en.json';
import zhJson from '../locales/zh.json';
import deJson from '../locales/de.json';

type NestedRecord = { [key: string]: string | NestedRecord };

/**
 * Flatten a nested JSON object into dot-separated keys.
 * Example: { menu: { file: { open: "Open" } } } -> { "menu.file.open": "Open" }
 */
function flattenKeys(obj: NestedRecord, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      result[fullKey] = value;
    } else {
      Object.assign(result, flattenKeys(value, fullKey));
    }
  }
  return result;
}

/**
 * Extract {param} placeholders from a string.
 */
function extractPlaceholders(str: string): string[] {
  const matches = str.match(/\{[^}]+\}/g);
  return matches ?? [];
}

const enFlat = flattenKeys(enJson as NestedRecord);
const zhFlat = flattenKeys(zhJson as NestedRecord);
const deFlat = flattenKeys(deJson as NestedRecord);

describe('translations', () => {
  it('allKeysPresent: every key in en.json exists in zh.json', () => {
    const missingInZh: string[] = [];
    for (const key of Object.keys(enFlat)) {
      if (!(key in zhFlat)) {
        missingInZh.push(key);
      }
    }
    expect(missingInZh).toEqual([]);
  });

  it('allKeysPresent: every key in en.json exists in de.json', () => {
    const missingInDe: string[] = [];
    for (const key of Object.keys(enFlat)) {
      if (!(key in deFlat)) {
        missingInDe.push(key);
      }
    }
    expect(missingInDe).toEqual([]);
  });

  it('noEmptyValues: no empty string values in en.json', () => {
    const emptyKeys = Object.entries(enFlat)
      .filter(([, v]) => v.trim() === '')
      .map(([k]) => k);
    expect(emptyKeys).toEqual([]);
  });

  it('noEmptyValues: no empty string values in zh.json', () => {
    const emptyKeys = Object.entries(zhFlat)
      .filter(([, v]) => v.trim() === '')
      .map(([k]) => k);
    expect(emptyKeys).toEqual([]);
  });

  it('noEmptyValues: no empty string values in de.json', () => {
    const emptyKeys = Object.entries(deFlat)
      .filter(([, v]) => v.trim() === '')
      .map(([k]) => k);
    expect(emptyKeys).toEqual([]);
  });

  it('paramPlaceholders: keys with {param} in English have {param} in zh.json', () => {
    const mismatches: string[] = [];
    for (const [key, enValue] of Object.entries(enFlat)) {
      const enPlaceholders = extractPlaceholders(enValue);
      if (enPlaceholders.length === 0) continue;
      const zhValue = zhFlat[key];
      if (!zhValue) continue; // already caught by allKeysPresent
      const zhPlaceholders = extractPlaceholders(zhValue);
      for (const ph of enPlaceholders) {
        if (!zhPlaceholders.includes(ph)) {
          mismatches.push(`${key}: missing ${ph} in zh`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('paramPlaceholders: keys with {param} in English have {param} in de.json', () => {
    const mismatches: string[] = [];
    for (const [key, enValue] of Object.entries(enFlat)) {
      const enPlaceholders = extractPlaceholders(enValue);
      if (enPlaceholders.length === 0) continue;
      const deValue = deFlat[key];
      if (!deValue) continue; // already caught by allKeysPresent
      const dePlaceholders = extractPlaceholders(deValue);
      for (const ph of enPlaceholders) {
        if (!dePlaceholders.includes(ph)) {
          mismatches.push(`${key}: missing ${ph} in de`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
