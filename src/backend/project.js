/* SPDX-License-Identifier: MIT */
'use strict';

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { validateDefinition, metadataComponent } = require('./definition');
const { property } = require('./json');
const { validatePath, locate, checkOverlaps, selectionPattern, defaultLocation } = require('./locations');
const { FORMATS, validateVersion, parseVersion, formatVersion } = require('./version');
const { CONFIG_FILE } = require('./configuration');

const MAX_FILE_SIZE = 2 * 1024 * 1024;

function identity(uri) {
    const value = uri.toString();
    return uri.scheme === 'file' && process.platform === 'win32' ? value.toLowerCase() : value;
}

function relativeFile(folder, uri) {
    if (uri.scheme !== folder.uri.scheme || uri.authority !== folder.uri.authority || uri.query !== folder.uri.query || uri.fragment !== folder.uri.fragment) throw new Error('Choose a file in this project folder.');
    const base = folder.uri.path.replace(/\/$/, '') + '/';
    const insensitive = uri.scheme === 'file' && process.platform === 'win32';
    if (!(insensitive ? uri.path.toLowerCase().startsWith(base.toLowerCase()) : uri.path.startsWith(base))) {
        throw new Error('Choose a file in this project folder.');
    }
    return validatePath(uri.path.slice(base.length));
}

async function openProjectFile(folder, file, documents = new Map()) {
    validatePath(file);
    let uri = vscode.Uri.joinPath(folder.uri, ...file.split('/'));
    if (uri.scheme === 'file') {
        const [root, actual] = await Promise.all([fs.realpath(folder.uri.fsPath), fs.realpath(uri.fsPath)]);
        const expected = path.join(root, ...file.split('/'));
        const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
        if (normalize(actual) !== normalize(expected)) throw new Error(`${file}: symbolic links and path aliases are unsupported.`);
        uri = vscode.Uri.file(actual);
    } else {
        let parent = folder.uri;
        for (const segment of file.split('/')) {
            parent = vscode.Uri.joinPath(parent, segment);
            const stat = await vscode.workspace.fs.stat(parent);
            if (stat.type & vscode.FileType.SymbolicLink) throw new Error(`${file}: symbolic links are unsupported.`);
        }
    }
    const key = identity(uri);
    if (documents.has(key)) return documents.get(key);
    const stat = await vscode.workspace.fs.stat(uri);
    if (!(stat.type & vscode.FileType.File) || stat.size > MAX_FILE_SIZE) throw new Error(`${file}: choose a text file no larger than 2 MiB.`);
    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    if (text.includes('\0') || Buffer.byteLength(text, 'utf8') > MAX_FILE_SIZE) throw new Error(`${file}: binary or oversized documents are unsupported.`);
    const snapshot = { folder, uri: document.uri, file, document, text, version: document.version, stat };
    documents.set(key, snapshot);
    return snapshot;
}

function assertUnchanged(documents) {
    for (const snapshot of documents.values()) {
        if (snapshot.document.isClosed || snapshot.document.version !== snapshot.version || snapshot.document.getText() !== snapshot.text) {
            throw new Error(`${snapshot.file}: the document changed. Review a new preview before applying.`);
        }
    }
}

function range(snapshot, start = 0, end = start) {
    return new vscode.Range(snapshot.document.positionAt(start), snapshot.document.positionAt(end));
}

