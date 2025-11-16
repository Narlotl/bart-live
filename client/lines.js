import { readFileSync, writeFileSync } from 'fs';

const data = JSON.parse(readFileSync('../gis/r_paths.geojson', 'utf8'));

const lines = [];

for (const feature of data.features) {
    const points = feature.geometry.coordinates;
    for (let i = 0; i < points.length; i++) {
        let point = points[i];
        point = [point[1], point[0]];
        points[i] = point;
    }

    lines.push({
        shape: feature.properties.shape_id,
        points
    });
}

writeFileSync('assets/paths.json', JSON.stringify(lines));
