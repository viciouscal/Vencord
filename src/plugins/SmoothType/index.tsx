/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { Devs } from "@utils/constants";
import { Margins } from "@utils/margins";
import { closeModal, ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import {
    Button,
    ColorPicker,
    Forms,
    SearchableSelect,
    Slider,
    Text,
} from "@webpack/common";

const STYLE_ID = "vc-smoothtype";

const EASING_OPTIONS = [
    { label: "Ease-out (recommended)", value: "ease-out" },
    { label: "Ease", value: "ease" },
    { label: "Linear", value: "linear" },
    { label: "Ease-in", value: "ease-in" },
    { label: "Ease-in-out", value: "ease-in-out" },
] as const;

const LIVE_SETTING_KEYS = [
    "transitionDelay",
    "animationType",
    "caretWidth",
    "caretOpacity",
    "caretGlow",
    "caretColor",
    "showChatBarButton",
] as const;

function toHex(n: number) {
    return `#${n.toString(16).padStart(6, "0")}`;
}

function clamp(n: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, n));
}

function onPickColor(color: number) {
    settings.store.caretColor = color;
    applyCSS();
}

function Divider16() {
    return <div style={{ height: 16 }} />;
}

function PresetButtons() {
    return (
        <>
            <Forms.FormTitle tag="h5">Presets</Forms.FormTitle>
            <Flex style={{ gap: 8, flexWrap: "wrap" }}>
                <Button onClick={() => applyPreset("snappy")}>Snappy</Button>
                <Button onClick={() => applyPreset("cinematic")}>Cinematic</Button>
                <Button onClick={() => applyPreset("chill")}>Chill</Button>
            </Flex>
        </>
    );
}

const settings = definePluginSettings({
    showChatBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show the SmoothType button in the chat bar (next to GIFs, etc.)",
        default: true,
    },
    animationType: {
        type: OptionType.SELECT,
        description: "Move easing",
        options: [
            { label: "Ease-out (recommended)", value: "ease-out", default: true },
            { label: "Ease", value: "ease" },
            { label: "Linear", value: "linear" },
            { label: "Ease-in", value: "ease-in" },
            { label: "Ease-in-out", value: "ease-in-out" },
        ],
        onChange: () => applyCSS(),
    },
    caretColor: {
        type: OptionType.COMPONENT,
        description: "Caret color",
        default: 0x00b0f4,
        component: () => (
            <div>
                <Forms.FormTitle tag="h3">Caret Color</Forms.FormTitle>
                <ColorPicker
                    color={settings.store.caretColor}
                    onChange={onPickColor}
                    showEyeDropper={true}
                />
            </div>
        ),
    },
    transitionDelay: {
        type: OptionType.COMPONENT,
        description: "Caret move duration (ms) — higher = smoother/slower",
        default: 55,
        component: () => (
            <div>
                <Forms.FormTitle tag="h5">Caret movement speed</Forms.FormTitle>
                <Forms.FormText style={{ marginBottom: 8 }}>Transition duration (ms) — higher is slower and usually smoother.</Forms.FormText>
                <Slider
                    initialValue={settings.store.transitionDelay ?? 55}
                    onValueChange={(v: number) => {
                        settings.store.transitionDelay = v;
                        applyCSS();
                    }}
                    minValue={0}
                    maxValue={800}
                    markers={[0, 100, 200, 400, 800]}
                    stickToMarkers={false}
                    onValueRender={(v: number) => `${Math.round(v)}ms`}
                />
            </div>
        ),
    },
    caretWidth: {
        type: OptionType.COMPONENT,
        description: "Caret width (px)",
        default: 2,
        component: () => (
            <div>
                <Forms.FormTitle tag="h5">Caret appearance</Forms.FormTitle>
                <Forms.FormText style={{ marginBottom: 8 }}>Width (px)</Forms.FormText>
                <Slider
                    initialValue={settings.store.caretWidth ?? 2}
                    onValueChange={(v: number) => {
                        settings.store.caretWidth = v;
                        applyCSS();
                    }}
                    minValue={1}
                    maxValue={10}
                    markers={[1, 2, 4, 6, 10]}
                    stickToMarkers={false}
                    onValueRender={(v: number) => `${Math.round(v)}px`}
                />
                <Forms.FormText style={{ marginBottom: 8 }}>Opacity</Forms.FormText>
                <Slider
                    initialValue={(settings.store.caretOpacity ?? 1) * 100}
                    onValueChange={(v: number) => {
                        settings.store.caretOpacity = clamp(v / 100, 0.25, 1);
                        applyCSS();
                    }}
                    minValue={25}
                    maxValue={100}
                    markers={[25, 50, 75, 100]}
                    stickToMarkers={false}
                    onValueRender={(v: number) => `${Math.round(v)}%`}
                />
                <Forms.FormText style={{ marginBottom: 8 }}>Glow (px)</Forms.FormText>
                <Slider
                    initialValue={settings.store.caretGlow ?? 0}
                    onValueChange={(v: number) => {
                        settings.store.caretGlow = v;
                        applyCSS();
                    }}
                    minValue={0}
                    maxValue={24}
                    markers={[0, 4, 8, 16, 24]}
                    stickToMarkers={false}
                    onValueRender={(v: number) => `${Math.round(v)}px`}
                />
            </div>
        ),
    },
    caretOpacity: {
        type: OptionType.HIDDEN,
        description: "Caret opacity (0.25–1)",
        default: 1,
    },
    caretGlow: {
        type: OptionType.HIDDEN,
        description: "Soft glow radius (px, 0 = off)",
        default: 0,
    },
    presets: {
        type: OptionType.COMPONENT,
        description: "Quick presets",
        component: () => <PresetButtons />,
    },
});

