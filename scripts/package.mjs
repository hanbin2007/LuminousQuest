import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { writeSha256Manifest } from './release-manifest.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seaRoot = path.join(projectRoot, 'dist', 'sea');
const releaseRoot = path.join(projectRoot, 'release', `${process.platform}-${process.arch}`);
const executableName = process.platform === 'win32' ? 'LuminousQuest.exe' : 'LuminousQuest';
const executablePath = path.join(releaseRoot, executableName);
const releaseManifestPath = path.join(
  projectRoot,
  'dist',
  `release-${process.platform}-${process.arch}.sha256`,
);
const seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${details ? `:\n${details}` : ''}`);
  }
  return result;
}

async function listFiles(root, relativeDirectory = '') {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

function supportsBuiltInSea() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 25 || (major === 25 && minor >= 5);
}

function assertSupportedNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 20)) {
    throw new Error('Packaging requires Node 22.20.0 or newer for the SEA asset API');
  }
}

async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function hasSeaFuse(executable) {
  const contents = await readFile(executable);
  return contents.includes(Buffer.from(seaFuse));
}

function officialNodeArchive() {
  const platform = { darwin: 'darwin', linux: 'linux', win32: 'win' }[process.platform];
  const architecture = { arm64: 'arm64', x64: 'x64' }[process.arch];
  if (!platform || !architecture) {
    throw new Error(`No official Node SEA toolchain mapping for ${process.platform}-${process.arch}`);
  }
  const baseName = `node-v${process.versions.node}-${platform}-${architecture}`;
  return {
    baseName,
    archiveName: `${baseName}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`,
  };
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function acquireOfficialNode() {
  const toolchainRoot = path.join(projectRoot, 'dist', 'toolchain');
  const { baseName, archiveName } = officialNodeArchive();
  const extractedRoot = path.join(toolchainRoot, baseName);
  const targetNode =
    process.platform === 'win32'
      ? path.join(extractedRoot, 'node.exe')
      : path.join(extractedRoot, 'bin', 'node');

  if ((await fileExists(targetNode)) && (await hasSeaFuse(targetNode))) return targetNode;

  await rm(extractedRoot, { recursive: true, force: true });
  await mkdir(toolchainRoot, { recursive: true });
  const archiveFile = path.join(toolchainRoot, archiveName);
  const baseUrl = `https://nodejs.org/dist/v${process.versions.node}`;
  console.log(`[package] Downloading the official SEA-capable Node ${process.versions.node} runtime...`);
  await download(`${baseUrl}/${archiveName}`, archiveFile);
  const checksumsFile = path.join(toolchainRoot, `SHASUMS256-v${process.versions.node}.txt`);
  await download(`${baseUrl}/SHASUMS256.txt`, checksumsFile);

  const checksums = await readFile(checksumsFile, 'utf8');
  const checksumLine = checksums
    .split(/\r?\n/)
    .find((line) => line.trim().endsWith(`  ${archiveName}`));
  if (!checksumLine) throw new Error(`Official checksum is missing for ${archiveName}`);
  const expectedChecksum = checksumLine.trim().split(/\s+/)[0];
  const actualChecksum = createHash('sha256').update(await readFile(archiveFile)).digest('hex');
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`Checksum mismatch for ${archiveName}`);
  }

  if (process.platform === 'win32') {
    const escapedArchive = archiveFile.replaceAll("'", "''");
    const escapedRoot = toolchainRoot.replaceAll("'", "''");
    run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedRoot}' -Force`,
    ]);
  } else {
    run('tar', ['-xzf', archiveFile, '-C', toolchainRoot]);
  }

  if (!(await hasSeaFuse(targetNode))) {
    throw new Error(`Official Node executable does not contain the SEA fuse: ${targetNode}`);
  }
  return targetNode;
}

async function resolveSeaNode() {
  const configured = process.env.LQ_SEA_NODE ? path.resolve(process.env.LQ_SEA_NODE) : null;
  if (configured) {
    if (!(await hasSeaFuse(configured))) {
      throw new Error(`LQ_SEA_NODE does not point to a SEA-capable Node executable: ${configured}`);
    }
    return configured;
  }
  if (await hasSeaFuse(process.execPath)) return process.execPath;
  console.log(`[package] ${process.execPath} is a dynamically linked Node launcher without a SEA fuse.`);
  return acquireOfficialNode();
}

