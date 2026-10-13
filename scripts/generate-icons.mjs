// Generates the app's icons (#29) into public/icons from one SVG mark:
// three rising bars on near-black. Run with `node scripts/generate-icons.mjs`
// after changing the mark; the PNGs are committed.
import sharp from "sharp";

// Full-bleed square: iOS rounds the corners itself, and Android's maskable
// icon keeps the mark inside the central safe zone (80%).
function mark(size, inset) {
  const s = size;
  const pad = s * inset;
  const w = s - pad * 2;
  // Bottom-aligned bars of rising height.
  const bar = (x, height) =>
    `<rect x="${pad + w * x}" y="${pad + w * (0.82 - height)}" width="${w * 0.16}" height="${w * height}" rx="${w * 0.04}" fill="#fafafa"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" fill="#171717"/>
  ${bar(0.2, 0.3)}
  ${bar(0.42, 0.46)}
  ${bar(0.64, 0.64)}
</svg>`);
}

const outputs = [
  ["public/icons/icon-192.png", 192, 0.12],
  ["public/icons/icon-512.png", 512, 0.12],
  ["public/icons/icon-maskable-512.png", 512, 0.2],
  ["public/icons/apple-touch-icon.png", 180, 0.12],
];
for (const [file, size, inset] of outputs) {
  await sharp(mark(size, inset)).png().toFile(file);
  console.log(file);
}
