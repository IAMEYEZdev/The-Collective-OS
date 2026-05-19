/**
 * GitNexus Parser — Layer 1: Structural Awareness
 *
 * Walks ClaudeClaw source via ts-morph AST traversal.
 * Extracts: File nodes, Symbol nodes (class/function/method),
 * Import edges (file-to-file), Call edges (symbol-to-symbol),
 * DefinedIn edges (symbol-to-file), Extends edges (class-to-class).
 */

import { Project, SyntaxKind, SourceFile, Node, ts } from 'ts-morph';
import path from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export interface FileNode {
  path: string;      // relative to project root
  name: string;      // basename
}

export interface SymbolNode {
  name: string;
  kind: 'class' | 'function' | 'method' | 'variable';
  filePath: string;  // relative
  lineStart: number;
}

export interface ImportEdge {
  from: string;      // importer file path (relative)
  to: string;        // imported file path (relative)
}

export interface CallEdge {
  caller: string;    // symbol name
  callerFile: string;
  callee: string;    // resolved symbol name
  calleeFile: string | null; // null = UNRESOLVED
}

export interface ExtendsEdge {
  child: string;
  childFile: string;
  parent: string;
  parentFile: string | null;
}

export interface ParseResult {
  files: FileNode[];
  symbols: SymbolNode[];
  imports: ImportEdge[];
  calls: CallEdge[];
  extends: ExtendsEdge[];
}

// ── Parser ─────────────────────────────────────────────────────────

export function parseProject(tsconfigPath: string): ParseResult {
  const project = new Project({ tsConfigFilePath: tsconfigPath });
  const projectRoot = path.dirname(tsconfigPath);

  const files: FileNode[] = [];
  const symbols: SymbolNode[] = [];
  const imports: ImportEdge[] = [];
  const calls: CallEdge[] = [];
  const extendsEdges: ExtendsEdge[] = [];

  const sourceFiles = project.getSourceFiles();

  for (const sf of sourceFiles) {
    const filePath = normalizeRelative(sf.getFilePath(), projectRoot);

    // Skip node_modules / dist
    if (filePath.includes('node_modules') || filePath.startsWith('dist/')) continue;

    files.push({ path: filePath, name: path.basename(filePath) });

    extractImports(sf, filePath, projectRoot, imports);
    extractSymbols(sf, filePath, symbols);
    extractCalls(sf, filePath, projectRoot, calls);
    extractExtends(sf, filePath, projectRoot, extendsEdges);
  }

  return { files, symbols, imports, calls, extends: extendsEdges };
}

// ── Extractors ─────────────────────────────────────────────────────

function extractImports(
  sf: SourceFile,
  filePath: string,
  projectRoot: string,
  imports: ImportEdge[]
): void {
  for (const decl of sf.getImportDeclarations()) {
    const moduleSpecifier = decl.getModuleSpecifierValue();

    // Only track relative imports (project internal)
    if (!moduleSpecifier.startsWith('.')) continue;

    // Resolve the import to an actual source file
    const resolved = resolveImportPath(sf, moduleSpecifier, projectRoot);
    if (resolved) {
      imports.push({ from: filePath, to: resolved });
    }
  }
}

function extractSymbols(
  sf: SourceFile,
  filePath: string,
  symbols: SymbolNode[]
): void {
  // Classes
  for (const cls of sf.getClasses()) {
    const name = cls.getName();
    if (name) {
      symbols.push({
        name,
        kind: 'class',
        filePath,
        lineStart: cls.getStartLineNumber(),
      });
    }
  }

  // Functions (top-level and exported)
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (name) {
      symbols.push({
        name,
        kind: 'function',
        filePath,
        lineStart: fn.getStartLineNumber(),
      });
    }
  }

  // Exported variable declarations (export const foo = ...)
  for (const vs of sf.getVariableStatements()) {
    if (!vs.isExported()) continue;
    for (const decl of vs.getDeclarations()) {
      symbols.push({
        name: decl.getName(),
        kind: 'variable',
        filePath,
        lineStart: decl.getStartLineNumber(),
      });
    }
  }

  // Methods inside classes
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '<anon>';
    for (const method of cls.getMethods()) {
      symbols.push({
        name: `${className}.${method.getName()}`,
        kind: 'method',
        filePath,
        lineStart: method.getStartLineNumber(),
      });
    }
  }
}

