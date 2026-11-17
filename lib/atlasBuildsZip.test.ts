import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  attemptQuery, buildAttempts, buildAtlasColumns, noSourceReason, cardFocusName, formatMissingTxt, locationFolderNames, masterZipName,
  missingRow, planBuildTasks, quarterLabel, safeFolderName, uniqueSegment, type AtlasBuildCard, type AtlasLocationLike,
} from './atlasBuildsZip'

const locs: AtlasLocationLike[] = [
  { id: 'b', name: 'Atlas - Lakeside Cancer Center', advertiser_name: 'Lakeside', shares_creative: false },
  { id: 'c1', name: 'Atlas - MetroCare Northside', advertiser_name: 'MetroCare', shares_creative: false },
  { id: 'c2', name: 'Atlas - MetroCare Eastside', advertiser_name: 'MetroCare', shares_creative: false },
  { id: 'p1', name: 'Atlas - ScanCo Region A', advertiser_name: 'ScanCo', shares_creative: true },
  { id: 'p2', name: 'Atlas - ScanCo Region B', advertiser_name: 'ScanCo', shares_creative: true },
]

function card(id: string, title: string, loc: string, social: string | null, display: string | null, folder: string | null = null): AtlasBuildCard {
  return { id, title, atlas_location_id: loc, build_link: social, display_build_link: display, box_folder_id: folder }
}

test('shares_creative locations collapse to one column; others stay separate', () => {
  const cols = buildAtlasColumns(locs)
  assert.equal(cols.length, 4)
  assert.deepEqual(cols.find(c => c.key === 'brand:ScanCo')?.locationIds, ['p1', 'p2'])
})

test('folder names: advertiser when unique, short location when shared across columns', () => {
  const names = locationFolderNames(buildAtlasColumns(locs), locs)
  assert.equal(names.get('b'), 'Lakeside')
  assert.equal(names.get('brand:ScanCo'), 'ScanCo')
  assert.equal(names.get('c1'), 'MetroCare Northside')
  assert.equal(names.get('c2'), 'MetroCare Eastside')
})

test('safeFolderName strips separators, reserved chars and edge dots', () => {
  assert.equal(safeFolderName('Women\'s Health / Urinary: "Sexual"?'), "Women's Health - Urinary- -Sexual--")
  assert.equal(safeFolderName('  ..  '), 'Unnamed')
  assert.equal(safeFolderName('', 'Focus'), 'Focus')
})

test('focus strips the location prefix and (Social) suffix, incl. shared brand titles', () => {
  const col = buildAtlasColumns(locs)
  assert.equal(
    cardFocusName({ title: 'Atlas - Lakeside Cancer Center — Breast (Social)' }, locs[0], col[0]),
    'Breast',
  )
  // ScanCo card whose atlas_location_id is any practice; title uses the brand label
  assert.equal(
    cardFocusName({ title: 'Atlas - ScanCo — Beta-Amyloid (Social)' }, locs[4], col[3]),
    'Beta-Amyloid',
  )
})

test('planBuildTasks: two tasks per card, grouped path, null link kept', () => {
  const tasks = planBuildTasks([
    card('1', 'Atlas - Lakeside Cancer Center — Breast (Social)', 'b', 'https://box/s/1', null),
    card('2', 'Atlas - ScanCo — Branded (Social)', 'p2', 'https://box/s/2', ' https://box/s/3 '),
  ], locs)
  assert.equal(tasks.length, 4)
  assert.equal(tasks[0].dir, 'Lakeside/Breast/Social')
  assert.equal(tasks[1].link, null)
  assert.equal(tasks[3].dir, 'ScanCo/Branded/Display')
  assert.equal(tasks[3].link, 'https://box/s/3')
})

