import FastScanner from 'fastscan'
import banwordList from './banword.json'

const scanner = new FastScanner(banwordList)

function filter(word: string): string {
  const list = scanner.search(word)

  if (list && list.length > 0) {
    list.forEach((item: any) => {
      const re = new RegExp(item[1], "g")
      word = word.replace(re, '***')
    })
  }

  return word
}

export default filter