import {
    readFile,
    readdir,
    stat,
    writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseSync } from 'oxc-parser'
import {
    err,
    log,
} from '@lixpi/debug-tools'

// This runner owns the repository-specific import and export layout that Oxfmt cannot
// express: values come before types, and type-only named imports stay multiline.
const ignoredDirectoryNames = new Set([
    'coverage',
    'dist',
    'node_modules',
    'packages-vendor',
])

type CollectedTypeScriptFiles = {
    files: string[]
    prohibitedFiles: string[]
}

type AstComment = {
    end: number
    start: number
}

type AstNode = {
    [key: string]: unknown
    range?: [number, number]
    type: string
}

type NamedSpecifier = {
    isType: boolean
    text: string
}

type Replacement = {
    end: number
    start: number
    value: string
}

type CanonicalizationResult = {
    output: string
    violations: number[]
}

// Oxc nodes share a loose object shape here because this runner only needs node types
// and source ranges, not the parser's complete generated type hierarchy.
const isAstNode = (value: unknown): value is AstNode => Boolean(value && typeof value === 'object' && typeof (value as AstNode).type === 'string')

// Missing ranges make a declaration unsafe to rewrite, so callers handle null instead
// of guessing where syntax begins or ends.
const getNodeRange = (node: AstNode | null | undefined): [number, number] | null => node?.range ?? null

