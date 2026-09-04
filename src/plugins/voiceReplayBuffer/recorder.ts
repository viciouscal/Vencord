

import { MediaEngineStore } from "@webpack/common";

export type RecordingFormat = "flac" | "wav";

export interface RecorderOptions {
    maxBufferSeconds: number;
    includeMicrophone: boolean;
    microphoneDeviceId?: string | null;
    localUserId?: string | null;
    voiceConnected?: boolean;
}

export interface RecorderStatus {
    armed: boolean;
    contextState: AudioContextState | "closed";
    sampleRate: number;
    bufferedSeconds: number;
    maxBufferSeconds: number;
    remoteTracks: number;
    isolatedTracks: number;
    microphoneActive: boolean;
    liveLevel: number;
    waveBands: number[];
    lastError: string | null;
}

export interface EncodedStem {
    userId: string;
    samples: Int16Array;
}

export interface ReplayClip {

    samples: Int16Array;
    channels: number;
    format: RecordingFormat;
    extension: "flac" | "wav";
    mimeType: string;
    sampleRate: number;
    durationSeconds: number;
    clipStartedAt: number;
    clipEndedAt: number;
    stems: EncodedStem[];
    residualStem: Int16Array | null;
    unmappedRemoteSources: number;
}

export interface RecorderParticipantActivity {
    participants: Array<{ userId: string; speaking: boolean; }>;
    ssrcUserMap?: Record<string, string>;
    localUserId?: string | null;
}

export interface NativeRemoteCapturePacket {
    startTimeMs: number;
    sampleRate: number;
    flags?: number;
    pcm16: Uint8Array;
}

export interface NativeRemoteCaptureBridge {
    start(): Promise<{ ok: boolean; backend?: string; sampleRate?: number; error?: string | null; }>;
    poll(): Promise<{ active: boolean; sampleRate?: number; packets?: NativeRemoteCapturePacket[]; error?: string | null; }>;
    stop(): Promise<unknown>;
}

type PendingNativeRemoteCapturePacket = {
    packet: NativeRemoteCapturePacket;
    samples: Int16Array<ArrayBufferLike> | null;
    startGlobal: number | null;
};

type StatusListener = (status: RecorderStatus) => void;

type TrackAttachment = {
    track: MediaStreamTrack;
    captureTrack: MediaStreamTrack;
    receiver: RTCRtpReceiver | null;
    source: MediaStreamAudioSourceNode;
    slot: number | null;
    captureKey: string | null;
    masterIncluded: boolean;
    captureKind: RemoteCaptureKind;
    hintedUserId: string | null;
    cleanup: () => void;
};

type DiscoveredTrack = {
    track: MediaStreamTrack;
    receiver: RTCRtpReceiver | null;
};

type RemoteCaptureKind = "direct" | "engine-scan" | "element-fallback" | "native-process";

type RemoteTrackOptions = {
    masterIncluded?: boolean;
    hintedUserId?: string | null;
    captureKind?: RemoteCaptureKind;
};

type StemChunk = {
    startSample: number;
    samples: Int16Array;
    userId: string | null;
};

