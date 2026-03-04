/**
 * HGS async evaluator — port of Digital's hdl/hgs/Expression.java and Statement.java.
 *
 * Walks the AST and executes it. All evaluation is async to support loadHex()
 * and loadFile() file I/O built-ins.
 */

import type { ASTNode, Expression, Statement } from "./ast";
import { HGSContext } from "./context";
import {
  type HGSValue,
  HGSArray,
  HGSMap,
  HGSFunction,
  ReturnValue,
  toBool,
  hgsAdd,
  hgsSub,
  hgsMul,
  hgsDiv,
  hgsMod,
  hgsAnd,
  hgsOr,
  hgsXor,
  hgsShiftLeft,
  hgsShiftRight,
  hgsEqual,
  hgsLess,
  hgsLessEqual,
  hgsNeg,
  hgsBitwiseNot,
  hgsLogicalNot,
  hgsToString,
  toBigint,
  toArray,
  toMap,
  toFunction,
} from "./value";
import { HGSEvalError } from "./parser-error";

// ---------------------------------------------------------------------------
// Top-level entry points
// ---------------------------------------------------------------------------

/**
 * Evaluate a full AST program.
 * Returns the output string produced by print/template statements.
 */
export async function evaluate(node: Statement, ctx: HGSContext): Promise<string> {
  await executeStmt(node, ctx);
  return ctx.getOutput();
}

// ---------------------------------------------------------------------------
// Expression evaluator
// ---------------------------------------------------------------------------

export async function evaluateExpr(expr: Expression, ctx: HGSContext): Promise<HGSValue> {
  const line = expr.line;
  try {
    return await evalExprInner(expr, ctx);
  } catch (e) {
    if (e instanceof HGSEvalError) {
      e.setLine(line);
    }
    throw e;
  }
}

