import { describe, test, expect } from 'bun:test'
import { packsFromManifest } from '../src/utils/emoji'

describe('emoji manifest shape', () => {
  test('packsFromManifest restores urlOf (waline + valine)', () => {
    const packs = packsFromManifest({
      v: 1,
      ts: Date.now(),
      packs: [
        {
          name: 'weibo',
          base: 'https://npm.elemecdn.com/@waline/emojis@1.2.0/weibo/',
          icon: '',
          prefix: '',
          type: 'png',
          keywords: ['smile'],
        },
        {
          name: 'GBC',
          base: 'https://hibiapi.cocomi.eu.org/stickers/GBC/',
          icon: '',
          prefix: '',
          type: '',
          keywords: ['a.gif'],
        },
      ],
    })
    expect(packs).toHaveLength(2)
    expect(packs[0]!.urlOf('smile')).toBe(
      'https://npm.elemecdn.com/@waline/emojis@1.2.0/weibo/smile.png',
    )
    expect(packs[1]!.urlOf('a.gif')).toBe('https://hibiapi.cocomi.eu.org/stickers/GBC/a.gif')
  })

  test('pickLatestHashed resolves emoji manifest', async () => {
    const { pickLatestHashed } = await import('../src/views/room')
    const got = pickLatestHashed('./static', /^emoji-manifest-[0-9a-f]{8}\.json$/)
    expect(got === null || /^emoji-manifest-[0-9a-f]{8}\.json$/.test(got)).toBe(true)
  })
})
