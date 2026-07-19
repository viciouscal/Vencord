/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { runtimeHashMessageKey } from "@utils/intlHash";

import type { DiscordLocalePack } from "../types";

const plainToArabic = new Map<string, string>();
const hashToArabic = new Map<string, string>();
const englishToArabic = new Map<string, string>();
const englishLowerToArabic = new Map<string, string>();

export function clearDiscordLocales() {
    plainToArabic.clear();
    hashToArabic.clear();
    englishToArabic.clear();
    englishLowerToArabic.clear();
}

export function registerDiscordPack(pack: DiscordLocalePack) {
    for (const [plainKey, arabic] of Object.entries(pack)) {
        if (!plainKey || !arabic) continue;
        plainToArabic.set(plainKey, arabic);
        hashToArabic.set(runtimeHashMessageKey(plainKey), arabic);
    }
}

// Single-word chrome labels only (buttons/tabs). Keep nouns out so mid-sentence English stays English.
const ALLOW_CHROME_SINGLE = new Set([
    "Badges", "Unsubscribe", "Deauthorize", "Reconnect", "Nitro", "Quests",
    "Permissions", "Domain", "Sound", "None", "Later!", "Relaunch",
    "Donations", "Contributions", "Settings", "Advanced", "Versions",
    "Desktop", "Web", "Mobile", "Console", "VR", "Stereo", "Simple",
    "Framerate", "Open", "Apply", "Mute", "Deafen", "Camera", "Width",
    "Height", "Hdr", "Remove", "Ignore", "Friends", "Shop", "Search",
    "Account", "Connections", "Notifications", "Clips", "Plugins",
    "Themes", "Username", "Email", "Reveal", "Edit", "Password", "Enabled", "Activity",
    "Hide", "Limited", "Suspended", "and", "Online", "All", "Pending", "Accept", "Decline",
    "Discover", "Apps", "Servers", "Home", "Gaming", "Music", "Education", "Featured", "Games", "Social", "Utilities", "Content",
    "Appearance", "Theme", "Messages", "System", "Billing", "Developer", "Vencord", "Updater", "Cloud", "Experience", "More", "Voice", "Video",
    "Overview", "Sounds", "Streaming", "Soundboard", "General", "Discord", "Everyone", "Unblock",
    "Activity", "Board", "Wishlist", "Accessibility", "Subscriptions"
]);

function isSafeEnglishKey(english: string): boolean {
    const n = english.trim();
    if (n.length < 2) return false;
    const words = n.split(/\s+/).filter(Boolean);
    if (words.length >= 2) return true;
    // Single words: allowlist only (avoids role-name collisions)
    return ALLOW_CHROME_SINGLE.has(n);
}

export function registerEnglishPack(pack: DiscordLocalePack) {
    for (const [english, arabic] of Object.entries(pack)) {
        if (!english || !arabic) continue;
        if (!isSafeEnglishKey(english)) continue;
        const norm = normalizeEnglish(english);
        englishToArabic.set(norm, arabic);
        englishLowerToArabic.set(norm.toLowerCase(), arabic);
    }
}

export function getArabicByPlainKey(plainKey: string): string | undefined {
    return plainToArabic.get(plainKey);
}

export function getArabicByHash(hash: string): string | undefined {
    return hashToArabic.get(hash);
}

