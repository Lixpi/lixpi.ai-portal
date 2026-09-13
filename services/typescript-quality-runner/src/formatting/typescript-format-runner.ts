import {
    readFile,
    readdir,
    stat,
    writeFile,
} from 'node:fs/promises'
import {
    extname,
    resolve,
} from 'node:path'
import {
    format,
    type FormatConfig,
} from 'oxfmt'
import { parseSync } from 'oxc-parser'
import {
    parse,
    parseFragment,
} from 'parse5'
import {
    err,
    log,
} from '@lixpi/debug-tools'
import { canonicalizeImportLayout } from './import-specifier-order.ts'

// Oxfmt provides the baseline parse-aware format. This runner layers repository layouts
// that Oxfmt cannot configure and preserves deliberate multiline structures it would fold.
const ignoredDirectoryNames = new Set([
    'coverage',
    'dist',
    'node_modules',
    'packages-vendor',
])
const formattedExtensions = new Set([
    '.html',
    '.ts',
])
const testDirectoryNames = new Set([
    '__tests__',
    'mocks',
    'test',
    'tests',
    'testUtils',
])
const compactIfStatementTypes = new Set([
    'BreakStatement',
    'ContinueStatement',
    'ExpressionStatement',
    'ReturnStatement',
    'ThrowStatement',
])
const separatedBlockStatementTypes = new Set([
    'BlockStatement',
    'DoWhileStatement',
    'ForInStatement',
    'ForOfStatement',
    'ForStatement',
    'IfStatement',
    'SwitchStatement',
    'TryStatement',
    'WhileStatement',
    'WithStatement',
])
const separatedControlFlowStatementTypes = new Set([
    'BreakStatement',
    'ContinueStatement',
    'ReturnStatement',
    'ThrowStatement',
])

// Statement spacing uses the same classification for block constructs and terminating
// control flow so a blank line is required when either neighboring statement forms a group.
const isSeparatedStatementType = (type: string): boolean => separatedBlockStatementTypes.has(type)
    || separatedControlFlowStatementTypes.has(type)

// Iterator calls are the only fluent chains this runner length-wraps. Other member chains
// retain Oxfmt's layout unless another explicit repository rule owns them.
const iteratorMethodNames = new Set([
    'drop',
    'entries',
    'every',
    'filter',
    'find',
    'findIndex',
    'findLast',
    'findLastIndex',
    'flatMap',
    'forEach',
    'keys',
    'map',
    'reduce',
    'reduceRight',
    'some',
    'take',
    'toArray',
    'values',
])
const maximumInlineArrowFunctionLength = 150

// One indentation step, matching oxfmt's tabWidth.
const indentationWidth = 4

// A call stays on one line only while its line fits this width.
const maximumInlineCallLength = 150
const maximumInlineIteratorChainLength = 150

// These shared shapes describe source spans and the small AST and HTML subsets used by the
// formatter passes. Every rewrite is range-based so unrelated source remains byte-for-byte.
type FormattingFiles = {
    files: string[]
    prohibitedFiles: string[]
}

type LayoutSpan = {
    end: number
    preserve?: boolean
    start: number
    text: string
}

type AstNode = {
    [key: string]: unknown
    loc?: {
        end: {
            column: number
            line: number
        }
        start: {
            column: number
            line: number
        }
    }
    range?: [number, number]
    type: string
}

type AstComment = {
    end: number
    start: number
}

type HtmlAttributeLocation = {
    endOffset: number
    startOffset: number
}

type HtmlNode = {
    attrs?: unknown[]
    childNodes?: HtmlNode[]
    content?: HtmlNode
    sourceCodeLocation?: {
        attrs?: Record<string, HtmlAttributeLocation>
        startTag?: HtmlAttributeLocation
    }
}

type HtmlTemplateContent = {
    end: number
    interpolationRanges: Array<[number, number]>
    indentation: string
    start: number
}

type HtmlTemplateQuasi = {
    span: LayoutSpan
    templateStart: number
}

type CallChainSegment = {
    boundaryEnd: number
    boundaryStart: number
    isIterator: boolean
    leadingWhitespace: string
    text: string
}

type CallChain = {
    base: AstNode
    iteratorCount: number
    segments: CallChainSegment[]
}

type TypeScriptLayouts = {
    arrays: LayoutSpan[]
    binaryExpressions: LayoutSpan[]
    callArguments: LayoutSpan[]
    callChains: LayoutSpan[]
    conditionalExpressions: LayoutSpan[]
    functionParameters: LayoutSpan[]
    objectBindings: LayoutSpan[]
    objects: LayoutSpan[]
    types: LayoutSpan[]
}

// Production formatting excludes tests even when a selected source root contains them.
// Tests have their own runner and formatting contract.
const isTestFile = (path: string): boolean => {
    if (
        path.endsWith('.spec.ts')
        || path.endsWith('.test.ts')
    )
        return true

    return path.split('/').some(segment => testDirectoryNames.has(segment))
}

