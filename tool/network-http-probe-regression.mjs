import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {approvedProbeUrl,probeApprovedHttp} from '../dist/tool/network-http-probe.js';
for(const target of ['http://127.0.0.1','https://100.111.12.117','http://example.com','http://user:secret@100.111.12.117','http://10.0.88.38:3333'])assert.throws(()=>approvedProbeUrl(target),/NOT_ALLOWED/);
const original=http.request;let calls=0,mode='body';
http.request=(url,options,callback)=>{
 calls++;assert.equal(options.agent,false);assert.equal(url.hostname,'100.111.12.117');
 const request=new EventEmitter();request.destroy=()=>{};
 request.end=()=>queueMicrotask(()=>{
  if(mode==='hang')return;
  const response=new EventEmitter();response.statusCode=mode==='redirect'?302:200;response.destroy=()=>{};
  response.headers={location:'http://127.0.0.1:3334/secret'};
  callback(response);
  if(mode==='body')response.emit('data',Buffer.from('abcdefgh'));
  response.emit('end');
 });return request;
};
try{
 const bounded=await probeApprovedHttp('http://100.111.12.117/status?token=private','GET',1000,4);
 assert.equal(bounded.response.body,'abcd');assert.equal(bounded.response.truncated,true);assert.equal(JSON.stringify(bounded).includes('private'),false);
 mode='redirect';const before=calls;
 const redirected=await probeApprovedHttp('http://100.111.12.117','HEAD',1000,0);
 assert.equal(redirected.response.statusCode,302);assert.equal(redirected.redirectsFollowed,0);assert.equal(calls,before+1);
 mode='hang';const time=Date.now();
 const timeout=await probeApprovedHttp('http://100.111.12.117','HEAD',1000,0);
 assert.equal(timeout.response.error,'NETWORK_PROBE_TIMEOUT');assert.ok(Date.now()-time<2500);
 console.log('NETWORK_HTTP_PROBE_REGRESSION_PASS: exact allowlist, no credentials/DNS/redirects, query redaction, body limit and absolute timeout');
}finally{http.request=original;}
