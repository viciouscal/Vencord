/**
 * Rewrite Arabic locale values to house loanword style.
 * Run before mergeEnText.mjs
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "plugins", "arabicUi", "locales");

const REPLACEMENTS = [
    [/BetterDiscord/gi, "بيتر ديسكورد"],
    [/بيترديسكورد/g, "بيتر ديسكورد"],
    [/بيتردسكورد/g, "بيتر ديسكورد"],
    [/Server Boosts?/gi, "سيرفر بوست"],
    [/Guild Boosts?/gi, "سيرفر بوست"],
    [/Rich Presence/gi, "حالة النشاط"],
    [/رتش بريزنس/g, "حالة النشاط"],
    [/النشاط الغني/g, "حالة النشاط"],
    [/Streamer Mode/gi, "وضع الستريمر"],
    [/Spotify/gi, "سبوتفاي"],
    [/YouTube/gi, "يوتيوب"],
    [/Twitch/gi, "تويتش"],
    [/Patreon/gi, "باتريون"],
    [/Webhooks/gi, "ويب هوكس"],
    [/Webhook/gi, "ويب هوك"],

    [/Unmute/gi, "فك الميوت"],
    [/Undeafen/gi, "فك الديفن"],
    [/Discord/gi, "دسكورد"],
    [/Vencord/gi, "فينكورد"],
    [/Nitro/gi, "نيترو"],
    [/Boosting/gi, "البوست"],
    [/Boosted/gi, "عليه بوست"],
    [/Boosts/gi, "بوستات"],
    [/Boost/gi, "بوست"],
    [/Mute/gi, "ميوت"],
    [/Deafen/gi, "ديفن"],
    [/Servers/gi, "سيرفرات"],
    [/Server/gi, "سيرفر"],
    [/Guilds/gi, "سيرفرات"],
    [/Guild/gi, "سيرفر"],

    [/\bDMs\b/gi, "الخاص"],
    [/\bDM\b/gi, "خاص"],
    [/دي ام/g, "خاص"],
    [/\bGIFs\b/gi, "صور متحركة"],
    [/\bGIF\b/gi, "صورة متحركة"],
    [/جيفات/g, "صور متحركة"],
    [/جيف/g, "صورة متحركة"],

    [/Quests/gi, "كويستس"],
    [/Quest/gi, "كويست"],
    [/Streamer/gi, "ستريمر"],

    [/Moderators/gi, "مودريترز"],
    [/Moderator/gi, "مودريتر"],
    [/\bMods\b/gi, "مودز"],
    [/\bMod\b/gi, "مود"],
    [/\bAdmins\b/gi, "ادمنز"],
    [/\bAdmin\b/gi, "ادمن"],
    [/\bBanned\b/gi, "مبند"],
    [/\bBanning\b/gi, "الباند"],
    [/\bBans\b/gi, "باندات"],
    [/\bBan\b/gi, "باند"],
    [/\bKicked\b/gi, "تم الكيك"],
    [/\bKicking\b/gi, "الكيك"],
    [/\bKick\b/gi, "كيك"],
    [/\bTimeouts\b/gi, "تايم اوتات"],
    [/\bTimeout\b/gi, "تايم اوت"],
    [/\bSpam\b/gi, "سبام"],
    [/\bBots\b/gi, "بوتات"],
    [/\bBot\b/gi, "بوت"],
    [/\bOffline\b/gi, "اوفلاين"],
    [/\bOnline\b/gi, "اونلاين"],
    [/\bBanners\b/gi, "بانرات"],
    [/\bBanner\b/gi, "بانر"],
    [/\bBadges\b/gi, "بادجز"],
    [/\bBadge\b/gi, "بادج"],
    [/\bStickers\b/gi, "ستيكرات"],
    [/\bSticker\b/gi, "ستيكر"],
    [/\bEmojis\b/gi, "ايموجيز"],
    [/\bEmoji\b/gi, "ايموجي"],
    [/\bThreads\b/gi, "ثريدات"],
    [/\bThread\b/gi, "ثريد"],
    [/\bForums\b/gi, "فورمز"],
    [/\bForum\b/gi, "فورم"],
    [/\bOverlays\b/gi, "اوفرلايز"],
    [/\bOverlay\b/gi, "اوفرلاي"],
    [/\bThemes\b/gi, "ثيمات"],
    [/\bTheme\b/gi, "ثيم"],
    [/\bPlugins\b/gi, "بلوقنز"],
    [/\bPlugin\b/gi, "بلوقن"],

    [/(?<!بيتر )ديسكورد/g, "دسكورد"],
    [/الخوادم/g, "السيرفرات"],
    [/خوادم/g, "سيرفرات"],
    [/الخادم/g, "السيرفر"],
    [/خادم/g, "سيرفر"],
    [/تعزيزات السيرفر/g, "سيرفر بوستات"],
    [/تعزيز السيرفر/g, "سيرفر بوست"],
    [/التعزيز/g, "البوست"],
    [/تعزيز/g, "بوست"],
    [/إلغاء الكتم/g, "فك الميوت"],
    [/الكتم/g, "الميوت"],
    [/كتم/g, "ميوت"],
    [/إلغاء الصمم/g, "فك الديفن"],
    [/الصمم/g, "الديفن"],
    [/صمم/g, "ديفن"],
    [/غير متصلة/g, "اوفلاين"],
    [/غير متصلين/g, "اوفلاين"],
    [/غير متصل/g, "اوفلاين"],

    [/تأكيد الحظر/g, "تأكيد الباند"],
    [/مدة الحظر/g, "مدة الباند"],
    [/سبب الحظر/g, "سبب الباند"],
    [/حظر الأعضاء/g, "باند الأعضاء"],
    [/حظر العضو/g, "باند العضو"],
    [/حظر المستخدم/g, "باند المستخدم"],
    [/إلغاء الحظر/g, "فك الباند"],
    [/رفع الحظر/g, "فك الباند"],
    [/طرد الأعضاء/g, "كيك الأعضاء"],
    [/طرد العضو/g, "كيك العضو"],
    [/طرد المستخدم/g, "كيك المستخدم"],
    [/إيموجيز/g, "ايموجيز"],
    [/إيموجي/g, "ايموجي"],
    [/رموز تعبيرية/g, "ايموجيز"],
    [/رمز تعبيري/g, "ايموجي"],
    [/الملصقات/g, "الستيكرات"],
    [/ملصقات/g, "ستيكرات"],
    [/ملصق/g, "ستيكر"],
    [/أرشفة الموضوع/g, "أرشفة الثريد"],
    [/مسح سجل الموضوع/g, "مسح سجل الثريد"],
    [/المواضيع النشطة/g, "الثريدات النشطة"],
    [/إنشاء موضوع/g, "إنشاء ثريد"],
    [/إنشاء منتدى/g, "إنشاء فورم"],
    [/إنشاء فئة منتدى/g, "إنشاء فئة فورم"],
    [/التخطيط الافتراضي للمنتدى/g, "التخطيط الافتراضي للفورم"],
    [/دردشة الغطاء/g, "دردشة الاوفرلاي"],
    [/قفل الغطاء/g, "قفل الاوفرلاي"],
    [/مناطق الغطاء/g, "مناطق الاوفرلاي"],
    [/إغلاق التراكب/g, "إغلاق الاوفرلاي"],
    [/تعيين دور المسؤول/g, "تعيين دور ادمن"],
    [/تعيين دور المشرف/g, "تعيين دور مودريتر"],
    [/تعيين مشرف/g, "تعيين مودريتر"],
    [/تعيين مشرفي المسرح/g, "تعيين مودريترز المسرح"],
];

const STRIP_ENGLISH_PARENS = /\s*\([A-Za-z][A-Za-z0-9 .+\-_\/]{0,40}\)/g;

function fixArabic(value) {
    let s = value;
    for (const [re, to] of REPLACEMENTS)
        s = s.replace(re, to);
    s = s.replace(/بيتر دسكورد/g, "بيتر ديسكورد");
    s = s.replace(STRIP_ENGLISH_PARENS, "");
    return s.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,!?،])/g, "$1").trim();
}

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (name.endsWith(".json") && name !== "glossary.json") out.push(p);
    }
    return out;
}

let files = 0;
let changedValues = 0;

for (const file of walk(root)) {
    let obj;
    try {
        obj = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        continue;
    }

    let dirty = false;
    function visit(node) {
        if (Array.isArray(node)) return node.map(visit);
        if (!node || typeof node !== "object") return node;
        const next = {};
        for (const [k, v] of Object.entries(node)) {
            if (typeof v === "string") {
                const fixed = fixArabic(v);
                if (fixed !== v) {
                    changedValues++;
                    dirty = true;
                }
                next[k] = fixed;
            } else {
                next[k] = visit(v);
            }
        }
        return next;
    }

    const updated = visit(obj);
    if (!dirty) continue;
    files++;
    const space = file.replace(/\\/g, "/").includes("/en-text/") && !file.endsWith("_all.json") ? 4 : 2;
    writeFileSync(file, JSON.stringify(updated, null, space) + "\n", "utf8");
}

console.log(JSON.stringify({ filesTouched: files, valuesChanged: changedValues }, null, 2));
