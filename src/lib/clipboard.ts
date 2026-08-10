import { logger } from "./logger";

/**
 * Read clipboard text when the browser grants permission.
 * @returns 剪贴板文本内容，读取失败返回空字符串
 */
export async function readClipboardText(): Promise<string> {
  try {
    return (await navigator.clipboard?.readText?.()) || "";
  } catch (error) {
    logger.warn("clipboard", "Failed to read clipboard", error);
    return "";
  }
}

/**
 * Write clipboard text through the secure-context browser API.
 * @param text 要写入剪贴板的文本内容
 * @returns 是否写入成功
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    logger.warn("clipboard", "Failed to write clipboard", error);
    return false;
  }
}
