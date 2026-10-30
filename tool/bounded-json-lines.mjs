// Bounded protocol framing. Never accumulate an entire untrusted stream.
export function boundedLines(stream, maximumBytes, onLine, onFailure) {
  let pending = Buffer.alloc(0), failed = false;
  stream.on('data', chunk => {
    if (failed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (pending.length + end - offset > maximumBytes) {
        failed = true; onFailure(Error('protocol_frame_limit')); return;
      }
      pending = Buffer.concat([pending, chunk.subarray(offset, end)]);
      if (newline < 0) break;
      const line = pending.toString('utf8'); pending = Buffer.alloc(0);
      onLine(line); offset = newline + 1;
    }
  });
}
