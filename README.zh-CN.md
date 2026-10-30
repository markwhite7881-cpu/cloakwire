<div align="center">

<img src="src-tauri/icons/icon.png" alt="Cloakwire Logo" width="112" />

# Cloakwire

**基于 sing-box 和 Xray 双内核的跨平台桌面与移动端代理客户端。**

Windows · macOS · Android · Rust/Tauri & React · VLESS Reality · Hysteria 2 · TUIC · 零遥测 · 完全开源

<br/>

[![Release](https://img.shields.io/github/v/release/markwhite7881-cpu/cloakwire?style=for-the-badge&color=10b981)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/markwhite7881-cpu/cloakwire/total?style=for-the-badge&color=3b82f6)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Android-blueviolet?style=for-the-badge)](https://github.com/markwhite7881-cpu/cloakwire/releases/latest)
[![License](https://img.shields.io/github/license/markwhite7881-cpu/cloakwire?style=for-the-badge&color=64748b)](LICENSE)

<br/>

**[ 🇬🇧 English ](README.md)** &nbsp;|&nbsp; **[ 🇷🇺 Русский ](README.ru.md)** &nbsp;|&nbsp; **[ 🇨🇳 简体中文 ](README.zh-CN.md)**

<br/>

<img src="screenshots/hero-showcase.png" alt="Cloakwire 界面展示" width="100%" />

</div>

---

## ⚡ 安装包下载 (v1.4.9)

| 平台 | 安装程序 | 备用格式 | 架构 |
|---|---|---|---|
| **Windows** | [下载 .exe](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_x64-setup.exe) | [下载 .msi](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_x64_en-US.msi) | x64 (Intel / AMD) |
| **macOS Apple Silicon** | [下载 .dmg](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_aarch64.dmg) | [下载 .app.zip](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_aarch64.app.zip) | arm64 (Apple Silicon) |
| **macOS Intel** | [下载 .dmg](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_x64.dmg) | [下载 .app.zip](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_x64.app.zip) | x86_64 |
| **Android** | [下载 .apk](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/Cloakwire_1.4.9_arm64-v8a.apk) | — | arm64-v8a · Android 7.0+ |

> 🔒 全部七个发布包（包括 Android）均提供 **Minisign** `.sig` 签名。SHA-256 校验和见 [`SHA256SUMS.txt`](https://github.com/markwhite7881-cpu/cloakwire/releases/download/v1.4.9/SHA256SUMS.txt).

## 🚀 1.4.9 更新内容

- Windows、macOS 和 Android 会在连接前使用对应内核检查订阅提供的完整配置。
- 配置错误会显示明确原因、处理建议和可复制的安全报告，不包含提供商配置。
- 无效配置会在替换当前连接前被拒绝；取消检查不会启动 VPN。
- 发布验证涵盖全部安装包、更新签名、校验和及 Android GeoIP 数据。
- 桌面端、Android 界面与诊断报告统一使用同步后的应用版本。

[完整更新历史](CHANGELOG.md) · [v1.4.9](https://github.com/markwhite7881-cpu/cloakwire/releases/tag/v1.4.9)

## 快速上手

Cloakwire 是客户端。使用前需要自备服务器或提供商订阅。

1. 从上表下载适合操作系统的安装包并安装。
2. 添加节点或订阅。支持连接链接、Base64 链接列表、Clash 订阅及完整的 sing-box/Xray 配置。
3. 选择节点或配置并连接。完整配置会在替换当前连接前接受检查；检查失败时，请按照错误卡片中的建议操作。

## 🌟 核心特性

### 双内核与订阅

- 默认使用 **sing-box**；**Xray** 用于兼容的 Xray 配置。
- 完整配置使用其对应内核，检查错误会在连接前显示。
- 支持单独链接导入、订阅管理和提供商配置更新。

### 路由与连接模式

- 支持 TUN 和桌面系统代理模式；可按应用、域名和 IP 设置规则，包括 GeoIP / Bypass RU。
- 应用本地 GeoIP / Bypass RU 规则时，完整 sing-box 配置会保留提供商的 DNS 和路由设置。
- 指定应用可通过 VPN 或直接连接。功能取决于平台和内核；不受支持的 Xray 应用规则会显示警告。
- macOS 上的 TUN 在需要时请求管理员授权。已准备的内核文件可复用授权；更换内核文件后可能需要重新确认。

### 桌面与 Android

- 桌面端支持系统托盘、快捷连接操作、会话计时和流量统计。
- Android VPN 服务、显示连接状态的桌面小组件及剪贴板导入。
- 内置速度测试和桌面连接通知。

### 外观与语言

- 支持跟随系统、浅色、深色和 OLED 主题；提供 Emerald、Cyan、Violet、Amber 和 Rose 五种强调色。
- 内置简体中文、英语和俄语，可在设置中切换。

## 🛡️ 隐私与发布验证

- 不包含内置遥测、分析统计或自动崩溃报告上传。
- 配置、订阅和凭据在本地应用数据目录中处理和保存。
- DNS 行为取决于所选设置及提供商配置；完整配置会保留提供商的 DNS 设置。
- 更新机制使用应用内置的公钥验证发布文件签名。

Minisign 用于保护更新下载。Windows 安装包未使用 Authenticode 签名；macOS 应用使用 ad hoc 签名，未经 Apple 公证，因此操作系统可能显示安全提示。安装前请将文件与发布的校验和进行比对。

示例：计算 Windows 安装程序的哈希，并与 `SHA256SUMS.txt` 比较：

```powershell
(Get-FileHash Cloakwire_1.4.9_x64-setup.exe -Algorithm SHA256).Hash.ToLowerInvariant()
```

## 🔧 连接链接格式

| 协议 | 链接方案 | 兼容内核 |
|---|---|---|
| VLESS | `vless://` | sing-box / Xray |
| VMess | `vmess://` | sing-box / Xray |
| Trojan | `trojan://` | sing-box / Xray |
| Shadowsocks | `ss://` | sing-box / Xray |
| Hysteria 2 | `hy2://` / `hysteria2://` | sing-box |
| TUIC | `tuic://` | sing-box |

传输方式和路由功能取决于内核及配置。连接前会使用内核的原生格式检查完整配置。

## 🛠️ 从源码构建

### 工具链

- Node.js 和 npm；1.4.9 发布版在 Windows 上使用 Node.js 24，在 macOS 上使用 Node.js 22 构建。
- Rust stable，并安装所需平台的编译目标。
- Windows：Visual Studio C++ 生成工具和 WebView2 运行时；Tauri 使用 NSIS/WiX 打包安装程序。
- macOS：Xcode 命令行工具；构建两种架构时需安装 `aarch64-apple-darwin` 和 `x86_64-apple-darwin` Rust 目标。
- Android：JDK 17、Android SDK platform 36 和 build-tools、NDK `28.0.13004108`，以及 Rust 目标 `aarch64-linux-android`。使用仓库自带的 Gradle wrapper。

### 二进制依赖

新克隆的仓库不包含大型内核文件、Android 库或地理数据。构建原生应用前请准备：

- `src-tauri/binaries/`：带目标平台后缀的 `sing-box` 和 `xray` 可执行文件；当前打包配置还需要 `wintun.dll`。
- Android：`src-tauri/gen/android/` 下的 `app/libs/libbox.aar`，以及 `app/src/main/jniLibs/arm64-v8a/libxray.so` 和 `libhev-socks5-tunnel.so`。
- Android：将 `geoip.dat` 和 `geosite.dat` 放入 `src-tauri/gen/android/app/src/main/assets/`。发布脚本会从源码编译 Rust 库。

内核准备步骤见 [Xray 脚本](scripts/prepare-xray-sidecar.ps1)、[Android 构建工作流](.github/workflows/release-android.yml)和 [macOS 构建工作流](.github/workflows/release-macos.yml)。

仓库内的 `src-tauri/.cargo/config.toml` 含有特定 Windows 主机的路径，请根据本机环境修改或覆盖。完整发布脚本从本地配置读取路径，并在 Mac 构建主机上移除这份 Windows 专用配置。

### 前端检查

以下命令仅检查和构建界面，不编译原生应用：

```bash
git clone https://github.com/markwhite7881-cpu/cloakwire.git
cd cloakwire
npm ci
npm test
npm run build
```

准备好工具链和二进制依赖后，使用 `npm run tauri:dev` 开发桌面应用，使用 `npm run tauri:build` 构建桌面发布包。

### 完整跨平台发布

完整发布脚本运行于 Windows，通过 SSH 在远程 Mac 上构建 macOS 版本。将 `scripts/release.local.example.psd1` 复制为 Git 忽略的 `release.local.psd1`，填写工具链、内核、签名和 Mac 主机路径。`BuildRoot` 路径必须仅包含 ASCII 字符；不要将私钥或密码提交到 Git。

主版本号位于 `src-tauri/tauri.conf.json`。提交新版本前，使用 `npm run release:version -- set <version>` 同步包、Rust 和 Android 元数据。

构建独立签名工具，然后将 `SignerPath` 设置为 `.release-work/tools/release/tauri-signer.exe`：

```powershell
cargo build --release --manifest-path src-tauri/crates/tauri-signer/Cargo.toml --target-dir .release-work/tools
```

```powershell
Copy-Item scripts/release.local.example.psd1 release.local.psd1
# 继续前请在 release.local.psd1 中填写本机路径。
npm run release:check
npm run release:test
npm run release:build -- -CheckOnly
npm run release:build
```

运行 `release:build` 前，请先提交已检查的源码和版本说明：所有平台均从同一份干净的 HEAD 归档构建。每次构建使用独立的源码、编译、安装包和日志目录。脚本会签名并验证七个发布包；发布时先创建草稿并核对全部 18 个上传文件的哈希。在推送对应 Git 标签后，使用 `npm run release:publish -- -DistPath <artifacts> -Publish` 明确发布已验证的草稿。

[详细发布指南（俄语）](docs/RELEASE_WORKFLOW.md)

## 📄 许可证

Cloakwire 应用源码采用 **MIT License**；详见 [LICENSE](LICENSE)。捆绑的内核及第三方库保留各自的许可证。
