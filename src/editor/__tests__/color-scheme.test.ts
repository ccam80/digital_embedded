/**
 * Tests for color-scheme.ts — ColorSchemeManager.
 */

import { describe, it, expect, vi } from "vitest";
import { ColorSchemeManager, buildColorMap } from "@/editor/color-scheme";
import { THEME_COLORS, defaultColorScheme, highContrastColorScheme } from "@/core/renderer-interface";
import type { ThemeColor } from "@/core/renderer-interface";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFullColorMap(override: Partial<Record<ThemeColor, string>> = {}): Record<ThemeColor, string> {
  const map = {} as Record<ThemeColor, string>;
  for (const color of THEME_COLORS) {
    map[color] = override[color] ?? "#aaaaaa";
  }
  return map;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ColorSchemeManager", () => {
  describe("switchesScheme", () => {
    it("defaults to the default scheme", () => {
      const mgr = new ColorSchemeManager();

      const active = mgr.getActive();

      expect(active.resolve("BACKGROUND")).toBe("#000000");
    });

    it("setActive('high-contrast') — BACKGROUND resolves to #000000", () => {
      const mgr = new ColorSchemeManager();

      mgr.setActive("high-contrast");

      expect(mgr.getActive().resolve("BACKGROUND")).toBe("#000000");
    });

    it("setActive('monochrome') — BACKGROUND resolves to #ffffff", () => {
      const mgr = new ColorSchemeManager();

      mgr.setActive("monochrome");

      expect(mgr.getActive().resolve("BACKGROUND")).toBe("#ffffff");
    });

    it("getActiveName returns the active scheme name", () => {
      const mgr = new ColorSchemeManager();

      mgr.setActive("high-contrast");

      expect(mgr.getActiveName()).toBe("high-contrast");
    });

    it("setActive('default') switches back from high-contrast", () => {
      const mgr = new ColorSchemeManager("high-contrast");

      mgr.setActive("default");

      expect(mgr.getActive().resolve("BACKGROUND")).toBe("#000000");
    });

    it("setActive with unknown name throws", () => {
      const mgr = new ColorSchemeManager();

      expect(() => mgr.setActive("nonexistent")).toThrow();
    });

    it("all built-in schemes are available by name", () => {
      const mgr = new ColorSchemeManager();
      const names = mgr.getSchemeNames();

      expect(names).toContain("default");
      expect(names).toContain("high-contrast");
      expect(names).toContain("monochrome");
    });

    it("high-contrast WIRE resolves to #ffffff", () => {
      const mgr = new ColorSchemeManager();
      mgr.setActive("high-contrast");

      expect(mgr.getActive().resolve("WIRE")).toBe("#ffffff");
    });
  });

  describe("gateShapeToggle", () => {
    it("defaults to ieee gate shape", () => {
      const mgr = new ColorSchemeManager();

      expect(mgr.getGateShapeStyle()).toBe("ieee");
    });

    it("setGateShapeStyle('iec') — getGateShapeStyle returns 'iec'", () => {
      const mgr = new ColorSchemeManager();

      mgr.setGateShapeStyle("iec");

      expect(mgr.getGateShapeStyle()).toBe("iec");
    });

    it("setGateShapeStyle('ieee') after 'iec' restores ieee", () => {
      const mgr = new ColorSchemeManager();
      mgr.setGateShapeStyle("iec");

      mgr.setGateShapeStyle("ieee");

      expect(mgr.getGateShapeStyle()).toBe("ieee");
    });

    it("constructor accepts initial gate shape style", () => {
      const mgr = new ColorSchemeManager("default", "iec");

      expect(mgr.getGateShapeStyle()).toBe("iec");
    });
  });

  describe("customSchemeWorks", () => {
    it("createCustomScheme with red background resolves BACKGROUND to red", () => {
      const mgr = new ColorSchemeManager();
      const colors = makeFullColorMap({ BACKGROUND: "#ff0000" });

      mgr.createCustomScheme("my-theme", colors);
      mgr.setActive("my-theme");

      expect(mgr.getActive().resolve("BACKGROUND")).toBe("#ff0000");
    });

    it("createCustomScheme registers scheme by name", () => {
      const mgr = new ColorSchemeManager();
      const colors = makeFullColorMap();

      mgr.createCustomScheme("custom-one", colors);

      expect(mgr.getSchemeNames()).toContain("custom-one");
    });

    it("createCustomScheme returns the new ColorScheme", () => {
      const mgr = new ColorSchemeManager();
      const colors = makeFullColorMap({ WIRE: "#123456" });

      const scheme = mgr.createCustomScheme("test-scheme", colors);

      expect(scheme.resolve("WIRE")).toBe("#123456");
    });

    it("custom scheme resolves every ThemeColor", () => {
      const mgr = new ColorSchemeManager();
      const colors = makeFullColorMap({ TEXT: "#ff00ff" });

      const scheme = mgr.createCustomScheme("all-colors", colors);

      for (const color of THEME_COLORS) {
        expect(() => scheme.resolve(color)).not.toThrow();
      }
    });

    it("createCustomScheme overwrites existing scheme of same name", () => {
      const mgr = new ColorSchemeManager();
      const colorsV1 = makeFullColorMap({ BACKGROUND: "#111111" });
      const colorsV2 = makeFullColorMap({ BACKGROUND: "#222222" });

      mgr.createCustomScheme("mutable-theme", colorsV1);
      mgr.createCustomScheme("mutable-theme", colorsV2);
      mgr.setActive("mutable-theme");

      expect(mgr.getActive().resolve("BACKGROUND")).toBe("#222222");
    });
  });

  describe("onChangeFiresOnSwitch", () => {
    it("onChange callback fires when setActive is called", () => {
      const mgr = new ColorSchemeManager();
      const callback = vi.fn();
      mgr.onChange(callback);

      mgr.setActive("high-contrast");

      expect(callback).toHaveBeenCalledOnce();
    });

    it("onChange callback fires when setGateShapeStyle is called", () => {
      const mgr = new ColorSchemeManager();
      const callback = vi.fn();
      mgr.onChange(callback);

      mgr.setGateShapeStyle("iec");

      expect(callback).toHaveBeenCalledOnce();
    });

    it("multiple onChange callbacks all fire", () => {
      const mgr = new ColorSchemeManager();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      mgr.onChange(cb1);
      mgr.onChange(cb2);

      mgr.setActive("monochrome");

      expect(cb1).toHaveBeenCalledOnce();
      expect(cb2).toHaveBeenCalledOnce();
    });

    it("removed listener does not fire after unsubscribe", () => {
      const mgr = new ColorSchemeManager();
      const callback = vi.fn();
      const unsubscribe = mgr.onChange(callback);

      unsubscribe();
      mgr.setActive("high-contrast");

      expect(callback).not.toHaveBeenCalled();
    });

    it("onChange fires once per setActive call, not multiple times", () => {
      const mgr = new ColorSchemeManager();
      const callback = vi.fn();
      mgr.onChange(callback);

      mgr.setActive("monochrome");
      mgr.setActive("default");

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("callback receives updated scheme when fired", () => {
      const mgr = new ColorSchemeManager();
      let capturedBackground = "";
      mgr.onChange(() => {
        capturedBackground = mgr.getActive().resolve("BACKGROUND");
      });

      mgr.setActive("high-contrast");

      expect(capturedBackground).toBe("#000000");
    });
  });

  describe("buildColorMap", () => {
    it("inherits all colors from base scheme when no overrides", () => {
      const map = buildColorMap(defaultColorScheme, {});

      for (const color of THEME_COLORS) {
        expect(map[color]).toBe(defaultColorScheme.resolve(color));
      }
    });

    it("applies override for specified colors", () => {
      const map = buildColorMap(defaultColorScheme, { BACKGROUND: "#abcdef" });

      expect(map.BACKGROUND).toBe("#abcdef");
    });

    it("does not mutate non-overridden colors", () => {
      const map = buildColorMap(highContrastColorScheme, { BACKGROUND: "#ffffff" });

      expect(map.WIRE).toBe(highContrastColorScheme.resolve("WIRE"));
    });
  });
});
