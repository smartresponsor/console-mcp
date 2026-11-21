import type { ServerResponse } from "node:http";

/**
 * Counts UTF-8 / selected-encoding response body bytes passed to write/end.
 * Not HTTP wire bytes: headers, chunk framing, TLS and compression are excluded.
 * On aborted requests this is an attempted-byte count, not delivered bytes.
 *
 * Leave the original ServerResponse method signatures, return values and callbacks
 * untouched. Never inspect, persist or log the actual body.
 */
export function measureResponseBodyBytes(response: ServerResponse): { readonly attemptedBytes: number } {
  let attemptedBytes = 0;

  const count = (args: unknown[]): void => {
    const chunk = args[0];
    const encoding = typeof args[1] === "string" ? args[1] as BufferEncoding : undefined;
    if (typeof chunk === "string") {
      attemptedBytes += Buffer.byteLength(chunk, encoding);
    } else if (chunk instanceof Uint8Array) {
      attemptedBytes += chunk.byteLength;
    }
  };

  response.write = new Proxy(response.write, {
    apply(target, thisArg, args: unknown[]) {
      count(args);
      return Reflect.apply(target, thisArg, args);
    },
  });

  response.end = new Proxy(response.end, {
    apply(target, thisArg, args: unknown[]) {
      count(args);
      return Reflect.apply(target, thisArg, args);
    },
  });

  return {
    get attemptedBytes() { return attemptedBytes; },
  };
}