function buildCSS(): string {
    const color = toHex(settings.store.caretColor ?? 0x00b0f4);
    const ms = clamp(settings.store.transitionDelay ?? 55, 0, 800);
    const easing = settings.store.animationType ?? "ease-out";
    const w = clamp(settings.store.caretWidth ?? 2, 1, 10);
    const op = clamp(settings.store.caretOpacity ?? 1, 0.25, 1);
    const glow = clamp(settings.store.caretGlow ?? 0, 0, 24);

    const moveProps = `left ${ms}ms ${easing}, top ${ms}ms ${easing}, height ${ms}ms ${easing}, opacity 120ms ease-out`;

    const shadow =
        glow > 0
            ? `box-shadow: 0 0 ${glow}px ${glow * 0.75}px ${color}55;`
            : "";

    return `
#vc-smoothtype-caret {
    position: fixed;
    top: 0;
    left: 0;
    width: ${w}px;
    border-radius: 2px;
    background: ${color};
    opacity: ${op};
    pointer-events: none;
    z-index: 99999;
    display: none;
    will-change: left, top, height;
    transition: ${moveProps};
    ${shadow}
}
[data-slate-editor] { caret-color: transparent !important; }
`;
}

function getCaret(): HTMLDivElement {
    let el = document.getElementById("vc-smoothtype-caret") as HTMLDivElement | null;
    if (!el) {
        el = document.createElement("div");
        el.id = "vc-smoothtype-caret";
        document.body.appendChild(el);
    }
    return el;
}

let lastX = Number.NaN;
let lastY = Number.NaN;
let rafScheduled = 0;

function scheduleApplyCaretPosition() {
    if (rafScheduled) return;
    rafScheduled = requestAnimationFrame(() => {
        rafScheduled = 0;
        applyCaretPosition();
    });
}

function applyCaretPosition() {
    const el = getCaret();

    if (!document.activeElement?.closest("[data-slate-editor]")) {
        el.style.display = "none";
        lastX = Number.NaN;
        lastY = Number.NaN;
        return;
    }

    const sel = window.getSelection();
    if (!sel?.rangeCount) {
        el.style.display = "none";
        return;
    }

    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(false);

    const rects = range.getClientRects();
    let rect: DOMRect | null = rects.length > 0 ? rects[0] : null;
    if (!rect || rect.height === 0) {
        const node = range.startContainer;
        const parent = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node) as HTMLElement | null;
        if (parent) rect = parent.getBoundingClientRect();
    }
    if (!rect || rect.height === 0) {
        el.style.display = "none";
        return;
    }

    const x = rect.right;
    const y = rect.top;
    const h = rect.height;

    lastX = x;
    lastY = y;

    el.style.display = "block";
    el.style.transform = "";
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.height = `${h}px`;
}

