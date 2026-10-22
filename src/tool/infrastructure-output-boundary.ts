import type { InfraObservation } from "./infrastructure-normalization.js";
// Conservative output cap. Never silently describe a clipped observation as complete.
export const MAX_OBSERVATION_BYTES=32768;
export const MAX_WARNING_COUNT=8;
export const MAX_WARNING_CHARS=160;
export function finalizeInfrastructureObservation(value:InfraObservation):InfraObservation {
 const warnings=value.warnings.slice(0,MAX_WARNING_COUNT).map(w=>String(w).slice(0,MAX_WARNING_CHARS));
 const safe:{[key:string]:unknown}={};
 let clipped=value.truncated || value.warnings.length>MAX_WARNING_COUNT;
 for(const [key,field] of Object.entries(value.data)){
   const candidate={...safe,[key]:field};
   if(Buffer.byteLength(JSON.stringify(candidate),"utf8")>MAX_OBSERVATION_BYTES-2048) {
     clipped=true;
     // Explicitly retain an array prefix when possible, preserving evidence.
     if(Array.isArray(field)){
       const kept:unknown[]=[];
       for(const element of field){
         if(Buffer.byteLength(JSON.stringify({...safe,[key]:[...kept,element]}),"utf8")>MAX_OBSERVATION_BYTES-2048)break;
         kept.push(element);
       }
       safe[key]=kept;
     }
   }else safe[key]=field;
 }
 if(clipped && !warnings.includes("observation output truncated")) { if(warnings.length>=MAX_WARNING_COUNT)warnings.pop(); warnings.push("observation output truncated"); }
 return {...value,data:safe,warnings:warnings.slice(0,MAX_WARNING_COUNT),truncated:clipped,
   status:clipped && value.status==="complete"?"partial":value.status,
   ok:value.status==="complete"||value.status==="partial"};
}
