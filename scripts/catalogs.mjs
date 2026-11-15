import { readFileSync } from 'node:fs';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';

const project = new URL('../translations/', import.meta.url);

export function readTuples(name) {
  const file = new URL(name + '.jsonl', project);
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function structure(nodes) {
  return nodes.filter(node => node.type !== TYPE.literal).map(node => {
    if (node.type === TYPE.tag) return [node.type, node.value, structure(node.children)];
    if (node.type === TYPE.select || node.type === TYPE.plural) {
      const branches = Object.keys(node.options).sort().map(key => [key, structure(node.options[key].value)]);
      return [node.type, node.value, node.offset, node.pluralType, branches];
    }
    return [node.type, node.value, node.style];
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function checkMessage(source, translation) {
  const before = structure(parse(source));
  const after = structure(parse(translation));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('ICU 参数、分支或标记不一致');
}

export function mergeCatalog(label, english, official = {}, secondary = {}, ...additionalCatalogs) {
  const localized = { ...english };
  const report = { entries: Object.keys(english).length, official: 0, supplemental: 0, english: 0, skipped: [] };
  for (const [id, original] of Object.entries(english)) {
    const translation = official[id] ?? secondary[id];
    if (typeof translation === 'string' && translation && translation !== original) {
      localized[id] = translation;
      report.official++;
    }
  }
  const seen = new Set();
  for (const [id, source, translation] of [label, ...additionalCatalogs].flatMap(readTuples)) {
    if (seen.has(id)) throw new Error(`${label}: 重复词条 ${id}`);
    seen.add(id);
    if (english[id] !== source) {
      report.skipped.push({ id, reason: Object.hasOwn(english, id) ? '原文已变更' : '词条已删除' });
      continue;
    }
    if (localized[id] !== source) continue;
    if (typeof translation !== 'string' || !translation || translation === source) {
      throw new Error(`${label}/${id}: 缺少有效译文`);
    }
    try {
      checkMessage(source, translation);
    } catch (error) {
      throw new Error(`${label}/${id}: ${error.message}`, { cause: error });
    }
    localized[id] = translation;
    report.supplemental++;
  }
  report.english = report.entries - report.official - report.supplemental;
  return { localized, report };
}

export function readCatalog(archive, path, optional = false) {
  if (optional && !archive.entries.has(path)) return {};
  const catalog = JSON.parse(archive.read(path));
  if (!catalog || Array.isArray(catalog) || Object.values(catalog).some(text => typeof text !== 'string')) {
    throw new Error(`未知词库格式 ${path}`);
  }
  return catalog;
}
