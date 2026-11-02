/* SPDX-License-Identifier: MIT */
'use strict';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/;
const FORMATS = ['plain', 'prefixed', 'numeric4', 'shields'];
const TEMPLATE_FIELDS = ['version', 'tag', 'shields', 'numeric4', 'major', 'minor', 'patch', 'prerelease', 'build'];

function validateVersion(value) {
    if (typeof value !== 'string' || !value || value !== value.trim() || /[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(value)) {
        throw new Error('Enter a nonempty version without surrounding spaces or control characters.');
    }
    return value;
}

function parseVersion(value) {
    validateVersion(value);
    const match = SEMVER.exec(value);
    if (!match || match[0] !== value || match[4]?.split('.').some(part => /^0\d+$/.test(part))) {
        throw new Error(`Not a semantic version: ${JSON.stringify(value)}.`);
    }
    const [major, minor, patch] = match.slice(1, 4).map(Number);
    if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error('Version numbers exceed the safe integer range.');
    return { major, minor, patch, prerelease: match[4] || '', build: match[5] || '' };
}

function validateRules(rules) {
    if (rules === null) return;
    if (!rules || typeof rules !== 'object' || Array.isArray(rules) || rules.kind !== 'semver' ||
        Object.keys(rules).some(key => !['kind', 'prerelease'].includes(key))) {
        throw new Error('Versioning rules must be null or a semantic versioning definition.');
    }
    const pre = rules.prerelease;
    if (pre === undefined) return;
    if (!pre || typeof pre !== 'object' || Array.isArray(pre) ||
        Object.keys(pre).some(key => !['label', 'separator', 'initial', 'onCoreBump'].includes(key)) ||
        typeof pre.label !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*$/.test(pre.label) ||
        !['', '.'].includes(pre.separator) || !Number.isSafeInteger(pre.initial) || pre.initial < 1 ||
        !['reset', 'remove'].includes(pre.onCoreBump)) {
        throw new Error('Prerelease rules require a label beginning with a letter, a separator, a positive initial counter and a reset/remove policy.');
    }
    parseVersion(`0.0.0-${pre.label}${pre.separator}${pre.initial}`);
}

function bumpVersion(value, kind, rules) {
    validateRules(rules);
    if (!rules) throw new Error('Enable versioning rules for this component before bumping its version.');
    const parts = parseVersion(value);
    if (!['major', 'minor', 'patch', 'prerelease'].includes(kind)) throw new Error(`Unsupported version action: ${kind}.`);
    const pre = rules.prerelease;
    if (kind === 'prerelease') {
        if (parts.prerelease) {
            const match = /^(.*?)(\d+)$/.exec(parts.prerelease);
            if (!match) throw new Error('The prerelease has no trailing counter. Set an exact version instead.');
            const counter = Number(match[2]);
            if (!Number.isSafeInteger(counter) || counter >= Number.MAX_SAFE_INTEGER) throw new Error('Prerelease counter exceeds the safe integer range.');
            parts.prerelease = match[1] + (counter + 1);
        } else {
            if (!pre) throw new Error('Configure a prerelease label before starting a prerelease.');
            parts.prerelease = `${pre.label}${pre.separator}${pre.initial}`;
        }
    } else {
        if (parts[kind] >= Number.MAX_SAFE_INTEGER) throw new Error('Version number exceeds the safe integer range.');
        parts[kind]++;
        if (kind === 'major') parts.minor = parts.patch = 0;
        if (kind === 'minor') parts.patch = 0;
        if (pre) {
            parts.prerelease = pre.onCoreBump === 'remove' ? '' : `${pre.label}${pre.separator}${pre.initial}`;
        } else if (parts.prerelease) {
            const match = /^(.*?)(\d+)$/.exec(parts.prerelease);
            if (!match) throw new Error('The prerelease has no trailing counter. Configure a reset policy or set an exact version.');
            parts.prerelease = match[1] + '1';
        }
    }
    const next = `${parts.major}.${parts.minor}.${parts.patch}${parts.prerelease ? '-' + parts.prerelease : ''}`;
    parseVersion(next);
    return next;
}

function downgradeVersion(value, kind, rules) {
    validateRules(rules);
    if (!rules) throw new Error('Enable versioning rules for this component before downgrading its version.');
    const parts = parseVersion(value);
    if (kind === 'prerelease') {
        const match = /^(.*?)(\d+)$/.exec(parts.prerelease);
        if (!match) throw new Error('The prerelease has no trailing counter. Enter a version manually.');
        const counter = Number(match[2]);
        if (!Number.isSafeInteger(counter) || counter < 1) throw new Error('The prerelease counter cannot be decreased.');
        parts.prerelease = match[1] + (counter - 1);
    } else {
        if (!['major', 'minor', 'patch'].includes(kind)) throw new Error(`Unsupported version action: ${kind}.`);
        if (parts[kind] === 0) throw new Error(`The ${kind} number is already zero.`);
        parts[kind]--;
        if (kind === 'major') parts.minor = parts.patch = 0;
        if (kind === 'minor') parts.patch = 0;
        parts.prerelease = '';
    }
    const next = `${parts.major}.${parts.minor}.${parts.patch}${parts.prerelease ? '-' + parts.prerelease : ''}`;
    parseVersion(next);
    return next;
}

function validateFormat(format) {
    if (FORMATS.includes(format)) return;
    if (!format || typeof format !== 'object' || Array.isArray(format) ||
        Object.keys(format).length !== 1 || typeof format.template !== 'string' || !format.template) {
        throw new Error('Choose a version format or enter a template.');
    }
    const remainder = format.template.replace(/\{([^{}]+)\}/g, (token, name) => {
        if (!TEMPLATE_FIELDS.includes(name)) throw new Error(`Unknown template field: ${token}.`);
        return '';
    });
    if (/[{}]/.test(remainder)) throw new Error('Unbalanced braces in the version template.');
}

function formatVersion(version, format) {
    validateVersion(version);
    validateFormat(format);
    if (format === 'plain') return version;
    if (format === 'prefixed') return 'v' + version;
    if (format === 'shields') return 'v' + version.replace(/-/g, '--').replace(/_/g, '__');
    if (format === 'numeric4') {
        const parts = parseVersion(version);
        if ([parts.major, parts.minor, parts.patch].some(number => number > 65535)) {
            throw new Error('Windows four-part version numbers must be between 0 and 65535.');
        }
        return `${parts.major}.${parts.minor}.${parts.patch}.0`;
    }
    const text = format.template.replace(/\{([^{}]+)\}/g, (token, name) => {
        if (name === 'version') return version;
        if (name === 'tag') return 'v' + version;
        if (name === 'shields') return formatVersion(version, 'shields');
        if (name === 'numeric4') return formatVersion(version, 'numeric4');
        if (['major', 'minor', 'patch', 'prerelease', 'build'].includes(name)) return String(parseVersion(version)[name]);
        throw new Error(`Unknown version template field: ${token}.`);
    });
    return validateVersion(text);
}

function matchingFormats(version, value) {
    return FORMATS.filter(format => {
        try { return formatVersion(version, format) === value; } catch { return false; }
    });
}

function formatTag(version, prefix) {
    validateVersion(version);
    if (typeof prefix !== 'string') throw new Error('The tag prefix must be text.');
    const tag = prefix + version;
    if (tag === '@' || tag.startsWith('-') || tag.endsWith('.') || tag.includes('..') || tag.includes('@{') ||
        /[\x00-\x20\x7f~^:?*\[\\]/.test(tag) || tag.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
        throw new Error('The configured prefix and version do not form a supported Git tag name.');
    }
    return tag;
}

module.exports = { FORMATS, validateVersion, parseVersion, validateRules, bumpVersion, downgradeVersion, validateFormat, formatVersion, matchingFormats, formatTag };
