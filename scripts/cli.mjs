import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Asar } from './asar.mjs';
import { updateEmbeddedDigest, verifyEmbeddedDigest } from './integrity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(readFileSync(join(root, 'translations/baseline.json')));
const appName = 'Claude 中文版';
const appFile = appName + '.app';
const bundleId = 'local.claude.desktop.zh-hans';
const officialId = 'com.anthropic.claudefordesktop';
const officialApp = '/Applications/Claude.app';
const releasesUrl = 'https://github.com/liangjiapeng0816/claude-zh/releases';
const archives = ['app', 'ion-dist'];
const release = join(root, 'release');
const receiptFile = 'build-report.json';
const electronFramework = 'Contents/Frameworks/Electron Framework.framework';
const electronBinary = electronFramework + '/Electron Framework';

function run(binary, args, options = {}) {
  return execFileSync(binary, args, { encoding: 'utf8', ...options });
}

function readPlist(path) {
  return JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', path]));
}

function writePlist(path, content) {
  run('/usr/bin/plutil', ['-convert', 'xml1', '-o', path, '--', '-'], { input: JSON.stringify(content) });
}

function readBundle(path) {
  return readPlist(join(path, 'Contents/Info.plist'));
}

function asarPath(app, archive) {
  return join(app, 'Contents/Resources', archive + '.asar');
}

function verifyASAR(archive, plist, name) {
  const integrity = plist.ElectronAsarIntegrity?.[`Resources/${name}.asar`];
  if (integrity?.algorithm !== 'SHA256' || integrity.hash !== archive.headerHash) {
    throw new Error(`ASAR 完整性不符 ${name}.asar`);
  }
}

function sourceInfo(path) {
  if (!existsSync(join(path, 'Contents/Info.plist'))) {
    throw new Error(`找不到官方 Claude Desktop ${path}`);
  }
  path = realpathSync(path);
  const plist = readBundle(path);
  if (plist.CFBundleIdentifier !== officialId || plist.CFBundleExecutable !== 'Claude') {
    throw new Error(`需要官方 Claude.app ${path}`);
  }
  const rawVersion = plist.CFBundleShortVersionString;
  if (!/^\d+(?:\.\d+){2,3}$/.test(rawVersion)) throw new Error('无法识别桌面版本');
  const rawBuild = plist.CFBundleVersion;
  if (typeof rawBuild !== 'string' || !rawBuild.trim()) throw new Error('无法识别构建号');
  const macho = run('/usr/bin/file', ['-b', join(path, 'Contents/MacOS/Claude')]);
  const architectures = ['arm64', 'x86_64'].filter(architecture => macho.includes(architecture));
  if (!architectures.includes(process.arch)) throw new Error('官方应用缺少当前 Node 架构的可执行文件');
  return { path, plist, version: rawVersion, build: rawBuild, architectures };
}

function checkVersion({ version, build }) {
  if (version === baseline.version && build === baseline.build) {
    console.log(`版本核对通过。桌面版本 ${version}，构建号 ${build}。`);
    return;
  }

  console.warn(`版本提示。本机桌面版本 ${version}，构建号 ${build}。`);
  console.warn(`当前适配基准为桌面版本 ${baseline.version}，构建号 ${baseline.build}。`);
  console.warn('本地构建可继续。词条缺少适用的中文译文时会显示原文。');
  console.warn(`下载 DMG 时，优先在 ${releasesUrl} 选择版本和构建号都匹配的 Release。`);
  console.warn(`没有匹配项时，使用最新 Release ${releasesUrl}/latest`);
}

function readSourceArchives(path, plist) {
  const opened = [];
  try {
    for (const name of archives) {
      const archive = new Asar(asarPath(path, name));
      opened.push(archive);
      verifyASAR(archive, plist, name);
    }
    return opened;
  } catch (error) {
    for (const archive of opened) archive.close();
    throw error;
  }
}

