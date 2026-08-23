/**
 * Minimal hand-written DOM stub for Bun's test environment.
 *
 * Bun 1.3.x ships no DOM and `bun test --dom` is unsupported; the plan forbids
 * adding npm dependencies (happy-dom/jsdom/linkedom). This stub implements just
 * enough of the DOM surface that `renderMarkdown` and the DOM-safety tests need:
 *
 *   - document.createElement(tag) / document.createTextNode(text)
 *   - element.appendChild(child)
 *   - element.textContent (getter concatenates descendant text; setter stores)
 *   - element.className / href / target / rel / src / alt / loading / referrerPolicy
 *   - element.querySelector(sel) / querySelectorAll(sel) with `tag` and
 *     `tag.class` selectors, searching descendants recursively
 *
 * It deliberately does NOT implement innerHTML — the whole point of the
 * renderMarkdown tests is verifying safe DOM building via createElement +
 * textContent only.
 */

interface StubNode {
  readonly nodeType: number
  readonly tagName?: string
  textContent: string
  children: StubNode[]
  appendChild(child: StubNode): void
  querySelector(sel: string): StubNode | null
  querySelectorAll(sel: string): StubNode[]
}

/** Text node: textContent is its own text; it can never have children. */
class StubTextNode implements StubNode {
  readonly nodeType = 3
  children: StubNode[] = []
  private _text: string

  constructor(text: string) {
    this._text = text
  }

  get textContent(): string {
    return this._text
  }

  set textContent(value: string) {
    this._text = value
  }

  appendChild(): void {
    throw new Error('Text nodes cannot have children')
  }

  querySelector(): StubNode | null {
    return null
  }

  querySelectorAll(): StubNode[] {
    return []
  }
}

/** Element node: holds children plus the attributes renderMarkdown sets. */
class StubElement implements StubNode {
  readonly nodeType = 1
  readonly tagName: string
  children: StubNode[] = []
  className = ''
  href = ''
  target = ''
  rel = ''
  src = ''
  alt = ''
  loading = ''
  referrerPolicy = ''
  /** Minimal style surface (background etc.) for avatar/monogram building. */
  style: Record<string, string> = {}
  /** Button/form element disabled state — needed for upload button tests. */
  disabled = false
  /** Hidden attribute — reflects HTML hidden="" (used by refreshUploadVisibility). */
  hidden = false
  /** Set when textContent is assigned; overrides child concatenation. */
  private _textContent: string | null = null
  private _classes = new Set<string>()

  get classList(): {
    add(c: string): void
    remove(c: string): void
    toggle(c: string): boolean
    contains(c: string): boolean
  } {
    return {
      add: (c) => void this._classes.add(c),
      remove: (c) => void this._classes.delete(c),
      toggle: (c) => (this._classes.has(c) ? (this._classes.delete(c), false) : (this._classes.add(c), true)),
      contains: (c) => this._classes.has(c),
    }
  }

  constructor(tag: string) {
    this.tagName = tag.toUpperCase()
  }

  appendChild(child: StubNode): void {
    this.children.push(child)
  }

  get textContent(): string {
    if (this._textContent !== null) return this._textContent
    return this.children.map((c) => c.textContent).join('')
  }

  set textContent(value: string) {
    this._textContent = value
    this.children = []
  }

  querySelector(sel: string): StubNode | null {
    return this.querySelectorAll(sel)[0] ?? null
  }

  querySelectorAll(sel: string): StubNode[] {
    const { tag, cls } = parseSelector(sel)
    const out: StubNode[] = []
    const walk = (node: StubNode): void => {
      for (const child of node.children) {
        if (matches(child, tag, cls)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
}

/** Splits `tag` or `tag.class` into an uppercase tag + optional class. */
function parseSelector(sel: string): { tag: string; cls: string | null } {
  const dot = sel.indexOf('.')
  if (dot === -1) return { tag: sel.toUpperCase(), cls: null }
  return { tag: sel.slice(0, dot).toUpperCase(), cls: sel.slice(dot + 1) }
}

function matches(node: StubNode, tag: string, cls: string | null): boolean {
  if (node.nodeType !== 1) return false
  const el = node as StubElement
  if (el.tagName !== tag) return false
  if (cls !== null && !el.className.split(/\s+/).includes(cls)) return false
  return true
}

// Register the stub as a global BEFORE any renderMarkdown test runs.
// renderMarkdown guards with `typeof document !== 'undefined'`, so the stub
// must be a real global — a local variable would not be visible to it.
//
// The extra surface (readyState/addEventListener/body) exists because Bun runs
// all test files in one shared process: `src/views/room.client.ts` executes
// browser-only module-level code when `document` is defined. `readyState =
// 'loading'` defers its `init()` (never fired), and `body` absorbs the
// `document.body.classList.add('self')` call, so importing that module in
// other test files stays harmless.
;(globalThis as Record<string, unknown>).document = {
  readyState: 'loading',
  createElement: (tag: string): StubElement => new StubElement(tag),
  createTextNode: (text: string): StubTextNode => new StubTextNode(text),
  addEventListener: (): void => {},
  body: new StubElement('body'),
}