async function inspectProject(folder, definition) {
    validateDefinition(definition);
    const result = { folder, definition, documents: new Map(), components: [], issues: [] };
    if (definition.fileConfiguration) {
        const file = definition.fileConfiguration;
        result.documents.set(identity(file.uri), { ...file, folder, file: CONFIG_FILE });
    }
    for (const component of definition.components) {
        const report = { component, version: undefined, entries: [], issues: [] };
        result.components.push(report);
        const locations = [{ ...component.source, source: true }, ...component.targets.map((target, index) => ({ ...target, source: false, index }))];
        for (const location of locations) {
            const caption = `${component.name} ${location.source ? 'source' : 'target ' + (location.index + 1)} (${location.file})`;
            try {
                const snapshot = await openProjectFile(folder, location.file, result.documents);
                const capture = locate(snapshot.text, location.pattern, caption);
                report.entries.push({ ...location, ...capture, caption, componentId: component.id, snapshot, range: range(snapshot, capture.start, capture.end) });
            } catch (error) {
                const message = error.message.startsWith(caption + ':') ? error.message : `${caption}: ${error.message}`;
                report.issues.push({ severity: 'error', message, uri: vscode.Uri.joinPath(folder.uri, ...location.file.split('/')), range: new vscode.Range(0, 0, 0, 0) });
            }
        }
        const source = report.entries.find(entry => entry.source);
        if (source) {
            try {
                validateVersion(source.value);
                if (component.rules) parseVersion(source.value);
                report.version = source.value;
            } catch (error) {
                report.issues.push({ severity: 'error', message: `${component.name}: ${error.message}`, uri: source.snapshot.uri, range: source.range });
            }
        }
        if (definition.fileConfiguration && metadataComponent(definition)?.id === component.id) {
            const snapshot = result.documents.get(identity(definition.fileConfiguration.uri));
            const capture = property(snapshot.text, ['metadata', 'version']);
            report.entries.push({ file: CONFIG_FILE, metadata: true, source: false, index: 'metadata', format: 'plain',
                caption: `${component.name} metadata.version (${CONFIG_FILE})`, componentId: component.id,
                ...capture, snapshot, range: range(snapshot, capture.start, capture.end) });
        }
        if (report.version) {
            for (const entry of report.entries.filter(item => !item.source)) {
                try {
                    entry.expected = formatVersion(report.version, entry.format);
                    if (entry.value !== entry.expected) report.issues.push({ severity: 'warning', message: `${entry.caption}: expected ${JSON.stringify(entry.expected)}, found ${JSON.stringify(entry.value)}.`, uri: entry.snapshot.uri, range: entry.range });
                } catch (error) {
                    report.issues.push({ severity: 'error', message: `${entry.caption}: ${error.message}`, uri: entry.snapshot.uri, range: entry.range });
                }
            }
        }
        result.issues.push(...report.issues);
    }
    const entries = result.components.flatMap(report => report.entries);
    for (const snapshot of result.documents.values()) {
        try { checkOverlaps(entries.filter(entry => entry.snapshot === snapshot), snapshot.file); }
        catch (error) { result.issues.push({ severity: 'error', message: error.message, uri: snapshot.uri, range: range(snapshot) }); }
    }
    assertUnchanged(result.documents);
    return result;
}

async function ensureWritable(snapshot) {
    if (vscode.workspace.fs.isWritableFileSystem(snapshot.uri.scheme) !== true) throw new Error(`${snapshot.file}: the file system does not confirm write access.`);
    const current = await openProjectFile(snapshot.folder, snapshot.file);
    if (identity(current.uri) !== identity(snapshot.uri)) throw new Error(`${snapshot.file}: the file location changed. Review a new preview.`);
    const stat = current.stat;
    if (stat.permissions & vscode.FilePermission.Readonly) throw new Error(`${snapshot.file}: the file is read-only.`);
    if (snapshot.uri.scheme === 'file') await fs.access(snapshot.uri.fsPath, constants.W_OK);
    if (stat.mtime !== snapshot.stat.mtime || stat.size !== snapshot.stat.size) throw new Error(`${snapshot.file}: the file changed on disk. Review a new preview.`);
}

function validateProjectedChanges(inspection, changes) {
    const texts = new Map();
    for (const snapshot of inspection.documents.values()) {
        const edits = changes.filter(change => change.snapshot === snapshot).sort((a, b) => b.start - a.start);
        if (!edits.length) continue;
        let text = snapshot.text;
        for (const edit of edits) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
        for (const entry of inspection.components.flatMap(report => report.entries).filter(entry => entry.snapshot === snapshot)) {
            const change = edits.find(edit => edit.componentId === entry.componentId && edit.source === entry.source && edit.index === entry.index);
            const expected = change ? change.next : entry.value;
            const offset = edits.filter(edit => edit.end <= entry.start).reduce((sum, edit) => sum + edit.replacement.length - (edit.end - edit.start), 0);
            const projected = entry.metadata ? property(text, ['metadata', 'version']) : locate(text, entry.pattern, entry.caption);
            const length = entry.metadata ? JSON.stringify(expected).length : expected.length;
            if (projected.value !== expected || projected.start !== entry.start + offset || projected.end !== entry.start + offset + length) {
                throw new Error(`${entry.caption}: its pattern would no longer identify the same field after this update. Edit the pattern first.`);
            }
        }
        texts.set(snapshot, text);
    }
    return texts;
}

