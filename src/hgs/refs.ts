/**
 * HGS reference system- l-value abstractions for the HGS runtime.
 *
 * References represent assignable locations: variables, array elements,
 * struct fields, and function call results. They compose for chained access
 * like `obj.field[index]`.
 */

import type { Expression } from "./ast";
import { HGSContext } from "./context";
import { type HGSValue, HGSArray, HGSMap, HGSFunction, toBigint, toFunction } from "./value";
import { HGSEvalError } from "./parser-error";
import { evaluateExpr } from "./evaluator";

// ---------------------------------------------------------------------------
// Reference interface
// ---------------------------------------------------------------------------

export interface Reference {
  get(ctx: HGSContext): Promise<HGSValue>;
  set(ctx: HGSContext, value: HGSValue): Promise<void>;
  declare(ctx: HGSContext, value: HGSValue): Promise<void>;
}

// ---------------------------------------------------------------------------
// ReferenceToVar- reads/writes a named variable in the context
// ---------------------------------------------------------------------------

export class ReferenceToVar implements Reference {
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  get name_(): string {
    return this.name;
  }

  async get(ctx: HGSContext): Promise<HGSValue> {
    return ctx.getVar(this.name);
  }

  async set(ctx: HGSContext, value: HGSValue): Promise<void> {
    ctx.setVar(this.name, value);
  }

  async declare(ctx: HGSContext, value: HGSValue): Promise<void> {
    ctx.declareVar(this.name, value);
  }
}

// ---------------------------------------------------------------------------
// ReferenceToArray- indexed access into an HGSArray
// ---------------------------------------------------------------------------

export class ReferenceToArray implements Reference {
  private readonly parent: Reference;
  private readonly index: Expression;

  constructor(parent: Reference, index: Expression) {
    this.parent = parent;
    this.index = index;
  }

  private async resolveIndex(ctx: HGSContext): Promise<number> {
    const idxVal = await evaluateExpr(this.index, ctx);
    return Number(toBigint(idxVal));
  }

  async get(ctx: HGSContext): Promise<HGSValue> {
    const container = await this.parent.get(ctx);
    if (!(container instanceof HGSArray)) {
      throw new HGSEvalError("cannot index a non-array value");
    }
    const i = await this.resolveIndex(ctx);
    return container.get(i);
  }

  async set(ctx: HGSContext, value: HGSValue): Promise<void> {
    const container = await this.parent.get(ctx);
    if (!(container instanceof HGSArray)) {
      throw new HGSEvalError("cannot index a non-array value");
    }
    const i = await this.resolveIndex(ctx);
    container.set(i, value);
  }

  async declare(ctx: HGSContext, value: HGSValue): Promise<void> {
    const container = await this.parent.get(ctx);
    if (!(container instanceof HGSArray)) {
      throw new HGSEvalError("cannot index a non-array for declaration");
    }
    const i = await this.resolveIndex(ctx);
    if (i < 0 || i > container.size()) {
      throw new HGSEvalError(`index out of bounds for declaration: ${i}`);
    }
    container.add(value);
  }
}

// ---------------------------------------------------------------------------
// ReferenceToStruct- field access on an HGSMap
// ---------------------------------------------------------------------------

export class ReferenceToStruct implements Reference {
  private readonly parent: Reference;
  private readonly fieldName: string;

  constructor(parent: Reference, fieldName: string) {
    this.parent = parent;
    this.fieldName = fieldName;
  }

  async get(ctx: HGSContext): Promise<HGSValue> {
    const container = await this.parent.get(ctx);
    if (!(container instanceof HGSMap)) {
      throw new HGSEvalError(`cannot access field '${this.fieldName}' on a non-map value`);
    }
    return container.get(this.fieldName);
  }

  async set(ctx: HGSContext, value: HGSValue): Promise<void> {
    const container = await this.parent.get(ctx);
    if (!(container instanceof HGSMap)) {
      throw new HGSEvalError(`cannot set field '${this.fieldName}' on a non-map value`);
    }
    if (!container.has(this.fieldName)) {
      throw new HGSEvalError(`field '${this.fieldName}' not declared in struct`);
    }
    container.set(this.fieldName, value);
  }

  async declare(ctx: HGSContext, value: HGSValue): Promise<void> {
    const container = await this.parent.get(ctx);
    if (!(container instanceof HGSMap)) {
      throw new HGSEvalError(`cannot declare field '${this.fieldName}' on a non-map value`);
    }
    if (container.has(this.fieldName)) {
      throw new HGSEvalError(`field '${this.fieldName}' already declared in struct`);
    }
    container.set(this.fieldName, value);
  }
}

// ---------------------------------------------------------------------------
// ReferenceToFunc- function call result (read-only, not assignable)
// ---------------------------------------------------------------------------

export class ReferenceToFunc implements Reference {
  private readonly parent: Reference;
  private readonly args: Expression[];

  constructor(parent: Reference, args: Expression[]) {
    this.parent = parent;
    this.args = args;
  }

  async get(ctx: HGSContext): Promise<HGSValue> {
    const fnVal = await this.parent.get(ctx);
    if (!(fnVal instanceof HGSFunction)) {
      throw new HGSEvalError(`cannot call a non-function value`);
    }
    const fn = toFunction(fnVal);
    const evaluatedArgs: HGSValue[] = [];
    for (const arg of this.args) {
      evaluatedArgs.push(await evaluateExpr(arg, ctx));
    }
    return fn.callable(evaluatedArgs);
  }

  async set(_ctx: HGSContext, _value: HGSValue): Promise<void> {
    throw new HGSEvalError("cannot assign to a function call result");
  }

  async declare(_ctx: HGSContext, _value: HGSValue): Promise<void> {
    throw new HGSEvalError("cannot declare a function call result");
  }
}
