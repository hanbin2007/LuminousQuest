import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = join(ROOT, "assets", "components");

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

const electrodePalettes = {
  carbon: {
    stops: [
      ["0%", "#23282E"],
      ["6%", "#4A5158"],
      ["17%", "#424950"],
      ["43%", "#3A4148"],
      ["69%", "#353B42"],
      ["88%", "#2C3238"],
      ["100%", "#20252B"],
    ],
    cap: "#4A5158",
    contact: "#394047",
  },
  zinc: {
    stops: [
      ["0%", "#69757E"],
      ["6%", "#AAB4BC"],
      ["16%", "#D5DCE2"],
      ["31%", "#B8C1C8"],
      ["57%", "#9AA3AB"],
      ["80%", "#87929B"],
      ["100%", "#65717A"],
    ],
    cap: "#C6CDD5",
    contact: "#9AA3AB",
  },
  copper: {
    stops: [
      ["0%", "#7A3E1D"],
      ["6%", "#B5602E"],
      ["17%", "#E29A5C"],
      ["32%", "#C4703A"],
      ["57%", "#DA874B"],
      ["79%", "#A85A2B"],
      ["100%", "#713719"],
    ],
    cap: "#E29A5C",
    contact: "#C4703A",
  },
};

function gradientStops(stops) {
  return stops.map(([offset, color]) => `<stop offset="${offset}" stop-color="${color}"/>`).join("\n");
}

function electrode(kind) {
  const palette = electrodePalettes[kind];
  const graphiteTexture =
    kind === "carbon"
      ? `
        <rect x="20" y="40" width="3" height="414" rx="1.5" fill="#657079" fill-opacity="0.10"/>
        <rect x="57" y="47" width="2" height="397" rx="1" fill="#151A1F" fill-opacity="0.12"/>
        <rect x="82" y="35" width="4" height="423" rx="2" fill="#66717A" fill-opacity="0.07"/>
        <path d="M12 132 V318 M72 78 V219 M92 270 V430" fill="none" stroke="#78828A" stroke-width="1" stroke-opacity="0.08"/>`
      : "";
  const zincTexture =
    kind === "zinc"
      ? `
        <path d="M15 102 H41 M66 177 H92 M20 292 H52 M59 397 H87" fill="none" stroke="#FFFFFF" stroke-width="1" stroke-opacity="0.13"/>
        <path d="M30 63 V148 M77 224 V352 M48 366 V453" fill="none" stroke="#56636C" stroke-width="1" stroke-opacity="0.10"/>`
      : "";
  const copperReflection =
    kind === "copper"
      ? `
        <rect x="21" y="37" width="10" height="413" rx="5" fill="#FFF1DE" fill-opacity="0.23"/>
        <rect x="31" y="41" width="4" height="405" rx="2" fill="#FFE4C6" fill-opacity="0.11"/>
        <path d="M70 80 V209 M75 267 V420" fill="none" stroke="#6A2F15" stroke-width="1" stroke-opacity="0.12"/>`
      : "";

  return document(
    108,
    504,
    `
      <path d="M3 11 Q3 8 7 8 H101 Q105 8 105 11 V477 C105 482 101 484 96 484 H12 C7 484 3 482 3 477 Z"
        fill="url(#body-metal)" stroke="#182027" stroke-width="1.2" stroke-opacity="0.28"/>
      <path d="M4 11 Q4 8 8 8 H100 Q104 8 104 11 V476 C104 480 100 482 95 482 H13 C8 482 4 480 4 476 Z"
        fill="url(#length-shade)"/>
      <ellipse cx="54" cy="9" rx="50" ry="6.5" fill="url(#top-face)" stroke="#FFFFFF" stroke-width="1" stroke-opacity="0.17"/>
      <rect x="5" y="17" width="98" height="18" rx="5" fill="${palette.contact}" fill-opacity="0.34"/>
      <ellipse cx="54" cy="25" rx="21" ry="7.5" fill="url(#terminal-face)" stroke="#172027" stroke-width="1" stroke-opacity="0.24"/>
      <ellipse cx="50" cy="22.5" rx="12" ry="3" fill="#FFFFFF" fill-opacity="0.18"/>
      <path d="M7 35 H101" fill="none" stroke="#152029" stroke-width="1" stroke-opacity="0.23"/>
      <rect x="8" y="43" width="5" height="402" rx="2.5" fill="#FFFFFF" fill-opacity="0.18"/>
      <rect x="13" y="48" width="3" height="390" rx="1.5" fill="#FFFFFF" fill-opacity="0.08"/>
      <rect x="95" y="38" width="8" height="416" rx="3" fill="#10161B" fill-opacity="0.14"/>
      ${graphiteTexture}
      ${zincTexture}
      ${copperReflection}
      <path d="M4 451 H104 V477 C104 481 99 483 94 483 H14 C9 483 4 481 4 477 Z" fill="url(#bottom-shade)"/>
      <path d="M12 483 C30 479 78 479 96 483" fill="none" stroke="#10161B" stroke-width="1.4" stroke-opacity="0.29"/>
    `,
    `<defs>
      <linearGradient id="body-metal" x1="0" y1="0" x2="1" y2="0">${gradientStops(palette.stops)}</linearGradient>
      <linearGradient id="length-shade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.13"/>
        <stop offset="12%" stop-color="#FFFFFF" stop-opacity="0.03"/>
        <stop offset="58%" stop-color="#000000" stop-opacity="0"/>
        <stop offset="88%" stop-color="#000000" stop-opacity="0.08"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0.22"/>
      </linearGradient>
      <linearGradient id="top-face" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.38"/>
        <stop offset="46%" stop-color="${palette.cap}" stop-opacity="0.92"/>
        <stop offset="100%" stop-color="#111820" stop-opacity="0.37"/>
      </linearGradient>
      <radialGradient id="terminal-face" cx="38%" cy="28%" r="72%">
        <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.38"/>
        <stop offset="42%" stop-color="${palette.cap}" stop-opacity="0.88"/>
        <stop offset="100%" stop-color="#111820" stop-opacity="0.30"/>
      </radialGradient>
      <linearGradient id="bottom-shade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
        <stop offset="100%" stop-color="#0A0F13" stop-opacity="0.32"/>
      </linearGradient>
    </defs>`,
  );
}

