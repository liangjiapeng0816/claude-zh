# Claude Desktop 简体中文版

基于本机的官方 `Claude.app` 构建。本次适配桌面版本及构建号 **5.11492.5**。原版是 arm64 / x86_64 通用应用，实际在这台 arm64 Mac 上验收。

## 安装和使用

在 Finder 双击 `Install.command`，或将 `release/5.11492.5/Claude-zh-Hans-5.11492.5.dmg` 里的应用拖入「应用程序」。退出原版后，打开「Claude 中文版」。

两个版本共用本机原有的 Claude 数据目录，请一次只运行一个。macOS 首次启动或重新签名后可能要求授权「Claude Safe Storage」，按系统提示处理。对于需要 Anthropic 签名身份、浏览器回调或系统权限的功能，可切回原版。安装包只包含软件资源。

## 构建、核验和更新

需要 macOS、Node.js 22 或更新版本，以及可读取的官方 `/Applications/Claude.app`。本地构建使用系统自带的 `plutil`、`ditto`、`codesign` 和 `hdiutil`。

```sh
npm ci --ignore-scripts
npm run inspect
npm run build
npm run verify -- 5.11492.5
npm run install:app -- 5.11492.5
npm run dmg -- 5.11492.5
```

`inspect` 和 `build` 可以通过 `-- "/其他路径/Claude.app"` 指定官方应用。产物和 `build-report.json` 按实际桌面版本写入 `release/<桌面版本>/`。中文版的「检查更新」会打开重新构建说明。更新官方版后再次运行 `inspect` 和 `build`。若必需脚本的结构或指纹改变，构建会停止并保留已有产物。新版本适配时，先从本机新 ASAR 核对补丁位置和内嵌摘要，再更新 `scripts/patches.mjs` 和 `translations/baseline.json`。

## 语言资源与范围

- `app.asar` 管理桌面菜单、窗口和原生提示。补译以官方简体词库为基础。
- `ion-dist.asar` 管理本机网关模式下内置的会话、Code、Cowork 和设置界面。新增 `zh-Hans` 词库及动态词库。
- `translations/*.jsonl` 中每行保存词条 ID、完整原文和中文。原文变更或词条删除时跳过旧译文。保留原版自带的中文译文，其余回退到当前英文。格式化文案核对 ICU 变量、格式、分支和标签。少量授权窗口文案按文件指纹和完整片段核对。
- 构建重算 ASAR 头部、修改条目的内容摘要和 Electron 二进制里的内嵌摘要。副本使用独立 Bundle ID，外层应用、Electron Framework 和对应 Helper 采用本地 ad-hoc 签名。这些重签组件使用 ad-hoc 运行属性，ASAR 运行时会继续校验应用资源。参考 [Electron ASAR 完整性文档](https://www.electronjs.org/docs/latest/tutorial/asar-integrity) 和 [macOS 内嵌摘要实现](https://github.com/electron/electron/blob/main/shell/common/asar/integrity_digest.mm)。
- 本机验证覆盖的页面和剩余限制见 [验收记录](验证记录.md)。在线服务下发的网页、实验功能和低频页面可能仍显示原文。
