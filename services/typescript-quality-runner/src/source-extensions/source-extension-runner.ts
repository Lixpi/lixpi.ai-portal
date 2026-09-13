import {
    readFile,
    readdir,
    rename,
    stat,
    writeFile,
} from 'node:fs/promises'
import {
    dirname,
    extname,
    isAbsolute,
    relative,
    resolve,
    sep,
} from 'node:path'
import { parseSync } from 'oxc-parser'
import {
    err,
    log,
} from '@lixpi/debug-tools'

// This pass enforces TypeScript-only source extensions before formatting and linting.
// In fix mode it renames JavaScript modules and updates imports that target those files.
const ignoredDirectoryNames = new Set([
    'coverage',
    'dist',
    'node_modules',
    'packages-vendor',
])
const javaScriptExtensions = new Set([
    '.cjs',
    '.js',
    '.mjs',
])
const prohibitedExtensions = new Set([
    '.jsx',
    '.tsx',
])
const testDirectoryNames = new Set([
    '__tests__',
    'mocks',
    'test',
    'tests',
    'testUtils',
])

type SourceFiles = {
    importers: string[]
    javaScriptFiles: string[]
    prohibitedFiles: string[]
}

type AstNode = {
    [key: string]: unknown
    range?: [number, number]
    type: string
}

type SourceReplacement = {
    end: number
    start: number
    value: string
}

type SourceAlias = {
    importerScope: string
    specifierPrefix: string
    targetDirectory: string
}

type SourceExtensionArguments = {
    inputPaths: string[]
    mode: 'check' | 'fix'
    sourceAliases: SourceAlias[]
}

// The parser result is intentionally narrowed to the properties used while walking
// module references, which keeps this migration pass independent of generated AST types.
const isAstNode = (value: unknown): value is AstNode => Boolean(value && typeof value === 'object' && typeof (value as AstNode).type === 'string')

// A missing range means the parser did not provide a safe source boundary for a rewrite.
const getNodeRange = (node: AstNode | null | undefined): [number, number] | null => node?.range ?? null

// Test TypeScript is excluded from import rewriting because test sources are outside the
// production quality target even when they live below a selected directory.
const isTestFile = (path: string): boolean => {
    if (
        path.endsWith('.spec.ts')
        || path.endsWith('.test.ts')
    )
        return true

    return path.split('/').some(segment => testDirectoryNames.has(segment))
}

// Collect files once so validation, collision checks, renames, and importer updates all
// operate on the same deterministic set of paths.
const collectSourceFiles = async (inputPaths: string[]): Promise<SourceFiles> => {
    const importers: string[] = []
    const javaScriptFiles: string[] = []
    const prohibitedFiles: string[] = []

    const visit = async (path: string): Promise<void> => {
        const entry = await stat(path)

        if (entry.isFile()) {
            const extension = extname(path)

            if (prohibitedExtensions.has(extension))
                prohibitedFiles.push(path)
            else if (javaScriptExtensions.has(extension)) {
                javaScriptFiles.push(path)
                importers.push(path)
            } else if (
                extension === '.ts'
                && !isTestFile(path)
            )
                importers.push(path)

            return
        }

        if (!entry.isDirectory())
            return

        const entries = await readdir(path, { withFileTypes: true })

        for (const child of entries) {
            if (
                child.isDirectory()
                && ignoredDirectoryNames.has(child.name)
            )
                continue

            await visit(
                resolve(path, child.name),
            )
        }
    }

    for (const inputPath of inputPaths)
        await visit(
            resolve(inputPath),
        )

    return {
        importers: importers.sort(),
        javaScriptFiles: javaScriptFiles.sort(),
        prohibitedFiles: prohibitedFiles.sort(),
    }
}

// Preserve the complete basename and replace only the final JavaScript extension.
const getTypeScriptPath = (path: string): string => `${path.slice(0, -extname(path).length)}.ts`

const isSourceAlias = (value: unknown): value is SourceAlias =>
    Boolean(
        value
        && typeof value === 'object'
        && typeof (value as SourceAlias).importerScope === 'string'
        && (value as SourceAlias).importerScope.length > 0
        && typeof (value as SourceAlias).specifierPrefix === 'string'
        && (value as SourceAlias).specifierPrefix.length > 0
        && typeof (value as SourceAlias).targetDirectory === 'string'
        && (value as SourceAlias).targetDirectory.length > 0,
    )

