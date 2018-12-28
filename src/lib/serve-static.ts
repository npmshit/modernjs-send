/*!
 * serve-static
 * Copyright(c) 2010 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2014-2016 Douglas Christopher Wilson
 * Copyright (c) 2018 Zongmin Lei <leizongmin@gmail.com>
 * MIT Licensed
 */

"use strict";

/**
 * Module dependencies.
 * @private
 */

import * as url from "url";
import { resolve } from "path";
import { send, SendStream } from "./send";
import { IncomingMessage, ServerResponse } from "http";
import { encodeUrl } from "../modules/encodeurl";
import { escapeHtml } from "../modules/escape-html";
import { parseUrl, getOriginalUrl } from "../modules/parseurl";

export interface IServeStaticOptions {
  /**
   * Enable or disable setting Cache-Control response header, defaults to true.
   * Disabling this will ignore the immutable and maxAge options.
   */
  cacheControl?: boolean;

  /**
   * Set how "dotfiles" are treated when encountered. A dotfile is a file or directory that begins with a dot (".").
   * Note this check is done on the path itself without checking if the path actually exists on the disk.
   * If root is specified, only the dotfiles above the root are checked (i.e. the root itself can be within a dotfile when when set to "deny").
   * The default value is 'ignore'.
   * 'allow' No special treatment for dotfiles
   * 'deny' Send a 403 for any request for a dotfile
   * 'ignore' Pretend like the dotfile does not exist and call next()
   */
  dotfiles?: "allow" | "deny" | "ignore";

  /**
   * Enable or disable etag generation, defaults to true.
   */
  etag?: boolean;

  /**
   * Set file extension fallbacks. When set, if a file is not found, the given extensions will be added to the file name and search for.
   * The first that exists will be served. Example: ['html', 'htm'].
   * The default value is false.
   */
  extensions?: string[];

  /**
   * Let client errors fall-through as unhandled requests, otherwise forward a client error.
   * The default value is false.
   */
  fallthrough?: boolean;

  /**
   * Enable or disable the immutable directive in the Cache-Control response header.
   * If enabled, the maxAge option should also be specified to enable caching. The immutable directive will prevent supported clients from making conditional requests during the life of the maxAge option to check if the file has changed.
   */
  immutable?: boolean;

  /**
   * By default this module will send "index.html" files in response to a request on a directory.
   * To disable this set false or to supply a new index pass a string or an array in preferred order.
   */
  index?: boolean | string | string[];

  /**
   * Enable or disable Last-Modified header, defaults to true. Uses the file system's last modified value.
   */
  lastModified?: boolean;

  /**
   * Provide a max-age in milliseconds for http caching, defaults to 0. This can also be a string accepted by the ms module.
   */
  maxAge?: number | string;

  /**
   * Redirect to trailing "/" when the pathname is a dir. Defaults to true.
   */
  redirect?: boolean;

  /**
   * Function to set custom headers on response. Alterations to the headers need to occur synchronously.
   * The function is called as fn(res, path, stat), where the arguments are:
   * res the response object
   * path the file path that is being sent
   * stat the stat object of the file that is being sent
   */
  setHeaders?: (res: ServerResponse, path: string, stat: any) => any;

  /**
   * Serve files relative to path.
   */
  root?: string;
}

/**
 * @param {string} root
 * @param {object} [options]
 * @return {function}
 */
export function serveStatic(root: string, options: IServeStaticOptions = {}) {
  if (!root) {
    throw new TypeError("root path required");
  }

  if (typeof root !== "string") {
    throw new TypeError("root path must be a string");
  }

  // copy options object
  const opts = { ...options };

  // fall-though
  const fallthrough = opts.fallthrough !== false;

  // default redirect
  const redirect = opts.redirect !== false;

  // headers listener
  const setHeaders = opts.setHeaders;

  if (setHeaders && typeof setHeaders !== "function") {
    throw new TypeError("option setHeaders must be function");
  }

  // setup options for send
  opts.maxAge = opts.maxAge || 0;
  opts.root = resolve(root);

  return function serveStatic(req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (fallthrough) {
        return next();
      }

      // method not allowed
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.setHeader("Content-Length", "0");
      res.end();
      return;
    }

    let forwardError = !fallthrough;
    let path = parseUrl(req)!.pathname;
    const originalUrl = getOriginalUrl(req);

    // make sure redirect occurs at mount
    if (path === "/" && originalUrl.pathname!.substr(-1) !== "/") {
      path = "";
    }

    // create send stream
    const stream = send(req, path!, opts);

    // construct directory listener
    const onDirectory = redirect ? createRedirectDirectoryListener(stream) : createNotFoundDirectoryListener(stream);

    // add directory handler
    stream.on("directory", onDirectory);

    // add headers listener
    if (setHeaders) {
      stream.on("headers", setHeaders);
    }

    // add file listener for fallthrough
    if (fallthrough) {
      stream.on("file", function onFile() {
        // once file is determined, always forward error
        forwardError = true;
      });
    }

    // forward errors
    stream.on("error", function error(err) {
      if (forwardError || !(err.statusCode < 500)) {
        next(err);
        return;
      }

      next();
    });

    // pipe
    stream.pipe(res);
  };
}

/**
 * Collapse all leading slashes into a single slash
 */
function collapseLeadingSlashes(str: string) {
  let i = 0;
  for (; i < str.length; i++) {
    if (str.charCodeAt(i) !== 0x2f /* / */) {
      break;
    }
  }

  return i > 1 ? "/" + str.substr(i) : str;
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
 * Create a directory listener that just 404s.
 */
function createNotFoundDirectoryListener(stream: SendStream) {
  return function notFound() {
    stream.error(404);
  };
}

/**
 * Create a directory listener that performs a redirect.
 */
function createRedirectDirectoryListener(stream: SendStream) {
  return function redirect(res: ServerResponse) {
    if (stream.hasTrailingSlash()) {
      stream.error(404);
      return;
    }

    // get original URL
    const originalUrl = getOriginalUrl(stream.req);

    // append trailing slash
    originalUrl.path = null as any;
    originalUrl.pathname = collapseLeadingSlashes(originalUrl.pathname + "/");

    // reformat the URL
    const loc = encodeUrl(url.format(originalUrl));
    const doc = createHtmlDocument(
      "Redirecting",
      'Redirecting to <a href="' + escapeHtml(loc) + '">' + escapeHtml(loc) + "</a>",
    );

    // send redirect response
    res.statusCode = 301;
    res.setHeader("Content-Type", "text/html; charset=UTF-8");
    res.setHeader("Content-Length", Buffer.byteLength(doc));
    res.setHeader("Content-Security-Policy", "default-src 'self'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Location", loc);
    res.end(doc);
  };
}
