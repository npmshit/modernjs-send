/*!
 * send
 * Copyright(c) 2012 TJ Holowaychuk
 * Copyright(c) 2014-2016 Douglas Christopher Wilson
 * Copyright (c) 2018 Zongmin Lei <leizongmin@gmail.com>
 * MIT Licensed
 */

"use strict";

/**
 * Module dependencies.
 * @private
 */

import * as fs from "fs";
import { Stream } from "stream";
import { extname, join, normalize, resolve, sep } from "path";
import { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from "http";
import { EventEmitter } from "events";

import { getStatusCodeMessage, createHttpError, IHttpError } from "./utils";

import { ms } from "../modules/ms";
import { onFinished } from "../modules/on-finished";
import { rangeParser as parseRange } from "../modules/range-parser";
import { encodeUrl } from "../modules/encodeurl";
import { escapeHtml } from "../modules/escape-html";
import { etag } from "../modules/etag";
import { fresh } from "../modules/fresh";
import * as createDebug from "@modernjs/debug";
import * as mime from "@modernjs/mime";
const debug = createDebug("send");

/**
 * Regular expression for identifying a bytes Range header.
 */
const BYTES_RANGE_REGEXP = /^ *bytes=/;

/**
 * Maximum value allowed for the max age.
 */
const MAX_MAXAGE = 60 * 60 * 24 * 365 * 1000; // 1 year

/**
 * Regular expression to match a path with a directory up component.
 * @private
 */
const UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

export interface ISendOptions {
  /**
   * Enable or disable accepting ranged requests, defaults to true.
   * Disabling this will not send Accept-Ranges and ignore the contents of the Range request header.
   */
  acceptRanges?: boolean;

  /**
   * Enable or disable setting Cache-Control response header, defaults to true.
   * Disabling this will ignore the maxAge option.
   */
  cacheControl?: boolean;

  /**
   * Set how "dotfiles" are treated when encountered.
   * A dotfile is a file or directory that begins with a dot (".").
   * Note this check is done on the path itself without checking if the path actually exists on the disk.
   * If root is specified, only the dotfiles above the root are checked (i.e. the root itself can be within a dotfile when when set to "deny").
   * 'allow' No special treatment for dotfiles.
   * 'deny' Send a 403 for any request for a dotfile.
   * 'ignore' Pretend like the dotfile does not exist and 404.
   * The default value is similar to 'ignore', with the exception that this default will not ignore the files within a directory that begins with a dot, for backward-compatibility.
   */
  dotfiles?: "allow" | "deny" | "ignore";

  /**
   * Byte offset at which the stream ends, defaults to the length of the file minus 1.
   * The end is inclusive in the stream, meaning end: 3 will include the 4th byte in the stream.
   */
  end?: number;

  /**
   * Enable or disable etag generation, defaults to true.
   */
  etag?: boolean;

  /**
   * If a given file doesn't exist, try appending one of the given extensions, in the given order.
   * By default, this is disabled (set to false).
   * An example value that will serve extension-less HTML files: ['html', 'htm'].
   * This is skipped if the requested file already has an extension.
   */
  extensions?: string[] | string | boolean;

  /**
   * By default send supports "index.html" files, to disable this set false or to supply a new index pass a string or an array in preferred order.
   */
  index?: string[] | string | boolean;

  /**
   * Enable or disable Last-Modified header, defaults to true.
   * Uses the file system's last modified value.
   */
  lastModified?: boolean;

  /**
   * Provide a max-age in milliseconds for http caching, defaults to 0.
   * This can also be a string accepted by the ms module.
   */
  maxAge?: string | number;

  /**
   * Serve files relative to path.
   */
  root?: string;

  /**
   * Byte offset at which the stream starts, defaults to 0.
   * The start is inclusive, meaning start: 2 will include the 3rd byte in the stream.
   */
  start?: number;
}

/**
 * Return a `SendStream` for `req` and `path`.
 *
 * @param {object} req
 * @param {string} path
 * @param {object} [options]
 * @return {SendStream}
 * @public
 */
export function send(req: IncomingMessage, path: string, options: ISendOptions) {
  return new SendStream(req, path, options);
}

export class SendStream extends Stream {
  protected _acceptRanges: boolean;
  protected _cacheControl: boolean;
  protected _etag: boolean;
  protected _dotfiles?: "allow" | "deny" | "ignore";
  protected _extensions: string[];
  protected _index: string[];
  protected _lastModified: boolean;
  protected _maxage: number;
  protected _root: string | null;
  protected res?: ServerResponse;

  /**
   * Initialize a `SendStream` with the given `path`.
   *
   * @param {Request} req
   * @param {String} path
   * @param {object} [options]
   * @private
   */
  constructor(
    public readonly req: IncomingMessage,
    public readonly path: string,
    public readonly options: ISendOptions = {},
  ) {
    super();

    this._acceptRanges = options.acceptRanges !== undefined ? Boolean(options.acceptRanges) : true;

    this._cacheControl = options.cacheControl !== undefined ? Boolean(options.cacheControl) : true;

    this._etag = options.etag !== undefined ? Boolean(options.etag) : true;

    this._dotfiles = options.dotfiles !== undefined ? options.dotfiles : "ignore";

    if (this._dotfiles !== "ignore" && this._dotfiles !== "allow" && this._dotfiles !== "deny") {
      throw new TypeError('dotfiles option must be "allow", "deny", or "ignore"');
    }

    // legacy support
    if (options.dotfiles === undefined) {
      this._dotfiles = undefined;
    }

    this._extensions = options.extensions !== undefined ? normalizeList(options.extensions, "extensions option") : [];

    this._index = options.index !== undefined ? normalizeList(options.index, "index option") : ["index.html"];

    this._lastModified = options.lastModified !== undefined ? Boolean(options.lastModified) : true;

    const maxage: any = typeof options.maxAge === "string" ? ms(options.maxAge) : Number(options.maxAge);
    this._maxage = !isNaN(maxage) ? Math.min(Math.max(0, maxage), MAX_MAXAGE) : 0;

    this._root = options.root ? resolve(options.root) : null;
  }

  /**
   * Set root `path`.
   *
   * @param {String} path
   * @return {SendStream}
   */
  public root(path: string) {
    this._root = resolve(String(path));
    debug("root %s", this._root);
    return this;
  }

  /**
   * Emit error with `status`.
   *
   * @param {number} status
   * @param {Error} [err]
   */
  public error(status: number, err?: IHttpError) {
    // emit if listeners instead of responding
    if (hasListeners(this, "error")) {
      return this.emit("error", createHttpError(status, err));
    }

    const res = this.res!;
    const msg = getStatusCodeMessage(status);
    const doc = createHtmlDocument("Error", escapeHtml(msg));

    // clear existing headers
    clearHeaders(res);

    // add error headers
    if (err && err.headers) {
      setHeaders(res, err.headers);
    }

    // send basic response
    res.statusCode = status;
    res.setHeader("Content-Type", "text/html; charset=UTF-8");
    res.setHeader("Content-Length", Buffer.byteLength(doc));
    res.setHeader("Content-Security-Policy", "default-src 'self'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(doc);
  }

  /**
   * Check if the pathname ends with "/".
   *
   * @return {boolean}
   */
  public hasTrailingSlash() {
    return this.path[this.path.length - 1] === "/";
  }

  /**
   * Check if this is a conditional GET request.
   *
   * @return {Boolean}
   */
  protected isConditionalGET() {
    return (
      this.req.headers["if-match"] ||
      this.req.headers["if-unmodified-since"] ||
      this.req.headers["if-none-match"] ||
      this.req.headers["if-modified-since"]
    );
  }

  /**
   * Check if the request preconditions failed.
   *
   * @return {boolean}
   */
  protected isPreconditionFailure() {
    const req = this.req;
    const res = this.res!;

    // if-match
    const match = req.headers["if-match"];
    if (match) {
      const etag = res.getHeader("ETag");
      return (
        !etag ||
        (match !== "*" &&
          parseTokenList(match).every(function(match) {
            return match !== etag && match !== "W/" + etag && "W/" + match !== etag;
          }))
      );
    }

    // if-unmodified-since
    const unmodifiedSince = parseHttpDate(req.headers["if-unmodified-since"]);
    if (!isNaN(unmodifiedSince)) {
      const lastModified = parseHttpDate(res.getHeader("Last-Modified"));
      return isNaN(lastModified) || lastModified > unmodifiedSince;
    }

    return false;
  }

  /**
   * Strip content-* header fields.
   */
  protected removeContentHeaderFields() {
    const res = this.res!;
    const headers = getHeaderNames(res);

    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      if (header.substr(0, 8) === "content-" && header !== "content-location") {
        res.removeHeader(header);
      }
    }
  }

  /**
   * Respond with 304 not modified.
   */
  protected notModified() {
    const res = this.res!;
    debug("not modified");
    this.removeContentHeaderFields();
    res.statusCode = 304;
    res.end();
  }

  /**
   * Raise error that headers already sent.
   */
  protected headersAlreadySent() {
    const err = new Error("Can't set headers after they are sent.");
    debug("headers already sent");
    this.error(500, err);
  }

  /**
   * Check if the request is cacheable, aka
   * responded with 2xx or 304 (see RFC 2616 section 14.2{5,6}).
   *
   * @return {Boolean}
   */
  protected isCachable() {
    const statusCode = this.res!.statusCode;
    return (statusCode >= 200 && statusCode < 300) || statusCode === 304;
  }

  /**
   * Handle stat() error.
   *
   * @param {Error} error
   */
  protected onStatError(error: IHttpError) {
    switch (error.code) {
      case "ENAMETOOLONG":
      case "ENOENT":
      case "ENOTDIR":
        this.error(404, error);
        break;
      default:
        this.error(500, error);
        break;
    }
  }

  /**
   * Check if the cache is fresh.
   *
   * @return {Boolean}
   */
  protected isFresh() {
    return fresh(this.req.headers, {
      etag: this.res!.getHeader("ETag"),
      "last-modified": this.res!.getHeader("Last-Modified"),
    });
  }

  /**
   * Check if the range is fresh.
   *
   * @return {Boolean}
   */
  protected isRangeFresh() {
    const ifRange = this.req.headers["if-range"];

    if (!ifRange) {
      return true;
    }

    // if-range as etag
    if (ifRange.indexOf('"') !== -1) {
      const etag = String(this.res!.getHeader("ETag"));
      return Boolean(etag && ifRange.indexOf(etag) !== -1);
    }

    // if-range as modified date
    const lastModified = this.res!.getHeader("Last-Modified");
    return parseHttpDate(lastModified) <= parseHttpDate(ifRange);
  }

  /**
   * Redirect to path.
   *
   * @param {string} path
   */
  protected redirect(path: string) {
    const res = this.res!;

    if (hasListeners(this, "directory")) {
      this.emit("directory", res, path);
      return;
    }

    if (this.hasTrailingSlash()) {
      this.error(403);
      return;
    }

    const loc = encodeUrl(collapseLeadingSlashes(this.path + "/"));
    const doc = createHtmlDocument(
      "Redirecting",
      'Redirecting to <a href="' + escapeHtml(loc) + '">' + escapeHtml(loc) + "</a>",
    );

    // redirect
    res.statusCode = 301;
    res.setHeader("Content-Type", "text/html; charset=UTF-8");
    res.setHeader("Content-Length", Buffer.byteLength(doc));
    res.setHeader("Content-Security-Policy", "default-src 'self'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Location", loc);
    res.end(doc);
  }

  /**
   * Pipe to `res.
   *
   * @param {Stream} res
   * @return {Stream} res
   */
  public pipe(res: any) {
    // root path
    const root = this._root;

    // references
    this.res = res;

    // decode the path
    const _path = decode(this.path);
    if (_path === -1) {
      this.error(400);
      return res;
    }
    let path = _path;

    // null byte(s)
    if (~path.indexOf("\0")) {
      this.error(400);
      return res;
    }

    let parts;
    if (root !== null) {
      // normalize
      if (path) {
        path = normalize("." + sep + path);
      }

      // malicious path
      if (UP_PATH_REGEXP.test(path)) {
        debug('malicious path "%s"', path);
        this.error(403);
        return res;
      }

      // explode path parts
      parts = path.split(sep);

      // join / normalize from optional root dir
      path = normalize(join(root, path));
    } else {
      // ".." is malicious without "root"
      if (UP_PATH_REGEXP.test(path)) {
        debug('malicious path "%s"', path);
        this.error(403);
        return res;
      }

      // explode path parts
      parts = normalize(path).split(sep);

      // resolve the path
      path = resolve(path);
    }

    // dotfile handling
    if (containsDotFile(parts)) {
      const access = this._dotfiles;

      debug('%s dotfile "%s"', access, path);
      switch (access) {
        case "allow":
          break;
        case "deny":
          this.error(403);
          return res;
        case "ignore":
        default:
          this.error(404);
          return res;
      }
    }

    // index file support
    if (this._index.length && this.hasTrailingSlash()) {
      this.sendIndex(path);
      return res;
    }

    this.sendFile(path);
    return res;
  }

  /**
   * Transfer `path`.
   *
   * @param {String} path
   * @api public
   */
  public send(path: string, stat: fs.Stats) {
    let len = stat.size;
    const options = this.options;
    const opts: Record<string, any> = {};
    const res = this.res!;
    const req = this.req;
    let ranges: any = req.headers.range;
    let offset = options.start || 0;

    if (headersSent(res)) {
      // impossible to send now
      this.headersAlreadySent();
      return;
    }

    debug('pipe "%s"', path);

    // set header fields
    this.setHeader(path, stat);

    // set content-type
    this.type(path);

    // conditional GET support
    if (this.isConditionalGET()) {
      if (this.isPreconditionFailure()) {
        this.error(412);
        return;
      }

      if (this.isCachable() && this.isFresh()) {
        this.notModified();
        return;
      }
    }

    // adjust len to start/end options
    len = Math.max(0, len - offset);
    if (options.end !== undefined) {
      const bytes = options.end - offset + 1;
      if (len > bytes) len = bytes;
    }

    // Range support
    if (this._acceptRanges && BYTES_RANGE_REGEXP.test(ranges!)) {
      // parse
      ranges = parseRange(len, ranges, {
        combine: true,
      });

      // If-Range support
      if (!this.isRangeFresh()) {
        debug("range stale");
        ranges = -2;
      }

      // unsatisfiable
      if (ranges === -1) {
        debug("range unsatisfiable");

        // Content-Range
        res.setHeader("Content-Range", contentRange("bytes", len));

        // 416 Requested Range Not Satisfiable
        return this.error(416, {
          headers: { "Content-Range": res.getHeader("Content-Range") },
        });
      }

      // valid (syntactically invalid/multiple ranges are treated as a regular response)
      if (ranges !== -2 && (ranges as string).length === 1) {
        debug("range %j", ranges);

        // Content-Range
        res.statusCode = 206;
        res.setHeader("Content-Range", contentRange("bytes", len, ranges[0]));

        // adjust for requested range
        offset += ranges[0].start;
        len = ranges[0].end - ranges[0].start + 1;
      }
    }

    // clone options
    for (const prop in options) {
      opts[prop] = (options as Record<string, any>)[prop];
    }

    // set read options
    opts.start = offset;
    opts.end = Math.max(offset, offset + len - 1);

    // content-length
    res.setHeader("Content-Length", len);

    // HEAD support
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    this.stream(path, opts);
  }

  /**
   * Transfer file for `path`.
   *
   * @param {String} path
   */
  protected sendFile(path: string) {
    let i = 0;

    const next = (err?: IHttpError) => {
      if (this._extensions.length <= i) {
        return err ? this.onStatError(err) : this.error(404);
      }

      const p = path + "." + this._extensions[i++];

      debug('stat "%s"', p);
      fs.stat(p, (err, stat) => {
        if (err) return next(err);
        if (stat.isDirectory()) return next();
        this.emit("file", p, stat);
        this.send(p, stat);
      });
    };

    debug('stat "%s"', path);
    fs.stat(path, (err, stat) => {
      if (err && err.code === "ENOENT" && !extname(path) && path[path.length - 1] !== sep) {
        // not found, check extensions
        return next(err);
      }
      if (err) return this.onStatError(err);
      if (stat.isDirectory()) return this.redirect(path);
      this.emit("file", path, stat);
      this.send(path, stat);
    });
  }

  /**
   * Transfer index for `path`.
   *
   * @param {String} path
   */
  protected sendIndex(path: string) {
    let i = -1;

    const next = (err?: IHttpError) => {
      if (++i >= this._index.length) {
        if (err) return this.onStatError(err);
        return this.error(404);
      }

      const p = join(path, this._index[i]);

      debug('stat "%s"', p);
      fs.stat(p, (err, stat) => {
        if (err) return next(err);
        if (stat.isDirectory()) return next();
        this.emit("file", p, stat);
        this.send(p, stat);
      });
    };

    next();
  }

  /**
   * Stream `path` to the response.
   *
   * @param {String} path
   * @param {Object} options
   */
  protected stream(
    path: string,
    options:
      | string
      | {
          flags?: string;
          encoding?: string;
          fd?: number;
          mode?: number;
          autoClose?: boolean;
          start?: number;
          end?: number;
          highWaterMark?: number;
        },
  ) {
    // TODO: this is all lame, refactor meeee
    let finished = false;
    const res = this.res!;

    // pipe
    const stream = fs.createReadStream(path, options);
    this.emit("stream", stream);
    stream.pipe(res);

    // response finished, done with the fd
    onFinished(res, () => {
      finished = true;
      stream.destroy();
    });

    // error handling code-smell
    stream.on("error", err => {
      // request already finished
      if (finished) return;

      // clean up stream
      finished = true;
      stream.destroy();

      // error
      this.onStatError(err);
    });

    // end
    stream.on("end", () => {
      this.emit("end");
    });
  }

  /**
   * Set content-type based on `path`
   * if it hasn't been explicitly set.
   *
   * @param {String} path
   */
  protected type(path: string) {
    const res = this.res!;

    if (res.getHeader("Content-Type")) return;

    const type = mime.getType(path);

    if (!type) {
      debug("no content-type");
      return;
    }

    debug("content-type %s", type);
    res.setHeader("Content-Type", type);
  }

  /**
   * Set response header fields, most
   * fields may be pre-defined.
   *
   * @param {String} path
   * @param {Object} stat
   */
  protected setHeader(path: string, stat: fs.Stats) {
    const res = this.res!;

    this.emit("headers", res, path, stat);

    if (this._acceptRanges && !res.getHeader("Accept-Ranges")) {
      debug("accept ranges");
      res.setHeader("Accept-Ranges", "bytes");
    }

    if (this._cacheControl && !res.getHeader("Cache-Control")) {
      const cacheControl = "public, max-age=" + Math.floor(this._maxage / 1000);
      debug("cache-control %s", cacheControl);
      res.setHeader("Cache-Control", cacheControl);
    }

    if (this._lastModified && !res.getHeader("Last-Modified")) {
      const modified = stat.mtime.toUTCString();
      debug("modified %s", modified);
      res.setHeader("Last-Modified", modified);
    }

    if (this._etag && !res.getHeader("ETag")) {
      const val = etag(stat);
      debug("etag %s", val);
      res.setHeader("ETag", val);
    }
  }
}

/**
 * Clear all headers from a response.
 *
 * @param {object} res
 */
function clearHeaders(res: ServerResponse) {
  const headers = getHeaderNames(res);

  for (let i = 0; i < headers.length; i++) {
    res.removeHeader(headers[i]);
  }
}

/**
 * Collapse all leading slashes into a single slash
 *
 * @param {string} str
 */
function collapseLeadingSlashes(str: string) {
  let i = 0;
  for (; i < str.length; i++) {
    if (str[i] !== "/") {
      break;
    }
  }

  return i > 1 ? "/" + str.substr(i) : str;
}

/**
 * Determine if path parts contain a dotfile.
 */
function containsDotFile(parts: string[]) {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length > 1 && part[0] === ".") {
      return true;
    }
  }

  return false;
}

