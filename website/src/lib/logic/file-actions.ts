import { fileStateCollection } from '$lib/logic/file-state';
import { fileActionManager } from '$lib/logic/file-action-manager';
import { applyToOrderedItemsFromFile, copied, cut, selection } from '$lib/logic/selection';
import { currentTool, Tool } from '$lib/components/toolbar/tools';
import { SplitType } from '$lib/components/toolbar/tools/scissors/scissors';
import {
    ListFileItem,
    ListLevel,
    ListRootItem,
    ListTrackItem,
    ListTrackSegmentItem,
    ListWaypointItem,
    ListWaypointsItem,
    sortItems,
    type ListItem,
} from '$lib/components/file-list/file-list';
import { i18n } from '$lib/i18n.svelte';
import { freeze, type WritableDraft } from 'immer';
import {
    GPXFile,
    parseGPX,
    parseKML,
    Track,
    TrackPoint,
    TrackSegment,
    Waypoint,
    type Coordinates,
    type LineStyleExtension,
    type WaypointType,
} from 'gpx';
import { get } from 'svelte/store';
import { settings } from '$lib/logic/settings';
import { getClosestLinePoint, getClosestTrackSegments, getElevation } from '$lib/utils';
import { gpxStatistics } from '$lib/logic/statistics';
import { boundsManager } from './bounds';

// Generate unique file ids, different from the ones in the database
export function getFileIds(n: number) {
    const ids = [];
    for (let index = 0; ids.length < n; index++) {
        const id = `gpx-${index}`;
        if (!fileStateCollection.getFile(id)) {
            ids.push(id);
        }
    }
    return ids;
}

export function newGPXFile() {
    const newFileName = i18n._('menu.new_file');

    const file = new GPXFile();

    let maxNewFileNumber = 0;
    fileStateCollection.forEach((fileId, file) => {
        if (file.metadata.name && file.metadata.name.startsWith(newFileName)) {
            const number = parseInt(file.metadata.name.split(' ').pop() ?? '0');
            if (!isNaN(number) && number > maxNewFileNumber) {
                maxNewFileNumber = number;
            }
        }
    });

    file.metadata.name = `${newFileName} ${maxNewFileNumber + 1}`;

    return file;
}

export function createFile() {
    const file = newGPXFile();

    fileActions.add(file);
    selection.selectFileWhenLoaded(file._data.id);
    currentTool.set(Tool.ROUTING);
}

export function triggerFileInput() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gpx,.kml';
    input.multiple = true;
    input.className = 'hidden';
    input.onchange = () => {
        if (input.files) {
            loadFiles(input.files);
        }
    };
    input.click();
}

export async function loadFiles(list: FileList | File[]) {
    const files: GPXFile[] = [];
    for (let i = 0; i < list.length; i++) {
        const file = await loadFile(list[i]);
        if (file) {
            files.push(file);
        }
    }

    const ids = fileActions.addMultiple(files);
    selection.selectFileWhenLoaded(ids[0]);
    boundsManager.fitBoundsOnLoad(ids);
}

// Choose the parser for a loaded file. The extension decides when present; otherwise (drag-drop, URL
// params and embeds build File objects whose names may lack an extension) the content is sniffed for
// the KML vs GPX root element so those entry points work too.
function detectFormat(name: string, data: string): 'gpx' | 'kml' {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    if (ext === 'kml') {
        return 'kml';
    }
    if (ext === 'gpx') {
        return 'gpx';
    }
    const start = data.charCodeAt(0) === 0xfeff ? 1 : 0;
    const head = data.slice(start, start + 2048);
    const kmlIndex = head.search(/<kml[\s>]/i);
    const gpxIndex = head.search(/<gpx[\s>]/i);
    if (kmlIndex !== -1 && (gpxIndex === -1 || kmlIndex < gpxIndex)) {
        return 'kml';
    }
    return 'gpx';
}

export async function loadFile(file: File): Promise<GPXFile | null> {
    const result = await new Promise<GPXFile | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
            const data = reader.result?.toString() ?? null;
            if (data) {
                try {
                    const gpx =
                        detectFormat(file.name, data) === 'kml' ? parseKML(data) : parseGPX(data);
                    if (gpx.metadata === undefined) {
                        gpx.metadata = {};
                    }
                    if (gpx.metadata.name === undefined || gpx.metadata.name.trim() === '') {
                        gpx.metadata.name = file.name.split('.').slice(0, -1).join('.');
                    }
                    resolve(gpx);
                } catch {
                    // A malformed or unrecognized file must not break the whole batch in loadFiles.
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        };
        reader.readAsText(file);
    });
    return result;
}

