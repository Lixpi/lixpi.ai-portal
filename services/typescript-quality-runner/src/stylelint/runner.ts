import {
    stat,
    type Stats,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import stylelint from 'stylelint'
import lixpiStylelintPlugins from './plugin.ts'

// This adapter turns repository-relative CLI paths into the file and glob inputs Stylelint
// expects inside the quality-runner container.
const repositoryDirectory = '/usr/src/repository'
const toolDirectory = '/usr/src/quality-runner'
const configFile = path.join(toolDirectory, 'stylelint.config.ts')
const supportedExtensions = new Set([
    '.css',
    '.scss',
])

// Missing paths and non-stylesheet files are harmless because one quality command receives
// mixed TypeScript, HTML, Sass, and CSS targets. Directories expand to both stylesheet forms.
const collectStylesheetPaths = async (
    inputPath: string,
    stylesheetPaths: string[],
): Promise<void> => {
    const absolutePath = path.resolve(repositoryDirectory, inputPath)
    let pathStats: Stats

    try {
        pathStats = await stat(absolutePath)
    } catch (error) {
        if (
            error instanceof Error
            && 'code' in error
            && error.code === 'ENOENT'
        )
            return

        throw error
    }

    if (pathStats.isFile()) {
        if (supportedExtensions.has(
            path.extname(absolutePath),
        ))
            stylesheetPaths.push(absolutePath)

        return
    }

    if (!pathStats.isDirectory())
        return

    const relativePath = path.relative(repositoryDirectory, absolutePath)
    stylesheetPaths.push(
        path.join(relativePath, '**/*.css'),
    )
    stylesheetPaths.push(
        path.join(relativePath, '**/*.scss'),
    )
}

// Stylelint exposes fixing as an option on the same lint operation, so the adapter accepts
// only the two modes used by the parent quality runner.
const action = process.argv[2]

if (
    action !== 'check'
    && action !== 'fix'
)
    throw new Error(`Unknown Stylelint action: ${action}`)

const stylesheetPaths: string[] = []

for (const inputPath of process.argv.slice(3))
    await collectStylesheetPaths(inputPath, stylesheetPaths)

if (stylesheetPaths.length === 0)
    process.exit(0)

const { default: repositoryConfig } = await import(pathToFileURL(configFile).href)

// Merge local plugin factories with configured package plugins without mutating the loaded
// configuration object, which can be cached by the module loader.
const result = await stylelint.lint({
    allowEmptyInput: true,
    config: {
        ...repositoryConfig,
        plugins: [...repositoryConfig.plugins, ...lixpiStylelintPlugins],
    },
    configBasedir: toolDirectory,
    cwd: repositoryDirectory,
    files: stylesheetPaths,
    fix: action === 'fix',
    formatter: 'string',
    maxWarnings: 0,
})

// Stylelint's string formatter already includes file locations and rule names. Print it
// only for failures and mirror the failure through the process exit code.
if (
    result.errored
    && result.report
)
    process.stdout.write(result.report)

if (result.errored)
    process.exitCode = 1
