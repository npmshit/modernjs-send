/*!
 * etag
 * Copyright(c) 2014-2016 Douglas Christopher Wilson
 * Copyright(c) 2018 Zongmin Lei <leizongmin@gmail.com>
 * MIT Licensed
 */

import * as crypto from "crypto";
import { Stats } from "fs";

const toString = Object.prototype.toString;

/**
 * Generate an entity tag.
 *
 * @param {Buffer|string} entity
 * @return {string}
 */
function entitytag(entity: Buffer | string) {
  if (entity.length === 0) {
    // fast-path empty
    return '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';
  }

  // compute hash of entity
  const hash = crypto
    .createHash("sha1")
    .update(entity as any, "utf8")
    .digest("base64")
    .substring(0, 27);

  // compute length of entity
  const len = typeof entity === "string" ? Buffer.byteLength(entity, "utf8") : entity.length;

  return '"' + len.toString(16) + "-" + hash + '"';
}

/**
 * Create a simple ETag.
 *
 * @param {string|Buffer|Stats} entity
 * @param {object} [options]
 * @param {boolean} [options.weak]
 * @return {String}
 */
export function etag(entity: string | Buffer | Stats, options: { weak?: boolean } = {}) {
  if (entity == null) {
    throw new TypeError("argument entity is required");
  }

  // support fs.Stats object
  const isStats = isstats(entity);
  const weak = options && typeof options.weak === "boolean" ? options.weak : isStats;

  // validate argument
  if (!isStats && typeof entity !== "string" && !Buffer.isBuffer(entity)) {
    throw new TypeError("argument entity must be string, Buffer, or fs.Stats");
  }

  // generate entity tag
  const tag = isStats ? stattag(entity as Stats) : entitytag(entity as Buffer | string);

  return weak ? "W/" + tag : tag;
}

/**
 * Determine if object is a Stats object.
 *
 * @param {object} obj
 * @return {boolean}
 */
function isstats(obj: string | Buffer | Stats) {
  // genuine fs.Stats
  if (typeof Stats === "function" && obj instanceof Stats) {
    return true;
  }

  // quack quack
  return (
    obj &&
    typeof obj === "object" &&
    "ctime" in obj &&
    toString.call(obj.ctime) === "[object Date]" &&
    "mtime" in obj &&
    toString.call(obj.mtime) === "[object Date]" &&
    "ino" in obj &&
    typeof obj.ino === "number" &&
    "size" in obj &&
    typeof obj.size === "number"
  );
}

/**
 * Generate a tag for a stat.
 *
 * @param {object} stat
 * @return {string}
 */
function stattag(stat: Stats) {
  const mtime = stat.mtime.getTime().toString(16);
  const size = stat.size.toString(16);

  return '"' + size + "-" + mtime + '"';
}
