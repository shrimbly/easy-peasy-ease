/**
 * Audio encoder availability.
 *
 * The output stays MP4 + AAC (with MP3 as a fallback) for maximum
 * social-media compatibility. Firefox and Chromium builds without
 * proprietary codecs ship no native WebCodecs AAC encoder, which used to
 * silently produce music-less videos there; the official
 * @mediabunny/aac-encoder WASM polyfill closes that gap. It is loaded
 * lazily and only registered when the native encoder is missing.
 */

import { canEncodeAudio } from 'mediabunny';

let registration: Promise<void> | null = null;

export const ensureAudioEncoders = (): Promise<void> => {
  registration ??= (async () => {
    if (await canEncodeAudio('aac')) {
      return;
    }
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
  })().catch((error) => {
    // Registration failure leaves us where we started (no AAC); callers
    // already handle "no encodable audio codec" and surface it to the user.
    console.warn('Failed to register AAC encoder polyfill:', error);
    registration = null;
  });
  return registration;
};

/** Audio bitrate by render quality: music deserves better than 128k in final output. */
export const audioBitrateForQuality = (quality: 'preview' | 'full'): number =>
  quality === 'preview' ? 128_000 : 192_000;