// Walk the current selection and hand each scoped chunk to `clear`, which takes the index-array
// scoping the `GPXFile.clear*` methods share: `undefined` means everything at that level, `[]` means
// nothing. Resolves to whether anything actually changed, so callers can tell "cleared" from
// "there was nothing to clear" — the clear methods leave the draft untouched when the data is
// already absent, which keeps the immer patch empty and adds no entry to the edit history.
//
// Items are narrowed individually rather than dispatched on the `level` the selection callback
// reports: `applyToOrderedItemsFromFile` assigns that from whichever item comes last, so a selection
// mixing levels within one file would misroute. Per-item narrowing is exact, and it also expresses
// segments picked from two different tracks.
function clearFromSelection(
    clear: (
        file: WritableDraft<GPXFile>,
        trackIndices?: number[],
        segmentIndices?: number[],
        waypointIndices?: number[]
    ) => void
): Promise<boolean> {
    if (get(selection).size === 0) {
        return Promise.resolve(false);
    }
    return fileActionManager.applyGlobal((draft) => {
        selection.applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
            const file = draft.get(fileId);
            if (!file) {
                return;
            }
            if (items.some((item) => item instanceof ListFileItem)) {
                // The whole file, waypoints included; anything narrower here is a subset.
                clear(file);
                return;
            }
            const waypointIndices: number[] = [];
            let allWaypoints = false;
            for (const item of items) {
                if (item instanceof ListTrackItem) {
                    clear(file, [item.getTrackIndex()], undefined, []);
                } else if (item instanceof ListTrackSegmentItem) {
                    clear(file, [item.getTrackIndex()], [item.getSegmentIndex()], []);
                } else if (item instanceof ListWaypointsItem) {
                    allWaypoints = true;
                } else if (item instanceof ListWaypointItem) {
                    waypointIndices.push(item.getWaypointIndex());
                }
            }
            // Batched into one call because each call walks the whole `wpt` array.
            if (allWaypoints) {
                clear(file, [], [], undefined);
            } else if (waypointIndices.length > 0) {
                clear(file, [], [], waypointIndices);
            }
        });
    });
}

