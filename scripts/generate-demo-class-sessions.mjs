import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(projectRoot, 'tests', 'fixtures', 'teacher');
const targetRoot = path.join(projectRoot, 'recordings', 'demo', 'class');

await mkdir(targetRoot, { recursive: true });
for (let index = 1; index <= 3; index += 1) {
  const suffix = String.fromCharCode(96 + index);
  const session = JSON.parse(await readFile(path.join(sourceRoot, `session-${suffix}.json`), 'utf8'));
  session.id = `demo-class-session-${String(index).padStart(2, '0')}`;
  session.anonymousStudentId = `anon-DEMO${String(index).padStart(4, '0')}`;
  const target = path.join(targetRoot, `student-${String(index).padStart(2, '0')}.json`);
  await writeFile(target, `${JSON.stringify(session, null, 2)}\n`);
  console.log(path.relative(projectRoot, target));
}
