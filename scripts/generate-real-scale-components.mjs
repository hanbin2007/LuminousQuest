import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = join(ROOT, "assets", "components");

const color = {
  ink: "#1F262B",
  blue: "#2B5CA8",
  cyan: "#2CB8B8",
  copper: "#C4703A",
  zinc: "#9AA3AB",
  graphite: "#3A4148",
  paleCyan: "#DFF3F2",
  paleBlue: "#DEE9F9",
  paleAmber: "#FBEBD2",
};

function document(width, height, body, defs = "") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${defs}
  <g stroke-linecap="round" stroke-linejoin="round">
    ${body}
  </g>
</svg>
`;
}

function electrode(fill, highlight) {
  return document(
    48,
    224,
    `
    <rect x="13.5" y="17.5" width="21" height="189" rx="5.5"
      fill="${fill}" stroke="${color.ink}" stroke-width="3"/>
    <rect x="17" y="25" width="3" height="151" rx="1.5"
      fill="${highlight}" fill-opacity="0.62"/>
    <path d="M15.5 43 H32.5" fill="none" stroke="${color.ink}" stroke-width="2"/>
  `,
  );
}

const leadPath = "M32 68 C70 82 97 78 101 58 C105 37 133 24 176 28";

function bareClip(transform) {
  return `
    <g transform="${transform}">
      <rect x="-2" y="-7" width="17" height="14" rx="4"
        fill="${color.blue}" stroke="${color.ink}" stroke-width="3"/>
      <path d="M14 -5 H20 L28 -3 L24 0 L28 3 L20 5 H14 Z"
        fill="${color.zinc}" stroke="${color.ink}" stroke-width="3"/>
      <path d="M21 0 H27" fill="none" stroke="${color.ink}" stroke-width="1.5"/>
      <path d="M2 -3.2 H10" fill="none" stroke="${color.paleBlue}"
        stroke-width="1.7" stroke-opacity="0.78"/>
    </g>
  `;
}

function insulatedClip(transform) {
  return `
    <g transform="${transform}">
      <path d="M18 -4.5 H23 L29 -2.5 L25 0 L29 2.5 L23 4.5 H18 Z"
        fill="${color.zinc}" stroke="${color.ink}" stroke-width="3"/>
      <path d="M22 0 H28" fill="none" stroke="${color.ink}" stroke-width="1.5"/>
      <rect x="-3" y="-8" width="23" height="16" rx="6"
        fill="${color.graphite}" stroke="${color.ink}" stroke-width="3"/>
      <path d="M2 -4 H13" fill="none" stroke="${color.paleBlue}"
        stroke-width="2" stroke-opacity="0.52"/>
    </g>
  `;
}

function wire(insulated = false) {
  const inner = insulated ? color.graphite : color.blue;
  const outerWidth = insulated ? 11 : 9;
  const innerWidth = insulated ? 7 : 5;
  const clip = insulated ? insulatedClip : bareClip;

  return document(
    208,
    96,
    `
    <path d="${leadPath}" fill="none" stroke="${color.ink}" stroke-width="${outerWidth}"/>
    <path d="${leadPath}" fill="none" stroke="${inner}" stroke-width="${innerWidth}"/>
    ${clip("translate(32 68) rotate(198)")}
    ${clip("translate(176 28) rotate(5)")}
  `,
  );
}

const beakerOuter =
  "M10.5 18 C15 12 24 9 35 9 H111 C116.5 9 119 12 117 16.5 C114 21 112 26 112 32 V134 C112 149.5 101 158 84 159 H44 C27 158 16 149.5 16 134 V32 C16 26 14 21.5 10.5 18 Z";
const beakerInterior =
  "M17.5 21 C20 28 21 35 21 43 V134 C21 147 31 155 45 156 H83 C97 155 107 147 107 134 V43 C107 35 109 28 111 21 Z";
const beakerRim = "M14 19 C21 14 28 12.5 38 12.5 H110";

function beaker({ kind }) {
  const isElectrolyte = kind === "electrolyte";
  const isSucrose = kind === "sucrose";
  const surfaceY = 68;
  const glassOpacity = isElectrolyte || isSucrose ? 0.16 : 0.24;

  const liquid = isElectrolyte
    ? `<rect x="16" y="${surfaceY}" width="96" height="92" clip-path="url(#beaker-interior)"
        fill="${color.cyan}" fill-opacity="0.32"/>
      <path d="M22.5 ${surfaceY} H106" fill="none" stroke="${color.paleCyan}"
        stroke-width="3" stroke-opacity="0.9"/>`
    : isSucrose
      ? `<rect x="16" y="${surfaceY}" width="96" height="92" clip-path="url(#beaker-interior)"
          fill="${color.paleCyan}" fill-opacity="0.12"/>
        <path d="M22.5 ${surfaceY} H106" fill="none" stroke="${color.paleCyan}"
          stroke-width="2.5" stroke-opacity="0.72"/>
        <g fill="${color.paleCyan}" stroke="${color.ink}" stroke-width="1.5">
          <path d="M37 151 L40 146 L45 148 L44 154 Z"/>
          <path d="M49 153 L52 148 L57 149 L58 154 Z"/>
          <path d="M64 153 L67 147 L72 148 L73 154 Z"/>
          <path d="M77 153 L81 148 L86 150 L87 154 Z"/>
        </g>`
      : "";

  const highlightHeight = isElectrolyte || isSucrose ? 29 : 78;

  return document(
    128,
    168,
    `
    <path d="${beakerOuter}" fill="${color.paleBlue}" fill-opacity="${glassOpacity}"/>
    ${liquid}
    <rect x="91" y="32" width="8" height="${highlightHeight}" rx="4"
      fill="${color.paleCyan}" fill-opacity="0.68"/>
    <path d="${beakerOuter}" fill="none" stroke="${color.ink}" stroke-width="3"/>
    <path d="${beakerRim}" fill="none" stroke="${color.ink}" stroke-width="6"/>
    <path d="${beakerRim}" fill="none" stroke="${color.blue}" stroke-width="3"/>
    <g fill="none" stroke="${color.ink}" stroke-width="2.25">
      <path d="M102 54 H109"/>
      <path d="M98 76 H109"/>
      <path d="M102 98 H109"/>
      <path d="M98 120 H109"/>
    </g>
  `,
    `<defs><clipPath id="beaker-interior"><path d="${beakerInterior}"/></clipPath></defs>`,
  );
}

const assets = new Map([
  ["electrode-carbon", electrode(color.graphite, color.paleBlue)],
  ["electrode-zinc", electrode(color.zinc, color.paleBlue)],
  ["copper", electrode(color.copper, color.paleAmber)],
  ["wire", wire(false)],
  ["insulated-wire", wire(true)],
  ["beaker-empty", beaker({ kind: "empty" })],
  ["beaker-electrolyte", beaker({ kind: "electrolyte" })],
  ["sucrose-beaker", beaker({ kind: "sucrose" })],
]);

mkdirSync(OUTPUT_DIR, { recursive: true });
const temporaryDirectory = mkdtempSync(join(tmpdir(), "luminous-components-"));

try {
  const rasterizerArguments = [];
  const moduleCache = join(temporaryDirectory, "module-cache");
  mkdirSync(moduleCache);

  for (const [id, source] of assets) {
    const svgPath = join(temporaryDirectory, `${id}.svg`);
    const outputPath = join(OUTPUT_DIR, `${id}@2x.png`);
    writeFileSync(svgPath, source);
    rasterizerArguments.push(svgPath, outputPath);
  }

  const result = spawnSync(
    "xcrun",
    ["swift", join(import.meta.dirname, "rasterize-svg.swift"), ...rasterizerArguments],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: moduleCache,
        SWIFT_MODULE_CACHE_PATH: moduleCache,
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(`SVG rasterization failed: ${result.stderr || result.stdout}`);
  }

  for (const id of assets.keys()) {
    console.log(`generated ${id}@2x.png`);
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
