import { useEffect, useRef, useState, useCallback } from 'react';

export interface VideoPlaybackState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  isReady: boolean;
}

export interface UseVideoPlaybackReturn {
  videoRef: (element: HTMLVideoElement | null) => void;
  state: VideoPlaybackState;
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  seek: (time: number) => void;
}

/**
 * Hook for managing video playback state and controls
 */
export function useVideoPlayback(
  onTimeUpdate?: (currentTime: number) => void
): UseVideoPlaybackReturn {
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const [boundVideo, setBoundVideo] = useState<HTMLVideoElement | null>(null);
  const [state, setState] = useState<VideoPlaybackState>({
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    isReady: false,
  });

  const animationFrameRef = useRef<number | null>(null);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const updateCurrentTimeRef = useRef<() => void | null>(null);
  const setVideoRef = useCallback((element: HTMLVideoElement | null) => {
    videoElementRef.current = element;
    setBoundVideo(element);

    setState((prev) => ({
      ...prev,
      currentTime: element?.currentTime ?? 0,
      duration: element?.duration ?? 0,
      isPlaying: element ? !element.paused && !element.ended : false,
      isReady: Boolean(element?.readyState && element.readyState >= 1),
    }));
  }, []);

  // Keep refs up to date
  useEffect(() => {
    onTimeUpdateRef.current = onTimeUpdate;
  }, [onTimeUpdate]);

  useEffect(() => {
    // Update current time using requestAnimationFrame for smooth playhead movement
    updateCurrentTimeRef.current = () => {
      if (videoElementRef.current && !videoElementRef.current.paused) {
        const currentTime = videoElementRef.current.currentTime;
        setState((prev) => ({ ...prev, currentTime }));
        onTimeUpdateRef.current?.(currentTime);
        animationFrameRef.current = requestAnimationFrame(() => updateCurrentTimeRef.current?.());
      }
    };

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Play video
  const play = useCallback(() => {
    const video = videoElementRef.current;
    console.log('play() called, videoRef.current:', video);
    if (video) {
      console.log('Attempting to play video, readyState:', video.readyState);
      video
        .play()
        .then(() => {
          console.log('Video play promise resolved');
        })
        .catch((error) => {
          console.error('Error playing video:', error);
        });
    } else {
      console.error('play() called but videoRef.current is null');
    }
  }, []);

  // Pause video
  const pause = useCallback(() => {
    if (videoElementRef.current) {
      videoElementRef.current.pause();
    }
  }, []);

  // Toggle play/pause
  const togglePlayPause = useCallback(() => {
    console.log('togglePlayPause called, isPlaying:', state.isPlaying);
    if (state.isPlaying) {
      console.log('Calling pause()');
      pause();
    } else {
      console.log('Calling play()');
      play();
    }
  }, [state.isPlaying, play, pause]);

  // Seek to specific time
  const seek = useCallback((time: number) => {
    if (videoElementRef.current) {
      videoElementRef.current.currentTime = time;
      setState((prev) => ({ ...prev, currentTime: time }));
      onTimeUpdateRef.current?.(time);
    }
  }, []);

  // Keep DOM playback state in sync with hook state
  useEffect(() => {
    const video = boundVideo;
    if (!video) {
      return;
    }

    if (state.isPlaying && video.paused) {
      video
        .play()
        .then(() => {
          console.log('Synced play state after rerender');
        })
        .catch((error) => {
          console.error('Failed to resume playback:', error);
          setState((prev) => ({ ...prev, isPlaying: false }));
        });
    } else if (!state.isPlaying && !video.paused) {
      video.pause();
    }
  }, [state.isPlaying, boundVideo]);

  // Set up event listeners - re-run when video element changes
  useEffect(() => {
    const video = boundVideo;
    if (!video) {
      console.log('useVideoPlayback: No video element attached to ref');
      return;
    }

    console.log('useVideoPlayback: Setting up event listeners on video element');

    const handleLoadedMetadata = () => {
      console.log('useVideoPlayback: Video metadata loaded, duration:', video.duration);
      setState((prev) => ({
        ...prev,
        duration: video.duration,
        isReady: true,
      }));
    };

    const handlePlay = () => {
      console.log('useVideoPlayback: Video play event');
      setState((prev) => ({ ...prev, isPlaying: true }));
      animationFrameRef.current = requestAnimationFrame(() => updateCurrentTimeRef.current?.());
    };

    const handlePause = () => {
      console.log('useVideoPlayback: Video pause event');
      setState((prev) => ({ ...prev, isPlaying: false }));
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };

    const handleEnded = () => {
      console.log('useVideoPlayback: Video ended event');
      setState((prev) => ({ ...prev, isPlaying: false }));
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };

    const handleTimeUpdate = () => {
      // Fallback for when RAF isn't running
      if (video.paused) {
        const currentTime = video.currentTime;
        setState((prev) => ({ ...prev, currentTime }));
        onTimeUpdateRef.current?.(currentTime);
      }
    };

    const handleError = (e: Event) => {
      console.error('useVideoPlayback: Video error event', e);
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('error', handleError);

    // If metadata is already loaded, update state immediately
    if (video.readyState >= 1) {
      handleLoadedMetadata();
    }

    return () => {
      console.log('useVideoPlayback: Cleaning up event listeners');
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('error', handleError);

      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [boundVideo]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Only handle if focus isn't on an input element
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA'
      ) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayPause();
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [togglePlayPause]);

  return {
    videoRef: setVideoRef,
    state,
    play,
    pause,
    togglePlayPause,
    seek,
  };
}