const leadPath = "M82 151 C154 184 212 171 227 112 C242 52 297 39 368 63";

function alligatorClip(transform, insulated) {
  const sleeve = insulated
    ? `
      <path d="M-10 -21 H25 C36 -21 43 -16 44 -8 L44 8 C43 16 36 21 25 21 H-10 C-18 15 -21 8 -21 0 C-21 -8 -18 -15 -10 -21 Z"
        fill="url(#clip-sleeve)" stroke="#11171C" stroke-width="1.4" stroke-opacity="0.28"/>
      <path d="M-8 -15 H24 C31 -15 35 -12 36 -8" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-opacity="0.15"/>
      <path d="M38 -10 L47 -7 V7 L38 10 Z" fill="#20262C" fill-opacity="0.86"/>`
    : `
      <path d="M-8 -13 H27 L43 -7 L35 0 L43 7 L27 13 H-8 Z"
        fill="url(#nickel)" stroke="#243038" stroke-width="1.2" stroke-opacity="0.30"/>
      <path d="M-2 -8 H25" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-opacity="0.27"/>`;

  return `
    <g transform="${transform}">
      <rect x="-34" y="-11" width="29" height="22" rx="8" fill="url(#crimp)" stroke="#5A2F18" stroke-width="1.2" stroke-opacity="0.30"/>
      <ellipse cx="-34" cy="0" rx="4" ry="10" fill="#7F431F" fill-opacity="0.82"/>
      <ellipse cx="-31.5" cy="-2" rx="1.5" ry="6" fill="#FFE0BB" fill-opacity="0.33"/>
      ${sleeve}
      <path d="M28 -5 L57 -19 L76 -9 L69 -4 L64 -4 L61 -1 L57 -4 L53 -1 L49 -4 L45 -1 L40 -4 L34 -3 Z"
        fill="url(#nickel)" stroke="#253139" stroke-width="1.2" stroke-opacity="0.30"/>
      <path d="M28 5 L57 19 L76 9 L69 4 L64 4 L61 1 L57 4 L53 1 L49 4 L45 1 L40 4 L34 3 Z"
        fill="url(#nickel-dark)" stroke="#253139" stroke-width="1.2" stroke-opacity="0.30"/>
      <path d="M38 -4 L43 -1 L47 -4 L51 -1 L55 -4 L59 -1 L63 -4" fill="none" stroke="#202A31" stroke-width="1.3" stroke-opacity="0.58"/>
      <path d="M38 4 L43 1 L47 4 L51 1 L55 4 L59 1 L63 4" fill="none" stroke="#202A31" stroke-width="1.3" stroke-opacity="0.58"/>
      <circle cx="27" cy="0" r="6.5" fill="url(#rivet)" stroke="#29353C" stroke-width="1" stroke-opacity="0.30"/>
      <circle cx="25" cy="-2" r="1.8" fill="#FFFFFF" fill-opacity="0.42"/>
      <path d="M50 -13 L68 -8" fill="none" stroke="#FFFFFF" stroke-width="1.8" stroke-opacity="0.28"/>
    </g>`;
}

