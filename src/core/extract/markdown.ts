import TurndownService from 'turndown';
// @ts-expect-error -- turndown-plugin-gfm ships no type declarations
import { gfm } from 'turndown-plugin-gfm';

/**
 * HTML -> Markdown. Turndown v7 bundles its own DOM parser, so this works in
 * plain Node with no jsdom dependency.
 */
function buildService(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    preformattedCode: true,
  });

  td.use(gfm);

  // Drop anything that is never content.
  td.remove(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed']);

  // Fenced code blocks keep their language hint.
  td.addRule('fencedCodeWithLang', {
    filter: (node) =>
      node.nodeName === 'PRE' &&
      node.firstChild != null &&
      (node.firstChild as HTMLElement).nodeName === 'CODE',
    replacement: (_content, node) => {
      const code = (node as HTMLElement).firstChild as HTMLElement;
      const className = code.getAttribute?.('class') ?? '';
      const lang =
        /language-([\w+#-]+)/.exec(className)?.[1] ??
        /lang-([\w+#-]+)/.exec(className)?.[1] ??
        '';
      const text = code.textContent ?? '';
      return '\n\n```' + lang + '\n' + text.replace(/\n$/, '') + '\n```\n\n';
    },
  });

  // Inline data: images would otherwise blow up the token count.
  td.addRule('stripDataImages', {
    filter: (node) =>
      node.nodeName === 'IMG' &&
      (node as HTMLElement).getAttribute('src')?.startsWith('data:') === true,
    replacement: () => '',
  });

  // Keep line breaks meaningful inside paragraphs.
  td.addRule('lineBreak', {
    filter: 'br',
    replacement: () => '  \n',
  });

  return td;
}

const service = buildService();

export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return '';
  const md = service.turndown(html);
  return tidy(md);
}

/** Collapses the whitespace noise that HTML conversion always leaves behind. */
export function tidy(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^(\s*\n)+/, '')
    .trimEnd();
}

/** Plain-text view: markdown with the syntax stripped out. */
export function markdownToText(markdown: string): string {
  return tidy(
    markdown
      .replace(/^```[\s\S]*?```$/gm, (block) => block.replace(/```[\w+#-]*\n?/g, ''))
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^[-*_]{3,}$/gm, ''),
  );
}
