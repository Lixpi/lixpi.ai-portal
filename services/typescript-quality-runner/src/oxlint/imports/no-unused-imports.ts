import { defineRule } from '@oxlint/plugins'
import { parseSync } from 'oxc-parser'
import { debugLoggingMethods } from '../shared/debug-logging-methods.ts'

const isAstNode = (value: unknown): boolean => Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { type?: unknown }).type === 'string',
)

// Collect identifiers from parsed comment fragments so references used in examples or
// suppression explanations do not cause their imports to be removed automatically.
const collectIdentifierNames = (
    node,
    names: Set<string>,
): void => {
    if (node.type === 'Identifier')
        names.add(node.name)

    for (const [key, value] of Object.entries(node)) {
        if (key === 'parent')
            continue

        if (Array.isArray(value)) {
            for (const child of value)
                if (isAstNode(child))
                    collectIdentifierNames(child, names)
        } else if (isAstNode(value))
            collectIdentifierNames(value, names)
    }
}

// Consecutive line comments are parsed together as code when possible. Parsing each line
// as well also recovers identifiers from comment prose that is not a valid module.
const getCommentReferencedIdentifierNames = (sourceCode): Set<string> => {
    const names = new Set<string>()
    const commentBlocks: string[] = []
    let currentLines: string[] = []
    let previousLineComment = null

    const flushCurrentLines = (): void => {
        if (currentLines.length > 0)
            commentBlocks.push(
                currentLines.join('\n'),
            )

        currentLines = []
    }

    for (const comment of sourceCode.getAllComments()) {
        if (
            comment.type === 'Line'
            && (previousLineComment == null || comment.loc.start.line === previousLineComment.loc.end.line + 1)
        ) {
            currentLines.push(comment.value)
            previousLineComment = comment

            continue
        }

        flushCurrentLines()
        previousLineComment = null

        if (comment.type === 'Block')
            commentBlocks.push(comment.value)

        if (comment.type === 'Line') {
            currentLines.push(comment.value)
            previousLineComment = comment
        }
    }

    flushCurrentLines()

    for (const commentBlock of commentBlocks)
        for (const commentSource of [commentBlock, ...commentBlock.split('\n')]) {
            const parseResult = parseSync(
                'comment-reference.ts',
                commentSource,
                {
                    astType: 'ts',
                    preserveParens: true,
                    range: true,
                },
            )
            collectIdentifierNames(parseResult.program, names)
        }

    return names
}

// Remove import bindings with no code or comment references. Rebuilding the declaration
// in one fix preserves default, namespace, and remaining named specifiers as one import.
export const noUnusedImports = defineRule({
    meta: {
        type: 'problem',
        fixable: 'code',
        messages: {
            unusedImport: "Imported identifier '{{name}}' is never used.",
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context
        // `no-native-console-logging` rewrites `console.log(...)` onto the debug-tools
        // specifier of the same name in this very fix round. Removing that specifier as
        // unused in the same round leaves the rewritten call with nothing to bind to, so
        // a specifier the console rule is about to claim counts as used.
        const pendingConsoleImportNames = new Set()

        return {
            CallExpression(node) {
                if (
                    node.callee.type !== 'MemberExpression'
                    || node.callee.computed
                    || node.callee.object.type !== 'Identifier'
                    || node.callee.object.name !== 'console'
                    || node.callee.property.type !== 'Identifier'
                    || !debugLoggingMethods.has(node.callee.property.name)
                )
                    return

                pendingConsoleImportNames.add(debugLoggingMethods.get(node.callee.property.name).importedName)
            },
            'Program:exit'() {
                const commentReferencedNames = getCommentReferencedIdentifierNames(sourceCode)
                const unusedSpecifiersByDeclaration = new Map()

                for (const scope of context.sourceCode.scopeManager.scopes)
                    for (const variable of scope.variables) {
                        if (
                            variable.references.length > 0
                            || commentReferencedNames.has(variable.name)
                        )
                            continue

                        const importDefinition = variable.defs.find(definition => definition.type === 'ImportBinding')

                        if (!importDefinition)
                            continue

                        const specifier = importDefinition.name.parent
                        const declaration = specifier?.parent

                        if (
                            !specifier
                            || declaration?.type !== 'ImportDeclaration'
                        )
                            continue

                        if (
                            declaration.source.value === '@lixpi/debug-tools'
                            && specifier.type === 'ImportSpecifier'
                            && specifier.imported.type === 'Identifier'
                            && pendingConsoleImportNames.has(specifier.imported.name)
                        )
                            continue

                        const unusedSpecifiers = (
                            unusedSpecifiersByDeclaration.get(declaration)
                            ?? []
                        )
                        unusedSpecifiers.push({
                            name: variable.name,
                            specifier,
                        })
                        unusedSpecifiersByDeclaration.set(declaration, unusedSpecifiers)
                    }

                for (const [declaration, unusedSpecifiers] of unusedSpecifiersByDeclaration) {
                    const unusedNodes = new Set(
                        unusedSpecifiers.map(({ specifier }) => specifier),
                    )
                    const remainingSpecifiers = declaration.specifiers.filter(specifier => !unusedNodes.has(specifier))
                    const names = unusedSpecifiers.map(({ name }) => name).join(', ')

                    context.report({
                        node: unusedSpecifiers[0].specifier,
                        messageId: 'unusedImport',
                        data: { name: names },
                        fix: fixer => {
                            if (remainingSpecifiers.length === 0)
                                return fixer.remove(declaration)

                            const defaultSpecifier = remainingSpecifiers.find(specifier => specifier.type === 'ImportDefaultSpecifier')
                            const namespaceSpecifier = remainingSpecifiers.find(specifier => specifier.type === 'ImportNamespaceSpecifier')
                            const namedSpecifiers = remainingSpecifiers.filter(specifier => specifier.type === 'ImportSpecifier')
                            const clauseParts: string[] = []

                            if (defaultSpecifier)
                                clauseParts.push(
                                    sourceCode.getText(defaultSpecifier),
                                )

                            if (namespaceSpecifier)
                                clauseParts.push(
                                    sourceCode.getText(namespaceSpecifier),
                                )

                            if (namedSpecifiers.length > 0)
                                clauseParts.push(`{ ${namedSpecifiers.map(specifier => sourceCode.getText(specifier)).join(', ')} }`)

                            const sourceText = sourceCode.getText(declaration.source)
                            const suffix = sourceCode.text.slice(declaration.source.range[1], declaration.range[1])

                            return fixer.replaceText(declaration, `import ${clauseParts.join(', ')} from ${sourceText}${suffix}`)
                        },
                    })
                }
            },
        }
    },
})