/**
 * Create a Content-Range header.
 *
 * @param {string} type
 * @param {number} size
 * @param {array} [range]
 */
function contentRange(type: string, size: number, range?: { start: number; end: number }) {
  return type + " " + (range ? range.start + "-" + range.end : "*") + "/" + size;
}

/**
 * Create a minimal HTML document.
 *
 * @param {string} title
 * @param {string} body
 */
function createHtmlDocument(title: string, body: string) {
  return (
    "<!DOCTYPE html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    "<title>" +
    title +
    "</title>\n" +
    "</head>\n" +
    "<body>\n" +
    "<pre>" +
    body +
    "</pre>\n" +
    "</body>\n" +
    "</html>\n"
  );
}

/**
 * decodeURIComponent.
 *
 * Allows V8 to only deoptimize this fn instead of all
 * of send().
 *
 * @param {String} path
 */
function decode(path: string) {
  try {
    return decodeURIComponent(path);
  } catch (err) {
    return -1;
  }
}

/**
 * Get the header names on a respnse.
 *
 * @param {object} res
 * @returns {array[string]}
 */
function getHeaderNames(res: ServerResponse) {
  return typeof res.getHeaderNames !== "function" ? Object.keys((res as any)._headers || {}) : res.getHeaderNames();
}

/**
 * Determine if emitter has listeners of a given type.
 *
 * The way to do this check is done three different ways in Node.js >= 0.8
 * so this consolidates them into a minimal set using instance methods.
 *
 * @param {EventEmitter} emitter
 * @param {string} type
 * @returns {boolean}
 */
