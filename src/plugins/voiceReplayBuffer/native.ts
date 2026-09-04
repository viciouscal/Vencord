import { downloadToFile, fetchBuffer, fetchJson } from "@main/utils/http";
import { VENCORD_USER_AGENT } from "@shared/vencordUserAgent";
import { createHash } from "crypto";
import { app, dialog, IpcMainInvokeEvent, shell } from "electron";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { createRequire } from "module";
import { basename, dirname, extname, join, normalize } from "path";
import { promisify } from "util";
import { gunzip, gzip } from "zlib";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

function safeName(name: string) {
    return basename(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 220) || "voice-replay";
}

function targetInFolder(folder: string, filename: string) {
    return join(normalize(folder), safeName(filename));
}

function pluginDataFolder() {
    return join(app.getPath("userData"), "Vencord", "VoiceReplayBuffer");
}

function catalogFile() {
    return join(pluginDataFolder(), "recordings-index.json");
}

function stemsFolderForAudio(audioPath: string) {
    const key = createHash("sha256").update(pathKey(audioPath)).digest("hex").slice(0, 24);
    return join(pluginDataFolder(), "stems", key);
}

function stemFileForAudio(audioPath: string, userId: string) {
    const safeUser = String(userId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96) || "unknown";
    return join(stemsFolderForAudio(audioPath), `${safeUser}.pcm16.gz`);
}

function pathKey(path: string) {
    return normalize(path).toLocaleLowerCase();
}

type CatalogEntry = {
    audioPath: string;
    metadata: any;
};

type Catalog = Record<string, CatalogEntry>;

async function readCatalog(): Promise<Catalog> {
    try {
        return JSON.parse(await readFile(catalogFile(), "utf8")) as Catalog;
    } catch {
        return {};
    }
}

async function writeCatalog(catalog: Catalog) {
    const file = catalogFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(catalog), "utf8");
}

