<script lang="ts">
    import WithUnits from '$lib/components/WithUnits.svelte';
    import { i18n } from '$lib/i18n.svelte';
    import { fileInfo } from '$lib/logic/file-info';
    import type { GPXGlobalStatistics } from 'gpx';

    let {
        statistics,
    }: {
        statistics: GPXGlobalStatistics;
    } = $props();

    type StatType = 'distance' | 'elevation' | 'speed' | 'time' | 'slope' | 'vam';
    // A row is a formatted stat (`value` + `type`), plain `text` (counts/creator/sampling rate),
    // or empty (neither) — in which case it renders a muted placeholder.
    type StatRow = { label: string; value?: number; type?: StatType; text?: string };

    // Only expose a value when it is finite/meaningful; otherwise the row shows the placeholder.
    const finite = (v: number): number | undefined => (Number.isFinite(v) ? v : undefined);

    // Time- and speed-derived metrics are only meaningful when the range carries timestamps.
    let hasTime = $derived(statistics.time.total > 0);
    // VAM (vertical ascent metre) divides elevation gain by the time spent *ascending*, not the
    // whole moving time — dividing by moving time would dilute the climb rate on up-and-down routes.
    let ascentHours = $derived(statistics.time.up / 3600);

    let samplingRateText = $derived(
        $fileInfo.samplingRate !== undefined
            ? `${Math.round($fileInfo.samplingRate * 10) / 10} ${i18n._('units.seconds')}`
            : undefined
    );

    let sections = $derived<{ title: string; rows: StatRow[] }[]>([
        {
            title: i18n._('quantities.distance'),
            rows: [
                {
                    label: i18n._('quantities.total_distance'),
                    value: statistics.distance.total,
                    type: 'distance',
                },
                {
                    label: i18n._('quantities.uphill_distance'),
                    value: statistics.distance.up,
                    type: 'distance',
                },
                {
                    label: i18n._('quantities.downhill_distance'),
                    value: statistics.distance.down,
                    type: 'distance',
                },
                {
                    label: i18n._('quantities.flat_distance'),
                    value: statistics.distance.flat,
                    type: 'distance',
                },
            ],
        },
        {
            title: i18n._('quantities.time'),
            rows: [
                {
                    label: i18n._('quantities.moving_time'),
                    value: hasTime ? statistics.time.moving : undefined,
                    type: 'time',
                },
                {
                    label: i18n._('quantities.total_time'),
                    value: hasTime ? statistics.time.total : undefined,
                    type: 'time',
                },
                {
                    label: i18n._('quantities.rest_time'),
                    value: hasTime ? statistics.time.total - statistics.time.moving : undefined,
                    type: 'time',
                },
            ],
        },
        {
            title: i18n._('quantities.speed'),
            rows: [
                {
                    label: i18n._('quantities.moving_speed'),
                    value: hasTime ? statistics.speed.moving : undefined,
                    type: 'speed',
                },
                {
                    label: i18n._('quantities.total_speed'),
                    value: hasTime ? statistics.speed.total : undefined,
                    type: 'speed',
                },
                {
                    label: i18n._('quantities.fastest_speed'),
                    value: hasTime ? statistics.speed.max : undefined,
                    type: 'speed',
                },
                {
                    label: i18n._('quantities.vertical_ascent_metric'),
                    value: ascentHours > 0 ? statistics.elevation.gain / ascentHours : undefined,
                    type: 'vam',
                },
            ],
        },
        {
            title: i18n._('quantities.elevation_gain_loss'),
            rows: [
                {
                    label: i18n._('quantities.elevation_gain'),
                    value: statistics.elevation.gain,
                    type: 'elevation',
                },
                {
                    label: i18n._('quantities.elevation_loss'),
                    value: statistics.elevation.loss,
                    type: 'elevation',
                },
            ],
        },
        {
            title: i18n._('quantities.elevation'),
            rows: [
                {
                    label: i18n._('quantities.max_elevation'),
                    value: finite(statistics.elevation.max),
                    type: 'elevation',
                },
                {
                    label: i18n._('quantities.min_elevation'),
                    value: finite(statistics.elevation.min),
                    type: 'elevation',
                },
                {
                    label: i18n._('quantities.start_elevation'),
                    value: finite(statistics.elevation.start),
                    type: 'elevation',
                },
                {
                    label: i18n._('quantities.end_elevation'),
                    value: finite(statistics.elevation.end),
                    type: 'elevation',
                },
            ],
        },
        {
            title: i18n._('quantities.slope'),
            rows: [
                {
                    label: i18n._('quantities.max_slope_up'),
                    value: finite(statistics.slope.max),
                    type: 'slope',
                },
                {
                    label: i18n._('quantities.max_slope_down'),
                    value: finite(statistics.slope.min),
                    type: 'slope',
                },
            ],
        },
        {
            title: i18n._('quantities.file_info'),
            rows: [
                { label: i18n._('quantities.track_count'), text: `${$fileInfo.trackCount}` },
                { label: i18n._('quantities.segment_count'), text: `${$fileInfo.segmentCount}` },
                { label: i18n._('quantities.point_count'), text: `${$fileInfo.pointCount}` },
                { label: i18n._('quantities.waypoint_count'), text: `${$fileInfo.waypointCount}` },
                { label: i18n._('quantities.creator'), text: $fileInfo.creator },
                { label: i18n._('quantities.sampling_rate'), text: samplingRateText },
            ],
        },
    ]);
</script>

<div class="flex max-h-[60vh] w-80 flex-col gap-3 overflow-y-auto p-3 text-sm">
    {#each sections as section (section.title)}
        <div class="flex flex-col gap-0.5">
            <span class="text-xs font-semibold text-muted-foreground">{section.title}</span>
            {#each section.rows as row (row.label)}
                <div class="flex flex-row items-center justify-between gap-4">
                    <span>{row.label}</span>
                    {#if row.value !== undefined && row.type !== undefined}
                        <WithUnits value={row.value} type={row.type} />
                    {:else if row.text !== undefined}
                        <span>{row.text}</span>
                    {:else}
                        <span class="text-muted-foreground">—</span>
                    {/if}
                </div>
            {/each}
        </div>
    {/each}
</div>
