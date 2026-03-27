/**
 * Simple markdown to HTML renderer
 * Handles basic markdown syntax for tutorial instructions
 */

/**
 * Convert markdown text to HTML
 * Supports:
 * - Headers: # H1, ## H2, ### H3
 * - Bold: **text** or __text__
 * - Italic: *text* or _text_
 * - Code: `inline code`
 * - Code blocks: ``` code ```
 * - Links: [text](url)
 * - Lists: - item (unordered)
 * - Paragraphs: blank lines separate
 */
export function renderMarkdown(markdown: string): string {
  if (!markdown || markdown.trim() === '') {
    return '';
  }

  let html = markdown
    // Escape HTML special chars
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks (must come before inline processing)
  html = html.replace(/```([^`]+?)```/g, (_match, code) => {
    const escaped = code.trim();
    return `<pre><code>${escaped}</code></pre>`;
  });

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold (must come before italic)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+?)`/g, '<code>$1</code>');

  // Links
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');

  // Unordered lists
  const lines = html.split('\n');
  let inList = false;
  const processedLines: string[] = [];

  for (const line of lines) {
    if (line.match(/^- /)) {
      if (!inList) {
        processedLines.push('<ul>');
        inList = true;
      }
      processedLines.push(`<li>${line.substring(2)}</li>`);
    } else {
      if (inList) {
        processedLines.push('</ul>');
        inList = false;
      }
      processedLines.push(line);
    }
  }

  if (inList) {
    processedLines.push('</ul>');
  }

  html = processedLines.join('\n');

  // Paragraphs
  html = html
    .split('\n\n')
    .map((para) => {
      const trimmed = para.trim();
      // Don't wrap if already wrapped in tags
      if (
        trimmed.match(/^<(h[1-3]|ul|ol|pre|li|code|a|strong|em)>/) ||
        trimmed === ''
      ) {
        return trimmed;
      }
      return `<p>${trimmed}</p>`;
    })
    .join('\n');

  return html;
}
