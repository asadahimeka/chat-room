import { describe, expect, it } from 'bun:test'
// Registers a minimal global `document` stub (Bun has no DOM; no npm deps allowed).
import './dom-stub'
import { parseMarkdown, renderMarkdown, type MdNode } from '../src/utils/markdown'

function types(nodes: MdNode[]): string[] {
  return nodes.map((n) => n.type)
}

describe('parseMarkdown — inline', () => {
  it('parses **bold** into a bold node', () => {
    const nodes = parseMarkdown('**bold**')
    expect(types(nodes)).toEqual(['bold'])
    expect(nodes[0].children).toEqual([{ type: 'text', text: 'bold' }])
  })

  it('parses ~~strike~~ into a strike node', () => {
    const nodes = parseMarkdown('~~strike~~')
    expect(types(nodes)).toEqual(['strike'])
    expect(nodes[0].children).toEqual([{ type: 'text', text: 'strike' }])
  })

  it('parses `code` into a code node', () => {
    const nodes = parseMarkdown('`code`')
    expect(types(nodes)).toEqual(['code'])
    expect(nodes[0].text).toBe('code')
  })

  it('parses *italic* into an italic node', () => {
    const nodes = parseMarkdown('*italic*')
    expect(types(nodes)).toEqual(['italic'])
    expect(nodes[0].children).toEqual([{ type: 'text', text: 'italic' }])
  })

  it('parses [ok](https://a.com) into a link node with url', () => {
    const nodes = parseMarkdown('[ok](https://a.com)')
    expect(types(nodes)).toEqual(['link'])
    expect(nodes[0].url).toBe('https://a.com')
    expect(nodes[0].text).toBe('ok')
  })

  it('parses ![alt](https://x/a.png) into an image node', () => {
    const nodes = parseMarkdown('![alt](https://x/a.png)')
    expect(types(nodes)).toEqual(['image'])
    expect(nodes[0].url).toBe('https://x/a.png')
    expect(nodes[0].text).toBe('alt')
  })

  it('parses ![alt](data:image/png;base64,xxx) into an image node', () => {
    const nodes = parseMarkdown('![alt](data:image/png;base64,xxx)')
    expect(types(nodes)).toEqual(['image'])
    expect(nodes[0].url).toBe('data:image/png;base64,xxx')
  })

  it('handles mixed nesting: **bold with *italic* inside**', () => {
    const nodes = parseMarkdown('**bold with *italic* inside**')
    expect(types(nodes)).toEqual(['bold'])
    const children = nodes[0].children ?? []
    expect(types(children)).toEqual(['text', 'italic', 'text'])
    expect(children[1].children).toEqual([{ type: 'text', text: 'italic' }])
  })

  it('keeps unmatched markers as literal text', () => {
    const nodes = parseMarkdown('**unclosed')
    expect(types(nodes)).toEqual(['text'])
    expect(nodes[0].text).toBe('**unclosed')
  })

  it('keeps plain text as a text node', () => {
    const nodes = parseMarkdown('hello world')
    expect(types(nodes)).toEqual(['text'])
    expect(nodes[0].text).toBe('hello world')
  })
})

describe('parseMarkdown — block level', () => {
  it('parses a fenced code block into a codeblock node', () => {
    const nodes = parseMarkdown('```\ncode\n```')
    expect(types(nodes)).toEqual(['codeblock'])
    expect(nodes[0].text).toBe('code')
  })

  it('does not parse markdown inside a code block', () => {
    const nodes = parseMarkdown('```\n**not bold**\n```')
    expect(types(nodes)).toEqual(['codeblock'])
    expect(nodes[0].text).toBe('**not bold**')
  })

  it('parses > quote into a quote node', () => {
    const nodes = parseMarkdown('> quote')
    expect(types(nodes)).toEqual(['quote'])
    expect(nodes[0].children).toEqual([{ type: 'text', text: 'quote' }])
  })

  it('groups consecutive quote lines into one quote node', () => {
    const nodes = parseMarkdown('> a\n> b')
    expect(types(nodes)).toEqual(['quote'])
    expect(nodes[0].children).toEqual([{ type: 'text', text: 'a\nb' }])
  })

  it('mixes block and inline nodes across lines', () => {
    const nodes = parseMarkdown('> q\nplain **b**')
    expect(types(nodes)).toEqual(['quote', 'text', 'bold'])
  })
})

describe('parseMarkdown — XSS / URL whitelist', () => {
  it('rejects javascript: link URLs as plain text', () => {
    const nodes = parseMarkdown('[t](javascript:alert(1))')
    expect(types(nodes)).toEqual(['text'])
    expect(nodes[0].text).toBe('[t](javascript:alert(1))')
  })

  it('rejects data:image/svg+xml image URLs as plain text', () => {
    const nodes = parseMarkdown('![x](data:image/svg+xml;base64,xxx)')
    expect(types(nodes)).toEqual(['text'])
    expect(nodes[0].text).toBe('![x](data:image/svg+xml;base64,xxx)')
  })

  it('rejects data:image/svg+xml link URLs as plain text', () => {
    const nodes = parseMarkdown('[x](data:image/svg+xml;base64,xxx)')
    expect(types(nodes)).toEqual(['text'])
  })

  it('rejects vbscript: link URLs as plain text', () => {
    const nodes = parseMarkdown('[x](vbscript:msgbox(1))')
    expect(types(nodes)).toEqual(['text'])
  })

  it('rejects malformed links as plain text', () => {
    const nodes = parseMarkdown('[x](https://a.com')
    expect(types(nodes)).toEqual(['text'])
  })
})

