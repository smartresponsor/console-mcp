import path from 'node:path';
import { readJson,resolveVersion } from './runtime-version-store.mjs';
import { selectorRouter } from './runtime-selector-router.mjs';
import { cutover } from './runtime-version-transaction.mjs';
import { probe } from './runtime-mcp-probe.mjs';
const config=await readJson(process.argv[2]);
if(config.mode!=='isolated-validation'||config.previous?.token)throw Error('isolated_validation_required');
config.previous.token=process.env.RUNTIME_PREVIOUS_BEARER_TOKEN;
const token=process.env.RUNTIME_ROUTER_BEARER_TOKEN;
for(const reference of [config.previous.reference,config.candidate]){
  if((await readJson(reference.manifest)).schema!==2)throw Error('immutable_release_required');
  await resolveVersion(reference);
}
const router=await selectorRouter({selector:path.join(config.base,'active.json'),port:config.routerPort,token,maxRequests:config.maxRequests,maxBodyBytes:config.maxBodyBytes});
router.register(config.previous.reference,config.previous);
let transaction;
try{
  const before=await probe({port:config.routerPort,token});
  if(before.pid!==config.previous.pid)throw Error('initial_route_identity');
  transaction=await cutover({...config,routing:router});
  const selected=await probe({port:config.routerPort,token});
  if(selected.pid!==transaction.candidatePid)throw Error('selected_route_identity');
  await transaction.rollback();transaction=undefined;
  const rolledBack=await probe({port:config.routerPort,token});
  if(rolledBack.pid!==config.previous.pid)throw Error('rollback_route_identity');
  console.log(JSON.stringify({ok:true,status:'VERSION_ROUTE_VALIDATION_PASSED',beforePid:before.pid,selectedPid:selected.pid,rolledBackPid:rolledBack.pid,routerPort:config.routerPort,metrics:router.metrics,productionChanged:false}));
}finally{
  if(transaction)await transaction.rollback();
  await router.close();
}
