import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { GPXFile } from './gpx';
import type {
    GPXFileType,
    TrackType,
    TrackPointType,
    TrackPointExtensions,
    TrackPointExtension,
    WaypointType,
    LineStyleExtension,
} from './types';

// KML is converted to/from the internal GPX model so every existing GPX query/edit/statistics
// function is reused unchanged. parseKML/buildKML mirror parseGPX/buildGPX (io.ts) and operate at
// the same `GPXFileType` plain-object boundary: parseKML builds that object and hands it to
// `new GPXFile(...)`, buildKML consumes `file.toGPXFileType(exclude)` so the export include/exclude
// options behave identically to buildGPX for free.
//
// Mapping is intentionally a *clean canonical* one: only fields with a natural home in both formats
// are carried (geometry, elevation, time, names, descriptions, track color/width, hr/cad/atemp/power).
// KML-only constructs (folder trees, per-feature ExtendedData tables, icon styles, unknown sensor
// arrays, overlays, network links, camera/region) are dropped rather than stashed into GPX.

// ---------------------------------------------------------------------------
// Loosely-typed view over the fast-xml-parser output (avoids `any`; the parser
// returns strings for leaf text, `{ attributes, ... }` for elements with
// attributes, and arrays for repeated elements).
// ---------------------------------------------------------------------------
type XmlValue = string | number | boolean | XmlNode | XmlValue[] | undefined | null;
interface XmlNode {
    [key: string]: XmlValue;
}

function obj(v: XmlValue): XmlNode | undefined {
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as XmlNode) : undefined;
}

// Coerce a node to its text content: a bare string, a number/boolean, or the `#text` of an element
// that also carried attributes.
function str(v: XmlValue): string | undefined {
    if (v === undefined || v === null) {
        return undefined;
    }
    if (typeof v === 'string') {
        return v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
        return String(v);
    }
    const o = obj(v);
    if (o && '#text' in o) {
        return str(o['#text']);
    }
    return undefined;
}

// Normalize a value into an array: fast-xml-parser returns a single object for a lone element and an
// array for repeats, so callers always iterate uniformly.
function arr(v: XmlValue): XmlValue[] {
    if (v === undefined || v === null) {
        return [];
    }
    return Array.isArray(v) ? v : [v];
}

function attr(node: XmlNode, key: string): string | undefined {
    const a = obj(node.attributes);
    return a ? str(a[key]) : undefined;
}

function num(v: string | undefined): number | undefined {
    if (v === undefined || v.trim() === '') {
        return undefined;
    }
    const n = parseFloat(v);
    return Number.isNaN(n) ? undefined : n;
}

function parseDate(v: string | undefined): Date | undefined {
    if (v === undefined || v.trim() === '') {
        return undefined;
    }
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? undefined : d;
}

function toIso(d: Date | undefined): string | undefined {
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
}

// ---------------------------------------------------------------------------
// Geometry & style helpers (load-bearing: KML coordinate order is lon,lat[,alt]).
// ---------------------------------------------------------------------------

// <coordinates>: whitespace-separated tuples, comma-separated "lon,lat[,alt]".
function parseCoordinates(text: string | undefined): { lon: number; lat: number; ele?: number }[] {
    if (!text) {
        return [];
    }
    const out: { lon: number; lat: number; ele?: number }[] = [];
    for (const tuple of text.trim().split(/\s+/)) {
        if (tuple === '') {
            continue;
        }
        const p = tuple.split(',');
        const lon = parseFloat(p[0]);
        const lat = parseFloat(p[1]);
        if (Number.isNaN(lon) || Number.isNaN(lat)) {
            continue;
        }
        const ele = p.length > 2 && p[2] !== '' ? parseFloat(p[2]) : undefined;
        out.push({ lon, lat, ele: ele !== undefined && !Number.isNaN(ele) ? ele : undefined });
    }
    return out;
}

// single <gx:coord>: SPACE-separated "lon lat [alt]", no commas.
function parseGxCoord(text: string | undefined): { lon: number; lat: number; ele?: number } | null {
    if (!text || text.trim() === '') {
        return null;
    }
    const p = text.trim().split(/\s+/);
    const lon = parseFloat(p[0]);
    const lat = parseFloat(p[1]);
    if (Number.isNaN(lon) || Number.isNaN(lat)) {
        return null;
    }
    const ele = p.length > 2 ? parseFloat(p[2]) : undefined;
    return { lon, lat, ele: ele === undefined || Number.isNaN(ele) ? undefined : ele };
}

