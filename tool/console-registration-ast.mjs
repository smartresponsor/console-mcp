import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const canonicalPrefix = /^(?:read_|write)\./;

export async function scanConsoleRegistrations(root) {
  const toolDir = path.join(root, "src", "tool");
  const files = (await readdir(toolDir)).filter((name) => name.endsWith(".ts")).sort();
  const sources = new Map();

  for (const file of files) {
    const text = await readFile(path.join(toolDir, file), "utf8");
    sources.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  }

  const registrations = [];
  const legacyPairs = [];
  const unresolved = [];

  for (const [file, source] of sources) {
    const functionCalls = collectFunctionCalls(source);
    const variableInitializers = collectVariableInitializers(source);

    const visit = (node) => {
      if (!ts.isCallExpression(node)) {
        ts.forEachChild(node, visit);
        return;
      }

      const expression = node.expression;
      const isRegisterTool = ts.isPropertyAccessExpression(expression) && expression.name.text === "registerTool";
      const isLegacyHelper = ts.isIdentifier(expression) && expression.text === "registerConsoleToolWithLegacyAlias";

      if (isLegacyHelper) {
        const canonical = resolveExpression(node.arguments[1], node, source, functionCalls, variableInitializers);
        const legacy = resolveExpression(node.arguments[2], node, source, functionCalls, variableInitializers);
        const canonicalNames = canonical.values.filter((name) => canonicalPrefix.test(name));
        const legacyNames = legacy.values.filter((name) => canonicalPrefix.test(name));
        if (canonicalNames.length === 1 && legacyNames.length === 1) {
          registrations.push(record(file, source, node, canonicalNames[0], "legacy-helper"));
          registrations.push(record(file, source, node, legacyNames[0], "legacy-helper"));
          legacyPairs.push({ legacy: legacyNames[0], canonical: canonicalNames[0], file, line: lineOf(source, node) });
        } else if (canonical.unresolved || legacy.unresolved) {
          unresolved.push(unresolvedRecord(file, source, node, "registerConsoleToolWithLegacyAlias", [canonical.reason, legacy.reason].filter(Boolean).join("; ")));
        }
        ts.forEachChild(node, visit);
        return;
      }

      if (isRegisterTool) {
        if (isInsideLegacyHelperDefinition(node)) {
          ts.forEachChild(node, visit);
          return;
        }

        const resolved = resolveExpression(node.arguments[0], node, source, functionCalls, variableInitializers);
        const names = [...new Set(resolved.values.filter((name) => canonicalPrefix.test(name)))];
        for (const name of names) registrations.push(record(file, source, node, name, "registerTool"));
        if (names.length === 0 && resolved.unresolved) {
          unresolved.push(unresolvedRecord(file, source, node, expression.getText(source), resolved.reason));
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return {
    registrations,
    registeredNames: [...new Set(registrations.map((item) => item.name))].sort(),
    legacyPairs,
    unresolved,
  };
}

function collectFunctionCalls(source) {
  const calls = new Map();
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const list = calls.get(name) ?? [];
      list.push(node);
      calls.set(name, list);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function collectVariableInitializers(source) {
  const initializers = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return initializers;
}

function resolveExpression(expression, contextNode, source, functionCalls, variableInitializers, propertyName = null, seen = new Set()) {
  if (!expression) return unresolved("missing expression");
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isParenthesizedExpression(expression)) {
    return resolveExpression(expression.expression, contextNode, source, functionCalls, variableInitializers, propertyName, seen);
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return resolved([expression.text]);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const values = [];
    let anyUnresolved = false;
    const reasons = [];
    for (const element of expression.elements) {
      if (propertyName && ts.isObjectLiteralExpression(element)) {
        const property = element.properties.find((item) =>
          ts.isPropertyAssignment(item) && propertyKey(item.name) === propertyName
        );
        if (property && ts.isPropertyAssignment(property)) {
          const result = resolveExpression(property.initializer, contextNode, source, functionCalls, variableInitializers, null, seen);
          values.push(...result.values);
          anyUnresolved ||= result.unresolved;
          if (result.reason) reasons.push(result.reason);
          continue;
        }
      }
      const result = resolveExpression(element, contextNode, source, functionCalls, variableInitializers, propertyName, seen);
      values.push(...result.values);
      anyUnresolved ||= result.unresolved;
      if (result.reason) reasons.push(result.reason);
    }
    return { values, unresolved: anyUnresolved, reason: reasons.join("; ") };
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const loop = findForOfBinding(contextNode, expression.expression.text);
    if (loop) {
      return resolveExpression(loop.expression, contextNode, source, functionCalls, variableInitializers, expression.name.text, seen);
    }
    return unresolved(`unresolved property access: ${expression.getText(source)}`);
  }
  if (ts.isIdentifier(expression)) {
    const name = expression.text;
    const key = `identifier:${name}`;
    if (seen.has(key)) return unresolved(`cyclic identifier resolution: ${name}`);
    const nextSeen = new Set(seen);
    nextSeen.add(key);

    const loop = findForOfBinding(contextNode, name);
    if (loop) {
      return resolveExpression(loop.expression, contextNode, source, functionCalls, variableInitializers, propertyName, nextSeen);
    }

    const enclosing = findEnclosingFunction(contextNode);
    if (enclosing && enclosing.name && ts.isIdentifier(enclosing.name)) {
      const parameterIndex = enclosing.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name);
      if (parameterIndex >= 0) {
        const calls = functionCalls.get(enclosing.name.text) ?? [];
        if (calls.length === 0) return unresolved(`parameter ${name} has no local call sites for ${enclosing.name.text}`);
        const values = [];
        const reasons = [];
        let anyUnresolved = false;
        for (const call of calls) {
          const argument = call.arguments[parameterIndex];
          const result = resolveExpression(argument, call, source, functionCalls, variableInitializers, propertyName, nextSeen);
          values.push(...result.values);
          anyUnresolved ||= result.unresolved;
          if (result.reason) reasons.push(result.reason);
        }
        return { values, unresolved: anyUnresolved, reason: reasons.join("; ") };
      }
    }

    const initializer = variableInitializers.get(name);
    if (initializer) {
      return resolveExpression(initializer, contextNode, source, functionCalls, variableInitializers, propertyName, nextSeen);
    }

    return unresolved(`unresolved identifier: ${name}`);
  }

  return unresolved(`unsupported ${ts.SyntaxKind[expression.kind]}: ${expression.getText(source)}`);
}

function findForOfBinding(node, identifierName) {
  let current = node.parent;
  while (current) {
    if (ts.isForOfStatement(current)
      && ts.isVariableDeclarationList(current.initializer)
      && current.initializer.declarations.length === 1) {
      const declaration = current.initializer.declarations[0];
      if (ts.isIdentifier(declaration.name) && declaration.name.text === identifierName) return current;
    }
    current = current.parent;
  }
  return null;
}

function findEnclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current) || ts.isMethodDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function isInsideLegacyHelperDefinition(node) {
  const fn = findEnclosingFunction(node);
  return Boolean(fn && fn.name && ts.isIdentifier(fn.name) && fn.name.text === "registerConsoleToolWithLegacyAlias");
}

function propertyKey(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function record(file, source, node, name, via) {
  return { name, file, line: lineOf(source, node), via };
}

function unresolvedRecord(file, source, node, call, reason) {
  return { file, line: lineOf(source, node), call, reason };
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function resolved(values) {
  return { values, unresolved: false, reason: null };
}

function unresolved(reason) {
  return { values: [], unresolved: true, reason };
}
