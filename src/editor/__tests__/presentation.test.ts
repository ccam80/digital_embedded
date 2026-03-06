/**
 * Tests for presentation.ts — PresentationMode.
 */

import { describe, it, expect, vi } from "vitest";
import { PresentationMode } from "@/editor/presentation";
import type { CollapsiblePanel, PanelSet, CanvasSize } from "@/editor/presentation";
import { Viewport } from "@/editor/viewport";

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makePanel(initiallyCollapsed = false): CollapsiblePanel & { collapseCount: number; expandCount: number } {
  let collapsed = initiallyCollapsed;
  let collapseCount = 0;
  let expandCount = 0;
  return {
    get collapseCount() { return collapseCount; },
    get expandCount() { return expandCount; },
    collapse() { collapsed = true; collapseCount++; },
    expand() { collapsed = false; expandCount++; },
    isCollapsed() { return collapsed; },
  };
}

function makePanelSet(paletteCollapsed = false, propertyCollapsed = false): {
  panels: PanelSet;
  palette: ReturnType<typeof makePanel>;
  propertyPanel: ReturnType<typeof makePanel>;
} {
  const palette = makePanel(paletteCollapsed);
  const propertyPanel = makePanel(propertyCollapsed);
  return { panels: { palette, propertyPanel }, palette, propertyPanel };
}

