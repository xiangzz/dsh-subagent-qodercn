import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  QODERCLI_BIN,
  executableNames,
  findOnPath,
  resolveQoderBinary,
} from '../src/binary.ts'

const tempDirs: string[] = []
const originalPath = process.env.PATH

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qodercn-bin-'))
  tempDirs.push(dir)
  return dir
}

function executable(file: string, content = '#!/bin/sh\nexit 0\n'): string {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, 0o755)
  return file
}

function withPath(value: string | undefined, run: () => void): void {
  if (value === undefined) delete process.env.PATH
  else process.env.PATH = value
  try {
    run()
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('executableNames', () => {
  it('probes the bare name on POSIX', { skip: process.platform === 'win32' }, () => {
    assert.deepEqual(executableNames(QODERCLI_BIN), [QODERCLI_BIN])
  })
})

describe('findOnPath', () => {
  it('returns the first executable match across PATH entries', () => {
    const first = tempDir()
    const second = tempDir()
    const hit = executable(join(second, QODERCLI_BIN))
    const found = findOnPath(QODERCLI_BIN, { PATH: [first, second].join(delimiter) })
    assert.equal(found, hit)
  })

  it('skips non-executable files and empty entries', () => {
    const dir = tempDir()
    writeFileSync(join(dir, QODERCLI_BIN), 'not executable')
    chmodSync(join(dir, QODERCLI_BIN), 0o644)
    assert.equal(findOnPath(QODERCLI_BIN, { PATH: `${delimiter}${dir}` }), undefined)
  })

  it('returns undefined without PATH', () => {
    assert.equal(findOnPath(QODERCLI_BIN, {}), undefined)
    assert.equal(findOnPath(QODERCLI_BIN, { PATH: '' }), undefined)
  })
})

describe('resolveQoderBinary', () => {
  it('uses an explicit absolute command when it is executable', () => {
    const dir = tempDir()
    const file = executable(join(dir, 'custom-qoder'))
    assert.deepEqual(resolveQoderBinary(file, dir), { path: file, source: 'config' })
  })

  it('rejects an explicit absolute command that is not an executable file', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'plain'), 'x')
    assert.throws(() => resolveQoderBinary(join(dir, 'plain'), dir), /not an executable file/)
    assert.throws(() => resolveQoderBinary(join(dir, 'missing'), dir), /not an executable file/)
  })

  it('looks a bare configured name up on PATH', () => {
    const dir = tempDir()
    const file = executable(join(dir, 'my-qoder'))
    withPath(dir, () => {
      assert.deepEqual(resolveQoderBinary('my-qoder', tempDir()), { path: file, source: 'config' })
    })
  })

  it('prefers qoderclicn on PATH over home locations', () => {
    const bin = tempDir()
    const home = tempDir()
    const onPath = executable(join(bin, QODERCLI_BIN))
    executable(join(home, '.local', 'bin', QODERCLI_BIN))
    withPath(bin, () => {
      assert.deepEqual(resolveQoderBinary(undefined, home), { path: onPath, source: 'PATH' })
    })
  })

  it('falls back to the install-script symlink under the home directory', () => {
    const home = tempDir()
    const link = executable(join(home, '.local', 'bin', QODERCLI_BIN))
    withPath(tempDir(), () => {
      assert.deepEqual(resolveQoderBinary(undefined, home), { path: link, source: 'install-script' })
    })
  })

  it('prefers the version recorded in version.txt over the bare name', () => {
    const home = tempDir()
    const cliDir = join(home, '.qoder-cn', 'bin', QODERCLI_BIN)
    mkdirSync(cliDir, { recursive: true })
    writeFileSync(join(cliDir, 'version.txt'), '1.2.3\n')
    const versioned = executable(join(cliDir, `${QODERCLI_BIN}-1.2.3`))
    executable(join(cliDir, QODERCLI_BIN))
    withPath(tempDir(), () => {
      assert.deepEqual(resolveQoderBinary(undefined, home), { path: versioned, source: 'versioned' })
    })
  })

  it('ignores a version.txt that would escape the cli directory', () => {
    const home = tempDir()
    const cliDir = join(home, '.qoder-cn', 'bin', QODERCLI_BIN)
    mkdirSync(cliDir, { recursive: true })
    writeFileSync(join(cliDir, 'version.txt'), '../../evil')
    const bare = executable(join(cliDir, QODERCLI_BIN))
    withPath(tempDir(), () => {
      assert.deepEqual(resolveQoderBinary(undefined, home), { path: bare, source: 'known-path' })
    })
  })

  it('uses the bare cli path when version.txt is absent', () => {
    const home = tempDir()
    const bare = executable(join(home, '.qoder-cn', 'bin', QODERCLI_BIN, QODERCLI_BIN))
    withPath(tempDir(), () => {
      assert.deepEqual(resolveQoderBinary(undefined, home), { path: bare, source: 'known-path' })
    })
  })

  it('falls back to the qodercn dispatcher on PATH', () => {
    const bin = tempDir()
    const home = tempDir()
    const wrapper = executable(join(bin, 'qodercn'))
    withPath(bin, () => {
      assert.deepEqual(resolveQoderBinary(undefined, home), { path: wrapper, source: 'PATH' })
    })
  })

  it('fails with every probed location when nothing is installed', () => {
    const bin = tempDir()
    const home = tempDir()
    withPath(bin, () => {
      assert.throws(
        () => resolveQoderBinary(undefined, home),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.match(error.message, /Qoder CLI CN executable not found/)
          assert.match(error.message, /Probed:/)
          assert.ok(error.message.includes(`PATH (${QODERCLI_BIN})`))
          assert.ok(error.message.includes(join(home, '.local', 'bin', QODERCLI_BIN)))
          assert.ok(error.message.includes(join(home, '.qoder-cn', 'bin', QODERCLI_BIN, QODERCLI_BIN)))
          assert.ok(error.message.includes(`PATH (qodercn)`))
          assert.match(error.message, /https:\/\/docs\.qoder\.cn\/cli\/installation/)
          return true
        },
      )
    })
  })
})
