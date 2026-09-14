# 构建与 GitHub 发布

## 源码结构

- `extension/`：Manifest V3 扩展、面板与下载接管逻辑。
- `host/`：本地桥接服务、分段下载引擎及无窗口启动器。
- `installer/`：图形安装器、安装与卸载逻辑。
- `tests/`、`host/*.test.mjs`：下载、接管、文件名与临时文件回归测试。
- `scripts/build.ps1`：Windows 安装器构建入口。

## 构建

构建需要 Windows x64、PowerShell 5.1 或更新版本，以及 .NET Framework 4.8。在仓库根目录运行：

```powershell
.\scripts\build.ps1
```

构建脚本负责准备 Node.js **24.18.0** x64 运行时、校验其散列、执行回归测试、构建本地启动器和图形安装器，并打包所需扩展文件与许可声明。产物位于 `dist/`。首次构建需要能够访问 Node.js 官方下载源；普通用户安装发行版时无需另行下载运行时。

离线构建可用 `-RuntimeDirectory` 指定包含官方 `node.exe` 的目录，脚本仍会核对 `scripts/runtime-lock.json` 中的散列。许可声明已保存在 `third_party/node/LICENSE.txt`，构建时一并校验：

```powershell
.\scripts\build.ps1 -RuntimeDirectory C:\BuildDependencies\node-24.18.0
```

源码测试需要 Node.js 24 或更新版本。安装 Node.js 后可从仓库根目录运行（未构建时跳过 Windows 启动器测试；完整构建会编译并验证启动器）：

```powershell
npm test
```

发布前应确认测试通过，并在 Windows Edge 中完成安装、加载扩展、公开文件自动接管、取消、完成、更新及卸载检查。本地模拟测试不能代替真实浏览器验证。

## 发布产物

0.2.0 的用户安装包名称为：

`EdgeParallel-0.2.0-win-x64-setup.exe`

安装器是带图形界面的单文件程序，捆绑运行时。安装后向导会提供扩展路径与扩展管理页入口。Windows 应用列表使用同一安装器的 `/uninstall` 模式卸载当前用户安装。安装器目前没有代码签名。

构建还会生成干净的 `EdgeParallel-0.2.0-source.zip`、`SHA256SUMS` 和安装器测试报告。仓库中的 GitHub Actions 会在推送、拉取请求或手动触发时运行构建并保存产物，不会自动公开发布 Release。

## 上传 GitHub

1. 将源码、测试、构建脚本和文档提交到自己的 GitHub 仓库。不要提交构建目录、运行时下载、已安装主机清单或个人配置。
2. 为经过验证的提交创建版本标签 `v0.2.0`。
3. 基于该标签创建 GitHub Release，正文可参考 [CHANGELOG](../CHANGELOG.md)，并写明实际验证环境与已知限制。
4. 上传 `EdgeParallel-0.2.0-win-x64-setup.exe` 和包含它校验值的 `SHA256SUMS`。

不要将安装器作为普通源码文件上传。源码会由 GitHub 提供归档下载，用户安装使用 Releases 附件。README 不预设发布地址；仓库创建和版本发布完成后，可按实际地址添加下载链接。

发布者应核对 `SHA256SUMS` 与最终上传的安装器一致。可用 PowerShell 检查：

```powershell
Get-FileHash .\EdgeParallel-0.2.0-win-x64-setup.exe -Algorithm SHA256
```

如后续进行代码签名，应在签名完成后重新计算校验值。SHA-256 用于确认文件一致性，不代替发布者身份验证。