// Walk only authored TypeScript sources. JSX files are collected separately so the CLI
// can reject them with the repository's migration guidance.
const collectTypeScriptFiles = async (inputPaths: string[]): Promise<CollectedTypeScriptFiles> => {
    const files: string[] = []
    const prohibitedFiles: string[] = []

    const visit = async (path: string): Promise<void> => {
        const entry = await stat(path)

        if (entry.isFile()) {
            if (
                path.endsWith('.tsx')
                || path.endsWith('.jsx')
            )
                prohibitedFiles.push(path)
            else if (path.endsWith('.ts'))
                files.push(path)

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
        files: files.sort(),
        prohibitedFiles: prohibitedFiles.sort(),
    }
}

// Replacements are produced in source order and cannot overlap. Building the result in
// one pass keeps every untouched byte, including whitespace outside declarations.
const applyReplacements = (
    source: string,
    replacements: Replacement[],
): string => {
    if (replacements.length === 0)
        return source

    let output = ''
    let cursor = 0

    for (const replacement of replacements) {
        output += source.slice(cursor, replacement.start)
        output += replacement.value
        cursor = replacement.end
    }

    return output + source.slice(cursor)
}

// Declaration rewrites are withheld when comments sit inside the declaration because
// rebuilding a named clause cannot preserve a comment's exact attachment reliably.
const hasComment = (
    range: [number, number],
    comments: AstComment[],
): boolean => comments.some(comment => comment.start >= range[0] && comment.end <= range[1])

// Render the shared named-specifier shape after grouping runtime bindings before type
// bindings. A lone type import remains multiline to match the TypeScript style guide.
const getNamedSpecifierBlock = (
    specifiers: NamedSpecifier[],
    singleTypeMustBeMultiline: boolean,
): string => {
    const ordered = [
        ...specifiers.filter(specifier => !specifier.isType),
        ...specifiers.filter(specifier => specifier.isType),
    ]

    if (
        ordered.length === 1
        && (!singleTypeMustBeMultiline || !ordered[0]!.isType)
    )
        return `{ ${ordered[0]!.text} }`

    return `{\n${ordered.map(specifier => `    ${specifier.text},`).join('\n')}\n}`
}

// All reconstructed syntax comes from source ranges so aliases and quoted export names
// retain the spelling the author used.
const getNodeText = (
    node: AstNode,
    source: string,
): string => {
    const range = getNodeRange(node)

    if (!range)
        throw new Error('Oxc returned a module node without a source range')

    return source.slice(range[0], range[1]).trim()
}

// Equal identifier bindings do not need an `as` clause; non-identifiers deliberately
// return false so their exact source text is retained on both sides.
const hasSameIdentifierName = (
    left: AstNode,
    right: AstNode,
): boolean => left.type === 'Identifier'
    && right.type === 'Identifier'
    && typeof left.name === 'string'
    && left.name === right.name

// Rebuild one import specifier and add inline `type` only when the declaration itself
// is not already introduced by `import type`.
const getImportSpecifierText = (
    specifier: AstNode,
    source: string,
    typeKeywordRequired: boolean,
): string => {
    const imported = isAstNode(specifier.imported) ? specifier.imported : null
    const local = isAstNode(specifier.local) ? specifier.local : null

    if (
        !imported
        || !local
    )
        throw new Error('Oxc returned an incomplete import specifier')

    const importedText = getNodeText(imported, source)
    const localText = getNodeText(local, source)
    const binding = hasSameIdentifierName(imported, local)
        ? importedText
        : `${importedText} as ${localText}`

    return typeKeywordRequired ? `type ${binding}` : binding
}

// Export specifiers use local-to-exported alias order, which is the reverse naming role
// of an import specifier even though both render with `as`.
const getExportSpecifierText = (
    specifier: AstNode,
    source: string,
    typeKeywordRequired: boolean,
): string => {
    const local = isAstNode(specifier.local) ? specifier.local : null
    const exported = isAstNode(specifier.exported) ? specifier.exported : null

    if (
        !local
        || !exported
    )
        throw new Error('Oxc returned an incomplete export specifier')

    const localText = getNodeText(local, source)
    const exportedText = getNodeText(exported, source)
    const binding = hasSameIdentifierName(local, exported)
        ? localText
        : `${localText} as ${exportedText}`

    return typeKeywordRequired ? `type ${binding}` : binding
}

// Canonicalize only named portions of an import. Default and namespace specifiers stay
// intact and remain ahead of the rebuilt named block.
const canonicalizeImportDeclaration = (
    node: AstNode,
    source: string,
): string | null => {
    const nodeRange = getNodeRange(node)
    const sourceNode = isAstNode(node.source) ? node.source : null
    const sourceRange = getNodeRange(sourceNode)
    const specifiers = Array.isArray(node.specifiers) ? node.specifiers.filter(isAstNode) : []
    const namedSpecifiers = specifiers.filter(specifier => specifier.type === 'ImportSpecifier')

    if (
        !nodeRange
        || !sourceRange
        || namedSpecifiers.length === 0
    )
        return null

    const declarationIsTypeOnly = node.importKind === 'type'
    const named = namedSpecifiers.map(
        (specifier): NamedSpecifier => {
            const isType = (
                declarationIsTypeOnly
                || specifier.importKind === 'type'
            )

            return {
                isType,
                text: getImportSpecifierText(
                    specifier,
                    source,
                    isType && !declarationIsTypeOnly,
                ),
            }
        },
    )
    const clauseParts = specifiers.filter(specifier => specifier.type !== 'ImportSpecifier').map(specifier => getNodeText(specifier, source))
    clauseParts.push(
        getNamedSpecifierBlock(named, true),
    )

    const sourceText = source.slice(sourceRange[0], sourceRange[1])
    const suffix = source.slice(sourceRange[1], nodeRange[1])

    return `import${declarationIsTypeOnly ? ' type' : ''} ${clauseParts.join(', ')} from ${sourceText}${suffix}`
}

// Canonicalize specifier exports, but leave `export const`, `export class`, and other
// declaration exports alone because they do not contain a named-specifier list.
const canonicalizeExportDeclaration = (
    node: AstNode,
    source: string,
): string | null => {
    const nodeRange = getNodeRange(node)
    const specifiers = Array.isArray(node.specifiers) ? node.specifiers.filter(isAstNode) : []

    if (
        !nodeRange
        || specifiers.length === 0
        || isAstNode(node.declaration)
    )
        return null

    const declarationIsTypeOnly = node.exportKind === 'type'
    const named = specifiers.map(
        (specifier): NamedSpecifier => {
            const isType = (
                declarationIsTypeOnly
                || specifier.exportKind === 'type'
            )

            return {
                isType,
                text: getExportSpecifierText(
                    specifier,
                    source,
                    isType && !declarationIsTypeOnly,
                ),
            }
        },
    )
    const sourceNode = isAstNode(node.source) ? node.source : null
    const sourceRange = getNodeRange(sourceNode)
    const sourceClause = sourceRange ? ` from ${source.slice(sourceRange[0], sourceRange[1])}` : ''
    const suffix = sourceRange ? source.slice(sourceRange[1], nodeRange[1]) : ''

    return `export${declarationIsTypeOnly ? ' type' : ''} ${getNamedSpecifierBlock(named, false)}${sourceClause}${suffix}`
}

// Parse one module, report every declaration whose layout differs, and optionally apply
// the same canonical text. Check and fix therefore use one definition of correctness.
export const canonicalizeImportLayout = (
    source: string,
    fix: boolean,
    file = 'module.ts',
): CanonicalizationResult => {
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

    const comments = parseResult.comments as AstComment[]
    const body = Array.isArray(parseResult.program.body) ? parseResult.program.body.filter(isAstNode) : []
    const replacements: Replacement[] = []
    const violations: number[] = []

    for (const node of body) {
        if (
            node.type !== 'ImportDeclaration'
            && node.type !== 'ExportNamedDeclaration'
        )
            continue

        const range = getNodeRange(node)

        if (
            !range
            || hasComment(range, comments)
        )
            continue

        const canonical = node.type === 'ImportDeclaration'
            ? canonicalizeImportDeclaration(node, source)
            : canonicalizeExportDeclaration(node, source)

        if (
            canonical == null
            || canonical === source.slice(range[0], range[1])
        )
            continue

        violations.push(source.slice(0, range[0]).split('\n').length)

        if (fix)
            replacements.push({
                end: range[1],
                start: range[0],
                value: canonical,
            })
    }

    return {
        output: fix ? applyReplacements(source, replacements) : source,
        violations,
    }
}

// The standalone CLI applies the canonicalizer recursively and turns collected line
// numbers into actionable diagnostics during check mode.
const runCli = async (): Promise<void> => {
    const [mode, ...inputPaths] = process.argv.slice(2)

    if (
        (mode !== 'check' && mode !== 'fix')
        || inputPaths.length === 0
    ) {
        err('Usage: import-specifier-order.ts {check|fix} <path...>')
        process.exit(1)
    }

    const {
        files,
        prohibitedFiles,
    } = await collectTypeScriptFiles(inputPaths)

    if (prohibitedFiles.length > 0) {
        for (const file of prohibitedFiles)
            err(`${file}: JSX source files are prohibited; use a .ts module and the repository DOM APIs`)

        process.exit(1)
    }

    let violationCount = 0
    let fixedFileCount = 0

    for (const file of files) {
        const source = await readFile(file, 'utf8')
        const {
            output,
            violations,
        } = canonicalizeImportLayout(
            source,
            mode === 'fix',
            file,
        )
        violationCount += violations.length

        if (
            mode === 'fix'
            && output !== source
        ) {
            await writeFile(file, output)
            fixedFileCount++

            continue
        }

        if (mode === 'check') for (const line of violations)
            err(`${file}:${line}: named imports and exports must use the repository value/type layout`)
    }

    if (mode === 'fix') {
        if (fixedFileCount > 0)
            log(`Fixed named import and export layout in ${fixedFileCount} files.`)

        return
    }

    if (violationCount > 0) {
        err(`Found ${violationCount} named import and export layout violation(s).`)
        process.exit(1)
    }
}

// Keep the canonicalizer importable by the TypeScript formatter without running its CLI
// entry point as a side effect.
const invokedPath = process.argv[1]

if (
    invokedPath
    && import.meta.url === pathToFileURL(
        resolve(invokedPath),
    ).href
)
    await runCli()
