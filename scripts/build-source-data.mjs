import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = [
  ["programs/firmware/src/lib.rs", "RUST", "CI VERIFIED", "The native Solana program: Chip identity, revisions, Machine ownership, bounded installations, receipts and SPL Token settlement."],
  ["programs/firmware/Cargo.toml", "TOML", "PROGRAM CONFIG", "Pins the Anchor and SPL dependencies for the onchain program."],
  ["Cargo.toml", "TOML", "WORKSPACE", "Defines the Rust workspace containing the firmware program."],
  ["Anchor.toml", "TOML", "ANCHOR CONFIG", "Defines the program ID and local validator settings."],
  [".github/workflows/solana.yml", "YAML", "CI CONFIG", "Compiles and runs unit tests for the Solana program on Linux."],
  ["scripts/build-source-data.mjs", "JAVASCRIPT", "BUILD TOOL", "Reads real repository files and generates this website source browser."],
  ["tests/site.test.mjs", "JAVASCRIPT", "SITE TEST", "Checks every board Chip maps to a real Solana symbol and detects stale chain claims."],
  ["index.html", "HTML", "WEBSITE SOURCE", "Defines the developer note, Solana account flow and source browser."],
  ["styles.css", "CSS", "WEBSITE SOURCE", "Styles the board, liquid glass panels and code explorer."],
  ["app.js", "JAVASCRIPT", "WEBSITE SOURCE", "Maps every board component to a real Solana program instruction or account."],
  ["README.md", "MARKDOWN", "PROJECT GUIDE", "Explains the implemented program, account model, build commands and security boundaries."],
  ["package.json", "JSON", "BUILD CONFIG", "Defines source synchronization and website test commands."],
  ["serve.py", "PYTHON", "LOCAL SERVER", "Serves the static site locally for inspection."]
];
const objects = {};
for (const [relativePath, language, state, description] of entries) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  objects[relativePath] = {
    language,
    state,
    description,
    content: fs.readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n")
  };
}
const groups = new Map();
const rootFiles = [];
for (const [relativePath] of entries) {
  const slash = relativePath.indexOf("/");
  if (slash < 0) {
    rootFiles.push(relativePath);
    continue;
  }
  const folder = relativePath.slice(0, slash);
  if (!groups.has(folder)) groups.set(folder, []);
  groups.get(folder).push(relativePath);
}
const tree = Array.from(groups, ([name, children]) => ({ name, type: "folder", children }));
for (const name of rootFiles) tree.push({ name, type: "file" });
const output = "window.FIRMWARE_SOURCE_OBJECTS = " + JSON.stringify(objects, null, 2) + ";\n\n" +
  "window.FIRMWARE_SOURCE_TREE = " + JSON.stringify(tree, null, 2) + ";\n";
fs.writeFileSync(path.join(root, "source-data.js"), output);
console.log("Synced " + entries.length + " real Solana source files into source-data.js");