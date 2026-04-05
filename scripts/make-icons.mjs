/**
 * make-icons.mjs
 * source-icon.png (흰 배경 + 검정 라인아트) →
 *   assets/icon.png        (32×32, 트레이용)
 *   assets/icon-256.png    (256×256, 앱 아이콘용)
 *   assets/icon.ico        (16/32/48/256 멀티사이즈 ICO, EXE 아이콘)
 */

import { createRequire } from 'module';
import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const Jimp = require('jimp');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'assets', 'source-icon.png');

// --- 1. 원본 로드 + 흰 배경 → 투명 처리 ---
const img = await Jimp.read(SRC);
const WHITE_THRESHOLD = 220; // 이 이상 밝으면 투명 처리

img.scan(0, 0, img.bitmap.width, img.bitmap.height, (x, y, idx) => {
  const r = img.bitmap.data[idx];
  const g = img.bitmap.data[idx + 1];
  const b = img.bitmap.data[idx + 2];
  // 흰색에 가까운 픽셀 → 투명
  if (r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD) {
    img.bitmap.data[idx + 3] = 0; // alpha = 0
  }
});

// --- 2. PNG 출력 (32px 트레이, 256px 앱아이콘) ---
const tray = img.clone().resize(32, 32);
await tray.writeAsync(join(ROOT, 'assets', 'icon.png'));
console.log('✓ assets/icon.png (32×32)');

const large = img.clone().resize(256, 256);
await large.writeAsync(join(ROOT, 'assets', 'icon-256.png'));
console.log('✓ assets/icon-256.png (256×256)');

// --- 3. ICO 생성 (16/32/48/256) ---
// ICO 포맷: ICONDIR + ICONDIRENTRY[] + image data
const sizes = [16, 32, 48, 256];
const pngBuffers = await Promise.all(
  sizes.map(async (s) => {
    const clone = img.clone().resize(s, s);
    // PNG 버퍼로 직렬화
    return clone.getBufferAsync(Jimp.MIME_PNG);
  })
);

// ICO 헤더
const count = sizes.length;
const headerSize = 6;
const entrySize = 16;
const dirSize = headerSize + entrySize * count;

// 각 이미지 오프셋 계산
const offsets = [];
let offset = dirSize;
for (const buf of pngBuffers) {
  offsets.push(offset);
  offset += buf.length;
}

const totalSize = offset;
const ico = Buffer.alloc(totalSize);

// ICONDIR
ico.writeUInt16LE(0, 0);        // reserved
ico.writeUInt16LE(1, 2);        // type: 1 = ICO
ico.writeUInt16LE(count, 4);    // count

// ICONDIRENTRY × count
for (let i = 0; i < count; i++) {
  const base = headerSize + i * entrySize;
  const s = sizes[i];
  ico.writeUInt8(s >= 256 ? 0 : s, base);      // width  (0 = 256)
  ico.writeUInt8(s >= 256 ? 0 : s, base + 1);  // height (0 = 256)
  ico.writeUInt8(0, base + 2);   // color count (0 = no palette)
  ico.writeUInt8(0, base + 3);   // reserved
  ico.writeUInt16LE(1, base + 4); // planes
  ico.writeUInt16LE(32, base + 6); // bit count
  ico.writeUInt32LE(pngBuffers[i].length, base + 8);  // size
  ico.writeUInt32LE(offsets[i], base + 12);            // offset
}

// 이미지 데이터
for (let i = 0; i < count; i++) {
  pngBuffers[i].copy(ico, offsets[i]);
}

writeFileSync(join(ROOT, 'assets', 'icon.ico'), ico);
console.log('✓ assets/icon.ico (16/32/48/256px multi-size)');
