/* SPDX-License-Identifier: MIT */
'use strict';

const { createHash } = require('node:crypto');
const { validateDefinition } = require('./definition');
const { validatePath, literalPattern, defaultLocation } = require('./locations');

const CONFIG_FILE = '.vscode/versync.json';
const componentId = name => createHash('sha256').update(name).digest('hex');

function fields(value, allowed, caption) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
        throw new Error(`${caption}: unsupported fields or object type.`);
    }
}

function location(value, target, caption) {
    if (typeof value === 'string') return { ...defaultLocation(value), ...(target ? { format: 'plain' } : {}) };
    fields(value, target ? ['file', 'key', 'match', 'pattern', 'format'] : ['file', 'key', 'match', 'pattern'], caption);
    validatePath(value.file);
    const selectors = ['key', 'match', 'pattern'].filter(key => value[key] !== undefined);
    if (selectors.length > 1) throw new Error(`${caption}: choose one of key, match or pattern.`);
    let pattern;
    if (!selectors.length) pattern = defaultLocation(value.file).pattern;
    else if (value.match !== undefined) pattern = literalPattern(value.match);
    else if (value.key !== undefined) {
        if (typeof value.key !== 'string' || !value.key) throw new Error(`${caption}: key must be a property name.`);
        const key = JSON.stringify(value.key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        pattern = key + '\\s*:\\s*"(?<version>[^"\\r\\n]+)"';
    } else pattern = value.pattern;
    if (value.file.toLowerCase() === CONFIG_FILE) throw new Error('The setup file cannot also be a version source or target.');
    return { file: value.file, pattern, ...(target ? { format: value.format ?? 'plain' } : {}) };
}

function parseConfiguration(value) {
    fields(value, ['components', 'statusBarPrefix'], 'Configuration');
    if (!value.components || typeof value.components !== 'object' || Array.isArray(value.components)) throw new Error('components must contain named component objects.');
    const components = Object.entries(value.components).map(([name, component]) => {
        fields(component, ['source', 'targets', 'versioning', 'tagPrefix'], name);
        if (component.targets !== undefined && !Array.isArray(component.targets)) throw new Error(`${name}: targets must be a list.`);
        let rules = null;
        if (component.versioning === 'semver') rules = { kind: 'semver' };
        else if (component.versioning !== undefined && component.versioning !== null && component.versioning !== 'manual') {
            fields(component.versioning, ['label', 'separator', 'initial', 'onCoreBump'], `${name} versioning`);
            rules = { kind: 'semver', prerelease: { label: component.versioning.label, separator: component.versioning.separator ?? '',
                initial: component.versioning.initial ?? 1, onCoreBump: component.versioning.onCoreBump ?? 'reset' } };
        }
        return { id: componentId(name), name, source: location(component.source, false, `${name} source`),
            targets: (component.targets || []).map((entry, index) => location(entry, true, `${name} target ${index + 1}`)),
            rules, tagPrefix: component.tagPrefix ?? 'v' };
    });
    return validateDefinition({ schemaVersion: 1, components,
        ...(value.statusBarPrefix !== undefined ? { statusBarPrefix: value.statusBarPrefix } : {}) });
}

function serializeConfiguration(definition, previous = { components: {} }) {
    validateDefinition(definition);
    const oldLocations = Object.values(previous.components).flatMap(component => [component.source, ...(component.targets || [])]);
    const serializeLocation = (entry, target) => {
        let selector;
        for (const old of oldLocations) {
            try {
                const normalized = location(old, true, 'Stored field');
                if (normalized.file === entry.file && normalized.pattern === entry.pattern) {
                    selector = typeof old === 'string' ? { file: old } : { ...old };
                    delete selector.format;
                    break;
                }
            } catch { /* Newly added locations have no earlier file representation. */ }
        }
        if (!selector) {
            try { if (defaultLocation(entry.file).pattern === entry.pattern) selector = { file: entry.file }; }
            catch { /* Other file types keep their explicit selectors. */ }
        }
        selector ||= { file: entry.file, pattern: entry.pattern };
        if (target && entry.format !== 'plain') selector.format = entry.format;
        return Object.keys(selector).length === 1 ? selector.file : selector;
    };
    return { ...(definition.statusBarPrefix !== undefined ? { statusBarPrefix: definition.statusBarPrefix } : {}),
        components: Object.fromEntries(definition.components.map(component => [component.name, {
        source: serializeLocation(component.source, false), targets: component.targets.map(entry => serializeLocation(entry, true)),
        ...(component.rules ? { versioning: component.rules.prerelease ? { ...component.rules.prerelease } : 'semver' } : {}),
        ...(component.tagPrefix !== 'v' ? { tagPrefix: component.tagPrefix } : {})
    }])) };
}

module.exports = { CONFIG_FILE, componentId, parseConfiguration, serializeConfiguration };
