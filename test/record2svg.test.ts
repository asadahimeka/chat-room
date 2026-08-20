import { describe, expect, it } from 'bun:test'
import record2svg, { formatLt } from '../src/utils/record2svg.ts'

const baseMsg = {
  time: 1597248000,
  name: 'alice',
  uid: 'u-1',
  namecolor: '#ff0000',
  msg: 'hello',
  msgcolor: '#000000',
}

describe('record2svg / formatLt', () => {
  it('renders the locked moment `l LT` format with +8h offset', () => {
    expect(formatLt(1597248000)).toBe('8/13/2020 8:00 AM')
    expect(formatLt(1597251600)).toBe('8/13/2020 9:00 AM')
    expect(formatLt(1597255200)).toBe('8/13/2020 10:00 AM')
  })

  it('output starts with <?xml and contains <svg and <foreignObject', () => {
    const svg = record2svg({ roomId: '@demo', record: [baseMsg], width: 750, height: 360 })
    expect(svg.startsWith('<?xml')).toBe(true)
    expect(svg).toContain('<svg')
    expect(svg).toContain('<foreignObject')
  })

  it('renders the time inside <span class="time"> with the exact locked strings', () => {
    const svg = record2svg({
      roomId: '@demo',
      record: [
        { ...baseMsg, time: 1597248000 },
        { ...baseMsg, time: 1597251600 },
        { ...baseMsg, time: 1597255200 },
      ],
      width: 750,
      height: 360,
    })
    expect(svg).toContain('<span class="time">8/13/2020 8:00 AM</span>')
    expect(svg).toContain('<span class="time">8/13/2020 9:00 AM</span>')
    expect(svg).toContain('<span class="time">8/13/2020 10:00 AM</span>')
  })

  it('journey-ad.github room rewrites 变态 to 好人', () => {
    const svg = record2svg({
      roomId: 'journey-ad.github',
      record: [{ ...baseMsg, msg: '你是个变态吗' }],
      width: 750,
      height: 360,
    })
    expect(svg).toContain('你是个好人吗')
    expect(svg).not.toContain('变态')
  })

  it('other rooms leave 变态 untouched', () => {
    const svg = record2svg({
      roomId: '@demo',
      record: [{ ...baseMsg, msg: '你是个变态吗' }],
      width: 750,
      height: 360,
    })
    expect(svg).toContain('你是个变态吗')
  })

  it('light theme adds class `container light`; default has `container` only', () => {
    const light = record2svg({ roomId: '@demo', record: [baseMsg], width: 750, height: 360, theme: 'light' })
    expect(light).toContain('class="container light"')
    expect(light).not.toContain('class="container"')

    const dark = record2svg({ roomId: '@demo', record: [baseMsg], width: 750, height: 360 })
    expect(dark).toContain('class="container"')
    expect(dark).not.toContain('class="container light"')
  })

  it('escapes title quotes and html in the title pseudo-element', () => {
    const svg = record2svg({
      roomId: '@demo',
      record: [baseMsg],
      width: 750,
      height: 360,
      title: 'a "quoted" <title>',
    })
    expect(svg).toContain("content: 'a &amp;quot;quoted&amp;quot; &lt;title&gt;';")
  })

  it('escapes msg html via processUnsafeHtml (round-trips entities)', () => {
    const svg = record2svg({
      roomId: '@demo',
      record: [{ ...baseMsg, msg: '<b>&amp;</b>' }],
      width: 750,
      height: 360,
    })
    expect(svg).toContain('<span class="msg" style="color:#000000">&lt;b&gt;&amp;amp;&lt;/b&gt;</span>')
  })

  it('default title is `${roomId}\\n  @chat.getloli.com: ~`', () => {
    const svg = record2svg({ roomId: '@demo', record: [baseMsg], width: 750, height: 360 })
    expect(svg).toContain('@demo\n  @chat.getloli.com: ~')
  })
})
