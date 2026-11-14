import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
console.log("PASS response-body-measurement-regression");
