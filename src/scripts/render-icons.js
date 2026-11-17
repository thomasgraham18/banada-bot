// Renders the player icons: writes <name>.svg + <name>.png into <outDir>, and a
// dark-background preview sheet next to this script.
// Usage (from src):
//   npm i --no-save @resvg/resvg-js
//   node scripts/render-icons.js assets/icons
// Edit the paths below to change an icon, then see utils/icons.js for how to
// get the new image onto Discord.
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });

// 24x24 grid. Solid shapes use fill; line icons use a 2.25px round stroke.
// Line icons are based on Feather Icons (MIT licence, feathericons.com).
const F = (d) => `<path d="${d}" fill="#fff"/>`;
const S = (d) =>
  `<path d="${d}" fill="none" stroke="#fff" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>`;
const speaker = F("M11 5 6 9H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l5 4z");

const icons = {
  play: F("M8 5.2v13.6a.8.8 0 0 0 1.2.7l11-6.8a.8.8 0 0 0 0-1.4l-11-6.8A.8.8 0 0 0 8 5.2z"),
  pause:
    `<rect x="6" y="5" width="4.5" height="14" rx="1.2" fill="#fff"/>` +
    `<rect x="13.5" y="5" width="4.5" height="14" rx="1.2" fill="#fff"/>`,
  stop: `<rect x="5.5" y="5.5" width="13" height="13" rx="2" fill="#fff"/>`,
  skip:
    F("M5 5.4v13.2a.8.8 0 0 0 1.25.66l9.5-6.6a.8.8 0 0 0 0-1.32l-9.5-6.6A.8.8 0 0 0 5 5.4z") +
    `<rect x="17" y="5" width="2.6" height="14" rx="1" fill="#fff"/>`,
  previous:
    F("M19 5.4v13.2a.8.8 0 0 1-1.25.66l-9.5-6.6a.8.8 0 0 1 0-1.32l9.5-6.6A.8.8 0 0 1 19 5.4z") +
    `<rect x="4.4" y="5" width="2.6" height="14" rx="1" fill="#fff"/>`,
  queue:
    S("M4 6h16M4 12h10M4 18h7") +
    F("M16 13.6v6a.6.6 0 0 0 .92.5l4.6-3a.6.6 0 0 0 0-1l-4.6-3a.6.6 0 0 0-.92.5z"),
  shuffle: S("M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"),
  loop: S("m17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"),
  loop_one:
    S("m17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3") +
    S("M11 10.5 12.5 9.5v5.5"),
  autoplay: S(
    "M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4z"
  ),
  vol_down: speaker + S("M15.5 8.5a5 5 0 0 1 0 7"),
  vol_up: speaker + S("M15.5 8.5a5 5 0 0 1 0 7M18.8 5.2a9.6 9.6 0 0 1 0 13.6"),
};

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 28 28" width="128" height="128">${body}</svg>\n`;

for (const [name, body] of Object.entries(icons)) {
  const source = svg(body);
  fs.writeFileSync(path.join(out, `${name}.svg`), source);
  const png = new Resvg(source, { fitTo: { mode: "width", value: 128 } }).render().asPng();
  fs.writeFileSync(path.join(out, `${name}.png`), png);
}

// Preview sheet on Discord's dark button colour.
const names = Object.keys(icons);
const cell = 72;
const sheet =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${names.length * cell}" height="${cell}">` +
  `<rect width="100%" height="100%" fill="#1e1f22"/>` +
  names
    .map(
      (n, i) =>
        `<rect x="${i * cell + 6}" y="6" width="60" height="60" rx="10" fill="#3a3c42"/>` +
        `<svg x="${i * cell + 20}" y="20" width="32" height="32" viewBox="-2 -2 28 28">${icons[n]}</svg>`
    )
    .join("") +
  `</svg>`;
fs.writeFileSync(
  path.join(require("os").tmpdir(), "banada-icons-preview.png"),
  new Resvg(sheet, { fitTo: { mode: "zoom", value: 2 } }).render().asPng()
);
console.log("rendered", names.join(", "));
