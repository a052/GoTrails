import { selection } from '$lib/logic/selection';
import { fileStateCollection } from '$lib/logic/file-state';
import { settings } from '$lib/logic/settings';
import { buildGPX, buildKML, type GPXFile } from 'gpx';
import FileSaver from 'file-saver';
import JSZip from 'jszip';
import { get } from 'svelte/store';

export enum ExportState {
    NONE,
    SELECTION,
    ALL,
}
export const exportState = $state({
    current: ExportState.NONE,
});

export type ExportFormat = 'gpx' | 'kml';

// KML rides through the same converter the app uses on import (buildKML reuses toGPXFileType, so the
// include/exclude options below apply identically to both formats).
const formatInfo: Record<ExportFormat, { mime: string; ext: string }> = {
    gpx: { mime: 'application/gpx+xml', ext: 'gpx' },
    kml: { mime: 'application/vnd.google-earth.kml+xml', ext: 'kml' },
};

function serialize(file: GPXFile, exclude: string[], format: ExportFormat): string {
    return format === 'kml' ? buildKML(file, exclude) : buildGPX(file, exclude);
}

async function exportFiles(fileIds: string[], exclude: string[], format: ExportFormat) {
    if (fileIds.length > 1) {
        await exportFilesAsZip(fileIds, exclude, format);
    } else {
        const firstFileId = fileIds.at(0);
        if (firstFileId != null) {
            const file = fileStateCollection.getFile(firstFileId);
            if (file) {
                exportFile(file, exclude, format);
            }
        }
    }
}

export async function exportSelectedFiles(exclude: string[], format: ExportFormat) {
    const fileIds: string[] = [];
    selection.applyToOrderedSelectedItemsFromFile(async (fileId) => {
        fileIds.push(fileId);
    });
    await exportFiles(fileIds, exclude, format);
}

export async function exportAllFiles(exclude: string[], format: ExportFormat) {
    await exportFiles(get(settings.fileOrder), exclude, format);
}

function exportFile(file: GPXFile, exclude: string[], format: ExportFormat) {
    const { mime, ext } = formatInfo[format];
    const blob = new Blob([serialize(file, exclude, format)], { type: mime });
    FileSaver.saveAs(blob, `${file.metadata.name}.${ext}`);
}

async function exportFilesAsZip(fileIds: string[], exclude: string[], format: ExportFormat) {
    const { ext } = formatInfo[format];
    const zip = new JSZip();
    for (const fileId of fileIds) {
        const file = fileStateCollection.getFile(fileId);
        if (file) {
            const content = serialize(file, exclude, format);
            let filename = file.metadata.name;
            for (let i = 1; zip.files[`${filename}.${ext}`]; i++) {
                filename = file.metadata.name + `-${i}`;
            }
            zip.file(`${filename}.${ext}`, content);
        }
    }
    if (Object.keys(zip.files).length > 0) {
        const blob = await zip.generateAsync({ type: 'blob' });
        FileSaver.saveAs(blob, `${format}-files.zip`);
    }
}
