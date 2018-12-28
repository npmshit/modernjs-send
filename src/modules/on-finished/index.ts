/*!
 * on-finished
 * Copyright(c) 2013 Jonathan Ong
 * Copyright(c) 2014 Douglas Christopher Wilson
 * Copyright(c) 2018 Zongmin Lei <leizongmin@gmail.com>
 * MIT Licensed
 */

import { ServerResponse } from "http";
import { Socket } from "net";
import { first } from "../ee-first";

/**
 * Invoke callback when the response has finished, useful for
 * cleaning up resources afterwards.
 *
 * @param {object} msg
 * @param {function} listener
 * @return {object}
 * @public
 */
export function onFinished(msg: any, listener: Function) {
  if (isFinished(msg) !== false) {
    setImmediate(listener as any, null, msg);
    return msg;
  }

  // attach the listener to the message
  attachListener(msg, listener);

  return msg;
}

/**
 * Determine if message is already finished.
 *
 * @param {object} msg
 * @return {boolean}
 */
export function isFinished(msg: any) {
  const socket = msg.socket;

  if (typeof msg.finished === "boolean") {
    // OutgoingMessage
    return Boolean(msg.finished || (socket && !socket.writable));
  }

  if (typeof msg.complete === "boolean") {
    // IncomingMessage
    return Boolean(msg.upgrade || !socket || !socket.readable || (msg.complete && !msg.readable));
  }

  // don't know
  return undefined;
}

/**
 * Attach a finished listener to the message.
 *
 * @param {object} msg
 * @param {function} callback
 */
function attachFinishedListener(msg: any, callback: Function) {
  let eeMsg: { (fn: Function): void; cancel: any; };
  let eeSocket: { (fn: Function): void; (fn: Function): void; (fn: Function): void; cancel: any; };
  let finished = false;

  function onFinish(err: Error) {
    eeMsg.cancel();
    eeSocket.cancel();

    finished = true;
    callback(err);
  }

  // finished on first message event
  eeMsg = eeSocket = first([[msg, "end", "finish"]], onFinish);

  function onSocket(socket: Socket) {
    // remove listener
    msg.removeListener("socket", onSocket);

    if (finished) return;
    if (eeMsg !== eeSocket) return;

    // finished on first socket event
    eeSocket = first([[socket, "error", "close"]], onFinish);
  }

  if (msg.socket) {
    // socket already assigned
    onSocket(msg.socket);
    return;
  }

  // wait for socket to be assigned
  msg.on("socket", onSocket);

  if (msg.socket === undefined) {
    // node.js 0.8 patch
    patchAssignSocket(msg, onSocket);
  }
}

/**
 * Attach the listener to the message.
 *
 * @param {object} msg
 * @return {function}
 * @private
 */

function attachListener(msg: any, listener: Function) {
  let attached = msg.__onFinished;

  // create a private single listener with queue
  if (!attached || !attached.queue) {
    attached = msg.__onFinished = createListener(msg);
    attachFinishedListener(msg, attached);
  }

  attached.queue.push(listener);
}

/**
 * Create listener on message.
 *
 * @param {object} msg
 * @return {function}
 * @private
 */

function createListener(msg: any) {
  interface IListener {
    (err: Error): void;
    queue: Array<(err: Error, msg: any) => void> | null;
  }
  const listener: IListener = (err: Error) => {
    if (msg.__onFinished === listener) msg.__onFinished = null;
    if (!listener.queue) return;

    const queue = listener.queue;
    listener.queue = null;

    for (let i = 0; i < queue.length; i++) {
      queue[i](err, msg);
    }
  };

  listener.queue = [] as any;

  return listener;
}

/**
 * Patch ServerResponse.prototype.assignSocket for node.js 0.8.
 *
 * @param {ServerResponse} res
 * @param {function} callback
 */
function patchAssignSocket(res: ServerResponse, callback: (s: Socket) => void) {
  const assignSocket = res.assignSocket;

  if (typeof assignSocket !== "function") return;

  // res.on('socket', callback) is broken in 0.8
  res.assignSocket = function _assignSocket(socket) {
    assignSocket.call(this, socket);
    callback(socket);
  };
}
