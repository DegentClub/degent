'use client';

import { useEffect, useRef, useState } from 'react';
import imageCompression from 'browser-image-compression';
import { MAX_FILE_BYTES, MIN_FILE_BYTES, formatFileSize, isFileSizeValid } from '@/lib/api';

interface FileValidationProps {
  originalFile: File | null;
  /** Called with the file to submit (null while compressing) whenever it changes. */
  onCompressedFile: (file: File | null) => void;
  disabled?: boolean;
}

const COMPRESS_DEBOUNCE_MS = 250;

export default function FileValidation({ originalFile, onCompressedFile, disabled }: FileValidationProps) {
  const [quality, setQuality] = useState(100);
  const [compressedFile, setCompressedFile] = useState<File | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // Monotonic id so a slow compression cannot overwrite a newer result.
  const requestCounter = useRef(0);
  const onCompressedRef = useRef(onCompressedFile);
  onCompressedRef.current = onCompressedFile;

  // New source file: reset slider and hand the original through untouched.
  useEffect(() => {
    requestCounter.current++;
    setQuality(100);
    setIsCompressing(false);
    setCompressedFile(originalFile);
    onCompressedRef.current(originalFile);
  }, [originalFile]);

  // Object URL lifecycle: one per preview, revoked when replaced or unmounted.
  useEffect(() => {
    if (!compressedFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(compressedFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [compressedFile]);

  // Debounced, race-guarded compression whenever the quality changes.
  useEffect(() => {
    if (!originalFile) return;
    const requestId = ++requestCounter.current;

    if (quality === 100) {
      setIsCompressing(false);
      setCompressedFile(originalFile);
      onCompressedRef.current(originalFile);
      return;
    }

    setIsCompressing(true);
    onCompressedRef.current(null);

    const timer = window.setTimeout(async () => {
      let result: File = originalFile;
      try {
        const compressed = await imageCompression(originalFile, {
          maxSizeMB: MAX_FILE_BYTES / (1024 * 1024),
          maxWidthOrHeight: 2048,
          useWebWorker: true,
          initialQuality: quality / 100,
          alwaysKeepResolution: false,
        });
        result = new File([compressed], originalFile.name, { type: originalFile.type });
      } catch {
        result = originalFile;
      }
      if (requestId !== requestCounter.current) return; // superseded
      setIsCompressing(false);
      setCompressedFile(result);
      onCompressedRef.current(result);
    }, COMPRESS_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [originalFile, quality]);

  if (!originalFile) return null;

  const originalSize = originalFile.size;
  const compressedSize = compressedFile?.size ?? originalSize;
  const isValid = !isCompressing && isFileSizeValid(compressedSize);
  const sourceTooSmall = originalSize < MIN_FILE_BYTES;

  const helperText = (() => {
    if (isCompressing) return 'Compressing…';
    if (sourceTooSmall) {
      return `Your source image is ${formatFileSize(originalSize)}, below the ${formatFileSize(MIN_FILE_BYTES)} minimum for this collection. Compression can only shrink files, so export a larger version (higher resolution or less compression) and upload that instead.`;
    }
    if (compressedSize < MIN_FILE_BYTES) return 'Compressed too far. Move the quality slider up.';
    if (compressedSize > MAX_FILE_BYTES) return 'Still too large. Move the quality slider down.';
    return 'Size is within range. Ready for a quote.';
  })();

  return (
    <section
      className={`degent-card ${isValid ? 'border-degent-green/50' : 'border-red-500/50'}`}
      aria-labelledby="file-validation-title"
    >
      <h2 id="file-validation-title" className="degent-title h2">
        <span className={`icon-square ${isValid ? 'bg-degent-green/20' : 'bg-red-500/20'}`}>
          <i
            className={`fas ${isValid ? 'fa-check-circle text-degent-green' : 'fa-times-circle text-red-500'}`}
            aria-hidden="true"
          ></i>
        </span>
        File Validation
        <div className={`status ${isValid ? 'text-degent-green' : 'text-red-500'}`} aria-hidden="true">
          <i className={`fas ${isValid ? 'fa-check' : 'fa-times'}`}></i>
        </div>
      </h2>

      {!sourceTooSmall && (
        <div className="degent-card-2">
          <div className="degent-row">
            <h3 className="degent-title h3">
              <span className="icon-square">
                <i className="fas fa-sliders-h text-degent-green text-sm" aria-hidden="true"></i>
              </span>
              <label htmlFor="quality-slider">Quality</label>
            </h3>
            <span className="text-xl font-bold text-degent-orange" aria-live="polite">
              {quality}%
            </span>
          </div>

          <p className="text-degent-muted text-sm mb-3">
            Lower the quality to bring the file inside {formatFileSize(MIN_FILE_BYTES)}–{formatFileSize(MAX_FILE_BYTES)}.
          </p>

          <div className="relative">
            <input
              id="quality-slider"
              type="range"
              min="1"
              max="100"
              step="1"
              value={quality}
              disabled={disabled}
              onChange={(e) => setQuality(Number(e.target.value))}
              aria-valuemin={1}
              aria-valuemax={100}
              aria-valuenow={quality}
              aria-valuetext={`${quality} percent quality`}
              className="w-full h-2 bg-degent-input rounded-lg appearance-none cursor-pointer"
              style={{
                background: `linear-gradient(to right, #2efc86 0%, #2efc86 ${quality}%, #2a2a2d ${quality}%, #2a2a2d 100%)`,
              }}
            />
            <div className="flex justify-between text-xs text-degent-muted mt-1" aria-hidden="true">
              <span>1%</span>
              <span>100%</span>
            </div>
          </div>

          {isCompressing && (
            <div className="mt-3 text-center text-degent-green animate-pulse flex items-center justify-center gap-2" role="status">
              <i className="fas fa-spinner fa-spin" aria-hidden="true"></i>
              Compressing…
            </div>
          )}
        </div>
      )}

      <div className="degent-card-2 text-sm">
        <div className="degent-row">
          <span className="label-icon">
            <i className="fas fa-file-image text-degent-green" aria-hidden="true"></i>
            Original size
          </span>
          <span className="text-white font-semibold">{formatFileSize(originalSize)}</span>
        </div>
        <div className="degent-row">
          <span className="label-icon">
            <i className="fas fa-compress text-degent-green" aria-hidden="true"></i>
            Upload size
          </span>
          <span className={`font-semibold ${isValid ? 'text-degent-green' : 'text-red-400'}`}>
            {isCompressing ? '…' : formatFileSize(compressedSize)}
          </span>
        </div>
        <div className="degent-row total">
          <span className="text-degent-muted">Allowed range</span>
          <span className="text-white">
            {formatFileSize(MIN_FILE_BYTES)} – {formatFileSize(MAX_FILE_BYTES)}
          </span>
        </div>
        <div className={`info-text status ${isValid ? 'success' : 'error'}`} role="status">
          <i className={`fas ${isValid ? 'fa-check-circle' : 'fa-exclamation-triangle'}`} aria-hidden="true"></i>
          <span>{helperText}</span>
        </div>
      </div>

      {previewUrl && (
        <div className="degent-block-border-top">
          <p className="label-icon">
            <i className="fas fa-eye text-degent-green" aria-hidden="true"></i>
            Preview
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element -- blob URL preview */}
          <img src={previewUrl} alt="Preview of the image that will be inscribed" className="degent-image w-full" />
        </div>
      )}
    </section>
  );
}
