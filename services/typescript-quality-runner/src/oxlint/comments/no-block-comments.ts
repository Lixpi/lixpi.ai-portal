import { defineRule } from '@oxlint/plugins'
import { getLineIndentation } from '../shared/source-text.ts'

// Block-comment conversion strips horizontal decoration while treating line breaks as
// meaningful boundaries for the generated `//` lines.
const isHorizontalWhitespace = (character: string | undefined): boolean => character === ' ' || character === '\t' || character === '\r'

// Remove block-comment padding and conventional leading stars, but preserve the words and
// intentional empty lines inside the comment.
const normalizeCommentLine = (line: string): string => {
    let start = 0
    let end = line.length

    while (
        start < end
        && isHorizontalWhitespace(line[start])
    )
        start++

    if (line[start] === '*') {
        start++

        if (line[start] === ' ')
            start++
    }

    while (
        end > start
        && isHorizontalWhitespace(line[end - 1])
    )
        end--

    return line.slice(start, end)
}

// Build line comments at the original indentation. Syntax that followed the closing block
// marker on the same line moves to its own correctly indented line.
const getLineCommentReplacement = (
    comment,
    sourceCode,
): string => {
    const lines = comment.value.split('\n').map(normalizeCommentLine)

    while (lines[0] === '')
        lines.shift()

    while (lines.at(-1) === '')
        lines.pop()

    if (lines.length === 0)
        lines.push('')

    const indentation = getLineIndentation(sourceCode.text, comment.range[0])
    let replacement = lines.map(line => line.length > 0 ? `// ${line}` : '//')
        .join(`\n${indentation}`)
    const nextToken = sourceCode.getTokenAfter(comment)

    if (
        nextToken
        && nextToken.loc.start.line === comment.loc.end.line
    )
        replacement = `${replacement}\n${getLineIndentation(sourceCode.text, nextToken.range[0])}`

    return replacement
}

// Enforce the repository's line-comment convention with a source-preserving autofix.
export const noBlockComments = defineRule({
    meta: {
        type: 'suggestion',
        fixable: 'code',
        messages: {
            useLineComments: 'Use // comments instead of block comments.',
        },
        schema: [],
    },
    create(context) {
        const { sourceCode } = context

        return {
            Program() {
                for (const comment of sourceCode.getAllComments()) {
                    if (comment.type !== 'Block')
                        continue

                    context.report({
                        node: comment,
                        messageId: 'useLineComments',
                        fix: fixer => fixer.replaceText(
                            comment,
                            getLineCommentReplacement(comment, sourceCode),
                        ),
                    })
                }
            },
        }
    },
})
