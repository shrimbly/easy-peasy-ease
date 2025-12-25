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

## Added
- ** Rearrange the videos even on the edit video frames main screen. Very useful when testing your footage with the different S curve slow-fast-slow transitions.

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

## Bug fixes
Bug Fixes
Finalize Button Failure
Issue: The "Finalize & Stitch Videos" button appeared to do nothing when clicked.

Cause: The preflight warning dialog and the finalization progress dialog were nested inside the conditional rendering block for the Result View (finalVideo), making them inaccessible from the Upload View. If preflight checks failed (e.g., due to resolution mismatches), the code tried to show a dialog that wasn't legally in the DOM, failing silently.

Fix: Moved the <Dialog> components to the root of the page component so they are available in all views.

Video Stitching Error: Fixed "video sample size must remain constant" error by correctly configuring mediabunny to use sizeChangeBehavior: 'contain'.

Audio Delete Button: Fixed the audio delete button not triggering an update. It now correctly prompts for a video update when clicked. Also updated the hover style to turn the icon red (text-destructive), improving visual feedback.

Tooltip Visibility Fix: Implemented @radix-ui/react-tooltip to ensure tooltips (like Quality Rating) are always visible and accessible.

Systematic Refactoring
A major codebase cleanup was performed to improve maintainability and separation of concerns.

1. State Management & Hooks
Created 
hooks/useProjectState.ts
 to encapsulate complex state logic (video segments, loop functionality, metadata) away from the view layer.
app/page.tsx
 now acts as an Orchestrator, delegating logic to the hook and rendering to specialized components.
2. Component Modularization
VideoList: Extracted the "Uploaded Videos" list into 
components/VideoList.tsx
, handling list rendering and drag-and-drop reordering.
FinalVideoEditor Decomposition: Broken down the monolithic editor into focused components:
QualityRating.tsx
: Encapsulates aspect ratio consistency checks and UI.
UpdatePromptDialog.tsx
: Handles user confirmation for re-stitching videos.
AudioSettingsPanel.tsx
: Manages audio fade/loop UI.
SegmentSettingsPanel.tsx
: Handles individual video clip settings (duration, easing).
3. Service Layer
Project Service: Moved core business logic (metadata reading, preflight checks, bitrate estimation) to 
lib/project-service.ts
.
Types: Consolidated project-related types (
PreflightWarning
, 
VideoMetadata
) into 
lib/types.ts
.

## Commands

```bash
npm run dev      # Start development server (localhost:3000)
npm run build    # Build for production
npm run lint     # Run ESLint
npm test         # Run Vitest
``` 
