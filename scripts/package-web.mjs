import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.resolve(process.argv[2] || path.join(ROOT, '..', 'artifacts'));
const NAME = 'checkin-assistant';
const FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile', 'docker-compose.yml',
  '.dockerignore', '.env.example', '.gitignore', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'CONTRIBUTING.md',
  'docs/deploy-1panel.md', 'docs/web-verification.md', 'deploy/entrypoint.sh', 'deploy/healthcheck.mjs', 'deploy/nginx-location.conf',
  'scripts/package-web.mjs'];
const DIRECTORIES = ['server', 'web', 'browser-extension', 'tests-node', 'docs/images', '.github'];
const EXCLUDED = new Set(['web/remote.js', 'web/remote.css', 'tests-node/local-connector.test.ts',
  'tests-node/local-connector.legacy-test.ts', 'tests-node/local-connector-smoke.mjs']);
const EXECUTABLES = new Set(['deploy/entrypoint.sh']);

async function walk(directory, root = ROOT) {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const file = path.posix.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Source package refuses symlink: ${file}`);
    if (entry.isDirectory()) result.push(...await walk(file, root));
    else if (entry.isFile() && !EXCLUDED.has(file)) result.push(file);
  }
  return result;
}

async function command(binary, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: ROOT, env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${binary} failed (${code}): ${errorText}`)));
  });
}

const sha256 = data => createHash('sha256').update(data).digest('hex');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'checkin-node-package-'));
try {
  await mkdir(OUTPUT, { recursive: true });
  const sources = [...FILES, ...(await Promise.all(DIRECTORIES.map(directory => walk(directory)))).flat()].sort();
  assert.equal(new Set(sources).size, sources.length);
  for (const file of sources) {
    assert.ok(!/(?:^|\/)(?:backend|data|node_modules|dist-server|build|\.git)(?:\/|$)|\.py(?:c|o)?$|\.db(?:-|$)|\.key$|(?:^|\/)\.env(?:\.|$)/.test(file)
      || file === '.env.example', `Source package refuses private or historical runtime file: ${file}`);
  }
  const staged = path.join(temporary, NAME);
  await mkdir(staged);
  const manifest = [];
  for (const file of sources) {
    const source = path.join(ROOT, file), target = path.join(staged, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    manifest.push(`${sha256(await readFile(target))}  ${file}`);
  }
  const manifestText = manifest.join('\n') + '\n';
  await writeFile(path.join(staged, 'SOURCE-MANIFEST.sha256'), manifestText);
  for (const file of EXECUTABLES) await chmod(path.join(staged, file), 0o755);
  const contents = [...sources, 'SOURCE-MANIFEST.sha256'].sort();
  const zipPath = path.join(OUTPUT, 'checkin-assistant-1panel.zip');
  const tarPath = path.join(OUTPUT, 'checkin-assistant-1panel.tar.gz');
  const zip = new yazl.ZipFile();
  for (const file of contents) zip.addFile(path.join(staged, file), `${NAME}/${file}`,
    { mode: EXECUTABLES.has(file) ? 0o100755 : 0o100644 });
  const zipWriting = pipeline(zip.outputStream, createWriteStream(zipPath));
  zip.end(); await zipWriting;
  await command('tar', ['-czf', tarPath, '-C', temporary, NAME]);
  for (const [format, archive] of [['zip', zipPath], ['tar', tarPath]]) {
    const extracted = path.join(temporary, format); await mkdir(extracted);
    await command(format === 'zip' ? 'unzip' : 'tar', format === 'zip' ? ['-q', archive, '-d', extracted] : ['-xzf', archive, '-C', extracted]);
    const actual = (await walk(NAME, extracted)).map(file => file.slice(NAME.length + 1)).sort();
    assert.deepEqual(actual, contents, `${format} source file list`);
    for (const file of contents) assert.deepEqual(await readFile(path.join(extracted, NAME, file)), await readFile(path.join(staged, file)), `${format} source bytes: ${file}`);
    for (const entry of manifest) {
      const digest = entry.slice(0, 64), file = entry.slice(66);
      assert.equal(sha256(await readFile(path.join(extracted, NAME, file))), digest, `${format} manifest: ${file}`);
    }
    for (const file of EXECUTABLES) assert.ok((await stat(path.join(extracted, NAME, file))).mode & 0o100, `${format} executable launcher: ${file}`);
  }
  const archives = ['checkin-assistant-1panel.zip', 'checkin-assistant-1panel.tar.gz'];
  await writeFile(path.join(OUTPUT, 'source-manifest.txt'), manifestText);
  await writeFile(path.join(OUTPUT, 'SHA256SUMS'), (await Promise.all(archives.map(async file => `${sha256(await readFile(path.join(OUTPUT, file)))}  ${file}`))).join('\n') + '\n');
  console.log(JSON.stringify({ result: 'passed', output: OUTPUT, source_files: sources.length, archive_files: contents.length,
    verified: ['zip and tar source hashes', 'Node source only', 'private data and retired connector exclusions', 'executable entrypoint',
      'open-source documentation and CI workflows'], archives }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