async function evalExprInner(expr: Expression, ctx: HGSContext): Promise<HGSValue> {
  switch (expr.kind) {
    case "literal":
      return expr.value as HGSValue;

    case "ident": {
      return ctx.getVar(expr.name);
    }

    case "binary": {
      const left = await evaluateExpr(expr.left, ctx);
      const right = await evaluateExpr(expr.right, ctx);
      return applyBinary(expr.op, left, right);
    }

    case "unary": {
      const operand = await evaluateExpr(expr.operand, ctx);
      switch (expr.op) {
        case "-":
          return hgsNeg(operand);
        case "~":
          return hgsBitwiseNot(operand);
        case "!":
          return hgsLogicalNot(operand);
      }
    }

    case "array": {
      const arr = new HGSArray();
      for (const el of expr.elements) {
        arr.add(await evaluateExpr(el, ctx));
      }
      return arr;
    }

    case "struct": {
      const map = new HGSMap();
      for (const { key, value } of expr.fields) {
        map.set(key, await evaluateExpr(value, ctx));
      }
      return map;
    }

    case "func": {
      const { params, body } = expr;
      const closure = ctx;
      return new HGSFunction(async (args: HGSValue[]) => {
        const fnCtx = closure.child(false);
        for (let i = 0; i < params.length; i++) {
          fnCtx.declareVar(params[i], args[i] ?? null);
        }
        try {
          await executeStmt(body, fnCtx);
          return null;
        } catch (e) {
          if (e instanceof ReturnValue) return e.value;
          throw e;
        }
      }, "<anonymous>");
    }

    case "call": {
      const callee = await evaluateExpr(expr.callee, ctx);
      const args: HGSValue[] = [];
      for (const arg of expr.args) {
        args.push(await evaluateExpr(arg, ctx));
      }
      const fn = toFunction(callee);
      return await fn.callable(args);
    }

    case "index": {
      const target = await evaluateExpr(expr.target, ctx);
      const idx = await evaluateExpr(expr.index, ctx);
      if (target instanceof HGSArray) {
        return target.get(Number(toBigint(idx)));
      }
      throw new HGSEvalError(`cannot index ${typeof target}`);
    }

    case "field": {
      const target = await evaluateExpr(expr.target, ctx);
      if (target instanceof HGSMap) {
        return target.get(expr.name);
      }
      throw new HGSEvalError(`cannot access field '${expr.name}' on ${typeof target}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Binary operator dispatch
// ---------------------------------------------------------------------------

function applyBinary(
  op: Expression extends { kind: "binary" } ? Expression["op"] : never,
  left: HGSValue,
  right: HGSValue,
): HGSValue {
  switch (op) {
    case "+":
      return hgsAdd(left, right);
    case "-":
      return hgsSub(left, right);
    case "*":
      return hgsMul(left, right);
    case "/":
      return hgsDiv(left, right);
    case "%":
      return hgsMod(left, right);
    case "&":
      return hgsAnd(left, right);
    case "|":
      return hgsOr(left, right);
    case "^":
      return hgsXor(left, right);
    case "<<":
      return hgsShiftLeft(left, right);
    case ">>>":
      return hgsShiftRight(left, right);
    case "=":
      return hgsEqual(left, right);
    case "!=":
      return !hgsEqual(left, right);
    case "<":
      return hgsLess(left, right);
    case "<=":
      return hgsLessEqual(left, right);
    case ">":
      return hgsLess(right, left);
    case ">=":
      return hgsLessEqual(right, left);
  }
}

// ---------------------------------------------------------------------------
// Statement executor
// ---------------------------------------------------------------------------

export async function executeStmt(stmt: Statement, ctx: HGSContext): Promise<void> {
  const line = stmt.line;
  try {
    await execStmtInner(stmt, ctx);
  } catch (e) {
    if (e instanceof HGSEvalError) {
      e.setLine(line);
    }
    throw e;
  }
}

async function execStmtInner(stmt: Statement, ctx: HGSContext): Promise<void> {
  switch (stmt.kind) {
    case "declare": {
      const val = await evaluateExpr(stmt.init, ctx);
      ctx.declareVar(stmt.name, val);
      return;
    }

    case "export": {
      const val = await evaluateExpr(stmt.init, ctx);
      ctx.exportVar(stmt.name, val);
      return;
    }

    case "assign": {
      const val = await evaluateExpr(stmt.value, ctx);
      await assignTarget(stmt.target, val, ctx);
      return;
    }

    case "increment": {
      const current = await evaluateExpr(stmt.target, ctx);
      const next = toBigint(current) + BigInt(stmt.delta);
      await assignTarget(stmt.target, next, ctx);
      return;
    }

    case "block": {
      for (const s of stmt.body) {
        await executeStmt(s, ctx);
      }
      return;
    }

    case "if": {
      const childCtx = ctx.child(false);
      const cond = await evaluateExpr(stmt.condition, childCtx);
      if (toBool(cond)) {
        await executeStmt(stmt.consequent, childCtx);
      } else if (stmt.alternate !== null) {
        await executeStmt(stmt.alternate, childCtx);
      }
      return;
    }

    case "for": {
      const loopCtx = ctx.child(false);
      await executeStmt(stmt.init, loopCtx);
      while (true) {
        const cond = await evaluateExpr(stmt.condition, loopCtx);
        if (!toBool(cond)) break;
        const bodyCtx = loopCtx.child(false);
        await executeStmt(stmt.body, bodyCtx);
        await executeStmt(stmt.update, loopCtx);
      }
      return;
    }

    case "while": {
      while (true) {
        const cond = await evaluateExpr(stmt.condition, ctx);
        if (!toBool(cond)) break;
        const bodyCtx = ctx.child(false);
        await executeStmt(stmt.body, bodyCtx);
      }
      return;
    }

    case "repeatUntil": {
      do {
        const bodyCtx = ctx.child(false);
        await executeStmt(stmt.body, bodyCtx);
        const cond = await evaluateExpr(stmt.condition, ctx);
        if (toBool(cond)) break;
      } while (true);
      return;
    }

    case "funcDecl": {
      const { params, body } = stmt;
      const closure = ctx;
      const fn = new HGSFunction(async (args: HGSValue[]) => {
        const fnCtx = closure.child(false);
        for (let i = 0; i < params.length; i++) {
          fnCtx.declareVar(params[i], args[i] ?? null);
        }
        try {
          await executeStmt(body, fnCtx);
          return null;
        } catch (e) {
          if (e instanceof ReturnValue) return e.value;
          throw e;
        }
      }, stmt.name);
      ctx.declareVar(stmt.name, fn);
      return;
    }

    case "return": {
      const val = await evaluateExpr(stmt.value, ctx);
      throw new ReturnValue(val);
    }

    case "output": {
      const val = await evaluateExpr(stmt.value, ctx);
      ctx.print(hgsToString(val));
      return;
    }

    case "text": {
      ctx.print(stmt.text);
      return;
    }

    case "exprStmt": {
      await evaluateExpr(stmt.expr, ctx);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Assignment to a target expression (l-value)
// ---------------------------------------------------------------------------

async function assignTarget(
  target: Expression,
  value: HGSValue,
  ctx: HGSContext,
): Promise<void> {
  switch (target.kind) {
    case "ident":
      ctx.setVar(target.name, value);
      return;

    case "index": {
      const arr = await evaluateExpr(target.target, ctx);
      const idx = await evaluateExpr(target.index, ctx);
      if (arr instanceof HGSArray) {
        arr.set(Number(toBigint(idx)), value);
        return;
      }
      throw new HGSEvalError("assignment target is not an array");
    }

    case "field": {
      const obj = await evaluateExpr(target.target, ctx);
      if (obj instanceof HGSMap) {
        obj.set(target.name, value);
        return;
      }
      throw new HGSEvalError(`cannot set field '${target.name}' on ${typeof obj}`);
    }

    default:
      throw new HGSEvalError(`invalid assignment target: ${target.kind}`);
  }
}
