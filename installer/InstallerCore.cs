using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace EdgeParallelInstaller {
    internal sealed class InstallContext {
        internal string Root;
        internal string SourceExe;
        internal string HostKey = @"Software\Microsoft\Edge\NativeMessagingHosts\com.edgeparallel.bridge";
        internal string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\EdgeParallel";
        internal Func<bool> IsBusy;
        internal Action<string> Checkpoint;
    }

    internal sealed class OwnedFiles {
        public string Product { get; set; }
        public string Version { get; set; }
        public string[] Files { get; set; }
    }

    internal sealed class RegistrySnapshot {
        internal bool Existed;
        internal Dictionary<string, object> Values = new Dictionary<string, object>();
        internal Dictionary<string, RegistryValueKind> Kinds = new Dictionary<string, RegistryValueKind>();
        internal static RegistrySnapshot Capture(string path) {
            var snapshot = new RegistrySnapshot();
            using (var key = Registry.CurrentUser.OpenSubKey(path)) {
                if (key == null) return snapshot;
                snapshot.Existed = true;
                foreach (string name in key.GetValueNames()) {
                    snapshot.Values[name] = key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                    snapshot.Kinds[name] = key.GetValueKind(name);
                }
            }
            return snapshot;
        }
        internal void Restore(string path) {
            if (!Existed) { Registry.CurrentUser.DeleteSubKeyTree(path, false); return; }
            using (var key = Registry.CurrentUser.CreateSubKey(path)) {
                foreach (string name in key.GetValueNames()) key.DeleteValue(name, false);
                foreach (var pair in Values) key.SetValue(pair.Key, pair.Value, Kinds[pair.Key]);
            }
        }
    }

    internal static class InstallerCore {
        internal const string Version = "0.2.0";
        internal const string ExtensionId = "jcpnknmnbonffkcmnficeijhojknegbm";
        internal const string Marker = ".edgeparallel-install.json";
        internal const string HostManifest = "host/com.edgeparallel.bridge.json";
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        internal static string DefaultRoot {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "EdgeParallel"); }
        }
        internal static InstallContext Production(string exe) {
            var context = new InstallContext { Root = DefaultRoot, SourceExe = exe };
            context.IsBusy = delegate { return ActiveHelper(context); };
            return context;
        }
        internal static string Inside(string root, string relative) {
            if (String.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative) || relative.IndexOf(':') >= 0)
                throw new InvalidDataException("安装包包含不安全的文件路径。");
            string normalized = relative.Replace('\\', '/');
            foreach (string part in normalized.Split('/')) {
                if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") ||
                    part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                    throw new InvalidDataException("安装包包含不安全的文件名。");
                string stem = part.Split('.')[0].ToUpperInvariant();
                if (new[] { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" }.Contains(stem))
                    throw new InvalidDataException("安装包包含 Windows 保留文件名。");
            }
            string prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string target = Path.GetFullPath(Path.Combine(root, normalized.Replace('/', Path.DirectorySeparatorChar)));
            if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装路径超出目标目录。");
            return target;
        }
        internal static void NoLinks(string path) {
            for (string current = Path.GetFullPath(path); !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current)) {
                if ((Directory.Exists(current) || File.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("安装路径包含目录链接。为保护原文件，已停止操作：" + current);
            }
        }
        private static bool Allowed(string relative) {
            string path = relative.Replace('\\', '/');
            return path.StartsWith("extension/", StringComparison.OrdinalIgnoreCase) || path.StartsWith("host/", StringComparison.OrdinalIgnoreCase) ||
                path.StartsWith("runtime/", StringComparison.OrdinalIgnoreCase) || path.StartsWith("docs/", StringComparison.OrdinalIgnoreCase) ||
                new[] { "LICENSE", "THIRD_PARTY_NOTICES.md", "PRIVACY.md", "README.md", "CHANGELOG.md", "Setup.exe", Marker }.Contains(path, StringComparer.OrdinalIgnoreCase);
        }
        private static HashSet<string> ReadOwned(string root) {
            string marker = Path.Combine(root, Marker);
            if (!File.Exists(marker)) return new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            NoLinks(marker);
            if (new FileInfo(marker).Length > 1024 * 1024) throw new InvalidDataException("安装清单异常，请保留当前目录并重新下载安装包。");
            var saved = Json.Deserialize<OwnedFiles>(File.ReadAllText(marker));
            if (saved == null || saved.Product != "EdgeParallel" || saved.Files == null) throw new InvalidDataException("当前目录没有有效的安装清单。");
            var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string file in saved.Files) {
                Inside(root, file);
                if (!Allowed(file) || !result.Add(file)) throw new InvalidDataException("安装清单包含无效文件。");
            }
            result.Add(Marker);
            return result;
        }
        private static HashSet<string> Extract(Stream payload, string stage) {
            var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long total = 0;
            using (var archive = new ZipArchive(payload, ZipArchiveMode.Read, true)) {
                if (archive.Entries.Count > 4096) throw new InvalidDataException("安装包文件过多。");
                foreach (var entry in archive.Entries) {
                    string name = entry.FullName.Replace('\\', '/');
                    if (name.EndsWith("/")) { Inside(stage, name.TrimEnd('/')); continue; }
                    string target = Inside(stage, name);
                    if (!Allowed(name) || name.Equals("Setup.exe", StringComparison.OrdinalIgnoreCase) || name.Equals(Marker, StringComparison.OrdinalIgnoreCase) || !files.Add(name))
                        throw new InvalidDataException("安装包中包含多余或重复的文件。");
                    total += entry.Length;
                    if (entry.Length > 512L * 1024 * 1024 || total > 1024L * 1024 * 1024) throw new InvalidDataException("安装包大小异常。");
                    int kind = (entry.ExternalAttributes >> 16) & 0xF000;
                    if (kind == 0xA000) throw new InvalidDataException("安装包不允许符号链接。");
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream input = entry.Open()) using (Stream output = new FileStream(target, FileMode.CreateNew)) input.CopyTo(output);
                }
            }
            foreach (string required in new[] { "extension/manifest.json", "host/EdgeParallelHost.exe", "host/main.mjs", "host/bridge.mjs", "host/engine.mjs", "runtime/node.exe", "runtime/LICENSE.txt", "LICENSE", "THIRD_PARTY_NOTICES.md" })
                if (!files.Contains(required)) throw new InvalidDataException("安装包不完整，缺少 " + required);
            var manifest = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Inside(stage, "extension/manifest.json")));
            if (!manifest.ContainsKey("key") || ExtensionFromKey((string)manifest["key"]) != ExtensionId) throw new InvalidDataException("扩展标识与此安装程序不匹配。");
            return files;
        }
        internal static string ExtensionFromKey(string key) {
            using (var sha = SHA256.Create()) {
                byte[] bytes = sha.ComputeHash(Convert.FromBase64String(key));
                var result = new StringBuilder();
                for (int i = 0; i < 16; i++) { result.Append((char)('a' + (bytes[i] >> 4))); result.Append((char)('a' + (bytes[i] & 15))); }
                return result.ToString();
            }
        }
        private static void WriteManifest(string stage, string root) {
            var manifest = new Dictionary<string, object> {
                { "name", "com.edgeparallel.bridge" }, { "description", "Edge Parallel Download background helper" },
                { "path", Inside(root, "host/EdgeParallelHost.exe") }, { "type", "stdio" },
                { "allowed_origins", new[] { "chrome-extension://" + ExtensionId + "/" } }
            };
            File.WriteAllText(Inside(stage, HostManifest), Json.Serialize(manifest), new UTF8Encoding(false));
        }
        private static void CheckBusy(InstallContext context) {
            if (context.IsBusy != null && context.IsBusy()) throw new IOException("下载助手正在使用中。请等待下载结束，关闭 Edge 后再重试；安装程序不会中断下载。");
        }
        private static void CheckWritable(string root, IEnumerable<string> names) {
            foreach (string name in names) {
                string path = Inside(root, name);
                NoLinks(path);
                if (Directory.Exists(path)) throw new IOException("目标文件名已被文件夹占用：" + name);
                if (File.Exists(path)) using (var file = File.Open(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
            }
        }
        private static void Register(InstallContext context) {
            using (var key = Registry.CurrentUser.CreateSubKey(context.HostKey)) key.SetValue("", Inside(context.Root, HostManifest));
            using (var key = Registry.CurrentUser.CreateSubKey(context.UninstallKey)) {
                string setup = Inside(context.Root, "Setup.exe");
                key.SetValue("DisplayName", "Edge 多线程下载");
                key.SetValue("DisplayVersion", Version);
                key.SetValue("Publisher", "EdgeParallel contributors");
                key.SetValue("InstallLocation", context.Root);
                key.SetValue("DisplayIcon", setup);
                key.SetValue("UninstallString", "\"" + setup + "\" /uninstall");
                key.SetValue("ModifyPath", "\"" + setup + "\"");
                key.SetValue("NoModify", 0, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 0, RegistryValueKind.DWord);
            }
        }
        internal static void Install(InstallContext context, Stream payload) {
            NoLinks(context.Root);
            CheckBusy(context);
            string parent = Path.GetDirectoryName(Path.GetFullPath(context.Root));
            Directory.CreateDirectory(parent);
            string stage = Path.Combine(parent, ".EdgeParallel-stage-" + Guid.NewGuid().ToString("N"));
            string backup = Path.Combine(parent, ".EdgeParallel-backup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(stage);
            bool canCleanBackup = true;
            try {
                HashSet<string> incoming = Extract(payload, stage);
                WriteManifest(stage, context.Root);
                incoming.Add(HostManifest);
                File.Copy(context.SourceExe, Inside(stage, "Setup.exe"));
                incoming.Add("Setup.exe");
                incoming.Add(Marker);
                File.WriteAllText(Inside(stage, Marker), Json.Serialize(new OwnedFiles { Product = "EdgeParallel", Version = Version, Files = incoming.ToArray() }), new UTF8Encoding(false));
                HashSet<string> owned = ReadOwned(context.Root);
                foreach (string name in incoming) {
                    string target = Inside(context.Root, name);
                    if (File.Exists(target) && !owned.Contains(name)) throw new IOException("目标目录已有非本安装程序管理的文件，请先保留或重命名该目录：" + context.Root);
                }
                var touched = new HashSet<string>(owned, StringComparer.OrdinalIgnoreCase);
                touched.UnionWith(incoming);
                CheckBusy(context);
                CheckWritable(context.Root, touched);
                var nativeBefore = RegistrySnapshot.Capture(context.HostKey);
                var uninstallBefore = RegistrySnapshot.Capture(context.UninstallKey);
                var moved = new List<string>();
                var installed = new List<string>();
                Directory.CreateDirectory(backup);
                try {
                    foreach (string name in touched) {
                        string target = Inside(context.Root, name);
                        if (!File.Exists(target)) continue;
                        string saved = Inside(backup, name);
                        Directory.CreateDirectory(Path.GetDirectoryName(saved));
                        File.Move(target, saved);
                        moved.Add(name);
                    }
                    foreach (string name in incoming) {
                        string target = Inside(context.Root, name);
                        NoLinks(target);
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        File.Move(Inside(stage, name), target);
                        installed.Add(name);
                    }
                    if (context.Checkpoint != null) context.Checkpoint("files-installed");
                    Register(context);
                    if (context.Checkpoint != null) context.Checkpoint("registered");
                } catch {
                    try {
                        foreach (string name in installed) { string path = Inside(context.Root, name); NoLinks(path); File.Delete(path); }
                        foreach (string name in moved) File.Move(Inside(backup, name), Inside(context.Root, name));
                        nativeBefore.Restore(context.HostKey);
                        uninstallBefore.Restore(context.UninstallKey);
                    } catch (Exception rollback) {
                        canCleanBackup = false;
                        throw new IOException("恢复原安装时发生错误，原文件备份已保留：" + backup, rollback);
                    }
                    throw;
                }
            } finally {
                SafeRemoveTree(stage);
                if (canCleanBackup) SafeRemoveTree(backup);
            }
        }
        internal static void Uninstall(InstallContext context) {
            NoLinks(context.Root);
            CheckBusy(context);
            HashSet<string> owned = ReadOwned(context.Root);
            if (owned.Count == 0) throw new IOException("未找到由本安装程序管理的安装，无需卸载。");
            CheckWritable(context.Root, owned);
            string backup = Path.Combine(Path.GetDirectoryName(context.Root), ".EdgeParallel-uninstall-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(backup);
            var moved = new List<string>();
            var nativeBefore = RegistrySnapshot.Capture(context.HostKey);
            var uninstallBefore = RegistrySnapshot.Capture(context.UninstallKey);
            bool finished = false;
            try {
                foreach (string name in owned) {
                    string source = Inside(context.Root, name);
                    if (!File.Exists(source)) continue;
                    string target = Inside(backup, name);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    File.Move(source, target);
                    moved.Add(name);
                }
                using (var key = Registry.CurrentUser.OpenSubKey(context.HostKey)) {
                    if (key != null && String.Equals(key.GetValue("") as string, Inside(context.Root, HostManifest), StringComparison.OrdinalIgnoreCase))
                        Registry.CurrentUser.DeleteSubKeyTree(context.HostKey, false);
                }
                using (var key = Registry.CurrentUser.OpenSubKey(context.UninstallKey)) {
                    if (key != null && String.Equals(key.GetValue("InstallLocation") as string, context.Root, StringComparison.OrdinalIgnoreCase))
                        Registry.CurrentUser.DeleteSubKeyTree(context.UninstallKey, false);
                }
                if (context.Checkpoint != null) context.Checkpoint("unregistered");
                finished = true;
            } finally {
                if (!finished) {
                    foreach (string name in moved) File.Move(Inside(backup, name), Inside(context.Root, name));
                    nativeBefore.Restore(context.HostKey);
                    uninstallBefore.Restore(context.UninstallKey);
                }
                SafeRemoveTree(backup);
            }
            // Only now remove empty directories. Unlisted files (including downloads) remain.
            foreach (string directory in owned.Select(name => Path.GetDirectoryName(Inside(context.Root, name))).Distinct().OrderByDescending(name => name.Length))
                RemoveEmptyParents(directory, context.Root);
            RemoveEmptyParents(context.Root, context.Root);
        }
        private static void RemoveEmptyParents(string directory, string root) {
            string limit = Path.GetFullPath(root);
            for (string current = directory; current != null && (current.Equals(limit, StringComparison.OrdinalIgnoreCase) || current.StartsWith(limit + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)); current = Path.GetDirectoryName(current)) {
                NoLinks(current);
                if (!Directory.Exists(current) || Directory.EnumerateFileSystemEntries(current).Any()) break;
                Directory.Delete(current);
            }
        }
        internal static void SafeRemoveTree(string root) {
            if (!Directory.Exists(root)) return;
            NoLinks(root);
            foreach (string entry in Directory.EnumerateFileSystemEntries(root)) {
                NoLinks(entry);
                if (Directory.Exists(entry)) SafeRemoveTree(entry); else File.Delete(entry);
            }
            Directory.Delete(root);
        }
        private static bool ActiveHelper(InstallContext context) {
            foreach (var process in Process.GetProcessesByName("EdgeParallelHost")) { process.Dispose(); return true; }
            string prefix = Path.GetFullPath(context.Root).TrimEnd('\\') + "\\";
            foreach (var process in Process.GetProcessesByName("node")) {
                using (process) {
                    try { if (process.MainModule.FileName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true; }
                    catch (System.ComponentModel.Win32Exception) { }
                    catch (InvalidOperationException) { }
                }
            }
            return false;
        }
    }
}
