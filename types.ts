
export interface SliceSettings {
  startTime: number;
  endTime: number;
  fps: number;
  quality: number;
}

export interface SliceResult {
  blob: Blob;
  url: string;
}

export enum AppMode {
  VIDEO = 'VIDEO',
  IMAGE = 'IMAGE'
}

// Extend Window for external libraries
declare global {
  interface Window {
    GIF: any;
    JSZip: any;
    saveAs: (blob: Blob, filename: string) => void;
  }
}
