/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import {
    Button,
    createRoot,
    Forms,
    React,
    showToast,
    TextInput,
    Toasts,
    useEffect,
    useMemo,
    useRef,
    useState
} from "@webpack/common";
import type { Root } from "react-dom/client";

const logger = new Logger("PasscodeLock");
const OVERLAY_ID = "vc-passcode-lock";
const PBKDF2_ITERATIONS = 210_000;

type CodeType = "four" | "six" | "custom";

interface PrivateSettings {
    hash?: string;
    salt?: string;
    iterations?: number;
    locked?: boolean;
    attempts?: number;
    cooldownUntil?: number;
}

const settings = definePluginSettings({
    setup: {
        type: OptionType.COMPONENT,
        description: "Set or change the passcode",
        component: PasscodeSettings
    },
    codeType: {
        type: OptionType.SELECT,
        description: "Passcode format",
        options: [
            { label: "4-digit numeric code", value: "four", default: true },
            { label: "6-digit numeric code", value: "six" },
            { label: "Custom numeric code", value: "custom" }
        ],
        onChange: () => {

            settings.store.hash = undefined;
            settings.store.salt = undefined;
            settings.store.iterations = undefined;
            showToast("Code type changed. Set a new passcode.", Toasts.Type.MESSAGE);
        }
    },
    autoLock: {
        type: OptionType.SELECT,
        description: "Lock Discord after the window has been unfocused for this long",
        options: [
            { label: "Disabled", value: 0, default: true },
            { label: "1 minute", value: 60_000 },
            { label: "5 minutes", value: 300_000 },
            { label: "15 minutes", value: 900_000 },
            { label: "1 hour", value: 3_600_000 },
            { label: "5 hours", value: 18_000_000 }
        ]
    },
    keybind: {
        type: OptionType.STRING,
        description: "Keyboard shortcut used to lock Discord (example: Ctrl+L)",
        default: "Ctrl+L"
    },
    lockOnStartup: {
        type: OptionType.BOOLEAN,
        description: "Always lock Discord when the plugin starts",
        default: true
    }
}).withPrivateSettings<PrivateSettings>();

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
    return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

async function deriveHash(passcode: string, salt: Uint8Array, iterations: number): Promise<string> {

    const saltBuffer = Uint8Array.from(salt).buffer;
    const material = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(passcode),
        "PBKDF2",
        false,
        ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            hash: "SHA-256",
            salt: saltBuffer,
            iterations
        },
        material,
        256
    );
    return bytesToBase64(new Uint8Array(bits));
}

async function setPasscode(passcode: string): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    settings.store.salt = bytesToBase64(salt);
    settings.store.iterations = PBKDF2_ITERATIONS;
    settings.store.hash = await deriveHash(passcode, salt, PBKDF2_ITERATIONS);
    settings.store.attempts = 0;
    settings.store.cooldownUntil = 0;
}

async function verifyPasscode(passcode: string): Promise<boolean> {
    const { hash, salt, iterations } = settings.store;
    if (!hash || !salt || !iterations) return false;

    const candidate = await deriveHash(passcode, base64ToBytes(salt), iterations);
    if (candidate.length !== hash.length) return false;


    let mismatch = 0;
    for (let i = 0; i < hash.length; i++) {
        mismatch |= hash.charCodeAt(i) ^ candidate.charCodeAt(i);
    }
    return mismatch === 0;
}

function requiredLength(): number | null {
    const type = settings.store.codeType as CodeType;
    return type === "four" ? 4 : type === "six" ? 6 : null;
}

function validatePasscode(value: string): string | null {
    if (!/^\d+$/.test(value)) return "The passcode must contain only numbers.";
    const length = requiredLength();
    if (length != null && value.length !== length) return `Enter exactly ${length} digits.`;
    if (length == null && (value.length < 4 || value.length > 32)) return "Enter between 4 and 32 digits.";
    return null;
}

