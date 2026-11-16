/**
 * M2 mock-only OS-handle lifecycle acceptance contract.
 * No native open, serial API, ioctl, DTR/RTS action, MCP registration or
 * user-selected factory. Handle observations are INJECTED claims, not OS proof.
 */
import { planSerialCapture, type SerialTarget } from "./network-serial-admission.js";
import { compareSerialWitnesses, type SerialIdentityWitness } from "./network-serial-identity-witness.js";
import { OfflineSerialLeaseCoordinator, type SerialLeaseResult } from "./network-serial-session-lease.js";

export type MockHandleObservation = Readonly<{
  handle: object;
  witness: SerialIdentityWitness;
  modemLinesSafe: false; // No untrusted fixture can attest physical line safety.
}>;
export type MockSerialHandle = Readonly<{
  handle: object;
  observe: () => Promise<MockHandleObservation>;
  frames: AsyncIterable<Uint8Array>;
  close: () => Promise<void>;
}>;
export type MockHandleFactory =
  (target: SerialTarget, signal: AbortSignal) => Promise<MockSerialHandle>;
type Capture = Readonly<{status:"SERIAL_MOCK_HANDLE_CAPTURE_COMPLETE";output:string;bytes:number;mayOpenDevice:false}>;
export type MockHandleResult = SerialLeaseResult<Capture> |
  {ok:false;status:"SERIAL_MOCK_ADMISSION_DENIED"};

function redact(s:string):string {
  return s.replace(/\b(password|token|api[_-]?key|secret)\s*[:=]\s*[^\s,;]+/gi,"$1=[REDACTED]");
}
const MAX_FRAME=1024, MAX_OUTPUT=4096;

/**
 * Trusted test harness ONLY. Never bind factory, target, observations or
 * approval from MCP client payload. A positive result remains mock-only.
 */
export async function captureMockSerialHandle(
  request: unknown, targets: readonly SerialTarget[], approval: unknown,
  platform: string, leases: OfflineSerialLeaseCoordinator,
  factory: MockHandleFactory, opts: Readonly<{timeoutMs:number;signal?:AbortSignal}>,
):Promise<MockHandleResult> {
  const plan=planSerialCapture(request,targets,approval,platform);
  if(!plan.ok)return {ok:false,status:"SERIAL_MOCK_ADMISSION_DENIED"};
  const target=targets.find(t=>t.id===plan.targetId);
  if(!target)return {ok:false,status:"SERIAL_MOCK_ADMISSION_DENIED"};
  return leases.run(plan.targetId,async signal=>{
    let session:MockSerialHandle|undefined;
    let result:Capture|undefined;
    let failed=false;
    try {
      session=await factory(target,signal);
      if(signal.aborted || !session.handle || typeof session.handle!=="object")throw Error("invalid mock handle");
      const before=await session.observe();
      if(signal.aborted || before.handle!==session.handle || before.modemLinesSafe!==false ||
         compareSerialWitnesses(plan,target,before.witness,before.witness).ok!==true)
        throw Error("mock handle before identity invalid");
      let total=0;const chunks:Uint8Array[]=[];
      for await(const frame of session.frames) {
        if(signal.aborted || !(frame instanceof Uint8Array) || frame.length>MAX_FRAME ||
           total+frame.length>MAX_OUTPUT)throw Error("mock frame rejected");
        total+=frame.length;chunks.push(Uint8Array.from(frame));
      }
      if(signal.aborted)throw Error("cancelled");
      const after=await session.observe();
      if(signal.aborted || after.handle!==session.handle || after.modemLinesSafe!==false ||
         compareSerialWitnesses(plan,target,before.witness,after.witness).ok!==true)
        throw Error("mock handle after identity changed");
      result={status:"SERIAL_MOCK_HANDLE_CAPTURE_COMPLETE",bytes:total,
        output:redact(new TextDecoder("utf-8",{fatal:false}).decode(Buffer.concat(chunks))),
        mayOpenDevice:false};
    }catch{failed=true;}
    finally {
      if(session) {
        try{await session.close();}catch{failed=true;}
      }
    }
    if(failed || !result || signal.aborted)throw Error("mock handle capture failed");
    return result;
  },opts);
}