describe('renderMarkdown — DOM safety', () => {
  it('renders <b>hi</b> as literal text without creating a <b> element', () => {
    const el = document.createElement('div')
    renderMarkdown(el, '<b>hi</b>')
    expect(el.querySelector('b')).toBeNull()
    expect(el.textContent).toBe('<b>hi</b>')
  })

  it('renders a link with rel="nofollow noreferrer noopener" and target="_blank"', () => {
    const el = document.createElement('div')
    const { containsLink } = renderMarkdown(el, '[ok](https://a.com)')
    const a = el.querySelector('a')
    expect(a).not.toBeNull()
    expect(a!.rel).toBe('nofollow noreferrer noopener')
    expect(a!.target).toBe('_blank')
    expect(a!.className).toBe('link')
    expect(a!.href).toBe('https://a.com')
    expect(containsLink).toBe(true)
  })

  it('returns containsLink=false when no markdown link is present', () => {
    const el = document.createElement('div')
    const { containsLink } = renderMarkdown(el, 'plain text')
    expect(containsLink).toBe(false)
  })

  it('does not create an anchor for a javascript: URL', () => {
    const el = document.createElement('div')
    renderMarkdown(el, '[x](javascript:alert(1))')
    expect(el.querySelector('a')).toBeNull()
    expect(el.textContent).toBe('[x](javascript:alert(1))')
  })

  it('renders an image with lazy loading and no-referrer policy', () => {
    const el = document.createElement('div')
    renderMarkdown(el, '![alt](https://x/a.png)')
    const img = el.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.className).toBe('md-img')
    expect(img!.loading).toBe('lazy')
    expect(img!.referrerPolicy).toBe('no-referrer')
    expect(img!.src).toBe('https://x/a.png')
  })

  describe('renderMarkdown — referrer policy by upload host', () => {
    const UPLOAD_HOST = 'https://cdn.example.com'

    it('uses strict-origin-when-cross-origin for same-host upload images', () => {
      const el = document.createElement('div')
      renderMarkdown(el, '![alt](https://cdn.example.com/uploads/abc.avif)', undefined, UPLOAD_HOST)
      const img = el.querySelector('img')
      expect(img).not.toBeNull()
      expect(img!.referrerPolicy).toBe('strict-origin-when-cross-origin')
    })

    it('keeps no-referrer for external markdown images', () => {
      const el = document.createElement('div')
      renderMarkdown(el, '![alt](https://other.com/pic.png)', undefined, UPLOAD_HOST)
      const img = el.querySelector('img')
      expect(img).not.toBeNull()
      expect(img!.referrerPolicy).toBe('no-referrer')
    })

    it('keeps no-referrer for data: images', () => {
      const el = document.createElement('div')
      renderMarkdown(el, '![alt](data:image/png;base64,xxx)', undefined, UPLOAD_HOST)
      const img = el.querySelector('img')
      expect(img).not.toBeNull()
      expect(img!.referrerPolicy).toBe('no-referrer')
    })

    it('keeps no-referrer when no uploadHost is provided', () => {
      const el = document.createElement('div')
      renderMarkdown(el, '![alt](https://cdn.example.com/uploads/abc.avif)')
      const img = el.querySelector('img')
      expect(img).not.toBeNull()
      expect(img!.referrerPolicy).toBe('no-referrer')
    })

    it('matches on origin only (ignores path prefix in publicUrl)', () => {
      const el = document.createElement('div')
      renderMarkdown(el, '![alt](https://cdn.example.com/sub/path/x.webp)', undefined, UPLOAD_HOST)
      const img = el.querySelector('img')
      expect(img).not.toBeNull()
      expect(img!.referrerPolicy).toBe('strict-origin-when-cross-origin')
    })
  })

  it('renders matched :keyword: emoji as an img and keeps unmatched literal', () => {
    const el = document.createElement('div')
    const emojiMap = new Map([['wave', 'https://x/wave.png']])
    renderMarkdown(el, 'hi :wave: :nope:', emojiMap)
    const imgs = el.querySelectorAll('img.emoji')
    expect(imgs.length).toBe(1)
    expect((imgs[0] as HTMLImageElement).src).toBe('https://x/wave.png')
    expect(el.textContent).toContain('hi ')
    expect(el.textContent).toContain(':nope:')
  })

  it('renders bold as a <b> element with textContent', () => {
    const el = document.createElement('div')
    renderMarkdown(el, '**bold**')
    const b = el.querySelector('b')
    expect(b).not.toBeNull()
    expect(b!.textContent).toBe('bold')
  })
})