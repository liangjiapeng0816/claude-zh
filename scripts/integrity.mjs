import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';

// Electron seals the sorted ASAR integrity dictionary inside each Mach-O architecture.
const marker = Buffer.from('AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A');

function dictionaryDigest(integrity) {
  const hash = createHash('sha256');
  for (const key of Object.keys(integrity).sort()) {
    const { algorithm, hash: value } = integrity[key];
    hash.update(key).update(algorithm).update(value);
  }
  return hash.digest();
}

function slots(path, integrity, architectureCount) {
  const binary = readFileSync(path);
  const expected = dictionaryDigest(integrity);
  const positions = [];
  for (let at = binary.indexOf(marker); at !== -1; at = binary.indexOf(marker, at + marker.length)) {
    const start = at + marker.length;
    if (binary[start] === 1 && binary[start + 1] === 1 &&
        binary.subarray(start + 2, start + 34).equals(expected)) positions.push(start + 2);
  }
  if (positions.length !== architectureCount) {
    throw new Error(`Electron 内嵌完整性摘要不符，预期 ${architectureCount} 处，发现 ${positions.length} 处`);
  }
  return positions;
}

export function verifyEmbeddedDigest(path, integrity, architectureCount) {
  slots(path, integrity, architectureCount);
}

export function updateEmbeddedDigest(path, original, updated, architectureCount) {
  const positions = slots(path, original, architectureCount);
  const digest = dictionaryDigest(updated);
  const fd = openSync(path, 'r+');
  try {
    for (const offset of positions) {
      if (writeSync(fd, digest, 0, digest.length, offset) !== digest.length) {
        throw new Error('无法写入 Electron 内嵌摘要');
      }
    }
  } finally {
    closeSync(fd);
  }
}
