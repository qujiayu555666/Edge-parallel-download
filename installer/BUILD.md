# Installer Build Contract

Target: C# 5 and .NET Framework 4.8, Windows GUI subsystem, x64.

Compile `Setup.cs`, `InstallerCore.cs`, and `SelfTests.cs` together, referencing:

- `System.Windows.Forms.dll`
- `System.Drawing.dll`
- `System.IO.Compression.dll`
- `System.IO.Compression.FileSystem.dll`
- `System.Web.Extensions.dll`

Embed the release ZIP with `/resource:<absolute-payload-path>,EdgeParallel.Payload.zip`.
Use `/target:winexe /optimize+ /win32manifest:installer/app.manifest /out:<absolute-output-path>`. The compiler is
`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`.

The ZIP root contains `extension/`, `host/`, `runtime/`, `LICENSE`, and
`THIRD_PARTY_NOTICES.md`. `README.md`, `PRIVACY.md`, `CHANGELOG.md`, and `docs/` are optional.
`runtime/LICENSE.txt` must accompany `runtime/node.exe`. Do not include an
outer package directory, `Setup.exe`, or `.edgeparallel-install.json` in the ZIP.

Run `Setup.exe /self-test <absolute-report-path>` and wait for the exit code.
Exit 0 means all tests passed; failures use exit 1 and record an exception in the
report. Tests use a unique temporary install directory and only the isolated
`HKCU\Software\EdgeParallelTests\<random-id>` registry namespace. An embedded
payload, when present, is also installed/uninstalled within this test directory.

Without switches the installer opens the maintenance GUI. `/uninstall` opens
that GUI and requests uninstall confirmation. Installation is per-user and
requires no elevation, command shell, browser policy, or startup service.

Build verification in the workspace sandbox: C# compilation passes. The local
self-test is currently blocked by Windows denying access to the isolated test
registry key. A normal Windows user session can run `/self-test`; it does not
touch the production NativeMessagingHosts or uninstall registry keys.
