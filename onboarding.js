/**
 * Discord server onboarding auto-completer — runs INSIDE the Vencord renderer.
 *
 * Loaded and evaluated by the `discord_onboarding` MCP tool (see server.ts).
 * The tool reads this file verbatim, appends `return await __discordOnboarding(opts);`
 * and sends it to the renderer, so this file must define `__discordOnboarding`
 * and reference only renderer globals (document/window/...).
 *
 * Flow handled:
 *   1. "Question X of Y" questionnaire — required questions get the first option
 *      selected then Next; optional questions are Skipped (unless opts.answerOptional).
 *      Two answer widgets exist: the option-button grid (`optionButtonWrapper`) and
 *      a "Select..." dropdown (a combobox input whose listbox renders in a portal);
 *      the dropdown is expanded first, then its first `[role="option"]` is clicked.
 *   2. "One last step! Read & Agree to Server Rules" — the final gate Discord shows
 *      after the questionnaire. Has no "Question X of Y" heading, so it's detected
 *      separately and completed by clicking the Finish button.
 *
 * Scoped to the current server's onboarding unless opts.allServers is set (Discord
 * chains the onboarding of several freshly-joined servers back-to-back).
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

    // Stop before the caller's renderer timeout kills the eval: `log` only exists
    // here, so a walk that overruns would return nothing at all.
    const deadline = Date.now() + Math.max(10000, Math.min(280000, opts.budgetMs || 105000));
    const outOfTime = () => Date.now() > deadline;

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
    // then morphs to "Next"/"Continue"/etc. Picks the visible button with the
    // lowest screen position to avoid stray matches outside the onboarding overlay.
    const advBtn = () => {
        const vw = window.innerWidth, vh = window.innerHeight;
        let adv = null, adv_y = -1;
        for (const el of document.querySelectorAll('button,[role="button"]')) {
            const t = (el.textContent || "").trim();
            if (!/^(Skip|Next|Continue|Done|Submit|Finish)\b/i.test(t)) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
            if (r.bottom > adv_y) { adv = el; adv_y = r.bottom; }
        }
        return adv;
    };
    const advText = () => { const a = advBtn(); return a ? (a.textContent || "").trim() : null; };

    // advBtn() matches `[role="button"]` too, and a div carries its disabled
    // state as aria-disabled — `.disabled` is undefined there.
    const isDisabled = (el) => !!el && (el.disabled === true ||
        el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true");

    // Detect the "One last step! Read & Agree to Server Rules" screen.
    // It appears after the Q&A flow but has no "Question X of Y" heading.
    const rulesScreen = () =>
        !!guildOf() && /Read\s*&\s*Agree/i.test(document.body ? document.body.textContent || "" : "");

    // Leaf element holding some onboarding caption, e.g. "Question 1 of 3".
    // The element pass catches a caption Discord split across several nodes,
    // which the text-node walk alone would miss.
    const captionEl = (re) => {
        const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (re.test((node.textContent || "").trim())) return node.parentElement;
        }
        // Onboarding always renders in the modal, so the split-caption scan stays
        // inside it — the whole-body scan only runs when no dialog is mounted.
        const dialog = document.querySelector('[role="dialog"]');
        let deepest = null;
        for (const el of (dialog || document.body || document).querySelectorAll("*")) {
            if (!re.test((el.textContent || "").trim())) continue;
            if (!deepest || deepest.contains(el)) deepest = el;
        }
        return deepest;
    };

    // The overlay a caption sits in: Discord renders onboarding in a modal, so
    // prefer its dialog ancestor and fall back to the nearest ancestor holding
    // `sel`, capped so a screen without one cannot resolve to <body>.
    const scopeAround = (from, sel) => {
        const dialog = from && from.closest('[role="dialog"]');
        if (dialog && dialog.querySelector(sel)) return dialog;
        for (let el = from, i = 0; el && i < 10; i++, el = el.parentElement)
            if (el.querySelector(sel)) return el;
        return null;
    };

    // Scoped to the rules overlay: a synthetic `scroll` on the message list
    // behind it would drive Discord's history pagination and read state.
    const scrollStep = () => {
        const root = scopeAround(captionEl(/Read\s*&\s*Agree/i), '[class*="scroller"]');
        if (!root || root === document.body || root === document.documentElement) return false;
        let moved = false;
        for (const s of root.querySelectorAll('[class*="scroller"]')) {
            if (s.scrollHeight <= s.clientHeight + 20 || s.clientHeight <= 100) continue;
            const before = s.scrollTop;
            s.scrollTop = Math.min(s.scrollHeight, before + s.clientHeight);
            s.dispatchEvent(new Event("scroll", { bubbles: true }));
            if (s.scrollTop > before) moved = true;
        }
        return moved;
    };

    // Drive the rules list to its end; returns whether anything moved. Stops as
    // soon as a step doesn't scroll (already at the bottom, or nothing to scroll).
    const scrollToEnd = async () => {
        let moved = false;
        for (let i = 0; i < 40 && !outOfTime(); i++) {
            if (!scrollStep()) break;
            moved = true;
            await sleep(120);
        }
        return moved;
    };

    // Poll ~8s for Finish to enable, nudging the rules list each tick: the usual
    // gate is the unread rules ("You must finish reading the rules to join"), but
    // the button can also enable on its own (short list, tall window, late render).
    const waitFinishEnabled = async () => {
        let scrolled = false;
        for (let i = 0; i < 40 && !outOfTime(); i++) {
            const fin = advBtn();
            if (fin && !isDisabled(fin)) return { ok: true, scrolled };
            if (scrollStep()) scrolled = true;
            await sleep(200);
        }
        const fin = advBtn();
        return { ok: !!fin && !isDisabled(fin), scrolled };
    };

    // Wait up to 6s for the click to take (URL leaves /onboarding), unless the
    // time budget runs out first.
    const waitLeftOnboarding = async () => {
        for (let i = 0; i < 30 && !outOfTime(); i++) { await sleep(200); if (!guildOf()) return true; }
        return false;
    };

    // Click Finish on the rules screen and wait for the URL to leave /onboarding.
    const finishRules = async () => {
        let fin = advBtn();
        if (!fin) { log.push("Rules screen: no Finish button found — cannot complete."); return; }
        if (isDisabled(fin)) {
            const st = await waitFinishEnabled();
            log.push("Rules screen: Finish started disabled — waited for it to enable (enabled=" +
                st.ok + ", scrolled=" + st.scrolled + ").");
            fin = advBtn();
            if (!fin || isDisabled(fin)) { log.push("Rules screen: Finish still disabled — cannot complete."); return; }
        }
        fire(fin);
        handled++;
        if (await waitLeftOnboarding()) { log.push("Rules screen: Finish clicked — onboarding complete."); return; }

        // The click didn't take: the button looked enabled but the rules were
        // unread (Finish gates a click without disabling), the portal swallowed
        // it, or aria-disabled hadn't landed. Scroll the rules to the end — which
        // waitFinishEnabled skips while the button already reads enabled — then
        // click once more before giving up.
        if (rulesScreen() && !outOfTime()) {
            const scrolled = await scrollToEnd();
            fin = advBtn();
            if (fin && !isDisabled(fin)) {
                fire(fin);
                log.push("Rules screen: first Finish click did not take — scrolled rules to end and retried (scrolled=" +
                    scrolled + ").");
                if (await waitLeftOnboarding()) { log.push("Rules screen: retry succeeded — onboarding complete."); return; }
            }
        }
        log.push("Rules screen: Finish clicked but onboarding is still on screen — not complete.");
    };

    const qHead = () => captionEl(/^Question\s+\d+\s+of\s+\d+$/i);

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

    const fireInside = (box) => {
        const r = box.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        let el = document.elementFromPoint(cx, cy);
        if (!el || !box.contains(el)) el = box;
        fire(el);
    };

    // Dropdown-style question: a visible "Select..." combobox input, scoped to the
    // question — Discord's own search box carries role="combobox" too.
    const comboInput = () => {
        const root = scopeAround(qHead(), 'input[role="combobox"]');
        if (!root) return null;
        for (const el of root.querySelectorAll('input[role="combobox"]')) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return el;
        }
        return null;
    };

    // The listbox renders in a portal, so it is reached through the id the input
    // points at. Discord mounts no node carrying that id — the options do, as
    // their own id prefix. Only an input naming no listbox falls back to a
    // document-wide scan; naming one that is absent means it is not open yet.
    const listOptions = (inp) => {
        const id = inp && (inp.getAttribute("aria-controls") || inp.getAttribute("aria-owns"));
        if (!id) return [...document.querySelectorAll('[role="option"]')];
        const box = document.getElementById(id);
        if (box) return [...box.querySelectorAll('[role="option"]')];
        return [...document.querySelectorAll('[role="option"]')].filter((o) => (o.id || "").indexOf(id) === 0);
    };

    // Discord's combobox keeps the listbox open after a pick — it is multi-select.
    const selectFirstDropdownOption = async () => {
        const inp = comboInput();
        if (!inp) return { ok: false, reason: "no options found" };
        if (inp.getAttribute("aria-expanded") !== "true") {
            try { inp.focus(); } catch (e) { /* ignore */ }
            fire(inp);
        }
        let items = [];
        for (let i = 0; i < 20 && !outOfTime(); i++) { items = listOptions(inp); if (items.length) break; await sleep(150); }
        if (!items.length) return { ok: false, reason: "dropdown did not expand" };
        if (items[0].getAttribute("aria-selected") === "true") return { ok: true, already: true };
        fireInside(items[0]);
        for (let i = 0; i < 20 && !outOfTime(); i++) {
            await sleep(150);
            if (firstSelected() || (advText() || "") !== "Skip") break;
        }
        return { ok: true };
    };

    // Click the first answer option. The clickable handler sits on the inner
    // optionButton (cursor:pointer), not the wrapper (cursor:auto).
    const selectFirstOption = async () => {
        const ws = optionWraps();
        if (!ws.length) return await selectFirstDropdownOption();
        const w = ws[0];
        if (/selected/i.test(w.className)) return { ok: true, already: true };
        fireInside(w.querySelector('[class*="optionButton__"]') || w);
        return { ok: true };
    };

    // Whether this question now has an answer, for either widget. A dropdown whose
    // listbox has collapsed leaves its pick as a removable tag in the field; text
    // alone is not proof, since the unanswered field can render its placeholder.
    const firstSelected = () => {
        const w0 = optionWraps()[0];
        if (w0) return /selected/i.test(w0.className);
        const inp = comboInput();
        if (!inp) return false;
        // Only trust the listbox while the input still names it; a collapsed
        // dropdown drops aria-controls, and listOptions() would then scan the
        // whole document — fall through to the tag/placeholder check instead.
        const listboxId = inp.getAttribute("aria-controls") || inp.getAttribute("aria-owns");
        const o0 = listboxId ? listOptions(inp)[0] : null;
        if (o0) return o0.getAttribute("aria-selected") === "true";
        const field = inp.closest('[class*="selectFieldContainer"]');
        if (!field) return false;
        if (field.querySelector('[class*="tag"]')) return true;
        const txt = (field.textContent || "").trim();
        return !!txt && txt !== (inp.getAttribute("placeholder") || "").trim();
    };

    // Wait until the question advances, the questionnaire closes, or the guild
    // (a different server's onboarding) changes — whichever comes first.
    const waitNext = async (prevCur, prevGuild) => {
        for (let i = 0; i < 35 && !outOfTime(); i++) {
            await sleep(200);
            const s = readState();
            if (!s.onboarding || s.current !== prevCur || s.guild !== prevGuild) return s;
        }
        return readState();
    };

    const startGuild = guildOf();
    // Poll up to 10s for the questionnaire DOM to appear.  The caller navigates
    // to /onboarding first, but Discord may not have rendered the React tree yet.
    // discord_onboarding runs with a 120s renderer budget (server.ts forwards it
    // via the daemon, overriding the plugin's 15s default), so 10s is well within
    // budget with plenty of headroom for the rest of the questionnaire walk.
    let init = readState();
    if (!init.onboarding && !rulesScreen()) {
        for (let i = 0; i < 10 && !outOfTime(); i++) {
            await sleep(1000);
            init = readState();
            if (init.onboarding || rulesScreen()) break;
        }
    }
    if (!init.onboarding && !rulesScreen()) {
        return { completed: false, handled: 0, startGuild, finalUrl: location.pathname,
            log: ["No onboarding question is on screen — nothing to do (polled 10s)."] };
    }

    let handled = 0, prevCur = -1, prevGuild = startGuild;

    for (let guard = 0; guard < MAX_Q; guard++) {
        if (outOfTime()) { log.push("Out of time budget — stopping with the log so far."); break; }
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
            const sel = await selectFirstOption();
            // Give the advance button a moment to morph away from "Skip".
            for (let i = 0; i < 16 && !outOfTime(); i++) { await sleep(150); if ((advText() || "") !== "Skip") break; }
            const selected = firstSelected();
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

    // After the Q&A loop Discord may land on the rules screen before closing onboarding.
    if (rulesScreen() && !outOfTime()) {
        log.push("Rules screen after Q&A — clicking Finish.");
        await finishRules();
    }

    // Base completed on the URL, not readState — readState() returns onboarding:false
    // for both "done" and "stuck on rules screen", so !now.onboarding would falsely
    // report completed:true if finishRules() ran but couldn't find the Finish button.
    const finalGuild = guildOf();
    return {
        completed: !finalGuild || (!ALL_SERVERS && finalGuild !== startGuild),
        handled,
        startGuild,
        finalUrl: location.pathname,
        log,
    };
}
