/**
 * WhereMyTokens 앱 아이콘 생성 (32×32 PNG, 순수 Node.js)
 * 😱 공포에 절규하는 얼굴 (Apple iOS 스타일)
 */
import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CRC-32
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(d.length);
  const crc = Buffer.allocUnsafe(4); crc.writeUInt32BE(crc32(Buffer.concat([t, d])));
  return Buffer.concat([len, t, d, crc]);
}

const S = 32;
const px = new Uint8Array(S * S * 4); // 투명으로 초기화

function sp(x, y, r, g, b, a = 255) {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || xi >= S || yi < 0 || yi >= S) return;
  const i = (yi * S + xi) * 4;
  px[i] = r; px[i+1] = g; px[i+2] = b; px[i+3] = a;
}

// 부드러운 안티앨리어싱 점
function spAA(x, y, r, g, b) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const blend = (tx, ty, alpha) => {
    if (tx < 0 || tx >= S || ty < 0 || ty >= S) return;
    const i = (ty * S + tx) * 4;
    const a = alpha / 255;
    px[i]   = Math.round(px[i]   * (1-a) + r * a);
    px[i+1] = Math.round(px[i+1] * (1-a) + g * a);
    px[i+2] = Math.round(px[i+2] * (1-a) + b * a);
    px[i+3] = Math.min(255, px[i+3] + Math.round(alpha * (1 - px[i+3]/255)));
  };
  blend(x0,   y0,   Math.round((1-fx)*(1-fy)*255));
  blend(x0+1, y0,   Math.round(fx*(1-fy)*255));
  blend(x0,   y0+1, Math.round((1-fx)*fy*255));
  blend(x0+1, y0+1, Math.round(fx*fy*255));
}

function ellipse(cx, cy, rx, ry, r, g, b, a = 255) {
  const x0 = Math.max(0, Math.floor(cx - rx - 1));
  const x1 = Math.min(S-1, Math.ceil(cx + rx + 1));
  const y0 = Math.max(0, Math.floor(cy - ry - 1));
  const y1 = Math.min(S-1, Math.ceil(cy + ry + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx*dx + dy*dy <= 1) sp(x, y, r, g, b, a);
    }
  }
}

// ── 얼굴 (연한 노랑, iOS 😱 스타일) ──────────────────────────────
// 외곽선 (어두운 노랑-갈색)
ellipse(15.5, 15.5, 15.5, 15.5, 180, 120, 0);
// 얼굴 채우기 (밝은 크림-노랑: 공포에 창백해진 느낌)
ellipse(15.5, 15.5, 14.5, 14.5, 252, 218, 100);
// 약간 밝은 중심 (입체감)
ellipse(15.5, 13, 9, 9, 255, 228, 120, 180);

// ── 눈썹 (올라간 - 공포 표정) ─────────────────────────────────────
// 왼쪽 눈썹: 바깥쪽이 더 높음 (공포에 올라간 형태)
for (let x = 6; x <= 13; x++) {
  const t = (x - 6) / 7;
  // 안쪽(오른쪽)이 낮고 바깥쪽(왼쪽)이 높은 형태
  const y = 7 + t * 3 - Math.sin(t * Math.PI * 0.7) * 2;
  spAA(x, y,   60, 35, 5);
  spAA(x, y+1, 60, 35, 5);
}
// 오른쪽 눈썹: 대칭
for (let x = 19; x <= 26; x++) {
  const t = (x - 19) / 7;
  const y = 10 - t * 3 + Math.sin((1-t) * Math.PI * 0.7) * 2;
  spAA(x, y,   60, 35, 5);
  spAA(x, y+1, 60, 35, 5);
}

// ── 눈 (크게 뜬 - 공포) ───────────────────────────────────────────
// 왼쪽 눈
ellipse(11, 14.5, 4, 5, 255, 255, 255);     // 흰자
ellipse(11, 14.5, 2.2, 2.8, 60, 35, 15);   // 홍채 (갈색)
ellipse(11, 14.5, 1.2, 1.5, 15, 10, 5);    // 동공
sp(9.5, 13, 255, 255, 255);                  // 하이라이트

// 오른쪽 눈
ellipse(21, 14.5, 4, 5, 255, 255, 255);
ellipse(21, 14.5, 2.2, 2.8, 60, 35, 15);
ellipse(21, 14.5, 1.2, 1.5, 15, 10, 5);
sp(19.5, 13, 255, 255, 255);