async function planChanges(folder, definition, requests) {
    if (!Array.isArray(requests) || !requests.length) throw new Error('Choose at least one component.');
    if (metadataComponent(definition) && !definition.fileConfiguration) throw new Error('Open Project Configuration to track metadata.version in the project JSON file.');
    const inspection = await inspectProject(folder, definition);
    const error = inspection.issues.find(issue => issue.severity === 'error');
    if (error) throw new Error(error.message);
    const changes = [], ids = new Set(), versions = [];
    for (const request of requests) {
        if (ids.has(request.id)) throw new Error('A component was selected more than once.');
        ids.add(request.id);
        const report = inspection.components.find(item => item.component.id === request.id);
        if (!report) throw new Error('The selected component no longer exists.');
        if (report.version !== request.previous) throw new Error(`${report.component.name}: the source version changed. Reopen the version action.`);
        validateVersion(request.next);
        if (report.component.rules) parseVersion(request.next);
        versions.push({ name: report.component.name, previous: report.version, next: request.next });
        for (const entry of report.entries) {
            const next = entry.source ? request.next : formatVersion(request.next, entry.format);
            if (entry.value !== next) changes.push({ ...entry, next, replacement: entry.metadata ? JSON.stringify(next) : next });
        }
    }
    validateProjectedChanges(inspection, changes);
    assertUnchanged(inspection.documents);
    return { ...inspection, changes, versions };
}

async function applyChanges(plan, selected = plan.changes) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before changing versions.');
    if (!selected.length) return false;
    if (new Set(selected).size !== selected.length || selected.some(change => !plan.changes.includes(change))) throw new Error('Choose changes from the current preview.');
    const affected = new Set(selected.map(change => change.snapshot));
    const inputs = new Set(affected), componentIds = new Set(selected.map(change => change.componentId));
    for (const report of plan.components.filter(report => componentIds.has(report.component.id))) {
        inputs.add(report.entries.find(entry => entry.source).snapshot);
    }
    if (plan.definition.fileConfiguration) inputs.add(plan.documents.get(identity(plan.definition.fileConfiguration.uri)));
    function requireSavedInputs() {
        const dirty = [...inputs].filter(snapshot => snapshot.document.isDirty);
        if (dirty.length) throw new Error(`Save these files first, then review and apply again:\n${dirty.map(snapshot => snapshot.file).join('\n')}`);
    }
    requireSavedInputs();
    for (const snapshot of affected) await ensureWritable(snapshot);
    requireSavedInputs();
    assertUnchanged(plan.documents);
    const texts = validateProjectedChanges(plan, selected);
    const edit = new vscode.WorkspaceEdit();
    for (const change of selected) edit.replace(change.snapshot.uri, change.range, change.replacement);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not apply the selected changes. Review a new preview.');
    const saved = new Set();
    try {
        for (const snapshot of affected) {
            const document = snapshot.document;
            if (document.isClosed || document.getText() !== texts.get(snapshot)) throw new Error(`${snapshot.file}: the document changed after applying. It was not saved by this operation.`);
            if (document.isDirty && !await document.save()) throw new Error(`${snapshot.file}: could not save the file.`);
            if (document.isClosed || document.isDirty) throw new Error(`${snapshot.file}: saving did not leave a saved document.`);
            saved.add(snapshot);
        }
        const entries = plan.components.flatMap(report => report.entries);
        for (const snapshot of affected) {
            if (snapshot.document.isClosed || snapshot.document.isDirty) throw new Error(`${snapshot.file}: the document changed or closed during saving.`);
            const text = snapshot.document.getText();
            for (const entry of entries.filter(entry => entry.snapshot === snapshot)) {
                const change = selected.find(change => change.componentId === entry.componentId && change.source === entry.source && change.index === entry.index);
                const expected = change ? change.next : entry.value;
                const actual = entry.metadata ? property(text, ['metadata', 'version']) : locate(text, entry.pattern, entry.caption);
                if (actual.value !== expected) throw new Error(`${entry.caption}: the version changed during saving. Review the saved file.`);
            }
        }
    } catch (error) {
        const confirmed = [...saved].filter(snapshot => !snapshot.document.isClosed && !snapshot.document.isDirty);
        const remaining = [...affected].filter(snapshot => !confirmed.includes(snapshot));
        const failure = new Error(`Version edits were applied, but the operation could not be completed.\n${error.message}\nConfirmed saved: ${confirmed.map(snapshot => snapshot.file).join(', ') || 'none'}.\nNot confirmed saved: ${remaining.map(snapshot => snapshot.file).join(', ') || 'none'}.\nReview the files and save any remaining changes before opening a new preview. No changes were rolled back.`);
        failure.changesApplied = true;
        throw failure;
    }
    return true;
}

