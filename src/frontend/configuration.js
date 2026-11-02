/* SPDX-License-Identifier: MIT */
'use strict';

const vscode = require('vscode');
const { relativeFile, openProjectFile, discoverSources } = require('../backend/project');
const { locate, selectionPattern } = require('../backend/locations');
const { FORMATS, validateVersion, parseVersion, validateRules, formatVersion, matchingFormats } = require('../backend/version');

const FORMAT_LABELS = { plain: 'Plain version', prefixed: 'With v prefix', numeric4: 'Windows four-part', shields: 'Shields badge' };

function formatLabel(format) {
    return typeof format === 'string' ? FORMAT_LABELS[format] : `Template: ${format.template}`;
}

function formatChoices(version) {
    const choices = [];
    for (const format of FORMATS) {
        try {
            choices.push({ label: formatLabel(format), description: formatVersion(version, format), format,
                detail: format === 'shields' ? 'Doubles hyphens and underscores for badge URLs.' :
                    format === 'prefixed' ? 'Adds v before the version.' : undefined });
        } catch {
            // Windows numeric fields cannot represent every source version.
        }
    }
    return choices;
}

async function input(title, value, validate, prompt) {
    return vscode.window.showInputBox({ title, value, prompt, ignoreFocusOut: true,
        validateInput: text => { try { validate(text); } catch (error) { return error.message; } return undefined; }
    });
}

async function chooseFile(folder) {
    const selected = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: 'Choose version file' });
    return selected?.[0] ? relativeFile(folder, selected[0]) : undefined;
}

async function patternLocation(folder, current) {
    const file = current?.file || await chooseFile(folder);
    if (!file) return;
    const snapshot = await openProjectFile(folder, file);
    const pattern = await input(`Version pattern: ${file}`, current?.pattern || '',
        value => locate(snapshot.text, value, file), 'Use a regex with (?<version>...) around the version. It must match once.');
    if (pattern === undefined) return;
    const match = locate(snapshot.text, pattern, file);
    return { file, pattern, value: match.value, snapshot };
}

async function selectedLocation(folder) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selections.length !== 1 || editor.selection.isEmpty || !editor.selection.isSingleLine) {
        throw new Error('Select exactly one complete version string on one line in a project file.');
    }
    const file = relativeFile(folder, editor.document.uri);
    const version = editor.document.version;
    const start = editor.document.offsetAt(editor.selection.start), end = editor.document.offsetAt(editor.selection.end);
    const value = editor.document.getText(editor.selection);
    validateVersion(value);
    const snapshot = await openProjectFile(folder, file);
    if (editor.document.version !== version || snapshot.text.slice(start, end) !== value) throw new Error('The document changed. Select the version again.');
    return { file, pattern: selectionPattern(snapshot.text, start, end), value, snapshot };
}

async function sourceLocation(folder) {
    let selection;
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty && editor.selection.isSingleLine) {
        try { selection = await selectedLocation(folder); }
        catch { /* Only valid selections inside this project can supply a source. */ }
    }
    const { found, truncated, skipped } = await discoverSources(folder);
    const choices = found.map(source => ({ label: source.file, description: source.value, source }));
    if (selection) choices.unshift({ label: 'Use selected version', description: selection.value, detail: selection.file, action: 'selection' });
    if (truncated || skipped) choices.push({ label: [truncated ? 'Search limited to 200 files' : '', skipped ? `${skipped} source files need manual selection` : ''].filter(Boolean).join('; '), kind: vscode.QuickPickItemKind.Separator });
    choices.push({ label: 'Choose a file and pattern…', action: 'pattern',
        detail: 'Select a file and enter a version pattern.' });
    const choice = await vscode.window.showQuickPick(choices, { title: 'Select a version source', ignoreFocusOut: true,
        placeHolder: 'Search version sources' });
    if (!choice) return;
    let selected;
    if (choice.action === 'selection') selected = selection;
    else if (choice.action === 'pattern') selected = await patternLocation(folder);
    else {
        const snapshot = await openProjectFile(folder, choice.source.file);
        selected = { ...choice.source, snapshot, value: locate(snapshot.text, choice.source.pattern, choice.source.file).value };
    }
    if (selected) validateVersion(selected.value);
    return selected;
}

