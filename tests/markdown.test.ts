// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown, resolveImageSource } from '../src/markdown';

function documentFor(source: string) {
  const result = renderMarkdown(source, '/Users/reader/notes/README.md');
  const document = new DOMParser().parseFromString(result.html, 'text/html');
  return { ...result, document };
}

describe('Markdown rendering', () => {
  it('renders CommonMark blocks, GFM tables, disabled task lists and highlighted code', () => {
    const { document } = documentFor('# 제목\n\n## 작업\n\n| 이름 | 상태 |\n| :--- | ---: |\n| 문서 | 완료 |\n\n- [x] 읽기\n- [ ] 편집\n\n~~이전 내용~~\n\n```typescript\nconst greeting: string = "안녕하세요";\n```');
    expect(document.querySelector('h1')?.textContent).toBe('제목');
    expect(document.querySelectorAll('table tbody tr')).toHaveLength(1);
    expect(document.querySelectorAll('th')[1].getAttribute('align')).toBe('right');
    const checks = document.querySelectorAll<HTMLInputElement>('input');
    expect(checks).toHaveLength(2);
    expect(checks[0].checked).toBe(true);
    expect([...checks].every((input) => input.disabled)).toBe(true);
    expect(document.querySelector('s')?.textContent).toBe('이전 내용');
    expect(document.querySelector('code .hljs-keyword')?.textContent).toBe('const');
  });

  it('keeps ordinary newlines distinct from explicit Markdown line breaks', () => {
    expect(documentFor('첫째\n둘째').document.querySelectorAll('br')).toHaveLength(0);
    expect(documentFor('첫째  \n둘째').document.querySelectorAll('br')).toHaveLength(1);
  });

  it('creates predictable Unicode anchors and avoids duplicate heading ids', () => {
    const { headings, document } = documentFor('# 소개\n\n## **파일** 열기\n\n## 파일 열기\n\n## 파일 열기-1\n\n### `save()` 사용');
    expect(headings).toEqual([
      { id: '파일-열기', text: '파일 열기', level: 2 },
      { id: '파일-열기-1', text: '파일 열기', level: 2 },
      { id: '파일-열기-1-1', text: '파일 열기-1', level: 2 },
      { id: 'save-사용', text: 'save() 사용', level: 3 },
    ]);
    expect(document.getElementById('파일-열기-1')?.tagName).toBe('H2');
  });

  it('renders inline and display math with accessible MathML and required layout styles', () => {
    const { document } = documentFor('에너지 $E=mc^2$\n\n$$\n\\frac{1}{n} \\sum_{i=1}^n x_i\n$$');
    expect(document.querySelectorAll('.katex')).toHaveLength(2);
    expect(document.querySelector('.katex-display')).not.toBeNull();
    expect(document.querySelector('math')).not.toBeNull();
    expect(document.querySelector('.katex [style]')).not.toBeNull();
    expect(document.querySelector('[data-math-render]')).toBeNull();
  });

  it('leaves Mermaid source available for asynchronous rendering and readable error fallback', () => {
    const { document } = documentFor('```mermaid\nflowchart LR\n  A[문서] --> B[미리보기]\n```');
    expect(document.querySelector('.markdown-diagram .mermaid-source')?.textContent).toContain('A[문서] --> B[미리보기]');
    expect(document.querySelector('.markdown-diagram')?.getAttribute('data-line')).toBe('1');
  });

  it('resolves Markdown and HTML relative images against the active document', () => {
    const { document } = documentFor('![개요](../assets/diagram.svg)\n\n<img src="./사진%20모음/a.png" alt="사진">');
    const images = document.querySelectorAll('img');
    expect(images[0].getAttribute('src')).toBe('md-asset://local/?path=%2FUsers%2Freader%2Fassets%2Fdiagram.svg');
    expect(images[1].getAttribute('src')).toBe('md-asset://local/?path=%2FUsers%2Freader%2Fnotes%2F%EC%82%AC%EC%A7%84%20%EB%AA%A8%EC%9D%8C%2Fa.png');
  });

  it('preserves safe HTML but removes executable content, form controls and injected page styles', () => {
    const { document, html } = documentFor('<details><summary>세부 내용</summary><p>설명</p></details>\n\n<script>alert(1)</script>\n\n<img src="x.png" onerror="alert(1)">\n\n<a href="javascript:alert(1)" onclick="alert(1)">위험</a>\n\n<iframe src="file:///etc/passwd"></iframe>\n\n<div class="katex" style="position:fixed;inset:0"><span style="background:url(https://example.com/track)">본문</span></div>\n\n<input type="text" autofocus>');
    expect(document.querySelector('details summary')?.textContent).toBe('세부 내용');
    expect(document.querySelector('script, iframe, input')).toBeNull();
    expect(document.querySelector('[onerror], [onclick], [style], [autofocus]')).toBeNull();
    expect(html).not.toContain('javascript:');
  });

  it('does not inject fenced HTML code and preserves unknown-language source', () => {
    const { document } = documentFor('```unknown-language\n<img src=x onerror=alert(1)>\n```');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('pre code')?.textContent).toBe('<img src=x onerror=alert(1)>\n');
  });

  it('prevents raw HTML from imitating application overlays or borrowing KaTeX layout privileges', () => {
    const { document } = documentFor('<div class="modal-backdrop loading-overlay application"><div class="katex" style="position:fixed;inset:0">위조 화면</div></div>\n\n$\\frac{1}{2}$');
    expect(document.querySelector('.modal-backdrop, .loading-overlay, .application')).toBeNull();
    expect(document.querySelector('[style*="position:fixed"]')).toBeNull();
    expect(document.querySelectorAll('.katex')).toHaveLength(1);
    expect(document.querySelector('.katex [style]')).not.toBeNull();
  });

  it('removes untrusted math commands that request links or HTML', () => {
    const { document } = documentFor('$\\href{javascript:alert(1)}{click}$\n\n$\\htmlStyle{position:fixed}{x}$');
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('[style*="position:fixed"]')).toBeNull();
  });
});

describe('image URLs', () => {
  it('normalizes parent directories and encoded filenames', () => {
    expect(resolveImageSource('../images/a%20b.png', '/docs/chapter/readme.md')).toBe('md-asset://local/?path=%2Fdocs%2Fimages%2Fa%20b.png');
  });
  it('permits HTTPS images and embedded raster images', () => {
    expect(resolveImageSource('https://example.com/photo.png', '/docs/a.md')).toBe('https://example.com/photo.png');
    expect(resolveImageSource('data:image/png;base64,aGVsbG8=', '/docs/a.md')).toBe('data:image/png;base64,aGVsbG8=');
  });
  it('blocks insecure, executable and arbitrary-protocol images', () => {
    for (const url of ['http://example.com/photo.png', 'javascript:alert(1)', 'file:///etc/passwd', '//example.com/image.png', 'data:text/html,<script>x</script>']) {
      expect(resolveImageSource(url, '/docs/a.md')).toBeNull();
    }
  });
});
