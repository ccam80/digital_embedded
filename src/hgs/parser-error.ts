/**
 * Error thrown during HGS parsing or evaluation.
 * Carries the source line number for user-facing error messages.
 */
export class ParserError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "ParserError";
    this.line = line;
  }
}

/**
 * Error thrown during HGS evaluation.
 * Line number is set after construction when the evaluator catches and re-throws.
 */
export class HGSEvalError extends Error {
  private _line: number = 0;

  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "HGSEvalError";
  }

  setLine(line: number): void {
    if (this._line === 0) {
      this._line = line;
    }
  }

  get line(): number {
    return this._line;
  }

  override get message(): string {
    if (this._line === 0) return super.message;
    return `${super.message}; line ${this._line}`;
  }
}
