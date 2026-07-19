/** Keep each English key in one en-text shard. Then run mergeEnText.mjs */

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const dir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src",
    "plugins",
    "arabicUi",
    "locales",
    "discord",
    "en-text",
);

function isExtras(name) {
    return name.startsWith("extras_");
}

function loadShards() {
    const files = readdirSync(dir)
        .filter(f => f.endsWith(".json") && f !== "_all.json")
        .sort((a, b) => a.localeCompare(b));

    /** @type {Map<string, Record<string, string>>} */
    const byFile = new Map();
    for (const f of files) {
        const raw = readFileSync(join(dir, f), "utf8");
        byFile.set(f, JSON.parse(raw));
    }
    return byFile;
}

function pickWinner(sources) {
    const topics = sources.filter(s => !isExtras(s.file)).sort((a, b) => a.file.localeCompare(b.file));
    if (topics.length) return topics[0];
    const extras = sources.filter(s => isExtras(s.file)).sort((a, b) => a.file.localeCompare(b.file));
    return extras[0];
}

function writeSorted(file, obj) {
    const sorted = Object.fromEntries(
        Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0])),
    );
    writeFileSync(join(dir, file), JSON.stringify(sorted, null, 4) + "\n", "utf8");
}

const byFile = loadShards();

/** @type {Map<string, {file: string, value: string}[]>} */
const keySources = new Map();
for (const [file, obj] of byFile) {
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value !== "string") continue;
        if (!keySources.has(key)) keySources.set(key, []);
        keySources.get(key).push({ file, value });
    }
}

const conflicts = [];
let removed = 0;
let keysTouched = 0;

for (const [key, sources] of keySources) {
    if (sources.length < 2) continue;
    keysTouched++;

    const winner = pickWinner(sources);
    const arabicVariants = new Set(sources.map(s => s.value));
    if (arabicVariants.size > 1) {
        conflicts.push({
            key,
            kept: { file: winner.file, value: winner.value },
            dropped: sources
                .filter(s => s.file !== winner.file || s.value !== winner.value)
                .map(s => ({ file: s.file, value: s.value })),
        });
    }

    for (const s of sources) {
        if (s.file === winner.file) {
            byFile.get(s.file)[key] = winner.value;
            continue;
        }
        if (key in byFile.get(s.file)) {
            delete byFile.get(s.file)[key];
            removed++;
        }
    }
}

for (const [file, obj] of byFile)
    writeSorted(file, obj);

const reportPath = join(dir, "_dedupe_report.json");
writeFileSync(
    reportPath,
    JSON.stringify(
        {
            keysInMultipleFiles: keysTouched,
            entriesRemoved: removed,
            conflictingArabic: conflicts.length,
            conflicts: conflicts.slice(0, 100),
            note: conflicts.length > 100 ? `…and ${conflicts.length - 100} more` : undefined,
        },
        null,
        2,
    ) + "\n",
    "utf8",
);

console.log(JSON.stringify({
    keysDeduped: keysTouched,
    entriesRemoved: removed,
    conflictingArabic: conflicts.length,
    report: reportPath,
}, null, 2));
