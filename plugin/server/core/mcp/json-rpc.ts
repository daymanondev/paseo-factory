/** JSON-RPC framing is independent of the selected execution mode and role. */
import type { Readable, Writable } from "node:stream";
export function createJsonRpcTransport(onMessage: (message: unknown) => Promise<void>, input: Readable = process.stdin, output: Writable = process.stdout) {
  let responseFraming = "newline";
  let stdinBuffer = Buffer.alloc(0);
  let pendingOps = 0;
  let stdinEnded = false;

  function writeJsonRpcMessage(msg: unknown) {
    const json = JSON.stringify(msg);
    if (responseFraming === "content-length") {
      const bytes = Buffer.from(json, "utf8");
      output.write(`Content-Length: ${bytes.length}\r\n\r\n`);
      output.write(bytes);
    } else {
      output.write(`${json}\n`);
    }
  }

  function drainStdinBuffer() {
    while (stdinBuffer.length > 0) {
      const preview = stdinBuffer.subarray(0, Math.min(stdinBuffer.length, 64)).toString("utf8");
      const trimmedPreview = preview.replace(/^[\r\n]+/, "");
      if (trimmedPreview.length < preview.length) {
        const trimBytes = Buffer.byteLength(preview.slice(0, preview.length - trimmedPreview.length), "utf8");
        stdinBuffer = stdinBuffer.subarray(trimBytes);
        if (stdinBuffer.length === 0) break;
      }
      const headStr = stdinBuffer.subarray(0, Math.min(stdinBuffer.length, 32)).toString("utf8");
      if (/^Content-Length:/i.test(headStr)) {
        responseFraming = "content-length";
        const sepIndex = stdinBuffer.indexOf("\r\n\r\n");
        const lfSepIndex = stdinBuffer.indexOf("\n\n");
        let headerEnd = -1;
        let sepLen = 4;
        if (sepIndex !== -1 && (lfSepIndex === -1 || sepIndex < lfSepIndex)) {
          headerEnd = sepIndex;
          sepLen = 4;
        } else if (lfSepIndex !== -1) {
          headerEnd = lfSepIndex;
          sepLen = 2;
        }
        if (headerEnd === -1) return;
        const headerText = stdinBuffer.subarray(0, headerEnd).toString("utf8");
        const m = /Content-Length:\s*(\d+)/i.exec(headerText);
        if (!m) {
          stdinBuffer = stdinBuffer.subarray(headerEnd + sepLen);
          continue;
        }
        const contentLen = Number(m[1]);
        const totalLen = headerEnd + sepLen + contentLen;
        if (stdinBuffer.length < totalLen) return;
        const bodyStr = stdinBuffer.subarray(headerEnd + sepLen, totalLen).toString("utf8");
        stdinBuffer = stdinBuffer.subarray(totalLen);
        let parsed;
        try {
          parsed = JSON.parse(bodyStr);
        } catch {
          continue;
        }
        dispatchMessage(parsed);
      } else {
        const nlIndex = stdinBuffer.indexOf("\n");
        if (nlIndex === -1) return;
        const line = stdinBuffer.subarray(0, nlIndex).toString("utf8").trim();
        stdinBuffer = stdinBuffer.subarray(nlIndex + 1);
        if (line === "") continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        dispatchMessage(parsed);
      }
    }
  }

  let rpcQueue = Promise.resolve();

  function dispatchMessage(parsed: unknown) {
    pendingOps += 1;
    rpcQueue = rpcQueue
      .then(() => onMessage(parsed))
      .catch(() => {})
      .finally(() => {
        pendingOps -= 1;
        if (stdinEnded && pendingOps === 0) {
          process.exit(0);
        }
      });
  }

  function start() {
    input.on("data", (chunk: Buffer | string) => {
      stdinBuffer = Buffer.concat([stdinBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      drainStdinBuffer();
    });

    input.on("end", () => {
      stdinEnded = true;
      drainStdinBuffer();
      if (pendingOps === 0) {
        process.exit(0);
      }
    });
  }
  return { write: writeJsonRpcMessage, start };
}
