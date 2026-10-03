# dsh-archive-keeper（归档守护）

DSH 的「归档」只改标记、不动磁盘。时间一长，`$DSH_HOME/sessions/` 会堆下一大坨再也不会翻的原文。

这个插件把归档会话**自动提炼成结构化要点**，并在对话头部加一个「归档守护」面板，让你逐条决定去留 —— 而且**任何删除都先移入回收站，随时可恢复**。

> 本包随附全部运行所需代码，安装后即可独立运行。

---

## 功能

### 1. 归档后自动提炼

轮询归档列表，一出现新的归档会话就调起提炼流程，把整个会话压成结构化要点：

概括 / 决定 / 事实 / 交付物 / 待办项 / 可作废项，并给出「是否值得留存」的判断。

### 2. 由你自己定去留

对话头部右侧的「归档守护」面板里，每条归档都是一个可展开的卡片：

| 选项 | 含义 |
| --- | --- |
| **保留原文** | 什么都不删 |
| **只留摘要** | 删除原文，只保留提炼出的要点 |
| **彻底删除** | 原文和摘要都移入回收站 |
| **恢复原文** | 把之前移入回收站的原文搬回来 |

### 3. 时间段 + 标签 分组

面板里的对话按 **年份 → 日期 → 时段 → 标签** 四级归类：

- 年份、日期：越新的越靠上（从远到近、从下到上）
- 时段：**上午 / 下午 / 晚上**（< 12:00 / 12:00–17:59 / ≥ 18:00）
- 标签：自己在齿轮面板里定义，没打标签的归入「未分类」

### 4. 自定义「值得留存」的价值判断

点右上角 **⚙** 打开个性化面板：

- **标签**：内置一批常见标签（重要 / 环境事实 / 用户偏好 / 教训 / 待跟进 / 可复用 / 项目 / 灵感），也可自己新建；给任意对话手工打标签。
- **收纳规则**：按**关键词 / 分类 / 用户轮数区间**组合条件（多条件是「且」）。**命中规则的会话优先纳入「值得留存」**；没命中任何规则的，才回落到默认价值判断。
- **自动打标签**：只自动贴标签，不改变收纳结果。

### 5. 回收站

所有被删除的内容（原文与摘要）都先移入 `trash/`，面板顶部显示回收站占用，可逐条恢复或清空。

---

## 安装

直接从 GitHub 安装：

```bash
npm i github:Isle-ux/dsh-archive-keeper-plugin
```

或克隆到本地，再把目录链接进 profile 的 `node_modules`：

```bash
git clone https://github.com/Isle-ux/dsh-archive-keeper-plugin.git
```

然后把插件加进 profile 的 `dsh.profile.bundles`（或按你的 DSH 版本的插件安装方式装载）。
本包**自带全部运行代码**，不需要额外安装运行时依赖。

### 兼容性

- 仅**桌面版 / 网页版**生效：界面半边注册在 `conversation.session.header.utilities` 座位，只有带对话区的宿主才声明这条座位；headless、tui 等宿主里插件不会激活。
- 需要 Node.js ≥ 20。
- 提炼步骤会调用模型，需要在 DSH 里配好可用的模型路由。

> ⚠️ 本插件是按作者本机 DSH 版本开发的。如果你的 DSH 版本对插件清单有不同要求
> （比如 `dsh.client` 字段格式），可能需要按你的版本调整 `package.json`。

---

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `root` | `<用户目录>\Documents\deepseek-harness\archive-keeper` | 用户数据根目录（摘要、选择、回收站都写在这里） |
| `pollMs` | `30000` | 归档列表轮询间隔（毫秒） |

> `root` 指向的是**你的数据目录**，与插件安装位置无关；升级或重装插件不会影响已有数据。

---

## 路由

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/archive-keeper/list` | 全部摘要 + 你的选择 + 原文是否还在 |
| POST | `/archive-keeper/decide` | 记录保留原文 / 只留摘要 / 恢复原文 |
| POST | `/archive-keeper/run` | 立即跑一次增量提炼 |
| GET | `/archive-keeper/customize` | 读取标签与规则 |
| POST | `/archive-keeper/tag` | 增删标签、手工打标签 |
| POST | `/archive-keeper/rule` | 增删改收纳规则 / 自动打标签规则 |

---

## 安全边界（重要）

- **本插件永不自动删任何东西。** 删除只发生在你显式点击并二次确认之后。
- 删除是**移动**到 `trash/<会话id>__<时间戳>/`，不是真删；随时可以搬回去。
- 每次清理都记一笔到 `state/purge-log.json`（原路径、去向、字节数）。
- **清空回收站是唯一不可逆的操作**，会二次确认后连摘要一起删除。

---

## 目录结构

### 插件包

```
dsh-archive-keeper/
  lib/index.js       宿主半边：归档监听 + HTTP 路由
  lib/client.js      浏览器半边：「归档守护」面板
  lib/state.cjs      状态机 / 排他锁 / 摘要读写
  lib/keeper.cjs     主流程：扫描 → 抽取 → 模型提炼 → 落盘
  lib/extract.cjs    会话文件解析（zstd 多帧解压 + 脉络抽取）
  lib/decisions.cjs  去留选择、回收站、彻底删除
  lib/tags.cjs       标签与自定义价值规则
  cordis.patch.yml   bundle patch（只 insert 自己这一行）
```

### 用户数据目录（`root` 指向处）

```
archive-keeper/
  digests/<会话id>.json   每个归档会话的结构化要点
  state/state.json        已处理记录
  state/decisions.json    你的选择
  state/tags.json         标签与规则（首次自定义后才创建）
  state/latest.json       最近一次运行的报告
  state/purge-log.json    清理日志
  trash/<会话id>__<时间戳>/  被清理的原文（可恢复）
```

---

## 命令行（不走界面时）

```bash
node lib/keeper.cjs            # 增量提炼新归档
node lib/keeper.cjs --all      # 重跑全部
node lib/keeper.cjs --no-llm   # 只抽取不调模型（离线自检）
node lib/decisions.cjs list    # 看当前选择
```

---

## 提炼用的模型

默认走 `headless` profile。想换成别的路由，设环境变量
`ARCHIVE_KEEPER_PROFILE=<profile名>` 即可。

---

## License

MIT