// ── 입 (크게 벌린 O형 - 절규) ────────────────────────────────────
ellipse(15.5, 24, 6.5, 5, 100, 50, 20);    // 입 외곽 (어두운 갈색)
ellipse(15.5, 24, 5.5, 4, 40, 10, 10);     // 입 안쪽 (진한 어두움)
ellipse(15.5, 23, 5, 3, 20, 5, 5);         // 목구멍 (가장 어두움)
// 위 이 (흰색 줄)
for (let x = 12; x <= 19; x++) sp(x, 20, 245, 240, 230);
// 아래 이
for (let x = 12; x <= 19; x++) sp(x, 27, 245, 240, 230);

// PNG 조립
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.allocUnsafe(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = [];
for (let y = 0; y < S; y++) {
  raw.push(0);
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    raw.push(px[i], px[i+1], px[i+2], px[i+3]);
  }
}

const png = Buffer.concat([
  sig,
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', deflateSync(Buffer.from(raw))),
  pngChunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(path.join(__dirname, '..', 'assets'), { recursive: true });
const outPath = path.join(__dirname, '..', 'assets', 'icon.png');
writeFileSync(outPath, png);

// 256×256 버전 생성 (electron-builder Windows 앱 아이콘용)
{
  const S2 = 256;
  const scale = S2 / S;
  const px2 = new Uint8Array(S2 * S2 * 4);

  function sp2(x, y, r, g, b, a = 255) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || xi >= S2 || yi < 0 || yi >= S2) return;
    const i = (yi * S2 + xi) * 4;
    px2[i] = r; px2[i+1] = g; px2[i+2] = b; px2[i+3] = a;
  }

  function ellipse2(cx, cy, rx, ry, r, g, b, a = 255) {
    const x0 = Math.max(0, Math.floor(cx - rx - 1));
    const x1 = Math.min(S2-1, Math.ceil(cx + rx + 1));
    const y0 = Math.max(0, Math.floor(cy - ry - 1));
    const y1 = Math.min(S2-1, Math.ceil(cy + ry + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx*dx + dy*dy <= 1) sp2(x, y, r, g, b, a);
      }
    }
  }

  const C = 127.5, R = 124;
  ellipse2(C, C, R, R, 180, 120, 0);
  ellipse2(C, C, R-8, R-8, 252, 218, 100);
  ellipse2(C, 104, 72, 72, 255, 228, 120, 180);

  // 눈썹
  for (let x = 48; x <= 104; x++) {
    const t2 = (x - 48) / 56;
    const y2 = 56 + t2 * 24 - Math.sin(t2 * Math.PI * 0.7) * 16;
    for (let dy = 0; dy < 8; dy++) sp2(x, y2 + dy, 60, 35, 5);
  }
  for (let x = 152; x <= 208; x++) {
    const t2 = (x - 152) / 56;
    const y2 = 80 - t2 * 24 + Math.sin((1-t2) * Math.PI * 0.7) * 16;
    for (let dy = 0; dy < 8; dy++) sp2(x, y2 + dy, 60, 35, 5);
  }

  // 눈
  ellipse2(88, 116, 32, 40, 255, 255, 255);
  ellipse2(88, 116, 18, 22, 60, 35, 15);
  ellipse2(88, 116, 10, 12, 15, 10, 5);
  ellipse2(168, 116, 32, 40, 255, 255, 255);
  ellipse2(168, 116, 18, 22, 60, 35, 15);
  ellipse2(168, 116, 10, 12, 15, 10, 5);

  // 입
  ellipse2(C, 192, 52, 40, 100, 50, 20);
  ellipse2(C, 192, 44, 32, 40, 10, 10);
  ellipse2(C, 184, 40, 24, 20, 5, 5);
  for (let x = 96; x <= 160; x++) { sp2(x, 160, 245, 240, 230); sp2(x, 216, 245, 240, 230); }

  const raw2 = [];
  for (let y = 0; y < S2; y++) {
    raw2.push(0);
    for (let x = 0; x < S2; x++) {
      const i = (y * S2 + x) * 4;
      raw2.push(px2[i], px2[i+1], px2[i+2], px2[i+3]);
    }
  }
  const ihdr2 = Buffer.allocUnsafe(13);
  ihdr2.writeUInt32BE(S2, 0); ihdr2.writeUInt32BE(S2, 4);
  ihdr2[8] = 8; ihdr2[9] = 6; ihdr2[10] = 0; ihdr2[11] = 0; ihdr2[12] = 0;
  const png256 = Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr2),
    pngChunk('IDAT', deflateSync(Buffer.from(raw2))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path.join(__dirname, '..', 'assets', 'icon-256.png'), png256);
}
