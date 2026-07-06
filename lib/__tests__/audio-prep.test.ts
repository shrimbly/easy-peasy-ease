import { describe, it, expect } from 'vitest';
import {
  assembleAudio,
  downmixToStereo,
  applyFades,
  type AudioBufferLike,
  type AudioBufferFactory,
} from '@/lib/audio-prep';

/**
 * Minimal structural AudioBuffer for tests. Backed by persistent Float32Arrays
 * (getChannelData always returns the same array instance per channel), which
 * the module relies on for in-place writes and fades. The real AudioBuffer
 * global is never touched.
 */
class MockAudioBuffer implements AudioBufferLike {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  private readonly channels: Float32Array[];

  constructor(options: { length: number; numberOfChannels: number; sampleRate: number }) {
    this.length = options.length;
    this.numberOfChannels = options.numberOfChannels;
    this.sampleRate = options.sampleRate;
    this.channels = Array.from(
      { length: options.numberOfChannels },
      () => new Float32Array(options.length)
    );
  }

  getChannelData(channel: number): Float32Array {
    const data = this.channels[channel];
    if (!data) {
      throw new Error(`MockAudioBuffer has no channel ${channel}`);
    }
    return data;
  }
}

const factory: AudioBufferFactory = (options) => new MockAudioBuffer(options);

/** Build a chunk from per-channel sample arrays: makeChunk(10, [[1,2,3]]) is mono. */
function makeChunk(sampleRate: number, channelData: number[][]): MockAudioBuffer {
  const length = channelData[0]?.length ?? 0;
  const buffer = new MockAudioBuffer({
    length,
    numberOfChannels: Math.max(1, channelData.length),
    sampleRate,
  });
  channelData.forEach((samples, channel) => {
    buffer.getChannelData(channel).set(samples);
  });
  return buffer;
}

function samples(buffer: AudioBufferLike, channel = 0): number[] {
  return Array.from(buffer.getChannelData(channel));
}

const f32 = Math.fround;

