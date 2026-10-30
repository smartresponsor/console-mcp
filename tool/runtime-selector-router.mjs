import http from 'node:http';
import { lstat } from 'node:fs/promises';
import { readJson } from './runtime-version-store.mjs';

const key=value=>JSON.stringify(value);
export async function selectorRouter({selector,port,token,maxRequests,maxBodyBytes}) {
  if(!Number.isInteger(port)||port<1024||port>65535||[3333,3334,3335,8000,8080,9222,9223].includes(port))throw Error('production_route_activation_blocked');
  if(!token||!Number.isSafeInteger(maxRequests)||maxRequests<1||!Number.isSafeInteger(maxBodyBytes)||maxBodyBytes<1)throw Error('explicit_route_resource_policy_required');
  const backends=new Map(),sockets=new Set();let active=0;
  const metrics={requests:0,rejected:0,peakActive:0};
  const server=http.createServer(async(req,res)=>{
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end();req.resume();return;}
    if(req.url!=='/mcp'||req.headers['mcp-session-id']){res.writeHead(400);res.end('stateless_mcp_route_required');req.resume();return;}
    if(active>=maxRequests){metrics.rejected++;res.writeHead(503,{'Retry-After':'1'});res.end();req.resume();return;}
    active++;metrics.requests++;metrics.peakActive=Math.max(metrics.peakActive,active);
    let finished=false;
    const finish=()=>{if(!finished){finished=true;active--;}};
    res.once('close',finish);
    try{
      if((await lstat(selector)).size>4096)throw Error('selector_size_invalid');
      const target=backends.get(key(await readJson(selector)));
      if(!target)throw Error('selector_backend_not_verified');
      const headers={...req.headers,host:`127.0.0.1:${target.port}`,authorization:`Bearer ${target.token}`};
      delete headers.connection;delete headers['proxy-authorization'];
      const outgoing=http.request({hostname:'127.0.0.1',port:target.port,path:'/mcp',method:req.method,headers},upstream=>{
        const responseHeaders={...upstream.headers};delete responseHeaders.connection;
        res.writeHead(upstream.statusCode,responseHeaders);upstream.pipe(res);
        upstream.once('error',()=>res.destroy());
      });
      outgoing.setTimeout(30000,()=>outgoing.destroy(Error('route_timeout')));
      outgoing.once('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
      res.once('close',()=>outgoing.destroy());
      let bytes=0;
      req.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBodyBytes){outgoing.destroy();res.destroy();}});
      req.once('aborted',()=>outgoing.destroy());req.pipe(outgoing);
    }catch{
      metrics.rejected++;res.writeHead(503);res.end('selector_unavailable');req.resume();
    }
  });
  server.maxConnections=maxRequests*2;
  server.headersTimeout=10000;server.requestTimeout=30000;
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {
    register(reference,backend){
      if(backends.size>=2&&!backends.has(key(reference)))throw Error('route_version_capacity');
      if(!Number.isInteger(backend.port)||backend.port<1024||backend.port>65535||[3333,3334,3335].includes(backend.port)||!backend.token)throw Error('invalid_isolated_backend');
      backends.set(key(reference),{...backend});
    },metrics,
    async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));},
  };
}