// Recursively collect supported authored sources and separately record JSX, which the
// repository prohibits and must diagnose instead of silently ignoring.
const collectFormattingFiles = async (inputPaths: string[]): Promise<FormattingFiles> => {
    const files: string[] = []
    const prohibitedFiles: string[] = []

    const visit = async (path: string): Promise<void> => {
        const entry = await stat(path)

        if (entry.isFile()) {
            const extension = extname(path)

            if (
                extension === '.jsx'
                || extension === '.tsx'
            )
                prohibitedFiles.push(path)
            else if (
                formattedExtensions.has(extension)
                && !isTestFile(path)
            )
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

// Oxfmt's API rejects CLI-only metadata, so remove schema and ignore settings after loading
// the shared JSON config. File selection is already handled by this runner.
const readFormatConfig = async (): Promise<FormatConfig> => {
    const config = JSON.parse(await readFile('/usr/src/quality-runner/oxfmt.json', 'utf8')) as FormatConfig
    delete config.$schema
    delete config.ignorePatterns

    return config
}

// A null range forces callers to skip or fail a rewrite instead of inventing source bounds.
const getNodeRange = (node: AstNode | null | undefined): [number, number] | null => node?.range ?? null

// Line-boundary helpers are offset-based because every parser node is represented by source
// ranges rather than line-oriented text matches.
const getLineStart = (
    source: string,
    offset: number,
): number => source.lastIndexOf('\n', offset - 1) + 1

// Return the first source offset after the next line break, or -1 when no later line exists.
const getNextLineStart = (
    source: string,
    offset: number,
): number => {
    const lineBreak = source.indexOf('\n', offset)

    return lineBreak < 0 ? -1 : lineBreak + 1
}

// Read the existing indentation prefix so local layout fixes do not impose whitespace on
// neighboring syntax that they do not own.
const getLineIndentation = (
    source: string,
    offset: number,
): string => {
    const lineStart = getLineStart(source, offset)
    let cursor = lineStart

    while (
        source[cursor] === ' '
        || source[cursor] === '\t'
    )
        cursor++

    return source.slice(lineStart, cursor)
}

// Whitespace boundary scans include newlines because layout spans deliberately absorb the
// padding that their replacement is responsible for rebuilding.
const isWhitespaceCharacter = (character: string | undefined): boolean => character === ' '
    || character === '\t'
    || character === '\n'
    || character === '\r'

// Move backward to the last non-whitespace byte within a bounded syntax region.
const getTrailingWhitespaceStart = (
    source: string,
    start: number,
    end: number,
): number => {
    let cursor = end

    while (
        cursor > start
        && isWhitespaceCharacter(source[cursor - 1])
    )
        cursor--

    return cursor
}

// Move forward past leading whitespace without crossing the caller's syntax boundary.
const getLeadingWhitespaceEnd = (
    source: string,
    start: number,
    end: number,
): number => {
    let cursor = start

    while (
        cursor < end
        && isWhitespaceCharacter(source[cursor])
    )
        cursor++

    return cursor
}

// Capture replacement text together with stable source bounds. `preserve` records layouts
// whose multiline shape matters even when their text happens to fit on one line.
const getLayoutSpan = (
    start: number,
    end: number,
    source: string,
    preserve = false,
): LayoutSpan => ({
    end,
    preserve,
    start,
    text: source.slice(start, end),
})

// Shift continuation lines by the difference between old and new base indentation while
// never removing indentation that is part of a nested line's own structure.
const reindentNodeText = (
    source: string,
    nodeRange: [number, number],
    indentation: string,
): string => {
    const originalIndentation = getLineIndentation(source, nodeRange[0])
    const indentationDifference = indentation.length - originalIndentation.length
    const lines = source.slice(nodeRange[0], nodeRange[1]).split('\n')

    for (let index = 1; index < lines.length; index++) {
        const line = lines[index]!

        if (indentationDifference > 0)
            lines[index] = `${' '.repeat(indentationDifference)}${line}`
        else
            lines[index] = line.slice(
                Math.min(-indentationDifference, line.length - line.trimStart().length),
            )
    }

    return lines.join('\n')
}

// Function parameter spans authored across lines are always preserved through Oxfmt so a
// deliberate expanded signature is not collapsed based on width.
const hasMultilineFunctionParameters = (
    node: AstNode,
    source: string,
): boolean => {
    if (!Array.isArray(node.params))
        return false

    const parameters = node.params.filter(isAstNode)
    const firstParameter = parameters[0]
    const lastParameter = parameters.at(-1)
    const firstParameterRange = getNodeRange(firstParameter)
    const lastParameterRange = getNodeRange(lastParameter)

    return Boolean(
        firstParameterRange
        && lastParameterRange
        && getLineStart(source, firstParameterRange[0]) !== getLineStart(source, lastParameterRange[1] - 1),
    )
}

// Preserve a function signature only through its last non-whitespace byte before the body;
// the body and its separating whitespace belong to later formatter passes.
const getFunctionParameterSpan = (
    node: AstNode,
    source: string,
): LayoutSpan | null => {
    const nodeRange = getNodeRange(node)
    const bodyRange = getNodeRange(node.body as AstNode)

    if (
        !nodeRange
        || !bodyRange
    )
        return null

    const signatureEnd = getTrailingWhitespaceStart(
        source,
        nodeRange[0],
        bodyRange[0],
    )

    return getLayoutSpan(
        nodeRange[0],
        signatureEnd,
        source,
        hasMultilineFunctionParameters(node, source),
    )
}

// Calls and constructors use their complete node range because their closing parenthesis is
// part of argument-list layout and must move with the list.
const getCallArgumentSpan = (
    node: AstNode,
    source: string,
): LayoutSpan | null => {
    const nodeRange = getNodeRange(node)

    if (!nodeRange)
        return null

    return getLayoutSpan(
        nodeRange[0],
        nodeRange[1],
        source,
    )
}

// AST traversal uses a minimal structural predicate instead of relying on generated Oxc
// unions for every syntax proposal supported by the parser.
const isAstNode = (value: unknown): value is AstNode => Boolean(value && typeof value === 'object' && typeof (value as AstNode).type === 'string')

// Type annotations and generic arguments retain authored expansion. Alias right-hand sides
// are included because union and object type layout carries meaning beyond print width.
const isPreservedTypeNode = (
    node: AstNode,
    parent: AstNode | null,
    parentKey: string,
): boolean => node.type === 'TSTypeAnnotation'
    || node.type === 'TSTypeParameterDeclaration'
    || node.type === 'TSTypeParameterInstantiation'
    || (parent?.type === 'TSTypeAliasDeclaration' && parentKey === 'typeAnnotation')

// Every layout pass parses the same text with the same options, and most passes leave
// their input untouched, so the chain would otherwise re-parse an unchanged file once
// per pass. Holding on to the most recent result turns that into a single parse.
let lastParsedFile: string | null = null
let lastParsedSource: string | null = null
let lastParseResult: ReturnType<typeof parseSync> | null = null

// Parse with parentheses and ranges preserved because later rules use both to distinguish
// authored grouping from parser precedence and to produce surgical replacements.
const parseTypeScript = (
    file: string,
    source: string,
): ReturnType<typeof parseSync> => {
    if (
        lastParseResult
        && lastParsedFile === file
        && lastParsedSource === source
    )
        return lastParseResult

    const parseResult = parseSync(
        file,
        source,
        {
            astType: 'ts',
            preserveParens: true,
            range: true,
        },
    )
    lastParsedFile = file
    lastParsedSource = source
    lastParseResult = parseResult

    return parseResult
}

// Record every syntax region whose multiline shape may need restoration after Oxfmt. Nodes
// inside control-flow tests are excluded because the condition formatter owns those ranges.
const collectTypeScriptLayouts = (
    file: string,
    source: string,
): TypeScriptLayouts => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const layouts: TypeScriptLayouts = {
        arrays: [],
        binaryExpressions: [],
        callArguments: [],
        callChains: [],
        conditionalExpressions: [],
        functionParameters: [],
        objectBindings: [],
        objects: [],
        types: [],
    }

    const visit = (
        node: AstNode,
        parent: AstNode | null = null,
        grandparent: AstNode | null = null,
        parentKey = '',
        insideCondition = false,
    ): void => {
        const nodeRange = getNodeRange(node)
        const body = node.body as AstNode | undefined
        const bodyRange = getNodeRange(body)

        if (
            !insideCondition
            && Array.isArray(node.params)
            && bodyRange
        ) {
            const span = getFunctionParameterSpan(node, source)

            if (span)
                layouts.functionParameters.push(span)
        }

        if (
            !insideCondition
            && (node.type === 'CallExpression' || node.type === 'NewExpression')
        ) {
            const span = getCallArgumentSpan(node, source)

            if (span)
                layouts.callArguments.push(span)
        }

        if (
            !insideCondition
            && node.type === 'CallExpression'
            && (node.callee as AstNode | undefined)?.type === 'MemberExpression'
            && nodeRange
        ) {
            const isNestedChain = parent?.type === 'MemberExpression'
                && parent.object === node
                && grandparent?.type === 'CallExpression'
                && grandparent.callee === parent

            if (!isNestedChain)
                layouts.callChains.push(
                    getLayoutSpan(
                        nodeRange[0],
                        nodeRange[1],
                        source,
                    ),
                )
        }

        if (
            !insideCondition
            && node.type === 'ObjectPattern'
            && nodeRange
        )
            layouts.objectBindings.push(
                getLayoutSpan(
                    nodeRange[0],
                    nodeRange[1],
                    source,
                ),
            )

        if (
            !insideCondition
            && node.type === 'ArrayExpression'
            && nodeRange
        )
            layouts.arrays.push(
                getLayoutSpan(
                    nodeRange[0],
                    nodeRange[1],
                    source,
                ),
            )

        if (
            !insideCondition
            && (node.type === 'BinaryExpression' || node.type === 'LogicalExpression')
            && nodeRange
        )
            layouts.binaryExpressions.push(
                getLayoutSpan(
                    nodeRange[0],
                    nodeRange[1],
                    source,
                ),
            )

        if (
            !insideCondition
            && node.type === 'ConditionalExpression'
            && nodeRange
        ) {
            const parenthesized = parent?.type === 'ParenthesizedExpression'
            const expressionRange = parenthesized ? getNodeRange(parent) : nodeRange

            if (expressionRange)
                layouts.conditionalExpressions.push(
                    getLayoutSpan(
                        expressionRange[0],
                        expressionRange[1],
                        source,
                        parenthesized,
                    ),
                )
        }

        if (
            !insideCondition
            && node.type === 'ObjectExpression'
            && nodeRange
        )
            layouts.objects.push(
                getLayoutSpan(
                    nodeRange[0],
                    nodeRange[1],
                    source,
                ),
            )

        if (
            !insideCondition
            && isPreservedTypeNode(
                node,
                parent,
                parentKey,
            )
            && nodeRange
            && parent?.type !== 'TSTypeAnnotation'
        ) {
            let start = nodeRange[0]

            while (
                start > 0
                && isWhitespaceCharacter(source[start - 1])
            )
                start--

            layouts.types.push(
                getLayoutSpan(
                    start,
                    nodeRange[1],
                    source,
                ),
            )
        }

        for (const [key, value] of Object.entries(node)) {
            if (key === 'range')
                continue

            const childInsideCondition = insideCondition
                || (
                    key === 'test'
                    && (
                        node.type === 'ConditionalExpression'
                        || node.type === 'DoWhileStatement'
                        || node.type === 'ForStatement'
                        || node.type === 'IfStatement'
                        || node.type === 'WhileStatement'
                    )
                )

            if (Array.isArray(value)) {
                for (const child of value)
                    if (isAstNode(child))
                        visit(
                            child,
                            node,
                            parent,
                            key,
                            childInsideCondition,
                        )
            } else if (isAstNode(value))
                visit(
                    value,
                    node,
                    parent,
                    key,
                    childInsideCondition,
                )
        }
    }

    visit(parseResult.program as AstNode)

    return layouts
}

// Restore preserved text at its new base indentation and enforce enough indentation for
// continuation content to remain visibly nested beneath its opening syntax.
const reindentLayoutText = (
    originalSource: string,
    original: LayoutSpan,
    formattedSource: string,
    target: LayoutSpan,
    layoutType: keyof TypeScriptLayouts,
): string => {
    const originalIndentation = getLineIndentation(originalSource, original.start)
    const targetIndentation = getLineIndentation(formattedSource, target.start)
    const indentationDifference = targetIndentation.length - originalIndentation.length

    const lines = original.text.split('\n')

    for (let index = 1; index < lines.length; index++) {
        let line = lines[index]!

        if (indentationDifference > 0)
            line = `${' '.repeat(indentationDifference)}${line}`
        else
            line = line.slice(
                Math.min(-indentationDifference, line.length - line.trimStart().length),
            )

        const trimmed = line.trimStart()

        if (trimmed.length > 0) {
            const firstCharacter = trimmed[0]!
            const alignsWithLayout = ')]}>'.includes(firstCharacter)
                || (
                    layoutType === 'types'
                    && '|&'.includes(firstCharacter)
                )
            const minimumIndentation = targetIndentation.length + (alignsWithLayout ? 0 : 4)
            const indentation = line.length - trimmed.length

            if (indentation < minimumIndentation)
                line = `${' '.repeat(minimumIndentation)}${trimmed}`
        }

        lines[index] = line
    }

    return lines.join('\n')
}

// Match original and formatted layouts by AST traversal order, then restore only outermost
// non-overlapping spans. This preserves authored expansion without producing conflicting edits.
const preserveExpandedTypeScriptLayouts = (
    file: string,
    source: string,
    formatted: string,
): string => {
    const originalLayouts = collectTypeScriptLayouts(file, source)
    const formattedLayouts = collectTypeScriptLayouts(file, formatted)
    const replacements: LayoutSpan[] = []

    for (const key of Object.keys(originalLayouts) as Array<keyof TypeScriptLayouts>) {
        const originalSpans = originalLayouts[key]
        const formattedSpans = formattedLayouts[key]

        if (originalSpans.length !== formattedSpans.length)
            throw new Error(`Oxfmt changed the ${key} syntax shape in ${file}`)

        for (let index = 0; index < originalSpans.length; index++) {
            const original = originalSpans[index]!

            const shouldPreserve = key === 'types'
                || original.preserve
                || (
                    key !== 'functionParameters'
                    && original.text.includes('\n')
                )

            if (!shouldPreserve)
                continue

            const target = formattedSpans[index]!
            replacements.push({
                start: target.start,
                end: target.end,
                text: reindentLayoutText(
                    source,
                    original,
                    formatted,
                    target,
                    key,
                ),
            })
        }
    }

    const nonOverlappingReplacements: LayoutSpan[] = []

    for (const replacement of replacements.sort((left, right) => right.end - right.start - (left.end - left.start) || left.start - right.start)) {
        const overlapsSelectedReplacement = nonOverlappingReplacements.some(
            candidate => replacement.start < candidate.end && replacement.end > candidate.start,
        )

        if (!overlapsSelectedReplacement)
            nonOverlappingReplacements.push(replacement)
    }

    let output = formatted

    for (const replacement of nonOverlappingReplacements.sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// Extract the parameter or argument nodes from syntax that owns a parenthesized list. Other
// node kinds return null so list canonicalization does not claim unrelated parentheses.
const getDelimitedListItems = (node: AstNode): AstNode[] | null => {
    if (Array.isArray(node.params))
        return node.params.filter(isAstNode)

    if (
        (node.type === 'CallExpression' || node.type === 'NewExpression')
        && Array.isArray(node.arguments)
    )
        return node.arguments.filter(isAstNode)

    return null
}

// A call whose member chain broke before its property sits on its own line, so its
// arguments and closing parenthesis anchor to that property rather than to the start
// of the chain. Every other call anchors to its own start. Anchoring to the end of
// the callee instead would read the indentation of a continuation line that this
// same pass produces, and the two would push each other one level deeper on every
// pass.
const getDelimitedListAnchor = (
    node: AstNode,
    nodeRange: [number, number],
    source: string,
): number => {
    if (
        node.type !== 'CallExpression'
        && node.type !== 'NewExpression'
    )
        return nodeRange[0]

    const callee = node.callee as AstNode | undefined

    if (callee?.type !== 'MemberExpression')
        return nodeRange[0]

    const objectRange = getNodeRange(callee.object as AstNode | undefined)
    const propertyRange = getNodeRange(callee.property as AstNode | undefined)

    if (
        !objectRange
        || !propertyRange
    )
        return nodeRange[0]

    return getLineStart(source, objectRange[1]) === getLineStart(source, propertyRange[0])
        ? nodeRange[0]
        : propertyRange[0]
}

// One or two items belong on the call or signature line, so a list left expanded by an
// earlier layout is joined back up. A list is only joined when every item is already a
// single line and the joined line still fits Oxfmt's print width, because Oxfmt would
// otherwise break the line again on the next run and the two would never agree.
const isCallLikeNode = (node: AstNode | null | undefined): boolean => node?.type === 'CallExpression'
    || node?.type === 'NewExpression'

// Collection constructors delegate layout to the array initializer inside them, preventing
// the generic argument formatter from adding a redundant outer level of expansion.
const collectionConstructorNames = new Set([
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
])

// `new Map([...])` and its siblings are laid out by Oxlint's collection rule, which puts
// the elements inside the array's own brackets. Splitting the constructor's argument list
// as well would give the two rules different answers for the same call.
// A lone argument or parameter whose own braces carry the content keeps those braces on
// the call or signature line, so one options bag reads as `f({` and closes on `})` rather
// than opening two brackets on two separate lines for the same item. A parameter counts by
// its type literal, since `params: { ... }` is one item however that type is written.
// `const handle = (a, b) => {}` and a class field written the same way are function
// definitions with a name, so they lay out like a declaration rather than like an
// argument.
const isNamedFunctionDefinition = (
    node: AstNode,
    parent: AstNode | null,
): boolean => (parent?.type === 'VariableDeclarator' && parent.init === node)
    || (parent?.type === 'PropertyDefinition' && parent.value === node)

// A callback whose body is an expression rather than a block has no braces of its own to
// open the call, so once it spans lines it needs a line of its own. A block-bodied
// callback keeps hugging the call, since its braces already do that job.
const isMultilineExpressionBodiedFunction = (
    node: AstNode,
    source: string,
): boolean => {
    if (
        node.type !== 'ArrowFunctionExpression'
        && node.type !== 'FunctionExpression'
    )
        return false

    const body = node.body as AstNode | undefined
    const bodyRange = getNodeRange(body)

    // The body itself has to span lines. Measuring the whole arrow would also count a
    // body the arrow-body rule merely pushed onto the following line, and the two rules
    // would then take turns undoing each other.
    return body?.type !== 'BlockStatement'
        && bodyRange != null
        && source.slice(bodyRange[0], bodyRange[1]).includes('\n')
}

// A name, a literal, or a property path made of them. There is no inner structure for a
// line break to reveal.
const isAtomicItem = (node: AstNode | null | undefined): boolean => {
    if (
        node?.type === 'Identifier'
        || node?.type === 'Literal'
        || node?.type === 'ThisExpression'
        || node?.type === 'Super'
    )
        return true

    if (node?.type !== 'MemberExpression')
        return false

    return isAtomicItem(node.object as AstNode | undefined)
        && (
            node.computed !== true
            || isAtomicItem(node.property as AstNode | undefined)
        )
}

// A trailing block callback supplies its own visual boundary, so the surrounding argument
// list does not need to split solely because the callback spans lines.
const endsWithBlockBodiedFunction = (items: AstNode[]): boolean => {
    const last = items.at(-1)

    return (
        last?.type === 'ArrowFunctionExpression'
        || last?.type === 'FunctionExpression'
    )
        && (last.body as AstNode | undefined)?.type === 'BlockStatement'
}

// A sole object, array, destructuring pattern, or inline object type can hug the surrounding
// parentheses because its own delimiters already expose the nested structure.
const isHuggableItem = (node: AstNode | null | undefined): boolean => {
    if (
        node?.type === 'ObjectExpression'
        || node?.type === 'ArrayExpression'
        || node?.type === 'ObjectPattern'
        || node?.type === 'ArrayPattern'
    )
        return true

    const annotation = node?.typeAnnotation as AstNode | undefined
    const annotatedType = annotation?.typeAnnotation as AstNode | undefined

    return annotatedType?.type === 'TSTypeLiteral'
}

// Recognize collection constructors whose sole array argument is formatted by the dedicated
// collection rule, so this pass does not create a second incompatible layout.
const isCollectionInitializer = (node: AstNode): boolean => {
    if (node.type !== 'NewExpression')
        return false

    const callee = node.callee as AstNode | undefined
    const args = Array.isArray(node.arguments) ? node.arguments.filter(isAstNode) : []

    return callee?.type === 'Identifier'
        && typeof callee.name === 'string'
        && collectionConstructorNames.has(callee.name)
        && args.length === 1
        && args[0]?.type === 'ArrayExpression'
}

// The joined text of a list, or null when an item spans lines and so cannot be joined
// without flattening a structure its author expanded on purpose.
const getCollapsedDelimitedListText = (
    source: string,
    itemRanges: Array<[number, number]>,
): string | null => {
    const itemTexts = itemRanges.map(range => source.slice(range[0], range[1]))

    return itemTexts.some(text => text.includes('\n')) ? null : itemTexts.join(', ')
}

// A node's text with every line break inside it closed up, which is what the node would
// measure if nothing within it were split. The width test reads this rather than the
// text as it currently stands, so a list's own decision never moves when a list nested
// inside it splits or joins, and the two cannot push each other back and forth forever.
const getInlineNodeText = (
    source: string,
    range: [number, number],
): string => {
    let output = ''
    let index = range[0]

    while (index < range[1]) {
        const character = source[index]!

        if (character !== '\n') {
            output += character
            index++

            continue
        }

        index++

        while (
            index < range[1]
            && isWhitespaceCharacter(source[index])
        )
            index++

        const next = source[index]
        const closesContainer = next === ')'
            || next === ']'
            || next === '}'

        if (
            output.endsWith(',')
            && closesContainer
        )
            output = output.slice(0, -1)
        else if (
            output.length > 0
            && !output.endsWith(' ')
        )
            output += ' '
    }

    return output
}

// Statement-like nodes reset the line-width anchor used for nested argument lists. Class
// fields and methods count because their initializers and signatures begin new source lines.
const isStatementNode = (node: AstNode): boolean => node.type.endsWith('Statement')
    || node.type.endsWith('Declaration')
    || node.type === 'PropertyDefinition'
    || node.type === 'MethodDefinition'

// Range-based multiline detection is used after parsing so comments and string contents do
// not get mistaken for structural line breaks outside the node.
const spansLines = (
    source: string,
    node: AstNode,
): boolean => {
    const range = getNodeRange(node)

    return range != null && source.slice(range[0], range[1]).includes('\n')
}

// The column a list's closing bracket would land on with everything inside it closed up.
// The opening bracket does not move when the list splits, and the items are measured from
// their own text rather than from the lines they currently occupy, so the answer is the
// same either way and a list cannot argue with itself from one pass to the next.
const getInlineListWidth = (
    source: string,
    start: number,
    itemRanges: Array<[number, number]>,
): number => start - getLineStart(source, start)
    + itemRanges.map(range => getInlineNodeText(source, range)).join(', ').length
    + 1

// Canonicalize one AST snapshot of every parameter and argument list. Only non-overlapping
// outer replacements are applied because nested widths must be recalculated on the next pass.
const canonicalizeDelimitedListsOnce = (
    file: string,
    source: string,
    printWidth: number,
): string => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const comments = parseResult.comments as AstComment[]
    const replacements: LayoutSpan[] = []
    const visit = (
        node: AstNode,
        statementStart: number,
        parent: AstNode | null,
    ): void => {
        const nodeRange = getNodeRange(node)
        const items = getDelimitedListItems(node)
        const ownStatementStart = isStatementNode(node)
            && nodeRange
            ? nodeRange[0]
            : statementStart

        if (
            nodeRange
            && items
            && items.length > 0
        ) {
            const itemRanges = items.map(getNodeRange)
            const firstRange = itemRanges[0]
            const lastRange = itemRanges.at(-1)

            if (
                firstRange
                && lastRange
                && itemRanges.every(range => range != null)
            ) {
                const start = getTrailingWhitespaceStart(
                    source,
                    nodeRange[0],
                    firstRange[0],
                )
                const trailingCommaEnd = source[lastRange[1]] === ','
                    ? lastRange[1] + 1
                    : lastRange[1]
                const end = getLeadingWhitespaceEnd(
                    source,
                    trailingCommaEnd,
                    nodeRange[1],
                )
                // A parameter list written without parentheses, such as `async request =>`,
                // has no brackets to lay out, and rewriting the span would eat the space
                // that separates the parameter from what comes before it.
                const isBracketed = source[start - 1] === '(' && source[end] === ')'
                const hasInterItemComment = isBracketed && comments.some(
                    comment =>
                        comment.start >= start
                        && comment.end <= end
                        && !itemRanges.some(range => range != null && comment.start >= range[0] && comment.end <= range[1]),
                )
                const isCall = isCallLikeNode(node)
                const collapsed = getCollapsedDelimitedListText(source, itemRanges as Array<[number, number]>)
                const lineLimit = isCall ? maximumInlineCallLength : printWidth
                // A call is split when it carries more than two arguments, when one of its
                // arguments is itself a call, or when writing its statement out on one
                // line would carry it past the limit. A call nested inside it is measured
                // the same way, so a long expression splits from the outside in.
                // A signature splits at two parameters, a call at three arguments. An arrow
                // written inline, as a callback or a branch of an expression, counts as a
                // call: splitting `(state, dispatch) =>` across lines buys nothing. An
                // arrow bound to a name is a function definition and splits like one.
                const isInlineArrow = node.type === 'ArrowFunctionExpression'
                    && !isNamedFunctionDefinition(node, parent)
                const inlineItemLimit = isCall
                    || isInlineArrow
                    ? 2
                    : 1
                const mustSplit = isBracketed
                    && !isCollectionInitializer(node)
                    && (items.length > inlineItemLimit
                    || (isCall && items.some(
                        item => isCallLikeNode(
                            unwrapParenthesizedExpression(item),
                        )
                            || isMultilineExpressionBodiedFunction(item, source),
                    ))
                    || (
                        // A literal the object rule already split cannot come back onto one
                        // line, so a list holding one alongside another item breaks too.
                        items.length > 1
                        && items.some(item => isHuggableItem(item) && spansLines(source, item))
                    )
                    || (
                        // A callback with a block body never fits on one line, so its own
                        // braces are what break the call, not the width rule. A sole object
                        // or array argument is likewise laid out by the hug rule, and
                        // letting width decide it too leaves the two disagreeing. A call
                        // around one plain argument, a name or a literal, has nothing to
                        // gain from splitting however long its line runs.
                        !(items.length === 1 && isAtomicItem(items[0]))
                        && !endsWithBlockBodiedFunction(items)
                        && getInlineListWidth(
                            source,
                            start,
                            itemRanges as Array<[number, number]>,
                        ) > lineLimit
                    ))

                // Hugging wins over every splitting reason above, because a single item is
                // never worth a line of its own between two brackets.
                const hugsSoleArgument = isBracketed
                    && items.length === 1
                    && collapsed == null
                    && isHuggableItem(items[0])

                if (
                    !hasInterItemComment
                    && (mustSplit || hugsSoleArgument)
                ) {
                    const indentation = getLineIndentation(
                        source,
                        getDelimitedListAnchor(
                            node,
                            nodeRange,
                            source,
                        ),
                    )
                    const itemIndentation = `${indentation}    `
                    const itemTexts = itemRanges.map(
                        range => reindentNodeText(
                            source,
                            range!,
                            hugsSoleArgument ? indentation : itemIndentation,
                        ),
                    )
                    const lastItem = items.at(-1)
                    const trailingComma = lastItem?.type === 'RestElement' ? '' : ','
                    const replacement = hugsSoleArgument
                        ? itemTexts[0]!
                        : `\n${itemIndentation}${itemTexts.join(`,\n${itemIndentation}`)}${trailingComma}\n${indentation}`

                    if (source.slice(start, end) !== replacement) {
                        replacements.push({
                            start,
                            end,
                            text: replacement,
                        })
                    }
                } else if (
                    isBracketed
                    && !hasInterItemComment
                    && collapsed != null
                    && source.slice(start, end) !== collapsed
                ) {
                    replacements.push({
                        start,
                        end,
                        text: collapsed,
                    })
                }
            }
        }

        for (const [key, value] of Object.entries(node)) {
            if (key === 'range')
                continue

            if (Array.isArray(value)) {
                for (const child of value)
                    if (isAstNode(child))
                        visit(
                            child,
                            ownStatementStart,
                            node,
                        )
            } else if (isAstNode(value))
                visit(
                    value,
                    ownStatementStart,
                    node,
                )
        }
    }

    visit(
        parseResult.program as AstNode,
        0,
        null,
    )
    const nonOverlappingReplacements: LayoutSpan[] = []

    // Outermost first. A list's width is measured against the line it sits on, so the
    // enclosing list has to settle before the lists inside it are measured again.
    for (const replacement of replacements.sort((left, right) => right.end - right.start - (left.end - left.start) || left.start - right.start)) {
        const overlapsSelectedReplacement = nonOverlappingReplacements.some(
            candidate => replacement.start < candidate.end && replacement.end > candidate.start,
        )

        if (!overlapsSelectedReplacement)
            nonOverlappingReplacements.push(replacement)
    }

    let output = source

    for (const replacement of nonOverlappingReplacements.sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// Repeat list formatting until nesting settles. The pass limit converts any disagreement
// between layout rules into an explicit error instead of silently oscillating forever.
const canonicalizeDelimitedLists = (
    file: string,
    source: string,
    printWidth: number,
): string => {
    let output = source

    for (let pass = 0; pass < 20; pass++) {
        const formatted = canonicalizeDelimitedListsOnce(
            file,
            output,
            printWidth,
        )

        if (formatted === output)
            return output

        output = formatted
    }

    throw new Error(`Could not stabilize function parameter and argument formatting in ${file}`)
}

// Recognize both directly imported `html` tags and namespaced `.html` tags used by the DOM
// template API; ordinary template literals must remain untouched.
const isHtmlTemplateTag = (tag: AstNode | undefined): boolean => tag?.type === 'Identifier' && tag.name === 'html'
    || tag?.type === 'MemberExpression'
    && tag.computed === false
    && isAstNode(tag.property)
    && tag.property.type === 'Identifier'
    && tag.property.name === 'html'

// Collect every raw quasi in tagged HTML templates and associate it with the template's
// start. Interpolations divide templates into quasis that must be restored independently.
const collectHtmlTemplateQuasis = (
    file: string,
    source: string,
): HtmlTemplateQuasi[] => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const layouts: HtmlTemplateQuasi[] = []
    const visit = (node: AstNode): void => {
        const tag = node.tag as AstNode | undefined
        const template = node.quasi as AstNode | undefined

        if (
            node.type === 'TaggedTemplateExpression'
            && isHtmlTemplateTag(tag)
            && template?.type === 'TemplateLiteral'
            && Array.isArray(template.quasis)
        ) {
            const templateRange = getNodeRange(template)

            for (const quasi of template.quasis) {
                if (!isAstNode(quasi))
                    continue

                const quasiRange = getNodeRange(quasi)

                if (
                    quasiRange
                    && templateRange
                ) {
                    layouts.push({
                        span: getLayoutSpan(
                            quasiRange[0],
                            quasiRange[1],
                            source,
                        ),
                        templateStart: templateRange[0],
                    })
                }
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

    return layouts
}

// Shift continuation lines in one template quasi without changing its first line, which
// may resume immediately after an interpolation rather than at an HTML indentation level.
const reindentHtmlTemplate = (
    text: string,
    indentationDifference: number,
): string => {
    const lines = text.split('\n')

    for (let index = 1; index < lines.length; index++) {
        const line = lines[index]!

        if (indentationDifference > 0)
            lines[index] = `${' '.repeat(indentationDifference)}${line}`
        else
            lines[index] = line.slice(
                Math.min(-indentationDifference, line.length - line.trimStart().length),
            )
    }

    return lines.join('\n')
}

// Transfer Oxfmt's HTML-aware template result back into the TypeScript-formatted module by
// matching quasis in AST order and aligning each template body to its TypeScript location.
const applyHtmlTemplateFormatting = (
    file: string,
    formatted: string,
    htmlFormatted: string,
): string => {
    const formattedLayouts = collectHtmlTemplateQuasis(file, formatted)
    const htmlLayouts = collectHtmlTemplateQuasis(file, htmlFormatted)

    if (formattedLayouts.length !== htmlLayouts.length)
        throw new Error(`Oxfmt changed the html template syntax shape in ${file}`)

    // Anchor each template body on its own first line, and put that line exactly where
    // canonicalizeHtmlTemplateBoundaries will put it: one step past the line the tagged
    // template sits on. When the two disagree, the boundary step moves the first line on
    // its own and leaves the attributes, children and closing tag behind at the offsets
    // this reindent gave them.
    //
    // Every quasi of one template moves together, so the relative shape of the body is
    // preserved. A quasi after the first resumes mid-line, so its first line belongs to
    // the interpolation before it and is never shifted.
    const bodyIndentation = new Map<number, number>()

    for (const quasi of htmlLayouts) {
        if (bodyIndentation.has(quasi.templateStart))
            continue

        for (const line of quasi.span.text.split('\n').slice(1)) {
            if (line.trim().length === 0)
                continue

            bodyIndentation.set(quasi.templateStart, line.length - line.trimStart().length)

            break
        }
    }

    const replacements = formattedLayouts.map(
        (target, index) => {
            const htmlQuasi = htmlLayouts[index]!
            const base = bodyIndentation.get(htmlQuasi.templateStart)
            const wanted = getLineIndentation(formatted, target.templateStart).length + indentationWidth

            return {
                ...target.span,
                text: reindentHtmlTemplate(htmlQuasi.span.text, base == null ? 0 : wanted - base),
            }
        },
    )
    let output = formatted

    for (const replacement of replacements.sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// Describe each tagged template's raw content and interpolation gaps in absolute source
// offsets. Later HTML parsing uses this map to separate markup from embedded TypeScript.
const collectHtmlTemplateContents = (
    file: string,
    source: string,
): HtmlTemplateContent[] => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const contents: HtmlTemplateContent[] = []
    const visit = (node: AstNode): void => {
        const tag = node.tag as AstNode | undefined
        const template = node.quasi as AstNode | undefined
        const templateRange = getNodeRange(template)

        if (
            node.type === 'TaggedTemplateExpression'
            && isHtmlTemplateTag(tag)
            && template?.type === 'TemplateLiteral'
            && templateRange
            && Array.isArray(template.quasis)
        ) {
            const quasis = template.quasis.filter(isAstNode)
            const rawRanges = quasis.map(
                (quasi): [number, number] | null => {
                    const quasiRange = getNodeRange(quasi)
                    const value = quasi.value
                    const raw = (
                        value
                        && typeof value === 'object'
                        && 'raw' in value
                    )
                        ? value.raw
                        : null

                    if (
                        !quasiRange
                        || typeof raw !== 'string'
                    )
                        return null

                    const start = quasiRange[0] + 1

                    return [start, start + raw.length]
                },
            )

            if (rawRanges.every(range => range != null)) {
                const interpolationRanges: Array<[number, number]> = []

                for (let index = 0; index < rawRanges.length - 1; index++)
                    interpolationRanges.push([rawRanges[index]![1], rawRanges[index + 1]![0]])

                contents.push({
                    start: templateRange[0] + 1,
                    end: templateRange[1] - 1,
                    interpolationRanges,
                    indentation: getLineIndentation(source, node.range?.[0] ?? templateRange[0]),
                })
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

    return contents
}

// Replace interpolation bytes with inert characters while preserving length and newlines.
// Parse5 can then locate HTML attributes without interpreting TypeScript as markup.
const maskHtmlInterpolations = (
    source: string,
    content: HtmlTemplateContent,
): string => {
    const characters: string[] = []

    for (let offset = content.start; offset < content.end; offset++)
        characters.push(source[offset]!)

    for (const range of content.interpolationRanges)
        for (let offset = range[0]; offset < range[1]; offset++)
            characters[offset - content.start] = 'x'

    return characters.join('')
}

// Rebuild a multi-attribute start tag with one attribute per line while preserving the tag
// name, exact attribute source, and whether the element closes with `>` or `/>`.
const getExpandedHtmlStartTag = (
    source: string,
    startTag: HtmlAttributeLocation,
    attributes: HtmlAttributeLocation[],
    indentation: string,
): string => {
    const start = startTag.startOffset
    const end = startTag.endOffset
    const firstAttribute = attributes[0]!
    const lastAttribute = attributes.at(-1)!
    const prefixEnd = getTrailingWhitespaceStart(
        source,
        start,
        firstAttribute.startOffset,
    )
    let closingOffset = end - 2

    while (
        closingOffset > lastAttribute.endOffset
        && isWhitespaceCharacter(source[closingOffset])
    )
        closingOffset--

    const closing = source[closingOffset] === '/' ? '/>' : '>'
    const attributeIndentation = `${indentation}    `
    const attributeText = attributes.map(attribute => `${attributeIndentation}${source.slice(attribute.startOffset, attribute.endOffset).trim()}`)
        .join('\n')

    return `${source.slice(start, prefixEnd)}\n${attributeText}\n${indentation}${closing}`
}

// Walk a Parse5 tree and produce source-relative replacements for every start tag with more
// than one attribute. Inline tags derive indentation from HTML depth.
const collectExpandedHtmlStartTags = (
    source: string,
    root: HtmlNode,
    baseIndentation: string,
    offset = 0,
): LayoutSpan[] => {
    const replacements: LayoutSpan[] = []
    const visit = (
        node: HtmlNode,
        depth: number,
    ): void => {
        const startTag = node.sourceCodeLocation?.startTag
        const attributes = Object.values(node.sourceCodeLocation?.attrs ?? {})
            .sort((left, right) => left.startOffset - right.startOffset)

        if (
            startTag
            && attributes.length > 1
        ) {
            const absoluteStart = offset + startTag.startOffset
            const lineStart = getLineStart(source, absoluteStart)
            const linePrefix = source.slice(lineStart, absoluteStart)
            const indentation = linePrefix.trim().length === 0
                ? linePrefix
                : `${baseIndentation}${' '.repeat((depth + 1) * 4)}`
            const relativeSource = source.slice(offset)
            const replacement = getExpandedHtmlStartTag(
                relativeSource,
                startTag,
                attributes,
                indentation,
            )
            const absoluteEnd = offset + startTag.endOffset

            if (source.slice(absoluteStart, absoluteEnd) !== replacement) {
                replacements.push({
                    start: absoluteStart,
                    end: absoluteEnd,
                    text: replacement,
                })
            }
        }

        for (const child of node.childNodes ?? [])
            visit(child, depth + 1)

        if (node.content)
            visit(node.content, depth + 1)
    }

    for (const child of root.childNodes ?? [])
        visit(child, 0)

    return replacements
}

// HTML replacements are independent and use Parse5 source locations, so applying them from
// right to left keeps all earlier offsets valid.
const applyHtmlAttributeReplacements = (
    source: string,
    replacements: LayoutSpan[],
): string => {
    let output = source

    for (const replacement of replacements.sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// Format start tags inside tagged templates after masking their TypeScript interpolations.
// Absolute offsets map Parse5 fragment locations back into the containing module.
const canonicalizeEmbeddedHtmlAttributes = (
    file: string,
    source: string,
): string => {
    const replacements: LayoutSpan[] = []

    for (const content of collectHtmlTemplateContents(file, source)) {
        const maskedContent = maskHtmlInterpolations(source, content)
        const fragment = parseFragment(maskedContent, { sourceCodeLocationInfo: true }) as HtmlNode
        replacements.push(...collectExpandedHtmlStartTags(
            source,
            fragment,
            content.indentation,
            content.start,
        ))
    }

    return applyHtmlAttributeReplacements(source, replacements)
}

// Reindent multiline TypeScript interpolations relative to `${` after HTML formatting. This
// pass moves only indentation and preserves the expression's internal line structure.
const canonicalizeHtmlTemplateInterpolations = (
    file: string,
    source: string,
): string => {
    const replacements: LayoutSpan[] = []

    // An interpolation that spans lines carries ordinary TypeScript, and nothing so far
    // ties that code to the `${` holding it. Left alone it keeps whatever indentation it
    // had in the authored file, which routinely leaves the expression and its closing
    // brace further left than the interpolation they belong to.
    for (const content of collectHtmlTemplateContents(file, source)) {
        for (const [start, end] of content.interpolationRanges) {
            const lines = source.slice(start, end).split('\n')

            if (lines.length < 2)
                continue

            const openIndentation = getLineIndentation(source, start).length
            const firstInner = lines.slice(1).find(line => line.trim().length > 0)

            if (firstInner == null)
                continue

            const difference = openIndentation + indentationWidth
                - (firstInner.length - firstInner.trimStart().length)

            if (difference === 0)
                continue

            replacements.push({
                start,
                end,
                text: lines.map(
                    (line, index) => {
                        if (
                            index === 0
                            || line.trim().length === 0
                        )
                            return line

                        return difference > 0
                            ? `${' '.repeat(difference)}${line}`
                            : line.slice(
                                Math.min(-difference, line.length - line.trimStart().length),
                            )
                    },
                ).join('\n'),
            })
        }
    }

    return applyHtmlAttributeReplacements(source, replacements)
}

// Standalone HTML has no interpolation gaps, so Parse5 can collect and rewrite start tags
// directly from the complete document.
const canonicalizeStandaloneHtmlAttributes = (source: string): string => {
    const document = parse(source, { sourceCodeLocationInfo: true }) as HtmlNode

    return applyHtmlAttributeReplacements(
        source,
        collectExpandedHtmlStartTags(
            source,
            document,
            '',
        ),
    )
}

// Normalize the several AST node shapes that bind a value on their right side. Returning
// null keeps assignment-boundary formatting limited to initialized declarations and fields.
const getAssignmentValue = (node: AstNode): AstNode | null => {
    if (
        node.type === 'AssignmentExpression'
        || node.type === 'AssignmentPattern'
    )
        return isAstNode(node.right) ? node.right : null

    if (
        node.type === 'PropertyDefinition'
        || node.type === 'VariableDeclarator'
    ) {
        if (isAstNode(node.value))
            return node.value

        return isAstNode(node.init) ? node.init : null
    }

    return null
}

// Keep an assignment operator and its value on the same line. When Oxfmt had indented a
// multiline value beneath the assignment, remove that extra level from its continuation lines.
const canonicalizeAssignmentBoundaries = (
    file: string,
    source: string,
): string => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const comments = parseResult.comments as AstComment[]
    const replacements: LayoutSpan[] = []
    // One entry per line, so a nested assignment cannot dedent a line its enclosing
    // assignment already accounted for.
    const dedentedLineStarts = new Map<number, LayoutSpan>()
    const visit = (node: AstNode): void => {
        const nodeRange = getNodeRange(node)
        const value = getAssignmentValue(node)
        const valueRange = getNodeRange(value)

        if (
            nodeRange
            && valueRange
            && !hasCommentWithinRange(comments, [nodeRange[0], valueRange[0]])
        ) {
            const whitespaceStart = getTrailingWhitespaceStart(
                source,
                nodeRange[0],
                valueRange[0],
            )
            const whitespace = source.slice(whitespaceStart, valueRange[0])

            if (
                whitespace !== ' '
                && whitespace.trim().length === 0
            ) {
                replacements.push({
                    start: whitespaceStart,
                    end: valueRange[0],
                    text: ' ',
                })

                // Oxfmt indents a value it moved onto its own line one level past the
                // assignment. Pulling that value back onto the assignment line has to
                // take the same level off every line the value spans, otherwise each
                // run leaves the value one level deeper than the run before it.
                const shift = getLineIndentation(source, valueRange[0]).length - getLineIndentation(source, nodeRange[0]).length

                for (
                    let lineStart = getNextLineStart(source, valueRange[0]);
                    shift > 0
                    && lineStart > 0
                    && lineStart < valueRange[1];
                    lineStart = getNextLineStart(source, lineStart)
                ) {
                    const removable = Math.min(shift, getLineIndentation(source, lineStart).length)

                    if (
                        removable > 0
                        && !dedentedLineStarts.has(lineStart)
                    ) {
                        dedentedLineStarts.set(
                            lineStart,
                            {
                                start: lineStart,
                                end: lineStart + removable,
                                text: '',
                            },
                        )
                    }
                }
            }
        }

        for (const [key, childValue] of Object.entries(node)) {
            if (key === 'range')
                continue

            if (Array.isArray(childValue)) {
                for (const child of childValue)
                    if (isAstNode(child))
                        visit(child)
            } else if (isAstNode(childValue))
                visit(childValue)
        }
    }

    visit(parseResult.program as AstNode)
    let output = source

    for (const replacement of [...replacements, ...dedentedLineStarts.values()].sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// A sole arrow parameter that is a plain name carries no information in its parentheses,
// so they come off. A parameter with a type, a default, a rest element or a destructuring
// pattern keeps them, because the syntax requires them there.
const hasBareArrowParameter = (node: AstNode): boolean => {
    if (node.type !== 'ArrowFunctionExpression')
        return false

    const parameters = Array.isArray(node.params) ? node.params.filter(isAstNode) : []
    const parameter = parameters[0]

    // A return type or a type parameter list keeps the parentheses too: `modelId: T[] =>`
    // and `<T>modelId =>` are not valid syntax.
    return parameters.length === 1
        && parameter?.type === 'Identifier'
        && !parameter.typeAnnotation
        && !parameter.optional
        && !node.returnType
        && !node.typeParameters
}

// Remove optional parentheses around exactly one bare arrow parameter. Commented parameter
// boundaries are preserved because deleting their brackets could move the comment.
const canonicalizeArrowParameters = (
    file: string,
    source: string,
): string => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const comments = parseResult.comments as AstComment[]
    const replacements: LayoutSpan[] = []
    const visit = (node: AstNode): void => {
        const nodeRange = getNodeRange(node)
        const parameterRange = hasBareArrowParameter(node)
            ? getNodeRange((node.params as AstNode[])[0])
            : null

        if (
            nodeRange
            && parameterRange
        ) {
            const openParenthesis = getTrailingWhitespaceStart(
                source,
                nodeRange[0],
                parameterRange[0],
            ) - 1
            const afterParameter = getLeadingWhitespaceEnd(
                source,
                parameterRange[1],
                source.length,
            )
            // A parameter list an earlier layout split carries a trailing comma, which
            // comes off with the parentheses.
            const closeParenthesis = source[afterParameter] === ','
                ? getLeadingWhitespaceEnd(
                    source,
                    afterParameter + 1,
                    source.length,
                )
                : afterParameter

            if (
                openParenthesis >= nodeRange[0]
                && source[openParenthesis] === '('
                && source[closeParenthesis] === ')'
                && !hasCommentWithinRange(comments, [openParenthesis, closeParenthesis + 1])
            ) {
                replacements.push({
                    start: openParenthesis,
                    end: closeParenthesis + 1,
                    text: source.slice(parameterRange[0], parameterRange[1]),
                })
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
    let output = source

    for (const replacement of replacements.sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// Keep a concise arrow body beside its arrow until the complete line crosses the repository
// limit, then place the intact expression on one indented continuation line.
const canonicalizeExpressionArrowBodies = (
    file: string,
    source: string,
): string => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const replacements: LayoutSpan[] = []
    const visit = (node: AstNode): void => {
        const nodeRange = getNodeRange(node)
        const bodyRange = getNodeRange(node.body as AstNode)

        if (
            node.type === 'ArrowFunctionExpression'
            && (node.body as AstNode | undefined)?.type !== 'BlockStatement'
            && nodeRange
            && bodyRange
        ) {
            const bodyText = source.slice(bodyRange[0], bodyRange[1])

            if (!bodyText.includes('\n')) {
                const whitespaceStart = getTrailingWhitespaceStart(
                    source,
                    nodeRange[0],
                    bodyRange[0],
                )
                const currentWhitespace = source.slice(whitespaceStart, bodyRange[0])

                if (currentWhitespace.trim().length === 0) {
                    const arrowLineStart = getLineStart(source, whitespaceStart)
                    const singleLineLength = whitespaceStart + 1 + bodyText.length - arrowLineStart
                    const indentation = `${getLineIndentation(source, whitespaceStart)}    `
                    const replacement = singleLineLength > maximumInlineArrowFunctionLength ? `\n${indentation}` : ' '

                    if (currentWhitespace !== replacement) {
                        replacements.push({
                            start: whitespaceStart,
                            end: bodyRange[0],
                            text: replacement,
                        })
                    }
                }
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
    let output = source

    for (const replacement of replacements.sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// Only an outermost call owns the whitespace boundaries of a complete fluent chain. Nested
// call links are collected as segments of that one chain.
const isNestedCallChain = (
    node: AstNode,
    parent: AstNode | null,
    grandparent: AstNode | null,
): boolean => parent?.type === 'MemberExpression'
    && parent.object === node
    && grandparent?.type === 'CallExpression'
    && grandparent.callee === parent

// Decompose a fluent chain into its base and exact source segments, marking recognized
// iterator methods so only those boundaries are eligible for line breaks.
const getCallChain = (
    node: AstNode,
    source: string,
): CallChain | null => {
    const segments: CallChainSegment[] = []
    let current = node
    let iteratorCount = 0

    while (
        current.type === 'CallExpression'
        && isAstNode(current.callee)
        && current.callee.type === 'MemberExpression'
        && current.callee.computed === false
        && isAstNode(current.callee.object)
        && isAstNode(current.callee.property)
        && current.callee.property.type === 'Identifier'
        && typeof current.callee.property.name === 'string'
    ) {
        const currentRange = getNodeRange(current)
        const objectRange = getNodeRange(current.callee.object)

        if (
            !currentRange
            || !objectRange
        )
            return null

        const isIterator = iteratorMethodNames.has(current.callee.property.name)

        if (isIterator)
            iteratorCount++

        let boundaryEnd = objectRange[1]

        while (
            boundaryEnd < currentRange[1]
            && isWhitespaceCharacter(source[boundaryEnd])
        )
            boundaryEnd++

        segments.unshift({
            boundaryEnd,
            boundaryStart: objectRange[1],
            isIterator,
            leadingWhitespace: source.slice(objectRange[1], boundaryEnd),
            text: source.slice(boundaryEnd, currentRange[1]),
        })
        current = current.callee.object
    }

    if (segments.length === 0)
        return null

    return {
        base: current,
        iteratorCount,
        segments,
    }
}

// Measure the lines containing iterator segments as though iterator boundaries were inline.
// This gives expansion a stable answer independent of the chain's current whitespace.
const getLongestIteratorLineLength = (
    chain: CallChain,
    source: string,
    nodeStart: number,
): number => {
    const baseRange = getNodeRange(chain.base)

    if (!baseRange)
        return 0

    const parts = [source.slice(baseRange[0], baseRange[1])]
    const iteratorOffsets: number[] = []
    let offset = parts[0]!.length

    for (const segment of chain.segments) {
        const leadingWhitespace = segment.isIterator ? '' : segment.leadingWhitespace
        parts.push(leadingWhitespace)
        offset += leadingWhitespace.length

        if (segment.isIterator)
            iteratorOffsets.push(offset)

        parts.push(segment.text)
        offset += segment.text.length
    }

    const inlineChain = parts.join('')
    const nodeColumn = nodeStart - getLineStart(source, nodeStart)
    let longestLineLength = 0

    for (const iteratorOffset of iteratorOffsets) {
        const lineStart = inlineChain.lastIndexOf('\n', iteratorOffset - 1) + 1
        const nextLineBreak = inlineChain.indexOf('\n', iteratorOffset)
        const lineEnd = nextLineBreak < 0 ? inlineChain.length : nextLineBreak
        const lineLength = lineEnd - lineStart + (lineStart === 0 ? nodeColumn : 0)
        longestLineLength = Math.max(longestLineLength, lineLength)
    }

    return longestLineLength
}

// Canonicalize iterator boundaries in one AST snapshot. More than two iterator calls always
// expand; one expands only when its line exceeds the configured limit.
const canonicalizeIteratorChainsOnce = (
    file: string,
    source: string,
): string => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const comments = parseResult.comments as AstComment[]
    const replacements: LayoutSpan[] = []
    const visit = (
        node: AstNode,
        parent: AstNode | null = null,
        grandparent: AstNode | null = null,
    ): void => {
        const nodeRange = getNodeRange(node)

        if (
            node.type === 'CallExpression'
            && nodeRange
            && !isNestedCallChain(
                node,
                parent,
                grandparent,
            )
        ) {
            const chain = getCallChain(node, source)

            if (
                chain
                && chain.iteratorCount > 0
                && !hasCommentWithinRange(comments, nodeRange)
            ) {
                const indentation = `${getLineIndentation(source, nodeRange[0])}    `
                const longestIteratorLineLength = getLongestIteratorLineLength(
                    chain,
                    source,
                    nodeRange[0],
                )
                const shouldExpand = chain.iteratorCount > 2
                    || (
                        chain.iteratorCount === 1
                        && longestIteratorLineLength > maximumInlineIteratorChainLength
                    )
                const boundaryWhitespace = shouldExpand ? `\n${indentation}` : ''

                for (const segment of chain.segments) {
                    if (
                        !segment.isIterator
                        || segment.leadingWhitespace === boundaryWhitespace
                    )
                        continue

                    replacements.push({
                        start: segment.boundaryStart,
                        end: segment.boundaryEnd,
                        text: boundaryWhitespace,
                    })
                }
            }
        }

        for (const [key, value] of Object.entries(node)) {
            if (key === 'range')
                continue

            if (Array.isArray(value)) {
                for (const child of value)
                    if (isAstNode(child))
                        visit(
                            child,
                            node,
                            parent,
                        )
            } else if (isAstNode(value))
                visit(
                    value,
                    node,
                    parent,
                )
        }
    }

    visit(parseResult.program as AstNode)
    let output = source

    for (const replacement of replacements.sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// Iterate because expanding an outer chain changes the line measurement of nested chains.
// A hard pass limit surfaces conflicting layout rules instead of looping indefinitely.
const canonicalizeIteratorChains = (
    file: string,
    source: string,
): string => {
    let output = source

    for (let pass = 0; pass < 20; pass++) {
        const formatted = canonicalizeIteratorChainsOnce(file, output)

        if (formatted === output)
            return output

        output = formatted
    }

    throw new Error(`Could not stabilize iterator chain formatting in ${file}`)
}

// Put non-empty tagged HTML template content on lines between the backticks and align those
// boundaries with the tagged expression. Empty templates remain compact.
const canonicalizeHtmlTemplateBoundaries = (
    file: string,
    source: string,
): string => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const replacements: LayoutSpan[] = []
    const visit = (node: AstNode): void => {
        const tag = node.tag as AstNode | undefined
        const template = node.quasi as AstNode | undefined
        const nodeRange = getNodeRange(node)
        const templateRange = getNodeRange(template)

        if (
            node.type === 'TaggedTemplateExpression'
            && isHtmlTemplateTag(tag)
            && template?.type === 'TemplateLiteral'
            && nodeRange
            && templateRange
            && templateRange[1] - templateRange[0] >= 2
        ) {
            const contentStart = templateRange[0] + 1
            const contentEnd = templateRange[1] - 1
            let leadingWhitespaceEnd = contentStart
            let trailingWhitespaceStart = contentEnd

            while (
                leadingWhitespaceEnd < contentEnd
                && isWhitespaceCharacter(source[leadingWhitespaceEnd])
            )
                leadingWhitespaceEnd++

            while (
                trailingWhitespaceStart > leadingWhitespaceEnd
                && isWhitespaceCharacter(source[trailingWhitespaceStart - 1])
            )
                trailingWhitespaceStart--

            const indentation = getLineIndentation(source, nodeRange[0])
            // The parser is asked for ranges only, so node.loc is never populated. Derive the
            // multiline check and the starting column from the source offsets instead, or every
            // template shorter than the inline budget collapses onto the tag line.
            const isMultiline = source.slice(nodeRange[0], nodeRange[1]).includes('\n')
            const inlineLength = nodeRange[1] - getLineStart(source, nodeRange[0])
            const shouldExpand = isMultiline
                || inlineLength > maximumInlineArrowFunctionLength
            const leadingWhitespace = shouldExpand ? `\n${indentation}    ` : ''
            const trailingWhitespace = shouldExpand ? `\n${indentation}` : ''

            if (leadingWhitespaceEnd === contentEnd) {
                const whitespace = shouldExpand ? `\n${indentation}` : ''

                if (source.slice(contentStart, contentEnd) !== whitespace) {
                    replacements.push({
                        start: contentStart,
                        end: contentEnd,
                        text: whitespace,
                    })
                }

                return
            }

            if (source.slice(contentStart, leadingWhitespaceEnd) !== leadingWhitespace) {
                replacements.push({
                    start: contentStart,
                    end: leadingWhitespaceEnd,
                    text: leadingWhitespace,
                })
            }

            if (source.slice(trailingWhitespaceStart, contentEnd) !== trailingWhitespace) {
                replacements.push({
                    start: trailingWhitespaceStart,
                    end: contentEnd,
                    text: trailingWhitespace,
                })
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
    let output = source

    for (const replacement of replacements.sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// Unwrap only grouping parentheses and return the conditional expression they contain.
// Other wrappers remain leaves because rewriting through them could change TypeScript syntax.
const getConditionalExpression = (node: AstNode | null | undefined): AstNode | null => {
    let current = node

    while (
        current?.type === 'ParenthesizedExpression'
        && isAstNode(current.expression)
    )
        current = current.expression

    return current?.type === 'ConditionalExpression' ? current : null
}

// A conditional needs hierarchical layout when any of its three branches is another
// conditional expression after removing grouping parentheses.
const hasNestedConditionalExpression = (node: AstNode): boolean => Boolean(
    getConditionalExpression(node.test as AstNode)
    || getConditionalExpression(node.consequent as AstNode)
    || getConditionalExpression(node.alternate as AstNode),
)

// Leaf text is copied directly from its range so casts, non-null assertions, and authored
// grouping inside a branch remain intact.
const getConditionalLeafText = (
    node: AstNode,
    source: string,
): string | null => {
    const range = getNodeRange(node)

    if (!range)
        return null

    const text = source.slice(range[0], range[1]).trim()

    return text || null
}

// Render nested conditionals recursively with each inner `?` and `:` one level deeper.
// Parenthesized tests retain explicit grouping around their multiline nested expression.
const getCanonicalConditionalText = (
    node: AstNode,
    source: string,
    operatorIndentation: string,
): string | null => {
    const test = node.test as AstNode | undefined
    const consequent = node.consequent as AstNode | undefined
    const alternate = node.alternate as AstNode | undefined

    if (
        !test
        || !consequent
        || !alternate
    )
        return null

    const nestedTest = getConditionalExpression(test)
    const nestedConsequent = getConditionalExpression(consequent)
    const nestedAlternate = getConditionalExpression(alternate)
    const nestedOperatorIndentation = `${operatorIndentation}    `
    const testText = nestedTest
        ? getCanonicalConditionalText(
            nestedTest,
            source,
            nestedOperatorIndentation,
        )
        : getConditionalLeafText(test, source)
    const consequentText = nestedConsequent
        ? getCanonicalConditionalText(
            nestedConsequent,
            source,
            nestedOperatorIndentation,
        )
        : getConditionalLeafText(consequent, source)
    const alternateText = nestedAlternate
        ? getCanonicalConditionalText(
            nestedAlternate,
            source,
            nestedOperatorIndentation,
        )
        : getConditionalLeafText(alternate, source)

    if (
        !testText
        || !consequentText
        || !alternateText
    )
        return null

    const canonicalTest = nestedTest
        ? `(\n${nestedOperatorIndentation}${testText}\n${operatorIndentation})`
        : testText

    return `${canonicalTest}\n${operatorIndentation}? ${consequentText}\n${operatorIndentation}: ${alternateText}`
}

// Replace only outermost nested conditional expressions. Returning after queuing a parent
// prevents overlapping child fixes, and comments disable the rewrite to preserve attachment.
const canonicalizeNestedConditionalExpressions = (
    file: string,
    source: string,
): string => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const comments = parseResult.comments as AstComment[]
    const replacements: LayoutSpan[] = []
    const visit = (node: AstNode): void => {
        const nodeRange = getNodeRange(node)

        if (
            node.type === 'ConditionalExpression'
            && nodeRange
            && hasNestedConditionalExpression(node)
            && !hasCommentWithinRange(comments, nodeRange)
        ) {
            const indentation = `${getLineIndentation(source, nodeRange[0])}    `
            const replacement = getCanonicalConditionalText(
                node,
                source,
                indentation,
            )

            if (!replacement)
                throw new Error(`Could not format the nested conditional expression in ${file}`)

            replacements.push({
                start: nodeRange[0],
                end: nodeRange[1],
                text: replacement,
            })

            return
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
    let output = source

    for (const replacement of replacements.sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// Count logical operands rather than AST operator nodes so formatting thresholds reflect
// the number of conditions a reader evaluates.
const countLogicalEvaluations = (node: AstNode): number => {
    if (
        node.type === 'ParenthesizedExpression'
        && isAstNode(node.expression)
    )
        return countLogicalEvaluations(node.expression)

    if (
        node.type !== 'LogicalExpression'
        || !isAstNode(node.left)
        || !isAstNode(node.right)
    )
        return 1

    return countLogicalEvaluations(node.left) + countLogicalEvaluations(node.right)
}

type LogicalConditionParts = {
    operands: AstNode[]
    operators: string[]
}

// Grouping parentheses do not change which homogeneous logical chain is being flattened.
const unwrapParenthesizedExpression = (node: AstNode): AstNode => {
    let current = node

    while (
        current.type === 'ParenthesizedExpression'
        && isAstNode(current.expression)
    )
        current = current.expression

    return current
}

// Reconstruct logical expressions from AST children while copying every non-logical leaf
// directly from source. This avoids operator discovery through fragile string searches.
const getAstExpressionText = (
    node: AstNode,
    source: string,
): string | null => {
    if (
        node.type === 'ParenthesizedExpression'
        && isAstNode(node.expression)
    ) {
        const expression = getAstExpressionText(node.expression, source)

        return expression == null ? null : `(${expression})`
    }

    if (
        node.type === 'LogicalExpression'
        && isAstNode(node.left)
        && isAstNode(node.right)
        && typeof node.operator === 'string'
    ) {
        const left = getAstExpressionText(node.left, source)
        const right = getAstExpressionText(node.right, source)

        return (
            left == null
            || right == null
        )
            ? null
            : `${left} ${node.operator} ${right}`
    }

    const range = getNodeRange(node)

    if (!range)
        return null

    const expression = source.slice(range[0], range[1]).trim()

    return expression || null
}

// Flatten a chain using one root operator. Mixed operators stay inside a leaf operand so
// parser precedence and authored grouping are preserved.
const getLogicalConditionParts = (node: AstNode): LogicalConditionParts | null => {
    const operands: AstNode[] = []
    const operators: string[] = []
    const logicalExpression = unwrapParenthesizedExpression(node)

    if (
        logicalExpression.type !== 'LogicalExpression'
        || (logicalExpression.operator !== '&&' && logicalExpression.operator !== '||' && logicalExpression.operator !== '??')
    )
        return null

    const rootOperator = logicalExpression.operator

    const visit = (current: AstNode): boolean => {
        if (
            current.type === 'LogicalExpression'
            && isAstNode(current.left)
            && isAstNode(current.right)
            && current.operator === rootOperator
        ) {
            if (!visit(current.left))
                return false

            operators.push(rootOperator)

            return visit(current.right)
        }

        operands.push(current)

        return true
    }

    if (
        !visit(logicalExpression)
        || operators.length === 0
    )
        return null

    return {
        operands,
        operators,
    }
}

// `wrapInParentheses` says the caller owns a parenthesis pair around this expression:
// the parentheses an `if`, `while` or `for` requires, or a pair the source already
// wrote. The formatter never introduces one of its own, so a group that is not
// parenthesized in the source stays on a single line rather than gaining a bracket.
const getFormattedConditionText = (
    node: AstNode,
    source: string,
    indentation: string,
    wrapInParentheses: boolean,
): string | null => {
    const logicalExpression = unwrapParenthesizedExpression(node)

    if (logicalExpression.type !== 'LogicalExpression')
        return getAstExpressionText(node, source)

    const conditionParts = getLogicalConditionParts(logicalExpression)

    if (!conditionParts)
        return null

    const operandIndentation = wrapInParentheses ? `${indentation}    ` : indentation
    const lines: string[] = []

    for (let index = 0; index < conditionParts.operands.length; index++) {
        const operandNode = conditionParts.operands[index]!
        const operandRange = getNodeRange(operandNode)
        // An operand is copied out of the source exactly as it was written, on one line
        // or on several. The rule decides where the operands of a chain go, never how an
        // operand is laid out inside itself.
        const operand = operandRange && source.slice(operandRange[0], operandRange[1])

        if (!operand)
            return null

        const operator = index === 0 ? '' : `${conditionParts.operators[index - 1]} `
        lines.push(`${operandIndentation}${operator}${operand}`)
    }

    const condition = lines.join('\n')

    return wrapInParentheses
        ? `(\n${condition}\n${indentation})`
        : condition
}

// An assigned value and a ternary test both start part way along a line that is already
// written, so the first operand stays where it is and the rest are indented under it. A
// pair of parentheses appears only when the source wrote one.
const getContinuedConditionText = (
    node: AstNode,
    source: string,
    indentation: string,
): string | null => {
    if (node.type === 'ParenthesizedExpression')
        return getFormattedConditionText(
            node,
            source,
            indentation,
            true,
        )

    const condition = getFormattedConditionText(
        node,
        source,
        `${indentation}    `,
        false,
    )

    return condition == null ? null : condition.trimStart()
}

// Assigned logical values use continuation layout without a control-flow keyword wrapper.
const getMultilineAssignedLogicalExpressionText = (
    node: AstNode,
    source: string,
    indentation: string,
): string | null => getContinuedConditionText(
    node,
    source,
    indentation,
)

// Build a complete `if`, `while`, or `switch` condition header. A single operand remains
// inline, while compound conditions put one logical operand on each line.
const getConditionContainerText = (
    keyword: string,
    node: AstNode,
    source: string,
    indentation: string,
): string | null => {
    if (countLogicalEvaluations(node) === 1) {
        const condition = getAstExpressionText(node, source)

        return condition ? `${keyword} (${condition})` : null
    }

    const conditionIndentation = `${indentation}    `
    const condition = getFormattedConditionText(
        node,
        source,
        conditionIndentation,
        false,
    )

    return condition
        ? `${keyword} (\n${condition}\n${indentation})`
        : null
}

// Comment-sensitive formatters skip a range when moving its syntax could change which node
// a comment describes.
const hasCommentWithinRange = (
    comments: AstComment[],
    range: [number, number],
): boolean => comments.some(comment => comment.start >= range[0] && comment.end <= range[1])

// Split assigned logical chains with more than two operands. The assignment stays inline
// with the first operand and later operands align as continuations.
const canonicalizeAssignedLogicalExpressions = (
    file: string,
    source: string,
): string => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const comments = parseResult.comments as AstComment[]
    const replacements: LayoutSpan[] = []
    const visit = (node: AstNode): void => {
        const value = getAssignmentValue(node)
        const valueRange = getNodeRange(value)

        if (
            value
            && valueRange
            && unwrapParenthesizedExpression(value).type === 'LogicalExpression'
            && countLogicalEvaluations(value) > 2
            && !hasCommentWithinRange(comments, valueRange)
        ) {
            const indentation = getLineIndentation(source, valueRange[0])
            const replacement = getMultilineAssignedLogicalExpressionText(
                value,
                source,
                indentation,
            )

            if (!replacement)
                throw new Error(`Could not split the assigned logical expression in ${file}`)

            if (source.slice(valueRange[0], valueRange[1]) !== replacement) {
                replacements.push({
                    start: valueRange[0],
                    end: valueRange[1],
                    text: replacement,
                })

                return
            }
        }

        for (const [key, childValue] of Object.entries(node)) {
            if (key === 'range')
                continue

            if (Array.isArray(childValue)) {
                for (const child of childValue)
                    if (isAstNode(child))
                        visit(child)
            } else if (isAstNode(childValue))
                visit(childValue)
        }
    }

    visit(parseResult.program as AstNode)
    let output = source

    for (const replacement of replacements.sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// Normalize AST containers that own ordered statements so spacing logic works across modules,
// blocks, namespace bodies, static blocks, and switch-case consequents.
const getStatementList = (node: AstNode): AstNode[] | null => {
    if (
        node.type !== 'BlockStatement'
        && node.type !== 'Program'
        && node.type !== 'StaticBlock'
        && node.type !== 'TSModuleBlock'
    ) {
        if (
            node.type !== 'SwitchCase'
            || !Array.isArray(node.consequent)
        )
            return null

        return node.consequent.filter(isAstNode)
    }

    if (!Array.isArray(node.body))
        return null

    return node.body.filter(isAstNode)
}

// Return only whitespace that may be replaced between statements. Comments remain attached
// to the following statement, and any other syntax makes the gap unsafe to edit.
const getStatementGap = (
    source: string,
    comments: AstComment[],
    previousEnd: number,
    nextStart: number,
): [number, number] | null => {
    let gapStart = previousEnd
    const commentsInGap = comments.filter(comment => comment.start >= previousEnd && comment.end <= nextStart)

    for (const comment of commentsInGap) {
        if (!source.slice(gapStart, comment.start).includes('\n')) {
            gapStart = comment.end

            continue
        }

        if (source.slice(gapStart, comment.start).trim().length > 0)
            return null

        return [gapStart, comment.start]
    }

    if (source.slice(gapStart, nextStart).trim().length > 0)
        return null

    return [gapStart, nextStart]
}

// Require blank lines around grouped or terminating statements and remove blank lines between
// adjacent switch cases. All edits inherit the following statement's indentation.
const canonicalizeStatementSpacing = (
    file: string,
    source: string,
): string => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const comments = (parseResult.comments as AstComment[]).toSorted((left, right) => left.start - right.start)
    const replacements: LayoutSpan[] = []
    const addSiblingGapReplacement = (
        previous: AstNode,
        current: AstNode,
        blankLine: boolean,
    ): void => {
        const previousRange = getNodeRange(previous)
        const currentRange = getNodeRange(current)

        if (
            !previousRange
            || !currentRange
        )
            return

        const gap = getStatementGap(
            source,
            comments,
            previousRange[1],
            currentRange[0],
        )

        if (!gap)
            return

        const lineBreaks = blankLine ? '\n\n' : '\n'
        const replacement = `${lineBreaks}${getLineIndentation(source, gap[1])}`

        if (source.slice(gap[0], gap[1]) === replacement)
            return

        replacements.push({
            start: gap[0],
            end: gap[1],
            text: replacement,
        })
    }
    const visit = (node: AstNode): void => {
        if (
            node.type === 'SwitchStatement'
            && Array.isArray(node.cases)
        ) {
            const cases = node.cases.filter(isAstNode)

            for (let index = 1; index < cases.length; index++)
                addSiblingGapReplacement(
                    cases[index - 1]!,
                    cases[index]!,
                    false,
                )
        }

        const statements = getStatementList(node)

        if (statements) {
            for (let index = 1; index < statements.length; index++) {
                const previous = statements[index - 1]!
                const current = statements[index]!

                if (
                    !isSeparatedStatementType(previous.type)
                    && !isSeparatedStatementType(current.type)
                )
                    continue

                addSiblingGapReplacement(
                    previous,
                    current,
                    true,
                )
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
    let output = source

    for (const replacement of replacements.sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// Canonicalize control-flow headers, compound logical tests, compact bodies, `else` placement,
// and conditional-expression branches through one AST pass so their shared boundaries agree.
const canonicalizeConditionStatements = (
    file: string,
    source: string,
): string => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const comments = parseResult.comments as AstComment[]
    const replacements: LayoutSpan[] = []
    const addConditionedStatementHeader = (
        node: AstNode,
        test: AstNode,
        body: AstNode,
        keyword: string,
        compactBody: boolean,
    ): void => {
        const nodeRange = getNodeRange(node)
        const bodyRange = getNodeRange(body)

        if (
            !nodeRange
            || !bodyRange
            || hasCommentWithinRange(comments, [nodeRange[0], bodyRange[0]])
        )
            return

        const indentation = getLineIndentation(source, nodeRange[0])
        const header = getConditionContainerText(
            keyword,
            test,
            source,
            indentation,
        )

        if (!header)
            throw new Error(`Could not format the ${keyword} condition in ${file}`)

        const bodySeparator = compactBody ? `\n${indentation}    ` : ' '
        const replacement = `${header}${bodySeparator}`

        if (source.slice(nodeRange[0], bodyRange[0]) === replacement)
            return

        replacements.push({
            start: nodeRange[0],
            end: bodyRange[0],
            text: replacement,
        })
    }

    // A loop whose body is a single statement gets the same shape as a brace-less `if`:
    // the body moves to its own line, one step in. Only whitespace sits between the head
    // and the body, so the head ends at the `)` immediately before it.
    const addLoopBodyBreak = (
        node: AstNode,
        body: AstNode | null | undefined,
    ): void => {
        const nodeRange = getNodeRange(node)
        const bodyRange = getNodeRange(body)

        if (
            !nodeRange
            || !body
            || !bodyRange
            || body.type === 'BlockStatement'
            || hasCommentWithinRange(comments, [nodeRange[0], bodyRange[0]])
        )
            return

        let headEnd = bodyRange[0]

        while (
            headEnd > nodeRange[0]
            && isWhitespaceCharacter(source[headEnd - 1])
        )
            headEnd--

        if (source[headEnd - 1] !== ')')
            return

        const replacement = `\n${getLineIndentation(source, nodeRange[0])}    `

        if (source.slice(headEnd, bodyRange[0]) === replacement)
            return

        replacements.push({
            start: headEnd,
            end: bodyRange[0],
            text: replacement,
        })
    }

    const visit = (node: AstNode): void => {
        if (node.type === 'IfStatement') {
            const nodeRange = getNodeRange(node)
            const consequent = node.consequent as AstNode | undefined
            const alternate = node.alternate as AstNode | null | undefined
            const consequentRange = getNodeRange(consequent)
            const alternateRange = getNodeRange(alternate)
            const test = node.test as AstNode | undefined
            const consequentIsCompact = Boolean(
                consequent
                && consequent.type !== 'BlockStatement'
                && compactIfStatementTypes.has(consequent.type),
            )
            const alternateIsCompact = Boolean(
                alternate
                && alternate.type !== 'BlockStatement'
                && alternate.type !== 'IfStatement'
                && compactIfStatementTypes.has(alternate.type),
            )

            if (
                test
                && consequent
            )
                addConditionedStatementHeader(
                    node,
                    test,
                    consequent,
                    'if',
                    consequentIsCompact,
                )

            if (
                nodeRange
                && alternate
                && alternateRange
                && consequent
                && consequentRange
                && !hasCommentWithinRange(comments, [consequentRange[1], alternateRange[0]])
                && (consequentIsCompact || alternateIsCompact)
            ) {
                const indentation = getLineIndentation(source, nodeRange[0])
                const beforeElse = consequentIsCompact ? `\n${indentation}` : ' '
                const afterElse = alternateIsCompact ? `\n${indentation}    ` : ' '
                const replacement = `${beforeElse}else${afterElse}`

                if (source.slice(consequentRange[1], alternateRange[0]) !== replacement) {
                    replacements.push({
                        start: consequentRange[1],
                        end: alternateRange[0],
                        text: replacement,
                    })
                }
            }
        } else if (node.type === 'WhileStatement') {
            const test = node.test as AstNode | undefined
            const body = node.body as AstNode | undefined

            if (
                test
                && body
            )
                addConditionedStatementHeader(
                    node,
                    test,
                    body,
                    'while',
                    body.type !== 'BlockStatement',
                )
        } else if (node.type === 'DoWhileStatement') {
            const nodeRange = getNodeRange(node)
            const test = node.test as AstNode | undefined
            const body = node.body as AstNode | undefined
            const bodyRange = getNodeRange(body)

            if (
                nodeRange
                && test
                && bodyRange
                && !hasCommentWithinRange(comments, [bodyRange[1], nodeRange[1]])
            ) {
                const indentation = getLineIndentation(source, nodeRange[0])
                const condition = getConditionContainerText(
                    'while',
                    test,
                    source,
                    indentation,
                )

                if (!condition)
                    throw new Error(`Could not format the do...while condition in ${file}`)

                const replacement = ` ${condition}`

                if (source.slice(bodyRange[1], nodeRange[1]) !== replacement) {
                    replacements.push({
                        start: bodyRange[1],
                        end: nodeRange[1],
                        text: replacement,
                    })
                }
            }
        } else if (node.type === 'ForStatement') {
            const nodeRange = getNodeRange(node)
            const test = node.test as AstNode | null | undefined
            const body = node.body as AstNode | undefined
            const bodyRange = getNodeRange(body)

            if (
                nodeRange
                && test
                && countLogicalEvaluations(test) > 1
                && body
                && bodyRange
                && !hasCommentWithinRange(comments, [nodeRange[0], bodyRange[0]])
            ) {
                const indentation = getLineIndentation(source, nodeRange[0])
                const clauseIndentation = `${indentation}    `
                const condition = getFormattedConditionText(
                    test,
                    source,
                    clauseIndentation,
                    false,
                )
                const initializer = isAstNode(node.init) ? getAstExpressionText(node.init, source) : ''
                const update = isAstNode(node.update) ? getAstExpressionText(node.update, source) : ''

                if (
                    !condition
                    || initializer == null
                    || update == null
                )
                    throw new Error(`Could not format the for condition in ${file}`)

                const clauses = [
                    `for (`,
                    `${clauseIndentation}${initializer};`,
                    `${condition};`,
                ]

                if (update)
                    clauses.push(`${clauseIndentation}${update}`)

                clauses.push(`${indentation})${body.type === 'BlockStatement' ? ' ' : `\n${clauseIndentation}`}`)
                const replacement = clauses.join('\n')

                if (source.slice(nodeRange[0], bodyRange[0]) !== replacement) {
                    replacements.push({
                        start: nodeRange[0],
                        end: bodyRange[0],
                        text: replacement,
                    })
                }
            } else
                addLoopBodyBreak(node, body)
        } else if (
            node.type === 'ForOfStatement'
            || node.type === 'ForInStatement'
        )
            addLoopBodyBreak(node, node.body as AstNode | undefined)
        else if (node.type === 'ConditionalExpression') {
            const test = node.test as AstNode | undefined
            const consequent = node.consequent as AstNode | undefined
            const alternate = node.alternate as AstNode | undefined
            const testRange = getNodeRange(test)
            const consequentRange = getNodeRange(consequent)
            const alternateRange = getNodeRange(alternate)

            if (
                test
                && testRange
                && consequentRange
                && alternateRange
                && countLogicalEvaluations(test) > 1
                && !hasCommentWithinRange(comments, [testRange[0], alternateRange[0]])
            ) {
                const indentation = getLineIndentation(source, testRange[0])
                const branchIndentation = `${indentation}    `
                const condition = getContinuedConditionText(
                    test,
                    source,
                    indentation,
                )

                if (!condition)
                    throw new Error(`Could not format the ternary condition in ${file}`)

                const conditionReplacement = `${condition}\n${branchIndentation}? `

                if (source.slice(testRange[0], consequentRange[0]) !== conditionReplacement) {
                    replacements.push({
                        start: testRange[0],
                        end: consequentRange[0],
                        text: conditionReplacement,
                    })
                }

                const alternateReplacement = `\n${branchIndentation}: `

                if (source.slice(consequentRange[1], alternateRange[0]) !== alternateReplacement) {
                    replacements.push({
                        start: consequentRange[1],
                        end: alternateRange[0],
                        text: alternateReplacement,
                    })
                }
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
    const nonOverlappingReplacements: LayoutSpan[] = []

    for (const replacement of replacements.sort((left, right) => right.end - right.start - (left.end - left.start) || left.start - right.start)) {
        const overlapsSelectedReplacement = nonOverlappingReplacements.some(
            candidate => replacement.start < candidate.end && replacement.end > candidate.start,
        )

        if (!overlapsSelectedReplacement)
            nonOverlappingReplacements.push(replacement)
    }

    let output = source

    for (const replacement of nonOverlappingReplacements.sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// Return the child nodes that should sit one indentation level inside a syntax container.
// The supported shapes cover statements, classes, types, switch cases, and literal members.
const getIndentedContainerChildren = (node: AstNode): AstNode[] | null => {
    if (node.type === 'Program')
        return Array.isArray(node.body) ? node.body.filter(isAstNode) : null

    if (
        node.type === 'BlockStatement'
        || node.type === 'ClassBody'
        || node.type === 'StaticBlock'
        || node.type === 'TSInterfaceBody'
        || node.type === 'TSModuleBlock'
    )
        return Array.isArray(node.body) ? node.body.filter(isAstNode) : null

    if (node.type === 'SwitchStatement')
        return Array.isArray(node.cases) ? node.cases.filter(isAstNode) : null

    if (node.type === 'SwitchCase')
        return Array.isArray(node.consequent) ? node.consequent.filter(isAstNode) : null

    if (
        node.type === 'ObjectExpression'
        || node.type === 'ObjectPattern'
    )
        return Array.isArray(node.properties) ? node.properties.filter(isAstNode) : null

    if (
        node.type === 'ArrayExpression'
        || node.type === 'ArrayPattern'
    )
        return Array.isArray(node.elements) ? node.elements.filter(isAstNode) : null

    // An argument list keeps its own indentation even when the split decision belongs
    // to another rule, so a list this pass does not rewrite cannot drift.
    if (
        node.type === 'CallExpression'
        || node.type === 'NewExpression'
    ) {
        const argumentNodes = Array.isArray(node.arguments) ? node.arguments.filter(isAstNode) : null

        return (
            argumentNodes
            && argumentNodes.length > 0
        )
            ? argumentNodes
            : null
    }

    if (node.type === 'TSTypeLiteral')
        return Array.isArray(node.members) ? node.members.filter(isAstNode) : null

    return null
}

// Locate the closing delimiter that aligns with a container's opening indentation. Pattern
// type annotations are excluded because they extend beyond the pattern's own closing bracket.
const getIndentedContainerClosingOffset = (
    node: AstNode,
    source: string,
): number | null => {
    if (
        node.type === 'Program'
        || node.type === 'SwitchCase'
    )
        return null

    const nodeRange = getNodeRange(node)

    if (!nodeRange)
        return null

    let end = nodeRange[1]

    if (
        node.type === 'ObjectPattern'
        || node.type === 'ArrayPattern'
    ) {
        const typeAnnotationRange = getNodeRange(node.typeAnnotation as AstNode)

        if (typeAnnotationRange)
            end = typeAnnotationRange[0]
    }

    const closingOffset = getTrailingWhitespaceStart(
        source,
        nodeRange[0],
        end,
    ) - 1
    let expectedCharacter = '}'

    if (
        node.type === 'ArrayExpression'
        || node.type === 'ArrayPattern'
    )
        expectedCharacter = ']'
    else if (
        node.type === 'CallExpression'
        || node.type === 'NewExpression'
    )
        expectedCharacter = ')'

    return source[closingOffset] === expectedCharacter ? closingOffset : null
}

// Align direct children and closing delimiters for one AST snapshot. Duplicate requests for
// the same whitespace range must agree, otherwise two container rules are in conflict.
const canonicalizeContainerIndentationOnce = (
    file: string,
    source: string,
): string => {
    const parseResult = parseTypeScript(file, source)

    if (parseResult.errors.length > 0)
        throw new Error(`Oxc parser could not parse ${file}: ${JSON.stringify(parseResult.errors[0])}`)

    const replacementsByRange = new Map<string, LayoutSpan>()
    const addIndentationReplacement = (
        offset: number,
        indentation: string,
        containerStart: number,
    ): void => {
        const lineStart = getLineStart(source, offset)

        if (lineStart === getLineStart(source, containerStart))
            return

        const currentIndentation = source.slice(lineStart, offset)

        if ([...currentIndentation].some(character => character !== ' ' && character !== '\t'))
            return

        if (currentIndentation === indentation)
            return

        const key = `${lineStart}:${offset}`
        const existing = replacementsByRange.get(key)

        if (
            existing
            && existing.text !== indentation
        )
            throw new Error(`Conflicting indentation rules in ${file}`)

        replacementsByRange.set(
            key,
            {
                start: lineStart,
                end: offset,
                text: indentation,
            },
        )
    }

    const visit = (node: AstNode): void => {
        const nodeRange = getNodeRange(node)
        const children = getIndentedContainerChildren(node)

        if (
            nodeRange
            && children
        ) {
            const anchor = getDelimitedListAnchor(
                node,
                nodeRange,
                source,
            )
            const indentation = node.type === 'Program'
                ? ''
                : `${getLineIndentation(source, anchor)}    `

            for (const child of children) {
                const childRange = getNodeRange(child)

                if (childRange)
                    addIndentationReplacement(
                        childRange[0],
                        indentation,
                        nodeRange[0],
                    )
            }

            const closingOffset = getIndentedContainerClosingOffset(node, source)

            if (closingOffset != null)
                addIndentationReplacement(
                    closingOffset,
                    getLineIndentation(source, anchor),
                    anchor,
                )
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
    let output = source

    for (const replacement of [...replacementsByRange.values()].sort((left, right) => right.start - left.start))
        output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`

    return output
}

// Repeat indentation because correcting an outer container changes the desired indentation
// of every nested container. The pass limit exposes non-converging ownership rules.
const canonicalizeContainerIndentation = (
    file: string,
    source: string,
): string => {
    let output = source

    for (let pass = 0; pass < 20; pass++) {
        const formatted = canonicalizeContainerIndentationOnce(file, output)

        if (formatted === output)
            return output

        output = formatted
    }

    throw new Error(`Could not stabilize container indentation in ${file}`)
}

// Run all repository layout passes until they reach a common fixed point. The ordering gives
// structural passes first claim, then repairs shared boundaries after imports and spacing move.
const canonicalizeTypeScriptLayout = (
    file: string,
    source: string,
    htmlFormatted: string,
    printWidth: number,
): string => {
    let output = source

    for (let pass = 0; pass < 20; pass++) {
        const indented = canonicalizeContainerIndentation(file, output)
        const canonicalDelimitedLists = canonicalizeDelimitedLists(
            file,
            indented,
            printWidth,
        )
        const canonicalConditionStatements = canonicalizeConditionStatements(file, canonicalDelimitedLists)
        const canonicalAssignmentBoundaries = canonicalizeAssignmentBoundaries(file, canonicalConditionStatements)
        const canonicalAssignedLogicalExpressions = canonicalizeAssignedLogicalExpressions(file, canonicalAssignmentBoundaries)
        const canonicalArrowParameters = canonicalizeArrowParameters(file, canonicalAssignedLogicalExpressions)
        const canonicalArrowBodies = canonicalizeExpressionArrowBodies(file, canonicalArrowParameters)
        const canonicalIteratorChains = canonicalizeIteratorChains(file, canonicalArrowBodies)
        const canonicalConditionalExpressions = canonicalizeNestedConditionalExpressions(file, canonicalIteratorChains)
        const formattedHtmlTemplates = applyHtmlTemplateFormatting(
            file,
            canonicalConditionalExpressions,
            htmlFormatted,
        )
        const canonicalHtmlTemplates = canonicalizeHtmlTemplateBoundaries(file, formattedHtmlTemplates)
        const canonicalHtmlAttributes = canonicalizeEmbeddedHtmlAttributes(file, canonicalHtmlTemplates)
        const canonicalHtmlInterpolations = canonicalizeHtmlTemplateInterpolations(file, canonicalHtmlAttributes)
        const canonicalStatementSpacing = canonicalizeStatementSpacing(file, canonicalHtmlInterpolations)
        const canonicalImports = canonicalizeImportLayout(
            canonicalStatementSpacing,
            true,
            file,
        ).output
        const formatted = canonicalizeConditionStatements(
            file,
            canonicalizeContainerIndentation(file, canonicalImports),
        )

        if (formatted === output)
            return output

        output = formatted
    }

    throw new Error(`Could not stabilize TypeScript formatting in ${file}`)
}

// Use Oxfmt for the baseline result, preserve authored TypeScript expansion, then apply the
// repository passes. A wider second Oxfmt result supplies HTML template formatting without
// forcing TypeScript arrow expressions to wrap at the normal print width.
const formatSource = async (
    file: string,
    source: string,
    config: FormatConfig,
): Promise<string> => {
    const result = await format(
        file,
        source,
        config,
    )

    if (result.errors.length > 0) {
        for (const error of result.errors) {
            err(`${file}: ${error.message}`)

            if (error.codeframe)
                err(error.codeframe)
        }

        throw new Error(`Oxfmt could not format ${file}`)
    }

    if (!file.endsWith('.ts'))
        return canonicalizeStandaloneHtmlAttributes(result.code)

    const htmlResult = await format(
        file,
        source,
        {
            ...config,
            printWidth: maximumInlineArrowFunctionLength,
        },
    )

    if (htmlResult.errors.length > 0)
        throw new Error(`Oxfmt could not format embedded HTML in ${file}`)

    const formattedConditionStatements = canonicalizeConditionStatements(file, result.code)
    const preserved = preserveExpandedTypeScriptLayouts(
        file,
        source,
        formattedConditionStatements,
    )

    return canonicalizeTypeScriptLayout(
        file,
        preserved,
        htmlResult.code,
        config.printWidth ?? maximumInlineArrowFunctionLength,
    )
}

// Check mode reports the first differing line with current and expected text, which gives a
// useful diagnostic without dumping an entire formatted file.
const describeFirstFormattingDifference = (
    file: string,
    source: string,
    formatted: string,
): void => {
    let offset = 0

    while (
        offset < source.length
        && offset < formatted.length
        && source[offset] === formatted[offset]
    )
        offset++

    const line = source.slice(0, offset).split('\n').length
    const contextStart = Math.max(0, source.lastIndexOf('\n', offset - 1) + 1)
    const sourceContextEnd = source.indexOf('\n', offset)
    const formattedContextEnd = formatted.indexOf('\n', offset)
    err(`${file}:${line}: formatting differs`)
    err(`current: ${JSON.stringify(
        source.slice(contextStart, sourceContextEnd < 0 ? source.length : sourceContextEnd),
    )}`)
    err(`expected: ${JSON.stringify(
        formatted.slice(contextStart, formattedContextEnd < 0 ? formatted.length : formattedContextEnd),
    )}`)
}

// Validate arguments and prohibited extensions before formatting any file. Fix mode writes
// canonical text; check mode reports differences and fails after scanning every selected file.
const [mode, ...inputPaths] = process.argv.slice(2)

if (
    (mode !== 'check' && mode !== 'fix')
    || inputPaths.length === 0
) {
    err('Usage: typescript-format-runner.ts {check|fix} <path...>')
    process.exit(1)
}

const {
    files,
    prohibitedFiles,
} = await collectFormattingFiles(inputPaths)

if (prohibitedFiles.length > 0) {
    for (const file of prohibitedFiles)
        err(`${file}: JSX source files are prohibited; use a .ts module and the repository DOM APIs`)

    process.exit(1)
}

const formatConfig = await readFormatConfig()
let changedFileCount = 0

for (const file of files) {
    const source = await readFile(file, 'utf8')
    const formatted = await formatSource(
        file,
        source,
        formatConfig,
    )

    if (formatted === source)
        continue

    changedFileCount++

    if (mode === 'fix')
        await writeFile(file, formatted)
    else
        describeFirstFormattingDifference(
            file,
            source,
            formatted,
        )
}

if (mode === 'fix') {
    if (changedFileCount > 0)
        log(`Formatted ${changedFileCount} TypeScript and HTML file(s).`)
} else if (changedFileCount > 0) {
    err(`Found ${changedFileCount} TypeScript and HTML formatting violation(s).`)
    process.exit(1)
}
