import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdown-renderer.js';

describe('MarkdownRenderer', () => {
  describe('headers', () => {
    it('converts # to h1', () => {
      const result = renderMarkdown('# Main Title');
      expect(result).toContain('<h1>Main Title</h1>');
    });

    it('converts ## to h2', () => {
      const result = renderMarkdown('## Subtitle');
      expect(result).toContain('<h2>Subtitle</h2>');
    });

    it('converts ### to h3', () => {
      const result = renderMarkdown('### Small Header');
      expect(result).toContain('<h3>Small Header</h3>');
    });

    it('handles multiple headers', () => {
      const markdown = '# Title\n## Section 1\n### Subsection';
      const result = renderMarkdown(markdown);
      expect(result).toContain('<h1>Title</h1>');
      expect(result).toContain('<h2>Section 1</h2>');
      expect(result).toContain('<h3>Subsection</h3>');
    });
  });

  describe('emphasis', () => {
    it('converts **text** to <strong>', () => {
      const result = renderMarkdown('This is **bold** text');
      expect(result).toContain('<strong>bold</strong>');
    });

    it('converts __text__ to <strong>', () => {
      const result = renderMarkdown('This is __bold__ text');
      expect(result).toContain('<strong>bold</strong>');
    });

    it('converts *text* to <em>', () => {
      const result = renderMarkdown('This is *italic* text');
      expect(result).toContain('<em>italic</em>');
    });

    it('converts _text_ to <em>', () => {
      const result = renderMarkdown('This is _italic_ text');
      expect(result).toContain('<em>italic</em>');
    });

    it('handles bold before italic', () => {
      const result = renderMarkdown('**bold** and *italic*');
      expect(result).toContain('<strong>bold</strong>');
      expect(result).toContain('<em>italic</em>');
    });
  });

  describe('code', () => {
    it('converts `code` to <code>', () => {
      const result = renderMarkdown('Use `variable` in your code');
      expect(result).toContain('<code>variable</code>');
    });

    it('converts code blocks to <pre><code>', () => {
      const result = renderMarkdown('```\nlet x = 5;\n```');
      expect(result).toContain('<pre><code>let x = 5;</code></pre>');
    });

    it('handles multiple code blocks', () => {
      const markdown = '```\ncode1\n```\ntext\n```\ncode2\n```';
      const result = renderMarkdown(markdown);
      expect(result).toContain('<pre><code>code1</code></pre>');
      expect(result).toContain('<pre><code>code2</code></pre>');
    });

    it('strips whitespace from code blocks', () => {
      const result = renderMarkdown('```\n  indented code  \n```');
      expect(result).toContain('<pre><code>indented code</code></pre>');
    });
  });

  describe('links', () => {
    it('converts [text](url) to <a>', () => {
      const result = renderMarkdown('Visit [Google](https://google.com)');
      expect(result).toContain('<a href="https://google.com">Google</a>');
    });

    it('handles multiple links', () => {
      const markdown = '[Link1](url1) and [Link2](url2)';
      const result = renderMarkdown(markdown);
      expect(result).toContain('<a href="url1">Link1</a>');
      expect(result).toContain('<a href="url2">Link2</a>');
    });

    it('preserves relative URLs', () => {
      const result = renderMarkdown('[File](./circuit.dig)');
      expect(result).toContain('<a href="./circuit.dig">File</a>');
    });
  });

  describe('lists', () => {
    it('converts - items to <ul><li>', () => {
      const markdown = '- Item 1\n- Item 2\n- Item 3';
      const result = renderMarkdown(markdown);
      expect(result).toContain('<ul>');
      expect(result).toContain('</ul>');
      expect(result).toContain('<li>Item 1</li>');
      expect(result).toContain('<li>Item 2</li>');
      expect(result).toContain('<li>Item 3</li>');
    });

    it('handles single list item', () => {
      const result = renderMarkdown('- Only item');
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>Only item</li>');
      expect(result).toContain('</ul>');
    });

    it('handles lists with content before and after', () => {
      const markdown = 'Before\n- Item 1\n- Item 2\nAfter';
      const result = renderMarkdown(markdown);
      expect(result).toContain('Before');
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>Item 1</li>');
      expect(result).toContain('</ul>');
      expect(result).toContain('After');
    });
  });

  describe('paragraphs', () => {
    it('wraps plain text in <p> tags', () => {
      const result = renderMarkdown('This is a paragraph');
      expect(result).toContain('<p>This is a paragraph</p>');
    });

    it('separates paragraphs by blank lines', () => {
      const markdown = 'Paragraph 1\n\nParagraph 2';
      const result = renderMarkdown(markdown);
      expect(result).toContain('<p>Paragraph 1</p>');
      expect(result).toContain('<p>Paragraph 2</p>');
    });

    it('does not wrap headers in <p>', () => {
      const result = renderMarkdown('# Title');
      expect(result).not.toContain('<p><h1>');
      expect(result).toContain('<h1>Title</h1>');
    });

    it('does not wrap lists in <p>', () => {
      const markdown = '- Item';
      const result = renderMarkdown(markdown);
      expect(result).toContain('<ul>');
      expect(result).not.toContain('<p><ul>');
    });
  });

  describe('HTML escaping', () => {
    it('escapes ampersands', () => {
      const result = renderMarkdown('A & B');
      expect(result).toContain('&amp;');
      // After escaping, isolated & signs become part of &amp; entity
      // So we check that the unescaped pattern " & " doesn't exist
      expect(result).not.toContain(' & ');
    });

    it('escapes less-than signs', () => {
      const result = renderMarkdown('a < b');
      expect(result).toContain('&lt;');
    });

    it('escapes greater-than signs', () => {
      const result = renderMarkdown('a > b');
      expect(result).toContain('&gt;');
    });

    it('escapes in code', () => {
      const result = renderMarkdown('`a < b`');
      expect(result).toContain('&lt;');
      expect(result).toContain('<code>');
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      const result = renderMarkdown('');
      expect(result).toBe('');
    });

    it('handles whitespace-only string', () => {
      const result = renderMarkdown('   \n\n   ');
      expect(result).toBe('');
    });

    it('handles mixed formatting', () => {
      const markdown =
        '# Title\n\nThis is **bold** and *italic* with `code`.\n\n[Link](url)';
      const result = renderMarkdown(markdown);
      expect(result).toContain('<h1>Title</h1>');
      expect(result).toContain('<strong>bold</strong>');
      expect(result).toContain('<em>italic</em>');
      expect(result).toContain('<code>code</code>');
      expect(result).toContain('<a href="url">Link</a>');
    });

    it('preserves line breaks in paragraph text', () => {
      const markdown = 'Line 1\nLine 2';
      const result = renderMarkdown(markdown);
      expect(result).toContain('Line 1');
      expect(result).toContain('Line 2');
    });

    it('handles complex nested markdown', () => {
      const markdown =
        '## Section\n\nText with **bold [link](url)** inside.\n\n- List with *italic*\n- Another item';
      const result = renderMarkdown(markdown);
      expect(result).toContain('<h2>Section</h2>');
      expect(result).toContain('<strong>bold');
      expect(result).toContain('<ul>');
      expect(result).toContain('<em>italic</em>');
    });
  });

  describe('integration', () => {
    it('renders complete tutorial markdown', () => {
      const markdown = `# Logic Gates Tutorial

This tutorial covers the basics of digital logic.

## AND Gate

An **AND** gate produces a \`1\` only when all inputs are \`1\`.

See [Digital documentation](https://github.com/hneemann/Digital)

### Truth Table

\`\`\`
A B Y
0 0 0
0 1 0
1 0 0
1 1 1
\`\`\`

## Practice

- Build an AND gate
- Test with 4 inputs
- Observe the output`;

      const result = renderMarkdown(markdown);

      expect(result).toContain('<h1>Logic Gates Tutorial</h1>');
      expect(result).toContain('<h2>AND Gate</h2>');
      expect(result).toContain('<strong>AND</strong>');
      expect(result).toContain('<code>1</code>');
      expect(result).toContain('<a href="https://github.com/hneemann/Digital">');
      expect(result).toContain('<h3>Truth Table</h3>');
      expect(result).toContain('<pre><code>');
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>Build an AND gate</li>');
    });
  });
});
