using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Ovis
{
    /// <summary>
    /// herdr's server at login, so herdr, and the app with it, is up without a terminal; a later `herdr` in a
    /// terminal attaches to that same server. Ovis.exe copies itself to %LOCALAPPDATA%\Programs\Ovis and adds a
    /// value under HKCU\...\Run that runs that copy with --start: no administrator, and it shows in Task Manager's
    /// Startup apps and in Settings, where the user can turn it off. The MSIX declares a startup task instead.
    /// </summary>
    internal static class LoginItem
    {
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string ValueName = "Ovis";

        /// <summary>Set when Remove could not delete the running copy; it goes once this process exits.</summary>
        public static bool DeleteOnExit;

        public static void Install()
        {
            if (Paths.Packaged) return;
            var current = System.Reflection.Assembly.GetExecutingAssembly().Location;
            Directory.CreateDirectory(Path.GetDirectoryName(Paths.InstalledExe));
            if (!string.Equals(Path.GetFullPath(current), Path.GetFullPath(Paths.InstalledExe), StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(current, Paths.InstalledExe, true);
            }
            // the user opened the download already; the copy should not ask again at every login
            DeleteFile(Paths.InstalledExe + ":Zone.Identifier");
            using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                key.SetValue(ValueName, "\"" + Paths.InstalledExe + "\" --start");
            }
            CreateShortcut();
            DeleteOnExit = false;
        }

        public static void Remove()
        {
            if (Paths.Packaged) return;
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey, true))
            {
                if (key != null) key.DeleteValue(ValueName, false);
            }
            if (File.Exists(Paths.StartMenuShortcut)) File.Delete(Paths.StartMenuShortcut);
            var current = System.Reflection.Assembly.GetExecutingAssembly().Location;
            if (string.Equals(Path.GetFullPath(current), Path.GetFullPath(Paths.InstalledExe), StringComparison.OrdinalIgnoreCase))
            {
                DeleteOnExit = true;
            }
            else if (File.Exists(Paths.InstalledExe))
            {
                File.Delete(Paths.InstalledExe);
                TryDeleteDirectory();
            }
        }

        public static bool Installed
        {
            get
            {
                if (Paths.Packaged) return true;
                using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
                {
                    return key != null && key.GetValue(ValueName) != null;
                }
            }
        }

        /// <summary>Removes the running copy after this process has exited: a running exe cannot delete itself.</summary>
        public static void FinishDeleteOnExit()
        {
            if (!DeleteOnExit) return;
            var directory = Path.GetDirectoryName(Paths.InstalledExe);
            var script = "ping -n 3 127.0.0.1 >nul & del /f /q " + Run.Quote(Paths.InstalledExe) + " & rmdir " + Run.Quote(directory);
            var start = new System.Diagnostics.ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe", "/d /c \"" + script + "\"")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetTempPath(),
            };
            System.Diagnostics.Process.Start(start);
        }

        private static void TryDeleteDirectory()
        {
            try
            {
                Directory.Delete(Path.GetDirectoryName(Paths.InstalledExe));
            }
            catch (IOException) { }
        }

        private static void CreateShortcut()
        {
            var type = Type.GetTypeFromProgID("WScript.Shell");
            if (type == null) return;
            dynamic shell = Activator.CreateInstance(type);
            try
            {
                dynamic shortcut = shell.CreateShortcut(Paths.StartMenuShortcut);
                shortcut.TargetPath = Paths.InstalledExe;
                shortcut.WorkingDirectory = Path.GetDirectoryName(Paths.InstalledExe);
                shortcut.Description = "Ovis";
                shortcut.Save();
                Marshal.FinalReleaseComObject(shortcut);
            }
            finally
            {
                Marshal.FinalReleaseComObject(shell);
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool DeleteFile(string path);
    }
}
