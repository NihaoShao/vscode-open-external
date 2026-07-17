import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync } from 'node:fs'

const svg = readFileSync('images/icon.svg', 'utf-8')
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 256 },
  background: 'transparent',
})
const png = resvg.render().asPng()
writeFileSync('images/icon.png', png)
console.log('written images/icon.png', png.length, 'bytes')