function wire(insulated = false) {
  const bodyStops = insulated
    ? `
      <stop offset="0%" stop-color="#23272C"/>
      <stop offset="18%" stop-color="#4B5158"/>
      <stop offset="42%" stop-color="#3A3F45"/>
      <stop offset="72%" stop-color="#30353A"/>
      <stop offset="100%" stop-color="#1E2328"/>`
    : `
      <stop offset="0%" stop-color="#183A70"/>
      <stop offset="16%" stop-color="#3973C2"/>
      <stop offset="42%" stop-color="#2B5CA8"/>
      <stop offset="74%" stop-color="#244E90"/>
      <stop offset="100%" stop-color="#142F59"/>`;

  return document(
    450,
    210,
    `
      <path d="${leadPath}" fill="none" stroke="#10181F" stroke-width="28" stroke-opacity="0.68"/>
      <path d="${leadPath}" fill="none" stroke="url(#wire-body)" stroke-width="22"/>
      <path d="${leadPath}" fill="none" stroke="#FFFFFF" stroke-width="5" stroke-opacity="${insulated ? "0.13" : "0.28"}"/>
      <path d="${leadPath}" fill="none" stroke="#080D11" stroke-width="2" stroke-opacity="0.16" transform="translate(0 7)"/>
      ${alligatorClip("translate(82 151) rotate(198)", insulated)}
      ${alligatorClip("translate(368 63) rotate(4)", insulated)}
    `,
    `<defs>
      <linearGradient id="wire-body" x1="0" y1="0" x2="0" y2="1">${bodyStops}</linearGradient>
      <linearGradient id="nickel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#6F7B83"/>
        <stop offset="14%" stop-color="#DDE3E7"/>
        <stop offset="34%" stop-color="#AEB8BF"/>
        <stop offset="59%" stop-color="#F1F4F6"/>
        <stop offset="78%" stop-color="#8A969E"/>
        <stop offset="100%" stop-color="#56626A"/>
      </linearGradient>
      <linearGradient id="nickel-dark" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#57636B"/>
        <stop offset="24%" stop-color="#A8B2B9"/>
        <stop offset="54%" stop-color="#7D8991"/>
        <stop offset="76%" stop-color="#D4DADF"/>
        <stop offset="100%" stop-color="#4C575F"/>
      </linearGradient>
      <linearGradient id="crimp" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#713719"/>
        <stop offset="16%" stop-color="#D07A3F"/>
        <stop offset="38%" stop-color="#E29A5C"/>
        <stop offset="62%" stop-color="#B55F2F"/>
        <stop offset="84%" stop-color="#D58047"/>
        <stop offset="100%" stop-color="#6E3418"/>
      </linearGradient>
      <linearGradient id="clip-sleeve" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#20252A"/>
        <stop offset="18%" stop-color="#50565D"/>
        <stop offset="42%" stop-color="#3A3F45"/>
        <stop offset="76%" stop-color="#2B3035"/>
        <stop offset="100%" stop-color="#171C20"/>
      </linearGradient>
      <radialGradient id="rivet" cx="35%" cy="30%" r="72%">
        <stop offset="0%" stop-color="#FFFFFF"/>
        <stop offset="34%" stop-color="#C7D0D6"/>
        <stop offset="74%" stop-color="#7F8B93"/>
        <stop offset="100%" stop-color="#4B565E"/>
      </radialGradient>
    </defs>`,
  );
}

const beakerOuter =
  "M50 117 C52 101 67 91 86 88 C173 74 457 74 546 88 C563 90 576 96 585 103 L610 94 C598 108 587 119 575 128 V690 C575 729 548 756 510 765 H120 C82 756 55 729 55 690 V139 C55 130 53 123 50 117 Z";
