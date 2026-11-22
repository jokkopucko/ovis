using System;
using System.Collections.Generic;
using System.Linq;
using System.Web.Script.Serialization;

namespace Ovis
{
    internal enum Phase
    {
        Checking,
        NotInstalled,
        Working,
        Failed,
        Installed,
        Outdated,
        HerdrTooOld,
    }

    internal enum UpdateReason
    {
        None,
        LegacyId,
        Older,
        VersionUnknown,
    }

    internal enum PhoneStep
    {
        Qr,
        MakeAddress,
        SignInTailscale,
        InstallTailscale,
        /// <summary>The server asks for a token the app does not have: nothing is known of Tailscale here.</summary>
        TokenNeeded,
    }

    internal sealed class Plugin
    {
        public string Id;
        public string Root;
        public string Version;
        public string MinHerdr;
        /// <summary>
        /// Not this project's GitHub install: a linked checkout (herdr refuses a reinstall over it) or a fork, which a
        /// reinstall from devswha/ovis would replace. The app offers neither the move nor the reinstall for it.
        /// </summary>
        public bool NotOurs;
    }

    internal static class Setup
    {
        public static readonly Version InstallerMinHerdr = new Version(0, 9, 0);

        /// <summary>
        /// The state dir herdr keeps for a plugin and hands it as HERDR_PLUGIN_STATE_DIR, found as herdr finds it
        /// (scripts/plugin-state.ts): under XDG_STATE_HOME when that is set, else under %LOCALAPPDATA%.
        /// </summary>
        public static string HerdrPluginStateDir(string id, Func<string, string> variable)
        {
            var xdg = variable("XDG_STATE_HOME");
            var root = xdg != null ? System.IO.Path.Combine(xdg, "herdr")
                : System.IO.Path.Combine(variable("LOCALAPPDATA") ?? System.IO.Path.Combine(variable("USERPROFILE") ?? "", "AppData", "Local"), "herdr");
            return System.IO.Path.Combine(root, "plugins", id);
        }

        /// <summary>
        /// Windows PowerShell's arguments for a command whose output the app shows. Given as -Command, not -EncodedCommand:
        /// started with -EncodedCommand and its output in a pipe, Windows PowerShell 5.1 writes its progress, warning and
        /// error records to stderr as CLIXML, whatever -OutputFormat says, and the log showed that raw. Run hands the
        /// script to cmd in an environment variable, so its | and quotes arrive as written (it refuses a double quote,
        /// which the script never has). TLS 1.2 for Windows 10, and UTF-8 output.
        /// </summary>
        public static string[] PowerShellArguments(string command)
        {
            var script = "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; " +
                         "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ProgressPreference = 'SilentlyContinue'; " + command;
            return new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script };
        }

        /// <summary>
        /// A server behind a token the app could not read answers nothing of Tailscale, which is then not taken as missing.
        /// </summary>
        public static PhoneStep Phone(string phoneUrl, string tailscale, bool accessLocked)
        {
            if (phoneUrl != null) return PhoneStep.Qr;
            if (accessLocked) return PhoneStep.TokenNeeded;
            if (tailscale == "running") return PhoneStep.MakeAddress;
            return tailscale == "stopped" ? PhoneStep.SignInTailscale : PhoneStep.InstallTailscale;
        }

        public static Version ParseVersion(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return null;
            var word = text.Trim().Split(' ').Last();
            if (word.StartsWith("v")) word = word.Substring(1);
            var end = word.IndexOfAny(new[] { '-', '+' });
            if (end >= 0)
            {
                if (end == word.Length - 1) return null;
                word = word.Substring(0, end);
            }
            Version version;
            if (!System.Version.TryParse(word, out version) || version.Build < 0 || version.Revision >= 0) return null;
            return version;
        }

