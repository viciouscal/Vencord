/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelRTCStore, ChannelStore, GuildStore, MediaEngineStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

export interface LiveParticipant {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    speaking: boolean;
    voiceDb: number | null;
    muted: boolean;
    deafened: boolean;
    selfMute: boolean;
    selfDeaf: boolean;
    serverMute: boolean;
    serverDeaf: boolean;
    localMute: boolean;
    firstSeenAt: number;
    lastSeenAt: number;
    present: boolean;
}

export interface SpeakingSegment {
    userId: string;
    startedAt: number;
    endedAt: number;
}

export interface RoomParticipantState {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    muted: boolean;
    deafened: boolean;
    selfMute: boolean;
    selfDeaf: boolean;
    serverMute: boolean;
    serverDeaf: boolean;
    localMute: boolean;
}

export interface RoomTimelineEvent {
    at: number;
    channelId: string | null;
    channelName: string | null;
    guildId: string | null;
    guildName: string | null;
    participants: RoomParticipantState[];
}

export interface ActivitySnapshot {
    channelId: string | null;
    channelName: string | null;
    guildId: string | null;
    guildName: string | null;
    participants: LiveParticipant[];
    maxLevel: number;

    waveHistory: number[];

    ssrcUserMap: Record<string, string>;
}

type Listener = (snapshot: ActivitySnapshot) => void;
type TrackedParticipant = LiveParticipant;

function entries(value: unknown): Array<[string, any]> {
    if (value instanceof Map) return Array.from(value.entries()) as Array<[string, any]>;
    if (value && typeof value === "object") return Object.entries(value as Record<string, any>);
    return [];
}

function boolValue(value: unknown) {
    return value === true || value === 1 || value === "true";
}

function normalizeDb(db: unknown, speaking: boolean): number {
    if (!speaking) return 0;
    const n = Number(db);
    if (!Number.isFinite(n)) return .42;
    const normalized = Math.min(1, Math.max(0, (n + 62) / 57));
    return Math.pow(normalized, .72);
}

function rtcVoiceLevel(rtc: any, speaking: boolean) {
    if (!speaking) return 0;
    const db = Number(rtc?.voiceDb ?? rtc?.voiceDB ?? rtc?.db);
    if (Number.isFinite(db) && db <= 0) return normalizeDb(db, true);

    for (const candidate of [rtc?.audioLevel, rtc?.speakingLevel, rtc?.level, rtc?.volume]) {
        const value = Number(candidate);
        if (!Number.isFinite(value)) continue;
        const normalized = value > 1 ? Math.min(1, value / 100) : Math.min(1, Math.max(0, value));
        return Math.pow(normalized, .72);
    }

    return .34;
}


function collectSsrcs(value: any, depth = 0, result = new Set<number>()): Set<number> {
    if (!value || typeof value !== "object" || depth > 2) return result;
    for (const [key, candidate] of Object.entries(value)) {
        if (/ssrc/i.test(key)) {
            const n = Number(candidate);
            if (Number.isFinite(n) && n > 0) result.add(Math.floor(n));
            continue;
        }
        if (depth < 2 && candidate && typeof candidate === "object" && !Array.isArray(candidate)) {

            if (/audio|voice|rtc|source|stream|speaker/i.test(key)) collectSsrcs(candidate, depth + 1, result);
        }
    }
    return result;
}

function voiceStateFlags(state: any) {
    const selfMute = boolValue(state?.selfMute ?? state?.self_mute ?? state?.selfMuted ?? state?.self_muted);
    const selfDeaf = boolValue(state?.selfDeaf ?? state?.self_deaf ?? state?.selfDeafen ?? state?.self_deafen);
    const serverMute = boolValue(state?.mute ?? state?.serverMute ?? state?.server_mute ?? state?.guildMute);
    const serverDeaf = boolValue(state?.deaf ?? state?.serverDeaf ?? state?.server_deaf ?? state?.guildDeaf);
    return {
        selfMute,
        selfDeaf,
        serverMute,
        serverDeaf,
        muted: selfMute || serverMute,
        deafened: selfDeaf || serverDeaf
    };
}

const localMuteCache = new Map<string, { value: boolean; expiresAt: number; }>();

