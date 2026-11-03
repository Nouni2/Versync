/*
 * SPDX-License-Identifier: MIT
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outputDirectory = path.join(root, 'build', 'publish', `v${manifest.version}`);
const output = path.join(outputDirectory, `${manifest.name}-${manifest.version}.vsix`);

function xml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function entriesIn(directory) {
    const entries = [];
    for (const name of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const relative = `${directory}/${name.name}`.replace(/\\/g, '/');
        if (name.isDirectory()) entries.push(...entriesIn(relative));
        else if (name.isFile()) entries.push({ name: `extension/${relative}`, data: fs.readFileSync(path.join(root, relative)) });
    }
    return entries;
}

function packageEntries() {
    return manifest.files.flatMap(name => {
        if (name.includes('..') || path.isAbsolute(name)) throw new Error(`Invalid package path: ${name}`);
        const stat = fs.statSync(path.join(root, name));
        return stat.isDirectory() ? entriesIn(name) : [{ name: `extension/${name}`, data: fs.readFileSync(path.join(root, name)) }];
    });
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
    // ZIP headers store a DOS date and time, with 1980 as the earliest representable year.
    const now = new Date();
    const year = Math.max(1980, Math.min(2107, now.getUTCFullYear()));
    const dosDate = ((year - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate();
    const dosTime = (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | Math.floor(now.getUTCSeconds() / 2);
    const local = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
        const crc = crc32(data);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x0800, 6);
        header.writeUInt16LE(0, 8);
        header.writeUInt16LE(dosTime, 10);
        header.writeUInt16LE(dosDate, 12);
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(name.length, 26);
        local.push(header, name, data);
        const directory = Buffer.alloc(46);
        directory.writeUInt32LE(0x02014b50, 0);
        directory.writeUInt16LE(20, 4);
        directory.writeUInt16LE(20, 6);
        directory.writeUInt16LE(0x0800, 8);
        directory.writeUInt16LE(0, 10);
        directory.writeUInt16LE(dosTime, 12);
        directory.writeUInt16LE(dosDate, 14);
        directory.writeUInt32LE(crc, 16);
        directory.writeUInt32LE(data.length, 20);
        directory.writeUInt32LE(data.length, 24);
        directory.writeUInt16LE(name.length, 28);
        directory.writeUInt32LE(offset, 42);
        central.push(directory, name);
        offset += header.length + name.length + data.length;
    }
    const centralSize = central.reduce((n, buffer) => n + buffer.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, ...central, end]);
}

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension/LICENCE" ContentType="text/plain" />
</Types>`;
const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(manifest.name)}" Version="${xml(manifest.version)}" Publisher="${xml(manifest.publisher)}" />
    <DisplayName>${xml(manifest.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(manifest.description)}</Description>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(manifest.engines.vscode)}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENCE" Addressable="true" />
  </Assets>
</PackageManifest>`;
const entries = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: 'extension.vsixmanifest', data: vsixManifest },
    { name: 'extension/package.json', data: fs.readFileSync(path.join(root, 'package.json')) },
    ...packageEntries()
];
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(output, zip(entries));
console.log(`Packaged ${output} (${entries.length} files)`);
