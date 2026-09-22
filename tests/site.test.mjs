import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const html = read("index.html");
const program = read("programs/firmware/src/lib.rs");

test("every board chip maps to a real program symbol", () => {
  const buttons = [...html.matchAll(/<button class="runtime-chip[^>]+>/g)].map((match) => match[0]);
  assert.equal(buttons.length, 18);
  for (const button of buttons) {
    const source = button.match(/data-open="([^"]+)"/)?.[1];
    const symbol = button.match(/data-symbol="([^"]+)"/)?.[1];
    assert.equal(source, "programs/firmware/src/lib.rs");
    assert.ok(symbol && program.includes(symbol), symbol ?? button);
    assert.equal([...button.matchAll(/data-module=/g)].length, 1);
  }
});

test("source browser embeds the checked-in program exactly", () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read("source-data.js"), sandbox);
  assert.equal(sandbox.window.FIRMWARE_SOURCE_OBJECTS["programs/firmware/src/lib.rs"].content, program.replace(/\r\n/g, "\n"));
  for (const file of Object.keys(sandbox.window.FIRMWARE_SOURCE_OBJECTS)) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
    assert.ok(!file.startsWith("contracts/"), file);
  }
});

test("public page contains no prior chain or signature claims", () => {
  assert.doesNotMatch(html, /Robinhood|EIP.712|ERC.1271|EVM|\.sol\b/i);
  assert.match(html, /F8XJnif9YTTV7fxZzGsp9KZdUkaC6n2cjArejj8Ypump/);
  assert.match(html, /Solana/);
});