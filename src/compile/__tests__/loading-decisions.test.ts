/**
 * Unit tests for applyLoadingDecisions().
 *
 * Tests cover:
 *   - "all" mode injects analog into digital-only groups
 *   - "cross-domain" mode leaves digital-only groups unchanged
 *   - "none" mode leaves digital-only groups unchanged
 *   - per-net "loaded" override wins over "cross-domain" mode
 *   - per-net "loaded" override wins over "none" mode
 *   - per-net "ideal" override on boundary group sets loadingMode
 *   - per-net "ideal" override on digital-only group is a no-op
 */

import { describe, it, expect } from 'vitest';
import { applyLoadingDecisions } from '../extract-connectivity.js';
import type { ConnectivityGroup } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGroup(
  groupId: number,
  domains: string[],
  bitWidth?: number,
): ConnectivityGroup {
  return {
    groupId,
    pins: [],
    wires: [],
    domains: new Set(domains),
    bitWidth,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyLoadingDecisions', () => {
  it('"all" mode injects analog into digital-only group', () => {
    const group = makeGroup(0, ['digital'], 1);
    applyLoadingDecisions([group], 'all', new Map());
    expect(group.domains.has('analog')).toBe(true);
    expect(group.domains.has('digital')).toBe(true);
  });

  it('"cross-domain" mode does not inject analog', () => {
    const group = makeGroup(0, ['digital'], 1);
    applyLoadingDecisions([group], 'cross-domain', new Map());
    expect(group.domains.has('analog')).toBe(false);
    expect(group.domains.has('digital')).toBe(true);
  });

  it('"none" mode does not inject analog', () => {
    const group = makeGroup(0, ['digital'], 1);
    applyLoadingDecisions([group], 'none', new Map());
    expect(group.domains.has('analog')).toBe(false);
    expect(group.domains.has('digital')).toBe(true);
  });

  it('per-net "loaded" override injects analog in "cross-domain" mode', () => {
    const group = makeGroup(0, ['digital'], 1);
    const overrides = new Map<number, 'loaded' | 'ideal'>([[0, 'loaded']]);
    applyLoadingDecisions([group], 'cross-domain', overrides);
    expect(group.domains.has('analog')).toBe(true);
    expect(group.domains.has('digital')).toBe(true);
  });

  it('per-net "loaded" override injects analog in "none" mode', () => {
    const group = makeGroup(0, ['digital'], 1);
    const overrides = new Map<number, 'loaded' | 'ideal'>([[0, 'loaded']]);
    applyLoadingDecisions([group], 'none', overrides);
    expect(group.domains.has('analog')).toBe(true);
    expect(group.domains.has('digital')).toBe(true);
  });

  it('per-net "ideal" override on boundary group sets loadingMode', () => {
    const group = makeGroup(0, ['digital', 'analog'], 1);
    const overrides = new Map<number, 'loaded' | 'ideal'>([[0, 'ideal']]);
    applyLoadingDecisions([group], 'cross-domain', overrides);
    expect(group.loadingMode).toBe('ideal');
  });

  it('per-net "ideal" override on digital-only group is no-op', () => {
    const group = makeGroup(0, ['digital'], 1);
    const overrides = new Map<number, 'loaded' | 'ideal'>([[0, 'ideal']]);
    applyLoadingDecisions([group], 'cross-domain', overrides);
    expect(group.domains.has('analog')).toBe(false);
    expect(group.loadingMode).toBeUndefined();
  });
});
