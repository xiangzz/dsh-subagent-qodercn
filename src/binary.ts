/**
 * Locate the Qoder CLI CN executable without depending on the Host's `PATH`.
 *
 * The official install script (`curl -fsSL https://static.qoder.com.cn/qoder-cli-cn/install.sh`)
 * places a native binary at `~/.qoder-cn/bin/qoderclicn/qoderclicn-<version>` and
 * symlinks `~/.local/bin/qoderclicn` to it; the legacy npm package
 * (`@qodercn-ai/qoderclicn`) puts a `qoderclicn` launcher on `PATH`. The public
 * `qodercn` command is only a shell dispatcher that execs one of those, so this
 * module resolves the real `qoderclicn` first and falls back to the dispatcher.
 *
 * @module dsh-subagent-qodercn/binary
 */

import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** Where a resolved executable came from. Safe for diagnostics. */
export type QoderBinarySource =
  | 'config'
  | 'PATH'
  | 'install-script'
  | 'versioned'
  | 'known-path'

/** A resolved Qoder CLI CN executable. */
export interface QoderBinary {
  /** Absolute path of the executable to spawn. */
  readonly path: string
  /** How {@link QoderBinary.path} was found. */
  readonly source: QoderBinarySource
}

/** The native CLI binary name. The `qodercn` wrapper is a shell dispatcher, not the agent. */
export const QODERCLI_BIN = 'qoderclicn'

/** The public dispatcher name. Tried last because it needs a POSIX shell. */
export const QODERCN_BIN = 'qodercn'

const WINDOWS_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'] as const

function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * Whether `file` is a regular file the current user may execute. On Windows
 * existence is enough: the loader decides through the file extension.
 * @param file - absolute candidate path.
 * @returns `true` only for an executable regular file.
 */
export function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (!isWindows()) accessSync(file, constants.X_OK)
    return true
  } catch {
    // statSync/accessSync throw only filesystem access errors here
    // (ENOENT/EACCES/ENOTDIR/…), and each one means `file` cannot be spawned.
    return false
  }
}

/**
 * File names to probe for a bare command on this platform. Windows resolves
 * commands through `PATHEXT`; POSIX uses the name as given.
 * @param name - bare command name.
 * @returns the candidate file names, in probe order.
 */
export function executableNames(name: string): readonly string[] {
  if (!isWindows() || /\.[A-Za-z0-9]+$/.test(name)) return [name]
  const ext = process.env.PATHEXT
  const exts = ext === undefined || ext.trim() === ''
    ? [...WINDOWS_PATHEXT]
    : ext.split(';').filter(entry => entry.trim() !== '')
  return [name, ...exts.map(entry => name + entry)]
}

/**
 * First executable `name` found on `PATH`.
 * @param name - bare command name.
 * @param env - environment to read `PATH`/`PATHEXT` from (defaults to the process).
 * @returns the absolute executable path, or `undefined` when none is on `PATH`.
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const search = env.PATH
  if (search === undefined || search === '') return undefined
  const names = executableNames(name)
  for (const dir of search.split(delimiter)) {
    if (dir === '') continue
    for (const candidate of names) {
      const full = join(dir, candidate)
      if (isExecutableFile(full)) return full
    }
  }
  return undefined
}

/** Fixed install-script locations under the user's home, in probe order. */
function homeCandidates(home: string): ReadonlyArray<readonly [file: string, source: QoderBinarySource]> {
  const cliDir = join(home, '.qoder-cn', 'bin', QODERCLI_BIN)
  const candidates: Array<readonly [string, QoderBinarySource]> = [
    [join(home, '.local', 'bin', QODERCLI_BIN), 'install-script'],
  ]
  // The install script keeps one versioned binary per release and records the
  // active one in version.txt; prefer the recorded version over a bare name.
  try {
    const version = readFileSync(join(cliDir, 'version.txt'), 'utf8').trim()
    if (version !== '' && !version.includes('/') && !version.includes('\\')) {
      candidates.push([join(cliDir, `${QODERCLI_BIN}-${version}`), 'versioned'])
    }
  } catch {
    // No version.txt: an older or partial install. The fixed name below may still exist.
  }
  candidates.push([join(cliDir, QODERCLI_BIN), 'known-path'])
  return candidates
}

/**
 * Resolve the Qoder CLI CN executable for one provider instance.
 * @param configured - the plugin's optional `command` config: an absolute path
 *   or a bare name to look up on `PATH`.
 * @param home - the user's home directory (defaults to `os.homedir()`).
 * @returns the executable and where it was found.
 * @throws when no candidate exists. The message lists every probed location
 *   so the operator can install the CLI or set `command`.
 */
export function resolveQoderBinary(configured: string | undefined, home: string = homedir()): QoderBinary {
  if (configured !== undefined && configured.trim() !== '') {
    if (isAbsolute(configured)) {
      if (!isExecutableFile(configured)) {
        throw new Error(`dsh-subagent-qodercn: configured command is not an executable file: ${configured}`)
      }
      return { path: configured, source: 'config' }
    }
    const onPath = findOnPath(configured)
    if (onPath === undefined) {
      throw new Error(`dsh-subagent-qodercn: configured command "${configured}" was not found on PATH`)
    }
    return { path: onPath, source: 'config' }
  }

  const onPath = findOnPath(QODERCLI_BIN)
  if (onPath !== undefined) return { path: onPath, source: 'PATH' }

  const probed: string[] = [`PATH (${QODERCLI_BIN})`]
  for (const [file, source] of homeCandidates(home)) {
    probed.push(file)
    if (isExecutableFile(file)) return { path: file, source }
  }

  const wrapper = findOnPath(QODERCN_BIN)
  if (wrapper !== undefined) return { path: wrapper, source: 'PATH' }
  probed.push(`PATH (${QODERCN_BIN})`)

  throw new Error(
    'dsh-subagent-qodercn: Qoder CLI CN executable not found. Probed:\n  '
    + probed.join('\n  ')
    + '\nInstall it from https://docs.qoder.cn/cli/installation, or point the plugin\'s `command` config at the executable.',
  )
}
