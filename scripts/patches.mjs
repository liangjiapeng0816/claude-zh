import { sha256 } from './asar.mjs';
import { mergeCatalog, readCatalog, readTuples } from './catalogs.mjs';

export function replaceOnce(content, from, to, label) {
  const index = content.indexOf(from);
  if (index < 0 || content.indexOf(from, index + from.length) >= 0) {
    throw new Error(`无法唯一定位 ${label}`);
  }
  return content.slice(0, index) + to + content.slice(index + from.length);
}

const locale = 'zh-Hans';
const nativeBase = 'resources/i18n/';
const paths = {
  pre: '.vite/build/index.pre.js',
  main: '.vite/build/index.chunk-xV3fJhc7.js',
  web: 'assets/v1/shared-130-B8XvJbHi.js',
  index: 'index.html'
};

const preAnchor = 'let y=require("electron");y=u(y);';
const prePatch = `
{
  const root = y.app.getPath("appData");
  y.app.setPath("userData", p.default.join(root, "Claude"));
  y.app.commandLine.appendSwitch("lang", "zh-CN");
  const ps = require("node:child_process").execFileSync("/bin/ps", ["-axo", "uid=,pid=,comm="], {encoding:"utf8"});
  const other = ps.split("\\n").some(line => {
    const match = line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(.*)$/);
    return match && Number(match[1]) === process.getuid() && Number(match[2]) !== process.pid &&
      /\\/(?:Claude|Claude 中文版)\\.app\\/Contents\\/MacOS\\/Claude$/.test(match[3]);
  });
  if (other) {
    y.dialog.showErrorBox("Claude 已在运行", "请先退出正在运行的 Claude，再打开中文版。两个版本使用同一份本机资料。");
    y.app.exit(0);
    process.exit(0);
  }
}
`;

export function patches(app, ion, baseline) {
  const appChanges = new Map();
  const webChanges = new Map();
  const report = {};

  function put(map, path, text) {
    map.set(path, Buffer.from(text));
  }

  function edit(archive, map, path, rules) {
    const bytes = archive.read(path);
    const name = archive === app ? 'app' : 'ion-dist';
    if (sha256(bytes) !== baseline.archives[name].files[path]) throw new Error(`脚本指纹不符 ${path}`);
    let source = bytes.toString('utf8');
    for (const [label, from, to] of rules) source = replaceOnce(source, from, to, label);
    put(map, path, source);
  }

  const desktopEn = readCatalog(app, nativeBase + 'en-US.json');
  const desktopZh = readCatalog(app, nativeBase + locale + '.json', true);
  const webEn = readCatalog(ion, 'i18n/en-US.json');
  const common = Object.fromEntries(Object.entries(desktopZh).filter(([id]) =>
    Object.hasOwn(desktopEn, id) && desktopEn[id] === webEn[id]));
  for (const [label, archive, map, folder, english, official, reuse] of [
    ['desktop', app, appChanges, nativeBase, desktopEn, desktopZh, {}],
    ['web', ion, webChanges, 'i18n/', webEn, readCatalog(ion, 'i18n/zh-Hans.json', true), common],
    ['dynamic', ion, webChanges, 'i18n/dynamic/', readCatalog(ion, 'i18n/dynamic/en-US.json'),
      readCatalog(ion, 'i18n/dynamic/zh-Hans.json', true), {}]
  ]) {
    const additionalCatalogs = label === 'web' ? ['web-reference'] : [];
    const { localized, report: stats } = mergeCatalog(label, english, official, reuse, ...additionalCatalogs);
    put(map, folder + locale + '.json', JSON.stringify(localized));
    report[label] = stats;
  }

  edit(app, appChanges, paths.pre, [['桌面启动', preAnchor, preAnchor + prePatch]]);
  edit(app, appChanges, paths.main, [
    ['桌面默认语言',
      'SIt(e!==void 0&&bIt().includes(e)?e:vIt())', 'SIt("zh-Hans")'],
    ['桌面会话语言保存在运行时',
      'return t!==pIt&&(Eo.set("locale",t),pIt=t),!0', 'return pIt=t,!0'],
    ['禁止副本注册官方深层链接',
      'function gJr({client:e,schemes:t,clientPath:n,clientPathArgs:r,remove:i,keepExistingDefault:a}){for(let o of t)i?(e.removeAsDefaultProtocolClient(o,n,r),r?.includes("--")&&e.removeAsDefaultProtocolClient(o)):(!a||!e.isDefaultProtocolClient(o,n,r))&&e.setAsDefaultProtocolClient(o,n,r)}',
      'function gJr(){}'],
    ['停止副本自动更新',
      'async function qYi(){kYi(),', 'async function qYi(){return; kYi(),'],
    ['停止副本更新检查',
      'function kJ(){return BP()?Promise.resolve("skipped")',
      'function kJ(){return Promise.resolve("skipped"); return BP()?Promise.resolve("skipped")'],
    ['显示副本更新说明',
      'async function rZi(){if(q().autoUpdate.disabled)',
      'async function rZi(){await u.dialog.showMessageBox({type:"info",title:"更新 Claude 中文版",message:"请更新官方 Claude，再从本项目重新构建中文版。",buttons:["好"]});return; if(q().autoUpdate.disabled)']
  ]);

  const baseVersion = sha256(webChanges.get('i18n/zh-Hans.json')).slice(0, 12);
  const dynamicVersion = sha256(webChanges.get('i18n/dynamic/zh-Hans.json')).slice(0, 12);
  edit(ion, webChanges, paths.index, [
    ['内置网页语言声明', ' lang="en" data-theme=', ' lang="zh-Hans" data-theme='],
    ['内置网页词库注册', '</head>',
      `<meta name="i18n-catalogs" data-i18n-catalogs="zh-Hans:${baseVersion}.${dynamicVersion}"></head>`]
  ]);
  edit(ion, webChanges, paths.web, [
    ['内置网页启动语言', 'localeOverride:null,localeChoice:null,',
      'localeOverride:"zh-Hans",localeChoice:null,'],
    ['内置网页预加载语言', 'function Wm(){let e=null;',
      'function Wm(){if(Km("zh-Hans"))return "zh-Hans";let e=null;']
  ]);

  const hardcoded = readTuples('hardcoded');
  report.hardcoded = 0;
  for (const [path, entries] of Object.entries(Object.groupBy(hardcoded, row => row[0]))) {
    try {
      edit(app, appChanges, path, entries.map(([, label, source, translation]) => [label, source, translation]));
      report.hardcoded += entries.length;
    } catch (error) {
      report.skippedHardcoded ??= [];
      report.skippedHardcoded.push({ path, reason: error.message });
    }
  }
  return { appChanges, webChanges, report };
}
