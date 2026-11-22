using System;
using System.Collections.Generic;
using System.Linq;

namespace Ovis
{
    /// <summary>
    /// The herdr answers are shaped as herdr 0.9.3 and 0.9.5 print them.
    /// </summary>
    internal static class SetupTests
    {
        private static readonly Version App = new Version(0, 4, 19);
        private static int failures;

        private static int Main()
        {
            var cases = new List<KeyValuePair<string, Action>>
            {
                Case("a fresh PC, with no herdr or no plugin, gets Install", () =>
                {
                    Equal(Phase.NotInstalled, Setup.Choose(null, Setup.Reason(null, null, null, false, App), null));
                    Equal(Phase.NotInstalled, Setup.Choose(Setup.ParsePlugin(List()), UpdateReason.None, null));
                }),
                Case("home-window as found: 0.3.45 under the old id, herdr 0.9.3 stopped, gets Update naming 0.3.45", () =>
                {
                    var plugin = Setup.ParsePlugin(List(Entry(Links.LegacyPluginId, "0.3.45")));
                    var reason = Setup.Reason(plugin, null, null, false, App);
                    Equal(UpdateReason.LegacyId, reason);
                    Equal(Phase.Outdated, Setup.Choose(plugin, reason, new Version(0, 9, 3)));
                    Contains(Setup.UpdateMessage(reason, plugin, false, null, null, App), "0.3.45");
                }),
                Case("the old id needs the move whatever its version, and in a build without a version", () =>
                {
                    var plugin = Setup.ParsePlugin(List(Entry(Links.LegacyPluginId, "0.4.13")));
                    Equal(UpdateReason.LegacyId, Setup.Reason(plugin, "0.4.30", "0.4.30", true, App));
                    Equal(UpdateReason.LegacyId, Setup.Reason(plugin, null, null, false, null));
                }),
                Case("a server that runs older than the app gets Update, naming both versions", () =>
                {
                    var plugin = Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.15")));
                    foreach (var running in new[] { true, false })
                    {
                        var reported = running ? new[] { "0.4.15", null } : new[] { null, "0.4.15" };
                        var reason = Setup.Reason(plugin, reported[0], reported[1], running, App);
                        Equal(UpdateReason.Older, reason);
                        Equal(Phase.Outdated, Setup.Choose(plugin, reason, new Version(0, 9, 5)));
                        var message = Setup.UpdateMessage(reason, plugin, running, reported[0], reported[1], App);
                        Contains(message, "0.4.15");
                        Contains(message, "0.4.19");
                    }
                }),
                Case("a server that updated itself is current: what it reports beats herdr's list and the status line", () =>
                {
                    // herdr lists the checkout as first installed, and a checkout from before the status line prints none
                    var plugin = Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.15")));
                    Equal(UpdateReason.None, Setup.Reason(plugin, "0.4.22", null, true, App));
                    Equal(UpdateReason.None, Setup.Reason(plugin, null, "0.4.19", false, App));
                    Equal(UpdateReason.Older, Setup.Reason(plugin, "0.4.15", "0.4.22", true, App));
                    Equal(UpdateReason.VersionUnknown, Setup.Reason(plugin, null, "0.4.22", true, App));
                }),
                Case("a stopped server known only by herdr's list is started first, not reinstalled", () =>
                {
                    var plugin = Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.15")));
                    Equal(UpdateReason.None, Setup.Reason(plugin, null, null, false, App));
                    Equal(Phase.Installed, Setup.Choose(plugin, UpdateReason.None, null));
                    // running, but not answering its version (a token): herdr's list is not taken for it
                    Equal(UpdateReason.VersionUnknown, Setup.Reason(plugin, null, null, true, App));
                    Equal(UpdateReason.VersionUnknown, Setup.Reason(Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.22"))), null, "0.4.22", true, App));
                    Equal(UpdateReason.None, Setup.Reason(Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.22"))), null, "0.4.22", false, App));
                    bool exact;
                    Equal(new Version(0, 4, 15), Setup.ServerVersion(plugin, false, null, null, out exact));
                    Equal(false, exact);
                }),
                Case("the update installs the newest release, never one older than the app or than the server runs", () =>
                {
                    var tags = "aa\trefs/tags/v0.4.18\nbb\trefs/tags/v0.4.21\ncc\trefs/tags/v0.4.20\ndd\trefs/tags/remote-v40\nee\trefs/tags/v0.5.0-rc.1\n";
                    Equal("v0.4.21", Setup.UpdateTag(tags, App));
                    Equal("v0.4.19", Setup.UpdateTag("aa\trefs/tags/v0.4.18\n", App));
                    Equal("v0.4.21", Setup.UpdateTag(tags, null));
                    Equal(null, Setup.UpdateTag(null, App));
                    Equal(null, Setup.UpdateTag("", null));
                }),
                Case("a current server, running or stopped, gets the Installed screen (Start, or Restart)", () =>
                {
                    foreach (var version in new[] { "0.4.19", "0.4.20" })
                    {
                        var plugin = Setup.ParsePlugin(List(Entry(Links.PluginId, version)));
                        Equal(Phase.Installed, Setup.Choose(plugin, Setup.Reason(plugin, null, null, false, App), null));
                        Equal(Phase.Installed, Setup.Choose(plugin, Setup.Reason(plugin, version, version, true, App), null));
                    }
                }),
                Case("a server whose version nobody reports gets Update, with its own words", () =>
                {
                    var plugin = Setup.ParsePlugin(List(Entry(Links.PluginId, null)));
                    Equal(null, plugin.Version);
                    var reason = Setup.Reason(plugin, null, null, false, App);
                    Equal(UpdateReason.VersionUnknown, reason);
                    Equal(Phase.Outdated, Setup.Choose(plugin, reason, null));
                    var unknown = Setup.UpdateMessage(reason, plugin, false, null, null, App);
                    if (unknown.Length == 0 || unknown == Setup.UpdateMessage(UpdateReason.Older, plugin, false, null, null, App)) throw new Exception("the unknown version has no words of its own: " + unknown);
                    Equal(UpdateReason.VersionUnknown, Setup.Reason(Setup.ParsePlugin(List(Entry(Links.PluginId, "unknown"))), "", "", true, App));
                }),
                Case("a server running without the update supervisor is not offered Update: the plugin's reinstall would not replace it", () =>
                {
                    var plugin = Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.15")));
                    Equal(UpdateReason.None, Setup.Reason(plugin, null, null, true, App, true));
                    Equal(UpdateReason.Older, Setup.Reason(plugin, "0.4.15", null, true, App, true));
                    Equal(UpdateReason.LegacyId, Setup.Reason(Setup.ParsePlugin(List(Entry(Links.LegacyPluginId, "0.3.45"))), null, null, true, App, true));
                    Equal(true, Setup.UpdatesUnmanaged("{\"managed\":false,\"current_version\":null}"));
                    Equal(false, Setup.UpdatesUnmanaged("{\"managed\":true,\"current_version\":\"0.4.19\"}"));
                    Equal(false, Setup.UpdatesUnmanaged("{\"error\":{\"code\":\"unauthorized\"}}"));
                    Equal(false, Setup.UpdatesUnmanaged("<html>"));
                }),
                Case("a linked checkout or a fork, under either id, or an app built without a version, is never offered a reinstall", () =>
                {
                    foreach (var id in new[] { Links.PluginId, Links.LegacyPluginId })
                    {
                        Equal(UpdateReason.None, Setup.Reason(Setup.ParsePlugin(List(Entry(id, "0.4.1", "local"))), "0.4.1", null, true, App));
                        Equal(UpdateReason.None, Setup.Reason(Setup.ParsePlugin(List(Entry(id, "0.4.1", "github", "0.9.0", "someone"))), "0.4.1", null, true, App));
                    }
                    Equal(UpdateReason.Older, Setup.Reason(Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.1", "github", "0.9.0", "DevSwha"))), "0.4.1", null, true, App));
                    Equal(UpdateReason.None, Setup.Reason(Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.1"))), "0.4.1", null, true, null));
                }),
                Case("a prerelease of the app's version is older than it; a newer one is not", () =>
                {
                    var plugin = Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.15")));
                    Equal(UpdateReason.Older, Setup.Reason(plugin, "0.4.19-rc.1", null, true, App));
                    Equal(UpdateReason.Older, Setup.Reason(plugin, null, "0.4.19-rc.1", false, App));
                    Equal(UpdateReason.None, Setup.Reason(plugin, "0.4.20-rc.1", null, true, App));
                }),
                Case("a herdr older than the server needs gets the herdr screen, naming both", () =>
                {
                    var legacy = Setup.ParsePlugin(List(Entry(Links.LegacyPluginId, "0.3.45")));
                    Equal(Phase.HerdrTooOld, Setup.Choose(legacy, UpdateReason.LegacyId, new Version(0, 8, 9)));
                    var asking = Setup.ParsePlugin(List(Entry(Links.PluginId, "0.4.1", "github", "0.9.4")));
                    Equal(Phase.HerdrTooOld, Setup.Choose(asking, UpdateReason.Older, new Version(0, 9, 3)));
                    Equal(Phase.Outdated, Setup.Choose(asking, UpdateReason.Older, new Version(0, 9, 4)));
                    Equal(Phase.Outdated, Setup.Choose(asking, UpdateReason.Older, null));
                    var message = Setup.HerdrMessage(asking, new Version(0, 9, 3));
                    Contains(message, "0.9.3");
                    Contains(message, "0.9.4");
                }),
                Case("herdr's list: the new id wins over the old, and what is not herdr's JSON is no plugin", () =>
                {
                    var both = Setup.ParsePlugin(List(Entry(Links.LegacyPluginId, "0.3.45"), Entry(Links.PluginId, "0.4.19")));
                    Equal(Links.PluginId, both.Id);
                    Equal(@"C:\Users\u\AppData\Roaming\herdr\plugins\" + Links.PluginId, both.Root);
                    Equal("0.9.0", both.MinHerdr);
                    Equal(false, both.NotOurs);
                    Equal(null, Setup.ParsePlugin("herdr: unknown command"));
                    Equal(null, Setup.ParsePlugin("{\"result\":{\"plugins\":[{\"plugin_id\":\"devswha.ovis\"}]}}"));
                    Equal(null, Setup.ParsePlugin(List(Entry("someone.else", "1.0.0"))));
                }),
                Case("what the server says: the status's version line and /api/updates' current_version", () =>
                {
                    Equal("0.4.19", Setup.StatusVersion("running http://127.0.0.1:7317 (pid 4)\r\nversion: 0.4.19\r\nconfig: none\r\n"));
                    Equal(null, Setup.StatusVersion("down http://127.0.0.1:7317\nconfig: none (settings go in C:\\x\\env)\n"));
                    Equal(null, Setup.StatusVersion(""));
                    // the process it recorded, alive, whether herdr answers ("running") or not ("down")
                    Equal(4, Setup.StatusPid("running http://127.0.0.1:7317 (pid 4)\r\nversion: 0.4.19\r\n"));
                    Equal(2, Setup.StatusPid("down http://127.0.0.1:17317 (pid 2)\nconfig: none\n"));
                    Equal((int?)null, Setup.StatusPid("down http://127.0.0.1:7317\nconfig: none (settings go in C:\\x (pid 9)\\env)\n"));
                    Equal((int?)null, Setup.StatusPid("down http://127.0.0.1:7317 (pid x)\n"));
                    Equal((int?)null, Setup.StatusPid(null));
                    // what the plugin's own stop says when it ended a server it verified, in every release's words
                    Equal(true, Setup.StoppedServer("stopped Ovis (pid 4)\r\n"));
                    Equal(true, Setup.StoppedServer("stopped herdr web ui (pid 4)\n"));
                    Equal(false, Setup.StoppedServer("Ovis is not running\n"));
                    Equal(false, Setup.StoppedServer("herdr web ui is not running\n"));
                    Equal(false, Setup.StoppedServer(null));
                    // the app's own bridge health, which needs no herdr, and not another program's answer on the port
                    Equal(true, Setup.BridgeHealth("{\"ok\":true,\"auth\":{\"required\":false,\"authenticated\":true},\"bridge_protocol\":1}"));
                    Equal(false, Setup.BridgeHealth("{\"ok\":true}"));
                    Equal(false, Setup.BridgeHealth("{\"ok\":false,\"bridge_protocol\":1}"));
                    Equal(false, Setup.BridgeHealth("{\"ok\":true,\"bridge_protocol\":\"1\"}"));
                    Equal(false, Setup.BridgeHealth("<html>"));
                    Equal("0.4.22", Setup.UpdatesVersion("{\"managed\":true,\"current_revision\":\"abc\",\"current_version\":\"0.4.22\",\"latest_version\":\"0.4.22\"}"));
                    Equal(null, Setup.UpdatesVersion("{\"managed\":false,\"current_version\":null}"));
                    Equal(null, Setup.UpdatesVersion("{\"error\":{\"code\":\"unauthorized\"}}"));
                    Equal(null, Setup.UpdatesVersion("<html>"));
                }),
                Case("the token the plugin's settings give the server: .env wins over env, the new name over the old", () =>
                {
                    Equal("b", Setup.EnvToken(new[] { "OVIS_TOKEN=a\n", "# note\nOVIS_TOKEN=\"b\"\r\n" }));
                    Equal("a", Setup.EnvToken(new[] { "OVIS_TOKEN=a\n", "PORT=1\n" }));
                    Equal("new", Setup.EnvToken(new[] { "HERDR_WEB_TOKEN=old\nOVIS_TOKEN=new\n" }));
                    Equal("old", Setup.EnvToken(new[] { "HERDR_WEB_TOKEN=old\n" }));
                    Equal(null, Setup.EnvToken(new[] { "OVIS_TOKEN=\n", "PORT=1" }));
                    // the environment as a layer under the files: only the old name set there still counts
                    var oldOnly = new Dictionary<string, string> { { "HERDR_WEB_TOKEN", "legacy" } };
                    Equal("legacy", Setup.EnvToken(new[] { Setup.EnvironmentLayer(name => oldOnly.ContainsKey(name) ? oldOnly[name] : null), "PORT=1\n" }));
                    Equal("file", Setup.EnvToken(new[] { Setup.EnvironmentLayer(name => oldOnly.ContainsKey(name) ? oldOnly[name] : null), "OVIS_TOKEN=file\n" }));
                    Equal("", Setup.EnvironmentLayer(name => null));
                }),
                Case("install.ps1's compiled server is asked through its run.ps1, which needs no Bun; a checkout through plugin.ts with Bun", () =>
                {
                    // install.ps1 (0.5.4 and newer) links %LOCALAPPDATA%\ovis\plugin, which holds herdr-plugin.toml and run.ps1 alone
                    var linked = @"C:\Users\u\AppData\Local\ovis\plugin";
                    var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { linked + @"\herdr-plugin.toml", linked + @"\run.ps1" };
                    Equal("powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + linked + @"\run.ps1 status", string.Join(" ", Setup.PluginCommandLine(linked, "status", files.Contains)));
                    var checkout = @"C:\Users\u\AppData\Roaming\herdr\plugins\github\devswha.ovis-aa47ee43150f";
                    files.Add(checkout + @"\herdr-plugin.toml");
                    files.Add(checkout + @"\scripts\plugin.ts");
                    files.Add(checkout + @"\scripts\plugin.ps1");
                    Equal("bun " + checkout + @"\scripts\plugin.ts stop", string.Join(" ", Setup.PluginCommandLine(checkout, "stop", files.Contains)));
                    files.Add(checkout + @"\run.ps1");
                    Equal("bun " + checkout + @"\scripts\plugin.ts status", string.Join(" ", Setup.PluginCommandLine(checkout, "status", files.Contains)));
                }),
                Case("Start reports a stop that failed, but not one that left another program's reused pid alone", () =>
                {
                    Equal(false, Setup.StopFailed(0, "stopped Ovis (pid 5472)\n"));
                    Equal(false, Setup.StopFailed(1, "could not verify the recorded Ovis process; it was left running and its pid file was kept\n"));
                    Equal(true, Setup.StopFailed(1, "could not stop Ovis: Access is denied.\n"));
                    Equal(true, Setup.StopFailed(1, null));
                }),
                Case("the old id's plugin.ts is told the state dir herdr keeps for it, found as herdr finds it", () =>
                {
                    var windows = new Dictionary<string, string> { { "LOCALAPPDATA", @"C:\Users\u\AppData\Local" }, { "USERPROFILE", @"C:\Users\u" } };
                    Equal(@"C:\Users\u\AppData\Local\herdr\plugins\devswha.herdr-web-ui", Setup.HerdrPluginStateDir(Links.LegacyPluginId, name => windows.ContainsKey(name) ? windows[name] : null));
                    windows["XDG_STATE_HOME"] = @"D:\state";
                    Equal(@"D:\state\herdr\plugins\devswha.herdr-web-ui", Setup.HerdrPluginStateDir(Links.LegacyPluginId, name => windows.ContainsKey(name) ? windows[name] : null));
                    Equal(@"C:\Users\u\AppData\Local\herdr\plugins\devswha.herdr-web-ui", Setup.HerdrPluginStateDir(Links.LegacyPluginId, name => name == "USERPROFILE" ? @"C:\Users\u" : null));
                }),
                Case("the phone step: a server behind a token the app could not read is not told to install Tailscale", () =>
                {
                    Equal(PhoneStep.TokenNeeded, Setup.Phone(null, null, true));
                    Equal(PhoneStep.Qr, Setup.Phone("https://pc.tail1.ts.net", "running", false));
                    Equal(PhoneStep.MakeAddress, Setup.Phone(null, "running", false));
                    Equal(PhoneStep.SignInTailscale, Setup.Phone(null, "stopped", false));
                    Equal(PhoneStep.InstallTailscale, Setup.Phone(null, "missing", false));
                    Equal(PhoneStep.InstallTailscale, Setup.Phone(null, null, false));
                }),
                Case("Windows PowerShell started as the app starts it writes its host, warning and error lines as text, not CLIXML", () =>
                {
                    // each word one argument, as cmd hands the app's words over
                    var words = Setup.PowerShellArguments("Write-Host 'a host line'; Write-Warning 'a warning'; Write-Error 'it broke'; exit 3");
                    var start = new System.Diagnostics.ProcessStartInfo("powershell.exe", string.Join(" ", words.Select(word => word.IndexOf(' ') >= 0 ? "\"" + word + "\"" : word)))
                    {
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        RedirectStandardInput = true,
                        CreateNoWindow = true,
                    };
                    using (var shell = System.Diagnostics.Process.Start(start))
                    {
                        shell.StandardInput.Close();
                        var stdout = shell.StandardOutput.ReadToEndAsync();
                        var stderr = shell.StandardError.ReadToEndAsync();
                        if (!shell.WaitForExit(60000))
                        {
                            shell.Kill();
                            throw new Exception("powershell did not end within 60 s");
                        }
                        if (!System.Threading.Tasks.Task.WaitAll(new System.Threading.Tasks.Task[] { stdout, stderr }, 10000)) throw new Exception("powershell's output did not close within 10 s");
                        var output = stdout.Result + stderr.Result;
                        Equal(3, shell.ExitCode);
                        Equal(false, output.Contains("CLIXML") || output.Contains("<Objs"));
                        Contains(output, "a host line");
                        Contains(output, "a warning");
                        Contains(output, "it broke");
                    }
                }),
                Case("versions: X.Y.Z from herdr's, a tag's or a preview's spelling, and nothing else", () =>
                {
                    Equal(new Version(0, 9, 3), Setup.ParseVersion("herdr 0.9.3"));
                    Equal(new Version(0, 4, 19), Setup.ParseVersion("v0.4.19"));
                    Equal(new Version(0, 9, 5), Setup.ParseVersion("0.9.5-preview.2"));
                    Equal(null, Setup.ParseVersion("0.4"));
                    Equal(null, Setup.ParseVersion("1.2.3.4"));
                    Equal(null, Setup.ParseVersion("0.4.19-"));
                    Equal(null, Setup.ParseVersion(null));
                    Equal(new Version(0, 4, 19), Setup.AppVersion(new Version(0, 4, 19, 0)));
                    Equal(null, Setup.AppVersion(new Version(0, 0, 0, 0)));
                }),
            };
            foreach (var test in cases)
            {
                try
                {
                    test.Value();
                    Console.WriteLine("ok   " + test.Key);
                }
                catch (Exception exception)
                {
                    failures++;
                    Console.WriteLine("FAIL " + test.Key + Environment.NewLine + "     " + exception.Message);
                }
            }
            Console.WriteLine(failures == 0 ? cases.Count + " passed" : failures + " of " + cases.Count + " failed");
            return failures == 0 ? 0 : 1;
        }

        private static KeyValuePair<string, Action> Case(string name, Action body)
        {
            return new KeyValuePair<string, Action>(name, body);
        }

        private static string Entry(string id, string version, string kind = "github", string minHerdr = "0.9.0", string owner = "devswha")
        {
            var root = (@"C:\Users\u\AppData\Roaming\herdr\plugins\" + id).Replace(@"\", @"\\");
            return "{\"enabled\":true,\"manifest_path\":\"" + root + "\\\\herdr-plugin.toml\",\"min_herdr_version\":\"" + minHerdr + "\",\"name\":\"Ovis\",\"platforms\":[\"linux\",\"macos\",\"windows\"],\"plugin_id\":\"" + id +
                   "\",\"plugin_root\":\"" + root + "\",\"source\":{\"kind\":\"" + kind + "\",\"owner\":\"" + owner + "\",\"repo\":\"ovis\",\"requested_ref\":\"v" + (version ?? "0.4.14") + "\"}" +
                   (version == null ? "" : ",\"version\":\"" + version + "\"") + ",\"actions\":[]}";
        }

        private static string List(params string[] entries)
        {
            return "{\"id\":\"cli:plugin\",\"result\":{\"plugins\":[" + string.Join(",", entries) + "]}}";
        }

        private static void Equal<T>(T expected, T actual)
        {
            if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception("expected " + Show(expected) + ", got " + Show(actual));
        }

        private static void Contains(string text, string part)
        {
            if (text == null || !text.Contains(part)) throw new Exception("expected \"" + part + "\" in \"" + text + "\"");
        }

        private static string Show(object value)
        {
            return value == null ? "null" : value.ToString();
        }
    }
}
