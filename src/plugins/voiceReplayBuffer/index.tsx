import { definePluginSettings } from "@api/Settings";
import { findModuleId, wreq } from "@webpack";
import { copyWithToast, openUserProfile } from "@utils/discord";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import {
    createRoot,
    MediaEngineStore,
    Modal,
    openModal,
    React,
    ReactDOM,
    SelectedChannelStore,
    showToast,
    Toasts,
    Tooltip,
    UserStore,
    UserUtils
} from "@webpack/common";
import type { ReactNode } from "react";

import { ActivitySnapshot, voiceActivityTracker } from "./activity";
import { encodePcm16FlacAsync, encodePcm16Wav } from "./codec";
import { RecordingFormat, RecorderStatus, voiceRecorder } from "./recorder";
import managedStyle from "./style.css?managed";

const Native = VencordNative.pluginHelpers.VoiceReplayBuffer as PluginNative<typeof import("./native")>;
voiceRecorder.setNativeRemoteCaptureBridge({
    start: () => Native.startDiscordProcessLoopback(),
    poll: () => Native.pollDiscordProcessLoopback(),
    stop: () => Native.stopDiscordProcessLoopback()
});
const QUICK_SAVE_DURATIONS = [30, 60, 300, 600] as const;
const AUTHOR_ID = "297283663991668738";
const RESIDUAL_STEM_ID = "__vrb_residual__";
const ROOM_EVENTS_STEM_ID = "__vrb_room_events__";
type PluginLanguage = "en" | "ar";
let settingsRef: any = null;

function pluginLanguage(): PluginLanguage {
    try {
        return settingsRef?.store?.language === "ar" ? "ar" : "en";
    } catch {
        return "en";
    }
}

function tr(english: string, arabic: string) {
    return pluginLanguage() === "ar" ? arabic : english;
}

function usePluginLanguage(): PluginLanguage {
    const store = settings.use(["language"]);
    return store.language === "ar" ? "ar" : "en";
}

function localizedBackGlyph() {
    return pluginLanguage() === "ar" ? "›" : "‹";
}

const settings = definePluginSettings({
    language: {
        type: OptionType.SELECT,
        get displayName() { return tr("Plugin language", "لغة البلوقن"); },
        get description() { return tr("Changes only Voice Replay. Discord's language is not affected.", "تغيّر لغة Voice Replay فقط، ولا تغيّر لغة دسكورد."); },
        options: [
            { label: "English", value: "en", default: true },
            { label: "العربية", value: "ar" }
        ],
        hidden: true
    },
    bufferCapacitySeconds: {
        type: OptionType.NUMBER,
        get displayName() { return tr("Rolling buffer capacity", "سعة التسجيل المؤقت"); },
        get description() { return tr(
            "Voice Replay can stay on for hours, but only this newest window is kept. Older audio is continuously discarded (10-3600 seconds).",
            "يمكن أن يبقى Voice Replay شغالًا لساعات، لكنه يحتفظ فقط بآخر مدة تحددها ويحذف الأقدم باستمرار (من 10 إلى 3600 ثانية)."
        ); },
        default: 600,
        isValid: value => {
            const n = Number(value);
            return Number.isFinite(n) && n >= 10 && n <= 3600 ? true : tr("Enter a duration from 10 to 3600 seconds.", "أدخل مدة من 10 إلى 3600 ثانية.");
        },
        onChange: value => voiceRecorder.setMaxBufferSeconds(Number(value)),
        hidden: true
    },
    toggleShortcut: {
        type: OptionType.STRING,
        get displayName() { return tr("Save replay shortcut", "اختصار حفظ التسجيل"); },
        get description() { return tr("Saves the only available duration or opens the duration chooser.", "يحفظ المدة الوحيدة المتاحة أو يفتح نافذة اختيار المدة."); },
        default: "Ctrl+Shift+F7",
        hidden: true
    },
    format: {
        type: OptionType.SELECT,
        get displayName() { return tr("Output format", "صيغة التسجيل"); },
        get description() { return tr("FLAC and WAV are both lossless after Discord audio is decoded.", "يحفظ FLAC وWAV الصوت دون فقدان إضافي للجودة بعد استقباله من دسكورد."); },
        get options() { return [
            { label: "FLAC", value: "flac", default: true },
            { label: "WAV", value: "wav" }
        ]; },
        hidden: true
    },
    autoStart: {
        type: OptionType.BOOLEAN,
        get displayName() { return tr("Auto-start when joining voice", "التشغيل التلقائي عند دخول قناة صوتية"); },
        get description() { return tr("Automatically starts the rolling buffer when you join a voice channel.", "يشغّل التسجيل المؤقت تلقائيًا عند دخولك قناة صوتية."); },
        default: false,
        hidden: true
    },
    includeMicrophone: {
        type: OptionType.BOOLEAN,
        get displayName() { return tr("Include my microphone", "تضمين صوتك"); },
        get description() { return tr("Adds your voice to the recording.", "يضيف صوتك إلى التسجيل."); },
        default: true,
        onChange: value => void voiceRecorder.setMicrophoneEnabled(Boolean(value), MediaEngineStore.getInputDeviceId?.() ?? null),
        hidden: true
    },
    notifications: {
        type: OptionType.BOOLEAN,
        get displayName() { return tr("Notifications", "الإشعارات"); },
        get description() { return tr("Show small Discord toasts when Voice Replay starts, stops or saves a clip.", "يعرض إشعارات صغيرة داخل دسكورد عند تشغيل Voice Replay أو إيقافه أو حفظ تسجيل."); },
        default: true,
        hidden: true
    },
    saveFolder: {
        type: OptionType.STRING,
        get description() { return tr("Recordings folder", "مجلد التسجيلات"); },
        default: "",
        hidden: true
    },
    customSaveMinutes: {
        type: OptionType.NUMBER,
        get description() { return tr("Custom replay duration in minutes.", "مدة التسجيل المخصصة بالدقائق."); },
        default: 0,
        hidden: true
    }
});
settingsRef = settings;

type RecordingParticipant = {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    spokeInClip?: boolean;
    isolatedAudio?: boolean;
};

type RecordingSegment = {
    userId: string;
    offsetStartSeconds: number;
    offsetEndSeconds: number;
};

type RecordingRoomParticipantState = {
    userId: string;
    username?: string;
    displayName?: string;
    avatarUrl?: string | null;
    muted?: boolean;
    deafened?: boolean;
    selfMute?: boolean;
    selfDeaf?: boolean;
    serverMute?: boolean;
    serverDeaf?: boolean;
    localMute?: boolean;
};

type RecordingRoomEvent = {
    offsetSeconds: number;
    at?: string;
    channelId: string | null;
    channelName: string | null;
    guildId?: string | null;
    guildName?: string | null;
    participants: RecordingRoomParticipantState[];
};

type RecordingMetadata = {
    metadataVersion?: number;
    customTitle?: string;
    capturedAt?: string;
    guildId?: string | null;
    guildName?: string | null;
    channelId?: string | null;
    channelName?: string | null;
    participantCount?: number;
    participants?: RecordingParticipant[];
    speakingTimeline?: RecordingSegment[];
    roomTimeline?: RecordingRoomEvent[];
    recording?: {
        format?: string;
        sampleRate?: number;
        channels?: number;
        bitDepth?: number;
        durationSeconds?: number;
        requestedDurationSeconds?: number;
        rollingBufferCapacitySeconds?: number;
        clipStartedAt?: string;
        clipEndedAt?: string;
        includedMicrophone?: boolean;
        incomingCapture?: string;
        isolatedTrackUserIds?: string[];
        hasResidualStem?: boolean;
        hasRoomEventStem?: boolean;
        joinLeaveCues?: boolean;
        joinLeaveCueCount?: number;
        unmappedRemoteSources?: number;
        audioPath?: string;
        audioFilename?: string;
    };
};

type SavedRecording = {
    id: string;
    audioFilename: string;
    metadataFilename: string | null;
    format: string;
    sizeBytes: number;
    modifiedAt: number;
    metadata: RecordingMetadata | null;
};

let lastVoiceChannelId: string | null = null;
let recorderActivityUnsubscribe: (() => void) | null = null;
let saving = false;
let saveFlashUntil = 0;
const saveFlashListeners = new Set<() => void>();

function emitSaveFlash() {
    saveFlashUntil = Date.now() + 780;
    for (const listener of saveFlashListeners) listener();
    window.setTimeout(() => {
        for (const listener of saveFlashListeners) listener();
    }, 820);
}

function bufferCapacitySeconds() {
    const value = Math.floor(Number(settings.store.bufferCapacitySeconds));
    return Number.isFinite(value) ? Math.min(3600, Math.max(10, value)) : 600;
}


