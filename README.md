<p align="center">
  <img src="src/assets/sprites/basic/idle/idle.png" width="120" alt="Project-Ze Logo" />
</p>

<h1 align="center">Project-Ze</h1>

<p align="center">
  <strong>MIDL Version · AI 桌宠分步操作指引助手</strong>
  <br />
  基于屏幕全域感知、互联网教程解析和虚拟桌宠指向动画的交互式操作引导系统
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-42.2-blue" alt="Electron" />
  <img src="https://img.shields.io/badge/TypeScript-6.0-brightgreen" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Platform-Windows-informational" alt="Windows" />
  <img src="https://img.shields.io/badge/Version-MIDL%20version-orange" alt="MIDL version" />
</p>

---

## 项目简介

Project-Ze 是一个运行在 Windows 桌面上的 AI 虚拟桌宠。当前 MIDL version 的核心能力是 **AI 桌宠分步操作指引助手**：

> 它不是给用户一篇教程，而是在用户当前屏幕上直接让桌宠移动过去，指出下一步应该点哪里。

系统面向计算机零基础用户，解决软件下载、安装、注册、配置流程复杂的问题。用户只需要告诉桌宠目标，例如“我想下载 Steam”，系统会自动整理教程、观察屏幕、判断当前步骤，并控制桌宠移动到目标控件旁边，通过八方向指向动画和气泡提示引导用户完成操作。

## 核心亮点

| 能力 | 说明 |
|------|------|
| 桌宠具身指引 | 不绘制红圈、矩形或额外箭头，所有可视化引导都由桌宠移动、指向动画和气泡完成 |
| 屏幕实时感知 | 捕获当前屏幕，调用 Vision 模型识别文字、按钮、输入框、图标、菜单和弹窗 |
| 教程结构化解析 | 根据目标软件检索教程，并整理成单步动作队列 |
| 单目标引导 | 每次只给用户一个当前操作目标，降低新手理解成本 |
| 高精度指向 | 使用八方向指尖校准、截图坐标映射、局部裁剪放大复核提升定位精度 |
| 页面变化处理 | 页面跳转、滚动、弹窗或加载后重新识别，不盲目沿用旧坐标 |
| 可交互指引面板 | 提供“我完成了 / 重新识别 / 退出”，网址提示可点击复制到剪贴板 |
| 绿色版打包 | Windows 下可输出 `release/win-unpacked/start.exe`，解压即可运行 |

## 当前版本能力

### 1. AI 桌宠分步操作指引

用户在 F11 设置中启用分步指引并填写 API 信息后，可以输入目标软件或目标任务，例如：

- 我想下载 Steam
- 帮我安装 Claude 客户端
- 怎么找到 Codex 下载入口
- 下一步应该点哪里

系统执行流程：

1. 根据用户目标检索或生成安装教程。
2. 将教程解析成结构化步骤队列。
3. 截取当前屏幕并识别可交互控件。
4. 判断用户当前处于哪一步。
5. 输出当前唯一目标控件坐标。
6. 桌宠移动到目标附近，播放指向动画。
7. 气泡给出短提示，例如“点击右上角的安装按钮”。
8. 用户完成后点击“我完成了”或“重新识别”，系统进入下一轮。

### 2. 屏幕目标指示

普通对话中也可以让桌宠帮你找屏幕上的目标。典型输入：

```txt
. 帮我指出下载按钮在哪里
. 搜索框在哪
. 指一下设置图标
. 找到页面里的 Install Steam
```

系统会优先识别：

- 文本位置：标题、链接、按钮文字、输入框占位文字
- 图案位置：图标、Logo、常见符号
- 控件位置：按钮、输入框、菜单、标签页、复选框
- 上下文位置：文字旁边的相关按钮或图标

### 3. 算法 3：局部裁剪放大复核

为了提高小文字、小图标、小按钮的定位精度，当前版本加入了 Algorithm 3：

```txt
全屏高精度定位
    ↓
得到候选目标框
    ↓
裁剪候选附近区域
    ↓
局部放大
    ↓
Vision 二次确认文字/图标/控件边界
    ↓
局部坐标映射回全屏
    ↓
桌宠指尖对准最终目标点
```

核心坐标映射公式：

```txt
screenX = origin.x + imageX * screenWidth / imageWidth
screenY = origin.y + imageY * screenHeight / imageHeight
```

局部裁剪坐标映射：

```txt
fullImageX = cropBox.x + cropLocalX / zoomScale
fullImageY = cropBox.y + cropLocalY / zoomScale
```

指尖对准目标的窗口位置计算：

```txt
windowX = targetX - fingertipOffsetX
windowY = targetY - fingertipOffsetY
```

然后根据屏幕工作区进行 clamp，保证桌宠窗口不会跑出屏幕。

## 系统架构

```txt
用户目标
  ↓
Operation Guide Intent
  ↓
教程检索 / 教程结构化解析
  ↓
结构化步骤队列
  ↓
Screen Analyzer 屏幕感知
  ↓
Guide Manager 指引中台
  ↓
Screen Target Pointer 目标指向编排
  ↓
Move Controller 桌宠移动
  ↓
Renderer 桌宠动画 / 指向 / 气泡 / 指引面板
```

核心模块：