function snapshot(source, opened) {
  return {
    version: source.version,
    build: source.build,
    architectures: source.architectures,
    asarHeaders: Object.fromEntries(archives.map((name, index) => [name, opened[index].headerHash]))
  };
}

function sign(app, stripVendorEntitlements = false) {
  const entitlementsXml = run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', app], { stdio: ['ignore', 'pipe', 'ignore'] });
  const stripped = new Set(['com.apple.application-identifier', 'com.apple.developer.team-identifier', 'keychain-access-groups']);
  const scratch = mkdtempSync(join(tmpdir(), 'claude-zh-sign-'));
  try {
    const entitlementsPath = join(scratch, 'entitlements.plist');
    const args = ['--force', '--sign', '-'];
    if (entitlementsXml.trim()) {
      writeFileSync(entitlementsPath, entitlementsXml);
      const entitlements = readPlist(entitlementsPath);
      if (stripVendorEntitlements) {
        for (const key of stripped) delete entitlements[key];
      }
      writePlist(entitlementsPath, entitlements);
      args.push('--entitlements', entitlementsPath);
    }
    run('/usr/bin/codesign', [...args, app]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function customizePlist(plist, permissions) {
  const zhPermissions = new Map(permissions.map(([id, en, zh]) => [id, { en, zh }]));
  let translated = 0;
  const skipped = [];
  for (const [id, { en, zh }] of zhPermissions) {
    if (plist[id] !== en) {
      skipped.push({ id, reason: '原文已变更或已删除' });
      continue;
    }
    plist[id] = zh;
    translated++;
  }
  Object.assign(plist, {
    CFBundleIdentifier: bundleId,
    CFBundleDisplayName: appName,
    CFBundleDevelopmentRegion: 'zh_CN'
  });
  // The Electron package productName remains Claude so profile and storage service names are stable.
  for (const key of [
    'CFBundleURLTypes', 'CFBundleDocumentTypes', 'UTExportedTypeDeclarations',
    'UTImportedTypeDeclarations', 'NSUserActivityTypes', 'ElectronTeamID'
  ]) delete plist[key];
  return { translated, skipped };
}

function processRunning(app) {
  const target = join(realpathSync(app), 'Contents/MacOS/Claude');
  return run('/bin/ps', ['-axo', 'comm=']).split('\n').some(command => command.trim() === target);
}

const copy = (from, to) => run('/usr/bin/ditto', ['--noqtn', from, to]);

function publish(stage, destination) {
  const parent = dirname(destination);
  if (!existsSync(destination)) {
    renameSync(stage, destination);
    return;
  }
  const backupDir = mkdtempSync(join(parent, '.claude-zh-backup-'));
  const previous = join(backupDir, basename(destination));
  try {
    renameSync(destination, previous);
    try {
      renameSync(stage, destination);
    } catch (error) {
      renameSync(previous, destination);
      throw error;
    }
  } finally {
    if (!existsSync(previous) || existsSync(destination)) {
      rmSync(backupDir, { recursive: true, force: true });
    }
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verify(app, receipt) {
  const plist = readBundle(app);
  if (plist.CFBundleIdentifier !== bundleId || plist.CFBundleDisplayName !== appName ||
      plist.CFBundleShortVersionString !== receipt.source.version || plist.CFBundleVersion !== receipt.source.build ||
      plist.CFBundleURLTypes || plist.CFBundleDevelopmentRegion !== 'zh_CN') {
    throw new Error('应用身份、版本或语言信息与构建记录不符');
  }
  const opened = readSourceArchives(app, plist);
  try {
    for (const [index, name] of archives.entries()) {
      const actual = await hashFile(asarPath(app, name));
      if (actual !== receipt.output[name].sha256 || opened[index].headerHash !== receipt.output[name].headerSha256) {
        throw new Error(`构建记录中的 ASAR 指纹不匹配 ${name}`);
      }
    }
    const renderer = opened[1].read('index.html').toString();
    if (!renderer.includes('lang="zh-Hans"') || !renderer.includes('data-i18n-catalogs="zh-Hans:')) {
      throw new Error('内置网页尚未注册简体中文');
    }
    for (const path of [
      'resources/i18n/zh-Hans.json', 'i18n/zh-Hans.json', 'i18n/dynamic/zh-Hans.json'
    ]) {
      const archive = path.startsWith('resources/') ? opened[0] : opened[1];
      if (!/[\u3400-\u9fff]/u.test(archive.read(path).toString())) {
        throw new Error(`找不到简体中文译文 ${path}`);
      }
    }
  } finally {
    for (const archive of opened) archive.close();
  }
  verifyEmbeddedDigest(join(app, electronBinary), plist.ElectronAsarIntegrity, receipt.source.architectures.length);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}

function takeLock(path) {
  try {
    return openSync(path, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`已有操作正在进行或上次异常退出。确认后清理锁文件 ${path}`);
    throw error;
  }
}

async function build(source, opened) {
  const { mergeCatalog, readTuples } = await import('./catalogs.mjs');
  const { patches } = await import('./patches.mjs');
  const state = snapshot(source, opened);
  const { appChanges, webChanges, report } = patches(...opened, baseline);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source.path]);
  mkdirSync(release, { recursive: true });
  const destination = join(release, source.version);
  const lockPath = join(release, `.${source.version}.lock`);
  const lock = takeLock(lockPath);
  let stage;
  try {
    const current = join(destination, appFile);
    if (existsSync(current) && processRunning(current)) throw new Error('请先退出 release 目录中运行的中文版');
    stage = mkdtempSync(join(release, '.build-'));
    const app = join(stage, appFile);
    copy(source.path, app);
    const plistPath = join(app, 'Contents/Info.plist');
    const plist = readPlist(plistPath);
    if (plist.CFBundleShortVersionString !== source.version || plist.CFBundleVersion !== source.build) {
      throw new Error('拷贝时官方应用已更新，请重新构建');
    }
    const originalIntegrity = structuredClone(plist.ElectronAsarIntegrity);
    const output = {};
    for (const [index, replacements] of [appChanges, webChanges].entries()) {
      const name = archives[index];
      const archive = new Asar(asarPath(app, name));
      try {
        verifyASAR(archive, plist, name);
        if (archive.headerHash !== opened[index].headerHash) throw new Error('拷贝时官方 ASAR 已变更');
        const headerSha256 = archive.rewrite(replacements);
        plist.ElectronAsarIntegrity[`Resources/${name}.asar`].hash = headerSha256;
        output[name] = { headerSha256, sha256: await hashFile(asarPath(app, name)) };
      } finally {
        archive.close();
      }
    }
    report.permissions = customizePlist(plist, readTuples('permissions'));
    writePlist(plistPath, plist);

    const localized = join(app, 'Contents/Resources/zh_CN.lproj');
    mkdirSync(localized, { recursive: true });
    const nativeOriginal = join(app, 'Contents/Resources/en.lproj/Localizable.strings');
    const canonical = join(localized, 'Localizable.strings');
    const native = existsSync(canonical) ? readPlist(canonical) : {};
    const merged = mergeCatalog('macos', readPlist(nativeOriginal), native);
    writePlist(canonical, merged.localized);
    report.macOS = merged.report;
    writePlist(join(localized, 'InfoPlist.strings'), { CFBundleDisplayName: appName });
    copyFileSync(join(root, 'translations/THIRD_PARTY_NOTICES.txt'),
      join(app, 'Contents/Resources/claude-zh-translation-notices.txt'));
    // Official provisioning and notarization tickets authenticate the vendor's unmodified bundle.
    for (const file of ['embedded.provisionprofile', 'CodeResources']) {
      rmSync(join(app, 'Contents', file), { force: true });
    }
    updateEmbeddedDigest(join(app, electronBinary), originalIntegrity, plist.ElectronAsarIntegrity,
      source.architectures.length);
    sign(join(app, electronFramework));
    for (const helper of readdirSync(join(app, 'Contents/Frameworks'))) {
      if (/^Claude Helper(?: \(.*\))?\.app$/.test(helper)) {
        sign(join(app, 'Contents/Frameworks', helper), true);
      }
    }
    sign(app, true);
    const receipt = { source: state, adapter: baseline.build, output, translations: report };
    writeFileSync(join(stage, receiptFile), JSON.stringify(receipt, null, 2) + '\n');
    await verify(app, receipt);
    publish(stage, destination);
    console.log(JSON.stringify(receipt, null, 2));
    console.log(join(destination, appFile));
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

async function install(versionDir, receipt) {
  const destination = join('/Applications', appFile);
  const lockPath = '/Applications/.claude-zh-install.lock';
  const lock = takeLock(lockPath);
  let staging;
  try {
    if (existsSync(destination)) {
      if (readBundle(destination).CFBundleIdentifier !== bundleId) {
        throw new Error(`安装位置已被其他应用使用 ${destination}`);
      }
      if (processRunning(destination)) throw new Error('请先退出正在运行的 Claude 中文版');
    }
    staging = mkdtempSync('/Applications/.claude-zh-install-');
    const candidate = join(staging, appFile);
    copy(join(versionDir, appFile), candidate);
    await verify(candidate, receipt);
    if (existsSync(destination) && processRunning(destination)) throw new Error('请先退出正在运行的 Claude 中文版');
    publish(candidate, destination);
    console.log(destination);
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

async function createDMG(versionDir, receipt) {
  const working = mkdtempSync(join(versionDir, '.dmg-'));
  try {
    const payload = join(working, 'payload');
    mkdirSync(payload);
    copy(join(versionDir, appFile), join(payload, appFile));
    symlinkSync('/Applications', join(payload, 'Applications'));
    const name = `Claude-zh-Hans-${receipt.source.version}.dmg`;
    const candidate = join(working, name);
    run('/usr/bin/hdiutil', ['create', '-quiet', '-format', 'UDZO', '-volname', appName, '-srcfolder', payload, candidate]);
    run('/usr/bin/hdiutil', ['verify', candidate]);
    const destination = join(versionDir, name);
    renameSync(candidate, destination);
    console.log(destination);
  } finally {
    rmSync(working, { recursive: true, force: true });
  }
}

try {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('请使用 macOS 和 Node.js 22 或更新版本');
  }
  const [command, rawArg, ...rest] = process.argv.slice(2);
  if (rest.length || !['check-version', 'inspect', 'build', 'verify', 'install', 'dmg'].includes(command)) {
    throw new Error('用法 npm run check-version|inspect|build -- [官方应用路径] 或 npm run verify|install:app|dmg -- [桌面版本]');
  }
  if (command === 'check-version') {
    checkVersion(sourceInfo(resolve(rawArg ?? officialApp)));
  } else if (command === 'inspect' || command === 'build') {
    const source = sourceInfo(resolve(rawArg ?? officialApp));
    const opened = readSourceArchives(source.path, source.plist);
    try {
      if (command === 'inspect') console.log(JSON.stringify(snapshot(source, opened), null, 2));
      else await build(source, opened);
    } finally {
      for (const archive of opened) archive.close();
    }
  } else {
    const version = rawArg ?? sourceInfo(officialApp).version;
    if (!/^\d+(?:\.\d+){2,3}$/.test(version)) throw new Error('无效的桌面版本号');
    const versionDir = join(release, version);
    const receipt = JSON.parse(readFileSync(join(versionDir, receiptFile)));
    const app = join(versionDir, appFile);
    await verify(app, receipt);
    if (command === 'install') await install(versionDir, receipt);
    else if (command === 'dmg') await createDMG(versionDir, receipt);
    else console.log(`已通过签名、ASAR 完整性与语言注册检查 ${app}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