export function normalizeEnglish(s: string) {
    return s
        .replace(/\u00a0/g, " ")
        .replace(/[ \t\f\v]+/g, " ")
        .replace(/\r\n/g, "\n")
        .replace(/[–—]/g, "-")
        .replace(/[‘’´`']/g, "'")
        .replace(/[“”"«»]/g, '"')
        .trim();
}

export function protectBidi(arabic: string): string {
    return arabic.replace(
        /\b(Cloud|iOS|Android|Windows|Linux|macOS|QR|API|CSS|FPS|GitHub|GitLab|Codeberg|Imgur|VALORANT|Shiki)\b/g,
        "\u2066$1\u2069"
    );
}
function applyCountPatterns(english: string): string | undefined {
    const norm = normalizeEnglish(english);

    let     m = /^(\d+)\s+Mutual Friends$/i.exec(norm);
    if (m) return `${m[1]} أصدقاء مشتركون`;

    m = /^(\d+)\s+Mutual Servers$/i.exec(norm);
    if (m) return `${m[1]} سيرفرات مشتركة`;

    m = /^(\d+)\s+accounts?$/i.exec(norm);
    if (m) return Number(m[1]) === 1 ? "حساب واحد" : `${m[1]} حسابات`;

    m = /^See\s+(\d+)\s+more$/i.exec(norm);
    if (m) return `شوف ${m[1]} زيادة`;

    m = /^(\d+)\s+devices?$/i.exec(norm);
    if (m) return Number(m[1]) === 1 ? "جهاز واحد" : `${m[1]} أجهزة`;

    m = /^Authorized on (\d{1,2}\/\d{1,2}\/\d{4})$/i.exec(norm);
    if (m) return `تم التصريح في ${m[1]}`;

    m = /^(\d+)\s+Seconds$/i.exec(norm);
    if (m) return `${m[1]} ثانية`;

    m = /^Online\s*-\s*(\d+)$/i.exec(norm);
    if (m) return `متصل - ${m[1]}`;

    m = /^All\s+friends\s*-\s*(\d+)$/i.exec(norm);
    if (m) return `جميع الأصدقاء - ${m[1]}`;

    m = /^Received\s*-\s*(\d+)$/i.exec(norm);
    if (m) return `الواردة - ${m[1]}`;

    m = /^You may be sharing activity from (\d+) games? you play, including (.+?)\. Restrict sharing on a game-by-game basis\.$/i.exec(norm);
    if (m) return `قد تكون تشارك نشاطك من ${m[1]} ألعاب تلعبها، بما في ذلك ${m[2]}. قم بتقييد المشاركة لكل لعبة على حدة.`;

    m = /^You may be sharing activity from (\d+) games? you play, including (.+?)\.?$/i.exec(norm);
    if (m) {
        const game = m[2];
        const num = Number(m[1]);
        return num === 1
            ? `قد تكون تشارك نشاطك من لعبة واحدة تلعبها، بما في ذلك ${game}.`
            : `قد تكون تشارك نشاطك من ${num} ألعاب تلعبها، بما في ذلك ${game}.`;
    }

    m = /^\.?\s*Restrict sharing on a game-by-game basis\.?$/i.exec(norm);
    if (m) return "قم بتقييد المشاركة لكل لعبة على حدة.";

    m = /^Pending,\s*(\d+)\s+new$/i.exec(norm);
    if (m) return `معلقة، ${m[1]} جديدة`;

    m = /^(\d+)\s+Persons?$/i.exec(norm);
    if (m) return Number(m[1]) === 1 ? "شخص واحد" : `${m[1]} أشخاص`;

    m = /^(\d+)\s+People$/i.exec(norm);
    if (m) return `${m[1]} أشخاص`;

    m = /^Member since (.+)$/i.exec(norm);
    if (m) return `عضو منذ ${m[1]}`;

    m = /^Logging in as (.+)$/i.exec(norm);
    if (m) return `تسجيل الدخول كـ ${m[1]}`;

    return;
}

export function getArabicByEnglish(english: string): string | undefined {
    if (!english) return;

    const hit = englishToArabic.get(english)
        ?? englishLowerToArabic.get(english.toLowerCase());
    if (hit) return protectBidi(hit);

    const norm = normalizeEnglish(english);
    if (!norm) return;

    const byNorm = englishToArabic.get(norm)
        ?? englishLowerToArabic.get(norm.toLowerCase());
    if (byNorm) return protectBidi(byNorm);

    const patterned = applyCountPatterns(norm);
    if (patterned) return protectBidi(patterned);
}

export function translateEnglishResult(value: unknown): unknown {
    if (typeof value !== "string" || !value.length) return value;
    return getArabicByEnglish(value) ?? value;
}

export function getDiscordCoverage() {
    return {
        intlKeys: plainToArabic.size,
        englishPhrases: englishToArabic.size,
    };
}
