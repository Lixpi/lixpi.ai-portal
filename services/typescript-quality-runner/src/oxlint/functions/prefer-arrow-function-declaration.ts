import { defineRule } from '@oxlint/plugins'

// A declaration called above its own definition still has to become an arrow
// function, but rewriting it in place would leave the call in the temporal dead
// zone. The rule reports it and withholds the fix, so a person moves the definition
// above its first use instead of the formatter breaking the file.
const isCalledBeforeItIsDeclared = (
    context,
    node,
): boolean =>
    context.sourceCode.scopeManager.scopes.some(
        scope =>
            scope.variables.some(
                variable =>
                    variable.name === node.id.name
                    && variable.defs.some(definition => definition.node === node || definition.name === node.id)
                    && variable.references.some(reference => reference.identifier.range[0] < node.range[0]),
            ),
    )

// Replace declarations with `const` arrow functions while withholding the fix when the
// declaration relied on function hoisting and must first be moved by a developer.
export const preferArrowFunctionDeclaration = defineRule({
    meta: {
        type: 'suggestion',
        fixable: 'code',
        messages: {
            preferArrowFunction: 'Use an arrow function instead of a plain function declaration.',
            preferArrowFunctionMoveDefinition: 'Use an arrow function instead of a plain function declaration. It is called above its definition, so move the definition above its first use.',
        },
        schema: [],
    },
    create(context) {
        return {
            FunctionDeclaration(node) {
                // Arrow functions require a name and implementation body, cannot represent
                // generators, and cannot directly follow `export default` as a const.
                if (
                    !node.id
                    || !node.body
                    || node.generator
                    || node.parent?.type === 'ExportDefaultDeclaration'
                )
                    return

                const replacement = `const ${node.id.name} = ${node.async ? 'async ' : ''}`
                const hoisted = isCalledBeforeItIsDeclared(context, node)

                context.report({
                    node,
                    messageId: hoisted
                        ? 'preferArrowFunctionMoveDefinition'
                        : 'preferArrowFunction',
                    ...(hoisted
                        ? {}
                        : {
                            fix: fixer => [
                                fixer.replaceTextRange([node.range[0], node.id.range[1]], replacement),
                                fixer.insertTextBefore(node.body, '=> '),
                            ],
                        }),
                })
            },
        }
    },
})
