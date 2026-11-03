/* SPDX-License-Identifier: MIT */
'use strict';

const vscode = require('vscode');
const { identity } = require('../backend/project');
const { metadataComponent } = require('../backend/definition');
const { formatLabel } = require('./configuration');

function createView(reports, selectedComponent) {
    const emitter = new vscode.EventEmitter();
    const diagnostics = vscode.languages.createDiagnosticCollection('versync');
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    status.name = 'Versync'; status.command = 'versync.actions'; status.show();
    let lastFolder;

    const provider = {
        onDidChangeTreeData: emitter.event,
        getChildren(node) {
            if (!node) return (vscode.workspace.workspaceFolders || []).map(folder => ({ kind: 'folder', folder }));
            if (node.kind === 'folder') {
                const report = reports.get(identity(node.folder.uri));
                if (report?.error) return [{ kind: 'error', folder: node.folder, message: report.error }];
                if (!report) return [{ kind: 'message', label: 'Loading project…' }];
                const children = report.components.map(component => ({ kind: 'component', folder: node.folder, report: component, componentId: component.component.id }));
                children.push({ kind: 'setup', folder: node.folder });
                for (const issue of report.issues.filter(issue => issue.severity === 'error')) children.push({ kind: 'issue', issue });
                return children;
            }
            if (node.kind === 'component') {
                const component = node.report.component;
                const entries = [component.source, ...component.targets];
                const children = entries.map((location, index) => ({
                    kind: 'location', folder: node.folder, componentId: component.id, targetIndex: index - 1, location,
                    entry: node.report.entries.find(entry => index === 0 ? entry.source : !entry.source && entry.index === index - 1),
                    report: node.report
                }));
                const metadata = node.report.entries.find(entry => entry.metadata);
                if (metadata) children.push({ kind: 'metadata', folder: node.folder, componentId: component.id, entry: metadata });
                children.push({ kind: 'discover', folder: node.folder, componentId: component.id });
                return children;
            }
            return [];
        },
        getTreeItem(node) {
            const expanded = vscode.TreeItemCollapsibleState.Expanded;
            const none = vscode.TreeItemCollapsibleState.None;
            let item;
            if (node.kind === 'folder') {
                const report = reports.get(identity(node.folder.uri)), metadata = report?.definition?.metadata;
                const linked = report?.definition && metadataComponent(report.definition);
                item = new vscode.TreeItem(metadata?.name || node.folder.name, expanded);
                item.id = JSON.stringify([identity(node.folder.uri)]);
                item.description = [metadata?.version, report?.definition?.fileConfiguration ? 'versync.json' : undefined].filter(value => value !== undefined).join(' · ');
                item.tooltip = [node.folder.name, metadata?.version !== undefined ? `Project version: ${metadata.version}` : undefined,
                    linked ? `Version from: ${linked.name}` : undefined].filter(Boolean).join('\n');
                item.iconPath = new vscode.ThemeIcon('folder');
                item.contextValue = 'versync.project';
            } else if (node.kind === 'component') {
                item = new vscode.TreeItem(node.report.component.name, expanded);
                item.id = JSON.stringify([identity(node.folder.uri), node.componentId]);
                item.description = node.report.version || 'Version unavailable';
                item.tooltip = [`Source: ${node.report.component.source.file}`, ...node.report.issues.map(issue => issue.message)].join('\n');
                item.iconPath = new vscode.ThemeIcon(node.report.issues.length ? 'warning' : 'versions');
                item.contextValue = 'versync.component';
                item.command = { command: 'versync.actions', title: 'Component actions', arguments: [node] };
            } else if (node.kind === 'metadata') {
                item = new vscode.TreeItem('versync.json · metadata.version', none);
                item.id = JSON.stringify([identity(node.folder.uri), node.componentId, 'metadata']);
                item.description = node.entry.value;
                const mismatch = node.entry.value !== node.entry.expected;
                item.iconPath = new vscode.ThemeIcon(mismatch ? 'warning' : 'check');
                item.tooltip = `Project version: ${node.entry.value}\nExpected: ${node.entry.expected}\nSynchronized copy of the component source. Click to open.`;
                item.command = { command: 'versync.openTarget', title: 'Open metadata version', arguments: [node] };
            } else if (node.kind === 'location') {
                item = new vscode.TreeItem(node.location.file, none);
                item.id = JSON.stringify([identity(node.folder.uri), node.componentId, node.targetIndex]);
                item.description = node.targetIndex < 0 ? 'Version source' : formatLabel(node.location.format);
                const uri = node.entry?.snapshot.uri || vscode.Uri.joinPath(node.folder.uri, ...node.location.file.split('/'));
                const issues = node.report.issues.filter(issue => identity(issue.uri) === identity(uri) &&
                    (!node.entry || issue.range.start.line === node.entry.range.start.line && issue.range.start.character === node.entry.range.start.character));
                const details = node.entry ? [`Version: ${node.entry.value}`] : ['Version field unavailable.'];
                if (node.entry?.expected !== undefined && node.entry.value !== node.entry.expected) details.push(`Expected: ${node.entry.expected}`);
                item.tooltip = [...details, ...issues.map(issue => issue.message)].join('\n');
                const mismatch = !node.entry || issues.length > 0 || node.entry.expected !== undefined && node.entry.value !== node.entry.expected;
                item.iconPath = new vscode.ThemeIcon(mismatch ? 'warning' : node.targetIndex < 0 ? 'symbol-variable' : 'check');
                item.contextValue = node.targetIndex < 0 ? 'versync.source' : 'versync.target';
                item.command = { command: 'versync.openTarget', title: 'Open version field', arguments: [node] };
            } else if (node.kind === 'setup' || node.kind === 'discover') {
                item = new vscode.TreeItem(node.kind === 'setup' ? 'Add Component' : 'Find Version Copies…', none);
                item.iconPath = new vscode.ThemeIcon('add');
                item.command = { command: node.kind === 'setup' ? 'versync.setup' : 'versync.discoverTargets', title: item.label, arguments: [node] };
            } else if (node.kind === 'issue') {
                item = new vscode.TreeItem(node.issue.message, none);
                item.iconPath = new vscode.ThemeIcon('error');
                item.command = { command: 'versync.openTarget', title: 'Open problem', arguments: [node] };
            } else {
                item = new vscode.TreeItem(node.message || node.label, none);
                if (node.kind === 'error') {
                    item.iconPath = new vscode.ThemeIcon('error');
                    item.command = { command: 'versync.manage', title: 'Manage project', arguments: [node] };
                }
            }
            return item;
        }
    };

    const tree = vscode.window.createTreeView('versync.projects', { treeDataProvider: provider, showCollapseAll: true });

    function refresh() {
        diagnostics.clear();
        const grouped = new Map();
        for (const report of reports.values()) {
            for (const issue of report.issues || []) {
                const key = identity(issue.uri);
                if (!grouped.has(key)) grouped.set(key, { uri: issue.uri, entries: [] });
                const diagnostic = new vscode.Diagnostic(issue.range, issue.message,
                    issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
                diagnostic.source = 'Versync'; grouped.get(key).entries.push(diagnostic);
            }
        }
        for (const group of grouped.values()) diagnostics.set(group.uri, group.entries);
        updateStatus();
        emitter.fire(undefined);
    }

    function updateStatus() {
        const active = vscode.window.activeTextEditor?.document.uri;
        const folders = vscode.workspace.workspaceFolders || [];
        const folder = active && vscode.workspace.getWorkspaceFolder(active) || folders.find(item => identity(item.uri) === lastFolder) || folders[0];
        lastFolder = folder && identity(folder.uri);
        const report = folder && reports.get(identity(folder.uri));
        const selected = report?.components?.find(item => item.component.id === selectedComponent(folder)) ||
            report?.components?.find(item => item.component.id === metadataComponent(report.definition)?.id) || report?.components?.[0];
        status.backgroundColor = undefined;
        if (!folder) {
            status.text = '$(versions) Versync';
            status.tooltip = 'Open a project folder to track versions.';
        } else if (report?.error) {
            status.text = '$(error) Versync';
            status.tooltip = report.error;
        } else if (!report) {
            status.text = '$(versions) Versync';
            status.tooltip = 'Reading project versions…';
        } else if (!selected) {
            status.text = '$(versions) Add Component';
            status.tooltip = `Add a versioned component to ${folder.name}.`;
        } else {
            const configuredPrefix = report.definition.statusBarPrefix ?? vscode.workspace.getConfiguration('versync', folder.uri).get('statusBarPrefix', 'v');
            const prefix = typeof configuredPrefix === 'string' ? configuredPrefix : 'v';
            const projectName = report.definition.metadata?.name || folder.name;
            status.text = prefix.replace(/\{(project|component)\}/g, (_, name) => name === 'project' ? projectName : selected.component.name) + (selected.version || '?');
            status.tooltip = report.issues.length ? `${folder.name}: ${report.issues.length} version ${report.issues.length === 1 ? 'issue' : 'issues'}. Click for actions.` :
                `${folder.name}: ${selected.component.targets.length} target ${selected.component.targets.length === 1 ? 'field' : 'fields'}. Click for actions.`;
            if (report.definition.metadata?.version !== undefined) status.tooltip += `\n${projectName}: project version ${report.definition.metadata.version}.`;
        }
        if (report?.error || report?.issues?.length) status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    return { refresh, updateStatus, dispose() { tree.dispose(); status.dispose(); diagnostics.dispose(); emitter.dispose(); } };
}

module.exports = { createView };
