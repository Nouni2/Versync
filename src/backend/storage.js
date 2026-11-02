/* SPDX-License-Identifier: MIT */
'use strict';

const { validateDefinition } = require('./definition');
const vscode = require('vscode');
const { CONFIG_FILE, parseConfiguration, serializeConfiguration } = require('./configuration');
const { openProjectFile } = require('./project');

const PREFIX = 'project:';
const copy = value => JSON.parse(JSON.stringify(value));

function projectKey(uri) {
    let key = uri.toString();
    if (uri.scheme === 'file' && process.platform === 'win32') key = key.toLowerCase();
    return PREFIX + key.replace(/\/$/, '');
}

function createStorage(state) {
    async function fileConfiguration(uri) {
        const fileUri = vscode.Uri.joinPath(uri, ...CONFIG_FILE.split('/'));
        let document = vscode.workspace.textDocuments.find(item => !item.isClosed && item.isDirty && projectKey(item.uri) === projectKey(fileUri));
        let stat;
        try { stat = await vscode.workspace.fs.stat(fileUri); }
        catch (error) {
            if (error.code === 'FileNotFound') { if (!document) return null; }
            else throw new Error(`${CONFIG_FILE}: ${error.message}`);
        }
        let resolvedUri = fileUri;
        if (stat) {
            const snapshot = await openProjectFile({ uri }, CONFIG_FILE);
            document = snapshot.document; stat = snapshot.stat; resolvedUri = snapshot.uri;
        }
        const text = document.getText();
        if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error(`${CONFIG_FILE}: configuration exceeds 2 MiB.`);
        let raw, definition;
        try { raw = JSON.parse(text); definition = parseConfiguration(raw); }
        catch (error) { throw new Error(`${CONFIG_FILE}: ${error.message}`); }
        const file = { uri: resolvedUri, document, version: document.version, text, stat, raw, definition };
        Object.defineProperty(definition, 'fileConfiguration', { value: file });
        return file;
    }

    return {
        async read(uri) {
            const file = await fileConfiguration(uri);
            if (file) return file.definition;
            const value = state.get(projectKey(uri));
            return value === undefined ? { schemaVersion: 1, components: [] } : copy(validateDefinition(value));
        },
        async write(uri, definition, expected) {
            const key = projectKey(uri);
            validateDefinition(definition);
            const file = await fileConfiguration(uri);
            if (file) {
                if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before changing project configuration.');
                if (vscode.workspace.fs.isWritableFileSystem(file.uri.scheme) !== true || file.stat?.permissions & vscode.FilePermission.Readonly) {
                    throw new Error(`${CONFIG_FILE} is read-only.`);
                }
                if (JSON.stringify(file.definition) !== JSON.stringify(expected)) throw new Error('The configuration changed. Reopen the action.');
                const text = JSON.stringify(serializeConfiguration(definition, file.raw), null, 2) + '\n';
                const edit = new vscode.WorkspaceEdit();
                edit.replace(file.uri, new vscode.Range(file.document.positionAt(0), file.document.positionAt(file.text.length)), text);
                if (file.document.version !== file.version || !await vscode.workspace.applyEdit(edit)) throw new Error('Could not update the configuration. Reopen the action.');
                if (!await file.document.save()) throw new Error(`Could not save ${CONFIG_FILE}. The changes remain in the editor.`);
                return;
            }
            if (expected.fileConfiguration) throw new Error('The configuration file was removed. Reopen the action.');
            const current = state.get(key) ?? { schemaVersion: 1, components: [] };
            if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('The project setup changed. Reopen the action and try again.');
            await state.update(key, copy(definition));
        },
        async reset(uri) {
            if (await fileConfiguration(uri)) throw new Error(`This project is controlled by ${CONFIG_FILE}. Edit that file to remove components.`);
            await state.update(projectKey(uri), undefined);
        },
        async createFile(uri) {
            if (await fileConfiguration(uri)) return vscode.Uri.joinPath(uri, ...CONFIG_FILE.split('/'));
            if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before creating project configuration.');
            const value = state.get(projectKey(uri));
            const definition = value === undefined ? { schemaVersion: 1, components: [] } : validateDefinition(value);
            const fileUri = vscode.Uri.joinPath(uri, ...CONFIG_FILE.split('/'));
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '.vscode'));
            const edit = new vscode.WorkspaceEdit();
            edit.createFile(fileUri, { overwrite: false });
            edit.insert(fileUri, new vscode.Position(0, 0), JSON.stringify(serializeConfiguration(definition), null, 2) + '\n');
            if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not create the configuration file.');
            const document = await vscode.workspace.openTextDocument(fileUri);
            if (!await document.save()) throw new Error('Could not save the configuration file.');
            await state.update(projectKey(uri), undefined);
            return fileUri;
        },
        entries() {
            return state.keys().filter(key => key.startsWith(PREFIX)).map(key => ({
                uri: key.slice(PREFIX.length), definition: copy(validateDefinition(state.get(key)))
            }));
        }
    };
}

module.exports = { createStorage };
