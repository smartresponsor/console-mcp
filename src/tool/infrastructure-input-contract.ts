import { z } from "zod";
import type { InfraOperation } from "./infrastructure-normalization.js";

// Public schemas are platform-neutral; adapter-specific defaults remain internal.
const local=z.object({targetId:z.literal("local")}).strict();
const limit=local.extend({limit:z.number().int().min(1).max(100).default(50)}).strict();
const portLimit=limit.extend({port:z.number().int().min(1).max(65535).optional()}).strict();
const pid=local.extend({pid:z.number().int().min(1).max(4194304)}).strict();
const service=local.extend({serviceId:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.@-]+\.service$/)}).strict();
const journalList=local.extend({
  serviceId:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.@-]+\.service$/).optional(),
  minutes:z.number().int().min(1).max(60).default(15),
  limit:z.number().int().min(1).max(100).default(30)
}).strict();
const journalDetail=local.extend({cursor:z.string().min(8).max(512).regex(/^[A-Za-z0-9_.;=:-]+$/)}).strict();
const fd=pid.extend({limit:z.number().int().min(1).max(100).default(50)}).strict();
const oom=local.extend({minutes:z.number().int().min(1).max(60).default(15),limit:z.number().int().min(1).max(50).default(20)}).strict();

export const infraInputSchemas={
 "ipv4.interface.list":local, "ipv4.route.list":local, "ipv4.neighbor.list":local,
 "tcp.listener.list":portLimit, "tcp.connection.list":portLimit, "udp.socket.list":portLimit,
 "dns.resolver.inspect":local,"firewall.chain.list":local,"firewall.policy.inspect":local,
 "system.process.list":limit,"system.process.detail":pid,"system.process.fd.list":fd,
 "system.memory.status":local,"system.cpu.load.inspect":local,"system.storage.io.status":local,
 "system.service.list":limit,"system.service.status":service,
 "system.journal.record.list":journalList,"system.journal.record.detail":journalDetail,
 "system.kernel.oom.record.list":oom
} satisfies Record<InfraOperation,z.ZodTypeAny>;
export function parseInfrastructureInput(operation:InfraOperation,input:unknown):Record<string,unknown>{
 return infraInputSchemas[operation].parse(input) as Record<string,unknown>;
}
