// Create objects for each trip shape

import { readFileSync, writeFileSync } from 'fs';
import geodesic from 'geographiclib-geodesic';
const Geodesic = geodesic.Geodesic;
const geod = Geodesic.WGS84;
const outmask = Geodesic.DISTANCE | Geodesic.AZIMUTH;

const points = readFileSync('../gis/points.csv', 'utf8')
    .split('\n').slice(1, -1).map(l => l.split(','));

const obj = {};

for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const shape = point[3];

    if (!(shape in obj))
        obj[shape] = [];

    const item = [parseFloat(point[4]) /* sequence number */, parseFloat(point[1]) /* lat */, parseFloat(point[0]) /* lon */];
    if (point[2].length > 0)
        item.push(point[2]); // Add stop code
    obj[shape].push(item);
}

const shapes = [];

for (const key in obj) {
    const array = obj[key].sort((a, b) => a[0] - b[0]);
    const stops = []; // Stops on shape

    array[0].shift(); // Remove sequence number

    for (let i = 0; i < array.length - 1; i++) {
        const next = array[i + 1], current = array[i];
        next.shift(); // Remove sequence number

        const inverse = geod.Inverse(current[0], current[1], next[0], next[1], outmask);

        array[i].splice(2, 0, inverse.s12, inverse.azi1); // Insert distance at index 2, azimuth at 3

        if (current.length === 5)
            stops.push(current[4]);
    }
    // Add 0 distance and 0 direction to end
    array[array.length - 1].splice(2, 0, 0, 0);

    obj[key] = array;
    shapes.push({ shape: key, stops });
}

writeFileSync('points.json', JSON.stringify(obj));
writeFileSync('shapes.json', JSON.stringify(shapes));
