// Non-root preparation: exact signed Browsing bundle and minimal pinned npm cache.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,relative} from 'node:path';
const ROOT='/home/alex/smartresponse/mcp/looping/.worktrees/browsing-lease-reconcile-20261127';
const SHA='917dea698640f0274ad55bcbe11e723895626894';
const SIGNER='SHA256:Bt2B2CF6uL5A9VwIjUkPfzIr48lT0Eqv5rvo2Oj4rWo';
const SIGNERS='/home/alex/smartresponse/mcp/console-mcp/.git/cmcp-allowed-signers';
const uid=process.getuid();
assert(uid===993||uid===1000,'UNPRIVILEGED_CAPSULE_REQUIRED');
assert.equal(realpathSync(ROOT),ROOT);
process.umask(0o077);
const env={PATH:'/usr/bin:/bin',HOME:homedir(),LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:'file',GIT_OPTIONAL_LOCKS:'0'};
const git=(...args)=>execFileSync('/usr/bin/git',['-c','safe.directory='+ROOT,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','gpg.format=ssh','-c','gpg.ssh.program=/usr/bin/ssh-keygen','-c','gpg.ssh.allowedSignersFile='+SIGNERS,'-C',ROOT,...args],{env,timeout:90000,maxBuffer:16*1024*1024});
const hash=(bytes,alg='sha256',encoding='hex')=>createHash(alg).update(bytes).digest(encoding);
assert.equal(git('rev-parse','HEAD').toString().trim(),SHA);
assert.equal(git('status','--porcelain').toString(),'');
git('verify-commit',SHA);
assert.deepEqual(git('show','-s','--format=%G?%n%GF',SHA).toString().trim().split('\n'),['G',SIGNER]);
const require=createRequire('/usr/lib/node_modules/npm/package.json'),cacache=require('cacache');
const npm=execFileSync('/usr/bin/node',['/usr/lib/node_modules/npm/bin/npm-cli.js','config','get','cache'],{cwd:ROOT,env:{PATH:'/usr/bin:/bin',HOME:homedir(),LC_ALL:'C'},encoding:'utf8',timeout:10000}).trim();
const sourceCache=join(npm,'_cacache');
const urls=new Map(),locks={};
for(const part of ['mcp-server','playwright-worker']){
  const name=part+'/package-lock.json',raw=git('show',SHA+':'+name);
  locks[name]=hash(raw);
  const lock=JSON.parse(raw);
  assert.equal(lock.lockfileVersion,3);
  for(const [k,item] of Object.entries(lock.packages)){
    if(!k)continue;
    assert(!item.link&&/^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity),'UNPINNED_DEPENDENCY:'+k);
    const url=new URL(item.resolved);
    assert(url.origin==='https://registry.npmjs.org'&&!url.username&&!url.password&&!url.search&&!url.hash,'DEPENDENCY_ORIGIN:'+k);
    assert(!urls.has(item.resolved)||urls.get(item.resolved)===item.integrity,'DEPENDENCY_CONFLICT');
    urls.set(item.resolved,item.integrity);
  }
}
const missing=[];
for(const [url,integrity] of urls){
  try{const bytes=await cacache.get.byDigest(sourceCache,integrity);assert.equal('sha512-'+hash(bytes,'sha512','base64'),integrity);}
  catch{missing.push(url);}
}
if(missing.length){
  console.log(JSON.stringify({status:'BROWSING_OFFLINE_CACHE_MISS',sourceSHA:SHA,lockfiles:locks,uniqueTarballs:urls.size,missingCount:missing.length,missing:missing.slice(0,12),networkUsed:false}));
  process.exit(2);
}
const stage=mkdtempSync(join('/home/alex/smartresponse/mcp','.browsing-linux-capsule-'));
chmodSync(stage,0o700);
const cache=join(stage,'npm-cache'),bare=join(stage,'source.git');
mkdirSync(cache,{mode:0o700});chmodSync(cache,0o700);
for(const [url,integrity] of urls){
  const bytes=await cacache.get.byDigest(sourceCache,integrity);
  assert.equal('sha512-'+hash(bytes,'sha512','base64'),integrity);
  await cacache.put(join(cache,'_cacache'),'pacote:tarball:'+url,bytes,{integrity});
}
git('init','--bare','--template=',bare);
const branch='refs/heads/integration/shared-browser-lease-20261127';
assert.equal(git('rev-parse',branch).toString().trim(),SHA);
const intermediate=join(stage,'branch.bundle');
git('bundle','create',intermediate,branch);
git('--git-dir='+bare,'fetch','--no-tags','--no-write-fetch-head',intermediate,branch+':refs/heads/premerge');
rmSync(intermediate);
assert.equal(git('--git-dir='+bare,'rev-parse','refs/heads/premerge').toString().trim(),SHA);
git('--git-dir='+bare,'verify-commit',SHA);
git('--git-dir='+bare,'bundle','create',join(stage,'source.bundle'),'refs/heads/premerge');
git('--git-dir='+bare,'bundle','verify',join(stage,'source.bundle'));
rmSync(bare,{recursive:true});
const files={};
function walk(dir){
 for(const n of readdirSync(dir).sort()){
   const p=join(dir,n),s=lstatSync(p);
   assert.equal(s.uid,uid);
   if(s.isDirectory()){walk(p);chmodSync(p,0o700);}
   else{assert(s.isFile()&&s.nlink===1);files[relative(cache,p)]=hash(readFileSync(p));chmodSync(p,0o600);}
 }
}
walk(cache);
const manifest=Buffer.from(JSON.stringify(files,null,2)+'\n');
writeFileSync(join(stage,'npm-cache.json'),manifest,{flag:'wx',mode:0o600});
const cap={schemaVersion:1,sourceSHA:SHA,signerFingerprint:SIGNER,sourceBundleSha256:hash(readFileSync(join(stage,'source.bundle'))),cacheManifestSha256:hash(manifest),lockfiles:locks};
const raw=Buffer.from(JSON.stringify(cap,null,2)+'\n');
writeFileSync(join(stage,'capsule.json'),raw,{flag:'wx',mode:0o600});
for(const p of ['source.bundle','npm-cache.json','capsule.json'])chmodSync(join(stage,p),0o600);
assert.equal(git('rev-parse','HEAD').toString().trim(),SHA);
console.log(JSON.stringify({status:'BROWSING_LINUX_CAPSULE_PASS',directory:stage,capsuleSha256:hash(raw),uniqueTarballs:urls.size,cacheFiles:Object.keys(files).length,uid,networkUsed:false,...cap}));
