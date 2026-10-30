import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const platform=Object.getOwnPropertyDescriptor(process,'platform'), original=childProcess.execFile;
let invocation, reply={ok:false,status:'WINDOW_ACTIVATION_REFUSED'};
Object.defineProperty(process,'platform',{value:'win32',configurable:true});
childProcess.execFile=(file,args,options,callback)=>{invocation={file,args,options};callback(null,JSON.stringify(reply));};
syncBuiltinESMExports();
try {
  const {registerWindowTools}=await import('../dist/tool/window.js');
  const tools=new Map();
  registerWindowTools({registerTool:(name,definition,handler)=>tools.set(name,{definition,handler})},{mode:'bearer',bearerToken:'fixture'});
  const activation=tools.get('write.window.activate');
  assert.equal(activation.definition.inputSchema.safeParse({windowId:'0x1'}).success,false);
  assert.equal(activation.definition.inputSchema.safeParse({windowId:'not-a-window',approved:true}).success,false);
  assert.equal(activation.definition.inputSchema.safeParse({windowId:'0x1',approved:true}).success,true);
  const refused=await activation.handler({windowId:'0x1',approved:true});
  assert.equal(JSON.parse(refused.content[0].text).ok,false);
  assert.ok(invocation.args.includes('-Approved'));
  assert.equal(invocation.args[invocation.args.indexOf('-WindowId')+1],'0x1');
  reply={ok:true,status:'WINDOW_ACTIVATED',visibility_verified:true,user_interaction_ready:true};
  const accepted=JSON.parse((await activation.handler({windowId:'0x1',approved:true})).content[0].text);
  assert.equal(accepted.status,'WINDOW_ACTIVATED');
  assert.equal(accepted.visibility_verified,false,'Window focus never establishes browser identity');
  assert.equal(accepted.user_interaction_ready,false);
  await tools.get('read_.window.inventory').handler({});
  assert.equal(invocation.args.includes('-Approved'),false);
  console.log('WINDOWS_WINDOW_ACTIVATION_REGRESSION_PASS: strict consent, exact ID, refusal and capability separation');
} finally {
  childProcess.execFile=original;syncBuiltinESMExports();Object.defineProperty(process,'platform',platform);
}
