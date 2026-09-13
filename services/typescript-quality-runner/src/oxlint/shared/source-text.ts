// Return the exact indentation prefix of the line containing an offset so fixes inherit
// local tabs or spaces without reformatting unrelated code.
export const getLineIndentation = (
    source: string,
    offset: number,
): string => {
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1
    let cursor = lineStart

    while (
        source[cursor] === ' '
        || source[cursor] === '\t'
    )
        cursor++

    return source.slice(lineStart, cursor)
}
