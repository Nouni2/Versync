/* SPDX-License-Identifier: MIT */
'use strict';

const vscode = require('vscode');
const { randomBytes } = require('node:crypto');

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function content(plan) {
    const nonce = randomBytes(24).toString('base64');
    const files = new Map();
    plan.changes.forEach((change, index) => {
        if (!files.has(change.snapshot)) files.set(change.snapshot, []);
        files.get(change.snapshot).push({ change, index });
    });
    const versions = plan.versions.map(version => (plan.versions.length > 1 ? `${version.name}: ` : '') + `${version.previous} → ${version.next}`).join(' · ');
    const summary = `${versions} · ${files.size} ${files.size === 1 ? 'file' : 'files'} · ${plan.changes.length} ${plan.changes.length === 1 ? 'change' : 'changes'}`;
    const groups = [...files].map(([snapshot, entries]) => `<section aria-label="${escape(snapshot.file)}">
        <h2>${escape(snapshot.file)}</h2><ul>${entries.map(({ change, index }) => `<li>
            <input type="checkbox" id="change-${index}" data-index="${index}" checked aria-label="${escape(`Apply ${change.caption}`)}">
            <button type="button" class="diff" data-diff="${index}" title="Click to see diff">
                <span>${escape(change.metadata ? 'metadata.version' : change.source ? 'Version source' : change.caption)} · line ${change.range.start.line + 1}</span>
                <span class="values"><code class="previous">${escape(change.value)}</code><span aria-label="to"> → </span><code class="next">${escape(change.next)}</code></span>
            </button>
        </li>`).join('')}</ul></section>`).join('');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Review version changes</title>
<style nonce="${nonce}">
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 0 24px 24px; }
    header { position: sticky; top: 0; z-index: 1; background: var(--vscode-editor-background); padding: 20px 0 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { font-size: 1.4em; margin: 0 0 12px; } h2 { font-size: 1em; overflow-wrap: anywhere; }
    p { line-height: 1.5; } .guidance, #selection { color: var(--vscode-descriptionForeground); }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; }
    button { font: inherit; cursor: pointer; border: 1px solid var(--vscode-contrastBorder, transparent); border-radius: 3px; padding: 6px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { cursor: default; opacity: .5; } button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    section { margin: 20px 0; } ul { list-style: none; padding: 0; } li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
    input { accent-color: var(--vscode-focusBorder); flex-shrink: 0; }
    button.diff { flex: 1; min-width: 0; text-align: left; display: flex; flex-direction: column; gap: 6px; color: var(--vscode-foreground); background: transparent; overflow-wrap: anywhere; }
    button.diff:hover { background: var(--vscode-list-hoverBackground); } .values { white-space: pre-wrap; }
    code { font-family: var(--vscode-editor-font-family); } .previous { background: var(--vscode-diffEditor-removedTextBackground); } .next { background: var(--vscode-diffEditor-insertedTextBackground); }
    #error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
</style></head><body>
<header>
    <h1>${escape(plan.definition.metadata?.name || plan.folder.name)} — Review version changes</h1>
    <p>${escape(summary)}</p>
    <p class="guidance">Click a change to inspect its diff. Checked changes will be applied.</p>
    <div class="toolbar">
        <button type="button" class="secondary" data-action="check">Check All</button>
        <button type="button" class="secondary" data-action="uncheck">Uncheck All</button>
        <span id="selection" role="status" aria-live="polite"></span>
    </div>
    <div class="toolbar">
        <button type="button" data-action="selected" title="Apply only checked changes">Apply Selected</button>
        <button type="button" data-action="all" title="Apply every proposed change, including unchecked changes">Apply All</button>
        <button type="button" class="secondary" data-action="discard">Discard</button>
    </div>
    <p class="guidance">Apply Selected applies checked changes. Apply All applies every proposed change, including unchecked changes. Unchecked fields may remain out of sync.</p>
    <p class="guidance">Changes are made in the editor. Save the edited files before building; your Auto Save settings apply.</p>
    <p id="error" role="alert" hidden></p>
</header>
<main>${groups}</main>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const checks = [...document.querySelectorAll('input[data-index]')];
    let busy = false;
    function update() {
        const count = checks.filter(input => input.checked).length;
        document.getElementById('selection').textContent = count + ' of ' + checks.length + ' changes checked';
        document.querySelectorAll('button').forEach(button => { button.disabled = busy; });
        checks.forEach(input => { input.disabled = busy; });
        document.querySelector('[data-action="selected"]').disabled = busy || count === 0;
        document.querySelector('[data-action="check"]').disabled = busy || count === checks.length;
        document.querySelector('[data-action="uncheck"]').disabled = busy || count === 0;
    }
    document.addEventListener('change', update);
    document.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button || button.disabled || busy) return;
        if (button.dataset.diff !== undefined) {
            vscode.postMessage({ type: 'diff', index: Number(button.dataset.diff) });
            return;
        }
        const action = button.dataset.action;
        if (action === 'check' || action === 'uncheck') {
            checks.forEach(input => { input.checked = action === 'check'; });
            update();
        } else if (action === 'discard') vscode.postMessage({ type: 'discard' });
        else if (action === 'selected' || action === 'all') {
            const indices = checks.filter(input => action === 'all' || input.checked).map(input => Number(input.dataset.index));
            busy = true;
            document.getElementById('error').hidden = true;
            update();
            document.getElementById('selection').textContent = 'Applying changes…';
            vscode.postMessage({ type: 'apply', indices });
        }
    });
    window.addEventListener('message', event => {
        if (event.data.type !== 'error') return;
        busy = false;
        const error = document.getElementById('error');
        error.textContent = event.data.message;
        error.hidden = false;
        update();
    });
    update();
