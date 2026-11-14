import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { measureResponseBodyBytes } from "../dist/Infrastructure/Diagnostics/ResponseBodyMeasurement.js";

function fakeResponse() {
  const emitter = new EventEmitter();
  const written = [];
  return Object.assign(emitter, {
    write(...args) { written.push(["write", ...args]); return true; },
    end(...args) { written.push(["end", ...args]); this.emit("finish"); return this; },
    written,
  });
}

const res = fakeResponse();
const originalReturn = res;
const metrics = measureResponseBodyBytes(res);
const callback = () => {};
let recordedAtFinish = null;
res.on("finish", () => { recordedAtFinish = metrics.attemptedBytes; });

assert.equal(res.write("é", "utf8", callback), true);
assert.equal(res.write(Buffer.from([0, 1, 2]), callback), true);
assert.equal(res.write(new Uint8Array([3, 4])), true);
assert.equal(res.end("A", "utf16le", callback), originalReturn);
assert.equal(metrics.attemptedBytes, 2 + 3 + 2 + 2);
assert.equal(recordedAtFinish, metrics.attemptedBytes);
assert.deepEqual(res.written[0], ["write", "é", "utf8", callback]);
assert.deepEqual(res.written[3], ["end", "A", "utf16le", callback]);

const streaming = fakeResponse();
const streamMetrics = measureResponseBodyBytes(streaming);
streaming.write("a");
streaming.write(Buffer.alloc(8192));
streaming.emit("close"); // interrupted stream: attempted bytes still counted
assert.equal(streamMetrics.attemptedBytes, 8193);

const empty = fakeResponse();
const emptyMetrics = measureResponseBodyBytes(empty);
empty.end(callback); // overload: callback only, no body
assert.equal(emptyMetrics.attemptedBytes, 0);
// Real Node ServerResponse path: end() must not double-count previous writes.
const server = createServer((_req, response) => {
  const measurement = measureResponseBodyBytes(response);
  response.once("finish", () => {
    assert.equal(measurement.attemptedBytes, 7);
    server.close();
  });
  response.write("é"); // 2 UTF-8 bytes
  response.end("hello"); // 5 UTF-8 bytes
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
assert.equal(await response.text(), "éhello");
await new Promise(resolve => server.once("close", resolve));
console.log("PASS response-body-measurement-regression");
