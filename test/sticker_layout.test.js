const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadCreateStickerLayout() {
  const appPath = path.join(__dirname, "..", "front", "app.js");
  const source = readFileSync(appPath, "utf8");
  const start = source.indexOf("function createSeededRandom");
  const end = source.indexOf("// 그날 로그들의 sticker_path", start);
  assert.notEqual(start, -1, "createSeededRandom source should exist");
  assert.notEqual(end, -1, "sticker cover render source should exist");

  const context = {};
  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.createStickerLayout = createStickerLayout;`,
    context,
  );
  return (stickerPaths) => JSON.parse(JSON.stringify(context.createStickerLayout(stickerPaths)));
}

function rotatedBounds(sticker) {
  const radians = sticker.rotation * Math.PI / 180;
  const side = sticker.width * (Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians)));
  const centerX = sticker.left + sticker.width / 2;
  const centerY = sticker.top + sticker.width / 2;
  return {
    left: centerX - side / 2,
    right: centerX + side / 2,
    top: centerY - side / 2,
    bottom: centerY + side / 2,
  };
}

test("sticker layout is stable for the same paths but changes with the seed", () => {
  const createStickerLayout = loadCreateStickerLayout();
  const paths = ["a.png", "b.png", "c.png", "d.png"];

  assert.deepEqual(createStickerLayout(paths), createStickerLayout(paths));
  assert.notDeepEqual(createStickerLayout(paths), createStickerLayout(["e.png", ...paths.slice(1)]));
});

test("rotated stickers stay inside the cover and never overlap", () => {
  const createStickerLayout = loadCreateStickerLayout();
  const epsilon = 1e-8;

  for (let count = 1; count <= 16; count += 1) {
    const layout = createStickerLayout(
      Array.from({ length: count }, (_, index) => `sticker-${count}-${index}.png`),
    );
    assert.equal(layout.length, count);

    const bounds = layout.map(rotatedBounds);
    for (const box of bounds) {
      assert.ok(box.left >= -epsilon, `count ${count}: left edge escaped`);
      assert.ok(box.top >= -epsilon, `count ${count}: top edge escaped`);
      assert.ok(box.right <= 100 + epsilon, `count ${count}: right edge escaped`);
      assert.ok(box.bottom <= 100 + epsilon, `count ${count}: bottom edge escaped`);
    }

    for (let first = 0; first < bounds.length; first += 1) {
      for (let second = first + 1; second < bounds.length; second += 1) {
        const a = bounds[first];
        const b = bounds[second];
        const separated = (
          a.right <= b.left + epsilon
          || b.right <= a.left + epsilon
          || a.bottom <= b.top + epsilon
          || b.bottom <= a.top + epsilon
        );
        assert.ok(separated, `count ${count}: stickers ${first} and ${second} overlap`);
      }
    }
  }
});

test("stickers occupy distinct regions across the cover", () => {
  const createStickerLayout = loadCreateStickerLayout();
  const padding = 5;

  for (let count = 2; count <= 16; count += 1) {
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    const cellWidth = (100 - padding * 2) / columns;
    const cellHeight = (100 - padding * 2) / rows;
    const layout = createStickerLayout(
      Array.from({ length: count }, (_, index) => `spread-${count}-${index}.png`),
    );
    const occupiedCells = new Set(layout.map((sticker) => {
      const centerX = sticker.left + sticker.width / 2;
      const centerY = sticker.top + sticker.width / 2;
      const column = Math.max(0, Math.min(columns - 1, Math.floor((centerX - padding) / cellWidth)));
      const row = Math.max(0, Math.min(rows - 1, Math.floor((centerY - padding) / cellHeight)));
      return `${column}:${row}`;
    }));

    assert.equal(occupiedCells.size, count, `count ${count}: stickers clustered in one region`);
  }
});