describe('assembleAudio', () => {
  it('returns null for an empty chunk list', () => {
    expect(assembleAudio([], 1, {}, factory)).toBeNull();
  });

  it('returns null (and does not hang) when every chunk is zero-length', () => {
    const chunks = [makeChunk(10, [[]]), makeChunk(10, [[]])];
    expect(assembleAudio(chunks, 1, {}, factory)).toBeNull();
  });

  it('produces exactly floor(targetDuration * sampleRate) samples', () => {
    const chunk = makeChunk(10, [[1, 1, 1]]);
    const result = assembleAudio([chunk], 2.35, {}, factory);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(23); // floor(2.35 * 10)
    expect(result!.sampleRate).toBe(10);
    expect(result!.numberOfChannels).toBe(1);
  });

  it('clamps the target duration up to the 0.1s minimum', () => {
    const chunk = makeChunk(100, [[1, 2, 3]]);
    const zero = assembleAudio([chunk], 0, {}, factory);
    expect(zero!.length).toBe(10); // 0.1s * 100Hz
    const tiny = assembleAudio([chunk], 0.01, {}, factory);
    expect(tiny!.length).toBe(10);
  });

  it('copies chunk content in order across multiple chunks', () => {
    const chunks = [makeChunk(10, [[1, 2, 3]]), makeChunk(10, [[4, 5]])];
    const result = assembleAudio(chunks, 0.5, {}, factory);
    expect(samples(result!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('preserves both channels of stereo content', () => {
    const chunk = makeChunk(10, [
      [1, 2, 3],
      [4, 5, 6],
    ]);
    const result = assembleAudio([chunk], 0.3, {}, factory);
    expect(result!.numberOfChannels).toBe(2);
    expect(samples(result!, 0)).toEqual([1, 2, 3]);
    expect(samples(result!, 1)).toEqual([4, 5, 6]);
  });

  it('ignores zero-length chunks mixed in with real ones', () => {
    const chunks = [makeChunk(10, [[]]), makeChunk(10, [[1, 2]]), makeChunk(10, [[]])];
    const result = assembleAudio(chunks, 0.2, {}, factory);
    expect(samples(result!)).toEqual([1, 2]);
  });

  it('positive offset writes offset*rate samples of leading silence before content', () => {
    const chunk = makeChunk(10, [[1, 2, 3]]);
    const result = assembleAudio([chunk], 0.5, { offset: 0.2 }, factory);
    expect(samples(result!)).toEqual([0, 0, 1, 2, 3]);
  });

  it('positive offset beyond the target duration yields a fully silent buffer of the right length', () => {
    const chunk = makeChunk(10, [[1, 2, 3]]);
    const result = assembleAudio([chunk], 0.5, { offset: 1.0 }, factory);
    expect(result!.length).toBe(5);
    expect(samples(result!)).toEqual([0, 0, 0, 0, 0]);
  });

  it('negative offset trims the first -offset*rate source samples', () => {
    const chunk = makeChunk(10, [[1, 2, 3, 4, 5]]);
    const result = assembleAudio([chunk], 0.3, { offset: -0.2 }, factory);
    expect(samples(result!)).toEqual([3, 4, 5]);
  });

  it('negative offset trims across a chunk boundary', () => {
    const chunks = [makeChunk(10, [[1, 2]]), makeChunk(10, [[3, 4, 5]])];
    const result = assembleAudio(chunks, 0.2, { offset: -0.3 }, factory);
    expect(samples(result!)).toEqual([4, 5]);
  });

  it('loops a source shorter than the target from the start of the track', () => {
    const chunk = makeChunk(10, [[1, 2, 3]]);
    const result = assembleAudio([chunk], 0.8, {}, factory);
    expect(samples(result!)).toEqual([1, 2, 3, 1, 2, 3, 1, 2]);
  });

  it('loops a multi-chunk source in chunk order', () => {
    const chunks = [makeChunk(10, [[1, 2]]), makeChunk(10, [[3]])];
    const result = assembleAudio(chunks, 0.8, {}, factory);
    expect(samples(result!)).toEqual([1, 2, 3, 1, 2, 3, 1, 2]);
  });

  it('applies fades after assembly: fade-in ramp then unscaled content', () => {
    const chunk = makeChunk(10, [[1, 1, 1, 1, 1, 1, 1, 1, 1, 1]]);
    const result = assembleAudio([chunk], 1.0, { fadeIn: 0.5 }, factory);
    const data = samples(result!);
    // fadeInSamples = 5; multiplier is i/5 across the fade region.
    expect(data[0]).toBe(0);
    expect(data[1]).toBeCloseTo(0.2, 5);
    expect(data[2]).toBeCloseTo(0.4, 5);
    expect(data[3]).toBeCloseTo(0.6, 5);
    expect(data[4]).toBeCloseTo(0.8, 5);
    // First sample after the fade-in region is at full scale.
    expect(data[5]).toBe(1);
    expect(data[9]).toBe(1);
  });

  it('fade-in covers the leading silence from a positive offset (content enters mid-ramp)', () => {
    const chunk = makeChunk(10, [[1, 1, 1, 1, 1, 1, 1]]);
    const result = assembleAudio([chunk], 1.0, { offset: 0.3, fadeIn: 0.5 }, factory);
    const data = samples(result!);
    // Silence occupies samples 0-2; fade region is samples 0-4 of the merged
    // buffer, so the first content sample (index 3) is scaled by 3/5, not 0/5.
    expect(data.slice(0, 3)).toEqual([0, 0, 0]);
    expect(data[3]).toBeCloseTo(0.6, 5);
    expect(data[4]).toBeCloseTo(0.8, 5);
    expect(data[5]).toBe(1);
  });

  it('applies a fade-out at the tail of the assembled buffer', () => {
    const chunk = makeChunk(10, [[1, 1, 1, 1, 1, 1, 1, 1, 1, 1]]);
    const result = assembleAudio([chunk], 1.0, { fadeOut: 0.3 }, factory);
    const data = samples(result!);
    expect(data[6]).toBe(1);
    expect(data[7]).toBeCloseTo(2 / 3, 5);
    expect(data[8]).toBeCloseTo(1 / 3, 5);
    expect(data[9]).toBe(0); // fade-out must reach exact silence
  });

  it('downmixes 6-channel chunks to stereo during assembly', () => {
    const chunk = makeChunk(10, [
      [0.1, 0.1], // FL
      [0.2, 0.2], // FR
      [0.3, 0.3], // FC
      [0.9, 0.9], // LFE (ignored)
      [0.1, 0.1], // SL
      [-0.1, -0.1], // SR
    ]);
    const result = assembleAudio([chunk], 0.2, {}, factory);
    expect(result!.numberOfChannels).toBe(2);
    const expectedL = f32(0.1) + 0.7071 * f32(0.3) + 0.7071 * f32(0.1);
    const expectedR = f32(0.2) + 0.7071 * f32(0.3) + 0.7071 * f32(-0.1);
    expect(samples(result!, 0)[0]).toBeCloseTo(expectedL, 5);
    expect(samples(result!, 1)[0]).toBeCloseTo(expectedR, 5);
  });

  it('builds the output through the injected factory', () => {
    const chunk = makeChunk(10, [[1]]);
    const result = assembleAudio([chunk], 0.2, {}, factory);
    expect(result).toBeInstanceOf(MockAudioBuffer);
  });
});

describe('downmixToStereo', () => {
  it('returns the same object for mono input', () => {
    const mono = makeChunk(10, [[0.5, -0.5]]);
    expect(downmixToStereo(mono, factory)).toBe(mono);
  });

  it('returns the same object for stereo input', () => {
    const stereo = makeChunk(10, [
      [0.5, -0.5],
      [0.25, -0.25],
    ]);
    expect(downmixToStereo(stereo, factory)).toBe(stereo);
  });

  it('mixes 5.1 with the ITU coefficients: L = FL + 0.7071*FC + 0.7071*SL', () => {
    const surround = makeChunk(10, [
      [0.2, 0.0], // FL
      [0.1, 0.0], // FR
      [0.4, 0.5], // FC
      [0.9, 0.9], // LFE
      [0.2, 0.0], // SL
      [-0.3, 0.0], // SR
    ]);
    const out = downmixToStereo(surround, factory);
    expect(out).not.toBe(surround);
    expect(out.numberOfChannels).toBe(2);
    expect(out.length).toBe(2);
    expect(out.sampleRate).toBe(10);

    const expectedL0 = f32(0.2) + 0.7071 * f32(0.4) + 0.7071 * f32(0.2);
    const expectedR0 = f32(0.1) + 0.7071 * f32(0.4) + 0.7071 * f32(-0.3);
    expect(out.getChannelData(0)[0]).toBeCloseTo(expectedL0, 5);
    expect(out.getChannelData(1)[0]).toBeCloseTo(expectedR0, 5);
    // Second frame: only center is non-zero, split equally.
    expect(out.getChannelData(0)[1]).toBeCloseTo(0.7071 * f32(0.5), 5);
    expect(out.getChannelData(1)[1]).toBeCloseTo(0.7071 * f32(0.5), 5);
  });

  it('ignores the LFE channel entirely', () => {
    const withLfe = makeChunk(10, [[0.1], [0.2], [0.0], [1.0], [0.0], [0.0]]);
    const withoutLfe = makeChunk(10, [[0.1], [0.2], [0.0], [0.0], [0.0], [0.0]]);
    const a = downmixToStereo(withLfe, factory);
    const b = downmixToStereo(withoutLfe, factory);
    expect(a.getChannelData(0)[0]).toBe(b.getChannelData(0)[0]);
    expect(a.getChannelData(1)[0]).toBe(b.getChannelData(1)[0]);
  });

  it('clamps the mixed output to [-1, 1]', () => {
    const hot = makeChunk(10, [
      [0.9, -0.9], // FL
      [0.9, -0.9], // FR
      [0.9, -0.9], // FC
      [0.0, 0.0], // LFE
      [0.9, -0.9], // SL
      [0.9, -0.9], // SR
    ]);
    const out = downmixToStereo(hot, factory);
    expect(out.getChannelData(0)[0]).toBe(1);
    expect(out.getChannelData(1)[0]).toBe(1);
    expect(out.getChannelData(0)[1]).toBe(-1);
    expect(out.getChannelData(1)[1]).toBe(-1);
  });

  it('mixes a 3-channel (L/R/C) input by folding center into both sides', () => {
    const threeCh = makeChunk(10, [[0.2], [0.4], [0.6]]);
    const out = downmixToStereo(threeCh, factory);
    expect(out.numberOfChannels).toBe(2);
    expect(out.getChannelData(0)[0]).toBeCloseTo(f32(0.2) + 0.7071 * f32(0.6), 5);
    expect(out.getChannelData(1)[0]).toBeCloseTo(f32(0.4) + 0.7071 * f32(0.6), 5);
  });
});

describe('applyFades', () => {
  function onesBuffer(length: number, sampleRate: number, channels = 1): MockAudioBuffer {
    const buffer = new MockAudioBuffer({ length, numberOfChannels: channels, sampleRate });
    for (let c = 0; c < channels; c++) {
      buffer.getChannelData(c).fill(1);
    }
    return buffer;
  }

  it('is a no-op when both fades are zero or omitted', () => {
    const a = onesBuffer(5, 10);
    applyFades(a, {});
    expect(samples(a)).toEqual([1, 1, 1, 1, 1]);

    const b = onesBuffer(5, 10);
    applyFades(b, { fadeIn: 0, fadeOut: 0 });
    expect(samples(b)).toEqual([1, 1, 1, 1, 1]);
  });

  it('treats negative fade durations as zero', () => {
    const buffer = onesBuffer(5, 10);
    applyFades(buffer, { fadeIn: -1, fadeOut: -2 });
    expect(samples(buffer)).toEqual([1, 1, 1, 1, 1]);
  });

  it('does not crash on a zero-length buffer', () => {
    const buffer = new MockAudioBuffer({ length: 0, numberOfChannels: 1, sampleRate: 10 });
    expect(() => applyFades(buffer, { fadeIn: 1, fadeOut: 1 })).not.toThrow();
  });

  it('applies a linear fade-in of exactly fadeIn*rate samples', () => {
    const buffer = onesBuffer(10, 10);
    applyFades(buffer, { fadeIn: 0.4 });
    const data = samples(buffer);
    expect(data[0]).toBe(0);
    expect(data[1]).toBeCloseTo(1 / 4, 5);
    expect(data[2]).toBeCloseTo(2 / 4, 5);
    expect(data[3]).toBeCloseTo(3 / 4, 5);
    expect(data.slice(4)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('applies a linear fade-out at the tail only', () => {
    const buffer = onesBuffer(10, 10);
    applyFades(buffer, { fadeOut: 0.4 });
    const data = samples(buffer);
    expect(data.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(data[6]).toBeCloseTo(3 / 4, 5);
    expect(data[7]).toBeCloseTo(2 / 4, 5);
    expect(data[8]).toBeCloseTo(1 / 4, 5);
    expect(data[9]).toBe(0); // reaches exact silence at the last sample
  });

  it('scales both fades down proportionally when they exceed the buffer length', () => {
    // 10-sample buffer; fadeIn 8 samples + fadeOut 4 samples = 12 > 10.
    // scale = 10/12 -> fadeIn floor(6.67) = 6, fadeOut floor(3.33) = 3.
    const buffer = onesBuffer(10, 10);
    applyFades(buffer, { fadeIn: 0.8, fadeOut: 0.4 });
    const data = samples(buffer);
    for (let i = 0; i < 6; i++) {
      expect(data[i]).toBeCloseTo(i / 6, 5);
    }
    expect(data[6]).toBe(1); // untouched gap between the scaled fades
    expect(data[7]).toBeCloseTo(2 / 3, 5);
    expect(data[8]).toBeCloseTo(1 / 3, 5);
    expect(data[9]).toBe(0);
  });

  it('produces monotonic ramps: non-decreasing fade-in, non-increasing fade-out', () => {
    const buffer = onesBuffer(20, 10);
    applyFades(buffer, { fadeIn: 1.0, fadeOut: 1.0 });
    const data = samples(buffer);
    for (let i = 1; i < 10; i++) {
      expect(data[i]).toBeGreaterThan(data[i - 1]);
    }
    for (let i = 11; i < 20; i++) {
      expect(data[i]).toBeLessThan(data[i - 1]);
    }
  });

  it('fades every channel of a multichannel buffer', () => {
    const buffer = onesBuffer(4, 10, 2);
    applyFades(buffer, { fadeIn: 0.2 });
    expect(samples(buffer, 0)[0]).toBe(0);
    expect(samples(buffer, 1)[0]).toBe(0);
    expect(samples(buffer, 0)[1]).toBeCloseTo(0.5, 5);
    expect(samples(buffer, 1)[1]).toBeCloseTo(0.5, 5);
    expect(samples(buffer, 0)[2]).toBe(1);
    expect(samples(buffer, 1)[2]).toBe(1);
  });
});