function formatDuration(seconds: number) {
    if (!Number.isFinite(seconds)) return tr("0s", "0 ث");
    seconds = Math.max(0, seconds);
    if (seconds < 60) return pluginLanguage() === "ar" ? `${Math.round(seconds)} ث` : `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    if (minutes < 60) {
        if (pluginLanguage() === "ar") return rest ? `${minutes} د ${rest} ث` : `${minutes} د`;
        return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const minRest = minutes % 60;
    if (pluginLanguage() === "ar") return minRest ? `${hours} س ${minRest} د` : `${hours} س`;
    return minRest ? `${hours}h ${minRest}m` : `${hours}h`;
}

function formatClock(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const whole = Math.floor(seconds);
    const minutes = Math.floor(whole / 60);
    const rest = whole % 60;
    return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function recordingTimestamp(recording: SavedRecording) {
    const captured = recording.metadata?.capturedAt;
    const parsed = captured ? Date.parse(captured) : NaN;
    return Number.isFinite(parsed) ? parsed : recording.modifiedAt;
}

function formatRecordingDate(recording: SavedRecording) {
    const date = new Date(recordingTimestamp(recording));
    const locale = pluginLanguage() === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : undefined;
    return `${date.toLocaleDateString(locale)} • ${date.toLocaleTimeString(locale)}`;
}

function safeFilenamePart(value: unknown): string {
    return String(value ?? "voice-channel")
        .normalize("NFKD")
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 70) || "voice-channel";
}

function timestampForFilename(date: Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function toast(message: string, type = Toasts.Type.MESSAGE) {
    if (settings.store.notifications) showToast(message, type);
}


type RoomCueKind = "user_join" | "user_leave" | "user_moved" | "disconnect";
type RoomCue = { atSeconds: number; kind: RoomCueKind; afterPrevious?: boolean; };

const DISCORD_ROOM_CUE_KINDS: readonly RoomCueKind[] = ["user_join", "user_leave", "user_moved", "disconnect"];
let discordSoundAssetResolver: ((path: string) => string) | null | undefined;
const discordRoomCueCache = new Map<string, Float32Array>();
const discordRoomCuePreloads = new Map<number, Promise<void>>();

function roomPresenceCues(timeline: RecordingRoomEvent[] | undefined): RoomCue[] {
    const events = timeline ?? [];
    const cues: RoomCue[] = [];
    let participantSettleUntil = -1;

    for (let index = 1; index < events.length; index++) {
        const previous = events[index - 1];
        const current = events[index];
        const atSeconds = Math.max(0, Number(current.offsetSeconds) || 0);
        const previousIds = new Set((previous.participants ?? []).map(participant => participant.userId));
        const currentIds = new Set((current.participants ?? []).map(participant => participant.userId));

        if (previous.channelId !== current.channelId) {


            participantSettleUntil = current.channelId ? atSeconds + .75 : -1;

            if (previous.channelId && current.channelId) {


                cues.push({ atSeconds, kind: "user_leave" });
                cues.push({ atSeconds, kind: "user_join", afterPrevious: true });
            } else if (current.channelId) {
                cues.push({ atSeconds, kind: "user_join" });
            } else if (previous.channelId) {
                cues.push({ atSeconds, kind: "disconnect" });
            }
            continue;
        }
        if (!current.channelId) continue;



        if (atSeconds <= participantSettleUntil) continue;

        const someoneLeft = Array.from(previousIds).some(userId => !currentIds.has(userId));
        const someoneJoined = Array.from(currentIds).some(userId => !previousIds.has(userId));
        if (someoneLeft) cues.push({ atSeconds, kind: "user_leave" });
        if (someoneJoined) cues.push({ atSeconds: atSeconds + (someoneLeft ? .06 : 0), kind: "user_join" });
    }
    return cues;
}

function getDiscordSoundAssetResolver() {
    if (discordSoundAssetResolver !== undefined) return discordSoundAssetResolver;
    try {
        const moduleId = findModuleId("./user_join.mp3", "./user_leave.mp3", "./user_moved.mp3");
        if (moduleId == null) return discordSoundAssetResolver = null;
        const resolver = wreq(moduleId as any);
        discordSoundAssetResolver = typeof resolver === "function" ? resolver as (path: string) => string : null;
    } catch {
        discordSoundAssetResolver = null;
    }
    return discordSoundAssetResolver;
}

function resampleMono(samples: Float32Array, inputRate: number, outputRate: number) {
    if (inputRate === outputRate || !samples.length) return samples;
    const outputLength = Math.max(1, Math.round(samples.length * outputRate / inputRate));
    const output = new Float32Array(outputLength);
    const ratio = inputRate / outputRate;
    for (let i = 0; i < outputLength; i++) {
        const position = i * ratio;
        const left = Math.min(samples.length - 1, Math.floor(position));
        const right = Math.min(samples.length - 1, left + 1);
        const fraction = position - left;
        output[i] = samples[left] * (1 - fraction) + samples[right] * fraction;
    }
    return output;
}





async function preloadDiscordRoomSounds(sampleRate = 48_000) {
    const rate = Math.max(8_000, Math.floor(sampleRate) || 48_000);
    const existing = discordRoomCuePreloads.get(rate);
    if (existing) return existing;

    const loading = (async () => {

        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        const resolver = getDiscordSoundAssetResolver();
        if (!resolver) return;

        let context: AudioContext | null = null;
        try {
            try {
                context = new AudioContext({ sampleRate: rate });
            } catch {
                context = new AudioContext();
            }

            for (const name of DISCORD_ROOM_CUE_KINDS) {
                const cacheKey = `${name}:${rate}`;
                if (discordRoomCueCache.has(cacheKey)) continue;

                try {
                    const url = resolver(`./${name}.mp3`);
                    if (!url) continue;
                    const response = await fetch(url);
                    if (!response.ok) continue;
                    const encoded = await response.arrayBuffer();
                    const decoded = await context.decodeAudioData(encoded.slice(0));
                    const channelCount = Math.max(1, decoded.numberOfChannels);
                    const mono = new Float32Array(decoded.length);
                    for (let channel = 0; channel < channelCount; channel++) {
                        const data = decoded.getChannelData(channel);
                        for (let i = 0; i < mono.length; i++) mono[i] += data[i] / channelCount;
                    }
                    discordRoomCueCache.set(cacheKey, resampleMono(mono, decoded.sampleRate, rate));
                } catch {

                }
            }
        } finally {
            if (context && context.state !== "closed") await context.close().catch(() => void 0);
        }
    })().catch(() => void 0);

    discordRoomCuePreloads.set(rate, loading);
    return loading;
}


function buildRoomCueStem(timeline: RecordingRoomEvent[] | undefined, sampleRate: number, sampleCount: number) {
    const cues = roomPresenceCues(timeline);
    if (!cues.length || sampleRate <= 0 || sampleCount <= 0) return null;

    const output = new Int16Array(sampleCount);
    let mixedAny = false;
    let previousCueEnd = 0;
    for (const cue of cues) {
        const samples = discordRoomCueCache.get(`${cue.kind}:${sampleRate}`);
        if (!samples?.length) continue;
        mixedAny = true;
        let start = Math.max(0, Math.floor(cue.atSeconds * sampleRate));
        if (cue.afterPrevious) start = Math.max(start, previousCueEnd + Math.floor(sampleRate * .04));
        for (let i = 0; i < samples.length && start + i < output.length; i++) {
            const target = start + i;
            const sample = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
            output[target] = Math.max(-32768, Math.min(32767, output[target] + sample));
        }
        previousCueEnd = Math.max(previousCueEnd, start + samples.length);
    }
    return mixedAny ? output : null;
}

function mixPcm16(base: Int16Array, overlay: Int16Array) {
    const output = new Int16Array(base);
    const count = Math.min(output.length, overlay.length);
    for (let i = 0; i < count; i++) output[i] = Math.max(-32768, Math.min(32767, output[i] + overlay[i]));
    return output;
}

async function encodePcmForFormat(samples: Int16Array, sampleRate: number, format: RecordingFormat, channels = 1) {
    return format === "flac"
        ? encodePcm16FlacAsync(samples, sampleRate, channels)
        : encodePcm16Wav(samples, sampleRate, channels);
}

function mixMonoOverlayIntoInterleaved(base: Int16Array, overlay: Int16Array, channels: number) {
    if (channels <= 1) return mixPcm16(base, overlay);
    const output = new Int16Array(base);
    const frames = Math.min(overlay.length, Math.floor(output.length / channels));
    for (let frame = 0; frame < frames; frame++) {
        for (let channel = 0; channel < channels; channel++) {
            const index = frame * channels + channel;
            output[index] = Math.max(-32768, Math.min(32767, output[index] + overlay[frame]));
        }
    }
    return output;
}

function localizedError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (pluginLanguage() !== "ar") return message;
    if (message.includes("Web Audio API is unavailable")) return "واجهة Web Audio غير متاحة في إصدار دسكورد الحالي.";
    if (message.includes("No voice audio has reached the replay buffer")) return "لم يصل أي صوت إلى التسجيل المؤقت بعد.";
    if (message.includes("Choose a recordings folder before saving")) return "اختر مجلدًا للتسجيلات قبل الحفظ.";
    if (message.startsWith("Only ") && message.includes(" are buffered")) return "المدة المتوفرة في التسجيل المؤقت أقل من المدة المطلوبة. انتظر حتى تكتمل المدة ثم حاول مرة أخرى.";
    if (message.includes("Video export is unavailable")) return "تصدير الفيديو غير متاح في إصدار دسكورد الحالي.";
    if (message.includes("Video export audio is unavailable")) return "تعذر تجهيز صوت التسجيل لتصدير الفيديو في إصدار دسكورد الحالي.";
    if (message.includes("Choose a recordings folder before exporting video")) return "اختر مجلد التسجيلات قبل تصدير الفيديو.";
    if (message.includes("Could not read this recording for video export")) return "تعذر قراءة التسجيل لتصدير الفيديو.";
    if (message.includes("Could not decode this recording for video export")) return "تعذر فك صوت التسجيل لتصدير الفيديو.";
    if (message.includes("No supported high-quality video encoder")) return "لم يتم العثور على ترميز فيديو عالي الجودة مدعوم في إصدار دسكورد الحالي.";
    if (message.includes("Video encoder failed")) return "حدث خطأ أثناء ترميز الفيديو.";
    if (message.includes("Audio playback failed during video export")) return "تعذر تشغيل الصوت أثناء تصدير الفيديو.";
    if (message.includes("Video export produced an empty file")) return "فشل تصدير الفيديو ونتج ملف فارغ.";
    if (message.includes("Could not create the video export file")) return "تعذر إنشاء ملف تصدير الفيديو.";
    if (message.includes("Could not write the video export file")) return "تعذر كتابة بيانات الفيديو أثناء التصدير.";
    if (message.includes("Voice Replay mixed input is unavailable")) return "تعذر الوصول إلى مسار مزج الصوت في Voice Replay.";
    if (message.includes("Voice Replay audio context is unavailable")) return "تعذر تهيئة محرك الصوت الخاص بـ Voice Replay.";
    if (message.includes("incoming-track isolation limit")) return "تم الوصول إلى الحد الأقصى للمسارات الصوتية المنفصلة في هذا التسجيل.";
    return message;
}

async function ensureSaveFolder(): Promise<string> {
    if (settings.store.saveFolder) return settings.store.saveFolder;
    const selected = await Native.chooseSaveFolder(tr("Choose recordings folder", "اختيار مجلد التسجيلات"));
    if (!selected) throw new Error(tr("Choose a recordings folder before saving.", "اختر مجلدًا للتسجيلات قبل الحفظ."));
    settings.store.saveFolder = selected;
    return selected;
}

async function chooseFolder() {
    const selected = await Native.chooseSaveFolder(tr("Choose recordings folder", "اختيار مجلد التسجيلات"));
    if (selected) {
        settings.store.saveFolder = selected;
        toast(tr("Recordings folder updated.", "تم تحديث مجلد تسجيلات."), Toasts.Type.SUCCESS);
    }
    return selected;
}

async function startRecorder(showStateToast = true) {
    const channelId = SelectedChannelStore.getVoiceChannelId() ?? null;
    try {
        await voiceRecorder.start({
            maxBufferSeconds: bufferCapacitySeconds(),
            includeMicrophone: settings.store.includeMicrophone !== false,
            microphoneDeviceId: MediaEngineStore.getInputDeviceId?.() ?? null,
            localUserId: UserStore.getCurrentUser()?.id ?? null,
            voiceConnected: Boolean(channelId)
        });
        void preloadDiscordRoomSounds(voiceRecorder.getStatus().sampleRate || 48_000);
        voiceActivityTracker.reset();
        voiceActivityTracker.start();
        lastVoiceChannelId = channelId;
        if (showStateToast) {
            const message = channelId
                ? tr("Voice Replay started.", "تم تشغيل Voice Replay.")
                : tr("Voice Replay is armed and will keep running until you stop it.", "Voice Replay جاهز وسيبقى شغالًا حتى توقفه بنفسك.");
            toast(message, Toasts.Type.SUCCESS);
        }
    } catch (error) {
        toast(localizedError(error), Toasts.Type.FAILURE);
    }
}

async function stopRecorder(showStateToast = true) {
    await voiceRecorder.stop(true);
    voiceActivityTracker.stop(true);
    if (showStateToast) {
        toast(tr("Voice Replay stopped.", "تم إيقاف Voice Replay."), Toasts.Type.MESSAGE);
    }
}

async function toggleRecorder() {
    if (voiceRecorder.getStatus().armed) await stopRecorder(true);
    else await startRecorder();
}

async function saveLatestClip(requestedSeconds: number) {
    if (saving) return;
    const status = voiceRecorder.getStatus();
    if (!status.armed) {
        toast(tr("Start Voice Replay before saving a clip.", "شغّل Voice Replay قبل حفظ التسجيل."), Toasts.Type.FAILURE);
        return;
    }
    if (status.bufferedSeconds < .1) {
        toast(tr("Voice Replay is on, but the rolling window has not started yet.", "Voice Replay شغال، لكن التسجيل المؤقت لم يبدأ بعد."), Toasts.Type.FAILURE);
        return;
    }

    const requested = Math.min(bufferCapacitySeconds(), Math.max(1, Math.floor(requestedSeconds)));
    if (status.bufferedSeconds + .02 < requested) {
        toast(tr(`Wait ${formatDuration(requested - status.bufferedSeconds)} more, exact ${formatDuration(requested)} saving requires a full ${formatDuration(requested)} buffer.`, `انتظر ${formatDuration(requested - status.bufferedSeconds)} إضافية، حفظ ${formatDuration(requested)} بالضبط يحتاج توفر المدة كاملة في التسجيل المؤقت.`), Toasts.Type.FAILURE);
        return;
    }
    saving = true;
    try {
        const folder = await ensureSaveFolder();
        const format = settings.store.format as RecordingFormat;
        const clip = voiceRecorder.prepareLatest(requested, format);
        const activity = voiceActivityTracker.makeMetadata(clip.clipStartedAt, clip.clipEndedAt);
        const roomCueCount = roomPresenceCues(activity.roomTimeline).length;
        const roomCueStem = buildRoomCueStem(activity.roomTimeline, clip.sampleRate, Math.round(clip.durationSeconds * clip.sampleRate));
        if (roomCueStem) {
            clip.samples = mixMonoOverlayIntoInterleaved(clip.samples, roomCueStem, clip.channels);
        }
        const encodedAudio = await encodePcmForFormat(clip.samples, clip.sampleRate, format, clip.channels);
        const roomCount = new Set((activity.roomTimeline ?? []).map((event: any) => event.channelId).filter(Boolean)).size;
        const channelName = safeFilenamePart(roomCount > 1 ? "multi-room" : activity.channelName ?? "voice-session");
        const baseName = `VoiceReplay_${channelName}_${timestampForFilename(new Date(clip.clipEndedAt))}_${Math.round(clip.durationSeconds)}s`;
        const audioName = `${baseName}.${clip.extension}`;
        const audioPath = await Native.saveBytes(folder, audioName, encodedAudio);

        const isolatedTrackUserIds: string[] = [];
        for (const stem of clip.stems) {
            try {
                const bytes = new Uint8Array(stem.samples.buffer, stem.samples.byteOffset, stem.samples.byteLength);
                const saved = await Native.saveRecordingStem(folder, audioName, stem.userId, bytes);
                if (saved) isolatedTrackUserIds.push(stem.userId);
            } catch {

            }
        }
        let hasResidualStem = false;
        if (clip.residualStem) {
            try {
                const bytes = new Uint8Array(clip.residualStem.buffer, clip.residualStem.byteOffset, clip.residualStem.byteLength);
                hasResidualStem = Boolean(await Native.saveRecordingStem(folder, audioName, RESIDUAL_STEM_ID, bytes));
            } catch {   }
        }
        let hasRoomEventStem = false;
        if (roomCueStem) {
            try {
                const bytes = new Uint8Array(roomCueStem.buffer, roomCueStem.byteOffset, roomCueStem.byteLength);
                hasRoomEventStem = Boolean(await Native.saveRecordingStem(folder, audioName, ROOM_EVENTS_STEM_ID, bytes));
            } catch {   }
        }

        const isolatedSet = new Set(isolatedTrackUserIds);
        if (Array.isArray(activity.participants)) {
            activity.participants = activity.participants.map((participant: any) => ({
                ...participant,
                isolatedAudio: isolatedSet.has(participant.userId)
            }));
        }

        const metadata: RecordingMetadata = {
            metadataVersion: 7,
            capturedAt: new Date(clip.clipEndedAt).toISOString(),
            recording: {
                format: clip.format.toUpperCase(),
                sampleRate: clip.sampleRate,
                channels: clip.channels,
                bitDepth: 16,
                durationSeconds: clip.durationSeconds,
                requestedDurationSeconds: requested,
                rollingBufferCapacitySeconds: bufferCapacitySeconds(),
                clipStartedAt: new Date(clip.clipStartedAt).toISOString(),
                clipEndedAt: new Date(clip.clipEndedAt).toISOString(),
                includedMicrophone: settings.store.includeMicrophone !== false,
                incomingCapture: "discord-process-loopback-with-renderer-fallback",
                isolatedTrackUserIds,
                hasResidualStem,
                hasRoomEventStem,
                joinLeaveCues: Boolean(roomCueStem),
                joinLeaveCueCount: roomCueCount,
                unmappedRemoteSources: clip.unmappedRemoteSources,
                audioPath,
                audioFilename: audioName
            },
            ...activity
        };
        await Native.indexRecording(audioPath, metadata);

        emitSaveFlash();
        toast(tr(`Saved the latest ${formatDuration(clip.durationSeconds)} as ${clip.format.toUpperCase()}.`, `تم حفظ آخر ${formatDuration(clip.durationSeconds)} بصيغة ${clip.format.toUpperCase()}.`), Toasts.Type.SUCCESS);
        return { audioPath };
    } catch (error) {
        toast(localizedError(error), Toasts.Type.FAILURE);
    } finally {
        saving = false;
    }
}

function availableSaveDurations(status = voiceRecorder.getStatus()) {
    if (!status.armed || status.bufferedSeconds < .1) return [];

    const durations = QUICK_SAVE_DURATIONS
        .filter(seconds => seconds <= status.maxBufferSeconds && status.bufferedSeconds + .02 >= seconds)
        .map(Number);
    const customMinutes = Math.floor(Number(settings.store.customSaveMinutes));
    const customSeconds = customMinutes >= 1 && customMinutes <= 60 ? customMinutes * 60 : 0;
    if (customSeconds > 0
        && customSeconds <= status.maxBufferSeconds
        && status.bufferedSeconds + .02 >= customSeconds) {
        durations.push(customSeconds);
    }

    return Array.from(new Set(durations)).sort((left, right) => left - right);
}

function openSaveDurationModal(durations: number[]) {
    openModal(modalProps => (
        <Modal
            {...modalProps}
            size="sm"
            title={tr("Choose recording duration", "اختيار مدة التسجيل")}
        >
            <div className="vc-vrb-duration-modal" dir={pluginLanguage() === "ar" ? "rtl" : "ltr"}>
                <p>{tr("Choose how much of the newest buffered audio to save.", "اختر المدة التي تريد حفظها من أحدث صوت في التسجيل المؤقت.")}</p>
                <div className="vc-vrb-duration-modal-options">
                    {durations.map(seconds => (
                        <button
                            key={seconds}
                            type="button"
                            className="vc-vrb-duration-modal-option"
                            onClick={() => {
                                modalProps.onClose();
                                void saveLatestClip(seconds);
                            }}
                        >
                            <span>{formatDuration(seconds)}</span>
                            <small>{tr("Ready to save", "جاهزة للحفظ")}</small>
                        </button>
                    ))}
                </div>
            </div>
        </Modal>
    ));
}

function requestReplaySave() {
    const status = voiceRecorder.getStatus();
    if (!status.armed) {
        toast(tr("Start Voice Replay before saving a clip.", "شغّل Voice Replay قبل حفظ التسجيل."), Toasts.Type.FAILURE);
        return;
    }

    const durations = availableSaveDurations(status);
    if (!durations.length) {
        const remaining = Math.max(0, 30 - status.bufferedSeconds);
        toast(tr(`Wait ${formatDuration(remaining)} before the first save.`, `انتظر ${formatDuration(remaining)} قبل أول حفظ.`), Toasts.Type.MESSAGE);
        return;
    }
    if (durations.length === 1) {
        void saveLatestClip(durations[0]);
        return;
    }

    openSaveDurationModal(durations);
}

function onVoiceChannelChanged() {
    const channelId = SelectedChannelStore.getVoiceChannelId() ?? null;
    if (channelId === lastVoiceChannelId) return;
    const previousChannelId = lastVoiceChannelId;
    lastVoiceChannelId = channelId;


    void voiceRecorder.setVoiceConnected(Boolean(channelId), MediaEngineStore.getInputDeviceId?.() ?? null);

    if (voiceRecorder.getStatus().armed) {



        if (previousChannelId && channelId && previousChannelId !== channelId) voiceRecorder.refreshVoiceRoom();
        return;
    }

    if (channelId && settings.store.autoStart) void startRecorder(false);
}

let capturingToggleShortcut = false;

function shortcutKeyFromEvent(event: KeyboardEvent) {
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;
    if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
    if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
    if (/^F(?:[1-9]|1[0-2])$/.test(event.code)) return event.code;
    if (event.code === "Space") return "Space";
    if (event.code === "Escape") return "Esc";
    if (event.code.startsWith("Arrow")) return event.code.replace("Arrow", "");
    return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

function shortcutFromEvent(event: KeyboardEvent) {
    const key = shortcutKeyFromEvent(event);
    if (!key) return null;
    const parts: string[] = [];
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("Meta");
    parts.push(key);
    return parts.join("+");
}

function shortcutMatches(event: KeyboardEvent, shortcut: string) {
    const actual = shortcutFromEvent(event);
    return Boolean(actual && actual.toLocaleLowerCase() === String(shortcut || "").replace(/\s+/g, "").toLocaleLowerCase());
}

function onKeyDown(event: KeyboardEvent) {
    if (event.repeat || capturingToggleShortcut) return;
    if (shortcutMatches(event, String(settings.store.toggleShortcut || "Ctrl+Shift+F7"))) {
        event.preventDefault();
        event.stopPropagation();
        requestReplaySave();
    }
}

function useRecorderStatus() {
    const [status, setStatus] = React.useState<RecorderStatus>(() => voiceRecorder.getStatus());
    React.useEffect(() => voiceRecorder.subscribe(setStatus), []);
    return status;
}

function useActivity() {
    const [snapshot, setSnapshot] = React.useState<ActivitySnapshot>(() => voiceActivityTracker.getSnapshot());
    React.useEffect(() => {
        const unsubscribe = voiceActivityTracker.subscribe(setSnapshot);
        return () => { unsubscribe(); };
    }, []);
    return snapshot;
}

function useSaveFlash() {
    const [, rerender] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => {
        const fn = () => rerender();
        saveFlashListeners.add(fn);
        return () => { saveFlashListeners.delete(fn); };
    }, []);
    return Date.now() < saveFlashUntil;
}

const ACTIVE_IDLE_BARS = [3.8, 5.2, 6.8, 8.2, 6.8, 5.2, 3.8];
const ACTIVE_MAX_BARS = [12.2, 16.8, 21.0, 23.0, 21.0, 16.8, 12.2];
const BAR_SENSITIVITY = [.72, .88, 1.02, 1.12, 1.02, .88, .72];






function useAudioWaveBars(realBands: number[], liveLevel: number, active: boolean, animate: boolean) {
    const targetRef = React.useRef<number[]>([...ACTIVE_IDLE_BARS]);
    const barsRef = React.useRef<number[]>([...ACTIVE_IDLE_BARS]);
    const [bars, setBars] = React.useState(() => [...ACTIVE_IDLE_BARS]);

    React.useEffect(() => {
        if (!active || !animate) {
            targetRef.current = [...ACTIVE_IDLE_BARS];
            return;
        }

        const source = realBands.length === 7 ? realBands : Array(7).fill(liveLevel);
        targetRef.current = ACTIVE_IDLE_BARS.map((idle, index) => {
            const raw = Math.min(1, Math.max(0, Number(source[index] ?? liveLevel)) * BAR_SENSITIVITY[index]);
            if (raw < .004) return idle;
            const perceptual = Math.pow(raw, .50);
            return idle + (ACTIVE_MAX_BARS[index] - idle) * perceptual;
        });
    }, [realBands, liveLevel, active, animate]);

    React.useEffect(() => {
        if (!active || !animate) {
            barsRef.current = [...ACTIVE_IDLE_BARS];
            setBars([...ACTIVE_IDLE_BARS]);
            return;
        }

        let frame = 0;
        let last = performance.now();
        const tick = (now: number) => {
            const dt = Math.min(.032, Math.max(.001, (now - last) / 1000));
            last = now;
            const next = barsRef.current.map((value, index) => {
                const target = targetRef.current[index] ?? ACTIVE_IDLE_BARS[index];


                const tau = target > value ? .026 : .085;
                const alpha = 1 - Math.exp(-dt / tau);
                const nextValue = value + (target - value) * alpha;
                return Math.abs(target - nextValue) < .018 ? target : nextValue;
            });
            barsRef.current = next;
            setBars([...next]);
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [active, animate]);

    return bars;
}

function useMorphProgress(active: boolean) {
    const [progress, setProgress] = React.useState(active ? 1 : 0);
    const progressRef = React.useRef(active ? 1 : 0);
    const targetRef = React.useRef(active ? 1 : 0);

    React.useEffect(() => {
        targetRef.current = active ? 1 : 0;
        let frame = 0;
        let last = performance.now();

        const tick = (now: number) => {
            const dt = Math.min(0.032, Math.max(0.001, (now - last) / 1000));
            last = now;
            const target = targetRef.current;
            const current = progressRef.current;


            const response = target > current ? 13.5 : 11.5;
            const next = target + (current - target) * Math.exp(-response * dt);
            progressRef.current = Math.abs(target - next) < 0.001 ? target : next;
            setProgress(progressRef.current);
            if (progressRef.current !== target) frame = requestAnimationFrame(tick);
        };

        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [active]);

    return progress;
}

function smoothStep(value: number) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
}

function WaveformIcon({
    active,
    liveLevel,
    waveBands,
    saved
}: {
    active: boolean;
    liveLevel: number;
    waveBands: number[];
    saved: boolean;
}) {
    const bars = useAudioWaveBars(waveBands, liveLevel, active, true);
    const morph = useMorphProgress(active);
    const eased = smoothStep(morph);



    const offHeights = [3.6, 5.2, 7.2, 9.4, 7.2, 5.2, 3.6];

    const xs = [7.4, 10.6, 13.8, 17, 20.2, 23.4, 26.6];

    return (
        <svg className={`vc-vrb-waveform ${active ? "vc-vrb-waveform-on" : "vc-vrb-waveform-off"} ${saved ? "vc-vrb-waveform-saved" : ""}`} viewBox="0 0 34 30" width="30" height="26" aria-hidden="true">
            <path
                className="vc-vrb-hex-shell"
                d="M17 2.4 29 9.2v11.6L17 27.6 5 20.8V9.2Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.35"
                strokeLinejoin="round"
                style={{
                    opacity: .88 - eased * .42,
                    strokeDasharray: 84,
                    strokeDashoffset: (1 - eased) * 2.8,
                    transform: `scale(${.965 + eased * .035})`,
                    transformOrigin: "17px 15px"
                }}
            />

            <g className="vc-vrb-morph-bars">
                {bars.map((height, index) => {
                    const localDelay = Math.abs(index - 3) * .014;
                    const local = smoothStep((eased - localDelay) / Math.max(.001, 1 - localDelay));
                    const activeHeight = Math.min(20.2, Math.max(3.2, height * .98));
                    const h = offHeights[index] + (activeHeight - offHeights[index]) * local;
                    const width = 1.78 + .56 * local;
                    return (
                        <rect
                            key={index}
                            x={xs[index] - width / 2}
                            y={15 - h / 2}
                            width={width}
                            height={h}
                            rx={width / 2}
                            fill="currentColor"
                            opacity={.78 + .22 * local}
                        />
                    );
                })}
            </g>

            <g className="vc-vrb-save-check">
                <path d="M8 15.2 13.2 20 26 9.1" fill="none" stroke="currentColor" strokeWidth="2.55" strokeLinecap="round" strokeLinejoin="round" />
            </g>
        </svg>
    );
}
function recordingDuration(recording: SavedRecording) {
    const metaDuration = Number(recording.metadata?.recording?.durationSeconds);
    return Number.isFinite(metaDuration) ? metaDuration : 0;
}

function recordingTitle(recording: SavedRecording) {
    return recording.metadata?.customTitle?.trim() || recording.metadata?.channelName || recording.audioFilename.replace(/^VoiceReplay_/, "").replace(/\.(flac|wav)$/i, "");
}

function activeSpeakerIds(metadata: RecordingMetadata | null, time: number) {
    const set = new Set<string>();
    for (const segment of metadata?.speakingTimeline ?? []) {
        if (time >= Number(segment.offsetStartSeconds) && time <= Number(segment.offsetEndSeconds)) set.add(segment.userId);
    }
    return set;
}

function CopyIcon() {
    return (
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path fill="currentColor" d="M8 7.5A2.5 2.5 0 0 1 10.5 5h7A2.5 2.5 0 0 1 20 7.5v7a2.5 2.5 0 0 1-2.5 2.5H16v-2h1.5a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5V9H8V7.5Z" />
            <path fill="currentColor" d="M4 11.5A2.5 2.5 0 0 1 6.5 9h7a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 18.5v-7Zm2.5-.5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7Z" />
        </svg>
    );
}

function VideoSaveGlyph() {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M12 3.5v10.25m0 0 4-4m-4 4-4-4" fill="none" stroke="currentColor" strokeWidth="2.15" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M5 14.75v2.5A2.75 2.75 0 0 0 7.75 20h8.5A2.75 2.75 0 0 0 19 17.25v-2.5" fill="none" stroke="currentColor" strokeWidth="2.15" strokeLinecap="round" />
        </svg>
    );
}

function EditRecordingGlyph() {
    return (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path fill="currentColor" d="M16.86 3.49a2.05 2.05 0 0 1 2.9 0l.75.75a2.05 2.05 0 0 1 0 2.9L9.22 18.43a1 1 0 0 1-.48.27l-4.55 1.14 1.14-4.55a1 1 0 0 1 .27-.48L16.86 3.49Zm1.45 1.42-11.1 11.1-.36 1.44 1.44-.36 11.1-11.1a.05.05 0 0 0 0-.07l-.75-.75a.05.05 0 0 0-.07 0l-.26-.26Z" />
        </svg>
    );
}

function TrashGlyph({ size = 14 }: { size?: number; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
            <path fill="currentColor" d="M8.5 3.5h7l.8 2H20a1 1 0 1 1 0 2h-1l-.72 11.02A2.7 2.7 0 0 1 15.59 21H8.41a2.7 2.7 0 0 1-2.69-2.48L5 7.5H4a1 1 0 1 1 0-2h3.7l.8-2Zm1.36 2h4.28l-.4-1H10.26l-.4 1ZM7 7.5l.7 10.89a.7.7 0 0 0 .7.61h7.18a.7.7 0 0 0 .7-.61L17 7.5H7Zm3 2.1a1 1 0 0 1 1 1v5.8a1 1 0 1 1-2 0v-5.8a1 1 0 0 1 1-1Zm4 0a1 1 0 0 1 1 1v5.8a1 1 0 1 1-2 0v-5.8a1 1 0 0 1 1-1Z" />
        </svg>
    );
}

function roomEventAt(metadata: RecordingMetadata | null, time: number): RecordingRoomEvent | null {
    const events = metadata?.roomTimeline ?? [];
    let current: RecordingRoomEvent | null = null;
    for (const event of events) {
        if (Number(event.offsetSeconds) <= time + .015) current = event;
        else break;
    }
    return current;
}


type ExportAvatarAssets = {
    images: Map<string, HTMLImageElement>;
    objectUrls: string[];
};

function resolvedThemeColor(variable: string, fallback: string) {
    try {
        const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
        return value || fallback;
    } catch {
        return fallback;
    }
}

function canvasRoundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
}

async function loadExportAvatarAssets(metadata: RecordingMetadata | null): Promise<ExportAvatarAssets> {
    const images = new Map<string, HTMLImageElement>();
    const objectUrls: string[] = [];
    await Promise.all((metadata?.participants ?? []).map(async participant => {
        if (!participant.avatarUrl) return;
        try {
            const response = await fetch(participant.avatarUrl);
            if (!response.ok) return;
            const objectUrl = URL.createObjectURL(await response.blob());
            objectUrls.push(objectUrl);
            const image = new Image();
            image.src = objectUrl;
            if (typeof image.decode === "function") await image.decode();
            else await new Promise<void>((resolve, reject) => {
                image.onload = () => resolve();
                image.onerror = () => reject(new Error("Avatar load failed"));
            });
            images.set(participant.userId, image);
        } catch {   }
    }));
    return { images, objectUrls };
}

function drawVideoMicState(context: CanvasRenderingContext2D, x: number, y: number, muted: boolean, color: string) {
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 4;
    context.lineCap = "round";
    context.beginPath();
    context.roundRect?.(x - 7, y - 13, 14, 22, 7);
    if (!context.roundRect) {
        context.moveTo(x - 7, y - 6);
        context.arc(x, y - 6, 7, Math.PI, 0);
        context.lineTo(x + 7, y + 2);
        context.arc(x, y + 2, 7, 0, Math.PI);
        context.closePath();
    }
    context.stroke();
    context.beginPath();
    context.arc(x, y - 1, 13, 0, Math.PI, false);
    context.stroke();
    context.beginPath();
    context.moveTo(x, y + 12);
    context.lineTo(x, y + 20);
    context.moveTo(x - 8, y + 20);
    context.lineTo(x + 8, y + 20);
    context.stroke();
    if (muted) {
        context.lineWidth = 5;
        context.beginPath();
        context.moveTo(x - 17, y - 18);
        context.lineTo(x + 17, y + 18);
        context.stroke();
    }
    context.restore();
}

function drawVideoDeafenState(context: CanvasRenderingContext2D, x: number, y: number, deafened: boolean, color: string) {
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 4;
    context.lineCap = "round";
    context.beginPath();
    context.arc(x, y, 15, Math.PI, 0);
    context.stroke();
    context.beginPath();
    context.moveTo(x - 15, y);
    context.lineTo(x - 15, y + 14);
    context.moveTo(x + 15, y);
    context.lineTo(x + 15, y + 14);
    context.stroke();
    if (deafened) {
        context.lineWidth = 5;
        context.beginPath();
        context.moveTo(x - 19, y - 18);
        context.lineTo(x + 19, y + 18);
        context.stroke();
    }
    context.restore();
}

function drawReplayVideoFrame(
    context: CanvasRenderingContext2D,
    recording: SavedRecording,
    time: number,
    avatars: Map<string, HTMLImageElement>,
    width: number,
    height: number
) {
    const metadata = recording.metadata;
    const event = roomEventAt(metadata, time);
    const speaking = activeSpeakerIds(metadata, time);
    const participantDirectory = new Map((metadata?.participants ?? []).map(participant => [participant.userId, participant]));
    const states = event?.participants ?? [];

    const background = resolvedThemeColor("--background-base-lowest", "#111214");
    const panel = resolvedThemeColor("--background-base-low", "#2b2d31");
    const rowHover = resolvedThemeColor("--background-mod-subtle", "#35373c");
    const text = resolvedThemeColor("--text-default", "#dbdee1");
    const mutedText = resolvedThemeColor("--text-muted", "#949ba4");
    const positive = resolvedThemeColor("--status-positive", "#23a55a");
    const separator = resolvedThemeColor("--border-subtle", "rgba(255,255,255,.08)");

    context.clearRect(0, 0, width, height);
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    try { context.imageSmoothingQuality = "high"; } catch {   }



    const panelWidth = 650;
    const rowHeight = states.length > 12 ? 52 : 62;
    const maxRows = Math.max(1, Math.min(15, Math.floor((height - 250) / rowHeight)));
    const visibleStates = states.slice(0, maxRows);
    const headerHeight = 86;
    const footerHeight = event?.channelId ? 58 : 0;
    const overflowHeight = states.length > maxRows ? 42 : 0;
    const bodyHeight = event?.channelId ? Math.max(82, visibleStates.length * rowHeight + overflowHeight) : 160;
    const panelHeight = headerHeight + bodyHeight + footerHeight;
    const panelX = Math.round((width - panelWidth) / 2);
    const panelY = Math.round((height - panelHeight) / 2);

    context.fillStyle = panel;
    canvasRoundedRect(context, panelX, panelY, panelWidth, panelHeight, 18);
    context.fill();

    const headerMidY = panelY + headerHeight / 2;
    const iconX = panelX + 38;
    context.fillStyle = event?.channelId ? positive : mutedText;
    context.beginPath();
    context.arc(iconX, headerMidY, 19, 0, Math.PI * 2);
    context.fill();

    context.save();
    context.strokeStyle = panel;
    context.lineWidth = 4;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(iconX - 8, headerMidY - 4);
    context.lineTo(iconX - 8, headerMidY + 4);
    context.stroke();
    for (const r of [7, 12]) {
        context.beginPath();
        context.arc(iconX - 4, headerMidY, r, -.82, .82);
        context.stroke();
    }
    context.restore();

    const channelTitle = event?.channelId
        ? event.channelName ?? metadata?.channelName ?? tr("Voice channel", "الروم الصوتي")
        : tr("Outside voice", "خارج الروم الصوتي");
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillStyle = text;
    context.font = "700 27px 'gg sans', Arial, sans-serif";
    context.fillText(channelTitle, panelX + 76, panelY + 33);
    context.fillStyle = mutedText;
    context.font = "500 18px 'gg sans', Arial, sans-serif";
    const guildLabel = event?.guildName ?? metadata?.guildName ?? tr("Discord Voice", "Discord Voice");
    context.fillText(guildLabel, panelX + 76, panelY + 60);

    context.textAlign = "right";
    context.fillStyle = event?.channelId ? positive : mutedText;
    context.font = "650 20px 'gg sans', Arial, sans-serif";
    context.fillText(`${formatClock(time)} / ${formatClock(recordingDuration(recording))}`, panelX + panelWidth - 28, headerMidY);

    context.fillStyle = separator;
    context.fillRect(panelX + 18, panelY + headerHeight - 1, panelWidth - 36, 1);

    if (!event?.channelId) {
        context.textAlign = "center";
        context.fillStyle = mutedText;
        context.font = "600 23px 'gg sans', Arial, sans-serif";
        context.fillText(tr("Not connected to a voice room at this moment", "غير متصل بروم صوتي في هذه اللحظة"), width / 2, panelY + headerHeight + 78);
    } else {
        const memberStartY = panelY + headerHeight;
        for (let index = 0; index < visibleStates.length; index++) {
            const state = visibleStates[index];
            const participant = participantDirectory.get(state.userId);
            const displayName = state.displayName ?? participant?.displayName ?? state.userId;
            const y = memberStartY + index * rowHeight;
            const centerY = y + rowHeight / 2;
            const isSpeaking = speaking.has(state.userId);
            const muted = Boolean(state.muted || state.selfMute || state.serverMute);
            const deafened = Boolean(state.deafened || state.selfDeaf || state.serverDeaf);

            if (isSpeaking) {
                context.fillStyle = rowHover;
                canvasRoundedRect(context, panelX + 12, y + 4, panelWidth - 24, rowHeight - 8, 10);
                context.fill();
            }

            const avatarX = panelX + 54;
            const avatarRadius = rowHeight <= 54 ? 18 : 21;
            if (isSpeaking) {
                context.strokeStyle = positive;
                context.lineWidth = 4;
                context.beginPath();
                context.arc(avatarX, centerY, avatarRadius + 4, 0, Math.PI * 2);
                context.stroke();
            }

            const image = avatars.get(state.userId);
            context.save();
            context.beginPath();
            context.arc(avatarX, centerY, avatarRadius, 0, Math.PI * 2);
            context.clip();
            if (image) context.drawImage(image, avatarX - avatarRadius, centerY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
            else {
                context.fillStyle = resolvedThemeColor("--brand-500", "#5865f2");
                context.fillRect(avatarX - avatarRadius, centerY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
                context.fillStyle = "#fff";
                context.font = `700 ${Math.max(15, avatarRadius)}px Arial, sans-serif`;
                context.textAlign = "center";
                context.textBaseline = "middle";
                context.fillText(displayName.slice(0, 1).toUpperCase(), avatarX, centerY + 1);
            }
            context.restore();

            context.textAlign = "left";
            context.textBaseline = "middle";
            context.fillStyle = isSpeaking ? positive : text;
            context.font = `600 ${rowHeight <= 54 ? 20 : 22}px 'gg sans', Arial, sans-serif`;
            context.fillText(displayName, panelX + 92, centerY);



            drawVideoMicState(context, panelX + panelWidth - 88, centerY, muted, muted ? mutedText : text);
            drawVideoDeafenState(context, panelX + panelWidth - 36, centerY, deafened, deafened ? mutedText : text);

            if (index < visibleStates.length - 1) {
                context.fillStyle = separator;
                context.fillRect(panelX + 92, y + rowHeight - 1, panelWidth - 118, 1);
            }
        }

        if (!states.length) {
            context.textAlign = "center";
            context.fillStyle = mutedText;
            context.font = "500 19px 'gg sans', Arial, sans-serif";
            context.fillText(tr("No members in the recorded room at this moment", "لا يوجد أعضاء في الروم في هذه اللحظة"), width / 2, memberStartY + 41);
        }

        let footerY = memberStartY + Math.max(82, visibleStates.length * rowHeight + overflowHeight);
        if (states.length > maxRows) {
            context.textAlign = "left";
            context.fillStyle = mutedText;
            context.font = "500 17px 'gg sans', Arial, sans-serif";
            context.fillText(tr(`+${states.length - maxRows} more members`, `+${states.length - maxRows} أعضاء آخرين`), panelX + 92, footerY + 21);
        }

        context.fillStyle = separator;
        context.fillRect(panelX + 18, footerY, panelWidth - 36, 1);
        context.textAlign = "left";
        context.fillStyle = mutedText;
        context.font = "500 19px 'gg sans', Arial, sans-serif";
        context.fillText(tr("Invite to Voice", "دعوة إلى الروم الصوتي"), panelX + 74, footerY + 30);
        context.font = "600 27px 'gg sans', Arial, sans-serif";
        context.fillText("+", panelX + 38, footerY + 30);
        context.textAlign = "right";
        context.font = "600 27px 'gg sans', Arial, sans-serif";
        context.fillText("›", panelX + panelWidth - 28, footerY + 30);
    }


    const progressX = panelX + 18;
    const progressY = panelY + panelHeight - 4;
    const progressWidth = panelWidth - 36;
    const fraction = recordingDuration(recording) > 0 ? Math.min(1, Math.max(0, time / recordingDuration(recording))) : 0;
    context.fillStyle = positive;
    canvasRoundedRect(context, progressX, progressY, progressWidth * fraction, 3, 2);
    context.fill();
}

type VideoExportPhase = "idle" | "exporting" | "done" | "error";
type VideoExportSnapshot = {
    phase: VideoExportPhase;
    progress: number;
    recordingId: string | null;
    outputPath: string | null;
};

type VideoExportListener = (snapshot: VideoExportSnapshot) => void;
const videoExportListeners = new Set<VideoExportListener>();
let videoExportSnapshot: VideoExportSnapshot = { phase: "idle", progress: 0, recordingId: null, outputPath: null };
let videoExportResetTimer: number | null = null;
let videoExportPromise: Promise<string | null> | null = null;

function setVideoExportSnapshot(next: Partial<VideoExportSnapshot>) {
    videoExportSnapshot = { ...videoExportSnapshot, ...next };
    for (const listener of videoExportListeners) listener({ ...videoExportSnapshot });
}

function subscribeVideoExport(listener: VideoExportListener) {
    videoExportListeners.add(listener);
    listener({ ...videoExportSnapshot });
    return () => { videoExportListeners.delete(listener); };
}

function useVideoExportStatus() {
    const [snapshot, setSnapshot] = React.useState<VideoExportSnapshot>(() => ({ ...videoExportSnapshot }));
    React.useEffect(() => subscribeVideoExport(setSnapshot), []);
    return snapshot;
}

function scheduleVideoExportReset(delay = 1200) {
    if (videoExportResetTimer != null) window.clearTimeout(videoExportResetTimer);
    videoExportResetTimer = window.setTimeout(() => {
        videoExportResetTimer = null;
        setVideoExportSnapshot({ phase: "idle", progress: 0, recordingId: null, outputPath: null });
    }, delay);
}

async function exportRecordingVideo(recording: SavedRecording, onProgress: (progress: number) => void) {
    if (typeof MediaRecorder === "undefined") throw new Error("Video export is unavailable in this Discord build.");
    const folder = settings.store.saveFolder;
    if (!folder) throw new Error("Choose a recordings folder before exporting video.");
    const bytes = await Native.readRecordingBytes(folder, recording.audioFilename) as Uint8Array | null;
    if (!bytes) throw new Error("Could not read this recording for video export.");

    const canvas = document.createElement("canvas");
    canvas.width = 1920;
    canvas.height = 1080;
    const drawing = canvas.getContext("2d", { alpha: false });
    if (!drawing || typeof canvas.captureStream !== "function") throw new Error("Video export is unavailable in this Discord build.");

    const avatars = await loadExportAvatarAssets(recording.metadata);
    const AudioContextConstructor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext; }).webkitAudioContext;
    if (!AudioContextConstructor) {
        avatars.objectUrls.forEach(url => URL.revokeObjectURL(url));
        throw new Error("Video export audio is unavailable in this Discord build.");
    }

    let audioContext: AudioContext | null = null;
    let videoStream: MediaStream | null = null;
    let audioSource: AudioBufferSourceNode | null = null;
    let recorder: MediaRecorder | null = null;
    let frame = 0;
    let exportFilename: string | null = null;
    let exportFileStarted = false;
    let exportCompleted = false;
    let writeChain: Promise<void> = Promise.resolve();

    try {
        audioContext = new AudioContextConstructor({ latencyHint: "playback" });
        const encodedAudio = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        let decodedAudio: AudioBuffer;
        try {
            decodedAudio = await audioContext.decodeAudioData(encodedAudio);
        } catch {
            throw new Error("Could not decode this recording for video export.");
        }

        const effectiveDuration = Number.isFinite(decodedAudio.duration) && decodedAudio.duration > 0
            ? decodedAudio.duration
            : recordingDuration(recording);
        const destination = audioContext.createMediaStreamDestination();
        const silentMonitor = audioContext.createGain();
        silentMonitor.gain.value = 0;
        silentMonitor.connect(audioContext.destination);

        audioSource = audioContext.createBufferSource();
        audioSource.buffer = decodedAudio;
        audioSource.connect(destination);

        audioSource.connect(silentMonitor);

        drawReplayVideoFrame(drawing, recording, 0, avatars.images, canvas.width, canvas.height);
        videoStream = canvas.captureStream(30);
        for (const track of destination.stream.getAudioTracks()) videoStream.addTrack(track);



        const candidates = [
            { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4" },
            { mimeType: "video/mp4", extension: "mp4" },
            { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
            { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
            { mimeType: "video/webm", extension: "webm" }
        ].filter(candidate => !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(candidate.mimeType));
        if (!candidates.length) throw new Error("No supported high-quality video encoder was found.");

        let chosen = candidates[0];
        for (const candidate of candidates) {
            try {
                recorder = new MediaRecorder(videoStream, {
                    mimeType: candidate.mimeType,
                    videoBitsPerSecond: 12_000_000,
                    audioBitsPerSecond: 256_000
                });
                chosen = candidate;
                break;
            } catch {   }
        }
        if (!recorder) throw new Error("No supported high-quality video encoder was found.");

        const base = safeFilenamePart(recordingTitle(recording));
        exportFilename = `VoiceReplay_${base}_video_${timestampForFilename(new Date())}.${chosen.extension}`;
        const startedPath = await Native.beginVideoExport(folder, exportFilename);
        if (!startedPath) throw new Error("Could not create the video export file.");
        exportFileStarted = true;

        recorder.ondataavailable = event => {
            if (!event.data.size || !exportFilename) return;
            const chunk = event.data;
            writeChain = writeChain.then(async () => {
                const chunkBytes = new Uint8Array(await chunk.arrayBuffer());
                const written = await Native.appendVideoExportChunk(folder, exportFilename!, chunkBytes);
                if (!written) throw new Error("Could not write the video export file.");
            });
        };

        let rejectRecorderFailure: ((reason?: any) => void) | null = null;
        const recorderFailure = new Promise<never>((_, reject) => { rejectRecorderFailure = reject; });
        const stopped = new Promise<void>((resolve, reject) => {
            recorder!.onstop = () => resolve();
            recorder!.onerror = () => {
                const error = new Error("Video encoder failed while exporting.");
                rejectRecorderFailure?.(error);
                reject(error);
            };
        });

        let startTime = 0;
        const drawLoop = () => {
            if (!audioContext) return;
            const now = Math.max(0, Math.min(effectiveDuration || 0, audioContext.currentTime - startTime));
            drawReplayVideoFrame(drawing, recording, now, avatars.images, canvas.width, canvas.height);
            onProgress(effectiveDuration > 0 ? now / effectiveDuration : 0);
            if (now < effectiveDuration - .005) frame = requestAnimationFrame(drawLoop);
        };

        recorder.start(750);
        if (audioContext.state === "suspended") {
            try { await audioContext.resume(); } catch { throw new Error("Video export audio is unavailable in this Discord build."); }
        }

        await new Promise(resolve => window.setTimeout(resolve, 70));
        startTime = audioContext.currentTime + .035;
        const ended = new Promise<void>(resolve => { audioSource!.onended = () => resolve(); });
        audioSource.start(startTime);
        frame = requestAnimationFrame(drawLoop);
        await Promise.race([ended, recorderFailure]);

        cancelAnimationFrame(frame);
        drawReplayVideoFrame(drawing, recording, effectiveDuration, avatars.images, canvas.width, canvas.height);
        onProgress(1);
        await new Promise(resolve => window.setTimeout(resolve, 120));
        if (recorder.state !== "inactive") recorder.stop();
        await stopped;
        await writeChain;

        const outputPath = await Native.finishVideoExport(folder, exportFilename);
        if (!outputPath) throw new Error("Video export produced an empty file.");
        exportCompleted = true;
        return outputPath as string;
    } finally {
        cancelAnimationFrame(frame);
        try { if (audioSource) audioSource.stop(); } catch {   }
        try { if (recorder && recorder.state !== "inactive") recorder.stop(); } catch {   }
        for (const track of videoStream?.getTracks() ?? []) track.stop();
        if (audioContext && audioContext.state !== "closed") await audioContext.close().catch(() => void 0);
        avatars.objectUrls.forEach(url => URL.revokeObjectURL(url));
        if (exportFileStarted && !exportCompleted && exportFilename) {
            await Native.abortVideoExport(folder, exportFilename).catch(() => void 0);
        }
    }
}

function startManagedVideoExport(recording: SavedRecording) {
    if (videoExportPromise || videoExportSnapshot.phase === "exporting") {
        toast(tr("A replay video is already being exported.", "يوجد فيديو تسجيل قيد التصدير بالفعل."), Toasts.Type.MESSAGE);
        return videoExportPromise;
    }
    if (videoExportResetTimer != null) {
        window.clearTimeout(videoExportResetTimer);
        videoExportResetTimer = null;
    }
    setVideoExportSnapshot({ phase: "exporting", progress: 0, recordingId: recording.id, outputPath: null });
    let lastProgress = 0;
    videoExportPromise = exportRecordingVideo(recording, progress => {
        const normalized = Math.max(lastProgress, Math.min(1, Math.max(0, Number(progress) || 0)));
        lastProgress = normalized;
        setVideoExportSnapshot({ phase: "exporting", progress: normalized, recordingId: recording.id });
    }).then(path => {
        setVideoExportSnapshot({ phase: "done", progress: 1, recordingId: recording.id, outputPath: path });
        toast(tr("High-quality replay video exported.", "تم تصدير فيديو التسجيل بجودة عالية."), Toasts.Type.SUCCESS);
        scheduleVideoExportReset(1400);
        return path;
    }).catch(error => {
        setVideoExportSnapshot({ phase: "error", progress: lastProgress, recordingId: recording.id, outputPath: null });
        toast(localizedError(error), Toasts.Type.FAILURE);
        scheduleVideoExportReset(2200);
        return null;
    }).finally(() => {
        videoExportPromise = null;
    });
    return videoExportPromise;
}

function SelfMutedGlyph() {
    return (
        <svg className="vc-vrb-room-state-icon vc-vrb-room-state-self" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="m2.7 22.7 20-20a1 1 0 0 0-1.4-1.4l-20 20a1 1 0 1 0 1.4 1.4ZM10.8 17.32c-.21.21-.1.58.2.62V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.06A8 8 0 0 0 20 10a1 1 0 0 0-2 0c0 1.45-.52 2.79-1.38 3.83l-.02.02A5.99 5.99 0 0 1 12.32 16a.52.52 0 0 0-.34.15l-1.18 1.18ZM15.36 4.52c.15-.15.19-.38.08-.56A4 4 0 0 0 8 6v4c0 .3.03.58.1.86.07.34.49.43.74.18l6.52-6.52ZM5.06 13.98c.16.28.53.31.75.09l.75-.75c.16-.16.19-.4.08-.61A5.97 5.97 0 0 1 6 10a1 1 0 0 0-2 0c0 1.45.39 2.81 1.06 3.98Z" />
        </svg>
    );
}

function BlockedMuteGlyph({ server = false }: { server?: boolean; }) {
    return (
        <svg className={`vc-vrb-room-state-icon ${server ? "vc-vrb-room-state-server" : "vc-vrb-room-state-local"}`} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" fillRule="evenodd" d="M21.76.83a5.02 5.02 0 0 1 .78 7.7 5 5 0 0 1-7.07 0 5.02 5.02 0 0 1 0-7.07 5 5 0 0 1 6.29-.63Zm-4.88 2.05a3 3 0 0 1 3.41-.59l-4 4a3 3 0 0 1 .59-3.41Zm4.83.83-4 4a3 3 0 0 0 4-4Z" clipRule="evenodd" />
            <path fill="currentColor" d="M12 2c.33 0 .51.35.4.66a6.99 6.99 0 0 0 3.04 8.37c.2.12.31.37.21.6A4 4 0 0 1 8 10V6a4 4 0 0 1 4-4Z" />
            <path fill="currentColor" d="M17.55 12.29c.1-.23.33-.37.58-.34.29.03.58.05.87.05h.04c.35 0 .63.32.51.65A8 8 0 0 1 13 17.94V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.06A8 8 0 0 1 4 10a1 1 0 0 1 2 0 6 6 0 0 0 11.55 2.29Z" />
        </svg>
    );
}

function SelfDeafenedGlyph() {
    return (
        <svg className="vc-vrb-room-state-icon vc-vrb-room-state-self" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M22.7 2.7a1 1 0 0 0-1.4-1.4l-20 20a1 1 0 1 0 1.4 1.4l20-20ZM17.06 2.94a.48.48 0 0 0-.11-.77A11 11 0 0 0 2.18 16.94c.14.3.53.35.76.12l3.2-3.2c.25-.25.15-.68-.2-.76a5 5 0 0 0-1.02-.1H3.05a9 9 0 0 1 12.66-9.2c.2.09.44.05.59-.1l.76-.76ZM20.2 8.28a.52.52 0 0 1 .1-.58l.76-.76a.48.48 0 0 1 .77.11 11 11 0 0 1-4.5 14.57c-1.27.71-2.73.23-3.55-.74a3.1 3.1 0 0 1-.17-3.78l1.38-1.97a5 5 0 0 1 4.1-2.13h1.86a9.1 9.1 0 0 0-.75-4.72ZM10.1 17.9c.25-.25.65-.18.74.14a3.1 3.1 0 0 1-.62 2.84 2.85 2.85 0 0 1-3.55.74.16.16 0 0 1-.04-.25l3.48-3.48Z" />
        </svg>
    );
}

function ServerDeafenedGlyph() {
    return (
        <svg className="vc-vrb-room-state-icon vc-vrb-room-state-server" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" fillRule="evenodd" d="M21.76.83a5.02 5.02 0 0 1 .78 7.7 5 5 0 0 1-7.07 0 5.02 5.02 0 0 1 0-7.07 5 5 0 0 1 6.29-.63Zm-4.88 2.05a3 3 0 0 1 3.41-.59l-4 4a3 3 0 0 1 .59-3.41Zm4.83.83-4 4a3 3 0 0 0 4-4Z" clipRule="evenodd" />
            <path fill="currentColor" d="M12.38 1c.38.02.58.45.4.78-.15.3-.3.62-.4.95A.4.4 0 0 1 12 3a9 9 0 0 0-8.95 10h1.87a5 5 0 0 1 4.1 2.13l1.37 1.97a3.1 3.1 0 0 1-.17 3.78 2.85 2.85 0 0 1-3.55.74 11 11 0 0 1 5.71-20.61ZM22.22 11.22c.34-.18.76.02.77.4L23 12a11 11 0 0 1-5.67 9.62c-1.27.71-2.73.23-3.55-.74a3.1 3.1 0 0 1-.17-3.78l1.38-1.97a5 5 0 0 1 4.1-2.13h1.86c.03-.33.05-.66.05-1a.4.4 0 0 1 .27-.38c.33-.1.65-.25.95-.4Z" />
        </svg>
    );
}

function PlaybackMuteGlyph({ muted }: { muted: boolean; }) {
    return muted ? <SelfMutedGlyph /> : (
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 14.5A2.5 2.5 0 0 0 14.5 12V6a2.5 2.5 0 1 0-5 0v6a2.5 2.5 0 0 0 2.5 2.5ZM6 11v1a6 6 0 0 0 5 5.92V21h2v-3.08A6 6 0 0 0 18 12v-1h-2v1a4 4 0 0 1-8 0v-1H6Z" /></svg>
    );
}

function PlaybackRoomReplay({
    metadata,
    currentTime,
    mutedUsers,
    availableStemIds,
    videoExportPhase,
    videoExportProgress,
    videoExportDisabled,
    onExportVideo,
    onToggleMute
}: {
    metadata: RecordingMetadata | null;
    currentTime: number;
    mutedUsers: Set<string>;
    availableStemIds: Set<string>;
    videoExportPhase: VideoExportPhase;
    videoExportProgress: number;
    videoExportDisabled: boolean;
    onExportVideo(): void;
    onToggleMute(userId: string): void;
}) {
    const speakingNow = activeSpeakerIds(metadata, currentTime);
    const event = roomEventAt(metadata, currentTime);
    const participantDirectory = new Map((metadata?.participants ?? []).map(participant => [participant.userId, participant]));
    const fallbackStates: RecordingRoomParticipantState[] = (metadata?.participants ?? []).map(participant => ({ userId: participant.userId }));
    const states = event ? event.participants ?? [] : fallbackStates;
    const connected = event ? Boolean(event.channelId) : states.length > 0;
    const recorderUserId = UserStore.getCurrentUser()?.id ?? null;

    return (
        <div className="vc-vrb-room-replay">
            <div key={event?.channelId ?? "disconnected"} className={`vc-vrb-room-header ${connected ? "vc-vrb-room-connected" : "vc-vrb-room-disconnected"}`}>
                <span className="vc-vrb-room-voice-glyph" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="18" height="18">
                        <path fill="currentColor" d="M4.5 8.5a1 1 0 0 1 1.4.05 5 5 0 0 1 0 6.9 1 1 0 1 1-1.45-1.38 3 3 0 0 0 0-4.14 1 1 0 0 1 .05-1.43Zm4-3a1 1 0 0 1 1.4.08 9 9 0 0 1 0 12.84 1 1 0 1 1-1.47-1.36 7 7 0 0 0 0-10.12A1 1 0 0 1 8.5 5.5Zm4-3a1 1 0 0 1 1.4.08 13 13 0 0 1 0 18.84 1 1 0 1 1-1.47-1.36 11 11 0 0 0 0-16.12 1 1 0 0 1 .07-1.44Z" />
                    </svg>
                </span>
                <div className="vc-vrb-room-header-copy">
                    <strong>{connected ? event?.channelName ?? metadata?.channelName ?? tr("Voice channel", "الروم الصوتي") : tr("Not connected to voice", "خارج الروم الصوتي")}</strong>
                    <span>{connected ? event?.guildName ?? metadata?.guildName ?? tr("Discord voice", "روم دسكورد") : tr("Voice Replay is still running", "Voice Replay ما زال شغالًا")}</span>
                </div>
                <Tooltip text={videoExportPhase === "exporting"
                    ? tr("Video export continues in the background.", "تصدير الفيديو مستمر في الخلفية.")
                    : tr("Save this voice-room replay as a 1080p video.", "حفظ تسجيل الروم كفيديو 1080p.")} position="top">
                    {(props: any) => (
                        <button
                            {...props}
                            type="button"
                            className={`vc-vrb-room-video-export vc-vrb-video-export-${videoExportPhase}`}
                            style={{ "--vc-vrb-export-progress": `${Math.round(videoExportProgress * 100)}%` } as any}
                            disabled={videoExportDisabled}
                            onClick={onExportVideo}
                            aria-label={tr("Export video", "تصدير فيديو")}
                        >
                            <span className="vc-vrb-room-video-export-glyph" aria-hidden="true">
                                {videoExportPhase === "done" ? "✓" : videoExportPhase === "error" ? "!" : <VideoSaveGlyph />}
                            </span>
                            {videoExportPhase === "exporting" && <small>{Math.round(videoExportProgress * 100)}%</small>}
                            <i aria-hidden="true"><b /></i>
                        </button>
                    )}
                </Tooltip>
            </div>

            <div className="vc-vrb-room-members">
                {!states.length ? (
                    <div className="vc-vrb-room-empty">{connected ? tr("No members in the recorded room at this moment.", "لا يوجد أعضاء في الروم في هذه اللحظة.") : tr("The session stayed armed while you were outside voice.", "التسجيل بقي شغالًا أثناء خروجك من الروم.")}</div>
                ) : states.map(state => {
                    const participant = participantDirectory.get(state.userId);
                    if (!participant && !state.displayName) return null;
                    const displayName = state.displayName ?? participant?.displayName ?? state.userId;
                    const username = state.username ?? participant?.username ?? state.userId;
                    const avatarUrl = state.avatarUrl ?? participant?.avatarUrl ?? null;
                    const speaking = speakingNow.has(state.userId);
                    const serverMuted = Boolean(state.serverMute);
                    const serverDeafened = Boolean(state.serverDeaf);
                    const locallyMuted = Boolean(state.localMute);
                    const selfMuted = Boolean(state.selfMute || state.muted && !serverMuted && !locallyMuted);
                    const selfDeafened = Boolean(state.selfDeaf || state.deafened && !serverDeafened);
                    const muteState = serverMuted ? "server" : locallyMuted ? "local" : selfMuted ? "self" : null;
                    const deafState = serverDeafened ? "server" : selfDeafened ? "self" : null;
                    const playbackMuted = mutedUsers.has(state.userId);
                    const hasStem = availableStemIds.has(state.userId);
                    const isRecorder = state.userId === recorderUserId;
                    return (
                        <div className={`vc-vrb-room-member ${speaking ? "vc-vrb-room-member-speaking" : ""} ${playbackMuted ? "vc-vrb-room-member-playback-muted" : ""}`} key={state.userId}>
                            <Tooltip text={tr("Open Discord profile", "فتح بروفايل دسكورد")} position="top">
                                {(props: any) => (
                                    <button {...props} type="button" className="vc-vrb-room-avatar-button" onClick={() => void openUserProfile(state.userId)}>
                                        {avatarUrl
                                            ? <img className="vc-vrb-room-avatar" src={avatarUrl} alt="" />
                                            : <span className="vc-vrb-room-avatar vc-vrb-avatar-fallback">{displayName.slice(0, 1).toUpperCase()}</span>}
                                    </button>
                                )}
                            </Tooltip>
                            <div className="vc-vrb-room-member-main">
                                <span className="vc-vrb-room-member-name">{displayName}</span>
                            </div>
                            <div className="vc-vrb-room-historical-states">
                                {muteState === "server" && <Tooltip text={tr("Server muted at this point in the recording", "كان عليه ميوت سيرفر في هذه اللحظة")} position="top">{(props: any) => <span {...props}><BlockedMuteGlyph server /></span>}</Tooltip>}
                                {muteState === "local" && <Tooltip text={tr("You had locally muted this participant", "كنت مسوي ميوت لهذا الشخص من طرفك")} position="top">{(props: any) => <span {...props}><BlockedMuteGlyph /></span>}</Tooltip>}
                                {muteState === "self" && <Tooltip text={tr("Self muted at this point in the recording", "كان مسوي ميوت لنفسه في هذه اللحظة")} position="top">{(props: any) => <span {...props}><SelfMutedGlyph /></span>}</Tooltip>}
                                {deafState === "server" && <Tooltip text={tr("Server deafened at this point in the recording", "كان عليه ديفن سيرفر في هذه اللحظة")} position="top">{(props: any) => <span {...props}><ServerDeafenedGlyph /></span>}</Tooltip>}
                                {deafState === "self" && <Tooltip text={tr("Self deafened at this point in the recording", "كان مسوي ديفن لنفسه في هذه اللحظة")} position="top">{(props: any) => <span {...props}><SelfDeafenedGlyph /></span>}</Tooltip>}
                            </div>
                            <div className="vc-vrb-room-member-actions">
                                {isRecorder && <Tooltip text={hasStem ? (playbackMuted ? tr("Unmute my recorded voice", "تشغيل صوتي في التسجيل") : tr("Mute my recorded voice", "كتم صوتي في التسجيل")) : tr("Your separate microphone track is not available in this recording", "مسار مايكك المنفصل غير متوفر في هذا التسجيل")} position="top">
                                    {(props: any) => (
                                        <button {...props} type="button" className={`vc-vrb-room-track-button ${playbackMuted ? "vc-vrb-room-track-button-active" : ""}`} disabled={!hasStem} onClick={() => onToggleMute(state.userId)} aria-label={tr("Mute my recorded voice", "كتم صوتي في التسجيل")}>
                                            <PlaybackMuteGlyph muted={playbackMuted} />
                                        </button>
                                    )}
                                </Tooltip>}
                                <Tooltip text={tr("Copy username + user ID", "نسخ اليوزر والـID")} position="top">
                                    {(props: any) => (
                                        <button {...props} type="button" className="vc-vrb-room-track-button" onClick={() => void copyWithToast(`@${username}\nID: ${state.userId}`, tr("Username and user ID copied", "تم نسخ اليوزر والـID"))}>
                                            <CopyIcon />
                                        </button>
                                    )}
                                </Tooltip>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function RecordingPlayer({ recording, onDeleted, onBack }: { recording: SavedRecording; onDeleted(): void; onBack(): void; }) {
    const [audioUrl, setAudioUrl] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [playing, setPlaying] = React.useState(false);
    const [currentTime, setCurrentTime] = React.useState(0);
    const [duration, setDuration] = React.useState(() => recordingDuration(recording));
    const [volumeBoost, setVolumeBoost] = React.useState(1);
    const [displayTitle, setDisplayTitle] = React.useState(() => recordingTitle(recording));
    const [editingTitle, setEditingTitle] = React.useState(false);
    const [titleDraft, setTitleDraft] = React.useState(() => recordingTitle(recording));
    const [savingTitle, setSavingTitle] = React.useState(false);
    const [mutedUsers, setMutedUsers] = React.useState<Set<string>>(() => new Set());
    const [soloUserId, setSoloUserId] = React.useState<string | null>(null);
    const [stemMode, setStemMode] = React.useState(false);
    const [stemPreparing, setStemPreparing] = React.useState(false);
    const [masterPreparing, setMasterPreparing] = React.useState(false);
    const videoExport = useVideoExportStatus();
    const videoExporting = videoExport.phase === "exporting";
    const thisVideoExport = videoExport.recordingId === recording.id && videoExport.phase !== "idle";
    const videoExportProgress = thisVideoExport ? videoExport.progress : 0;

    const cancelTitleEditRef = React.useRef(false);
    const audioRef = React.useRef<HTMLAudioElement | null>(null);
    const playbackContextRef = React.useRef<AudioContext | null>(null);
    const playbackSourceRef = React.useRef<MediaElementAudioSourceNode | null>(null);
    const playbackGainRef = React.useRef<GainNode | null>(null);
    const masterEncodedBytesRef = React.useRef<Uint8Array | null>(null);
    const masterBufferRef = React.useRef<AudioBuffer | null>(null);
    const masterBufferSourceRef = React.useRef<AudioBufferSourceNode | null>(null);
    const masterBufferGainRef = React.useRef<GainNode | null>(null);
    const masterBufferClockRef = React.useRef({ offset: 0, contextStartedAt: 0 });
    const masterBufferModeRef = React.useRef(false);
    const masterDecodePromiseRef = React.useRef<Promise<AudioBuffer | null> | null>(null);
    const stemGainRef = React.useRef<GainNode | null>(null);
    const stemSourcesRef = React.useRef<Map<string, AudioBufferSourceNode>>(new Map());
    const stemBuffersRef = React.useRef<Map<string, AudioBuffer>>(new Map());
    const stemClockRef = React.useRef({ offset: 0, contextStartedAt: 0 });
    const playingRef = React.useRef(false);
    const stemModeRef = React.useRef(false);
    const currentTimeRef = React.useRef(0);
    const loadGenerationRef = React.useRef(0);
    const seekGenerationRef = React.useRef(0);
    const pendingSeekRef = React.useRef<number | null>(null);
    const seekCommitTimerRef = React.useRef<number | null>(null);
    const internalSeekPauseRef = React.useRef(false);


    const scrubbingRef = React.useRef(false);
    const scrubWasPlayingRef = React.useRef(false);
    const scrubTargetRef = React.useRef(0);

    const effectiveDuration = duration || recordingDuration(recording);
    const declaredStemIds = new Set(recording.metadata?.recording?.isolatedTrackUserIds ?? []);
    const hasResidualStem = Boolean(recording.metadata?.recording?.hasResidualStem);
    const hasRoomEventStem = Boolean(recording.metadata?.recording?.hasRoomEventStem);

    React.useEffect(() => { playingRef.current = playing; }, [playing]);
    React.useEffect(() => { stemModeRef.current = stemMode; }, [stemMode]);
    React.useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);

    const stopStemSources = React.useCallback(() => {
        for (const source of stemSourcesRef.current.values()) {
            try { source.onended = null; } catch {   }
            try { source.stop(); } catch {   }
            try { source.disconnect(); } catch {   }
        }
        stemSourcesRef.current.clear();
    }, []);

    const stopMasterBufferSource = React.useCallback(() => {
        const source = masterBufferSourceRef.current;
        masterBufferSourceRef.current = null;
        if (!source) return;
        try { source.onended = null; } catch {   }
        try { source.stop(); } catch {   }
        try { source.disconnect(); } catch {   }
    }, []);

    const masterBufferPosition = React.useCallback(() => {
        const context = playbackContextRef.current;
        const clock = masterBufferClockRef.current;
        if (!masterBufferModeRef.current || !playingRef.current || !context || context.state === "closed") return currentTimeRef.current;
        return Math.min(effectiveDuration, Math.max(0, clock.offset + (context.currentTime - clock.contextStartedAt)));
    }, [effectiveDuration]);

    const getPlaybackContext = React.useCallback(() => {
        const existing = playbackContextRef.current;
        if (existing && existing.state !== "closed") return existing;
        const AudioContextConstructor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext; }).webkitAudioContext;
        if (!AudioContextConstructor) return null;
        try {
            const context = new AudioContextConstructor({ latencyHint: "interactive" });
            playbackContextRef.current = context;
            return context;
        } catch {
            return null;
        }
    }, []);

    const stemPosition = React.useCallback(() => {
        const context = playbackContextRef.current;
        const clock = stemClockRef.current;
        if (!stemModeRef.current || !playingRef.current || !context || context.state === "closed") return currentTimeRef.current;
        return Math.min(effectiveDuration, Math.max(0, clock.offset + (context.currentTime - clock.contextStartedAt)));
    }, [effectiveDuration]);

    const ensureMasterBuffer = React.useCallback(async () => {
        if (masterBufferRef.current) return masterBufferRef.current;
        if (masterDecodePromiseRef.current) return masterDecodePromiseRef.current;
        const bytes = masterEncodedBytesRef.current;
        const context = getPlaybackContext();
        if (!bytes || !context) return null;

        setMasterPreparing(true);
        const promise = (async () => {
            try {
                const encoded = new Uint8Array(bytes.byteLength);
                encoded.set(bytes);
                const decoded = await context.decodeAudioData(encoded.buffer);
                masterBufferRef.current = decoded;
                if (Number.isFinite(decoded.duration) && decoded.duration > 0) setDuration(decoded.duration);
                return decoded;
            } catch {
                return null;
            } finally {
                masterDecodePromiseRef.current = null;
                setMasterPreparing(false);
            }
        })();
        masterDecodePromiseRef.current = promise;
        return promise;
    }, [getPlaybackContext]);

    const ensureMasterBufferGain = React.useCallback(() => {
        const context = getPlaybackContext();
        if (!context) return null;
        if (masterBufferGainRef.current) return masterBufferGainRef.current;
        const gain = context.createGain();
        gain.gain.value = volumeBoost;
        gain.connect(context.destination);
        masterBufferGainRef.current = gain;
        return gain;
    }, [getPlaybackContext, volumeBoost]);

    const startMasterBufferPlayback = React.useCallback(async (offset: number) => {
        const context = getPlaybackContext();
        const gain = ensureMasterBufferGain();
        if (!context || !gain) return false;
        try { if (context.state === "suspended") await context.resume(); } catch {   }
        const buffer = await ensureMasterBuffer();
        if (!buffer) return false;

        stopMasterBufferSource();
        stopStemSources();
        const startAt = offset >= effectiveDuration - .01 ? 0 : Math.max(0, Math.min(offset, Math.max(0, buffer.duration - .001)));
        gain.gain.value = volumeBoost;

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        masterBufferSourceRef.current = source;
        source.onended = () => {
            if (masterBufferSourceRef.current !== source || !playingRef.current) return;
            masterBufferSourceRef.current = null;
            masterBufferClockRef.current = { offset: effectiveDuration, contextStartedAt: context.currentTime };
            currentTimeRef.current = effectiveDuration;
            setCurrentTime(effectiveDuration);
            playingRef.current = false;
            setPlaying(false);
        };

        try { source.start(0, startAt); } catch { return false; }
        internalSeekPauseRef.current = true;
        audioRef.current?.pause();
        internalSeekPauseRef.current = false;
        stemModeRef.current = false;
        setStemMode(false);
        masterBufferModeRef.current = true;
        masterBufferClockRef.current = { offset: startAt, contextStartedAt: context.currentTime };
        currentTimeRef.current = startAt;
        setCurrentTime(startAt);
        playingRef.current = true;
        setPlaying(true);
        return true;
    }, [effectiveDuration, ensureMasterBuffer, ensureMasterBufferGain, getPlaybackContext, stopMasterBufferSource, stopStemSources, volumeBoost]);

    const pauseMasterBufferPlayback = React.useCallback(() => {
        const position = masterBufferPosition();
        stopMasterBufferSource();
        const context = playbackContextRef.current;
        masterBufferClockRef.current = { offset: position, contextStartedAt: context?.currentTime ?? 0 };
        currentTimeRef.current = position;
        setCurrentTime(position);
        playingRef.current = false;
        setPlaying(false);
        return position;
    }, [masterBufferPosition, stopMasterBufferSource]);

    const ensurePlaybackGain = React.useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return null;
        if (playbackGainRef.current) return playbackGainRef.current;
        try {
            const context = getPlaybackContext();
            if (!context) return null;
            const source = context.createMediaElementSource(audio);
            const gain = context.createGain();
            source.connect(gain);
            gain.connect(context.destination);
            playbackSourceRef.current = source;
            playbackGainRef.current = gain;
            gain.gain.value = volumeBoost;
            return gain;
        } catch {
            return null;
        }
    }, [getPlaybackContext, volumeBoost]);

    const ensureStemGain = React.useCallback(() => {
        const context = getPlaybackContext();
        if (!context) return null;
        if (stemGainRef.current) return stemGainRef.current;
        const gain = context.createGain();
        gain.gain.value = volumeBoost;
        gain.connect(context.destination);
        stemGainRef.current = gain;
        return gain;
    }, [getPlaybackContext, volumeBoost]);

    const pcmBytesToAudioBuffer = React.useCallback((context: AudioContext, value: Uint8Array, sampleRate: number) => {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as any);
        const sampleCount = Math.floor(bytes.byteLength / 2);
        const buffer = context.createBuffer(1, sampleCount, sampleRate);
        const output = buffer.getChannelData(0);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < sampleCount; i++) output[i] = view.getInt16(i * 2, true) / 32768;
        return buffer;
    }, []);

    const ensureStemBuffers = React.useCallback(async (userIds: string[]) => {
        const context = getPlaybackContext();
        if (!context) return new Map(stemBuffersRef.current);
        const sampleRate = Math.max(8000, Number(recording.metadata?.recording?.sampleRate) || 48000);
        const working = new Map(stemBuffersRef.current);
        const generation = loadGenerationRef.current;
        const missing = Array.from(new Set(userIds)).filter(id => id && !working.has(id));
        if (!missing.length) return working;

        setStemPreparing(true);
        try {
            await Promise.all(missing.map(async userId => {
                const bytes = await Native.readRecordingStem(settings.store.saveFolder, recording.audioFilename, userId) as Uint8Array | null;
                if (!bytes || generation !== loadGenerationRef.current) return;
                try { working.set(userId, pcmBytesToAudioBuffer(context, bytes, sampleRate)); } catch {   }
            }));
            if (generation === loadGenerationRef.current) stemBuffersRef.current = working;
            return working;
        } finally {
            if (generation === loadGenerationRef.current) setStemPreparing(false);
        }
    }, [getPlaybackContext, pcmBytesToAudioBuffer, recording.audioFilename, recording.id]);

    const selectedStemIds = React.useCallback((nextMuted: Set<string>, nextSolo: string | null) => {
        const ids = nextSolo
            ? (declaredStemIds.has(nextSolo) ? [nextSolo] : [])
            : Array.from(declaredStemIds).filter(userId => !nextMuted.has(userId));
        if (!nextSolo && hasResidualStem) ids.push(RESIDUAL_STEM_ID);


        if (hasRoomEventStem) ids.push(ROOM_EVENTS_STEM_ID);
        return ids;
    }, [recording.id, hasResidualStem, hasRoomEventStem]);

    const startStemPlayback = React.useCallback(async (offset: number, nextMuted: Set<string>, nextSolo: string | null) => {
        const context = getPlaybackContext();
        const gain = ensureStemGain();
        if (!context || !gain) {
            toast(tr("Separate-track playback is unavailable in this Discord build.", "تشغيل المسارات المنفصلة غير متاح في إصدار دسكورد الحالي."), Toasts.Type.FAILURE);
            return false;
        }

        const ids = selectedStemIds(nextMuted, nextSolo);
        const buffers = await ensureStemBuffers(ids);
        if (nextSolo && !buffers.has(nextSolo)) {
            toast(tr("Could not load this participant's separate audio track.", "تعذر تحميل المسار الصوتي المنفصل لهذا الشخص."), Toasts.Type.FAILURE);
            return false;
        }

        stopStemSources();
        stopMasterBufferSource();
        masterBufferModeRef.current = false;
        const startAt = offset >= effectiveDuration - .01 ? 0 : Math.max(0, offset);
        try { if (context.state === "suspended") await context.resume(); } catch {   }
        gain.gain.value = volumeBoost;

        for (const id of ids) {
            const buffer = buffers.get(id);
            if (!buffer) continue;
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(gain);
            stemSourcesRef.current.set(id, source);
            try { source.start(0, Math.min(startAt, Math.max(0, buffer.duration - .001))); } catch {   }
        }

        audioRef.current?.pause();
        stemClockRef.current = { offset: startAt, contextStartedAt: context.currentTime };
        currentTimeRef.current = startAt;
        setCurrentTime(startAt);
        stemModeRef.current = true;
        setStemMode(true);
        playingRef.current = true;
        setPlaying(true);
        return true;
    }, [effectiveDuration, ensureStemBuffers, ensureStemGain, getPlaybackContext, selectedStemIds, stopMasterBufferSource, stopStemSources, volumeBoost]);

    const pauseStemPlayback = React.useCallback(() => {
        const position = stemPosition();
        stopStemSources();
        const context = playbackContextRef.current;
        stemClockRef.current = { offset: position, contextStartedAt: context?.currentTime ?? 0 };
        currentTimeRef.current = position;
        setCurrentTime(position);
        playingRef.current = false;
        setPlaying(false);
        return position;
    }, [stemPosition, stopStemSources]);

    const switchToMainPlayback = React.useCallback((position: number, shouldPlay: boolean) => {
        stopStemSources();
        stemModeRef.current = false;
        setStemMode(false);
        const clamped = Math.min(Math.max(0, position), effectiveDuration);
        currentTimeRef.current = clamped;
        setCurrentTime(clamped);

        if (shouldPlay) {
            void startMasterBufferPlayback(clamped).then(ok => {
                if (ok) return;
                masterBufferModeRef.current = false;
                const audio = audioRef.current;
                if (!audio || !audioUrl) {
                    playingRef.current = false;
                    setPlaying(false);
                    return;
                }
                try { audio.currentTime = clamped; } catch {   }
                void audio.play().catch(() => {
                    playingRef.current = false;
                    setPlaying(false);
                });
            });
            return;
        }

        stopMasterBufferSource();
        masterBufferModeRef.current = true;
        const context = playbackContextRef.current;
        masterBufferClockRef.current = { offset: clamped, contextStartedAt: context?.currentTime ?? 0 };
        internalSeekPauseRef.current = true;
        audioRef.current?.pause();
        internalSeekPauseRef.current = false;
        playingRef.current = false;
        setPlaying(false);
    }, [audioUrl, effectiveDuration, startMasterBufferPlayback, stopMasterBufferSource, stopStemSources]);

    const useStemSelection = React.useCallback((nextMuted: Set<string>, nextSolo: string | null) => {
        const wasPlaying = playingRef.current;
        const position = stemModeRef.current
            ? stemPosition()
            : masterBufferModeRef.current
                ? masterBufferPosition()
                : (audioRef.current?.currentTime ?? currentTimeRef.current);
        setMutedUsers(nextMuted);
        setSoloUserId(nextSolo);

        if (!nextSolo && nextMuted.size === 0) {
            switchToMainPlayback(position, wasPlaying);
            return;
        }

        stopMasterBufferSource();
        masterBufferModeRef.current = false;
        audioRef.current?.pause();
        stemModeRef.current = true;
        setStemMode(true);
        const context = playbackContextRef.current;
        stemClockRef.current = { offset: position, contextStartedAt: context?.currentTime ?? 0 };
        currentTimeRef.current = position;
        setCurrentTime(position);
        if (wasPlaying) {
            void startStemPlayback(position, nextMuted, nextSolo).then(ok => {
                if (!ok) switchToMainPlayback(position, true);
            });
        } else {
            playingRef.current = false;
            setPlaying(false);

            void ensureStemBuffers(selectedStemIds(nextMuted, nextSolo));
        }
    }, [ensureStemBuffers, masterBufferPosition, selectedStemIds, startStemPlayback, stemPosition, stopMasterBufferSource, switchToMainPlayback]);

    React.useEffect(() => {
        let cancelled = false;
        let objectUrl: string | null = null;
        loadGenerationRef.current++;
        if (seekCommitTimerRef.current !== null) {
            window.clearTimeout(seekCommitTimerRef.current);
            seekCommitTimerRef.current = null;
        }
        pendingSeekRef.current = null;
        scrubbingRef.current = false;
        scrubWasPlayingRef.current = false;
        scrubTargetRef.current = 0;
        stopStemSources();
        stopMasterBufferSource();
        masterEncodedBytesRef.current = null;
        masterBufferRef.current = null;
        masterDecodePromiseRef.current = null;
        masterBufferModeRef.current = false;
        stemBuffersRef.current = new Map();
        setMutedUsers(new Set());
        setSoloUserId(null);
        setStemMode(false);
        stemModeRef.current = false;
        setAudioUrl(null);
        setCurrentTime(0);
        currentTimeRef.current = 0;
        setPlaying(false);
        playingRef.current = false;
        setDuration(recordingDuration(recording));
        setLoading(true);
        const nextTitle = recordingTitle(recording);
        setDisplayTitle(nextTitle);
        setTitleDraft(nextTitle);
        setEditingTitle(false);

        void Native.readRecordingBytes(settings.store.saveFolder, recording.audioFilename).then(bytes => {
            if (cancelled) return;
            if (!bytes) {
                toast(tr("Could not read this recording.", "تعذر فتح هذا التسجيل."), Toasts.Type.FAILURE);
                return;
            }
            const rawBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as any);
            masterEncodedBytesRef.current = rawBytes;
            const mime = recording.format.toLowerCase() === "flac" ? "audio/flac" : "audio/wav";
            objectUrl = URL.createObjectURL(new Blob([rawBytes], { type: mime }));
            setAudioUrl(objectUrl);
        }).finally(() => {
            if (!cancelled) setLoading(false);
        });

        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [recording.id, stopMasterBufferSource, stopStemSources]);

    React.useEffect(() => {
        if (!playing) return;
        let frame = 0;
        const tick = () => {


            if (scrubbingRef.current || pendingSeekRef.current !== null) {
                frame = requestAnimationFrame(tick);
                return;
            }
            if (stemModeRef.current) {
                const next = stemPosition();
                currentTimeRef.current = next;
                setCurrentTime(next);
                if (next >= effectiveDuration - .005) {
                    stopStemSources();
                    playingRef.current = false;
                    setPlaying(false);
                    stemClockRef.current.offset = effectiveDuration;
                    currentTimeRef.current = effectiveDuration;
                    setCurrentTime(effectiveDuration);
                    return;
                }
            } else if (masterBufferModeRef.current) {
                const next = masterBufferPosition();
                currentTimeRef.current = next;
                setCurrentTime(next);
                if (next >= effectiveDuration - .005) {
                    stopMasterBufferSource();
                    playingRef.current = false;
                    setPlaying(false);
                    masterBufferClockRef.current.offset = effectiveDuration;
                    currentTimeRef.current = effectiveDuration;
                    setCurrentTime(effectiveDuration);
                    return;
                }
            } else {
                const audio = audioRef.current;
                if (audio) {
                    currentTimeRef.current = audio.currentTime || 0;
                    setCurrentTime(audio.currentTime || 0);
                }
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [playing, effectiveDuration, masterBufferPosition, stemPosition, stopMasterBufferSource, stopStemSources]);

    React.useEffect(() => () => {
        loadGenerationRef.current++;
        if (seekCommitTimerRef.current !== null) window.clearTimeout(seekCommitTimerRef.current);
        pendingSeekRef.current = null;
        scrubbingRef.current = false;
        scrubWasPlayingRef.current = false;
        stopStemSources();
        stopMasterBufferSource();
        stemBuffersRef.current.clear();
        masterEncodedBytesRef.current = null;
        masterBufferRef.current = null;
        masterDecodePromiseRef.current = null;
        masterBufferModeRef.current = false;
        try { playbackSourceRef.current?.disconnect(); } catch {   }
        try { playbackGainRef.current?.disconnect(); } catch {   }
        try { masterBufferGainRef.current?.disconnect(); } catch {   }
        try { stemGainRef.current?.disconnect(); } catch {   }
        const context = playbackContextRef.current;
        playbackSourceRef.current = null;
        playbackGainRef.current = null;
        masterBufferGainRef.current = null;
        stemGainRef.current = null;
        playbackContextRef.current = null;
        if (context && context.state !== "closed") void context.close();
    }, [stopMasterBufferSource, stopStemSources]);

    const applyVolumeBoost = React.useCallback((next: number) => {
        const clamped = Math.min(2, Math.max(0, next));
        setVolumeBoost(clamped);
        const audio = audioRef.current;
        const gain = audio ? (playbackGainRef.current ?? (clamped > 1 ? ensurePlaybackGain() : null)) : null;
        const context = playbackContextRef.current;
        if (audio) {
            if (gain && context) {
                audio.volume = 1;
                gain.gain.setTargetAtTime(clamped, context.currentTime, .012);
            } else {


                audio.volume = Math.min(1, clamped);
            }
        }
        if (masterBufferGainRef.current && context) masterBufferGainRef.current.gain.setTargetAtTime(clamped, context.currentTime, .012);
        if (stemGainRef.current && context) stemGainRef.current.gain.setTargetAtTime(clamped, context.currentTime, .012);
    }, [ensurePlaybackGain]);

    const commitSeek = React.useCallback(async (next: number, resumeOverride?: boolean) => {
        if (!Number.isFinite(next)) return;
        const clamped = Math.min(effectiveDuration, Math.max(0, next));
        const generation = ++seekGenerationRef.current;
        currentTimeRef.current = clamped;
        setCurrentTime(clamped);

        if (stemModeRef.current) {
            const context = playbackContextRef.current;
            const resumeStem = resumeOverride ?? playingRef.current;
            stemClockRef.current = { offset: clamped, contextStartedAt: context?.currentTime ?? 0 };
            if (resumeStem) await startStemPlayback(clamped, mutedUsers, soloUserId);
            return;
        }

        const audio = audioRef.current;
        if (!audio) return;
        const resumeAfterSeek = resumeOverride ?? (playingRef.current && !audio.paused);
        if (resumeAfterSeek) {
            internalSeekPauseRef.current = true;
            audio.pause();
        }

        await new Promise<void>(resolve => {
            let settled = false;
            const finishSeek = () => {
                if (settled) return;
                settled = true;
                audio.removeEventListener("seeked", onSeeked);
                if (generation !== seekGenerationRef.current) { resolve(); return; }
                currentTimeRef.current = clamped;
                setCurrentTime(clamped);
                internalSeekPauseRef.current = false;
                resolve();
            };
            const onSeeked = () => finishSeek();
            audio.addEventListener("seeked", onSeeked, { once: true });
            try { audio.currentTime = clamped; } catch { finishSeek(); return; }

            window.setTimeout(finishSeek, 320);
        });

        if (generation !== seekGenerationRef.current) return;
        const context = playbackContextRef.current;
        if (context?.state === "suspended") {
            try { await context.resume(); } catch {   }
        }
        if (resumeAfterSeek && audioUrl) {
            try {
                await audio.play();
            } catch {
                playingRef.current = false;
                setPlaying(false);
            }
        }
    }, [audioUrl, effectiveDuration, mutedUsers, soloUserId, startStemPlayback]);

    const togglePlayback = () => {
        if (stemPreparing || masterPreparing) return;
        if (stemModeRef.current) {
            if (playingRef.current) {
                pauseStemPlayback();
            } else {
                const pending = pendingSeekRef.current;
                if (pending !== null) {
                    pendingSeekRef.current = null;
                    if (seekCommitTimerRef.current !== null) {
                        window.clearTimeout(seekCommitTimerRef.current);
                        seekCommitTimerRef.current = null;
                    }
                    void commitSeek(pending, false).then(() => startStemPlayback(currentTimeRef.current, mutedUsers, soloUserId)).then(ok => {
                        if (!ok) switchToMainPlayback(currentTimeRef.current, false);
                    });
                } else {
                    void startStemPlayback(currentTimeRef.current, mutedUsers, soloUserId).then(ok => {
                        if (!ok) switchToMainPlayback(currentTimeRef.current, false);
                    });
                }
            }
            return;
        }

        if (masterBufferModeRef.current) {
            if (playingRef.current) {
                pauseMasterBufferPlayback();
            } else {
                const pending = pendingSeekRef.current;
                pendingSeekRef.current = null;
                if (seekCommitTimerRef.current !== null) {
                    window.clearTimeout(seekCommitTimerRef.current);
                    seekCommitTimerRef.current = null;
                }
                const position = pending ?? currentTimeRef.current;
                void startMasterBufferPlayback(position).then(ok => {
                    if (!ok) {
                        masterBufferModeRef.current = false;
                        void commitSeek(position, true);
                    }
                });
            }
            return;
        }

        const audio = audioRef.current;
        if (!audio || !audioUrl) return;

        const pending = pendingSeekRef.current;
        if (pending !== null) {
            pendingSeekRef.current = null;
            if (seekCommitTimerRef.current !== null) {
                window.clearTimeout(seekCommitTimerRef.current);
                seekCommitTimerRef.current = null;
            }
            void startMasterBufferPlayback(pending).then(ok => {
                if (!ok) void commitSeek(pending, true);
            });
            return;
        }
        const gain = playbackGainRef.current ?? (volumeBoost > 1 ? ensurePlaybackGain() : null);
        if (gain && playbackContextRef.current) {
            audio.volume = 1;
            gain.gain.value = volumeBoost;
            if (playbackContextRef.current.state === "suspended") void playbackContextRef.current.resume();
        } else {
            audio.volume = Math.min(1, volumeBoost);
        }

        if (!audio.paused) {
            audio.pause();
            return;
        }

        const playFromCurrentPosition = async () => {
            const pending = pendingSeekRef.current;
            if (pending !== null) {
                pendingSeekRef.current = null;
                if (seekCommitTimerRef.current !== null) {
                    window.clearTimeout(seekCommitTimerRef.current);
                    seekCommitTimerRef.current = null;
                }
                await commitSeek(pending, false);
            } else if (Math.abs((audio.currentTime || 0) - currentTimeRef.current) > .04 || audio.seeking) {
                await commitSeek(currentTimeRef.current, false);
            }

            if (audio.currentTime >= effectiveDuration - .01) {
                currentTimeRef.current = 0;
                setCurrentTime(0);
                await commitSeek(0, false);
            }

            try {
                await audio.play();
            } catch {
                playingRef.current = false;
                setPlaying(false);
            }
        };
        void playFromCurrentPosition();
    };

    const beginSeekDrag = React.useCallback(() => {
        if (scrubbingRef.current) return;
        scrubbingRef.current = true;
        scrubWasPlayingRef.current = playingRef.current;
        scrubTargetRef.current = currentTimeRef.current;
        pendingSeekRef.current = currentTimeRef.current;

        if (seekCommitTimerRef.current !== null) {
            window.clearTimeout(seekCommitTimerRef.current);
            seekCommitTimerRef.current = null;
        }



        if (!playingRef.current) return;
        if (stemModeRef.current) {
            const position = pauseStemPlayback();
            scrubTargetRef.current = position;
            pendingSeekRef.current = position;
            return;
        }
        if (masterBufferModeRef.current) {
            const position = pauseMasterBufferPlayback();
            scrubTargetRef.current = position;
            pendingSeekRef.current = position;
            return;
        }

        const audio = audioRef.current;
        if (audio && !audio.paused) {
            internalSeekPauseRef.current = true;
            audio.pause();
            internalSeekPauseRef.current = false;
        }
        playingRef.current = false;
        setPlaying(false);
    }, [pauseMasterBufferPlayback, pauseStemPlayback]);

    const finishSeekDrag = React.useCallback(() => {
        if (!scrubbingRef.current) return;
        const target = Math.min(effectiveDuration, Math.max(0, scrubTargetRef.current));
        const shouldResume = scrubWasPlayingRef.current;
        scrubbingRef.current = false;
        scrubWasPlayingRef.current = false;
        currentTimeRef.current = target;
        setCurrentTime(target);
        pendingSeekRef.current = target;



        if (!shouldResume) return;

        pendingSeekRef.current = null;
        if (stemModeRef.current) {
            void startStemPlayback(target, mutedUsers, soloUserId).then(ok => {
                if (!ok) switchToMainPlayback(target, true);
            });
            return;
        }

        void startMasterBufferPlayback(target).then(ok => {
            if (!ok) void commitSeek(target, true);
        });
    }, [commitSeek, effectiveDuration, mutedUsers, soloUserId, startMasterBufferPlayback, startStemPlayback, switchToMainPlayback]);

    const seekPlayback = (next: number) => {
        if (!Number.isFinite(next)) return;
        const clamped = Math.min(effectiveDuration, Math.max(0, next));
        currentTimeRef.current = clamped;
        setCurrentTime(clamped);
        pendingSeekRef.current = clamped;
        scrubTargetRef.current = clamped;



        if (scrubbingRef.current) return;



        if (seekCommitTimerRef.current !== null) {
            window.clearTimeout(seekCommitTimerRef.current);
            seekCommitTimerRef.current = null;
        }
        if (!playingRef.current) return;

        seekCommitTimerRef.current = window.setTimeout(() => {
            seekCommitTimerRef.current = null;
            const pending = pendingSeekRef.current;
            if (pending === null) return;
            pendingSeekRef.current = null;
            if (stemModeRef.current) {
                void commitSeek(pending, true);
                return;
            }
            internalSeekPauseRef.current = true;
            audioRef.current?.pause();
            internalSeekPauseRef.current = false;
            void startMasterBufferPlayback(pending).then(ok => {
                if (!ok) void commitSeek(pending, true);
            });
        }, 90);
    };

    const toggleParticipantMute = (userId: string) => {
        if (!declaredStemIds.has(userId)) return;
        const next = new Set(mutedUsers);
        if (next.has(userId)) next.delete(userId);
        else next.add(userId);
        useStemSelection(next, null);
    };

    const deleteThis = async () => {
        try {
            await Native.deleteRecording(settings.store.saveFolder, recording.audioFilename);
            toast(tr("Recording deleted.", "تم حذف التسجيل."), Toasts.Type.SUCCESS);
            onDeleted();
        } catch (error) {
            toast(localizedError(error), Toasts.Type.FAILURE);
        }
    };

    const exportVideo = () => {
        if (videoExporting) {
            toast(tr("A replay video is already being exported.", "يوجد فيديو تسجيل قيد التصدير بالفعل."), Toasts.Type.MESSAGE);
            return;
        }
        if (stemModeRef.current && playingRef.current) pauseStemPlayback();
        else audioRef.current?.pause();
        void startManagedVideoExport(recording);
    };

    const saveRecordingTitle = async () => {
        if (savingTitle) return;
        const next = titleDraft.trim().replace(/\s+/g, " ").slice(0, 80);
        if (!next) {
            setTitleDraft(displayTitle);
            setEditingTitle(false);
            return;
        }
        setSavingTitle(true);
        try {
            await Native.setRecordingTitle(settings.store.saveFolder, recording.audioFilename, next);
            setDisplayTitle(next);
            setTitleDraft(next);
            setEditingTitle(false);
            toast(tr("Recording name updated.", "تم تعديل اسم التسجيل."), Toasts.Type.SUCCESS);
        } catch (error) {
            toast(localizedError(error), Toasts.Type.FAILURE);
        } finally {
            setSavingTitle(false);
        }
    };

    return (
        <div className="vc-vrb-player">
            <audio
                ref={audioRef}
                src={audioUrl ?? undefined}
                preload="metadata"
                onLoadedMetadata={event => {
                    const d = event.currentTarget.duration;
                    if (Number.isFinite(d)) setDuration(d);
                }}
                onPlay={() => {
                    if (stemModeRef.current || masterBufferModeRef.current) return;
                    playingRef.current = true;
                    setPlaying(true);
                }}
                onPause={() => {
                    if (stemModeRef.current || internalSeekPauseRef.current || scrubbingRef.current) return;
                    playingRef.current = false;
                    setPlaying(false);
                    const next = audioRef.current?.currentTime ?? 0;
                    currentTimeRef.current = next;
                    setCurrentTime(next);
                }}
                onEnded={() => {
                    if (stemModeRef.current) return;
                    playingRef.current = false;
                    setPlaying(false);
                    currentTimeRef.current = effectiveDuration;
                    setCurrentTime(effectiveDuration);
                }}
            />

            <div className="vc-vrb-player-top">
                <button type="button" className="vc-vrb-back" onClick={onBack} aria-label={tr("Back to recordings", "الرجوع إلى التسجيلات")}>{localizedBackGlyph()}</button>
                <div className="vc-vrb-player-heading">
                    <div className={`vc-vrb-player-title-line ${editingTitle ? "vc-vrb-player-title-line-editing" : ""}`}>
                        {editingTitle ? (
                            <input
                                className="vc-vrb-title-input"
                                value={titleDraft}
                                maxLength={80}
                                autoFocus
                                disabled={savingTitle}
                                onChange={event => setTitleDraft(event.currentTarget.value)}
                                onBlur={() => {
                                    if (cancelTitleEditRef.current) {
                                        cancelTitleEditRef.current = false;
                                        return;
                                    }
                                    void saveRecordingTitle();
                                }}
                                onKeyDown={event => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        event.currentTarget.blur();
                                    } else if (event.key === "Escape") {
                                        event.preventDefault();
                                        cancelTitleEditRef.current = true;
                                        setTitleDraft(displayTitle);
                                        setEditingTitle(false);
                                    }
                                }}
                                aria-label={tr("Recording name", "اسم التسجيل")}
                            />
                        ) : (
                            <>
                                <div className="vc-vrb-player-title">{displayTitle}</div>
                                <Tooltip text={tr("Rename recording", "تعديل اسم التسجيل")} position="top">
                                    {(props: any) => (
                                        <button
                                            {...props}
                                            type="button"
                                            className="vc-vrb-recording-edit-button vc-vrb-player-edit-button"
                                            onClick={() => {
                                                setTitleDraft(displayTitle);
                                                setEditingTitle(true);
                                            }}
                                            aria-label={tr("Rename recording", "تعديل اسم التسجيل")}
                                        >
                                            <EditRecordingGlyph />
                                        </button>
                                    )}
                                </Tooltip>
                            </>
                        )}
                    </div>
                    <div className="vc-vrb-player-date">{formatRecordingDate(recording)}</div>
                    <div className="vc-vrb-player-meta">{recording.format.toUpperCase()} • {formatBytes(recording.sizeBytes)}</div>
                </div>
                <div className="vc-vrb-player-actions">
                    <Tooltip text={tr("Show file", "إظهار الملف")} position="top">
                        {(props: any) => <button {...props} type="button" className="vc-vrb-text-button" onClick={() => void Native.revealRecording(settings.store.saveFolder, recording.audioFilename)}>{tr("File", "الملف")}</button>}
                    </Tooltip>
                    <Tooltip text={tr("Delete recording", "حذف التسجيل")} position="top">
                        {(props: any) => (
                            <button {...props} type="button" className="vc-vrb-text-button vc-vrb-player-delete" onClick={() => void deleteThis()}>
                                <TrashGlyph size={13} />
                                <span>{tr("Delete recording", "حذف التسجيل")}</span>
                            </button>
                        )}
                    </Tooltip>
                </div>
            </div>

            <div className="vc-vrb-transport">
                <button type="button" className="vc-vrb-play" disabled={(!audioUrl && !stemMode) || loading || stemPreparing || masterPreparing} onClick={togglePlayback} aria-label={playing ? tr("Pause", "إيقاف مؤقت") : tr("Play", "تشغيل")}>
                    {playing
                        ? <svg viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></svg>
                        : <svg viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5Z" /></svg>}
                </button>
                <span className="vc-vrb-time">{formatClock(currentTime)}</span>
                <input
                    className="vc-vrb-seek"
                    type="range"
                    min={0}
                    max={Math.max(.01, effectiveDuration)}
                    step={.01}
                    value={Math.min(currentTime, Math.max(.01, effectiveDuration))}
                    disabled={(!audioUrl && !stemMode) || loading || stemPreparing || masterPreparing}
                    onPointerDown={event => {
                        try { event.currentTarget.setPointerCapture(event.pointerId); } catch {   }
                        beginSeekDrag();
                    }}
                    onPointerUp={event => {
                        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {   }
                        finishSeekDrag();
                    }}
                    onPointerCancel={() => finishSeekDrag()}
                    onBlur={() => finishSeekDrag()}
                    onChange={event => seekPlayback(Number(event.currentTarget.value))}
                />
                <span className="vc-vrb-time">{formatClock(effectiveDuration)}</span>
            </div>

            <div className="vc-vrb-volume-control">
                <svg className="vc-vrb-volume-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M4 9.5v5h4l5 4V5.5l-5 4H4Zm11.4-.8a1 1 0 0 1 1.4.1 5.1 5.1 0 0 1 0 6.4 1 1 0 1 1-1.5-1.3 3.1 3.1 0 0 0 0-3.8 1 1 0 0 1 .1-1.4Zm2.8-2.4a1 1 0 0 1 1.4.1 8.8 8.8 0 0 1 0 11.2 1 1 0 1 1-1.5-1.3 6.8 6.8 0 0 0 0-8.6 1 1 0 0 1 .1-1.4Z" />
                </svg>
                <span className="vc-vrb-volume-label">{tr("Playback volume", "صوت التشغيل")}</span>
                <input
                    className="vc-vrb-volume-slider"
                    type="range"
                    min={0}
                    max={2}
                    step={.05}
                    value={volumeBoost}
                    onChange={event => applyVolumeBoost(Number(event.currentTarget.value))}
                    aria-label={tr("Playback volume boost", "رفع صوت التشغيل")}
                />
                <span className={`vc-vrb-volume-value ${volumeBoost > 1 ? "vc-vrb-volume-boosted" : ""}`}>{Math.round(volumeBoost * 100)}%</span>
            </div>

            <div className="vc-vrb-section-title">
                <span>{tr("Recorded voice room", "الروم الصوتي المسجّل")}</span>
                <span>{stemPreparing ? tr("Preparing tracks…", "جارٍ تجهيز المسارات…") : tr(`${declaredStemIds.size} isolated`, `${declaredStemIds.size} مسارات منفصلة`)}</span>
            </div>
            <PlaybackRoomReplay
                metadata={recording.metadata}
                currentTime={currentTime}
                mutedUsers={mutedUsers}
                availableStemIds={declaredStemIds}
                videoExportPhase={thisVideoExport ? videoExport.phase : "idle"}
                videoExportProgress={videoExportProgress}
                videoExportDisabled={(videoExporting && !thisVideoExport) || loading}
                onExportVideo={exportVideo}
                onToggleMute={toggleParticipantMute}
            />
        </div>
    );
}

function recordingDayKey(recording: SavedRecording) {
    const date = new Date(recordingTimestamp(recording));
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function recordingDayLabel(recording: SavedRecording) {
    const date = new Date(recordingTimestamp(recording));
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const days = Math.round((startToday - startThatDay) / 86400000);
    if (days === 0) return tr("Today", "اليوم");
    if (days === 1) return tr("Yesterday", "أمس");
    return date.toLocaleDateString(pluginLanguage() === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : undefined, { month: "short", day: "numeric", year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

function RecordingParticipantStack({ recording }: { recording: SavedRecording }) {
    const directParticipants = (recording.metadata?.participants ?? []).filter(participant => Boolean(participant?.userId));
    const timelineParticipants = new Map<string, RecordingParticipant>();
    for (const event of recording.metadata?.roomTimeline ?? []) {
        for (const participant of event.participants ?? []) {
            if (!participant?.userId || timelineParticipants.has(participant.userId)) continue;
            timelineParticipants.set(participant.userId, {
                userId: participant.userId,
                username: participant.username ?? participant.userId,
                displayName: participant.displayName ?? participant.username ?? participant.userId,
                avatarUrl: participant.avatarUrl ?? null
            });
        }
    }
    const participants = directParticipants.length ? directParticipants : Array.from(timelineParticipants.values());
    if (!participants.length) return null;

    const visible = participants.slice(0, 4);
    const overflow = Math.max(0, participants.length - visible.length);
    const label = tr(
        `${participants.length} participant${participants.length === 1 ? "" : "s"} in this recording`,
        `${participants.length} ${participants.length === 1 ? "شخص" : "أشخاص"} في هذا التسجيل`
    );

    return (
        <div className="vc-vrb-recording-avatars" aria-label={label} title={label}>
            {visible.map((participant, index) => {
                const name = participant.displayName || participant.username || participant.userId;
                return (
                    <span
                        key={participant.userId}
                        className="vc-vrb-recording-avatar-shell"
                        style={{ zIndex: visible.length - index }}
                        title={name}
                    >
                        {participant.avatarUrl
                            ? <img className="vc-vrb-recording-avatar" src={participant.avatarUrl} alt="" />
                            : <span className="vc-vrb-recording-avatar vc-vrb-recording-avatar-fallback">{name.slice(0, 1).toUpperCase()}</span>}
                    </span>
                );
            })}
            {overflow > 0 && <span className="vc-vrb-recording-avatar-more">+{overflow}</span>}
        </div>
    );
}

function RecordingsList({
    onSelect,
    onCount,
    limit,
    compact = false
}: {
    onSelect(recording: SavedRecording): void;
    onCount?(count: number): void;
    limit?: number;
    compact?: boolean;
}) {
    const [recordings, setRecordings] = React.useState<SavedRecording[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [editingId, setEditingId] = React.useState<string | null>(null);
    const [titleDraft, setTitleDraft] = React.useState("");
    const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());
    const [deleting, setDeleting] = React.useState(false);
    const cancelRenameRef = React.useRef(false);
    const videoExport = useVideoExportStatus();

    const refresh = React.useCallback(async () => {
        if (!settings.store.saveFolder) {
            setRecordings([]);
            onCount?.(0);
            setLoading(false);
            return;
        }
        setLoading(true);
        try {
            const next = await Native.listRecordings(settings.store.saveFolder) as SavedRecording[];
            setRecordings(next);
            setSelectedIds(new Set());
            onCount?.(next.length);
        } finally {
            setLoading(false);
        }
    }, [onCount]);

    const beginRename = React.useCallback((recording: SavedRecording) => {
        cancelRenameRef.current = false;
        setEditingId(recording.id);
        setTitleDraft(recordingTitle(recording));
    }, []);

    const commitRename = React.useCallback(async (recording: SavedRecording) => {
        const next = titleDraft.trim().replace(/\s+/g, " ").slice(0, 80);
        setEditingId(null);
        if (!next || next === recordingTitle(recording)) return;
        try {
            const savedTitle = await Native.setRecordingTitle(settings.store.saveFolder, recording.audioFilename, next);
            if (savedTitle) {
                setRecordings(current => current.map(item => item.id === recording.id
                    ? { ...item, metadata: { ...(item.metadata ?? {}), customTitle: String(savedTitle) } }
                    : item));
                toast(tr("Recording name updated.", "تم تعديل اسم التسجيل."), Toasts.Type.SUCCESS);
            }
        } catch (error) {
            toast(localizedError(error), Toasts.Type.FAILURE);
        }
    }, [titleDraft]);

    const toggleSelected = React.useCallback((recordingId: string) => {
        setSelectedIds(current => {
            const next = new Set(current);
            if (next.has(recordingId)) next.delete(recordingId);
            else next.add(recordingId);
            return next;
        });
    }, []);

    const deleteFromLibrary = React.useCallback(async (recording: SavedRecording) => {
        if (deleting) return;
        setDeleting(true);
        try {
            await Native.deleteRecording(settings.store.saveFolder, recording.audioFilename);
            const nextRecordings = recordings.filter(item => item.id !== recording.id);
            setRecordings(nextRecordings);
            onCount?.(nextRecordings.length);
            setSelectedIds(current => {
                const next = new Set(current);
                next.delete(recording.id);
                return next;
            });
            toast(tr("Recording deleted.", "تم حذف التسجيل."), Toasts.Type.SUCCESS);
        } catch (error) {
            toast(localizedError(error), Toasts.Type.FAILURE);
        } finally {
            setDeleting(false);
        }
    }, [deleting, onCount, recordings]);

    const deleteSelected = React.useCallback(async () => {
        if (deleting || selectedIds.size === 0) return;
        const targets = recordings.filter(recording => selectedIds.has(recording.id));
        if (!targets.length) return;
        setDeleting(true);
        const deletedIds = new Set<string>();
        try {

            for (const recording of targets) {
                await Native.deleteRecording(settings.store.saveFolder, recording.audioFilename);
                deletedIds.add(recording.id);
            }
            const next = recordings.filter(recording => !deletedIds.has(recording.id));
            setRecordings(next);
            setSelectedIds(new Set());
            onCount?.(next.length);
            toast(
                tr(`${deletedIds.size} recordings deleted.`, `تم حذف ${deletedIds.size} من التسجيلات.`),
                Toasts.Type.SUCCESS
            );
        } catch (error) {
            if (deletedIds.size) {
                const next = recordings.filter(recording => !deletedIds.has(recording.id));
                setRecordings(next);
                setSelectedIds(current => new Set(Array.from(current).filter(id => !deletedIds.has(id))));
                onCount?.(next.length);
            }
            toast(localizedError(error), Toasts.Type.FAILURE);
        } finally {
            setDeleting(false);
        }
    }, [deleting, onCount, recordings, selectedIds]);

    React.useEffect(() => { void refresh(); }, [refresh]);
    if (loading) return <div className="vc-vrb-empty vc-vrb-view-fade">{tr("Loading recordings…", "جارٍ تحميل التسجيلات…")}</div>;
    if (!settings.store.saveFolder) return <div className="vc-vrb-empty vc-vrb-view-fade">{tr("Choose a recordings folder in Settings first.", "اختر مجلد التسجيلات من الإعدادات أولًا.")}</div>;
    if (!recordings.length) return <div className="vc-vrb-empty vc-vrb-view-fade">{tr("No saved recordings yet.", "لا توجد تسجيلات محفوظة بعد.")}</div>;

    const visible = typeof limit === "number" ? recordings.slice(0, limit) : recordings;
    let lastDay = "";
    const allSelected = !compact && recordings.length > 0 && selectedIds.size === recordings.length;

    return (
        <>
            <div className={compact ? "vc-vrb-recording-list vc-vrb-recording-list-compact" : "vc-vrb-library-list"} role="list" aria-label={tr(`${recordings.length} saved recordings`, `${recordings.length} تسجيلات محفوظة`)}>
                {!compact && (
                <div className="vc-vrb-library-bulk-actions">
                    <button
                        type="button"
                        className={`vc-vrb-library-bulk-select ${allSelected ? "vc-vrb-library-bulk-select-active" : ""}`}
                        disabled={deleting}
                        onClick={() => setSelectedIds(allSelected ? new Set() : new Set(recordings.map(recording => recording.id)))}
                    >
                        <span className="vc-vrb-library-check-box" aria-hidden="true">{allSelected ? "✓" : ""}</span>
                        <span>{allSelected ? tr("Clear selection", "إلغاء التحديد") : tr("Select all", "تحديد الكل")}</span>
                    </button>
                    <button
                        type="button"
                        className="vc-vrb-library-bulk-delete"
                        disabled={deleting || selectedIds.size === 0}
                        onClick={() => void deleteSelected()}
                    >
                        <TrashGlyph size={13} />
                        <span>{selectedIds.size ? tr(`Delete selected (${selectedIds.size})`, `حذف المحدد (${selectedIds.size})`) : tr("Delete selected", "حذف المحدد")}</span>
                    </button>
                </div>
            )}
            {visible.map((recording, index) => {
                const dayKey = recordingDayKey(recording);
                const showDay = !compact && dayKey !== lastDay;
                const thisVideoExport = videoExport.recordingId === recording.id && videoExport.phase !== "idle";
                const exportPhase: VideoExportPhase = thisVideoExport ? videoExport.phase : "idle";
                const exportProgress = thisVideoExport ? videoExport.progress : 0;
                lastDay = dayKey;
                return (
                    <React.Fragment key={recording.id}>
                        {showDay && <div className="vc-vrb-library-day">{recordingDayLabel(recording)}</div>}
                        <div
                            role="button"
                            tabIndex={0}
                            className={`${compact ? "vc-vrb-recording-row" : "vc-vrb-library-card"} ${editingId === recording.id ? (compact ? "vc-vrb-recording-row-renaming" : "vc-vrb-library-card-renaming") : ""}`}
                            style={{ animationDelay: `${Math.min(index, 6) * 16}ms` }}
                            onClick={() => { if (editingId !== recording.id) onSelect(recording); }}
                            onKeyDown={event => {
                                if (editingId === recording.id) return;
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    onSelect(recording);
                                }
                            }}
                            aria-label={recordingTitle(recording)}
                        >
                            {!compact && <RecordingParticipantStack recording={recording} />}
                            <span className={compact ? "vc-vrb-recording-main" : "vc-vrb-library-card-main"}>
                                {editingId === recording.id ? (
                                    <input
                                        className="vc-vrb-recording-rename-input"
                                        value={titleDraft}
                                        maxLength={80}
                                        autoFocus
                                        onClick={event => event.stopPropagation()}
                                        onContextMenu={event => event.stopPropagation()}
                                        onChange={event => setTitleDraft(event.currentTarget.value)}
                                        onBlur={() => {
                                            if (cancelRenameRef.current) {
                                                cancelRenameRef.current = false;
                                                return;
                                            }
                                            void commitRename(recording);
                                        }}
                                        onKeyDown={event => {
                                            event.stopPropagation();
                                            if (event.key === "Enter") {
                                                event.preventDefault();
                                                event.currentTarget.blur();
                                            } else if (event.key === "Escape") {
                                                event.preventDefault();
                                                cancelRenameRef.current = true;
                                                setEditingId(null);
                                            }
                                        }}
                                        aria-label={tr("Rename recording", "تعديل اسم التسجيل")}
                                    />
                                ) : (
                                    <span className={compact ? "vc-vrb-recording-title-row" : "vc-vrb-library-card-title-row"}>
                                        <span className={compact ? "vc-vrb-recording-title" : "vc-vrb-library-card-title"}>{recordingTitle(recording)}</span>
                                        <span className="vc-vrb-library-item-actions">
                                            <Tooltip text={tr("Rename recording", "تعديل اسم التسجيل")} position="top">
                                                {(props: any) => (
                                                    <button
                                                        {...props}
                                                        type="button"
                                                        className="vc-vrb-recording-edit-button"
                                                        onClick={event => {
                                                            event.stopPropagation();
                                                            beginRename(recording);
                                                        }}
                                                        onKeyDown={event => event.stopPropagation()}
                                                        aria-label={tr("Rename recording", "تعديل اسم التسجيل")}
                                                    >
                                                        <EditRecordingGlyph />
                                                    </button>
                                                )}
                                            </Tooltip>
                                            {!compact && (
                                                <Tooltip text={selectedIds.has(recording.id) ? tr("Unselect recording", "إلغاء تحديد التسجيل") : tr("Select recording", "تحديد التسجيل")} position="top">
                                                    {(props: any) => (
                                                        <button
                                                            {...props}
                                                            type="button"
                                                            className={`vc-vrb-library-select-one ${selectedIds.has(recording.id) ? "vc-vrb-library-select-one-active" : ""}`}
                                                            aria-pressed={selectedIds.has(recording.id)}
                                                            onClick={event => {
                                                                event.stopPropagation();
                                                                toggleSelected(recording.id);
                                                            }}
                                                            onKeyDown={event => event.stopPropagation()}
                                                        >
                                                            {selectedIds.has(recording.id) ? "✓" : ""}
                                                        </button>
                                                    )}
                                                </Tooltip>
                                            )}
                                        </span>
                                    </span>
                                )}
                                <span className={compact ? "vc-vrb-recording-date" : "vc-vrb-library-card-date"}>{formatRecordingDate(recording)}</span>
                            </span>
                            <span className={compact ? "vc-vrb-recording-side" : "vc-vrb-library-card-side"}>
                                {!compact && (
                                    <span className="vc-vrb-library-card-side-actions">
                                        <Tooltip text={exportPhase === "exporting"
                                            ? tr(`Exporting video… ${Math.round(exportProgress * 100)}%`, `جارٍ تصدير الفيديو… ${Math.round(exportProgress * 100)}٪`)
                                            : tr("Export recording as video", "تصدير التسجيل كفيديو")} position="top">
                                            {(props: any) => (
                                                <button
                                                    {...props}
                                                    type="button"
                                                    className={`vc-vrb-library-card-export vc-vrb-video-export-${exportPhase}`}
                                                    style={{ "--vc-vrb-export-progress": `${Math.round(exportProgress * 100)}%` } as any}
                                                    disabled={videoExport.phase === "exporting"}
                                                    onClick={event => {
                                                        event.stopPropagation();
                                                        void startManagedVideoExport(recording);
                                                    }}
                                                    onKeyDown={event => event.stopPropagation()}
                                                    aria-label={tr("Export recording as video", "تصدير التسجيل كفيديو")}
                                                >
                                                    <VideoSaveGlyph />
                                                    <i aria-hidden="true"><b /></i>
                                                </button>
                                            )}
                                        </Tooltip>
                                        <Tooltip text={tr("Delete recording", "حذف التسجيل")} position="top">
                                            {(props: any) => (
                                                <button
                                                    {...props}
                                                    type="button"
                                                    className="vc-vrb-library-delete-one vc-vrb-library-delete-one-side"
                                                    disabled={deleting}
                                                    onClick={event => {
                                                        event.stopPropagation();
                                                        void deleteFromLibrary(recording);
                                                    }}
                                                    onKeyDown={event => event.stopPropagation()}
                                                    aria-label={tr("Delete recording", "حذف التسجيل")}
                                                >
                                                    <TrashGlyph size={13} />
                                                </button>
                                            )}
                                        </Tooltip>
                                    </span>
                                )}
                                <span className={compact ? "vc-vrb-recording-duration" : "vc-vrb-library-card-duration"}>{formatDuration(recordingDuration(recording))}</span>
                                <span className={compact ? "vc-vrb-recording-format" : "vc-vrb-library-card-format"}>{recording.format.toUpperCase()}</span>
                            </span>
                        </div>
                    </React.Fragment>
                );
            })}
            </div>
        </>
    );
}

function PanelCloseButton({ onClick, label }: { onClick(): void; label: string; }) {
    return (
        <button type="button" className="vc-vrb-panel-close" onClick={onClick} aria-label={label}>
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                <path fill="currentColor" d="M6.4 5a1 1 0 0 0-1.4 1.4l5.6 5.6L5 17.6A1 1 0 1 0 6.4 19l5.6-5.6 5.6 5.6a1 1 0 0 0 1.4-1.4L13.4 12 19 6.4A1 1 0 0 0 17.6 5L12 10.6 6.4 5Z" />
            </svg>
        </button>
    );
}

function RecordingsLibraryView({
    onBack,
    onClose,
    onSelect,
    onCount,
    refreshKey
}: {
    onBack(): void;
    onClose(): void;
    onSelect(recording: SavedRecording): void;
    onCount(count: number): void;
    refreshKey: number;
}) {
    return (
        <div className="vc-vrb-view vc-vrb-library-view">
            <div className="vc-vrb-view-header vc-vrb-library-header vc-vrb-view-header-has-close">
                <button type="button" className="vc-vrb-back" onClick={onBack} aria-label={tr("Back", "رجوع")}>{localizedBackGlyph()}</button>
                <div className="vc-vrb-library-header-copy">
                    <div className="vc-vrb-library-header-title-row">
                        <div className="vc-vrb-player-title">{tr("Recordings", "التسجيلات")}</div>
                        <PanelDeveloperCredit />
                    </div>
                    <div className="vc-vrb-player-meta">{tr("Voice Replay library", "مكتبة Voice Replay")}</div>
                </div>
                <PanelCloseButton onClick={onClose} label={tr("Close recordings", "إغلاق التسجيلات")} />
            </div>
            <RecordingsList key={refreshKey} onSelect={onSelect} onCount={onCount} />
        </div>
    );
}


function PanelDeveloperCredit() {
    const [author, setAuthor] = React.useState<any>(null);

    React.useEffect(() => {
        let cancelled = false;
        void UserUtils.getUser(AUTHOR_ID).then(user => {
            if (!cancelled) setAuthor(user);
        }).catch(() => void 0);
        return () => { cancelled = true; };
    }, []);

    let avatarUrl: string | null = null;
    try {
        avatarUrl = author?.getAvatarURL?.(undefined, 48, true) ?? null;
    } catch {
        avatarUrl = null;
    }

    return (
        <Tooltip text={tr("open Discord profile", "فتح بروفايل دسكورد")} position="top">
            {(props: any) => (
                <button
                    {...props}
                    type="button"
                    className="vc-vrb-panel-developer-user vc-vrb-panel-developer-user-top"
                    onClick={() => void openUserProfile(AUTHOR_ID)}
                >
                    {avatarUrl
                        ? <img className="vc-vrb-panel-developer-avatar" src={avatarUrl} alt="" />
                        : <span className="vc-vrb-panel-developer-avatar vc-vrb-panel-developer-fallback">a</span>}
                    <span className="vc-vrb-panel-developer-name">{author?.username ?? "at.b"}</span>
                </button>
            )}
        </Tooltip>
    );
}

function SmoothPanelStage({ viewKey, children }: { viewKey: string; children: ReactNode; }) {
    const shellRef = React.useRef<HTMLDivElement | null>(null);
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    const previousHeightRef = React.useRef<number | null>(null);

    React.useLayoutEffect(() => {
        const shell = shellRef.current;
        const content = contentRef.current;
        if (!shell || !content) return;

        const nextHeight = content.getBoundingClientRect().height;
        const previousHeight = previousHeightRef.current;
        previousHeightRef.current = nextHeight;

        if (previousHeight == null || Math.abs(previousHeight - nextHeight) < 1) {
            shell.style.height = "auto";
            return;
        }

        shell.style.transition = "none";
        shell.style.height = `${previousHeight}px`;

        void shell.offsetHeight;
        shell.style.transition = "height 360ms cubic-bezier(.16,1,.3,1)";
        shell.style.height = `${nextHeight}px`;

        const timer = window.setTimeout(() => {
            if (shellRef.current) {
                shellRef.current.style.transition = "";
                shellRef.current.style.height = "auto";
            }
        }, 390);
        return () => window.clearTimeout(timer);
    }, [viewKey]);

    return (
        <div ref={shellRef} className="vc-vrb-stage">
            <div ref={contentRef} key={viewKey} className={`vc-vrb-stage-view vc-vrb-stage-${viewKey}`}>
                {children}
            </div>
        </div>
    );
}

function PluginLanguageSwitch({ compact = false }: { compact?: boolean; }) {
    const language = usePluginLanguage();
    const setLanguage = (next: PluginLanguage) => {
        if (language === next) return;
        settings.store.language = next;
    };

    return (
        <div className={`vc-vrb-language-switch ${compact ? "vc-vrb-language-switch-compact" : ""}`} role="group" aria-label={tr("Voice Replay language", "لغة Voice Replay")}>
            <button type="button" className={language === "ar" ? "vc-vrb-language-active" : ""} aria-pressed={language === "ar"} onClick={() => setLanguage("ar")}>العربية</button>
            <button type="button" className={language === "en" ? "vc-vrb-language-active" : ""} aria-pressed={language === "en"} onClick={() => setLanguage("en")}>English</button>
        </div>
    );
}

function QuickSettingsView({ onBack }: { onBack(): void; }) {
    const store = settings.use(["bufferCapacitySeconds", "format", "autoStart", "includeMicrophone", "notifications", "saveFolder"]);
    const [bufferInput, setBufferInput] = React.useState(() => String(store.bufferCapacitySeconds));

    React.useEffect(() => {
        setBufferInput(String(store.bufferCapacitySeconds));
    }, [store.bufferCapacitySeconds]);

    const commitBufferCapacity = () => {
        const parsed = Math.floor(Number(bufferInput));
        const next = Number.isFinite(parsed) ? Math.min(3600, Math.max(10, parsed)) : bufferCapacitySeconds();
        settings.store.bufferCapacitySeconds = next;
        voiceRecorder.setMaxBufferSeconds(next);
        setBufferInput(String(next));
    };

    const resetBufferCapacity = () => {
        const next = 600;
        settings.store.bufferCapacitySeconds = next;
        voiceRecorder.setMaxBufferSeconds(next);
        setBufferInput(String(next));
    };

    return (
        <div className="vc-vrb-view vc-vrb-settings-view vc-vrb-merged-settings-view">
            <div className="vc-vrb-view-header">
                <PanelCloseButton onClick={onBack} label={tr("Close settings", "إغلاق الإعدادات")} />
                <div className="vc-vrb-settings-header-copy">
                    <div className="vc-vrb-settings-header-title-row">
                        <div className="vc-vrb-player-title">{tr("Settings", "الإعدادات")}</div>
                        <PanelDeveloperCredit />
                    </div>
                    <div className="vc-vrb-player-meta">Voice Replay</div>
                </div>
            </div>

            <div className="vc-vrb-merged-settings-scroll">
                <div className="vc-vrb-merged-setting-row vc-vrb-merged-language-row">
                    <span className="vc-vrb-merged-setting-label">{tr("Language", "اللغة")}</span>
                    <PluginLanguageSwitch compact />
                </div>

                <div className="vc-vrb-merged-setting-row">
                    <span className="vc-vrb-merged-setting-label">{tr("Rolling buffer", "مدة التسجيل المؤقت")}</span>
                    <div className="vc-vrb-full-number-wrap vc-vrb-buffer-capacity-controls">
                        <button
                            type="button"
                            className="vc-vrb-buffer-reset"
                            onClick={resetBufferCapacity}
                        >
                            {tr("Reset", "إعادة تعيين")}
                        </button>
                        <div className="vc-vrb-buffer-number-field">
                            <input
                                className="vc-vrb-full-number"
                                type="number"
                                min={10}
                                max={3600}
                                step={1}
                                value={bufferInput}
                                onChange={event => setBufferInput(event.currentTarget.value)}
                                onBlur={commitBufferCapacity}
                                onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
                            />
                            <span>{tr("sec", "ث")}</span>
                        </div>
                    </div>
                </div>

                <div className="vc-vrb-merged-setting-row">
                    <span className="vc-vrb-merged-setting-label">{tr("Recording format", "صيغة التسجيل")}</span>
                    <RecordingFormatSelect
                        value={store.format as RecordingFormat}
                        onChange={value => { settings.store.format = value; }}
                    />
                </div>

                <div className="vc-vrb-merged-setting-row">
                    <span className="vc-vrb-merged-setting-label">{tr("Auto-start in voice", "التشغيل التلقائي عند دخول الروم")}</span>
                    <FullSettingsToggle
                        checked={Boolean(store.autoStart)}
                        label={tr("Auto-start in voice", "التشغيل التلقائي عند دخول الروم")}
                        onChange={value => { settings.store.autoStart = value; }}
                    />
                </div>

                <div className="vc-vrb-merged-setting-row">
                    <Tooltip text={tr("Adds your voice to the recording.", "يضيف صوتك إلى التسجيل.")} position="top">
                        {(props: any) => <span {...props} className="vc-vrb-merged-setting-label vc-vrb-quick-setting-help">{tr("Include your voice", "تضمين صوتك")}</span>}
                    </Tooltip>
                    <FullSettingsToggle
                        checked={store.includeMicrophone !== false}
                        label={tr("Include your voice", "تضمين صوتك")}
                        onChange={value => {
                            settings.store.includeMicrophone = value;
                            void voiceRecorder.setMicrophoneEnabled(value, MediaEngineStore.getInputDeviceId?.() ?? null);
                        }}
                    />
                </div>

                <div className="vc-vrb-merged-setting-row">
                    <Tooltip text={tr("Shows a notification when Voice Replay starts, stops or saves.", "يعرض إشعارًا عند التشغيل والإيقاف والحفظ.")} position="top">
                        {(props: any) => <span {...props} className="vc-vrb-merged-setting-label vc-vrb-quick-setting-help">{tr("Notifications", "الإشعارات")}</span>}
                    </Tooltip>
                    <FullSettingsToggle
                        checked={Boolean(store.notifications)}
                        label={tr("Notifications", "الإشعارات")}
                        onChange={value => { settings.store.notifications = value; }}
                    />
                </div>

                <div className="vc-vrb-merged-setting-row vc-vrb-merged-folder-row">
                    <span className="vc-vrb-merged-setting-label">{tr("Recordings folder", "مجلد التسجيلات")}</span>
                    <div className="vc-vrb-merged-folder-actions">
                        <button type="button" className="vc-vrb-merged-action vc-vrb-merged-action-primary" onClick={() => void chooseFolder()}>{tr("Choose", "اختيار")}</button>
                        <button type="button" className="vc-vrb-merged-action" disabled={!store.saveFolder} onClick={() => void Native.openFolder(settings.store.saveFolder)}>{tr("Open", "فتح")}</button>
                    </div>
                </div>
            </div>
        </div>
    );
}


function ToggleShortcutButton() {
    const [capturing, setCapturing] = React.useState(false);
    const shortcutRef = React.useRef<HTMLSpanElement | null>(null);
    const shortcut = String(settings.store.toggleShortcut || "Ctrl+Shift+F7");

    const stopCapturing = React.useCallback(() => {
        capturingToggleShortcut = false;
        setCapturing(false);
    }, []);

    const beginCapturing = React.useCallback(() => {
        capturingToggleShortcut = true;
        setCapturing(true);
        window.setTimeout(() => shortcutRef.current?.focus(), 0);
    }, []);

    React.useEffect(() => () => { capturingToggleShortcut = false; }, []);

    return (
        <span
            ref={shortcutRef}
            role="button"
            tabIndex={0}
            className={`vc-vrb-shortcut-button vc-vrb-shortcut-button-embedded ${capturing ? "vc-vrb-shortcut-listening" : ""}`}
            onPointerDown={event => {
                event.preventDefault();
                event.stopPropagation();
            }}
            onClick={event => {
                event.preventDefault();
                event.stopPropagation();
                beginCapturing();
            }}
            onBlur={() => {
                if (capturing) stopCapturing();
            }}
            onKeyDown={event => {
                event.stopPropagation();
                if (!capturing) {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        beginCapturing();
                    }
                    return;
                }
                event.preventDefault();
                if (event.key === "Escape") {
                    stopCapturing();
                    return;
                }
                const next = shortcutFromEvent(event.nativeEvent);
                if (!next) return;
                settings.store.toggleShortcut = next;
                stopCapturing();
                toast(tr(`Voice Replay shortcut: ${next}`, `اختصار Voice Replay: ${next}`), Toasts.Type.SUCCESS);
            }}
            aria-label={tr("Voice Replay keyboard shortcut", "اختصار تسجيل الصوت")}
        >
            <span className="vc-vrb-shortcut-value">{capturing ? tr("Press…", "اضغط…") : shortcut.replace(/\+/g, " + ")}</span>
            <span className="vc-vrb-shortcut-inline-hint" aria-hidden="true">
                {tr("Choose a shortcut to save audio", "حدد اختصارًا لحفظ الصوت")}
            </span>
        </span>
    );
}

function ReplayPopover({ onOpenRecordings }: { onOpenRecordings(): void; }) {
    const language = usePluginLanguage();
    const status = useRecorderStatus();
    const customSaveStore = settings.use(["customSaveMinutes"]);
    const [savingSeconds, setSavingSeconds] = React.useState<number | null>(null);
    const [savedSeconds, setSavedSeconds] = React.useState<number | null>(null);
    const [customDurationOpen, setCustomDurationOpen] = React.useState(false);
    const configuredCustomMinutes = Math.floor(Number(customSaveStore.customSaveMinutes));
    const customConfigured = Number.isFinite(configuredCustomMinutes) && configuredCustomMinutes >= 1 && configuredCustomMinutes <= 60;
    const [customMinutesDraft, setCustomMinutesDraft] = React.useState(() => customConfigured ? String(configuredCustomMinutes) : "");
    const customDurationRef = React.useRef<HTMLDivElement | null>(null);
    const hasAudio = status.armed && status.bufferedSeconds >= .1;
    const readyDurations = availableSaveDurations(status);
    const primarySaveLabel = readyDurations.length > 1
        ? tr("Choose duration", "اختر المدة")
        : readyDurations.length === 1
            ? tr(`Save ${formatDuration(readyDurations[0])}`, `حفظ ${formatDuration(readyDurations[0])}`)
            : tr("Save replay", "حفظ التسجيل");
    const customSeconds = customConfigured ? configuredCustomMinutes * 60 : 0;
    const customDurationReady = customConfigured && hasAudio && status.bufferedSeconds + .02 >= customSeconds;
    const parsedCustomMinutesDraft = Math.floor(Number(customMinutesDraft));
    const customDraftValid = Number.isFinite(parsedCustomMinutesDraft) && parsedCustomMinutesDraft >= 1 && parsedCustomMinutesDraft <= 60;
    React.useEffect(() => {
        if (!customDurationOpen) return;
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (target && !customDurationRef.current?.contains(target)) setCustomDurationOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [customDurationOpen]);

    const openCustomDurationEditor = React.useCallback(() => {
        if (savingSeconds != null) return;
        setCustomMinutesDraft(customConfigured ? String(configuredCustomMinutes) : "");
        setCustomDurationOpen(true);
    }, [configuredCustomMinutes, customConfigured, savingSeconds]);

    const commitCustomDuration = React.useCallback(() => {
        if (!customDraftValid) return;
        const minutes = parsedCustomMinutesDraft;
        const seconds = minutes * 60;
        settings.store.customSaveMinutes = minutes;



        if (seconds > bufferCapacitySeconds()) {
            settings.store.bufferCapacitySeconds = seconds;
            voiceRecorder.setMaxBufferSeconds(seconds);
        }

        setCustomDurationOpen(false);
    }, [customDraftValid, parsedCustomMinutesDraft]);

    const resetCustomDuration = React.useCallback(() => {
        settings.store.customSaveMinutes = 0;
        setCustomMinutesDraft("");
        setCustomDurationOpen(false);
    }, []);

    const saveFromButton = React.useCallback(async (seconds: number) => {
        if (savingSeconds != null) return;
        setSavingSeconds(seconds);
        const result = await saveLatestClip(seconds);
        setSavingSeconds(null);
        if (!result) return;
        setSavedSeconds(seconds);
        window.setTimeout(() => setSavedSeconds(current => current === seconds ? null : current), 900);
    }, [savingSeconds]);

    return (
        <div className={`vc-vrb-popout ${status.armed ? "vc-vrb-popout-running" : "vc-vrb-popout-stopped"} ${customDurationOpen ? "vc-vrb-popout-custom-duration" : ""}`} dir={language === "ar" ? "rtl" : "ltr"}>
            <SmoothPanelStage viewKey={customDurationOpen ? "custom-duration" : "home"}>
                {customDurationOpen ? (
                    <div ref={customDurationRef} className="vc-vrb-view vc-vrb-custom-duration-screen">
                        <div className="vc-vrb-custom-duration-screen-header">
                            <button
                                type="button"
                                className="vc-vrb-back vc-vrb-custom-duration-back"
                                onClick={() => setCustomDurationOpen(false)}
                                aria-label={tr("Back", "رجوع")}
                            >
                                {localizedBackGlyph()}
                            </button>
                            <div className="vc-vrb-custom-duration-screen-title">{tr("Set duration", "حدد مدة")}</div>
                        </div>
                        <div className="vc-vrb-custom-duration-screen-controls">
                            <div className="vc-vrb-custom-duration-input-wrap">
                                <input
                                    autoFocus
                                    className="vc-vrb-custom-duration-input"
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    max={60}
                                    step={1}
                                    placeholder="15"
                                    value={customMinutesDraft}
                                    onChange={event => setCustomMinutesDraft(event.currentTarget.value)}
                                    onKeyDown={event => {
                                        if (event.key === "Escape") setCustomDurationOpen(false);
                                        if (event.key === "Enter" && customDraftValid) {
                                            event.preventDefault();
                                            commitCustomDuration();
                                        }
                                    }}
                                    aria-label={tr("Minutes", "الدقائق")}
                                />
                                <span>{tr("min", "د")}</span>
                            </div>
                            <button
                                type="button"
                                className="vc-vrb-custom-duration-save"
                                disabled={!customDraftValid}
                                onClick={commitCustomDuration}
                            >
                                {tr("Apply", "اعتماد")}
                            </button>
                        </div>
                        {customConfigured && (
                            <button
                                type="button"
                                className="vc-vrb-custom-duration-reset"
                                onClick={resetCustomDuration}
                            >
                                {tr("Reset duration", "إزالة المدة")}
                            </button>
                        )}
                    </div>
                ) : (
                <div className="vc-vrb-view vc-vrb-view-back">
            <div className="vc-vrb-popout-header">
                <div className="vc-vrb-header-main">
                    <div className="vc-vrb-title-row">
                        <div className="vc-vrb-popout-title">Voice Replay</div>
                        <PanelDeveloperCredit />
                    </div>
                </div>
                <div className="vc-vrb-session-controls">
                    <button
                        type="button"
                        className={`vc-vrb-session-toggle ${status.armed ? "vc-vrb-session-toggle-stop" : "vc-vrb-session-toggle-start"}`}
                        onClick={() => void toggleRecorder()}
                        aria-label={status.armed ? tr("Stop Voice Replay", "إيقاف Voice Replay") : tr("Start Voice Replay", "تشغيل Voice Replay")}
                    >
                        <span className="vc-vrb-session-toggle-icon" aria-hidden="true" />
                        <span>{status.armed ? tr("Stop", "إيقاف") : tr("Start", "تشغيل")}</span>
                    </button>
                    <Tooltip text={status.armed ? tr("Recording now", "يسجل الآن") : tr("Stopped", "متوقف")} position="top">
                        {(tooltipProps: any) => (
                            <span
                                {...tooltipProps}
                                className={`vc-vrb-session-live-dot ${status.armed ? "vc-vrb-session-live-dot-on" : "vc-vrb-session-live-dot-off"}`}
                                role="status"
                                aria-label={status.armed ? tr("Recording now", "يسجل الآن") : tr("Stopped", "متوقف")}
                            />
                        )}
                    </Tooltip>
                </div>
            </div>

            <div className="vc-vrb-recorder-control vc-vrb-recorder-control-simple vc-vrb-recorder-control-dual">
                <div className={`vc-vrb-toggle-composite ${status.armed ? "vc-vrb-toggle-composite-on" : "vc-vrb-toggle-composite-off"}`}>
                    <button
                        type="button"
                        className="vc-vrb-toggle-button vc-vrb-toggle-button-wide vc-vrb-save-action-button"
                        onClick={requestReplaySave}
                        aria-label={primarySaveLabel}
                    >
                        <span className="vc-vrb-save-action-glyph" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M5 3h12l2 2v16H5V3Zm2 2v5h9V5H7Zm1 10v4h8v-4H8Z" /></svg>
                        </span>
                        <span className="vc-vrb-toggle-label">{primarySaveLabel}</span>
                    </button>
                    <ToggleShortcutButton />
                </div>
                <button
                    type="button"
                    className="vc-vrb-recordings-control-button"
                    onClick={onOpenRecordings}
                    aria-label={tr("Recordings", "التسجيلات")}
                    data-vrb-tooltip={tr("Recordings", "التسجيلات")}
                >
                    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M7.25 3.75h6.4l4.6 4.6v10.4A1.75 1.75 0 0 1 16.5 20.5h-9a1.75 1.75 0 0 1-1.75-1.75V5.5A1.75 1.75 0 0 1 7.5 3.75Z" />
                        <path d="M13.25 4v4.75H18" />
                        <path d="M8.25 14.25h1.1m1.05-2.25v4.5m2-6.25v8m2-5.25v4.5m1.05-2.25h.3" />
                    </svg>
                </button>
            </div>

            <div className="vc-vrb-section-title">
                <span>{tr("Save newest audio", "حفظ آخر مدة")}</span>
                <span>{status.armed ? tr(`up to ${formatDuration(status.maxBufferSeconds)}`, `حتى ${formatDuration(status.maxBufferSeconds)}`) : tr("start first", "شغّل أولًا")}</span>
            </div>
            {status.armed ? (
                <div className="vc-vrb-save-grid">
                    {QUICK_SAVE_DURATIONS
                        .filter(seconds => seconds <= status.maxBufferSeconds)
                        .map(seconds => {
                            const exactReady = hasAudio && status.bufferedSeconds + .02 >= seconds;
                            const isSaving = savingSeconds === seconds;
                            const isSaved = savedSeconds === seconds;
                            return (
                                <Tooltip key={seconds} text={exactReady ? tr(`Save exactly the newest ${formatDuration(seconds)}`, `حفظ آخر ${formatDuration(seconds)} بالضبط`) : tr(`Needs a full ${formatDuration(seconds)} in the rolling buffer`, `يلزم توفر ${formatDuration(seconds)} كاملة في التسجيل المؤقت`)} position="top">
                                    {(props: any) => (
                                        <button
                                            {...props}
                                            type="button"
                                            className={`vc-vrb-save-chip ${isSaving ? "vc-vrb-save-chip-saving" : ""} ${isSaved ? "vc-vrb-save-chip-saved" : ""}`}
                                            disabled={!exactReady || savingSeconds != null}
                                            onClick={() => void saveFromButton(seconds)}
                                        >
                                            <span className="vc-vrb-save-chip-label">{isSaved ? tr("Saved", "تم الحفظ") : formatDuration(seconds)}</span>
                                            {isSaved && <svg className="vc-vrb-chip-check" viewBox="0 0 18 18" aria-hidden="true"><path d="M3.5 9.2 7.2 12.6 14.6 5.7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                                        </button>
                                    )}
                                </Tooltip>
                            );
                        })}
                    <div ref={customDurationRef} className={`vc-vrb-custom-duration ${customDurationOpen ? "vc-vrb-custom-duration-open" : ""}`}>
                        {customConfigured ? (
                            <div className="vc-vrb-custom-duration-composite">
                                <Tooltip
                                    text={customDurationReady
                                        ? tr(`Save exactly the newest ${formatDuration(customSeconds)}`, `حفظ آخر ${formatDuration(customSeconds)} بالضبط`)
                                        : tr(`Activates when ${formatDuration(customSeconds)} are buffered`, `يتفعّل عند توفر ${formatDuration(customSeconds)} كاملة`)}
                                    position="top"
                                >
                                    {(props: any) => (
                                        <button
                                            {...props}
                                            type="button"
                                            className={`vc-vrb-save-chip vc-vrb-save-chip-custom-value ${savingSeconds === customSeconds ? "vc-vrb-save-chip-saving" : ""} ${savedSeconds === customSeconds ? "vc-vrb-save-chip-saved" : ""}`}
                                            disabled={!customDurationReady || savingSeconds != null}
                                            onClick={() => void saveFromButton(customSeconds)}
                                        >
                                            <span className="vc-vrb-save-chip-label">{savedSeconds === customSeconds ? tr("Saved", "تم الحفظ") : formatDuration(customSeconds)}</span>
                                            {savedSeconds === customSeconds && <svg className="vc-vrb-chip-check" viewBox="0 0 18 18" aria-hidden="true"><path d="M3.5 9.2 7.2 12.6 14.6 5.7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                                        </button>
                                    )}
                                </Tooltip>
                                <Tooltip text={tr("Change custom duration", "تغيير مدة الحفظ")} position="top">
                                    {(props: any) => (
                                        <button
                                            {...props}
                                            type="button"
                                            className="vc-vrb-custom-duration-edit"
                                            aria-expanded={customDurationOpen}
                                            onClick={openCustomDurationEditor}
                                        >
                                            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M16.9 3.6a2.1 2.1 0 0 1 3 3L8.2 18.3 4 19.4l1.1-4.2L16.9 3.6Zm-10 12.6-.4 1.3 1.3-.4 9.1-9.1-1-1-9 9.2Z"/></svg>
                                        </button>
                                    )}
                                </Tooltip>
                            </div>
                        ) : (
                            <Tooltip text={tr("Set a custom save duration in minutes.", "حدد مدة مخصصة للحفظ بالدقائق.")} position="top">
                                {(props: any) => (
                                    <button
                                        {...props}
                                        type="button"
                                        className="vc-vrb-save-chip vc-vrb-save-chip-custom"
                                        disabled={savingSeconds != null}
                                        aria-expanded={customDurationOpen}
                                        onClick={openCustomDurationEditor}
                                    >
                                        <span className="vc-vrb-custom-duration-icon" aria-hidden="true">＋</span>
                                        <span>{tr("Set time", "حدد مدة")}</span>
                                    </button>
                                )}
                            </Tooltip>
                        )}
                    </div>
                </div>
            ) : (
                <div className="vc-vrb-save-off-note">{tr("Start Voice Replay to enable saving.", "شغّل Voice Replay لتفعيل الحفظ.")}</div>
            )}

                </div>
                )}
            </SmoothPanelStage>
        </div>
    );
}


function VoiceReplayFloatingLayer({
    anchorRef,
    onClose,
    onOpenRecordings,
    closing = false
}: {
    anchorRef: { current: HTMLButtonElement | null };
    onClose(): void;
    onOpenRecordings(): void;
    closing?: boolean;
}) {
    const layerRef = React.useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = React.useState({ left: 8, bottom: 8 });

    const updatePosition = React.useCallback(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;
        const anchorRect = anchor.getBoundingClientRect();
        const panelWidth = 330;
        const gap = 9;
        const anchorCenter = anchorRect.left + anchorRect.width / 2;



        const left = Math.min(
            Math.max(8, anchorCenter - panelWidth / 2),
            Math.max(8, window.innerWidth - panelWidth - 8)
        );
        const bottom = Math.max(8, window.innerHeight - anchorRect.top + gap);
        setPosition({ left, bottom });
    }, [anchorRef]);

    React.useLayoutEffect(() => {
        updatePosition();
        const onMove = () => updatePosition();
        window.addEventListener("resize", onMove);
        window.addEventListener("scroll", onMove, true);
        return () => {
            window.removeEventListener("resize", onMove);
            window.removeEventListener("scroll", onMove, true);
        };
    }, [updatePosition]);

    React.useEffect(() => {
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (!target || layerRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
            onClose();
        };
        const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [anchorRef, onClose]);

    return ReactDOM.createPortal(
        <div
            ref={layerRef}
            className={`vc-vrb-floating-layer vc-vrb-main-floating-layer ${closing ? "vc-vrb-main-layer-closing" : ""}`}
            style={{ left: `${position.left}px`, bottom: `${position.bottom}px` }}
        >
            <ReplayPopover onOpenRecordings={onOpenRecordings} />
        </div>,
        document.body
    );
}


type DetachedPanelView = "settings" | "recordings";

function DetachedVoiceReplayPanel({ view, onClose, onBackToMain }: { view: DetachedPanelView; onClose(): void; onBackToMain(): void; }) {
    const language = usePluginLanguage();
    const [selected, setSelected] = React.useState<SavedRecording | null>(null);
    const [libraryKey, setLibraryKey] = React.useState(0);
    const [, setRecordingCount] = React.useState(0);

    if (view === "settings") {
        return (
            <div className="vc-vrb-popout" dir={language === "ar" ? "rtl" : "ltr"}>
                <SmoothPanelStage viewKey="detached-settings">
                    <QuickSettingsView onBack={onClose} />
                </SmoothPanelStage>
            </div>
        );
    }

    if (selected) {
        return (
            <div className="vc-vrb-popout vc-vrb-popout-player" dir={language === "ar" ? "rtl" : "ltr"}>
                <SmoothPanelStage viewKey="detached-player">
                    <div className="vc-vrb-view vc-vrb-view-forward">
                        <RecordingPlayer
                            recording={selected}
                            onBack={() => setSelected(null)}
                            onDeleted={() => {
                                setSelected(null);
                                setLibraryKey(key => key + 1);
                            }}
                        />
                    </div>
                </SmoothPanelStage>
            </div>
        );
    }

    return (
        <div className="vc-vrb-popout vc-vrb-popout-library" dir={language === "ar" ? "rtl" : "ltr"}>
            <SmoothPanelStage viewKey="detached-library">
                <RecordingsLibraryView
                    onBack={onBackToMain}
                    onClose={onClose}
                    onSelect={setSelected}
                    onCount={setRecordingCount}
                    refreshKey={libraryKey}
                />
            </SmoothPanelStage>
        </div>
    );
}

function findVoicePanelContainer(anchor: HTMLElement): HTMLElement | null {
    let node: HTMLElement | null = anchor;
    let best: HTMLElement | null = null;

    for (let depth = 0; node && node !== document.body && depth < 12; depth++, node = node.parentElement) {
        const rect = node.getBoundingClientRect();
        const nearBottom = rect.bottom >= window.innerHeight - 24;
        const lowerLeftPanelSized = rect.width >= 220 && rect.width <= 430 && rect.height >= 42 && rect.height <= 560;
        if (nearBottom && lowerLeftPanelSized) best = node;
    }

    return best;
}

function VoiceReplayDetachedFloatingLayer({
    anchorRef,
    view,
    onClose,
    onBackToMain
}: {
    anchorRef: { current: HTMLButtonElement | null };
    view: DetachedPanelView;
    onClose(): void;
    onBackToMain(): void;
}) {
    const layerRef = React.useRef<HTMLDivElement | null>(null);
    const closeTimerRef = React.useRef<number | null>(null);
    const [position, setPosition] = React.useState({ left: 8, bottom: 8 });
    const [closing, setClosing] = React.useState(false);

    const finishAfterExit = React.useCallback((action: () => void) => {
        if (closing) return;
        setClosing(true);
        if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = window.setTimeout(action, 190);
    }, [closing]);

    const requestClose = React.useCallback(() => finishAfterExit(onClose), [finishAfterExit, onClose]);
    const requestBackToMain = React.useCallback(() => finishAfterExit(onBackToMain), [finishAfterExit, onBackToMain]);

    React.useEffect(() => () => {
        if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    }, []);

    const updatePosition = React.useCallback(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;
        const anchorRect = anchor.getBoundingClientRect();
        const voicePanel = findVoicePanelContainer(anchor);
        const panelRect = voicePanel?.getBoundingClientRect() ?? anchorRect;
        const panelWidth = 330;
        const gap = 10;



        let left = panelRect.right + gap;
        let bottom = Math.max(8, window.innerHeight - panelRect.bottom);
        if (left + panelWidth > window.innerWidth - 8) {
            left = Math.max(8, window.innerWidth - panelWidth - 8);
            bottom = Math.max(8, window.innerHeight - panelRect.top + gap);
        }
        setPosition({ left, bottom });
    }, [anchorRef]);

    React.useLayoutEffect(() => {
        updatePosition();
        const onMove = () => updatePosition();
        window.addEventListener("resize", onMove);
        window.addEventListener("scroll", onMove, true);
        return () => {
            window.removeEventListener("resize", onMove);
            window.removeEventListener("scroll", onMove, true);
        };
    }, [updatePosition]);

    React.useEffect(() => {
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (!target || layerRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
            requestClose();
        };
        const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") requestClose(); };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [anchorRef, requestClose]);

    return ReactDOM.createPortal(
        <div
            ref={layerRef}
            className={`vc-vrb-floating-layer vc-vrb-detached-floating-layer vc-vrb-detached-${view} ${closing ? "vc-vrb-layer-closing" : ""}`}
            style={{ left: `${position.left}px`, bottom: `${position.bottom}px` }}
        >
            <DetachedVoiceReplayPanel key={view} view={view} onClose={requestClose} onBackToMain={requestBackToMain} />
        </div>,
        document.body
    );
}

function VoiceReplayButton({ discordButtonClassName = "" }: { discordButtonClassName?: string; } = {}) {
    usePluginLanguage();
    const status = useRecorderStatus();
    const activity = useActivity();
    const saved = useSaveFlash();
    const exportStatus = useVideoExportStatus();
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [detachedView, setDetachedView] = React.useState<DetachedPanelView | null>(null);
    const [mainLayerClosing, setMainLayerClosing] = React.useState(false);
    const recordingsTransitionTimerRef = React.useRef<number | null>(null);
    const buttonRef = React.useRef<HTMLButtonElement | null>(null);
    const active = status.armed;




    const remoteLevel = active ? Number(activity.maxLevel || 0) : 0;
    const localLevel = active ? Number(status.liveLevel || 0) : 0;
    const effectiveLevel = Math.max(localLevel, remoteLevel);
    const history = activity.waveHistory.slice(-7);
    const remoteBands = Array.from({ length: 7 }, (_, index) => Number(history[index] ?? remoteLevel));
    const effectiveBands = active
        ? status.waveBands.map((level, index) => Math.max(Number(level || 0), remoteBands[index] ?? remoteLevel))
        : ACTIVE_IDLE_BARS.map(() => 0);
    const speaking = active && effectiveLevel > .012;
    const shown = menuOpen || detachedView != null;

    const mainLeftClick = React.useCallback(() => {
        const wasDetached = detachedView != null;
        setDetachedView(null);
        setMenuOpen(current => wasDetached ? true : !current);
    }, [detachedView]);

    const openSettingsFromPanelButton = React.useCallback(() => {
        setMenuOpen(false);
        setDetachedView(current => current === "settings" ? null : "settings");
    }, []);

    const openRecordingsFromMainPanel = React.useCallback(() => {
        if (mainLayerClosing) return;




        setMainLayerClosing(true);

        if (recordingsTransitionTimerRef.current != null) window.clearTimeout(recordingsTransitionTimerRef.current);
        recordingsTransitionTimerRef.current = window.setTimeout(() => {
            setMenuOpen(false);
            setMainLayerClosing(false);
            setDetachedView("recordings");
            recordingsTransitionTimerRef.current = null;
        }, 190);
    }, [mainLayerClosing]);

    React.useEffect(() => () => {
        if (recordingsTransitionTimerRef.current != null) window.clearTimeout(recordingsTransitionTimerRef.current);
    }, []);

    const tooltip: ReactNode = active
        ? <>Voice Replay - {tr("Recording", "جارٍ التسجيل")}<br />{formatDuration(status.bufferedSeconds)} / {formatDuration(status.maxBufferSeconds)}<br />{tr("Click: open menu", "اضغط: فتح القائمة")}</>
        : <>Voice Replay - {tr("Stopped", "متوقف")}<br />{tr("Click: open menu", "اضغط: فتح القائمة")}</>;

    return (
        <>
            <Tooltip text={shown ? null : tooltip} position="top">
                {(tooltipProps: any) => (
                    <button
                        {...tooltipProps}
                        ref={buttonRef}
                        type="button"
                        aria-haspopup="dialog"
                        aria-expanded={shown}
                        className={`${discordButtonClassName} vc-vrb-icon-button ${active ? "vc-vrb-active" : ""} ${speaking ? "vc-vrb-speaking" : ""} ${saved ? "vc-vrb-saved" : ""} ${shown ? "vc-vrb-selected" : ""} ${exportStatus.phase !== "idle" ? `vc-vrb-export-icon-${exportStatus.phase}` : ""}`}
                        style={{ "--vc-vrb-export-progress": `${Math.round(exportStatus.progress * 100)}%` } as any}
                        onClick={event => {
                            if (event.button !== 0) return;
                            event.preventDefault();
                            event.stopPropagation();
                            mainLeftClick();
                        }}
                        onContextMenu={event => {
                            event.preventDefault();
                            event.stopPropagation();
                            setDetachedView(null);
                            setMenuOpen(current => !current);
                        }}
                    >
                        {exportStatus.phase !== "idle"
                            ? <>
                                <span className="vc-vrb-export-icon-fill" aria-hidden="true" />
                                <span className="vc-vrb-export-icon-progress" aria-label={tr("Video export progress", "تقدم تصدير الفيديو")}>{exportStatus.phase === "error" ? "!" : `${Math.round(exportStatus.progress * 100)}%`}</span>
                            </>
                            : <WaveformIcon
                                active={active}
                                liveLevel={effectiveLevel}
                                waveBands={effectiveBands}
                                saved={saved}
                            />}
                        <span
                            className="vc-vrb-panel-settings-button"
                            role="button"
                            tabIndex={0}
                            aria-label={tr("Voice Replay settings", "إعدادات Voice Replay")}
                            onClick={event => {
                                event.preventDefault();
                                event.stopPropagation();
                                openSettingsFromPanelButton();
                            }}
                            onContextMenu={event => {
                                event.preventDefault();
                                event.stopPropagation();
                            }}
                            onKeyDown={event => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                event.stopPropagation();
                                openSettingsFromPanelButton();
                            }}
                        >
                            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                                <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.62l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.15 7.15 0 0 0-1.62-.94L14.38 2.8a.49.49 0 0 0-.49-.4h-3.84a.49.49 0 0 0-.49.4L9.2 5.34c-.58.24-1.12.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.66 8.86a.49.49 0 0 0 .12.62l2.03 1.58c-.05.31-.08.64-.08.96 0 .31.03.62.07.92l-2.02 1.58a.49.49 0 0 0-.12.62l1.92 3.32c.12.22.38.31.61.22l2.38-.96c.5.39 1.05.71 1.63.95l.36 2.53c.04.24.24.4.49.4h3.84c.25 0 .45-.16.49-.4l.36-2.53c.58-.24 1.13-.56 1.63-.95l2.38.96c.23.09.49 0 .61-.22l1.92-3.32a.49.49 0 0 0-.12-.62l-2.02-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/>
                            </svg>
                        </span>
                    </button>
                )}
            </Tooltip>

            {menuOpen && (
                <VoiceReplayFloatingLayer
                    anchorRef={buttonRef}
                    onClose={() => {
                        setMainLayerClosing(false);
                        setMenuOpen(false);
                    }}
                    onOpenRecordings={openRecordingsFromMainPanel}
                    closing={mainLayerClosing}
                />
            )}

            {detachedView && (
                <VoiceReplayDetachedFloatingLayer
                    anchorRef={buttonRef}
                    view={detachedView}
                    onClose={() => setDetachedView(null)}
                    onBackToMain={() => {
                        setDetachedView(null);
                        setMenuOpen(true);
                    }}
                />
            )}
        </>
    );
}


let panelObserver: MutationObserver | null = null;
let panelRoot: ReturnType<typeof createRoot> | null = null;
let panelHost: HTMLDivElement | null = null;
let panelMountFrame = 0;
let panelButtonClassName = "";

function elementLabel(element: Element): string {
    return [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-text-variant"),
        element.textContent
    ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function findAccountPanelAnchor(): HTMLElement | null {
    const panelScope = document.querySelector<HTMLElement>('[class*="panels"]') ?? document.body;
    if (!panelScope) return null;

    const scopeRect = panelScope.getBoundingClientRect();
    const controls = Array.from(panelScope.querySelectorAll<HTMLElement>('button,[role="button"]'))
        .map(control => ({ control, label: elementLabel(control), rect: control.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.bottom >= scopeRect.bottom - 92);

    const micTerms = ["mute", "unmute", "microphone", "mic", "كتم", "إلغاء الكتم", "الغاء الكتم", "الميكروفون", "مايك"];
    const excluded = ["deafen", "undeafen", "noise", "suppression", "soundboard", "ديفن", "الضوضاء", "ساوند بورد"];
    const microphone = controls.find(({ label }) => micTerms.some(term => label.includes(term)) && !excluded.some(term => label.includes(term)));
    return microphone?.control ?? null;
}

function unmountVoicePanelButton() {
    if (panelMountFrame) {
        cancelAnimationFrame(panelMountFrame);
        panelMountFrame = 0;
    }
    panelRoot?.unmount();
    panelRoot = null;
    panelHost?.remove();
    panelHost = null;
    panelButtonClassName = "";
}

function mountVoicePanelButton() {
    panelMountFrame = 0;
    const anchor = findAccountPanelAnchor();
    if (!anchor?.parentElement) return;
    const parent = anchor.parentElement;
    const anchorClassName = String(anchor.className ?? "");

    if (panelHost?.isConnected && panelRoot) {
        if (panelHost.parentElement !== parent || panelHost.nextSibling !== anchor) {
            parent.insertBefore(panelHost, anchor);
        }
        if (panelButtonClassName !== anchorClassName) {
            panelButtonClassName = anchorClassName;
            panelRoot.render(<VoiceReplayButton discordButtonClassName={panelButtonClassName} />);
        }
        return;
    }

    if (panelHost) unmountVoicePanelButton();
    for (const staleHost of document.querySelectorAll<HTMLElement>('[data-voice-replay-buffer="button"]')) staleHost.remove();

    const host = document.createElement("div");
    host.className = "vc-vrb-dom-host";
    host.dataset.voiceReplayBuffer = "button";
    parent.insertBefore(host, anchor);
    panelHost = host;
    panelButtonClassName = anchorClassName;
    panelRoot = createRoot(host);
    panelRoot.render(<VoiceReplayButton discordButtonClassName={panelButtonClassName} />);
}

function scheduleVoicePanelMount() {
    if (panelMountFrame) return;
    panelMountFrame = requestAnimationFrame(mountVoicePanelButton);
}

function startVoicePanelMounting() {
    stopVoicePanelMounting();
    scheduleVoicePanelMount();
    panelObserver = new MutationObserver(scheduleVoicePanelMount);
    panelObserver.observe(document.body, { childList: true, subtree: true });
}

function stopVoicePanelMounting() {
    panelObserver?.disconnect();
    panelObserver = null;
    unmountVoicePanelButton();
}

function FullSettingsToggle({ checked, label, onChange }: { checked: boolean; label: string; onChange(value: boolean): void; }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            className={`vc-vrb-full-toggle ${checked ? "vc-vrb-full-toggle-on" : ""}`}
            onClick={() => onChange(!checked)}
        >
            <span className="vc-vrb-full-toggle-knob" />
        </button>
    );
}

function RecordingFormatSelect({ value, onChange }: { value: RecordingFormat; onChange(value: RecordingFormat): void; }) {
    const [open, setOpen] = React.useState(false);
    const rootRef = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [open]);

    const choose = (next: RecordingFormat) => {
        onChange(next);
        setOpen(false);
    };

    return (
        <div ref={rootRef} className={`vc-vrb-format-select ${open ? "vc-vrb-format-select-open" : ""}`}>
            <button
                type="button"
                className="vc-vrb-format-select-trigger"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpen(current => !current)}
            >
                <span>{value.toUpperCase()}</span>
                <svg className="vc-vrb-format-select-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <path fill="currentColor" d="M7.4 9.4a1 1 0 0 1 1.4 0L12 12.6l3.2-3.2a1 1 0 1 1 1.4 1.4l-3.9 3.9a1 1 0 0 1-1.4 0l-3.9-3.9a1 1 0 0 1 0-1.4Z" />
                </svg>
            </button>
            {open && (
                <div className="vc-vrb-format-select-menu" role="listbox" aria-label={tr("Recording format", "صيغة التسجيل")}>
                    {(["flac", "wav"] as const).map(format => {
                        const selected = value === format;
                        return (
                            <button
                                key={format}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                className={`vc-vrb-format-select-option ${selected ? "vc-vrb-format-select-option-selected" : ""}`}
                                onClick={() => choose(format)}
                            >
                                <span>{format.toUpperCase()}</span>
                                {selected && (
                                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                                        <path fill="currentColor" d="M9.2 16.6 4.9 12.3a1 1 0 0 1 1.4-1.4l2.9 2.9 8.5-8.5a1 1 0 1 1 1.4 1.4l-9.2 9.9a1 1 0 0 1-.7.3 1 1 0 0 1-.7-.3Z" />
                                    </svg>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export default definePlugin({
    name: "VoiceReplayBuffer",
    description: "Save the latest audio from your Discord voice room.",
    tags: ["Voice", "Utility"],
    authors: [Devs.atb],
    settings,
    managedStyle,

    start() {
        lastVoiceChannelId = SelectedChannelStore.getVoiceChannelId() ?? null;
        SelectedChannelStore.addChangeListener(onVoiceChannelChanged);
        window.addEventListener("keydown", onKeyDown, true);
        recorderActivityUnsubscribe?.();
        recorderActivityUnsubscribe = voiceActivityTracker.subscribe(snapshot => voiceRecorder.updateParticipantActivity({
            localUserId: UserStore.getCurrentUser()?.id ?? null,
            participants: snapshot.participants.map(participant => ({ userId: participant.userId, speaking: participant.speaking })),
            ssrcUserMap: snapshot.ssrcUserMap
        }));
        void voiceRecorder.setVoiceConnected(Boolean(lastVoiceChannelId), MediaEngineStore.getInputDeviceId?.() ?? null);
        startVoicePanelMounting();
        if (lastVoiceChannelId && settings.store.autoStart) void startRecorder(false);
    },

    stop() {
        SelectedChannelStore.removeChangeListener(onVoiceChannelChanged);
        window.removeEventListener("keydown", onKeyDown, true);
        recorderActivityUnsubscribe?.();
        recorderActivityUnsubscribe = null;
        stopVoicePanelMounting();
        voiceActivityTracker.stop(true);
        void voiceRecorder.dispose();
    }
});
