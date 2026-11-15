# Leaf

轻巧、安静的本地 EPUB、PDF、漫画和文本阅读器。使用 Tauri 2、Rust、TypeScript 和 Web Awesome，优先考虑启动速度与内存占用。正文使用系统 WebView 排版，书籍与阅读记录保存在本机。

## 功能

- **本地阅读**：打开或拖入 EPUB 2 / 3，树形目录、无链接分组标题、章节导航和阅读位置恢复。
- **MOBI 和 AZW3**：打开和扫描无 DRM 的 Kindle 电子书，支持书内目录与续读。
- **PDF 阅读**：保留原版面，支持内嵌目录、页码跳转、缩放及按页续读；也可通过扫描目录加入书架。
- **CBZ 漫画**：按文件名的自然顺序逐页读图，支持扫描、页码跳转、缩放、适合页面和按页续读。
- **文本阅读**：支持 UTF-8 Markdown、HTML 和 TXT。单文件 Markdown 按「第 X 章」标题分章，HTML 由标题生成目录，TXT 对谈按说话人区分。
- **Markdown 目录书**：点击“打开目录”或拖入文件夹，子目录内的 Markdown 文件也会成为章节。优先采用根目录 `SUMMARY.md`、`TOC.md` 或 `_sidebar.md` 的链接顺序，其余文件按自然文件名排序。扫描会把包含这些索引文件的目录识别为一本书。
- **诗歌排版**：在正文上方切换，保留软换行、增加诗节间距、居中标题；设置按书保存。
- **浏览器共读**：把当前 EPUB、Markdown、HTML 或 TXT 章节打开成浏览器里的独立页面，支持上一章和下一章。
- **移除书籍**：在书籍整理菜单中从书架移除；刷新持续忽略，手动重新打开文件可恢复，原文件和阅读记录保留。
- **扫描来源**：配置多个目录，递归扫描并加载书架；启动使用缓存，点击书架“刷新”同步新增文件、书籍信息和文件可用状态。
- **可选导入**：独立设置书库目录；默认关闭，开启后打开阅读时复制到书库，保留原文件。HTML 和 Markdown 留在原处，保留相对路径的图片和章节。
- **逻辑合集**：手动选择“合集 → 子书 → 章节”，折叠目录；子书共享 EPUB，独立记录进度和整理信息。
- **书架整理**：分组、标签、搜索、收藏、置顶、未读 / 在读 / 读过分类；手动分类不会被打开行为覆盖。
- **排序**：按书名、作者或最近阅读时间排序；置顶始终优先，排序选择自动保存。
- **书籍信息**：查看路径、大小、章节数、修改时间和阅读时长；手动补全书名、作者、出版社、出版日期、ISBN、语言和简介，可恢复原书信息。
- **封面与显示**：先显示书籍，按需异步读取 EPUB 封面；书卡大小支持滑杆、放大和缩小，记住偏好。
- **阅读设置**：字体、字号、行距、宽度和暖纸 / 素白 / 夜读主题；位置记忆与阅读计时可分别关闭。

## 开始开发

需要 Node.js 22.13+（22.x）或 24+、Rust stable，以及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。macOS 桌面开发可使用 Xcode Command Line Tools；Windows 需要 C++ Build Tools 与 WebView2；Linux 的系统包按发行版配置。

```sh
git clone https://github.com/codepiano/leaf-reader.git
cd leaf-reader
npm ci
npm run dev:desktop
```

开发模式前端热更新，Rust 改动增量编译后重启，无需反复打发布包。`npm run dev` 仅提供网页预览，本地文件功能需要桌面实例。

开发窗口名为 **Leaf Dev · 本地阅读**，标识 `local.leaf.reader.dev`，与正式配置 `local.leaf.reader` 分开保存数据。目前在 macOS 验证；Windows / Linux 的原生构建与实际运行尚未验收。

## 使用

1. 点“打开书籍”、拖入文件，或在侧栏“扫描目录”添加来源并“保存并扫描”。
2. 需要集中存放副本时，到“书库设置”另选导入目录并主动开启导入；扫描本身不会复制书籍。
3. 书卡星号用于收藏，↑ 用于置顶，··· 设置分组、标签和阅读分类。
4. 点 ⓘ →“编辑信息”补全书籍资料。留空使用原书信息；只修改本地展示记录，原文件保持不变。
5. 工具栏选择排序和封面大小；置顶在所有排序下始终优先。

完整操作、合集划分、开关与数据说明见 [使用说明](docs/usage.md)。

## 构建与验证

构建发布包：

```sh
npm run tauri -- build
```

请在独立 checkout 中验证，隔离依赖、构建输出与数据，避免打扰正在使用的 dev 实例：

```sh
npm ci
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm exec playwright -- install chromium webkit
npm run test:ui
npm exec playwright -- test --browser webkit
```

浏览器测试使用临时存储和 mock IPC，ZIP 解析、复制、信息覆盖与持久化由 Rust 测试验证。[开发说明](docs/development.md) 记录目录结构、隔离方法和资源协议。历史发布版本的性能基线见 [验证记录](docs/verification.md)，不代表当前 dev 的性能测量。

## 本地数据与范围

macOS 默认记录目录为 `~/Library/Application Support/local.leaf.reader.dev`（开发）或 `~/Library/Application Support/local.leaf.reader`（正式配置）。`library.json` 保存书架、进度、时长与手动信息；界面偏好保存在 WebView 本地存储。扫描和导入的目录是用户自行选择的其他位置。

EPUB 支持无 DRM、UTF-8 编码的流式正文，固定版式 EPUB、竖排和复杂交互未完成验收。PDF 支持无密码文件及图像扫描页。HTML 使用 Leaf 排版，保留本地图片和页内链接；远程资源、脚本和原网页样式不会载入。尚未实现 EPUB 分页、OCR、批注、书签、全文搜索与同步。正文在沙箱内展示，资源按需读取，限制书籍脚本、外部资源和路径逃逸。启动先读取缓存书架，封面仅在视口附近异步加载。

仓库中的 EPUB 和 PDF 为项目自带的原创或合成测试材料。个人图书、阅读记录、备份、构建包及本地配置均不纳入仓库。