// Helper functions for file operations
export const fileActions = {
    add: (file: GPXFile) => {
        if (file._data.id === undefined) {
            file._data.id = getFileIds(1)[0];
        }
        return fileActionManager.applyGlobal((draft) => {
            draft.set(file._data.id, freeze(file));
        });
    },
    addMultiple: (files: GPXFile[]) => {
        const ids = getFileIds(files.length);
        fileActionManager.applyGlobal((draft) => {
            files.forEach((file, index) => {
                file._data.id = ids[index];
                draft.set(file._data.id, freeze(file));
            });
        });
        return ids;
    },
    duplicateSelection: () => {
        if (get(selection).size === 0) {
            return;
        }
        fileActionManager.applyGlobal((draft) => {
            const ids = getFileIds(get(settings.fileOrder).length);
            let index = 0;
            selection.applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
                if (level === ListLevel.FILE) {
                    const file = fileStateCollection.getFile(fileId);
                    if (file) {
                        const newFile = file.clone();
                        newFile._data.id = ids[index++];
                        draft.set(newFile._data.id, freeze(newFile));
                    }
                } else {
                    const file = draft.get(fileId);
                    if (file) {
                        if (level === ListLevel.TRACK) {
                            for (const item of items) {
                                const trackIndex = (item as ListTrackItem).getTrackIndex();
                                file.replaceTracks(trackIndex + 1, trackIndex, [
                                    file.trk[trackIndex].clone(),
                                ]);
                            }
                        } else if (level === ListLevel.SEGMENT) {
                            for (const item of items) {
                                const trackIndex = (item as ListTrackSegmentItem).getTrackIndex();
                                const segmentIndex = (
                                    item as ListTrackSegmentItem
                                ).getSegmentIndex();
                                file.replaceTrackSegments(
                                    trackIndex,
                                    segmentIndex + 1,
                                    segmentIndex,
                                    [file.trk[trackIndex].trkseg[segmentIndex].clone()]
                                );
                            }
                        } else if (level === ListLevel.WAYPOINTS) {
                            file.replaceWaypoints(
                                file.wpt.length,
                                file.wpt.length - 1,
                                file.wpt.map((wpt) => wpt.clone())
                            );
                        } else if (level === ListLevel.WAYPOINT) {
                            for (const item of items) {
                                const waypointIndex = (item as ListWaypointItem).getWaypointIndex();
                                file.replaceWaypoints(waypointIndex + 1, waypointIndex, [
                                    file.wpt[waypointIndex].clone(),
                                ]);
                            }
                        }
                    }
                }
            });
        });
    },
    addNewTrack: (fileId: string) => {
        fileActionManager.applyToFile(fileId, (file) =>
            file.replaceTracks(file.trk.length, file.trk.length, [new Track()])
        );
    },
    addNewSegment: (fileId: string, trackIndex: number) => {
        fileActionManager.applyToFile(fileId, (file) => {
            const track = file.trk[trackIndex];
            track.replaceTrackSegments(track.trkseg.length, track.trkseg.length, [
                new TrackSegment(),
            ]);
        });
    },
    reverseSelection: () => {
        if (
            !get(selection).hasAnyChildren(new ListRootItem(), true, ['waypoints']) ||
            get(gpxStatistics).global.length <= 1
        ) {
            return;
        }
        fileActionManager.applyGlobal((draft) => {
            selection.applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
                const file = draft.get(fileId);
                if (file) {
                    if (level === ListLevel.FILE) {
                        file.reverse();
                    } else if (level === ListLevel.TRACK) {
                        for (const item of items) {
                            const trackIndex = (item as ListTrackItem).getTrackIndex();
                            file.reverseTrack(trackIndex);
                        }
                    } else if (level === ListLevel.SEGMENT) {
                        for (const item of items) {
                            const trackIndex = (item as ListTrackSegmentItem).getTrackIndex();
                            const segmentIndex = (item as ListTrackSegmentItem).getSegmentIndex();
                            file.reverseTrackSegment(trackIndex, segmentIndex);
                        }
                    }
                }
            });
        });
    },
    createRoundTripForSelection() {
        if (!get(selection).hasAnyChildren(new ListRootItem(), true, ['waypoints'])) {
            return;
        }
        fileActionManager.applyGlobal((draft) => {
            selection.applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
                const file = draft.get(fileId);
                if (file) {
                    if (level === ListLevel.FILE) {
                        file.roundTrip();
                    } else if (level === ListLevel.TRACK) {
                        for (const item of items) {
                            const trackIndex = (item as ListTrackItem).getTrackIndex();
                            file.roundTripTrack(trackIndex);
                        }
                    } else if (level === ListLevel.SEGMENT) {
                        for (const item of items) {
                            const trackIndex = (item as ListTrackSegmentItem).getTrackIndex();
                            const segmentIndex = (item as ListTrackSegmentItem).getSegmentIndex();
                            file.roundTripTrackSegment(trackIndex, segmentIndex);
                        }
                    }
                }
            });
        });
    },
    mergeSelection: (mergeTraces: boolean, removeGaps: boolean) => {
        fileActionManager.applyGlobal((draft) => {
            let first = true;
            let target: ListItem = new ListRootItem();
            let targetFile: GPXFile | undefined = undefined;
            const toMerge: {
                trk: Track[];
                trkseg: TrackSegment[];
                wpt: Waypoint[];
            } = {
                trk: [],
                trkseg: [],
                wpt: [],
            };
            selection.applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
                const file = draft.get(fileId);
                const originalFile = fileStateCollection.getFile(fileId);
                if (file && originalFile) {
                    if (level === ListLevel.FILE) {
                        toMerge.trk.push(...originalFile.trk.map((track) => track.clone()));
                        for (const wpt of originalFile.wpt) {
                            if (!toMerge.wpt.some((w) => w.equals(wpt))) {
                                toMerge.wpt.push(wpt.clone());
                            }
                        }
                        if (first) {
                            target = items[0];
                            targetFile = file;
                        } else {
                            draft.delete(fileId);
                        }
                    } else {
                        if (level === ListLevel.TRACK) {
                            items.forEach((item, index) => {
                                const trackIndex = (item as ListTrackItem).getTrackIndex();
                                toMerge.trkseg.splice(
                                    0,
                                    0,
                                    ...originalFile.trk[trackIndex].trkseg.map((segment) =>
                                        segment.clone()
                                    )
                                );
                                if (index === items.length - 1) {
                                    // Order is reversed, so the last track is the first one and the one to keep
                                    target = item;
                                    file.trk[trackIndex].trkseg = [];
                                } else {
                                    file.trk.splice(trackIndex, 1);
                                }
                            });
                        } else if (level === ListLevel.SEGMENT) {
                            items.forEach((item, index) => {
                                const trackIndex = (item as ListTrackSegmentItem).getTrackIndex();
                                const segmentIndex = (
                                    item as ListTrackSegmentItem
                                ).getSegmentIndex();
                                if (index === items.length - 1) {
                                    // Order is reversed, so the last segment is the first one and the one to keep
                                    target = item;
                                }
                                toMerge.trkseg.splice(
                                    0,
                                    0,
                                    originalFile.trk[trackIndex].trkseg[segmentIndex].clone()
                                );
                                file.trk[trackIndex].trkseg.splice(segmentIndex, 1);
                            });
                        }
                        targetFile = file;
                    }
                    first = false;
                }
            });
            if (mergeTraces) {
                const statistics = get(gpxStatistics);
                const speed =
                    statistics.global.speed.moving > 0 ? statistics.global.speed.moving : undefined;
                let startTime: Date | undefined = undefined;
                if (speed !== undefined) {
                    if (
                        statistics.global.length > 0 &&
                        statistics.getTrackPoint(0)!.trkpt.time !== undefined
                    ) {
                        startTime = statistics.getTrackPoint(0)!.trkpt.time;
                    } else {
                        for (let i = 0; i < statistics.global.length; i++) {
                            const point = statistics.getTrackPoint(i)!;
                            if (point.trkpt.time !== undefined) {
                                startTime = new Date(
                                    point.trkpt.time.getTime() -
                                        (1000 * 3600 * point.distance.total) / speed
                                );
                                break;
                            }
                        }
                    }
                }
                if (toMerge.trk.length > 0 && toMerge.trk[0].trkseg.length > 0) {
                    const s = new TrackSegment();
                    toMerge.trk.map((track) => {
                        track.trkseg.forEach((segment) => {
                            s.replaceTrackPoints(
                                s.trkpt.length,
                                s.trkpt.length,
                                segment.trkpt.slice(),
                                speed,
                                startTime,
                                removeGaps
                            );
                        });
                    });
                    toMerge.trk = [toMerge.trk[0]];
                    toMerge.trk[0].trkseg = [s];
                }
                if (toMerge.trkseg.length > 0) {
                    const s = new TrackSegment();
                    toMerge.trkseg.forEach((segment) => {
                        s.replaceTrackPoints(
                            s.trkpt.length,
                            s.trkpt.length,
                            segment.trkpt.slice(),
                            speed,
                            startTime,
                            removeGaps
                        );
                    });
                    toMerge.trkseg = [s];
                }
            }
            if (targetFile) {
                targetFile = targetFile as GPXFile;
                if (target instanceof ListFileItem) {
                    targetFile.replaceTracks(0, targetFile.trk.length - 1, toMerge.trk);
                    targetFile.replaceWaypoints(0, targetFile.wpt.length - 1, toMerge.wpt);
                } else if (target instanceof ListTrackItem) {
                    const trackIndex = target.getTrackIndex();
                    targetFile.replaceTrackSegments(trackIndex, 0, -1, toMerge.trkseg);
                } else if (target instanceof ListTrackSegmentItem) {
                    const trackIndex = target.getTrackIndex();
                    const segmentIndex = target.getSegmentIndex();
                    targetFile.replaceTrackSegments(
                        trackIndex,
                        segmentIndex,
                        segmentIndex - 1,
                        toMerge.trkseg
                    );
                }
            }
        });
    },
    cropSelection: (start: number, end: number) => {
        if (get(selection).size === 0) {
            return;
        }
        fileActionManager.applyGlobal((draft) => {
            selection.applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
                const file = draft.get(fileId);
                if (file) {
                    if (level === ListLevel.FILE) {
                        const length = file.getNumberOfTrackPoints();
                        if (start >= length || end < 0) {
                            draft.delete(fileId);
                        } else if (start > 0 || end < length - 1) {
                            file.crop(Math.max(0, start), Math.min(length - 1, end));
                        }
                        start -= length;
                        end -= length;
                    } else if (level === ListLevel.TRACK) {
                        const trackIndices = items.map((item) =>
                            (item as ListTrackItem).getTrackIndex()
                        );
                        file.crop(start, end, trackIndices);
                    } else if (level === ListLevel.SEGMENT) {
                        const trackIndices = [(items[0] as ListTrackSegmentItem).getTrackIndex()];
                        const segmentIndices = items.map((item) =>
                            (item as ListTrackSegmentItem).getSegmentIndex()
                        );
                        file.crop(start, end, trackIndices, segmentIndices);
                    }
                }
            }, false);
        });
    },
    extractSelection: () => {
        return fileActionManager.applyGlobal((draft) => {
            selection.applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
                if (level === ListLevel.FILE) {
                    const file = fileStateCollection.getFile(fileId);
                    const statistics = fileStateCollection.getStatistics(fileId);
                    if (file && statistics) {
                        if (file.trk.length > 1) {
                            const fileIds = getFileIds(file.trk.length);
                            const closest = file.wpt.map((wpt) =>
                                getClosestTrackSegments(file, statistics, wpt.getCoordinates())
                            );
                            file.trk.forEach((track, index) => {
                                const newFile = file.clone();
                                const tracks = track.trkseg.map((segment, segmentIndex) => {
                                    const t = track.clone();
                                    t.replaceTrackSegments(0, track.trkseg.length - 1, [segment]);
                                    if (track.name) {
                                        t.name = `${track.name} (${segmentIndex + 1})`;
                                    }
                                    return t;
                                });
                                newFile.replaceTracks(0, file.trk.length - 1, tracks);
                                newFile.replaceWaypoints(
                                    0,
                                    file.wpt.length - 1,
                                    file.wpt.filter((wpt, wptIndex) =>
                                        closest[wptIndex].some(
                                            ([trackIndex]) => trackIndex === index
                                        )
                                    )
                                );
                                newFile._data.id = fileIds[index];
                                newFile.metadata.name =
                                    track.name ?? `${file.metadata.name} (${index + 1})`;
                                draft.set(newFile._data.id, freeze(newFile));
                            });
                        } else if (file.trk.length === 1) {
                            const fileIds = getFileIds(file.trk[0].trkseg.length);
                            const closest = file.wpt.map((wpt) =>
                                getClosestTrackSegments(file, statistics, wpt.getCoordinates())
                            );
                            file.trk[0].trkseg.forEach((segment, index) => {
                                const newFile = file.clone();
                                newFile.replaceTrackSegments(0, 0, file.trk[0].trkseg.length - 1, [
                                    segment,
                                ]);
                                newFile.replaceWaypoints(
                                    0,
                                    file.wpt.length - 1,
                                    file.wpt.filter((wpt, wptIndex) =>
                                        closest[wptIndex].some(
                                            ([, segmentIndex]) => segmentIndex === index
                                        )
                                    )
                                );
                                newFile._data.id = fileIds[index];
                                newFile.metadata.name = `${file.trk[0].name ?? file.metadata.name} (${index + 1})`;
                                draft.set(newFile._data.id, freeze(newFile));
                            });
                        }
                        draft.delete(fileId);
                    }
                } else if (level === ListLevel.TRACK) {
                    const file = draft.get(fileId);
                    if (file) {
                        for (const item of items) {
                            const trackIndex = (item as ListTrackItem).getTrackIndex();
                            const track = file.trk[trackIndex];
                            const tracks = track.trkseg.map((segment, segmentIndex) => {
                                const t = track.clone();
                                t.replaceTrackSegments(0, track.trkseg.length - 1, [segment]);
                                if (track.name) {
                                    t.name = `${track.name} (${segmentIndex + 1})`;
                                }
                                return t;
                            });
                            file.replaceTracks(trackIndex, trackIndex, tracks);
                        }
                    }
                }
            });
        });
    },
    split(
        splitType: SplitType,
        fileId: string,
        trackIndex: number,
        segmentIndex: number,
        coordinates: Coordinates,
        trkptIndex?: number
    ) {
        return fileActionManager.applyGlobal((draft) => {
            const file = fileStateCollection.getFile(fileId);
            if (file) {
                const segment = file.trk[trackIndex].trkseg[segmentIndex];
                let minIndex = 0;
                if (trkptIndex === undefined) {
                    // Find the point closest to split
                    const closest = getClosestLinePoint(segment.trkpt, coordinates);
                    minIndex = closest._data.index;
                } else {
                    minIndex = trkptIndex;
                }
                let absoluteIndex = minIndex;
                file.forEachSegment((seg, trkIndex, segIndex) => {
                    if (
                        (trkIndex < trackIndex && splitType === SplitType.FILES) ||
                        (trkIndex === trackIndex && segIndex < segmentIndex)
                    ) {
                        absoluteIndex += seg.trkpt.length;
                    }
                });
                if (splitType === SplitType.FILES) {
                    const newFile = draft.get(fileId);
                    if (newFile) {
                        newFile.crop(0, absoluteIndex);
                        const newFile2 = file.clone();
                        newFile2._data.id = getFileIds(1)[0];
                        newFile2.crop(absoluteIndex, file.getNumberOfTrackPoints() - 1);
                        draft.set(newFile2._data.id, freeze(newFile2));
                    }
                } else if (splitType === SplitType.TRACKS) {
                    const newFile = draft.get(fileId);
                    if (newFile) {
                        const start = file.trk[trackIndex].clone();
                        start.crop(0, absoluteIndex);
                        const end = file.trk[trackIndex].clone();
                        end.crop(absoluteIndex, file.trk[trackIndex].getNumberOfTrackPoints() - 1);
                        newFile.replaceTracks(trackIndex, trackIndex, [start, end]);
                    }
                } else if (splitType === SplitType.SEGMENTS) {
                    const newFile = draft.get(fileId);
                    if (newFile) {
                        const start = segment.clone();
                        start.crop(0, minIndex);
                        const end = segment.clone();
                        end.crop(minIndex, segment.trkpt.length - 1);
                        newFile.replaceTrackSegments(trackIndex, segmentIndex, segmentIndex, [
                            start,
                            end,
                        ]);
                    }
                }
            }
        });
    },
    cleanSelection: (
        bounds: [Coordinates, Coordinates],
        inside: boolean,
        deleteTrackPoints: boolean,
        deleteWaypoints: boolean
    ) => {
        if (get(selection).size === 0) {
            return;
        }
        fileActionManager.applyGlobal((draft) => {
            selection.applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
                const file = draft.get(fileId);
                if (file) {
                    if (level === ListLevel.FILE) {
                        file.clean(bounds, inside, deleteTrackPoints, deleteWaypoints);
                    } else if (level === ListLevel.TRACK) {
                        const trackIndices = items.map((item) =>
                            (item as ListTrackItem).getTrackIndex()
                        );
                        file.clean(
                            bounds,
                            inside,
                            deleteTrackPoints,
                            deleteWaypoints,
                            trackIndices
                        );
                    } else if (level === ListLevel.SEGMENT) {
                        const trackIndices = [(items[0] as ListTrackSegmentItem).getTrackIndex()];
                        const segmentIndices = items.map((item) =>
                            (item as ListTrackSegmentItem).getSegmentIndex()
                        );
                        file.clean(
                            bounds,
                            inside,
                            deleteTrackPoints,
                            deleteWaypoints,
                            trackIndices,
                            segmentIndices
                        );
                    } else if (level === ListLevel.WAYPOINTS) {
                        file.clean(bounds, inside, false, deleteWaypoints);
                    } else if (level === ListLevel.WAYPOINT) {
                        const waypointIndices = items.map((item) =>
                            (item as ListWaypointItem).getWaypointIndex()
                        );
                        file.clean(bounds, inside, false, deleteWaypoints, [], [], waypointIndices);
                    }
                }
            });
        });
    },
    reduce: (itemsAndPoints: Map<ListItem, TrackPoint[]>) => {
        if (itemsAndPoints.size === 0) {
            return;
        }
        fileActionManager.applyGlobal((draft) => {
            const allItems = Array.from(itemsAndPoints.keys());
            applyToOrderedItemsFromFile(allItems, (fileId, level, items) => {
                const file = draft.get(fileId);
                if (file) {
                    for (const item of items) {
                        if (item instanceof ListTrackSegmentItem) {
                            const trackIndex = item.getTrackIndex();
                            const segmentIndex = item.getSegmentIndex();
                            const points = itemsAndPoints.get(item);
                            if (points) {
                                file.replaceTrackPoints(
                                    trackIndex,
                                    segmentIndex,
                                    0,
                                    file.trk[trackIndex].trkseg[
                                        segmentIndex
                                    ].getNumberOfTrackPoints() - 1,
                                    points
                                );
                            }
                        }
                    }
                }
            });
        });
    },
    addOrUpdateWaypoint: (waypoint: WaypointType, item?: ListWaypointItem) => {
        const apply = (elevation: number | undefined) => {
            if (item) {
                fileActionManager.applyToFile(item.getFileId(), (file) => {
                    const wpt = file.wpt[item.getWaypointIndex()];
                    wpt.name = waypoint.name;
                    wpt.desc = waypoint.desc;
                    wpt.cmt = waypoint.cmt;
                    wpt.sym = waypoint.sym;
                    wpt.link = waypoint.link;
                    wpt.setCoordinates(waypoint.attributes);
                    wpt.ele = elevation;
                    wpt.time = waypoint.time;
                });
            } else {
                const fileIds = new Set<string>();
                get(selection)
                    .getSelected()
                    .forEach((item) => {
                        fileIds.add(item.getFileId());
                    });
                // new Waypoint(waypoint) already copies waypoint.time via its constructor.
                const wpt = new Waypoint(waypoint);
                wpt.ele = elevation;
                fileActionManager.applyToFiles(Array.from(fileIds), (file) =>
                    file.replaceWaypoints(file.wpt.length, file.wpt.length, [wpt])
                );
            }
        };

        // A user-supplied elevation wins; otherwise fall back to fetching it from the DEM tiles
        // (the historical behavior, and what waypoints created from POIs still rely on).
        if (waypoint.ele !== undefined) {
            apply(waypoint.ele);
        } else {
            getElevation([waypoint.attributes]).then((elevation) => apply(elevation[0]));
        }
    },
    deleteWaypoint: (fileId: string, waypointIndex: number) => {
        fileActionManager.applyToFile(fileId, (file) =>
            file.replaceWaypoints(waypointIndex, waypointIndex, [])
        );
    },
    setStyleToSelection: (style: LineStyleExtension) => {
        if (get(selection).size === 0) {
            return;
        }
        fileActionManager.applyGlobal((draft) => {
            selection.applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
                const file = draft.get(fileId);
                if (file && (level === ListLevel.FILE || level === ListLevel.TRACK)) {
                    if (level === ListLevel.FILE) {
                        file.setStyle(style);
                    } else if (level === ListLevel.TRACK) {
                        if (items.length === file.trk.length) {
                            file.setStyle(style);
                        } else {
                            for (const item of items) {
                                const trackIndex = (item as ListTrackItem).getTrackIndex();
                                file.trk[trackIndex].setStyle(style);
                            }
                        }
                    }
                }
            });
        });
    },
    setHiddenToSelection: (hidden: boolean) => {
        if (get(selection).size === 0) {
            return;
        }
        fileActionManager.applyGlobal((draft) => {
            selection.applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
                const file = draft.get(fileId);
                if (file) {
                    if (level === ListLevel.FILE) {
                        file.setHidden(hidden);
                    } else if (level === ListLevel.TRACK) {
                        const trackIndices = items.map((item) =>
                            (item as ListTrackItem).getTrackIndex()
                        );
                        file.setHidden(hidden, trackIndices);
                    } else if (level === ListLevel.SEGMENT) {
                        const trackIndices = [(items[0] as ListTrackSegmentItem).getTrackIndex()];
                        const segmentIndices = items.map((item) =>
                            (item as ListTrackSegmentItem).getSegmentIndex()
                        );
                        file.setHidden(hidden, trackIndices, segmentIndices);
                    } else if (level === ListLevel.WAYPOINTS) {
                        file.setHiddenWaypoints(hidden);
                    } else if (level === ListLevel.WAYPOINT) {
                        const waypointIndices = items.map((item) =>
                            (item as ListWaypointItem).getWaypointIndex()
                        );
                        file.setHiddenWaypoints(hidden, waypointIndices);
                    }
                }
            });
        });
    },
    deleteSelection: () => {
        if (get(selection).size === 0) {
            return;
        }
        fileActionManager.applyGlobal((draft) => {
            selection.applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
                if (level === ListLevel.FILE) {
                    draft.delete(fileId);
                } else {
                    const file = draft.get(fileId);
                    if (file) {
                        if (level === ListLevel.TRACK) {
                            for (const item of items) {
                                const trackIndex = (item as ListTrackItem).getTrackIndex();
                                file.replaceTracks(trackIndex, trackIndex, []);
                            }
                        } else if (level === ListLevel.SEGMENT) {
                            for (const item of items) {
                                const trackIndex = (item as ListTrackSegmentItem).getTrackIndex();
                                const segmentIndex = (
                                    item as ListTrackSegmentItem
                                ).getSegmentIndex();
                                file.replaceTrackSegments(
                                    trackIndex,
                                    segmentIndex,
                                    segmentIndex,
                                    []
                                );
                            }
                        } else if (level === ListLevel.WAYPOINTS) {
                            file.replaceWaypoints(0, file.wpt.length - 1, []);
                        } else if (level === ListLevel.WAYPOINT) {
                            for (const item of items) {
                                const waypointIndex = (item as ListWaypointItem).getWaypointIndex();
                                file.replaceWaypoints(waypointIndex, waypointIndex, []);
                            }
                        }
                    }
                }
            });
        });
    },
    addElevationToSelection: async (): Promise<boolean> => {
        if (get(selection).size === 0) {
            return false;
        }
        const points: (TrackPoint | Waypoint)[] = [];
        selection.applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
            const file = fileStateCollection.getFile(fileId);
            if (file) {
                if (level === ListLevel.FILE) {
                    points.push(...file.getTrackPoints());
                    points.push(...file.wpt);
                } else if (level === ListLevel.TRACK) {
                    const trackIndices = items.map((item) =>
                        (item as ListTrackItem).getTrackIndex()
                    );
                    trackIndices.forEach((trackIndex) => {
                        points.push(...file.trk[trackIndex].getTrackPoints());
                    });
                } else if (level === ListLevel.SEGMENT) {
                    const trackIndex = (items[0] as ListTrackSegmentItem).getTrackIndex();
                    const segmentIndices = items.map((item) =>
                        (item as ListTrackSegmentItem).getSegmentIndex()
                    );
                    segmentIndices.forEach((segmentIndex) => {
                        points.push(...file.trk[trackIndex].trkseg[segmentIndex].getTrackPoints());
                    });
                } else if (level === ListLevel.WAYPOINTS) {
                    points.push(...file.wpt);
                } else if (level === ListLevel.WAYPOINT) {
                    const waypointIndices = items.map((item) =>
                        (item as ListWaypointItem).getWaypointIndex()
                    );
                    points.push(...waypointIndices.map((waypointIndex) => file.wpt[waypointIndex]));
                }
            }
        });
        if (points.length === 0) {
            return false;
        }
        const elevations = await getElevation(points);
        return fileActionManager.applyGlobal((draft) => {
            selection.applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
                const file = draft.get(fileId);
                if (file) {
                    if (level === ListLevel.FILE) {
                        file.addElevation(elevations);
                    } else if (level === ListLevel.TRACK) {
                        const trackIndices = items.map((item) =>
                            (item as ListTrackItem).getTrackIndex()
                        );
                        file.addElevation(elevations, trackIndices, undefined, []);
                    } else if (level === ListLevel.SEGMENT) {
                        const trackIndices = [(items[0] as ListTrackSegmentItem).getTrackIndex()];
                        const segmentIndices = items.map((item) =>
                            (item as ListTrackSegmentItem).getSegmentIndex()
                        );
                        file.addElevation(elevations, trackIndices, segmentIndices, []);
                    } else if (level === ListLevel.WAYPOINTS) {
                        file.addElevation(elevations, [], [], undefined);
                    } else if (level === ListLevel.WAYPOINT) {
                        const waypointIndices = items.map((item) =>
                            (item as ListWaypointItem).getWaypointIndex()
                        );
                        file.addElevation(elevations, [], [], waypointIndices);
                    }
                }
            });
        });
    },
    clearElevationDataFromSelection: (): Promise<boolean> =>
        clearFromSelection((file, trackIndices, segmentIndices, waypointIndices) =>
            file.clearElevation(trackIndices, segmentIndices, waypointIndices)
        ),
    clearTimeDataFromSelection: (): Promise<boolean> =>
        clearFromSelection((file, trackIndices, segmentIndices, waypointIndices) =>
            file.clearTimestamps(trackIndices, segmentIndices, waypointIndices)
        ),
    deleteSelectedFiles: () => {
        if (get(selection).size === 0) {
            return;
        }
        fileActionManager.applyGlobal((draft) => {
            selection.applyToOrderedSelectedItemsFromFile((fileId) => {
                draft.delete(fileId);
            });
        });
    },
    deleteAllFiles: () => {
        fileActionManager.applyGlobal((draft) => {
            draft.clear();
        });
    },
};