const parseSourceAliases = (serializedAliases: string): SourceAlias[] => {
    const parsedAliases: unknown = JSON.parse(serializedAliases)

    if (
        !Array.isArray(parsedAliases)
        || !parsedAliases.every(isSourceAlias)
    )
        throw new Error('Source aliases must be a JSON array of specifierPrefix, importerScope, and targetDirectory objects')

    return parsedAliases.map(
        sourceAlias => ({
            importerScope: resolve(sourceAlias.importerScope),
            specifierPrefix: sourceAlias.specifierPrefix,
            targetDirectory: resolve(sourceAlias.targetDirectory),
        }),
    )
}

const parseArguments = (arguments_: string[]): SourceExtensionArguments => {
    const [mode, ...optionsAndPaths] = arguments_

    if (
        mode !== 'check'
        && mode !== 'fix'
    )
        throw new Error('The first argument must be check or fix')

    const inputPaths: string[] = []
    const sourceAliases: SourceAlias[] = []

    for (let index = 0; index < optionsAndPaths.length; index++) {
        const argument = optionsAndPaths[index]

        if (argument === '--') {
            inputPaths.push(...optionsAndPaths.slice(index + 1))

            break
        }

        if (argument !== '--aliases') {
            inputPaths.push(argument)

            continue
        }

        const serializedAliases = optionsAndPaths.at(index + 1)

        if (!serializedAliases)
            throw new Error('--aliases requires a JSON value')

        sourceAliases.push(...parseSourceAliases(serializedAliases))
        index++
    }

    if (inputPaths.length === 0)
        throw new Error('At least one input path is required')

    return {
        inputPaths,
        mode,
        sourceAliases,
    }
}

const readArguments = (): SourceExtensionArguments => {
    try {
        return parseArguments(
            process.argv.slice(2),
        )
    } catch (error) {
        err(error instanceof Error ? error.message : String(error))
        err('Usage: source-extension-runner.ts {check|fix} [--aliases <json>] -- <path...>')
        process.exit(1)
    }
}

const isWithinDirectory = (
    path: string,
    directory: string,
): boolean => {
    const relativePath = relative(directory, path)

    return relativePath === ''
        || (
            relativePath !== '..'
            && !relativePath.startsWith(`..${sep}`)
            && !isAbsolute(relativePath)
        )
}

// Resolve only module forms whose filesystem target is known here. Package imports and
// unconfigured aliases are left unchanged because this runner cannot prove their targets.
const resolveModuleSpecifier = (
    importer: string,
    specifier: string,
    sourceAliases: SourceAlias[],
): string | null => {
    if (
        specifier.startsWith('./')
        || specifier.startsWith('../')
    )
        return resolve(
            dirname(importer),
            specifier,
        )

    const sourceAlias = sourceAliases.filter(
        alias => (
                isWithinDirectory(importer, alias.importerScope)
                && (
                    specifier === alias.specifierPrefix
                    || specifier.startsWith(`${alias.specifierPrefix}/`)
                )
            ),
    )
        .toSorted((left, right) => right.importerScope.length - left.importerScope.length)
        .at(0)

    if (sourceAlias) {
        const aliasPath = specifier === sourceAlias.specifierPrefix
            ? ''
            : specifier.slice(sourceAlias.specifierPrefix.length + 1)

        return resolve(sourceAlias.targetDirectory, aliasPath)
    }

    return null
}