// KML color aabbggrr -> gpx_style color (rrggbb, no '#') + opacity 0..1.
function kmlColorToStyle(kml: string | undefined): { color?: string; opacity?: number } {
    if (!kml) {
        return {};
    }
    const s = kml.trim().toLowerCase().replace(/^#/, '');
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(s)) {
        return {};
    }
    const [aa, bb, gg, rr] =
        s.length === 8
            ? [s.slice(0, 2), s.slice(2, 4), s.slice(4, 6), s.slice(6, 8)]
            : ['ff', s.slice(0, 2), s.slice(2, 4), s.slice(4, 6)];
    return { color: rr + gg + bb, opacity: parseInt(aa, 16) / 255 };
}

// gpx_style color (rrggbb, no '#') + opacity -> KML aabbggrr.
function styleToKmlColor(
    color: string | undefined,
    opacity: number | undefined
): string | undefined {
    if (!color) {
        return undefined;
    }
    const c = color.replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(c)) {
        return undefined;
    }
    const rr = c.slice(0, 2);
    const gg = c.slice(2, 4);
    const bb = c.slice(4, 6);
    const aa = Math.round(Math.min(1, Math.max(0, opacity ?? 1)) * 255)
        .toString(16)
        .padStart(2, '0');
    return (aa + bb + gg + rr).toLowerCase();
}

// ---------------------------------------------------------------------------
// Sensor channels shared by both directions.
// ---------------------------------------------------------------------------
type Channel = 'heartrate' | 'cadence' | 'temperature' | 'power';
const ALL_CHANNELS: Channel[] = ['heartrate', 'cadence', 'temperature', 'power'];

function channelDisplayName(ch: Channel): string {
    switch (ch) {
        case 'heartrate':
            return 'Heart Rate';
        case 'cadence':
            return 'Cadence';
        case 'temperature':
            return 'Temperature';
        case 'power':
            return 'Power';
    }
}

function sensorValue(p: TrackPointType, ch: Channel): number | undefined {
    const tpx = p.extensions?.['gpxtpx:TrackPointExtension'];
    switch (ch) {
        case 'heartrate':
            return tpx?.['gpxtpx:hr'];
        case 'cadence':
            return tpx?.['gpxtpx:cad'];
        case 'temperature':
            return tpx?.['gpxtpx:atemp'];
        case 'power':
            return p.extensions?.['gpxpx:PowerExtension']?.['gpxpx:PowerInWatts'];
    }
}

// ===========================================================================
// parseKML: KML string -> GPXFile
// ===========================================================================

const KML_ARRAY_TAGS = new Set([
    'Document',
    'Folder',
    'Placemark',
    'when',
    'coord', // gx:coord (removeNSPrefix strips the gx: prefix)
    'Track', // gx:Track, incl. children of gx:MultiTrack
    'LineString',
    'Point',
    'SimpleArrayData', // gx:SimpleArrayData
    'value', // gx:value
    'Style',
    'StyleMap',
    'Pair',
]);

interface StyleTable {
    styles: Record<string, XmlNode>;
    styleMaps: Record<string, XmlNode>;
}

export function parseKML(kmlData: string): GPXFile {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '',
        attributesGroupName: 'attributes',
        removeNSPrefix: true, // gx:Track -> Track, gx:coord -> coord, atom:* -> * (robust to prefix)
        parseTagValue: false, // keep <coordinates>/<when>/colors as raw strings; parsed manually
        isArray: (name: string) => KML_ARRAY_TAGS.has(name),
    });

    const result: GPXFileType = { attributes: {}, metadata: {}, wpt: [], trk: [], rte: [] };

    const parsed = obj(parser.parse(kmlData) as XmlValue);
    const kml = parsed ? obj(parsed.kml) : undefined;
    if (!kml) {
        return new GPXFile(result);
    }

    // Name/description come from the top-level <Document>/<Folder> when present, else <kml> itself.
    // (Document/Folder are force-arrayed, so unwrap the first entry.)
    const top = obj(arr(kml.Document)[0]) ?? obj(arr(kml.Folder)[0]) ?? kml;
    const name = str(top.name);
    const desc = str(top.description);
    if (name) {
        result.metadata.name = name;
    }
    if (desc) {
        result.metadata.desc = desc;
    }

    // Pre-index shared <Style>/<StyleMap> (anywhere in the tree) so <styleUrl> can be resolved.
    const styles: StyleTable = { styles: {}, styleMaps: {} };
    indexStyles(kml, styles);

    // Folders are flattened: placemarks are collected in document order.
    const placemarks: XmlNode[] = [];
    collectPlacemarks(kml, placemarks);

    for (const pm of placemarks) {
        dispatchPlacemark(pm, styles, result);
    }

    return new GPXFile(result);
}

