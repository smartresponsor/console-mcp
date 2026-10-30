import { cp, mkdir, readdir, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicJson, digest, fileDigest } from './runtime-version-store.mjs';
const exec=promisify(execFile);

export async function inventory(root,prefix='') {
  const entries=[];
  for(const item of await readdir(path.join(root,prefix),{withFileTypes:true})) {
    const name=prefix?`${prefix}/${item.name}`:item.name;
    if(name==='version.json')continue;
    // This runtime writes operational logs below var/. It is not executable
    // release content; every dependency and runtime file remains inventoried.
    if(name==='var' && item.isDirectory())continue;
    const target=path.join(root,name);
    if((await lstat(target)).isSymbolicLink())throw Error('release_symlink_forbidden');
    if(item.isDirectory())entries.push(...await inventory(root,name));
    else if(item.isFile())entries.push({path:name,sha256:await fileDigest(target)});
    else throw Error('release_special_file_forbidden');
  }
  return entries.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}

export async function buildRelease(source,destination) {
  const commit=(await exec('git',['-C',source,'rev-parse','HEAD'])).stdout.trim();
  // Runtime sources and dependency inputs must match the declared commit.
  await exec('git',['-C',source,'diff','--exit-code','HEAD','--','src','policy','tool','config','package.json','package-lock.json','tsconfig.json']);
  await mkdir(destination); // Existing release directories are never overwritten.
  for(const name of ['dist','policy','package.json','package-lock.json'])await cp(path.join(source,name),path.join(destination,name),{recursive:true});
  // Copy tracked operational code/config only. Ignored local configuration and
  // resolved secrets must never be swept into a release by a directory copy.
  const tracked=(await exec('git',['-C',source,'ls-files','-z','--','tool','config'],{maxBuffer:1024**2})).stdout.split('\0').filter(Boolean);
  for(const name of tracked){await mkdir(path.dirname(path.join(destination,name)),{recursive:true});await cp(path.join(source,name),path.join(destination,name));}
  const lock=JSON.parse(await readFile(path.join(destination,'package-lock.json')));
  for(const [name,entry] of Object.entries(lock.packages)){
    if(!name || entry.dev || entry.optional)continue;
    if(entry.link || !entry.integrity || !entry.resolved?.startsWith('https://registry.npmjs.org/'))throw Error('unpinned_dependency');
  }
  const command=process.platform==='win32'?'cmd.exe':'npm';
  const args=process.platform==='win32'?['/d','/s','/c','npm ci --omit=dev --ignore-scripts --no-audit --no-fund']:['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'];
  await exec(command,args,{cwd:destination,windowsHide:true,maxBuffer:1024**2,timeout:180000});
  const installed=JSON.parse(await readFile(path.join(destination,'node_modules/.package-lock.json')));
  for(const [name,entry]of Object.entries(installed.packages)){
    const expected=lock.packages[name];
    if(!expected || expected.version!==entry.version || expected.integrity!==entry.integrity)throw Error('installed_dependency_mismatch');
  }
  const manifest={schema:2,commit,entry:'dist/index.js',provenance:{node:process.version,lockfileSha256:digest(await readFile(path.join(destination,'package-lock.json'))),installer:'npm-ci-omit-dev-ignore-scripts',installedPackages:Object.keys(installed.packages).length},files:await inventory(destination)};
  await atomicJson(path.join(destination,'version.json'),manifest);
  return {manifest:path.join(destination,'version.json'),sha256:digest(await readFile(path.join(destination,'version.json')))};
}