const liquidBody =
  "M76.5 250.5 H553.5 V700 C553.5 734.5 535 756.5 506 756.5 H124 C95 756.5 76.5 734.5 76.5 700 Z";

function sugarCrystals() {
  return `
    <g fill="url(#sugar)" stroke="#FFFFFF" stroke-width="0.8" stroke-opacity="0.24">
      <path d="M218 746 L226 730 L243 733 L247 750 L232 754 Z"/>
      <path d="M241 737 L250 718 L270 720 L274 742 L257 750 Z"/>
      <path d="M268 748 L278 725 L299 727 L304 750 L286 755 Z"/>
      <path d="M295 739 L307 714 L327 719 L332 742 L313 750 Z"/>
      <path d="M325 748 L336 723 L357 726 L362 749 L345 755 Z"/>
      <path d="M354 740 L365 719 L384 723 L389 744 L372 750 Z"/>
      <path d="M382 749 L391 730 L408 733 L413 751 L398 755 Z"/>
      <path d="M252 720 L262 704 L278 708 L280 725 L266 731 Z"/>
      <path d="M282 723 L292 700 L311 704 L315 725 L298 733 Z"/>
      <path d="M316 718 L327 696 L347 702 L350 724 L332 730 Z"/>
      <path d="M349 725 L359 705 L378 709 L381 730 L365 736 Z"/>
      <path d="M292 703 L304 685 L321 691 L322 708 L308 714 Z"/>
      <path d="M325 701 L336 681 L353 687 L357 706 L341 713 Z"/>
    </g>`;
}

