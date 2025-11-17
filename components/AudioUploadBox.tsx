'use client';

import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AudioUploadBoxProps {
  onAudioSelect: (file: File) => void;
  disabled?: boolean;
}

export function AudioUploadBox({ onAudioSelect, disabled = false }: AudioUploadBoxProps) {
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files[0]) {
      const audioFiles = Array.from(files).filter((f) => f.type.startsWith('audio/'));
      if (audioFiles[0]) {
        onAudioSelect(audioFiles[0]);
      }
    }
  };

  return (
    <div className="w-full">
      <input
        type="file"
        accept="audio/*"
        onChange={handleFileChange}
        className="hidden"
        id="audio-input"
        disabled={disabled}
      />
      <div
        className={cn(
          'rounded-lg border-2 border-dashed border-muted-foreground/30 p-4 text-center transition-colors',
          'flex items-center justify-center h-[80px] cursor-pointer',
          !disabled && 'hover:border-muted-foreground/50',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
        onClick={() => !disabled && document.getElementById('audio-input')?.click()}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            document.getElementById('audio-input')?.click();
          }
        }}
        tabIndex={disabled ? -1 : 0}
        role="button"
        aria-label="Click to upload audio"
      >
        <div className="flex items-center justify-center gap-2">
          <Plus className="h-5 w-5 text-muted-foreground flex-shrink-0" />
          <p className="text-sm font-medium text-muted-foreground">Add Audio Track</p>
        </div>
      </div>
    </div>
  );
}
