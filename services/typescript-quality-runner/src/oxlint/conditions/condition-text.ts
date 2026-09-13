// Statements simple enough to stand as a brace-less `if` body. The compact-if and
// multiline-condition rules share this set so they classify bodies the same way.
export const compactIfStatementTypes = new Set([
    'BreakStatement',
    'ContinueStatement',
    'ExpressionStatement',
    'ReturnStatement',
    'ThrowStatement',
])

// Count leaf operands rather than operators so `a && b && c` has three logical evaluations
// regardless of how the parser associates the binary tree.
export const countLogicalEvaluations = (node): number => {
    if (node.type === 'ParenthesizedExpression')
        return countLogicalEvaluations(node.expression)

    if (node.type !== 'LogicalExpression')
        return 1

    return countLogicalEvaluations(node.left) + countLogicalEvaluations(node.right)
}

// Parentheses affect emitted text but not the logical chain being classified.
export const unwrapParenthesizedExpression = node => {
    let current = node

    while (current.type === 'ParenthesizedExpression')
        current = current.expression

    return current
}

// Reconstruct logical expressions recursively from AST nodes so condition formatting never
// depends on searching raw source for operators.
const getAstExpressionText = (
    node,
    sourceCode,
): string => {
    if (node.type === 'ParenthesizedExpression')
        return `(${getAstExpressionText(node.expression, sourceCode)})`

    if (node.type === 'LogicalExpression')
        return `${getAstExpressionText(node.left, sourceCode)} ${node.operator} ${getAstExpressionText(node.right, sourceCode)}`

    return sourceCode.getText(node).trim()
}

// Flatten one homogeneous logical chain into ordered operands and operators. Nested chains
// using a different operator remain a single operand so their grouping is preserved.
const getLogicalConditionParts = (node): {
    operands: unknown[]
    operators: string[]
} | null => {
    const operands = []
    const operators: string[] = []
    const logicalExpression = unwrapParenthesizedExpression(node)

    if (
        logicalExpression.type !== 'LogicalExpression'
        || (logicalExpression.operator !== '&&' && logicalExpression.operator !== '||' && logicalExpression.operator !== '??')
    )
        return null

    const rootOperator = logicalExpression.operator

    const visit = (current): void => {
        if (
            current.type === 'LogicalExpression'
            && current.operator === rootOperator
        ) {
            visit(current.left)
            operators.push(rootOperator)
            visit(current.right)

            return
        }

        operands.push(current)
    }

    visit(logicalExpression)

    return {
        operands,
        operators,
    }
}

// The AST drops grouping parentheses, so a source pair is recognised by the tokens on
// either side of the operand and folded back into the operand's own text.
const getOperandSourceText = (
    node,
    sourceCode,
): string | null => {
    const before = sourceCode.getTokenBefore(node)
    const after = sourceCode.getTokenAfter(node)
    const parenthesized = before?.value === '(' && after?.value === ')'

    return sourceCode.text.slice(parenthesized ? before.range[0] : node.range[0], parenthesized ? after.range[1] : node.range[1]) || null
}

// `wrapInParentheses` says the caller owns a parenthesis pair around this expression:
// the parentheses an `if`, `while` or `for` requires, or a pair the source already
// wrote. The fixer never introduces one of its own, so a group that is not
// parenthesized in the source stays on a single line rather than gaining a bracket.
export const getFormattedConditionText = (
    node,
    sourceCode,
    indentation,
    wrapInParentheses,
): string | null => {
    const logicalExpression = unwrapParenthesizedExpression(node)

    if (logicalExpression.type !== 'LogicalExpression')
        return getAstExpressionText(node, sourceCode)

    const conditionParts = getLogicalConditionParts(logicalExpression)

    if (!conditionParts)
        return null

    const operandIndentation = wrapInParentheses ? `${indentation}    ` : indentation
    const lines = conditionParts.operands.map(
        (operand, index) => {
            // An operand is copied out of the source exactly as it was written, on one line
            // or on several. The rule decides where the operands of a chain go, never how an
            // operand is laid out inside itself.
            const operandText = getOperandSourceText(operand, sourceCode)
            const operator = index === 0 ? '' : `${conditionParts.operators[index - 1]} `

            return operandText == null ? null : `${operandIndentation}${operator}${operandText}`
        },
    )

    if (lines.some(line => line == null))
        return null

    const condition = lines.join('\n')

    return wrapInParentheses
        ? `(\n${condition}\n${indentation})`
        : condition
}
