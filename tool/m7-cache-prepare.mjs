import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = realpathSync(process.cwd());
assert.notEqual(process.getuid(), 0, "Owner preparation only");
const req = createRequire("/usr/lib/node_modules/npm/package.json");
const cacache = req("cacache");
const sourceCache = join(homedir(), ".npm", "_cacache");
const lockBytes = readFileSync(join(root, "package-lock.json"));
const lock = JSON.parse(lockBytes);
const pkg = JSON.parse(readFileSync(join(root,"package.json")));
const sha = (bytes, alg="sha256", format="hex") => createHash(alg).update(bytes).digest(format);
function shareCache(stage,pin) {
  assert(process.getgroups().includes(1001),"smartresponse group required");
  const st=lstatSync(stage);assert(st.isDirectory()&&st.uid===process.getuid());
  const metadata=join(stage,"npm-cache.json"),receipt=join(stage,"cache-receipt.json"),cache=join(stage,"npm-cache");
  const raw=readFileSync(metadata);assert.equal(sha(raw),pin);
  const expected=JSON.parse(raw),actual={},paths=[];
  function verify(p){
    const info=lstatSync(p);assert.equal(info.uid,process.getuid());
    if(info.isDirectory()){paths.push([p,0o750]);for(const n of readdirSync(p))verify(join(p,n));}
    else{assert(info.isFile()&&info.nlink===1);actual[relative(cache,p)]=sha(readFileSync(p));paths.push([p,0o640]);}
  }
  verify(cache);assert.deepEqual(actual,expected);
  for(const p of [metadata,receipt]){const s=lstatSync(p);assert(s.isFile()&&s.nlink===1&&s.uid===process.getuid());paths.push([p,0o640]);}
  paths.push([stage,0o750]);
  for(const [p,mode] of paths){chownSync(p,process.getuid(),1001);chmodSync(p,mode);}
}
if(process.argv[2]==="--share-existing"){
  assert.equal(process.argv.length,5);
  const name=process.argv[3],pin=process.argv[4];
  assert(/^\.m7-cache-[A-Za-z0-9]{6}$/.test(name)&&/^[a-f0-9]{64}$/.test(pin));
  const stage=join(root,name);shareCache(stage,pin);
  console.log(JSON.stringify({status:"M7_CACHE_OWNER_HANDOFF_PASS",directory:stage,cacheManifestSha256:pin}));process.exit(0);
}
assert.equal(process.argv.length,2);
const stage = mkdtempSync(join(root,".m7-cache-"));
chmodSync(stage, 0o700);
const cache = join(stage,"npm-cache"), isolated = join(stage,"offline-check");
mkdirSync(cache,{mode:0o700});mkdirSync(isolated,{mode:0o700});
let count=0;const urls=new Map();
for (const [name,item] of Object.entries(lock.packages)) {
  if (!name) continue;
  assert(!item.link && /^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity) &&
    /^https:\/\/registry\.npmjs\.org\//.test(item.resolved), "Unpinned dependency: "+name);
  const u=new URL(item.resolved);
  assert(!u.username && !u.password && !u.search && !u.hash && u.origin==="https://registry.npmjs.org");
  if(urls.has(item.resolved)){assert.equal(urls.get(item.resolved),item.integrity);continue;}
  const bytes=await cacache.get.byDigest(sourceCache,item.integrity);
  assert.equal("sha512-"+sha(bytes,"sha512","base64"),item.integrity,"Cache integrity: "+name);
  // New cache contains only lockfile content. No original metadata or headers.
  await cacache.put(join(cache,"_cacache"),"pacote:tarball:"+item.resolved,bytes,{integrity:item.integrity});
  urls.set(item.resolved,item.integrity);count++;
}
const sanitized = {};
for (const k of ["name","version","private","type","dependencies","devDependencies","optionalDependencies","peerDependencies","peerDependenciesMeta","overrides","engines"]) {
  if (Object.hasOwn(pkg,k)) sanitized[k]=pkg[k];
}
writeFileSync(join(isolated,"package.json"),JSON.stringify(sanitized),{mode:0o600});
writeFileSync(join(isolated,"package-lock.json"),lockBytes,{mode:0o600});
const env={PATH:"/usr/bin:/bin",HOME:isolated,LC_ALL:"C",NODE_DISABLE_COMPILE_CACHE:"1",npm_config_userconfig:"/dev/null",npm_config_globalconfig:join(isolated,"empty-global.npmrc"),npm_config_registry:"https://registry.npmjs.org/",npm_config_offline:"true",npm_config_ignore_scripts:"true"};
// Check using a separate copy; the deliverable cache stays minimal and untouched.
const checkCache=join(isolated,"cache");
for(const [url,integrity] of urls){
  const bytes=await cacache.get.byDigest(join(cache,"_cacache"),integrity);
  await cacache.put(join(checkCache,"_cacache"),"pacote:tarball:"+url,bytes,{integrity});
}
execFileSync("/usr/bin/node",["/usr/lib/node_modules/npm/bin/npm-cli.js","ci","--offline","--ignore-scripts","--no-audit","--no-fund","--cache",checkCache],{cwd:isolated,env,timeout:180000,stdio:"pipe"});
const inventory={};let bytes=0;
function walk(path){
  for(const name of readdirSync(path).sort()){
    const p=join(path,name),s=lstatSync(p);
    if(s.isDirectory()){walk(p);chmodSync(p,0o750);}
    else {assert(s.isFile()&&s.nlink===1,"Unsafe cache file");const raw=readFileSync(p);bytes+=raw.length;inventory[relative(cache,p)]=sha(raw);chmodSync(p,0o640);}
  }
}
walk(cache);chmodSync(cache,0o750);
const manifest=Buffer.from(JSON.stringify(inventory,null,2)+"\n");
writeFileSync(join(stage,"npm-cache.json"),manifest,{flag:"wx",mode:0o640});
const receipt={status:"M7_MINIMAL_OFFLINE_CACHE_PASS",lockfileSha256:sha(lockBytes),dependencyEntries:Object.keys(lock.packages).length-1,uniqueTarballs:count,cacheFiles:Object.keys(inventory).length,cacheBytes:bytes,cacheManifestSha256:sha(manifest),directory:stage,offlineCi:true,networkUsed:false,lifecycleScripts:false};
writeFileSync(join(stage,"cache-receipt.json"),JSON.stringify(receipt,null,2)+"\n",{flag:"wx",mode:0o640});
chmodSync(join(stage,"npm-cache.json"),0o640);chmodSync(join(stage,"cache-receipt.json"),0o640);
shareCache(stage,receipt.cacheManifestSha256);
console.log(JSON.stringify(receipt));
