/* SPDX-License-Identifier: MIT */
'use strict';

const vscode = require('vscode');
const { createController } = require('./frontend/controller');

function activate(context) {
    const controller = createController(context);
    context.subscriptions.push(controller);
    for (const [name, handler] of Object.entries(controller.commands)) {
        context.subscriptions.push(vscode.commands.registerCommand(name, handler));
    }
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => controller.changed(event.document.uri)),
        vscode.workspace.onDidSaveTextDocument(document => controller.changed(document.uri)),
        vscode.workspace.onDidCloseTextDocument(document => controller.changed(document.uri)),
        vscode.workspace.onDidRenameFiles(event => event.files.forEach(file => { controller.changed(file.oldUri); controller.changed(file.newUri); })),
        vscode.workspace.onDidCreateFiles(event => event.files.forEach(controller.changed)),
        vscode.workspace.onDidDeleteFiles(event => event.files.forEach(controller.changed)),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('versync.statusBarPrefix')) controller.render();
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(controller.workspaceFoldersChanged),
        vscode.window.onDidChangeActiveTextEditor(controller.render)
    );
    controller.start();
}

module.exports = { activate };
