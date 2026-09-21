import { distance, type Coordinates, TrackPoint, TrackSegment, Track, projectedPoint } from 'gpx';
import { get, type Readable } from 'svelte/store';
import { safeWritable } from '$lib/logic/safe-store';
import * as maplibregl from 'maplibre-gl';
import {
    type MapMouseEvent,
    type GeoJSONSource,
    type MapLayerMouseEvent,
    type MapLayerTouchEvent,
} from 'maplibre-gl';
import { route } from './routing';
import { toast } from 'svelte-sonner';
import {
    ListFileItem,
    ListTrackItem,
    ListTrackSegmentItem,
} from '$lib/components/file-list/file-list';
import { getClosestLinePoint, loadSVGIcon, type ClosestLinePointDetails } from '$lib/utils';
import type { GPXFileWithStatistics } from '$lib/logic/statistics-tree';
import { mapCursor, MapCursorState } from '$lib/logic/map-cursor';
import { settings } from '$lib/logic/settings';
import { selection } from '$lib/logic/selection';
import { currentTool, Tool } from '$lib/components/toolbar/tools';
import { streetViewEnabled } from '$lib/components/map/street-view-control/utils';
import { fileActionManager } from '$lib/logic/file-action-manager';
import { i18n } from '$lib/i18n.svelte';
import { map } from '$lib/components/map/map';
import { ANCHOR_LAYER_KEY } from '$lib/components/map/style';
import { MAX_ANCHOR_ZOOM, MIN_ANCHOR_ZOOM } from './simplify';

const { streetViewSource, routing } = settings;
export const canChangeStart = safeWritable(false, 'canChangeStart');
// The track point whose details AnchorInfoDialog shows, or null when the dialog is closed.
export const trackpointInfo = safeWritable<TrackPoint | null>(null, 'trackpointInfo');

type AnchorProperties = {
    trackIndex: number;
    segmentIndex: number;
    pointIndex: number;
    anchorIndex: number;
    minZoom: number;
};
type Anchor = GeoJSON.Feature<GeoJSON.Point, AnchorProperties>;

export class RoutingControls {
    active: boolean = false;
    fileId: string = '';
    file: Readable<GPXFileWithStatistics | undefined>;
    layers: Map<
        number,
        {
            id: string;
            anchors: GeoJSON.Feature<GeoJSON.Point, AnchorProperties>[];
        }
    > = new Map();
    anchors: GeoJSON.Feature<GeoJSON.Point, AnchorProperties>[] = [];
    popup: maplibregl.Popup;
    popupElement: HTMLElement;
    fileUnsubscribe: () => void = () => {};
    unsubscribes: (() => void)[] = [];

    updateControlsBinded: () => void = this.updateControls.bind(this);
    appendAnchorBinded: (e: MapMouseEvent) => void = this.appendAnchor.bind(this);
    addIntermediateAnchorBinded: (e: MapMouseEvent) => void = this.addIntermediateAnchor.bind(this);

    lastDraggedAnchorEventTime: number = 0;
    draggingStartingPosition: maplibregl.Point = new maplibregl.Point(0, 0);
    // The anchor the pointer went down on, kept as an object rather than as an index into
    // `this.anchors`: that array is rebuilt whenever the file changes, so an index captured here can
    // point at a different anchor — or at nothing — by the time the drag ends.
    private _pressedAnchor: Anchor | null = null;
    // Whether the pointer actually travelled between the last mousedown and its mouseup. A click or
    // contextmenu that follows a drag must be ignored, but only then: gating on a time window instead
    // used to swallow the menu of an anchor that was merely clicked right after a drag.
    private _dragged = false;
    private _cancelDragBinded: () => void = this.cancelDrag.bind(this);
    onMouseEnterBinded: () => void = this.onMouseEnter.bind(this);
    onMouseLeaveBinded: () => void = this.onMouseLeave.bind(this);
    onClickBinded: (e: MapLayerMouseEvent) => void = this.onClick.bind(this);
    onMouseDownBinded: (e: MapLayerMouseEvent) => void = this.onMouseDown.bind(this);
    onTouchStartBinded: (e: MapLayerTouchEvent) => void = this.onTouchStart.bind(this);
    onMouseUpBinded: (e: MapLayerMouseEvent | MapLayerTouchEvent) => void =
        this.onMouseUp.bind(this);

    temporaryAnchor: GeoJSON.Feature<GeoJSON.Point, AnchorProperties> | null = null;
    showTemporaryAnchorBinded: (e: MapLayerMouseEvent) => void =
        this.showTemporaryAnchor.bind(this);
    updateTemporaryAnchorBinded: (e: MapMouseEvent) => void = this.updateTemporaryAnchor.bind(this);

    constructor(
        fileId: string,
        file: Readable<GPXFileWithStatistics | undefined>,
        popup: maplibregl.Popup,
        popupElement: HTMLElement
    ) {
        this.fileId = fileId;
        this.file = file;
        for (let zoom = MIN_ANCHOR_ZOOM; zoom <= MAX_ANCHOR_ZOOM; zoom++) {
            this.layers.set(zoom, {
                id: `routing-controls-${this.fileId}-${zoom}`,
                anchors: [],
            });
        }
        this.popup = popup;
        this.popupElement = popupElement;

        this.unsubscribes.push(selection.subscribe(this.addIfNeeded.bind(this)));
        this.unsubscribes.push(currentTool.subscribe(this.addIfNeeded.bind(this)));
    }

    addIfNeeded() {
        const routing = get(currentTool) === Tool.ROUTING;
        if (!routing) {
            if (this.active) {
                this.remove();
            }
            return;
        }

        const selected = get(selection).hasAnyChildren(new ListFileItem(this.fileId), true, [
            'waypoints',
        ]);
        if (selected) {
            if (this.active) {
                this.updateControls();
            } else {
                this.add();
            }
        } else if (this.active) {
            this.remove();
        }
    }