function isLocallyMuted(userId: string) {
    const now = Date.now();
    const cached = localMuteCache.get(userId);
    if (cached && cached.expiresAt > now) return cached.value;

    const store = MediaEngineStore as any;
    let engine: any = null;
    try { engine = store?.getMediaEngine?.(); } catch { }
    const connections = Array.from(engine?.connections ?? []) as any[];
    const checks: Array<() => unknown> = [
        () => store?.isLocalMute?.("default", userId),
        () => store?.isLocalMute?.(userId, "default"),
        () => store?.isLocalMute?.(userId)
    ];

    for (const connection of connections) {
        if (connection?.context && connection.context !== "default") continue;
        checks.push(
            () => connection?.getLocalMute?.(userId),
            () => connection?.isLocalMute?.(userId),
            () => connection?.localMutes?.[userId]
        );
    }

    for (const check of checks) {
        try {
            const value: any = check();
            if (value === true || value?.muted === true || value?.mute === true) {
                localMuteCache.set(userId, { value: true, expiresAt: now + 200 });
                return true;
            }
        } catch { }
    }
    localMuteCache.set(userId, { value: false, expiresAt: now + 200 });
    return false;
}

class VoiceActivityTracker {
    private timer: number | null = null;
    private listeners = new Set<Listener>();

    private participants = new Map<string, TrackedParticipant>();
    private activeSpeaking = new Map<string, number>();
    private segments: SpeakingSegment[] = [];
    private roomEvents: RoomTimelineEvent[] = [];
    private lastRoomSignature = "";
    private channelId: string | null = null;
    private maxLevel = 0;
    private waveHistory = Array(15).fill(0) as number[];
    private ssrcUserMap: Record<string, string> = {};

    start() {
        if (this.timer != null) return;
        this.tick();

        this.timer = window.setInterval(() => this.tick(), 20);
    }

    stop(clear = false) {
        if (this.timer != null) window.clearInterval(this.timer);
        this.timer = null;
        this.closeActiveSegments(Date.now());
        if (clear) this.reset();
        else this.emit();
    }

    reset() {
        this.closeActiveSegments(Date.now());
        this.participants.clear();
        this.activeSpeaking.clear();
        this.segments = [];
        this.roomEvents = [];
        this.lastRoomSignature = "";
        this.channelId = SelectedChannelStore.getVoiceChannelId() ?? null;
        this.maxLevel = 0;
        this.waveHistory = Array(15).fill(0) as number[];
        this.ssrcUserMap = {};

        this.emit();
    }

    subscribe(listener: Listener) {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => { this.listeners.delete(listener); };
    }

    getSnapshot(): ActivitySnapshot {
        const channel = this.channelId ? ChannelStore.getChannel(this.channelId) : null;
        const guildId = channel?.guild_id ?? null;
        const guild = guildId ? GuildStore.getGuild(guildId) : null;
        return {
            channelId: this.channelId,
            channelName: channel?.name ?? null,
            guildId,
            guildName: guild?.name ?? null,
            participants: Array.from(this.participants.values())
                .filter(p => p.present)
                .sort((a, b) => Number(b.speaking) - Number(a.speaking) || a.displayName.localeCompare(b.displayName)),
            maxLevel: this.maxLevel,
            waveHistory: [...this.waveHistory],
            ssrcUserMap: { ...this.ssrcUserMap }
        };
    }

