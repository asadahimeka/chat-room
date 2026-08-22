/**
 * Hand-written Markdown subset parser (safe AST).
 *
 * Pure functions — zero DOM access at parse time, unit-testable in Node/Bun.
 * Rendering builds DOM via createElement/textContent only (never innerHTML),
 * so user content stays XSS-safe.
 */

export interface MdNode {
  type: 'text' | 'bold' | 'italic' | 'code' | 'codeblock' | 'link' | 'quote' | 'image' | 'strike'
  text?: string
  url?: string
  children?: MdNode[]
}

/**
 * URL protocol whitelist for links/images.
 * Only http(s) and data:image (excluding SVG) are allowed; everything else
 * (javascript:, data:image/svg+xml, vbscript:, ...) is rejected.
 */
function isSafeUrl(url: string): boolean {
  if (url.startsWith('http://') || url.startsWith('https://')) return true
  if (url.startsWith('data:image/') && !url.startsWith('data:image/svg')) return true
  return false
}

/**
 * Finds the `](url)` tail of a `[text](url)` / `![alt](url)` construct
 * starting right after the opening `[`. Returns null when malformed.
 */
function findLinkEnd(
  src: string,
  start: number,
): { text: string; url: string; endIndex: number } | null {
  const close = src.indexOf('](', start)
  if (close === -1) return null
  const urlStart = close + 2
  const urlEnd = src.indexOf(')', urlStart)
  if (urlEnd === -1) return null
  return { text: src.slice(start, close), url: src.slice(urlStart, urlEnd), endIndex: urlEnd + 1 }
}

/**
 * Recursive inline parser: `**bold**`, `*italic*`, `` `code` ``, `[text](url)`,
 * `![alt](url)`, `~~strike~~`. Unmatched markers fall through as literal text.
 */
function parseInline(src: string): MdNode[] {
  const nodes: MdNode[] = []
  let i = 0
  let textStart = 0

  const flushText = (end: number): void => {
    if (end > textStart) nodes.push({ type: 'text', text: src.slice(textStart, end) })
  }

  while (i < src.length) {
    const ch = src[i]
    let matched = false

    if (ch === '!' && src[i + 1] === '[') {
      const end = findLinkEnd(src, i + 2)
      if (end && isSafeUrl(end.url)) {
        flushText(i)
        nodes.push({ type: 'image', text: end.text, url: end.url })
        i = end.endIndex
        textStart = i
        matched = true
      }
    } else if (ch === '[') {
      const end = findLinkEnd(src, i + 1)
      if (end && isSafeUrl(end.url)) {
        flushText(i)
        nodes.push({ type: 'link', text: end.text, url: end.url, children: parseInline(end.text) })
        i = end.endIndex
        textStart = i
        matched = true
      }
    } else if (ch === '*' && src[i + 1] === '*') {
      const close = src.indexOf('**', i + 2)
      if (close !== -1) {
        flushText(i)
        nodes.push({ type: 'bold', children: parseInline(src.slice(i + 2, close)) })
        i = close + 2
        textStart = i
        matched = true
      }
    } else if (ch === '*') {
      const close = src.indexOf('*', i + 1)
      if (close !== -1) {
        flushText(i)
        nodes.push({ type: 'italic', children: parseInline(src.slice(i + 1, close)) })
        i = close + 1
        textStart = i
        matched = true
      }
    } else if (ch === '`') {
      const close = src.indexOf('`', i + 1)
      if (close !== -1) {
        flushText(i)
        nodes.push({ type: 'code', text: src.slice(i + 1, close) })
        i = close + 1
        textStart = i
        matched = true
      }
    } else if (ch === '~' && src[i + 1] === '~') {
      const close = src.indexOf('~~', i + 2)
      if (close !== -1) {
        flushText(i)
        nodes.push({ type: 'strike', children: parseInline(src.slice(i + 2, close)) })
        i = close + 2
        textStart = i
        matched = true
      }
    }

    if (!matched) i++
  }

  flushText(src.length)
  return nodes
}

/**
 * Line-level + inline Markdown subset parser. Pure function — no DOM access.
 *
 * - Code blocks (``` ... ```) take priority and are never parsed inside.
 * - Consecutive `> ` lines become a quote node.
 * - Everything else is parsed inline.
 */