function hasListeners(emitter: EventEmitter, type: string) {
  const count =
    typeof emitter.listenerCount !== "function" ? emitter.listeners(type).length : emitter.listenerCount(type);

  return count > 0;
}

/**
 * Determine if the response headers have been sent.
 *
 * @param {object} res
 * @returns {boolean}
 */
function headersSent(res: ServerResponse) {
  return typeof res.headersSent !== "boolean" ? Boolean((res as any)._header) : res.headersSent;
}

/**
 * Normalize the index option into an array.
 *
 * @param {boolean|string|array} val
 * @param {string} name
 */
function normalizeList(val: boolean | string | string[], name: string) {
  const list = [].concat((val as any) || []);

  for (let i = 0; i < list.length; i++) {
    if (typeof list[i] !== "string") {
      throw new TypeError(name + " must be array of strings or false");
    }
  }

  return list;
}

/**
 * Parse an HTTP Date into a number.
 *
 * @param {string} date
 */
function parseHttpDate(date?: string | string[] | number) {
  const timestamp = date && Date.parse(String(date));

  return typeof timestamp === "number" ? timestamp : NaN;
}

/**
 * Parse a HTTP token list.
 *
 * @param {string} str
 */
function parseTokenList(str: string) {
  let end = 0;
  let start = 0;
  const list = [];

  // gather tokens
  for (let i = 0, len = str.length; i < len; i++) {
    switch (str.charCodeAt(i)) {
      case 0x20 /*   */:
        if (start === end) {
          start = end = i + 1;
        }
        break;
      case 0x2c /* , */:
        list.push(str.substring(start, end));
        start = end = i + 1;
        break;
      default:
        end = i + 1;
        break;
    }
  }

  // final token
  list.push(str.substring(start, end));

  return list;
}

/**
 * Set an object of headers on a response.
 *
 * @param {object} res
 * @param {object} headers
 */
function setHeaders(res: ServerResponse, headers: OutgoingHttpHeaders) {
  const keys = Object.keys(headers);

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    res.setHeader(key, headers[key]!);
  }
}
