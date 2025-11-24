const map = L.map('map').setView([37.807869, -122.26898], 10);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
map.on('click', () => highlightPath(null));

const frontIconFiles = ['Red-N', 'Red-S', 'Orange-N', 'Orange-S', 'Yellow-N', 'Yellow-S', 'Green-N', 'Green-S', 'Blue-N', 'Blue-S'];
const frontIcons = {};
const mobile = window.innerWidth <= 600;
const iconSize = mobile ? [33, 30] : [45, 41];
const iconAnchor = mobile ? [18, 15] : [23, 21]
for (const file of frontIconFiles)
    frontIcons[file] = L.icon({
        iconUrl: 'assets/cars/' + file + '.png',
        iconSize,
        iconAnchor
    });

const timezoneOffset = new Date().getTimezoneOffset() * 60; // Time change in seconds
const stringifyTime = (time, includeSeconds = true) => {
    time -= timezoneOffset;
    const seconds = time % 60;
    const minute = Math.floor((time % 3600) / 60).toString();
    const hour = Math.floor((time % 86400) / 3600).toString();
    let string = hour.padStart(2, '0') + ':' + minute.padStart(2, '0');
    if (includeSeconds)
        string += ':' + seconds.toString().padStart(2, '0');
    return string;
};
const timeWindow = L.control();
timeWindow.onAdd = map => {
    this._div = L.DomUtil.create('div', 'info');
    return this._div;
};
timeWindow.update = time => {
    this._div.innerText = stringifyTime(time);
};
timeWindow.addTo(map);

const getColor = shape => {
    switch (shape.substring(0, 3)) {
        case '001': // works as an or statement: https://stackoverflow.com/a/6514571
        case '002':
            // Yellow
            return '#FFFF33';
        case '003':
        case '004':
            // Orange
            return '#FF9933';
        case '005':
        case '006':
            // Green
            return '#339933';
        case '007':
        case '008':
            // Red
            return '#FF0000';
        case '011':
        case '012':
            // Blue
            return '#0099CC';
        case '019':
        case '020':
            // Grey (OAK-Coliseum)
            return '#B0BEC7';
    }
}

const paths = new Map();
fetch('assets/paths.json').then(res => res.json()).then(data => {
    for (const path of data) {
        const line = L.polyline(path.points, { color: getColor(path.shape) });
        paths.set(path.shape, line);
    }
});
let highlightedPath;
const highlightPath = shape => {
    if (highlightedPath)
        map.removeLayer(highlightedPath);
    if (shape) {
        highlightedPath = paths.get(shape);
        highlightedPath.addTo(map);
    }
};

const stationMarkers = new Map();
const stationIconOptions = { className: 'station-icon', iconSize: [50, 15], iconAnchor: [25, 8] };
fetch('assets/stations.json').then(res => res.json()).then(data => {
    for (const station of data) {
        stationIconOptions.html = station.code;
        const marker = L.marker(station.latLng, { icon: L.divIcon(stationIconOptions) }).addTo(map);
        marker.bindPopup('<b>' + station.name + '</b>');
        marker.setZIndexOffset(-1000);
        marker.name = station.name;
        stationMarkers.set(station.code, marker);
    }
});

const trainMarkers = new Map();
const createPopup = (message, marker) => `
    ${message[0]} - ${marker.line} (${marker.length} cars)
    <br>
    Next: ${message[2]} at ${stringifyTime(parseInt(message[3]))}
    <br>
    ${Math.round(parseFloat(message[4]) * 2.23694 /* m/s to mph */)} mph
`;

//const eventSource = new EventSource('https://bart.eliasfretwell.com:3000');
const eventSource = new EventSource('http://localhost:3000');
eventSource.addEventListener('create', e => {
    const messages = e.data.split(';');
    for (let message of messages) {
        if (!message)
            continue;

        message = message.split(',');
        // id,line,nextStation,arriveTime,speed,shape,length
        if (trainMarkers.has(message[0])) // Only add new one if it doesn't exist already
            continue;

        const marker = L.marker([0, 0], { icon: frontIcons[message[1]] });
        marker.line = message[1];
        marker.length = parseInt(message[6]);
        marker.bindPopup(createPopup(message, marker));
        marker.on('click', () => highlightPath(message[5]));
        marker.addTo(map);

        trainMarkers.set(message[0], marker);
    }
});
eventSource.addEventListener('delete', e => {
    const messages = e.data.split(';');
    for (const message of messages) {
        map.removeLayer(trainMarkers.get(message));
        trainMarkers.delete(message);
    }
});
eventSource.addEventListener('move', e => {
    const messages = e.data.split(';');
    for (let message of messages) {
        message = message.split(',');
        const marker = trainMarkers.get(message[0]);
        const lat = parseFloat(message[1]), lon = parseFloat(message[2]);
        marker.setLatLng([lat, lon]);
    }
});
const updatePopup = e => {
    const messages = e.data.split(';');
    for (let message of messages) {
        message = message.split(',');
        const marker = trainMarkers.get(message[0]);
        marker.bindPopup(createPopup(message, marker));
    }
};
eventSource.addEventListener('station', updatePopup);
eventSource.addEventListener('update', updatePopup);
eventSource.addEventListener('time', e => timeWindow.update(e.data));
eventSource.addEventListener('departures', e => {
    const stations = e.data.split(';');
    for (const station of stations) {
        const departures = station.split('|');
        const marker = stationMarkers.get(departures[0]); // Station code
        marker.bindPopup('<b>' + marker.name + '</b><br>' + departures.slice(1).join('<br>'));
    }
});
