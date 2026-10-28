import { createHash, randomUUID } from 'node:crypto';
import { readFile, open, rename, realpath, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }

// Same-directory rename is the commit point. Never delete the destination first.
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function resolveVersion(reference) {
  if (!reference || !path.isAbsolute(reference.manifest) || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw Error('invalid_version_reference');
  const bytes = await readFile(reference.manifest);
  if (digest(bytes) !== reference.sha256) throw Error('manifest_hash_mismatch');
  const manifest = JSON.parse(bytes);
  if (manifest.schema !== 1 || !/^[a-f0-9]{40}$/.test(manifest.commit) || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('invalid_manifest');
  const root = await realpath(path.dirname(reference.manifest));
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || seen.has(file.path)) throw Error('unsafe_artifact');
    seen.add(file.path);
    const target = path.join(root, file.path);
    const actual = await realpath(target);
    const relative = path.relative(root, actual);
    if (relative.startsWith('..') || path.isAbsolute(relative) || (await lstat(target)).isSymbolicLink()) throw Error('artifact_escape');
    if (digest(await readFile(actual)) !== file.sha256) throw Error('artifact_hash_mismatch');
  }
  if (!seen.has(manifest.entry)) throw Error('entry_not_verified');
  return { root, entry: path.join(root, manifest.entry), commit: manifest.commit, reference };
}
