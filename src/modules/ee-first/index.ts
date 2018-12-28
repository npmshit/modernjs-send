/*!
 * ee-first
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2018 Zongmin Lei <leizongmin@gmail.com>
 * MIT Licensed
 */

import { Socket } from "net";

/**
 * Get the first event in a set of event emitters and event pairs.
 *
 * @param {array} stuff
 * @param {function} done
 * @public
 */
export function first(stuff: any[] | any[][] | (string | Socket)[][], done: Function) {
  if (!Array.isArray(stuff)) throw new TypeError("arg must be an array of [ee, events...] arrays");

  const cleanups: any = [];

  for (let i = 0; i < stuff.length; i++) {
    const arr = stuff[i];

    if (!Array.isArray(arr) || arr.length < 2) throw new TypeError("each array member must be [ee, events...]");

    const ee = arr[0];

    for (let j = 1; j < arr.length; j++) {
      const event = arr[j];
      const fn = listener(event, callback);

      // listen to the event
      ee.on(event, fn);
      // push this listener to the list of cleanups
      cleanups.push({
        ee: ee,
        event: event,
        fn: fn,
      });
    }
  }

  function callback() {
    cleanup();
    done.apply(null, arguments);
  }

  function cleanup() {
    let x;
    for (let i = 0; i < cleanups.length; i++) {
      x = cleanups[i];
      x.ee.removeListener(x.event, x.fn);
    }
  }

  function thunk(fn: Function) {
    done = fn;
  }

  thunk.cancel = cleanup;

  return thunk;
}

/**
 * Create the event listener.
 */
function listener(event: string, done: Function) {
  return function onevent(arg1: any) {
    const args = new Array(arguments.length);
    const ee = this;
    const err = event === "error" ? arg1 : null;

    // copy args to prevent arguments escaping scope
    for (let i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }

    done(err, ee, event, args);
  };
}
