import path from "node:path";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Conservative runtime import closure: imported modules remain checked even when
// a registration is conditional. Type-only imports cannot expose tools.
export async function collectRuntimeModules(root, entrypoint = "src/index.ts") {
  const modules = new Set();
  const pending = [path.resolve(root, entrypoint)];
  while (pending.length) {
    const file = pending.pop();
    if (modules.has(file)) continue;
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error(`Cannot parse runtime module: ${file}`);
    modules.add(file);
    const imports = [];
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : node;
        const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : node.exportClause;
        const onlyTypes = clause?.isTypeOnly || (bindings && "elements" in bindings &&
          bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly) && !clause?.name);
        if (!onlyTypes && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ts.isIdentifier(node.expression) && node.expression.text === "require") &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of imports) {
      if (!specifier.startsWith(".")) continue; // Packages do not own src/tool registrations.
      const resolved = ts.resolveModuleName(specifier, file, {
        module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      }, ts.sys).resolvedModule;
      if (!resolved) throw new Error(`Unresolved runtime import: ${file} -> ${specifier}`);
      if (!resolved.resolvedFileName.endsWith(".json") && !resolved.isExternalLibraryImport &&
          !resolved.resolvedFileName.endsWith(".d.ts")) pending.push(path.resolve(resolved.resolvedFileName));
    }
  }
  return modules;
}
