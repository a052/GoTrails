<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { Button } from '$lib/components/ui/button';
    import { i18n } from '$lib/i18n.svelte';
    import { page } from '$app/state';
    import { map } from '$lib/components/map/map';
    import { mapCamera } from '$lib/logic/map-camera';

    let {
        geolocate = true,
        geocoder = true,
        hash = true,
        restoreCamera = false,
        class: className = '',
    }: {
        geolocate?: boolean;
        geocoder?: boolean;
        hash?: boolean;
        restoreCamera?: boolean;
        class?: string;
    } = $props();

    let webgl2Supported = $state(true);
    let embeddedApp = $state(false);
    // Plain let, not $state: nothing renders it, it only guards the async gap in onMount below.
    let destroyed = false;

    onMount(async () => {
        let gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) {
            webgl2Supported = false;
            return;
        }
        if (window.top !== window.self && !page.route.id?.includes('embed')) {
            embeddedApp = true;
            return;
        }

        let language = page.params.language;
        if (language === 'zh') {
            language = 'zh-Hans';
        } else if (language?.includes('-')) {
            language = language.split('-')[0];
        } else if (language === '' || language === undefined) {
            language = 'en';
        }

        // Opt-in, because embeds share this component and the same origin — and therefore the same
        // database — as the app itself, and must not read or write the user's stored viewport.
        // Reading it has to finish before the map is constructed: passing it to the constructor is
        // what lets a URL hash keep precedence over it and keeps applyThreeD from undoing a restored
        // pitch. If the component went away while we were waiting, onDestroy has already run and the
        // container is gone, so there is nothing left to initialise.
        const camera = restoreCamera ? await mapCamera.enable() : undefined;
        if (destroyed) {
            return;
        }

        map.init(language, hash, geocoder, geolocate, camera);
    });

    onDestroy(() => {
        destroyed = true;
        if (restoreCamera) {
            mapCamera.disable();
        }
        map.destroy();
    });
</script>

