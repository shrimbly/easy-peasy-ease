/**
 * Audio preparation shared by the mixing and remux paths.
 *
 * Assembles decoded audio chunks into a single buffer of exactly the video's
 * duration, applying offset (delay or trim), looping to fill, downmixing to
 * stereo, and fading in/out. Previously this logic existed twice (in
 * useAudioMixing and useRemuxAudio) with diverging behavior — the remux copy
 * ignored the offset, so changing a fade silently discarded a configured
 * offset. One implementation ends that class of bug.
 *
 * The functions are written against a minimal structural AudioBuffer type
 * with an injectable output-buffer factory so the math is unit-testable
 * outside a browser.
 */

export interface AudioBufferLike {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export type AudioBufferFactory = (options: {
  length: number;
  numberOfChannels: number;
  sampleRate: number;
}) => AudioBufferLike;

export interface AssembleAudioOptions {
  /** Seconds. Positive = delay audio start; negative = trim from the start. */
  offset?: number;
  /** Fade lengths in seconds. */
  fadeIn?: number;
  fadeOut?: number;
}

const MINIMUM_AUDIO_DURATION = 0.1; // seconds

const defaultFactory: AudioBufferFactory = (options) => new AudioBuffer(options);

/**
 * ITU-style downmix of multichannel audio to stereo. WebAudio channel order
 * for 5.1 is [FL, FR, FC, LFE, SL, SR]. Buffers with 1 or 2 channels are
 * returned untouched.
 */
export function downmixToStereo(
  buffer: AudioBufferLike,
  createBuffer: AudioBufferFactory = defaultFactory
): AudioBufferLike {
  const channels = buffer.numberOfChannels;
  if (channels <= 2) {
    return buffer;
  }

  const out = createBuffer({
    length: buffer.length,
    numberOfChannels: 2,
    sampleRate: buffer.sampleRate,
  });
  const left = out.getChannelData(0);
  const right = out.getChannelData(1);

  const fl = buffer.getChannelData(0);
  const fr = buffer.getChannelData(1);
  const fc = channels > 2 ? buffer.getChannelData(2) : null;
  // Channel 3 is LFE in the 5.1 layout; conventionally omitted from downmix.
  const sl = channels > 4 ? buffer.getChannelData(4) : null;
  const sr = channels > 5 ? buffer.getChannelData(5) : null;

  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  for (let i = 0; i < buffer.length; i++) {
    const center = fc ? 0.7071 * fc[i] : 0;
    left[i] = clamp(fl[i] + center + (sl ? 0.7071 * sl[i] : 0));
    right[i] = clamp(fr[i] + center + (sr ? 0.7071 * sr[i] : 0));
  }
  return out;
}

/** Apply linear fade-in/fade-out in place. */
export function applyFades(
  buffer: AudioBufferLike,
  options: Pick<AssembleAudioOptions, 'fadeIn' | 'fadeOut'>
): void {
  const fadeInSeconds = Math.max(0, options.fadeIn ?? 0);
  const fadeOutSeconds = Math.max(0, options.fadeOut ?? 0);
  if (fadeInSeconds === 0 && fadeOutSeconds === 0) return;

  const totalSamples = buffer.length;
  if (totalSamples === 0) return;

  let fadeInSamples = Math.min(totalSamples, Math.floor(fadeInSeconds * buffer.sampleRate));
  let fadeOutSamples = Math.min(totalSamples, Math.floor(fadeOutSeconds * buffer.sampleRate));

  if (fadeInSamples + fadeOutSamples > totalSamples) {
    const scale = totalSamples / Math.max(1, fadeInSamples + fadeOutSamples);
    fadeInSamples = Math.floor(fadeInSamples * scale);
    fadeOutSamples = Math.floor(fadeOutSamples * scale);
  }

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < fadeInSamples; i++) {
      data[i] *= i / fadeInSamples;
    }
    for (let i = 0; i < fadeOutSamples; i++) {
      const sampleIndex = totalSamples - fadeOutSamples + i;
      data[sampleIndex] *= (fadeOutSamples - i) / fadeOutSamples;
    }
  }
}

/**
 * Assemble decoded chunks into one buffer covering `targetDuration` seconds:
 * offset, loop-to-fill, downmix to stereo, and fades — in that order.
 * Returns null when the chunks contain no audio data at all.
 */
export function assembleAudio(
  chunks: AudioBufferLike[],
  targetDuration: number,
  options: AssembleAudioOptions = {},
  createBuffer: AudioBufferFactory = defaultFactory
): AudioBufferLike | null {
  const usable = chunks.filter((c) => c.length > 0);
  const totalSourceSamples = usable.reduce((sum, c) => sum + c.length, 0);
  if (usable.length === 0 || totalSourceSamples === 0) {
    return null;
  }

  const stereoChunks = usable.map((c) => downmixToStereo(c, createBuffer));
  const sampleRate = stereoChunks[0].sampleRate;
  const channels = Math.min(2, stereoChunks[0].numberOfChannels);
  const totalSamples = Math.max(
    1,
    Math.floor(Math.max(MINIMUM_AUDIO_DURATION, targetDuration) * sampleRate)
  );

  const merged = createBuffer({ length: totalSamples, numberOfChannels: channels, sampleRate });

  const offsetSeconds = options.offset ?? 0;
  const offsetSamples = Math.floor(offsetSeconds * sampleRate);

  // Positive offset: start writing later (leading silence).
  // Negative offset: skip source samples from the front.
  let writeOffset = offsetSamples > 0 ? Math.min(offsetSamples, totalSamples) : 0;
  let sourceSkip = offsetSamples < 0 ? -offsetSamples : 0;

  let chunkIndex = 0;
  let chunkOffset = 0;
  while (sourceSkip > 0 && chunkIndex < stereoChunks.length) {
    const available = stereoChunks[chunkIndex].length - chunkOffset;
    if (sourceSkip >= available) {
      sourceSkip -= available;
      chunkIndex++;
      chunkOffset = 0;
    } else {
      chunkOffset = sourceSkip;
      sourceSkip = 0;
    }
  }

  const writeFrom = (
    chunk: AudioBufferLike,
    fromSample: number,
    toWriteOffset: number,
    length: number
  ) => {
    for (let channel = 0; channel < channels; channel++) {
      const sourceChannel = Math.min(channel, chunk.numberOfChannels - 1);
      const data = chunk.getChannelData(sourceChannel).subarray(fromSample, fromSample + length);
      merged.getChannelData(channel).set(data, toWriteOffset);
    }
  };

  // First pass: write from the (possibly trimmed) source position.
  while (writeOffset < totalSamples && chunkIndex < stereoChunks.length) {
    const chunk = stereoChunks[chunkIndex];
    const available = chunk.length - chunkOffset;
    const writeLength = Math.min(available, totalSamples - writeOffset);
    writeFrom(chunk, chunkOffset, writeOffset, writeLength);
    writeOffset += writeLength;
    chunkOffset += writeLength;
    if (chunkOffset >= chunk.length) {
      chunkIndex++;
      chunkOffset = 0;
    }
  }

  // Loop the track from its start until the timeline is filled.
  while (writeOffset < totalSamples) {
    for (const chunk of stereoChunks) {
      const remaining = totalSamples - writeOffset;
      if (remaining <= 0) break;
      const writeLength = Math.min(chunk.length, remaining);
      writeFrom(chunk, 0, writeOffset, writeLength);
      writeOffset += writeLength;
    }
  }

  applyFades(merged, options);
  return merged;
}
