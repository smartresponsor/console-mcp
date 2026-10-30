import http from 'node:http';
import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {ConsoleAuthConfig} from '../Security/Auth/ConsoleAuth.js';
import {buildConsoleToolRegistration,textResult} from './common.js';

export function approvedProbeUrl(raw:string):URL {
  const url=new URL(raw);
  if(url.protocol!=='http:' || url.username || url.password || !['100.111.12.117','10.0.88.38'].includes(url.hostname) || !['','80','52893'].includes(url.port))throw new Error('NETWORK_TARGET_NOT_ALLOWED');
  url.hash='';return url;
}
export function probeApprovedHttp(raw:string,method:'HEAD'|'GET',timeoutMs:number,maxBodyBytes:number):Promise<Record<string,unknown>>{
  const url=approvedProbeUrl(raw);
  if(!['HEAD','GET'].includes(method) || timeoutMs<1000 || timeoutMs>10000 || maxBodyBytes<0 || maxBodyBytes>65536)throw new Error('NETWORK_PROBE_LIMIT_INVALID');
  return new Promise(resolve=>{
    let completed=false;let request:http.ClientRequest|undefined;let response:http.IncomingMessage|undefined;
    const chunks:Buffer[]=[];let received=0,stored=0;let deadline:ReturnType<typeof setTimeout>;
    const finish=(error:string|null)=>{
      if(completed)return;completed=true;clearTimeout(deadline);
      const status=response?.statusCode??null;
      const safe=new URL(url);safe.search='';
      resolve({ok:!error && status!==null && status>=200 && status<400,request:{method,url:safe.href,timeoutMs},response:{statusCode:status,body:Buffer.concat(chunks).toString('utf8'),truncated:received>stored,error},redirectsFollowed:0});
      response?.destroy();request?.destroy();
    };
    deadline=setTimeout(()=>finish('NETWORK_PROBE_TIMEOUT'),timeoutMs);
    request=http.request(url,{method,agent:false},res=>{
      response=res;
      res.on('error',()=>finish('NETWORK_PROBE_STREAM_ERROR'));
      res.on('data',(chunk:Buffer)=>{received+=chunk.length;const part=chunk.subarray(0,Math.max(0,maxBodyBytes-stored));chunks.push(part);stored+=part.length;if(received>maxBodyBytes)finish(null);});
      res.on('end',()=>finish(null));
      res.on('aborted',()=>finish('NETWORK_PROBE_ABORTED'));
    });
    request.on('error',()=>finish('NETWORK_PROBE_CONNECTION_ERROR'));request.end();
  });
}
export function registerNetworkHttpProbe(server:McpServer,auth:ConsoleAuthConfig):void{
  server.registerTool('read_.network.http.probe',{
    description:'Read-only HTTP probe for the two existing approved iPhone addresses. No credentials, DNS or redirect following.',
    inputSchema:z.object({url:z.string().min(1).max(2048),method:z.enum(['GET','HEAD']).default('HEAD'),timeoutMs:z.number().int().min(1000).max(10000).default(5000),maxBodyBytes:z.number().int().min(0).max(65536).default(8192)}).strict(),...buildConsoleToolRegistration(auth),
  },async({url,method,timeoutMs,maxBodyBytes})=>textResult(await probeApprovedHttp(url,method,timeoutMs,maxBodyBytes)));
}
