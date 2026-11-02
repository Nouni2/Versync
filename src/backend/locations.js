/* SPDX-License-Identifier: MIT */
'use strict';

function validatePath(file) {
    if (typeof file !== 'string' || !file || /[\\\x00-\x1f\x7f:*?"<>|]/.test(file) ||
        file.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
        throw new Error(`Unsupported project-relative path: ${JSON.stringify(file)}.`);
    }
    return file;
}

function locate(text, pattern, description) {
    let regex;
    try { regex = new RegExp(pattern, 'gmd'); }
    catch (error) { throw new Error(`${description}: invalid pattern: ${error.message}`); }
    const first = regex.exec(text);
    if (!first) throw new Error(`${description}: expected one match, found none.`);
    if (!first[0].length) throw new Error(`${description}: zero-width matches are unsupported.`);
    if (regex.exec(text)) throw new Error(`${description}: expected one match, found several.`);
    const span = first.indices?.groups?.version;
    if (!span || span[0] === span[1]) throw new Error(`${description}: the named version capture is empty or missing.`);
    return { start: span[0], end: span[1], value: text.slice(span[0], span[1]) };
}

function checkOverlaps(entries, description) {
    const ordered = [...entries].sort((a, b) => a.start - b.start);
    for (let index = 1; index < ordered.length; index++) {
        if (ordered[index].start < ordered[index - 1].end) {
            throw new Error(`${description}: ${ordered[index - 1].caption} overlaps ${ordered[index].caption}.`);
        }
    }
}

function escapePattern(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literalPattern(text) {
    if (typeof text !== 'string' || text.split('{version}').length !== 2) throw new Error('A match must contain {version} exactly once.');
    const [before, after] = text.split('{version}');
    return escapePattern(before) + '(?<version>[^\\r\\n]+?)' + escapePattern(after) + (after ? '' : '(?=\\r?$)');
}

function defaultLocation(file) {
    validatePath(file);
    const name = file.split('/').at(-1);
    if (name === 'package.json') return { file, pattern: '"version"\\s*:\\s*"(?<version>[^"\\r\\n]+)"' };
    if (name === 'Directory.Build.props') return { file, pattern: '<Version>(?<version>[^<\\r\\n]+)</Version>' };
    if (name === 'pyproject.toml') return { file, pattern: '^version[ \\t]*=[ \\t]*["\x27](?<version>[^"\x27\\r\\n]+)["\x27]' };
    if (name === 'VERSION') return { file, pattern: '^(?<version>[^\\r\\n]+)\\r?$' };
    throw new Error(`${file}: specify a key, match or pattern to identify the version.`);
}

const VERSION_TOKEN = /v?\d+\.\d+\.\d+(?:\.[0-9]+)?(?:--?[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?/g;

function selectionPattern(text, start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) {
        throw new Error('Select one nonempty version field.');
    }
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const newline = text.indexOf('\n', end);
    let lineEnd = newline === -1 ? text.length : newline;
    if (text[lineEnd - 1] === '\r') lineEnd--;
    if (/[\r\n]/.test(text.slice(start, end)) || end > lineEnd) throw new Error('Select a version on one line.');
    const mask = value => {
        let result = '', cursor = 0;
        for (const match of value.matchAll(VERSION_TOKEN)) {
            result += escapePattern(value.slice(cursor, match.index)) + VERSION_TOKEN.source;
            cursor = match.index + match[0].length;
        }
        return result + escapePattern(value.slice(cursor));
    };
    const pattern = '^' + mask(text.slice(lineStart, start)) + '(?<version>[^\\r\\n]+?)' + mask(text.slice(end, lineEnd)) + '\\r?$';
    const match = locate(text, pattern, 'Selected field');
    if (match.start !== start || match.end !== end) {
        throw new Error('The selection cannot be identified uniquely. Use an explicit pattern.');
    }
    return pattern;
}

module.exports = { validatePath, locate, checkOverlaps, selectionPattern, literalPattern, defaultLocation };
