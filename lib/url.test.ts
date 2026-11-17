import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHttpsScheme, landingHostname } from './url'
import { buildCopyTrackerHtml } from './copyTracker'
import { generateUtmUrl } from './utm'

test('withHttpsScheme prepends https:// to schemeless URLs', () => {
  assert.equal(withHttpsScheme('campus.example.edu/visit'), 'https://campus.example.edu/visit')
  assert.equal(withHttpsScheme('go.example.edu/campuspreview'), 'https://go.example.edu/campuspreview')
  assert.equal(withHttpsScheme('  www.example.com?a=1  '), 'https://www.example.com?a=1')
  assert.equal(withHttpsScheme('localhost:3000/x'), 'https://localhost:3000/x')
  assert.equal(withHttpsScheme('httpbin.org/get'), 'https://httpbin.org/get')
  assert.equal(withHttpsScheme('//cdn.example.com/a'), 'https://cdn.example.com/a')
})

test('withHttpsScheme leaves explicit schemes and relative refs alone', () => {
  assert.equal(withHttpsScheme('https://a.com/x'), 'https://a.com/x')
  assert.equal(withHttpsScheme('HTTP://a.com'), 'HTTP://a.com')
  assert.equal(withHttpsScheme('mailto:hi@a.com'), 'mailto:hi@a.com')
  assert.equal(withHttpsScheme('tel:+15555550100'), 'tel:+15555550100')
  assert.equal(withHttpsScheme('/card/123'), '/card/123')
  assert.equal(withHttpsScheme('#top'), '#top')
})

test('withHttpsScheme returns empty string for empty input', () => {
  assert.equal(withHttpsScheme(null), '')
  assert.equal(withHttpsScheme(undefined), '')
  assert.equal(withHttpsScheme('   '), '')
})

test('landingHostname handles schemeless URLs', () => {
  assert.equal(landingHostname('www.example-moto.com/inventory'), 'example-moto.com')
  assert.equal(landingHostname('https://campus.example.edu/visit'), 'campus.example.edu')
  assert.equal(landingHostname(null), '')
})

test('Copy Tracker HTML uses an absolute href but keeps the visible text as typed', () => {
  const html = buildCopyTrackerHtml({
    creativeName: 'EXU-M10-Visit',
    adviewerUrl: null,
    cardUrl: 'https://your-app.vercel.app/card/abc',
    landingPages: ['campus.example.edu/visit', 'https://go.example.edu/x?a=1&b=2'],
    endDate: '2026-10-31',
  })
  assert.ok(html.includes('<a href="https://campus.example.edu/visit">campus.example.edu/visit</a>'))
  assert.ok(html.includes('<a href="https://go.example.edu/x?a=1&amp;b=2">https://go.example.edu/x?a=1&amp;b=2</a>'))
  assert.ok(!html.includes('href="campus.example.edu'))
})

test('generateUtmUrl still normalizes schemeless base URLs', () => {
  assert.equal(
    generateUtmUrl({ baseUrl: 'campus.example.edu/visit', campaign: 'fall', channel: 'display', client: null }),
    'https://campus.example.edu/visit?utm_source=FTE&utm_medium=display&utm_campaign=fall',
  )
})