let observer: MutationObserver | null = null;

function startObserver() {
    observer = new MutationObserver(() => scheduleApplyCaretPosition());
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function stopObserver() {
    observer?.disconnect();
    observer = null;
}

const handlers = {
    sel: () => scheduleApplyCaretPosition(),
    focus: () => applyCaretPosition(),
    blur: () => {
        getCaret().style.display = "none";
        lastX = Number.NaN;
        lastY = Number.NaN;
    },
    fast: () => applyCaretPosition(),
    click: () => applyCaretPosition(),
};

function startListeners() {
    document.addEventListener("selectionchange", handlers.sel);
    document.addEventListener("focusin", handlers.focus);
    document.addEventListener("focusout", handlers.blur);
    document.addEventListener("input", handlers.fast, true);
    document.addEventListener("keyup", handlers.fast, true);
    document.addEventListener("compositionupdate", handlers.fast, true);
    document.addEventListener("compositionend", handlers.fast, true);
    document.addEventListener("click", handlers.click, true);
}

function stopListeners() {
    document.removeEventListener("selectionchange", handlers.sel);
    document.removeEventListener("focusin", handlers.focus);
    document.removeEventListener("focusout", handlers.blur);
    document.removeEventListener("input", handlers.fast, true);
    document.removeEventListener("keyup", handlers.fast, true);
    document.removeEventListener("compositionupdate", handlers.fast, true);
    document.removeEventListener("compositionend", handlers.fast, true);
    document.removeEventListener("click", handlers.click, true);
}

function applyCSS() {
    document.getElementById(STYLE_ID)?.remove();
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = buildCSS();
    document.head.appendChild(s);
    applyCaretPosition();
}

function removeCSS() {
    document.getElementById(STYLE_ID)?.remove();
}

function applyPreset(kind: "snappy" | "cinematic" | "chill") {
    if (kind === "snappy") {
        settings.store.transitionDelay = 42;
        settings.store.animationType = "ease-out";
        settings.store.caretGlow = 2;
    } else if (kind === "cinematic") {
        settings.store.transitionDelay = 190;
        settings.store.animationType = "ease-in-out";
        settings.store.caretGlow = 14;
    } else {
        settings.store.transitionDelay = 320;
        settings.store.animationType = "ease-out";
        settings.store.caretGlow = 6;
    }
    applyCSS();
}

const SmoothTypeIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg
        aria-hidden
        width={width}
        height={height}
        className={className}
        viewBox="0 0 24 24"
        fill="currentColor"
    >
        <path d="M12 3l1.35 4.7L18 8.5l-4.65 1.35L12 14l-1.35-4.15L5.5 8.5l4.85-0.8L12 3zm6 9.5l.9 3.1L22 16.5l-2.6.75L18 20.5l-.9-2.65-2.6-.75 2.1-.6.9-3.1zm-12 .5l1 3.4 3.5 1-3.5 1-1 3.4-1-3.4-3.5-1 3.5-1 1-3.4z" />
    </svg>
);

