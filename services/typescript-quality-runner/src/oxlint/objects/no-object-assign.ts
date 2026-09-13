import { defineRule } from '@oxlint/plugins'

const isObjectAssignCall = (node): boolean => {
    const callee = node.callee

    if (
        callee?.type !== 'MemberExpression'
        || callee.optional
        || callee.object.type !== 'Identifier'
        || callee.object.name !== 'Object'
    )
        return false

    return callee.computed
        ? callee.property.type === 'Literal' && callee.property.value === 'assign'
        : callee.property.type === 'Identifier' && callee.property.name === 'assign'
}

// An object literal cannot open a statement or an arrow body, so the replacement needs
// parentheses when the call is the leftmost token of either.
const startsStatementOrArrowBody = (node): boolean => {
    let current = node

    while (
        current.parent
        && current.parent.range[0] === node.range[0]
    ) {
        if (current.parent.type === 'ExpressionStatement')
            return true

        current = current.parent
    }

    return current.parent?.type === 'ArrowFunctionExpression' && current.parent.body === current
}

// An object-literal source is inlined as its own properties instead of being spread.
const getSpreadMemberText = (
    source,
    sourceCode,
): string => {
    if (
        source.type === 'ObjectExpression'
        && source.properties.length > 0
        && source.properties.every(property => property.type === 'SpreadElement' || property.kind === 'init')
    )
        return source.properties.map(property => sourceCode.getText(property)).join(', ')

    return source.type === 'SequenceExpression'
        ? `...(${sourceCode.getText(source)})`
        : `...${sourceCode.getText(source)}`
}

// A reassigned target is written twice, so it must be a plain reference whose evaluation has
// no side effects. DOM `style` objects cannot be replaced by a plain object.
const isReassignableReference = (node): boolean => {
    if (node.type === 'Identifier')
        return true

    if (
        node.type !== 'MemberExpression'
        || node.optional
    )
        return false

    if (node.computed ? node.property.type !== 'Literal' : node.property.name === 'style')
        return false

    return node.object.type === 'ThisExpression' || isReassignableReference(node.object)
}

const findVariable = (
    scope,
    name: string,
) => {
    for (let current = scope; current; current = current.upper) {
        const variable = current.set.get(name)

        if (variable)
            return variable
    }

    return undefined
}

// Object.assign is replaced by object spread. A fresh-literal target becomes the spread
// literal, a statement that mutates a reference becomes a spread reassignment, and a
// `const` binding of that reference becomes `let`. Calls whose returned object is used
// with a non-literal target, such as decorating an Error or a mock, are reported.
// Writes onto an element's `style` are allowed.
export const noObjectAssign = defineRule({
    meta: {
        type: 'suggestion',
        fixable: 'code',
        messages: {
            preferSpread: 'Use object spread instead of Object.assign.',
            noMutation: 'Object.assign mutates an object whose identity is used. Build a new object with spread.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context

        return {
            CallExpression(node) {
                if (!isObjectAssignCall(node))
                    return

                const [target, ...sources] = node.arguments
                const safeToRewrite = (
                    !node.typeArguments
                    && sourceCode.getCommentsInside(node).length === 0
                )

                // An element's CSSStyleDeclaration can't be replaced by a new object, and
                // Object.assign is the idiomatic way to write several properties onto it.
                if (
                    target?.type === 'MemberExpression'
                    && !target.computed
                    && target.property.name === 'style'
                )
                    return

                if (target?.type === 'ObjectExpression') {
                    const literalProperties = target.properties.every(property => property.type === 'SpreadElement' || property.kind === 'init')
                    const spreadSource = sources.length === 1
                        && sources[0].type === 'SpreadElement'
                        ? sources[0]
                        : undefined
                    const canFix = (
                        safeToRewrite
                        && literalProperties
                        && (spreadSource || sources.every(source => source.type !== 'SpreadElement'))
                    )

                    context.report({
                        node,
                        messageId: 'preferSpread',
                        fix: canFix
                            ? fixer => {
                                const initialText = target.properties.length === 0 ? '{}' : sourceCode.getText(target)

                                if (spreadSource)
                                    return fixer.replaceText(
                                        node,
                                        `${sourceCode.getText(spreadSource.argument)}.reduce((merged, source) => ({ ...merged, ...source }), ${initialText})`,
                                    )

                                const members = [
                                    ...target.properties.map(property => sourceCode.getText(property)),
                                    ...sources.map(source => getSpreadMemberText(source, sourceCode)),
                                ]
                                const literal = members.length === 0 ? '{}' : `{ ${members.join(', ')} }`

                                return fixer.replaceText(node, startsStatementOrArrowBody(node) ? `(${literal})` : literal)
                            }
                            : undefined,
                    })

                    return
                }

                const statement = node.parent
                const variable = target?.type === 'Identifier' ? findVariable(
                    sourceCode.getScope(node),
                    target.name,
                ) : undefined
                const definition = variable?.defs[0]
                const bindingIsWritable = target?.type !== 'Identifier'
                    || (
                    variable?.defs.length === 1
                    && (
                        definition.type === 'Parameter'
                        || (definition.type === 'Variable' && definition.parent.declarations.length === 1)
                    )
                )
                const canFix = (
                    safeToRewrite
                    && statement?.type === 'ExpressionStatement'
                    && target
                    && isReassignableReference(target)
                    && sources.length > 0
                    && sources.every(source => source.type !== 'SpreadElement')
                    && bindingIsWritable
                )

                context.report({
                    node,
                    messageId: canFix ? 'preferSpread' : 'noMutation',
                    fix: canFix
                        ? fixer => {
                            const targetText = sourceCode.getText(target)
                            const members = [target, ...sources].map(member => getSpreadMemberText(member, sourceCode))
                            const fixes = [
                                fixer.replaceText(node, `${targetText} = { ${members.join(', ')} }`),
                            ]

                            if (
                                definition?.type === 'Variable'
                                && definition.parent.kind === 'const'
                            ) {
                                const declaration = definition.parent
                                fixes.push(
                                    fixer.replaceTextRange([declaration.range[0], declaration.range[0] + 'const'.length], 'let'),
                                )
                            }

                            return fixes
                        }
                        : undefined,
                })
            },
        }
    },
})
