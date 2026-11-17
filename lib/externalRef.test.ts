import { test } from 'node:test'
import assert from 'node:assert/strict'
import { externalRefKind, externalRefLabel } from './externalRef'

test('Google working files are classified by path', () => {
  assert.equal(externalRefKind('https://docs.google.com/spreadsheets/d/abc/edit#gid=0'), 'Google Sheet')
  assert.equal(externalRefKind('https://docs.google.com/document/d/abc/edit'), 'Google Doc')
  assert.equal(externalRefKind('https://docs.google.com/presentation/d/abc'), 'Google Slides')
  assert.equal(externalRefKind('https://docs.google.com/forms/d/abc'), 'Google Form')
  assert.equal(externalRefKind('https://drive.google.com/drive/folders/abc'), 'Google Drive folder')
  assert.equal(externalRefKind('https://drive.google.com/file/d/abc/view'), 'Google Drive file')
})

test('Box links are classified, including company subdomains and schemeless input', () => {
  assert.equal(externalRefKind('https://app.box.com/folder/123'), 'Box folder')
  assert.equal(externalRefKind('https://example.app.box.com/file/456'), 'Box file')
  assert.equal(externalRefKind('example.app.box.com/s/xyz'), 'Box shared link')
  assert.equal(externalRefKind('boxapp://file/789'), 'Box Drive file')
})

test('anything else is not a working-material reference', () => {
  assert.equal(externalRefKind('https://www.example.com/landing'), null)
  assert.equal(externalRefKind('External Box folder link'), null)
  assert.equal(externalRefKind(''), null)
  assert.equal(externalRefKind(null), null)
  assert.equal(externalRefKind('https://notbox.com/s/1'), null)
})

test('labels describe the kind and an optional note, never the URL', () => {
  assert.equal(externalRefLabel('https://app.box.com/s/xyz', 'display build'), 'Box shared link · display build')
  assert.equal(externalRefLabel('https://docs.google.com/spreadsheets/d/abc'), 'Google Sheet')
  assert.equal(externalRefLabel(null, 'working PSD', 'Box Drive file'), 'Box Drive file · working PSD')
  assert.equal(externalRefLabel('not a url', 'brand kit'), 'External file · brand kit')
})
