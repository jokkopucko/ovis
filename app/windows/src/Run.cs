using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace Ovis
{
    internal struct RunResult
    {
        public int Status;
        public string Output;
    }

    /// <summary>
    /// Runs what a terminal user would run. Every program goes through cmd.exe, which finds it on PATH as a
    /// terminal does (bun.exe or a bun.cmd shim alike), and which is started with the desktop app breakaway
    /// policy: from the Store's MSIX, whatever cmd starts runs outside the package, so herdr, Bun and the
    /// installer write to the user's real AppData, and a herdr server outlives an update or removal of the app.
    /// Outside a package the policy changes nothing.
    /// </summary>
    internal static class Run
    {
        public static Task<RunResult> Program(string program, IEnumerable<string> arguments, Action<string> onLine = null, bool keepStderr = true, int limitSeconds = 120)
        {
            var words = new[] { program }.Concat(arguments).ToArray();
            return Task.Run(() => RunToEnd(words, onLine, keepStderr, limitSeconds));
        }

        public static void Detached(string program, IEnumerable<string> arguments)
        {
            // start /b: cmd hands the program its own hidden console and exits, so no cmd lives on beside it
            var process = Create("start \"\" /b ", new[] { program }.Concat(arguments).ToArray(), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            process.WaitForExit(10000);
            process.Dispose();
        }

        public static string Quote(string argument)
        {
            if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '"', '&', '|', '<', '>', '^', '(', ')' }) < 0) return argument;
            return "\"" + argument.Replace("\"", "\\\"") + "\"";
        }

        private static RunResult RunToEnd(string[] words, Action<string> onLine, bool keepStderr, int limitSeconds)
        {
            var lines = new List<string>();
            var security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
            IntPtr read, write;
            if (!CreatePipe(out read, out write, ref security, 0)) return Failed(new Win32Exception().Message);
            // only the child gets the pipe's write end and the empty stdin
            SetHandleInformation(read, HandleFlagInherit, 0);
            var input = CreateFile("NUL", GenericRead, 3, ref security, OpenExisting, 0, IntPtr.Zero);
            var error = keepStderr ? write : CreateFile("NUL", GenericWrite, 3, ref security, OpenExisting, 0, IntPtr.Zero);
            ChildProcess process;
            try
            {
                process = Create("", words, input, write, error);
            }
            catch (Exception exception) when (exception is Win32Exception || exception is ArgumentException)
            {
                CloseHandle(read);
                return Failed(exception.Message);
            }
            finally
            {
                CloseHandle(write);
                CloseHandle(input);
                if (!keepStderr) CloseHandle(error);
            }
            var handle = new SafeFileHandle(read, true);
            var stream = new FileStream(handle, FileAccess.Read);
            var abandoned = false;
            var reader = new Thread(() =>
            {
                try
                {
                    using (var text = new StreamReader(stream, new UTF8Encoding(false)))
                    {
                        string line;
                        while ((line = text.ReadLine()) != null)
                        {
                            line = line.Replace("\r", "");
                            lock (lines)
                            {
                                if (abandoned) break;
                                lines.Add(line);
                                if (onLine != null) onLine(line);
                            }
                        }
                    }
                }
                // cancelled below when a child the program left behind still holds the pipe
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                catch (OperationCanceledException) { }
            }) { IsBackground = true };
            reader.Start();
            var timedOut = !process.WaitForExit(checked(limitSeconds * 1000));
            if (timedOut)
            {
                EndTree(process);
                process.WaitForExit(5000);
            }
            // A background child the program started (the installer's server) can hold the pipe open for good:
            // wait for the rest of the output, but briefly.
            if (!reader.Join(2000))
            {
                lock (lines) abandoned = true;
                // the blocked read holds the handle open: cancel it, so the handle closes and the thread ends.
                // Passed as the SafeFileHandle, which stays open for the call or throws when already closed, so a
                // reused handle number is never cancelled.
                try
                {
                    CancelIoEx(handle, IntPtr.Zero);
                }
                catch (ObjectDisposedException) { }
                stream.Dispose();
            }
            var status = timedOut ? TimedOut : process.ExitCode;
            process.Dispose();
            lock (lines)
            {
                if (timedOut) lines.Add(words[0] + " did not finish within " + limitSeconds + " seconds and was stopped.");
                return new RunResult { Status = status, Output = string.Join("\n", lines) };
            }
        }

        public const int TimedOut = -2;

        /// <summary>
        /// Ends a program that went past its limit and everything it started, newest first, except herdr: herdr may hold
        /// the user's agents. The walk checks each process through a handle before it looks at its children: the process
        /// must have started no earlier than its parent and no later than the snapshot it was found in, and its own
        /// executable must not be herdr.exe. A process that fails, or cannot be checked, is left alone with everything
        /// under it, so a process id that a departed herdr (or anything else) left behind never leads into its orphans.
        /// </summary>
        private static void EndTree(ChildProcess root)
        {
            long started;
            if (!StartTime(root.Handle, out started)) { TerminateProcess(root.Handle, 1); return; }
            long snapshotTime;
            GetSystemTimeAsFileTime(out snapshotTime);
            var children = new Dictionary<int, List<int>>();
            var snapshot = CreateToolhelp32Snapshot(SnapProcess, 0);
            if (snapshot == new IntPtr(-1)) { TerminateProcess(root.Handle, 1); return; }
            try
            {
                var entry = new ProcessEntry { Size = Marshal.SizeOf(typeof(ProcessEntry)) };
                for (var more = Process32First(snapshot, ref entry); more; more = Process32Next(snapshot, ref entry))
                {
                    List<int> list;
                    if (!children.TryGetValue(entry.ParentProcessId, out list)) children[entry.ParentProcessId] = list = new List<int>();
                    list.Add(entry.ProcessId);
                }
            }
            finally
            {
                CloseHandle(snapshot);
            }
            // checked processes, parents before children, each with the handle it was checked through
            var checkedProcesses = new List<IntPtr>();
            var pending = new Stack<KeyValuePair<int, long>>();
            var seen = new HashSet<int> { root.Id };
            List<int> rootChildren;
            if (children.TryGetValue(root.Id, out rootChildren)) foreach (var id in rootChildren) pending.Push(new KeyValuePair<int, long>(id, started));
            try
            {
                while (pending.Count > 0)
                {
                    var next = pending.Pop();
                    if (!seen.Add(next.Key)) continue;
                    var process = OpenProcess(ProcessTerminate | ProcessQueryLimited, false, next.Key);
                    if (process == IntPtr.Zero) continue;
                    long created;
                    var image = new StringBuilder(1024);
                    var length = image.Capacity;
                    if (!StartTime(process, out created) || created < next.Value || created > snapshotTime
                        || !QueryFullProcessImageName(process, 0, image, ref length) || IsHerdr(Path.GetFileName(image.ToString())))
                    {
                        CloseHandle(process);
                        continue;
                    }
                    checkedProcesses.Add(process);
                    List<int> list;
                    if (children.TryGetValue(next.Key, out list)) foreach (var id in list) pending.Push(new KeyValuePair<int, long>(id, created));
                }
                for (var i = checkedProcesses.Count - 1; i >= 0; i--) TerminateProcess(checkedProcesses[i], 1);
            }
            finally
            {
                foreach (var process in checkedProcesses) CloseHandle(process);
            }
            TerminateProcess(root.Handle, 1);
        }

        private static bool IsHerdr(string executable)
        {
            return string.Equals(executable, "herdr.exe", StringComparison.OrdinalIgnoreCase);
        }

        private static bool StartTime(IntPtr process, out long creation)
        {
            long exit, kernel, user;
            return GetProcessTimes(process, out creation, out exit, out kernel, out user);
        }

        private static RunResult Failed(string message)
        {
            return new RunResult { Status = -1, Output = message };
        }

        private sealed class ChildProcess : IDisposable
        {
            public IntPtr Handle;
            public int Id;

            public bool WaitForExit(int milliseconds)
            {
                return WaitForSingleObject(Handle, unchecked((uint)milliseconds)) == 0;
            }

            public int ExitCode
            {
                get
                {
                    int code;
                    return GetExitCodeProcess(Handle, out code) ? code : -1;
                }
            }

            public void Dispose()
            {
                if (Handle != IntPtr.Zero) CloseHandle(Handle);
                Handle = IntPtr.Zero;
            }
        }

        private static readonly object CreateLock = new object();
        private static int created;

        /// <summary>
        /// cmd runs the words, each handed over in an environment variable of this child only and named in the
        /// command line: cmd expands %NAME% once and never again inside what it put there, so a path with %, !,
        /// & or ^ in it arrives as written (scripts/plugin.ps1 does the same). /v:off keeps ! literal.
        /// </summary>
        private static ChildProcess Create(string prefix, string[] words, IntPtr input, IntPtr output, IntPtr error)
        {
            // a quote would end the word early, for cmd and for the program's own argv parsing alike; no path or
            // argument this app passes has one (Windows paths cannot)
            var quoted = words.FirstOrDefault(word => word.IndexOf('"') >= 0);
            if (quoted != null) throw new ArgumentException("A word to run has a double quote in it: " + quoted);
            lock (CreateLock)
            {
                var names = new List<string>();
                try
                {
                    var id = ++created;
                    for (var i = 0; i < words.Length; i++)
                    {
                        var name = "OVIS_RUN_" + id + "_" + i;
                        Environment.SetEnvironmentVariable(name, words[i]);
                        names.Add(name);
                    }
                    var command = prefix + string.Join(" ", names.Select(name => "\"%" + name + "%\""));
                    return Create("/d /v:off /s /c \"" + command + "\"", input, output, error);
                }
                finally
                {
                    // the child has its own copy of the environment by now
                    foreach (var name in names) Environment.SetEnvironmentVariable(name, null);
                }
            }
        }

        private static ChildProcess Create(string arguments, IntPtr input, IntPtr output, IntPtr error)
        {
            var comspec = Environment.GetEnvironmentVariable("ComSpec") ?? Path.Combine(Environment.SystemDirectory, "cmd.exe");
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            var list = Marshal.AllocHGlobal(size);
            var policy = Marshal.AllocHGlobal(4);
            try
            {
                if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception();
                Marshal.WriteInt32(policy, BreakawayEnableProcessTree);
                if (!UpdateProcThreadAttribute(list, 0, (IntPtr)DesktopAppPolicyAttribute, policy, (IntPtr)4, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
                var startup = new StartupInfoEx();
                startup.StartupInfo.Size = Marshal.SizeOf(typeof(StartupInfoEx));
                startup.AttributeList = list;
                var redirect = output != IntPtr.Zero;
                if (redirect)
                {
                    startup.StartupInfo.Flags = UseStdHandles;
                    startup.StartupInfo.Input = input;
                    startup.StartupInfo.Output = output;
                    startup.StartupInfo.Error = error;
                }
                ProcessInformation info;
                var commandLine = new StringBuilder(Quote(comspec) + " " + arguments);
                if (!CreateProcess(comspec, commandLine, IntPtr.Zero, IntPtr.Zero, redirect, ExtendedStartupInfoPresent | CreateNoWindow | CreateUnicodeEnvironment,
                        IntPtr.Zero, null, ref startup, out info)) throw new Win32Exception();
                CloseHandle(info.Thread);
                return new ChildProcess { Handle = info.Process, Id = info.ProcessId };
            }
            finally
            {
                DeleteProcThreadAttributeList(list);
                Marshal.FreeHGlobal(list);
                Marshal.FreeHGlobal(policy);
            }
        }

        // PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY
        private const int DesktopAppPolicyAttribute = 0x00020012;
        // PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE
        private const int BreakawayEnableProcessTree = 0x01;
        private const uint ExtendedStartupInfoPresent = 0x00080000;
        private const uint CreateNoWindow = 0x08000000;
        private const uint CreateUnicodeEnvironment = 0x00000400;
        private const int UseStdHandles = 0x00000100;
        private const uint HandleFlagInherit = 1;
        private const uint GenericRead = 0x80000000;
        private const uint GenericWrite = 0x40000000;
        private const uint OpenExisting = 3;

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            public int Length;
            public IntPtr Descriptor;
            public int Inherit;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            public int Size;
            public string Reserved, Desktop, Title;
            public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
            public short ShowWindow, Reserved2;
            public IntPtr Reserved3, Input, Output, Error;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct StartupInfoEx
        {
            public StartupInfo StartupInfo;
            public IntPtr AttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr Process, Thread;
            public int ProcessId, ThreadId;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CancelIoEx(SafeFileHandle handle, IntPtr overlapped);

        // TH32CS_SNAPPROCESS
        private const uint SnapProcess = 0x00000002;
        private const uint ProcessTerminate = 0x0001;
        private const uint ProcessQueryLimited = 0x1000;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct ProcessEntry
        {
            public int Size;
            public int Usage;
            public int ProcessId;
            public IntPtr DefaultHeapId;
            public int ModuleId;
            public int Threads;
            public int ParentProcessId;
            public int PriorityClassBase;
            public int Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, int processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32FirstW")]
        private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32NextW")]
        private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll")]
        private static extern void GetSystemTimeAsFileTime(out long time);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "QueryFullProcessImageNameW")]
        private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr list);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
            bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation info);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out int code);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
