using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Ovis
{
    internal sealed class Status
    {
        public bool Running;
        public string Origin;
        public string PhoneUrl;
        public string Tailscale;
        public string Version;
        public string RunningVersion;
        public int? Pid;
        public bool AliveWithoutHerdr;
        public bool Unmanaged;
        /// <summary>GET /api/access answered 401: the server asks for a token the app does not have, so Tailscale's state is unknown.</summary>
        public bool AccessLocked;
    }

    internal sealed class Model
    {
        private readonly SynchronizationContext context = SynchronizationContext.Current ?? throw new InvalidOperationException("Model is made on the window's thread, after the form's constructor started.");
        private readonly List<string> log = new List<string>();
        private Plugin plugin;

        public Phase Phase { get; private set; }
        public string Title { get; private set; }
        public Status Status { get; private set; }
        public bool GitMissing { get; private set; }
        public bool CanUseWinget { get; private set; }
        public UpdateReason UpdateReason { get; private set; }
        public Version HerdrVersion { get; private set; }
        public Plugin Plugin { get { return plugin; } }

        public static readonly Version AppVersion = Setup.AppVersion(typeof(Model).Assembly.GetName().Version);

        public Func<Task> Retry { get; private set; }

        public event Action Changed;
        public event Action<string> LineAdded;

        public string LogText
        {
            get { lock (log) return string.Join(Environment.NewLine, log); }
        }

        public async Task Refresh()
        {
            Paths.RefreshPath();
            GitMissing = Paths.Which("git") == null;
            CanUseWinget = Paths.Which("winget") != null;
            plugin = Paths.Which("herdr") == null ? null : await FindPlugin();
            if (plugin == null)
            {
                Status = null;
                UpdateReason = UpdateReason.None;
                Set(Phase.NotInstalled);
                return;
            }
            Status = await ReadStatus(plugin);
            UpdateReason = Setup.Reason(plugin, Status.RunningVersion, Status.Version, Status.Running, AppVersion, Status.Unmanaged);
            HerdrVersion = UpdateReason == UpdateReason.None ? null : Setup.ParseVersion((await Run.Program("herdr", new[] { "--version" }, null, false)).Output.Split('\n').FirstOrDefault());
            Set(Setup.Choose(plugin, UpdateReason, HerdrVersion));
        }

        public Task Install()
        {
            Retry = Install;
            return RunInstaller(Lang.L("Installing herdr, Bun and the Ovis server…", "herdr, Bun, Ovis 서버를 설치하는 중…"));
        }

        /// <summary>
        /// Under the old id, install.ps1 moves it to the new one (its settings and token come along); under the new id,
        /// herdr reinstalls it at the newest release (never older than this app), keeping its config and state dirs.
        /// </summary>
        public async Task Update()
        {
            Retry = UpdateAgain;
            var title = Lang.L("Updating the Ovis server…", "Ovis 서버를 업데이트하는 중…");
            // a linked checkout or a fork is never moved or reinstalled (the screen offers no Update for one)
            if (plugin != null && plugin.NotOurs)
            {
                await Refresh();
                return;
            }
            if (plugin == null)
            {
                await RunInstaller(title);
                return;
            }
            ClearLog();
            Paths.RefreshPath();
            if (Paths.Which("git") == null)
            {
                await Refresh();
                return;
            }
            Set(Phase.Working, title);
            // a server that outlived herdr counts though its health, which asks herdr, fails: the update stops it, so a
            // failed one must start it again. Its recorded pid alone is not enough: a stale one can name another program.
            var wasRunning = Status != null && (Status.Running || Status.AliveWithoutHerdr);
            // the release is settled before anything stops, so a PC that cannot reach GitHub keeps its server running
            var tags = await Run.Program("git", new[] { "ls-remote", "--tags", "--refs", Links.Repository, "v*" }, Append, true);
            var tag = Setup.UpdateTag(tags.Status == 0 ? tags.Output : null, AppVersion);
            if (tag == null)
            {
                Fail(Lang.L("Could not read the Ovis releases from GitHub, so nothing was updated. Check the internet connection.", "GitHub에서 Ovis 릴리스를 읽지 못해 아무것도 업데이트하지 않았습니다. 인터넷 연결을 확인해 주세요."));
                return;
            }
            // the server stops here, under either id, before anything is replaced: the reinstall leaves the old files to a
            // server that runs them, and the start would find it answering. Its own stop says when it ended a verified
            // Ovis process, which a probe of the port can miss (a PORT edited since it started): that one is started again
            // if the update fails.
            var stop = await PluginCommand(plugin, "stop", Append);
            if (stop.Status != 0)
            {
                Fail(Lang.L("Could not stop the Ovis server, so nothing was updated.", "Ovis 서버를 멈추지 못해 아무것도 업데이트하지 않았습니다."));
                return;
            }
            wasRunning = wasRunning || Setup.StoppedServer(stop.Output);
            if (plugin.Id == Links.LegacyPluginId)
            {
                // install.ps1 moves the old id; pinned to that release, so an OVIS_REF the PC inherited cannot take it back
                await RunInstaller(title, tag, wasRunning);
                return;
            }
            var reinstall = new[] { "plugin", "install", Links.PluginSource, "--ref", tag, "--yes" };
            if ((await Run.Program("herdr", reinstall, Append, true, 45 * 60)).Status != 0)
            {
                // herdr keeps the old install when its reinstall fails: start that one again rather than leave it stopped
                await StartKept(wasRunning);
                Fail(Lang.L("herdr could not update the Ovis server; the version it had is kept.", "herdr가 Ovis 서버를 업데이트하지 못했습니다. 원래 버전은 그대로입니다."));
                return;
            }
            plugin = await FindPlugin() ?? plugin;
            if (!LoginStart()) return;
            if (await HerdrRunning())
            {
                if ((await Run.Program("herdr", new[] { "plugin", "action", "invoke", plugin.Id + ".start-windows" }, Append)).Status != 0)
                {
                    Fail(Lang.L("Could not start the Ovis server.", "Ovis 서버를 시작하지 못했습니다."));
                    return;
                }
            }
            else
            {
                Run.Detached("herdr", new[] { "server" });
            }
            await WaitUntilRunning();
            await Refresh();
        }

        /// <summary>
        /// Try again after a failed update. The update may have moved or removed the plugin it read (install.ps1 takes the
        /// old id's checkout away), so what is on this PC is read again: the update runs again while one is due (or the
        /// plugin is gone); for a current server, the update's last steps run again: its login start, and its start when it
        /// is stopped.
        /// </summary>
        private async Task UpdateAgain()
        {
            await Refresh();
            if (Phase == Phase.Outdated || Phase == Phase.NotInstalled)
            {
                await Update();
                return;
            }
            if (Phase != Phase.Installed) return;
            if (!LoginStart() || (Status != null && Status.Running)) return;
            await Restart();
            if (Phase == Phase.Failed) Retry = UpdateAgain;
        }

        private bool LoginStart()
        {
            try
            {
                if (!LoginItem.Installed) LoginItem.Install();
                return true;
            }
            catch (Exception exception)
            {
                Fail(Lang.L("Could not set herdr to start at login.", "로그인할 때 herdr가 켜지도록 설정하지 못했습니다."), exception.Message);
                return false;
            }
        }

        /// <summary>
        /// The server that ran before a failed update, started again the way herdr starts it, so it runs with herdr's
        /// plugin environment and so on its active release (started by hand, a checkout Settings → Updates moved past
        /// would run its own older files): the start-windows action while herdr runs, else herdr's server, whose
        /// startup hook starts it, as Start does.
        /// </summary>
        private async Task StartKept(bool wasRunning)
        {
            if (!wasRunning) return;
            var kept = await FindPlugin();
            if (kept == null || (await ReadStatus(kept)).Running) return;
            if (await HerdrRunning()) await Run.Program("herdr", new[] { "plugin", "action", "invoke", kept.Id + ".start-windows" }, Append);
            else Run.Detached("herdr", new[] { "server" });
        }

        private async Task RunInstaller(string title, string reference = null, bool wasRunning = false)
        {
            ClearLog();
            Paths.RefreshPath();
            if (Paths.Which("git") == null)
            {
                await Refresh();
                return;
            }
            Set(Phase.Working, title);
            Environment.SetEnvironmentVariable("OVIS_NO_OPEN", "1");
            var inherited = Environment.GetEnvironmentVariable("OVIS_REF");
            if (reference != null) Environment.SetEnvironmentVariable("OVIS_REF", reference);
            RunResult result;
            try
            {
                result = await Run.Program("powershell", PowerShell(Links.InstallCommand), Append, true, 45 * 60);
            }
            finally
            {
                if (reference != null) Environment.SetEnvironmentVariable("OVIS_REF", inherited);
            }
            if (result.Status != 0)
            {
                await StartKept(wasRunning);
                Fail(Lang.L("The installer stopped with an error.", "설치 중 오류가 났습니다."));
                return;
            }
            Paths.RefreshPath();
            Set(Phase.Working, Lang.L("Starting herdr…", "herdr를 시작하는 중…"));
            try
            {
                LoginItem.Install();
            }
            catch (Exception exception)
            {
                Fail(Lang.L("Could not set herdr to start at login.", "로그인할 때 herdr가 켜지도록 설정하지 못했습니다."), exception.Message);
                return;
            }
            if (!await HerdrRunning()) Run.Detached("herdr", new[] { "server" });
            await WaitUntilRunning();
            await Refresh();
        }

        /// <summary>Git for Windows, which install.ps1 needs, from winget (Windows asks for administrator approval).</summary>
        public async Task InstallGit()
        {
            Retry = InstallGit;
            ClearLog();
            Set(Phase.Working, Lang.L("Installing Git for Windows…", "Git for Windows를 설치하는 중…"));
            var result = await Run.Program("winget", new[] { "install", "--id", "Git.Git", "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements" }, Append, true, 30 * 60);
            Paths.RefreshPath();
            if (Paths.Which("git") == null)
            {
                Fail(result.Status == 0
                    ? Lang.L("Git is installed, but this PC does not find it yet. Sign out and in again, then open Ovis again.", "Git을 설치했지만 아직 찾지 못했습니다. 로그아웃 후 다시 로그인한 뒤 Ovis를 다시 열어 주세요.")
                    : Lang.L("Git for Windows did not install.", "Git for Windows를 설치하지 못했습니다."));
                return;
            }
            await (plugin == null ? Install() : Update());
        }

        /// <summary>
        /// Only a pid the stop could not verify as Ovis's (another program reused it) is no failure: the stop leaves it
        /// alone and the start passes over it.
        /// </summary>
        public async Task Start()
        {
            Retry = Start;
            await Refresh();
            if (Phase != Phase.Installed || (Status != null && Status.Running)) return;
            ClearLog();
            Set(Phase.Working, Lang.L("Restarting…", "다시 시작하는 중…"));
            if (plugin != null && Status != null && Status.Pid != null && await HerdrRunning())
            {
                var stop = await PluginCommand(plugin, "stop", Append);
                if (Setup.StopFailed(stop.Status, stop.Output))
                {
                    Fail(Lang.L("Could not stop the Ovis server.", "Ovis 서버를 멈추지 못했습니다."));
                    return;
                }
            }
            await StartServer();
        }

        public async Task Restart()
        {
            Retry = Restart;
            ClearLog();
            Set(Phase.Working, Lang.L("Restarting…", "다시 시작하는 중…"));
            // the start waits until the old server has exited: started before, it would find that one
            // answering and leave nothing running once it goes
            if (plugin != null && await HerdrRunning() && !await Stop(plugin))
            {
                Fail(Lang.L("Could not stop the Ovis server.", "Ovis 서버를 멈추지 못했습니다."));
                return;
            }
            await StartServer();
        }

        private async Task StartServer()
        {
            if (plugin != null && await HerdrRunning())
            {
                if ((await Run.Program("herdr", new[] { "plugin", "action", "invoke", plugin.Id + ".start-windows" }, Append)).Status != 0)
                {
                    Fail(Lang.L("Could not start the Ovis server.", "Ovis 서버를 시작하지 못했습니다."));
                    return;
                }
            }
            else
            {
                if (!LoginStart()) return;
                Run.Detached("herdr", new[] { "server" });
            }
            await WaitUntilRunning();
            await Refresh();
        }

        public async Task MakePhoneAddress()
        {
            if (plugin == null) return;
            Retry = MakePhoneAddress;
            ClearLog();
            Set(Phase.Working, Lang.L("Making the phone address…", "휴대폰 주소를 만드는 중…"));
            await PluginCommand(plugin, "phone", Append, true, 5 * 60);
            await Refresh();
        }

        /// <summary>
        /// herdr and Bun stay, and herdr keeps running: stopping it would end every agent in it.
        /// </summary>
        public async Task Remove()
        {
            Retry = Remove;
            ClearLog();
            Set(Phase.Working, Lang.L("Removing…", "제거하는 중…"));
            var phoneUrl = Status == null ? null : Status.PhoneUrl;
            if (plugin != null)
            {
                // removed with its server up, the checkout would go on serving from a deleted folder; the server
                // can outlive a herdr that crashed, so it is stopped whether herdr runs or not
                if (!await Stop(plugin))
                {
                    Fail(Lang.L("Could not stop the Ovis server, so nothing was removed.", "Ovis 서버를 멈추지 못해 아무것도 제거하지 않았습니다."));
                    return;
                }
                if ((await Run.Program("herdr", new[] { "plugin", "uninstall", plugin.Id }, Append, true, 5 * 60)).Status != 0)
                {
                    Fail(Lang.L("herdr could not remove the Ovis server.", "herdr가 Ovis 서버를 제거하지 못했습니다."));
                    return;
                }
            }
            var tailscale = Paths.Tailscale;
            Uri url;
            if (phoneUrl != null && tailscale != null && Uri.TryCreate(phoneUrl, UriKind.Absolute, out url))
            {
                await Run.Program(tailscale, new[] { "serve", "--https=" + url.Port, "off" }, Append);
            }
            try
            {
                LoginItem.Remove();
            }
            catch (Exception exception)
            {
                Append(exception.Message);
            }
            await Refresh();
        }

        /// <summary>
        /// The plugin's own stop, run here rather than queued in herdr (a herdr action only queues): it returns
        /// once the server and everything under it have exited, and fails when it cannot tell.
        /// </summary>
        private async Task<bool> Stop(Plugin plugin)
        {
            return (await PluginCommand(plugin, "stop", Append)).Status == 0;
        }

        /// <summary>
        /// The plugin's own command (Setup.PluginCommandLine), run here as herdr runs its actions: told the state dir herdr
        /// keeps for the plugin. Releases under the old id from before 0.4.13 look for their server's pid there only when told, and in ~/.local/state
        /// otherwise, where they find none: their stop ended nothing, so a server that outlived herdr kept the old
        /// checkout's files open for the move's uninstall, and their status named no pid. Every release under the new id
        /// finds herdr's dir itself, and keeps its own for a server started by hand from the checkout.
        /// </summary>
        private static async Task<RunResult> PluginCommand(Plugin plugin, string command, Action<string> onLine, bool keepStderr = true, int limitSeconds = 120)
        {
            var line = Setup.PluginCommandLine(plugin.Root, command, System.IO.File.Exists);
            var program = line[0];
            var words = line.Skip(1).ToArray();
            if (plugin.Id != Links.LegacyPluginId) return await Run.Program(program, words, onLine, keepStderr, limitSeconds);
            // the child takes this process's environment when it starts; the app's steps run one at a time
            var given = Environment.GetEnvironmentVariable("HERDR_PLUGIN_STATE_DIR");
            Environment.SetEnvironmentVariable("HERDR_PLUGIN_STATE_DIR", Setup.HerdrPluginStateDir(plugin.Id, Environment.GetEnvironmentVariable));
            RunResult result;
            try
            {
                result = await Run.Program(program, words, onLine, keepStderr, limitSeconds);
            }
            finally
            {
                Environment.SetEnvironmentVariable("HERDR_PLUGIN_STATE_DIR", given);
            }
            // a server started by hand from the checkout keeps its pid in its own dir, which the given one hides: a stop
            // that found none there asks the way it did before
            if (command == "stop" && result.Status == 0 && !Setup.StoppedServer(result.Output)) return await Run.Program(program, words, onLine, keepStderr, limitSeconds);
            return result;
        }

        private static string[] PowerShell(string command)
        {
            return Setup.PowerShellArguments(command);
        }

        /// <summary>herdr's plugin list names the plugin's checkout; releases up to 0.4.13 name it by the old id.</summary>
        internal static async Task<Plugin> FindPlugin()
        {
            var result = await Run.Program("herdr", new[] { "plugin", "list", "--json" }, null, false);
            return result.Status != 0 ? null : Setup.ParsePlugin(result.Output);
        }

        private static async Task<Status> ReadStatus(Plugin plugin)
        {
            var result = await PluginCommand(plugin, "status", null, false);
            var words = (result.Output.Split('\n').FirstOrDefault() ?? "").Split(' ');
            var status = new Status { Running = words[0] == "running", Origin = words.Length > 1 ? words[1] : null, Version = Setup.StatusVersion(result.Output), Pid = Setup.StatusPid(result.Output) };
            if (!status.Running && status.Pid != null && status.Origin != null) status.AliveWithoutHerdr = await BridgeAnswers(status.Origin);
            if (!status.Running || status.Origin == null) return status;
            // the token that opened GET /api/updates opens GET /api/access too; one the server refused is not sent again
            string accessToken = null;
            try
            {
                using (var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) })
                {
                    var url = status.Origin.TrimEnd('/') + "/api/updates";
                    var answer = await GetTwice(client, url, null);
                    if (answer.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                    {
                        // behind a token: the plugin's own settings hold it, as `plugin.ts` reads them
                        var token = await PluginToken(plugin);
                        answer.Dispose();
                        if (token == null) return await WithAccess(status, null);
                        answer = await GetTwice(client, url, token);
                        if (answer.StatusCode != System.Net.HttpStatusCode.Unauthorized) accessToken = token;
                    }
                    using (answer)
                    {
                        if (answer.IsSuccessStatusCode)
                        {
                            var body = await answer.Content.ReadAsStringAsync();
                            status.RunningVersion = Setup.UpdatesVersion(body);
                            status.Unmanaged = Setup.UpdatesUnmanaged(body);
                        }
                    }
                }
            }
            catch (Exception exception) when (exception is HttpRequestException || exception is TaskCanceledException || exception is ArgumentException || exception is InvalidOperationException || exception is System.IO.IOException || exception is UnauthorizedAccessException || exception is FormatException)
            {
            }
            return await WithAccess(status, accessToken);
        }

        /// <summary>
        /// Whether the app itself holds its port: its bridge health (`/api/health?scope=bridge`, open, answered by every
        /// release since 0.3.0) needs no herdr, so it tells a server that outlived herdr from a stale pid file naming
        /// another program.
        /// </summary>
        private static async Task<bool> BridgeAnswers(string origin)
        {
            try
            {
                using (var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) })
                using (var answer = await client.GetAsync(origin.TrimEnd('/') + "/api/health?scope=bridge"))
                {
                    return answer.IsSuccessStatusCode && Setup.BridgeHealth(await answer.Content.ReadAsStringAsync());
                }
            }
            catch (Exception exception) when (exception is HttpRequestException || exception is TaskCanceledException || exception is ArgumentException || exception is InvalidOperationException)
            {
                return false;
            }
        }

        /// <summary>
        /// Each send is a request of its own, with the token when there is one.
        /// </summary>
        private static async Task<HttpResponseMessage> GetTwice(HttpClient client, string url, string token)
        {
            for (var attempt = 1; ; attempt++)
            {
                using (var request = new HttpRequestMessage(HttpMethod.Get, url))
                {
                    if (token != null) request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
                    try
                    {
                        return await client.SendAsync(request);
                    }
                    catch (TaskCanceledException) when (attempt < 2)
                    {
                    }
                }
            }
        }

        private static async Task<string> PluginToken(Plugin plugin)
        {
            var dir = await Run.Program("herdr", new[] { "plugin", "config-dir", plugin.Id }, null, false);
            var path = dir.Status == 0 ? (dir.Output.Split('\n').FirstOrDefault() ?? "").Trim() : "";
            var files = path.Length == 0 ? new string[0] : new[] { "env", ".env" }.Select(name => System.IO.Path.Combine(path, name)).Where(System.IO.File.Exists).Select(file => System.IO.File.ReadAllText(file)).ToArray();
            // the environment herdr hands the plugin, under its settings files, as `plugin.ts` layers them: this process's
            // own value first (herdr and the app started the same way share it), the saved User value when it has none
            var environment = Setup.EnvironmentLayer(name => Environment.GetEnvironmentVariable(name) ?? Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.User));
            return Setup.EnvToken(new[] { environment }.Concat(files));
        }

        /// <summary>
        /// The phone address and Tailscale's state, from GET /api/access, with the server's token when it asks for one (the
        /// PC's own token, from the plugin's settings): without it, a server behind a token answers 401, and that is all
        /// that is known.
        /// </summary>
        private static async Task<Status> WithAccess(Status status, string token)
        {
            try
            {
                using (var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) })
                using (var request = new HttpRequestMessage(HttpMethod.Get, status.Origin.TrimEnd('/') + "/api/access"))
                {
                    if (token != null) request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
                    string body;
                    using (var answer = await client.SendAsync(request))
                    {
                        if (answer.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                        {
                            status.AccessLocked = true;
                            return status;
                        }
                        if (!answer.IsSuccessStatusCode) return status;
                        body = await answer.Content.ReadAsStringAsync();
                    }
                    var access = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
                    object value;
                    var tailscale = access != null && access.TryGetValue("tailscale", out value) ? value as Dictionary<string, object> : null;
                    if (tailscale != null)
                    {
                        status.Tailscale = tailscale.ContainsKey("state") ? tailscale["state"] as string : null;
                        status.PhoneUrl = tailscale.ContainsKey("serving_url") ? tailscale["serving_url"] as string : null;
                    }
                }
            }
            catch (Exception exception) when (exception is HttpRequestException || exception is TaskCanceledException || exception is ArgumentException || exception is KeyNotFoundException || exception is InvalidOperationException)
            {
            }
            return status;
        }

        internal static async Task<bool> HerdrRunning()
        {
            var result = await Run.Program("herdr", new[] { "status", "server", "--json" }, null, false);
            return result.Output.Replace(" ", "").Contains("\"running\":true");
        }

        private static async Task WaitUntilRunning()
        {
            for (var attempt = 0; attempt < 60; attempt++)
            {
                var found = await FindPlugin();
                if (found != null && (await ReadStatus(found)).Running) return;
                await Task.Delay(2000);
            }
        }

        private void Set(Phase phase, string title = null)
        {
            Phase = phase;
            Title = title;
            var changed = Changed;
            if (changed != null) changed();
        }

        private void Fail(string message, string detail = null)
        {
            if (detail != null) Append(detail);
            Set(Phase.Failed, message);
        }

        private void ClearLog()
        {
            lock (log) log.Clear();
        }

        private void Append(string line)
        {
            if (line.Length == 0 || line.All(c => "█▀▄ ".IndexOf(c) >= 0)) return;
            lock (log) log.Add(line);
            context.Post(_ =>
            {
                var added = LineAdded;
                if (added != null) added(line);
            }, null);
        }
    }
}
