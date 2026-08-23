import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import type { PreviewState, SourceType } from '../types';

export type PreviewBackground = 'grid' | 'checkerboard' | 'solid';

type PreviewKind = NonNullable<PreviewState['kind']>;

export type PreviewViewportProps = {
  /** The renderer result already used throughout the workbench. */
  preview: PreviewState;
  /** Used only for descriptive copy in empty and loading states. */
  sourceType?: SourceType | string;
  /** A complete, sandbox-safe SVG preview document, rather than raw SVG markup. */
  previewDocument?: string;
  /** A complete, sandbox-safe HTML preview document, rather than an HTML fragment. */
  htmlDocument?: string;
  title?: string;
  eyebrow?: string;
  className?: string;
  background?: PreviewBackground;
  onBackgroundChange?: (background: PreviewBackground) => void;
  /** Omit this to let the viewport manage presentation mode itself. */
  presentationMode?: boolean;
  onPresentationModeChange?: (active: boolean) => void;
  onRender?: () => void;
  onCopyOutput?: (content: string, kind: PreviewKind) => void;
  onCopyImage?: (content: string, kind: PreviewKind) => void;
  onExport?: () => void;
  onPrompt?: () => void;
  onJumpToError?: (message: string) => void;
  /** Opens the output in a separate, larger viewer when the parent provides one. */
  onOpenViewer?: () => void;
  onClose?: () => void;
  closeLabel?: string;
  /** Whether presentation uses a viewport overlay (default) or fills its parent container. */
  presentationStyle?: 'overlay' | 'inline';
  presentationLabel?: string;
};

const SOURCE_LABELS: Record<SourceType, { label: string; short: string }> = {
  tikz: { label: 'TikZ', short: 'TZ' },
  latex: { label: 'LaTeX', short: 'TEX' },
  metafont: { label: 'MetaFont', short: 'MF' },
  svg: { label: 'SVG', short: 'SV' },
  mermaid: { label: 'Mermaid', short: 'MM' },
  markdown: { label: 'Markdown', short: 'MD' },
  text: { label: 'Plain Text', short: 'TXT' },
  yaml: { label: 'YAML', short: 'YML' },
  json: { label: 'JSON', short: 'JSN' },
  javascript: { label: 'JavaScript', short: 'JS' },
  typescript: { label: 'TypeScript', short: 'TS' },
  python: { label: 'Python', short: 'PY' },
  fortran: { label: 'Fortran', short: 'F90' },
  sql: { label: 'SQL', short: 'SQL' },
  html: { label: 'HTML', short: 'HTML' },
  css: { label: 'CSS', short: 'CSS' },
};

const STATUS_LABELS: Record<PreviewState['status'], string> = {
  idle: 'Idle',
  rendering: 'Rendering',
  ready: 'Current',
  error: 'Error',
};

const ZOOM_MIN = 25;
const ZOOM_MAX = 400;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sourceDetails(sourceType?: SourceType | string) {
  if (sourceType && sourceType in SOURCE_LABELS) {
    return SOURCE_LABELS[sourceType as SourceType];
  }

  return { label: sourceType || 'Diagram', short: 'DF' };
}

/**
 * A panel-ready output viewport. It deliberately receives fully formed iframe
 * documents so document construction and sanitising remain owned by the render
 * layer, while the viewport owns interaction and display affordances.
 */
