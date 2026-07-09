# Markdown Notes

一个基于 Electron 的 Markdown 笔记桌面应用。

## 功能

- Markdown 编辑与实时预览
- 笔记搜索与语义检索
- 本地文件系统存储
- 浅色 / 深色主题

## 技术栈

- [Electron](https://www.electronjs.org/)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/) + [electron-vite](https://electron-vite.org/)
- [Milkdown](https://milkdown.dev/)（Markdown 编辑器）
- [Transformers.js](https://huggingface.co/docs/transformers.js)（本地语义嵌入）

## 开发

```bash
# 安装依赖
npm install

# 启动开发环境
npm run dev

# 类型检查
npm run typecheck
```

## 打包

```bash
# macOS（.dmg）
npm run build:mac

# Windows（.exe 安装包）
npm run build:win

# 同时打包 macOS + Windows
npm run build:all
```

打包产物位于 `release/` 目录下。

## 项目结构

```
├── build/          # 应用图标与构建资源
├── out/            # 编译输出（electron-vite）
├── release/        # 打包产物
├── src/
│   ├── main/       # Electron 主进程
│   ├── preload/    # 预加载脚本
│   └── renderer/   # 渲染进程（React）
└── package.json
```

## License

MIT
