// Generates the app's icons from Tally's mascot (#73), a thermal receipt
// with a face: the full receipt on the app's green for the home-screen icons
// (#29), and the simpler mark as the browser tab's icon. Run `npm run icons`
// after changing the mascot (src/lib/tally/mascot.ts); the files are
// committed. That runs it through tsx, which loads the TypeScript shapes on
// any supported Node (plain `node` only can from 22.18).
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { mascotSvg } from "../src/lib/tally/mascot.ts";

// The app's primary green (--primary), the tile the receipt sits on.
const TILE = "#1a6444";

// The receipt's extent in its 100-unit box: 84 units tall, centred on y 52.
const RECEIPT_HEIGHT = 0.84;
const RECEIPT_CENTRE_Y = 0.52;

// Full-bleed square: iOS rounds the corners itself, and Android's maskable
// icon keeps the mark inside the central safe zone (80%). `fill` is how much
// of the icon's height the receipt takes.
function icon(size, fill) {
  const box = Math.round((size * fill) / RECEIPT_HEIGHT);
  return sharp({ create: { width: size, height: size, channels: 4, background: TILE } })
    .composite([{ input: Buffer.from(mascotSvg("full", { size: box })), left: Math.round(size / 2 - box / 2), top: Math.round(size / 2 - box * RECEIPT_CENTRE_Y) }])
    .png();
}

const outputs = [
  ["public/icons/icon-192.png", 192, 0.74],
  ["public/icons/icon-512.png", 512, 0.74],
  ["public/icons/icon-maskable-512.png", 512, 0.6],
  ["public/icons/apple-touch-icon.png", 180, 0.74],
];
for (const [file, size, fill] of outputs) {
  await icon(size, fill).toFile(file);
  console.log(file);
}

// The tab icon, as SVG so it stays sharp at 16px and on high-density screens.
// No background: a tab strip is light or dark, and the receipt's brown edge
// reads on both.
await writeFile("src/app/icon.svg", `${mascotSvg("mark")}\n`);
console.log("src/app/icon.svg");
