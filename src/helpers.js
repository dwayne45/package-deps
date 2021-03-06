/* @flow */

import fs from 'sb-fs'
import Path from 'path'
import semver from 'semver'
import { BufferedProcess } from 'atom'
import type { Dependency } from './types'

let shownStorageInfo = false
const VALID_TICKS = new Set(['✓', 'done'])
const VALIDATION_REGEXP = /(?:Installing|Moving) (.*?) to .* (.*)/

function exec(command: string, parameters: Array<string>): Promise<{ stdout: string, stderr: string }> {
  return new Promise(function(resolve) {
    const data = { stdout: [], stderr: [] }
    const spawnedProcess = new BufferedProcess({
      command,
      args: parameters,
      stdout(chunk) {
        data.stdout.push(chunk)
      },
      stderr(chunk) {
        data.stderr.push(chunk)
      },
      exit() {
        resolve({ stdout: data.stdout.join(''), stderr: data.stderr.join('') })
      },
      autoStart: false,
    })
    spawnedProcess.start()
  })
}

export function apmInstall(
  dependencies: Array<Dependency>,
  progressCallback: (packageName: string, status: boolean) => void,
): Promise<Map<string, Error>> {
  const errors = new Map()
  return Promise.all(
    dependencies.map(function(dep) {
      return exec(atom.packages.getApmPath(), ['install', dep.url || dep.name, '--production', '--color', 'false'])
        .then(function(output) {
          let successful = VALIDATION_REGEXP.test(output.stdout)
          if (successful) {
            const match = VALIDATION_REGEXP.exec(output.stdout)
            successful = match && VALID_TICKS.has(match[2])
          }
          progressCallback(dep.name, !!successful)
          if (!successful) {
            const error = new Error(`Error installing dependency: ${dep.name}`)
            error.stack = output.stderr
            throw error
          }
        })
        .catch(function(error) {
          errors.set(dep.name, error)
        })
    }),
  ).then(function() {
    return errors
  })
}

const DEPENDENCY_REGEX_VERSION = /(.*?):.*/
const DEPENDENCY_REGEX_GIRURL = /(.*?)#.*/
export async function getDependencies(packageName: string): Promise<Array<Dependency>> {
  const packageModule = atom.packages.getLoadedPackage(packageName)
  const packageDependencies = packageModule && packageModule.metadata['package-deps']

  if (!Array.isArray(packageDependencies)) {
    console.error(`[Package-Deps] Unable to get loaded package '${packageName}'`)
    return []
  }
  return (await Promise.all(
    packageDependencies.map(async function(entry) {
      let url = null
      let name = entry
      let version = null

      const matchVersion = DEPENDENCY_REGEX_VERSION.exec(entry)
      const matchGiturl = DEPENDENCY_REGEX_GIRURL.exec(entry)
      if (matchVersion) {
        ;[, name, version] = matchVersion
      } else if (matchGiturl) {
        ;[, name, url] = matchGiturl
      } else {
        name = entry
      }

      if (__steelbrain_package_deps.has(name)) {
        return null
      }

      const resolvedPath = atom.packages.resolvePackagePath(name)
      if (resolvedPath) {
        if (!version) {
          return null
        }

        const manifest = JSON.parse(await fs.readFile(Path.join(resolvedPath, 'package.json')))
        // $FlowIgnore: Flow is paranoid, this parsed.version is NOT NULL
        if (semver.satisfies(manifest.version, `>=${version}`)) {
          return null
        }
      }
      __steelbrain_package_deps.add(name)

      return { name, url }
    }),
  )).filter(Boolean)
}

export async function promptUser(packageName: string, dependencies: Array<Dependency>): Promise<'Yes' | 'No' | 'Never'> {
  const oldConfigPath = Path.join(atom.getConfigDirPath(), 'package-deps-state.json')
  let ignoredPackages = atom.config.get('atom-package-deps.ignored') || []

  if (await fs.exists(oldConfigPath)) {
    const oldConfig = JSON.parse(await fs.readFile(oldConfigPath, 'utf8'))
    atom.config.set('atom-package-deps.ignored', (ignoredPackages = oldConfig.ignored))
    await fs.unlink(oldConfigPath)
  }

  if (ignoredPackages.includes(packageName)) {
    return 'No'
  }

  if (atom.packages.isPackageDisabled('notifications')) {
    console.warn(`Enable notifications to install dependencies for ${packageName}`)
  }

  return new Promise(function(resolve) {
    const notification = atom.notifications.addInfo(`${packageName} needs to install dependencies`, {
      dismissable: true,
      icon: 'cloud-download',
      detail: dependencies.map(e => e.name).join(', '),
      description: `Install dependenc${dependencies.length === 1 ? 'y' : 'ies'}?`,
      buttons: [
        {
          text: 'Yes',
          onDidClick: () => {
            resolve('Yes')
            notification.dismiss()
          },
        },
        {
          text: 'No Thanks',
          onDidClick: () => {
            resolve('No')
            notification.dismiss()
          },
        },
        {
          text: 'Never',
          onDidClick: () => {
            ignoredPackages.push(packageName)
            atom.config.set('atom-package-deps.ignored', ignoredPackages)
            if (!shownStorageInfo) {
              shownStorageInfo = true
              atom.notifications.addInfo('How to reset package-deps memory', {
                dismissable: true,
                description:
                  "To modify the list of ignored files invoke 'Application: Open Your Config' and change the 'atom-package-deps' section",
              })
            }
            resolve('Never')
            notification.dismiss()
          },
        },
      ],
    })
    notification.onDidDismiss(() => resolve('No'))
  })
}
