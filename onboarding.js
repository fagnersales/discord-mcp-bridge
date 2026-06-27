/**
 * Discord server onboarding auto-completer — runs INSIDE the Vencord renderer.
 *
 * Loaded and evaluated by the `discord_onboarding` MCP tool (see server.ts).
 * The tool reads this file verbatim, appends `return await __discordOnboarding(opts);`
 * and sends it to the renderer, so this file must define `__discordOnboarding`
 * and reference only renderer globals (document/window/...).
 *
 * Per question in the "Question X of Y" flow shown after joining a community
 * server:
 *   - Required question  -> select the first option, then click Next.
 *   - Optional question  -> click Skip (unless opts.answerOptional).
 * Repeat until the questionnaire closes. Scoped to the current server's
 * onboarding unless opts.allServers is set (Discord chains the onboarding of
 * several freshly-joined servers back-to-back).
 *
 * Keep this dependency-free and resilient to Discord's hashed CSS class names
 * (match by stable substrings like `optionButtonWrapper`, never exact hashes).
 */
async function __discordOnboarding(opts) {
    opts = opts || {};
    const ANSWER_OPTIONAL = !!opts.answerOptional;
    const ALL_SERVERS = !!opts.allServers;
    const MAX_Q = Math.max(1, Math.min(100, opts.maxQuestions || 40));

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const log = [];

    // The guild whose onboarding we're on, from /channels/<id>/onboarding.
    const guildOf = () => {
        const m = location.pathname.match(/\/channels\/(\d+)\/onboarding/);
        return m ? m[1] : null;
    };

    // Dispatch a faithful pointer+mouse+click burst on an element. React's
    // delegated onClick fires only for handlers on the event target's ancestor
    // chain, so we must hit the deepest painted node — not a layout wrapper.
    const fire = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const init = {
            bubbles: true, cancelable: true, view: window, button: 0,
            clientX: Math.round(r.left + r.width / 2),
            clientY: Math.round(r.top + r.height / 2),
        };
        for (const t of ["pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            const Ctor = t.startsWith("pointer") ? (window.PointerEvent || MouseEvent) : MouseEvent;
            try { el.dispatchEvent(new Ctor(t, init)); } catch (e) { /* ignore */ }
        }
        return true;
    };

    // The bottom-right advance button. Reads "Skip" until a selection is made,
    // then morphs to "Next"/"Continue"/etc. Bottom-most match wins.
    const advBtn = () => {
        let adv = null;
        for (const el of document.querySelectorAll('button,[role="button"]')) {
            const t = (el.textContent || "").trim();
            if (/^(Skip|Next|Continue|Done|Submit|Finish)\b/i.test(t)) adv = el;
        }
        return adv;
    };
    const advText = () => { const a = advBtn(); return a ? (a.textContent || "").trim() : null; };

    // Leaf element holding the "Question X of Y" caption.
    const qHead = () => {
        for (const el of document.querySelectorAll("*")) {
            if (el.children.length) continue;
            if (/^Question\s+\d+\s+of\s+\d+$/i.test((el.textContent || "").trim())) return el;
        }
        return null;
    };

    const readState = () => {
        const q = qHead();
        if (!q) return { onboarding: false, guild: guildOf() };
        const m = (q.textContent || "").match(/Question\s+(\d+)\s+of\s+(\d+)/i);
        const row = q.parentElement; // the "Question X of Y · Required" row
        const required = /\bRequired\b/i.test(row ? row.textContent : "");
        return {
            onboarding: true,
            current: +m[1], total: +m[2],
            required, guild: guildOf(), advText: advText(),
        };
    };

    const optionWraps = () => [...document.querySelectorAll('[class*="optionButtonWrapper"]')];

    // Click the first answer option. The clickable handler sits on the inner
    // optionButton (cursor:pointer), not the wrapper (cursor:auto).
    const selectFirstOption = () => {
        const ws = optionWraps();
        if (!ws.length) return { ok: false, reason: "no options found" };
        const w = ws[0];
        if (/selected/i.test(w.className)) return { ok: true, already: true };
        const btn = w.querySelector('[class*="optionButton__"]') || w;
        const r = btn.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        let el = document.elementFromPoint(cx, cy);
        if (!el || !btn.contains(el)) el = btn;
        fire(el);
        return { ok: true };
    };

    // Wait until the question advances, the questionnaire closes, or the guild
    // (a different server's onboarding) changes — whichever comes first.
    const waitNext = async (prevCur, prevGuild) => {
        for (let i = 0; i < 35; i++) {
            await sleep(200);
            const s = readState();
            if (!s.onboarding || s.current !== prevCur || s.guild !== prevGuild) return s;
        }
        return readState();
    };

    const startGuild = guildOf();
    const init = readState();
    if (!init.onboarding) {
        return { completed: false, handled: 0, startGuild, finalUrl: location.pathname,
            log: ["No onboarding question is on screen — nothing to do."] };
    }

    let handled = 0, prevCur = -1, prevGuild = startGuild;

    for (let guard = 0; guard < MAX_Q; guard++) {
        const st = readState();
        if (!st.onboarding) { log.push("Onboarding closed — no more questions."); break; }
        if (!ALL_SERVERS && st.guild !== startGuild) {
            log.push("Reached another server's onboarding (" + st.guild + ") — stopping. Pass allServers:true to continue.");
            break;
        }
        if (st.current === prevCur && st.guild === prevGuild) {
            log.push("Stuck on Q" + st.current + " (it did not advance) — aborting.");
            break;
        }
        prevCur = st.current; prevGuild = st.guild;

        if (st.required || ANSWER_OPTIONAL) {
            const sel = selectFirstOption();
            // Give the advance button a moment to morph away from "Skip".
            for (let i = 0; i < 16; i++) { await sleep(150); if ((advText() || "") !== "Skip") break; }
            const w0 = optionWraps()[0];
            const selected = w0 ? /selected/i.test(w0.className) : false;
            const tag = st.required ? "[required]" : "[optional]";
            log.push("Q" + st.current + "/" + st.total + " " + tag +
                " -> selected first option (selected=" + selected + ", button=\"" + advText() + "\"" +
                (sel.ok ? "" : ", WARN: " + sel.reason) + ")");
        } else {
            log.push("Q" + st.current + "/" + st.total + " [optional] -> skip");
        }

        const adv = advBtn();
        if (!adv) { log.push("  No advance button found — aborting."); break; }
        fire(adv);
        handled++;

        const after = await waitNext(st.current, st.guild);
        if (!after.onboarding) { log.push("  Onboarding complete."); break; }
        if (!ALL_SERVERS && after.guild !== startGuild) {
            log.push("  Next server's onboarding appeared (" + after.guild + ") — stopping.");
            break;
        }
    }

    const now = readState();
    return {
        completed: !now.onboarding || (!ALL_SERVERS && guildOf() !== startGuild),
        handled,
        startGuild,
        finalUrl: location.pathname,
        log,
    };
}