export default function PreviewViewport({
  preview,
  sourceType,
  previewDocument,
  htmlDocument,
  title = 'Live output',
  eyebrow = 'Read-only preview',
  className,
  background: controlledBackground,
  onBackgroundChange,
  presentationMode,
  onPresentationModeChange,
  onRender,
  onCopyOutput,
  onCopyImage,
  onExport,
  onPrompt,
  onJumpToError,
  onOpenViewer,
  onClose,
  closeLabel = 'Hide live preview',
  presentationStyle = 'overlay',
  presentationLabel = 'Full screen',
}: PreviewViewportProps) {
  const [uncontrolledBackground, setUncontrolledBackground] = useState<PreviewBackground>('grid');
  const [uncontrolledPresentation, setUncontrolledPresentation] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const background = controlledBackground ?? uncontrolledBackground;
  const isPresentationMode = presentationMode ?? uncontrolledPresentation;
  const source = useMemo(() => sourceDetails(sourceType), [sourceType]);
  const isReady = preview.status === 'ready';
  const isPannable = isReady && zoom > 100;

  const documentForPreview = preview.kind === 'svg'
    ? previewDocument ?? preview.content
    : preview.kind === 'html'
      ? htmlDocument ?? preview.content
      : undefined;
  const outputForCopy = preview.content ?? documentForPreview;

  const setBackground = useCallback((next: PreviewBackground) => {
    if (controlledBackground === undefined) setUncontrolledBackground(next);
    onBackgroundChange?.(next);
  }, [controlledBackground, onBackgroundChange]);

  const setPresentation = useCallback((next: boolean) => {
    if (presentationMode === undefined) setUncontrolledPresentation(next);
    onPresentationModeChange?.(next);
  }, [onPresentationModeChange, presentationMode]);

  const resetView = useCallback(() => {
    setZoom(100);
    setPan({ x: 0, y: 0 });
  }, []);

  const changeZoom = useCallback((delta: number) => {
    setZoom((current) => clamp(current + delta, ZOOM_MIN, ZOOM_MAX));
  }, []);

  useEffect(() => {
    // A new renderer revision should always open in a predictable, fitted view.
    resetView();
  }, [preview.kind, preview.revision, resetView]);

  useEffect(() => {
    if (zoom <= 100) setPan({ x: 0, y: 0 });
  }, [zoom]);

  useEffect(() => {
    if (!isPresentationMode) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPresentation(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPresentationMode, setPresentation]);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? 10 : -10);
  }, [changeZoom]);

  const handleStageKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === '0' || event.key.toLowerCase() === 'f') {
      event.preventDefault();
      resetView();
      return;
    }

    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      changeZoom(25);
      return;
    }

    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      changeZoom(-25);
      return;
    }

    if (event.key === 'Escape' && isPresentationMode) {
      event.preventDefault();
      setPresentation(false);
    }
  }, [changeZoom, isPresentationMode, resetView, setPresentation]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isPannable || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    };
    setIsDragging(true);
  }, [isPannable, pan.x, pan.y]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const panLimit = Math.max(80, Math.round((zoom - 100) * 4));
    setPan({
      x: clamp(drag.originX + event.clientX - drag.startX, -panLimit, panLimit),
      y: clamp(drag.originY + event.clientY - drag.startY, -panLimit, panLimit),
    });
  }, [zoom]);

  const stopDragging = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  const copyOutput = useCallback(() => {
    if (!outputForCopy || !preview.kind) return;
    onCopyOutput?.(outputForCopy, preview.kind);
  }, [onCopyOutput, outputForCopy, preview.kind]);

  const viewportClassName = [
    'preview-viewport',
    isPresentationMode && 'is-presentation-mode',
    isPresentationMode && `is-presentation-${presentationStyle}`,
    className,
  ].filter(Boolean).join(' ');

  const renderMedia = () => {
    if (!isReady) return null;

    if (preview.kind === 'pdf' && preview.content) {
      return (
        <object className="preview-viewport-media preview-viewport-pdf" data={preview.content} type="application/pdf" aria-label="PDF preview">
          <div className="preview-viewport-fallback">PDF preview is unavailable. Export the diagram to open it in Preview.</div>
        </object>
      );
    }

    if (preview.kind === 'svg' && documentForPreview) {
      return <iframe className="preview-viewport-media" sandbox="" title="Diagram preview" srcDoc={documentForPreview} />;
    }

    if (preview.kind === 'html' && documentForPreview) {
      return <iframe className="preview-viewport-media" sandbox="" title={`${source.label} preview`} srcDoc={documentForPreview} />;
    }

    return (
      <div className="preview-viewport-placeholder preview-viewport-no-output" role="status">
        <span className="preview-viewport-empty-mark">{source.short}</span>
        <strong>Nothing to show yet</strong>
        <p>{preview.message || 'The renderer completed without output. Try building the current source again.'}</p>
      </div>
    );
  };

  return (
    <section className={viewportClassName} aria-label={`${title} preview`}>
      <header className="preview-viewport-heading">
        <div>
          <p className="preview-viewport-eyebrow">{eyebrow}</p>
          <h2>{onOpenViewer ? <button className="preview-viewport-title-button" type="button" onClick={onOpenViewer} title={`Open ${title} in a separate viewer`}>{title}</button> : title}</h2>
        </div>
        <div className="preview-viewport-heading-actions">
          <span className={`preview-viewport-status ${preview.status}`} aria-live="polite">
            <span aria-hidden="true"></span>{STATUS_LABELS[preview.status]}
          </span>
          {onOpenViewer && <button className="preview-viewport-icon-button" type="button" onClick={onOpenViewer} aria-label={`Open ${title} in a separate viewer`} title="Open separate output viewer">⤢</button>}
          {onClose && <button className="preview-viewport-icon-button" type="button" onClick={onClose} aria-label={closeLabel} title={closeLabel}>×</button>}
        </div>
      </header>

      <div className="preview-viewport-controls" role="toolbar" aria-label="Preview controls">
        <div className="preview-viewport-control-group" aria-label="Canvas background">
          <span className="preview-viewport-control-label">Canvas</span>
          {(['grid', 'checkerboard', 'solid'] as const).map((option) => (
            <button
              key={option}
              className="preview-viewport-control"
              type="button"
              aria-pressed={background === option}
              onClick={() => setBackground(option)}
              title={`${option[0].toUpperCase()}${option.slice(1)} background`}
            >
              {option === 'grid' ? 'Grid' : option === 'checkerboard' ? 'Check' : 'Solid'}
            </button>
          ))}
        </div>
        <div className="preview-viewport-control-group preview-viewport-zoom-controls" aria-label="Zoom controls">
          <button className="preview-viewport-icon-button" type="button" onClick={() => changeZoom(-25)} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out" title="Zoom out (⌘−)">−</button>
          <output className="preview-viewport-zoom-readout" aria-label={`Zoom ${zoom}%`}>{zoom}%</output>
          <button className="preview-viewport-icon-button" type="button" onClick={() => changeZoom(25)} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in" title="Zoom in (⌘+)">+</button>
          <button className="preview-viewport-control" type="button" onClick={resetView} title="Fit output to the canvas">Fit</button>
          <button className="preview-viewport-control" type="button" onClick={resetView} disabled={zoom === 100 && pan.x === 0 && pan.y === 0} title="Reset zoom and position">Reset</button>
        </div>
      </div>

      <div
        className="preview-viewport-stage"
        data-background={background}
        onWheel={handleWheel}
        onKeyDown={handleStageKeyDown}
        onDoubleClick={onOpenViewer}
        tabIndex={0}
        aria-label={`${source.label} output canvas. Use plus and minus to zoom, or 0 to fit.`}
      >
        {preview.status === 'rendering' && (
          <div className="preview-viewport-placeholder" role="status">
            <div className="preview-viewport-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
            <strong>Rendering {source.label}</strong>
            <p>Watching your source changes and rebuilding locally.</p>
          </div>
        )}

        {preview.status === 'idle' && (
          <div className="preview-viewport-placeholder">
            <span className="preview-viewport-empty-mark">{source.short}</span>
            <strong>Ready when you are</strong>
            <p>Edit the source, then render to generate output.</p>
          </div>
        )}

        {preview.status === 'error' && (
          <div className="preview-viewport-error" role="alert">
            <span className="preview-viewport-error-emblem" aria-hidden="true">!</span>
            <strong>Preview could not be built</strong>
            <p>Fix the source and the preview will retry automatically.</p>
            {preview.message && <pre>{preview.message}</pre>}
            {onJumpToError && <button className="preview-viewport-jump" type="button" onClick={() => onJumpToError(preview.message ?? '')}>Jump to issue</button>}
          </div>
        )}

        {isReady && (
          <div
            className={`preview-viewport-transform${isDragging ? ' is-dragging' : ''}`}
            style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom / 100})` }}
          >
            {renderMedia()}
          </div>
        )}

        {isPannable && (
          <div
            className={`preview-viewport-drag-layer${isDragging ? ' is-dragging' : ''}`}
            aria-hidden="true"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
          />
        )}
      </div>

      <footer className="preview-viewport-footer">
        <div className="preview-viewport-footer-actions">
          {onRender && <button type="button" onClick={onRender}>↻ Render now</button>}
          {onCopyOutput && outputForCopy && preview.kind && <button type="button" onClick={copyOutput}>⧉ Copy output</button>}
          {onCopyImage && outputForCopy && preview.kind === 'svg' && <button type="button" onClick={() => onCopyImage(outputForCopy, 'svg')}>▧ Copy PNG</button>}
          {onExport && <button type="button" onClick={onExport}>⇩ Export</button>}
          {onPrompt && <button type="button" onClick={onPrompt}>✦ Prompt</button>}
        </div>
        {onOpenViewer ? <button className="preview-viewport-present-button" type="button" onClick={onOpenViewer} title="Open the output in a separate viewer">Open viewer ↗</button> : <button
          className="preview-viewport-present-button"
          type="button"
          onClick={() => setPresentation(!isPresentationMode)}
          aria-pressed={isPresentationMode}
          title={isPresentationMode ? `Exit ${presentationLabel} (Esc)` : `Enter ${presentationLabel}`}
        >
          {isPresentationMode ? `Exit ${presentationLabel}` : presentationLabel}
        </button>}
      </footer>
    </section>
  );
}