function beaker(kind) {
  const isElectrolyte = kind === "electrolyte";
  const isSucrose = kind === "sucrose";
  let liquid = "";

  if (isElectrolyte) {
    liquid = `
      <path d="${liquidBody}" fill="url(#electrolyte)"/>
      <path d="M76.5 250.5 C151 269 479 269 553.5 250.5 C482 281 148 281 76.5 250.5 Z" fill="url(#electrolyte-surface)"/>
      <path d="M77 251 H553" fill="none" stroke="#81DBD5" stroke-width="1.5" stroke-opacity="0.70"/>
      <path d="M88 253 C182 267 448 267 542 253" fill="none" stroke="#D6FFFC" stroke-width="1.5" stroke-opacity="0.62"/>`;
  } else if (isSucrose) {
    liquid = `
      <path d="${liquidBody}" fill="#FFFFFF" fill-opacity="0.075"/>
      <path d="M76.5 250.5 C151 267 479 267 553.5 250.5 C482 276 148 276 76.5 250.5 Z" fill="#FFFFFF" fill-opacity="0.065"/>
      <path d="M77 251 H553" fill="none" stroke="#FFFFFF" stroke-width="1.2" stroke-opacity="0.24"/>
      <path d="M92 254 C188 264 442 264 538 254" fill="none" stroke="#FFFFFF" stroke-width="1" stroke-opacity="0.18"/>
      ${sugarCrystals()}`;
  }

  return document(
    630,
    780,
    `
      <path d="${beakerOuter}" fill="#FFFFFF" fill-opacity="0.105"/>
      ${liquid}
      <path d="${beakerOuter}" fill="#D9F1F4" fill-opacity="0.025"/>

      <path d="M82 157 V680 C82 719 98 742 125 752 H151 C124 735 112 712 112 677 V158 Z" fill="#FFFFFF" fill-opacity="0.10"/>
      <path d="M88 162 V673 C88 711 99 730 114 741" fill="none" stroke="#FFFFFF" stroke-width="13" stroke-opacity="0.10"/>
      <path d="M94 162 V660 C94 696 101 718 113 731" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-opacity="0.44"/>
      <path d="M102 166 V635" fill="none" stroke="#FFFFFF" stroke-width="2.5" stroke-opacity="0.50"/>
      <path d="M526 168 V673 C526 706 518 728 506 741" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-opacity="0.16"/>

      <path d="M77 710 C94 742 108 753 135 757 H495 C522 753 537 742 553 710 C548 751 525 765 500 769 H130 C105 765 82 751 77 710 Z" fill="#FFFFFF" fill-opacity="0.105"/>
      <path d="M91 733 C121 755 155 759 207 759 H423 C475 759 509 755 539 733" fill="none" stroke="#FFFFFF" stroke-width="8" stroke-opacity="0.18"/>
      <path d="M112 754 C199 765 431 765 518 754" fill="none" stroke="#DAF5F7" stroke-width="2" stroke-opacity="0.43"/>

      <g fill="none" stroke="#FFFFFF" stroke-width="1.2" stroke-opacity="0.23">
        <path d="M502 211 H542"/>
        <path d="M514 274 H542"/>
        <path d="M502 337 H542"/>
        <path d="M514 400 H542"/>
        <path d="M502 463 H542"/>
        <path d="M514 526 H542"/>
        <path d="M502 589 H542"/>
        <path d="M514 652 H542"/>
      </g>
      <g fill="none" stroke="#263840" stroke-width="0.8" stroke-opacity="0.10">
        <path d="M502 213 H542"/>
        <path d="M514 276 H542"/>
        <path d="M502 339 H542"/>
        <path d="M514 402 H542"/>
        <path d="M502 465 H542"/>
        <path d="M514 528 H542"/>
        <path d="M502 591 H542"/>
        <path d="M514 654 H542"/>
      </g>

      <path d="M55 137 V690 C55 729 82 756 120 765 H510 C548 756 575 729 575 690 V128"
        fill="none" stroke="#263840" stroke-width="1.4" stroke-opacity="0.26"/>
      <path d="M76 137 V700 C76 735 95 757 124 757 H506 C535 757 554 735 554 700 V137"
        fill="none" stroke="#E7FFFF" stroke-width="1.4" stroke-opacity="0.52"/>
      <path d="M78 137 V700 C78 733 96 754 124 755" fill="none" stroke="#3B5962" stroke-width="0.9" stroke-opacity="0.17"/>
      <path d="M552 137 V700 C552 733 534 754 506 755" fill="none" stroke="#3B5962" stroke-width="0.9" stroke-opacity="0.17"/>

      <ellipse cx="315" cy="116" rx="260" ry="37" fill="#FFFFFF" fill-opacity="0.055" stroke="#263840" stroke-width="1.4" stroke-opacity="0.25"/>
      <ellipse cx="315" cy="116" rx="239" ry="27" fill="none" stroke="#FFFFFF" stroke-width="1.5" stroke-opacity="0.48"/>
      <path d="M76 116 C151 93 479 93 554 116" fill="none" stroke="#FFFFFF" stroke-width="1.3" stroke-opacity="0.42"/>
      <path d="M76 118 C155 140 475 140 554 118" fill="none" stroke="#294047" stroke-width="1.1" stroke-opacity="0.20"/>
      <path d="M554 91 C575 90 596 97 610 94 C599 108 587 119 575 128 C568 124 561 121 554 118 Z"
        fill="#FFFFFF" fill-opacity="0.12" stroke="#263840" stroke-width="1.2" stroke-opacity="0.23"/>
      <path d="M563 98 C579 99 592 101 602 98" fill="none" stroke="#FFFFFF" stroke-width="1.3" stroke-opacity="0.48"/>
    `,
    `<defs>
      <linearGradient id="electrolyte" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#5BC0BC" stop-opacity="0.57"/>
        <stop offset="24%" stop-color="#52B9B5" stop-opacity="0.60"/>
        <stop offset="58%" stop-color="#3EA9A5" stop-opacity="0.64"/>
        <stop offset="86%" stop-color="#349F9B" stop-opacity="0.67"/>
        <stop offset="100%" stop-color="#2E9E9A" stop-opacity="0.69"/>
      </linearGradient>
      <linearGradient id="electrolyte-surface" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#A9EFEB" stop-opacity="0.61"/>
        <stop offset="45%" stop-color="#5BC0BC" stop-opacity="0.64"/>
        <stop offset="100%" stop-color="#2E9E9A" stop-opacity="0.58"/>
      </linearGradient>
      <radialGradient id="sugar" cx="35%" cy="24%" r="76%">
        <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.82"/>
        <stop offset="48%" stop-color="#FFFFFF" stop-opacity="0.52"/>
        <stop offset="100%" stop-color="#DDEBED" stop-opacity="0.28"/>
      </radialGradient>
    </defs>`,
  );
}

const assets = new Map([
  ["electrode-carbon", electrode("carbon")],
  ["electrode-zinc", electrode("zinc")],
  ["copper", electrode("copper")],
  ["wire", wire(false)],
  ["insulated-wire", wire(true)],
  ["beaker-empty", beaker("empty")],
  ["beaker-electrolyte", beaker("electrolyte")],
  ["sucrose-beaker", beaker("sucrose")],
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
