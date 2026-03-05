/**
 * SpeedControl — manages the simulation speed value.
 *
 * Speed represents simulation steps per second. The value is clamped to
 * [MIN_SPEED, MAX_SPEED]. Supports multiplicative adjustments (/10, /2, x2, x10)
 * and direct text entry parsing.
 */

export const MIN_SPEED = 1;
export const MAX_SPEED = 10_000_000;
export const DEFAULT_SPEED = 1000;

export class SpeedControl {
  private _speed: number = DEFAULT_SPEED;

  get speed(): number {
    return this._speed;
  }

  set speed(value: number) {
    this._speed = clamp(value);
  }

  divideBy10(): void {
    this._speed = clamp(Math.round(this._speed / 10));
  }

  divideBy2(): void {
    this._speed = clamp(Math.round(this._speed / 2));
  }

  multiplyBy2(): void {
    this._speed = clamp(this._speed * 2);
  }

  multiplyBy10(): void {
    this._speed = clamp(this._speed * 10);
  }

  /**
   * Parse a text field entry and update speed.
   *
   * Accepts decimal integers and scientific notation (e.g. "1e6").
   * If the text cannot be parsed to a finite positive number the speed is
   * left unchanged.
   */
  parseText(text: string): void {
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }
    this._speed = clamp(Math.round(parsed));
  }
}

function clamp(value: number): number {
  if (value < MIN_SPEED) return MIN_SPEED;
  if (value > MAX_SPEED) return MAX_SPEED;
  return value;
}
