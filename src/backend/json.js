/* SPDX-License-Identifier: MIT */
'use strict';

function property(text, keys) {
    const whitespace = offset => {
        while (/\s/.test(text[offset] || '') && offset < text.length) offset++;
        return offset;
    };
    function stringEnd(offset) {
        for (let cursor = offset + 1; cursor < text.length; cursor++) {
            if (text[cursor] === '\\') cursor++;
            else if (text[cursor] === '"') return cursor + 1;
        }
        throw new Error('Unterminated JSON string.');
    }
    function valueEnd(offset) {
        if (text[offset] === '"') return stringEnd(offset);
        if (text[offset] === '{' || text[offset] === '[') {
            let depth = 1, cursor = offset + 1;
            while (depth && cursor < text.length) {
                if (text[cursor] === '"') cursor = stringEnd(cursor);
                else {
                    if (text[cursor] === '{' || text[cursor] === '[') depth++;
                    else if (text[cursor] === '}' || text[cursor] === ']') depth--;
                    cursor++;
                }
            }
            return cursor;
        }
        let cursor = offset;
        while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++;
        return cursor;
    }
    let start = whitespace(0), end = text.length;
    for (const key of keys) {
        if (text[start] !== '{') throw new Error(`Missing JSON property: ${keys.join('.')}.`);
        let cursor = whitespace(start + 1), found;
        while (cursor < end && text[cursor] !== '}') {
            const keyEnd = stringEnd(cursor), name = JSON.parse(text.slice(cursor, keyEnd));
            const valueStart = whitespace(whitespace(keyEnd) + 1), valueStop = valueEnd(valueStart);
            if (name === key) found = { start: valueStart, end: valueStop };
            cursor = whitespace(valueStop);
            if (text[cursor] === ',') cursor = whitespace(cursor + 1);
        }
        if (!found) throw new Error(`Missing JSON property: ${keys.join('.')}.`);
        ({ start, end } = found);
    }
    return { start, end, value: JSON.parse(text.slice(start, end)) };
}

module.exports = { property };
