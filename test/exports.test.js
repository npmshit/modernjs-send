const assert = require("assert");
const { mime, debug } = require("../dist/lib");

describe("exports", function() {
  it("should exports mime", function() {
    assert.equal(mime.getType("json"), "application/json");
  });

  it("should exports debug", function() {
    assert.equal(typeof debug("test"), "function");
  });
});
