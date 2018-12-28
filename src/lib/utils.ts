/*!
 * 工具函数
 *
 * Copyright(c) 2018 Zongmin Lei <leizongmin@gmail.com>
 * MIT Licensed
 */

import { STATUS_CODES, OutgoingHttpHeaders, ServerResponse } from "http";

/**
 * HTTP Error
 */
export interface IHttpError {
  message?: string;
  name?: string;
  stack?: string;
  headers?: OutgoingHttpHeaders;
  code?: string | number;
  status?: string | number;
  statusCode?: string | number;
}

/**
 * 获取指定 HTTP 状态码的文本描述
 * @param status
 */
export function getStatusCodeMessage(status: number | string): string {
  const message = STATUS_CODES[status];
  if (!message) throw new Error(`invalid status code: ${status}`);
  return message;
}

/**
 * 创建 HTTP Error 对象
 * @param status
 * @param err
 */
export function createHttpError(status: number, err?: IHttpError) {
  if (err) {
    err.statusCode = err.status = status;
    return err;
  }
  err = new Error(getStatusCodeMessage(status));
  err.name = err.message!.replace(/\s+/, "") + "Error";
  err.statusCode = err.status = status;
  return err;
}

/**
 * 当 ServerResponse 完成时调用
 * @param res
 * @param callback
 */
export function onFinished(res: ServerResponse, callback: () => void) {
  if (res.finished) {
    return setImmediate(callback);
  }
  let hasCalled = false;
  const firstCallback = () => {
    if (!hasCalled) {
      hasCalled = true;
      callback();
    }
  };
  res.once("end", firstCallback);
  res.once("close", firstCallback);
  res.once("finish", firstCallback);
  res.once("error", firstCallback);
}
