# dsh-fork-to-preset

![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/github/v/release/bpc-oss/dsh-fork-to-preset)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在**输入条工具行、模型选择按钮旁边添加一个「分叉预设」胶囊**（与模型选择同款视觉规格）。点开菜单选择任意 agent preset，把当前会话分叉（fork）成一个全新的独立子会话，挂载到所选 preset 下——继承父会话已完成的轮次。

## 用法

- 点击输入条右下角（模型选择左侧）的 **分叉预设** 胶囊
- 菜单**只列出预设名称**；鼠标悬停（或方向键移动焦点）时，菜单底部的详情栏显示该预设的完整信息（id + 全部描述 + 默认标记）
- 点击某个预设 → 立即分叉，新会话自动打开，挂载到所选 preset，同时继承父会话的已完成轮次
- 键盘：↓/↑ 循环移动、Enter 分叉、Esc 关闭——与模型选择菜单同一套交互契约

## 分发

**仅 GitHub**。不发布到 npm。通过挂载包目录的 `cordis.patch.yml` bundle 声明安装。

需要平台支持 `session.fork({ agentPreset })` API（DeepSeek Harness rc.8+）。

## 安装

### 1. 把包链接进 harness 安装

```bat
:: Windows
mklink /J "<plugin-dir>\node_modules" "<harness>\resources\host\node_modules"
```

```sh
# POSIX (Linux/macOS)
ln -s "<harness>/resources/host/node_modules" "<plugin-dir>/node_modules"
```

### 2. 把 bundle 加进 profile

```json
{
  "dependencies": { "dsh-fork-to-preset": "link:<plugin-dir>" },
  "dsh": { "profile": { "bundles": ["...", "dsh-fork-to-preset"] } }
}
```

## License

MIT
