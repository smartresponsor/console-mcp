import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { realpath,open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ConsolePolicy } from '../Policy/ConsolePolicy.js';
import type { ConsoleAuthConfig } from '../Security/Auth/ConsoleAuth.js';
import { assertReadablePath } from '../Policy/PathGuard.js';
import { buildConsoleToolRegistration,textResult } from './common.js';
import { inspectZip } from '../service/archive-inspection.js';

async function inspectFile(policy:ConsolePolicy,candidate:string,read:boolean){
  const checked=assertReadablePath(candidate,policy.deniedPath,policy.allowedRoots);
  const canonical=await realpath(checked);
  assertReadablePath(canonical,policy.deniedPath,policy.allowedRoots);
  const handle=await open(canonical,'r');
  try{
    const info=await handle.stat();
    if(!info.isFile() || (read && info.size>Math.min(policy.maxFileBytes,64*1024*1024)))throw new Error('Regular file within configured read limit required');
    const bytes=read?Buffer.alloc(info.size):undefined;
    if(bytes){let offset=0;while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw new Error('File changed during inspection');offset+=bytesRead;}}
    const after=await handle.stat();
    if(after.size!==info.size || after.mtimeMs!==info.mtimeMs || await realpath(checked)!==canonical)throw new Error('File changed during inspection');
    return {path:canonical,sizeBytes:info.size,modifiedAt:info.mtime.toISOString(),bytes};
  }finally{await handle.close();}
}
export function registerArchiveInspectionTools(server:McpServer,policy:ConsolePolicy,auth:ConsoleAuthConfig):void{
  server.registerTool('read_.file.metadata.inspect',{
    description:'Inspect allowed regular-file metadata and optional bounded SHA-256 without changing it.',
    inputSchema:z.object({filePath:z.string().min(1),sha256:z.boolean().default(false)}).strict(),...buildConsoleToolRegistration(auth),
  },async({filePath,sha256})=>{
    const {bytes,...metadata}=await inspectFile(policy,filePath,sha256);
    return textResult({ok:true,...metadata,sha256:bytes?createHash('sha256').update(bytes).digest('hex'):undefined});
  });
  server.registerTool('read_.archive.zip.inspect',{
    description:'Inspect bounded ZIP entries and flag traversal/symlinks without extraction. ZIP64/encryption are refused.',
    inputSchema:z.object({archivePath:z.string().min(1)}).strict(),...buildConsoleToolRegistration(auth),
  },async({archivePath})=>{
    const file=await inspectFile(policy,archivePath,true);
    return textResult({...inspectZip(file.bytes!),path:file.path});
  });
  server.registerTool('read_.archive.zip.verify',{
    description:'Verify bounded ZIP CRC and local/central structure in memory, without extracting or executing entries.',
    inputSchema:z.object({archivePath:z.string().min(1)}).strict(),...buildConsoleToolRegistration(auth),
  },async({archivePath})=>{
    const file=await inspectFile(policy,archivePath,true);
    return textResult({...inspectZip(file.bytes!,true),path:file.path});
  });
}
