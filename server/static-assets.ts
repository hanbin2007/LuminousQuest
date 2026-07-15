import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getAsset, getAssetKeys, isSea } from 'node:sea';

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function safeAssetPath(requestPath: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const normalized = path.posix.normalize(decoded).replace(/^\/+/, '');
  if (normalized.startsWith('..')) return null;
  return normalized || 'index.html';
}

async function readEmbeddedAsset(relativePath: string) {
  const key = `client/${relativePath}`;
  if (!getAssetKeys().includes(key)) return null;
  return new Uint8Array(getAsset(key));
}

async function readDiskAsset(clientRoot: string, relativePath: string) {
  const absoluteRoot = path.resolve(clientRoot);
  const absoluteFile = path.resolve(clientRoot, relativePath);
  if (absoluteFile !== absoluteRoot && !absoluteFile.startsWith(`${absoluteRoot}${path.sep}`)) {
    return null;
  }
  try {
    return await readFile(absoluteFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function loadStaticAsset(clientRoot: string, requestPath: string) {
  const relativePath = safeAssetPath(requestPath);
  if (!relativePath) return null;
  const load = isSea()
    ? (candidate: string) => readEmbeddedAsset(candidate)
    : (candidate: string) => readDiskAsset(clientRoot, candidate);
  const direct = await load(relativePath);
  const selectedPath = direct ? relativePath : 'index.html';
  const body = direct ?? (await load(selectedPath));
  if (!body) return null;

  return {
    body,
    contentType: mimeTypes[path.extname(selectedPath).toLowerCase()] ?? 'application/octet-stream',
    isIndex: selectedPath === 'index.html',
  };
}

