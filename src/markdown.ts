import MarkdownIt, { type Token } from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
// @ts-expect-error This small Markdown-it plugin does not ship TypeScript declarations.
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

export interface MarkdownHeading {
  id: string;
  text: string;
  level: number;
}

export interface RenderedMarkdown {
  html: string;
  headings: MarkdownHeading[];
}

const blockedTags = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'button', 'textarea', 'select'];
const blockedAttrs = ['srcdoc', 'srcset', 'formaction', 'autofocus', 'contenteditable'];
const previewClasses = new Set([
  'markdown-code-block', 'code-header', 'hljs', 'markdown-table-scroll',
  'task-list-item', 'contains-task-list', 'task-list-item-checkbox',
  'markdown-diagram', 'diagram-header', 'diagram-canvas', 'diagram-output', 'mermaid-source',
]);

/** Map local images to the app's read-only, permission-checked file protocol. */
export function resolveImageSource(source: string, filePath: string): string | null {
  const value = source.trim();
  if (/^https:\/\//i.test(value)) return value;
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/=\s]+$/i.test(value)) return value;
  if (/^md-asset:\/\/local\//i.test(value)) return value;
  if (!value || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return null;

  // Keep URL fragments (for example, an SVG view) separate from the disk path.
  const [rawPath, fragment] = value.split('#', 2);
  let imagePath: string;
  try {
    imagePath = decodeURIComponent(rawPath.split('?', 1)[0]);
  } catch {
    imagePath = rawPath.split('?', 1)[0];
  }
  if (imagePath.includes('\0')) return null;
  const documentPath = filePath.replaceAll('\\', '/');
  const directory = documentPath.slice(0, documentPath.lastIndexOf('/') + 1);
  const combined = imagePath.startsWith('/') ? imagePath : `${directory}${imagePath}`;
  const segments: string[] = [];
  for (const part of combined.split('/')) {
    if (part === '..') segments.pop();
    else if (part && part !== '.') segments.push(part);
  }
  const absolutePath = `/${segments.join('/')}`;
  return `md-asset://local/?path=${encodeURIComponent(absolutePath)}${fragment ? `#${fragment}` : ''}`;
}

function inlineText(tokens: Token[] | null): string {
  return (tokens ?? []).map((token) => {
    if (token.type === 'image') return inlineText(token.children) || token.content;
    if (token.type === 'text' || token.type === 'code_inline' || token.type.startsWith('math_inline')) return token.content;
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    return '';
  }).join('');
}

function slugify(text: string): string {
  return text.trim().toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-') || 'section';
}

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  breaks: false,
}).use(taskLists, { enabled: false, label: false }).use(texmath, {
  engine: katex,
  delimiters: 'dollars',
  katexOptions: { throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' },
});

for (const name of Object.keys(markdown.renderer.rules).filter((key) => key.startsWith('math_'))) {
  const render = markdown.renderer.rules[name]!;
  markdown.renderer.rules[name] = (tokens, index, options, env, self) => {
    const tag = name.startsWith('math_block') ? 'div' : 'span';
    return `<${tag} data-math-render="${env?.mathNonce ?? ''}">${render(tokens, index, options, env, self)}</${tag}>`;
  };
}

markdown.core.ruler.push('document_headings', (state) => {
  const headings: MarkdownHeading[] = [];
  const usedIds = new Set<string>();
  state.tokens.forEach((token, index) => {
    if (token.map && token.type !== 'inline') token.attrSet('data-line', String(token.map[0] + 1));
    if (token.type !== 'heading_open') return;
    const text = inlineText(state.tokens[index + 1]?.children ?? null);
    const base = slugify(text);
    let id = base;
    let suffix = 0;
    while (usedIds.has(id)) id = `${base}-${++suffix}`;
    usedIds.add(id);
    token.attrSet('id', id);
    const level = Number(token.tag.slice(1));
    if (level >= 2) headings.push({ id, text, level });
  });
  state.env.headings = headings;
});

markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/)[0].toLowerCase();
  const source = markdown.utils.escapeHtml(token.content);
  const line = token.map ? ` data-line="${token.map[0] + 1}"` : '';
  if (language === 'mermaid') {
    return `<figure class="markdown-diagram"${line}><div class="diagram-header"><span>Mermaid</span></div><div class="diagram-canvas"><div class="diagram-output"><pre class="mermaid-source"><code>${source}</code></pre></div></div></figure>\n`;
  }
  let code = source;
  if (language && hljs.getLanguage(language)) {
    try { code = hljs.highlight(token.content, { language, ignoreIllegals: true }).value; } catch { /* Preserve readable source when a grammar fails. */ }
  }
  const label = markdown.utils.escapeHtml(language || 'text');
  // Toolbar buttons are attached by the React component after sanitization.
  return `<div class="markdown-code-block"${line}><div class="code-header"><span>${label}</span></div><pre><code class="hljs language-${label}">${code}</code></pre></div>\n`;
};

