import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getOrCreateFolderSharedLink, pickNamedFolder, resolveRootFolderId } from './boxSharedLink'

function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; method: string; body?: string }[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    const r = handler(url, init)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

test('reuses an existing shared link and never writes', async () => {
  const { impl, calls } = stubFetch(() => ({ body: { shared_link: { url: 'https://example.app.box.com/s/abc' } } }))
  const r = await getOrCreateFolderSharedLink('1', 'tok', impl)
  assert.deepEqual(r, { url: 'https://example.app.box.com/s/abc', created: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
})

test('creates a link like "Copy link": empty shared_link, no access level forced', async () => {
  const { impl, calls } = stubFetch((_u, init) =>
    init?.method === 'PUT'
      ? { body: { shared_link: { url: 'https://example.app.box.com/s/new' } } }
      : { body: { shared_link: null } })
  const r = await getOrCreateFolderSharedLink('2', 'tok', impl)
  assert.deepEqual(r, { url: 'https://example.app.box.com/s/new', created: true })
  assert.equal(calls[1].method, 'PUT')
  assert.deepEqual(JSON.parse(calls[1].body ?? '{}'), { shared_link: {} })
})

test('a 403 on create explains the permission to ask for', async () => {
  const { impl } = stubFetch((_u, init) =>
    init?.method === 'PUT' ? { status: 403, body: {} } : { body: { shared_link: null } })
  await assert.rejects(getOrCreateFolderSharedLink('3', 'tok', impl), /permission to create shared links/)
})

test('resolveRootFolderId: bare id and folder URL need no API call; a shared link does', async () => {
  const { impl, calls } = stubFetch(() => ({ body: { id: '999', type: 'folder' } }))
  assert.equal(await resolveRootFolderId('123', 't', impl), '123')
  assert.equal(await resolveRootFolderId('https://app.box.com/folder/456', 't', impl), '456')
  assert.equal(calls.length, 0)
  assert.equal(await resolveRootFolderId('https://example.app.box.com/s/xyz', 't', impl), '999')
  assert.equal(calls.length, 1)
})

test('resolveRootFolderId refuses a shared file', async () => {
  const { impl } = stubFetch(() => ({ body: { id: '5', type: 'file' } }))
  await assert.rejects(resolveRootFolderId('https://example.app.box.com/s/f', 't', impl), /not a folder/)
})

test('pickNamedFolder is case-insensitive, trimmed, and ignores files', () => {
  const items = [
    { type: 'file', name: '2026' },
    { type: 'folder', name: ' q4 ' },
    { type: 'folder', name: '2026' },
  ]
  assert.equal(pickNamedFolder(items, 'Q4')?.name, ' q4 ')
  assert.equal(pickNamedFolder(items, '2026')?.type, 'folder')
  assert.equal(pickNamedFolder(items, 'Q1'), undefined)
})
