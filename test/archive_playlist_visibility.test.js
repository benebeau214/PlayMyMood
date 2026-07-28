const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = readFileSync(path.join(__dirname, "..", "front", "app.js"), "utf8");

function functionSource(name, nextFunctionName) {
  const start = appSource.indexOf(`async function ${name}`);
  const end = appSource.indexOf(`\nfunction ${nextFunctionName}`, start);
  assert.notEqual(start, -1, `${name} source should exist`);
  assert.notEqual(end, -1, `${nextFunctionName} source should exist`);
  return appSource.slice(start, end);
}

test("archive queries include ready playlists before their titles are saved", () => {
  const archiveQueries = [
    functionSource("loadArchiveMonthCounts", "renderArchiveShelves"),
    functionSource("renderArchiveMonthView", "getActiveArchivePlaylistRow"),
  ];

  for (const query of archiveQueries) {
    assert.match(query, /\.eq\("status", "ready"\)/);
    assert.doesNotMatch(query, /\.not\("title", "is", null\)/);
  }
});
