import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moveColumn, nextColumnPosition, resolveCardFields, safeColor, stageForCard } from './atlasStages'
import type { AtlasBoardColumn } from '@/types'

const cols: AtlasBoardColumn[] = [
  { id: 'review', title: 'Out for Review', position: 2, color: '#f59e0b' },
  { id: 'design', title: 'In Design', position: 0, color: '#0075a9' },
  { id: 'internal', title: 'Internal Review', position: 1, color: '#73308a' },
]

test('resolveCardFields: missing keys default on, explicit false stays off', () => {
  const f = resolveCardFields({ thumbnail: false })
  assert.equal(f.thumbnail, false)
  assert.equal(f.location, true)
  assert.equal(f.adviewer_link, true)
  assert.equal(resolveCardFields(null).deadline, true)
})

test('stageForCard: known id kept, null or stale id falls to the first column by position', () => {
  assert.equal(stageForCard('review', cols), 'review')
  assert.equal(stageForCard(null, cols), 'design')
  assert.equal(stageForCard('deleted-stage', cols), 'design')
  assert.equal(stageForCard('review', []), null)
})

test('moveColumn: swaps neighbours and renumbers 0..n-1', () => {
  const moved = moveColumn(cols, 'review', -1)
  assert.deepEqual(moved.map((c) => [c.id, c.position]), [['design', 0], ['review', 1], ['internal', 2]])
  const edge = moveColumn(cols, 'design', -1)
  assert.deepEqual(edge.map((c) => c.id), ['design', 'internal', 'review'])
})

test('nextColumnPosition + safeColor', () => {
  assert.equal(nextColumnPosition(cols), 3)
  assert.equal(nextColumnPosition([]), 0)
  assert.equal(safeColor('#ABCDEF'), '#ABCDEF')
  assert.equal(safeColor('red; background:url(x)'), '#0075a9')
})
