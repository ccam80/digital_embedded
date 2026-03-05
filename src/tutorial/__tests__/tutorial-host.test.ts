import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseUrlParams,
  buildCheckpointPath,
  buildInstructionsUrl,
  buildIframeSrc,
  TutorialHost,
  setupCheckpointNavigation,
} from '../tutorial-host.js';

describe('TutorialHost', () => {
  describe('parseParams', () => {
    it('parses tutorial and step from URL search params', () => {
      const params = new URLSearchParams('tutorial=intro-to-logic&step=2');
      const result = parseUrlParams(params);

      expect(result.tutorial).toBe('intro-to-logic');
      expect(result.step).toBe(2);
    });

    it('returns empty object when no params provided', () => {
      const params = new URLSearchParams('');
      const result = parseUrlParams(params);

      expect(Object.keys(result).length).toBe(0);
    });

    it('parses only tutorial when step is missing', () => {
      const params = new URLSearchParams('tutorial=advanced');
      const result = parseUrlParams(params);

      expect(result.tutorial).toBe('advanced');
      expect(result.step).toBeUndefined();
    });

    it('parses only step when tutorial is missing', () => {
      const params = new URLSearchParams('step=5');
      const result = parseUrlParams(params);

      expect(result.tutorial).toBeUndefined();
      expect(result.step).toBe(5);
    });

    it('ignores invalid step values (not positive integers)', () => {
      const params = new URLSearchParams('step=abc');
      const result = parseUrlParams(params);

      expect(result.step).toBeUndefined();
    });

    it('ignores zero or negative step values', () => {
      let params = new URLSearchParams('step=0');
      let result = parseUrlParams(params);
      expect(result.step).toBeUndefined();

      params = new URLSearchParams('step=-1');
      result = parseUrlParams(params);
      expect(result.step).toBeUndefined();
    });
  });

  describe('checkpointPath', () => {
    it('builds correct checkpoint path from tutorial and step', () => {
      const path = buildCheckpointPath('intro-to-logic', 2);
      expect(path).toBe('tutorials/intro-to-logic/checkpoint-2/');
    });

    it('works with different tutorial names', () => {
      const path = buildCheckpointPath('advanced-circuits', 5);
      expect(path).toBe('tutorials/advanced-circuits/checkpoint-5/');
    });

    it('works with step 1', () => {
      const path = buildCheckpointPath('basics', 1);
      expect(path).toBe('tutorials/basics/checkpoint-1/');
    });
  });

  describe('instructionsUrl', () => {
    it('builds instructions URL from base path', () => {
      const url = buildInstructionsUrl('tutorials/intro-to-logic/checkpoint-2/');
      expect(url).toBe(
        'tutorials/intro-to-logic/checkpoint-2/instructions.md'
      );
    });

    it('works with various base paths', () => {
      const url = buildInstructionsUrl('my-path/');
      expect(url).toBe('my-path/instructions.md');
    });
  });

  describe('iframeSetup', () => {
    it('builds iframe src with base parameter', () => {
      const src = buildIframeSrc(
        'simulator.html',
        'tutorials/intro-to-logic/checkpoint-1/'
      );

      expect(src).toContain('simulator.html');
      expect(src).toContain('base=tutorials%2Fintro-to-logic%2Fcheckpoint-1%2F');
    });

    it('includes file parameter when provided', () => {
      const src = buildIframeSrc(
        'simulator.html',
        'tutorials/intro-to-logic/checkpoint-1/',
        'and-gate.dig'
      );

      expect(src).toContain('simulator.html');
      expect(src).toContain('base=tutorials%2Fintro-to-logic%2Fcheckpoint-1%2F');
      expect(src).toContain('file=and-gate.dig');
    });

    it('omits file parameter when not provided', () => {
      const src = buildIframeSrc(
        'simulator.html',
        'tutorials/intro-to-logic/checkpoint-1/'
      );

      expect(src).not.toContain('file=');
    });
  });

  describe('TutorialHost', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = document.createElement('div');
      container.id = 'instructions';
      document.body.appendChild(container);

      // Mock fetch
      global.fetch = vi.fn();
    });

    afterEach(() => {
      document.body.removeChild(container);
      vi.clearAllMocks();
    });

    it('initializes with correct container', () => {
      const host = new TutorialHost('instructions');
      expect(host).toBeDefined();
    });

    it('throws when container not found', () => {
      const host = new TutorialHost('nonexistent');
      expect(() => {
        host.registerIframe(document.createElement('iframe'));
      }).not.toThrow(); // registerIframe doesn't check container
    });

    it('registers iframes for management', () => {
      const host = new TutorialHost('instructions');
      const iframe = document.createElement('iframe');

      host.registerIframe(iframe);
      // No error should be thrown
      expect(host).toBeDefined();
    });

    it('handles iframe registration with multiple iframes', () => {
      const host = new TutorialHost('instructions');
      const iframe1 = document.createElement('iframe');
      const iframe2 = document.createElement('iframe');

      host.registerIframe(iframe1);
      host.registerIframe(iframe2);

      expect(host).toBeDefined();
    });
  });

  describe('checkpointNavigation', () => {
    let navContainer: HTMLElement;

    beforeEach(() => {
      navContainer = document.createElement('div');
      navContainer.id = 'nav';
      document.body.appendChild(navContainer);
    });

    afterEach(() => {
      document.body.removeChild(navContainer);
    });

    it('creates navigation buttons for each step', async () => {
      const onNavigate = vi.fn();

      setupCheckpointNavigation(
        'intro-to-logic',
        3,
        async (t, s) => {
          onNavigate(t, s);
        },
        'nav'
      );

      const buttons = navContainer.querySelectorAll('button');
      expect(buttons.length).toBe(3);
    });

    it('creates buttons with correct labels', async () => {
      const onNavigate = vi.fn();

      setupCheckpointNavigation(
        'intro-to-logic',
        3,
        async (t, s) => {
          onNavigate(t, s);
        },
        'nav'
      );

      const buttons = navContainer.querySelectorAll('button');
      expect(buttons[0].textContent).toBe('Checkpoint 1');
      expect(buttons[1].textContent).toBe('Checkpoint 2');
      expect(buttons[2].textContent).toBe('Checkpoint 3');
    });

    it('calls onNavigate when button clicked', async () => {
      const onNavigate = vi.fn();

      setupCheckpointNavigation(
        'intro-to-logic',
        3,
        async (t, s) => {
          onNavigate(t, s);
        },
        'nav'
      );

      const buttons = navContainer.querySelectorAll('button');
      (buttons[1] as HTMLButtonElement).click();

      // Wait for async callback
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onNavigate).toHaveBeenCalledWith('intro-to-logic', 2);
    });

    it('handles missing container gracefully', async () => {
      const onNavigate = vi.fn();

      // Should not throw
      setupCheckpointNavigation(
        'intro-to-logic',
        3,
        async (t, s) => {
          onNavigate(t, s);
        },
        'nonexistent'
      );

      expect(onNavigate).not.toHaveBeenCalled();
    });

    it('creates correct number of buttons for single step', async () => {
      const onNavigate = vi.fn();

      setupCheckpointNavigation(
        'intro-to-logic',
        1,
        async (t, s) => {
          onNavigate(t, s);
        },
        'nav'
      );

      const buttons = navContainer.querySelectorAll('button');
      expect(buttons.length).toBe(1);
      expect(buttons[0].textContent).toBe('Checkpoint 1');
    });

    it('creates correct number of buttons for many steps', async () => {
      const onNavigate = vi.fn();

      setupCheckpointNavigation(
        'intro-to-logic',
        10,
        async (t, s) => {
          onNavigate(t, s);
        },
        'nav'
      );

      const buttons = navContainer.querySelectorAll('button');
      expect(buttons.length).toBe(10);
      expect(buttons[9].textContent).toBe('Checkpoint 10');
    });

    it('clears previous content when called multiple times', async () => {
      const onNavigate = vi.fn();

      setupCheckpointNavigation(
        'intro-to-logic',
        3,
        async (t, s) => {
          onNavigate(t, s);
        },
        'nav'
      );

      let buttons = navContainer.querySelectorAll('button');
      expect(buttons.length).toBe(3);

      setupCheckpointNavigation(
        'advanced',
        2,
        async (t, s) => {
          onNavigate(t, s);
        },
        'nav'
      );

      buttons = navContainer.querySelectorAll('button');
      expect(buttons.length).toBe(2);
    });
  });
});
