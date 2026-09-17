<script lang="ts">
    import * as Dialog from '$lib/components/ui/dialog';
    import CopyCoordinates from '$lib/components/map/gpx-layer/CopyCoordinates.svelte';
    import WithUnits from '$lib/components/WithUnits.svelte';
    import { i18n } from '$lib/i18n.svelte';
    import { trackpointInfo } from './routing-controls';

    let point = $derived($trackpointInfo);

    // The extension fields are read directly instead of through getHeartRate()/getCadence()/
    // getTemperature()/getPower(): those getters treat every falsy value as absent, which would hide
    // a legitimate 0 (0 °C, 0 rpm, 0 W).
    let trackPointExtension = $derived(point?.extensions?.['gpxtpx:TrackPointExtension']);
    let temperature = $derived(trackPointExtension?.['gpxtpx:atemp']);
    let heartRate = $derived(trackPointExtension?.['gpxtpx:hr']);
    let cadence = $derived(trackPointExtension?.['gpxtpx:cad']);
    let power = $derived(point?.extensions?.['gpxpx:PowerExtension']?.['gpxpx:PowerInWatts']);
    // getExtensions() hands back a shared empty object when the point has none, so this is always safe.
    let customExtensions = $derived(point ? Object.entries(point.getExtensions()) : []);

    type Row = {
        label: string;
        value?: number;
        type?: 'elevation' | 'temperature';
        text?: string;
    };

    // Only expose a value when it is meaningful; otherwise the row shows the placeholder.
    let rows = $derived<Row[]>(
        point
            ? [
                  {
                      label: i18n._('quantities.latitude'),
                      text: `${point.getLatitude().toFixed(6)}°`,
                  },
                  {
                      label: i18n._('quantities.longitude'),
                      text: `${point.getLongitude().toFixed(6)}°`,
                  },
                  {
                      label: i18n._('quantities.elevation'),
                      value: point.ele,
                      type: 'elevation',
                  },
                  {
                      label: i18n._('quantities.time'),
                      text: point.time ? i18n.df.format(point.time) : undefined,
                  },
                  {
                      label: i18n._('quantities.temperature'),
                      value: temperature,
                      type: 'temperature',
                  },
                  {
                      label: i18n._('quantities.heartrate'),
                      text:
                          heartRate !== undefined
                              ? `${heartRate} ${i18n._('units.heartrate')}`
                              : undefined,
                  },
                  {
                      label: i18n._('quantities.cadence'),
                      text:
                          cadence !== undefined
                              ? `${cadence} ${i18n._('units.cadence')}`
                              : undefined,
                  },
                  {
                      label: i18n._('quantities.power'),
                      text: power !== undefined ? `${power} ${i18n._('units.power')}` : undefined,
                  },
              ]
            : []
    );

    function close() {
        trackpointInfo.set(null);
    }
</script>

<Dialog.Root
    open={$trackpointInfo !== null}
    onOpenChange={(isOpen) => {
        if (!isOpen) {
            close();
        }
    }}
>
    <Dialog.Trigger class="hidden" />
    <Dialog.Portal>
        <Dialog.Content class="flex max-h-[80dvh] w-80 flex-col">
            <Dialog.Title>{i18n._('toolbar.routing.anchor_info')}</Dialog.Title>
            {#if point}
                <div class="flex max-h-[60dvh] flex-col gap-3 overflow-y-auto text-sm">
                    <div class="flex flex-col gap-0.5">
                        {#each rows as row (row.label)}
                            <div class="flex flex-row items-center justify-between gap-4">
                                <span>{row.label}</span>
                                {#if row.value !== undefined && row.type !== undefined}
                                    <WithUnits value={row.value} type={row.type} />
                                {:else if row.text !== undefined}
                                    <span>{row.text}</span>
                                {:else}
                                    <span class="text-muted-foreground">&mdash;</span>
                                {/if}
                            </div>
                        {/each}
                    </div>
                    <div class="flex flex-col gap-0.5">
                        <span class="text-xs font-semibold text-muted-foreground">
                            {i18n._('quantities.custom_extensions')}
                        </span>
                        {#if customExtensions.length > 0}
                            {#each customExtensions as [key, value] (key)}
                                <div class="flex flex-row items-start justify-between gap-4">
                                    <span class="break-all">{key}</span>
                                    <span class="break-all text-right">{value}</span>
                                </div>
                            {/each}
                        {:else}
                            <span class="text-muted-foreground">&mdash;</span>
                        {/if}
                    </div>
                    <CopyCoordinates coordinates={point.attributes} onCopy={close} />
                </div>
            {/if}
        </Dialog.Content>
    </Dialog.Portal>
</Dialog.Root>