async function chooseFormat(version, value, current, file) {
    const matches = matchingFormats(version, value);
    if (current === undefined && matches.length === 1) return matches[0];
    const choices = formatChoices(version);
    choices.push({ label: 'Custom template…', custom: true });
    const picked = await vscode.window.showQuickPick(choices, { title: file ? `Version format: ${file}` : 'Version format', ignoreFocusOut: true,
        placeHolder: 'Search version formats' });
    if (!picked) return;
    if (!picked.custom) return picked.format;
    const template = await input('Version template', current && typeof current === 'object' ? current.template : '{version}',
        text => formatVersion(version, { template: text }), 'Fields: {version}, {tag}, {major}, {minor}, {patch}, {prerelease}, {build}, {numeric4}, {shields}.');
    return template === undefined ? undefined : { template };
}

async function chooseRules(version, current = null) {
    let semantic;
    try { semantic = parseVersion(version); } catch { /* Manual versions do not require semantic syntax. */ }
    const choices = [{ label: 'Manual versions', description: 'Enter exact versions', rules: null,
        detail: semantic ? undefined : 'Bump rules require a semantic version, such as 1.2.3.' }];
    if (semantic) choices.push(
        { label: 'Semantic versioning', description: 'Major, minor and patch bumps', rules: { kind: 'semver' } },
        { label: 'Prerelease versioning…', custom: true, description: 'Configure a label and counter, such as alpha1 or beta.2' }
    );
    const picked = await vscode.window.showQuickPick(choices, { title: 'Versioning rules', ignoreFocusOut: true, placeHolder: 'Search versioning options' });
    if (!picked) return undefined;
    if (picked.rules === null) return null;
    if (!picked.custom) return picked.rules;
    const existing = current?.prerelease;
    const inferred = /^([A-Za-z][A-Za-z-]*)(\.?)(\d+)$/.exec(semantic.prerelease);
    const label = await input('Prerelease label', existing?.label || inferred?.[1] || 'alpha', text => {
        if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(text)) throw new Error('Begin with a letter; use letters, numbers or hyphens.');
    });
    if (label === undefined) return;
    const separator = await vscode.window.showQuickPick([
        { label: `${label}${existing?.initial || 1}`, separator: '' }, { label: `${label}.${existing?.initial || 1}`, separator: '.' }
    ], { title: 'Prerelease format', placeHolder: 'Search counter formats', ignoreFocusOut: true });
    if (!separator) return;
    const initial = await input('Initial prerelease counter', String(existing?.initial || 1), text => {
        if (!/^[1-9]\d*$/.test(text)) throw new Error('Enter a positive whole number.');
        if (!Number.isSafeInteger(Number(text))) throw new Error('The counter is too large.');
    });
    if (initial === undefined) return;
    const policy = await vscode.window.showQuickPick([
        { label: 'Restart prerelease counter', description: `${label}${separator.separator}${initial}`, policy: 'reset' },
        { label: 'Remove prerelease suffix', description: 'Use a stable version', policy: 'remove' }
    ], { title: 'After a major, minor or patch bump', placeHolder: 'Search prerelease actions', ignoreFocusOut: true });
    if (!policy) return;
    const rules = { kind: 'semver', prerelease: { label, separator: separator.separator, initial: Number(initial), onCoreBump: policy.policy } };
    validateRules(rules);
    return rules;
}

function definitionLocation(selected) {
    return { file: selected.file, pattern: selected.pattern };
}

module.exports = { input, patternLocation, selectedLocation, sourceLocation, chooseFormat, chooseRules, definitionLocation, formatLabel, formatChoices };
