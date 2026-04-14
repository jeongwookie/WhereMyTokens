import esbuild from 'esbuild';
import { mkdirSync, copyFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// dist/renderer 디렉토리 생성
mkdirSync(join(root, 'dist', 'renderer'), { recursive: true });

// React 번들링
await esbuild.build({
  entryPoints: [join(root, 'src', 'renderer', 'index.tsx')],
  bundle: true,
  outfile: join(root, 'dist', 'renderer', 'app.js'),
  platform: 'browser',
  target: 'chrome130',
  minify: false,
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

// Noto Sans 폰트 복사 (400, 700 weight WOFF2 + CSS만)
const fontsDir = join(root, 'dist', 'renderer', 'fonts');
for (const pkg of ['noto-sans', 'noto-sans-kr', 'noto-sans-jp', 'jetbrains-mono']) {
  const src = join(root, 'node_modules', '@fontsource', pkg);
  const dst = join(fontsDir, pkg);
  mkdirSync(join(dst, 'files'), { recursive: true });
  for (const weight of ['400', '700']) {
    copyFileSync(join(src, `${weight}.css`), join(dst, `${weight}.css`));
  }
  for (const file of readdirSync(join(src, 'files'))) {
    if (file.endsWith('.woff2')) {
      copyFileSync(join(src, 'files', file), join(dst, 'files', file));
    }
  }
}

// HTML 복사
copyFileSync(
  join(root, 'src', 'renderer', 'index.html'),
  join(root, 'dist', 'renderer', 'index.html')
);

console.log('렌더러 빌드 완료');