type StemSource = {
    captureKey: string;
    sourceType: "remote" | "microphone";
    slot: number;
    mappedUserId: string | null;
    reliableMapping: boolean;
    receiver: RTCRtpReceiver | null;
    chunks: StemChunk[];
    mapScores: Map<string, number>;
    mismatchTicks: number;
    lastLevel: number;
    active: boolean;
    masterIncluded: boolean;
    captureKind: RemoteCaptureKind | "microphone";
    approvedVoiceSource: boolean;
    voiceEvidence: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const MAX_CAPTURE_INPUTS = 32;
const MICROPHONE_SLOT = MAX_CAPTURE_INPUTS - 1;
const REMOTE_SLOT_LIMIT = MAX_CAPTURE_INPUTS - 1;
const TRACK_SIGNAL_THRESHOLD = 0.00045;
const TERMINAL_MEDIA_ERRORS = new Set(["AbortError", "NotAllowedError", "SecurityError"]);

function pcm16(value: number) {
    const mixed = clamp(value, -1, 1);
    return mixed < 0 ? Math.round(mixed * 0x8000) : Math.round(mixed * 0x7fff);
}

function pcm16Unit(value: number) {
    return value / (value < 0 ? 0x8000 : 0x7fff);
}


function softLimitUnit(value: number) {
    const magnitude = Math.abs(value);
    const knee = .82;
    const ceiling = .985;
    if (magnitude <= knee) return value;
    const rounded = knee + (ceiling - knee) * (1 - Math.exp(-(magnitude - knee) / (ceiling - knee)));
    return Math.sign(value) * Math.min(ceiling, rounded);
}

function mixPcm16(left: number, right: number) {
    return pcm16(softLimitUnit(pcm16Unit(left) + pcm16Unit(right)));
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

class RollingVoiceRecorder {
    private context: AudioContext | null = null;
    private mixer: GainNode | null = null;
    private masterLimiter: DynamicsCompressorNode | null = null;
    private captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
    private stemCaptureNode: AudioWorkletNode | null = null;
    private multiTrackWorklet = false;
    private workletUrl: string | null = null;
    private silentOutput: GainNode | null = null;

    private ring = new Int16Array(0);
    private ringRight = new Int16Array(0);
    private writeIndex = 0;
    private validSamples = 0;
    private totalSamplesWritten = 0;
    private maxBufferSeconds = 600;
    private sampleRate = 0;
    private lastSampleAt = 0;

    private remoteTracks = new Map<string, TrackAttachment>();
    private discoveredTracks = new Map<string, DiscoveredTrack>();
    private microphoneStream: MediaStream | null = null;
    private microphoneSource: MediaStreamAudioSourceNode | null = null;
    private microphoneTrackIds = new Set<string>();
    private microphoneCaptureKey: string | null = null;
    private microphoneWanted = false;
    private microphoneDeviceId: string | null = null;
    private microphoneRecoveryTimer: number | null = null;
    private voiceConnected = false;
    private localUserId: string | null = null;

    private slotCaptureKeys = Array<string | null>(MAX_CAPTURE_INPUTS).fill(null);
    private stemSources = new Map<string, StemSource>();
    private captureSerial = 0;
    private presentRemoteUserIds = new Set<string>();
    private speakingRemoteUserIds = new Set<string>();
    private ssrcUserMap = new Map<number, string>();
    private engineSsrcUserMap = new Map<number, string>();
    private mediaEngineSpeakingHooks = new Map<any, {
        originalNative: any;
        wrappedNative: any;
        originalFlags: any;
        wrappedFlags: any;
        originalCreateUser: any;
        wrappedCreateUser: any;
    }>();

    private originalSrcObjectDescriptor: PropertyDescriptor | null = null;
    private originalReceiverTrackDescriptor: PropertyDescriptor | null = null;
    private originalSetRemoteDescription: ((this: RTCPeerConnection, ...args: any[]) => any) | null = null;
    private originalSetLocalDescription: ((this: RTCPeerConnection, ...args: any[]) => any) | null = null;
    private originalGetReceivers: ((this: RTCPeerConnection) => RTCRtpReceiver[]) | null = null;
    private originalCreateMediaStreamSource: ((this: AudioContext, mediaStream: MediaStream) => MediaStreamAudioSourceNode) | null = null;
    private originalAudioNodeConnect: ((this: AudioNode, ...args: any[]) => any) | null = null;
    private wrappedAudioNodeConnect: ((this: AudioNode, ...args: any[]) => any) | null = null;
    private audioNodePrototype: any = null;
    private wrappedCreateMediaStreamSource: ((this: AudioContext, mediaStream: MediaStream) => MediaStreamAudioSourceNode) | null = null;
    private originalCreateMediaStreamTrackSource: ((this: AudioContext, mediaStreamTrack: MediaStreamTrack) => AudioNode) | null = null;
    private wrappedCreateMediaStreamTrackSource: ((this: AudioContext, mediaStreamTrack: MediaStreamTrack) => AudioNode) | null = null;
    private audioContextPrototype: any = null;
    private originalMediaStreamAddTrack: ((this: MediaStream, track: MediaStreamTrack) => void) | null = null;
    private wrappedMediaStreamAddTrack: ((this: MediaStream, track: MediaStreamTrack) => void) | null = null;
    private mediaDevicesTarget: MediaDevices | null = null;
    private originalGetUserMedia: ((this: MediaDevices, constraints?: MediaStreamConstraints) => Promise<MediaStream>) | null = null;
    private wrappedGetUserMedia: ((this: MediaDevices, constraints?: MediaStreamConstraints) => Promise<MediaStream>) | null = null;
    private localCaptureTrackIds = new Set<string>();
    private bypassAudioDiscovery = 0;
    private observedPeerConnections = new Set<RTCPeerConnection>();
    private peerTrackHandlers = new Map<RTCPeerConnection, (event: RTCTrackEvent) => void>();
    private mediaObserver: MutationObserver | null = null;
    private elementFallbacks = new Map<HTMLMediaElement, { stream: MediaStream; trackIds: string[]; cleanup: () => void; }>();
    private trustedRemoteSignalAt = 0;
    private recoveryTimer: number | null = null;
    private gestureResumeHandler: (() => void) | null = null;

    private nativeRemoteBridge: NativeRemoteCaptureBridge | null = null;
    private nativeRemoteActive = false;
    private nativeRemotePollTimer: number | null = null;
    private nativeRemotePollBusy = false;
    private nativeRemotePendingPackets: PendingNativeRemoteCapturePacket[] = [];
    private nativeRemoteLevel = 0;
    private nativeRemoteBands = [0, 0, 0, 0, 0, 0, 0];
    private nativeRemoteMeterAt = 0;




    private nativeRemoteAnchorTimeMs: number | null = null;
    private nativeRemoteAnchorGlobalSample: number | null = null;
    private nativeRemoteLastPacketEndGlobal: number | null = null;
    private nativeMixGain = 1;
    private readonly nativeRemoteCaptureKey = "__vrb_windows_process_loopback__";

    private listeners = new Set<StatusListener>();
    private armed = false;
    private lastError: string | null = null;
    private lastStatusEmit = 0;
    private liveLevel = 0;
    private waveBands = [0, 0, 0, 0, 0, 0, 0];

    subscribe(listener: StatusListener): () => void {
        this.listeners.add(listener);
        listener(this.getStatus());
        return () => this.listeners.delete(listener);
    }

    getStatus(): RecorderStatus {
        const isolatedUsers = new Set<string>();
        for (const source of this.stemSources.values()) if (source.mappedUserId) isolatedUsers.add(source.mappedUserId);
        return {
            armed: this.armed,
            contextState: this.context?.state ?? "closed",
            sampleRate: this.sampleRate,
            bufferedSeconds: this.sampleRate ? this.validSamples / this.sampleRate : 0,
            maxBufferSeconds: this.maxBufferSeconds,
            remoteTracks: this.nativeRemoteActive ? 1 : this.remoteTracks.size,
            isolatedTracks: isolatedUsers.size,
            microphoneActive: Boolean(this.microphoneStream?.active),
            liveLevel: this.liveLevel,
            waveBands: [...this.waveBands],
            lastError: this.lastError
        };
    }

    setNativeRemoteCaptureBridge(bridge: NativeRemoteCaptureBridge | null) {
        this.nativeRemoteBridge = bridge;
    }

    updateParticipantActivity(activity: RecorderParticipantActivity) {
        if (activity.localUserId) this.localUserId = activity.localUserId;
        this.presentRemoteUserIds = new Set(activity.participants
            .map(participant => participant.userId)
            .filter(userId => userId && userId !== this.localUserId));
        this.speakingRemoteUserIds = new Set(activity.participants
            .filter(participant => participant.speaking)
            .map(participant => participant.userId)
            .filter(userId => userId && userId !== this.localUserId));
        this.ssrcUserMap.clear();
        for (const [ssrc, userId] of Object.entries(activity.ssrcUserMap ?? {})) {
            const numeric = Number(ssrc);
            if (Number.isFinite(numeric) && numeric > 0 && userId && userId !== this.localUserId) {
                this.ssrcUserMap.set(Math.floor(numeric), userId);
            }
        }
        this.refreshReliableMappings();
    }

    async start(options: RecorderOptions): Promise<RecorderStatus> {
        this.microphoneWanted = Boolean(options.includeMicrophone);
        this.voiceConnected = options.voiceConnected !== false;
        this.localUserId = options.localUserId ?? this.localUserId;

        if (this.armed) {
            this.setMaxBufferSeconds(options.maxBufferSeconds);
            await this.setVoiceConnected(this.voiceConnected, options.microphoneDeviceId);
            await this.setMicrophoneEnabled(this.microphoneWanted, options.microphoneDeviceId);
            return this.getStatus();
        }

        this.lastError = null;
        this.liveLevel = 0;
        this.waveBands = [0, 0, 0, 0, 0, 0, 0];
        this.maxBufferSeconds = clamp(Math.floor(options.maxBufferSeconds || 600), 10, 3600);

        const AudioContextConstructor = window.AudioContext ?? (window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
        }).webkitAudioContext;
        if (!AudioContextConstructor) throw new Error("Web Audio API is unavailable in this Discord build.");

        try {
            this.context = new AudioContextConstructor({ latencyHint: "interactive", sampleRate: 48_000 });
        } catch {
            this.context = new AudioContextConstructor({ latencyHint: "interactive" });
        }

        this.sampleRate = this.context.sampleRate;
        this.ring = new Int16Array(this.sampleRate * this.maxBufferSeconds);
        this.ringRight = new Int16Array(this.sampleRate * this.maxBufferSeconds);
        this.writeIndex = 0;
        this.validSamples = 0;
        this.totalSamplesWritten = 0;
        this.lastSampleAt = 0;
        this.nativeRemotePendingPackets = [];
        this.resetNativeRemoteTimeline();
        this.stemSources.clear();
        this.slotCaptureKeys.fill(null);


        this.mixer = this.context.createGain();
        this.masterLimiter = this.context.createDynamicsCompressor();
        this.masterLimiter.threshold.value = -1.5;
        this.masterLimiter.knee.value = 2;
        this.masterLimiter.ratio.value = 20;
        this.masterLimiter.attack.value = .002;
        this.masterLimiter.release.value = .12;
        this.mixer.connect(this.masterLimiter);
        this.silentOutput = this.context.createGain();
        this.silentOutput.gain.value = 0;

        try {
            const source = `
                class VoiceReplayMasterProcessor extends AudioWorkletProcessor {
                    constructor() {
                        super();
                        this.chunkSize = 1024;
                        this.offset = 0;
                        this.left = new Float32Array(this.chunkSize);
                        this.right = new Float32Array(this.chunkSize);
                    }
                    flush() {
                        const left = this.left;
                        const right = this.right;
                        this.left = new Float32Array(this.chunkSize);
                        this.right = new Float32Array(this.chunkSize);
                        this.port.postMessage({ left, right }, [left.buffer, right.buffer]);
                    }
                    process(inputs, outputs) {
                        const output = outputs[0];
                        const frames = output?.[0]?.length || inputs?.[0]?.[0]?.length || 128;
                        if (output) for (const channel of output) channel.fill(0);
                        const input = inputs[0];

                        for (let i = 0; i < frames; i++) {
                            const left = Math.max(-1, Math.min(1, input?.[0]?.[i] || 0));
                            const right = Math.max(-1, Math.min(1, input?.[1]?.[i] ?? left));
                            this.left[this.offset] = left;
                            this.right[this.offset] = right;
                            this.offset++;
                            if (this.offset === this.chunkSize) {
                                this.offset = 0;
                                this.flush();
                            }
                        }
                        return true;
                    }
                }

                class VoiceReplayStemProcessor extends AudioWorkletProcessor {
                    constructor() {
                        super();
                        this.chunkSize = 1024;
                        this.inputCount = ${MAX_CAPTURE_INPUTS};
                        this.offset = 0;
                        this.frameIndex = 0;
                        this.tracks = Array.from({ length: this.inputCount }, () => new Float32Array(this.chunkSize));
                        this.peaks = new Float32Array(this.inputCount);
                    }
                    flush() {
                        const levels = this.peaks;
                        const tracks = [];
                        const transfer = [levels.buffer];
                        for (let slot = 0; slot < this.inputCount; slot++) {
                            const samples = this.tracks[slot];
                            if (levels[slot] > ${TRACK_SIGNAL_THRESHOLD}) {
                                tracks.push({ slot, samples });
                                transfer.push(samples.buffer);
                            }
                            this.tracks[slot] = new Float32Array(this.chunkSize);
                        }
                        this.peaks = new Float32Array(this.inputCount);
                        this.port.postMessage({
                            startFrame: this.frameIndex - this.chunkSize,
                            levels,
                            tracks
                        }, transfer);
                    }
                    process(inputs, outputs) {
                        const output = outputs[0];
                        const frames = output?.[0]?.length || inputs.find(input => input?.[0])?.[0]?.length || 128;
                        if (output) for (const channel of output) channel.fill(0);

                        for (let i = 0; i < frames; i++) {
                            for (let slot = 0; slot < this.inputCount; slot++) {
                                const channels = inputs[slot];
                                let mono = 0;
                                if (channels && channels.length) {
                                    for (let c = 0; c < channels.length; c++) mono += channels[c]?.[i] || 0;
                                    mono /= Math.max(1, channels.length);
                                }
                                mono = Math.max(-1, Math.min(1, mono));
                                this.tracks[slot][this.offset] = mono;
                                const abs = Math.abs(mono);
                                if (abs > this.peaks[slot]) this.peaks[slot] = abs;
                            }
                            this.offset++;
                            this.frameIndex++;
                            if (this.offset === this.chunkSize) {
                                this.offset = 0;
                                this.flush();
                            }
                        }
                        return true;
                    }
                }

                registerProcessor('voice-replay-master-v21', VoiceReplayMasterProcessor);
                registerProcessor('voice-replay-stems-v21', VoiceReplayStemProcessor);
            `;
            this.workletUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
            await this.context.audioWorklet.addModule(this.workletUrl);

            const masterNode = new AudioWorkletNode(this.context, "voice-replay-master-v21", {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2]
            });
            masterNode.port.onmessage = event => {
                const data = event.data;
                if (data?.left instanceof Float32Array && data?.right instanceof Float32Array) {
                    this.writeMasterChunk(data.left, data.right);
                }
            };
            this.captureNode = masterNode;
            this.masterLimiter.connect(masterNode);

            try {
                const stemNode = new AudioWorkletNode(this.context, "voice-replay-stems-v21", {
                    numberOfInputs: MAX_CAPTURE_INPUTS,
                    numberOfOutputs: 1,
                    outputChannelCount: [1]
                });
                stemNode.port.onmessage = event => this.onStemWorkletPacket(event.data);
                this.stemCaptureNode = stemNode;
                this.multiTrackWorklet = true;
            } catch (stemError) {
                this.stemCaptureNode = null;
                this.multiTrackWorklet = false;
                this.lastError = `Separate-track capture fallback active: ${errorMessage(stemError)}`;
            }
        } catch (error) {
            const node = this.context.createScriptProcessor(1024, 2, 2);
            node.onaudioprocess = event => this.onAudioProcessFallback(event);
            this.captureNode = node;
            this.masterLimiter.connect(node);
            this.stemCaptureNode = null;
            this.multiTrackWorklet = false;
            this.lastError = `AudioWorklet fallback active: ${errorMessage(error)}`;
        }

        this.captureNode.connect(this.silentOutput);
        this.stemCaptureNode?.connect(this.silentOutput);
        this.silentOutput.connect(this.context.destination);

        this.armed = true;
        this.installGestureResume();
        const nativeRemoteStart = this.voiceConnected ? this.startNativeRemoteCapture() : Promise.resolve(false);

        try {
            await this.context.resume();
        } catch {

        }

        const nativeRemoteStarted = await nativeRemoteStart;
        if (!nativeRemoteStarted) {
            this.prepareRemoteCapture();
            this.startRecoveryTimer();
            for (const discovered of this.discoveredTracks.values()) this.attachRemoteTrack(discovered.track, discovered.receiver);
        }

        if (this.microphoneWanted && this.voiceConnected) {
            try {
                await this.attachMicrophone(options.microphoneDeviceId);
            } catch (error) {
                const micError = `Microphone was not attached: ${errorMessage(error)}`;
                this.lastError = this.lastError ? `${this.lastError} • ${micError}` : micError;
            }
        }

        this.emitStatus(true);
        return this.getStatus();
    }


    async stop(clearBuffer = true): Promise<void> {
        this.armed = false;
        this.stopRecoveryTimer();
        await this.stopNativeRemoteCapture();
        this.uninstallGestureResume();
        this.detachElementFallbacks();
        for (const attachment of this.remoteTracks.values()) attachment.cleanup();
        this.remoteTracks.clear();
        this.detachMicrophone();

        if (this.captureNode) {
            if (this.captureNode instanceof ScriptProcessorNode) this.captureNode.onaudioprocess = null;
            if (this.captureNode instanceof AudioWorkletNode) this.captureNode.port.onmessage = null;
            try { this.captureNode.disconnect(); } catch {   }
        }
        if (this.stemCaptureNode) {
            this.stemCaptureNode.port.onmessage = null;
            try { this.stemCaptureNode.disconnect(); } catch {   }
        }
        try { this.mixer?.disconnect(); } catch {   }
        try { this.masterLimiter?.disconnect(); } catch {   }
        try { this.silentOutput?.disconnect(); } catch {   }

        const context = this.context;
        this.context = null;
        this.captureNode = null;
        this.stemCaptureNode = null;
        this.mixer = null;
        this.masterLimiter = null;
        this.silentOutput = null;
        this.multiTrackWorklet = false;
        this.slotCaptureKeys.fill(null);
        if (this.workletUrl) {
            URL.revokeObjectURL(this.workletUrl);
            this.workletUrl = null;
        }
        this.liveLevel = 0;
        this.waveBands = [0, 0, 0, 0, 0, 0, 0];

        if (context && context.state !== "closed") {
            try { await context.close(); } catch {   }
        }

        if (clearBuffer) {
            this.ring = new Int16Array(0);
            this.ringRight = new Int16Array(0);
            this.writeIndex = 0;
            this.validSamples = 0;
            this.totalSamplesWritten = 0;
            this.sampleRate = 0;
            this.lastSampleAt = 0;
            this.stemSources.clear();
        }
        this.emitStatus(true);
    }


    prepareRemoteCapture() {
        if (this.nativeRemoteActive) return;




        this.installLocalCaptureHook();
        this.installAudioGraphHooks();
        this.installMediaStreamHook();
        this.installSrcObjectHook();
        this.installPeerConnectionHook();
        this.installReceiverTrackHook();
        this.installMediaObserver();
        this.attachExistingAudioStreams();
    }


    async dispose() {
        await this.stop(true);
        this.uninstallMediaObserver();
        this.restoreAudioGraphHooks();
        this.restoreMediaStreamHook();
        this.restoreLocalCaptureHook();
        this.restoreSrcObjectHook();
        this.restoreReceiverTrackHook();
        this.restorePeerConnectionHook();
        this.restoreMediaEngineSpeakingHooks();
        this.discoveredTracks.clear();
        this.stemSources.clear();
    }


    refreshVoiceRoom() {
        if (!this.armed || !this.voiceConnected || this.nativeRemoteActive) return;
        this.detachElementFallbacks();
        for (const attachment of this.remoteTracks.values()) attachment.cleanup();
        this.remoteTracks.clear();
        this.discoveredTracks.clear();
        this.engineSsrcUserMap.clear();
        this.rescanRemoteCapture();
        this.emitStatus(true);
    }

    async setVoiceConnected(connected: boolean, deviceId?: string | null) {
        this.voiceConnected = connected;
        if (!this.armed) return;
        if (!connected) {

            await this.stopNativeRemoteCapture();
            this.detachElementFallbacks();
            for (const attachment of this.remoteTracks.values()) attachment.cleanup();
            this.remoteTracks.clear();
            this.discoveredTracks.clear();
            this.engineSsrcUserMap.clear();
            this.detachMicrophone();
            this.emitStatus(true);
            return;
        }
        const nativeRemoteStarted = await this.startNativeRemoteCapture();
        if (!nativeRemoteStarted) {
            this.prepareRemoteCapture();
            this.startRecoveryTimer();
            this.rescanRemoteCapture();
        } else {
            this.stopRecoveryTimer();
            this.detachElementFallbacks();
            for (const attachment of this.remoteTracks.values()) attachment.cleanup();
            this.remoteTracks.clear();
        }
        if (this.microphoneWanted && !this.microphoneStream?.active) {
            try { await this.attachMicrophone(deviceId); } catch (error) {
                this.lastError = `Microphone was not attached: ${errorMessage(error)}`;
            }
        }
        this.emitStatus(true);
    }

    async setMicrophoneEnabled(enabled: boolean, deviceId?: string | null) {
        this.microphoneWanted = enabled;
        if (!this.armed) return;
        if (enabled && this.voiceConnected) {
            if (!this.microphoneStream?.active) await this.attachMicrophone(deviceId);
            return;
        }
        this.detachMicrophone();
        this.emitStatus(true);
    }

    clear() {
        if (this.ring.length) this.ring.fill(0);
        if (this.ringRight.length) this.ringRight.fill(0);
        this.writeIndex = 0;
        this.validSamples = 0;
        this.totalSamplesWritten = 0;
        this.lastSampleAt = 0;
        this.nativeRemotePendingPackets = [];
        this.resetNativeRemoteTimeline();
        this.stemSources.clear();
        for (const attachment of this.remoteTracks.values()) {
            if (!attachment.captureKey || attachment.slot == null) continue;
            this.ensureStemSource(attachment.captureKey, "remote", attachment.slot, attachment.receiver, {
                masterIncluded: attachment.masterIncluded,
                captureKind: attachment.captureKind,
                hintedUserId: attachment.hintedUserId
            });
        }
        if (this.microphoneCaptureKey) this.ensureStemSource(this.microphoneCaptureKey, "microphone", MICROPHONE_SLOT, null);
        this.emitStatus(true);
    }

    setMaxBufferSeconds(seconds: number) {
        const nextSeconds = clamp(Math.floor(seconds), 10, 3600);
        if (nextSeconds === this.maxBufferSeconds) return;
        this.maxBufferSeconds = nextSeconds;
        if (!this.sampleRate || !this.ring.length) {
            this.emitStatus(true);
            return;
        }

        const newRing = new Int16Array(this.sampleRate * nextSeconds);
        const newRingRight = new Int16Array(this.sampleRate * nextSeconds);
        const keep = Math.min(this.validSamples, newRing.length);
        const newest = this.copyNewestSamples(keep);
        for (let frame = 0; frame < keep; frame++) {
            newRing[frame] = newest[frame * 2];
            newRingRight[frame] = newest[frame * 2 + 1];
        }
        this.ring = newRing;
        this.ringRight = newRingRight;
        this.validSamples = keep;
        this.writeIndex = keep % newRing.length;
        this.pruneStemHistory();
        this.emitStatus(true);
    }

    prepareLatest(requestedSeconds: number, format: RecordingFormat): ReplayClip {
        if (!this.sampleRate || !this.validSamples) throw new Error("No voice audio has reached the replay buffer yet.");
        this.flushNativeRemotePackets();

        const requestedSamples = Math.round(clamp(requestedSeconds, 1, this.maxBufferSeconds) * this.sampleRate);
        if (this.validSamples < requestedSamples) {
            const available = this.validSamples / this.sampleRate;
            throw new Error(`Only ${available.toFixed(1)}s are buffered. Wait until the full requested duration is available.`);
        }
        let samples = this.copyNewestSamples(requestedSamples);
        const durationSeconds = requestedSamples / this.sampleRate;
        const clipEndedAt = this.lastSampleAt || Date.now();
        const clipStartedAt = clipEndedAt - durationSeconds * 1000;
        const { stems, residualStem, unmappedRemoteSources } = this.extractStemSamples(requestedSamples);
        samples = this.mixSupplementalRemoteIntoMaster(samples, requestedSamples);

        return {
            samples,
            format,
            extension: format === "flac" ? "flac" : "wav",
            mimeType: format === "flac" ? "audio/flac" : "audio/wav",
            sampleRate: this.sampleRate,
            channels: 2,
            durationSeconds,
            clipStartedAt,
            clipEndedAt,
            stems,
            residualStem,
            unmappedRemoteSources
        };
    }

    private onStemWorkletPacket(data: any) {
        const rawStartFrame = Number(data?.startFrame);
        const chunkStartSample = Number.isFinite(rawStartFrame) && rawStartFrame >= 0
            ? Math.floor(rawStartFrame)
            : this.totalSamplesWritten;

        const levels = data?.levels instanceof Float32Array ? data.levels : null;
        if (levels) this.updateStemMappings(levels);

        for (const item of Array.isArray(data?.tracks) ? data.tracks : []) {
            const slot = Number(item?.slot);
            const floatSamples = item?.samples;
            if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_CAPTURE_INPUTS || !(floatSamples instanceof Float32Array)) continue;
            const captureKey = this.slotCaptureKeys[slot];
            if (!captureKey) continue;
            const source = this.stemSources.get(captureKey);
            if (!source) continue;

            const converted = new Int16Array(floatSamples.length);
            let hasSignal = false;
            for (let i = 0; i < floatSamples.length; i++) {
                const value = pcm16(floatSamples[i]);
                converted[i] = value;
                if (Math.abs(value) > 2) hasSignal = true;
            }
            if (!hasSignal) continue;




            const mappedUserId = source.mappedUserId;
            const soleSpeakingUser = this.speakingRemoteUserIds.size === 1
                ? Array.from(this.speakingRemoteUserIds)[0]
                : null;
            const solePresentUser = this.presentRemoteUserIds.size === 1
                ? Array.from(this.presentRemoteUserIds)[0]
                : null;
            const solePresent = Boolean(mappedUserId && solePresentUser === mappedUserId);
            const soleSpeaker = Boolean(mappedUserId && soleSpeakingUser === mappedUserId);
            const stableIndividualMapping = Boolean(
                mappedUserId
                && source.captureKind !== "element-fallback"
                && (source.mapScores.get(mappedUserId) ?? 0) >= 6
            );

            const fallbackChunkUser = source.sourceType === "remote" && source.captureKind === "element-fallback"
                ? (soleSpeakingUser ?? solePresentUser)
                : null;
            const chunkUserId = fallbackChunkUser
                ?? (source.sourceType === "microphone" || source.reliableMapping || stableIndividualMapping || solePresent || soleSpeaker
                    ? mappedUserId
                    : null);
            source.chunks.push({
                startSample: chunkStartSample,
                samples: converted,
                userId: chunkUserId
            });
        }

        this.pruneStemHistory();
    }

    private writeMasterChunk(leftSamples: Float32Array, rightSamples: Float32Array = leftSamples) {
        if (!this.armed || !this.ring.length || !this.sampleRate || !leftSamples.length) return;

        const frames = Math.min(leftSamples.length, rightSamples.length || leftSamples.length);
        let squareSum = 0;
        let peak = 0;
        const bandSquares = new Float64Array(7);
        const bandPeaks = new Float32Array(7);
        const bandCounts = new Uint16Array(7);

        for (let i = 0; i < frames; i++) {
            const left = clamp(leftSamples[i], -1, 1);
            const right = clamp(rightSamples[i] ?? left, -1, 1);
            const meter = (left + right) * .5;
            const abs = Math.max(Math.abs(left), Math.abs(right));
            squareSum += meter * meter;
            peak = Math.max(peak, abs);

            const band = Math.min(6, Math.floor(i * 7 / frames));
            bandSquares[band] += meter * meter;
            bandPeaks[band] = Math.max(bandPeaks[band], abs);
            bandCounts[band]++;

            this.ring[this.writeIndex] = pcm16(left);
            this.ringRight[this.writeIndex] = pcm16(right);
            this.writeIndex = (this.writeIndex + 1) % this.ring.length;
        }

        this.validSamples = Math.min(this.validSamples + frames, this.ring.length);
        this.totalSamplesWritten += frames;

        const normalize = (rms: number, localPeak: number) => {
            const raw = Math.max(rms * 5.15, localPeak * 1.45);
            if (raw < .0028) return 0;
            return clamp(Math.pow((raw - .0028) / .38, .62), 0, 1);
        };

        const now = Date.now();
        const rms = Math.sqrt(squareSum / frames);
        const gated = normalize(rms, peak);
        const nativeAge = Math.max(0, now - this.nativeRemoteMeterAt);
        const nativeDecay = nativeAge <= 90 ? 1 : Math.exp(-(nativeAge - 90) / 170);
        const combinedLevel = Math.max(gated, this.nativeRemoteLevel * nativeDecay);
        this.liveLevel = combinedLevel > this.liveLevel
            ? this.liveLevel + (combinedLevel - this.liveLevel) * .90
            : this.liveLevel + (combinedLevel - this.liveLevel) * .30;
        this.waveBands = Array.from({ length: 7 }, (_, index) => {
            const count = Math.max(1, bandCounts[index]);
            const graphBand = normalize(Math.sqrt(bandSquares[index] / count), bandPeaks[index]);
            return Math.max(graphBand, (this.nativeRemoteBands[index] ?? 0) * nativeDecay);
        });
        this.lastSampleAt = now;
        this.flushNativeRemotePackets();
        this.emitStatus(false);
    }

    private onAudioProcessFallback(event: AudioProcessingEvent) {
        const input = event.inputBuffer;
        const frames = input.length || 1024;
        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        if (input.numberOfChannels) {
            left.set(input.getChannelData(0));
            if (input.numberOfChannels > 1) right.set(input.getChannelData(1));
            else right.set(left);
        }

        this.writeMasterChunk(left, right);
    }

    private async startNativeRemoteCapture(): Promise<boolean> {
        if (!this.nativeRemoteBridge || !this.armed || !this.voiceConnected) return false;
        if (this.nativeRemoteActive) return true;
        try {
            const result = await this.nativeRemoteBridge.start();
            if (!result?.ok) {
                if (result?.error) this.lastError = `Windows Discord audio backend unavailable: ${result.error}`;
                return false;
            }
            this.nativeRemoteActive = true;
            this.nativeRemotePendingPackets = [];
            this.nativeRemoteLevel = 0;
            this.nativeRemoteBands = [0, 0, 0, 0, 0, 0, 0];
            this.nativeRemoteMeterAt = 0;
            this.resetNativeRemoteTimeline();
            const source = this.ensureStemSource(this.nativeRemoteCaptureKey, "remote", -1, null, {
                masterIncluded: true,
                captureKind: "native-process"
            });
            source.mappedUserId = null;
            source.reliableMapping = false;
            source.active = true;
            this.startNativeRemotePoll();
            this.emitStatus(true);
            return true;
        } catch (error) {
            this.lastError = `Windows Discord audio backend failed to start: ${errorMessage(error)}`;
            this.nativeRemoteActive = false;
            return false;
        }
    }

    private async stopNativeRemoteCapture() {
        if (this.nativeRemotePollTimer != null) window.clearInterval(this.nativeRemotePollTimer);
        this.nativeRemotePollTimer = null;
        this.nativeRemotePollBusy = false;
        this.nativeRemoteActive = false;
        this.nativeRemotePendingPackets = [];
        this.nativeRemoteLevel = 0;
        this.nativeRemoteBands = [0, 0, 0, 0, 0, 0, 0];
        this.nativeRemoteMeterAt = 0;
        this.resetNativeRemoteTimeline();
        const source = this.stemSources.get(this.nativeRemoteCaptureKey);
        if (source) source.active = false;
        if (!this.nativeRemoteBridge) return;
        try { await this.nativeRemoteBridge.stop(); } catch {   }
    }

    private startNativeRemotePoll() {
        if (!this.nativeRemoteBridge || this.nativeRemotePollTimer != null) return;
        const poll = () => void this.pollNativeRemoteCapture();
        this.nativeRemotePollTimer = window.setInterval(poll, 35);
        poll();
    }

    private activateRendererFallback(error?: string) {
        this.nativeRemoteActive = false;
        if (this.nativeRemotePollTimer != null) window.clearInterval(this.nativeRemotePollTimer);
        this.nativeRemotePollTimer = null;
        if (error) this.lastError = error;
        if (!this.armed || !this.voiceConnected) return;

        this.prepareRemoteCapture();
        this.startRecoveryTimer();
        this.rescanRemoteCapture();
        this.emitStatus(true);
    }

    private async pollNativeRemoteCapture() {
        if (!this.nativeRemoteBridge || !this.nativeRemoteActive || this.nativeRemotePollBusy || !this.armed) return;
        this.nativeRemotePollBusy = true;
        try {
            const result = await this.nativeRemoteBridge.poll();
            if (!this.nativeRemoteActive || !this.armed) return;
            this.nativeRemotePendingPackets.push(...(result?.packets ?? []).map(packet => ({
                packet,
                samples: null,
                startGlobal: null
            })));
            while (this.nativeRemotePendingPackets.length > 300) this.nativeRemotePendingPackets.shift();
            this.flushNativeRemotePackets();
            if (!result?.active) {
                this.activateRendererFallback(result?.error ? `Windows Discord audio backend stopped: ${result.error}` : undefined);
            }
        } catch (error) {
            this.activateRendererFallback(`Windows Discord audio backend polling failed: ${errorMessage(error)}`);
        } finally {
            this.nativeRemotePollBusy = false;
        }
    }

    private resetNativeRemoteTimeline() {
        this.nativeRemoteAnchorTimeMs = null;
        this.nativeRemoteAnchorGlobalSample = null;
        this.nativeRemoteLastPacketEndGlobal = null;
        this.nativeMixGain = 1;
    }

    private nativePacketStartGlobal(packet: NativeRemoteCapturePacket, timelineEndMs: number) {
        const packetTimeMs = Number(packet.startTimeMs);
        const timestampStart = this.totalSamplesWritten
            + Math.round((packetTimeMs - timelineEndMs) * this.sampleRate / 1000);
        const mustReanchor = !Number.isFinite(packetTimeMs)
            || this.nativeRemoteAnchorTimeMs == null
            || this.nativeRemoteAnchorGlobalSample == null
            || packetTimeMs < this.nativeRemoteAnchorTimeMs;

        if (mustReanchor) {
            this.nativeRemoteAnchorTimeMs = packetTimeMs;
            this.nativeRemoteAnchorGlobalSample = timestampStart;
            return timestampStart;
        }

        let projected = this.nativeRemoteAnchorGlobalSample!
            + Math.round((packetTimeMs - this.nativeRemoteAnchorTimeMs!) * this.sampleRate / 1000);



        const driftSamples = Math.abs(projected - timestampStart);
        if (driftSamples > this.sampleRate * 0.25) {
            this.nativeRemoteAnchorTimeMs = packetTimeMs;
            this.nativeRemoteAnchorGlobalSample = timestampStart;
            return timestampStart;
        }



        const snapLimit = Math.max(2, Math.round(this.sampleRate * .02));
        if (this.nativeRemoteLastPacketEndGlobal != null
            && Math.abs(projected - this.nativeRemoteLastPacketEndGlobal) <= snapLimit) {
            projected = this.nativeRemoteLastPacketEndGlobal;
        }

        return projected;
    }

    private resampleNativePcm(samples: Int16Array, inputRate: number): Int16Array {
        if (!samples.length || !this.sampleRate || inputRate === this.sampleRate) return samples;
        const outputLength = Math.max(1, Math.round(samples.length * this.sampleRate / inputRate));
        const output = new Int16Array(outputLength);
        const ratio = inputRate / this.sampleRate;
        for (let i = 0; i < outputLength; i++) {
            const position = i * ratio;
            const left = Math.min(samples.length - 1, Math.floor(position));
            const right = Math.min(samples.length - 1, left + 1);
            const fraction = position - left;
            output[i] = Math.round(samples[left] + (samples[right] - samples[left]) * fraction);
        }
        return output;
    }

    private flushNativeRemotePackets() {
        if (!this.nativeRemotePendingPackets.length || !this.validSamples || !this.sampleRate || !this.lastSampleAt) return;
        const pending: PendingNativeRemoteCapturePacket[] = [];
        for (const entry of this.nativeRemotePendingPackets) {
            if (entry.samples == null || entry.startGlobal == null) {
                const bytes = entry.packet?.pcm16;
                const inputRate = Math.floor(Number(entry.packet?.sampleRate));
                const startTimeMs = Number(entry.packet?.startTimeMs);
                if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || !Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(startTimeMs)) continue;

                const copiedBytes = bytes.slice(0, bytes.byteLength - (bytes.byteLength % 2));
                let samples: Int16Array<ArrayBufferLike> = new Int16Array(copiedBytes.buffer, copiedBytes.byteOffset, copiedBytes.byteLength / 2).slice();
                samples = this.resampleNativePcm(samples, inputRate);
                if (!samples.length) continue;

                entry.samples = samples;
                entry.startGlobal = this.nativePacketStartGlobal(entry.packet, this.lastSampleAt);
                this.nativeRemoteLastPacketEndGlobal = entry.startGlobal + samples.length;
            }

            if (entry.startGlobal + entry.samples.length > this.totalSamplesWritten) {
                pending.push(entry);
                continue;
            }

            this.overlayNativeRemotePacket(entry.samples, entry.startGlobal);
        }
        this.nativeRemotePendingPackets = pending;
    }

    private overlayNativeRemotePacket(samples: Int16Array<ArrayBufferLike>, packetStartGlobal: number) {
        if (!this.nativeRemoteActive || !this.armed || !this.ring.length || !this.sampleRate || !this.validSamples) return;
        const oldestGlobal = this.totalSamplesWritten - this.validSamples;
        const overlapStart = Math.max(packetStartGlobal, oldestGlobal);
        const overlapEnd = packetStartGlobal + samples.length;
        if (overlapEnd <= overlapStart) return;

        const sourceOffset = overlapStart - packetStartGlobal;
        const count = overlapEnd - overlapStart;
        let squareSum = 0;
        let peak = 0;
        const bandSquares = new Float64Array(7);
        const bandPeaks = new Float32Array(7);
        const bandCounts = new Uint32Array(7);
        const remoteSamples = new Int16Array(count);
        const limiterCeiling = .965;
        const releaseStep = 1 - Math.exp(-1 / (this.sampleRate * .12));

        for (let i = 0; i < count; i++) {
            const globalSample = overlapStart + i;
            const samplesBehindWriteHead = this.totalSamplesWritten - globalSample;
            const ringIndex = (this.writeIndex - samplesBehindWriteHead + this.ring.length) % this.ring.length;
            const normalized = softLimitUnit(pcm16Unit(samples[sourceOffset + i]));
            const remote = pcm16(normalized);
            remoteSamples[i] = remote;

            const leftSum = pcm16Unit(this.ring[ringIndex]) + normalized;
            const rightSum = pcm16Unit(this.ringRight[ringIndex]) + normalized;
            const framePeak = Math.max(Math.abs(leftSum), Math.abs(rightSum));
            const targetGain = framePeak > limiterCeiling ? limiterCeiling / framePeak : 1;
            this.nativeMixGain = targetGain < this.nativeMixGain
                ? targetGain
                : this.nativeMixGain + (1 - this.nativeMixGain) * releaseStep;
            this.ring[ringIndex] = pcm16(leftSum * this.nativeMixGain);
            this.ringRight[ringIndex] = pcm16(rightSum * this.nativeMixGain);

            const abs = Math.abs(normalized);
            squareSum += normalized * normalized;
            peak = Math.max(peak, abs);
            const band = Math.min(6, Math.floor(i * 7 / count));
            bandSquares[band] += normalized * normalized;
            bandPeaks[band] = Math.max(bandPeaks[band], abs);
            bandCounts[band]++;
        }

        const stem = this.ensureStemSource(this.nativeRemoteCaptureKey, "remote", -1, null, {
            masterIncluded: true,
            captureKind: "native-process"
        });
        stem.mappedUserId = null;
        stem.reliableMapping = false;
        stem.active = true;
        stem.chunks.push({
            startSample: overlapStart,
            samples: remoteSamples,
            userId: null
        });
        this.pruneStemHistory();

        const normalize = (rms: number, localPeak: number) => {
            const raw = Math.max(rms * 5.15, localPeak * 1.45);
            if (raw < .0028) return 0;
            return clamp(Math.pow((raw - .0028) / .38, .62), 0, 1);
        };
        const rms = Math.sqrt(squareSum / Math.max(1, count));
        this.nativeRemoteLevel = normalize(rms, peak);
        this.nativeRemoteBands = Array.from({ length: 7 }, (_, index) => {
            const bandCount = Math.max(1, bandCounts[index]);
            return normalize(Math.sqrt(bandSquares[index] / bandCount), bandPeaks[index]);
        });
        this.nativeRemoteMeterAt = Date.now();
        this.emitStatus(false);
    }

    private copyNewestSamples(sampleCount: number): Int16Array {
        if (!sampleCount) return new Int16Array(0);
        const result = new Int16Array(sampleCount * 2);
        const start = (this.writeIndex - sampleCount + this.ring.length) % this.ring.length;
        for (let frame = 0; frame < sampleCount; frame++) {
            const index = (start + frame) % this.ring.length;
            result[frame * 2] = this.ring[index];
            result[frame * 2 + 1] = this.ringRight[index];
        }
        return result;
    }

    private extractStemSamples(sampleCount: number) {
        const clipEndSample = this.totalSamplesWritten;
        const clipStartSample = clipEndSample - sampleCount;
        const grouped = new Map<string, Int16Array>();
        const residual = new Int16Array(sampleCount);
        let residualHasSignal = false;
        const unmappedSources = new Set<string>();

        const addChunk = (target: Int16Array, chunk: StemChunk) => {
            const chunkStart = chunk.startSample;
            const chunkEnd = chunkStart + chunk.samples.length;
            const overlapStart = Math.max(clipStartSample, chunkStart);
            const overlapEnd = Math.min(clipEndSample, chunkEnd);
            if (overlapEnd <= overlapStart) return;
            const sourceOffset = overlapStart - chunkStart;
            const targetOffset = overlapStart - clipStartSample;
            const count = overlapEnd - overlapStart;
            for (let i = 0; i < count; i++) {
                const index = targetOffset + i;
                target[index] = clamp(target[index] + chunk.samples[sourceOffset + i], -32768, 32767);
            }
        };

        const mergeParticipantChunk = (target: Int16Array, chunk: StemChunk) => {
            const chunkStart = chunk.startSample;
            const chunkEnd = chunkStart + chunk.samples.length;
            const overlapStart = Math.max(clipStartSample, chunkStart);
            const overlapEnd = Math.min(clipEndSample, chunkEnd);
            if (overlapEnd <= overlapStart) return;
            const sourceOffset = overlapStart - chunkStart;
            const targetOffset = overlapStart - clipStartSample;
            const count = overlapEnd - overlapStart;
            for (let i = 0; i < count; i++) {
                const index = targetOffset + i;
                const sample = chunk.samples[sourceOffset + i];




                if (Math.abs(sample) > Math.abs(target[index])) target[index] = sample;
            }
        };

        for (const source of this.stemSources.values()) {
            if (source.sourceType === "remote" && !source.approvedVoiceSource) continue;
            for (const chunk of source.chunks) {
                if (chunk.startSample + chunk.samples.length <= clipStartSample || chunk.startSample >= clipEndSample) continue;
                const userId = chunk.userId;
                if (userId) {
                    let target = grouped.get(userId);
                    if (!target) {
                        target = new Int16Array(sampleCount);
                        grouped.set(userId, target);
                    }
                    mergeParticipantChunk(target, chunk);
                } else if (source.sourceType === "remote") {
                    addChunk(residual, chunk);
                    residualHasSignal = true;
                    unmappedSources.add(source.captureKey);
                }
            }
        }

        const stems: EncodedStem[] = [];
        for (const [userId, samples] of grouped) {
            let nonZero = false;
            for (let i = 0; i < samples.length; i += 256) {
                if (samples[i] !== 0) { nonZero = true; break; }
            }
            if (nonZero) stems.push({ userId, samples });
        }

        return {
            stems,
            residualStem: residualHasSignal ? residual : null,
            unmappedRemoteSources: unmappedSources.size
        };
    }



    private mixSupplementalRemoteIntoMaster(master: Int16Array, sampleCount: number) {
        const clipEndSample = this.totalSamplesWritten;
        const clipStartSample = clipEndSample - sampleCount;
        const grouped = new Map<string, Int16Array>();
        const directRemoteMask = new Uint8Array(sampleCount);

        const overlap = (chunk: StemChunk) => {
            const overlapStart = Math.max(clipStartSample, chunk.startSample);
            const overlapEnd = Math.min(clipEndSample, chunk.startSample + chunk.samples.length);
            if (overlapEnd <= overlapStart) return null;
            return {
                sourceOffset: overlapStart - chunk.startSample,
                targetOffset: overlapStart - clipStartSample,
                count: overlapEnd - overlapStart
            };
        };


        for (const source of this.stemSources.values()) {
            if (source.sourceType !== "remote" || !source.masterIncluded) continue;
            for (const chunk of source.chunks) {
                const range = overlap(chunk);
                if (!range) continue;
                for (let i = 0; i < range.count; i++) {
                    if (Math.abs(chunk.samples[range.sourceOffset + i]) > 8) directRemoteMask[range.targetOffset + i] = 1;
                }
            }
        }

        const mergeStronger = (target: Int16Array, chunk: StemChunk) => {
            const range = overlap(chunk);
            if (!range) return;
            for (let i = 0; i < range.count; i++) {
                const sample = chunk.samples[range.sourceOffset + i];
                const index = range.targetOffset + i;
                if (directRemoteMask[index]) continue;
                if (Math.abs(sample) > Math.abs(target[index])) target[index] = sample;
            }
        };

        for (const source of this.stemSources.values()) {
            if (source.sourceType !== "remote" || source.masterIncluded || !source.approvedVoiceSource) continue;
            const groupKey = source.mappedUserId ? `user:${source.mappedUserId}` : `source:${source.captureKey}`;
            let track = grouped.get(groupKey);
            if (!track) {
                track = new Int16Array(sampleCount);
                grouped.set(groupKey, track);
            }
            for (const chunk of source.chunks) mergeStronger(track, chunk);
        }

        if (!grouped.size) return master;
        const mixed = master.slice();
        for (const track of grouped.values()) {
            for (let frame = 0; frame < sampleCount; frame++) {
                const sample = track[frame];
                if (!sample) continue;
                const leftIndex = frame * 2;
                mixed[leftIndex] = mixPcm16(mixed[leftIndex], sample);
                mixed[leftIndex + 1] = mixPcm16(mixed[leftIndex + 1], sample);
            }
        }
        return mixed;
    }

    private pruneStemHistory() {
        if (!this.ring.length) return;
        const cutoff = Math.max(0, this.totalSamplesWritten - this.ring.length);
        for (const [key, source] of this.stemSources) {
            while (source.chunks.length && source.chunks[0].startSample + source.chunks[0].samples.length <= cutoff) {
                source.chunks.shift();
            }
            if (!source.active && !source.chunks.length) this.stemSources.delete(key);
        }
    }

    private ensureStemSource(
        captureKey: string,
        sourceType: "remote" | "microphone",
        slot: number,
        receiver: RTCRtpReceiver | null,
        options: { masterIncluded?: boolean; captureKind?: RemoteCaptureKind | "microphone"; hintedUserId?: string | null; } = {}
    ) {
        let source = this.stemSources.get(captureKey);
        if (source) {
            source.active = true;
            source.receiver = receiver ?? source.receiver;
            source.masterIncluded = options.masterIncluded ?? source.masterIncluded;
            if (options.captureKind) source.captureKind = options.captureKind;
            if (options.hintedUserId && options.hintedUserId !== this.localUserId) this.assignMapping(source, options.hintedUserId, true);
            return source;
        }
        const captureKind = options.captureKind ?? (sourceType === "microphone" ? "microphone" : "direct");
        const hintedUserId = sourceType === "microphone" ? this.localUserId : options.hintedUserId ?? null;
        source = {
            captureKey,
            sourceType,
            slot,
            mappedUserId: hintedUserId,
            reliableMapping: sourceType === "microphone" || Boolean(hintedUserId),
            receiver,
            chunks: [],
            mapScores: new Map(),
            mismatchTicks: 0,
            lastLevel: 0,
            active: true,
            masterIncluded: options.masterIncluded ?? sourceType === "microphone",
            captureKind,

            approvedVoiceSource: true,
            voiceEvidence: captureKind === "element-fallback" ? 10 : 0
        };
        this.stemSources.set(captureKey, source);
        return source;
    }

    private updateStemMappings(levels: Float32Array) {
        for (let slot = 0; slot < Math.min(levels.length, MAX_CAPTURE_INPUTS); slot++) {
            const captureKey = this.slotCaptureKeys[slot];
            if (!captureKey) continue;
            const source = this.stemSources.get(captureKey);
            if (!source) continue;
            const level = Number(levels[slot] || 0);
            source.lastLevel = level;
            if (source.sourceType === "remote" && source.masterIncluded && level > TRACK_SIGNAL_THRESHOLD * 2.1) {
                this.trustedRemoteSignalAt = Date.now();
            }
            if (source.captureKind === "element-fallback") {
                const audible = level > TRACK_SIGNAL_THRESHOLD * 2.3;
                if (audible && this.speakingRemoteUserIds.size > 0) source.voiceEvidence = Math.min(40, source.voiceEvidence + 1);
                else if (!audible) source.voiceEvidence = Math.max(0, source.voiceEvidence - .08);
                source.approvedVoiceSource = true;
            }
            if (source.sourceType === "microphone") {
                if (this.localUserId && source.mappedUserId !== this.localUserId) this.assignMapping(source, this.localUserId, true);
                continue;
            }

            const reliable = this.resolveReceiverUserId(source.receiver);
            if (reliable) {
                this.assignMapping(source, reliable, true);
                continue;
            }
            if (source.reliableMapping) continue;

            const audible = level > TRACK_SIGNAL_THRESHOLD * 2.3;
            const speakers = Array.from(this.speakingRemoteUserIds);
            if (source.mappedUserId) {
                if (audible && speakers.length === 1 && speakers[0] !== source.mappedUserId) {
                    source.mismatchTicks++;
                    if (source.mismatchTicks >= 8) {


                        source.mappedUserId = null;
                        source.mapScores.clear();
                        source.mismatchTicks = 0;
                    }
                } else if (speakers.includes(source.mappedUserId) || !audible) {
                    source.mismatchTicks = Math.max(0, source.mismatchTicks - 1);
                }
                continue;
            }

            if (!audible) continue;
            let candidate: string | null = null;
            if (this.presentRemoteUserIds.size === 1) candidate = Array.from(this.presentRemoteUserIds)[0];
            else if (speakers.length === 1) candidate = speakers[0];
            if (!candidate) continue;

            for (const [userId, score] of source.mapScores) source.mapScores.set(userId, Math.max(0, score - .35));
            const score = (source.mapScores.get(candidate) ?? 0) + 1;
            source.mapScores.set(candidate, score);
            const runnerUp = Math.max(0, ...Array.from(source.mapScores.entries()).filter(([id]) => id !== candidate).map(([, value]) => value));
            if (score >= 6 && score - runnerUp >= 3) this.assignMapping(source, candidate, false);
        }
    }

    private assignMapping(source: StemSource, userId: string, reliable: boolean) {
        if (!userId || userId === this.localUserId && source.sourceType === "remote") return;
        const changed = source.mappedUserId !== userId;
        source.mappedUserId = userId;
        source.reliableMapping = source.reliableMapping || reliable;
        source.mismatchTicks = 0;
        if (!changed) return;

        const retroactiveSamples = reliable
            ? this.ring.length
            : Math.max(1, Math.floor(this.sampleRate * 1.8));
        const cutoff = this.totalSamplesWritten - retroactiveSamples;
        for (const chunk of source.chunks) {
            if (chunk.userId == null && chunk.startSample + chunk.samples.length >= cutoff) chunk.userId = userId;
        }
        this.emitStatus(true);
    }

    private resolveReceiverUserId(receiver: RTCRtpReceiver | null): string | null {
        if (!receiver) return null;

        const resolveSsrc = (ssrc: number) => {
            const numeric = Math.floor(Number(ssrc));
            if (!Number.isFinite(numeric) || numeric <= 0) return null;
            const known = this.ssrcUserMap.get(numeric);
            if (known) return known;
            const nativeKnown = this.engineSsrcUserMap.get(numeric);
            if (nativeKnown && (!this.presentRemoteUserIds.size || this.presentRemoteUserIds.has(nativeKnown))) return nativeKnown;


            try {
                const engine = (MediaEngineStore as any)?.getMediaEngine?.();
                for (const connection of engine?.connections ?? []) {
                    if (connection?.context && connection.context !== "default") continue;
                    const candidate = connection?.getUserIdBySsrc?.(numeric);
                    if (candidate != null) {
                        const userId = String(candidate);
                        if (userId && userId !== this.localUserId && (!this.presentRemoteUserIds.size || this.presentRemoteUserIds.has(userId))) {
                            this.ssrcUserMap.set(numeric, userId);
                            return userId;
                        }
                    }
                }
            } catch {   }
            return null;
        };

        try {
            for (const source of receiver.getSynchronizationSources?.() ?? []) {
                const userId = resolveSsrc(Number(source.source));
                if (userId) return userId;
            }
            for (const source of receiver.getContributingSources?.() ?? []) {
                const userId = resolveSsrc(Number(source.source));
                if (userId) return userId;
            }
        } catch {   }
        return null;
    }

    private refreshReliableMappings() {
        for (const source of this.stemSources.values()) {
            if (source.sourceType !== "remote") continue;
            const userId = this.resolveReceiverUserId(source.receiver);
            if (userId) this.assignMapping(source, userId, true);
        }
    }

    private detachMicrophone() {
        if (this.microphoneRecoveryTimer != null) window.clearTimeout(this.microphoneRecoveryTimer);
        this.microphoneRecoveryTimer = null;
        if (this.microphoneCaptureKey) {
            const stem = this.stemSources.get(this.microphoneCaptureKey);
            if (stem) stem.active = false;
            this.slotCaptureKeys[MICROPHONE_SLOT] = null;
            this.microphoneCaptureKey = null;
        }
        try { this.microphoneSource?.disconnect(); } catch {   }
        this.microphoneSource = null;
        this.microphoneStream?.getTracks().forEach(track => track.stop());
        this.microphoneStream = null;
        this.microphoneTrackIds.clear();
    }

    private scheduleMicrophoneRecovery(stream: MediaStream) {
        if (this.microphoneRecoveryTimer != null) return;
        this.microphoneRecoveryTimer = window.setTimeout(() => {
            this.microphoneRecoveryTimer = null;
            if (!this.armed || !this.voiceConnected || !this.microphoneWanted || this.microphoneStream !== stream) return;
            void this.attachMicrophone(this.microphoneDeviceId).catch(error => {
                this.lastError = `Microphone recovery failed: ${errorMessage(error)}`;
                this.emitStatus(true);
            });
        }, 750);
    }

    private async requestMicrophoneStream(deviceId?: string | null): Promise<MediaStream> {
        const selectedDeviceId = typeof deviceId === "string" && deviceId && deviceId !== "default" ? deviceId : null;
        const rawAudio: MediaTrackConstraints = {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
        };
        const preferred: MediaTrackConstraints = {
            ...rawAudio,
            channelCount: { ideal: 2 },
            sampleRate: { ideal: 48_000 },
            ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {})
        };
        const compatible: MediaTrackConstraints = {
            ...rawAudio,
            ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {})
        };
        const candidates: Array<MediaTrackConstraints | true> = [preferred, compatible, true];
        let lastError: unknown;

        for (const audio of candidates) {
            try {
                return await navigator.mediaDevices.getUserMedia({ audio, video: false });
            } catch (error) {
                if (error instanceof DOMException && TERMINAL_MEDIA_ERRORS.has(error.name)) throw error;
                lastError = error;
            }
        }

        throw lastError ?? new Error("No microphone input is available.");
    }

    private async attachMicrophone(deviceId?: string | null) {
        if (!this.context || !this.captureNode || !this.armed || !this.voiceConnected) return;
        this.detachMicrophone();
        this.microphoneDeviceId = typeof deviceId === "string" ? deviceId : null;
        const stream = await this.requestMicrophoneStream(this.microphoneDeviceId);
        if (!this.armed || !this.context || !this.captureNode || !this.voiceConnected) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }

        this.microphoneStream = stream;
        for (const track of stream.getAudioTracks()) {
            this.microphoneTrackIds.add(track.id);
            track.addEventListener("ended", () => {
                this.microphoneTrackIds.delete(track.id);
                this.scheduleMicrophoneRecovery(stream);
            }, { once: true });
        }
        this.microphoneSource = this.createMediaStreamSourceInternal(stream);
        if (!this.mixer) throw new Error("Voice Replay mixed input is unavailable.");
        this.microphoneSource.connect(this.mixer);

        if (this.multiTrackWorklet && this.stemCaptureNode) {
            const captureKey = `microphone:${this.localUserId ?? "local"}:${++this.captureSerial}`;
            this.microphoneCaptureKey = captureKey;
            this.slotCaptureKeys[MICROPHONE_SLOT] = captureKey;
            const stem = this.ensureStemSource(captureKey, "microphone", MICROPHONE_SLOT, null);
            stem.mappedUserId = this.localUserId;
            stem.reliableMapping = true;
            this.microphoneSource.connect(this.stemCaptureNode, 0, MICROPHONE_SLOT);
        }
    }

    private createMediaStreamSourceInternal(stream: MediaStream) {
        if (!this.context) throw new Error("Voice Replay audio context is unavailable.");
        this.bypassAudioDiscovery++;
        try {
            const create = this.originalCreateMediaStreamSource ?? this.context.createMediaStreamSource;
            return create.call(this.context, stream);
        } finally {
            this.bypassAudioDiscovery--;
        }
    }

    private inspectAudioNodeSource(node: AudioNode) {
        if (!node || this.bypassAudioDiscovery) return;
        const candidate = node as any;

        try {
            const stream = candidate.mediaStream;
            if (stream instanceof MediaStream && stream.getAudioTracks().length) {
                this.attachRemoteStream(stream);
                return;
            }
        } catch {   }

        try {
            const track = candidate.mediaStreamTrack;
            if (track instanceof MediaStreamTrack && track.kind === "audio") {
                this.attachRemoteTrack(track, null, { captureKind: "direct", masterIncluded: true });
                return;
            }
        } catch {   }

        try {
            const element = candidate.mediaElement;
            if (element instanceof HTMLMediaElement) this.attachMediaElement(element);
        } catch {   }
    }

    private rememberEngineSsrc(userIdValue: unknown, ssrcValue: unknown) {
        const userId = String(userIdValue ?? "");
        const ssrc = Math.floor(Number(ssrcValue));
        if (!userId || userId === this.localUserId || !Number.isFinite(ssrc) || ssrc <= 0) return;
        this.engineSsrcUserMap.set(ssrc, userId);
    }

    private installMediaEngineSpeakingHooks(target: any) {
        if (!target || this.mediaEngineSpeakingHooks.has(target)) return;
        const originalNative = typeof target.handleSpeakingNative === "function" ? target.handleSpeakingNative : null;
        const originalFlags = typeof target.handleSpeakingFlags === "function" ? target.handleSpeakingFlags : null;
        const originalCreateUser = typeof target.createUser === "function" ? target.createUser : null;
        if (!originalNative && !originalFlags && !originalCreateUser) return;

        const recorder = this;
        let wrappedNative: any = null;
        let wrappedFlags: any = null;
        let wrappedCreateUser: any = null;
        try {
            if (originalNative) {
                wrappedNative = function (this: any, userId: string, speaking: boolean | number, ssrc: number, ...rest: any[]) {
                    recorder.rememberEngineSsrc(userId, ssrc);
                    return originalNative.call(this, userId, speaking, ssrc, ...rest);
                };
                target.handleSpeakingNative = wrappedNative;
            }
            if (originalFlags) {
                wrappedFlags = function (this: any, userId: string, flags: number, ssrc: number, ...rest: any[]) {
                    recorder.rememberEngineSsrc(userId, ssrc);
                    return originalFlags.call(this, userId, flags, ssrc, ...rest);
                };
                target.handleSpeakingFlags = wrappedFlags;
            }



            if (originalCreateUser) {
                wrappedCreateUser = function (this: any, userId: string, audioSsrc: number, videoSsrc: number, ...rest: any[]) {
                    recorder.rememberEngineSsrc(userId, audioSsrc);
                    return originalCreateUser.call(this, userId, audioSsrc, videoSsrc, ...rest);
                };
                target.createUser = wrappedCreateUser;
            }
            this.mediaEngineSpeakingHooks.set(target, {
                originalNative,
                wrappedNative,
                originalFlags,
                wrappedFlags,
                originalCreateUser,
                wrappedCreateUser
            });
        } catch {
            try { if (originalNative && target.handleSpeakingNative === wrappedNative) target.handleSpeakingNative = originalNative; } catch {   }
            try { if (originalFlags && target.handleSpeakingFlags === wrappedFlags) target.handleSpeakingFlags = originalFlags; } catch {   }
            try { if (originalCreateUser && target.createUser === wrappedCreateUser) target.createUser = originalCreateUser; } catch {   }
        }
    }

    private restoreMediaEngineSpeakingHooks() {
        for (const [target, hook] of this.mediaEngineSpeakingHooks) {
            try { if (hook.originalNative && target.handleSpeakingNative === hook.wrappedNative) target.handleSpeakingNative = hook.originalNative; } catch {   }
            try { if (hook.originalFlags && target.handleSpeakingFlags === hook.wrappedFlags) target.handleSpeakingFlags = hook.originalFlags; } catch {   }
            try { if (hook.originalCreateUser && target.createUser === hook.wrappedCreateUser) target.createUser = hook.originalCreateUser; } catch {   }
        }
        this.mediaEngineSpeakingHooks.clear();
        this.engineSsrcUserMap.clear();
    }






    private scanDiscordMediaEngine() {
        if (!this.armed || !this.voiceConnected) return;
        let engine: any = null;
        try { engine = (MediaEngineStore as any)?.getMediaEngine?.(); } catch { return; }
        if (!engine || typeof engine !== "object") return;



        this.installMediaEngineSpeakingHooks(engine);
        try {
            for (const connection of engine.connections ?? []) {
                if (connection?.context && connection.context !== "default") continue;
                this.installMediaEngineSpeakingHooks(connection);
            }
        } catch {   }

        const seen = new WeakSet<object>();
        const remoteIds = this.presentRemoteUserIds;
        const interesting = /(audio|voice|rtc|webrtc|peer|receiver|stream|track|connection|remote|speaker|ssrc|media|user)/i;
        let visited = 0;

        const hintedUser = (value: any, fallback: string | null) => {
            for (const key of ["userId", "user_id", "remoteUserId", "remote_user_id", "streamUserId"]) {
                try {
                    const id = value?.[key];
                    if (id != null && remoteIds.has(String(id))) return String(id);
                } catch {   }
            }
            return fallback;
        };

        const walk = (value: any, depth: number, userHint: string | null = null, propertyHint = "") => {
            if (value == null || depth > 5 || visited > 1800) return;
            if (typeof value !== "object" && typeof value !== "function") return;

            try {
                if (typeof MediaStreamTrack !== "undefined" && value instanceof MediaStreamTrack) {
                    const remotePath = Boolean(userHint || /(remote|receiver|incoming|speaker|webrtc|peer)/i.test(propertyHint));
                    if (value.kind === "audio" && remotePath) this.attachRemoteTrack(value, null, {
                        captureKind: "engine-scan",
                        masterIncluded: true,
                        hintedUserId: userHint
                    });
                    return;
                }
                if (typeof MediaStream !== "undefined" && value instanceof MediaStream) {
                    const remotePath = Boolean(userHint || /(remote|receiver|incoming|speaker|webrtc|peer)/i.test(propertyHint));
                    if (!remotePath) return;
                    for (const track of value.getAudioTracks()) this.attachRemoteTrack(track, null, {
                        captureKind: "engine-scan",
                        masterIncluded: true,
                        hintedUserId: userHint
                    });
                    return;
                }
                if (typeof RTCRtpReceiver !== "undefined" && value instanceof RTCRtpReceiver) {
                    let track: MediaStreamTrack | null = null;
                    try { track = value.track; } catch {   }
                    if (track?.kind === "audio") this.attachRemoteTrack(track, value, {
                        captureKind: "engine-scan",
                        masterIncluded: true,
                        hintedUserId: userHint
                    });
                    return;
                }
                if (typeof RTCPeerConnection !== "undefined" && value instanceof RTCPeerConnection) {
                    this.observePeerConnection(value);
                    return;
                }
            } catch {   }

            if (typeof value !== "object") return;
            if (seen.has(value)) return;
            seen.add(value);
            visited++;

            const effectiveHint = hintedUser(value, userHint);

            if (value instanceof Map) {
                for (const [key, child] of value) {
                    const keyText = typeof key === "string" || typeof key === "number" ? String(key) : "";
                    const nextHint = remoteIds.has(keyText) ? keyText : effectiveHint;
                    const nextPath = propertyHint ? `${propertyHint}.${keyText}` : keyText;
                    walk(child, depth + 1, nextHint, nextPath);
                }
                return;
            }
            if (value instanceof Set || Array.isArray(value)) {
                for (const child of value as Iterable<any>) {

                    try {
                        if (/connection/i.test(propertyHint) && child?.context && child.context !== "default") continue;
                    } catch {   }
                    walk(child, depth + 1, effectiveHint, propertyHint);
                }
                return;
            }

            let descriptors: PropertyDescriptorMap;
            try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return; }
            for (const [key, descriptor] of Object.entries(descriptors)) {
                if (!("value" in descriptor)) continue;

                if (/(desktop|soundshare|screen|clip|loopback|output|device)/i.test(key)) continue;
                const inheritedRemoteRoot = /(remoteConnection|connections|receiver|incoming|peer|webrtc)/i.test(propertyHint);
                if (!interesting.test(key) && !inheritedRemoteRoot) continue;
                const child = descriptor.value;
                if (/ssrc/i.test(key) && effectiveHint) {
                    const ssrc = Number(child);
                    if (Number.isFinite(ssrc) && ssrc > 0) this.ssrcUserMap.set(Math.floor(ssrc), effectiveHint);
                }
                const keyHint = remoteIds.has(key) ? key : effectiveHint;
                const nextPath = propertyHint ? `${propertyHint}.${key}` : key;
                walk(child, depth + 1, keyHint, nextPath);
            }
        };



        try {
            for (const connection of engine.connections ?? []) {
                if (connection?.context && connection.context !== "default") continue;
                this.installMediaEngineSpeakingHooks(connection);
                try {
                    const options = connection?.getUserOptions?.();
                    if (options) walk(options, 1, null, "remoteUserOptions");
                } catch {   }


                walk(connection, 1, null, "remoteConnection");
            }
        } catch {   }

        walk(engine, 0, null, "mediaEngine");
    }






    private installAudioGraphHooks() {
        if (this.originalCreateMediaStreamSource) return;
        const Constructor = window.AudioContext ?? (window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
        }).webkitAudioContext;
        const prototype = Constructor?.prototype as any;
        if (!prototype) return;

        this.audioContextPrototype = prototype;

        if (typeof prototype.createMediaStreamSource === "function") {
            this.originalCreateMediaStreamSource = prototype.createMediaStreamSource;
            const recorder = this;
            this.wrappedCreateMediaStreamSource = function (this: AudioContext, stream: MediaStream) {
                if (!recorder.bypassAudioDiscovery && stream instanceof MediaStream) {
                    queueMicrotask(() => recorder.attachRemoteStream(stream));
                }
                return recorder.originalCreateMediaStreamSource!.call(this, stream);
            };
            prototype.createMediaStreamSource = this.wrappedCreateMediaStreamSource;
        }

        if (typeof prototype.createMediaStreamTrackSource === "function") {
            this.originalCreateMediaStreamTrackSource = prototype.createMediaStreamTrackSource;
            const recorder = this;
            this.wrappedCreateMediaStreamTrackSource = function (this: AudioContext, track: MediaStreamTrack) {
                if (!recorder.bypassAudioDiscovery && track?.kind === "audio") {
                    queueMicrotask(() => recorder.attachRemoteTrack(track, null));
                }
                return recorder.originalCreateMediaStreamTrackSource!.call(this, track);
            };
            prototype.createMediaStreamTrackSource = this.wrappedCreateMediaStreamTrackSource;
        }

        try {
            const audioNodePrototype = (window as any).AudioNode?.prototype ?? (typeof AudioNode !== "undefined" ? AudioNode.prototype : null);
            if (audioNodePrototype && typeof audioNodePrototype.connect === "function" && !this.originalAudioNodeConnect) {
                this.audioNodePrototype = audioNodePrototype;
                this.originalAudioNodeConnect = audioNodePrototype.connect;
                const recorder = this;
                this.wrappedAudioNodeConnect = function (this: AudioNode, ...args: any[]) {
                    let discoverableSource = false;
                    try {
                        const candidate = this as any;
                        const name = String(candidate?.constructor?.name ?? "");
                        discoverableSource = /^(?:MediaStream|MediaStreamTrack|MediaElement)AudioSourceNode$/i.test(name)
                            || candidate.mediaStream instanceof MediaStream
                            || candidate.mediaStreamTrack instanceof MediaStreamTrack
                            || candidate.mediaElement instanceof HTMLMediaElement;
                    } catch {   }
                    if (!recorder.bypassAudioDiscovery && discoverableSource) {
                        queueMicrotask(() => recorder.inspectAudioNodeSource(this));
                    }
                    return recorder.originalAudioNodeConnect!.apply(this, args);
                };
                audioNodePrototype.connect = this.wrappedAudioNodeConnect;
            }
        } catch {
            this.originalAudioNodeConnect = null;
            this.wrappedAudioNodeConnect = null;
            this.audioNodePrototype = null;
        }
    }


    private installLocalCaptureHook() {
        if (this.originalGetUserMedia || typeof navigator === "undefined") return;
        const target = navigator.mediaDevices;
        if (!target || typeof target.getUserMedia !== "function") return;

        this.mediaDevicesTarget = target;
        this.originalGetUserMedia = target.getUserMedia;
        const recorder = this;
        this.wrappedGetUserMedia = function (this: MediaDevices, constraints?: MediaStreamConstraints) {
            const result = recorder.originalGetUserMedia!.call(this, constraints);
            return Promise.resolve(result).then(stream => {
                for (const track of stream.getAudioTracks()) {
                    recorder.localCaptureTrackIds.add(track.id);
                    track.addEventListener("ended", () => recorder.localCaptureTrackIds.delete(track.id), { once: true });
                }
                return stream;
            });
        };

        try {
            target.getUserMedia = this.wrappedGetUserMedia;
        } catch {
            this.mediaDevicesTarget = null;
            this.originalGetUserMedia = null;
            this.wrappedGetUserMedia = null;
        }
    }

    private restoreLocalCaptureHook() {
        if (this.mediaDevicesTarget && this.originalGetUserMedia && this.mediaDevicesTarget.getUserMedia === this.wrappedGetUserMedia) {
            try { this.mediaDevicesTarget.getUserMedia = this.originalGetUserMedia; } catch {   }
        }
        this.mediaDevicesTarget = null;
        this.originalGetUserMedia = null;
        this.wrappedGetUserMedia = null;
        this.localCaptureTrackIds.clear();
    }

    private installMediaStreamHook() {
        if (this.originalMediaStreamAddTrack || typeof MediaStream === "undefined") return;
        const prototype = MediaStream.prototype as any;
        if (typeof prototype.addTrack !== "function") return;

        this.originalMediaStreamAddTrack = prototype.addTrack;
        const recorder = this;
        this.wrappedMediaStreamAddTrack = function (this: MediaStream, track: MediaStreamTrack) {
            recorder.originalMediaStreamAddTrack!.call(this, track);
            if (!recorder.bypassAudioDiscovery && track?.kind === "audio") {
                queueMicrotask(() => recorder.attachRemoteTrack(track, null));
            }
        };
        prototype.addTrack = this.wrappedMediaStreamAddTrack;
    }

    private restoreMediaStreamHook() {
        if (typeof MediaStream === "undefined") return;
        const prototype = MediaStream.prototype as any;
        if (this.originalMediaStreamAddTrack && prototype.addTrack === this.wrappedMediaStreamAddTrack) {
            prototype.addTrack = this.originalMediaStreamAddTrack;
        }
        this.originalMediaStreamAddTrack = null;
        this.wrappedMediaStreamAddTrack = null;
    }

    private restoreAudioGraphHooks() {
        const prototype = this.audioContextPrototype;
        if (prototype) {
            if (this.originalCreateMediaStreamSource && prototype.createMediaStreamSource === this.wrappedCreateMediaStreamSource) {
                prototype.createMediaStreamSource = this.originalCreateMediaStreamSource;
            }
            if (this.originalCreateMediaStreamTrackSource && prototype.createMediaStreamTrackSource === this.wrappedCreateMediaStreamTrackSource) {
                prototype.createMediaStreamTrackSource = this.originalCreateMediaStreamTrackSource;
            }
        }
        this.originalCreateMediaStreamSource = null;
        this.wrappedCreateMediaStreamSource = null;
        this.originalCreateMediaStreamTrackSource = null;
        this.wrappedCreateMediaStreamTrackSource = null;
        this.audioContextPrototype = null;
        if (this.audioNodePrototype && this.originalAudioNodeConnect && this.audioNodePrototype.connect === this.wrappedAudioNodeConnect) {
            this.audioNodePrototype.connect = this.originalAudioNodeConnect;
        }
        this.originalAudioNodeConnect = null;
        this.wrappedAudioNodeConnect = null;
        this.audioNodePrototype = null;
        this.bypassAudioDiscovery = 0;
    }

    private attachExistingAudioStreams() {
        for (const element of document.querySelectorAll("audio")) this.attachMediaElement(element as HTMLAudioElement);
    }

    private attachMediaElement(element: HTMLMediaElement) {
        const stream = element.srcObject;
        if (stream instanceof MediaStream && stream.getAudioTracks().length) {
            this.attachRemoteStream(stream);
            return;
        }
        this.tryAttachLiveVoiceElement(element);
    }

    private tryAttachLiveVoiceElement(element: HTMLMediaElement) {
        if (!this.armed || !this.voiceConnected || !this.context || !this.multiTrackWorklet || !this.stemCaptureNode) return;
        if (!this.presentRemoteUserIds.size || this.elementFallbacks.has(element)) return;
        if (Date.now() - this.trustedRemoteSignalAt < 1800) return;
        if (element.controls || element.ended) return;

        let duration = Number.NaN;
        try { duration = Number(element.duration); } catch {   }
        const liveLike = !Number.isFinite(duration) || duration === Infinity || (duration <= 0 && !element.paused);
        if (!liveLike) return;

        let src = "";
        try { src = element.currentSrc || element.getAttribute("src") || ""; } catch {   }

        if (/\.(?:mp3|wav|flac|ogg|oga|m4a|aac|mp4|m4v|webm)(?:[?#]|$)/i.test(src)) return;

        const capture = (element as any).captureStream ?? (element as any).mozCaptureStream;
        if (typeof capture !== "function") return;

        let captured: MediaStream;
        try { captured = capture.call(element); } catch { return; }
        const tracks = captured.getAudioTracks();
        if (!tracks.length) return;

        const trackIds: string[] = [];
        for (const track of tracks) {
            trackIds.push(track.id);
            this.attachRemoteTrack(track, null, {
                masterIncluded: false,
                captureKind: "element-fallback"
            });
        }

        const cleanup = () => {
            for (const trackId of trackIds) {
                const attachment = this.remoteTracks.get(trackId);
                if (attachment?.captureKind === "element-fallback") {
                    attachment.cleanup();
                    this.remoteTracks.delete(trackId);
                    this.discoveredTracks.delete(trackId);
                }
            }
            for (const track of captured.getTracks()) {
                try { track.stop(); } catch {   }
            }
        };
        this.elementFallbacks.set(element, { stream: captured, trackIds, cleanup });
    }

    private detachElementFallbacks() {
        for (const fallback of this.elementFallbacks.values()) fallback.cleanup();
        this.elementFallbacks.clear();
    }

    private pruneElementFallbacks() {
        for (const [element, fallback] of Array.from(this.elementFallbacks)) {
            if (document.contains(element) && !element.ended) continue;
            fallback.cleanup();
            this.elementFallbacks.delete(element);
        }

        if (Date.now() - this.trustedRemoteSignalAt < 1800 && this.elementFallbacks.size) this.detachElementFallbacks();
    }

    private attachRemoteStream(stream: MediaStream, options: RemoteTrackOptions = {}) {
        for (const track of stream.getAudioTracks()) this.attachRemoteTrack(track, null, options);
    }

    private allocateRemoteSlot() {
        for (let slot = 0; slot < REMOTE_SLOT_LIMIT; slot++) if (!this.slotCaptureKeys[slot]) return slot;
        return null;
    }


    private attachRemoteTrack(track: MediaStreamTrack, receiver: RTCRtpReceiver | null = null, options: RemoteTrackOptions = {}) {
        if (this.nativeRemoteActive) return;
        if (track.kind !== "audio") return;
        if (track.readyState === "ended") {
            this.discoveredTracks.delete(track.id);
            return;
        }
        if (this.microphoneTrackIds.has(track.id) || this.localCaptureTrackIds.has(track.id)) return;

        const discovered = this.discoveredTracks.get(track.id);
        this.discoveredTracks.set(track.id, { track, receiver: receiver ?? discovered?.receiver ?? null });

        const existing = this.remoteTracks.get(track.id);
        if (existing) {
            if (receiver && !existing.receiver) {
                existing.receiver = receiver;
                if (existing.captureKey) {
                    const stem = this.stemSources.get(existing.captureKey);
                    if (stem) stem.receiver = receiver;
                }
            }
            if (options.hintedUserId && options.hintedUserId !== this.localUserId && existing.captureKey) {
                const stem = this.stemSources.get(existing.captureKey);
                if (stem) this.assignMapping(stem, options.hintedUserId, true);
                existing.hintedUserId = options.hintedUserId;
            }
            return;
        }
        if (!this.armed || !this.voiceConnected || !this.context || !this.captureNode || !this.mixer) return;

        let source: MediaStreamAudioSourceNode | null = null;
        let slot: number | null = null;
        let captureKey: string | null = null;
        const masterIncluded = options.masterIncluded !== false;
        const captureKind = options.captureKind ?? "direct";

        try {
            source = this.createMediaStreamSourceInternal(new MediaStream([track]));
            if (masterIncluded) source.connect(this.mixer);

            const endedHandler = () => {
                const current = this.remoteTracks.get(track.id);
                if (!current) return;
                current.cleanup();
                this.remoteTracks.delete(track.id);
                this.discoveredTracks.delete(track.id);
                this.emitStatus(true);
            };
            track.addEventListener("ended", endedHandler, { once: true });

            const cleanup = () => {
                track.removeEventListener("ended", endedHandler);
                try { source?.disconnect(); } catch {   }
                if (slot != null && this.slotCaptureKeys[slot] === captureKey) this.slotCaptureKeys[slot] = null;
                if (captureKey) {
                    const stem = this.stemSources.get(captureKey);
                    if (stem) stem.active = false;
                }
            };


            const attachment: TrackAttachment = {
                track,
                captureTrack: track,
                receiver,
                source,
                slot: null,
                captureKey: null,
                masterIncluded,
                captureKind,
                hintedUserId: options.hintedUserId ?? null,
                cleanup
            };
            this.remoteTracks.set(track.id, attachment);


            if (this.multiTrackWorklet && this.stemCaptureNode) {
                try {
                    slot = this.allocateRemoteSlot();
                    if (slot != null) {
                        captureKey = `remote:${track.id}:${++this.captureSerial}`;
                        this.slotCaptureKeys[slot] = captureKey;
                        const stem = this.ensureStemSource(captureKey, "remote", slot, receiver, {
                            masterIncluded,
                            captureKind,
                            hintedUserId: options.hintedUserId ?? null
                        });
                        source.connect(this.stemCaptureNode, 0, slot);
                        attachment.slot = slot;
                        attachment.captureKey = captureKey;

                        const reliableUser = options.hintedUserId ?? this.resolveReceiverUserId(receiver);
                        if (reliableUser && reliableUser !== this.localUserId) this.assignMapping(stem, reliableUser, true);
                    }
                } catch (stemError) {
                    if (slot != null && this.slotCaptureKeys[slot] === captureKey) this.slotCaptureKeys[slot] = null;
                    if (captureKey) {
                        const stem = this.stemSources.get(captureKey);
                        if (stem) stem.active = false;
                    }
                    attachment.slot = null;
                    attachment.captureKey = null;

                    this.lastError = `Separate track unavailable for one speaker: ${errorMessage(stemError)}`;
                }
            }

            this.emitStatus(true);
        } catch (error) {
            try { source?.disconnect(); } catch {   }
            this.remoteTracks.delete(track.id);
            this.lastError = `Could not attach an incoming Discord audio track: ${errorMessage(error)}`;
            this.emitStatus(true);
        }
    }

    private observePeerConnection(pc: RTCPeerConnection, knownReceivers?: RTCRtpReceiver[]) {
        if (!this.observedPeerConnections.has(pc)) {
            this.observedPeerConnections.add(pc);
            const handler = (event: RTCTrackEvent) => {
                if (event.track?.kind === "audio") this.attachRemoteTrack(event.track, event.receiver ?? null);
                for (const stream of event.streams ?? []) this.attachRemoteStream(stream);
            };
            this.peerTrackHandlers.set(pc, handler);
            pc.addEventListener("track", handler);
        }

        let receivers = knownReceivers;
        if (!receivers) {
            try {
                receivers = this.originalGetReceivers
                    ? this.originalGetReceivers.call(pc)
                    : pc.getReceivers?.() ?? [];
            } catch { receivers = []; }
        }
        for (const receiver of receivers ?? []) {
            let track: MediaStreamTrack | null = null;
            try { track = receiver.track; } catch {   }
            if (track?.kind === "audio") this.attachRemoteTrack(track, receiver);
        }
    }

    private installPeerConnectionHook() {
        if (typeof RTCPeerConnection === "undefined") return;
        const prototype = RTCPeerConnection.prototype;
        try {
            if (!this.originalGetReceivers && typeof prototype.getReceivers === "function") {
                this.originalGetReceivers = prototype.getReceivers;
                const recorder = this;
                prototype.getReceivers = function (this: RTCPeerConnection) {
                    const receivers = recorder.originalGetReceivers!.call(this);
                    queueMicrotask(() => recorder.observePeerConnection(this, receivers));
                    return receivers;
                };
            }
            if (!this.originalSetRemoteDescription && typeof prototype.setRemoteDescription === "function") {
                this.originalSetRemoteDescription = prototype.setRemoteDescription as any;
                const recorder = this;
                prototype.setRemoteDescription = function (this: RTCPeerConnection, ...args: any[]) {
                    recorder.observePeerConnection(this);
                    const result = recorder.originalSetRemoteDescription!.apply(this, args);
                    Promise.resolve(result).finally(() => recorder.observePeerConnection(this));
                    return result;
                } as any;
            }
            if (!this.originalSetLocalDescription && typeof prototype.setLocalDescription === "function") {
                this.originalSetLocalDescription = prototype.setLocalDescription as any;
                const recorder = this;
                prototype.setLocalDescription = function (this: RTCPeerConnection, ...args: any[]) {
                    recorder.observePeerConnection(this);
                    const result = recorder.originalSetLocalDescription!.apply(this, args);
                    Promise.resolve(result).finally(() => recorder.observePeerConnection(this));
                    return result;
                } as any;
            }
        } catch (error) {
            this.lastError = `Could not hook WebRTC negotiation: ${errorMessage(error)}`;
        }
    }

    private restorePeerConnectionHook() {
        if (typeof RTCPeerConnection !== "undefined") {
            const prototype = RTCPeerConnection.prototype;
            if (this.originalSetRemoteDescription) prototype.setRemoteDescription = this.originalSetRemoteDescription;
            if (this.originalSetLocalDescription) prototype.setLocalDescription = this.originalSetLocalDescription;
            if (this.originalGetReceivers) prototype.getReceivers = this.originalGetReceivers;
        }
        this.originalSetRemoteDescription = null;
        this.originalSetLocalDescription = null;
        this.originalGetReceivers = null;
        for (const [pc, handler] of this.peerTrackHandlers) {
            try { pc.removeEventListener("track", handler); } catch {   }
        }
        this.peerTrackHandlers.clear();
        this.observedPeerConnections.clear();
    }

    private installReceiverTrackHook() {
        if (this.originalReceiverTrackDescriptor || typeof RTCRtpReceiver === "undefined") return;
        try {
            const prototype = RTCRtpReceiver.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(prototype, "track");
            if (!descriptor?.get || descriptor.configurable === false) return;
            this.originalReceiverTrackDescriptor = descriptor;
            const recorder = this;
            Object.defineProperty(prototype, "track", {
                ...descriptor,
                get(this: RTCRtpReceiver) {
                    const track = descriptor.get!.call(this) as MediaStreamTrack;
                    if (track?.kind === "audio") queueMicrotask(() => recorder.attachRemoteTrack(track, this));
                    return track;
                }
            });
        } catch {
            this.originalReceiverTrackDescriptor = null;
        }
    }

    private restoreReceiverTrackHook() {
        if (!this.originalReceiverTrackDescriptor || typeof RTCRtpReceiver === "undefined") return;
        Object.defineProperty(RTCRtpReceiver.prototype, "track", this.originalReceiverTrackDescriptor);
        this.originalReceiverTrackDescriptor = null;
    }

    private installSrcObjectHook() {
        if (this.originalSrcObjectDescriptor) return;
        const prototype = HTMLMediaElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "srcObject");
        if (!descriptor?.get || !descriptor?.set || descriptor.configurable === false) {
            this.lastError = "Could not hook media srcObject; WebRTC receiver capture remains enabled.";
            return;
        }

        this.originalSrcObjectDescriptor = descriptor;
        const recorder = this;
        Object.defineProperty(prototype, "srcObject", {
            ...descriptor,
            get: descriptor.get,
            set(value: MediaProvider | null) {
                descriptor.set!.call(this, value);
                if (value instanceof MediaStream) queueMicrotask(() => recorder.attachRemoteStream(value));
            }
        });
    }

    private restoreSrcObjectHook() {
        if (!this.originalSrcObjectDescriptor) return;
        Object.defineProperty(HTMLMediaElement.prototype, "srcObject", this.originalSrcObjectDescriptor);
        this.originalSrcObjectDescriptor = null;
    }

    private installMediaObserver() {
        if (this.mediaObserver) return;
        this.mediaObserver = new MutationObserver(records => {
            for (const record of records) for (const node of Array.from(record.addedNodes)) {
                if (!(node instanceof HTMLElement)) continue;
                if (node instanceof HTMLAudioElement) this.attachMediaElement(node);
                for (const audio of node.querySelectorAll?.("audio") ?? []) this.attachMediaElement(audio as HTMLAudioElement);
            }
        });
        this.mediaObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    private uninstallMediaObserver() {
        this.mediaObserver?.disconnect();
        this.mediaObserver = null;
    }

    private startRecoveryTimer() {
        if (this.recoveryTimer != null) return;
        this.recoveryTimer = window.setInterval(() => this.rescanRemoteCapture(), 900);
    }

    private stopRecoveryTimer() {
        if (this.recoveryTimer != null) window.clearInterval(this.recoveryTimer);
        this.recoveryTimer = null;
    }

    private rescanRemoteCapture() {
        if (!this.armed || this.nativeRemoteActive) return;
        this.scanDiscordMediaEngine();
        this.attachExistingAudioStreams();
        this.pruneElementFallbacks();
        for (const pc of Array.from(this.observedPeerConnections)) {
            if (pc.connectionState === "closed") {
                const handler = this.peerTrackHandlers.get(pc);
                if (handler) {
                    try { pc.removeEventListener("track", handler); } catch {   }
                    this.peerTrackHandlers.delete(pc);
                }
                this.observedPeerConnections.delete(pc);
                continue;
            }
            this.observePeerConnection(pc);
        }
        for (const discovered of this.discoveredTracks.values()) this.attachRemoteTrack(discovered.track, discovered.receiver);
        this.refreshReliableMappings();
    }

    private installGestureResume() {
        if (!this.context || this.gestureResumeHandler) return;
        this.gestureResumeHandler = () => {
            if (!this.context || this.context.state !== "suspended") return;
            void this.context.resume().finally(() => this.emitStatus(true));
        };
        window.addEventListener("pointerdown", this.gestureResumeHandler, true);
        window.addEventListener("keydown", this.gestureResumeHandler, true);
    }

    private uninstallGestureResume() {
        if (!this.gestureResumeHandler) return;
        window.removeEventListener("pointerdown", this.gestureResumeHandler, true);
        window.removeEventListener("keydown", this.gestureResumeHandler, true);
        this.gestureResumeHandler = null;
    }

    private emitStatus(force: boolean) {
        const now = Date.now();
        if (!force && now - this.lastStatusEmit < 18) return;
        this.lastStatusEmit = now;
        const status = this.getStatus();
        for (const listener of this.listeners) listener(status);
    }
}

export const voiceRecorder = new RollingVoiceRecorder();