const renderTableOpen = markdown.renderer.rules.table_open;
markdown.renderer.rules.table_open = (tokens, index, options, env, self) =>
  `<div class="markdown-table-scroll" tabindex="0" role="region" aria-label="표">${renderTableOpen ? renderTableOpen(tokens, index, options, env, self) : self.renderToken(tokens, index, options)}`;
markdown.renderer.rules.table_close = () => '</table></div>\n';

/** Render untrusted Markdown without executable HTML or uncontrolled local URLs. */
export function renderMarkdown(content: string, filePath: string): RenderedMarkdown {
  const mathNonce = crypto.randomUUID();
  const env: { headings?: MarkdownHeading[]; mathNonce: string } = { mathNonce };
  const html = markdown.render(content, env);
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true },
    ADD_TAGS: ['eq', 'eqn'],
    FORBID_TAGS: blockedTags,
    FORBID_ATTR: blockedAttrs,
    ALLOW_DATA_ATTR: true,
  });
  const container = document.createElement('template');
  container.innerHTML = clean;

  for (const element of container.content.querySelectorAll<HTMLElement>('[class]')) {
    if (element.closest(`[data-math-render="${mathNonce}"]`)) continue;
    // Document HTML shares the renderer DOM, so it must not reuse application UI classes.
    const classes = [...element.classList].filter((name) => previewClasses.has(name) || /^hljs-[\w-]+$/.test(name) || /^language-[\w+-]+$/.test(name));
    if (classes.length) element.className = classes.join(' ');
    else element.removeAttribute('class');
  }
  for (const element of container.content.querySelectorAll<HTMLElement>('[style]')) {
    // KaTeX owns its inline layout; document HTML cannot restyle the application.
    if (!element.closest(`[data-math-render="${mathNonce}"]`)) {
      if (element.matches('th, td') && ['left', 'center', 'right'].includes(element.style.textAlign)) {
        element.setAttribute('align', element.style.textAlign);
      }
      element.removeAttribute('style');
    }
  }
  for (const element of container.content.querySelectorAll('[data-math-render]')) element.removeAttribute('data-math-render');
  for (const image of container.content.querySelectorAll<HTMLImageElement>('img')) {
    const source = resolveImageSource(image.getAttribute('src') ?? '', filePath);
    if (source) image.setAttribute('src', source);
    else image.removeAttribute('src');
    image.setAttribute('loading', 'lazy');
    image.setAttribute('decoding', 'async');
    image.setAttribute('referrerpolicy', 'no-referrer');
  }
  for (const input of container.content.querySelectorAll<HTMLInputElement>('input')) {
    if (input.type !== 'checkbox') input.remove();
    else {
      input.disabled = true;
      input.setAttribute('aria-label', input.checked ? '완료한 항목' : '완료하지 않은 항목');
    }
  }
  for (const anchor of container.content.querySelectorAll<HTMLAnchorElement>('a')) {
    anchor.removeAttribute('target');
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
  return { html: container.innerHTML, headings: env.headings ?? [] };
}
