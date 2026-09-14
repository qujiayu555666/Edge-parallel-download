using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using Microsoft.Win32;

namespace EdgeParallelInstaller {
    internal static class SelfTests {
        private const string Key = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApJpEgZDt3yRK9poMbCClDWrQT/BKFriFC1h5s3JRSLGeHwr4IDlinE6Ut6VvfZ/VHyDZUsvF6Ml09PWhrDIMFGErgLVCcRxad2hw9NEuvgBKLH2oaexYlj6IIkPPi1MixnLwRUXCcnY18PII4cJ/jiDv1DM8N9GaXNgGjRZC32/NpLjM9qGc+f07hq4P73Xp/6R20fWk271M/b4fB3cFTRAWPqen6SxiljHNQDxa2FTmchE9GFBvUR+/s0+LaUx4WJJFOxYUmUMfJlNA3JPV7HPnba3sQl3g3vro14xPileQX1D/tZ1oASBoA8pV68Xhl8S0BW16KLxszKv2KJU9SQIDAQAB";
        private static void Check(bool condition, string message) { if (!condition) throw new Exception("FAIL: " + message); }
        private static void Reject(Action action, string message) {
            bool rejected = false;
            try { action(); } catch (IOException) { rejected = true; } catch (InvalidDataException) { rejected = true; }
            Check(rejected, message);
        }
        private static Stream Fixture(string version, string unsafeName) {
            var stream = new MemoryStream();
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, true)) {
                var files = new Dictionary<string, string> {
                    { "extension/manifest.json", "{\"key\":\"" + Key + "\",\"version\":\"0.2.0\"}" },
                    { "host/EdgeParallelHost.exe", "host-fixture" }, { "host/main.mjs", version },
                    { "host/bridge.mjs", "bridge" }, { "host/engine.mjs", "engine" },
                    { "runtime/node.exe", "runtime-fixture" }, { "runtime/LICENSE.txt", "runtime-license" },
                    { "LICENSE", "license" }, { "THIRD_PARTY_NOTICES.md", "notices" }
                };
                if (unsafeName != null) files.Add(unsafeName, "unsafe");
                foreach (var file in files) using (var writer = new StreamWriter(zip.CreateEntry(file.Key).Open(), new UTF8Encoding(false))) writer.Write(file.Value);
            }
            stream.Position = 0;
            return stream;
        }
        private static void Install(InstallContext context, string version) { using (Stream zip = Fixture(version, null)) InstallerCore.Install(context, zip); }
        private static string Registered(string key) { using (var entry = Registry.CurrentUser.OpenSubKey(key)) return entry == null ? null : entry.GetValue("") as string; }
        internal static string Run(string sourceExe) {
            string token = Guid.NewGuid().ToString("N");
            string root = Path.Combine(Path.GetTempPath(), "EdgeParallel-InstallerTest-" + token);
            string registry = @"Software\EdgeParallelTests\" + token;
            var report = new StringBuilder();
            var context = new InstallContext {
                Root = Path.Combine(root, "Install"), SourceExe = sourceExe,
                HostKey = registry + @"\NativeHost", UninstallKey = registry + @"\Uninstall", IsBusy = delegate { return false; }
            };
            Directory.CreateDirectory(root);
            try {
                Check(InstallerCore.ExtensionFromKey(Key) == InstallerCore.ExtensionId, "fixed extension ID");
                report.AppendLine("PASS: extension identity remains unchanged");
                using (var existing = Registry.CurrentUser.CreateSubKey(context.HostKey)) existing.SetValue("", "external-old-install.json");
                string oldDirectory = Path.Combine(root, "ExternalOldInstall");
                Directory.CreateDirectory(oldDirectory); File.WriteAllText(Path.Combine(oldDirectory, "keep.txt"), "keep");
                Install(context, "version-one");
                string manifest = Path.Combine(context.Root, "host", "com.edgeparallel.bridge.json");
                Check(Registered(context.HostKey) == manifest, "native host path registration");
                Check(File.ReadAllText(manifest).Contains(InstallerCore.ExtensionId), "native host origin");
                Check(File.Exists(Path.Combine(context.Root, "Setup.exe")), "installed maintenance executable");
                using (var uninstall = Registry.CurrentUser.OpenSubKey(context.UninstallKey)) Check(uninstall != null && ((string)uninstall.GetValue("UninstallString")).Contains("/uninstall"), "Windows uninstall entry");
                Check(File.Exists(Path.Combine(oldDirectory, "keep.txt")), "external old directory preserved");
                report.AppendLine("PASS: installation, origin, manifest, maintenance executable, Windows registration");
                File.WriteAllText(Path.Combine(context.Root, "personal-download.zip"), "personal");
                Install(context, "version-two");
                Check(File.ReadAllText(Path.Combine(context.Root, "host", "main.mjs")) == "version-two", "update writes new payload");
                Check(File.ReadAllText(Path.Combine(context.Root, "personal-download.zip")) == "personal", "update preserves personal files");
                report.AppendLine("PASS: update preserves unrelated files and old external installation");
                foreach (string failureAt in new[] { "files-installed", "registered" }) {
                    context.Checkpoint = delegate(string checkpoint) { if (checkpoint == failureAt) throw new IOException("injected failure"); };
                    Reject(delegate { Install(context, "must-rollback"); }, "injected installation failure");
                    Check(File.ReadAllText(Path.Combine(context.Root, "host", "main.mjs")) == "version-two", "rollback restores old bytes");
                    Check(Registered(context.HostKey) == manifest, "rollback restores registration");
                    context.Checkpoint = null;
                }
                report.AppendLine("PASS: file and registration failure rollback");
                context.IsBusy = delegate { return true; };
                Reject(delegate { Install(context, "busy"); }, "active helper blocks update");
                Reject(delegate { InstallerCore.Uninstall(context); }, "active helper blocks uninstall");
                context.IsBusy = delegate { return false; };
                using (var locked = File.Open(Path.Combine(context.Root, "host", "main.mjs"), FileMode.Open, FileAccess.Read, FileShare.None))
                    Reject(delegate { Install(context, "locked"); }, "locked files block update");
                Check(File.ReadAllText(Path.Combine(context.Root, "host", "main.mjs")) == "version-two", "busy checks leave original files intact");
                report.AppendLine("PASS: active helpers and locked files are never interrupted");
                foreach (string unsafeName in new[] { "../escape.txt", "host/../../escape.txt", "C:/escape.txt", "host/NUL", "host/file.mjs.", "host/stream:ads", "Setup.exe", "unexpected.txt" }) {
                    using (Stream zip = Fixture("unsafe", unsafeName)) Reject(delegate { InstallerCore.Install(context, zip); }, "unsafe ZIP rejected: " + unsafeName);
                }
                Check(!File.Exists(Path.Combine(root, "escape.txt")), "ZIP traversal cannot escape");
                report.AppendLine("PASS: path traversal, alternate streams, reserved names, duplicate ownership are rejected");
                context.Checkpoint = delegate(string checkpoint) { if (checkpoint == "unregistered") throw new IOException("injected uninstall failure"); };
                Reject(delegate { InstallerCore.Uninstall(context); }, "uninstall rollback triggered");
                context.Checkpoint = null;
                Check(File.ReadAllText(Path.Combine(context.Root, "host", "main.mjs")) == "version-two", "uninstall rollback restores files");
                Check(Registered(context.HostKey) == manifest, "uninstall rollback restores registration");
                report.AppendLine("PASS: failed uninstall rolls back files and registration");
                InstallerCore.Uninstall(context);
                Check(!File.Exists(Path.Combine(context.Root, "host", "main.mjs")), "owned files removed");
                Check(File.Exists(Path.Combine(context.Root, "personal-download.zip")), "uninstall leaves personal file");
                Check(Registered(context.HostKey) == null, "native host removed");
                using (var uninstall = Registry.CurrentUser.OpenSubKey(context.UninstallKey)) Check(uninstall == null, "uninstall entry removed");
                report.AppendLine("PASS: uninstall removes only owned files and matching registration");
                Install(context, "version-three");
                using (var external = Registry.CurrentUser.CreateSubKey(context.HostKey)) external.SetValue("", "another-external-install.json");
                InstallerCore.Uninstall(context);
                Check(Registered(context.HostKey) == "another-external-install.json", "uninstall preserves newer external registration");
                report.AppendLine("PASS: registration owned by another installation is preserved");
                using (Stream embedded = Assembly.GetExecutingAssembly().GetManifestResourceStream(Program.PayloadResource)) {
                    if (embedded != null) {
                        InstallerCore.Install(context, embedded);
                        Check(File.Exists(Path.Combine(context.Root, "runtime", "node.exe")), "embedded runtime installed");
                        InstallerCore.Uninstall(context);
                        report.AppendLine("PASS: actual embedded release payload installation and uninstall");
                    }
                }
                report.AppendLine("All installer self-tests passed. Production installation and registry were not modified.");
                return report.ToString();
            } finally {
                Registry.CurrentUser.DeleteSubKeyTree(registry, false);
                InstallerCore.SafeRemoveTree(root);
            }
        }
    }
}
