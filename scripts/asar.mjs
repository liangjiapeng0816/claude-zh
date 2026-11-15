import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { posix } from 'node:path';

export const sha256 = data => createHash('sha256').update(data).digest('hex');

function readBytes(fd, size, position) {
  const data = Buffer.allocUnsafe(size);
  let read = 0;
  while (read < size) {
    const count = readSync(fd, data, read, size - read, position + read);
    if (!count) throw new Error('ASAR 文件提前结束');
    read += count;
  }
  return data;
}

function writeBytes(fd, data) {
  let written = 0;
  while (written < data.length) {
    const count = writeSync(fd, data, written, data.length - written);
    if (!count) throw new Error('无法写入 ASAR');
    written += count;
  }
}

function* walk(files, base = '') {
  for (const [name, entry] of Object.entries(files)) {
    const path = base + name;
    if (entry.files) yield* walk(entry.files, path + '/');
    else yield [path, entry];
  }
}

export class Asar {
  constructor(path) {
    this.path = path;
    this.fd = openSync(path, 'r');
    try {
      const prefix = readBytes(this.fd, 16, 0);
      const headerSize = prefix.readUInt32LE(4);
      const jsonSize = prefix.readUInt32LE(12);
      this.dataOffset = headerSize + 8;
      if (prefix.readUInt32LE(0) !== 4 || headerSize !== prefix.readUInt32LE(8) + 4 ||
          headerSize % 4 || headerSize < 8 || jsonSize > headerSize - 8 ||
          headerSize - 8 - jsonSize > 3 || this.dataOffset > fstatSync(this.fd).size) {
        throw new Error('不支持的 ASAR 头部');
      }
      const header = readBytes(this.fd, jsonSize, 16);
      this.headerHash = sha256(header);
      this.header = JSON.parse(header);
      this.entries = new Map(walk(this.header.files));
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    closeSync(this.fd);
  }

  read(path) {
    const entry = this.entries.get(path);
    const offset = Number(entry?.offset);
    if (!entry || entry.unpacked || entry.link || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`ASAR 中没有可读条目 ${path}`);
    }
    return readBytes(this.fd, entry.size, this.dataOffset + offset);
  }

  rewrite(replacements) {
    const header = structuredClone(this.header);
    for (const path of replacements.keys()) {
      const original = this.entries.get(path);
      if (original && (original.unpacked || original.link)) {
        throw new Error(`无法修改解包文件或链接 ${path}`);
      }
      const parts = path.split('/');
      const name = parts.pop();
      let files = header.files;
      for (const folder of parts) {
        if (!files[folder]?.files) throw new Error(`ASAR 目录已变更 ${posix.dirname(path)}`);
        files = files[folder].files;
      }
      files[name] ??= {};
    }
    let offset = 0;
    const packed = [];
    for (const [path, entry] of walk(header.files)) {
      if (entry.unpacked || entry.link) continue;
      const replacement = replacements.get(path);
      if (replacement) {
        entry.size = replacement.length;
        const blockSize = entry.integrity?.blockSize ?? 4 * 1024 * 1024;
        const blocks = [];
        for (let start = 0; start < entry.size || start === 0; start += blockSize) {
          blocks.push(sha256(replacement.subarray(start, start + blockSize)));
        }
        entry.integrity = { algorithm: 'SHA256', hash: sha256(replacement), blockSize, blocks };
      }
      entry.offset = String(offset);
      offset += entry.size;
      packed.push(path);
    }
    const json = Buffer.from(JSON.stringify(header));
    const padding = (4 - json.length % 4) % 4;
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(8 + json.length + padding, 4);
    prefix.writeUInt32LE(4 + json.length + padding, 8);
    prefix.writeUInt32LE(json.length, 12);
    const temp = this.path + '.tmp';
    const fd = openSync(temp, 'wx');
    try {
      for (const bytes of [prefix, json, Buffer.alloc(padding)]) writeBytes(fd, bytes);
      for (const path of packed) writeBytes(fd, replacements.get(path) ?? this.read(path));
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
    return sha256(json);
  }
}
