/*!
 * parseurl
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2014-2017 Douglas Christopher Wilson
 * Copyright(c) 2018 Zongmin Lei <leizongmin@gmail.com>
 * MIT Licensed
 */

import { parse, Url } from "url";
import { IncomingMessage } from "http";

interface IServerRequest extends IncomingMessage {
  _parsedUrl?: IParsedUrl;
  originalUrl?: string;
  _parsedOriginalUrl?: IParsedUrl;
}

interface IParsedUrl extends Url {
  _raw?: any;
}

/**
 * Parse the `req` url with memoization.
 *
 * @param {ServerRequest} req
 * @return {Object}
 */
export function parseUrl(req: IServerRequest) {
  const url = req.url;

  if (url === undefined) {
    // URL is undefined
    return undefined;
  }

  let parsed = req._parsedUrl;

  if (fresh(url, parsed || null)) {
    // Return cached URL parse
    return parsed;
  }

  // Parse the URL
  parsed = fastparse(url);
  parsed._raw = url;

  return (req._parsedUrl = parsed);
}

/**
 * Parse the `req` original url with fallback and memoization.
 *
 * @param {ServerRequest} req
 * @return {Object}
 * @public
 */

export function getOriginalUrl(req: IServerRequest): IParsedUrl {
  const url = req.originalUrl;

  if (typeof url !== "string") {
    // Fallback
    return parseUrl(req)!;
  }

  let parsed = req._parsedOriginalUrl;

  if (fresh(url, parsed || null)) {
    // Return cached URL parse
    return parsed!;
  }

  // Parse the URL
  parsed = fastparse(url);
  parsed._raw = url;

  return (req._parsedOriginalUrl = parsed);
}

/**
 * Parse the `str` url with fast-path short-cut.
 *
 * @param {string} str
 * @return {Object}
 * @private
 */

function fastparse(str: string) {
  if (typeof str !== "string" || str.charCodeAt(0) !== 0x2f /* / */) {
    return parse(str);
  }

  let pathname = str;
  let query = null;
  let search = null;

  // This takes the regexp from https://github.com/joyent/node/pull/7878
  // Which is /^(\/[^?#\s]*)(\?[^#\s]*)?$/
  // And unrolls it into a for loop
  for (let i = 1; i < str.length; i++) {
    switch (str.charCodeAt(i)) {
      case 0x3f /* ?  */:
        if (search === null) {
          pathname = str.substring(0, i);
          query = str.substring(i + 1);
          search = str.substring(i);
        }
        break;
      case 0x09: /* \t */
      case 0x0a: /* \n */
      case 0x0c: /* \f */
      case 0x0d: /* \r */
      case 0x20: /*    */
      case 0x23: /* #  */
      case 0xa0:
      case 0xfeff:
        return parse(str);
    }
  }

  const url: Url = {
    path: str,
    href: str,
    pathname: pathname,
    query: query,
    search: search!,
  };
  return url;
}

/**
 * Determine if parsed is still fresh for url.
 *
 * @param {string} url
 * @param {object} parsedUrl
 * @return {boolean}
 */
function fresh(url: string, parsedUrl: IParsedUrl | null) {
  return typeof parsedUrl === "object" && parsedUrl !== null && parsedUrl._raw === url;
}
