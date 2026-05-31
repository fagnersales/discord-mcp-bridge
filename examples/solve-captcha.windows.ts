#!/usr/bin/env bun
/**
 * EXAMPLE captcha solver for `discord_join` (Windows).
 * =====================================================
 * This is the kind of script you point `discord_config`'s `captchaCommand` at:
 *
 *   discord_config  captchaCommand="bun /abs/path/examples/solve-captcha.windows.ts"
 *
 * The bridge runs it when a join is gated behind a captcha. Contract:
 *   - It is given context on stdin (JSON) and in env (CAPTCHA_GUILD_NAME, …) but
 *     NO pixel coordinates — it must find the captcha on screen itself, so it
 *     stays correct across resolutions, window positions, and monitors.
 *   - Exit 0 once the captcha is solved; non-zero (or hang past the configured
 *     timeout) means "not solved".
 *
 * This reference impl is Windows-only: it uses the `computer-use` project's
 * hardware-level mouse (Interception driver — produces trusted input that
 * passes hCaptcha's `isTrusted`/behavioural checks) plus its RapidOCR locator.
 * macOS/Linux users write their own equivalent (e.g. screencapture + cliclick,
 * or grim + ydotool) — the bridge ships none of this.
 *
 * Scope: clicks the "I am human" anchor checkbox only. If hCaptcha escalates to
 * an image-grid challenge, this exits non-zero and a human finishes it.
 */
import { screenshot } from "/mnt/c/Users/fsfag/p/computer-use/packages/capture/screenshot.ts";
import { runOcr, foundFuzzy } from "/mnt/c/Users/fsfag/p/computer-use/packages/ocr/rapidocr.ts";

const CLI = "/mnt/c/Users/fsfag/p/computer-use/packages/input/cli";
const IMOUSE = `${CLI}/imouse`;
const WINCTL = `${CLI}/winctl`;
// The captcha lives inside the Discord/Vesktop window; a full-desktop capture
// only sees it if that window is on top. Default to titles containing "Discord".
const WINDOW = process.env.CAPTCHA_WINDOW || "Discord";
// On a /mnt/c path so capture.ps1 (Windows) writes it AND the RapidOCR server
// (a WSL python process) can read the same file via the same /mnt/c path.
const SHOT = "/mnt/c/Users/fsfag/Pictures/captcha-shot.png";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sh = (args: string[]) => Bun.spawnSync({ cmd: args, stderr: "inherit" });

// hCaptcha's anchor checkbox is labelled "I am human" (localised — "Sou humano"
// in pt-BR etc.). The word "human" ALSO appears in the modal heading ("Are you
// human?"), so match the checkbox label specifically and, if more than one word
// still matches, take the LOWEST on screen — the checkbox sits below the heading.
const LABELS = ["sou humano", "i am human", "ich bin", "je suis humain", "soy humano"];

async function main() {
    // Bring Discord to the front so the desktop capture actually sees the modal,
    // then give it a beat to raise + finish animating in.
    sh([WINCTL, "activate", WINDOW]);
    await sleep(800);

    for (let attempt = 0; attempt < 3; attempt++) {
        screenshot({ outPath: SHOT });
        // runOcr words carry bbox as [x, y, w, h] in screen pixels.
        const words = runOcr(SHOT).words as { text: string; bbox: [number, number, number, number] }[];
        const matches = words.filter(w => LABELS.some(l => foundFuzzy(w.text, l)));
        if (!matches.length) { await sleep(800); continue; }

        // Lowest match = the checkbox label (heading is above it).
        const label = matches.reduce((a, b) => (b.bbox[1] > a.bbox[1] ? b : a));
        const [lx, ly, , lh] = label.bbox;

        // The checkbox square sits left of the label, vertically centred on it.
        // Offset is derived from the label's height, so it scales with
        // resolution / DPR rather than being a hardcoded pixel gap.
        const x = Math.round(lx - lh * 1.6);
        const y = Math.round(ly + lh / 2);

        // `imouse click` smooth-glides (~1s) before clicking, so the OS/app emit
        // the WM_MOUSEMOVE events hCaptcha's behavioural check wants to see.
        sh([IMOUSE, "click", "left", String(x), String(y)]);
        console.error(`[solver] clicked checkbox ~(${x},${y}) left of "${label.text}"`);
        return; // exit 0 — bridge re-verifies membership from the guild store
    }
    console.error("[solver] captcha checkbox label not found on screen");
    process.exit(1);
}

main().catch(e => { console.error("[solver] " + (e?.message ?? e)); process.exit(1); });
