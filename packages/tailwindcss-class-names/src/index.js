import extractClassNames from './extractClassNames.mjs'
import Hook from './hook.mjs'
import dlv from 'dlv'
import dset from 'dset'
import importFrom from 'import-from'
import chokidar from 'chokidar'
import semver from 'semver'
import invariant from 'tiny-invariant'
import getPlugins from './getPlugins'
import getVariants from './getVariants'
import resolveConfig from './resolveConfig'
import * as util from 'util'
import * as path from 'path'
import { glob } from './glob'
import { getUtilityConfigMap } from './getUtilityConfigMap'

function TailwindConfigError(error) {
  Error.call(this)
  Error.captureStackTrace(this, this.constructor)

  this.name = this.constructor.name
  this.message = error.message
  this.stack = error.stack
}

util.inherits(TailwindConfigError, Error)

function arraysEqual(arr1, arr2) {
  return (
    JSON.stringify(arr1.concat([]).sort()) ===
    JSON.stringify(arr2.concat([]).sort())
  )
}

const CONFIG_GLOB =
  '**/{tailwind,tailwind.config,tailwind-config,.tailwindrc}.js'

export default async function getClassNames(
  cwd = process.cwd(),
  { onChange = () => {} } = {}
) {
  async function run() {
    let configPath
    let postcss
    let tailwindcss
    let version

    configPath = await glob(CONFIG_GLOB, {
      cwd,
      ignore: '**/node_modules/**',
      max: 1,
    })
    invariant(configPath.length === 1, 'No Tailwind CSS config found.')
    configPath = configPath[0]
    const configDir = path.dirname(configPath)
    postcss = importFrom(configDir, 'postcss')
    tailwindcss = importFrom(configDir, 'tailwindcss')
    version = importFrom(configDir, 'tailwindcss/package.json').version

    const sepLocation = semver.gte(version, '0.99.0')
      ? ['separator']
      : ['options', 'separator']
    let userSeperator
    let hook = Hook(configPath, (exports) => {
      userSeperator = dlv(exports, sepLocation)
      dset(exports, sepLocation, '__TAILWIND_SEPARATOR__')
      return exports
    })

    hook.watch()
    let config
    try {
      config = __non_webpack_require__(configPath)
    } catch (error) {
      throw new TailwindConfigError(error)
    }
    hook.unwatch()

    const ast = await postcss([tailwindcss(configPath)]).process(
      `
        @tailwind components;
        @tailwind utilities;
      `,
      { from: undefined }
    )

    hook.unhook()

    if (typeof userSeperator !== 'undefined') {
      dset(config, sepLocation, userSeperator)
    } else {
      delete config[sepLocation]
    }

    const resolvedConfig = resolveConfig({ cwd: configDir, config })

    return {
      version,
      configPath,
      config: resolvedConfig,
      separator: typeof userSeperator === 'undefined' ? ':' : userSeperator,
      classNames: await extractClassNames(ast),
      dependencies: hook.deps,
      plugins: getPlugins(config),
      variants: getVariants({ config, version, postcss }),
      utilityConfigMap: await getUtilityConfigMap({
        cwd: configDir,
        resolvedConfig,
        postcss,
      }),
    }
  }

  let watcher
  function watch(files = []) {
    if (watcher) watcher.close()
    watcher = chokidar
      .watch([CONFIG_GLOB, ...files], { cwd })
      .on('change', handleChange)
      .on('unlink', handleChange)
  }

  async function handleChange() {
    const prevDeps = result ? result.dependencies : []
    try {
      result = await run()
    } catch (error) {
      if (error instanceof TailwindConfigError) {
        onChange({ error })
      } else {
        onChange(null)
      }
      return
    }
    if (!arraysEqual(prevDeps, result.dependencies)) {
      watch(result.dependencies)
    }
    onChange(result)
  }

  let result
  try {
    result = await run()
  } catch (_) {
    watch()
    return null
  }

  watch(result.dependencies)

  return result
}

export { resolveConfig }
