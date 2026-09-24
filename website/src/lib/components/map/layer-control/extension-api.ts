import { settings } from '$lib/logic/settings';
import { derived, get, type Writable } from 'svelte/store';
import { guardSubscribers, safeWritable } from '$lib/logic/safe-store';
import { getSubtree, isSelected, remove, removeAll } from './utils';
import { overlays, overlayTree, type LayerTreeType } from '$lib/assets/layers';
import { browser } from '$app/environment';
import { map } from '$lib/components/map/map';

const { currentOverlays, previousOverlays, selectedOverlayTree } = settings;

export type CustomOverlay = {
    extensionName: string;
    id: string;
    name: string;
    tileUrls: string[];
    maxZoom?: number;
};

export class ExtensionAPI {
    private _overlays: Writable<Map<string, CustomOverlay>> = safeWritable(
        new Map(),
        'extensionOverlays'
    );

    init() {
        if (browser && !Object.hasOwn(window, 'gotrails')) {
            Object.defineProperty(window, 'gotrails', {
                value: this,
            });
            addEventListener('beforeunload', () => {
                this.destroy();
            });
        }
    }

    ensureLoaded(): Promise<void> {
        let unsubscribe: () => void;
        const promise = new Promise<void>((resolve) => {
            map.onLoad(() => {
                unsubscribe = currentOverlays.subscribe((current) => {
                    if (current) {
                        resolve();
                    }
                });
            });
        });
        promise.finally(() => {
            unsubscribe?.();
        });
        return promise;
    }

    addOrUpdateOverlay(overlay: CustomOverlay) {
        if (
            !overlay.extensionName ||
            !overlay.id ||
            !overlay.name ||
            !overlay.tileUrls ||
            overlay.tileUrls.length === 0
        ) {
            throw new Error(
                'Overlay must have an extensionName, id, name, and at least one tile URL.'
            );
        }
        overlay.id = this.getOverlayId(overlay.id);

        this._overlays.update(($overlays) => {
            $overlays.set(overlay.id, overlay);
            return $overlays;
        });

        overlays[overlay.id] = {
            version: 8,
            sources: {
                [overlay.id]: {
                    type: 'raster',
                    tiles: overlay.tileUrls,
                    tileSize: overlay.tileUrls.some((url) => url.includes('512')) ? 512 : 256,
                    maxzoom: overlay.maxZoom ?? 22,
                },
            },
            layers: [
                {
                    id: overlay.id,
                    type: 'raster',
                    source: overlay.id,
                },
            ],
        };

        getSubtree(getSubtree(overlayTree, 'overlays'), overlay.extensionName)[overlay.id] = true;

        selectedOverlayTree.update((selected) => {
            getSubtree(getSubtree(selected, 'overlays'), overlay.extensionName)[overlay.id] = true;
            return selected;
        });

        // Deferred until the stored value arrives: `currentOverlays` is undefined until the Dexie
        // liveQuery delivers, and both `show` and the write below need the loaded tree.
        currentOverlays.updateWhenLoaded((current) => {
            let show = false;
            if (isSelected(current, overlay.id)) {
                show = true;
                try {
                    get(map)?.removeLayer(overlay.id);
                } catch {
                    // No reliable way to check if the map is ready to remove sources and layers
                }
            }
            getSubtree(getSubtree(current, 'overlays'), overlay.extensionName)[overlay.id] = show;
            return current;
        });
    }

    filterOverlays(ids: string[]) {
        ids = ids.map((id) => this.getOverlayId(id));
        const idsToRemove = Array.from(get(this._overlays).keys()).filter(
            (id) => !ids.includes(id)
        );

        currentOverlays.updateWhenLoaded((current) => {
            removeAll(current, idsToRemove);
            return current;
        });
        previousOverlays.update((previous) => {
            removeAll(previous, idsToRemove);
            return previous;
        });
        selectedOverlayTree.update((selected) => {
            removeAll(selected, idsToRemove);
            return selected;
        });
        Object.keys(overlays).forEach((id) => {
            if (idsToRemove.includes(id)) {
                delete overlays[id];
            }
        });
        removeAll(overlayTree, idsToRemove);
        this._overlays.update(($overlays) => {
            $overlays.forEach((_, id) => {
                if (idsToRemove.includes(id)) {
                    $overlays.delete(id);
                }
            });
            return $overlays;
        });
    }

    updateOverlaysOrder(ids: string[]) {
        ids = ids.map((id) => this.getOverlayId(id));
        selectedOverlayTree.update((selected) => {
            const overlaysTree = selected.overlays as LayerTreeType;
            // Holds tree leaves rather than plain booleans, and named so it no longer shadows the
            // imported isSelected(). Not getSubtree() below: a missing extension must be skipped,
            // not created.
            const selectedState: LayerTreeType = {};
            ids.forEach((id) => {
                const overlay = get(this._overlays).get(id);
                if (
                    overlay &&
                    Object.hasOwn(overlaysTree, overlay.extensionName) &&
                    Object.hasOwn(overlaysTree[overlay.extensionName] as LayerTreeType, id)
                ) {
                    const extensionOverlays = overlaysTree[overlay.extensionName] as LayerTreeType;
                    selectedState[id] = extensionOverlays[id];
                    delete extensionOverlays[id];
                }
            });
            Object.entries(selectedState).forEach(([id, value]) => {
                const overlay = get(this._overlays).get(id)!;
                (overlaysTree[overlay.extensionName] as LayerTreeType)[id] = value;
            });
            return selected;
        });
    }

    isLayerFromExtension = guardSubscribers(
        derived(this._overlays, ($overlays) => {
            return (id: string) => $overlays.has(id);
        }),
        'isLayerFromExtension'
    );

    getLayerName = guardSubscribers(
        derived(this._overlays, ($overlays) => {
            return (id: string) => $overlays.get(id)?.name || '';
        }),
        'getLayerName'
    );

    private getOverlayId(id: string): string {
        return `extension-${id}`;
    }

    private destroy() {
        const ids = Array.from(get(this._overlays).keys());
        currentOverlays.updateWhenLoaded((current) => {
            ids.forEach((id) => {
                remove(current, id);
            });
            return current;
        });
        previousOverlays.update((previous) => {
            ids.forEach((id) => {
                remove(previous, id);
            });
            return previous;
        });
        selectedOverlayTree.update((selected) => {
            ids.forEach((id) => {
                remove(selected, id);
            });
            return selected;
        });
    }
}

export const extensionAPI = new ExtensionAPI();