export function parseMarkdown(src: string): MdNode[] {
  const lines = src.split(/\r?\n/)
  const nodes: MdNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trimStart().startsWith('```')) {
      const fence = line.trimStart().match(/^```+/)?.[0] ?? '```'
      const content: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(fence)) {
        content.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      nodes.push({ type: 'codeblock', text: content.join('\n') })
      continue
    }

    if (line.startsWith('> ')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2))
        i++
      }
      nodes.push({ type: 'quote', children: parseInline(quoteLines.join('\n')) })
      continue
    }

    nodes.push(...parseInline(line))
    i++
  }

  return nodes
}

/**
 * Renders parsed nodes into `el` using createElement/textContent only.
 * Returns whether any link was rendered (for linkify coordination).
 */
export function renderMarkdown(
  el: HTMLElement,
  src: string,
  emojiMap?: Map<string, string>,
): { containsLink: boolean } {
  if (typeof document === 'undefined') {
    // No DOM available — fall back to plain text when the element allows it.
    if (el && 'textContent' in el) (el as { textContent: string }).textContent = src
    return { containsLink: false }
  }

  const nodes = parseMarkdown(src)
  let containsLink = false
  for (const node of nodes) {
    if (renderNode(el, node, emojiMap)) containsLink = true
  }
  return { containsLink }
}

function renderChildren(
  el: HTMLElement,
  children: MdNode[],
  emojiMap?: Map<string, string>,
): boolean {
  let containsLink = false
  for (const child of children) {
    if (renderNode(el, child, emojiMap)) containsLink = true
  }
  return containsLink
}

function renderNode(el: HTMLElement, node: MdNode, emojiMap?: Map<string, string>): boolean {
  switch (node.type) {
    case 'text':
      renderTextWithEmoji(el, node.text ?? '', emojiMap)
      return false
    case 'code': {
      const code = document.createElement('code')
      code.textContent = node.text ?? ''
      el.appendChild(code)
      return false
    }
    case 'codeblock': {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = node.text ?? ''
      pre.appendChild(code)
      el.appendChild(pre)
      return false
    }
    case 'bold': {
      const b = document.createElement('b')
      renderChildren(b, node.children ?? [], emojiMap)
      el.appendChild(b)
      return false
    }
    case 'italic': {
      const em = document.createElement('em')
      renderChildren(em, node.children ?? [], emojiMap)
      el.appendChild(em)
      return false
    }
    case 'strike': {
      const s = document.createElement('s')
      renderChildren(s, node.children ?? [], emojiMap)
      el.appendChild(s)
      return false
    }
    case 'quote': {
      const blockquote = document.createElement('blockquote')
      renderChildren(blockquote, node.children ?? [], emojiMap)
      el.appendChild(blockquote)
      return false
    }
    case 'link': {
      const a = document.createElement('a')
      a.href = node.url ?? ''
      a.target = '_blank'
      a.rel = 'nofollow noreferrer noopener'
      a.className = 'link'
      renderChildren(a, node.children ?? [], emojiMap)
      el.appendChild(a)
      return true
    }
    case 'image': {
      const img = document.createElement('img')
      img.src = node.url ?? ''
      img.alt = node.text ?? ''
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
      img.className = 'md-img'
      el.appendChild(img)
      return false
    }
  }
}

/**
 * Appends text to `el`, splitting `:keyword:` tokens that match `emojiMap`
 * into `<img class="emoji">` elements. Unmatched tokens stay literal text.
 */
function renderTextWithEmoji(el: HTMLElement, text: string, emojiMap?: Map<string, string>): void {
  if (!emojiMap || emojiMap.size === 0) {
    el.appendChild(document.createTextNode(text))
    return
  }
  const re = /:([^:\s]+):/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      el.appendChild(document.createTextNode(text.slice(lastIndex, match.index)))
    }
    const url = emojiMap.get(match[1])
    if (url && isSafeUrl(url)) {
      const img = document.createElement('img')
      img.className = 'emoji'
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
      img.src = url
      img.alt = match[0]
      el.appendChild(img)
    } else {
      el.appendChild(document.createTextNode(match[0]))
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    el.appendChild(document.createTextNode(text.slice(lastIndex)))
  }
}