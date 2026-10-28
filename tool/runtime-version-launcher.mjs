import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readJson, resolveVersion } from './runtime-version-store.mjs';
import { cutover, recover } from './runtime-version-transaction.mjs';

// No implicit entry, version, production port, token, or selector fallback.
// Managed production integration remains gated by the runbook acceptance list.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, file] = process.argv.slice(2);
    if (!file || !path.isAbsolute(file)) throw Error('absolute_configuration_required');
    if (operation === 'resolve') {
      console.log(JSON.stringify(await resolveVersion(await readJson(file))));
    } else {
      const config = await readJson(file);
      if (config.mode !== 'isolated-validation') throw Error('production_cutover_blocked');
      if (config.previous?.token) throw Error('plaintext_config_token_forbidden');
      config.previous.token = process.env.RUNTIME_PREVIOUS_BEARER_TOKEN;
      if (operation === 'recover') {
        await recover(config.base, config.previous);
        console.log(JSON.stringify({ ok: true, status: 'rolled-back' }));
      } else if (operation === 'select') {
        const transaction = await cutover({ ...config, onRollback: result => {
          console.log(JSON.stringify(result));
          if (!result.ok) process.exitCode = 2;
        } });
        console.log(JSON.stringify({ ok: true, status: 'isolated-selected', candidatePid: transaction.candidatePid, previousPid: transaction.previousPid }));
        for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
          transaction.rollback().then(() => process.exit(0), () => process.exit(2));
        });
      } else throw Error('usage_resolve_select_recover');
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 2;
  }
}
