using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace EdgeParallelInstaller {
    internal static class Program {
        internal const string PayloadResource = "EdgeParallel.Payload.zip";
        [STAThread]
        private static int Main(string[] args) {
            string exe = Assembly.GetExecutingAssembly().Location;
            if (Array.IndexOf(args, "/self-test") >= 0) {
                string report = args.Length > 1 ? Path.GetFullPath(args[1]) : Path.Combine(Path.GetTempPath(), "EdgeParallel-installer-test.txt");
                try { File.WriteAllText(report, SelfTests.Run(exe)); return 0; }
                catch (Exception error) { File.WriteAllText(report, error.ToString()); return 1; }
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try {
                string installedExe = Path.Combine(InstallerCore.DefaultRoot, "Setup.exe");
                if (String.Equals(exe, installedExe, StringComparison.OrdinalIgnoreCase)) {
                    // Run maintenance from a separate copy so the installed executable can be replaced/deleted.
                    string copy = Path.Combine(Path.GetTempPath(), "EdgeParallel-Setup-" + Guid.NewGuid().ToString("N") + ".exe");
                    File.Copy(exe, copy);
                    Process.Start(new ProcessStartInfo {
                        FileName = copy, Arguments = "/wait " + Process.GetCurrentProcess().Id + (Array.IndexOf(args, "/uninstall") >= 0 ? " /uninstall" : ""),
                        UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetTempPath()
                    });
                    return 0;
                }
                if (args.Length >= 2 && args[0] == "/wait") {
                    int pid;
                    if (Int32.TryParse(args[1], out pid)) {
                        try { using (var parent = Process.GetProcessById(pid)) parent.WaitForExit(10000); }
                        catch (ArgumentException) { }
                    }
                }
                bool created;
                using (var mutex = new Mutex(true, @"Local\EdgeParallel-Installer-" + Environment.UserName, out created)) {
                    if (!created) { MessageBox.Show("安装程序已打开，请使用现有窗口。", "Edge 多线程下载"); return 0; }
                    Application.Run(new SetupForm(InstallerCore.Production(exe), Array.IndexOf(args, "/uninstall") >= 0));
                }
                return 0;
            } catch (Exception error) {
                MessageBox.Show(error.Message, "无法启动安装程序", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }

    internal sealed class SetupForm : Form {
        private readonly InstallContext context;
        private readonly Button install = new Button();
        private readonly Button uninstall = new Button();
        private readonly Button copy = new Button();
        private readonly Button folder = new Button();
        private readonly Button edge = new Button();
        private readonly Label status = new Label();
        private readonly ProgressBar progress = new ProgressBar();
        private bool working;
        internal SetupForm(InstallContext installContext, bool uninstallRequested) {
            context = installContext;
            Text = "Edge 多线程下载 · " + InstallerCore.Version;
            Font = new Font("Microsoft YaHei UI", 10F);
            ClientSize = new Size(720, 650);
            MinimumSize = new Size(700, 650);
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            BackColor = Color.White;
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(26), ColumnCount = 1, RowCount = 8 };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 45));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 56));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 22));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 63));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
            Controls.Add(layout);
            layout.Controls.Add(new Label { Text = "Edge 多线程下载", Font = new Font(Font.FontFamily, 19F, FontStyle.Bold), Dock = DockStyle.Fill }, 0, 0);
            layout.Controls.Add(new Label { Text = "下载仍在 Edge 中管理，下载助手在后台运行。", Dock = DockStyle.Fill }, 0, 1);
            var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
            StyleButton(install, "安装 / 修复", 172);
            install.BackColor = Color.FromArgb(0, 102, 204); install.ForeColor = Color.White; install.FlatStyle = FlatStyle.Flat;
            StyleButton(uninstall, "卸载", 100);
            actions.Controls.Add(install); actions.Controls.Add(uninstall); layout.Controls.Add(actions, 0, 2);
            progress.Dock = DockStyle.Fill; progress.Visible = false; progress.Style = ProgressBarStyle.Marquee; layout.Controls.Add(progress, 0, 3);
            status.Dock = DockStyle.Fill; status.Padding = new Padding(0, 8, 0, 0); status.ForeColor = Color.FromArgb(35, 55, 75);
            status.Text = "安装后还需在 Edge 中完成一次手动加载：\n\n1. 打开 Edge 扩展管理，开启“开发人员模式”。\n2. 选择“加载解压缩的扩展”，粘贴下方目录。\n\n从旧 ZIP 版升级时，也需要加载下方新目录。\n已使用此安装目录的扩展，更新后点击“重新加载”。";
            layout.Controls.Add(status, 0, 4);
            var pathPanel = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
            pathPanel.Controls.Add(new Label { Text = "扩展目录", AutoSize = true }, 0, 0);
            pathPanel.Controls.Add(new TextBox { Text = Path.Combine(context.Root, "extension"), ReadOnly = true, Dock = DockStyle.Fill }, 0, 1);
            layout.Controls.Add(pathPanel, 0, 5);
            var links = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
            StyleButton(copy, "复制目录", 115); StyleButton(folder, "打开目录", 115); StyleButton(edge, "打开 Edge 扩展管理", 205);
            links.Controls.Add(copy); links.Controls.Add(folder); links.Controls.Add(edge); layout.Controls.Add(links, 0, 6);
            layout.Controls.Add(new Label { Text = "仅为当前用户安装 · 无需管理员权限", Dock = DockStyle.Fill, ForeColor = Color.DimGray, Font = new Font(Font.FontFamily, 9F) }, 0, 7);
            install.Click += async delegate { await RunAction(false); };
            uninstall.Click += async delegate { await RunAction(true); };
            copy.Click += delegate { Open(delegate { Clipboard.SetText(Path.Combine(context.Root, "extension")); status.Text = "目录已复制。\n\n在 Edge 扩展管理中开启开发人员模式，\n选择“加载解压缩的扩展”，粘贴目录。"; }); };
            folder.Click += delegate { Open(delegate { Process.Start("explorer.exe", "\"" + Path.Combine(context.Root, "extension") + "\""); }); };
            edge.Click += delegate { Open(delegate {
                string browser = FindEdge();
                if (browser == null) throw new IOException("未找到 Edge。请手动在 Edge 地址栏打开 edge://extensions。");
                Process.Start(new ProcessStartInfo { FileName = browser, Arguments = "edge://extensions", UseShellExecute = true });
            }); };
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (working) e.Cancel = true; };
            RefreshButtons();
            if (uninstallRequested) Shown += async delegate { await RunAction(true); };
        }
        private static void StyleButton(Button button, string text, int width) { button.Text = text; button.Size = new Size(width, 38); button.Margin = new Padding(0, 0, 12, 0); }
        private void RefreshButtons() {
            bool exists = File.Exists(Path.Combine(context.Root, InstallerCore.Marker));
            install.Enabled = !working; uninstall.Enabled = !working && exists;
            copy.Enabled = !working && exists; folder.Enabled = !working && exists; edge.Enabled = !working;
            progress.Visible = working;
        }
        private async Task RunAction(bool remove) {
            if (working) return;
            if (remove && MessageBox.Show(this, "卸载下载助手和安装文件？\n\n浏览器扩展请随后在 Edge 扩展管理中移除。已下载的文件不会删除。", "卸载 Edge 多线程下载", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            working = true; RefreshButtons();
            status.Text = remove ? "正在卸载，请稍候……" : "正在准备和安装文件，请稍候……";
            try {
                await Task.Run(delegate {
                    if (remove) InstallerCore.Uninstall(context);
                    else using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(Program.PayloadResource)) {
                        if (payload == null) throw new InvalidDataException("安装程序缺少内嵌文件，请重新下载完整 Setup.exe。");
                        InstallerCore.Install(context, payload);
                    }
                });
                status.Text = remove ? "已卸载下载助手。\n\n请在 Edge 扩展管理中移除“Edge 多线程下载”。\n已下载的文件和目录内其他个人文件均已保留。" :
                    "安装成功。\n\n1. 点击“复制目录”和“打开 Edge 扩展管理”。\n2. 开启开发人员模式，选择“加载解压缩的扩展”。\n3. 粘贴目录并选择文件夹。\n\n旧 ZIP 版需移除旧扩展后加载；已用此目录则重新加载。";
            } catch (Exception error) {
                status.Text = "操作未完成：" + error.Message;
                MessageBox.Show(this, error.Message, "操作未完成", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            } finally { working = false; RefreshButtons(); }
        }
        private void Open(Action action) { try { action(); } catch (Exception error) { MessageBox.Show(this, error.Message, "无法打开", MessageBoxButtons.OK, MessageBoxIcon.Information); } }
        private static string FindEdge() {
            foreach (string root in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) }) {
                string candidate = Path.Combine(root, "Microsoft", "Edge", "Application", "msedge.exe");
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }
    }
}
