/* SPDX-License-Identifier: MIT */
'use strict';

const { validatePath } = require('./locations');
const { validateRules, validateFormat } = require('./version');

function object(value, keys, caption) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
        throw new Error(`${caption}: unsupported fields or object type.`);
    }
}

function validateLocation(location, target, caption) {
    object(location, target ? ['file', 'pattern', 'format'] : ['file', 'pattern'], caption);
    validatePath(location.file);
    if (location.file.toLowerCase() === '.vscode/versync.json') throw new Error(`${caption}: the setup file cannot also be a version source or target.`);
    if (typeof location.pattern !== 'string' || !location.pattern.includes('(?<version>')) throw new Error(`${caption}: a named version capture is required.`);
    try { new RegExp(location.pattern, 'gmd'); }
    catch (error) { throw new Error(`${caption}: ${error.message}`); }
    if (target) validateFormat(location.format);
}

function validateDefinition(project) {
    object(project, ['schemaVersion', 'components', 'statusBarPrefix'], 'Project setup');
    if (project.schemaVersion !== 1 || !Array.isArray(project.components)) throw new Error('Unsupported project setup format.');
    if (project.statusBarPrefix !== undefined && (typeof project.statusBarPrefix !== 'string' || /[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(project.statusBarPrefix))) {
        throw new Error('statusBarPrefix must be text without line breaks or control characters.');
    }
    const ids = new Set(), names = new Set();
    for (const component of project.components) {
        object(component, ['id', 'name', 'source', 'targets', 'rules', 'tagPrefix'], 'Component');
        if (typeof component.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(component.id) || ids.has(component.id)) throw new Error('Component identifiers must be unique.');
        if (typeof component.name !== 'string' || !component.name.trim() || component.name !== component.name.trim() ||
            /[\x00-\x1f\x7f]/.test(component.name) || names.has(component.name.toLowerCase())) throw new Error('Component names must be nonempty and unique.');
        ids.add(component.id); names.add(component.name.toLowerCase());
        validateLocation(component.source, false, `${component.name} source`);
        if (!Array.isArray(component.targets)) throw new Error(`${component.name}: targets must be an array.`);
        component.targets.forEach((target, index) => validateLocation(target, true, `${component.name} target ${index + 1}`));
        validateRules(component.rules);
        if (typeof component.tagPrefix !== 'string' || /[\x00-\x20\x7f]/.test(component.tagPrefix)) throw new Error(`${component.name}: invalid tag prefix.`);
    }
    return project;
}

function importDefinition(value, name) {
    if (value && value.schemaVersion !== undefined) return validateDefinition(value);
    object(value, ['source', 'targets', 'prerelease', 'tagPrefix'], 'Imported setup');
    return validateDefinition({ schemaVersion: 1, components: [{
        id: 'project', name, source: value.source, targets: value.targets,
        rules: value.prerelease ? { kind: 'semver', prerelease: value.prerelease } : null,
        tagPrefix: value.tagPrefix ?? 'v'
    }] });
}

module.exports = { validateDefinition, importDefinition };
