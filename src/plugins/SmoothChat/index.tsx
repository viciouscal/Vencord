/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { ColorPicker, Forms } from "@webpack/common";

const STYLE_ID = "vencord-smoothchat";

function onPickColor(color: number) {
    settings.store.caretColor = color;
    applyCSS();
}

const settings = definePluginSettings({
    smoothAnimation: {
        type: OptionType.BOOLEAN,
        description: "Smooth character animation when typing",
        default: true,
        onChange: () => applyCSS(),
    },
    caretColor: {
        type: OptionType.COMPONENT,
        description: "Caret color",
        default: 0x00b0f4,
        component: () => (
            <div>
                <Forms.FormTitle tag="h3">Caret Color</Forms.FormTitle>
                <Forms.FormText style={{ marginBottom: 8 }}>
                    Pick a color for the text cursor in the chat box.
                </Forms.FormText>
                <ColorPicker
                    color={settings.store.caretColor}
                    onChange={onPickColor}
                    showEyeDropper={true}
                />
            </div>
        ),
    },
});

function toHex(color: number): string {
    return `#${color.toString(16).padStart(6, "0")}`;
}

function buildCSS(): string {
    const color = toHex(settings.store.caretColor ?? 0x00b0f4);
    const anim = settings.store.smoothAnimation ?? true;

    return `
/* SmoothChat — Vencord Plugin */

${anim ? `
@keyframes smoothChar {
    from {
        opacity: 0;
        transform: translateY(3px) scale(0.95);
        filter: blur(2px);
    }
    to {
        opacity: 1;
        transform: translateY(0) scale(1);
        filter: blur(0);
    }
}` : ""}

[class*="slateTextArea"],
[class*="textArea"] > [contenteditable],
[role="textbox"][contenteditable] {
    will-change: contents !important;
    -webkit-font-smoothing: antialiased !important;
    backface-visibility: hidden !important;
    transform: translateZ(0) !important;
    direction: ltr !important;
    unicode-bidi: plaintext !important;
    text-align: left !important;
    caret-color: ${color} !important;
}

[class*="slateTextArea"] [data-slate-node="text"] span,
[class*="textArea"] [data-slate-node="text"] span {
    display: inline-block !important;
    ${anim ? "animation: smoothChar 0.15s ease-out forwards !important;" : ""}
    direction: ltr !important;
    unicode-bidi: plaintext !important;
    caret-color: ${color} !important;
}

[class*="slateTextArea"] [data-slate-node="element"],
[class*="textArea"] [data-slate-node="element"] {
    direction: ltr !important;
    unicode-bidi: plaintext !important;
    text-align: left !important;
}

[class*="slateTextArea"] [data-slate-placeholder],
[class*="textArea"] [data-slate-placeholder] {
    direction: ltr !important;
    text-align: left !important;
}

[class*="channelTextArea"],
[class*="scrollableContainer"] {
    contain: layout style !important;
}

[class*="messagesWrapper"],
[class*="chatContent"] {
    will-change: scroll-position !important;
    transform: translateZ(0) !important;
}

[class*="scroller"] {
    overflow-anchor: none !important;
    scroll-behavior: auto !important;
}
`;
}

let observer: MutationObserver | null = null;
let patching = false;

function patchEditors() {
    if (patching) return;
    patching = true;
    observer?.disconnect();

    document.querySelectorAll<HTMLElement>(
        "[contenteditable], [data-slate-node], [data-slate-placeholder]"
    ).forEach(el => {
        if (el.getAttribute("dir") !== "ltr") {
            el.setAttribute("dir", "ltr");
        }
    });

    attachObserver();
    patching = false;
}

function attachObserver() {
    if (!observer) return;
    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

function startObserver() {
    observer = new MutationObserver(mutations => {
        const hasEditor = mutations.some(m =>
            Array.from(m.addedNodes).some(
                n => n instanceof Element && (
                    n.hasAttribute("contenteditable") ||
                    n.hasAttribute("data-slate-node") ||
                    n.querySelector("[contenteditable], [data-slate-node]")
                )
            )
        );
        if (hasEditor) patchEditors();
    });
    attachObserver();
}

function stopObserver() {
    observer?.disconnect();
    observer = null;
}

function applyCSS() {
    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = buildCSS();
    document.head.appendChild(style);
}

function removeCSS() {
    document.getElementById(STYLE_ID)?.remove();
}

export default definePlugin({
    name: "SmoothChat",
    description: "Smooth typing .. Like the old version",
    authors: [Devs.viciouscal],
    settings,

    start() {
        applyCSS();
        patchEditors();
        startObserver();
    },

    stop() {
        removeCSS();
        stopObserver();
    },
});