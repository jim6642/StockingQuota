# StockingQuota V1.0 — Windows 透明桌面 AI 额度丝袜悬浮组件

以日系二次元哑光天鹅绒丝袜、WebGL 实时光学褶皱着色、240Hz 弹性物理与双手拉扯/遮挡交互为核心的 **Windows 透明无边框悬浮组件**，原生同步 **OpenAI Codex（白丝）**、**Google Antigravity（紫丝）** 与 **DeepSeek Harness / DSH（蓝丝）** 的真实额度或上下文容量。

---

## 一、新用户两种一键上手方式

### 方式 1：普通用户一键安装（推荐）
直接下载并双击以下任意一个产物即可，**全程免管理员权限、无命令行黑框、无需手动跑任何脚本**：
- **一键安装包**：`release/StockingQuota-Setup-1.0.0.exe`（3 秒安装完成并自动启动）
- **单文件便携版**：`release/StockingQuota-1.0.0-Portable.exe`（免安装随拷随走）

首次运行后程序会自动完成全部配置：
1. **自动检测本机 Agent**：设置界面只显示你电脑上实际安装的 Agent（外加离线模拟调试模式）。
2. **自动配置 DSH 蓝丝插件**：如果检测到你装了 DeepSeek Harness，程序会自动以严格无 BOM 的 UTF-8 安装桥接插件（零修改 DSH 安装目录，并在首次写入前自动备份原配置），重启一次 DSH 即可实时同步蓝丝。
3. **自动启用 3MB 极轻哨兵（`sq-sentinel.exe`）**：平时不驻留 Electron，当你打开 Codex / Antigravity / DSH 时自动静默拉起丝袜；三个软件全部关闭后自动释放 Electron 内存。随时可在设置中一键关闭。
4. **默认隐身无托盘图标**：任务栏和托盘都不占位置，任何时候按 **`Ctrl + Alt + S`** 即可呼出设置面板或退出程序。

> 注：个人开源软件未购买商业代码签名证书，Windows 首次运行可能会弹出 SmartScreen 蓝框提示，点击「更多信息 → 仍要运行」即可。

### 方式 2：交给 AI Agent 全自动部署
把本仓库交给任意 AI Agent（Codex / Antigravity / DSH / Claude Code），直接告诉它：
> “请按照仓库里的 `AGENT_INSTALL.md` 帮我完成编译、安装和验收。”

---

## 二、核心特性一览

- **贴靠原软件图标隐形热区（无小药丸）**：
  - **Codex（白丝）**：通过缓存式 Windows UIA 自动咬住左下角额度圆环（开关侧边栏、改窗口宽度、分屏均不漂移）；点击原生圆环查看详情时丝袜立刻避让。
  - **Antigravity（紫丝）**：自动咬住左下角切模型按钮，点击切模型或展开菜单瞬间零延迟收起，绝不挡住选模型；额度优先取 Gemini 模型组，排除 GPT/Claude，严格门禁 `agy >= 1.1.11`。
  - **DSH（蓝丝）**：通过官方零 UI 插件订阅 `@deepseek-ai/dsh-token-meter` 的 `contextPressure`（左腿剩余上下文 %，右腿自由互动腿）。
  - 支持在设置面板一键 **「🎯 标定图标位置」** 微调任意软件的热区坐标。
- **极致低耗静默**：
  - 丝袜收起/隐藏时自动暂停 PixiJS WebGL 渲染循环（**静默 GPU 0%、CPU < 0.3%**），悬停展开瞬间零延迟恢复 60–144 FPS；
  - 所有原生辅助进程（`sq-wintracker.exe`、`sq-sentinel.exe`）均以纯无窗口 `/target:winexe` 编译，绝不闪黑框。
- **系统兼容**：Windows 10（1903+）与 Windows 11 64 位（x64），完整适配多显示器与 100% / 125% / 150% / 200% 混排 DPI。

---

## 三、开发与发布打包命令

```powershell
# 开发预览（浏览器实验室 http://127.0.0.1:5173/ 与悬浮窗 http://127.0.0.1:5173/widget.html）
npm run dev

# 一键打包：免解压目录 + NSIS 一键安装包 + 单文件便携版
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run package:release
```

---

## 四、开源致谢与许可

- Codex / Antigravity 额度读取集成自 MIT 开源项目 [nesszer/Win-CodexBar](https://github.com/nesszer/Win-CodexBar)（许可全文见 `vendor/codexbar/LICENSE.Win-CodexBar.txt`）。
