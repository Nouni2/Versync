# Versync v1.0.1

Versync is a VS Code extension that helps you synchronize version numbers across selected project files. You can set a version, bump it using optional versioning rules, or check for mismatches.

It writes the corresponding value to each registered field. While allowing several components to keep separate versions and rules for each. 

## Set up a project

Open a project folder in VS Code and select Versync in the Activity Bar.

1. Choose **Add Component**. Select the version source from the detected fields, or use a version selected in the editor. Versync searches for sources in `package.json`, `Directory.Build.props`, `pyproject.toml` and `VERSION` files by default.
2. Name the component and choose **Manual versions** or semantic versioning rules.
3. Use **Find Version Copies** to review possible targets. Select the fields to track and their formats. Discovery leaves fields unregistered until you select them.
4. Click the Versync status bar item or a component to open its actions: **Bump**, **Check**, **Downgrade** or **Enter Version**. Version edits open VS Code's **Refactor Preview**, where you can inspect the diffs, select the changes and use **Apply** or **Discard**. Select all proposed edits to keep the source and targets synchronized. The gear button opens project management; **Synchronize Current Version** is also available from the Command Palette.
5. Review and save the edited documents. Your VS Code Auto Save settings apply.

To add a field later, select its complete version string and run **Versync: Track Selected Version**. For unusual file syntax, **Add Target Using Pattern** accepts a JavaScript regular expression with a named `(?<version>...)` capture. The pattern must identify one field in that file.

**Bump** and **Downgrade** use the component's semantic versioning rules and show the resulting versions before selection. Downgrading a core number resets the numbers after it to zero and removes prerelease and build suffixes: `2.3.4` can become `2.3.3`, `2.2.0` or `1.0.0`. A prerelease counter can be decreased while it is above zero. Downgrade calculates a lower version; it does not restore previous file contents. Use **Enter Version** for a specific version.

## Version display

Open **Manage Project → Change version prefix** from the Versync gear button. Choose no prefix, `v`, `V`, the project name, the project name followed by `v` or `V`, or **Custom text…**. The choices preview the current version. Custom text keeps the spaces you enter.

The default is `"v"`. The prefix changes only the status bar display; it does not alter versions in files. No spaces or punctuation are added automatically. The choice is saved in `.vscode/versync.json` when that file controls the project, otherwise in the project's private setup, and updates the status bar immediately.

| Prefix | Display for version `1.2.3` in project `Versync` |
| --- | --- |
| `"v"` | `v1.2.3` |
| `"V"` | `V1.2.3` |
| `""` | `1.2.3` |
| `"Release "` | `Release 1.2.3` |
| `"{project} "` | `Versync 1.2.3` |
| `"{project} v"` | `Versync v1.2.3` |
| `"{project} V"` | `Versync V1.2.3` |

`{project}` uses the workspace folder name; `{component}` uses the selected component's name. The prefix is retained when exporting or editing the setup through Versync. You can also edit the top-level `statusBarPrefix` in `.vscode/versync.json` beside `components`.

For projects without a saved prefix, **Versync: Status Bar Prefix** in VS Code Settings (`versync.statusBarPrefix`) supplies the default.


## Target formats


Templates support `{version}`, `{tag}`, `{major}`, `{minor}`, `{patch}`, `{prerelease}`, `{build}`, `{numeric4}` and `{shields}`. The component fields `{major}`, `{minor}`, `{patch}`, `{prerelease}` and `{build}` require a semantic version. Windows four-part numbers must fit the range 0–65535.


## Stored setup

By default, Versync stores component definitions in VS Code. To control the setup from a file, run **Versync: Open Project Configuration**. It creates `.vscode/versync.json` from the existing setup if the file is absent.

While this file exists, it is the only source of setup. UI changes update the file, and edits to the file refresh the extension. An empty component list stays empty; invalid configuration reports an error instead of loading private settings. Current versions remain in the source files you name.

```json
{
  "components": {
    "Interface": {
      "source": "package.json",
      "versioning": "semver",
      "targets": [
        { "file": "README.md", "match": "Version: {version}" },
        { "file": "app.json", "key": "version" }
      ]
    },
    "CLI": {
      "source": "cli/package.json",
      "versioning": { "label": "beta", "separator": "." },
      "targets": []
    }
  }
}
```

A filename alone selects the usual version field in `package.json`, `Directory.Build.props`, `pyproject.toml` or `VERSION`. Other locations use one selector:

- `key`: a JSON property name, such as `"version"`.
- `match`: literal text containing `{version}` once. Versync replaces that part.
- `pattern`: an advanced regex containing `(?<version>...)`.

Each selector must match once. To track several fields in the same file, add a target entry for each. Target `format` defaults to `"plain"`; the other choices are `"prefixed"`, `"numeric4"`, `"shields"` or `{ "template": "release-{version}" }`.

Omit `versioning` for manual versions, use `"semver"` for semantic bumps, or supply a prerelease object. Its defaults are `separator: ""`, `initial: 1` and `onCoreBump: "reset"`; choose `"remove"` to produce stable core bumps. `tagPrefix` defaults to `"v"`.

The configuration uses JSON without comments. Removing it returns the project to private storage. `.vscode/` is ignored in this repository; sharing the configuration through Git is a separate choice.

Use **Export Setup** to open a setup snapshot, then save it with **Save As**. Use **Import Setup** to load that snapshot on another machine or in another clone. After moving a project, **Manage Project → Use a saved setup…** can reuse its stored definition. Edit a project's setup from one VS Code window at a time.

## Package and install

From the repository folder, run:

```powershell
npm run package
```

In VS Code, run **Extensions: Install from VSIX...** and select the generated `.vsix` file. The extension requires VS Code 1.85 or later. The package script uses Node.js without third-party dependencies.

## Licence
The project is licenced under MIT, check the [LICENCE](LICENCE) file for details.