test('duplicate focus folders within a location get a suffix', () => {
  const tasks = planBuildTasks([
    card('1', 'Atlas - Lakeside Cancer Center — Breast (Social)', 'b', 'x', 'y'),
    card('2', 'Atlas - Lakeside Cancer Center — Breast (Social)', 'b', 'x', 'y'),
  ], locs)
  assert.equal(tasks[0].focusFolder, 'Breast')
  assert.equal(tasks[2].focusFolder, 'Breast (2)')
})

test('MISSING.txt rows and empty case', () => {
  const [t] = planBuildTasks([card('1', 'Atlas - Lakeside Cancer Center — Breast (Social)', 'b', null, null)], locs)
  const txt = formatMissingTxt([missingRow(t, 'no link')], 3, 'Q4 2026')
  assert.match(txt, /Downloaded: 3 {3}Missing: 1/)
  assert.match(txt, /Lakeside \| Breast \| Social \| no link/)
  assert.match(formatMissingTxt([], 5, 'Q4 2026'), /Nothing missing\./)
})

test('quarter label and zip name', () => {
  assert.equal(quarterLabel(new Date(2026, 9, 8)), 'Q4 2026')
  assert.equal(quarterLabel(new Date(2026, 0, 1)), 'Q1 2026')
  assert.equal(masterZipName('Q4 2026'), 'Atlas Builds — Q4 2026.zip')
})

test('Social: Build folder wins; build_link only when no folder', () => {
  const [withFolder] = planBuildTasks([card('1', 'Atlas - Lakeside Cancer Center — Breast (Social)', 'b', 'https://box/s/1', null, 'F1')], locs)
  assert.deepEqual(buildAttempts(withFolder), [{ via: 'folder', folderId: 'F1' }])
  const [noFolder] = planBuildTasks([card('1', 'Atlas - Lakeside Cancer Center — Breast (Social)', 'b', 'https://box/s/1', null)], locs)
  assert.deepEqual(buildAttempts(noFolder), [{ via: 'link', link: 'https://box/s/1' }])
  const [none] = planBuildTasks([card('1', 'Atlas - Lakeside Cancer Center — Breast (Social)', 'b', null, null)], locs)
  assert.deepEqual(buildAttempts(none), [])
  assert.match(noSourceReason(none), /No Build folder/)
})

test('Display: display_build_link only; none = "No Display build yet"', () => {
  const tasks = planBuildTasks([
    card('1', 'Atlas - Lakeside Cancer Center — Breast (Social)', 'b', null, 'https://box/s/d', 'F1'),
    card('2', 'Atlas - Lakeside Cancer Center — Lung (Social)', 'b', null, null, 'F2'),
  ], locs)
  const d1 = tasks[1], d2 = tasks[3]
  assert.deepEqual(buildAttempts(d1), [{ via: 'link', link: 'https://box/s/d' }])
  assert.deepEqual(buildAttempts(d2), [])
  assert.equal(noSourceReason(d2), 'No Display build yet')
})

test('attemptQuery matches the drawer calls and adds the folder mode', () => {
  const [s, d] = planBuildTasks([card('c9', 'Atlas - Lakeside Cancer Center — Breast (Social)', 'b', 'L', 'M', 'F1')], locs)
  assert.equal(attemptQuery(s, { via: 'link', link: 'L' }), 'sharedLink=L&cardId=c9')
  assert.equal(attemptQuery(d, { via: 'link', link: 'M' }), 'sharedLink=M&cardId=c9&variant=display')
  assert.equal(attemptQuery(s, { via: 'folder', folderId: 'F1' }), 'folderId=F1&cardId=c9')
})

test('uniqueSegment never hands out a name that is already taken', () => {
  const used = new Map<string, number>()
  assert.deepEqual(
    ['Breast', 'Breast', 'Breast (2)'].map(n => uniqueSegment(n, used)),
    ['Breast', 'Breast (2)', 'Breast (2) (2)'],
  )
  const used2 = new Map<string, number>()
  assert.deepEqual(
    ['Breast (2)', 'Breast', 'Breast'].map(n => uniqueSegment(n, used2)),
    ['Breast (2)', 'Breast', 'Breast (3)'],
  )
})