function PasscodeSettings() {
    const [first, setFirst] = useState("");
    const [second, setSecond] = useState("");
    const [busy, setBusy] = useState(false);
    const hasPasscode = Boolean(settings.store.hash);

    const save = async () => {
        const error = validatePasscode(first);
        if (error) return showToast(error, Toasts.Type.FAILURE);
        if (first !== second) return showToast("The passcodes do not match.", Toasts.Type.FAILURE);

        setBusy(true);
        try {
            await setPasscode(first);
            setFirst("");
            setSecond("");
            showToast("Passcode saved securely.", Toasts.Type.SUCCESS);
        } catch (error) {
            logger.error("Failed to save passcode", error);
            showToast("Could not save the passcode.", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="vc-pcl-settings">
            <Forms.FormTitle tag="h3">{hasPasscode ? "Change passcode" : "Create passcode"}</Forms.FormTitle>
            <Forms.FormText>
                This prevents casual access to Discord. For real device security, lock your operating-system account.
            </Forms.FormText>
            <div className="vc-pcl-settings-inputs">
                <TextInput
                    type="password"
                    value={first}
                    placeholder="New numeric passcode"
                    onChange={setFirst}
                    maxLength={32}
                />
                <TextInput
                    type="password"
                    value={second}
                    placeholder="Repeat passcode"
                    onChange={setSecond}
                    maxLength={32}
                    onKeyDown={(event: React.KeyboardEvent) => {
                        if (event.key === "Enter") void save();
                    }}
                />
            </div>
            <div className="vc-pcl-settings-buttons">
                <Button disabled={busy || !first || !second} onClick={() => void save()}>
                    {busy ? "Saving…" : "Save passcode"}
                </Button>
                <Button
                    color={Button.Colors.PRIMARY}
                    disabled={!hasPasscode}
                    onClick={() => lock()}
                >
                    Lock now
                </Button>
            </div>
        </div>
    );
}

interface LockScreenProps {
    onUnlock(): void;
}

function LockScreen({ onUnlock }: LockScreenProps) {
    const maxLength = requiredLength() ?? 32;
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [now, setNow] = useState(Date.now());
    const inputRef = useRef<HTMLInputElement>(null);

    const cooldownUntil = settings.store.cooldownUntil ?? 0;
    const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

    useEffect(() => {
        inputRef.current?.focus();
        if (cooldownSeconds <= 0) return;
        const timer = window.setInterval(() => setNow(Date.now()), 250);
        return () => window.clearInterval(timer);
    }, [cooldownSeconds > 0]);

    const submit = async (candidate = code) => {
        if (busy || cooldownUntil > Date.now() || !candidate) return;
        setBusy(true);
        setError("");

        try {
            if (await verifyPasscode(candidate)) {
                settings.store.attempts = 0;
                settings.store.cooldownUntil = 0;
                onUnlock();
                return;
            }

            const attempts = (settings.store.attempts ?? 0) + 1;
            settings.store.attempts = attempts;
            setCode("");
            if (attempts >= 3) {
                const delay = Math.min(30_000, 5_000 * (attempts - 2));
                settings.store.cooldownUntil = Date.now() + delay;
                setNow(Date.now());
                setError("Too many attempts.");
            } else {
                setError("Incorrect passcode.");
            }
        } catch (verificationError) {
            logger.error("Passcode verification failed", verificationError);
            setError("Could not verify the passcode.");
        } finally {
            setBusy(false);
            inputRef.current?.focus();
        }
    };

    const append = (digit: string) => {
        if (busy || cooldownSeconds > 0 || code.length >= maxLength) return;
        const next = code + digit;
        setCode(next);
        const length = requiredLength();
        if (length != null && next.length === length) void submit(next);
    };

    const dots = useMemo(
        () => Array.from({ length: Math.min(code.length, 32) }, (_, index) => <span key={index} />),
        [code.length]
    );

    return (
        <div className="vc-pcl-screen" role="dialog" aria-modal="true" aria-label="Discord is locked">
            <div className="vc-pcl-card">
                <svg className="vc-pcl-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 10h-1V7a5 5 0 0 0-10 0v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2ZM9 7a3 3 0 0 1 6 0v3H9V7Zm4 10.73V19h-2v-1.27a2 2 0 1 1 2 0Z" />
                </svg>
                <h1>Discord is locked</h1>
                <p>Enter your passcode to continue</p>

                <input
                    ref={inputRef}
                    className="vc-pcl-hidden-input"
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    value={code}
                    maxLength={maxLength}
                    aria-label="Passcode"
                    onChange={event => {
                        const next = event.currentTarget.value.replace(/\D/g, "").slice(0, maxLength);
                        setCode(next);
                        const length = requiredLength();
                        if (length != null && next.length === length) void submit(next);
                    }}
                    onKeyDown={event => {
                        if (event.key === "Enter") void submit();
                        if (event.key === "Escape") event.preventDefault();
                    }}
                />

                <div className="vc-pcl-dots" aria-hidden="true">{dots}</div>
                <div className="vc-pcl-status" aria-live="polite">
                    {cooldownSeconds > 0 ? `Try again in ${cooldownSeconds}s` : error}
                </div>

                <div className="vc-pcl-keypad">
                    {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(digit => (
                        <button key={digit} type="button" onClick={() => append(digit)}>{digit}</button>
                    ))}
                    <button type="button" aria-label="Clear" onClick={() => setCode("")}>C</button>
                    <button type="button" onClick={() => append("0")}>0</button>
                    <button type="button" aria-label="Delete digit" onClick={() => setCode(value => value.slice(0, -1))}>⌫</button>
                </div>

                {requiredLength() == null && (
                    <Button className="vc-pcl-unlock" disabled={busy || !code || cooldownSeconds > 0} onClick={() => void submit()}>
                        Unlock
                    </Button>
                )}
            </div>
        </div>
    );
}

let overlayRoot: Root | null = null;
let overlayElement: HTMLDivElement | null = null;
let autoLockTimer: number | undefined;

function blockUnderlyingInput(event: Event): void {
    if (!settings.store.locked) return;
    if (overlayElement?.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
}

function addInputGuards(): void {
    window.addEventListener("keydown", blockUnderlyingInput, true);
    window.addEventListener("keyup", blockUnderlyingInput, true);
    window.addEventListener("pointerdown", blockUnderlyingInput, true);
    window.addEventListener("contextmenu", blockUnderlyingInput, true);
    window.addEventListener("wheel", blockUnderlyingInput, { capture: true, passive: false });
}

function removeInputGuards(): void {
    window.removeEventListener("keydown", blockUnderlyingInput, true);
    window.removeEventListener("keyup", blockUnderlyingInput, true);
    window.removeEventListener("pointerdown", blockUnderlyingInput, true);
    window.removeEventListener("contextmenu", blockUnderlyingInput, true);
    window.removeEventListener("wheel", blockUnderlyingInput, true);
}

function unlock(): void {
    settings.store.locked = false;
    removeInputGuards();
    overlayRoot?.unmount();
    overlayElement?.remove();
    overlayRoot = null;
    overlayElement = null;
}

function lock(): void {
    if (settings.store.locked && overlayElement) return;
    if (!settings.store.hash) {
        showToast("Set a passcode in PasscodeLock settings first.", Toasts.Type.FAILURE);
        return;
    }

    settings.store.locked = true;
    overlayElement = document.createElement("div");
    overlayElement.id = OVERLAY_ID;
    document.body.appendChild(overlayElement);
    overlayRoot = createRoot(overlayElement);
    overlayRoot.render(<LockScreen onUnlock={unlock} />);
    addInputGuards();
}

function normalizeKey(value: string): string {
    const key = value.toLowerCase();
    if (key === "control") return "ctrl";
    if (key === " ") return "space";
    return key;
}

function matchesKeybind(event: KeyboardEvent, keybind: string): boolean {
    const parts = keybind.toLowerCase().split("+").map(part => part.trim()).filter(Boolean);
    if (parts.length === 0) return false;

    const modifiers = new Set(parts.filter(part => ["ctrl", "control", "alt", "shift", "meta", "win"].includes(part)));
    const key = parts.find(part => !modifiers.has(part));
    if (!key) return false;

    return event.ctrlKey === (modifiers.has("ctrl") || modifiers.has("control"))
        && event.altKey === modifiers.has("alt")
        && event.shiftKey === modifiers.has("shift")
        && event.metaKey === (modifiers.has("meta") || modifiers.has("win"))
        && normalizeKey(event.key) === normalizeKey(key);
}

function onGlobalKeyDown(event: KeyboardEvent): void {
    if (settings.store.locked || !matchesKeybind(event, settings.store.keybind)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    lock();
}

function onWindowBlur(): void {
    window.clearTimeout(autoLockTimer);
    const delay = settings.store.autoLock;
    if (!delay || settings.store.locked || !settings.store.hash) return;
    autoLockTimer = window.setTimeout(lock, delay);
}

function onWindowFocus(): void {
    window.clearTimeout(autoLockTimer);
}

export default definePlugin({
    name: "PasscodeLock",
    description: "Protect Discord from casual access with a local passcode lock screen.",
    authors: [Devs.Yazan],
    settings,

    start() {
        document.addEventListener("keydown", onGlobalKeyDown, true);
        window.addEventListener("blur", onWindowBlur);
        window.addEventListener("focus", onWindowFocus);


        if (settings.store.hash && (settings.store.locked || settings.store.lockOnStartup)) {
            window.setTimeout(lock, 250);
        }
    },

    stop() {
        document.removeEventListener("keydown", onGlobalKeyDown, true);
        window.removeEventListener("blur", onWindowBlur);
        window.removeEventListener("focus", onWindowFocus);
        window.clearTimeout(autoLockTimer);
        unlock();
    }
});
