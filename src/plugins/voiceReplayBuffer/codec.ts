





const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function ascii(view: DataView, offset: number, text: string) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodePcm16Wav(samples: Int16Array, sampleRate: number, channels = 1): Uint8Array {
    channels = Math.max(1, Math.min(8, Math.floor(channels)));
    const headerBytes = 44;
    const dataBytes = samples.length * 2;
    const blockAlign = channels * 2;
    const buffer = new ArrayBuffer(headerBytes + dataBytes);
    const view = new DataView(buffer);

    ascii(view, 0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    ascii(view, 8, "WAVE");
    ascii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    ascii(view, 36, "data");
    view.setUint32(40, dataBytes, true);



    const littleEndian = new Uint8Array(new Uint16Array([0x0102]).buffer)[0] === 0x02;
    if (littleEndian) {
        new Uint8Array(buffer, headerBytes, dataBytes).set(
            new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
        );
    } else {
        let offset = headerBytes;
        for (let i = 0; i < samples.length; i++, offset += 2) view.setInt16(offset, samples[i], true);
    }
    return new Uint8Array(buffer);
}

export function encodeMonoPcm16Wav(samples: Int16Array, sampleRate: number): Uint8Array {
    return encodePcm16Wav(samples, sampleRate, 1);
}

function crc8(bytes: ArrayLike<number>): number {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    return crc;
}

function crc16(bytes: ArrayLike<number>): number {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i] << 8;
        for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}

function encodeUtf8Integer(value: number): number[] {
    value = Math.max(0, Math.floor(value));
    if (value < 0x80) return [value];

    let count = 2;
    while (count < 7 && value >= 2 ** (5 * count + 1)) count++;

    const out = new Array<number>(count);
    let remaining = value;
    for (let i = count - 1; i > 0; i--) {
        out[i] = 0x80 | (remaining & 0x3f);
        remaining = Math.floor(remaining / 64);
    }

    const prefixMask = (0xff << (8 - count)) & 0xff;
    const payloadBits = 7 - count;
    out[0] = prefixMask | (remaining & ((1 << payloadBits) - 1));
    return out;
}

function frameBlockSizeCode(blockSize: number): { code: number; extra: number[]; } {
    const fixedCodes = new Map<number, number>([
        [256, 8], [512, 9], [1024, 10], [2048, 11], [4096, 12], [8192, 13], [16384, 14], [32768, 15]
    ]);
    const fixed = fixedCodes.get(blockSize);
    if (fixed) return { code: fixed, extra: [] };
    if (blockSize >= 1 && blockSize <= 256) return { code: 6, extra: [blockSize - 1] };
    return { code: 7, extra: [((blockSize - 1) >>> 8) & 0xff, (blockSize - 1) & 0xff] };
}

function makeFlacFrame(samples: Int16Array, frameNumber: number, channels: number): Uint8Array {
    const frameCount = Math.floor(samples.length / channels);
    const { code: blockCode, extra: blockExtra } = frameBlockSizeCode(frameCount);
    const channelAssignment = Math.max(0, Math.min(7, channels - 1));
    const header: number[] = [
        0xff,
        0xf8,
        (blockCode << 4) | 0x00,
        (channelAssignment << 4) | 0x08
    ];
    header.push(...encodeUtf8Integer(frameNumber), ...blockExtra);
    header.push(crc8(header));

    const subframeBytes = channels * (1 + frameCount * 2);
    const frame = new Uint8Array(header.length + subframeBytes + 2);
    frame.set(header, 0);
    let pos = header.length;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    for (let channel = 0; channel < channels; channel++) {
        frame[pos++] = 0x02;
        for (let i = 0; i < frameCount; i++, pos += 2) {
            view.setInt16(pos, samples[i * channels + channel], false);
        }
    }

    const checksum = crc16(frame.subarray(0, pos));
    frame[pos++] = (checksum >>> 8) & 0xff;
    frame[pos] = checksum & 0xff;
    return frame;
}