function SmoothTypeQuickPanel({ close }: { close(): void; }) {
    settings.use([...LIVE_SETTING_KEYS]);

    return (
        <div className={Margins.bottom8}>
            <Forms.FormText style={{ marginBottom: 12 }}>
                Quick controls from the chat bar. The same values appear in the SmoothType plugin page in Vencord settings.
            </Forms.FormText>

            <Forms.FormTitle tag="h5">Caret color</Forms.FormTitle>
            <ColorPicker
                color={settings.store.caretColor}
                onChange={c => {
                    settings.store.caretColor = c;
                    applyCSS();
                }}
                showEyeDropper={true}
            />

            <Divider16 />

            <Forms.FormTitle tag="h5">Caret movement speed</Forms.FormTitle>
            <Forms.FormText style={{ marginBottom: 8 }}>Transition duration (ms) — higher is slower and usually smoother.</Forms.FormText>
            <Slider
                initialValue={settings.store.transitionDelay}
                onValueChange={(v: number) => {
                    settings.store.transitionDelay = v;
                    applyCSS();
                }}
                minValue={0}
                maxValue={800}
                markers={[0, 100, 200, 400, 800]}
                stickToMarkers={false}
                onValueRender={(v: number) => `${Math.round(v)}ms`}
            />

            <Divider16 />

            <Forms.FormTitle tag="h5">Easing</Forms.FormTitle>
            <SearchableSelect
                options={[...EASING_OPTIONS]}
                value={settings.store.animationType}
                placeholder="Easing"
                maxVisibleItems={6}
                closeOnSelect
                onChange={(v: string) => {
                    settings.store.animationType = v;
                    applyCSS();
                }}
            />

            <Divider16 />

            <Forms.FormTitle tag="h5">Caret appearance</Forms.FormTitle>
            <Forms.FormText style={{ marginBottom: 8 }}>Width (px)</Forms.FormText>
            <Slider
                initialValue={settings.store.caretWidth}
                onValueChange={(v: number) => {
                    settings.store.caretWidth = v;
                    applyCSS();
                }}
                minValue={1}
                maxValue={10}
                markers={[1, 2, 4, 6, 10]}
                stickToMarkers={false}
                onValueRender={(v: number) => `${Math.round(v)}px`}
            />
            <Forms.FormText style={{ marginBottom: 8 }}>Opacity</Forms.FormText>
            <Slider
                initialValue={settings.store.caretOpacity * 100}
                onValueChange={(v: number) => {
                    settings.store.caretOpacity = clamp(v / 100, 0.25, 1);
                    applyCSS();
                }}
                minValue={25}
                maxValue={100}
                markers={[25, 50, 75, 100]}
                stickToMarkers={false}
                onValueRender={(v: number) => `${Math.round(v)}%`}
            />
            <Forms.FormText style={{ marginBottom: 8 }}>Glow (px)</Forms.FormText>
            <Slider
                initialValue={settings.store.caretGlow}
                onValueChange={(v: number) => {
                    settings.store.caretGlow = v;
                    applyCSS();
                }}
                minValue={0}
                maxValue={24}
                markers={[0, 4, 8, 16, 24]}
                stickToMarkers={false}
                onValueRender={(v: number) => `${Math.round(v)}px`}
            />

            <Divider16 />

            <PresetButtons />

            <div style={{ marginTop: 20 }}>
                <Button color={Button.Colors.PRIMARY} onClick={close}>
                    Done
                </Button>
            </div>
        </div>
    );
}

function openSmoothTypeHud() {
    const key = openModal(props => (
        <ModalRoot {...props} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>
                    SmoothType
                </Text>
                <ModalCloseButton onClick={() => closeModal(key)} />
            </ModalHeader>
            <ModalContent>
                <SmoothTypeQuickPanel close={() => closeModal(key)} />
            </ModalContent>
        </ModalRoot>
    ));
}

const SmoothTypeChatBarButton: ChatBarButtonFactory = ({ isAnyChat }) => {
    settings.use([...LIVE_SETTING_KEYS]);
    if (!isAnyChat || settings.store.showChatBarButton === false) return null;

    return (
        <ChatBarButton
            tooltip="SmoothType"
            onClick={() => openSmoothTypeHud()}
            buttonProps={{ "aria-haspopup": "dialog" }}
        >
            <SmoothTypeIcon />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "SmoothType",
    description: "smooth typing plugin",
    tags: ["Chat", "Appearance"],
    authors: [Devs.pluck, Devs.viciouscal, Devs.coll],
    requiresRestart: true,
    settings,

    chatBarButton: {
        icon: SmoothTypeIcon,
        render: SmoothTypeChatBarButton,
    },

    start() {
        applyCSS();
        getCaret();
        startObserver();
        startListeners();
    },

    stop() {
        stopObserver();
        stopListeners();
        removeCSS();
        if (rafScheduled) cancelAnimationFrame(rafScheduled);
        rafScheduled = 0;
        document.getElementById("vc-smoothtype-caret")?.remove();
        lastX = Number.NaN;
        lastY = Number.NaN;
    },
});