/**
 * Tiny JSON file store for things the web panel can change at runtime
 * (settings, the reaction-role board, the panel token).
 *
 * Files live in src/data/ (gitignored). Writes go to a temp file first and
 * are then renamed, so a crash mid-write cannot leave a half-written file.
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");

const fileFor = (name) => path.join(DATA_DIR, `${name}.json`);

/** Returns the parsed file, or `fallback` when it is missing or invalid. */
function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(name), "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT")
      console.warn(`[store] ${name}.json could not be read, using defaults:`, err.message);
    return fallback;
  }
}

function write(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = fileFor(name);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

module.exports = { read, write, DATA_DIR };
