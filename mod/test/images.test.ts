import { expect, test } from 'claude-code/testing'

import { dashed, imageIds, imagesDir, makeImageFinder } from '../src/images'

test('imagesDir: <tmp>/claude-<uid>/<dashed project>/<session>/images', () => {
  expect(imagesDir('/tmp', 1000, '/home/u/app', 'S1')).toBe('/tmp/claude-1000/-home-u-app/S1/images')
  // a trailing slash on the temp root is dropped, as Claude Code does
  expect(imagesDir('/var/tmp/', 501, '/home/u/app', 'S1')).toBe('/var/tmp/claude-501/-home-u-app/S1/images')
})

test('dashed: every non-alphanumeric becomes a dash (pinned to image-preview 0.2.3), leading dash kept', () => {
  expect(dashed('/home/u/app')).toBe('-home-u-app')
  expect(dashed('/home/u/my.app_v2')).toBe('-home-u-my-app-v2')
  expect(dashed('C:\\Work\\Proj')).toBe('C--Work-Proj')
})

test('imageIds: each [Image #N] once, in order', () => {
  expect(imageIds('look at [Image #1] and [Image #2] then [Image #1]')).toEqual([1, 2])
  expect(imageIds('no images [Image #x]')).toEqual([])
})

function finder(files: Record<string, Array<{ name: string; kind: 'file' | 'dir' | 'other' }>>, opts: { projects?: string[]; sid?: string; tmp?: string; uid?: number } = {}) {
  const listed: string[] = []
  const f = makeImageFinder({
    tmpRoot: async () => opts.tmp ?? '/tmp',
    uid: async () => opts.uid ?? 1000,
    projects: opts.projects ?? ['/home/u/app'],
    sessionId: () => opts.sid ?? 'S1',
    list: async dir => {
      listed.push(dir)
      const r = files[dir]
      if (!r) throw new Error('ENOENT')
      return r
    },
  })
  return { f, listed }
}

test('find: [Image #1] present as 1.png, [Image #2] (2.jpg) missing -> only #1', async () => {
  const { f } = finder({ '/tmp/claude-1000/-home-u-app/S1/images': [{ name: '1.png', kind: 'file' }] })
  const r = await f.find('look at [Image #1] and [Image #2]')
  expect(r.images).toEqual([{ n: 1, path: '/tmp/claude-1000/-home-u-app/S1/images/1.png' }])
  expect(r.dir).toBe('/tmp/claude-1000/-home-u-app/S1/images')
})

test('find: a symlink, a folder or an odd name is never reported', async () => {
  const { f } = finder({
    '/tmp/claude-1000/-home-u-app/S1/images': [
      { name: '1.png', kind: 'other' }, { name: '2.png', kind: 'dir' }, { name: '3.PNG.sh', kind: 'file' }, { name: '30.png', kind: 'file' },
    ],
  })
  expect((await f.find('[Image #1] [Image #2] [Image #3]')).images).toEqual([])
})

test('find: no placeholder -> no file system call', async () => {
  const { f, listed } = finder({})
  expect(await f.find('plain prompt')).toEqual({ dir: '', images: [] })
  expect(listed).toEqual([])
})

test('find: falls back to the cwd folder when the root one does not exist', async () => {
  const { f } = finder({ '/tmp/claude-1000/-home-u-app-sub/S2/images': [{ name: '1.jpeg', kind: 'file' }] }, { projects: ['/home/u/app', '/home/u/app/sub'], sid: 'S2' })
  const r = await f.find('[Image #1]')
  expect(r).toEqual({ dir: '/tmp/claude-1000/-home-u-app-sub/S2/images', images: [{ n: 1, path: '/tmp/claude-1000/-home-u-app-sub/S2/images/1.jpeg' }] })
})

test('find: no uid (e.g. Windows) or no session id -> nothing', async () => {
  const noUid = makeImageFinder({ tmpRoot: async () => '/tmp', uid: async () => undefined, projects: ['/a'], sessionId: () => 'S1', list: async () => [{ name: '1.png', kind: 'file' }] })
  expect(await noUid.find('[Image #1]')).toEqual({ dir: '', images: [] })
  const noSid = makeImageFinder({ tmpRoot: async () => '/tmp', uid: async () => 1000, projects: ['/a'], sessionId: () => '', list: async () => [{ name: '1.png', kind: 'file' }] })
  expect(await noSid.find('[Image #1]')).toEqual({ dir: '', images: [] })
})

test('find: a failing uid lookup is asked once and never throws', async () => {
  let calls = 0
  const f = makeImageFinder({ tmpRoot: async () => '/tmp', uid: async () => { calls++; throw new Error('no id') }, projects: ['/a'], sessionId: () => 'S1', list: async () => [] })
  expect(await f.find('[Image #1]')).toEqual({ dir: '', images: [] })
  expect(await f.find('[Image #1]')).toEqual({ dir: '', images: [] })
  expect(calls).toBe(1)
})

test('dir: the expected folder for the current session id, without touching the file system', async () => {
  const { f, listed } = finder({}, { sid: 'S9' })
  expect(await f.dir()).toBe('/tmp/claude-1000/-home-u-app/S9/images')
  expect(listed).toEqual([])
})
