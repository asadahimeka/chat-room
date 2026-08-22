/**
 * Safe URL linkification (Bun-native port of linkifyjs usage in room.ejs).
 *
 * Walks the text nodes of an element and wraps http/https/www URLs in
 * `<a target="_blank" rel="nofollow noreferrer noopener" class="link">`
 * anchors using the DOM API only — never innerHTML — so user content stays
 * XSS-safe. The rel matches the anchors renderMarkdown produces.
 */

const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/g

export function linkify(element: HTMLElement): void {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node = walker.nextNode()
  while (node) {
    nodes.push(node as Text)
    node = walker.nextNode()
  }

  for (const textNode of nodes) {
    const text = textNode.nodeValue ?? ''
    if (!URL_RE.test(text)) continue
    URL_RE.lastIndex = 0

    const fragment = document.createDocumentFragment()
    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = URL_RE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)))
      }
      const url = match[0]
      const href = url.startsWith('www.') ? `http://${url}` : url
      const a = document.createElement('a')
      a.href = href
      a.target = '_blank'
      a.rel = 'nofollow noreferrer noopener'
      a.className = 'link'
      a.textContent = url
      fragment.appendChild(a)
      lastIndex = match.index + url.length
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)))
    }
    textNode.parentNode?.replaceChild(fragment, textNode)
  }
}
