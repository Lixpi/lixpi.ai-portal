import { defineRule } from '@oxlint/plugins'
import { getLineIndentation } from '../shared/source-text.ts'
import { debugLoggingMethods } from '../shared/debug-logging-methods.ts'

// Replace backend `console` calls with debug-tools functions. The rule reuses existing
// imports, creates collision-safe aliases, and batches all call and import edits per file.
export const noNativeConsoleLogging = defineRule({
    meta: {
        type: 'problem',
        fixable: 'code',
        messages: {
            useDebugTools: "Use '@lixpi/debug-tools' instead of native console logging.",
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context
        const consoleCalls = []

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

                consoleCalls.push({
                    member: node.callee,
                    methodName: node.callee.property.name,
                })
            },
            'Program:exit'(program) {
                if (consoleCalls.length === 0)
                    return

                const debugImport = program.body.find(node => node.type === 'ImportDeclaration' && node.source.value === '@lixpi/debug-tools')
                const localNames = new Set(
                    context.sourceCode.scopeManager.scopes.flatMap(scope => scope.variables.map(variable => variable.name)),
                )
                const methodLocalNames = new Map()

                if (debugImport) {
                    for (const specifier of debugImport.specifiers) {
                        if (
                            specifier.type !== 'ImportSpecifier'
                            || specifier.imported.type !== 'Identifier'
                        )
                            continue

                        if (!debugLoggingMethods.has(specifier.imported.name))
                            continue

                        methodLocalNames.set(specifier.imported.name, specifier.local.name)
                    }
                }

                const usedMethods = [...new Set(
                    consoleCalls.map(({ methodName }) => methodName),
                )]
                const addedSpecifiers = []

                for (const methodName of usedMethods) {
                    const config = debugLoggingMethods.get(methodName)

                    if (methodLocalNames.has(config.importedName))
                        continue

                    let localName = config.preferredLocalName
                    let suffix = 2

                    while (localNames.has(localName)) {
                        localName = `${config.preferredLocalName}${suffix}`
                        suffix++
                    }

                    localNames.add(localName)
                    methodLocalNames.set(config.importedName, localName)
                    addedSpecifiers.push(`${config.importedName} as ${localName}`)
                }

                context.report({
                    node: consoleCalls[0].member,
                    messageId: 'useDebugTools',
                    fix: fixer => {
                        const fixes = consoleCalls.map(
                            ({
                                member,
                                methodName,
                            }) => {
                                const importedName = debugLoggingMethods.get(methodName).importedName

                                return fixer.replaceText(
                                    member,
                                    methodLocalNames.get(importedName),
                                )
                            },
                        )

                        if (addedSpecifiers.length === 0)
                            return fixes

                        if (
                            debugImport
                            && debugImport.specifiers.every(specifier => specifier.type === 'ImportSpecifier')
                        ) {
                            const closeBrace = sourceCode.getTokens(debugImport).findLast(token => token.value === '}')

                            if (closeBrace) {
                                const importText = sourceCode.getText(debugImport)
                                const insertion = importText.includes('\n')
                                    ? `${getLineIndentation(sourceCode.text, closeBrace.range[0])}    ${addedSpecifiers.join(
                                        `,\n${getLineIndentation(sourceCode.text, closeBrace.range[0])}    `,
                                    )},\n`
                                    : `, ${addedSpecifiers.join(', ')}`
                                fixes.push(
                                    fixer.insertTextBefore(closeBrace, insertion),
                                )

                                return fixes
                            }
                        }

                        const declaration = `import { ${addedSpecifiers.join(', ')} } from '@lixpi/debug-tools'\n`
                        const firstStatement = program.body[0]
                        fixes.push(firstStatement ? fixer.insertTextBefore(firstStatement, declaration) : fixer.insertTextAfter(program, declaration))

                        return fixes
                    },
                })
            },
        }
    },
})