async function buildExecutable(seaConfig) {
  const configFile = path.join(seaRoot, 'sea-config.json');
  const seaNode = await resolveSeaNode();
  const targetVersion = run(seaNode, ['-p', 'process.versions.node']).stdout.trim();
  if (targetVersion !== process.versions.node) {
    throw new Error(
      `SEA builder and target Node versions must match (${process.versions.node} != ${targetVersion})`,
    );
  }

  if (supportsBuiltInSea()) {
    await writeFile(
      configFile,
      `${JSON.stringify(
        {
          ...seaConfig,
          executable: seaNode,
          output: executablePath,
        },
        null,
        2,
      )}\n`,
    );
    run(process.execPath, ['--build-sea', configFile]);
  } else {
    const blobFile = path.join(seaRoot, 'luminous-quest.blob');
    await writeFile(
      configFile,
      `${JSON.stringify({ ...seaConfig, output: blobFile }, null, 2)}\n`,
    );
    run(process.execPath, ['--experimental-sea-config', configFile]);
    await copyFile(seaNode, executablePath);

    if (process.platform === 'darwin') {
      run('codesign', ['--remove-signature', executablePath]);
    }

    const postjectArgs = [
      'exec',
      'postject',
      executablePath,
      'NODE_SEA_BLOB',
      blobFile,
      '--sentinel-fuse',
      seaFuse,
    ];
    if (process.platform === 'darwin') {
      postjectArgs.push('--macho-segment-name', 'NODE_SEA');
    }
    run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', postjectArgs);
  }

  if (process.platform === 'darwin') {
    run('codesign', ['--force', '--sign', '-', executablePath]);
  }
  if (process.platform !== 'win32') await chmod(executablePath, 0o755);
}

async function copyExternalContent() {
  for (const directory of ['config', 'prompts', 'assets', 'recordings']) {
    await cp(path.join(projectRoot, directory), path.join(releaseRoot, directory), {
      recursive: true,
      filter(source) {
        const relative = path.relative(projectRoot, source);
        return !relative.startsWith(path.join('recordings', 'cache')) && !source.endsWith('.DS_Store');
      },
    });
  }

  await copyFile(path.join(projectRoot, '.env.example'), path.join(releaseRoot, '.env'));
  await chmod(path.join(releaseRoot, '.env'), 0o600);
  await copyFile(path.join(projectRoot, 'start.command'), path.join(releaseRoot, 'start.command'));
  await copyFile(path.join(projectRoot, 'start.bat'), path.join(releaseRoot, 'start.bat'));
  if (process.platform !== 'win32') {
    await chmod(path.join(releaseRoot, 'start.command'), 0o755);
  }

  const docsRoot = path.join(releaseRoot, 'docs');
  await mkdir(docsRoot, { recursive: true });
  for (const relativeFile of [
    'docs/superpowers/specs/2026-07-16-competition-runbook.md',
    'docs/superpowers/specs/2026-07-16-lan-security.md',
    'recordings/demo/README.md',
  ]) {
    await copyFile(
      path.join(projectRoot, relativeFile),
      path.join(docsRoot, path.basename(relativeFile)),
    );
  }
}

async function writeReleaseMetadata() {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  let sourceCommit = 'unknown';
  try {
    sourceCommit = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  } catch {
    // Source archives without .git remain packageable but identify the commit as unknown.
  }
  await writeFile(path.join(releaseRoot, 'RELEASE.json'), `${JSON.stringify({
    format: 'luminous-quest-release.v1',
    name: packageJson.name,
    version: packageJson.version,
    platform: process.platform,
    architecture: process.arch,
    runtime: `Node SEA ${process.versions.node}`,
    sourceCommit,
    executable: executableName,
    externalContent: ['config', 'prompts', 'assets', 'recordings', '.env'],
  }, null, 2)}\n`);
}

async function main() {
  assertSupportedNodeVersion();
  if (process.argv.includes('--mac-arm64') && (process.platform !== 'darwin' || process.arch !== 'arm64')) {
    throw new Error(`macOS arm64 packaging requires darwin-arm64, received ${process.platform}-${process.arch}`);
  }
  const clientRoot = path.join(projectRoot, 'dist', 'client');
  const clientFiles = await listFiles(clientRoot);
  if (!clientFiles.includes('index.html')) {
    throw new Error('dist/client/index.html is missing; run pnpm build first');
  }

  await rm(seaRoot, { recursive: true, force: true });
  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(seaRoot, { recursive: true });
  await mkdir(releaseRoot, { recursive: true });

  const serverBundle = path.join(seaRoot, 'server.cjs');
  await build({
    entryPoints: [path.join(projectRoot, 'server', 'index.ts')],
    outfile: serverBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    minify: true,
    sourcemap: false,
    logLevel: 'info',
  });

  const assets = Object.fromEntries(
    clientFiles.map((relativePath) => [
      `client/${relativePath.split(path.sep).join('/')}`,
      path.join(clientRoot, relativePath),
    ]),
  );
  await buildExecutable({
    main: serverBundle,
    mainFormat: 'commonjs',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: 'none',
    assets,
  });
  await copyExternalContent();
  await writeReleaseMetadata();
  const manifestEntries = await writeSha256Manifest({
    root: releaseRoot,
    outputFile: releaseManifestPath,
    pathPrefix: path.posix.join('release', `${process.platform}-${process.arch}`),
  });

  console.log(`[package] Runtime: Node SEA ${process.versions.node}`);
  console.log(`[package] Executable: ${executablePath}`);
  console.log(`[package] External content: ${releaseRoot}`);
  console.log(`[package] Frozen manifest: ${releaseManifestPath} (${manifestEntries.length} files)`);
}

main().catch((error) => {
  console.error(`[package] ${(error).message}`);
  process.exitCode = 1;
});