    makeMetadata(clipStartedAt: number, clipEndedAt: number) {
        const currentSegments = [...this.segments];
        for (const [userId, startedAt] of this.activeSpeaking) {
            currentSegments.push({ userId, startedAt, endedAt: clipEndedAt });
        }

        const clipDuration = Math.max(0, (clipEndedAt - clipStartedAt) / 1000);
        const speakingTimeline = currentSegments
            .filter(s => s.endedAt >= clipStartedAt && s.startedAt <= clipEndedAt)
            .map(s => ({
                userId: s.userId,
                startedAt: new Date(Math.max(s.startedAt, clipStartedAt)).toISOString(),
                endedAt: new Date(Math.min(s.endedAt, clipEndedAt)).toISOString(),
                offsetStartSeconds: Math.max(0, (s.startedAt - clipStartedAt) / 1000),
                offsetEndSeconds: Math.min(clipDuration, (s.endedAt - clipStartedAt) / 1000)
            }))
            .filter(s => s.offsetEndSeconds > s.offsetStartSeconds);

        const beforeStart = [...this.roomEvents].reverse().find(event => event.at <= clipStartedAt) ?? null;
        const rangedEvents = this.roomEvents.filter(event => event.at > clipStartedAt && event.at <= clipEndedAt);
        const sourceEvents: RoomTimelineEvent[] = [];
        if (beforeStart) sourceEvents.push({ ...beforeStart, at: clipStartedAt });
        else sourceEvents.push({
            at: clipStartedAt,
            channelId: null,
            channelName: null,
            guildId: null,
            guildName: null,
            participants: []
        });
        sourceEvents.push(...rangedEvents);


        const roomTimeline: any[] = [];
        let priorSignature = "";
        for (const event of sourceEvents) {
            const signature = this.roomSignature(event.channelId, event.participants);
            if (signature === priorSignature && roomTimeline.length) continue;
            priorSignature = signature;
            roomTimeline.push({
                offsetSeconds: Math.max(0, Math.min(clipDuration, (event.at - clipStartedAt) / 1000)),
                at: new Date(event.at).toISOString(),
                channelId: event.channelId,
                channelName: event.channelName,
                guildId: event.guildId,
                guildName: event.guildName,
                participants: event.participants.map(participant => ({ ...participant }))
            });
        }

        const participantIds = new Set<string>();
        for (const event of roomTimeline) for (const participant of event.participants ?? []) participantIds.add(participant.userId);
        for (const segment of speakingTimeline) participantIds.add(segment.userId);

        const participants = Array.from(participantIds).map(userId => {
            const tracked = this.participants.get(userId);
            const user = UserStore.getUser(userId);
            let avatarUrl: string | null = tracked?.avatarUrl ?? null;
            if (!avatarUrl && user) {
                try { avatarUrl = user.getAvatarURL?.(undefined, 128, true) ?? null; } catch { }
            }
            return {
                userId,
                username: tracked?.username ?? user?.username ?? userId,
                displayName: tracked?.displayName ?? user?.globalName ?? user?.username ?? userId,
                avatarUrl,
                spokeInClip: speakingTimeline.some(s => s.userId === userId)
            };
        });

        const latestRoom = [...roomTimeline].reverse().find(event => event.channelId) ?? roomTimeline[roomTimeline.length - 1] ?? null;

        return {
            guildId: latestRoom?.guildId ?? null,
            guildName: latestRoom?.guildName ?? null,
            channelId: latestRoom?.channelId ?? null,
            channelName: latestRoom?.channelName ?? null,
            participantCount: participants.length,
            participants,
            speakingTimeline,
            roomTimeline
        };
    }

