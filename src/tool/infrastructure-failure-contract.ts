// Normalized failure semantics for passive Infrastructure Diagnostics.
// Never return raw command stderr to ChatGPT: stderr may contain host paths or secrets.
export type FailureStatus="permission_denied"|"timeout"|"unavailable"|"no_data";
export type FailureEvidence={status:FailureStatus;warning:string};
export function classifyCommandFailure(input:{exitCode:number|null;stderr?:string;stdout?:string;timedOut?:boolean}):FailureEvidence{
 if(input.timedOut)return {status:"timeout",warning:"observation timed out"};
 const stderr=(input.stderr??"").slice(0,4096).toLowerCase();
 if(/\betimedout\b|\betimedout\s*\b|\btimed out\b|\btimeout exceeded\b|\bcommand timed out\b/i.test(stderr))
  return {status:"timeout",warning:"observation timed out"};
 if(/permission denied|access is denied|operation not permitted|unauthorizedaccess|requires elevation|not authorized/.test(stderr))
  return {status:"permission_denied",warning:"insufficient rights for observation"};
 if(/no such process|no entries|no data|not found in journal/.test(stderr))
  return {status:"no_data",warning:"requested record not available"};
 return {status:"unavailable",warning:"observation source unavailable"};
}
export function failureObservation(source:string,platform:"linux"|"windows",failure:FailureEvidence){
 return {ok:false,status:failure.status,targetId:"local" as const,vantage:"local" as const,
  technology:platform,source,collectedAt:new Date().toISOString(),data:{},warnings:[failure.warning],truncated:false};
}
