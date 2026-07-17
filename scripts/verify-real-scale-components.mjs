import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "..");
const expected = [
  ["electrode-carbon", 48, 224],
  ["electrode-zinc", 48, 224],
  ["copper", 48, 224],
  ["wire", 208, 96],
  ["insulated-wire", 208, 96],
  ["beaker-empty", 128, 168],
  ["beaker-electrolyte", 128, 168],
  ["sucrose-beaker", 128, 168],
];
const manifest = JSON.parse(readFileSync(resolve(ROOT, "assets", "manifest.json"), "utf8"));

function inspectPng(id) {
  const path = resolve(ROOT, "assets", "components", `${id}@2x.png`);
  const png = readFileSync(path);
  const signature = png.subarray(0, 8).toString("hex");

  if (signature !== "89504e470d0a1a0a" || png.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error(`${id}: not a valid PNG with an IHDR header`);
  }

  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const colorType = png[25];
  const bitDepth = png[24];
  const interlaceMethod = png[28];
  const idatChunks = [];

  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") {
      idatChunks.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }

  return {
    width,
    height,
    colorType,
    transparentCanvas:
      colorType === 6 && bitDepth === 8 && interlaceMethod === 0
        ? inspectAlpha(inflateSync(Buffer.concat(idatChunks)), width, height)
        : false,
  };
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);

  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function inspectAlpha(filtered, width, height) {
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  let minAlpha = 255;
  let maxAlpha = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset];
    sourceOffset += 1;

    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[sourceOffset];
      sourceOffset += 1;
      const destination = y * stride + x;
      const left = x >= bytesPerPixel ? pixels[destination - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[destination - stride] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[destination - stride - bytesPerPixel] : 0;

      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : filter === 4
                  ? paeth(left, up, upperLeft)
                  : null;

      if (predictor === null) {
        throw new Error(`unsupported PNG filter: ${filter}`);
      }

      pixels[destination] = (raw + predictor) & 0xff;
    }

    for (let x = 3; x < stride; x += bytesPerPixel) {
      const alpha = pixels[y * stride + x];
      minAlpha = Math.min(minAlpha, alpha);
      maxAlpha = Math.max(maxAlpha, alpha);
    }
  }

  const cornerAlpha = [
    pixels[3],
    pixels[(width - 1) * bytesPerPixel + 3],
    pixels[(height - 1) * stride + 3],
    pixels[(height - 1) * stride + (width - 1) * bytesPerPixel + 3],
  ];

  return minAlpha === 0 && maxAlpha > 0 && cornerAlpha.every((alpha) => alpha === 0);
}

console.log("asset                 expected   actual     manifest   RGBA   alpha   result");
console.log("--------------------  ---------  ---------  ---------  -----  ------  ------");

let failed = false;
for (const [id, expectedWidth, expectedHeight] of expected) {
  const actual = inspectPng(id);
  const dimensionsMatch = actual.width === expectedWidth && actual.height === expectedHeight;
  const manifestEntries = manifest.assets.filter((asset) => asset.id === id);
  const manifestMatches =
    manifestEntries.length === 1 &&
    manifestEntries[0].file === `assets/components/${id}@2x.png` &&
    manifestEntries[0].dimensions?.width === expectedWidth &&
    manifestEntries[0].dimensions?.height === expectedHeight &&
    typeof manifestEntries[0].purpose === "string" &&
    manifestEntries[0].purpose.length > 0;
  const isRgba = actual.colorType === 6;
  const passes = dimensionsMatch && manifestMatches && isRgba && actual.transparentCanvas;
  failed ||= !passes;

  console.log(
    `${id.padEnd(20)}  ${`${expectedWidth}x${expectedHeight}`.padEnd(9)}  ${`${actual.width}x${actual.height}`.padEnd(9)}  ${String(manifestMatches ? "yes" : "no").padEnd(9)}  ${String(isRgba ? "yes" : "no").padEnd(5)}  ${String(actual.transparentCanvas ? "yes" : "no").padEnd(6)}  ${passes ? "PASS" : "FAIL"}`,
  );
}

if (failed) {
  process.exitCode = 1;
}
