/*!
 * destroy
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2018 Zongmin Lei <leizongmin@gmail.com>
 * MIT Licensed
 */

import { ReadStream } from "fs";
import { Stream } from "stream";

export interface IReadStream extends ReadStream {
  fd?: number;
}

/**
 * Destroy a stream.
 *
 * @param {object} stream
 */
export function destroy(stream: Stream) {
  if (stream instanceof ReadStream) {
    return destroyReadStream(stream as ReadStream);
  }

  if (!(stream instanceof Stream)) {
    return stream;
  }

  if (typeof (stream as any).destroy === "function") {
    (stream as any).destroy();
  }

  return stream;
}

/**
 * Destroy a ReadStream.
 *
 * @param {object} stream
 */
function destroyReadStream(stream: IReadStream) {
  stream.destroy();

  if (typeof stream.close === "function") {
    // node.js core bug work-around
    stream.on("open", () => {
      if (typeof stream.fd === "number") {
        // actually close down the fd
        stream.close();
      }
    });
  }

  return stream;
}
