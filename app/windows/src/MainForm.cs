using System;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Ovis
{
    internal sealed class MainForm : Form
    {
        private readonly Model model;
        private readonly FlowLayoutPanel body;
        private readonly TextBox logBox;

        public MainForm()
        {
            // made here, not in a field initializer: the Model keeps the window thread's context, which the
            // base Form constructor installs
            model = new Model();
            Text = "Ovis";
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F, 96F);
            Font = new Font("Segoe UI", 9.75F);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            BackColor = SystemColors.Window;
            Padding = new Padding(24);
            try
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch (ArgumentException) { }

            var root = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, Margin = Padding.Empty };
            root.Controls.Add(Header());
            root.Controls.Add(new Label { BorderStyle = BorderStyle.Fixed3D, Height = 2, Width = ContentWidth, Margin = new Padding(0, 14, 0, 14) });
            body = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, Margin = Padding.Empty, MinimumSize = new Size(ContentWidth, 160) };
            root.Controls.Add(body);
            var licences = new LinkLabel { Text = Lang.L("Licences", "라이선스"), AutoSize = true, Margin = new Padding(0, 16, 0, 0), LinkColor = SystemColors.GrayText };
            licences.LinkClicked += (sender, args) => ShowLicences();
            root.Controls.Add(licences);
            Controls.Add(root);

            logBox = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Font = new Font("Consolas", 8.5F),
                Width = ContentWidth,
                Height = 220,
                BackColor = SystemColors.Control,
                Margin = new Padding(0, 10, 0, 10),
                AccessibleName = "Log",
            };
            model.Changed += Render;
            model.LineAdded += line =>
            {
                logBox.AppendText((logBox.TextLength == 0 ? "" : Environment.NewLine) + line);
            };
            Render();
            Shown += async (sender, args) => await model.Refresh();
        }

        private const int ContentWidth = 520;
        private Font boldFont;

        private Control Header()
        {
            var header = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = false, Margin = Padding.Empty };
            if (Icon != null)
            {
                header.Controls.Add(new PictureBox { Image = new Icon(Icon, 64, 64).ToBitmap(), Size = new Size(56, 56), SizeMode = PictureBoxSizeMode.Zoom, Margin = new Padding(0, 0, 14, 0) });
            }
            var titles = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, Margin = new Padding(0, 4, 0, 0) };
            titles.Controls.Add(new Label { Text = "Ovis", Font = new Font("Segoe UI Semibold", 18F), AutoSize = true, Margin = Padding.Empty });
            titles.Controls.Add(new Label { Text = Lang.L("Your coding agents, on your phone", "코딩 에이전트를 휴대폰에서"), ForeColor = SystemColors.GrayText, AutoSize = true, Margin = Padding.Empty });
            header.Controls.Add(titles);
            return header;
        }

        private void Render()
        {
            SuspendLayout();
            AcceptButton = null;
            // a cleared control keeps its window handle until disposed: each Check again would leak them
            var replaced = body.Controls.Cast<Control>().Where(control => control != logBox).ToList();
            body.Controls.Clear();
            foreach (var control in replaced) DisposeTree(control);
            switch (model.Phase)
            {
                case Phase.Checking:
                    body.Controls.Add(Paragraph(Lang.L("Checking this PC…", "이 PC를 확인하는 중…")));
                    break;
                case Phase.NotInstalled:
                    NotInstalled();
                    break;
                case Phase.Working:
                    body.Controls.Add(new ProgressBar { Style = ProgressBarStyle.Marquee, Width = ContentWidth, Height = 6, Margin = new Padding(0, 0, 0, 8) });
                    body.Controls.Add(Heading(model.Title));
                    logBox.Text = model.LogText;
                    body.Controls.Add(logBox);
                    break;
                case Phase.Failed:
                    var message = Heading("⚠ " + model.Title);
                    message.ForeColor = Color.Firebrick;
                    body.Controls.Add(message);
                    logBox.Text = model.LogText;
                    body.Controls.Add(logBox);
                    body.Controls.Add(Buttons(
                        Primary(Lang.L("Try again", "다시 시도"), () => (model.Retry ?? model.Install)()),
                        Button(Lang.L("Copy the log", "오류 내용 복사"), () => { Clipboard.SetText(model.LogText.Length == 0 ? " " : model.LogText); return Task.CompletedTask; }),
                        Button(Lang.L("Get help", "도움 받기"), () => Open(Links.Support))));
                    break;
                case Phase.Installed:
                    Installed();
                    break;
                case Phase.Outdated:
                    Outdated();
                    break;
                case Phase.HerdrTooOld:
                    HerdrTooOld();
                    break;
            }
            ResumeLayout(true);
        }

        private void NotInstalled()
        {
            body.Controls.Add(Heading(Lang.L("Set up this PC for Ovis", "이 PC를 Ovis에 연결할 준비를 합니다")));
            body.Controls.Add(Paragraph(Lang.L(
                "This installs herdr, Bun and the Ovis server for your user only, with no administrator password, and starts herdr when you sign in to Windows. Then scan the QR code with Ovis on your phone.",
                "herdr, Bun, Ovis 서버를 내 사용자 계정에만 설치합니다(관리자 권한 필요 없음). Windows에 로그인할 때 herdr가 자동으로 켜집니다. 설치가 끝나면 휴대폰의 Ovis로 QR 코드를 찍으면 됩니다.")));
            if (GitStep()) return;
            var install = Primary(Lang.L("Install", "설치"), () => model.Install());
            body.Controls.Add(Buttons(install));
            AcceptButton = install;
        }

        private bool GitStep()
        {
            if (!model.GitMissing) return false;
            var git = Heading(Lang.L("First, Git for Windows", "먼저 Git for Windows가 필요합니다"));
            git.Margin = new Padding(0, 6, 0, 4);
            body.Controls.Add(git);
            body.Controls.Add(Paragraph(model.CanUseWinget
                ? Lang.L("The installer needs Git. Install it with winget (Windows asks for permission), or download it yourself and open Ovis again.",
                         "설치 프로그램에 Git이 필요합니다. winget으로 설치하거나(Windows가 허락을 물어봅니다) 직접 받아 설치한 뒤 Ovis를 다시 열어 주세요.")
                : Lang.L("The installer needs Git. Download and install it, then open Ovis again.",
                         "설치 프로그램에 Git이 필요합니다. 받아서 설치한 뒤 Ovis를 다시 열어 주세요.")));
            body.Controls.Add(model.CanUseWinget
                ? Buttons(
                    Primary(Lang.L("Install Git", "Git 설치"), () => model.InstallGit()),
                    Button(Lang.L("Download Git", "Git 내려받기"), () => Open(Links.GitDownload)),
                    Button(Lang.L("Check again", "다시 확인"), () => model.Refresh()))
                : Buttons(
                    Primary(Lang.L("Download Git", "Git 내려받기"), () => Open(Links.GitDownload)),
                    Button(Lang.L("Check again", "다시 확인"), () => model.Refresh())));
            return true;
        }

        private void Outdated()
        {
            body.Controls.Add(Heading(Lang.L("Update the Ovis server", "Ovis 서버를 업데이트해야 합니다")));
            body.Controls.Add(Paragraph(Setup.UpdateMessage(model.UpdateReason, model.Plugin, model.Status != null && model.Status.Running, model.Status == null ? null : model.Status.RunningVersion, model.Status == null ? null : model.Status.Version, Model.AppVersion)));
            if (GitStep()) return;
            var update = Primary(Lang.L("Update", "업데이트"), () => model.Update());
            body.Controls.Add(Buttons(update, Button(Lang.L("Check again", "다시 확인"), () => model.Refresh())));
            AcceptButton = update;
        }

        private void HerdrTooOld()
        {
            body.Controls.Add(Heading(Lang.L("Update herdr first", "먼저 herdr를 업데이트해야 합니다")));
            body.Controls.Add(Paragraph(Setup.HerdrMessage(model.Plugin, model.HerdrVersion)));
            body.Controls.Add(Buttons(
                Primary(Lang.L("Check again", "다시 확인"), () => model.Refresh()),
                Button(Lang.L("Get help", "도움 받기"), () => Open(Links.Support))));
        }

        private void Installed()
        {
            var status = model.Status;
            var running = status != null && status.Running;
            var line = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = false, Margin = new Padding(0, 0, 0, 10) };
            line.Controls.Add(new Label { Text = "●", ForeColor = running ? Color.SeaGreen : Color.DarkOrange, AutoSize = true, Margin = new Padding(0, 2, 4, 0) });
            var state = Heading(running ? Lang.L("Running on this PC", "이 PC에서 실행 중") : Lang.L("Not running", "꺼져 있음"));
            state.Margin = Padding.Empty;
            line.Controls.Add(state);
            line.Controls.Add(Button(Lang.L("Check again", "다시 확인"), () => model.Refresh(), 0));
            body.Controls.Add(line);
            if (running) Phone(status);
            var buttons = new System.Collections.Generic.List<Button>();
            if (running && status.Origin != null) buttons.Add(Primary(Lang.L("Open in browser", "브라우저에서 열기"), () => Open(status.Origin)));
            buttons.Add(running ? Button(Lang.L("Restart", "다시 시작"), () => model.Restart()) : Button(Lang.L("Start", "시작"), () => model.Start()));
            buttons.Add(Button(Lang.L("Remove…", "제거…"), ConfirmRemove));
            body.Controls.Add(Buttons(buttons.ToArray()));
        }

        private void Phone(Status status)
        {
            var step = Setup.Phone(status.PhoneUrl, status.Tailscale, status.AccessLocked);
            if (step == PhoneStep.Qr)
            {
                var row = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = false, Margin = new Padding(0, 0, 0, 12) };
                var size = (int)Math.Round(180 * DeviceDpi / 96.0);
                var modules = QrCode.Encode(status.PhoneUrl);
                var scale = Math.Max(1, size / (modules.GetLength(0) + 8));
                row.Controls.Add(new PictureBox
                {
                    Image = QrCode.ToBitmap(modules, scale, 4),
                    SizeMode = PictureBoxSizeMode.AutoSize,
                    Margin = new Padding(0, 0, 18, 0),
                    AccessibleName = "QR code",
                });
                var words = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, Margin = Padding.Empty };
                words.Controls.Add(Heading(Lang.L("Connect your phone", "휴대폰 연결")));
                words.Controls.Add(Paragraph(Lang.L(
                    "Open Ovis on your phone, tap Scan QR code, and point it here. Your phone needs Tailscale, signed in to the same account.",
                    "휴대폰에서 Ovis를 열고 Scan QR code를 눌러 이 화면을 찍으세요. 휴대폰에도 같은 계정으로 로그인한 Tailscale이 있어야 합니다."), 300));
                var url = new TextBox { Text = status.PhoneUrl, ReadOnly = true, BorderStyle = BorderStyle.None, Width = 300, BackColor = SystemColors.Window, ForeColor = SystemColors.GrayText, Font = MonoFont, AccessibleName = "Phone address" };
                words.Controls.Add(url);
                row.Controls.Add(words);
                body.Controls.Add(row);
            }
            else if (step == PhoneStep.TokenNeeded)
            {
                // what the server told without its token is not that Tailscale is missing: say what stood in the way
                body.Controls.Add(Heading(Lang.L("Ovis cannot read this PC's phone address", "이 PC의 휴대폰 주소를 읽지 못했습니다")));
                body.Controls.Add(Paragraph(Lang.L(
                    "The Ovis server asks for its token, and Ovis did not find it, or it did not work, in the server's settings (env or .env in herdr's config folder for the plugin). Open Ovis in the browser to connect your phone, or put the server's token there and check again.",
                    "Ovis 서버가 토큰을 요구하는데, 서버 설정(herdr의 플러그인 설정 폴더에 있는 env 또는 .env)에서 그 토큰을 찾지 못했거나 그 토큰이 맞지 않습니다. 브라우저에서 Ovis를 열어 휴대폰을 연결하거나, 서버의 토큰을 그곳에 넣은 뒤 다시 확인해 주세요.")));
            }
            else if (step == PhoneStep.MakeAddress)
            {
                body.Controls.Add(Heading(Lang.L("Your phone needs an address for this PC", "휴대폰이 열 주소가 아직 없습니다")));
                body.Controls.Add(Paragraph(Lang.L("Tailscale runs here: let it serve the app to your own devices.", "이 PC에 Tailscale이 있습니다. 내 기기들에서만 열리는 주소를 만듭니다.")));
                body.Controls.Add(Buttons(Button(Lang.L("Make the phone address", "휴대폰 주소 만들기"), () => model.MakePhoneAddress())));
            }
            else
            {
                body.Controls.Add(Heading(Lang.L("Your phone needs a way to reach this PC", "휴대폰에서 이 PC에 올 길이 필요합니다")));
                body.Controls.Add(Paragraph(step == PhoneStep.SignInTailscale
                    ? Lang.L("Tailscale is installed but not signed in. Sign in to it, then check again.", "Tailscale이 설치돼 있지만 로그인되지 않았습니다. 로그인한 뒤 다시 확인해 주세요.")
                    : Lang.L("Install Tailscale on this PC and on your phone, sign in to both with the same account, then check again.", "이 PC와 휴대폰에 Tailscale을 설치하고 같은 계정으로 로그인한 뒤 다시 확인해 주세요.")));
                if (step == PhoneStep.InstallTailscale) body.Controls.Add(Buttons(Button(Lang.L("Get Tailscale", "Tailscale 받기"), () => Open(Links.TailscaleDownload))));
            }
        }

        private void ShowLicences()
        {
            string notice;
            using (var stream = typeof(MainForm).Assembly.GetManifestResourceStream("NOTICE.txt"))
            using (var reader = new System.IO.StreamReader(stream))
            {
                notice = reader.ReadToEnd().Replace("\r\n", "\n").Replace("\n", Environment.NewLine);
            }
            using (var dialog = new Form { Text = Lang.L("Licences", "라이선스"), StartPosition = FormStartPosition.CenterParent, Size = new Size(620, 460), MinimizeBox = false, MaximizeBox = false, ShowInTaskbar = false, Icon = Icon })
            {
                dialog.Controls.Add(new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Font = MonoFont, Text = notice });
                dialog.ShowDialog(this);
            }
        }

        private Task ConfirmRemove()
        {
            var answer = MessageBox.Show(this,
                Lang.L("herdr and Bun stay, and herdr keeps running with your agents.", "herdr와 Bun은 남고, herdr와 에이전트는 계속 실행됩니다."),
                Lang.L("Remove the Ovis server from this PC?", "이 PC에서 Ovis 서버를 제거할까요?"),
                MessageBoxButtons.OKCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            return answer == DialogResult.OK ? model.Remove() : Task.CompletedTask;
        }

        private static Task Open(string url)
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            return Task.CompletedTask;
        }

        private static readonly Font HeadingFont = new Font("Segoe UI Semibold", 11F);
        private static readonly Font MonoFont = new Font("Consolas", 8.5F);

        private static void DisposeTree(Control control)
        {
            foreach (var child in control.Controls.Cast<Control>().ToList()) DisposeTree(child);
            var picture = control as PictureBox;
            if (picture != null && picture.Image != null) picture.Image.Dispose();
            control.Dispose();
        }

        private static Label Heading(string text)
        {
            return new Label { Text = text, Font = HeadingFont, AutoSize = true, MaximumSize = new Size(ContentWidth, 0), Margin = new Padding(0, 0, 0, 6) };
        }

        private static Label Paragraph(string text, int width = ContentWidth)
        {
            return new Label { Text = text, AutoSize = true, MaximumSize = new Size(width, 0), Margin = new Padding(0, 0, 0, 10) };
        }

        private static FlowLayoutPanel Buttons(params Button[] buttons)
        {
            var row = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = true, MaximumSize = new Size(ContentWidth, 0), Margin = new Padding(0, 4, 0, 0) };
            row.Controls.AddRange(buttons);
            return row;
        }

        private Button Primary(string text, Func<Task> action)
        {
            var button = Button(text, action);
            button.Font = boldFont ?? (boldFont = new Font(Font, FontStyle.Bold));
            return button;
        }

        private Button Button(string text, Func<Task> action, int left = -1)
        {
            var button = new Button { Text = text, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(10, 3, 10, 3), UseVisualStyleBackColor = true };
            if (left >= 0) button.Margin = new Padding(12, 0, 0, 0);
            button.Click += async (sender, args) =>
            {
                body.Enabled = false;
                try
                {
                    await action();
                }
                catch (Exception exception)
                {
                    MessageBox.Show(this, exception.Message, "Ovis", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                finally
                {
                    body.Enabled = true;
                }
            };
            return button;
        }
    }
}
