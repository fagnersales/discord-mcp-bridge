/*
 * Vencord userplugin: DiscordMCP — native (main-process) half
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Runs in Discord's Electron MAIN process. Vencord auto-discovers `native.ts`
 * in a plugin folder and exposes its exports to the renderer half as
 * `VencordNative.pluginHelpers.DiscordMCP`.
 *
 * The renderer cannot read its own pixels — `webContents.capturePage()` lives
 * in the main process — so the screenshot tool hops here. `event.sender` is the
 * Discord renderer's WebContents; capturing it yields exactly the page content,
 * no window chrome and no hardware-acceleration black frames.
 *
 * NOTE: native handlers register at Discord STARTUP, not at plugin-enable time.
 * After adding this file you must fully quit and reopen Discord ONCE; Ctrl+R is
 * not enough. After that, toggling the renderer plugin only needs Ctrl+R.
 */

import type { IpcMainInvokeEvent } from "electron";

interface Rect { x: number; y: number; width: number; height: number; }

interface CaptureOpts {
    /** Sub-rectangle of the visible page to capture, in CSS pixels. */
    rect?: Rect;
    /** Scale the result down so its width is at most this many pixels. */
    maxWidth?: number;
    /** Encoding for the returned image. */
    format?: "png" | "jpeg";
    /** JPEG quality 1–100 (ignored for png). */
    quality?: number;
}

interface CaptureResult {
    data: string;          // base64-encoded image bytes
    mimeType: string;
    width: number;
    height: number;
    bytes: number;
}

/** Capture the Discord renderer (or a sub-rect of it) and return it base64. */
export async function captureScreenshot(
    event: IpcMainInvokeEvent,
    opts: CaptureOpts = {},
): Promise<CaptureResult> {
    let image = opts.rect
        ? await event.sender.capturePage(opts.rect)
        : await event.sender.capturePage();

    let { width, height } = image.getSize();
    if (width < 1 || height < 1)
        throw new Error("capturePage returned an empty image (is the Discord window minimized?)");

    const maxWidth = opts.maxWidth && opts.maxWidth > 0 ? Math.floor(opts.maxWidth) : 1600;
    if (width > maxWidth) {
        image = image.resize({ width: maxWidth, quality: "better" });
        ({ width, height } = image.getSize());
    }

    const format = opts.format === "jpeg" ? "jpeg" : "png";
    const buf = format === "jpeg"
        ? image.toJPEG(Math.min(100, Math.max(1, Math.floor(opts.quality ?? 85))))
        : image.toPNG();

    return {
        data: buf.toString("base64"),
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
        width,
        height,
        bytes: buf.length,
    };
}
