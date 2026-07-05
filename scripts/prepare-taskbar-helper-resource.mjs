import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourceDir = path.join(root, 'taskbar-helper', 'bin');
const source = path.join(sourceDir, 'WhereMyTokens.Taskbar.exe');
const sourceProgram = path.join(root, 'taskbar-helper', 'Program.cs');
const targetDir = path.join(root, 'dist', 'taskbar-helper');
const target = path.join(targetDir, 'WhereMyTokens.Taskbar.exe');
const marker = path.join(targetDir, 'README.txt');

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

if (fs.existsSync(source)) {
  // `npm run build` / `pack` / `dist` never invoke `dotnet publish` themselves (the plan keeps that
  // toolchain optional) — this step only copies whatever already sits in taskbar-helper/bin. Print
  // the published DLL's timestamp on every run so a binary that predates the last Program.cs edit is
  // visible in the build log instead of being silently repackaged.
  const publishedDll = path.join(sourceDir, 'WhereMyTokens.Taskbar.dll');
  if (fs.existsSync(publishedDll) && fs.existsSync(sourceProgram)) {
    const dllTime = fs.statSync(publishedDll).mtimeMs;
    const sourceTime = fs.statSync(sourceProgram).mtimeMs;
    console.log(`[prepare-taskbar-helper-resource] using published helper from ${new Date(dllTime).toISOString()}`);
    if (dllTime < sourceTime) {
      console.warn(
        '[prepare-taskbar-helper-resource] WARNING: taskbar-helper/bin/WhereMyTokens.Taskbar.dll is older ' +
          `than taskbar-helper/Program.cs (${new Date(sourceTime).toISOString()}). Run ` +
          '`npm run build:taskbar-helper` before packaging or this build will ship a stale helper.',
      );
    }
  }
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
  }
} else {
  if (fs.existsSync(target)) fs.rmSync(target);
  fs.writeFileSync(
    marker,
    'Optional taskbar helper artifact not built. Run npm run build:taskbar-helper to include taskbar helper publish artifacts.\n',
    'utf8',
  );
}
