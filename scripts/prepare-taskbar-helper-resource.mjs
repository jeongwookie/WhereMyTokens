import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourceDir = path.join(root, 'taskbar-helper', 'bin');
const source = path.join(sourceDir, 'WhereMyTokens.Taskbar.exe');
const helperSourceFiles = [
  path.join(root, 'taskbar-helper', 'Program.cs'),
  path.join(root, 'taskbar-helper', 'WhereMyTokens.Taskbar.csproj'),
];
const targetDir = path.join(root, 'dist', 'taskbar-helper');
const target = path.join(targetDir, 'WhereMyTokens.Taskbar.exe');
const marker = path.join(targetDir, 'README.txt');
const allowedArtifacts = new Set(['WhereMyTokens.Taskbar.exe']);

function writeMarker(message) {
  if (fs.existsSync(target)) fs.rmSync(target);
  fs.writeFileSync(marker, message, 'utf8');
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

if (fs.existsSync(source)) {
  let staleHelper = false;
  // 일반 build는 기존 helper 산출물만 복사하고, pack/dist는 이 단계 전에 self-contained helper를 다시 publish한다.
  // 배포에는 단일 EXE만 허용해서 ignored bin 폴더의 임시 파일이 release에 섞이지 않게 한다.
  const newestSourceTime = helperSourceFiles
    .filter(file => fs.existsSync(file))
    .map(file => fs.statSync(file).mtimeMs)
    .reduce((latest, mtime) => Math.max(latest, mtime), 0);
  if (newestSourceTime > 0) {
    const exeTime = fs.statSync(source).mtimeMs;
    console.log(`[prepare-taskbar-helper-resource] using published helper from ${new Date(exeTime).toISOString()}`);
    if (exeTime < newestSourceTime) {
      console.warn(
        '[prepare-taskbar-helper-resource] WARNING: taskbar-helper/bin/WhereMyTokens.Taskbar.exe is older ' +
          `than taskbar-helper sources (${new Date(newestSourceTime).toISOString()}). Run ` +
          '`npm run build:taskbar-helper` before packaging or this build will ship a stale helper.',
      );
      staleHelper = true;
    }
  }
  if (staleHelper) {
    writeMarker('Optional taskbar helper artifact is stale. Run npm run build:taskbar-helper to include a current helper artifact.\n');
  } else {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!allowedArtifacts.has(entry.name)) continue;
      fs.copyFileSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
    }
  }
} else {
  writeMarker('Optional taskbar helper artifact not built. Run npm run build:taskbar-helper to include taskbar helper publish artifacts.\n');
}