export function pasteSelection() {
    const fromItems = get(copied);
    if (fromItems === undefined || fromItems.length === 0) {
        return;
    }

    let selected = get(selection).getSelected();
    if (selected.length === 0) {
        selected = [new ListRootItem()];
    }

    const fromParent = fromItems[0].getParent();
    let toParent = selected[selected.length - 1];

    let startIndex: number | undefined = undefined;

    if (fromItems[0].level === toParent.level) {
        if (
            toParent instanceof ListTrackItem ||
            toParent instanceof ListTrackSegmentItem ||
            toParent instanceof ListWaypointItem
        ) {
            startIndex = toParent.getId() + 1;
        }
        toParent = toParent.getParent();
    }

    const toItems: ListItem[] = [];
    if (toParent.level === ListLevel.ROOT) {
        const fileIds = getFileIds(fromItems.length);
        fileIds.forEach((fileId) => {
            toItems.push(new ListFileItem(fileId));
        });
    } else {
        const toFile = fileStateCollection.getFile(toParent.getFileId());
        if (toFile) {
            fromItems.forEach((item, index) => {
                if (toParent instanceof ListFileItem) {
                    if (item instanceof ListTrackItem || item instanceof ListTrackSegmentItem) {
                        toItems.push(
                            new ListTrackItem(
                                toParent.getFileId(),
                                (startIndex ?? toFile.trk.length) + index
                            )
                        );
                    } else if (item instanceof ListWaypointsItem) {
                        toItems.push(new ListWaypointsItem(toParent.getFileId()));
                    } else if (item instanceof ListWaypointItem) {
                        toItems.push(
                            new ListWaypointItem(
                                toParent.getFileId(),
                                (startIndex ?? toFile.wpt.length) + index
                            )
                        );
                    }
                } else if (toParent instanceof ListTrackItem) {
                    if (item instanceof ListTrackSegmentItem) {
                        const toTrackIndex = toParent.getTrackIndex();
                        toItems.push(
                            new ListTrackSegmentItem(
                                toParent.getFileId(),
                                toTrackIndex,
                                (startIndex ?? toFile.trk[toTrackIndex].trkseg.length) + index
                            )
                        );
                    }
                } else if (toParent instanceof ListWaypointsItem) {
                    if (item instanceof ListWaypointItem) {
                        toItems.push(
                            new ListWaypointItem(
                                toParent.getFileId(),
                                (startIndex ?? toFile.wpt.length) + index
                            )
                        );
                    }
                }
            });
        }
    }

    if (fromItems.length === toItems.length) {
        moveItems(fromParent, toParent, fromItems, toItems, get(cut));
        selection.resetCopied();
    }
}

