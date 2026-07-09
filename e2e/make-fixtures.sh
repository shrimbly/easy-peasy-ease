#!/usr/bin/env bash
# Generates the synthetic video/audio fixtures the E2E suite uploads.
# Requires ffmpeg. Pattern sources are used (no fonts needed, fast to encode).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fixtures
cd fixtures

ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=5" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -b:v 8M clip1.mp4 &
ffmpeg -y -loglevel error -f lavfi -i "smptehdbars=size=1920x1080:rate=30:duration=5" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -b:v 8M clip2.mp4 &
ffmpeg -y -loglevel error -f lavfi -i "mandelbrot=size=1920x1080:rate=30" -t 5 \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -b:v 8M clip3.mp4 &
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=5" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -b:v 4M clip_small.mp4 &
# One long clip for the "Split a video" flow (12s -> 3 sections at 5s).
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=12" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -b:v 8M long.mp4 &
ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=440:duration=10" -ac 2 -b:a 128k music.mp3 &
# 128 BPM kick track (decaying 175Hz thump every 60/128 = 0.46875s, first beat
# at t=0.15) for the beat-sync scenario. WAV so no codec delay shifts the phase.
ffmpeg -y -loglevel error -f lavfi \
  -i "aevalsrc=0.85*exp(-30*mod(t+0.31875\,0.46875))*sin(2*PI*175*t):s=44100:c=mono:d=30" \
  -c:a pcm_s16le beats128.wav &
wait
echo "Fixtures written to $(pwd)"