        /// <summary>
        /// The plugin in `herdr plugin list --json`, under its id or, for releases up to 0.4.13, the old one; null when
        /// neither is listed or the JSON is not what herdr prints.
        /// </summary>
        public static Plugin ParsePlugin(string json)
        {
            try
            {
                var root = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                object answer, list;
                var plugins = root != null && root.TryGetValue("result", out answer) && answer is Dictionary<string, object> && ((Dictionary<string, object>)answer).TryGetValue("plugins", out list)
                    ? list as System.Collections.ArrayList
                    : null;
                if (plugins == null) return null;
                var listed = plugins.OfType<Dictionary<string, object>>().ToList();
                foreach (var id in new[] { Links.PluginId, Links.LegacyPluginId })
                {
                    var found = listed.FirstOrDefault(p => Text(p, "plugin_id") == id);
                    if (found == null || Text(found, "plugin_root") == null) continue;
                    object value;
                    var source = found.TryGetValue("source", out value) ? value as Dictionary<string, object> : null;
                    var kind = source == null ? null : Text(source, "kind");
                    var owner = source == null ? null : Text(source, "owner");
                    var repo = source == null ? null : Text(source, "repo");
                    // herdr 0.9.x names a GitHub install's owner and repo; one that does not is taken as ours
                    var fork = kind == "github" && owner != null && repo != null &&
                               !(string.Equals(owner, "devswha", StringComparison.OrdinalIgnoreCase) && (string.Equals(repo, "ovis", StringComparison.OrdinalIgnoreCase) || string.Equals(repo, "herdr-web-ui", StringComparison.OrdinalIgnoreCase)));
                    return new Plugin
                    {
                        Id = id,
                        Root = Text(found, "plugin_root"),
                        Version = Text(found, "version"),
                        MinHerdr = Text(found, "min_herdr_version"),
                        NotOurs = (kind != null && kind != "github") || fork,
                    };
                }
            }
            catch (Exception exception) when (exception is ArgumentException || exception is InvalidOperationException || exception is KeyNotFoundException || exception is InvalidCastException)
            {
                return null;
            }
            return null;
        }

        /// <summary>
        /// How the app runs one of the plugin's commands, as herdr's actions run it. install.ps1's install of the release's
        /// compiled server (0.5.4 and newer) links a plugin of a run.ps1 alone, which hands the command to bin\ovis-server.exe
        /// and needs no Bun; a checkout (herdr's GitHub install, a linked one) runs its scripts\plugin.ts with Bun, whatever
        /// else its root holds. Asked through plugin.ts alone, the compiled server's status could not run, and one that
        /// answered showed as not running.
        /// </summary>
        public static string[] PluginCommandLine(string root, string command, Func<string, bool> exists)
        {
            var script = System.IO.Path.Combine(root, "scripts", "plugin.ts");
            var run = System.IO.Path.Combine(root, "run.ps1");
            if (!exists(script) && exists(run)) return new[] { "powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", run, command };
            return new[] { "bun", script, command };
        }