type FlacEncodingPlan = {
    channels: number;
    preferredBlockSize: number;
    sampleRate: number;
    streamInfo: Uint8Array;
    totalFrames: number;
};

function makeFlacEncodingPlan(samples: Int16Array, sampleRate: number, channels: number): FlacEncodingPlan {
    sampleRate = Math.round(clamp(sampleRate, 1, 1_048_575));
    channels = Math.max(1, Math.min(8, Math.floor(channels)));
    const preferredBlockSize = 4096;
    const totalFrames = Math.floor(samples.length / channels);
    const streamBlockSize = totalFrames > 0 && totalFrames < preferredBlockSize ? totalFrames : preferredBlockSize;

    const streamInfo = new Uint8Array(34);
    const streamView = new DataView(streamInfo.buffer);
    streamView.setUint16(0, streamBlockSize, false);
    streamView.setUint16(2, streamBlockSize, false);

    const packed = (BigInt(sampleRate) << 44n)
        | (BigInt(channels - 1) << 41n)
        | (15n << 36n)
        | BigInt(totalFrames);
    for (let i = 0; i < 8; i++) streamInfo[10 + i] = Number((packed >> BigInt((7 - i) * 8)) & 0xffn);

    return { channels, preferredBlockSize, sampleRate, streamInfo, totalFrames };
}

function assembleFlac(streamInfo: Uint8Array, frames: Uint8Array[]) {
    const totalBytes = 4 + 4 + streamInfo.length + frames.reduce((sum, frame) => sum + frame.length, 0);
    const out = new Uint8Array(totalBytes);
    let pos = 0;
    out.set([0x66, 0x4c, 0x61, 0x43], pos); pos += 4;
    out[pos++] = 0x80;
    out[pos++] = 0x00;
    out[pos++] = 0x00;
    out[pos++] = 34;
    out.set(streamInfo, pos); pos += streamInfo.length;
    for (const frame of frames) {
        out.set(frame, pos);
        pos += frame.length;
    }
    return out;
}

export function encodePcm16Flac(samples: Int16Array, sampleRate: number, channels = 1): Uint8Array {
    const plan = makeFlacEncodingPlan(samples, sampleRate, channels);
    const frames: Uint8Array[] = [];
    let frameOffset = 0;
    let frameNumber = 0;
    while (frameOffset < plan.totalFrames) {
        const count = Math.min(plan.preferredBlockSize, plan.totalFrames - frameOffset);
        const start = frameOffset * plan.channels;
        const end = (frameOffset + count) * plan.channels;
        frames.push(makeFlacFrame(samples.subarray(start, end), frameNumber++, plan.channels));
        frameOffset += count;
    }
    return assembleFlac(plan.streamInfo, frames);
}





export async function encodePcm16FlacAsync(samples: Int16Array, sampleRate: number, channels = 1): Promise<Uint8Array> {
    const plan = makeFlacEncodingPlan(samples, sampleRate, channels);
    const frames: Uint8Array[] = [];
    let frameOffset = 0;
    let frameNumber = 0;
    let yieldDeadline = Date.now() + 8;

    while (frameOffset < plan.totalFrames) {
        const count = Math.min(plan.preferredBlockSize, plan.totalFrames - frameOffset);
        const start = frameOffset * plan.channels;
        const end = (frameOffset + count) * plan.channels;
        frames.push(makeFlacFrame(samples.subarray(start, end), frameNumber++, plan.channels));
        frameOffset += count;

        if (Date.now() >= yieldDeadline && frameOffset < plan.totalFrames) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            yieldDeadline = Date.now() + 8;
        }
    }

    await new Promise<void>(resolve => setTimeout(resolve, 0));
    return assembleFlac(plan.streamInfo, frames);
}

export function encodeMonoPcm16Flac(samples: Int16Array, sampleRate: number): Uint8Array {
    return encodePcm16Flac(samples, sampleRate, 1);
}
