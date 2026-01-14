
import React, { useState, useRef, useEffect } from 'react';
import { SliceSettings, SliceResult, AppMode } from './types.ts';

const App: React.FC = () => {
  // --- States ---
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<AppMode>(AppMode.VIDEO);
  const [mediaInfo, setMediaInfo] = useState({ duration: 0, width: 0, height: 0 });
  const [settings, setSettings] = useState<SliceSettings>({
    startTime: 0,
    endTime: 6,
    fps: 10,
    quality: 10
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [results, setResults] = useState<(SliceResult | null)[]>(new Array(9).fill(null));
  const [workerBlobUrl, setWorkerBlobUrl] = useState<string | null>(null);

  // --- Refs ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Initialization ---
  useEffect(() => {
    const initGifWorker = async () => {
      try {
        const response = await fetch('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js');
        if (!response.ok) throw new Error('Worker fetch failed');
        const workerCode = await response.text();
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        setWorkerBlobUrl(URL.createObjectURL(blob));
      } catch (e) {
        console.error('Failed to load GIF worker:', e);
        setStatus('错误：GIF 引擎初始化失败。');
      }
    };
    initGifWorker();
    return () => {
      if (workerBlobUrl) URL.revokeObjectURL(workerBlobUrl);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, []);

  // --- Handlers ---
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setResults(new Array(9).fill(null));
    setProgress(0);
    setStatus('');

    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl(url);
    setFile(selectedFile);

    if (selectedFile.type.startsWith('image/')) {
      setMode(AppMode.IMAGE);
    } else {
      setMode(AppMode.VIDEO);
    }
  };

  const onImageLoad = () => {
    if (imageRef.current) {
      setMediaInfo({
        duration: 0,
        width: imageRef.current.naturalWidth,
        height: imageRef.current.naturalHeight
      });
    }
  };

  const onVideoMetadata = () => {
    if (videoRef.current) {
      const duration = videoRef.current.duration;
      setMediaInfo({
        duration,
        width: videoRef.current.videoWidth,
        height: videoRef.current.videoHeight
      });
      setSettings(prev => ({ 
        ...prev, 
        startTime: 0,
        endTime: Math.min(6, Number(duration.toFixed(1))) 
      }));
    }
  };

  const sliceImage = (img: HTMLImageElement, sx: number, sy: number, w: number, h: number): Promise<SliceResult> => {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(img, sx, sy, w, h, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (blob) {
          resolve({ blob, url: URL.createObjectURL(blob) });
        }
      }, 'image/png');
    });
  };

  const sliceVideoToGif = (
    video: HTMLVideoElement,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    s: SliceSettings
  ): Promise<SliceResult> => {
    return new Promise(async (resolve, reject) => {
      if (!window.GIF || !workerBlobUrl) return reject(new Error('GIF 引擎未就绪'));

      const gif = new window.GIF({
        workers: 2,
        quality: s.quality,
        workerScript: workerBlobUrl,
        width: sw,
        height: sh,
        transparent: null
      });

      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      const duration = Math.max(0.1, s.endTime - s.startTime);
      const totalFrames = Math.max(1, Math.floor(duration * s.fps));
      const step = 1 / s.fps;
      let currentTime = s.startTime;

      const seekTo = (time: number) => new Promise<void>((res, rej) => {
        const timeout = setTimeout(() => {
          video.removeEventListener('seeked', handler);
          rej(new Error('视频定位超时'));
        }, 5000);

        const handler = () => {
          clearTimeout(timeout);
          video.removeEventListener('seeked', handler);
          res();
        };
        video.addEventListener('seeked', handler);
        video.currentTime = time;
      });

      try {
        for (let f = 0; f < totalFrames; f++) {
          await seekTo(currentTime);
          ctx?.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
          gif.addFrame(ctx, { copy: true, delay: 1000 / s.fps });
          currentTime += step;
          if (currentTime > s.endTime) break;
        }

        gif.on('finished', (blob: Blob) => {
          resolve({ blob, url: URL.createObjectURL(blob) });
        });
        gif.render();
      } catch (err) {
        reject(err);
      }
    });
  };

  const handleProcess = async () => {
    if (!file || (mode === AppMode.VIDEO && !workerBlobUrl)) return;

    setIsProcessing(true);
    setProgress(0);
    setResults(new Array(9).fill(null));

    const chunkW = Math.floor(mediaInfo.width / 3);
    const chunkH = Math.floor(mediaInfo.height / 3);
    const newResults = [...new Array(9).fill(null)];

    try {
      for (let i = 0; i < 9; i++) {
        setStatus(`正在处理第 ${i + 1} / 9 个切片...`);
        const row = Math.floor(i / 3);
        const col = i % 3;
        const sx = col * chunkW;
        const sy = row * chunkH;

        let result: SliceResult;
        if (mode === AppMode.IMAGE && imageRef.current) {
          result = await sliceImage(imageRef.current, sx, sy, chunkW, chunkH);
        } else if (mode === AppMode.VIDEO && videoRef.current) {
          result = await sliceVideoToGif(videoRef.current, sx, sy, chunkW, chunkH, settings);
        } else {
          throw new Error('未发现媒体源');
        }

        newResults[i] = result;
        setResults([...newResults]);
        setProgress(((i + 1) / 9) * 100);
      }
      setStatus('所有切片制作完成！');
    } catch (err: any) {
      console.error(err);
      setStatus(`制作失败: ${err.message || '未知错误'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownloadAll = async () => {
    if (results.some(r => r === null)) return;
    try {
      const zip = new window.JSZip();
      const folderName = mode === AppMode.IMAGE ? '9_grid_images' : '9_grid_gifs';
      const ext = mode === AppMode.IMAGE ? 'png' : 'gif';
      const folder = zip.folder(folderName);

      results.forEach((res, i) => {
        if (res) folder.file(`slice_${i + 1}.${ext}`, res.blob);
      });

      setStatus('正在打包 ZIP...');
      const content = await zip.generateAsync({ type: 'blob' });
      window.saveAs(content, `${folderName}.zip`);
      setStatus('下载已开始');
    } catch (err) {
      setStatus('打包失败');
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <header className="text-center mb-8">
        <h1 className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-500 mb-2">
          九宫格切片工具 Pro
        </h1>
        <p className="text-slate-400">将视频转为九宫格 GIF 或将图片切分为 9 份 PNG</p>
      </header>

      <div className="bg-slate-800 rounded-2xl p-6 shadow-2xl border border-slate-700 mb-10">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-slate-200">1. 素材上传</h3>
            <div 
              onClick={() => fileInputRef.current?.click()}
              className={`relative h-64 border-2 border-dashed rounded-xl flex flex-col items-center justify-center cursor-pointer transition-all ${
                file ? 'border-blue-500 bg-slate-700/50' : 'border-slate-600 hover:border-blue-400 bg-slate-900/50'
              }`}
            >
              <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="video/*,image/*" className="hidden" />
              {!file ? (
                <div className="text-center p-6">
                  <div className="w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 border border-slate-700 shadow-inner">
                    <svg className="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                  </div>
                  <p className="text-slate-300 font-medium">点击或拖拽上传</p>
                </div>
              ) : (
                <div className="w-full h-full flex flex-col p-4">
                  <div className="flex-1 flex items-center justify-center overflow-hidden bg-black rounded-lg relative">
                    {mode === AppMode.VIDEO && previewUrl && (
                      <video ref={videoRef} src={previewUrl} muted onLoadedMetadata={onVideoMetadata} className="max-w-full max-h-full" controls />
                    )}
                    {mode === AppMode.IMAGE && previewUrl && (
                      <img ref={imageRef} src={previewUrl} onLoad={onImageLoad} className="max-w-full max-h-full object-contain" alt="preview" />
                    )}
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-blue-400 truncate pr-2">{file.name}</p>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); setFile(null); setPreviewUrl(null); }} className="text-xs text-red-400 shrink-0">重新选择</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-6">
            <h3 className="text-lg font-semibold text-slate-200">2. 参数设置</h3>
            {mode === AppMode.VIDEO ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">开始 (s)</label>
                    <input type="number" step="0.1" value={settings.startTime} onChange={e => setSettings({...settings, startTime: Number(e.target.value)})} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">结束 (s)</label>
                    <input type="number" step="0.1" value={settings.endTime} onChange={e => setSettings({...settings, endTime: Number(e.target.value)})} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200" />
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-8 bg-slate-900/50 rounded-xl border border-slate-700 border-dashed text-center">
                <p className="text-sm text-slate-300">图片模式：自动切分为 9 份 PNG</p>
              </div>
            )}

            <button
              disabled={!file || isProcessing}
              onClick={handleProcess}
              className={`w-full py-4 rounded-xl font-bold text-white shadow-lg transition-all ${!file || isProcessing ? 'bg-slate-700' : 'bg-gradient-to-r from-blue-600 to-indigo-600 active:scale-95'}`}
            >
              {isProcessing ? '处理中...' : '开始制作'}
            </button>
            {isProcessing && (
              <div className="w-full bg-slate-900 rounded-full h-2 overflow-hidden">
                <div className="bg-blue-500 h-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
              </div>
            )}
            {status && <p className="text-xs text-center text-slate-400">{status}</p>}
          </div>
        </div>
      </div>

      {(results.some(r => r !== null) || isProcessing) && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-white">切片预览</h2>
            {results.every(r => r !== null) && (
              <button onClick={handleDownloadAll} className="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold">下载 ZIP</button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 bg-black p-2 rounded-2xl max-w-[500px] mx-auto overflow-hidden border border-slate-800">
            {results.map((res, i) => (
              <div key={i} className="aspect-square bg-slate-900 rounded flex items-center justify-center overflow-hidden border border-slate-800">
                {res ? <img src={res.url} className="w-full h-full object-cover" /> : <div className="animate-pulse w-4 h-4 bg-slate-700 rounded-full"></div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
