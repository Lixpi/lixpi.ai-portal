import { defineRule } from '@oxlint/plugins'

// The quality runner must reason from parsed syntax. These raw-string methods are banned
// when they inspect variables that conventionally hold source or formatted code.
const rawSyntaxInspectionMethods = new Set([
    'match',
    'matchAll',
    'replace',
    'replaceAll',
    'search',
])
const syntaxSourceNames = new Set([
    'body',
    'condition',
    'formatted',
    'source',
    'text',
])

// Return a static property name for dot access and string-literal bracket access. Dynamic
// computed members cannot be classified safely by syntax rules.
const getMemberPropertyName = (member): string | null => {
    if (
        !member.computed
        && member.property.type === 'Identifier'
    )
        return member.property.name

    if (
        member.computed
        && member.property.type === 'Literal'
        && typeof member.property.value === 'string'
    )
        return member.property.value

    return null
}

// Walk through calls and member access to identify the source variable being inspected by
// a chained raw-string operation.
const getRootIdentifierName = (node): string | null => {
    let current = node

    while (
        current?.type === 'CallExpression'
        || current?.type === 'MemberExpression'
    ) {
        if (current.type === 'CallExpression')
            current = current.callee
        else
            current = current.object
    }

    return current?.type === 'Identifier' ? current.name : null
}

// Prevent quality-runner rules from searching source strings for syntax. AST inspection is
// stable across whitespace and comments, while regex and substring checks are not.
export const requireAstFormatterRules = defineRule({
    meta: {
        type: 'problem',
        messages: {
            requireAst: 'Quality-runner syntax rules must inspect parsed AST nodes instead of searching raw source text.',
        },
        schema: [],
    },
    create(context) {
        const report = (node): void => void context.report({
            node,
            messageId: 'requireAst',
        })

        return {
            CallExpression(node) {
                if (
                    node.callee.type === 'Identifier'
                    && node.callee.name === 'RegExp'
                ) {
                    report(node)

                    return
                }

                if (node.callee.type !== 'MemberExpression')
                    return

                const methodName = getMemberPropertyName(node.callee)

                if (!methodName)
                    return

                if (rawSyntaxInspectionMethods.has(methodName)) {
                    report(node)

                    return
                }

                if (
                    methodName !== 'endsWith'
                    && methodName !== 'startsWith'
                    && methodName !== 'includes'
                    && methodName !== 'indexOf'
                    && methodName !== 'lastIndexOf'
                    && methodName !== 'split'
                )
                    return

                const rootName = getRootIdentifierName(node.callee.object)

                if (
                    !rootName
                    || !syntaxSourceNames.has(rootName)
                )
                    return

                const separator = node.arguments[0]

                if (
                    separator?.type === 'Literal'
                    && separator.value === '\n'
                )
                    return

                report(node)
            },
            Literal(node) {
                if (node.regex)
                    report(node)
            },
            NewExpression(node) {
                if (
                    node.callee.type === 'Identifier'
                    && node.callee.name === 'RegExp'
                )
                    report(node)
            },
        }
    },
})
