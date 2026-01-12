
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { SliceSettings, SliceResult, AppMode } from './types';

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
        setStatus('错误：GIF 引擎初始化失败，请检查网络连接。');
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

    // 清理旧资源
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

      // 优化后的 seekTo，带超时控制
      const seekTo = (time: number) => new Promise<void>((res, rej) => {
        const timeout = setTimeout(() => {
          video.removeEventListener('seeked', handler);
          rej(new Error('视频跳转超时，可能格式不兼容'));
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
    if (!file || (mode === AppMode.VIDEO && !workerBlobUrl)) {
      setStatus('资源未准备好');
      return;
    }

    setIsProcessing(true);
    setProgress(0);
    const initialResults = new Array(9).fill(null);
    setResults(initialResults);

    const chunkW = Math.floor(mediaInfo.width / 3);
    const chunkH = Math.floor(mediaInfo.height / 3);
    const newResults = [...initialResults];

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

      setStatus('正在生成压缩包...');
      const content = await zip.generateAsync({ type: 'blob' });
      window.saveAs(content, `${folderName}.zip`);
      setStatus('下载已开始');
    } catch (err) {
      setStatus('下载打包失败');
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      {/* Header */}
      <header className="text-center mb-8">
        <h1 className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-500 mb-2">
          九宫格切片工具 Pro
        </h1>
        <p className="text-slate-400">将视频转为九宫格 GIF 或将图片切分为 9 份 PNG</p>
      </header>

      {/* Main Container */}
      <div className="bg-slate-800 rounded-2xl p-6 shadow-2xl border border-slate-700 mb-10">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          
          {/* Left: Upload and Preview */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-slate-200">1. 素材上传</h3>
            <div 
              onClick={() => fileInputRef.current?.click()}
              className={`relative h-64 border-2 border-dashed rounded-xl flex flex-col items-center justify-center cursor-pointer transition-all ${
                file ? 'border-blue-500 bg-slate-700/50' : 'border-slate-600 hover:border-blue-400 bg-slate-900/50'
              }`}
            >
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange}
                accept="video/*,image/*" 
                className="hidden" 
              />
              
              {!file ? (
                <div className="text-center p-6">
                  <div className="w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 border border-slate-700 shadow-inner">
                    <svg className="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                  </div>
                  <p className="text-slate-300 font-medium">点击或拖拽文件上传</p>
                  <p className="text-xs text-slate-500 mt-2">支持常见视频及图片格式</p>
                </div>
              ) : (
                <div className="w-full h-full flex flex-col p-4">
                  <div className="flex-1 flex items-center justify-center overflow-hidden bg-black rounded-lg relative">
                    {mode === AppMode.VIDEO && previewUrl && (
                      <video 
                        ref={videoRef} 
                        src={previewUrl}
                        muted 
                        onLoadedMetadata={onVideoMetadata}
                        className="max-w-full max-h-full" 
                        controls 
                      />
                    )}
                    {mode === AppMode.IMAGE && previewUrl && (
                      <img 
                        ref={imageRef} 
                        src={previewUrl}
                        onLoad={onImageLoad}
                        className="max-w-full max-h-full object-contain" 
                        alt="preview"
                      />
                    )}
                    <div className="absolute top-2 right-2 px-2 py-1 bg-black/60 backdrop-blur rounded text-[10px] font-bold text-white uppercase tracking-wider">
                      {mode}
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-blue-400 truncate pr-2">{file.name}</p>
                      <p className="text-[10px] text-slate-500">{mediaInfo.width} x {mediaInfo.height} {mode === AppMode.VIDEO && `| ${mediaInfo.duration.toFixed(1)}s`}</p>
                    </div>
                    <button 
                      onClick={(e) => { e.stopPropagation(); setFile(null); setPreviewUrl(null); }}
                      className="text-xs text-red-400 hover:text-red-300 font-medium shrink-0"
                    >
                      重新选择
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right: Settings */}
          <div className="space-y-6">
            <h3 className="text-lg font-semibold text-slate-200">2. 参数设置</h3>
            
            {mode === AppMode.VIDEO ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">开始时间 (秒)</label>
                    <input 
                      type="number" 
                      step="0.1"
                      value={settings.startTime}
                      onChange={e => setSettings({...settings, startTime: Number(e.target.value)})}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">结束时间 (秒)</label>
                    <input 
                      type="number" 
                      step="0.1"
                      value={settings.endTime}
                      onChange={e => setSettings({...settings, endTime: Number(e.target.value)})}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">采样帧率 (FPS)</label>
                    <select 
                      value={settings.fps}
                      onChange={e => setSettings({...settings, fps: Number(e.target.value)})}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                    >
                      <option value={5}>5 FPS (极速)</option>
                      <option value={10}>10 FPS (推荐)</option>
                      <option value={15}>15 FPS (流畅)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">质量参数</label>
                    <select 
                      value={settings.quality}
                      onChange={e => setSettings({...settings, quality: Number(e.target.value)})}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                    >
                      <option value={20}>低 (生成快)</option>
                      <option value={10}>中 (平衡)</option>
                      <option value={1}>高 (慢但清晰)</option>
                    </select>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-8 bg-slate-900/50 rounded-xl border border-slate-700 border-dashed text-center">
                <p className="text-sm text-slate-300">当前处于图片模式</p>
                <p className="text-xs text-slate-500 mt-1">系统将自动为您精确切分为 9 张等大的 PNG 图片</p>
              </div>
            )}

            <div className="pt-4 space-y-4">
              <button
                disabled={!file || isProcessing}
                onClick={handleProcess}
                className={`w-full py-4 rounded-xl font-bold text-white shadow-lg transition-all flex items-center justify-center gap-3 ${
                  !file || isProcessing 
                  ? 'bg-slate-700 cursor-not-allowed text-slate-400' 
                  : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 active:scale-95'
                }`}
              >
                {isProcessing && (
                  <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
                )}
                {isProcessing ? '正在处理中...' : '开始切片制作'}
              </button>

              {isProcessing && (
                <div className="space-y-2">
                  <div className="w-full bg-slate-900 rounded-full h-2 shadow-inner overflow-hidden">
                    <div 
                      className="bg-blue-500 h-full transition-all duration-300 shadow-[0_0_10px_rgba(59,130,246,0.5)]" 
                      style={{ width: `${progress}%` }}
                    ></div>
                  </div>
                  <p className="text-[10px] text-center text-slate-500 font-medium uppercase tracking-widest animate-pulse">
                    {status}
                  </p>
                </div>
              )}
              
              {!isProcessing && status && (
                <p className={`text-xs text-center font-medium ${status.includes('失败') ? 'text-red-400' : 'text-slate-400'}`}>{status}</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Results Section */}
      {(results.some(r => r !== null) || isProcessing) && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-white">切片预览</h2>
            {results.every(r => r !== null) && (
              <button 
                onClick={handleDownloadAll}
                className="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold shadow-lg transition-all flex items-center gap-2 active:scale-95"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                打包下载 ZIP
              </button>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 md:gap-4 bg-black p-2 md:p-6 rounded-2xl shadow-2xl border border-slate-800 ring-1 ring-slate-700/50 max-w-[600px] mx-auto overflow-hidden">
            {results.map((res, i) => (
              <div 
                key={i} 
                className="aspect-square bg-slate-900 rounded-lg relative group overflow-hidden border border-slate-800 flex items-center justify-center transition-all hover:ring-2 hover:ring-blue-500/50"
              >
                {res ? (
                  <>
                    <img src={res.url} className="w-full h-full object-cover" alt={`slice ${i+1}`} />
                    <a 
                      href={res.url} 
                      download={`slice_${i+1}.${mode === AppMode.IMAGE ? 'png' : 'gif'}`}
                      className="absolute bottom-2 right-2 bg-black/60 backdrop-blur text-white p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-all hover:bg-blue-600 scale-90 group-hover:scale-100"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                    </a>
                    <div className="absolute top-1 left-1 bg-black/40 px-1.5 py-0.5 rounded text-[8px] font-mono text-white pointer-events-none">
                      {i + 1}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center">
                    <div className="w-2 h-2 bg-slate-700 rounded-full animate-bounce"></div>
                    <span className="text-[10px] text-slate-700 mt-2 font-mono uppercase tracking-tighter">WAITING</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer Disclaimer */}
      <footer className="mt-16 text-center text-slate-500 text-[10px] uppercase tracking-[0.2em] border-t border-slate-800 pt-8">
        Built for Speed & Quality • 100% Client-Side Processing
      </footer>
    </div>
  );
};

export default App;