| 模块 | 责任 |
|------|------|
| `src/core/operation-guide-manager.ts` | 分步指引中台，维护教程进度并调度屏幕定位和桌宠指向 |
| `src/core/operation-guide-planner.ts` | 将教程或目标任务整理成结构化步骤 |
| `src/core/operation-guide-search.ts` | 联网教程检索边界 |
| `src/core/operation-guide-progress-evaluator.ts` | 判断当前步骤是否完成、下一步目标是否出现 |
| `src/core/screen-analyzer.ts` | 屏幕截图、Vision 调用、OCR/控件/图标目标定位、算法 3 复核 |
| `src/core/screen-target-pointer.ts` | 判断是否需要指向、选择目标、调用移动和指向动画 |
| `src/core/screen-target-alignment.ts` | 八方向指尖坐标校准和最佳指向姿态选择 |
| `src/core/move-controller.ts` | 桌宠平滑移动、坐标 clamp、移动动画事件 |
| `src/renderer/renderer.ts` | 桌宠动画、气泡、指引面板、网址点击复制 |
| `src/main/main.ts` | Electron 主进程、窗口、IPC、模块初始化 |

## 对外融合接口建议

如果要和其他小组融合，建议把分步指引封装成高层 API，其他组只调用接口，不直接改内部实现。

### 高层指引接口

```ts
interface GuideStartRequest {
  goal: string;
  source?: 'text' | 'voice' | 'demo' | 'external';
  preferredLanguage?: 'zh-CN' | 'en-US';
}

interface GuideState {
  sessionId: string;
  active: boolean;
  status: 'planning' | 'observing' | 'pointing' | 'waiting' | 'completed' | 'error';
  goal: string;
  currentIndex: number;
  totalSteps: number;
  message: string;
  canNext: boolean;
  canReidentify: boolean;
  canExit: boolean;
}

interface GuideApi {
  start(request: GuideStartRequest): Promise<GuideState>;
  next(sessionId: string): Promise<GuideState>;
  reidentify(sessionId: string): Promise<GuideState>;
  exit(sessionId: string): Promise<GuideState>;
  getState(sessionId: string): Promise<GuideState>;
}
```

### 桌宠行为指令

```ts
interface PetGuideCommand {
  type: 'point_to_target';
  target: {
    x: number;
    y: number;
    width?: number;
    height?: number;
    label?: string;
    kind?: 'text' | 'button' | 'input' | 'icon' | 'menu' | 'region';
  };
  action: 'click' | 'input' | 'scroll' | 'wait';
  hint: string;
  confidence: number;
}
```

这样语音组、摄像头组、网页检索组都可以独立接入：

- 语音组负责把语音转成 `goal` 或 `next/reidentify/exit` 指令。
- 摄像头组负责提供用户状态，例如“长时间找不到目标”。
- 教程组负责提供更高质量的步骤队列。
- 桌宠组只消费 `PetGuideCommand`，不需要知道教程来源。

## 使用方法

### 开发运行

```bash
git clone https://github.com/Cookie-yeah666/Project-Chen.git Project-Ze
cd Project-Ze
npm install
npm start
```

### 快捷键

| 操作 | 作用 |
|------|------|
| F11 | 打开设置 |
| F3 | 打开调试窗口 |
| F12 | 打开开发者工具 |
| 右键桌宠 | 打开聊天输入框 |
| 左键拖拽 | 移动桌宠 |
| `.` 开头消息 | 显式屏幕分析 / 屏幕目标指示 |
| 麦克风按钮 | 开始或结束语音输入 |
| `Ctrl+Shift+Space` | 长按语音输入 |

### AI 配置

进入 F11 设置后，可以配置：

- 通用聊天模型 API
- 屏幕分析 Vision API
- 分步指引独立 API
- 语音输入 ASR API
- TTS 语音合成 API
- 桌宠大小、透明度等外观参数

分步指引支持独立配置 API Key、API 地址、模型、温度和提示词，方便与普通聊天能力解耦。

## Windows 打包

```bash
npm run dist:win
```

输出目录：

```txt
release/win-unpacked/
```

绿色版启动入口：

```txt
release/win-unpacked/start.exe
```

`start.exe` 是 Windows 启动器，会清理异常环境变量后拉起 `Project-Ze.exe`，降低双击无反应和安装器场景下被压到后台的概率。

## 测试

```bash
npm test
```

当前契约测试覆盖：

- 语音输入链路
- 屏幕 fingerprint
- 指尖坐标对齐
- 屏幕目标定位 JSON 解析
- 算法 3 裁剪复核坐标映射
- 分步指引流程

## 版本路线

### V1.0 / 当前落地版本

- 屏幕实时感知
- 教程结构化解析
- 桌宠移动到目标控件旁
- 八方向指向动画
- 气泡短提示
- 每次只指引一个目标
- 用户可选择“我完成了 / 重新识别 / 退出”

### V2.0 / 语音交互

- 用户通过麦克风发起指引
- 语音确认下一步
- 桌宠语音播报操作提示

### V3.0 / 摄像头多模态行为感知

- 检测用户长时间找不到目标
- 反复误操作时加强提示
- 结合屏幕状态和用户状态进行容错

## 设计边界

当前版本刻意不做：

- 自动点击用户电脑
- 自动输入敏感信息
- 顶层悬浮红圈或矩形标注
- 摄像头默认开启
- 麦克风默认开启
- 后台高频截屏监控

项目原则是：**桌宠给出清晰指引，最终操作始终由用户完成。**

## 项目文档

- [项目索引](PROJECT_INDEX.md)
- [开发规则](PROJECT_RULE.md)
- [版本记录](VERSION.md)
- [分步指引路线图](docs/challenge-cup-operation-guide-roadmap.md)
- [配置安全说明](docs/configuration-security.md)
- [摄像头感知模块说明](docs/camera-awareness-core.md)

## 仓库与版本标记

当前备份仓库：

```txt
https://github.com/Cookie-yeah666/Project-Chen.git
```

重要标记：

```txt
MIDL-version-2026-07-16
operation-guide-v1.2.7-algorithm3-guide-url-copy-2026-07-16
```

## License

当前项目遵循仓库内 `package.json` 标注的开源许可配置。