</script></body></html>`;
}

function createPreview() {
    const documents = new Map(), panels = new Set();
    const provider = vscode.workspace.registerTextDocumentContentProvider('versync-preview', {
        provideTextDocumentContent(uri) {
            const entry = documents.get(uri.toString());
            if (!entry) throw new Error('This version preview has been closed. Open a new preview.');
            return entry.change ? entry.snapshot.text.slice(0, entry.change.start) + entry.change.replacement + entry.snapshot.text.slice(entry.change.end) : entry.snapshot.text;
        }
    });
    return {
        review(plan, apply) {
            const id = randomBytes(16).toString('hex');
            const panel = vscode.window.createWebviewPanel('versync.preview', 'Versync: Review Changes', vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
            panels.add(panel);
            return new Promise(resolve => {
                let applying = false, closed = false;
                const uris = new Set();
                const messages = panel.webview.onDidReceiveMessage(async message => {
                    if (closed || applying || !message || typeof message !== 'object') return;
                    try {
                        if (message.type === 'discard') { panel.dispose(); return; }
                        if (message.type === 'diff') {
                            if (!Number.isInteger(message.index)) return;
                            const change = plan.changes[message.index];
                            if (!change) return;
                            const before = vscode.Uri.from({ scheme: 'versync-preview', path: `/${id}/${message.index}/before/${change.file}` });
                            const after = vscode.Uri.from({ scheme: 'versync-preview', path: `/${id}/${message.index}/after/${change.file}` });
                            documents.set(before.toString(), { snapshot: change.snapshot });
                            documents.set(after.toString(), { snapshot: change.snapshot, change });
                            uris.add(before.toString()); uris.add(after.toString());
                            await vscode.commands.executeCommand('vscode.diff', before, after, `${change.file}: ${change.value} → ${change.next}`, { viewColumn: vscode.ViewColumn.Beside, preview: true });
                        } else if (message.type === 'apply') {
                            if (!Array.isArray(message.indices) || !message.indices.length || new Set(message.indices).size !== message.indices.length ||
                                message.indices.some(index => !Number.isInteger(index) || index < 0 || index >= plan.changes.length)) throw new Error('Choose changes from this preview.');
                            applying = true;
                            const applied = await apply(message.indices.map(index => plan.changes[index]));
                            resolve(applied);
                            panel.dispose();
                        }
                    } catch (error) {
                        if (!closed) void panel.webview.postMessage({ type: 'error', message: error.message });
                        else { resolve(false); void vscode.window.showErrorMessage(`Versync: ${error.message}`); }
                    } finally { applying = false; }
                });
                const disposal = panel.onDidDispose(() => {
                    closed = true;
                    panels.delete(panel);
                    for (const uri of uris) documents.delete(uri);
                    messages.dispose(); disposal.dispose();
                    if (!applying) resolve(false);
                });
                panel.webview.html = content(plan);
            });
        },
        dispose() {
            for (const panel of panels) panel.dispose();
            documents.clear(); provider.dispose();
        }
    };
}

module.exports = { createPreview };
