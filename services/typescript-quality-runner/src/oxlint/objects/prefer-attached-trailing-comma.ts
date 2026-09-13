import { defineRule } from '@oxlint/plugins'

// Move a trailing comma back beside the final item when a formatter left it on its own
// line. A comment between the item and comma blocks the fix to preserve attachment.
export const preferAttachedTrailingComma = defineRule({
    meta: {
        type: 'layout',
        fixable: 'whitespace',
        messages: {
            attachTrailingComma: 'Keep a trailing comma on the same line as the preceding syntax node.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context

        const checkLastItem = (
            container,
            items,
        ): void => {
            const lastItem = items.at(-1)

            if (!lastItem)
                return

            const comma = sourceCode.getTokenAfter(lastItem)
            const closeToken = sourceCode.getLastToken(container)

            if (
                comma?.value !== ','
                || !closeToken
                || comma.range[0] >= closeToken.range[0]
                || comma.loc.start.line === lastItem.loc.end.line
                || sourceCode.getCommentsInside(container).some(
                    comment =>
                        comment.range[0] >= lastItem.range[1]
                        && comment.range[1] <= comma.range[0],
                )
            )
                return

            context.report({
                node: comma,
                messageId: 'attachTrailingComma',
                fix: fixer => fixer.replaceTextRange([lastItem.range[1], comma.range[1]], ','),
            })
        }

        return {
            ArrayExpression: node => checkLastItem(node, node.elements),
            ArrayPattern: node => checkLastItem(node, node.elements),
            CallExpression: node => checkLastItem(node, node.arguments),
            ImportExpression: node => checkLastItem(node, node.options ? [node.options] : []),
            NewExpression: node => checkLastItem(node, node.arguments),
            ObjectExpression: node => checkLastItem(node, node.properties),
            ObjectPattern: node => checkLastItem(node, node.properties),
        }
    },
})
