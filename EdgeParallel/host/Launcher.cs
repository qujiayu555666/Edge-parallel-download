using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

internal static class Launcher {
    private static void Pump(Stream source, Stream destination) {
        byte[] buffer = new byte[8192];
        int length;
        while ((length = source.Read(buffer, 0, buffer.Length)) > 0) {
            destination.Write(buffer, 0, length);
            destination.Flush();
        }
    }
    [STAThread]
    private static int Main(string[] args) {
        const string origin = "chrome-extension://jcpnknmnbonffkcmnficeijhojknegbm/";
        if (args.Length < 1 || args[0] != origin) return 2;
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            var start = new ProcessStartInfo {
                FileName = Path.GetFullPath(Path.Combine(root, "..", "runtime", "node.exe")),
                Arguments = "\"" + Path.Combine(root, "main.mjs") + "\" " + origin,
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var child = Process.Start(start)) {
                Task input = Task.Factory.StartNew(() => Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream)).ContinueWith(t => {
                    try { child.StandardInput.Close(); } catch { }
                });
                Task output = Task.Factory.StartNew(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
                Task errors = child.StandardError.BaseStream.CopyToAsync(Stream.Null);
                child.WaitForExit();
                output.Wait();
                return child.ExitCode;
            }
        } catch { return 1; }
    }
}