function extractCalls(
  sf: SourceFile,
  filePath: string,
  projectRoot: string,
  calls: CallEdge[]
): void {
  // Find enclosing symbol for a node
  const getEnclosingSymbol = (node: Node): string | null => {
    let current: Node | undefined = node;
    while (current) {
      if (Node.isFunctionDeclaration(current)) return current.getName() ?? null;
      if (Node.isMethodDeclaration(current)) {
        const cls = current.getParentIfKind(SyntaxKind.ClassDeclaration);
        const className = cls?.getName() ?? '<anon>';
        return `${className}.${current.getName()}`;
      }
      if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
        // Check if assigned to a variable
        const parent = current.getParent();
        if (parent && Node.isVariableDeclaration(parent)) {
          return parent.getName();
        }
      }
      current = current.getParent();
    }
    return null;
  };

  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const callerName = getEnclosingSymbol(node);
    if (!callerName) return; // Top-level calls - skip for now

    const expression = node.getExpression();
    let calleeName: string | null = null;
    let calleeFile: string | null = null;

    try {
      // Try ts-morph symbol resolution
      const symbol = expression.getSymbol();
      if (symbol) {
        calleeName = symbol.getName();
        const declarations = symbol.getDeclarations();
        if (declarations.length > 0) {
          const declFile = declarations[0].getSourceFile();
          calleeFile = normalizeRelative(declFile.getFilePath(), projectRoot);
        }
      }
    } catch {
      // Symbol resolution failed - fallback to text
    }

    if (!calleeName) {
      // Fallback: extract name from expression text
      calleeName = expression.getText();
      // Clean up member access: obj.method() -> method
      if (calleeName.includes('.')) {
        calleeName = calleeName.split('.').pop() ?? calleeName;
      }
      calleeFile = null; // UNRESOLVED
    }

    calls.push({
      caller: callerName,
      callerFile: filePath,
      callee: calleeName,
      calleeFile,
    });
  });
}

function extractExtends(
  sf: SourceFile,
  filePath: string,
  projectRoot: string,
  extendsEdges: ExtendsEdge[]
): void {
  for (const cls of sf.getClasses()) {
    const childName = cls.getName();
    if (!childName) continue;

    const extendsExpr = cls.getExtends();
    if (!extendsExpr) continue;

    const parentName = extendsExpr.getText();
    let parentFile: string | null = null;

    try {
      const symbol = extendsExpr.getExpression().getSymbol();
      if (symbol) {
        const declarations = symbol.getDeclarations();
        if (declarations.length > 0) {
          parentFile = normalizeRelative(
            declarations[0].getSourceFile().getFilePath(),
            projectRoot
          );
        }
      }
    } catch {
      // Unresolved parent
    }

    extendsEdges.push({
      child: childName,
      childFile: filePath,
      parent: parentName,
      parentFile,
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function normalizeRelative(filePath: string, projectRoot: string): string {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function resolveImportPath(
  sf: SourceFile,
  moduleSpecifier: string,
  projectRoot: string
): string | null {
  // ts-morph can resolve module specifiers
  const dir = sf.getDirectory();
  const resolved = dir.getProject().getSourceFile(
    path.resolve(path.dirname(sf.getFilePath()), moduleSpecifier.replace(/\.js$/, '.ts'))
  );
  if (resolved) {
    return normalizeRelative(resolved.getFilePath(), projectRoot);
  }

  // Try with index.ts
  const indexResolved = dir.getProject().getSourceFile(
    path.resolve(path.dirname(sf.getFilePath()), moduleSpecifier.replace(/\.js$/, ''), 'index.ts')
  );
  if (indexResolved) {
    return normalizeRelative(indexResolved.getFilePath(), projectRoot);
  }

  return null;
}