// Find static imports, re-exports, dynamic imports, and type imports through one AST walk.
// Range de-duplication prevents syntax exposed through two parser properties from being
// rewritten twice.
const getModuleSpecifierNodes = (
    file: string,
    source: string,
): AstNode[] => {
    const parseResult = parseSync(
        file,
        source,
        {
            astType: 'ts',
            preserveParens: true,
            range: true,
        },
    )

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const specifiers: AstNode[] = []
    const ranges = new Set<string>()
    const visit = (node: AstNode): void => {
        const importTypeArgument = node.type === 'TSImportType'
            && isAstNode(node.argument)
            ? node.argument
            : null
        const sourceNode = isAstNode(node.source) ? node.source : importTypeArgument
        const isModuleReference = node.type === 'ImportDeclaration'
            || node.type === 'ExportAllDeclaration'
            || node.type === 'ExportNamedDeclaration'
            || node.type === 'ImportExpression'
            || node.type === 'TSImportType'
        const sourceRange = getNodeRange(sourceNode)

        if (
            isModuleReference
            && sourceNode
            && sourceRange
            && typeof sourceNode.value === 'string'
        ) {
            const rangeKey = `${sourceRange[0]}:${sourceRange[1]}`

            if (!ranges.has(rangeKey)) {
                ranges.add(rangeKey)
                specifiers.push(sourceNode)
            }
        }

        for (const [key, value] of Object.entries(node)) {
            if (key === 'range')
                continue

            if (Array.isArray(value)) {
                for (const child of value)
                    if (isAstNode(child))
                        visit(child)
            } else if (isAstNode(value))
                visit(value)
        }
    }

    visit(parseResult.program as AstNode)

    return specifiers
}

// Apply edits from right to left so earlier source offsets remain valid after each edit.
const applySourceReplacements = (
    source: string,
    replacements: SourceReplacement[],
): string => {
    let output = source

    for (const replacement of replacements.sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`

    return output
}

// Rewrite only specifiers whose resolved source file appears in the completed rename map.
// Returning whether the file changed lets the CLI report useful fix counts.
const updateModuleSpecifiers = async (
    importer: string,
    renamedFiles: Map<string, string>,
    sourceAliases: SourceAlias[],
): Promise<boolean> => {
    const source = await readFile(importer, 'utf8')
    const replacements: SourceReplacement[] = []

    for (const sourceNode of getModuleSpecifierNodes(importer, source)) {
        const sourceRange = getNodeRange(sourceNode)
        const specifier = sourceNode.value

        if (
            !sourceRange
            || typeof specifier !== 'string'
        )
            continue

        const resolvedSpecifier = resolveModuleSpecifier(
            importer,
            specifier,
            sourceAliases,
        )

        if (!resolvedSpecifier)
            continue

        const target = renamedFiles.get(resolvedSpecifier)

        if (!target)
            continue

        replacements.push({
            end: sourceRange[1],
            start: sourceRange[0],
            value: JSON.stringify(`${specifier.slice(0, -extname(specifier).length)}.ts`),
        })
    }

    const output = applySourceReplacements(source, replacements)

    if (output === source)
        return false

    await writeFile(importer, output)

    return true
}

// Validate the invocation before touching the repository. Check mode reports prohibited
// extensions; fix mode performs collision checks before any rename begins.
const {
    inputPaths,
    mode,
    sourceAliases,
} = readArguments()

const {
    importers,
    javaScriptFiles,
    prohibitedFiles,
} = await collectSourceFiles(inputPaths)

if (prohibitedFiles.length > 0) {
    for (const file of prohibitedFiles)
        err(`${file}: JSX source files are prohibited; use a .ts module and the repository DOM APIs`)

    process.exit(1)
}

if (mode === 'check') {
    if (javaScriptFiles.length === 0)
        process.exit(0)

    for (const file of javaScriptFiles)
        err(`${file}: JavaScript source files are prohibited; use a .ts extension`)

    process.exit(1)
}

const renamedFiles = new Map(
    javaScriptFiles.map(file => [file, getTypeScriptPath(file)]),
)

// Abort the whole migration if any destination already exists. This prevents a partial
// rename from overwriting an authored TypeScript module.
for (const target of renamedFiles.values()) {
    try {
        await stat(target)
        err(`${target}: cannot migrate JavaScript source because the TypeScript target already exists`)
        process.exit(1)
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            throw error
    }
}

// Rename every source before rewriting importers so all subsequent paths refer to the
// final filesystem layout.
for (const [source, target] of renamedFiles)
    await rename(source, target)

let updatedImporterCount = 0

for (const originalImporter of importers) {
    const importer = renamedFiles.get(originalImporter)
        ?? originalImporter

    if (await updateModuleSpecifiers(
        importer,
        renamedFiles,
        sourceAliases,
    ))
        updatedImporterCount++
}

if (renamedFiles.size > 0)
    log(`Migrated ${renamedFiles.size} JavaScript source file(s) to TypeScript and updated ${updatedImporterCount} importer(s).`)