async function discoverSources(folder) {
    const found = [];
    let skipped = 0;
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/{package.json,Directory.Build.props,pyproject.toml,VERSION}'), '**/{node_modules,.git,bin,obj,out,dist,build,.venv,venv}/**', 201);
    const truncated = files.length > 200;
    for (const uri of files.slice(0, 200)) {
        try {
            const file = relativeFile(folder, uri);
            const { pattern } = defaultLocation(file);
            const snapshot = await openProjectFile(folder, file);
            const capture = locate(snapshot.text, pattern, file);
            validateVersion(capture.value);
            found.push({ file, pattern, value: capture.value });
        } catch {
            skipped++;
        }
    }
    return { found, truncated, skipped };
}

async function discoverTargets(folder, definition, componentId) {
    const inspection = await inspectProject(folder, definition);
    const report = inspection.components.find(item => item.component.id === componentId);
    if (!report?.version || report.issues.some(issue => issue.severity === 'error')) throw new Error(report?.issues[0]?.message || 'Choose a valid component source.');
    const variants = new Set();
    for (const format of FORMATS) {
        try {
            variants.add(formatVersion(report.version, format));
        } catch { /* Numeric representations are available only for compatible versions. */ }
    }
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), '**/{node_modules,.git,bin,obj,out,dist,build,.venv,venv,coverage}/**', 501);
    const found = [], seen = new Set();
    let skippedFiles = 0, skippedFields = 0;
    for (const uri of files.slice(0, 500)) {
        if (/(?:^|\/)changelog(?:[.-]|$)|(?:^|\/)licen[cs]e(?:[.-]|$)|\.versync\.json$|\.(?:vsix|lock|png|jpg|gif|ico|pdf|zip|exe|dll)$/i.test(uri.path)) continue;
        let file, snapshot;
        try {
            file = relativeFile(folder, uri);
            if (file.toLowerCase() === CONFIG_FILE) continue;
            snapshot = await openProjectFile(folder, file, new Map(inspection.documents));
        } catch { skippedFiles++; continue; }
        const candidates = [];
        for (const value of variants) {
            let cursor = 0;
            while (cursor < snapshot.text.length) {
                const start = snapshot.text.indexOf(value, cursor);
                if (start < 0) break;
                const end = start + value.length;
                cursor = end;
                const badge = /https:\/\/(?:img\.)?shields\.io\/badge\/[^\s)]*$/.test(snapshot.text.slice(Math.max(0, start - 512), start));
                if (/[\w.+-]/.test(snapshot.text[start - 1] || '') || /[\w.+]/.test(snapshot.text[end] || '') ||
                    snapshot.text[end] === '-' && !badge) continue;
                candidates.push({ start, end, value });
            }
        }
        candidates.sort((a, b) => b.value.length - a.value.length);
        const claimed = [];
        for (const candidate of candidates) {
            if (claimed.some(span => candidate.start < span.end && span.start < candidate.end)) continue;
            claimed.push(candidate);
            if (inspection.components.some(item => item.entries.some(entry => identity(entry.snapshot.uri) === identity(snapshot.uri) && candidate.start < entry.end && entry.start < candidate.end))) continue;
            try {
                const pattern = selectionPattern(snapshot.text, candidate.start, candidate.end);
                const key = file + '\n' + pattern;
                if (seen.has(key)) continue;
                seen.add(key);
                const position = snapshot.document.positionAt(candidate.start);
                found.push({ file, pattern, value: candidate.value, line: position.line + 1,
                    context: snapshot.document.lineAt(position.line).text.trim(), snapshot });
            } catch { skippedFields++; }
            if (found.length >= 200) {
                assertUnchanged(inspection.documents);
                return { found, skippedFiles, skippedFields, limit: 'fields', inspection };
            }
        }
    }
    assertUnchanged(inspection.documents);
    return { found, skippedFiles, skippedFields, limit: files.length > 500 ? 'files' : null, inspection };
}

module.exports = { identity, relativeFile, openProjectFile, assertUnchanged, inspectProject, planChanges, applyChanges, discoverSources, discoverTargets, validateProjectedChanges };
