import { defineRule } from '@oxlint/plugins'

// A conditional expression may go one level deep. Nesting a second one inside the test,
// the consequent or the alternate hides the branching, and no layout rescues it.
export const noNestedTernary = defineRule({
    meta: {
        type: 'suggestion',
        messages: {
            noNestedTernary: 'Nested ternary expressions are not allowed. Rewrite this as an if statement or an early return. When several groups of conditions decide the same value, use a membership test such as [...].includes(value), a lookup object keyed by the value, or a small named helper, instead of chaining ternaries.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context
        const unwrap = node => {
            let current = node

            while (
                current?.type === 'TSAsExpression'
                || current?.type === 'TSNonNullExpression'
            )
                current = current.expression

            return current
        }
        const isConditional = node => unwrap(node)?.type === 'ConditionalExpression'

        return {
            ConditionalExpression(node) {
                // Report the outer expression only, so one nested chain is one error
                // rather than one error for every level in it.
                const parent = sourceCode.getAncestors
                    ? sourceCode.getAncestors(node).at(-1)
                    : node.parent

                if (isConditional(parent))
                    return

                if (
                    !isConditional(node.test)
                    && !isConditional(node.consequent)
                    && !isConditional(node.alternate)
                )
                    return

                context.report({
                    node,
                    messageId: 'noNestedTernary',
                })
            },
        }
    },
})