    private tick() {
        const now = Date.now();
        const nextChannelId = SelectedChannelStore.getVoiceChannelId() ?? null;
        if (nextChannelId !== this.channelId) {

            this.closeActiveSegments(now);
            for (const participant of this.participants.values()) {
                participant.present = false;
                participant.speaking = false;
            }
            this.channelId = nextChannelId;
        }

        if (!nextChannelId) {
            this.maxLevel = 0;
            this.waveHistory = [...this.waveHistory.slice(1), 0];
            this.ssrcUserMap = {};
            this.recordRoomSnapshot(now, null, []);
            this.pruneHistory(now);
            this.emit();
            return;
        }

        const channel = ChannelStore.getChannel(nextChannelId);
        const guildId = channel?.guild_id ?? null;
        const speakingParticipants = ChannelRTCStore.getSpeakingParticipants(nextChannelId) ?? [];
        const speakingById = new Map<string, any>();
        const nextSsrcMap: Record<string, string> = {};
        for (const participant of speakingParticipants as any[]) {
            const id = participant?.user?.id ?? participant?.userId ?? participant?.user_id ?? participant?.id;
            if (!id) continue;
            const userId = String(id);
            speakingById.set(userId, participant);
            for (const ssrc of collectSsrcs(participant)) nextSsrcMap[String(ssrc)] = userId;
        }

        let maxLevel = 0;
        const seen = new Set<string>();
        const currentStates: RoomParticipantState[] = [];
        const voiceStates = entries(VoiceStateStore.getVoiceStatesForChannel(nextChannelId));
        for (const [key, state] of voiceStates) {
            const userId = String(state?.userId ?? state?.user_id ?? key);
            const user = UserStore.getUser(userId);
            if (!user) continue;
            seen.add(userId);

            const rtc = speakingById.get(userId);
            const speaking = Boolean(rtc?.speaking);
            const voiceDb = Number.isFinite(Number(rtc?.voiceDb)) ? Number(rtc.voiceDb) : null;
            const level = rtcVoiceLevel(rtc, speaking);
            maxLevel = Math.max(maxLevel, level);
            const flags = voiceStateFlags(state);
            const localMute = userId !== UserStore.getCurrentUser()?.id && isLocallyMuted(userId);

            for (const ssrc of collectSsrcs(state)) nextSsrcMap[String(ssrc)] = userId;

            const prior = this.participants.get(userId);
            const displayName = rtc?.userNick || user.globalName || user.username || userId;
            let avatarUrl: string | null = prior?.avatarUrl ?? null;
            if (!avatarUrl) {
                try { avatarUrl = user.getAvatarURL?.(guildId, 128, true) ?? null; } catch { avatarUrl = null; }
            }

            this.participants.set(userId, {
                userId,
                username: user.username ?? userId,
                displayName,
                avatarUrl,
                speaking,
                voiceDb,
                ...flags,
                localMute,
                firstSeenAt: prior?.firstSeenAt ?? now,
                lastSeenAt: now,
                present: true
            });

            currentStates.push({
                userId,
                username: user.username ?? userId,
                displayName,
                avatarUrl,
                ...flags,
                localMute
            });

            if (speaking && !this.activeSpeaking.has(userId)) {
                this.activeSpeaking.set(userId, now);
            } else if (!speaking && this.activeSpeaking.has(userId)) {
                this.finishSegment(userId, now);
            }
        }

        for (const [userId, participant] of this.participants) {
            if (!participant.present || seen.has(userId)) continue;
            participant.present = false;
            participant.speaking = false;
            participant.lastSeenAt = now;
            if (this.activeSpeaking.has(userId)) this.finishSegment(userId, now);
        }

        this.maxLevel = maxLevel;
        this.ssrcUserMap = nextSsrcMap;
        this.waveHistory = [...this.waveHistory.slice(1), maxLevel];
        this.recordRoomSnapshot(now, nextChannelId, currentStates);
        this.pruneHistory(now);
        this.emit();
    }

    private recordRoomSnapshot(at: number, channelId: string | null, participants: RoomParticipantState[]) {


        const signatureStates = [...participants].sort((a, b) => a.userId.localeCompare(b.userId));
        const signature = this.roomSignature(channelId, signatureStates);
        if (signature === this.lastRoomSignature) return;
        this.lastRoomSignature = signature;

        const channel = channelId ? ChannelStore.getChannel(channelId) : null;
        const guildId = channel?.guild_id ?? null;
        const guild = guildId ? GuildStore.getGuild(guildId) : null;
        this.roomEvents.push({
            at,
            channelId,
            channelName: channel?.name ?? null,
            guildId,
            guildName: guild?.name ?? null,
            participants: participants.map(participant => ({ ...participant }))
        });
    }

    private roomSignature(channelId: string | null, participants: RoomParticipantState[]) {
        return `${channelId ?? "-"}|${participants.map(p => `${p.userId}:${p.displayName}:${Number(p.muted)}${Number(p.deafened)}${Number(p.selfMute)}${Number(p.selfDeaf)}${Number(p.serverMute)}${Number(p.serverDeaf)}${Number(p.localMute)}`).join(",")}`;
    }

    private finishSegment(userId: string, endedAt: number) {
        const startedAt = this.activeSpeaking.get(userId);
        if (startedAt == null) return;
        this.activeSpeaking.delete(userId);
        if (endedAt > startedAt) this.segments.push({ userId, startedAt, endedAt });
    }

    private closeActiveSegments(endedAt: number) {
        for (const userId of Array.from(this.activeSpeaking.keys())) this.finishSegment(userId, endedAt);
    }

    private pruneHistory(now: number) {

        const cutoff = now - 2 * 60 * 60 * 1000;
        if (this.segments.length > 6000) this.segments = this.segments.filter(segment => segment.endedAt >= cutoff);
        if (this.roomEvents.length > 4000) {
            const prior = [...this.roomEvents].reverse().find(event => event.at < cutoff);
            this.roomEvents = [
                ...(prior ? [{ ...prior, at: cutoff }] : []),
                ...this.roomEvents.filter(event => event.at >= cutoff)
            ];
        }
    }

    private emit() {
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) listener(snapshot);
    }
}

export const voiceActivityTracker = new VoiceActivityTracker();
