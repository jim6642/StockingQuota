# StockingQuota V1.0 — AI Agent 全自动安装与验收指南 (`AGENT_INSTALL.md`)

本文件专为 **AI 编程 Agent**（OpenAI Codex / Google Antigravity / DeepSeek Harness / Claude Code）编写。  
用户只需对任意 Agent 说：
> **“请阅读这个仓库里的 `AGENT_INSTALL.md`，帮我把 StockingQuota 编译安装到这台 Windows 电脑并验收。”**

---

## 一、环境前置检查（Windows 10 1903+ / Windows 11 x64）

1. 检查 Node.js（>= 18）与 npm：
   ```powershell
   node -v; npm -v
   ```
2. 检查 `.NET Framework 4.x` 编译器（Windows 10/11 自带，用于构建 0 黑框原生辅助进程）：
   ```powershell
   Test-Path "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
   ```
3. **PowerShell 5.1 语法注意**：不要使用 `&&`，请使用 `;` 分隔命令。修改任何 JSON 文件禁止写入 UTF-8 BOM。

---

## 二、编译原生辅助二进制（`/target:winexe`，彻底无黑框）

```powershell
$fx = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319"
New-Item -ItemType Directory -Force -Path "vendor\win-tracker","vendor\win-sentinel","vendor\win-exec" | Out-Null

# 1. 前台窗口与 UIA 按钮追踪器（支持 Antigravity 切模型按钮 + Codex 额度圆环缓存追踪）
& "$fx\csc.exe" /nologo /optimize+ /target:winexe `
  /r:"$fx\WPF\WindowsBase.dll" `
  /r:"$fx\WPF\UIAutomationClient.dll" `
  /r:"$fx\WPF\UIAutomationTypes.dll" `
  /out:"vendor\win-tracker\sq-wintracker.exe" "scripts\winTracker.cs"

# 2. ~4.6MB 极轻随 Agent 自动唤醒哨兵
& "$fx\csc.exe" /nologo /optimize+ /target:winexe `
  /out:"vendor\win-sentinel\sq-sentinel.exe" "scripts\sentinel.cs"

# 3. 9KB ConPTY 无黑框命令行执行器（杜绝 Win11 下子/孙进程刷新额度时弹黑框）
& "$fx\csc.exe" /nologo /optimize+ /target:winexe `
  /out:"vendor\win-exec\sq-silent-exec.exe" "scripts\silentExec.cs"
```

---

## 三、安装依赖并打包 Windows 程序

1. 安装依赖：
   ```powershell
   npm install
   ```
2. 如在中国大陆网络环境，建议先配置国内 Electron 镜像再打包：
   ```powershell
   $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
   $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

   # 一键安装包（推荐给普通用户双击安装）
   npm run package:installer

   # 或免安装绿色目录 / 单文件便携版
   npm run package:win
   npm run package:portable
   ```
3. 产物位置：
   - 一键安装包：`release\StockingQuota-Setup-1.0.0.exe`（免管理员权限，装完自动启动）
   - 单文件便携版：`release\StockingQuota-1.0.0-Portable.exe`
   - 免解压目录：`release\win-unpacked\StockingQuota.exe`

---

## 四、首次启动的零人工全自动行为（无需额外跑脚本）

用户双击运行安装好的 `StockingQuota.exe` 后，程序会自动完成以下初始化，**Agent 无需再手动修改 DSH 或注册表**：
1. **自动检测本机已安装的 Agent**（Codex / Antigravity / DSH），设置界面仅展示本机拥有的 Agent。
2. **自动配置 DSH 蓝丝插件**：若检测到 `~/.dsh`，主进程用纯 Node.js（严格无 BOM UTF-8 + 写入前 `JSON.parse` 校验 + 首次自动备份原 `package.json`）将内置 `dsh-stocking-quota-bridge` 自动安装并注册到 `~/.dsh/profiles/desktop` 与 `web`；**不修改 DSH 安装目录**。用户只需重启一次 DSH 即可实时同步蓝丝。
3. **自动激活 3MB 极轻哨兵（`sq-sentinel.exe`）**：平时不跑 Electron；每当打开 Codex / Antigravity / DSH 时自动静默拉起 `StockingQuota.exe`，全部关闭 30 秒后自动释放 Electron 内存。用户可在 `Ctrl+Alt+S` 设置面板随时关闭。

---

## 五、端到端验收清单

启动 `StockingQuota.exe` 后可执行以下只读核验：
```powershell
# 1. 校验本机回环指标接口（绝不把失败伪装成 0% 或 100%）
Invoke-RestMethod http://127.0.0.1:17821/metrics | ConvertTo-Json -Depth 6

# 2. 若本机装有 DSH，校验 profile package.json 无 UTF-8 BOM 且 JSON 合法
node -e "const fs=require('fs'),p=require('path'); for(const prof of ['desktop','web']){ const f=p.join(process.env.USERPROFILE,'.dsh','profiles',prof,'package.json'); if(!fs.existsSync(f)) continue; const b=fs.readFileSync(f); if(b[0]===0xEF) throw new Error('BOM'); JSON.parse(b.toString('utf8')); console.log('OK_NO_BOM:', prof); }"
```
- 验收快捷键 **`Ctrl + Alt + S`** 可随时在隐身无托盘状态下呼出设置面板；
- 验收丝袜隐藏收起时 GPU 占用降至 **0%**（PixiJS 渲染循环已自动暂停）。
