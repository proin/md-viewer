import { useEffect, useMemo, useRef } from 'react';
import type { MouseEvent, WheelEvent } from 'react';
import DOMPurify from 'dompurify';
import { renderMarkdown } from './markdown';
import type { MarkdownHeading } from './markdown';
import 'katex/dist/katex.min.css';
import './markdown.css';

interface MarkdownPreviewProps {
  content: string;
  filePath: string;
  onNavigate: (href: string) => void;
  onHeadings?: (headings: MarkdownHeading[]) => void;
}

let diagramSequence = 0;
const diagramCache = new Map<string, { svg: string; prefix: string }>();

function createButton(label: string, action: string, title?: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.action = action;
  button.setAttribute('aria-label', title ?? label);
  button.title = title ?? label;
  return button;
}

function setDiagramZoom(figure: HTMLElement, zoom: number) {
  const amount = Math.min(3, Math.max(0.5, zoom));
  figure.dataset.zoom = String(amount);
  const output = figure.querySelector<HTMLElement>('.diagram-output');
  if (output) output.style.zoom = String(amount);
  const reset = figure.querySelector<HTMLButtonElement>('[data-action="zoom-reset"]');
  if (reset) reset.textContent = `${Math.round(amount * 100)}%`;
}

export default function MarkdownPreview({ content, filePath, onNavigate, onHeadings }: MarkdownPreviewProps) {
  const articleRef = useRef<HTMLElement>(null);
  const rendered = useMemo(() => renderMarkdown(content, filePath), [content, filePath]);
  const onHeadingsRef = useRef(onHeadings);
  onHeadingsRef.current = onHeadings;

  useEffect(() => { onHeadingsRef.current?.(rendered.headings); }, [rendered.headings]);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    let cancelled = false;

    article.querySelectorAll<HTMLElement>('.code-header').forEach((header) => {
      if (!header.querySelector('button')) header.append(createButton('복사', 'copy-code', '코드 복사'));
    });

    const figures = [...article.querySelectorAll<HTMLElement>('.markdown-diagram')];
    if (figures.length) {
      void (async () => {
        try {
          const { default: mermaid } = await import('mermaid');
          if (cancelled) return;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            suppressErrorRendering: true,
            htmlLabels: false,
            secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'flowchart', 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'altFontFamily'],
            theme: 'base',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            flowchart: { htmlLabels: false, useMaxWidth: true },
            themeVariables: {
              primaryColor: '#f0f4e8', primaryTextColor: '#4a5839', primaryBorderColor: '#b4c396',
              lineColor: '#a0b08b', secondaryColor: '#f7f9f3', tertiaryColor: '#f3f7eb',
              fontSize: '14px',
            },
          });
          for (const figure of figures) {
            if (cancelled) break;
            const source = figure.querySelector('.mermaid-source')?.textContent ?? '';
            const output = figure.querySelector<HTMLElement>('.diagram-output');
            const header = figure.querySelector<HTMLElement>('.diagram-header');
            if (!output || !header) continue;
            try {
              const prefix = `md-diagram-${++diagramSequence}-${crypto.randomUUID()}`;
              let cached = diagramCache.get(source);
              if (!cached) {
                const result = await mermaid.render(prefix, source);
                // Keep styles needed by Mermaid, while stripping executable SVG/HTML.
                const svg = DOMPurify.sanitize(result.svg, {
                  USE_PROFILES: { svg: true, svgFilters: true },
                  FORBID_TAGS: ['script', 'foreignObject', 'iframe'],
                  FORBID_ATTR: ['onload', 'onclick'],
                });
                if (diagramCache.size >= 32) diagramCache.delete(diagramCache.keys().next().value!);
                cached = { svg, prefix };
                diagramCache.set(source, cached);
              }
              if (cancelled) break;
              output.innerHTML = cached.svg.replaceAll(cached.prefix, prefix);
              output.setAttribute('role', 'img');
              output.setAttribute('aria-label', 'Mermaid 다이어그램');
              figure.dataset.source = source;
              figure.dataset.zoom = '1';
              if (!header.querySelector('button')) {
                const controls = document.createElement('div');
                controls.className = 'diagram-controls';
                controls.append(
                  createButton('−', 'zoom-out', '다이어그램 축소'),
                  createButton('100%', 'zoom-reset', '다이어그램 원래 크기'),
                  createButton('+', 'zoom-in', '다이어그램 확대'),
                  createButton('복사', 'copy-diagram', '다이어그램 코드 복사'),
                );
                header.append(controls);
              }
            } catch {
              if (cancelled) break;
              const error = document.createElement('p');
              error.className = 'diagram-error';
              error.textContent = '다이어그램을 표시할 수 없습니다. 아래 코드를 확인하십시오.';
              output.prepend(error);
            }
          }
        } catch {
          // A failed dynamic import leaves the original diagram source readable.
        }
      })();
    }
    return () => { cancelled = true; };
  }, [rendered.html]);

  async function handleClick(event: MouseEvent<HTMLElement>) {
    const target = event.target as Element;
    const button = target.closest<HTMLButtonElement>('button[data-action]');
    if (button) {
      const action = button.dataset.action;
      const figure = button.closest<HTMLElement>('.markdown-diagram');
      if (figure && action?.startsWith('zoom-')) {
        const zoom = Number(figure.dataset.zoom ?? 1);
        setDiagramZoom(figure, action === 'zoom-reset' ? 1 : zoom + (action === 'zoom-in' ? 0.25 : -0.25));
        return;
      }
      const code = action === 'copy-diagram'
        ? figure?.dataset.source
        : button.closest('.markdown-code-block')?.querySelector('pre code')?.textContent;
      if (code != null) {
        try {
          if (window.desktop) await window.desktop.copyText(code);
          else await navigator.clipboard.writeText(code);
          button.textContent = '복사됨';
          window.setTimeout(() => { if (button.isConnected) button.textContent = '복사'; }, 1400);
        } catch { button.textContent = '복사 실패'; }
      }
      return;
    }
    const link = target.closest<HTMLAnchorElement>('a[href]');
    if (link) {
      event.preventDefault();
      const href = link.getAttribute('href');
      if (href) onNavigate(href);
    }
  }

  function handleWheel(event: WheelEvent<HTMLElement>) {
    if (!event.altKey) return;
    const figure = (event.target as Element).closest<HTMLElement>('.markdown-diagram');
    if (!figure) return;
    setDiagramZoom(figure, Number(figure.dataset.zoom ?? 1) + (event.deltaY < 0 ? 0.1 : -0.1));
  }

  return <article
    ref={articleRef}
    className="markdown-preview"
    data-testid="markdown-preview"
    aria-label="마크다운 미리보기"
    onClick={handleClick}
    onWheel={handleWheel}
    dangerouslySetInnerHTML={{ __html: rendered.html }}
  />;
}
