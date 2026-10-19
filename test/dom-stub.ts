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
 *   - element.dataset (plain object), className/classList backed by one Set
 *   - element.insertBefore(child, ref) / appendChild (both track parents)
 *   - element.nextSibling / previousSibling / nextElementSibling /
 *     previousElementSibling (element-only for the *Element variants)
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
  /** Owning element — set by appendChild/insertBefore; powers sibling walks. */
  _parent: StubElement | null = null
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
  href = ''
  target = ''
  rel = ''
  src = ''
  alt = ''
  loading = ''
  referrerPolicy = ''
  /** Dataset surface (plain object; camelCase keys stored as-is — producer
   * and consumer are the same module code, so no DOM camelCase mapping). */
  dataset: Record<string, string> = {}
  /** Minimal style surface (background etc.) for avatar/monogram building. */
  style: Record<string, string> = {}
  /** Button/form element disabled state — needed for upload button tests. */
  disabled = false
  /** Hidden attribute — reflects HTML hidden="" (used by refreshUploadVisibility). */
  hidden = false
  /** Owning element — set by appendChild/insertBefore; powers sibling walks. */
  _parent: StubElement | null = null
  /** Set when textContent is assigned; overrides child concatenation. */
  private _textContent: string | null = null
  private _classes = new Set<string>()

  /** className and classList share the same backing Set, mirroring the real
   * DOM where `el.className = 'x'` and `el.classList.contains('x')` agree. */
  get className(): string {
    return Array.from(this._classes).join(' ')
  }

  set className(value: string) {
    this._classes = new Set(value.split(/\s+/).filter(Boolean))
  }

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
    if (child.nodeType === 1) (child as StubElement)._parent = this
    else (child as StubTextNode)._parent = this
    this.children.push(child)
  }

  /** DOM insertBefore: ref null / not-a-child → append (the DOM would throw
   * for a bad ref; tests only pass own children or null). */
  insertBefore(child: StubNode, ref: StubNode | null): StubNode {
    if (child.nodeType === 1) (child as StubElement)._parent = this
    else (child as StubTextNode)._parent = this
    const idx = ref === null || ref === undefined ? -1 : this.children.indexOf(ref)
    if (idx === -1) this.children.push(child)
    else this.children.splice(idx, 0, child)
    return child
  }

  get nextSibling(): StubNode | null {
    const sibs = this._parent?.children
    if (!sibs) return null
    const i = sibs.indexOf(this)
    return i >= 0 && i + 1 < sibs.length ? sibs[i + 1] : null
  }

  get previousSibling(): StubNode | null {
    const sibs = this._parent?.children
    if (!sibs) return null
    const i = sibs.indexOf(this)
    return i > 0 ? sibs[i - 1] : null
  }

  get nextElementSibling(): StubElement | null {
    const sibs = this._parent?.children
    if (!sibs) return null
    const i = sibs.indexOf(this)
    if (i < 0) return null
    for (let j = i + 1; j < sibs.length; j++) {
      if (sibs[j].nodeType === 1) return sibs[j] as StubElement
    }
    return null
  }

  get previousElementSibling(): StubElement | null {
    const sibs = this._parent?.children
    if (!sibs) return null
    const i = sibs.indexOf(this)
    if (i < 0) return null
    for (let j = i - 1; j >= 0; j--) {
      if (sibs[j].nodeType === 1) return sibs[j] as StubElement
    }
    return null
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