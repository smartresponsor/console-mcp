import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the worker's real attachment function with inert browser/filesystem doubles.
// A managed-mode launch is legitimate; a Console-verified visible request cannot launch.
export async function assertVisibleWorkerContract(worker) {
  const ast = ts.createSourceFile('worker.js', worker, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0, 'Worker contract source must parse');
  const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'ensurePage');
  assert.ok(declaration, 'Worker must expose the attachment boundary');
  const contextCalls = [];
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'visibleRequest.run') contextCalls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(contextCalls.length, 1, 'Exactly one verified request-context boundary');
  const [proof, next] = contextCalls[0].arguments;
  const forwardsProof = proof && (ts.isIdentifier(proof) && proof.text === 'before' ||
    ts.isObjectLiteralExpression(proof) && proof.properties.length === 2 &&
    ts.isSpreadAssignment(proof.properties[0]) && proof.properties[0].expression.getText(ast) === 'before' &&
    ts.isShorthandPropertyAssignment(proof.properties[1]) && proof.properties[1].name.text === 'preserveActiveTarget');
  assert.ok(forwardsProof, 'Forward the complete native proof, optionally preserving the active target');
  assert.equal(next?.getText(ast), 'next', 'Continue within the verified async context');
  const source = declaration.getText(ast);
  async function scenario({ external = true, guard = { ok: true, evidence: { targetId: 'verified' } }, attachFails = false, stale = false } = {}) {
    const effects = [];
    const target = { isClosed: () => false, url: () => 'https://fixture.invalid', bringToFront: async () => {} };
    const context = { pages: () => [target], newPage: async () => { effects.push('newPage'); return target; } };
    const sandbox = {
      browser: undefined, connectedBrowser: undefined, page: undefined,
      getPolicy: () => ({ externalVisibleChrome: external, browserChannel: 'chromium', headless: false }),
      assertSessionWindow: async () => {}, visibleRequest: { getStore: () => guard },
      revisionError: (status, message) => Object.assign(new Error(message), { status }),
      getManagedUserDataDir: () => '/inert-fixture',
      connectExternalVisibleChrome: async () => {
        effects.push('attach');
        if (attachFails) throw new Error('fixture attach failed');
        return { connectedBrowser: {}, context };
      },
      normalizeError: e => e.message,
      mkdir: async () => { effects.push('mkdir'); },
      killManagedBrowserProcesses: async () => { effects.push('kill'); },
      chromium: { launchPersistentContext: async () => { effects.push('launch'); return context; } },
      getPageTargetId: async () => stale ? 'another-target' : 'verified',
      console: { warn: () => {} },
    };
    const run = vm.runInNewContext(`(${source})`, sandbox);
    let error;
    let result;
    try { result = await run(); } catch (caught) { error = caught; }
    return { effects, error, result, target };
  }
  const ownership = await scenario({ external: false });
  assert.equal(ownership.error?.status, 'WEB_VISIBLE_SESSION_REQUIRED');
  assert.deepEqual(ownership.effects, [], 'Verified ownership must reject before profile/launch effects');
  const failedAttach = await scenario({ attachFails: true });
  assert.match(failedAttach.error?.message ?? '', /Shared browser CDP attach failed/);
  assert.deepEqual(failedAttach.effects, ['attach'], 'Failed attach must never fall back to managed launch');
  const attached = await scenario();
  assert.equal(attached.error, undefined);
  assert.equal(attached.result, attached.target, 'Reuse the exact verified target');
  assert.deepEqual(attached.effects, ['attach']);
  const stale = await scenario({ stale: true });
  assert.equal(stale.error?.status, 'WEB_TARGET_STALE');
  assert.deepEqual(stale.effects, ['attach'], 'Missing target must not create a replacement tab');
  const managed = await scenario({ external: false, guard: null });
  assert.equal(managed.error, undefined);
  assert.deepEqual(managed.effects, ['mkdir', 'kill', 'launch'], 'Unverified managed mode retains its explicit launch path');
}
