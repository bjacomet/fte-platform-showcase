import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalFocusKey, matchAtlasBoxTrees, type AtlasBoxBuild, type AtlasDisplayBuild, type AtlasSyncCard, type AtlasSyncLocation,
} from './atlasBoxSync'

const locations: AtlasSyncLocation[] = [
  { id: 'imp', name: 'Atlas - Desert Valley' },
  { id: 'cn', name: 'Atlas - Coastal Cancer Care' },
  { id: 'p1', name: 'Atlas - ScanCo Imaging of Metro (Ridgeview)' },
  { id: 'p2', name: 'Atlas - ScanCo Imaging of Region Two (Hillcrest)' },
  { id: 'p3', name: 'Atlas - ScanCo Imaging of Region Three' },
  { id: 'p4', name: 'Atlas - ScanCo Imaging of Region Four' },
  { id: 'p5', name: 'Atlas - ScanCo Imaging of Region Five' },
]

function card(id: string, loc: string, focus: string): AtlasSyncCard {
  const name = locations.find((l) => l.id === loc)!.name
  return { id, title: `${name} — ${focus} (Social)`, atlas_location_id: loc, box_folder_id: null }
}

function social(id: string, path: string[], file = `Atlas-M10-${path.join('-')}-1080x1080.mp4`): AtlasBoxBuild {
  return {
    buildFolderId: id, path, locationLabel: path.slice(0, -1).join('/'), focusLabel: path[path.length - 1],
    file: { id: `f-${id}`, name: file, size: 1, dimensions: { width: 1080, height: 1080 } },
    offSpec: false, ambiguousFiles: null, skippedFiles: [],
  }
}

function display(id: string, path: string[], files = 6): AtlasDisplayBuild {
  return {
    buildFolderId: id, path, locationLabel: path.slice(0, -1).join('/'), focusLabel: path[path.length - 1],
    files: Array.from({ length: files }, (_, i) => `z${i}.zip`),
  }
}

test("alias: Box focus 'LDRT' resolves to the card focus 'LDRT for OA'", () => {
  assert.equal(canonicalFocusKey('LDRT'), canonicalFocusKey('LDRT for OA'))
  const r = matchAtlasBoxTrees(
    [social('s1', ['Desert Valley', 'LDRT'], 'Atlas-M10-Desert-LDRT-1080x1080.mp4')],
    [display('d1', ['Desert Valley', 'LDRT'])],
    [card('c1', 'imp', 'LDRT for OA')], locations,
  )
  assert.equal(r.matched.length, 1)
  assert.deepEqual(r.matched[0].cardIds, ['c1'])
  assert.equal(r.matched[0].display?.buildFolderId, 'd1')
})

test('Display pairs onto the Social row for the same card; no display-only row appears', () => {
  const r = matchAtlasBoxTrees(
    [social('s1', ['Coastal Cancer Care', 'Joint Care'])],
    [display('d1', ['Coastal Cancer Care', 'Joint Care'])],
    [card('c1', 'cn', 'Joint Care')], locations,
  )
  assert.equal(r.matched.length + r.needsAttention.length, 1)
  assert.equal(r.matched[0].display?.files.length, 6)
  assert.equal(r.displayMissing.length, 0)
  assert.equal(r.totals.displayBuilds, 1)
})

test('a Social row with no Display build is listed, with the reason', () => {
  const r = matchAtlasBoxTrees(
    [social('s1', ['Desert Valley', 'Prostate'])],
    [display('d1', ['Desert Valley', 'Skin'])],
    [card('c1', 'imp', 'Prostate'), card('c2', 'imp', 'Skin')], locations,
  )
  assert.equal(r.displayMissing.length, 1)
  assert.match(r.displayMissing[0].reason, /No Banner Ads build for "Prostate"/)
})

