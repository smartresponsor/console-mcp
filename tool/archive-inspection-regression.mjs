import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {mkdtemp,writeFile,readFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inspectZip,crc32} from '../dist/service/archive-inspection.js';
import {registerArchiveInspectionTools} from '../dist/tool/archive-inspection.js';
function fixture(name='safe/file.txt',method=8,content=Buffer.from('preserve source')){
  const filename=Buffer.from(name), packed=method===8?deflateRawSync(content):content,crc=crc32(content);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(method,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(filename.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(method,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(content.length,24);central.writeUInt16LE(filename.length,28);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(46+filename.length,12);end.writeUInt32LE(local.length+filename.length+packed.length,16);
  return Buffer.concat([local,filename,packed,central,filename,end]);
}
assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
for(const method of [0,8])assert.equal(inspectZip(fixture('safe.txt',method),true).verified,true);
for(const name of ['../escape','/absolute','C:alternate','a\\b','bad\0file'])assert.equal(inspectZip(fixture(name),true).ok,false);
const broken=fixture();broken[30+Buffer.byteLength('safe/file.txt')]^=0x7f;
assert.throws(()=>inspectZip(broken,true));
assert.throws(()=>inspectZip(Buffer.alloc(10),true));
const mismatch=fixture();mismatch[30]^=1;assert.throws(()=>inspectZip(mismatch,true),/mismatch/);
const encrypted=fixture();encrypted.writeUInt16LE(1,6);encrypted.writeUInt16LE(1,encrypted.length-22-46-Buffer.byteLength('safe/file.txt')+8);assert.throws(()=>inspectZip(encrypted,true),/Encrypted/);
const large=fixture();const cd=large.readUInt32LE(large.length-6);large.writeUInt32LE(40*1024*1024,cd+24);assert.throws(()=>inspectZip(large,true));
const root=await mkdtemp(path.join(tmpdir(),'archive-proof-')),file=path.join(root,'fixture.zip'),denied=path.join(root,'.env');
try{
 const bytes=fixture();await writeFile(file,bytes);await writeFile(denied,'private sentinel');
 const tools=new Map();const policy={allowedRoots:[root],maxFileBytes:1024*1024,deniedPath:{denyBasenames:['.env'],denyExtensions:[],denyPathFragments:[],allowlist:[]}};
 registerArchiveInspectionTools({registerTool:(name,definition,handler)=>tools.set(name,handler)},policy,{mode:'bearer',bearerToken:'fixture'});
 for(const name of ['read_.archive.zip.inspect','read_.archive.zip.verify'])assert.equal(JSON.parse((await tools.get(name)({archivePath:file})).content[0].text).ok,true);
 await assert.rejects(()=>tools.get('read_.file.metadata.inspect')({filePath:denied,sha256:true}),/policy/);
 await assert.rejects(()=>tools.get('read_.file.metadata.inspect')({filePath:path.dirname(root),sha256:true}),/outside/);
 policy.maxFileBytes=1;await assert.rejects(()=>tools.get('read_.archive.zip.verify')({archivePath:file}),/read limit/);
 assert.deepEqual(await readFile(file),bytes);assert.equal(await readFile(denied,'utf8'),'private sentinel');
 console.log('ARCHIVE_INSPECTION_REGRESSION_PASS: stored/deflate CRC, hostile paths, corruption, header mismatch, encryption, size limits, policy and preserved files');
}finally{await unlink(file);await unlink(denied);await rmdir(root);}
