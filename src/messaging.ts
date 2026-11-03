import type { Request, Response } from "./types.js";

export async function send<T>(req: Request): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as Response<T> | undefined;
  if (!res) throw new Error("バックグラウンドから応答がありません");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