        public static string StatusVersion(string output)
        {
            var line = (output ?? "").Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.StartsWith("version: "));
            return line == null ? null : line.Substring("version: ".Length).Trim();
        }

        /// <summary>
        /// The token the plugin's settings files give the server (scripts/plugin.ts reads `env`, then `.env`, which wins),
        /// so the app can ask a server behind one for its version. Its old name counts where the new one is unset.
        /// </summary>
        public static string EnvToken(IEnumerable<string> files)
        {
            string token = null;
            foreach (var text in files)
            {
                if (text == null) continue;
                var vars = new Dictionary<string, string>();
                foreach (var raw in text.Split('\n'))
                {
                    var line = raw.Trim();
                    var eq = line.IndexOf('=');
                    if (line.Length == 0 || line.StartsWith("#") || eq <= 0) continue;
                    vars[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim().Trim('"', '\'');
                }
                string value;
                if ((vars.TryGetValue("OVIS_TOKEN", out value) || vars.TryGetValue("HERDR_WEB_TOKEN", out value)) && value.Length > 0) token = value;
            }
            return token;
        }

        /// <summary>
        /// The token names the environment sets, as one settings layer under the plugin's files. A name it does not set
        /// stays out: written empty, it would hide the old name, which `plugin.ts` reads then.
        /// </summary>
        public static string EnvironmentLayer(Func<string, string> variable)
        {
            return string.Join("\n", new[] { "OVIS_TOKEN", "HERDR_WEB_TOKEN" }.Select(name => new { name, value = variable(name) }).Where(set => set.value != null).Select(set => set.name + "=" + set.value));
        }

        public static bool UpdatesUnmanaged(string json)
        {
            try
            {
                var root = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                object value;
                return root != null && root.TryGetValue("managed", out value) && value is bool && !(bool)value;
            }
            catch (Exception exception) when (exception is ArgumentException || exception is InvalidOperationException)
            {
                return false;
            }
        }

        public static string UpdatesVersion(string json)
        {
            try
            {
                var root = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                return root == null ? null : Text(root, "current_version");
            }
            catch (Exception exception) when (exception is ArgumentException || exception is InvalidOperationException)
            {
                return null;
            }
        }

        /// <summary>
        /// The server's version and whether it is the one that runs. A running server is known only by what it reports
        /// itself (GET /api/updates): the status line names the release the next start runs, which a reinstall under a
        /// running server has already moved. A stopped one is known by that status line. herdr's list names the
        /// checkout as first installed, and Settings → Updates may run a newer release since: it is a lower bound only.
        /// </summary>
        public static Version ServerVersion(Plugin plugin, bool running, string runningVersion, string statusVersion, out bool exact)
        {
            var known = running ? ParseVersion(runningVersion) : ParseVersion(statusVersion);
            exact = known != null;
            return known ?? ParseVersion(plugin == null ? null : plugin.Version);
        }

        /// <summary>
        /// The `(pid N)` of the status's first line: `plugin.ts status` names the process it recorded only while it lives,
        /// and says so whether herdr answers or not (its "running" needs herdr, every release since 0.3).
        /// </summary>
        public static int? StatusPid(string output)
        {
            var first = (output ?? "").Split('\n').FirstOrDefault() ?? "";
            var at = first.LastIndexOf("(pid ", StringComparison.Ordinal);
            if (at < 0) return null;
            var end = first.IndexOf(')', at);
            int pid;
            return end > at && int.TryParse(first.Substring(at + 5, end - at - 5), out pid) && pid > 0 ? pid : (int?)null;
        }

        /// <summary>
        /// `plugin.ts stop` ended a server: "stopped Ovis (pid N)", or "stopped herdr web ui (pid N)" before the rename. It
        /// prints that only after it verified the process as the plugin's own and saw it exit; "… is not running" otherwise.
        /// </summary>
        public static bool StoppedServer(string output)
        {
            return (output ?? "").Split('\n').Select(line => line.Trim()).Any(line => line.StartsWith("stopped ", StringComparison.Ordinal) && line.Contains("(pid "));
        }

        /// <summary>
        /// A `plugin.ts stop` that failed in a way Start reports: every failure but the one that left alone a recorded pid
        /// it could not verify as the Ovis server's (another program reused it), which the start then passes over.
        /// </summary>
        public static bool StopFailed(int status, string output)
        {
            return status != 0 && (output ?? "").IndexOf("could not verify the recorded Ovis process", StringComparison.Ordinal) < 0;
        }

        public static bool BridgeHealth(string json)
        {
            try
            {
                var root = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                object ok, protocol;
                return root != null && root.TryGetValue("ok", out ok) && ok is bool && (bool)ok && root.TryGetValue("bridge_protocol", out protocol) && protocol is int;
            }
            catch (Exception exception) when (exception is ArgumentException || exception is InvalidOperationException)
            {
                return false;
            }
        }

        /// <summary>
        /// herdr's list is never taken for the version that runs: a stopped server known only by it is started first, as
        /// it may have updated itself, and a running one that does not say its version (a token holds /api/updates) is
        /// one whose version cannot be read. An app without a version (a local build) asks only the old id to move; a
        /// linked checkout or a fork is never touched.
        /// </summary>
        public static UpdateReason Reason(Plugin plugin, string runningVersion, string statusVersion, bool running, Version app, bool unmanaged = false)
        {
            if (plugin == null || plugin.NotOurs) return UpdateReason.None;
            if (plugin.Id == Links.LegacyPluginId) return UpdateReason.LegacyId;
            if (app == null) return UpdateReason.None;
            bool exact;
            var server = ServerVersion(plugin, running, runningVersion, statusVersion, out exact);
            // a server that runs without the update supervisor reports no version, and none is guessed for it: one the
            // plugin's start just started answers so until its supervisor's first word, and a hand-run one is not the
            // plugin's to reinstall
            if (running && !exact && unmanaged) return UpdateReason.None;
            if (running && !exact) return UpdateReason.VersionUnknown;
            if (server == null) return UpdateReason.VersionUnknown;
            if (server >= app && !(server == app && exact && Prerelease(running ? runningVersion : statusVersion))) return UpdateReason.None;
            return exact ? UpdateReason.Older : UpdateReason.None;
        }

        private static bool Prerelease(string text)
        {
            return text != null && text.Trim().IndexOf('-') > 0;
        }

        public static Version RequiredHerdr(Plugin plugin)
        {
            var asked = plugin == null ? null : ParseVersion(plugin.MinHerdr);
            return asked != null && asked > InstallerMinHerdr ? asked : InstallerMinHerdr;
        }

        public static Phase Choose(Plugin plugin, UpdateReason reason, Version herdr)
        {
            if (plugin == null) return Phase.NotInstalled;
            if (reason == UpdateReason.None) return Phase.Installed;
            return herdr != null && herdr < RequiredHerdr(plugin) ? Phase.HerdrTooOld : Phase.Outdated;
        }

        public static string UpdateMessage(UpdateReason reason, Plugin plugin, bool running, string runningVersion, string statusVersion, Version app)
        {
            bool exact;
            var server = ServerVersion(plugin, running, runningVersion, statusVersion, out exact);
            var target = app == null ? Lang.L("the latest version", "최신 버전") : Short(app);
            var keeps = Lang.L(" herdr, your agents and your settings stay.", " herdr, 에이전트, 설정은 그대로 남습니다.");
            switch (reason)
            {
                case UpdateReason.LegacyId:
                    return (server == null
                        ? Lang.L("This PC has an old Ovis server, from before its new name. Update it to " + target + " or newer.", "이 PC에 예전 이름으로 설치된 옛 Ovis 서버가 있습니다. " + target + " 이상으로 업데이트하세요.")
                        : Lang.L("This PC has an old Ovis server (" + Short(server) + "), from before its new name. Update it to " + target + " or newer.", "이 PC에 예전 이름으로 설치된 옛 Ovis 서버(" + Short(server) + ")가 있습니다. " + target + " 이상으로 업데이트하세요.")) + keeps;
                case UpdateReason.Older:
                    return (exact
                        ? Lang.L("This PC has Ovis server " + Short(server) + ", older than this app (" + target + "). Update it to " + target + " or newer.",
                                 "이 PC의 Ovis 서버(" + Short(server) + ")가 이 앱(" + target + ")보다 오래됐습니다. " + target + " 이상으로 업데이트하세요.")
                        : Lang.L("This PC's Ovis server was installed at " + Short(server) + ", older than this app (" + target + "). Update it to " + target + " or newer so they match.",
                                 "이 PC의 Ovis 서버는 " + Short(server) + "로 설치됐고, 이 앱(" + target + ")보다 오래됐습니다. 서로 맞도록 " + target + " 이상으로 업데이트하세요.")) + keeps;
                case UpdateReason.VersionUnknown:
                    return Lang.L("Ovis cannot read which version of the Ovis server this PC has. Update it to " + target + " or newer so it matches this app.",
                                  "이 PC에 있는 Ovis 서버의 버전을 읽지 못했습니다. 이 앱과 맞도록 " + target + " 이상으로 업데이트하세요.") + keeps;
                default:
                    return "";
            }
        }

        /// <summary>
        /// The tag the update installs: the newest release `git ls-remote --tags` lists, never older than this app, so a
        /// server that updated itself past this app to a listed release keeps its version (the server's own version is
        /// not compared): reinstalled older, it would run the older checkout, since its installed release is tied to the
        /// checkout it replaced. Without the list (null) there is no tag: the app's own could be older than what runs.
        /// </summary>
        public static string UpdateTag(string lsRemote, Version app)
        {
            if (lsRemote == null) return null;
            var newest = app;
            foreach (var line in (lsRemote ?? "").Split('\n'))
            {
                var at = line.LastIndexOf("refs/tags/v", StringComparison.Ordinal);
                if (at < 0) continue;
                var name = line.Substring(at + "refs/tags/".Length).Trim();
                if (name.IndexOfAny(new[] { '-', '+' }) >= 0) continue;
                var version = ParseVersion(name);
                if (version != null && (newest == null || version > newest)) newest = version;
            }
            return newest == null ? null : "v" + newest.ToString(3);
        }

        public static string HerdrMessage(Plugin plugin, Version herdr)
        {
            var needed = Short(RequiredHerdr(plugin));
            return Lang.L("This PC has herdr " + Short(herdr) + ", and the Ovis server needs herdr " + needed + " or newer. Update herdr (run herdr update in a terminal), then check again.",
                          "이 PC의 herdr는 " + Short(herdr) + "이고, Ovis 서버에는 herdr " + needed + " 이상이 필요합니다. 터미널에서 herdr update를 실행해 herdr를 업데이트한 뒤 다시 확인해 주세요.");
        }

        public static Version AppVersion(Version assembly)
        {
            if (assembly == null || (assembly.Major == 0 && assembly.Minor == 0 && assembly.Build <= 0)) return null;
            return new Version(assembly.Major, assembly.Minor, Math.Max(0, assembly.Build));
        }

        private static string Short(Version version)
        {
            return version == null ? "?" : version.ToString(3);
        }

        private static string Text(Dictionary<string, object> map, string key)
        {
            object value;
            return map.TryGetValue(key, out value) ? value as string : null;
        }
    }
}
