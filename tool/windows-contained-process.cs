using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RuntimeContainment {
    // The only Job handle is held by this host. Abrupt host death closes it in
    // the kernel and kills the entire child tree. A process-creation Job list
    // assigns containment atomically, before even a suspended child exists.
    public static class Host {
        [StructLayout(LayoutKind.Sequential)] struct Security { public int length; public IntPtr descriptor; public int inherit; }
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
            public int cb; public string reserved, desktop, title;
            public int x,y,xsize,ysize,xchars,ychars,fill,flags;
            public short show,reservedSize; public IntPtr reservedData,input,output,error;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
        [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
            public long processTime,jobTime; public uint flags;
            public UIntPtr minWorkingSet,maxWorkingSet; public uint activeProcesses;
            public UIntPtr affinity; public uint priority,scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong r,w,o,rb,wb,ob; }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
            public BasicLimits basic; public IoCounters io;
            public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
        }
        [StructLayout(LayoutKind.Sequential)] struct MemoryCounters {
            public uint cb,faults; public UIntPtr peakWorkingSet,workingSet,peakPaged,paged,peakNonpaged,nonpaged,pagefile,peakPagefile,privateBytes;
        }
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref ExtendedLimits limits,uint length);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out ExtendedLimits limits,uint length,IntPtr returned);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,UIntPtr attribute,IntPtr value,UIntPtr size,IntPtr previous,IntPtr returned);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref Security attributes,uint size);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
        [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
        [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
        [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
        [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("psapi.dll", SetLastError=true)] static extern bool GetProcessMemoryInfo(IntPtr process,ref MemoryCounters counters,uint length);
        static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
        static string Quote(string text) {
            var b=new StringBuilder("\""); int slashes=0;
            foreach(char c in text) {
                if(c=='\\') { slashes++; continue; }
                if(c=='"') { b.Append('\\',slashes*2+1); b.Append(c); slashes=0; continue; }
                b.Append('\\',slashes); slashes=0; b.Append(c);
            }
            b.Append('\\',slashes*2); return b.Append('"').ToString();
        }
        public static int Run(string executable,string[] arguments,string cwd,Dictionary<string,string> environment,ulong memoryBytes) {
            IntPtr job=IntPtr.Zero,block=IntPtr.Zero,ir=IntPtr.Zero,iw=IntPtr.Zero,or=IntPtr.Zero,ow=IntPtr.Zero,er=IntPtr.Zero,ew=IntPtr.Zero,attributes=IntPtr.Zero,jobList=IntPtr.Zero,handleList=IntPtr.Zero;
            var child=new ProcessInfo(); bool assigned=false;
            try {
                job=CreateJobObjectW(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
                var limits=new ExtendedLimits(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE
                if(memoryBytes>0) { limits.basic.flags|=0x200; limits.jobMemory=(UIntPtr)memoryBytes; } // aggregate committed bytes
                Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<ExtendedLimits>()));
                var security=new Security { length=Marshal.SizeOf<Security>(),inherit=1 };
                Check(CreatePipe(out ir,out iw,ref security,0)); Check(SetHandleInformation(iw,1,0));
                Check(CreatePipe(out or,out ow,ref security,0)); Check(SetHandleInformation(or,1,0));
                Check(CreatePipe(out er,out ew,ref security,0)); Check(SetHandleInformation(er,1,0));
                var command=new StringBuilder(Quote(executable)); foreach(string a in arguments) command.Append(' ').Append(Quote(a));
                var keys=new List<string>(environment.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
                var env=new StringBuilder(); foreach(string k in keys) { if(k.Contains("=") || k.Contains("\0") || environment[k].Contains("\0")) throw new ArgumentException("invalid_environment"); env.Append(k).Append('=').Append(environment[k]).Append('\0'); } env.Append('\0');
                block=Marshal.StringToHGlobalUni(env.ToString());
                IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
                attributes=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes,2,0,ref size));
                jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,job);
                Check(UpdateProcThreadAttribute(attributes,0,(UIntPtr)0x2000D,jobList,(UIntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero));
                handleList=Marshal.AllocHGlobal(IntPtr.Size*3);
                Marshal.WriteIntPtr(handleList,0,ir); Marshal.WriteIntPtr(handleList,IntPtr.Size,ow); Marshal.WriteIntPtr(handleList,IntPtr.Size*2,ew);
                Check(UpdateProcThreadAttribute(attributes,0,(UIntPtr)0x20002,handleList,(UIntPtr)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
                var startup=new StartupEx { startup=new Startup { cb=Marshal.SizeOf<StartupEx>(),flags=0x100,input=ir,output=ow,error=ew },attributes=attributes };
                Check(CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,block,cwd,ref startup,out child)); assigned=true;
                CloseHandle(ir); ir=IntPtr.Zero; CloseHandle(ow); ow=IntPtr.Zero; CloseHandle(ew); ew=IntPtr.Zero;
                Console.Error.WriteLine("{\"containment\":\"ready\",\"pid\":"+child.pid+",\"hostPid\":"+Environment.ProcessId+",\"memoryBytes\":"+memoryBytes+"}");
                if(ResumeThread(child.thread)==UInt32.MaxValue) throw new Exception("resume_failed");
                var input=new StreamWriter(new FileStream(new SafeFileHandle(iw,true),FileAccess.Write),new UTF8Encoding(false)) { AutoFlush=true }; iw=IntPtr.Zero;
                var output=new FileStream(new SafeFileHandle(or,true),FileAccess.Read); or=IntPtr.Zero;
                var error=new FileStream(new SafeFileHandle(er,true),FileAccess.Read); er=IntPtr.Zero;
                var stdout=output.CopyToAsync(Console.OpenStandardOutput());
                var stderr=error.CopyToAsync(Console.OpenStandardError());
                var stdin=Task.Run(async () => {
                    try { string line; while((line=await Console.In.ReadLineAsync())!=null) await input.WriteLineAsync(line); }
                    catch(IOException) { /* Broken child stdin is followed by process exit. */ }
                    finally { input.Dispose(); TerminateJobObject(job,78); }
                });
                while(WaitForSingleObject(child.process,500)==0x102) {
                    if(!QueryInformationJobObject(job,9,out limits,(uint)Marshal.SizeOf<ExtendedLimits>(),IntPtr.Zero)) throw new Exception("job_telemetry_failed");
                    var counters=new MemoryCounters { cb=(uint)Marshal.SizeOf<MemoryCounters>() };
                    Check(GetProcessMemoryInfo(child.process,ref counters,counters.cb));
                    Console.Error.WriteLine("{\"containment\":\"sample\",\"pid\":"+child.pid+",\"privateBytes\":"+counters.privateBytes.ToUInt64()+",\"workingSetBytes\":"+counters.workingSet.ToUInt64()+",\"peakJobBytes\":"+limits.peakJobMemory.ToUInt64()+"}");
                }
                GetExitCodeProcess(child.process,out uint code);
                Check(QueryInformationJobObject(job,9,out limits,(uint)Marshal.SizeOf<ExtendedLimits>(),IntPtr.Zero));
                // Descendants may outlive the main process; close the Job before draining pipes.
                TerminateJobObject(job,78);
                Task.WaitAll(new[]{stdout,stderr},5000);
                Console.Error.WriteLine("{\"containment\":\"exited\",\"pid\":"+child.pid+",\"code\":"+code+",\"peakJobBytes\":"+limits.peakJobMemory.ToUInt64()+"}");
                return unchecked((int)code);
            } finally {
                if(child.process!=IntPtr.Zero && !assigned) TerminateProcess(child.process,78);
                if(job!=IntPtr.Zero) CloseHandle(job);
                if(child.thread!=IntPtr.Zero) CloseHandle(child.thread); if(child.process!=IntPtr.Zero) CloseHandle(child.process);
                if(block!=IntPtr.Zero) Marshal.FreeHGlobal(block);
                if(attributes!=IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
                if(jobList!=IntPtr.Zero) Marshal.FreeHGlobal(jobList); if(handleList!=IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                foreach(var h in new[]{ir,iw,or,ow,er,ew}) if(h!=IntPtr.Zero) CloseHandle(h);
            }
        }
    }
}
