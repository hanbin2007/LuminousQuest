import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function listFiles(root, relativeDirectory = '') {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relativePath));
    else if (entry.isFile() && entry.name !== '.DS_Store') files.push(relativePath);
  }
  return files.sort();
}

async function sha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  return hash.digest('hex');
}

/**
 * @param {{ root: string, outputFile: string, pathPrefix: string }} options
 */
export async function writeSha256Manifest({ root, outputFile, pathPrefix }) {
  const files = await listFiles(root);
  const entries = await Promise.all(files.map(async (relativePath) => ({
    sha256: await sha256(path.join(root, relativePath)),
    path: path.posix.join(pathPrefix, relativePath.split(path.sep).join('/')),
  })));
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(
    outputFile,
    `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`,
  );
  return entries;
}