test('ScanCo: missing "ScanCo" folder under Banner Ads surfaces — never a silent skip', () => {
  const cards = ['p1', 'p2', 'p3', 'p4', 'p5'].map((l, i) => card(`c${i}`, l, 'Branded'))
  const r = matchAtlasBoxTrees(
    [social('s1', ['ScanCo', 'Branded'])],
    [display('d1', ['Desert Valley', 'Skin'])],
    cards, locations,
  )
  assert.equal(r.matched[0].cardIds.length, 5)
  assert.equal(r.displayMissing.length, 1)
  assert.match(r.displayMissing[0].reason, /No "ScanCo" folder in Banner Ads/)
})

test('ScanCo present in Banner Ads: one Display build covers all its cards', () => {
  const cards = ['p1', 'p2', 'p3', 'p4', 'p5'].map((l, i) => card(`c${i}`, l, 'Branded'))
  const r = matchAtlasBoxTrees([social('s1', ['ScanCo', 'Branded'])], [display('d1', ['ScanCo', 'Branded'])], cards, locations)
  assert.equal(r.matched[0].display?.buildFolderId, 'd1')
  assert.equal(r.displayMissing.length, 0)
})

test('a missing Banner Ads period reports one note for every row', () => {
  const r = matchAtlasBoxTrees(
    [social('s1', ['Desert Valley', 'Prostate'])], [],
    [card('c1', 'imp', 'Prostate')], locations, 'Banner Ads has no 2026/Q4 folder yet',
  )
  assert.equal(r.matched.length, 1)
  assert.equal(r.displayMissing[0].reason, 'Banner Ads has no 2026/Q4 folder yet')
})

test('a Display build with no Social build still becomes a row, and an empty one needs attention', () => {
  const r = matchAtlasBoxTrees(
    [], [display('d1', ['Desert Valley', 'Skin']), display('d2', ['Desert Valley', 'Prostate'], 0)],
    [card('c1', 'imp', 'Skin'), card('c2', 'imp', 'Prostate')], locations,
  )
  assert.equal(r.matched.length, 1)
  assert.equal(r.matched[0].buildFolderId, null)
  assert.equal(r.matched[0].rowKey, 'display:d1')
  assert.equal(r.needsAttention.length, 1)
  assert.match(r.needsAttention[0].reason ?? '', /empty/)
})

test('a Display build for an unknown location needs attention, never dropped', () => {
  const r = matchAtlasBoxTrees([], [display('d1', ['Nowhere Clinic', 'Skin'])], [], locations)
  assert.equal(r.needsAttention.length, 1)
  assert.equal(r.needsAttention[0].cardIds.length, 0)
})

test('an empty Banner Ads Build folder never holds back the Social attach', () => {
  const r = matchAtlasBoxTrees(
    [social('s1', ['Coastal Cancer Care', 'Joint Care'])],
    [display('d1', ['Coastal Cancer Care', 'Joint Care'], 0)],
    [card('c1', 'cn', 'Joint Care')], locations,
  )
  assert.equal(r.matched.length, 1)
  assert.equal(r.matched[0].display, null)
  assert.equal(r.needsAttention.length, 0)
  assert.equal(r.totals.cardsCovered, 1)
  assert.deepEqual(r.displayMissing.map((m) => m.reason), ['The Display Build folder is empty'])
})

test('two Banner Ads builds for one row: neither is paired, both need attention', () => {
  const r = matchAtlasBoxTrees(
    [social('s1', ['Coastal Cancer Care', 'Joint Care'])],
    [display('d1', ['Coastal Cancer Care', 'Joint Care']), display('d2', ['Coastal Cancer Care', 'Joint Care'])],
    [card('c1', 'cn', 'Joint Care')], locations,
  )
  assert.equal(r.matched.length, 1)
  assert.equal(r.matched[0].display, null)
  assert.deepEqual(r.needsAttention.map((n) => n.rowKey).sort(), ['display:d1', 'display:d2'])
  assert.ok(r.needsAttention.every((n) => n.cardIds.length === 0))
  assert.equal(r.displayMissing.length, 1)
})
