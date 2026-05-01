/**
 * AST node types for the HGS scripting language.
 *
 * HGS is Digital's embedded scripting language for parameterized circuits.
 * All nodes carry a line number for error reporting.
 */

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export interface ASTNode {
  readonly line: number;
}

// ---------------------------------------------------------------------------
// Expression nodes
// ---------------------------------------------------------------------------

export interface LiteralExpr extends ASTNode {
  readonly kind: "literal";
  readonly value: bigint | number | string | boolean;
}

export interface IdentExpr extends ASTNode {
  readonly kind: "ident";
  readonly name: string;
}

export interface BinaryExpr extends ASTNode {
  readonly kind: "binary";
  readonly op:
    | "+"
    | "-"
    | "*"
    | "/"
    | "%"
    | "&"
    | "|"
    | "^"
    | "="
    | "!="
    | "<"
    | "<="
    | ">"
    | ">="
    | "<<"
    | ">>>";
  readonly left: Expression;
  readonly right: Expression;
}

export interface UnaryExpr extends ASTNode {
  readonly kind: "unary";
  readonly op: "-" | "~" | "!";
  readonly operand: Expression;
}

export interface ArrayLiteralExpr extends ASTNode {
  readonly kind: "array";
  readonly elements: Expression[];
}

export interface StructLiteralExpr extends ASTNode {
  readonly kind: "struct";
  readonly fields: Array<{ key: string; value: Expression }>;
}

export interface FuncExpr extends ASTNode {
  readonly kind: "func";
  readonly params: string[];
  readonly body: Statement;
}

export interface IndexExpr extends ASTNode {
  readonly kind: "index";
  readonly target: Expression;
  readonly index: Expression;
}

export interface CallExpr extends ASTNode {
  readonly kind: "call";
  readonly callee: Expression;
  readonly args: Expression[];
}

export interface FieldExpr extends ASTNode {
  readonly kind: "field";
  readonly target: Expression;
  readonly name: string;
}

export type Expression =
  | LiteralExpr
  | IdentExpr
  | BinaryExpr
  | UnaryExpr
  | ArrayLiteralExpr
  | StructLiteralExpr
  | FuncExpr
  | IndexExpr
  | CallExpr
  | FieldExpr;

// ---------------------------------------------------------------------------
// Statement nodes
// ---------------------------------------------------------------------------

export interface DeclareStmt extends ASTNode {
  readonly kind: "declare";
  readonly name: string;
  readonly init: Expression;
}

export interface ExportStmt extends ASTNode {
  readonly kind: "export";
  readonly name: string;
  readonly init: Expression;
}

export interface AssignStmt extends ASTNode {
  readonly kind: "assign";
  /** Left-hand side- an expression that resolves to an assignable location */
  readonly target: Expression;
  readonly value: Expression;
}

export interface IncrementStmt extends ASTNode {
  readonly kind: "increment";
  readonly target: Expression;
  readonly delta: 1 | -1;
}

export interface BlockStmt extends ASTNode {
  readonly kind: "block";
  readonly body: Statement[];
}

export interface IfStmt extends ASTNode {
  readonly kind: "if";
  readonly condition: Expression;
  readonly consequent: Statement;
  readonly alternate: Statement | null;
}

export interface ForStmt extends ASTNode {
  readonly kind: "for";
  readonly init: Statement;
  readonly condition: Expression;
  readonly update: Statement;
  readonly body: Statement;
}

export interface WhileStmt extends ASTNode {
  readonly kind: "while";
  readonly condition: Expression;
  readonly body: Statement;
}

export interface RepeatUntilStmt extends ASTNode {
  readonly kind: "repeatUntil";
  readonly body: Statement;
  readonly condition: Expression;
}

export interface FuncDeclStmt extends ASTNode {
  readonly kind: "funcDecl";
  readonly name: string;
  readonly params: string[];
  readonly body: Statement;
}

export interface ReturnStmt extends ASTNode {
  readonly kind: "return";
  readonly value: Expression;
}

export interface OutputStmt extends ASTNode {
  readonly kind: "output";
  readonly value: Expression;
}

export interface TextStmt extends ASTNode {
  readonly kind: "text";
  readonly text: string;
}

export interface ExprStmt extends ASTNode {
  readonly kind: "exprStmt";
  readonly expr: Expression;
}

export type Statement =
  | DeclareStmt
  | ExportStmt
  | AssignStmt
  | IncrementStmt
  | BlockStmt
  | IfStmt
  | ForStmt
  | WhileStmt
  | RepeatUntilStmt
  | FuncDeclStmt
  | ReturnStmt
  | OutputStmt
  | TextStmt
  | ExprStmt;
