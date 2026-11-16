export function buildSemanticChatGptHeadingFallbackExpression(): string {
  // Read-only compatibility path for ChatGPT layouts with semantic turn headings
  // but without data-message-author-role. Never treat arbitrary page headings
  // outside the conversation region as assistant messages.
  return `(() => {
    const regions = Array.from(document.querySelectorAll('[role="region"][aria-label="Conversation"], section[aria-label="Conversation"]'));
    if (regions.length !== 1) return [];
    const headings = Array.from(regions[0].querySelectorAll('h4')).filter(
      (heading) => ['You said:', 'ChatGPT said:'].includes(String(heading.textContent || '').trim())
    );
    const messages = [];
    for (const heading of headings) {
      const role = String(heading.textContent || '').trim() === 'ChatGPT said:' ? 'assistant' : 'user';
      const block = heading.parentElement?.parentElement;
      if (!block) continue;
      const directTurnHeadings = Array.from(block.querySelectorAll('h4')).filter(
        (item) => ['You said:', 'ChatGPT said:'].includes(String(item.textContent || '').trim())
      );
      if (directTurnHeadings.length !== 1) continue;
      const readableText = (node) => {
        if (node.nodeType === 3) return String(node.textContent || '');
        if (node.nodeType !== 1) return '';
        if (node.matches('h4, button, [aria-hidden="true"], [role="toolbar"], input, textarea')) return '';
        const content = Array.from(node.childNodes).map(readableText).join('');
        return /^(P|DIV|ARTICLE|SECTION|LI|PRE|BR|UL|OL|TABLE|TR)$/.test(node.tagName) ? content + '\\n' : content;
      };
      const text = readableText(block).replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
      if (text.length > 0) messages.push({ role, text, index: messages.length });
    }
    return messages;
  })()`;
}


