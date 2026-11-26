import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

export type OwnerBaseline = { head: string; statusHash: string; worktreeFingerprint: string; untrackedCount: number; diffCheckOk: boolean };

const authenticatedClient = "import socket,struct,json,sys,time\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)\nend=time.monotonic()+34\nwith s:\n s.settimeout(34);s.connect(sys.argv[1])\n if struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]!=1000: raise PermissionError('SERVER_DENIED')\n s.sendall(sys.argv[2].encode()+b'\\n')\n data=b''\n while b'\\n' not in data:\n  remaining=end-time.monotonic()\n  if remaining<=0: raise TimeoutError('TIMEOUT')\n  s.settimeout(remaining)\n  chunk=s.recv(min(4096,65537-len(data)))\n  if not chunk: raise ValueError('INCOMPLETE')\n  data+=chunk\n  if len(data)>65536: raise ValueError('RESPONSE_LIMIT')\n if data.count(b'\\n')!=1 or not data.endswith(b'\\n'): raise ValueError('FRAMING')\n sys.stdout.buffer.write(data)";
const repositoryResolver = "import os,stat,json,sys,re\ndef unique(pairs):\n d={}\n for k,v in pairs:\n  if k in d: raise ValueError('DUPLICATE')\n  d[k]=v\n return d\nfd=os.open('/',os.O_DIRECTORY)\ntry:\n for part in ('etc','console-mcp'):\n  new=os.open(part,os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)\n  os.close(fd);fd=new\n  s=os.fstat(fd)\n  if s.st_uid!=0 or s.st_mode&0o022: raise PermissionError('CONFIG_PARENT')\n with os.fdopen(os.open('preservation-audit.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd),'rb') as f:\n  s=os.fstat(f.fileno())\n  if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022 or s.st_nlink!=1: raise PermissionError('CONFIG_FILE')\n  raw=f.read(1048577)\n  t=os.fstat(f.fileno())\n  if len(raw)>1048576 or (s.st_size,s.st_mtime_ns,s.st_ctime_ns)!=(t.st_size,t.st_mtime_ns,t.st_ctime_ns): raise ValueError('CONFIG_CHANGED')\nfinally: os.close(fd)\ncfg=json.loads(raw,object_pairs_hook=unique)\nrepos=cfg['repositories']\npath=sys.argv[1]\nif os.path.realpath(path)!=path: raise ValueError('WORKSPACE')\nmatches=[k for k,v in repos.items() if v==path]\nif len(matches)!=1 or not re.fullmatch('[A-Za-z0-9-]{1,64}',matches[0]): raise ValueError('REPOSITORY_BINDING')\nif cfg['socket']!=sys.argv[2] or not os.path.isabs(cfg['socket']) or os.path.normpath(cfg['socket'])!=cfg['socket']: raise ValueError('SOCKET_BINDING')\nprint(matches[0])";
const run = promisify(execFile);

export function requiresOwnerBaseline(workspacePath: string): boolean {
  return process.platform === "linux" && (process.getuid?.() === 993 || Boolean(process.env.CONSOLE_MCP_PRESERVATION_SOCKET) || workspacePath === "/home/alex/smartresponse" || workspacePath.startsWith("/home/alex/smartresponse/"));
}

export function baselineProvenanceMatches(workspacePath: string, fingerprint: unknown): boolean {
  return typeof fingerprint === "string" && (requiresOwnerBaseline(workspacePath) ? /^preservation-v3:[a-f0-9]{64}$/.test(fingerprint) : /^[a-f0-9]{64}$/.test(fingerprint));
}

export async function captureOwnerBaseline(workspacePath: string): Promise<OwnerBaseline> {
  const socketPath = process.env.CONSOLE_MCP_PRESERVATION_SOCKET;
  if (!socketPath) throw new Error("PRESERVATION_CONFIGURATION");
  const expected = await realpath(workspacePath);
  if (expected !== workspacePath) throw new Error("PRESERVATION_NONCANONICAL_WORKSPACE");
  const { stdout: aliasOutput } = await run("/usr/bin/python3", ["-I", "-B", "-c", repositoryResolver, expected, socketPath], {timeout:5000,maxBuffer:4096,env:{PATH:"/usr/bin:/bin",LC_ALL:"C"}});
  const repository = aliasOutput.trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(repository)) throw new Error("PRESERVATION_REPOSITORY");
  const requestId = randomUUID();
  const { stdout } = await run("/usr/bin/python3", ["-I", "-B", "-c", authenticatedClient, socketPath, JSON.stringify({version:1, operation:"baseline", requestId, repository})], {timeout:35000,maxBuffer:65536,env:{PATH:"/usr/bin:/bin",LC_ALL:"C"}});
  const reply = JSON.parse(stdout);
  if (reply.requestId !== requestId || reply.status !== "BASELINE_COMPLETE" || reply.uid !== 1000 || reply.workspace !== expected) throw new Error("PRESERVATION_REJECTED");
  const b = reply.baseline;
  if (!b || typeof b.diffCheckOk !== "boolean" || typeof b.head !== "string" || !/^[a-f0-9]{40}$/.test(b.head) || typeof b.statusHash !== "string" || !/^[a-f0-9]{64}$/.test(b.statusHash) || typeof b.worktreeFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(b.worktreeFingerprint) || !Number.isInteger(b.untrackedCount) || b.untrackedCount < 0 || b.untrackedCount > 200) throw new Error("PRESERVATION_BASELINE_SCHEMA");
  if (b.fingerprintVersion !== "preservation-v3") throw new Error("PRESERVATION_FINGERPRINT_VERSION");
  return { ...b, worktreeFingerprint: `preservation-v3:${b.worktreeFingerprint}` };
}
