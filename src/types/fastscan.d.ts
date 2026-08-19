declare module 'fastscan' {
  export default class FastScanner {
    constructor(words: string[])
    search(text: string): [number, string][]
    hits(text: string): string[]
  }
}