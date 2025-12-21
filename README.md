# stevie-peasy-ease

I have modified Wullies code so its more robust now and more user friendly.
The list of feature updates are down below the main one was warning users their aspcet ratio are wrong but we will process this anyway to give you an idea of what the finished product should look like if you fix it properly.

Client-side video editor that stitches video segments into seamless loops with custom ease-in/out speed curves and background music. This is a weekend project and has plenty of issues, for best results use desktop chrome or firefox, there is a known issue on Android chrome where frames at the end of each clip are dropped. I am not planning to maintain this project long term. 

## Workflow

Upload video segments → Order and trim → Apply speed curves → Stitch into MP4 → Mix audio → Download

## Tech Stack

- **Framework**: Next.js 16 App Router + React 19 + TypeScript 5
- **Styling**: Tailwind CSS 4 + shadcn/ui components + CSS variables
- **Video Engine**: Mediabunny (client-side WASM/JS processing)
- **State Management**: React hooks + custom hooks (`useFinalizeVideo`, `useVideoPlayback`, `useAudioVisualization`)

## Getting Started

```bash
npm install
npm run dev
```

## Key Features

- **Browser-based**: All processing happens client-side using Mediabunny—no server-side encoding
- **Speed Curves**: Apply preset or custom Bezier curves for organic motion
- **Audio Mixing**: Mix background music with video client-side
- **Session-only**: No persistent storage; all data is ephemeral

## Commands

```bash
npm run dev      # Start development server (localhost:3000)
npm run build    # Build for production
npm run lint     # Run ESLint
npm test         # Run Vitest
``` 