    add() {
        const map_ = get(map);
        const layerEventManager = map.layerEventManager;
        if (!map_ || !layerEventManager) {
            return;
        }

        this.active = true;

        this.loadIcons();

        map_.on('style.load', this.updateControlsBinded);
        map_.on('click', this.appendAnchorBinded);
        layerEventManager.on('mousemove', this.fileId, this.showTemporaryAnchorBinded);
        layerEventManager.on('click', this.fileId, this.addIntermediateAnchorBinded);

        this.fileUnsubscribe = this.file.subscribe(this.updateControlsBinded);
    }

    updateControls() {
        const map_ = get(map);
        const layerEventManager = map.layerEventManager;
        const file = get(this.file)?.file;
        if (!map_ || !layerEventManager || !file) {
            return;
        }

        this.layers.forEach((layer) => (layer.anchors = []));
        this.anchors = [];

        file.forEachSegment((segment, trackIndex, segmentIndex) => {
            if (
                get(selection).hasAnyParent(
                    new ListTrackSegmentItem(this.fileId, trackIndex, segmentIndex)
                )
            ) {
                for (let i = 0; i < segment.trkpt.length; i++) {
                    const point = segment.trkpt[i];
                    if (point._data.anchor) {
                        const anchor: Anchor = {
                            type: 'Feature',
                            geometry: {
                                type: 'Point',
                                coordinates: [point.getLongitude(), point.getLatitude()],
                            },
                            properties: {
                                trackIndex: trackIndex,
                                segmentIndex: segmentIndex,
                                pointIndex: i,
                                anchorIndex: this.anchors.length,
                                minZoom: point._data.zoom,
                            },
                        };
                        this.layers.get(point._data.zoom)?.anchors.push(anchor);
                        this.anchors.push(anchor);
                    }
                }
            }
        });

        this.layers.forEach((layer, zoom) => {
            try {
                const source = map_.getSource(layer.id) as maplibregl.GeoJSONSource | undefined;
                if (source) {
                    source.setData({
                        type: 'FeatureCollection',
                        features: layer.anchors,
                    });
                } else {
                    map_.addSource(layer.id, {
                        type: 'geojson',
                        data: {
                            type: 'FeatureCollection',
                            features: layer.anchors,
                        },
                        promoteId: 'anchorIndex',
                    });
                }

                if (!map_.getLayer(layer.id)) {
                    map_.addLayer(
                        {
                            id: layer.id,
                            type: 'symbol',
                            source: layer.id,
                            layout: {
                                'icon-image': 'routing-control',
                                'icon-size': 0.25,
                                'icon-padding': 0,
                                'icon-allow-overlap': true,
                            },
                            minzoom: zoom,
                        },
                        ANCHOR_LAYER_KEY.routingControls
                    );

                    layerEventManager.on('mouseenter', layer.id, this.onMouseEnterBinded);
                    layerEventManager.on('mouseleave', layer.id, this.onMouseLeaveBinded);
                    layerEventManager.on('click', layer.id, this.onClickBinded);
                    layerEventManager.on('contextmenu', layer.id, this.onClickBinded);
                    layerEventManager.on('mousedown', layer.id, this.onMouseDownBinded);
                    layerEventManager.on('touchstart', layer.id, this.onTouchStartBinded);
                }
            } catch {
                // No reliable way to check if the map is ready to add sources and layers
                return;
            }
        });
    }

