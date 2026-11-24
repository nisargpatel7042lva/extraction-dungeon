// Turns the AI-generated art in ../art/raw into game-ready PNGs in public/sprites.
//   npx tsx scripts/sprites.ts
// - Objects: magenta (#FF00FF) background keyed out, trimmed to content, centred in a square, 128px.
// - heroes.png is a 2x2 sheet: split into hero0..hero3 (blue, pink, orange, lime = seat order).
// - floor/wall are seamless textures: kept whole, scaled to 256px for Phaser TileSprites.
import sharp from "sharp";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, "../../art/raw");
const OUT = join(here, "../public/sprites");
mkdirSync(OUT, { recursive: true });

const SIZE = 128;

/** Alpha for a pixel: 0 on pure magenta, fading in over a narrow fringe. Only pixels where red and
 *  blue are both high AND nearly equal count, so hot pink (r >> b) is never keyed. */
function keyAlpha(r: number, g: number, b: number): number {
  const balanced = Math.abs(r - b) < 60;
  if (!balanced) return 255;
  const mag = Math.min(r, b) - g; // how "magenta" it is
  if (mag > 150) return 0;
  if (mag > 90) return Math.round(((150 - mag) / 60) * 255);
  return 255;
}

async function keyed(file: string, region?: { left: number; top: number; width: number; height: number }) {
  let img = sharp(join(RAW, file)).ensureAlpha();
  if (region) img = img.extract(region);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = keyAlpha(data[i], data[i + 1], data[i + 2]);
      data[i + 3] = a;
      if (a < 255) {
        // despill: pull residual magenta out of fringe pixels
        const cap = data[i + 1] + 40;
        data[i] = Math.min(data[i], cap);
        data[i + 2] = Math.min(data[i + 2], cap);
      }
      if (a > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  if (maxX < 0) throw new Error(`${file}: everything keyed out`);
  const w = maxX - minX + 1, h = maxY - minY + 1;
  return sharp(data, { raw: { width, height, channels: 4 } }).extract({ left: minX, top: minY, width: w, height: h });
}

async function object(file: string, out: string, region?: Parameters<typeof keyed>[1]) {
  const img = await keyed(file, region);
  // Two passes: sharp applies extract before resize only within one pipeline, so materialise first.
  const buf = await img.png().toBuffer();
  await sharp(buf)
    .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: "lanczos3" })
    .png()
    .toFile(join(OUT, out));
  const meta = await sharp(buf).metadata();
  console.log(`${out.padEnd(18)} content ${meta.width}x${meta.height} -> ${SIZE}x${SIZE}`);
}

async function texture(file: string, out: string) {
  await sharp(join(RAW, file)).resize(256, 256, { kernel: "lanczos3" }).png().toFile(join(OUT, out));
  console.log(`${out.padEnd(18)} 1024x1024 -> 256x256 (seamless)`);
}

const half = 512;
for (let i = 0; i < 4; i++) {
  const left = (i % 2) * half, top = Math.floor(i / 2) * half;
  await object("heroes.png", `hero${i}.png`, { left, top, width: half, height: half });
}
await object("chest_closed.png", "chest_closed.png");
await object("chest_open.png", "chest_open.png");
await object("sack.png", "sack.png");
await object("exit.png", "exit.png");
await texture("floor.png", "floor.png");
await texture("wall.png", "wall.png");
