/**
 * SVG path string parser for CUSTOM subcircuit shapes.
 *
 * Parses SVG path data (M, L, C, Q, Z commands) into PathOperation[] arrays
 * compatible with RenderContext.drawPath(). All coordinates in the input are
 * pixel units and are divided by pixelScale (default 20) to convert to grid
 * units at parse time.
 */

import type { PathOperation } from "../../core/renderer-interface.js";

/**
 * Parse an SVG path string into an array of PathOperation objects.
 *
 * Supported commands:
 * - M x,y (moveTo)
 * - L x,y (lineTo)
 * - C cp1x,cp1y cp2x,cp2y x,y (cubic bezier)
 * - Q cpx,cpy x,y (quadratic bezier — converted to cubic for PathOperation)
 * - Z (closePath)
 *
 * All coordinates are divided by pixelScale to convert from pixel to grid units.
 */
export function parseSvgPath(pathStr: string, pixelScale: number = 20): PathOperation[] {
  const ops: PathOperation[] = [];
  const tokens = tokenize(pathStr);
  let i = 0;

  function nextNumber(): number {
    if (i >= tokens.length) {
      throw new Error(`parseSvgPath: unexpected end of path data`);
    }
    const n = parseFloat(tokens[i]);
    if (isNaN(n)) {
      throw new Error(`parseSvgPath: expected number, got "${tokens[i]}"`);
    }
    i++;
    return n / pixelScale;
  }

  let lastX = 0;
  let lastY = 0;

  while (i < tokens.length) {
    const cmd = tokens[i];
    i++;

    switch (cmd) {
      case "M": {
        const x = nextNumber();
        const y = nextNumber();
        ops.push({ op: "moveTo", x, y });
        lastX = x;
        lastY = y;
        while (i < tokens.length && isNumeric(tokens[i])) {
          const lx = nextNumber();
          const ly = nextNumber();
          ops.push({ op: "lineTo", x: lx, y: ly });
          lastX = lx;
          lastY = ly;
        }
        break;
      }

      case "L": {
        while (i < tokens.length && isNumeric(tokens[i])) {
          const x = nextNumber();
          const y = nextNumber();
          ops.push({ op: "lineTo", x, y });
          lastX = x;
          lastY = y;
        }
        break;
      }

      case "C": {
        while (i < tokens.length && isNumeric(tokens[i])) {
          const cp1x = nextNumber();
          const cp1y = nextNumber();
          const cp2x = nextNumber();
          const cp2y = nextNumber();
          const x = nextNumber();
          const y = nextNumber();
          ops.push({ op: "curveTo", cp1x, cp1y, cp2x, cp2y, x, y });
          lastX = x;
          lastY = y;
        }
        break;
      }

      case "Q": {
        while (i < tokens.length && isNumeric(tokens[i])) {
          const qx = nextNumber();
          const qy = nextNumber();
          const ex = nextNumber();
          const ey = nextNumber();
          const cp1x = lastX + (2 / 3) * (qx - lastX);
          const cp1y = lastY + (2 / 3) * (qy - lastY);
          const cp2x = ex + (2 / 3) * (qx - ex);
          const cp2y = ey + (2 / 3) * (qy - ey);
          ops.push({ op: "curveTo", cp1x, cp1y, cp2x, cp2y, x: ex, y: ey });
          lastX = ex;
          lastY = ey;
        }
        break;
      }

      case "Z":
      case "z":
        ops.push({ op: "closePath" });
        break;

      default:
        throw new Error(`parseSvgPath: unsupported command "${cmd}"`);
    }
  }

  return ops;
}

/**
 * Tokenize an SVG path string into commands and numbers.
 * Handles comma and space separators, negative numbers as separate tokens.
 */
function tokenize(pathStr: string): string[] {
  const tokens: string[] = [];
  const re = /([MCLQZmclqz])|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pathStr)) !== null) {
    tokens.push(match[0]);
  }
  return tokens;
}

function isNumeric(token: string): boolean {
  return /^-?\d/.test(token);
}