    // Rebuild an anchor from the layer feature that was clicked. The feature is the only trustworthy
    // source of identity: `this.anchors` is rebuilt on every file change, while a feature queried
    // from the map — or one captured by an already open popup — can be a few edits old.
    resolveAnchor(feature: GeoJSON.Feature | undefined): Anchor | null {
        const properties = feature?.properties as AnchorProperties | undefined;
        if (!properties) {
            return null;
        }

        const point = get(this.file)?.file?.trk[properties.trackIndex]?.trkseg[
            properties.segmentIndex
        ]?.trkpt[properties.pointIndex];
        if (!point) {
            // The track point was removed (or the file reloaded) since the layer was drawn.
            return null;
        }

        return {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [point.getLongitude(), point.getLatitude()],
            },
            properties: {
                ...properties,
                // Prefer the zoom the feature was drawn at, so the geometry update below lands in the
                // very source the marker came from.
                minZoom: properties.minZoom ?? point._data.zoom ?? MIN_ANCHOR_ZOOM,
            },
        };
    }

    remove() {
        const map_ = get(map);
        const layerEventManager = map.layerEventManager;

        this.active = false;

        this.cancelDrag();

        map_?.off('style.load', this.updateControlsBinded);
        map_?.off('click', this.appendAnchorBinded);
        layerEventManager?.off('mousemove', this.fileId, this.showTemporaryAnchorBinded);
        layerEventManager?.off('click', this.fileId, this.addIntermediateAnchorBinded);
        map_?.off('mousemove', this.updateTemporaryAnchorBinded);

        this.layers.forEach((layer) => {
            try {
                layerEventManager?.off('mouseenter', layer.id, this.onMouseEnterBinded);
                layerEventManager?.off('mouseleave', layer.id, this.onMouseLeaveBinded);
                layerEventManager?.off('click', layer.id, this.onClickBinded);
                layerEventManager?.off('contextmenu', layer.id, this.onClickBinded);
                layerEventManager?.off('mousedown', layer.id, this.onMouseDownBinded);
                layerEventManager?.off('touchstart', layer.id, this.onTouchStartBinded);

                if (map_?.getLayer(layer.id)) {
                    map_?.removeLayer(layer.id);
                }

                if (map_?.getSource(layer.id)) {
                    map_?.removeSource(layer.id);
                }
            } catch {
                // No reliable way to check if the map is ready to remove sources and layers
            }
        });

        this.popup.remove();

        this.fileUnsubscribe();
    }

    async moveAnchor(anchor: Anchor, coordinates: Coordinates) {
        // Move the anchor and update the route from and to the neighbouring anchors
        if (anchor === this.temporaryAnchor) {
            // Temporary anchor, need to find the closest point of the segment and create an anchor for it
            anchor = this.getPermanentAnchor(this.temporaryAnchor);
            this.removeTemporaryAnchor();
        }
        const file = get(this.file)?.file;
        if (!file) {
            return;
        }

        const segment = file.getSegment(
            anchor.properties.trackIndex,
            anchor.properties.segmentIndex
        );
        const anchorPoint = segment?.trkpt[anchor.properties.pointIndex];
        if (!anchorPoint) {
            // The segment was edited between the popup/marker being built and this call.
            return;
        }
        const initialAnchorCoordinates = anchorPoint.getCoordinates();

        const [previousAnchor, nextAnchor] = this.getNeighbouringAnchors(anchor);

        const anchors = [];
        const targetTrackpoints = [];

        if (previousAnchor !== null) {
            anchors.push(previousAnchor);
            targetTrackpoints.push(segment.trkpt[previousAnchor.properties.pointIndex]);
        }

        anchors.push(anchor);
        targetTrackpoints.push(
            new TrackPoint({
                attributes: coordinates,
            })
        );

        if (nextAnchor !== null) {
            anchors.push(nextAnchor);
            targetTrackpoints.push(segment.trkpt[nextAnchor.properties.pointIndex]);
        }

        try {
            const success = await this.routeBetweenAnchors(anchors, targetTrackpoints);
            if (!success) {
                // Route failed, revert the marker to the previous position
                this.moveAnchorFeature(anchor, initialAnchorCoordinates);
            }
        } catch (error) {
            // The marker was moved to the pointer position while dragging; put it back, then let the
            // caller's `.catch` report the failure. Swallowing it here would leave the map showing a
            // position the file does not have.
            this.moveAnchorFeature(anchor, initialAnchorCoordinates);
            throw error;
        }
    }

    getPermanentAnchor(anchor: Anchor): Anchor {
        const file = get(this.file)?.file;
        if (!file) {
            return anchor;
        }
        const segment = file.getSegment(
            anchor.properties.trackIndex,
            anchor.properties.segmentIndex
        );
        // Find the point closest to the temporary anchor
        const anchorPoint = new TrackPoint({
            attributes: {
                lon: anchor.geometry.coordinates[0],
                lat: anchor.geometry.coordinates[1],
            },
        });
        const details: ClosestLinePointDetails = {};
        const closest = getClosestLinePoint(segment.trkpt, anchorPoint, details);

        const permanentAnchor: Anchor = {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [closest.getLongitude(), closest.getLatitude()],
            },
            properties: {
                trackIndex: anchor.properties.trackIndex,
                segmentIndex: anchor.properties.segmentIndex,
                pointIndex: closest._data.index,
                anchorIndex: this.anchors.length,
                minZoom: 0,
            },
        };

        return permanentAnchor;
    }

    turnIntoPermanentAnchor() {
        const file = get(this.file)?.file;
        if (!file || !this.temporaryAnchor) {
            return;
        }
        const segment = file.getSegment(
            this.temporaryAnchor.properties.trackIndex,
            this.temporaryAnchor.properties.segmentIndex
        );
        // Find the point closest to the temporary anchor
        const anchorPoint = new TrackPoint({
            attributes: {
                lon: this.temporaryAnchor.geometry.coordinates[0],
                lat: this.temporaryAnchor.geometry.coordinates[1],
            },
        });
        const details: ClosestLinePointDetails = {};
        getClosestLinePoint(segment.trkpt, anchorPoint, details);

        // getClosestLinePoint always fills `index` here: the caller only reaches this branch for a
        // segment that has at least two track points. The assertions keep the arithmetic as-is.
        const before = details.before ? details.index! : details.index! - 1;

        const projectedPt = projectedPoint(
            segment.trkpt[before],
            segment.trkpt[before + 1],
            anchorPoint
        );
        const ratio =
            distance(segment.trkpt[before], projectedPt) /
            distance(segment.trkpt[before], segment.trkpt[before + 1]);

        const point = segment.trkpt[before].clone();
        point.setCoordinates(projectedPt);
        point.ele =
            (1 - ratio) * (segment.trkpt[before].ele ?? 0) +
            ratio * (segment.trkpt[before + 1].ele ?? 0);
        point.time =
            segment.trkpt[before].time && segment.trkpt[before + 1].time
                ? new Date(
                      (1 - ratio) * segment.trkpt[before].time.getTime() +
                          ratio * segment.trkpt[before + 1].time!.getTime()
                  )
                : undefined;
        point._data = {
            anchor: true,
            zoom: 0,
        };

        const trackIndex = this.temporaryAnchor!.properties.trackIndex;
        const segmentIndex = this.temporaryAnchor!.properties.segmentIndex;
        fileActionManager.applyToFile(this.fileId, (file) =>
            file.replaceTrackPoints(trackIndex, segmentIndex, before + 1, before, [point])
        );

        this.temporaryAnchor = null;
    }

    getDeleteAnchor(anchor: Anchor) {
        return () => this.deleteAnchor(anchor);
    }

    async deleteAnchor(anchor: Anchor) {
        this.popup.remove();

        if (!this.resolveAnchor(anchor)) {
            // The popup was left open across an edit that removed this point; nothing left to delete.
            return;
        }

        const [previousAnchor, nextAnchor] = this.getNeighbouringAnchors(anchor);

        if (previousAnchor === null && nextAnchor === null) {
            // Only one point, remove it
            fileActionManager.applyToFile(this.fileId, (file) =>
                file.replaceTrackPoints(
                    anchor.properties.trackIndex,
                    anchor.properties.segmentIndex,
                    0,
                    0,
                    []
                )
            );
        } else if (previousAnchor === null && nextAnchor !== null) {
            // First point, remove trackpoints until nextAnchor
            fileActionManager.applyToFile(this.fileId, (file) =>
                file.replaceTrackPoints(
                    anchor.properties.trackIndex,
                    anchor.properties.segmentIndex,
                    0,
                    nextAnchor.properties.pointIndex - 1,
                    []
                )
            );
        } else if (nextAnchor === null && previousAnchor !== null) {
            // Last point, remove trackpoints from previousAnchor
            fileActionManager.applyToFile(this.fileId, (file) => {
                const segment = file.getSegment(
                    anchor.properties.trackIndex,
                    anchor.properties.segmentIndex
                );
                file.replaceTrackPoints(
                    anchor.properties.trackIndex,
                    anchor.properties.segmentIndex,
                    previousAnchor.properties.pointIndex + 1,
                    segment.trkpt.length - 1,
                    []
                );
            });
        } else if (previousAnchor !== null && nextAnchor !== null) {
            // The two neighbours are track points differing by one index, so the point between them
            // is the one being deleted, and removing it leaves the neighbours to connect directly.
            // This is also what a re-route would produce here anyway — the segment is too short to
            // follow anything but a straight line.
            const neighboursAdjacent =
                nextAnchor.properties.pointIndex - previousAnchor.properties.pointIndex === 2;

            if (neighboursAdjacent || !get(routing)) {
                // Connect the neighbours directly. Re-routing here is not an option: the router
                // would return the point that is being deleted (it lies on the road), so "delete"
                // would re-create it and the point could never be removed.
                this.replaceSpanWithConnection(anchor, previousAnchor, nextAnchor);
            } else {
                const file = get(this.file)?.file;
                if (!file) {
                    return;
                }
                const segment = file.getSegment(
                    anchor.properties.trackIndex,
                    anchor.properties.segmentIndex
                );
                await this.routeBetweenAnchors(
                    [previousAnchor, nextAnchor],
                    [
                        segment.trkpt[previousAnchor.properties.pointIndex],
                        segment.trkpt[nextAnchor.properties.pointIndex],
                    ]
                );
            }
        }
    }

    // Drop every track point between two neighbouring anchors, so that the two are left adjacent.
    // The points are removed rather than re-supplied to `replaceTrackPoints`: a point read from the
    // draft cannot be written back into it — the draft is finalized (and its proxy revoked) when the
    // producer returns, and a patch value holding a revoked proxy cannot be persisted, which fails
    // the whole mutation.
    private replaceSpanWithConnection(anchor: Anchor, previousAnchor: Anchor, nextAnchor: Anchor) {
        const trackIndex = anchor.properties.trackIndex;
        const segmentIndex = anchor.properties.segmentIndex;
        const previousPointIndex = previousAnchor.properties.pointIndex;
        const nextPointIndex = nextAnchor.properties.pointIndex;
        if (nextPointIndex - previousPointIndex < 2) {
            // The anchors are not distinct, adjacent points: nothing lies between them.
            return;
        }

        fileActionManager.applyToFile(this.fileId, (file) => {
            const segment = file.trk[trackIndex]?.trkseg[segmentIndex];
            if (!segment || segment.trkpt.length <= nextPointIndex) {
                // The segment changed since the anchors were resolved; leave it untouched rather
                // than splicing at a stale index.
                return;
            }
            file.replaceTrackPoints(
                trackIndex,
                segmentIndex,
                previousPointIndex + 1,
                nextPointIndex - 1,
                []
            );
        });
    }

    getStartLoopAtAnchor(anchor: Anchor) {
        return () => this.startLoopAtAnchor(anchor);
    }

    startLoopAtAnchor(anchor: Anchor) {
        this.popup.remove();

        const fileWithStats = get(this.file);
        if (!fileWithStats) {
            return;
        }

        const speed = fileWithStats.statistics.getStatisticsFor(
            new ListTrackSegmentItem(
                this.fileId,
                anchor.properties.trackIndex,
                anchor.properties.segmentIndex
            )
        ).global.speed.moving;

        const segment = fileWithStats.file.getSegment(
            anchor.properties.trackIndex,
            anchor.properties.segmentIndex
        );
        fileActionManager.applyToFile(this.fileId, (file) => {
            file.replaceTrackPoints(
                anchor.properties.trackIndex,
                anchor.properties.segmentIndex,
                segment.trkpt.length,
                segment.trkpt.length - 1,
                segment.trkpt.slice(0, anchor.properties.pointIndex),
                speed > 0 ? speed : undefined
            );
            file.crop(
                anchor.properties.pointIndex,
                anchor.properties.pointIndex + segment.trkpt.length - 1,
                [anchor.properties.trackIndex],
                [anchor.properties.segmentIndex]
            );
        });
    }

    getShowTrackpointInfo(anchor: Anchor) {
        return () => this.showTrackpointInfo(anchor);
    }

    showTrackpointInfo(anchor: Anchor) {
        // Guarded indexed access rather than file.getSegment(): getSegment has no bounds check and
        // throws if the segment was removed between opening the popup and clicking the button.
        const point = get(this.file)?.file?.trk[anchor.properties.trackIndex]?.trkseg[
            anchor.properties.segmentIndex
        ]?.trkpt[anchor.properties.pointIndex];
        if (!point) {
            return;
        }

        trackpointInfo.set(point);
        // Close the menu so it does not linger underneath the dialog.
        this.popup.remove();
    }

    async appendAnchor(e: maplibregl.MapMouseEvent) {
        // Add a new anchor to the end of the last segment
        if (get(streetViewEnabled) && get(streetViewSource) === 'google') {
            return;
        }
        if (this._pressedAnchor !== null || Date.now() - this.lastDraggedAnchorEventTime < 100) {
            // Exit while an anchor is being dragged, or right after one was dropped: the map click
            // that ends a drag must not also append a new anchor at the release position.
            return;
        }
        if (
            e.target.queryRenderedFeatures(e.point, {
                layers: [this.fileId, ...[...this.layers.values()].map((layer) => layer.id)],
            }).length
        ) {
            // Clicked on routing control or layer, ignoring
            return;
        }
        this.appendAnchorWithCoordinates({
            lat: e.lngLat.lat,
            lon: e.lngLat.lng,
        });
    }

    async appendAnchorWithCoordinates(coordinates: Coordinates) {
        // Add a new anchor to the end of the last segment
        const newAnchorPoint = new TrackPoint({
            attributes: coordinates,
        });

        if (this.anchors.length == 0) {
            this.routeBetweenAnchors(
                [
                    {
                        type: 'Feature',
                        geometry: {
                            type: 'Point',
                            coordinates: [
                                newAnchorPoint.getLongitude(),
                                newAnchorPoint.getLatitude(),
                            ],
                        },
                        properties: {
                            trackIndex: 0,
                            segmentIndex: 0,
                            pointIndex: 0,
                            anchorIndex: 0,
                            minZoom: 0,
                        },
                    },
                ],
                [newAnchorPoint]
            );
            return;
        }

        const lastAnchor = this.anchors[this.anchors.length - 1];

        const file = get(this.file)?.file;
        if (!file) {
            return;
        }

        const segment = file.getSegment(
            lastAnchor.properties.trackIndex,
            lastAnchor.properties.segmentIndex
        );
        const lastAnchorPoint = segment.trkpt[lastAnchor.properties.pointIndex];

        const newAnchor: Anchor = {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [newAnchorPoint.getLongitude(), newAnchorPoint.getLatitude()],
            },
            properties: {
                trackIndex: lastAnchor.properties.trackIndex,
                segmentIndex: lastAnchor.properties.segmentIndex,
                pointIndex: segment.trkpt.length - 1, // Do as if the point was the last point in the segment
                anchorIndex: 0,
                minZoom: 0,
            },
        };

        await this.routeBetweenAnchors([lastAnchor, newAnchor], [lastAnchorPoint, newAnchorPoint]);
    }

    addIntermediateAnchor(e: maplibregl.MapMouseEvent) {
        e.preventDefault();

        if (this.temporaryAnchor !== null) {
            this.turnIntoPermanentAnchor();
            return;
        }
    }

    getNeighbouringAnchors(anchor: Anchor): [Anchor | null, Anchor | null] {
        let previousAnchor: Anchor | null = null;
        let nextAnchor: Anchor | null = null;

        const zoom = get(map)?.getZoom() ?? 20;

        for (let i = 0; i < this.anchors.length; i++) {
            if (
                this.anchors[i].properties.trackIndex === anchor.properties.trackIndex &&
                this.anchors[i].properties.segmentIndex === anchor.properties.segmentIndex &&
                zoom >= this.anchors[i].properties.minZoom
            ) {
                if (this.anchors[i].properties.pointIndex < anchor.properties.pointIndex) {
                    if (
                        !previousAnchor ||
                        this.anchors[i].properties.pointIndex > previousAnchor.properties.pointIndex
                    ) {
                        previousAnchor = this.anchors[i];
                    }
                } else if (this.anchors[i].properties.pointIndex > anchor.properties.pointIndex) {
                    if (
                        !nextAnchor ||
                        this.anchors[i].properties.pointIndex < nextAnchor.properties.pointIndex
                    ) {
                        nextAnchor = this.anchors[i];
                    }
                }
            }
        }

        return [previousAnchor, nextAnchor];
    }

    async routeBetweenAnchors(
        anchors: Anchor[],
        targetTrackPoints: TrackPoint[]
    ): Promise<boolean> {
        const fileWithStats = get(this.file);
        if (!fileWithStats) {
            return false;
        }

        if (anchors.length <= 1) {
            // Only one anchor, update the point in the segment
            targetTrackPoints[0]._data.anchor = true;
            targetTrackPoints[0]._data.zoom = 0;
            const selected = selection.getOrderedSelection();
            if (
                selected.length === 0 ||
                selected[selected.length - 1].getFileId() !== this.fileId
            ) {
                return false;
            }
            const item = selected[selected.length - 1];
            fileActionManager.applyToFile(this.fileId, (file) => {
                let trackIndex = file.trk.length > 0 ? file.trk.length - 1 : 0;
                if (item instanceof ListTrackItem || item instanceof ListTrackSegmentItem) {
                    trackIndex = item.getTrackIndex();
                }
                let segmentIndex =
                    file.trk.length > 0 && file.trk[trackIndex].trkseg.length > 0
                        ? file.trk[trackIndex].trkseg.length - 1
                        : 0;
                if (item instanceof ListTrackSegmentItem) {
                    segmentIndex = item.getSegmentIndex();
                }
                if (file.trk.length === 0) {
                    const track = new Track();
                    track.replaceTrackPoints(0, 0, 0, targetTrackPoints);
                    file.replaceTracks(0, 0, [track]);
                } else if (file.trk[trackIndex].trkseg.length === 0) {
                    const segment = new TrackSegment();
                    segment.replaceTrackPoints(0, 0, targetTrackPoints);
                    file.replaceTrackSegments(trackIndex, 0, 0, [segment]);
                } else {
                    file.replaceTrackPoints(trackIndex, segmentIndex, 0, 0, targetTrackPoints);
                }
            });
            return true;
        }

        let response: TrackPoint[];
        try {
            response = await route(targetTrackPoints.map((trkpt) => trkpt.getCoordinates()));
        } catch (e) {
            toast.error(i18n._((e as Error).message, (e as Error).message));
            return false;
        }

        // The producer below runs after this method returns, by which time the draft has been
        // finalized and its proxies revoked. A point read from the draft would then be a revoked
        // proxy, and writing one into the file fails the whole mutation, so clone the points here
        // while they are still readable.
        const firstTargetPoint = targetTrackPoints[0].clone();
        const lastTargetPoint = targetTrackPoints[anchors.length - 1].clone();

        const segment = fileWithStats.file.getSegment(
            anchors[0].properties.trackIndex,
            anchors[0].properties.segmentIndex
        );

        if (
            anchors[0].properties.pointIndex !== 0 &&
            (anchors[0].properties.pointIndex !== segment.trkpt.length - 1 ||
                distance(firstTargetPoint.getCoordinates(), response[0].getCoordinates()) > 1)
        ) {
            response.splice(0, 0, firstTargetPoint); // Keep the current first anchor
        }

        if (anchors[anchors.length - 1].properties.pointIndex !== segment.trkpt.length - 1) {
            response.push(lastTargetPoint); // Keep the current last anchor
        }

        const anchorTrackPoints = [response[0], response[response.length - 1]];
        for (let i = 1; i < anchors.length - 1; i++) {
            // Find the closest point to the intermediate anchor, which will become an anchor
            anchorTrackPoints.push(
                getClosestLinePoint(response.slice(1, -1), targetTrackPoints[i])
            );
        }

        response.forEach((trkpt) => {
            // Turn all routed points into anchors, visible from the highest zoom level
            trkpt._data.anchor = true;
            trkpt._data.zoom = MAX_ANCHOR_ZOOM;
        });
        anchorTrackPoints.forEach((trkpt) => {
            // Turn them into permanent anchors, always visible
            trkpt._data.anchor = true;
            trkpt._data.zoom = 0;
        });

        const stats = fileWithStats.statistics.getStatisticsFor(
            new ListTrackSegmentItem(
                this.fileId,
                anchors[0].properties.trackIndex,
                anchors[0].properties.segmentIndex
            )
        );
        let speed: number | undefined = undefined;
        let startTime = segment.trkpt[anchors[0].properties.pointIndex].time;

        if (stats.global.speed.moving > 0) {
            let replacingDistance = 0;
            for (let i = 1; i < response.length; i++) {
                replacingDistance +=
                    distance(response[i - 1].getCoordinates(), response[i].getCoordinates()) / 1000;
            }
            const startAnchorStats = stats.getTrackPoint(anchors[0].properties.pointIndex)!;
            const endAnchorStats = stats.getTrackPoint(
                anchors[anchors.length - 1].properties.pointIndex
            )!;

            const replacedDistance =
                endAnchorStats.distance.moving - startAnchorStats.distance.moving;

            const newDistance = stats.global.distance.moving + replacingDistance - replacedDistance;
            const newTime = (newDistance / stats.global.speed.moving) * 3600;

            const remainingTime =
                stats.global.time.moving -
                (endAnchorStats.time.moving - startAnchorStats.time.moving);
            let replacingTime = newTime - remainingTime;

            if (replacingTime <= 0) {
                // Fallback to simple time difference
                replacingTime = endAnchorStats.time.total - startAnchorStats.time.total;
            }

            speed = (replacingDistance / replacingTime) * 3600;

            if (startTime === undefined) {
                // Replacing the first point
                const endIndex = anchors[anchors.length - 1].properties.pointIndex;
                startTime = new Date(
                    (segment.trkpt[endIndex].time?.getTime() ?? 0) -
                        (replacingTime + endAnchorStats.time.total - endAnchorStats.time.moving) *
                            1000
                );
            }
        }

        fileActionManager.applyToFile(this.fileId, (file) =>
            file.replaceTrackPoints(
                anchors[0].properties.trackIndex,
                anchors[0].properties.segmentIndex,
                anchors[0].properties.pointIndex,
                anchors[anchors.length - 1].properties.pointIndex,
                response,
                speed,
                startTime
            )
        );

        return true;
    }

    destroy() {
        this.remove();
        this.unsubscribes.forEach((unsubscribe) => unsubscribe());
    }

    loadIcons() {
        const _map = get(map);
        if (!_map) {
            return;
        }

        loadSVGIcon(
            _map,
            'routing-control',
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                <circle cx="10" cy="10" r="8" fill="white" stroke="black" stroke-width="2" />
            </svg>`,
            _map.getCanvasContainer().offsetWidth > 1000 ? 56 : 80
        );
    }

    onMouseEnter() {
        mapCursor.notify(MapCursorState.ANCHOR_HOVER, true);
    }

    onMouseLeave() {
        // A drag whose release is missed (pointer released outside the canvas, window blur) would
        // otherwise keep `dragPan` disabled and the whole layer unresponsive.
        if (this._pressedAnchor !== null) {
            this.cancelDrag();
        }
        if (this.temporaryAnchor !== null) {
            return;
        }
        mapCursor.notify(MapCursorState.ANCHOR_HOVER, false);
    }

    onClick(e: MapLayerMouseEvent) {
        e.preventDefault();

        if (this._dragged || Date.now() - this.lastDraggedAnchorEventTime < 100) {
            // Exit if the anchor was just dragged: this click (or contextmenu) is the tail of that
            // gesture, not a fresh request for the popup.
            return;
        }

        const anchor = this.resolveAnchor(e.features![0]);
        if (!anchor) {
            return;
        }
        if (e.originalEvent.shiftKey) {
            this.deleteAnchor(anchor);
            return;
        }

        canChangeStart.update(() => {
            if (anchor.properties.pointIndex === 0) {
                return false;
            }
            const segment = get(this.file)?.file.getSegment(
                anchor.properties.trackIndex,
                anchor.properties.segmentIndex
            );
            if (
                !segment ||
                distance(
                    segment.trkpt[0].getCoordinates(),
                    segment.trkpt[segment.trkpt.length - 1].getCoordinates()
                ) > 1000
            ) {
                return false;
            }
            return true;
        });

        this.popup.setLngLat(e.lngLat);
        this.popup.addTo(e.target);

        const deleteThisAnchor = this.getDeleteAnchor(anchor);
        this.popupElement.addEventListener('delete', deleteThisAnchor); // Register the delete event for this anchor
        const startLoopAtThisAnchor = this.getStartLoopAtAnchor(anchor);
        this.popupElement.addEventListener('change-start', startLoopAtThisAnchor); // Register the start loop event for this anchor
        const showTrackpointInfo = this.getShowTrackpointInfo(anchor);
        this.popupElement.addEventListener('show-info', showTrackpointInfo); // Register the show info event for this anchor
        this.popup.once('close', () => {
            this.popupElement.removeEventListener('delete', deleteThisAnchor);
            this.popupElement.removeEventListener('change-start', startLoopAtThisAnchor);
            this.popupElement.removeEventListener('show-info', showTrackpointInfo);
        });
    }

    onMouseDown(e: MapLayerMouseEvent) {
        const _map = get(map);
        if (!_map) {
            return;
        }

        e.preventDefault();
        // Block the map pan for the duration of the gesture, otherwise it moves with the anchor.
        _map.dragPan.disable();

        this.startDrag(e.features![0], e.point);
        if (this._pressedAnchor === null) {
            // The feature has no resolvable track point anymore (stale layer data), ignore the press
            // rather than leaving the state machine half-armed.
            _map.dragPan.enable();
            return;
        }

        _map.once('mouseup', this.onMouseUpBinded);
        this.addDragListeners();
    }

    onTouchStart(e: MapLayerTouchEvent) {
        if (e.points.length !== 1) {
            return;
        }
        const _map = get(map);
        if (!_map) {
            return;
        }

        e.preventDefault();
        _map.dragPan.disable();

        this.startDrag(e.features![0], e.point);
        if (this._pressedAnchor === null) {
            _map.dragPan.enable();
            return;
        }

        _map.once('touchend', this.onMouseUpBinded);
        this.addDragListeners();
    }

    // Record the pressed anchor. Dragging does not change its `pointIndex` while the pointer is down
    // (the file is only written on release), so it keeps identifying the right track point until
    // `onMouseUp`. The temporary hover marker is identified by its `anchorIndex`, which is one past
    // the last real anchor.
    private startDrag(feature: GeoJSON.Feature | undefined, point: maplibregl.Point) {
        const anchor =
            (feature?.properties as AnchorProperties | undefined)?.anchorIndex ===
            this.anchors.length
                ? this.temporaryAnchor
                : this.resolveAnchor(feature);
        if (!anchor) {
            return;
        }
        this._pressedAnchor = anchor;
        this._dragged = false;
        this.draggingStartingPosition = point;
    }

    // Grab the pointer for the whole gesture. These are DOM listeners on the map container rather
    // than map events: `MapLayerEventManager._handleMouseMove` deliberately returns early while a
    // button is held (`originalEvent.buttons > 0`, so that hovering does no hit-testing during a
    // pan), which means a map `mousemove` never fires between mousedown and mouseup — the drag would
    // receive no movement at all. The container also still gets the event when the pointer leaves the
    // canvas, and the window-level listeners catch a release that happens outside it.
    private addDragListeners() {
        const container = get(map)?.getCanvasContainer();
        container?.addEventListener('mousemove', this.onDragMoveBinded);
        container?.addEventListener('touchmove', this.onDragMoveBinded, { passive: false });
        window.addEventListener('mouseup', this._cancelDragBinded);
        window.addEventListener('touchend', this._cancelDragBinded);
        window.addEventListener('touchcancel', this._cancelDragBinded);
    }

    private removeDragListeners() {
        const container = get(map)?.getCanvasContainer();
        container?.removeEventListener('mousemove', this.onDragMoveBinded);
        container?.removeEventListener('touchmove', this.onDragMoveBinded);
        window.removeEventListener('mouseup', this._cancelDragBinded);
        window.removeEventListener('touchend', this._cancelDragBinded);
        window.removeEventListener('touchcancel', this._cancelDragBinded);
    }

    // End whatever drag is in flight without touching the file. Safe to call at any time.
    cancelDrag() {
        this.removeDragListeners();

        get(map)?.dragPan.enable();

        if (this._pressedAnchor !== null) {
            mapCursor.notify(MapCursorState.ANCHOR_DRAGGING, false);
        }
        this._pressedAnchor = null;
        this._dragged = false;
    }

    private onDragMoveBinded = (e: MouseEvent | TouchEvent) => {
        const _map = get(map);
        if (!_map) {
            return;
        }
        // A mouse event whose button is no longer down means the release was missed (window blur, or
        // a release outside both the container and the window listener's reach) — end the drag.
        if (e.type === 'mousemove' && (e as MouseEvent).buttons === 0) {
            this.cancelDrag();
            return;
        }

        const touch = 'touches' in e ? e.touches[0] : undefined;
        const point = touch
            ? new maplibregl.Point(touch.clientX, touch.clientY)
            : new maplibregl.Point((e as MouseEvent).clientX, (e as MouseEvent).clientY);
        const rect = _map.getCanvas().getBoundingClientRect();
        point.x -= rect.left;
        point.y -= rect.top;

        this.dragTo(point, _map.unproject(point));
    };

    private dragTo(point: maplibregl.Point, lngLat: { lat: number; lng: number }) {
        if (this._pressedAnchor === null) {
            return;
        }
        if (point.equals(this.draggingStartingPosition)) {
            return;
        }

        this._dragged = true;
        mapCursor.notify(MapCursorState.ANCHOR_DRAGGING, true);

        this.moveAnchorFeature(this._pressedAnchor, {
            lat: lngLat.lat,
            lon: lngLat.lng,
        });
    }

    onMouseUp(e: MapLayerMouseEvent | MapLayerTouchEvent) {
        mapCursor.notify(MapCursorState.ANCHOR_DRAGGING, false);

        const _map = get(map);
        if (!_map) {
            return;
        }

        const pressedAnchor = this._pressedAnchor;
        const dragged = this._dragged;

        // Free the state machine before anything asynchronous runs: `moveAnchor` awaits the routing
        // request, and while it is pending every click and contextmenu on the layer is ignored.
        // Leaving the flag set on an early return is what used to make anchors unresponsive.
        this.removeDragListeners();
        this._pressedAnchor = null;
        this._dragged = false;
        this.draggingStartingPosition = e.point;

        _map.dragPan.enable();

        if (pressedAnchor === null || !dragged) {
            return;
        }

        this.lastDraggedAnchorEventTime = Date.now();
        this.moveAnchor(pressedAnchor, {
            lat: e.lngLat.lat,
            lon: e.lngLat.lng,
        }).catch((error) => {
            // `routeBetweenAnchors` already reported a routing failure through its own toast; this
            // only catches the unexpected (e.g. the segment disappearing mid-drag).
            console.error('Failed to move the anchor point:', error);
            toast.error(i18n._((error as Error).message, (error as Error).message));
        });
    }

    showTemporaryAnchor(e: MapLayerMouseEvent) {
        const map_ = get(map);
        if (!map_) {
            return;
        }

        if (this._pressedAnchor !== null) {
            // Do not not change the source point if it is already being dragged
            return;
        }

        if (get(streetViewEnabled)) {
            return;
        }

        if (
            !get(selection).hasAnyParent(
                new ListTrackSegmentItem(
                    this.fileId,
                    e.features![0].properties.trackIndex,
                    e.features![0].properties.segmentIndex
                )
            )
        ) {
            return;
        }

        if (this.temporaryAnchorCloseToOtherAnchor(e)) {
            return;
        }

        this.temporaryAnchor = {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [e.lngLat.lng, e.lngLat.lat],
            },
            properties: {
                trackIndex: e.features![0].properties.trackIndex,
                segmentIndex: e.features![0].properties.segmentIndex,
                pointIndex: 0,
                anchorIndex: this.anchors.length,
                minZoom: 0,
            },
        };

        this.addTemporaryAnchor();
        mapCursor.notify(MapCursorState.ANCHOR_HOVER, true);

        map_.on('mousemove', this.updateTemporaryAnchorBinded);
    }

    updateTemporaryAnchor(e: MapMouseEvent) {
        const map_ = get(map);
        if (!map_ || !this.temporaryAnchor) {
            return;
        }

        if (this._pressedAnchor !== null) {
            // Do not hide if it is being dragged, and stop listening for mousemove
            map_.off('mousemove', this.updateTemporaryAnchorBinded);
            return;
        }

        if (
            e.point.dist(
                map_.project(this.temporaryAnchor.geometry.coordinates as [number, number])
            ) > 20 ||
            this.temporaryAnchorCloseToOtherAnchor(e)
        ) {
            // Hide if too far from the layer
            this.removeTemporaryAnchor();
            return;
        }

        // Update the position of the temporary anchor
        this.moveAnchorFeature(this.temporaryAnchor, {
            lat: e.lngLat.lat,
            lon: e.lngLat.lng,
        });
    }

    temporaryAnchorCloseToOtherAnchor(e: maplibregl.MapMouseEvent) {
        const map_ = get(map);
        if (!map_) {
            return false;
        }

        const zoom = map_.getZoom();
        // With every trackpoint being an anchor, projecting each one is too costly on
        // mousemove. Pre-filter geographically: an anchor farther than ~15 px cannot pass
        // the 10 px test below (15 px keeps this a conservative superset).
        const degPerPx = 360 / (256 * Math.pow(2, zoom));
        const latThreshold = degPerPx * 15;
        const lngThreshold = latThreshold / Math.max(0.1, Math.cos((e.lngLat.lat * Math.PI) / 180));
        const [cursorLng, cursorLat] = [e.lngLat.lng, e.lngLat.lat];

        for (const anchor of this.anchors) {
            const [anchorLng, anchorLat] = anchor.geometry.coordinates as [number, number];
            if (
                Math.abs(anchorLat - cursorLat) > latThreshold ||
                Math.abs(anchorLng - cursorLng) > lngThreshold
            ) {
                continue;
            }
            if (
                zoom >= anchor.properties.minZoom &&
                e.point.dist(map_.project(anchor.geometry.coordinates as [number, number])) < 10
            ) {
                return true;
            }
        }
        return false;
    }

    moveAnchorFeature(anchor: Anchor, coordinates: Coordinates) {
        const source = get(map)?.getSource(
            this.layers.get(anchor.properties.minZoom ?? MIN_ANCHOR_ZOOM)?.id ?? ''
        ) as GeoJSONSource | undefined;
        if (source) {
            source.updateData({
                update: [
                    {
                        id: anchor.properties.anchorIndex,
                        newGeometry: {
                            type: 'Point',
                            coordinates: [coordinates.lon, coordinates.lat],
                        },
                    },
                ],
            });
        }
    }

    addTemporaryAnchor() {
        if (!this.temporaryAnchor) {
            return;
        }
        const source = get(map)?.getSource(`routing-controls-${this.fileId}-0`) as
            | GeoJSONSource
            | undefined;
        if (source) {
            if (this.temporaryAnchor) {
                source.updateData({
                    add: [this.temporaryAnchor],
                });
            }
        }
    }

    removeTemporaryAnchor() {
        if (!this.temporaryAnchor) {
            return;
        }
        const map_ = get(map);
        const source = map_?.getSource(`routing-controls-${this.fileId}-0`) as
            | GeoJSONSource
            | undefined;
        if (source) {
            if (this.temporaryAnchor) {
                source.updateData({
                    remove: [this.temporaryAnchor.properties.anchorIndex],
                });
            }
        }
        map_?.off('mousemove', this.updateTemporaryAnchorBinded);
        mapCursor.notify(MapCursorState.ANCHOR_HOVER, false);
        this.temporaryAnchor = null;
    }
}

export const routingControls: Map<string, RoutingControls> = new Map();
