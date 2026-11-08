# 开发说明

## 工具与命令

Node.js 版本需满足 Vite 的 `^20.19.0 || >=22.12.0`，Rust 使用 stable。按 [Tauri 官方前置依赖](https://v2.tauri.app/start/prerequisites/) 配置系统库。

```sh
npm ci
npm run dev:desktop
```

开发前端监听 `127.0.0.1:1437`；修改前端由 Vite 热更新，修改 Rust 会增量编译并重启桌面进程。开发配置 `src-tauri/tauri.dev.conf.json` 使用独立应用标识，区别于正式配置。`scripts/tauri.mjs` 优先使用 PATH 中的 Cargo；本机存在 `~/Library/Caches/leaf-toolchain` 时才使用该备用工具链，不会自动安装或改 shell 配置。

发布构建执行 `npm run tauri -- build`，输出位于 `src-tauri/target/release/bundle`；不同平台应分别构建和验收。发布源码到仓库不等于生成或分发桌面安装包。

## 验证隔离

正在使用的 checkout 中不运行可能改写依赖、构建产物或触发 watcher 的验证命令。创建独立 worktree，在其中独立安装依赖并使用独立 Cargo 输出；依赖与缓存不要用符号链接指回在线目录。

```sh
git worktree add -b codex/check ../leaf-check HEAD
cd ../leaf-check
npm ci
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm exec playwright -- install chromium webkit
npm run test:ui
npm exec playwright -- test --browser webkit
```

浏览器测试启动 `127.0.0.1:1438`，新 origin、上下文与 mock 数据不操作个人书库。浏览器测试覆盖交互与视觉几何，Rust 测试覆盖真实 ZIP、临时文件、复制和原子持久化。需要原生窗口验证时另外配置独立应用标识和数据路径；仅换端口不足以隔离原生记录及 WebView 存储。

## 结构

| 路径                                                    | 职责                                 |
| ------------------------------------------------------- | ------------------------------------ |
| `src/main.ts`、`public/reader-bridge.js`                | 阅读会话、章节清洗、沙箱消息桥       |
| `src/shelf.ts`、`shelf-sort.ts`、`shelf-size.ts`        | 书架、筛选、排序、大小偏好           |
| `src/book-info.ts`                                      | 信息展示与手动补全                   |
| `src/covers.ts`、`src-tauri/src/cover.rs`               | 视口封面队列与 ZIP 封面提取          |
| `src-tauri/src/epub.rs`、`collection.rs`                | EPUB 解析、目录与逻辑子书范围        |
| `src-tauri/src/scan.rs`、`library_directory.rs`         | 来源扫描与可选导入，配置分别持久化   |
| `src-tauri/src/details.rs`                              | 原书资料读取、手动覆盖、显示名称解析 |
| `src-tauri/src/reading_time.rs`、`src/reading-clock.ts` | 会话计时与偏好                       |
| `fixtures`、`tests`                                     | 原创/合成材料及浏览器回归            |

## 数据与安全边界

`library.json` 兼容旧字段的默认值，变更先作用于副本，写临时文件并原子替换成功后才更新内存。手动资料按原书 ID / 子书 ID 保存，覆盖的是展示字段，原 EPUB 与原始路径索引不被改写；扫描不会覆盖补全信息。

正文使用 DOMPurify 清洗，位于不允许同源访问的 iframe；应用桥脚本经 CSP 允许，书籍脚本与外部请求被限制。本地资源协议按当前会话提供章节资源，封面仅按已登记书籍 ID 提供图片；路径逃逸被拒绝。元数据、章节和资源有读取上限。封面提取与信息窗口的额外 OPF 读取按需执行，不在书架快照中遍历所有 EPUB。

阅读计时每秒轻量采样、约每 15 秒及离开阅读时保存；封面按视口最多发起两张图片请求，离屏后移除 src。不要在启动时全盘扫描、解压整书或把全部封面编码进书架 JSON。

## 文档与基线

[使用说明](usage.md) 描述当前用户流程；其余按功能命名的文档保留实现边界和验证记录。[历史验收](verification.md) 与 JSON 性能数据属于特定旧发布构建，不能作为当前 dev 或新增功能的最新性能报告。

需要刷新浏览器原生契约 fixture 时，在隔离 worktree 执行 `python3 scripts/update-browser-fixtures.py`。不要将个人 EPUB、`library.json`、凭据、备份或测试生成物提交到公开仓库。