export async function chooseSaveFolder(_: IpcMainInvokeEvent, localizedTitle?: string) {
    const result = await dialog.showOpenDialog({
        title: String(localizedTitle || "Voice Replay — Choose recordings folder"),
        properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return normalize(result.filePaths[0]);
}

export async function beginVideoExport(_: IpcMainInvokeEvent, folder: string, filename: string) {
    if (!folder || !filename) return null;
    const targetFolder = normalize(folder);
    await mkdir(targetFolder, { recursive: true });
    const target = targetInFolder(targetFolder, filename);
    await writeFile(target, Buffer.alloc(0));
    return target;
}

export async function appendVideoExportChunk(_: IpcMainInvokeEvent, folder: string, filename: string, data: Uint8Array) {
    if (!folder || !filename || !data?.byteLength) return false;
    const target = targetInFolder(normalize(folder), filename);
    await appendFile(target, Buffer.from(data));
    return true;
}

export async function finishVideoExport(_: IpcMainInvokeEvent, folder: string, filename: string) {
    if (!folder || !filename) return null;
    const target = targetInFolder(normalize(folder), filename);
    try {
        const info = await stat(target);
        if (!info.size) {
            await rm(target, { force: true });
            return null;
        }
        return target;
    } catch {
        return null;
    }
}

export async function abortVideoExport(_: IpcMainInvokeEvent, folder: string, filename: string) {
    if (!folder || !filename) return false;
    await rm(targetInFolder(normalize(folder), filename), { force: true });
    return true;
}

export async function saveBytes(_: IpcMainInvokeEvent, folder: string, filename: string, data: Uint8Array) {
    const targetFolder = normalize(folder);
    await mkdir(targetFolder, { recursive: true });
    const target = targetInFolder(targetFolder, filename);
    await writeFile(target, Buffer.from(data));
    return target;
}

export async function indexRecording(_: IpcMainInvokeEvent, audioPath: string, metadata: any) {
    const catalog = await readCatalog();
    catalog[pathKey(audioPath)] = { audioPath: normalize(audioPath), metadata };
    await writeCatalog(catalog);
    return true;
}

export async function openFolder(_: IpcMainInvokeEvent, folder: string) {
    if (!folder) return "";
    return shell.openPath(normalize(folder));
}

export async function revealRecording(_: IpcMainInvokeEvent, folder: string, audioFilename: string) {
    if (!folder || !audioFilename) return false;
    shell.showItemInFolder(targetInFolder(folder, audioFilename));
    return true;
}

export async function readRecordingBytes(_: IpcMainInvokeEvent, folder: string, audioFilename: string) {
    if (!folder || !audioFilename) return null;
    try {
        const buffer = await readFile(targetInFolder(folder, audioFilename));
        return new Uint8Array(buffer);
    } catch {
        return null;
    }
}

export async function saveRecordingStem(_: IpcMainInvokeEvent, folder: string, audioFilename: string, userId: string, data: Uint8Array) {
    if (!folder || !audioFilename || !userId || !data) return false;
    const audioPath = targetInFolder(folder, audioFilename);
    const target = stemFileForAudio(audioPath, userId);
    await mkdir(dirname(target), { recursive: true });
    const compressed = await gzipAsync(Buffer.from(data), { level: 6 });
    await writeFile(target, compressed);
    return true;
}

export async function readRecordingStem(_: IpcMainInvokeEvent, folder: string, audioFilename: string, userId: string) {
    if (!folder || !audioFilename || !userId) return null;
    try {
        const audioPath = targetInFolder(folder, audioFilename);
        const compressed = await readFile(stemFileForAudio(audioPath, userId));
        const raw = await gunzipAsync(compressed);
        return new Uint8Array(raw);
    } catch {
        return null;
    }
}

export async function deleteRecording(_: IpcMainInvokeEvent, folder: string, audioFilename: string) {
    if (!folder || !audioFilename) return false;
    const audioPath = targetInFolder(folder, audioFilename);
    await rm(audioPath, { force: true });
    await rm(stemsFolderForAudio(audioPath), { recursive: true, force: true });
    const catalog = await readCatalog();
    delete catalog[pathKey(audioPath)];
    await writeCatalog(catalog);
    return true;
}

export async function setRecordingTitle(_: IpcMainInvokeEvent, folder: string, audioFilename: string, title: string) {
    if (!folder || !audioFilename) return null;
    const cleanTitle = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!cleanTitle) return null;

    const audioPath = targetInFolder(folder, audioFilename);
    const catalog = await readCatalog();
    const key = pathKey(audioPath);
    const existing = catalog[key] ?? { audioPath, metadata: {} };
    existing.metadata = { ...(existing.metadata ?? {}), customTitle: cleanTitle };
    catalog[key] = existing;
    await writeCatalog(catalog);
    return cleanTitle;
}

async function migrateLegacySidecars(folder: string, names: string[], catalog: Catalog) {
    let changed = false;
    for (const metadataFilename of names.filter(name => /^VoiceReplay_.*\.json$/i.test(name))) {
        const metadataPath = targetInFolder(folder, metadataFilename);
        try {
            const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
            const candidate = safeName(metadata?.recording?.audioFilename || basename(metadata?.recording?.audioPath || metadataFilename.replace(/\.json$/i, ".flac")));
            const audioFilename = names.includes(candidate)
                ? candidate
                : [metadataFilename.replace(/\.json$/i, ".flac"), metadataFilename.replace(/\.json$/i, ".wav")].find(name => names.includes(name));
            if (audioFilename) {
                const audioPath = targetInFolder(folder, audioFilename);
                catalog[pathKey(audioPath)] = { audioPath, metadata };
                changed = true;
            }
            await rm(metadataPath, { force: true });
        } catch {

        }
    }
    if (changed) await writeCatalog(catalog);
}

export async function listRecordings(_: IpcMainInvokeEvent, folder: string) {
    if (!folder) return [];
    const targetFolder = normalize(folder);
    let names: string[];
    try {
        names = await readdir(targetFolder);
    } catch {
        return [];
    }

    const catalog = await readCatalog();
    await migrateLegacySidecars(targetFolder, names, catalog);
    const freshCatalog = await readCatalog();
    const results: any[] = [];

    for (const audioFilename of names.filter(name => /^VoiceReplay_.*\.(flac|wav)$/i.test(name))) {
        try {
            const audioPath = targetInFolder(targetFolder, audioFilename);
            const fileStat = await stat(audioPath);
            const entry = freshCatalog[pathKey(audioPath)];
            results.push({
                id: audioFilename.replace(/\.(flac|wav)$/i, ""),
                audioFilename,
                metadataFilename: null,
                format: extname(audioFilename).slice(1).toLowerCase(),
                sizeBytes: fileStat.size,
                modifiedAt: fileStat.mtimeMs,
                metadata: entry?.metadata ?? null
            });
        } catch { }
    }

    return results.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

type ProcessLoopbackPacket = {
    startTimeMs: number;
    sampleRate: number;
    flags: number;
    pcm16: Uint8Array;
};

type ProcessLoopbackStartResult = {
    ok: boolean;
    backend: string;
    sampleRate?: number;
    error?: string;
};

type ProcessLoopbackSnapshot = {
    active: boolean;
    sampleRate: number;
    packets: ProcessLoopbackPacket[];
    error: string | null;
};

type ProcessLoopbackAddon = {
    start(targetProcessId: number): Promise<ProcessLoopbackStartResult>;
    poll(): ProcessLoopbackSnapshot;
    stop(): Promise<boolean>;
    getVersion(): string;
};

type GitHubReleaseAsset = {
    id: number;
    name: string;
    browser_download_url: string;
    digest?: string | null;
};

type GitHubRelease = {
    tag_name: string;
    assets: GitHubReleaseAsset[];
};

type CachedCaptureRelease = {
    tagName: string;
    nodeAssetId: number;
    checksumAssetId: number;
    sha256: string;
};

type ResolvedCaptureBinary = {
    path: string;
    source: string;
};

const CAPTURE_RELEASE_API = "https://api.github.com/repos/sultriness/VoiceReplayCapture/releases/latest";
const CAPTURE_DOWNLOAD_PATH_PREFIX = "/sultriness/VoiceReplayCapture/releases/download/";
const CAPTURE_NODE_ASSET_NAME = "voiceReplayCapture-win32-x64.node";
const CAPTURE_CHECKSUM_ASSET_NAME = `${CAPTURE_NODE_ASSET_NAME}.sha256`;

let resolvedCaptureBinaryPromise: Promise<ResolvedCaptureBinary> | null = null;
let loadedCaptureAddon: ProcessLoopbackAddon | null = null;
let loadedCaptureSource = "";
let processLoopbackActive = false;
let processLoopbackSampleRate = 0;

function captureCacheFolder() {
    return join(pluginDataFolder(), "native");
}

function captureNodePath() {
    return join(captureCacheFolder(), CAPTURE_NODE_ASSET_NAME);
}

function captureReleaseMetadataPath() {
    return join(captureCacheFolder(), "release.json");
}

function captureRequestHeaders() {
    return {
        Accept: "application/vnd.github+json",
        "User-Agent": VENCORD_USER_AGENT
    };
}

function errorText(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

async function fileExists(path: string) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function fileSha256(path: string) {
    return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readCachedCaptureRelease(): Promise<CachedCaptureRelease | null> {
    try {
        const value = JSON.parse(await readFile(captureReleaseMetadataPath(), "utf8")) as CachedCaptureRelease;
        if (
            typeof value?.tagName !== "string"
            || !Number.isSafeInteger(value?.nodeAssetId)
            || !Number.isSafeInteger(value?.checksumAssetId)
            || !/^[a-f0-9]{64}$/i.test(value?.sha256)
        ) return null;
        return {
            tagName: value.tagName,
            nodeAssetId: value.nodeAssetId,
            checksumAssetId: value.checksumAssetId,
            sha256: value.sha256.toLowerCase()
        };
    } catch {
        return null;
    }
}

function validateReleaseAsset(asset: GitHubReleaseAsset) {
    const url = new URL(asset.browser_download_url);
    if (
        url.protocol !== "https:"
        || url.hostname !== "github.com"
        || !url.pathname.startsWith(CAPTURE_DOWNLOAD_PATH_PREFIX)
    ) {
        throw new Error(`Rejected an unexpected Voice Replay Capture asset URL: ${url.origin}`);
    }
}

async function fetchReleaseChecksum(asset: GitHubReleaseAsset) {
    validateReleaseAsset(asset);
    const text = (await fetchBuffer(asset.browser_download_url, {
        headers: captureRequestHeaders()
    })).toString("utf8");
    const match = text.match(/\b[a-f0-9]{64}\b/i);
    if (!match) throw new Error("Voice Replay Capture release checksum is invalid.");
    return match[0].toLowerCase();
}

async function installCaptureBinary(asset: GitHubReleaseAsset, expectedSha256: string) {
    validateReleaseAsset(asset);
    const target = captureNodePath();
    const temporary = `${target}.download`;
    await rm(temporary, { force: true });

    try {
        await downloadToFile(asset.browser_download_url, temporary, {
            headers: captureRequestHeaders()
        });
        const actualSha256 = await fileSha256(temporary);
        if (actualSha256 !== expectedSha256) {
            throw new Error("Voice Replay Capture download failed SHA-256 verification.");
        }
        await rm(target, { force: true });
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}

async function resolveCaptureBinary(): Promise<ResolvedCaptureBinary> {
    resolvedCaptureBinaryPromise ??= (async () => {
        await mkdir(captureCacheFolder(), { recursive: true });

        const target = captureNodePath();
        const cached = await fileExists(target);
        const metadata = await readCachedCaptureRelease();

        try {
            const release = await fetchJson<GitHubRelease>(CAPTURE_RELEASE_API, {
                headers: captureRequestHeaders()
            });
            const nodeAsset = release.assets?.find(asset => asset.name === CAPTURE_NODE_ASSET_NAME);
            const checksumAsset = release.assets?.find(asset => asset.name === CAPTURE_CHECKSUM_ASSET_NAME);
            if (!nodeAsset || !checksumAsset) {
                throw new Error("Voice Replay Capture release assets are incomplete.");
            }
            validateReleaseAsset(nodeAsset);
            validateReleaseAsset(checksumAsset);

            const cachedSha256 = cached ? await fileSha256(target) : null;
            const metadataMatches = metadata?.tagName === release.tag_name
                && metadata.nodeAssetId === nodeAsset.id
                && metadata.checksumAssetId === checksumAsset.id
                && cachedSha256 === metadata.sha256;

            if (metadataMatches) {
                return { path: target, source: `release ${release.tag_name}` };
            }

            const expectedSha256 = await fetchReleaseChecksum(checksumAsset);
            const releaseDigest = nodeAsset.digest?.toLowerCase();
            if (releaseDigest && releaseDigest !== `sha256:${expectedSha256}`) {
                throw new Error("Voice Replay Capture release digest does not match its checksum.");
            }

            if (cachedSha256 !== expectedSha256) {
                await installCaptureBinary(nodeAsset, expectedSha256);
            }

            await writeFile(captureReleaseMetadataPath(), JSON.stringify({
                tagName: release.tag_name,
                nodeAssetId: nodeAsset.id,
                checksumAssetId: checksumAsset.id,
                sha256: expectedSha256
            } satisfies CachedCaptureRelease), "utf8");

            return { path: target, source: `release ${release.tag_name}` };
        } catch (error) {
            if (cached && metadata && await fileSha256(target) === metadata.sha256) {
                return { path: target, source: `cached ${metadata.tagName}` };
            }
            throw error;
        }
    })().catch(error => {
        resolvedCaptureBinaryPromise = null;
        throw error;
    });

    return resolvedCaptureBinaryPromise;
}

async function getCaptureAddon() {
    if (loadedCaptureAddon) return loadedCaptureAddon;

    const resolved = await resolveCaptureBinary();
    const nativeRequire = createRequire(join(captureCacheFolder(), "loader.cjs"));
    const candidate = nativeRequire(resolved.path) as Partial<ProcessLoopbackAddon>;
    if (
        typeof candidate?.start !== "function"
        || typeof candidate?.poll !== "function"
        || typeof candidate?.stop !== "function"
        || typeof candidate?.getVersion !== "function"
    ) {
        throw new Error("Voice Replay Capture native addon has an invalid API.");
    }

    loadedCaptureAddon = candidate as ProcessLoopbackAddon;
    loadedCaptureSource = resolved.source;
    return loadedCaptureAddon;
}

export async function startDiscordProcessLoopback(_: IpcMainInvokeEvent) {
    if (process.platform !== "win32" || process.arch !== "x64") {
        return {
            ok: false,
            backend: "unavailable",
            error: "Windows x64 process loopback is required for native Discord audio capture."
        };
    }
    if (processLoopbackActive) {
        return {
            ok: true,
            backend: "wasapi-process-loopback",
            sampleRate: processLoopbackSampleRate
        };
    }

    try {
        const addon = await getCaptureAddon();
        const result = await addon.start(process.pid);
        processLoopbackActive = Boolean(result?.ok);
        processLoopbackSampleRate = processLoopbackActive ? Number(result.sampleRate || 0) : 0;
        return {
            ...result,
            source: loadedCaptureSource,
            version: addon.getVersion()
        };
    } catch (error) {
        processLoopbackActive = false;
        processLoopbackSampleRate = 0;
        return {
            ok: false,
            backend: "wasapi-process-loopback",
            error: errorText(error)
        };
    }
}

export async function pollDiscordProcessLoopback(_: IpcMainInvokeEvent) {
    if (!loadedCaptureAddon) {
        return { active: false, sampleRate: 0, packets: [], error: null };
    }

    try {
        const snapshot = loadedCaptureAddon.poll();
        processLoopbackActive = Boolean(snapshot?.active);
        processLoopbackSampleRate = processLoopbackActive ? Number(snapshot.sampleRate || 0) : 0;
        return snapshot;
    } catch (error) {
        processLoopbackActive = false;
        processLoopbackSampleRate = 0;
        return {
            active: false,
            sampleRate: 0,
            packets: [],
            error: errorText(error)
        };
    }
}

export async function stopDiscordProcessLoopback(_: IpcMainInvokeEvent | null) {
    processLoopbackActive = false;
    processLoopbackSampleRate = 0;
    if (!loadedCaptureAddon) return true;
    try {
        return await loadedCaptureAddon.stop();
    } catch {
        return false;
    }
}
