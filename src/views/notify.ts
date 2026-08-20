/**
 * Browser notification helper (Bun-native port of assets/js/notify.js).
 *
 * - `init()` requests Notification permission once.
 * - `push(info)` plays /notify.mp3; if the window is focused it shows the
 *   in-page toast, otherwise it fires a browser Notification (tagged
 *   'mention-notify' so repeated mentions collapse into one).
 */

export type NotifyInfo = {
  roomId: string
  from: string
  to: string
  msg: string
}

export class Notify {
  private focus = true

  constructor() {
    window.addEventListener('blur', () => {
      this.focus = false
    })
    window.addEventListener('focus', () => {
      this.focus = true
    })
  }

  init(): void {
    if (window.Notification && Notification.permission !== 'granted') {
      Notification.requestPermission()
    }
  }

  push(info: NotifyInfo): void {
    try {
      new Audio('/notify.mp3').play()
    } catch {
      void 0
    }

    if (this.focus) {
      const toast = document.getElementById('toast')
      if (toast) {
        toast.textContent = 'Someone mentions you'
        toast.classList.add('show')
        window.setTimeout(() => {
          toast.classList.remove('show')
        }, 2200)
      }
    } else if (window.Notification && Notification.permission === 'granted') {
      new Notification(`${info.to}, Someone mentions you`, {
        tag: 'mention-notify',
        body: `${info.from}::${info.roomId}: ${info.msg}`,
        icon: '/favicon.ico',
      })
    }
  }
}