<div class={className}>
    <div id="map" class="h-full {webgl2Supported && !embeddedApp ? '' : 'hidden'}"></div>
    <div
        class="flex flex-col items-center justify-center gap-3 h-full {webgl2Supported &&
        !embeddedApp
            ? 'hidden'
            : ''} {embeddedApp ? 'z-30' : ''}"
    >
        {#if !webgl2Supported}
            <p>{i18n._('webgl2_required')}</p>
            <Button href="https://get.webgl.org/webgl2/" target="_blank">
                {i18n._('enable_webgl2')}
            </Button>
        {:else if embeddedApp}
            <p>The app cannot be embedded in an iframe.</p>
            <Button href="https://gotrails.vercel.app/help/integration" target="_blank">
                Learn how to create a map for your website
            </Button>
        {/if}
    </div>
</div>

<style lang="postcss">
    @reference "../../../app.css";

    div :global(.maplibregl-map) {
        @apply font-sans;
    }

    div :global(.maplibregl-ctrl-top-right > .maplibregl-ctrl) {
        @apply shadow-md;
        @apply bg-background;
        @apply text-foreground;
    }

    div :global(.maplibregl-ctrl-icon) {
        @apply dark:brightness-[4.7];
    }

    div :global(.maplibregl-ctrl-geocoder) {
        @apply flex;
        @apply flex-row;
        @apply w-fit;
        @apply min-w-fit;
        @apply items-center;
        @apply shadow-md;
    }

    div :global(.suggestions) {
        @apply shadow-md;
        @apply bg-background;
        @apply text-foreground;
    }

    div :global(.maplibregl-ctrl-geocoder .suggestions > li > a) {
        @apply text-foreground;
        @apply hover:text-accent-foreground;
        @apply hover:bg-accent;
    }

    div :global(.maplibregl-ctrl-geocoder .suggestions > .active > a) {
        @apply bg-background;
    }

    div :global(.maplibregl-ctrl-geocoder--button) {
        @apply bg-transparent;
        @apply hover:bg-transparent;
    }

    div :global(.maplibregl-ctrl-geocoder--icon) {
        @apply fill-foreground;
        @apply hover:fill-accent-foreground;
    }

    div :global(.maplibregl-ctrl-geocoder--icon-search) {
        @apply relative;
        @apply top-0;
        @apply left-0;
        @apply w-[29px];
    }

    div :global(.maplibregl-ctrl-geocoder--icon-loading) {
        @apply -mt-1;
        @apply mb-0;
    }

    div :global(.maplibregl-ctrl-geocoder--icon-close) {
        @apply my-0;
    }

    div :global(.maplibregl-ctrl-geocoder--input) {
        @apply relative;
        @apply h-8;
        @apply w-64;
        @apply py-0;
        @apply pl-2;
        @apply focus:outline-none;
        @apply transition-[width];
        @apply duration-200;
        @apply text-foreground;
    }

    div :global(.maplibregl-ctrl-geocoder--collapsed .maplibregl-ctrl-geocoder--input) {
        @apply w-0;
        @apply p-0;
    }

    div :global(.maplibregl-ctrl-top-right) {
        @apply z-40;
        @apply flex;
        @apply flex-col;
        @apply items-end;
        @apply h-full;
        @apply overflow-hidden;
    }

    .horizontal :global(.maplibregl-ctrl-bottom-left) {
        @apply bottom-[42px];
    }

    .horizontal :global(.maplibregl-ctrl-bottom-right) {
        @apply bottom-[42px];
    }

    .bottom-bar :global(.maplibregl-ctrl-bottom-right) {
        @apply bottom-[42px];
    }

    /* Clean mode: drop MapLibre's whole control layer in one rule — zoom/compass, globe, geocoder,
       geolocate, scale and attribution, plus LayerControl and StreetViewControl, which are added
       through `map.addControl` and therefore live in the same container. */
    .clean :global(.maplibregl-control-container) {
        @apply hidden;
    }

    div :global(.maplibregl-ctrl-attrib) {
        @apply dark:bg-transparent;
    }

    div :global(.maplibregl-compact-show.maplibregl-ctrl-attrib) {
        @apply dark:bg-background;
    }

    div :global(.maplibregl-ctrl-attrib-button) {
        @apply dark:bg-foreground;
    }

    div :global(.maplibregl-compact-show .maplibregl-ctrl-attrib-button) {
        @apply dark:bg-foreground;
    }

    div :global(.maplibregl-ctrl-attrib a) {
        @apply text-foreground;
    }

    div :global(.maplibregl-popup) {
        @apply z-50;
    }

    div :global(.maplibregl-popup-content) {
        @apply p-0;
        @apply bg-transparent;
        @apply shadow-none;
    }

    div :global(.maplibregl-popup-anchor-top .maplibregl-popup-tip) {
        @apply border-b-background;
    }

    div :global(.maplibregl-popup-anchor-top-left .maplibregl-popup-tip) {
        @apply border-b-background;
    }

    div :global(.maplibregl-popup-anchor-top-right .maplibregl-popup-tip) {
        @apply border-b-background;
    }

    div :global(.maplibregl-popup-anchor-bottom .maplibregl-popup-tip) {
        @apply border-t-background;
        @apply drop-shadow-md;
    }

    div :global(.maplibregl-popup-anchor-bottom-left .maplibregl-popup-tip) {
        @apply border-t-background;
        @apply drop-shadow-md;
    }

    div :global(.maplibregl-popup-anchor-bottom-right .maplibregl-popup-tip) {
        @apply border-t-background;
        @apply drop-shadow-md;
    }

    div :global(.maplibregl-popup-anchor-left .maplibregl-popup-tip) {
        @apply border-r-background;
    }

    div :global(.maplibregl-popup-anchor-right .maplibregl-popup-tip) {
        @apply border-l-background;
    }
</style>
