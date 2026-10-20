import { describe, expect, it } from 'bun:test'
// Registers the global DOM stub BEFORE importing room.client (its module-level
// code runs when `document` exists; readyState 'loading' defers init()).
import './dom-stub'
import {
  dayKeyOf,
  formatDayLabel,
  formatTime,
  insertMessageNode,
} from '../src/views/room.client'

// ── Stub augmentation: Element.remove() ────────────────────────────────
// The day-chip invariant needs chip removal ("swallowing"). The standard
// source-side primitive is el.remove(); this round's write-scope excludes
// test/dom-stub.ts, so the shared stub is taught the primitive here —
// purely additive (only-if-missing), no other test calls .remove().
{
  const proto = Object.getPrototypeOf(document.createElement('div')) as {
    remove?: () => void
  }
  if (typeof proto.remove !== 'function') {
    proto.remove = function (this: { _parent: { children: unknown[] } | null }): void {
      const parent = this._parent
      if (!parent) return
      const i = parent.children.indexOf(this)
      if (i >= 0) parent.children.splice(i, 1)
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────
// Local-time timestamps keep day-key expectations timezone-independent.

/** Unix-seconds timestamp for a local date/time. */
function ts(y: number, mo: number, d: number, h = 12, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi).getTime() / 1000
}

const DAY0 = '2026-10-17'
const DAY1 = '2026-10-18'
const DAY2 = '2026-10-19'
const DAY3 = '2026-10-20'

function makeList(): { msgList: HTMLDivElement; tip: HTMLDivElement } {
  const msgList = document.createElement('div')
  const tip = document.createElement('div')
  tip.id = 'history-tip'
  msgList.appendChild(tip)
  return { msgList, tip }
}

/** Mirrors appendMsg's message-node construction (class + dataset hooks). */
function makeMessage(uid: string, dayKey?: string): HTMLDivElement {
  const node = document.createElement('div')
  node.className = 'message'
  node.dataset.uid = uid
  if (dayKey) node.dataset.dayKey = dayKey
  return node
}

function makeSys(): HTMLDivElement {
  const node = document.createElement('div')
  node.className = 'sys-msg'
  node.textContent = 'someone joined'
  return node
}

function insertBefore(msgList: HTMLDivElement, tip: HTMLDivElement, node: HTMLDivElement): void {
  insertMessageNode(msgList, tip, node, 'before')
}

function insertAfter(msgList: HTMLDivElement, tip: HTMLDivElement, node: HTMLDivElement): void {
  insertMessageNode(msgList, tip, node, 'after')
}

function children(msgList: HTMLDivElement): HTMLDivElement[] {
  return Array.from(msgList.children) as HTMLDivElement[]
}

/** All .day-sep children of the list (bare class selectors are not part of
 * the stub's querySelector surface, so filter the children directly). */
function daySeps(msgList: HTMLDivElement): HTMLDivElement[] {
  return children(msgList).filter((c) => c.classList.contains('day-sep'))
}

/** Asserts the day-chip invariant: every maximal same-day block of keyed
 * messages has EXACTLY ONE chip directly above its first message, labeled
 * with that block's dayKey; no stray chips exist. (Pigeonhole: chip count
 * == block count, each block consumes a distinct chip above it.) */
function expectDayChipInvariant(msgList: HTMLDivElement): void {
  const kids = children(msgList)
  const keyed = kids.filter((c) => c.classList.contains('message') && c.dataset.dayKey)
  const groups: HTMLDivElement[][] = []
  for (const m of keyed) {
    const g = groups[groups.length - 1]
    if (g && g[0].dataset.dayKey === m.dataset.dayKey) g.push(m)
    else groups.push([m])
  }
  const chips = daySeps(msgList)
  expect(chips.length).toBe(groups.length)
  for (const g of groups) {
    const idx = kids.indexOf(g[0])
    const above = idx > 0 ? kids[idx - 1] : undefined
    expect(above?.classList.contains('day-sep')).toBe(true)
    expect(above?.textContent).toBe(formatDayLabel(g[0].dataset.dayKey as string))
  }
}

// ── Upward pagination (position: 'before') ─────────────────────────────
describe('insertMessageNode before (upward pagination)', () => {
  it('keeps #history-tip as the first child across consecutive prepends', () => {
    const { msgList, tip } = makeList()
    const existing = makeMessage('u1', DAY2) // initial-load top
    insertAfter(msgList, tip, existing)

    const p1 = makeMessage('u1', DAY2)
    const p2 = makeMessage('u2', DAY2)
    const p3 = makeMessage('u1', DAY1)
    for (const node of [p1, p2, p3]) {
      insertBefore(msgList, tip, node)
      expect(msgList.children[0]).toBe(tip) // Bug A: tip must stay first
    }
    // Two day blocks (DAY1 page top, DAY2 rest) → exactly two chips: a top
    // chip above the newest-oldest block and a boundary chip above DAY2.
    const seps = daySeps(msgList)
    expect(seps.length).toBe(2)
    expect(msgList.children[1]).toBe(seps[0])
    expect(msgList.children[2]).toBe(p3)
    expect(msgList.children[3]).toBe(seps[1])
    expect(msgList.children[4]).toBe(p2)
    expect(msgList.children[5]).toBe(p1)
    expect(msgList.children[6]).toBe(existing)
    expectDayChipInvariant(msgList)
  })

  it('threads the BELOW sibling on same uid + same day (cross-page merge)', () => {
    const { msgList, tip } = makeList()
    const oldTop = makeMessage('u1', DAY2)
    insertAfter(msgList, tip, oldTop)

    const node = makeMessage('u1', DAY2)
    insertBefore(msgList, tip, node)

    // Bug B: the SIBLING below gets .threaded, never the freshly prepended node.
    expect(oldTop.classList.contains('threaded')).toBe(true)
    expect(node.classList.contains('threaded')).toBe(false)
    expect(msgList.children[0]).toBe(tip)
    expect(msgList.children[1].classList.contains('day-sep')).toBe(true)
    expect(msgList.children[2]).toBe(node)
    expect(msgList.children[3]).toBe(oldTop)
  })

  it('does not thread when uids differ', () => {
    const { msgList, tip } = makeList()
    const oldTop = makeMessage('u2', DAY2)
    insertAfter(msgList, tip, oldTop)

    const node = makeMessage('u1', DAY2)
    insertBefore(msgList, tip, node)

    expect(node.classList.contains('threaded')).toBe(false)
    expect(oldTop.classList.contains('threaded')).toBe(false)
  })

  it('swallows the old top chip on same-day pagination (count stays 1)', () => {
    const { msgList, tip } = makeList()
    const a1 = makeMessage('u1', DAY2)
    const a2 = makeMessage('u1', DAY2)
    insertAfter(msgList, tip, a1)
    insertAfter(msgList, tip, a2)
    const oldChip = daySeps(msgList)[0]
    expect(oldChip).toBeDefined() // the DAY2 block starts with a top chip

    const node = makeMessage('u2', DAY2) // same day, older page item
    insertBefore(msgList, tip, node)

    // The block grew upward: old chip swallowed, exactly one chip remains,
    // sitting directly above the new top message.
    const seps = daySeps(msgList)
    expect(seps.length).toBe(1)
    expect(children(msgList).includes(oldChip as HTMLDivElement)).toBe(false)
    expect(msgList.children[1]).toBe(seps[0])
    expect(msgList.children[2]).toBe(node)
    expect(seps[0].textContent).toBe(formatDayLabel(DAY2))
    expectDayChipInvariant(msgList)
  })

  it('keeps top chip + boundary chip on cross-day pagination, labels correct', () => {
    const { msgList, tip } = makeList()
    const oldTop = makeMessage('u1', DAY2) // newer, below
    insertAfter(msgList, tip, oldTop)

    const node = makeMessage('u1', DAY1) // older, above
    insertBefore(msgList, tip, node)

    const seps = daySeps(msgList)
    expect(seps.length).toBe(2)
    // Top chip above node labeled with node's (older) day…
    expect(msgList.children[1]).toBe(seps[0])
    expect(msgList.children[2]).toBe(node)
    expect(seps[0].textContent).toBe(formatDayLabel(DAY1))
    // …boundary chip between the days labeled with the day below it.
    expect(msgList.children[3]).toBe(seps[1])
    expect(msgList.children[4]).toBe(oldTop)
    expect(seps[1].textContent).toBe(formatDayLabel(DAY2))
    expect(seps[1].classList.contains('sys-msg')).toBe(true)
    // Same uid but cross-day: no threading, only the two chips.
    expect(node.classList.contains('threaded')).toBe(false)
    expect(oldTop.classList.contains('threaded')).toBe(false)
    expectDayChipInvariant(msgList)
  })

  it('skips non-message elements (sys pills) when finding the adjacent message', () => {
    const { msgList, tip } = makeList()
    insertAfter(msgList, tip, makeMessage('u1', DAY2))
    insertAfter(msgList, tip, makeSys()) // live sys pill lands between

    const node = makeMessage('u1', DAY2)
    insertAfter(msgList, tip, node)

    // [tip, chip, first, sys, node] — the upward walk must skip pill+chip.
    expect(msgList.children[1].classList.contains('day-sep')).toBe(true)
    expect(msgList.children[2].classList.contains('message')).toBe(true)
    expect(msgList.children[3].classList.contains('sys-msg')).toBe(true)
    expect(!msgList.children[3].classList.contains('day-sep')).toBe(true)
    expect(msgList.children[4]).toBe(node)
    expect(node.classList.contains('threaded')).toBe(true)
    expectDayChipInvariant(msgList)
  })
})

// ── Live append (position: 'after') ────────────────────────────────────
describe('insertMessageNode after (live append)', () => {
  it('threads node when the message above is same uid + same day', () => {
    const { msgList, tip } = makeList()
    const first = makeMessage('u1', DAY2)
    insertAfter(msgList, tip, first)

    const node = makeMessage('u1', DAY2)
    insertAfter(msgList, tip, node)

    expect(node.classList.contains('threaded')).toBe(true) // regression: old behavior
    expect(first.classList.contains('threaded')).toBe(false)
    expect(msgList.children[1].classList.contains('day-sep')).toBe(true)
    expect(msgList.children[2]).toBe(first)
    expect(msgList.children[3]).toBe(node)
  })

  it('does not thread same uid across days', () => {
    const { msgList, tip } = makeList()
    insertAfter(msgList, tip, makeMessage('u1', DAY1))
    const node = makeMessage('u1', DAY2)
    insertAfter(msgList, tip, node)
    expect(node.classList.contains('threaded')).toBe(false)
  })

  it('inserts a boundary chip before node when the day changes (2 chips total)', () => {
    const { msgList, tip } = makeList()
    insertAfter(msgList, tip, makeMessage('u1', DAY1))

    const node = makeMessage('u2', DAY2)
    insertAfter(msgList, tip, node)

    const seps = daySeps(msgList)
    expect(seps.length).toBe(2)
    expect(seps[0].textContent).toBe(formatDayLabel(DAY1)) // top of DAY1 block
    expect(seps[1].textContent).toBe(formatDayLabel(DAY2)) // top of DAY2 block
    expect(msgList.children[3]).toBe(seps[1])
    expect(msgList.children[4]).toBe(node)
    expectDayChipInvariant(msgList)
  })

  it('keeps exactly one chip for a same-day block across 3 appends', () => {
    const { msgList, tip } = makeList()
    insertAfter(msgList, tip, makeMessage('u1', DAY2))
    insertAfter(msgList, tip, makeMessage('u2', DAY2))
    insertAfter(msgList, tip, makeMessage('u1', DAY2))
    const seps = daySeps(msgList)
    expect(seps.length).toBe(1)
    expect(seps[0].textContent).toBe(formatDayLabel(DAY2))
    expectDayChipInvariant(msgList)
  })

  it('chips the first message of the list and skips the history tip', () => {
    const { msgList, tip } = makeList()
    const node = makeMessage('u1', DAY2)
    insertAfter(msgList, tip, node) // above-adjacent walk must skip the tip
    expect(node.classList.contains('threaded')).toBe(false)
    expect(msgList.children[0]).toBe(tip)
    // First message in the list: its block gets a top chip above it.
    expect(msgList.children[1].classList.contains('day-sep')).toBe(true)
    expect(msgList.children[2]).toBe(node)
    expect(daySeps(msgList)[0].textContent).toBe(formatDayLabel(DAY2))
  })

  it('never chips a first message without a dayKey', () => {
    const { msgList, tip } = makeList()
    insertAfter(msgList, tip, makeMessage('u1')) // no dayKey
    expect(daySeps(msgList).length).toBe(0)
  })
})

// ── Multi-day full-history simulation ──────────────────────────────────
describe('insertMessageNode multi-day invariant (full simulation)', () => {
  it('initial load across 3 days → one chip per day block (3 chips)', () => {
    const { msgList, tip } = makeList()
    // Oldest→newest, mixed uids, three maximal blocks.
    insertAfter(msgList, tip, makeMessage('u1', DAY1))
    insertAfter(msgList, tip, makeMessage('u2', DAY1))
    insertAfter(msgList, tip, makeMessage('u1', DAY2))
    insertAfter(msgList, tip, makeMessage('u2', DAY2))
    insertAfter(msgList, tip, makeMessage('u1', DAY3))

    expect(daySeps(msgList).length).toBe(3)
    expect(daySeps(msgList).map((c) => c.textContent)).toEqual([
      formatDayLabel(DAY1),
      formatDayLabel(DAY2),
      formatDayLabel(DAY3),
    ])
    expectDayChipInvariant(msgList)
  })

  it('pagination over that history keeps chips == blocks after every insert', () => {
    const { msgList, tip } = makeList()
    for (const [uid, day] of [
      ['u1', DAY1],
      ['u2', DAY1],
      ['u1', DAY2],
      ['u2', DAY2],
      ['u1', DAY3],
    ] as const) {
      insertAfter(msgList, tip, makeMessage(uid, day))
    }
    expect(daySeps(msgList).length).toBe(3)

    // Older page arrives DESC (newest first), same-day head then cross-day.
    const page = [
      ['u1', DAY1], // extends the DAY1 block upward (swallows its top chip)
      ['u2', DAY0], // older day → new oldest block + boundary chip
    ] as const
    for (const [uid, day] of page) {
      insertBefore(msgList, tip, makeMessage(uid, day))
      expect(msgList.children[0]).toBe(tip)
      expectDayChipInvariant(msgList) // invariant holds after EVERY insert
    }

    // 4 blocks → 4 chips, oldest-first labels.
    expect(daySeps(msgList).map((c) => c.textContent)).toEqual([
      formatDayLabel(DAY0),
      formatDayLabel(DAY1),
      formatDayLabel(DAY2),
      formatDayLabel(DAY3),
    ])
  })
})

// ── Pure helpers ───────────────────────────────────────────────────────
describe('dayKeyOf', () => {
  it('derives a local-timezone YYYY-MM-DD key', () => {
    expect(dayKeyOf(ts(2026, 10, 19))).toBe('2026-10-19')
  })

  it('zero-pads month and day', () => {
    expect(dayKeyOf(ts(2026, 1, 3))).toBe('2026-01-03')
  })
})

describe('formatDayLabel', () => {
  it('renders 年月日 without zero padding on month/day', () => {
    expect(formatDayLabel('2026-10-19')).toBe('2026年10月19日')
    expect(formatDayLabel('2026-01-03')).toBe('2026年1月3日')
  })
})

describe('formatTime (24h HH:mm)', () => {
  it('pads hours and minutes to two digits', () => {
    expect(formatTime(ts(2026, 10, 19, 8, 5))).toBe('08:05')
    expect(formatTime(ts(2026, 10, 19, 0, 0))).toBe('00:00')
  })

  it('uses 24-hour clock', () => {
    expect(formatTime(ts(2026, 10, 19, 23, 59))).toBe('23:59')
    expect(formatTime(ts(2026, 10, 19, 13, 7))).toBe('13:07')
  })
})