export function moveItems(
    fromParent: ListItem,
    toParent: ListItem,
    fromItems: ListItem[],
    toItems: ListItem[],
    remove: boolean = true
) {
    if (fromItems.length === 0) {
        return;
    }

    sortItems(fromItems, false);
    sortItems(toItems, false);

    const context: (GPXFile | Track | TrackSegment | Waypoint[] | Waypoint)[] = [];
    fromItems.forEach((item) => {
        const file = fileStateCollection.getFile(item.getFileId());
        if (file) {
            if (item instanceof ListFileItem) {
                context.push(file.clone());
            } else if (item instanceof ListTrackItem && item.getTrackIndex() < file.trk.length) {
                context.push(file.trk[item.getTrackIndex()].clone());
            } else if (
                item instanceof ListTrackSegmentItem &&
                item.getTrackIndex() < file.trk.length &&
                item.getSegmentIndex() < file.trk[item.getTrackIndex()].trkseg.length
            ) {
                context.push(file.trk[item.getTrackIndex()].trkseg[item.getSegmentIndex()].clone());
            } else if (item instanceof ListWaypointsItem) {
                context.push(file.wpt.map((wpt) => wpt.clone()));
            } else if (
                item instanceof ListWaypointItem &&
                item.getWaypointIndex() < file.wpt.length
            ) {
                context.push(file.wpt[item.getWaypointIndex()].clone());
            }
        }
    });

    if (remove && !(fromParent instanceof ListRootItem)) {
        sortItems(fromItems, true);
    }

    let files = [fromParent.getFileId(), toParent.getFileId()];
    let callbacks = [
        (file: WritableDraft<GPXFile>) => {
            fromItems.forEach((item) => {
                if (item instanceof ListTrackItem) {
                    file.replaceTracks(item.getTrackIndex(), item.getTrackIndex(), []);
                } else if (item instanceof ListTrackSegmentItem) {
                    file.replaceTrackSegments(
                        item.getTrackIndex(),
                        item.getSegmentIndex(),
                        item.getSegmentIndex(),
                        []
                    );
                } else if (item instanceof ListWaypointsItem) {
                    file.replaceWaypoints(0, file.wpt.length - 1, []);
                } else if (item instanceof ListWaypointItem) {
                    file.replaceWaypoints(item.getWaypointIndex(), item.getWaypointIndex(), []);
                }
            });
        },
        (
            file: WritableDraft<GPXFile>,
            context: (GPXFile | Track | TrackSegment | Waypoint[] | Waypoint)[]
        ) => {
            toItems.forEach((item, i) => {
                if (item instanceof ListTrackItem) {
                    if (context[i] instanceof Track) {
                        file.replaceTracks(item.getTrackIndex(), item.getTrackIndex() - 1, [
                            context[i],
                        ]);
                    } else if (context[i] instanceof TrackSegment) {
                        file.replaceTracks(item.getTrackIndex(), item.getTrackIndex() - 1, [
                            new Track({
                                trkseg: [context[i]],
                            }),
                        ]);
                    }
                } else if (
                    item instanceof ListTrackSegmentItem &&
                    context[i] instanceof TrackSegment
                ) {
                    file.replaceTrackSegments(
                        item.getTrackIndex(),
                        item.getSegmentIndex(),
                        item.getSegmentIndex() - 1,
                        [context[i]]
                    );
                } else if (item instanceof ListWaypointsItem) {
                    if (
                        Array.isArray(context[i]) &&
                        context[i].length > 0 &&
                        context[i][0] instanceof Waypoint
                    ) {
                        file.replaceWaypoints(file.wpt.length, file.wpt.length - 1, context[i]);
                    } else if (context[i] instanceof Waypoint) {
                        file.replaceWaypoints(file.wpt.length, file.wpt.length - 1, [context[i]]);
                    }
                } else if (item instanceof ListWaypointItem && context[i] instanceof Waypoint) {
                    file.replaceWaypoints(item.getWaypointIndex(), item.getWaypointIndex() - 1, [
                        context[i],
                    ]);
                }
            });
        },
    ];

    if (fromParent instanceof ListRootItem) {
        files = [];
        callbacks = [];
    } else if (!remove) {
        files.splice(0, 1);
        callbacks.splice(0, 1);
    }

    fileActionManager.applyEachToFilesAndGlobal(
        files,
        callbacks,
        (files, context: (GPXFile | Track | TrackSegment | Waypoint[] | Waypoint)[]) => {
            toItems.forEach((item, i) => {
                if (item instanceof ListFileItem) {
                    if (context[i] instanceof GPXFile) {
                        const newFile = context[i];
                        if (remove) {
                            files.delete(newFile._data.id);
                        }
                        newFile._data.id = item.getFileId();
                        files.set(item.getFileId(), freeze(newFile));
                    } else if (context[i] instanceof Track) {
                        const newFile = newGPXFile();
                        newFile._data.id = item.getFileId();
                        if (context[i].name) {
                            newFile.metadata.name = context[i].name;
                        }
                        newFile.replaceTracks(0, 0, [context[i]]);
                        files.set(item.getFileId(), freeze(newFile));
                    } else if (context[i] instanceof TrackSegment) {
                        const newFile = newGPXFile();
                        newFile._data.id = item.getFileId();
                        newFile.replaceTracks(0, 0, [
                            new Track({
                                trkseg: [context[i]],
                            }),
                        ]);
                        files.set(item.getFileId(), freeze(newFile));
                    }
                }
            });
        },
        context
    );

    selection.set(toItems);
}
