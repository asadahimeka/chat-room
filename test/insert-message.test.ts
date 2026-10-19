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

// ── Helpers ────────────────────────────────────────────────────────────
// Local-time timestamps keep day-key expectations timezone-independent.

/** Unix-seconds timestamp for a local date/time. */
function ts(y: number, mo: number, d: number, h = 12, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi).getTime() / 1000
}

const DAY1 = '2026-10-18'
const DAY2 = '2026-10-19'

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

/** All .day-sep children of the list (bare class selectors are not part of
 * the stub's querySelector surface, so filter the children directly). */
function daySeps(msgList: HTMLDivElement): HTMLDivElement[] {
  return Array.from(msgList.children).filter(
    (c): c is HTMLDivElement => c.classList.contains('day-sep'),
  )
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
    // Oldest page item lands directly after the tip; p3(DAY1) above p2(DAY2)
    // spawns exactly one separator labeled with the newer day below it.
    const seps = daySeps(msgList)
    expect(seps.length).toBe(1)
    expect(seps[0].textContent).toBe(formatDayLabel(DAY2))
    expect(msgList.children[1]).toBe(p3)
    expect(msgList.children[2]).toBe(seps[0])
    expect(msgList.children[3]).toBe(p2)
    expect(msgList.children[4]).toBe(p1)
    expect(msgList.children[5]).toBe(existing)
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
    expect(msgList.children[1]).toBe(node)
    expect(msgList.children[2]).toBe(oldTop)
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

  it('inserts a day separator between days, labeled with the day below it', () => {
    const { msgList, tip } = makeList()
    const oldTop = makeMessage('u1', DAY2) // newer, below
    insertAfter(msgList, tip, oldTop)

    const node = makeMessage('u1', DAY1) // older, above
    insertBefore(msgList, tip, node)

    const seps = daySeps(msgList)
    expect(seps.length).toBe(1)
    // The separator sits between the two messages…
    expect(msgList.children[1]).toBe(node)
    expect(msgList.children[2]).toBe(seps[0])
    expect(msgList.children[3]).toBe(oldTop)
    // …and labels the first message BELOW it (the newer day).
    expect(seps[0].textContent).toBe(formatDayLabel(DAY2))
    expect(seps[0].classList.contains('sys-msg')).toBe(true)
    // Same uid but cross-day: no threading, only the separator.
    expect(node.classList.contains('threaded')).toBe(false)
    expect(oldTop.classList.contains('threaded')).toBe(false)
  })

  it('skips non-message elements (sys pills) when finding the adjacent message', () => {
    const { msgList, tip } = makeList()
    insertAfter(msgList, tip, makeMessage('u1', DAY2))
    insertAfter(msgList, tip, makeSys()) // live sys pill lands between

    const node = makeMessage('u1', DAY2)
    insertAfter(msgList, tip, node)

    // [tip, first, sys, node] — the upward walk must skip the sys pill.
    expect(msgList.children[1].classList.contains('message')).toBe(true)
    expect(msgList.children[2].classList.contains('sys-msg')).toBe(true)
    expect(msgList.children[3]).toBe(node)
    expect(node.classList.contains('threaded')).toBe(true)
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
    expect(msgList.children[1]).toBe(first)
    expect(msgList.children[2]).toBe(node)
  })

  it('does not thread same uid across days', () => {
    const { msgList, tip } = makeList()
    insertAfter(msgList, tip, makeMessage('u1', DAY1))
    const node = makeMessage('u1', DAY2)
    insertAfter(msgList, tip, node)
    expect(node.classList.contains('threaded')).toBe(false)
  })

  it('inserts a day separator before node when the day changes', () => {
    const { msgList, tip } = makeList()
    insertAfter(msgList, tip, makeMessage('u1', DAY1))

    const node = makeMessage('u2', DAY2)
    insertAfter(msgList, tip, node)

    const seps = daySeps(msgList)
    expect(seps.length).toBe(1)
    // Labeled with node's dayKey — node is the first message below the sep.
    expect(seps[0].textContent).toBe(formatDayLabel(DAY2))
    expect(msgList.children[2]).toBe(seps[0])
    expect(msgList.children[3]).toBe(node)
  })

  it('inserts no separator within the same day', () => {
    const { msgList, tip } = makeList()
    insertAfter(msgList, tip, makeMessage('u1', DAY2))
    insertAfter(msgList, tip, makeMessage('u2', DAY2))
    insertAfter(msgList, tip, makeMessage('u1', DAY2))
    expect(daySeps(msgList).length).toBe(0)
  })

  it('skips the history tip when the list is otherwise empty', () => {
    const { msgList, tip } = makeList()
    const node = makeMessage('u1', DAY2)
    insertAfter(msgList, tip, node) // above-adjacent walk must skip the tip
    expect(node.classList.contains('threaded')).toBe(false)
    expect(msgList.children[0]).toBe(tip)
    expect(msgList.children[1]).toBe(node)
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