function collectPlacemarks(container: XmlNode, out: XmlNode[]): void {
    for (const pm of arr(container.Placemark)) {
        const o = obj(pm);
        if (o) {
            out.push(o);
        }
    }
    for (const child of [...arr(container.Folder), ...arr(container.Document)]) {
        const o = obj(child);
        if (o) {
            collectPlacemarks(o, out);
        }
    }
}

function indexStyles(container: XmlNode, table: StyleTable): void {
    for (const s of arr(container.Style)) {
        const o = obj(s);
        const id = o ? attr(o, 'id') : undefined;
        if (o && id) {
            table.styles[id] = o;
        }
    }
    for (const sm of arr(container.StyleMap)) {
        const o = obj(sm);
        const id = o ? attr(o, 'id') : undefined;
        if (o && id) {
            table.styleMaps[id] = o;
        }
    }
    for (const child of [...arr(container.Folder), ...arr(container.Document)]) {
        const o = obj(child);
        if (o) {
            indexStyles(o, table);
        }
    }
}

function resolveStyle(pm: XmlNode, styles: StyleTable): XmlNode | undefined {
    const inline = obj(arr(pm.Style)[0]);
    if (inline) {
        return inline;
    }
    const url = str(pm.styleUrl);
    return url ? lookupStyle(url.replace(/^#/, ''), styles) : undefined;
}

function lookupStyle(id: string, styles: StyleTable): XmlNode | undefined {
    if (styles.styles[id]) {
        return styles.styles[id];
    }
    const sm = styles.styleMaps[id];
    if (sm) {
        for (const pair of arr(sm.Pair)) {
            const po = obj(pair);
            if (po && str(po.key) === 'normal') {
                const su = str(po.styleUrl);
                if (su) {
                    return styles.styles[su.replace(/^#/, '')];
                }
            }
        }
    }
    return undefined;
}

function lineStyleFromPlacemark(pm: XmlNode, styles: StyleTable): LineStyleExtension | undefined {
    const style = resolveStyle(pm, styles);
    const ls = style ? obj(style.LineStyle) : undefined;
    if (!ls) {
        return undefined;
    }
    const { color, opacity } = kmlColorToStyle(str(ls.color));
    const width = num(str(ls.width));
    const ext: LineStyleExtension = {};
    if (color) {
        ext['gpx_style:color'] = color;
    }
    if (opacity !== undefined) {
        ext['gpx_style:opacity'] = opacity;
    }
    if (width !== undefined) {
        ext['gpx_style:width'] = width;
    }
    return Object.keys(ext).length > 0 ? ext : undefined;
}

function dispatchPlacemark(pm: XmlNode, styles: StyleTable, result: GPXFileType): void {
    const name = str(pm.name);
    // KML descriptions are commonly HTML (photos, links, notes), and they are routed to GPX *cmt*
    // rather than desc: the OSM iD editor (and anything built on togeojson) renders the GPX desc
    // as the feature's plain-text map label (label = desc || name), so HTML in desc leaks as raw
    // tag soup there, while cmt is parsed but never used as a label. gpx.studio's waypoint popup
    // renders cmt exactly like desc (sanitized HTML), so the content stays fully visible here.
    // buildKML mirrors this by emitting cmt (when desc is empty) back as the KML description.
    const desc = str(pm.description);

    const segments = extractSegments(pm);
    if (segments.length > 0) {
        const track: TrackType = { trkseg: segments.map((trkpt) => ({ trkpt })) };
        if (name) {
            track.name = name;
        }
        if (desc) {
            track.cmt = desc;
        }
        const line = lineStyleFromPlacemark(pm, styles);
        if (line) {
            track.extensions = { 'gpx_style:line': line };
        }
        result.trk.push(track);
    }

    const points = extractPoints(pm);
    if (points.length > 0) {
        const time = parseDate(str(arr(obj(pm.TimeStamp)?.when)[0]));
        for (const c of points) {
            const wpt: WaypointType = { attributes: { lat: c.lat, lon: c.lon } };
            if (c.ele !== undefined) {
                wpt.ele = c.ele;
            }
            if (time) {
                wpt.time = time;
            }
            if (name) {
                wpt.name = name;
            }
            if (desc) {
                wpt.cmt = desc;
            }
            result.wpt.push(wpt);
        }
    }
}

// A Placemark (or a MultiGeometry within it) may hold several line-like geometries; each becomes one
// track segment. Point geometries are handled separately by extractPoints.
function extractSegments(node: XmlNode): TrackPointType[][] {
    const segments: TrackPointType[][] = [];

    for (const ls of arr(node.LineString)) {
        const o = obj(ls);
        if (o) {
            const pts = coordsToTrackpoints(str(o.coordinates));
            if (pts.length > 0) {
                segments.push(pts);
            }
        }
    }
    for (const tr of arr(node.Track)) {
        const o = obj(tr);
        if (o) {
            const pts = gxTrackToTrackpoints(o);
            if (pts.length > 0) {
                segments.push(pts);
            }
        }
    }
    for (const mt of arr(node.MultiTrack)) {
        const o = obj(mt);
        if (o) {
            for (const tr of arr(o.Track)) {
                const t = obj(tr);
                if (t) {
                    const pts = gxTrackToTrackpoints(t);
                    if (pts.length > 0) {
                        segments.push(pts);
                    }
                }
            }
        }
    }
    for (const pg of arr(node.Polygon)) {
        const o = obj(pg);
        const ring = o ? obj(obj(o.outerBoundaryIs)?.LinearRing) : undefined;
        if (ring) {
            const pts = coordsToTrackpoints(str(ring.coordinates));
            if (pts.length > 0) {
                segments.push(pts);
            }
        }
    }
    for (const mg of arr(node.MultiGeometry)) {
        const o = obj(mg);
        if (o) {
            segments.push(...extractSegments(o));
        }
    }

    return segments;
}

function extractPoints(node: XmlNode): { lon: number; lat: number; ele?: number }[] {
    const points: { lon: number; lat: number; ele?: number }[] = [];
    for (const p of arr(node.Point)) {
        const o = obj(p);
        if (o) {
            const c = parseCoordinates(str(o.coordinates))[0];
            if (c) {
                points.push(c);
            }
        }
    }
    for (const mg of arr(node.MultiGeometry)) {
        const o = obj(mg);
        if (o) {
            points.push(...extractPoints(o));
        }
    }
    return points;
}

function coordsToTrackpoints(text: string | undefined): TrackPointType[] {
    return parseCoordinates(text).map((c) => {
        const pt: TrackPointType = { attributes: { lat: c.lat, lon: c.lon } };
        if (c.ele !== undefined) {
            pt.ele = c.ele;
        }
        return pt;
    });
}

function gxTrackToTrackpoints(track: XmlNode): TrackPointType[] {
    const coords = arr(track.coord).map((v) => parseGxCoord(str(v)));
    const whens = arr(track.when).map((v) => str(v));
    const sensors = extractSchemaArrays(track);

    const pts: TrackPointType[] = [];
    for (let i = 0; i < coords.length; i++) {
        const c = coords[i];
        if (!c) {
            continue; // empty <gx:coord> => missing sample, dropped together with its when/sensors
        }
        const pt: TrackPointType = { attributes: { lat: c.lat, lon: c.lon } };
        if (c.ele !== undefined) {
            pt.ele = c.ele;
        }
        const time = parseDate(whens[i]);
        if (time) {
            pt.time = time;
        }
        const ext = pointExtensions(sensors, i);
        if (ext) {
            pt.extensions = ext;
        }
        pts.push(pt);
    }
    return pts;
}

function extractSchemaArrays(track: XmlNode): Partial<Record<Channel, string[]>> {
    const res: Partial<Record<Channel, string[]>> = {};
    const ed = obj(track.ExtendedData);
    if (!ed) {
        return res;
    }
    for (const sd of arr(ed.SchemaData)) {
        const sdo = obj(sd);
        if (!sdo) {
            continue;
        }
        for (const sad of arr(sdo.SimpleArrayData)) {
            const o = obj(sad);
            if (!o) {
                continue;
            }
            const channel = matchChannel(attr(o, 'name'));
            if (channel) {
                res[channel] = arr(o.value).map((v) => str(v) ?? '');
            }
        }
    }
    return res;
}

function matchChannel(name: string | undefined): Channel | undefined {
    if (!name) {
        return undefined;
    }
    const n = name.toLowerCase();
    if (n.includes('heart') || n === 'hr') {
        return 'heartrate';
    }
    if (n.includes('cad')) {
        return 'cadence';
    }
    if (n.includes('temp')) {
        return 'temperature';
    }
    if (n.includes('power') || n.includes('watt')) {
        return 'power';
    }
    return undefined;
}

function pointExtensions(
    sensors: Partial<Record<Channel, string[]>>,
    i: number
): TrackPointExtensions | undefined {
    const tpx: TrackPointExtension = {};
    const hr = num(sensors.heartrate?.[i]);
    if (hr !== undefined) {
        tpx['gpxtpx:hr'] = hr;
    }
    const cad = num(sensors.cadence?.[i]);
    if (cad !== undefined) {
        tpx['gpxtpx:cad'] = cad;
    }
    const atemp = num(sensors.temperature?.[i]);
    if (atemp !== undefined) {
        tpx['gpxtpx:atemp'] = atemp;
    }
    const power = num(sensors.power?.[i]);

    const ext: TrackPointExtensions = {};
    if (Object.keys(tpx).length > 0) {
        ext['gpxtpx:TrackPointExtension'] = tpx;
    }
    if (power !== undefined) {
        ext['gpxpx:PowerExtension'] = { 'gpxpx:PowerInWatts': power };
    }
    return Object.keys(ext).length > 0 ? ext : undefined;
}

// ===========================================================================
// buildKML: GPXFile -> KML string
// ===========================================================================

export function buildKML(file: GPXFile, exclude: string[] = []): string {
    const gpx = file.toGPXFileType(exclude);

    const builder = new XMLBuilder({
        format: true,
        ignoreAttributes: false,
        attributeNamePrefix: '',
        attributesGroupName: 'attributes',
        suppressEmptyNode: true,
        cdataPropName: '__cdata',
    });

    const channels = usedChannels(gpx);

    const doc: XmlNode = {};
    if (gpx.metadata?.name) {
        doc.name = gpx.metadata.name;
    }
    if (gpx.metadata?.desc) {
        doc.description = { __cdata: gpx.metadata.desc };
    }
    if (channels.length > 0) {
        doc.Schema = {
            attributes: { id: 'gpxstudio', name: 'gpxstudio' },
            'gx:SimpleArrayField': channels.map((ch) => ({
                attributes: { name: ch, type: ch === 'temperature' ? 'float' : 'int' },
                displayName: channelDisplayName(ch),
            })),
        };
    }

    const placemarks: XmlNode[] = [];
    for (const wpt of gpx.wpt) {
        placemarks.push(buildPointPlacemark(wpt));
    }
    // Track names are exported as-is: no borrowing the file name for a single unnamed track (the
    // Document name already carries it, and a fabricated track name shows up as a surprise label
    // in consumers like the OSM iD editor). Matches buildGPX, which no longer seeds either.
    gpx.trk.forEach((trk) => {
        const pm = buildTrackPlacemark(trk, channels, trk.name);
        if (pm) {
            placemarks.push(pm);
        }
    });
    if (placemarks.length > 0) {
        doc.Placemark = placemarks;
    }

    return builder.build({
        '?xml': { attributes: { version: '1.0', encoding: 'UTF-8' } },
        kml: {
            attributes: {
                xmlns: 'http://www.opengis.net/kml/2.2',
                'xmlns:gx': 'http://www.google.com/kml/ext/2.2',
            },
            Document: doc,
        },
    }) as string;
}

function usedChannels(gpx: GPXFileType): Channel[] {
    const set = new Set<Channel>();
    for (const trk of gpx.trk) {
        for (const seg of trk.trkseg ?? []) {
            for (const p of seg.trkpt) {
                for (const ch of ALL_CHANNELS) {
                    if (sensorValue(p, ch) !== undefined) {
                        set.add(ch);
                    }
                }
            }
        }
    }
    return ALL_CHANNELS.filter((ch) => set.has(ch));
}

function hasSensor(p: TrackPointType): boolean {
    return ALL_CHANNELS.some((ch) => sensorValue(p, ch) !== undefined);
}

function pointTuple(lon: number, lat: number, ele: number | undefined): string {
    return ele != null ? `${lon},${lat},${ele}` : `${lon},${lat}`;
}

function buildPointPlacemark(wpt: WaypointType): XmlNode {
    const pm: XmlNode = {};
    if (wpt.name) {
        pm.name = wpt.name;
    }
    const desc = wpt.desc ?? wpt.cmt;
    if (desc) {
        pm.description = { __cdata: desc };
    }
    const iso = toIso(wpt.time);
    if (iso) {
        pm.TimeStamp = { when: iso };
    }
    pm.Point = { coordinates: pointTuple(wpt.attributes.lon, wpt.attributes.lat, wpt.ele) };
    return pm;
}

function buildTrackPlacemark(
    trk: TrackType,
    channels: Channel[],
    name: string | undefined
): XmlNode | null {
    const segments = (trk.trkseg ?? []).filter((seg) => seg.trkpt.length > 0);
    if (segments.length === 0) {
        return null;
    }

    const pm: XmlNode = {};
    if (name) {
        pm.name = name;
    }
    // desc first (primary GPX description), then cmt — where descriptions of KML origin live, so
    // they round-trip back into the KML description. Mirrors buildPointPlacemark.
    const desc = trk.desc ?? trk.cmt;
    if (desc) {
        pm.description = { __cdata: desc };
    }

    const style = trk.extensions?.['gpx_style:line'];
    if (style) {
        const ls: XmlNode = {};
        const color = styleToKmlColor(style['gpx_style:color'], style['gpx_style:opacity']);
        if (color) {
            ls.color = color;
        }
        if (style['gpx_style:width'] !== undefined) {
            ls.width = style['gpx_style:width'];
        }
        if (Object.keys(ls).length > 0) {
            pm.Style = { LineStyle: ls };
        }
    }

    // A gx:Track is required to carry per-point data (timestamps and/or sensor arrays); a plain
    // LineString suffices otherwise. Sensor-only tracks (no timestamps) still round-trip through a
    // gx:Track that omits the <when> block.
    const useGxTrack = segments.some((seg) =>
        seg.trkpt.some((p) => p.time !== undefined || hasSensor(p))
    );
    if (useGxTrack) {
        const tracks = segments.map((seg) => buildGxTrack(seg, channels));
        if (tracks.length === 1) {
            pm['gx:Track'] = tracks[0];
        } else {
            pm['gx:MultiTrack'] = { 'gx:Track': tracks };
        }
    } else {
        const lines = segments.map((seg) => ({ coordinates: coordinatesString(seg.trkpt) }));
        if (lines.length === 1) {
            pm.LineString = lines[0];
        } else {
            pm.MultiGeometry = { LineString: lines };
        }
    }

    return pm;
}

function coordinatesString(trkpt: TrackPointType[]): string {
    return trkpt.map((p) => pointTuple(p.attributes.lon, p.attributes.lat, p.ele)).join(' ');
}

function buildGxTrack(seg: { trkpt: TrackPointType[] }, channels: Channel[]): XmlNode {
    const hasTime = seg.trkpt.some((p) => p.time !== undefined);
    const when: string[] = [];
    const coord: string[] = [];
    for (const p of seg.trkpt) {
        coord.push(
            p.ele != null
                ? `${p.attributes.lon} ${p.attributes.lat} ${p.ele}`
                : `${p.attributes.lon} ${p.attributes.lat}`
        );
        if (hasTime) {
            when.push(toIso(p.time) ?? '');
        }
    }

    const track: XmlNode = {};
    if (hasTime) {
        track.when = when;
    }
    track['gx:coord'] = coord;

    const arrays: XmlNode[] = [];
    for (const ch of channels) {
        const values = seg.trkpt.map((p) => {
            const v = sensorValue(p, ch);
            return v === undefined ? '' : String(v);
        });
        if (values.some((v) => v !== '')) {
            arrays.push({ attributes: { name: ch }, 'gx:value': values });
        }
    }
    if (arrays.length > 0) {
        track.ExtendedData = {
            SchemaData: { attributes: { schemaUrl: '#gpxstudio' }, 'gx:SimpleArrayData': arrays },
        };
    }

    return track;
}
