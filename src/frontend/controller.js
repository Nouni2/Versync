/* SPDX-License-Identifier: MIT */
'use strict';

const vscode = require('vscode');
const { createStorage } = require('../backend/storage');
const { CONFIG_FILE, componentId, parseConfiguration, serializeConfiguration } = require('../backend/configuration');
const { validateDefinition, importDefinition } = require('../backend/definition');
const { validateVersion, parseVersion, bumpVersion, downgradeVersion, formatTag } = require('../backend/version');
const { identity, inspectProject, planChanges, applyChanges, discoverTargets, assertUnchanged, relativeFile } = require('../backend/project');
const { input, patternLocation, selectedLocation, sourceLocation, chooseFormat, chooseRules, definitionLocation, formatLabel, formatChoices } = require('./configuration');
const { createView } = require('./view');

const clone = value => JSON.parse(JSON.stringify(value));

function createController(context) {
    const storage = createStorage(context.globalState);
    const reports = new Map(), timers = new Map(), generations = new Map(), watchers = new Map();
    let disposed = false;
    let pendingWrite = Promise.resolve();
    const selectionKey = folder => 'selected:' + identity(folder.uri);
    const view = createView(reports, folder => context.workspaceState.get(selectionKey(folder)));

    function write(action) {
        const result = pendingWrite.then(() => {
            if (disposed) throw new Error('Versync has been deactivated.');
            return action();
        });
        pendingWrite = result.catch(() => {});
        return result;
    }

    async function refresh(folder) {
        if (disposed) return;
        const key = identity(folder.uri), generation = (generations.get(key) || 0) + 1;
        generations.set(key, generation);
        let result;
        try { result = await inspectProject(folder, await storage.read(folder.uri)); }
        catch (error) { result = { folder, error: error.message, components: [], issues: error.message.startsWith(CONFIG_FILE + ':') ? [{
            severity: 'error', message: error.message, uri: vscode.Uri.joinPath(folder.uri, ...CONFIG_FILE.split('/')), range: new vscode.Range(0, 0, 0, 0)
        }] : [] }; }
        if (!disposed && generations.get(key) === generation && vscode.workspace.workspaceFolders?.some(item => identity(item.uri) === key)) {
            reports.set(key, result); view.refresh();
        }
        return result;
    }

    function schedule(folder) {
        if (disposed) return;
        const key = identity(folder.uri);
        clearTimeout(timers.get(key));
        timers.set(key, setTimeout(() => { timers.delete(key); void refresh(folder); }, 200));
    }

    async function changed(uri) {
        for (const folder of vscode.workspace.workspaceFolders || []) {
            let file;
            try { file = relativeFile(folder, uri); }
            catch { continue; }
            if (file === CONFIG_FILE || file === '.vscode') { schedule(folder); continue; }
            try {
                const definition = await storage.read(folder.uri);
                const normalize = value => folder.uri.scheme === 'file' && process.platform === 'win32' ? value.toLowerCase() : value;
                if (definition.components.some(component => [component.source, ...component.targets].some(location =>
                    normalize(location.file) === normalize(file) || normalize(location.file).startsWith(normalize(file) + '/')))) schedule(folder);
            } catch {
                schedule(folder);
            }
        }
    }

    function workspaceFoldersChanged() {
        const folders = vscode.workspace.workspaceFolders || [], active = new Set(folders.map(folder => identity(folder.uri)));
        for (const [key, watcher] of watchers) {
            if (!active.has(key)) {
                watcher.dispose(); watchers.delete(key); reports.delete(key);
                clearTimeout(timers.get(key)); timers.delete(key);
                generations.set(key, (generations.get(key) || 0) + 1);
            }
        }
        for (const folder of folders) {
            const key = identity(folder.uri);
            if (!watchers.has(key)) {
                const items = ['**/*', CONFIG_FILE].map(pattern => vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern)));
                const subscriptions = items.flatMap(watcher => [watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed)]);
                watchers.set(key, { dispose() { subscriptions.forEach(item => item.dispose()); items.forEach(item => item.dispose()); } });
                void refresh(folder);
            }
        }
        view.refresh();
    }

    async function chooseFolder(node) {
        const folders = vscode.workspace.workspaceFolders || [];
        if (!folders.length) throw new Error('Open a project folder first.');
        if (node?.folder) {
            const folder = folders.find(item => identity(item.uri) === identity(node.folder.uri));
            if (!folder) throw new Error('This project folder is no longer open.');
            return folder;
        }
        const active = vscode.window.activeTextEditor?.document.uri;
        const folder = active && vscode.workspace.getWorkspaceFolder(active);
        if (folder || folders.length === 1) return folder || folders[0];
        return (await vscode.window.showQuickPick(folders.map(item => ({ label: item.name, description: item.uri.fsPath, folder: item })),
            { title: 'Select project', placeHolder: 'Search project folders' }))?.folder;
    }

    async function chooseComponent(folder, node) {
        const report = await refresh(folder);
        if (report.error) throw new Error(report.error);
        if (!report.components.length) throw new Error('Add a component first using Versync: Add Component.');
        let selected = node?.componentId && report.components.find(item => item.component.id === node.componentId);
        if (node?.componentId && !selected) throw new Error('The component no longer exists.');
        if (!selected) selected = report.components.length === 1 ? report.components[0] :
            (await vscode.window.showQuickPick(report.components.map(item => ({ label: item.component.name, description: item.version || 'Invalid version source', report: item })),
                { title: 'Select component', placeHolder: 'Search components' }))?.report;
        if (selected) { await context.workspaceState.update(selectionKey(folder), selected.component.id); view.updateStatus(); }
        return selected;
    }

    async function saveDefinition(folder, definition, expected) {
        validateDefinition(definition);
        await write(async () => {
            if (!vscode.workspace.workspaceFolders?.some(item => identity(item.uri) === identity(folder.uri))) throw new Error('The project folder is no longer open.');
            await storage.write(folder.uri, definition, expected);
        });
        return refresh(folder);
    }

    async function addComponent(node) {
        const folder = await chooseFolder(node); if (!folder) return;
        const expected = await storage.read(folder.uri);
        const source = await sourceLocation(folder); if (!source) return;
        const name = await input('Component name', expected.components.length ? '' : folder.name, value => {
            if (!value.trim() || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Enter a name without surrounding spaces or control characters.');
            if (expected.components.some(item => item.name.toLowerCase() === value.toLowerCase())) throw new Error('A component already has that name.');
        });
        if (name === undefined) return;
        const rules = await chooseRules(source.value); if (rules === undefined) return;
        const component = { id: componentId(name), name, source: definitionLocation(source), targets: [], rules, tagPrefix: 'v' };
        const definition = clone(expected); definition.components.push(component);
        const inspection = await inspectProject(folder, definition);
        const error = inspection.issues.find(issue => issue.severity === 'error');
        if (error) throw new Error(error.message);
        assertUnchanged(new Map([['source', source.snapshot]]));
        await saveDefinition(folder, definition, expected);
        await context.workspaceState.update(selectionKey(folder), component.id);
        view.updateStatus();
        await findTargets({ folder, componentId: component.id });
    }

    async function registerTargets(folder, componentId, additions, expected) {
        if (!additions.length) return;
        const definition = clone(expected), component = definition.components.find(item => item.id === componentId);
        if (!component) throw new Error('The component no longer exists.');
        component.targets.push(...additions);
        const report = await inspectProject(folder, definition);
        const error = report.issues.find(issue => issue.severity === 'error');
        if (error) throw new Error(error.message);
        await saveDefinition(folder, definition, expected);
        await vscode.window.showInformationMessage(`Added ${additions.length} ${additions.length === 1 ? 'version field' : 'version fields'} to ${component.name}.`);
    }

    async function addTarget(node, useSelection) {
        const folder = await chooseFolder(node); if (!folder) return;
        const selected = useSelection ? await selectedLocation(folder) : await patternLocation(folder);
        if (!selected) return;
        const report = await chooseComponent(folder, node); if (!report) return;
        if (!report.version) throw new Error('Repair the component source before adding targets.');
        const expected = await storage.read(folder.uri);
        const format = await chooseFormat(report.version, selected.value, undefined, selected.file); if (format === undefined) return;
        assertUnchanged(new Map([['selection', selected.snapshot]]));
        await registerTargets(folder, report.component.id, [{ ...definitionLocation(selected), format }], expected);
    }

    async function findTargets(node) {
        const folder = await chooseFolder(node); if (!folder) return;
        const report = await chooseComponent(folder, node); if (!report) return;
        const expected = await storage.read(folder.uri);
        const discovery = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Finding version copies' }, () => discoverTargets(folder, expected, report.component.id));
        const notes = [];
        if (discovery.limit === 'files') notes.push('Search limited to 500 files');
        if (discovery.limit === 'fields') notes.push('Showing the first 200 matching fields');
        if (discovery.skippedFiles) notes.push(`Skipped ${discovery.skippedFiles} unreadable or unsupported files`);
        if (discovery.skippedFields) notes.push(`${discovery.skippedFields} fields need manual patterns`);
        if (!discovery.found.length) {
            await vscode.window.showInformationMessage(`No matching version fields found. ${notes.length ? notes.join('. ') + '. ' : ''}Select a version in the editor and run Track Selected Version to add it.`);
            return;
        }
        const formats = formatChoices(report.version);
        const choices = discovery.found.flatMap(candidate => formats.filter(format => format.description === candidate.value).map(format => ({
            label: `${candidate.file}:${candidate.line}`, description: `${candidate.value} (${format.label})`,
            detail: [candidate.context, format.detail].filter(Boolean).join(' | '),
            picked: false, candidate, format: format.format
        })));
        const headings = [{ label: 'Select fields to track; choose one format per field', kind: vscode.QuickPickItemKind.Separator },
            ...notes.map(label => ({ label, kind: vscode.QuickPickItemKind.Separator }))];
        let selected;
        while (true) {
            selected = await vscode.window.showQuickPick([...headings, ...choices], { canPickMany: true, matchOnDescription: true, matchOnDetail: true,
                title: `Version copies: ${report.component.name}`, ignoreFocusOut: true, placeHolder: 'Search files or versions' });
            if (!selected?.length) return;
            const duplicate = selected.find((choice, index) => selected.findIndex(item => item.candidate === choice.candidate) !== index);
            if (!duplicate) break;
            choices.forEach(choice => { choice.picked = selected.includes(choice); });
            await vscode.window.showWarningMessage(`${duplicate.candidate.file}:${duplicate.candidate.line}: select one format for this field.`);
        }
        const additions = selected.map(({ candidate, format }) => ({ file: candidate.file, pattern: candidate.pattern, format }));
        const snapshots = selected.map(choice => choice.candidate.snapshot);
        snapshots.push(discovery.inspection.components.find(item => item.component.id === report.component.id).entries.find(entry => entry.source).snapshot);
        assertUnchanged(new Map(snapshots.map(snapshot => [identity(snapshot.uri), snapshot])));
        await registerTargets(folder, report.component.id, additions, expected);
    }

    async function commitPlan(folder, definition, requests) {
        const plan = await planChanges(folder, definition, requests);
        if (!plan.changes.length) { await vscode.window.showInformationMessage('The selected versions are already synchronized.'); return; }
        const applied = await write(async () => {
            if (!vscode.workspace.workspaceFolders?.some(item => identity(item.uri) === identity(folder.uri))) throw new Error('The project folder is no longer open.');
            if (JSON.stringify(await storage.read(folder.uri)) !== JSON.stringify(definition)) throw new Error('The setup changed. Review a new preview.');
            return applyChanges(plan);
        });
        const report = await refresh(folder);
        if (applied && report?.issues?.length) {
            void vscode.window.showWarningMessage('Some tracked versions still differ or could not be read. See the Problems panel.');
        }
    }

    async function versionAction(node, action) {
        const folder = await chooseFolder(node); if (!folder) return;
        const report = await chooseComponent(folder, node); if (!report) return;
        if (!report.version) throw new Error(report.issues[0]?.message || 'Repair the component source first.');
        const definition = await storage.read(folder.uri);
        let next;
        if (action === 'bump' || action === 'downgrade') {
            if (!report.component.rules) throw new Error('Enable versioning rules through Manage Component, or enter a version manually.');
            const downgrade = action === 'downgrade';
            const changeVersion = downgrade ? downgradeVersion : bumpVersion;
            const choices = ['patch', 'minor', 'major', 'prerelease'].map(kind => {
                try { return { label: `$(${downgrade ? 'arrow-down' : 'arrow-up'}) ${kind[0].toUpperCase() + kind.slice(1)}`,
                    next: changeVersion(report.version, kind, report.component.rules) }; }
                catch { return undefined; }
            }).filter(Boolean).map(choice => ({ ...choice, description: choice.next }));
            if (!choices.length) throw new Error(`No ${action} is available for ${report.version}. Enter a version manually.`);
            const choice = await vscode.window.showQuickPick(choices, { title: `${downgrade ? 'Downgrade' : 'Bump'} ${report.component.name} · ${report.version}`, placeHolder: 'Choose the next version' });
            if (!choice) return;
            next = choice.next;
        } else if (action === 'sync') next = report.version;
        else next = await input(`Set ${report.component.name} version`, report.version,
            value => { validateVersion(value); if (report.component.rules) parseVersion(value); });
        if (next !== undefined) await commitPlan(folder, definition, [{ id: report.component.id, previous: report.version, next }]);
    }

    async function updateTogether(node) {
        const folder = await chooseFolder(node); if (!folder) return;
        const inspection = await refresh(folder); if (inspection.error) throw new Error(inspection.error);
        if (!inspection.components.length) { await vscode.window.showInformationMessage('Add a component before updating versions.'); return; }
        const choices = await vscode.window.showQuickPick(inspection.components.map(report => ({ label: report.component.name, description: report.version || 'Invalid version source', report })),
            { title: 'Update components together', placeHolder: 'Search components to update', canPickMany: true });
        if (!choices?.length) return;
        const definition = await storage.read(folder.uri), requests = [];
        for (const { report } of choices) {
            if (!report.version) throw new Error(`${report.component.name}: repair the source first.`);
            const next = await input(`Set ${report.component.name} version`, report.version,
                value => { validateVersion(value); if (report.component.rules) parseVersion(value); });
            if (next === undefined) return;
            requests.push({ id: report.component.id, previous: report.version, next });
        }
        await commitPlan(folder, definition, requests);
    }

    async function check(node) {
        const folder = await chooseFolder(node); if (!folder) return;
        const report = await refresh(folder); if (report.error) throw new Error(report.error);
        if (!report.components.length) { await vscode.window.showInformationMessage('Add a component to start tracking versions.'); return; }
        if (report.issues.length) await vscode.window.showWarningMessage(`${report.issues.length} version ${report.issues.length === 1 ? 'issue' : 'issues'}. See the Problems panel.`);
        else if (!report.definition.components.some(component => component.targets.length)) await vscode.window.showInformationMessage('Version sources are valid. No target fields have been added.');
        else await vscode.window.showInformationMessage('All tracked versions match their sources.');
    }

    async function manageComponent(node) {
        const folder = await chooseFolder(node); if (!folder) return;
        const report = await chooseComponent(folder, node); if (!report) return;
        const expected = await storage.read(folder.uri), definition = clone(expected);
        const component = definition.components.find(item => item.id === report.component.id);
        const action = await vscode.window.showQuickPick([
            { label: 'Rename component', action: 'name' }, { label: 'Change version source', action: 'source' },
            { label: 'Configure versioning rules', action: 'rules' }, { label: 'Change tag prefix', action: 'tag' },
            { label: 'Edit or remove a target', action: 'target' }, { label: 'Remove component', action: 'remove' }
        ], { title: `Manage component: ${component.name}`, placeHolder: 'Search component actions' });
        if (!action) return;
        if (action.action === 'target') return editTarget({ folder, componentId: component.id });
        if (action.action === 'name') {
            const name = await input('Component name', component.name, value => {
                const proposed = clone(definition); proposed.components.find(item => item.id === component.id).name = value; validateDefinition(proposed);
            });
            if (name === undefined) return; component.name = name;
        } else if (action.action === 'source') {
            const source = await sourceLocation(folder); if (!source) return;
            component.source = definitionLocation(source);
            if (component.rules) parseVersion(source.value);
            const inspection = await inspectProject(folder, definition);
            const error = inspection.issues.find(issue => issue.severity === 'error'); if (error) throw new Error(error.message);
            assertUnchanged(new Map([['source', source.snapshot]]));
        } else if (action.action === 'rules') {
            const source = report.entries.find(entry => entry.source);
            if (!source) throw new Error('Fix the missing version source before changing versioning rules.');
            validateVersion(source.value);
            const rules = await chooseRules(source.value, component.rules); if (rules === undefined) return;
            component.rules = rules;
        } else if (action.action === 'tag') {
            if (!report.version) throw new Error('Fix the version source before changing the tag prefix.');
            const prefix = await input('Git tag prefix', component.tagPrefix, value => formatTag(report.version, value));
            if (prefix === undefined) return; component.tagPrefix = prefix;
        } else {
            if (await vscode.window.showWarningMessage(`Remove ${component.name} and its tracking setup? Project files stay unchanged.`, { modal: true }, 'Remove Component') !== 'Remove Component') return;
            definition.components = definition.components.filter(item => item.id !== component.id);
        }
        await saveDefinition(folder, definition, expected);
    }

    async function editTarget(node) {
        const folder = await chooseFolder(node); if (!folder) return;
        const report = await chooseComponent(folder, node); if (!report) return;
        const expected = await storage.read(folder.uri), definition = clone(expected), component = definition.components.find(item => item.id === report.component.id);
        if (!component.targets.length) { await vscode.window.showInformationMessage(`${component.name} has no target fields. Use Find Version Copies or Track Selected Version to add one.`); return; }
        let index = node?.targetIndex;
        if (!Number.isInteger(index) || index < 0) index = (await vscode.window.showQuickPick(component.targets.map((target, targetIndex) => ({
            label: target.file, description: formatLabel(target.format), detail: target.pattern, targetIndex
        })), { title: 'Select target field', placeHolder: 'Search target files' }))?.targetIndex;
        if (index === undefined) return;
        const target = component.targets[index]; if (!target) throw new Error('This target no longer exists.');
        if (node?.location && JSON.stringify(node.location) !== JSON.stringify(target)) throw new Error('The target changed. Select it again in the refreshed view.');
        const choice = await vscode.window.showQuickPick(['Change format', 'Edit matching pattern', 'Move to another file', 'Remove target'], { title: `Edit target: ${target.file}`, placeHolder: 'Search target actions' });
        if (!choice) return;
        if (choice === 'Remove target') {
            if (await vscode.window.showWarningMessage(`Stop tracking this field in ${target.file}?`, { modal: true }, 'Remove Target') !== 'Remove Target') return;
            component.targets.splice(index, 1);
        } else {
            if (choice === 'Change format') {
                if (!report.version) throw new Error('Repair the version source first.');
                const value = report.entries.find(entry => !entry.source && entry.index === index)?.value;
                const format = await chooseFormat(report.version, value, target.format, target.file); if (format === undefined) return;
                target.format = format;
            } else {
                const selected = await patternLocation(folder, choice === 'Edit matching pattern' ? target : undefined); if (!selected) return;
                Object.assign(target, definitionLocation(selected));
                assertUnchanged(new Map([['target', selected.snapshot]]));
            }
            const inspection = await inspectProject(folder, definition);
            const error = inspection.issues.find(issue => issue.severity === 'error'); if (error) throw new Error(error.message);
        }
        await saveDefinition(folder, definition, expected);
    }

    async function transfer(node, action) {
        const folder = await chooseFolder(node); if (!folder) return;
        const expected = await storage.read(folder.uri);
        if (action === 'export') {
            if (!expected.components.length) throw new Error('There is no project setup to export.');
            const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(serializeConfiguration(expected, expected.fileConfiguration?.raw), null, 2) + '\n' });
            await vscode.window.showTextDocument(document, { preview: false });
            await vscode.window.showInformationMessage('Use Save As to save this project setup.');
        } else {
            const uris = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: 'Import setup' });
            if (!uris?.length) return;
            const document = await vscode.workspace.openTextDocument(uris[0]);
            const version = document.version;
            const value = JSON.parse(document.getText());
            const definition = value?.components && !Array.isArray(value.components) ? parseConfiguration(value) : importDefinition(value, folder.name);
            const inspection = await inspectProject(folder, definition);
            const error = inspection.issues.find(issue => issue.severity === 'error'); if (error) throw new Error(error.message);
            if (await vscode.window.showWarningMessage(`Replace the setup for ${folder.name} with ${definition.components.length} imported ${definition.components.length === 1 ? 'component' : 'components'}?`, { modal: true }, 'Import Setup') !== 'Import Setup') return;
            if (document.isClosed || document.version !== version) throw new Error('The import file changed. Import it again.');
            assertUnchanged(inspection.documents);
            await saveDefinition(folder, definition, expected);
        }
    }

    async function openConfiguration(node) {
        const folder = await chooseFolder(node); if (!folder) return;
        const uri = vscode.Uri.joinPath(folder.uri, ...CONFIG_FILE.split('/'));
        try { await vscode.workspace.fs.stat(uri); }
        catch (error) {
            if (error.code !== 'FileNotFound') throw error;
            await write(() => storage.createFile(folder.uri));
        }
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
        await refresh(folder);
    }

    async function changeVersionPrefix(folder) {
        const expected = await storage.read(folder.uri);
        const current = expected.statusBarPrefix ?? vscode.workspace.getConfiguration('versync', folder.uri).get('statusBarPrefix', 'v');
        const report = reports.get(identity(folder.uri));
        const selected = report?.components?.find(item => item.component.id === context.workspaceState.get(selectionKey(folder))) || report?.components?.[0];
        const choices = [
            { label: 'No prefix', prefix: '' },
            { label: 'v', prefix: 'v' },
            { label: 'V', prefix: 'V' },
            { label: 'Project name', prefix: '{project} ' },
            { label: 'Project name + v', prefix: '{project} v' },
            { label: 'Project name + V', prefix: '{project} V' }
        ].map(choice => ({ ...choice,
            description: selected?.version ? choice.prefix.replace(/\{project\}/g, () => folder.name) + selected.version : undefined,
            detail: choice.prefix === current ? 'Current prefix' : undefined
        }));
        choices.push({ label: '$(edit) Custom text…', custom: true });
        const choice = await vscode.window.showQuickPick(choices, {
            title: 'Version prefix', placeHolder: 'Search prefix options', ignoreFocusOut: true
        });
        if (!choice) return;
        let prefix = choice.prefix;
        if (choice.custom) {
            prefix = await input('Version prefix', current, text => {
                validateDefinition({ ...expected, statusBarPrefix: text });
            }, 'Text before the version. {project} inserts the project name; {component} inserts the component name. Include any spaces yourself.');
        }
        if (prefix === undefined) return;
        const definition = clone(expected);
        definition.statusBarPrefix = prefix;
        await saveDefinition(folder, definition, expected);
    }

    async function manageProject(node) {
        const folder = await chooseFolder(node); if (!folder) return;
        const action = await vscode.window.showQuickPick([
            { label: 'Open project configuration', action: 'config' },
            { label: '$(edit) Change version prefix', action: 'prefix' },
            { label: 'Add component', action: 'add' }, { label: 'Manage component', action: 'component' },
            { label: 'Export setup', action: 'export' }, { label: 'Import setup', action: 'import' },
            { label: 'Use a saved setup…', action: 'associate' }, { label: 'Reset project setup', action: 'reset' }
        ], { title: `Manage project: ${folder.name}`, placeHolder: 'Search project actions' });
        if (!action) return;
        if (action.action === 'config') return openConfiguration({ folder });
        if (action.action === 'prefix') return changeVersionPrefix(folder);
        if (action.action === 'add') return addComponent({ folder });
        if (action.action === 'component') return manageComponent({ folder });
        if (['export', 'import'].includes(action.action)) return transfer({ folder }, action.action);
        if (action.action === 'reset') {
            const expected = await storage.read(folder.uri);
            if (await vscode.window.showWarningMessage('Remove the local tracking setup? Project files stay unchanged.', { modal: true }, 'Reset Setup') !== 'Reset Setup') return;
            await write(async () => {
                if (JSON.stringify(await storage.read(folder.uri)) !== JSON.stringify(expected)) throw new Error('The setup changed. Reopen Reset Setup.');
                await storage.reset(folder.uri);
            });
            await refresh(folder); return;
        }
        const existing = storage.entries().filter(entry => entry.definition.components.length && identity(vscode.Uri.parse(entry.uri)) !== identity(folder.uri));
        if (!existing.length) { await vscode.window.showInformationMessage('No setup is saved for another project folder.'); return; }
        const picked = await vscode.window.showQuickPick(existing.map(entry => ({ label: entry.definition.components.map(component => component.name).join(', '), description: vscode.Uri.parse(entry.uri).fsPath, entry })),
            { title: 'Select saved project setup', placeHolder: 'Search saved setups' });
        if (!picked) return;
        const expected = await storage.read(folder.uri), definition = picked.entry.definition;
        const inspection = await inspectProject(folder, definition);
        const error = inspection.issues.find(issue => issue.severity === 'error'); if (error) throw new Error(error.message);
        if (await vscode.window.showWarningMessage(`Replace the setup for ${folder.name} with this saved setup?`, { modal: true }, 'Use Setup') !== 'Use Setup') return;
        assertUnchanged(inspection.documents);
        await saveDefinition(folder, definition, expected);
    }

    async function actions(node) {
        const folder = await chooseFolder(node); if (!folder) return;
        const picked = await new Promise(resolve => {
            const picker = vscode.window.createQuickPick();
            picker.title = 'Versync';
            picker.placeholder = 'Choose an action';
            picker.items = [
                { label: '$(arrow-up) Bump', command: 'versync.bumpVersion' },
                { label: '$(check) Check', command: 'versync.check' },
                { label: '$(arrow-down) Downgrade', command: 'versync.downgradeVersion' },
                { label: '$(edit) Enter Version', command: 'versync.setVersion' }
            ];
            picker.buttons = [{ iconPath: new vscode.ThemeIcon('gear'), tooltip: 'Manage project' }];
            const subscriptions = [
                picker.onDidAccept(() => {
                    if (!picker.selectedItems.length) return;
                    resolve(picker.selectedItems[0]); picker.hide();
                }),
                picker.onDidTriggerButton(() => { resolve({ command: 'versync.manage' }); picker.hide(); }),
                picker.onDidHide(() => { resolve(undefined); subscriptions.forEach(item => item.dispose()); picker.dispose(); })
            ];
            picker.show();
        });
        if (picked) return handlers[picked.command]({ folder, componentId: node?.componentId });
    }

    const handlers = {
        'versync.openConfig': openConfiguration,
        'versync.actions': actions, 'versync.setup': addComponent,
        'versync.addSelectedTarget': node => addTarget(node, true), 'versync.addTarget': node => addTarget(node, false),
        'versync.discoverTargets': findTargets, 'versync.setVersion': node => versionAction(node, 'set'),
        'versync.bumpVersion': node => versionAction(node, 'bump'), 'versync.downgradeVersion': node => versionAction(node, 'downgrade'),
        'versync.synchronize': node => versionAction(node, 'sync'),
        'versync.updateTogether': updateTogether, 'versync.check': check, 'versync.manage': manageProject,
        'versync.manageComponent': manageComponent, 'versync.editTarget': editTarget,
        'versync.exportSetup': node => transfer(node, 'export'), 'versync.importSetup': node => transfer(node, 'import'),
        'versync.copyTag': async node => {
            const folder = await chooseFolder(node); if (!folder) return;
            const report = await chooseComponent(folder, node); if (!report) return;
            if (!report.version) throw new Error('Repair the version source first.');
            await vscode.env.clipboard.writeText(formatTag(report.version, report.component.tagPrefix));
            await vscode.window.showInformationMessage('Git tag copied.');
        },
        'versync.openTarget': async node => {
            if (!node) return;
            const uri = node.issue?.uri || node.entry?.snapshot.uri || (node.folder && node.location && vscode.Uri.joinPath(node.folder.uri, ...node.location.file.split('/')));
            if (!uri) return;
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true, selection: node.issue?.range || node.entry?.range });
        }
    };

    return {
        commands: Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async node => {
            try { await handler(node); }
            catch (error) { await vscode.window.showErrorMessage(`Versync: ${error.message}`); }
        }])),
        start: workspaceFoldersChanged, workspaceFoldersChanged, changed, render: view.updateStatus,
        dispose() {
            disposed = true;
            for (const timer of timers.values()) clearTimeout(timer);
            for (const watcher of watchers.values()) watcher.dispose();
            view.dispose();
        }
    };
}

module.exports = { createController };