const DEFAULT_CANVAS: CanvasSize = { width: 800, height: 600 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Presentation", () => {
  describe("enterHidesPanels", () => {
    it("collapses palette on enter", () => {
      const { panels, palette } = makePanelSet(false, false);
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);
      const vp = new Viewport();

      mode.enter(vp);

      expect(palette.isCollapsed()).toBe(true);
    });

    it("collapses property panel on enter", () => {
      const { panels, propertyPanel } = makePanelSet(false, false);
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);
      const vp = new Viewport();

      mode.enter(vp);

      expect(propertyPanel.isCollapsed()).toBe(true);
    });

    it("isActive returns true after enter", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);
      const vp = new Viewport();

      mode.enter(vp);

      expect(mode.isActive()).toBe(true);
    });

    it("isActive returns false before enter", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);

      expect(mode.isActive()).toBe(false);
    });

    it("does not double-enter if already active", () => {
      const { panels, palette } = makePanelSet(false, false);
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);
      const vp = new Viewport();

      mode.enter(vp);
      const countAfterFirst = palette.collapseCount;
      mode.enter(vp);

      expect(palette.collapseCount).toBe(countAfterFirst);
    });
  });

  describe("enterFitsContent", () => {
    it("calls fitToContent on the viewport during enter", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);
      const vp = new Viewport(1.0);
      // fitToContent with empty elements resets to zoom=1 and pan=(0,0)
      // but we set a custom zoom/pan first to detect it was called
      vp.zoom = 3.5;
      vp.pan = { x: 100, y: 200 };

      mode.enter(vp, []);

      // After fitToContent([]) the zoom resets to 1.0 and pan to (0,0)
      expect(vp.zoom).toBe(1.0);
      expect(vp.pan.x).toBe(0);
      expect(vp.pan.y).toBe(0);
    });

    it("fitToContent is called with the provided canvas size", () => {
      const canvas: CanvasSize = { width: 1920, height: 1080 };
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, canvas);
      const vp = new Viewport();

      const fitSpy = vi.spyOn(vp, "fitToContent");
      mode.enter(vp, []);

      expect(fitSpy).toHaveBeenCalledWith([], canvas);
    });
  });

  describe("exitRestoresPanels", () => {
    it("expands palette on exit when it was expanded before enter", () => {
      const { panels, palette } = makePanelSet(false, false);
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);
      const vp = new Viewport();

      mode.enter(vp);
      expect(palette.isCollapsed()).toBe(true);

      mode.exit(vp);
      expect(palette.isCollapsed()).toBe(false);
    });

    it("expands property panel on exit when it was expanded before enter", () => {
      const { panels, propertyPanel } = makePanelSet(false, false);
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);
      const vp = new Viewport();

      mode.enter(vp);
      mode.exit(vp);

      expect(propertyPanel.isCollapsed()).toBe(false);
    });

    it("keeps palette collapsed on exit when it was collapsed before enter", () => {
      const { panels, palette } = makePanelSet(true, false);
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);
      const vp = new Viewport();

      mode.enter(vp);
      mode.exit(vp);

      expect(palette.isCollapsed()).toBe(true);
    });

    it("isActive returns false after exit", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);
      const vp = new Viewport();

      mode.enter(vp);
      mode.exit(vp);

      expect(mode.isActive()).toBe(false);
    });

    it("restores saved zoom on exit", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);
      const vp = new Viewport(2.5);

      mode.enter(vp);
      // Viewport zoom is now different (fitToContent changed it)
      mode.exit(vp);

      expect(vp.zoom).toBe(2.5);
    });

    it("restores saved pan on exit", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);
      const vp = new Viewport(1.0, { x: 42, y: 99 });

      mode.enter(vp);
      mode.exit(vp);

      expect(vp.pan.x).toBe(42);
      expect(vp.pan.y).toBe(99);
    });

    it("does nothing on exit when not active", () => {
      const { panels, palette } = makePanelSet(false, false);
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);

      mode.exit();

      // No panel operations should have occurred
      expect(palette.expandCount).toBe(0);
      expect(palette.collapseCount).toBe(0);
    });
  });

  describe("toolbarHasSimControlsOnly", () => {
    it("getToolbarActions returns exactly 4 actions", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);

      const actions = mode.getToolbarActions();

      expect(actions).toHaveLength(4);
    });

    it("toolbar actions include play", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);

      const labels = mode.getToolbarActions().map((a) => a.label);
      expect(labels).toContain("play");
    });

    it("toolbar actions include pause", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);

      const labels = mode.getToolbarActions().map((a) => a.label);
      expect(labels).toContain("pause");
    });

    it("toolbar actions include step", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);

      const labels = mode.getToolbarActions().map((a) => a.label);
      expect(labels).toContain("step");
    });

    it("toolbar actions include reset", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);

      const labels = mode.getToolbarActions().map((a) => a.label);
      expect(labels).toContain("reset");
    });

    it("toolbar actions are all enabled", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);

      const actions = mode.getToolbarActions();
      expect(actions.every((a) => a.enabled)).toBe(true);
    });

    it("play action invokes the play callback", () => {
      const { panels } = makePanelSet();
      const playCb = vi.fn();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS, { play: playCb });

      const actions = mode.getToolbarActions();
      const playAction = actions.find((a) => a.label === "play")!;
      playAction.action();

      expect(playCb).toHaveBeenCalledOnce();
    });

    it("pause action invokes the pause callback", () => {
      const { panels } = makePanelSet();
      const pauseCb = vi.fn();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS, { pause: pauseCb });

      const actions = mode.getToolbarActions();
      const pauseAction = actions.find((a) => a.label === "pause")!;
      pauseAction.action();

      expect(pauseCb).toHaveBeenCalledOnce();
    });

    it("step action invokes the step callback", () => {
      const { panels } = makePanelSet();
      const stepCb = vi.fn();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS, { step: stepCb });

      const actions = mode.getToolbarActions();
      const stepAction = actions.find((a) => a.label === "step")!;
      stepAction.action();

      expect(stepCb).toHaveBeenCalledOnce();
    });

    it("reset action invokes the reset callback", () => {
      const { panels } = makePanelSet();
      const resetCb = vi.fn();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS, { reset: resetCb });

      const actions = mode.getToolbarActions();
      const resetAction = actions.find((a) => a.label === "reset")!;
      resetAction.action();

      expect(resetCb).toHaveBeenCalledOnce();
    });
  });

  describe("toggle", () => {
    it("toggle enters when not active", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);
      const vp = new Viewport();

      mode.toggle(vp);

      expect(mode.isActive()).toBe(true);
    });

    it("toggle exits when active", () => {
      const { panels } = makePanelSet();
      const mode = new PresentationMode(panels, DEFAULT_CANVAS);
      const vp = new Viewport();

      mode.enter(vp);
      mode.toggle(vp);

      expect(mode.isActive()).toBe(false);
    });
  });
});
