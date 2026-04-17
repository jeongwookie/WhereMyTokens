<img src="assets/source-icon.png" width="80" align="right" />

# WhereMyTokens

**实时监控 Claude Code 令牌使用量的 Windows 系统托盘应用。**

由每天使用 Claude Code 的韩国开发者打造 — 为自己而做。

安静地驻留在任务栏中，一目了然地展示 Claude Code 使用情况 — 令牌数、费用、会话活动和速率限制。

![Platform](https://img.shields.io/badge/platform-Windows_10%2F11-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Release](https://img.shields.io/github/v/release/jeongwookie/WhereMyTokens)

> [English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [Español](README.es.md)

> 💾 **无云同步** — 仅读取本地 Claude 文件。您的数据绝不会离开您的设备。

<table>
  <tr>
    <th width="50%">浅色模式</th>
    <th width="50%">深色模式</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-light.png" alt="Light mode" /></td>
    <td><img src="assets/screenshot-dark.png" alt="Dark mode" /></td>
  </tr>
</table>

<table>
  <tr>
    <th width="33%">Rhythm 与峰值统计</th>
    <th width="33%">7 天热力图</th>
    <th width="33%">设置</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-rhythm.png" alt="Rhythm tab" /></td>
    <td><img src="assets/screenshot-heatmap.png" alt="7-day heatmap" /></td>
    <td><img src="assets/screenshot-settings.png" alt="Settings" /></td>
  </tr>
</table>

## 下载

**[⬇ 下载最新版本](https://github.com/jeongwookie/WhereMyTokens/releases/latest)**

1. 下载 `WhereMyTokens-v1.9.1-win-x64.zip`
2. 解压到任意位置
3. 运行 `WhereMyTokens.exe`

无需安装 — 应用自动打开并驻留在系统托盘中。

---

## 功能特性

### 会话追踪
- **实时会话检测** — 终端、VS Code、Cursor、Windsurf 等，实时状态：`active` / `waiting` / `idle` / `compacting`
- **两级分组** — 按 git 项目 → 分支分组，含项目级提交统计和行数
- **空闲自动隐藏** — 空闲会话逐步折叠；6小时以上自动隐藏（可展开）
- **上下文窗口警告** — 每会话进度条；50% 琥珀色、80% 橙色、95%+ 红色
- **工具使用条** — 比例颜色条 + 工具标签（Bash、Edit、Read 等）

### 速率限制与提醒
- **速率限制条** — Anthropic API 5小时和1周用量，含进度条、重置倒计时、缓存效率等级
- **Claude Code 桥接** — 注册为 `statusLine` 插件，无需 API 轮询即可获取实时数据
- **Windows 通知** — 在可配置的使用阈值（50% / 80% / 90%）时弹出提醒
- **Extra Usage 预算** — 月度额度使用量 / 限额 / 利用率

### 分析与活动
- **标题栏统计** — today/all-time 切换：费用、API 调用、会话、缓存效率、节省金额、令牌分析（In/Out/Cache）
- **活动标签页** — 7天热力图、5个月日历（GitHub 风格）、按小时分布、4周对比
- **Rhythm 标签页** — 按时段费用分布（Morning/Afternoon/Evening/Night），渐变条，峰值详细统计，本地时区
- **模型分析** — 按模型的令牌和费用总计，渐变条
- **Activity Breakdown** — 每会话输出令牌 10 类分析（Thinking、Edit/Write、Read、Search、Git 等）

### 代码产出与生产力
- **Git 指标** — 提交数、净变更行数、**$/100 Lines**（每100行新增的成本）
- **今日 vs 全部** — 今日显示实际行均成本与历史平均对比
- **自动发现** — 通过 `~/.claude/projects/` 包含所有使用过 Claude 的项目
- **仅统计您的提交** — 按 `git config user.email` 过滤

### 个性化
- **Auto/Light/Dark 主题** — 默认跟随系统偏好
- **费用显示** — USD 或 KRW，可配置汇率
- **置顶小部件** — 始终悬浮；通过标题栏按钮、托盘图标或全局快捷键最小化
- **托盘标签** — 在任务栏直接显示使用率 %、令牌数或费用
- **项目管理** — 隐藏或完全排除项目
- **随 Windows 启动** — 可选自动启动

---

## 快速开始

### 1. 打开仪表板
点击托盘图标（或按全局快捷键 `Ctrl+Shift+D`）。

### 2. 连接 Claude Code 桥接（可选）
**Settings → Claude Code Integration → Setup** — 无需 API 轮询即可获取实时速率限制数据。

### 3. 配置
- **货币** — USD 或 KRW
- **提醒** — 设置使用阈值（50% / 80% / 90%）
- **主题** — Auto（跟随系统）/ Light / Dark
- **托盘标签** — 选择任务栏显示内容

---

## 数据与隐私

WhereMyTokens 仅读取本地文件 — 无云同步，无遥测。

| 文件 | 用途 |
|------|------|
| `~/.claude/sessions/*.json` | 会话元数据（pid、cwd、模型） |
| `~/.claude/projects/**/*.jsonl` | 对话日志（令牌数、费用） |
| `~/.claude/.credentials.json` | OAuth 令牌 — 仅用于从 Anthropic 获取您的使用统计 |
| `%APPDATA%\WhereMyTokens\live-session.json` | `statusLine` 插件写入的桥接数据 |

---

## 从源码安装

### 环境要求

- Windows 10 / 11
- [Node.js](https://nodejs.org) 18+
- [Claude Code](https://claude.ai/code) 已安装并登录

### 构建与运行

```bash
git clone https://github.com/jeongwookie/WhereMyTokens.git
cd WhereMyTokens
npm install
npm run build
npm start
```

---

## 演示

<div align="center">

https://github.com/user-attachments/assets/98b6f8d7-6fc6-4c12-aef1-af6300db0728

</div>

---

## 免责声明

显示的费用为 **API 等价估算值**，并非实际账单。Claude Max/Pro 订阅为月度固定费用。费用显示的是您从订阅中获得的使用价值。

---

## 贡献

欢迎提交 Issue 和 Pull Request。如需变更，请先开一个 Issue 进行讨论。

---

## 致谢

灵感来自 [duckbar](https://github.com/rofeels/duckbar) — macOS 版本。

---

## 许可证

MIT
