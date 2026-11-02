import assert from "node:assert/strict";
import { inspectBrowserPrompts } from "../dist/service/browser-prompt-supervisor.js";
const invalid=await inspectBrowserPrompts(0,200);
assert.equal(invalid.ok,false);
assert.equal(invalid.status,"BROWSER_PROMPT_PORT_INVALID");
assert.equal(invalid.browserChromePrompts,"UNOBSERVABLE");
assert.equal(invalid.mutationAttempted,false);
const unavailable=await inspectBrowserPrompts(1,200);
assert.equal(unavailable.status,"BROWSER_PROMPT_CDP_UNAVAILABLE");
assert.equal(unavailable.observations[0].status,"UNOBSERVABLE");
assert.equal(unavailable.mutationAttempted,false);

const realFetch=globalThis.fetch;
const RealWebSocket=globalThis.WebSocket;
try {
  const targetId='A'.repeat(32);
  globalThis.fetch=async()=>({ok:true,json:async()=>[{id:targetId,type:'page',webSocketDebuggerUrl:`ws://127.0.0.1:9223/devtools/page/${targetId}`}]});
  globalThis.WebSocket=class {
    handlers=new Map();
    constructor(){queueMicrotask(()=>this.handlers.get('open')?.({}));}
    addEventListener(name,fn){this.handlers.set(name,fn);}
    send(payload){
      assert.equal(JSON.parse(payload).method,'Page.enable');
      queueMicrotask(()=>{
        this.handlers.get('message')?.({data:JSON.stringify({id:1,result:{}})});
        this.handlers.get('message')?.({data:JSON.stringify({method:'Page.javascriptDialogOpening',params:{type:'beforeunload'}})});
      });
    }
    close(){}
  };
  const detected=await inspectBrowserPrompts(9223,500);
  assert.equal(detected.status,'BROWSER_PROMPT_DETECTED');
  assert.equal(detected.observations[0].dialogType,'beforeunload');
  assert.equal(detected.observations[0].resolution,'MANUAL_REVIEW');
  assert.equal(detected.mutationAttempted,false);
  assert.equal(detected.browserChromePrompts,'UNOBSERVABLE');
} finally {globalThis.fetch=realFetch;globalThis.WebSocket=RealWebSocket;}

console.log("Browser prompt supervisor fail-closed and CDP event fixtures PASS");
