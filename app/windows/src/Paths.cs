using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace Ovis
{
    internal static class Links
    {
        public const string PluginId = "devswha.ovis";
        public const string LegacyPluginId = "devswha.herdr-web-ui";
        public const string PluginSource = "devswha/ovis";
        public const string Repository = "https://github.com/devswha/ovis.git";
        public const string InstallCommand = "irm https://ovis.sh/install.ps1 | iex";
        public const string Support = "https://ovis.sh/support/";
        public const string GitDownload = "https://git-scm.com/download/win";
        public const string TailscaleDownload = "https://tailscale.com/download/windows";
    }

    internal static class Paths
    {
        public static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        public static readonly string LocalAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        public static readonly string InstalledExe = Path.Combine(LocalAppData, "Programs", "Ovis", "Ovis.exe");
        public static readonly string StartMenuShortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Ovis.lnk");

        /// <summary>
        /// The PATH a new terminal would get, read again from the registry: an app opened from Explorer keeps the
        /// PATH of the login, and Git, herdr or Bun installed since are on the new one. The official installers'
        /// own directories come first, as install.ps1 puts them.
        /// </summary>
        public static void RefreshPath()
        {
            var parts = new[]
            {
                Path.Combine(Home, ".bun", "bin"),
                Path.Combine(LocalAppData, "Programs", "Herdr", "bin"),
                Environment.ExpandEnvironmentVariables(Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.Machine) ?? ""),
                Environment.ExpandEnvironmentVariables(Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User) ?? ""),
            };
            var seen = new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var path = string.Join(";", parts.SelectMany(p => p.Split(';')).Select(p => p.Trim()).Where(p => p.Length > 0 && seen.Add(p)));
            Environment.SetEnvironmentVariable("PATH", path);
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("HOME"))) Environment.SetEnvironmentVariable("HOME", Home);
        }

        /// <summary>The first program of that name on PATH, as cmd would find it.</summary>
        public static string Which(string name)
        {
            foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                if (directory.Length == 0) continue;
                foreach (var extension in new[] { ".exe", ".cmd", ".bat" })
                {
                    try
                    {
                        var candidate = Path.Combine(directory, name + extension);
                        if (File.Exists(candidate)) return candidate;
                    }
                    // a PATH entry with characters a path cannot have
                    catch (ArgumentException) { }
                }
            }
            return null;
        }

        public static string Tailscale
        {
            get
            {
                var installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Tailscale", "tailscale.exe");
                return Which("tailscale") ?? (File.Exists(installed) ? installed : null);
            }
        }

        /// <summary>True when this process runs from the Store's MSIX (it has package identity).</summary>
        public static bool Packaged
        {
            get
            {
                try
                {
                    var length = 0;
                    return GetCurrentPackageFullName(ref length, null) != AppModelErrorNoPackage;
                }
                catch (EntryPointNotFoundException)
                {
                    return false;
                }
            }
        }

        private const int AppModelErrorNoPackage = 15700;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetCurrentPackageFullName(ref int length, StringBuilder name);
    }

    internal static class Lang
    {
        private static readonly bool Korean = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "ko";

        public static string L(string english, string korean)
        {
            return Korean ? korean : english;
        }
    }
}
